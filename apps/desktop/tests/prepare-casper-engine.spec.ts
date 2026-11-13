import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { c as createTar } from 'tar'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkReleaseSums, npmLauncher, prepareCasperEngine, releaseAssetUrl, smokeCasperEngine,
  type CasperEngineLock, type CasperEngineNodeLock,
} from '../scripts/prepare-casper-engine.ts'
import lock from '../scripts/casper-engine.lock.json' with { type: 'json' }

const roots: string[] = []
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'desktop-casper-engine-'))
  roots.push(path)
  return path
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Put bytes in the hash-addressed cache, as an earlier download would have, and return their digest. */
function seed(cache: string, bytes: Uint8Array): string {
  mkdirSync(cache, { recursive: true })
  const digest = sha256(bytes)
  writeFileSync(join(cache, digest), bytes)
  return digest
}

async function tarGz(files: Record<string, string>): Promise<Buffer> {
  const source = root()
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(source, path, '..'), { recursive: true })
    writeFileSync(join(source, path), text)
  }
  const archive = join(source, 'archive.tar.gz')
  await createTar({ gzip: true, file: archive, cwd: source }, Object.keys(files))
  return readFileSync(archive)
}

const zip = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, new TextEncoder().encode(text)])))

/** A lock and cache whose pinned assets are small stand-ins, for one target. */
async function fixture(target: 'mac-arm64' | 'win-x64', sums?: (engine: string) => string) {
  const cache = join(root(), 'cache')
  const windows = target === 'win-x64'
  const engine = Buffer.from('#!/bin/sh\necho casper 9.9.9\n')
  const engineName = windows ? 'casper-windows-x64.exe' : 'casper-darwin-arm64'
  const engineSha = seed(cache, engine)
  const sumsSha = seed(cache, Buffer.from(sums?.(engineSha) ?? `${'0'.repeat(64)}  other\n${engineSha}  ${engineName}\n`))
  const uv = windows
    ? zip({ 'uv.exe': 'uv', 'uvx.exe': 'uvx', 'uvw.exe': 'uvw' })
    : await tarGz({ 'uv-aarch64-apple-darwin/uv': 'uv', 'uv-aarch64-apple-darwin/uvx': 'uvx' })
  const uvSha = seed(cache, uv)
  const nodeDirectory = windows ? 'node-v1.2.3-win-x64' : 'node-v1.2.3-darwin-arm64'
  const npm = windows ? `${nodeDirectory}/node_modules/npm` : `${nodeDirectory}/lib/node_modules/npm`
  const nodeFiles = {
    [`${nodeDirectory}/${windows ? 'node.exe' : 'bin/node'}`]: 'node',
    [`${npm}/package.json`]: '{"name":"npm","version":"7.7.7"}',
    [`${npm}/bin/npx-cli.js`]: 'npx',
    [`${npm}/bin/npm-cli.js`]: 'npm',
  }
  const nodeSha = seed(cache, windows ? zip(nodeFiles) : await tarGz(nodeFiles))
  const asset = (name: string, digest: string) => ({ asset: name, sha256: digest })
  const pins: CasperEngineLock = {
    casper: {
      repository: 'example/casper', version: '9.9.9', tag: 'v9.9.9', sums: asset('SHA256SUMS', sumsSha),
      targets: { 'mac-arm64': asset(engineName, engineSha), 'mac-x64': asset(engineName, engineSha), 'win-x64': asset(engineName, engineSha) },
    },
    uv: {
      repository: 'example/uv', version: '0.0.1', tag: '0.0.1',
      targets: { 'mac-arm64': asset('uv.tar.gz', uvSha), 'mac-x64': asset('uv.tar.gz', uvSha), 'win-x64': asset('uv.zip', uvSha) },
    },
  }
  const node: CasperEngineNodeLock = {
    nodeVersion: '1.2.3',
    targets: {
      'mac-arm64': { nodeArchive: 'darwin-arm64.tar.gz', nodeSha256: nodeSha },
      'mac-x64': { nodeArchive: 'darwin-x64.tar.gz', nodeSha256: nodeSha },
      'win-x64': { nodeArchive: 'win-x64.zip', nodeSha256: nodeSha },
    },
  }
  return { cache, runtime: join(root(), 'runtime'), pins, node, engineSha, uvSha }
}

/** Every file under a folder, relative and sorted. */
function files(path: string): string[] {
  return readdirSync(path, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name).slice(path.length + 1).split('\\').join('/')).sort()
}

describe('prepareCasperEngine', () => {
  it('lays out the engine, uv, uvx, the npx and npm launchers, and only npm from the Node archive', async () => {
    const { cache, runtime, pins, node, engineSha, uvSha } = await fixture('mac-arm64')
    mkdirSync(join(runtime, 'casper'), { recursive: true })
    writeFileSync(join(runtime, 'casper', 'stale'), 'from an earlier build')
    await expect(prepareCasperEngine({ target: 'mac-arm64', runtime, cache, lock: pins, nodeLock: node })).resolves.toEqual({
      casper: { version: '9.9.9', sha256: engineSha }, uv: { version: '0.0.1', sha256: uvSha },
    })
    expect(files(join(runtime, 'casper'))).toEqual([
      'casper', 'npm/bin/npm-cli.js', 'npm/bin/npx-cli.js', 'npm/package.json', 'tools/npm', 'tools/npx', 'tools/uv', 'tools/uvx',
    ])
    if (process.platform !== 'win32') {
      for (const path of ['casper', 'tools/uv', 'tools/uvx', 'tools/npx']) expect(statSync(join(runtime, 'casper', path)).mode & 0o777).toBe(0o755)
    }
    expect(readFileSync(join(runtime, 'casper', 'tools', 'npx'), 'utf8')).toBe(npmLauncher('npx', false))
  })

  it('lays out casper.exe, uv.exe, uvx.exe and .cmd launchers for Windows', async () => {
    const { cache, runtime, pins, node } = await fixture('win-x64')
    await prepareCasperEngine({ target: 'win-x64', runtime, cache, lock: pins, nodeLock: node })
    expect(files(join(runtime, 'casper'))).toEqual([
      'casper.exe', 'npm/bin/npm-cli.js', 'npm/bin/npx-cli.js', 'npm/package.json', 'tools/npm.cmd', 'tools/npx.cmd', 'tools/uv.exe', 'tools/uvx.exe',
    ])
    expect(readFileSync(join(runtime, 'casper', 'tools', 'npm.cmd'), 'utf8')).toBe(npmLauncher('npm', true))
  })

  it('refuses an engine the release SHA256SUMS lists with another digest', async () => {
    const { cache, runtime, pins, node } = await fixture('mac-arm64', () => `${'1'.repeat(64)}  casper-darwin-arm64\n`)
    await expect(prepareCasperEngine({ target: 'mac-arm64', runtime, cache, lock: pins, nodeLock: node }))
      .rejects.toThrow(`SHA256SUMS lists casper-darwin-arm64 as ${'1'.repeat(64)}`)
  })

  it('refuses a cached download whose bytes no longer match the lock', async () => {
    const { cache, runtime, pins, node, uvSha } = await fixture('mac-arm64')
    writeFileSync(join(cache, uvSha), 'corrupt')
    await expect(prepareCasperEngine({ target: 'mac-arm64', runtime, cache, lock: pins, nodeLock: node })).rejects.toThrow('checksum mismatch')
  })
})

describe('the checked-in lock', () => {
  it('pins Casper and uv for every Desktop target, each with a SHA-256 digest', () => {
    for (const release of [lock.casper, lock.uv]) {
      expect(Object.keys(release.targets).sort()).toEqual(['mac-arm64', 'mac-x64', 'win-x64'])
      for (const { sha256: digest } of Object.values(release.targets)) expect(digest).toMatch(/^[0-9a-f]{64}$/u)
    }
    expect(lock.casper.tag).toBe(`v${lock.casper.version}`)
    expect(lock.uv.tag).toBe(lock.uv.version)
  })
})

describe('release assets', () => {
  it('addresses a GitHub release download', () => {
    expect(releaseAssetUrl({ repository: 'Choaterboater/casper', tag: 'v0.4.15' }, 'casper-darwin-arm64'))
      .toBe('https://github.com/Choaterboater/casper/releases/download/v0.4.15/casper-darwin-arm64')
  })

  it('accepts a SHA256SUMS line in text or binary mode and refuses an unlisted asset', () => {
    const digest = 'a'.repeat(64)
    expect(() => { checkReleaseSums(`${digest} *casper-darwin-x64\n`, { asset: 'casper-darwin-x64', sha256: digest }) }).not.toThrow()
    expect(() => { checkReleaseSums(`${digest}  casper-darwin-x64\n`, { asset: 'casper-darwin-arm64', sha256: digest }) })
      .toThrow('SHA256SUMS does not list casper-darwin-arm64')
  })
})

// The launcher is a POSIX shell script; Windows runs the .cmd form.
it.skipIf(process.platform === 'win32')('runs npx with the primary runtime\'s node, found from the launcher\'s own folder', () => {
  const runtime = root()
  mkdirSync(join(runtime, 'primary-runtime', 'dependencies', 'node', 'bin'), { recursive: true })
  symlinkSync(process.execPath, join(runtime, 'primary-runtime', 'dependencies', 'node', 'bin', 'node'))
  mkdirSync(join(runtime, 'casper', 'npm', 'bin'), { recursive: true })
  writeFileSync(join(runtime, 'casper', 'npm', 'bin', 'npx-cli.js'), 'console.log(JSON.stringify([process.execPath, ...process.argv.slice(2)]))\n')
  mkdirSync(join(runtime, 'casper', 'tools'))
  writeFileSync(join(runtime, 'casper', 'tools', 'npx'), npmLauncher('npx', false), { mode: 0o755 })
  const printed = execFileSync(join(runtime, 'casper', 'tools', 'npx'), ['-y', 'server with space'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
  expect(JSON.parse(printed)).toEqual([process.execPath, '-y', 'server with space'])
})

it('does not run a target the build host cannot execute', async () => {
  const other = process.platform === 'win32' ? 'mac-arm64' : 'win-x64'
  await expect(smokeCasperEngine(root(), other)).resolves.toBe(false)
})
