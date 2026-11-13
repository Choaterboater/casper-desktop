/** Select and copy the local npm tarball closures that supply Desktop dsh and its private Host. */

import { createHash } from 'node:crypto'
import {
  constants,
  copyFileSync,
  globSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import * as yaml from 'js-yaml'
import {
  DESKTOP_HOST_PACKAGE,
  DESKTOP_HOST_RUNTIME_FILES,
  DESKTOP_OMITTED_PACKAGES,
  DESKTOP_PACKAGES_DIR,
  DESKTOP_PACKAGE_SET_FILE,
  parseDesktopCorePackageSet,
  type DesktopCorePackageRecord,
  type DesktopCorePackageSet,
} from '../src/core-package-set.ts'
import { capture } from '../../../scripts/release/process.ts'
import { tarballFiles } from '../../../scripts/release/tarball.ts'
import { desktopTargetPlatform, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'

const DSH_PACKAGE = '@deepseek-ai/dsh'
const ROOT_PACKAGES = [DSH_PACKAGE, DESKTOP_HOST_PACKAGE] as const
const APP_ROOT = resolve(import.meta.dirname, '..')
const REPOSITORY_ROOT = resolve(APP_ROOT, '..', '..')

const REQUIRED_DEPENDENCY_SECTIONS = ['dependencies', 'peerDependencies'] as const
const OPTIONAL_DEPENDENCY_SECTION = 'optionalDependencies'

/** Packed package information needed to form the local Desktop closure. */
export interface PackedDesktopPackage {
  readonly tarball: string
  readonly manifest: Readonly<Record<string, unknown>>
}

function supportsTarget(manifest: Readonly<Record<string, unknown>>, field: 'os' | 'cpu', target: string): boolean {
  const values = manifest[field]
  if (values === undefined) return true
  if (!Array.isArray(values) || !values.every((value): value is string => typeof value === 'string')) {
    throw new Error(`desktop package set: ${String(manifest.name)} has invalid ${field}`)
  }
  if (values.includes(`!${target}`)) return false
  return values.length === 0 || (values.length === 1 && values[0] === 'any') || values.includes(target)
    || values.every(value => value.startsWith('!'))
}

function dependencyNames(manifest: Readonly<Record<string, unknown>>, section: string): string[] {
  const value = manifest[section]
  if (value === undefined) return []
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`desktop package set: ${String(manifest.name)} has invalid ${section}`)
  }
  return Object.keys(value).sort()
}

/**
 * Select workspace dependencies rooted at dsh and its private Host; npm resolves external packages.
 * Reads the repository workspace manifest and package manifests to distinguish required local packages from npm-resolved externals.
 * A dependency edge to an omitted package is not followed, so the omitted package and every package reachable only
 * through it stay out of the selection; an omitted package need not be packed.
 * @param available - Packed packages indexed by package name.
 * @param target - Platform and architecture of the installer payload.
 * @param omitted - Package names to cut; each must be a dependency of a selected package and none may be a root.
 * @returns Selected packages sorted by name.
 */
export function selectDesktopPackageClosure(
  available: ReadonlyMap<string, PackedDesktopPackage>,
  target: ReturnType<typeof desktopTargetPlatform>,
  omitted: readonly string[],
): PackedDesktopPackage[] {
  const cut = new Set(omitted)
  for (const name of ROOT_PACKAGES) {
    if (cut.has(name)) throw new Error(`desktop package set: cannot omit root package ${name}`)
  }
  const reached = new Set<string>()
  const workspace = yaml.load(readFileSync(join(REPOSITORY_ROOT, 'pnpm-workspace.yaml'), 'utf8')) as { packages: string[] }
  const workspaceNames = new Set(globSync(workspace.packages.map(pattern => `${pattern}/package.json`), { cwd: REPOSITORY_ROOT })
    .map(path => (JSON.parse(readFileSync(join(REPOSITORY_ROOT, path), 'utf8')) as { name: string }).name))
  const selected = new Map<string, PackedDesktopPackage>()
  const visit = (name: string): void => {
    if (selected.has(name)) return
    const packed = available.get(name)
    if (packed === undefined) throw new Error(`desktop package set: packed inputs omit required package ${name}`)
    selected.set(name, packed)
    for (const section of REQUIRED_DEPENDENCY_SECTIONS) {
      for (const dependency of dependencyNames(packed.manifest, section)) {
        if (cut.has(dependency)) reached.add(dependency)
        else if (available.has(dependency)) visit(dependency)
        else if (workspaceNames.has(dependency)) {
          throw new Error(`desktop package set: ${name} requires unpacked package ${dependency}`)
        }
      }
    }
    for (const dependency of dependencyNames(packed.manifest, OPTIONAL_DEPENDENCY_SECTION)) {
      if (cut.has(dependency)) {
        reached.add(dependency)
        continue
      }
      const optional = available.get(dependency)
      if (optional && supportsTarget(optional.manifest, 'os', target.platform)
        && supportsTarget(optional.manifest, 'cpu', target.arch)) visit(dependency)
    }
  }
  for (const name of ROOT_PACKAGES) {
    if (!available.has(name)) throw new Error(`desktop package set: packed inputs omit ${name}`)
    visit(name)
  }
  const unused = omitted.filter(name => !reached.has(name))
  if (unused.length > 0) {
    throw new Error(`desktop package set: no selected package depends on omitted package(s) ${unused.join(', ')}`)
  }
  return [...selected.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, packed]) => packed)
}

function packedManifest(tarball: string): Record<string, unknown> {
  const value: unknown = JSON.parse(capture('tar', ['-xOzf', tarball, 'package/package.json']))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`desktop package set: ${tarball} has no package manifest`)
  }
  return value as Record<string, unknown>
}

function packedPackages(inputs: readonly string[]): Map<string, PackedDesktopPackage> {
  const available = new Map<string, PackedDesktopPackage>()
  for (const input of inputs) {
    const tarballs = readdirSync(input).filter(file => file.endsWith('.tgz')).sort()
    if (tarballs.length === 0) throw new Error(`desktop package set: ${input} contains no tarballs`)
    for (const file of tarballs) {
      const tarball = join(input, file)
      const manifest = packedManifest(tarball)
      const name = manifest.name
      if (typeof name !== 'string' || name === '') throw new Error(`desktop package set: ${tarball} has no package name`)
      if (available.has(name)) throw new Error(`desktop package set: duplicate packed package ${name}`)
      available.set(name, { tarball, manifest })
    }
  }
  return available
}

/** A `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` package name. */
const DSH_NAME = /^@deepseek-ai\/dsh(?:-[a-z0-9._~-]+)?$/u

/**
 * Name the `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` optional dependencies of package-set members that the set leaves
 * out, because they do not support its target. The runtime install overrides them to `-` like the omitted packages, so
 * pnpm neither resolves them from a registry nor records them in the lockfile.
 * @param projectDir - Directory containing the package set and its tarballs.
 * @param packageSet - Verified package set read from `projectDir`.
 * @returns The left-out optional package names, sorted.
 */
export function desktopUnshippedOptionalPackages(projectDir: string, packageSet: DesktopCorePackageSet): string[] {
  const shipped = new Set(packageSet.packages.map(record => record.name))
  const names = new Set<string>()
  for (const record of packageSet.packages) {
    const manifest = packedManifest(join(projectDir, DESKTOP_PACKAGES_DIR, record.file))
    for (const name of dependencyNames(manifest, OPTIONAL_DEPENDENCY_SECTION)) {
      if (DSH_NAME.test(name) && !shipped.has(name)) names.add(name)
    }
  }
  return [...names].sort()
}

/**
 * Require every private Host file used before the Desktop profile can pass its health check.
 * @param files - Tarball paths rooted at `package/`.
 * @returns Nothing.
 */
export function assertDesktopHostPackageFiles(files: readonly string[]): void {
  const available = new Set(files)
  const missing = DESKTOP_HOST_RUNTIME_FILES
    .map(file => `package/${file}`)
    .filter(file => !available.has(file))
  if (missing.length > 0) {
    throw new Error(`desktop package set: ${DESKTOP_HOST_PACKAGE} tarball omits required file(s): ${missing.join(', ')}`)
  }
}

/**
 * Prepare a package set from release tarball directories.
 * @param inputs - Release tarball directories.
 * @param output - Destination package-set directory.
 * @param target - Platform and architecture of the installer payload.
 * @param omitted - Package names cut from the closure, as {@link selectDesktopPackageClosure} takes them.
 */
export function prepareDesktopPackageSet(
  inputs: readonly string[], output: string, target: ReturnType<typeof desktopTargetPlatform>, omitted: readonly string[],
): void {
  const selected = selectDesktopPackageClosure(packedPackages(inputs), target, omitted)
  const host = selected.find(packed => packed.manifest.name === DESKTOP_HOST_PACKAGE)
  if (host === undefined) throw new Error(`desktop package set: selected closure omits ${DESKTOP_HOST_PACKAGE}`)
  assertDesktopHostPackageFiles(tarballFiles(host.tarball))
  rmSync(output, { recursive: true, force: true })
  const packageDir = join(output, DESKTOP_PACKAGES_DIR)
  mkdirSync(packageDir, { recursive: true })
  const records: DesktopCorePackageRecord[] = selected.map((packed) => {
    const name = packed.manifest.name
    const version = packed.manifest.version
    if (typeof name !== 'string' || typeof version !== 'string') {
      throw new Error(`desktop package set: ${packed.tarball} has no package identity`)
    }
    const file = basename(packed.tarball)
    const destination = join(packageDir, file)
    copyFileSync(packed.tarball, destination, constants.COPYFILE_EXCL)
    const body = readFileSync(destination)
    return {
      name,
      version,
      file,
      bytes: statSync(destination).size,
      integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`,
    }
  })
  const packageSet = parseDesktopCorePackageSet({ schemaVersion: 1, packages: records })
  writeFileSync(join(output, DESKTOP_PACKAGE_SET_FILE), `${JSON.stringify(packageSet, undefined, 2)}\n`, { mode: 0o600 })
}

function main(): void {
  const buildPaths = resolveDesktopTargetBuildPaths()
  const defaultInputs = [
    buildPaths.packedDsh,
    buildPaths.packedVendor,
    buildPaths.packedLandlock,
  ]
  const { values } = parseArgs({
    options: { from: { type: 'string', multiple: true }, out: { type: 'string' } },
    allowPositionals: false,
  })
  const inputs = (values.from ?? defaultInputs).map(path => resolve(REPOSITORY_ROOT, path))
  const output = values.out === undefined ? buildPaths.packageSet : resolve(REPOSITORY_ROOT, values.out)
  prepareDesktopPackageSet(inputs, output, desktopTargetPlatform(resolveDesktopBuildTarget()), DESKTOP_OMITTED_PACKAGES)
  console.log(`desktop package set: prepared ${output}`)
}

if (import.meta.main) main()
