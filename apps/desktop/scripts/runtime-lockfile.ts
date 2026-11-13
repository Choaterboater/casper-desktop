/** Lockfile check that keeps the Desktop runtime install inside its local package set. */

import * as yaml from 'js-yaml'
import { DESKTOP_PACKAGES_DIR, type DesktopCorePackageSet } from '../src/core-package-set.ts'

/** A `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` package name. */
const DSH_NAME = /^@deepseek-ai\/dsh(?:-[a-z0-9._~-]+)?$/u
/** `name@resolution` of such a package in a package key, snapshot key or peer suffix. */
const DSH_RESOLUTION = /(@deepseek-ai\/dsh(?:-[a-z0-9._~-]+)?)@([^()\s]*)/gu
const RESOLVED_DEPENDENCY_SECTIONS = ['dependencies', 'optionalDependencies', 'devDependencies'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function records(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error(`desktop package set: lockfile ${path} is not a map`)
  return value
}

/**
 * Reject a lockfile that installs any `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` package from outside the local package
 * set: a name the set does not contain, such as an omitted package or one reachable only through it, at any version, or
 * a set member resolved from anything but its own tarball, `file:desktop-packages/<file>`. Only resolutions are read:
 * package and snapshot keys with their peer suffixes, snapshot dependency maps and transitive peers, and importer
 * dependency versions. Declared peer ranges and the `overrides` block, which names omitted packages with `-`, are not.
 * @param lockfile - Generated pnpm lockfile text.
 * @param packageSet - Verified local core package set.
 */
export function verifyDesktopLockfileExclusions(lockfile: string, packageSet: DesktopCorePackageSet): void {
  const tarballs = new Map(packageSet.packages.map(record => [record.name, `file:${DESKTOP_PACKAGES_DIR}/${record.file}`]))
  const check = (name: string, resolution?: string): void => {
    if (!DSH_NAME.test(name)) return
    const tarball = tarballs.get(name)
    if (tarball === undefined) throw new Error(`desktop package set: lockfile installs ${name}, which is outside the local package set`)
    if (resolution !== undefined && resolution !== tarball) {
      throw new Error(`desktop package set: lockfile resolved ${name}@${resolution} outside the local package set`)
    }
  }
  const checkResolutions = (text: string): void => {
    for (const [, name, resolution] of text.matchAll(DSH_RESOLUTION)) check(name ?? '', resolution)
  }
  const checkDependency = (name: string, version: unknown, path: string): void => {
    if (typeof version !== 'string') throw new Error(`desktop package set: lockfile ${path} has no version`)
    check(name, version.split('(')[0])
    checkResolutions(version)
  }
  const parsed: unknown = yaml.load(lockfile)
  if (!isRecord(parsed)) throw new Error('desktop package set: lockfile is not a map')
  for (const key of Object.keys(records(parsed.packages, 'packages'))) checkResolutions(key)
  for (const [key, value] of Object.entries(records(parsed.snapshots, 'snapshots'))) {
    checkResolutions(key)
    const snapshot = records(value, `snapshot ${key}`)
    for (const section of RESOLVED_DEPENDENCY_SECTIONS) {
      for (const [name, version] of Object.entries(records(snapshot[section], `snapshot ${key} ${section}`))) {
        checkDependency(name, version, `snapshot ${key} ${section} ${name}`)
      }
    }
    const peers = snapshot.transitivePeerDependencies ?? []
    if (!Array.isArray(peers)) throw new Error(`desktop package set: lockfile snapshot ${key} transitivePeerDependencies is not a list`)
    for (const name of peers) {
      if (typeof name !== 'string') throw new Error(`desktop package set: lockfile snapshot ${key} lists a non-string transitive peer`)
      check(name)
    }
  }
  for (const [path, value] of Object.entries(records(parsed.importers, 'importers'))) {
    const importer = records(value, `importer ${path}`)
    for (const section of RESOLVED_DEPENDENCY_SECTIONS) {
      for (const [name, entry] of Object.entries(records(importer[section], `importer ${path} ${section}`))) {
        checkDependency(name, records(entry, `importer ${path} ${section} ${name}`).version, `importer ${path} ${section} ${name}`)
      }
    }
  }
}
