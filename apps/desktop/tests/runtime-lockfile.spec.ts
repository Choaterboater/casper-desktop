import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseDesktopCorePackageSet, type DesktopCorePackageRecord } from '../src/core-package-set.ts'
import { verifyDesktopLockfileExclusions } from '../scripts/runtime-lockfile.ts'

function record(name: string, file: string): DesktopCorePackageRecord {
  const body = Buffer.from(file)
  return {
    name, version: '1.2.3', file, bytes: body.byteLength, integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`,
  }
}

const packageSet = parseDesktopCorePackageSet({
  schemaVersion: 1,
  packages: [record('@deepseek-ai/dsh', 'dsh.tgz'), record('@deepseek-ai/dsh-desktop-host', 'host.tgz')],
})

/** A pnpm 11 lockfile in the runtime install's layout, with optional planted lines at each slot. */
const lockfile = (slots: { importer?: string; packages?: string; snapshotKey?: string; snapshot?: string; peer?: string } = {}): string => [
  "lockfileVersion: '9.0'",
  'overrides:',
  "  '@deepseek-ai/dsh': file:./desktop-packages/dsh.tgz",
  "  '@deepseek-ai/dsh-base': '-'",
  'importers:',
  '  .:',
  '    dependencies:',
  "      '@deepseek-ai/dsh':",
  '        specifier: file:desktop-packages/dsh.tgz',
  '        version: file:desktop-packages/dsh.tgz(59cd3c1928f6efe8eb79d80db7057d88)',
  ...slots.importer === undefined ? [] : [slots.importer],
  'packages:',
  "  '@deepseek-ai/dsh-desktop-host@file:desktop-packages/host.tgz':",
  '    resolution: {integrity: sha512-host, tarball: file:desktop-packages/host.tgz}',
  '    version: 1.2.3',
  '    peerDependencies:',
  "      '@deepseek-ai/dsh': 1.2.3",
  "      '@deepseek-ai/dsh-llm': 1.2.3",
  ...slots.packages === undefined ? [] : [slots.packages],
  'snapshots:',
  `  '@deepseek-ai/dsh-desktop-host@file:desktop-packages/host.tgz(@deepseek-ai/dsh@file:desktop-packages/dsh.tgz)${slots.snapshotKey ?? ''}':`,
  '    dependencies:',
  "      '@deepseek-ai/dsh': file:desktop-packages/dsh.tgz(zod@4.4.3)",
  '      zod: 4.4.3',
  ...slots.snapshot === undefined ? [] : [slots.snapshot],
  '    transitivePeerDependencies:',
  '      - supports-color',
  ...slots.peer === undefined ? [] : [slots.peer],
  '',
].join('\n')

describe('runtime lockfile exclusions', () => {
  it('accepts set members from their tarballs, declared peer ranges, and omitted names in the overrides block', () => {
    expect(() => { verifyDesktopLockfileExclusions(lockfile(), packageSet) }).not.toThrow()
  })

  it.each([
    ['an omitted package key', { packages: "  '@deepseek-ai/dsh-base@1.2.3':\n    resolution: {integrity: sha512-x}" },
      /installs @deepseek-ai\/dsh-base, which is outside/u],
    ['a snapshot dependency on a dropped package', { snapshot: "      '@deepseek-ai/dsh-sdk-protocol': file:x.tgz" },
      /installs @deepseek-ai\/dsh-sdk-protocol/u],
    ['an omitted peer in a snapshot key', { snapshotKey: '(@deepseek-ai/dsh-headless@file:x.tgz)' },
      /installs @deepseek-ai\/dsh-headless/u],
    ['an omitted transitive peer', { peer: "      - '@deepseek-ai/dsh-sdk-app'" },
      /installs @deepseek-ai\/dsh-sdk-app/u],
    ['a set member from the registry in a snapshot', { snapshot: "      '@deepseek-ai/dsh-desktop-host': 1.2.4" },
      /resolved @deepseek-ai\/dsh-desktop-host@1\.2\.4 outside/u],
    ['a set member key at a registry version', { packages: "  '@deepseek-ai/dsh@1.2.3':\n    resolution: {integrity: sha512-x}" },
      /resolved @deepseek-ai\/dsh@1\.2\.3 outside/u],
    ['a set member from another tarball', { snapshot: "      '@deepseek-ai/dsh-desktop-host': file:desktop-packages/dsh.tgz" },
      /resolved @deepseek-ai\/dsh-desktop-host@file:desktop-packages\/dsh\.tgz outside/u],
    ['an importer dependency from the registry', {
      importer: "      '@deepseek-ai/dsh-desktop-host':\n        specifier: 1.2.3\n        version: 1.2.3",
    }, /resolved @deepseek-ai\/dsh-desktop-host@1\.2\.3 outside/u],
  ])('rejects %s', (_case, slots, error) => {
    expect(() => { verifyDesktopLockfileExclusions(lockfile(slots), packageSet) }).toThrow(error)
  })

  it('rejects a lockfile that is not a map of maps', () => {
    expect(() => { verifyDesktopLockfileExclusions('- a list\n', packageSet) }).toThrow(/lockfile is not a map/u)
    expect(() => { verifyDesktopLockfileExclusions('snapshots: text\n', packageSet) }).toThrow(/lockfile snapshots is not a map/u)
  })
})
