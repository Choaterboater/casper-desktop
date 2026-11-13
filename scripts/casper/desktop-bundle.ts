/**
 * Generate the Casper desktop bundle's patch layers and dependencies from upstream's `dsh-base` and `dsh-web-app`.
 *
 * Each source patch file is copied with every row in {@link DESKTOP_REMOVED_ROWS} taken out: top-level patch items with
 * such an id, and `insert` list items with such an id, including items nested in group `config` lists. Removal is
 * line-based, so every kept line, comment and `!!js` text is copied byte for byte. A comment block directly above an item,
 * at its indentation, covers that item and the following items without such a comment of their own; it is removed only
 * with every item it covers. Each output is checked to parse to the source's semantic filter, and every listed id must be
 * removed from some `insert` list, so an upstream rename fails here even while a top-level patch still names the old id.
 *
 * The bundle manifest's `files`, `dsh.bundle.patch` and `dependencies` are generated too: the patch list mirrors the sources in
 * order and ends with the hand-written `casper.patch.yml`; the dependencies are both sources' dependencies plus
 * `dsh-web-app`, whose own rows load its code, minus {@link DESKTOP_FORBIDDEN_PACKAGES}, plus, as `workspace:*`, each
 * other package that `casper.patch.yml` names. `dsh-web-app`'s own manifest still depends on forbidden packages, so
 * this bundle's install closure reaches them; the Desktop package set omits them through `DESKTOP_OMITTED_PACKAGES` in
 * `apps/desktop/src/core-package-set.ts`.
 *
 * `--write` writes every output; `--check` exits 1 and names each output that differs from its generated text.
 * @module scripts/casper/desktop-bundle
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isCordisGroupEntry, loadCordisYaml } from '../cordis-yaml.ts'
import { packageNameOf } from '../source-parse-uses.ts'
import { DESKTOP_FORBIDDEN_PACKAGES, DESKTOP_REMOVED_ROWS } from './desktop-policy.ts'

/** Repository root. */
export const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..')
/** Repository-relative directory of the Casper desktop bundle package. */
export const DESKTOP_BUNDLE_DIR = 'packages/casper/desktop'
/** The hand-written Casper layer, applied after every generated layer. */
export const CASPER_PATCH = './casper.patch.yml'
/** The package whose code the web-app rows load, kept as a dependency of the generated bundle. */
const WEB_APP_PACKAGE = '@deepseek-ai/dsh-web-app'
const GENERATOR = 'scripts/casper/desktop-bundle.ts'

/** One upstream bundle layer the Casper bundle is generated from. */
interface SourceBundle {
  /** Repository-relative package directory. */
  readonly dir: string
  /** Output path of the bundle's first patch file, relative to the Casper bundle; later files keep their paths under `generated/`. */
  readonly firstOutput: string
}

/** The source layers, in application order. */
const SOURCE_BUNDLES: readonly SourceBundle[] = [
  { dir: 'packages/bundle/base', firstOutput: './generated/base.patch.yml' },
  { dir: 'packages/bundle/web-app', firstOutput: './generated/web-app.patch.yml' },
]

/** One generated file and the text it must hold. */
export interface GeneratedFile {
  /** Repository-relative output path. */
  readonly path: string
  /** Expected file text. */
  readonly text: string
}

/** Removal result for one source patch file. */
export interface FilteredPatch {
  /** Filtered YAML text, without the generated-file header. */
  readonly text: string
  /** Removed row ids, in source order. */
  readonly removed: readonly string[]
  /** The removed ids that were items of an `insert` list or of a group's `config` list, in source order. */
  readonly inserted: readonly string[]
}

interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string | string[] } }
  [key: string]: unknown
}

type Lines = readonly string[]

const isBlank = (line: string): boolean => line.trim() === ''
const isComment = (line: string): boolean => line.trimStart().startsWith('#')
const indentOf = (line: string): number => line.length - line.trimStart().length
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** One block sequence item: its `- ` line and the body lines indented under it. */
interface LineItem {
  readonly start: number
  /** Exclusive end after the last non-blank body line. */
  readonly end: number
  /** Column of the item's `-`. */
  readonly indent: number
}

/**
 * The block sequence items at one indentation inside `[from, to)`.
 * @param lines - Source lines.
 * @param from - First line of the sequence.
 * @param to - Exclusive bound of the enclosing block.
 * @param indent - Column of the sequence's `-` markers.
 * @returns Items in source order.
 */
function sequenceItems(lines: Lines, from: number, to: number, indent: number): LineItem[] {
  const items: LineItem[] = []
  let line = from
  while (line < to) {
    const text = lines[line] as string
    if (isBlank(text) || isComment(text)) { line++; continue }
    if (indentOf(text) !== indent || !text.trimStart().startsWith('-')) break
    let next = line + 1
    let end = line + 1
    while (next < to) {
      const body = lines[next] as string
      if (!isBlank(body)) {
        if (indentOf(body) <= indent) break
        end = next + 1
      }
      next++
    }
    items.push({ start: line, end, indent })
    line = next
  }
  return items
}

/**
 * Parse one item's text on its own, dedented, to read its id and group membership exactly as the YAML loader does.
 * @param lines - Source lines.
 * @param item - The item.
 * @param source - Source path, for errors.
 * @returns The parsed entry.
 */
function parseItem(lines: Lines, item: LineItem, source: string): unknown {
  const text = lines.slice(item.start, item.end).map(line => line.slice(Math.min(item.indent, indentOf(line)))).join('\n')
  const parsed = loadCordisYaml(text)
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error(`${source}:${item.start + 1}: expected exactly one sequence item`)
  return parsed[0]
}

/**
 * The block sequence that is the value of one mapping key of an item, if the key holds one.
 * @param lines - Source lines.
 * @param item - The item whose key is read.
 * @param key - Mapping key.
 * @returns The sequence's first line and indentation, or undefined when the item has no such block sequence.
 */
function keySequence(lines: Lines, item: LineItem, key: string): { from: number; indent: number } | undefined {
  const keyColumn = item.indent + 2
  const pattern = new RegExp(`^${key}:\\s*(?:#.*)?$`, 'u')
  let keyLine: number | undefined
  if (pattern.test((lines[item.start] as string).slice(keyColumn))) keyLine = item.start
  for (let line = item.start + 1; keyLine === undefined && line < item.end; line++) {
    const text = lines[line] as string
    if (!isBlank(text) && !isComment(text) && indentOf(text) === keyColumn && pattern.test(text.trimStart())) keyLine = line
  }
  if (keyLine === undefined) return undefined
  for (let line = keyLine + 1; line < item.end; line++) {
    const text = lines[line] as string
    if (isBlank(text) || isComment(text)) continue
    return text.trimStart().startsWith('-') && indentOf(text) >= keyColumn ? { from: line, indent: indentOf(text) } : undefined
  }
  return undefined
}

/** A line range to delete. */
interface Span { start: number; end: number }

/** Whether a parsed patch or entry carries one of the removed ids. */
const isRemovedRow = (value: unknown): value is { id: string } =>
  isRecord(value) && typeof value.id === 'string' && Object.hasOwn(DESKTOP_REMOVED_ROWS, value.id)

/**
 * Collect the spans of removed items in one entry list, recursing into groups.
 * @param lines - Source lines.
 * @param items - The list's items.
 * @param source - Source path, for errors.
 * @param spans - Receives removal spans.
 * @param removed - Receives removed ids.
 */
function collectEntryRemovals(lines: Lines, items: readonly LineItem[], source: string, spans: Span[], removed: string[]): void {
  const removedAt = items.map((item) => {
    const entry = parseItem(lines, item, source)
    if (isRemovedRow(entry)) {
      removed.push(entry.id)
      return true
    }
    if (isCordisGroupEntry(entry)) {
      const config = keySequence(lines, item, 'config')
      if (config === undefined) return false
      collectEntryRemovals(lines, sequenceItems(lines, config.from, item.end, config.indent), source, spans, removed)
    }
    return false
  })
  spans.push(...listRemovalSpans(lines, items, removedAt))
}

/**
 * The first line of the comment block directly above an item at its own indentation; the item's own line when it has none.
 * @param lines - Source lines.
 * @param item - The item.
 * @returns A line index.
 */
function commentStart(lines: Lines, item: LineItem): number {
  let start = item.start
  while (start > 0 && isComment(lines[start - 1] as string) && indentOf(lines[start - 1] as string) === item.indent) start--
  return start
}

/**
 * Removal spans for one list's removed items. A comment block directly above an item covers it and the following items
 * without such a comment of their own, so the block is removed with an item only when every item it covers is removed.
 * @param lines - Source lines.
 * @param items - The list's items, in source order.
 * @param removedAt - Whether the item at each index is removed.
 * @returns One span per removed item.
 */
function listRemovalSpans(lines: Lines, items: readonly LineItem[], removedAt: readonly boolean[]): Span[] {
  const spans: Span[] = []
  items.forEach((item, index) => {
    if (removedAt[index] !== true) return
    let coversOnlyRemoved = true
    for (let next = index + 1; next < items.length; next++) {
      const following = items[next] as LineItem
      if (commentStart(lines, following) !== following.start) break
      if (removedAt[next] !== true) coversOnlyRemoved = false
    }
    spans.push({ start: coversOnlyRemoved ? commentStart(lines, item) : item.start, end: item.end })
  })
  return spans
}

/**
 * Remove every row in {@link DESKTOP_REMOVED_ROWS} from one patch file's text, line by line.
 * @param source - Source patch file text.
 * @param path - Source path, for errors.
 * @returns The filtered text and the removed ids.
 * @throws {Error} when the text is not a top-level patch list, or when the output does not parse to the semantic filter of the source.
 */
export function filterPatchText(source: string, path: string): FilteredPatch {
  const lines = source.replace(/\n$/u, '').split('\n')
  const spans: Span[] = []
  const removed: string[] = []
  const inserted: string[] = []
  const patches = sequenceItems(lines, 0, lines.length, 0)
  const removedAt = patches.map((item) => {
    const patch = parseItem(lines, item, path)
    if (isRemovedRow(patch)) {
      removed.push(patch.id)
      return true
    }
    const insert = keySequence(lines, item, 'insert')
    if (insert !== undefined) {
      const entries: string[] = []
      collectEntryRemovals(lines, sequenceItems(lines, insert.from, item.end, insert.indent), path, spans, entries)
      removed.push(...entries)
      inserted.push(...entries)
    }
    return false
  })
  spans.push(...listRemovalSpans(lines, patches, removedAt))
  const text = `${removeSpans(lines, spans).join('\n')}\n`
  const expected = filterPatchList(loadCordisYaml(source), path)
  if (!isDeepStrictEqual(loadCordisYaml(text), expected)) {
    throw new Error(`${path}: the line-based removal does not parse to the source with the removed rows taken out; a removed row is likely in a flow collection, or its list would become empty`)
  }
  return { text, removed, inserted }
}

/**
 * Delete spans, merging spans separated only by blank lines, and collapse the blank lines left around each deletion.
 * @param lines - Source lines.
 * @param spans - Spans to delete.
 * @returns The kept lines.
 */
function removeSpans(lines: Lines, spans: readonly Span[]): string[] {
  const merged: Span[] = []
  for (const span of [...spans].sort((left, right) => left.start - right.start)) {
    const last = merged.at(-1)
    if (last !== undefined && lines.slice(last.end, span.start).every(isBlank)) last.end = span.end
    else merged.push({ ...span })
  }
  const drop = new Set<number>()
  for (const span of merged) {
    for (let line = span.start; line < span.end; line++) drop.add(line)
    const before = lines[span.start - 1]
    const after = lines[span.end]
    // The blank line after a deletion goes when the deletion follows a blank line, opens its list, or follows a kept
    // comment, which then sits directly above the next item it covers.
    if (after !== undefined && isBlank(after) && (before === undefined || isBlank(before) || isComment(before) || before.trimEnd().endsWith(':'))) drop.add(span.end)
  }
  const kept = lines.filter((_, index) => !drop.has(index))
  while (kept.length > 0 && isBlank(kept.at(-1) as string)) kept.pop()
  return kept
}

/**
 * Remove listed rows from parsed entries, recursing into groups.
 * @param entries - Parsed entries.
 * @returns Entries without listed rows.
 */
function filterEntries(entries: readonly unknown[]): unknown[] {
  return entries
    .filter(entry => !isRemovedRow(entry))
    .map(entry => isCordisGroupEntry(entry) ? { ...entry, config: filterEntries(entry.config) } : entry)
}

/**
 * The semantic filter of one parsed patch list: top-level items and `insert` items (in groups too) whose id is listed are taken out.
 * @param document - Parsed patch file.
 * @param path - Source path, for errors.
 * @returns The filtered patch list.
 * @throws {Error} when the document is not a top-level list.
 */
export function filterPatchList(document: unknown, path: string): unknown[] {
  if (!Array.isArray(document)) throw new Error(`${path}: a patch file must be a top-level YAML list`)
  const patches: readonly unknown[] = document
  return patches
    .filter(patch => !isRemovedRow(patch))
    .map(patch => isRecord(patch) && Array.isArray(patch.insert) ? { ...patch, insert: filterEntries(patch.insert) } : patch)
}

/**
 * Reject inserted rows whose plugin name is a path: the Loader anchors those beside the patch file, so moving them under
 * `generated/` would change what they load.
 * @param document - Parsed patch file.
 * @param path - Source path, for errors.
 */
function assertNoPathNames(document: unknown, path: string): void {
  const visit = (entry: unknown): void => {
    if (!isRecord(entry)) return
    if (typeof entry.name === 'string' && /^(?:\.{1,2}\/|\/)/u.test(entry.name)) throw new Error(`${path}: row ${String(entry.id)} names a path (${entry.name}), which would resolve differently from the generated copy`)
    if (isCordisGroupEntry(entry)) entry.config.forEach(visit)
  }
  if (Array.isArray(document)) for (const patch of document) if (isRecord(patch) && Array.isArray(patch.insert)) patch.insert.forEach(visit)
}

const readText = (root: string, path: string): string => readFileSync(join(root, path), 'utf8')
const readManifest = (root: string, dir: string): PackageManifest => JSON.parse(readText(root, `${dir}/package.json`)) as PackageManifest

function patchList(manifest: PackageManifest, dir: string): string[] {
  const patch = manifest.dsh?.bundle?.patch
  const list = typeof patch === 'string' ? [patch] : patch
  if (list === undefined || list.length === 0) throw new Error(`${dir}/package.json declares no dsh.bundle.patch`)
  return list
}

/**
 * The packages one hand-written patch file names: plugin names of top-level patches and of `insert` items, groups included.
 * @param document - Parsed patch file.
 * @returns Package names, without paths, built-in specifiers or duplicates.
 */
function namedPackages(document: unknown): Set<string> {
  const names = new Set<string>()
  const visit = (entry: unknown): void => {
    if (!isRecord(entry)) return
    const name = typeof entry.name === 'string' ? packageNameOf(entry.name) : undefined
    if (name !== undefined) names.add(name)
    if (isCordisGroupEntry(entry)) entry.config.forEach(visit)
  }
  if (Array.isArray(document)) {
    for (const patch of document) {
      visit(patch)
      if (isRecord(patch) && Array.isArray(patch.insert)) patch.insert.forEach(visit)
    }
  }
  return names
}

/** Normalize a manifest-relative path to `./`-prefixed form. */
const dotted = (path: string): string => path.startsWith('./') ? path : `./${path}`

/**
 * Compute every generated file of the Casper desktop bundle.
 * @param root - Repository root; defaults to this checkout.
 * @returns Generated patch files and the bundle manifest, with their expected text.
 * @throws {Error} when a source cannot be filtered, a listed id is inserted by no source, the sources disagree on a
 * dependency's spec, or `casper.patch.yml` names a forbidden package.
 */
export function generateDesktopBundle(root: string = REPOSITORY_ROOT): GeneratedFile[] {
  const files: GeneratedFile[] = []
  const patches: string[] = []
  const inserted = new Set<string>()
  const dependencies = new Map<string, string>()
  for (const bundle of SOURCE_BUNDLES) {
    const manifest = readManifest(root, bundle.dir)
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      const previous = dependencies.get(name)
      if (previous !== undefined && previous !== spec) throw new Error(`${name}: the source bundles declare different specs (${previous}, ${spec})`)
      dependencies.set(name, spec)
    }
    patchList(manifest, bundle.dir).forEach((patch, index) => {
      const sourcePath = `${bundle.dir}/${dotted(patch).slice(2)}`
      const output = index === 0 ? bundle.firstOutput : `./generated/${dotted(patch).slice(2)}`
      const source = readText(root, sourcePath)
      assertNoPathNames(loadCordisYaml(source), sourcePath)
      const filtered = filterPatchText(source, sourcePath)
      filtered.inserted.forEach(id => inserted.add(id))
      const header = `# Generated from ${sourcePath} by ${GENERATOR} --write; do not edit.\n`
      files.push({ path: `${DESKTOP_BUNDLE_DIR}/${output.slice(2)}`, text: header + filtered.text })
      patches.push(output)
    })
  }
  const missing = Object.keys(DESKTOP_REMOVED_ROWS).filter(id => !inserted.has(id))
  if (missing.length > 0) throw new Error(`removed rows not inserted by any source patch file: ${missing.join(', ')}; update scripts/casper/desktop-policy.ts for the upstream rename`)
  dependencies.set(WEB_APP_PACKAGE, 'workspace:*')
  for (const name of DESKTOP_FORBIDDEN_PACKAGES) dependencies.delete(name)
  const manifest = readManifest(root, DESKTOP_BUNDLE_DIR)
  const casperPath = `${DESKTOP_BUNDLE_DIR}/${CASPER_PATCH.slice(2)}`
  for (const name of namedPackages(loadCordisYaml(readText(root, casperPath)))) {
    if (DESKTOP_FORBIDDEN_PACKAGES.includes(name)) throw new Error(`${casperPath}: names ${name}, which the desktop must not ship`)
    // Casper-only plugins are workspace packages; the bundle's own package needs no dependency.
    if (name !== manifest.name && !dependencies.has(name)) dependencies.set(name, 'workspace:*')
  }
  const dsh = manifest.dsh ?? {}
  const patchFiles = [...patches, CASPER_PATCH]
  const generated: PackageManifest = {
    ...manifest,
    // Workspace constraints require bundles to publish each patch file by name, between the entry and its types.
    files: ['locale/*.json', 'lib/index.js', ...patchFiles.map(patch => patch.slice(2)), 'lib/types/**/*.d.ts'],
    dsh: { ...dsh, bundle: { ...dsh.bundle, patch: patchFiles } },
    dependencies: Object.fromEntries([...dependencies].sort(([left], [right]) => left.localeCompare(right, 'en'))),
  }
  files.push({ path: `${DESKTOP_BUNDLE_DIR}/package.json`, text: `${JSON.stringify(generated, undefined, 2)}\n` })
  return files
}

/**
 * List the generated files whose text on disk differs from their generated text.
 * @param root - Repository root; defaults to this checkout.
 * @returns Repository-relative paths of stale or missing outputs; empty when the tree is current.
 */
export function checkDesktopBundle(root: string = REPOSITORY_ROOT): string[] {
  return generateDesktopBundle(root)
    .filter(file => !existsSync(join(root, file.path)) || readText(root, file.path) !== file.text)
    .map(file => file.path)
}

function main(): void {
  const write = process.argv.includes('--write')
  if (write === process.argv.includes('--check')) throw new Error(`usage: tsx ${GENERATOR} --write | --check`)
  if (write) {
    for (const file of generateDesktopBundle()) {
      mkdirSync(dirname(join(REPOSITORY_ROOT, file.path)), { recursive: true })
      writeFileSync(join(REPOSITORY_ROOT, file.path), file.text)
    }
    console.log(`desktop bundle: wrote ${DESKTOP_BUNDLE_DIR}`)
    return
  }
  const stale = checkDesktopBundle()
  for (const path of stale) console.error(`desktop bundle: ${path} is stale; run pnpm run gen-casper-desktop-bundle`)
  if (stale.length > 0) process.exitCode = 1
  else console.log(`desktop bundle: ${DESKTOP_BUNDLE_DIR} is current`)
}

if (import.meta.main) main()
