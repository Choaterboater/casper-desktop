import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DESKTOP_OMITTED_PACKAGES,
  DESKTOP_PACKAGES_DIR,
  DESKTOP_PACKAGE_SET_FILE,
  desktopCorePackageOverrides,
  desktopDshPackageSpec,
  desktopOmittedPackageOverrides,
  parseDesktopCorePackageSet,
  verifyDesktopCoreLockfile,
  verifyDesktopCorePackageSet,
  type DesktopCorePackageRecord,
} from '../src/core-package-set.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { createRuntimeProjectMetadata } from '../src/project-manager.ts'

const roots: string[] = []

function record(name: string, file: string, body: Buffer, version = '1.2.3'): DesktopCorePackageRecord {
  return {
    name,
    version,
    file,
    bytes: body.byteLength,
    integrity: `sha512-${createHash('sha512').update(body).digest('base64')}`,
  }
}

function packageSetProject(): {
  root: string
  dsh: DesktopCorePackageRecord
  base: DesktopCorePackageRecord
  host: DesktopCorePackageRecord
} {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-package-set-'))
  roots.push(root)
  const packageDir = join(root, DESKTOP_PACKAGES_DIR)
  mkdirSync(packageDir)
  const dshBody = Buffer.from('dsh')
  const baseBody = Buffer.from('base')
  const hostBody = Buffer.from('host')
  const dsh = record('@deepseek-ai/dsh', 'dsh.tgz', dshBody)
  const base = record('@deepseek-ai/dsh-base', 'dsh-base.tgz', baseBody)
  const host = record('@deepseek-ai/dsh-desktop-host', 'dsh-desktop-host.tgz', hostBody)
  writeFileSync(join(packageDir, dsh.file), dshBody)
  writeFileSync(join(packageDir, base.file), baseBody)
  writeFileSync(join(packageDir, host.file), hostBody)
  writeFileSync(join(root, DESKTOP_PACKAGE_SET_FILE), `${JSON.stringify({
    schemaVersion: 1,
    packages: [dsh, base, host],
  })}\n`)
  return { root, dsh, base, host }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop core package set', () => {
  it('pins the direct dsh dependency and every internal package to local tarballs', () => {
    const { root } = packageSetProject()
    const packageSet = verifyDesktopCorePackageSet(root, '1.2.3')
    expect(desktopDshPackageSpec(packageSet)).toBe('file:./desktop-packages/dsh.tgz')
    expect(desktopCorePackageOverrides(packageSet)).toEqual({
      '@deepseek-ai/dsh': 'file:./desktop-packages/dsh.tgz',
      '@deepseek-ai/dsh-base': 'file:./desktop-packages/dsh-base.tgz',
      '@deepseek-ai/dsh-desktop-host': 'file:./desktop-packages/dsh-desktop-host.tgz',
    })
  })

  it('rejects version drift, descriptor disorder, corruption, and extra files', () => {
    const { root, dsh, base, host } = packageSetProject()
    expect(() => verifyDesktopCorePackageSet(root, '2.0.0')).toThrow(/does not match Desktop/u)
    expect(() => parseDesktopCorePackageSet({
      schemaVersion: 1,
      packages: [dsh, base, { ...host, version: '2.0.0' }],
    }, '1.2.3')).toThrow(/dsh-desktop-host@2\.0\.0 does not match Desktop 1\.2\.3/u)
    expect(() => parseDesktopCorePackageSet({ schemaVersion: 1, packages: [base, dsh, host] }))
      .toThrow(/sorted by name/u)
    writeFileSync(join(root, DESKTOP_PACKAGES_DIR, dsh.file), 'changed')
    expect(() => verifyDesktopCorePackageSet(root, '1.2.3')).toThrow(/integrity check failed/u)
    writeFileSync(join(root, DESKTOP_PACKAGES_DIR, 'extra.tgz'), '')
    expect(() => verifyDesktopCorePackageSet(root, '1.2.3')).toThrow(/does not match its descriptor/u)
  })

  it('rejects registry resolutions for names supplied by the local package set', () => {
    const dsh = record('@deepseek-ai/dsh', 'dsh.tgz', Buffer.from('dsh'))
    const host = record('@deepseek-ai/dsh-desktop-host', 'host.tgz', Buffer.from('host'))
    const packageSet = parseDesktopCorePackageSet({ schemaVersion: 1, packages: [dsh, host] })
    expect(() => {
      verifyDesktopCoreLockfile(
        "packages:\n  '@deepseek-ai/dsh@file:desktop-packages/dsh.tgz':\n    resolution: {}\n",
        packageSet,
      )
    }).not.toThrow()
    expect(() => {
      verifyDesktopCoreLockfile(
        "packages:\n  '@deepseek-ai/dsh@1.2.3':\n    resolution: {integrity: sha512-registry}\n",
        packageSet,
      )
    }).toThrow(/outside the local package set/u)
  })

  it('overrides each omitted package to -, and refuses a package set that contains one', () => {
    const { root } = packageSetProject()
    const packageSet = verifyDesktopCorePackageSet(root, '1.2.3')
    expect(() => desktopOmittedPackageOverrides(packageSet, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']))
      .toThrow(/contains omitted package\(s\) @deepseek-ai\/dsh-base$/u)
    expect(desktopOmittedPackageOverrides(packageSet, ['@deepseek-ai/dsh-headless', '@deepseek-ai/dsh-sdk-app'])).toEqual({
      '@deepseek-ai/dsh-headless': '-',
      '@deepseek-ai/dsh-sdk-app': '-',
    })
  })

  it('writes the runtime project with the omitted packages overridden to - and absent from its dependencies', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-runtime-project-'))
    roots.push(root)
    mkdirSync(join(root, DESKTOP_PACKAGES_DIR))
    const files = [['@deepseek-ai/dsh', 'dsh.tgz'], ['@deepseek-ai/dsh-desktop-host', 'host.tgz']] as const
    const records = files.map(([name, file]) => {
      const body = Buffer.from(file)
      writeFileSync(join(root, DESKTOP_PACKAGES_DIR, file), body)
      return record(name, file, body)
    })
    writeFileSync(join(root, DESKTOP_PACKAGE_SET_FILE), JSON.stringify({ schemaVersion: 1, packages: records }))
    createRuntimeProjectMetadata(root, {
      schemaVersion: 1, version: '1.2.3', hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, nodeVersion: '24.17.0', pnpmVersion: '11.28.5',
    }, DESKTOP_OMITTED_PACKAGES)
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(Object.keys(manifest.dependencies)).toEqual(['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host'])
    const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
    expect(workspace).toContain('  "@deepseek-ai/dsh": "file:./desktop-packages/dsh.tgz"\n')
    for (const name of DESKTOP_OMITTED_PACKAGES) expect(workspace).toContain(`  ${JSON.stringify(name)}: "-"\n`)
  })
})
