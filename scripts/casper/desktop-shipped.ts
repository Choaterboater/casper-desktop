/**
 * Scan what the Casper desktop ships, on the source plane, for upstream hosts, upstream screen text (and upstream's short
 * product name in locale dictionaries), forbidden packages, imports of them, and removed service rows. Comments and module
 * specifiers are not screen text. No build is needed: workspace packages are read from `src/` in place of the
 * `lib/` they publish, third-party packages from the installed `node_modules`, and the desktop's rows from its profile bundles.
 *
 * What is scanned:
 * - the desktop package set from the packager's own {@link selectDesktopPackageClosure}, for each shipped target;
 * - per workspace package, `package.json`, top-level READMEs, the source `files` globs, and `src/` when `files` ships `lib/` or `dist/`;
 * - workspace packages a scanned source imports at runtime without depending on them, which the build inlines;
 * - the Electron app's bundled entries, following their local and workspace imports, and its `renderer/` files;
 * - the installed third-party production closure, minus the files the packager drops (`desktopRuntimeFileExclusion`).
 *
 * The closure walk cuts {@link DESKTOP_OMITTED_PACKAGES}, as the packager does. An import of a forbidden or omitted
 * package counts only from kept code; a forbidden package's own imports leave with it.
 *
 * Not seen: tsdown and Vite output and third-party code a build inlines; `scan-packaged-app.ts` covers those on a packaged app.
 * @module scripts/casper/desktop-shipped
 */

import { existsSync, globSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import * as yaml from 'js-yaml'
import ts from 'typescript'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { selectDesktopPackageClosure, type PackedDesktopPackage } from '../../apps/desktop/scripts/prepare-package-set.ts'
import { CASPER_DESKTOP_BUNDLES } from '../../apps/desktop/src/casper-desktop-profile.ts'
import { DESKTOP_OMITTED_PACKAGES } from '../../apps/desktop/src/core-package-set.ts'
import { desktopRuntimeFileExclusion } from '../../apps/desktop/scripts/runtime-file-policy.ts'
import { isCordisGroupEntry, isJsExpr, loadCordisYaml } from '../cordis-yaml.ts'
import { collectRuntimeLocalSourceSpecifiers, collectRuntimeSourceSpecifiers, packageNameOf } from '../source-parse-uses.ts'
import { DESKTOP_FORBIDDEN_PACKAGES, DESKTOP_REMOVED_ROWS } from './desktop-policy.ts'
import {
  DESKTOP_LOCALES,
  DESKTOP_SHIPPED_EXEMPTIONS,
  FORBIDDEN_HOST,
  FORBIDDEN_PRODUCT_NAME,
  FORBIDDEN_SCREEN_TEXT,
  LOCALE_DICTIONARY,
  MINIMUM_SHIPPED_PACKAGES,
  REQUIRED_SHIPPED_PACKAGES,
  type Exemption,
  type Finding,
  type FindingRule,
} from './desktop-shipped-rules.ts'

/** Repository root. */
export const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..')

/** One packaged target, as the packager's closure walk takes it. */
export type DesktopShippedTarget = Parameters<typeof selectDesktopPackageClosure>[1]

/** Targets the desktop is packaged for; the scanned closure is their union. */
export const DESKTOP_SHIPPED_TARGETS = [
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'darwin', arch: 'x64' },
  { platform: 'win32', arch: 'x64' },
] as const satisfies readonly DesktopShippedTarget[]

/** The Electron app's bundled entries (`electron-builder-config.mjs` `files`) as their sources. */
const DESKTOP_APP_ENTRIES = [
  'src/main.ts',
  'src/operation-report-worker.ts',
  'src/client/welcome.tsx',
  'src/preload-app.ts',
  'src/preload-mandatory.ts',
  'src/preload-platform-account.ts',
  'src/preload-update-dialog.ts',
  'src/preload-welcome.ts',
]
const DESKTOP_APP_DIR = 'apps/desktop'
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/u
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.jsx']
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|__mocks__|fixtures)\/|\.(?:spec|test|e2e)\.[cm]?[jt]sx?$/u
const LOCALE_FILE = /(?:^|\/)locale\/(?:[^/]+\/)*([a-z]{2})\.json$/u
const PACKAGE_MANIFEST_TEXT_FIELDS = ['description', 'displayName', 'keywords', 'dsh'] as const

/** Content replacements by repository-relative path, read in place of the files on disk (planted cases). */
export type ShippedOverlay = ReadonlyMap<string, string>

/** What one scan saw and found. */
export interface ShippedScan {
  /** Every finding, sorted. */
  readonly findings: readonly Finding[]
  /** Scanned package names: the workspace closure, inlined workspace packages, and third-party packages. */
  readonly packages: ReadonlySet<string>
  /** Locales with at least one dictionary read. */
  readonly locales: ReadonlySet<string>
  /** Scanned files, repository-relative. */
  readonly files: number
}

interface WorkspacePackage {
  readonly name: string
  readonly dir: string
  readonly manifest: Readonly<Record<string, unknown>>
}

class Collector {
  readonly counts = new Map<string, { rule: FindingRule; file: string; match: string; count: number }>()

  add(rule: FindingRule, file: string, match: string, count = 1): void {
    const key = `${rule}\u0000${file}\u0000${match}`
    const existing = this.counts.get(key)
    if (existing === undefined) this.counts.set(key, { rule, file, match, count })
    else existing.count += count
  }

  findings(): Finding[] {
    return [...this.counts.values()].sort(compareFindings)
  }
}

/**
 * Order findings by rule, file and match.
 * @param left - First finding.
 * @param right - Second finding.
 * @returns A negative, zero or positive sort result.
 */
export function compareFindings(left: Finding, right: Finding): number {
  return left.rule.localeCompare(right.rule) || left.file.localeCompare(right.file) || left.match.localeCompare(right.match)
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}

function readWorkspace(): Map<string, WorkspacePackage> {
  const workspace = yaml.load(readFileSync(join(REPOSITORY_ROOT, 'pnpm-workspace.yaml'), 'utf8')) as { packages: string[] }
  const packages = new Map<string, WorkspacePackage>()
  for (const path of globSync(workspace.packages.map(pattern => `${pattern}/package.json`), { cwd: REPOSITORY_ROOT })) {
    const manifest = JSON.parse(readFileSync(join(REPOSITORY_ROOT, path), 'utf8')) as Record<string, unknown>
    if (typeof manifest.name !== 'string') continue
    packages.set(manifest.name, { name: manifest.name, dir: toPosix(dirname(path)), manifest })
  }
  return packages
}

/**
 * Select the desktop's workspace package set with the packager's own closure walk, over every shipped target.
 * @param workspace - Workspace packages by name.
 * @param targets - Shipped targets whose closures to unite.
 * @returns Package names in the union of the per-target closures.
 */
function workspaceClosure(
  workspace: ReadonlyMap<string, WorkspacePackage>,
  targets: readonly DesktopShippedTarget[] = DESKTOP_SHIPPED_TARGETS,
): Set<string> {
  const available = new Map<string, PackedDesktopPackage>(
    [...workspace.values()].map(pkg => [pkg.name, { tarball: pkg.dir, manifest: pkg.manifest }]),
  )
  const names = new Set<string>()
  for (const target of targets) {
    for (const packed of selectDesktopPackageClosure(available, target, DESKTOP_OMITTED_PACKAGES)) {
      names.add(packed.manifest.name as string)
    }
  }
  return names
}

/**
 * The desktop package set's workspace packages, as the packager selects them.
 * @param targets - Shipped targets whose closures to unite; all of them by default.
 * @returns The closure's package names and every workspace package name, each sorted.
 */
export function desktopShippedWorkspacePackages(
  targets: readonly DesktopShippedTarget[] = DESKTOP_SHIPPED_TARGETS,
): { closure: string[]; workspace: string[] } {
  const workspace = readWorkspace()
  return { closure: [...workspaceClosure(workspace, targets)].sort(), workspace: [...workspace.keys()].sort() }
}

function workspacePackage(workspace: ReadonlyMap<string, WorkspacePackage>, name: string): WorkspacePackage {
  const pkg = workspace.get(name)
  if (pkg === undefined) throw new Error(`desktop shipped scan: ${name} is not a workspace package`)
  return pkg
}

function dependencyNames(manifest: Readonly<Record<string, unknown>>, sections: readonly string[]): string[] {
  return sections.flatMap((section) => {
    const value = manifest[section]
    return value !== null && typeof value === 'object' ? Object.keys(value) : []
  })
}

function walkFiles(dir: string, skip: (relativePath: string) => boolean): string[] {
  const files: string[] = []
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      const rel = toPosix(relative(dir, path))
      if (skip(rel)) continue
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push(rel)
    }
  }
  visit(dir)
  return files.sort()
}

/** Packages kept code must not import at runtime: forbidden ones, and omitted ones, which the package set leaves out. */
const UNIMPORTABLE_PACKAGES: ReadonlySet<string> = new Set([...DESKTOP_FORBIDDEN_PACKAGES, ...DESKTOP_OMITTED_PACKAGES])

/** Reads shipped files with the overlay applied and records findings. */
class Scanner {
  readonly collector = new Collector()
  readonly packages = new Set<string>()
  readonly locales = new Set<string>()
  readonly scanned = new Set<string>()

  /**
   * @param overlay - Content replacements by repository-relative path.
   * @param forbiddenDirs - Folders of forbidden workspace packages, each ending in `/`; their own imports leave with them.
   */
  constructor(private readonly overlay: ShippedOverlay, private readonly forbiddenDirs: readonly string[]) {}

  read(path: string): string {
    return this.overlay.get(path) ?? readFileSync(join(REPOSITORY_ROOT, path), 'latin1')
  }

  readText(path: string): string {
    return this.overlay.get(path) ?? readFileSync(join(REPOSITORY_ROOT, path), 'utf8')
  }

  /**
   * Scan one shipped file once.
   * @param path - Repository-relative path, or an absolute path for third-party files.
   * @param label - Finding file label.
   * @param textRules - Whether screen-text rules apply (workspace files only).
   */
  scan(path: string, label: string, textRules: boolean): void {
    if (this.scanned.has(label)) return
    this.scanned.add(label)
    const raw = path.startsWith('/') ? readFileSync(path, 'latin1') : this.read(path)
    for (const host of raw.matchAll(FORBIDDEN_HOST)) this.collector.add('host', label, host[0].toLowerCase())
    if (!textRules) return
    const locale = LOCALE_FILE.exec(label)?.[1]
    if (locale !== undefined) this.locales.add(locale)
    const dictionary = LOCALE_DICTIONARY.test(label)
    for (const text of this.screenTexts(path, label)) {
      for (const match of text.matchAll(FORBIDDEN_SCREEN_TEXT)) this.collector.add('text', label, match[0])
      if (dictionary) for (const match of text.matchAll(FORBIDDEN_PRODUCT_NAME)) this.collector.add('text', label, match[0])
    }
    if (SOURCE_FILE.test(label) && !this.forbiddenDirs.some(dir => label.startsWith(dir))) {
      for (const specifier of collectRuntimeSourceSpecifiers(label, this.readText(path))) {
        const name = packageNameOf(specifier)
        if (name !== undefined && UNIMPORTABLE_PACKAGES.has(name)) this.collector.add('import', label, name)
      }
    }
  }

  /**
   * Text a user can see: string literals and JSX text in sources, values in JSON, YAML and HTML, chosen manifest fields.
   * @param path - File path as read.
   * @param label - Repository-relative label.
   * @returns The candidate screen texts.
   */
  screenTexts(path: string, label: string): string[] {
    if (label.endsWith('/package.json') || label === 'package.json') {
      const manifest = JSON.parse(this.readText(path)) as Record<string, unknown>
      return PACKAGE_MANIFEST_TEXT_FIELDS.flatMap(field => stringValues(manifest[field]))
    }
    if (label.endsWith('.json')) return stringValues(JSON.parse(this.readText(path)))
    if (/\.ya?ml$/u.test(label)) return stringValues(loadCordisYaml(this.readText(path)))
    if (/\.html?$/u.test(label)) return [this.readText(path)]
    if (SOURCE_FILE.test(label)) return sourceStrings(label, this.readText(path))
    return []
  }
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (isJsExpr(value)) return [value.__jsExpr]
  if (Array.isArray(value)) return value.flatMap(stringValues)
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(stringValues)
  return []
}

/** Whether a string literal names a module: an import, export, `import()`, `import x = require()` or import type specifier. */
function isModuleSpecifier(node: ts.StringLiteralLike): boolean {
  const parent = node.parent
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return parent.moduleSpecifier === node
  if (ts.isCallExpression(parent)) return parent.expression.kind === ts.SyntaxKind.ImportKeyword && parent.arguments[0] === node
  if (ts.isExternalModuleReference(parent)) return true
  return ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)
}

/**
 * Collect string literal, template and JSX text contents from one source file; comments and module specifiers are not
 * screen text.
 * @param path - File path used to select TypeScript's parser mode.
 * @param source - Source text.
 * @returns The literal texts in source order.
 */
export function sourceStrings(path: string, source: string): string[] {
  const kind = path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind)
  const texts: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      if (!isModuleSpecifier(node)) texts.push(node.text)
    } else if (ts.isTemplateLiteralToken(node) || ts.isJsxText(node)) texts.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return texts
}

/** Build output folders a package publishes; the scan reads the package's `src/` in their place. */
const BUILD_OUTPUT = /^(?:lib|dist)(?:\/|$)/u

/**
 * Files one workspace package publishes, as sources: the manifest, READMEs, the `files` globs that name sources, and
 * `src/` in place of build output (`lib/`, `dist/`). Negated globs only narrow build output, so they are not read.
 */
function workspacePackageFiles(scanner: Scanner, pkg: WorkspacePackage): string[] {
  const dir = join(REPOSITORY_ROOT, pkg.dir)
  const files = new Set<string>(['package.json'])
  for (const entry of readdirSync(dir)) if (/^readme/iu.test(entry)) files.add(entry)
  const globs = Array.isArray(pkg.manifest.files) ? pkg.manifest.files.filter(file => typeof file === 'string') : undefined
  const sources = globs === undefined || globs.some(file => BUILD_OUTPUT.test(file))
  for (const pattern of globs ?? []) {
    if (BUILD_OUTPUT.test(pattern) || pattern.startsWith('!')) continue
    for (const match of globSync(pattern, { cwd: dir })) {
      const path = join(dir, match)
      if (statSync(path).isDirectory()) for (const nested of walkFiles(path, () => false)) files.add(toPosix(join(match, nested)))
      else files.add(toPosix(match))
    }
  }
  if (sources && existsSync(join(dir, 'src'))) {
    for (const file of walkFiles(join(dir, 'src'), rel => TEST_PATH.test(`${rel}/`) || TEST_PATH.test(rel))) files.add(`src/${file}`)
  }
  return [...files].sort().map(file => `${pkg.dir}/${file}`).filter(file => !scanner.scanned.has(file))
}

function resolveRelative(from: string, specifier: string): string | undefined {
  const base = join(dirname(from), specifier)
  const candidates = [base, ...SOURCE_EXTENSIONS.map(ext => base.replace(/\.[cm]?js$/u, '') + ext), ...SOURCE_EXTENSIONS.map(ext => join(base, `index${ext}`))]
  return candidates.find(candidate => existsSync(join(REPOSITORY_ROOT, candidate)) && statSync(join(REPOSITORY_ROOT, candidate)).isFile())
}

/** Node module lookup of `name` from `fromDir`, through ancestor `node_modules` folders. */
function resolveInstalled(fromDir: string, name: string): string | undefined {
  let current = fromDir
  for (;;) {
    if (!current.endsWith(`${sep}node_modules`)) {
      const candidate = join(current, 'node_modules', name)
      if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Scan the Casper desktop's shipped output on the source plane.
 * @param overlay - File contents to read in place of the files on disk, by repository-relative path.
 * @returns What the scan saw and found.
 */
export function scanDesktopShipped(overlay: ShippedOverlay = new Map()): ShippedScan {
  const workspace = readWorkspace()
  const scanner = new Scanner(overlay, DESKTOP_FORBIDDEN_PACKAGES.map(name => `${workspacePackage(workspace, name).dir}/`))
  const closure = workspaceClosure(workspace)
  for (const name of [...closure].sort()) {
    if (DESKTOP_FORBIDDEN_PACKAGES.includes(name)) scanner.collector.add('package', 'closure', name)
  }

  const workspaceQueue = [...closure].sort()
  const queued = new Set(workspaceQueue)
  const enqueueImports = (label: string): void => {
    if (!SOURCE_FILE.test(label)) return
    for (const specifier of collectRuntimeSourceSpecifiers(label, scanner.readText(label))) {
      const name = packageNameOf(specifier)
      // An omitted package's import is an `import` finding; the package itself does not ship, so it is not scanned.
      if (name !== undefined && workspace.has(name) && !queued.has(name) && !DESKTOP_OMITTED_PACKAGES.includes(name)) {
        queued.add(name)
        workspaceQueue.push(name)
      }
    }
  }

  // The Electron app: its bundled entries and what they reach, plus its renderer files.
  const appFiles = [...DESKTOP_APP_ENTRIES.map(entry => `${DESKTOP_APP_DIR}/${entry}`)]
  // An array iterator sees elements pushed during iteration, so this walks every file reached.
  for (const file of appFiles) {
    for (const specifier of collectRuntimeLocalSourceSpecifiers(file, scanner.readText(file))) {
      const target = resolveRelative(file, specifier)
      if (target !== undefined && !appFiles.includes(target) && target.startsWith(`${DESKTOP_APP_DIR}/`)) appFiles.push(target)
    }
  }
  const appManifest = workspace.get('@deepseek-ai/dsh-desktop')
  if (appManifest === undefined) throw new Error('desktop shipped scan: the workspace has no @deepseek-ai/dsh-desktop')
  scanner.packages.add(appManifest.name)
  for (const file of [`${DESKTOP_APP_DIR}/package.json`, ...appFiles.sort(), ...walkFiles(join(REPOSITORY_ROOT, DESKTOP_APP_DIR, 'renderer'), () => false).map(file => `${DESKTOP_APP_DIR}/renderer/${file}`)]) {
    scanner.scan(file, file, true)
    enqueueImports(file)
  }
  for (const name of dependencyNames(appManifest.manifest, ['dependencies'])) {
    if (workspace.has(name) && !queued.has(name)) {
      queued.add(name)
      workspaceQueue.push(name)
    }
  }

  // Workspace packages: the closure, then every workspace package a scanned source imports at runtime.
  for (const name of workspaceQueue) {
    const pkg = workspacePackage(workspace, name)
    scanner.packages.add(pkg.name)
    for (const file of workspacePackageFiles(scanner, pkg)) {
      scanner.scan(file, file, true)
      enqueueImports(file)
    }
  }

  // Third-party production closure of every scanned workspace package that installs at runtime.
  const thirdParty: { name: string; dir: string }[] = []
  const seenDirs = new Set<string>()
  const enqueueInstalled = (fromDir: string, manifest: Readonly<Record<string, unknown>>, optional: boolean): void => {
    for (const name of dependencyNames(manifest, ['dependencies', 'peerDependencies', 'optionalDependencies'])) {
      if (workspace.has(name)) continue
      const dir = resolveInstalled(fromDir, name)
      if (dir === undefined || seenDirs.has(dir)) {
        if (dir === undefined && !optional && dependencyNames(manifest, ['dependencies']).includes(name)) {
          throw new Error(`desktop shipped scan: ${String(manifest.name)} depends on ${name}, which is not installed`)
        }
        continue
      }
      seenDirs.add(dir)
      thirdParty.push({ name, dir })
    }
  }
  for (const name of [...closure, appManifest.name]) {
    const pkg = workspacePackage(workspace, name)
    enqueueInstalled(join(REPOSITORY_ROOT, pkg.dir), pkg.manifest, false)
  }
  for (const { name, dir } of thirdParty) {
    scanner.packages.add(name)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
    enqueueInstalled(dir, manifest, true)
    const shipped = walkFiles(dir, rel => rel === 'node_modules' || rel.startsWith('node_modules/'))
      .filter(rel => DESKTOP_SHIPPED_TARGETS.some(target =>
        desktopRuntimeFileExclusion(`${name}/${rel}`, target, `${target.platform}-${target.arch}`) === undefined))
    for (const rel of shipped) scanner.scan(join(dir, rel), `node_modules/${name}/${rel}`, false)
  }

  scanComposition(scanner, workspace)
  return { findings: scanner.collector.findings(), packages: scanner.packages, locales: scanner.locales, files: scanner.scanned.size }
}

/** Compose the desktop profile's template bundles and report removed service rows that are present. */
function scanComposition(scanner: Scanner, workspace: ReadonlyMap<string, WorkspacePackage>): void {
  const layers: PatchOptions[][] = CASPER_DESKTOP_BUNDLES.map((name) => {
    const pkg = workspace.get(name)
    if (pkg === undefined) throw new Error(`desktop shipped scan: profile bundle ${name} is not a workspace package`)
    const bundle = (pkg.manifest.dsh as { bundle?: { patch?: string | string[] } } | undefined)?.bundle
    const patches = typeof bundle?.patch === 'string' ? [bundle.patch] : bundle?.patch
    if (patches === undefined) throw new Error(`desktop shipped scan: ${name} declares no dsh.bundle.patch`)
    return patches.flatMap(patch => loadCordisYaml(scanner.readText(toPosix(join(pkg.dir, patch)))) as PatchOptions[])
  })
  const entries = applyEntryPatches([], structuredClone(layers.flat()), () => {})
  const visit = (entry: EntryOptions): void => {
    if (typeof entry.id === 'string' && entry.id in DESKTOP_REMOVED_ROWS) {
      scanner.collector.add('row', 'composition', `${entry.id} ${entry.disabled === true ? 'disabled' : 'enabled'}`)
    }
    if (isCordisGroupEntry(entry)) (entry.config as EntryOptions[]).forEach(visit)
  }
  entries.forEach(visit)
}

const findingKey = (finding: Finding): string => `${finding.rule} ${finding.match} in ${finding.file}`

const DICTIONARY_KEY = /['"]?([\w.]+)['"]?\s*:\s*['"`]/gu

/**
 * Count the occurrences of `match` in `text` that no listed dictionary key holds (see {@link Exemption.keys}).
 * @param text - The exempted file's text.
 * @param match - The exempted host or screen text.
 * @param keys - Dictionary keys that may hold an occurrence.
 * @param ignoreCase - Match case-insensitively, as the host rule scans.
 * @returns How many occurrences lie outside those keys.
 */
export function occurrencesOutsideKeys(text: string, match: string, keys: readonly string[], ignoreCase = false): number {
  let outside = 0
  const pattern = new RegExp(match.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), ignoreCase ? 'giu' : 'gu')
  for (const { index: at } of text.matchAll(pattern)) {
    const prefix = text.slice(text.lastIndexOf('\n', at) + 1, at)
    const key = [...prefix.matchAll(DICTIONARY_KEY)].at(-1)?.[1]
    const word = `${/[\w.]*$/u.exec(prefix)?.[0] ?? ''}${/^[\w.]*/u.exec(text.slice(at))?.[0] ?? ''}`
    if (!keys.some(name => name === key || name === word)) outside += 1
  }
  return outside
}

/**
 * Compare one scan with the permanent exemptions; every count must match exactly.
 * @param scan - What the scan saw and found.
 * @param exemptions - Permanent exemptions.
 * @param readEvidence - Reads an exempted file's text, to count its evidence and check its keys.
 * @returns Problems, each a sentence; empty when the scan passes.
 */
export function checkDesktopShipped(
  scan: ShippedScan,
  exemptions: readonly Exemption[],
  readEvidence: (file: string) => string = file => readFileSync(join(REPOSITORY_ROOT, file), 'utf8'),
): string[] {
  const problems: string[] = []
  if (scan.packages.size < MINIMUM_SHIPPED_PACKAGES) {
    problems.push(`the scan saw ${scan.packages.size} packages, fewer than ${MINIMUM_SHIPPED_PACKAGES}; the closure walk broke`)
  }
  for (const name of REQUIRED_SHIPPED_PACKAGES) {
    if (!scan.packages.has(name)) problems.push(`the scan did not reach ${name}; the closure walk broke`)
  }
  for (const locale of DESKTOP_LOCALES) {
    if (!scan.locales.has(locale)) problems.push(`the scan read no ${locale} dictionary; the locale walk broke`)
  }
  const allowed = new Map<string, number>()
  for (const entry of exemptions) {
    const key = findingKey(entry)
    if (allowed.has(key)) problems.push(`${key} is listed twice; keep one entry`)
    allowed.set(key, entry.count)
  }
  const found = new Map(scan.findings.map(finding => [findingKey(finding), finding]))
  for (const finding of scan.findings) {
    const key = findingKey(finding)
    const allowance = allowed.get(key)
    if (allowance === undefined) problems.push(`new: ${key} (${finding.count}x)`)
    else if (finding.count > allowance) problems.push(`new: ${key} occurs ${finding.count}x, the exemption allows ${allowance}`)
    else if (finding.count < allowance) problems.push(`stale: ${key} occurs ${finding.count}x, lower the exemption entry from ${allowance}`)
  }
  for (const key of allowed.keys()) {
    if (!found.has(key)) problems.push(`stale: ${key} no longer occurs, remove the exemption entry`)
  }
  for (const exemption of exemptions) {
    if (exemption.evidence !== undefined) {
      const occurrences = readEvidence(exemption.file).split(exemption.evidence).length - 1
      if (occurrences !== exemption.count) {
        problems.push(`exemption evidence ${JSON.stringify(exemption.evidence)} occurs ${occurrences}x in ${exemption.file}, expected ${exemption.count}`)
      }
    }
    if (exemption.keys !== undefined) {
      const outside = occurrencesOutsideKeys(readEvidence(exemption.file), exemption.match, exemption.keys, exemption.rule === 'host')
      if (outside > 0) problems.push(`${findingKey(exemption)}: ${outside} occurrence(s) lie outside the exempted keys ${exemption.keys.join(', ')}`)
    }
  }
  return problems
}

function main(): void {
  const scan = scanDesktopShipped()
  const problems = checkDesktopShipped(scan, DESKTOP_SHIPPED_EXEMPTIONS)
  for (const problem of problems) console.error(`desktop shipped: ${problem}`)
  console.log(`desktop shipped: ${scan.files} files in ${scan.packages.size} packages, ${problems.length} problem(s)`)
  if (problems.length > 0) process.exitCode = 1
}

if (import.meta.main) main()
