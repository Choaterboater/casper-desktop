/**
 * Fetch the pinned Casper engine and uv into the Desktop runtime, each checked against
 * `casper-engine.lock.json`, and take npm from the primary runtime's pinned Node archive,
 * so Casper and the servers it starts find `node`, `npx` and `uv` on a computer that has none.
 */

import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import extractZip from 'extract-zip'
import { x as extractTar } from 'tar'
import primaryLock from '../../../scripts/primary-runtime/lock.json' with { type: 'json' }
import { downloadPrimaryRuntimeAsset } from '../../../scripts/primary-runtime/prepare.ts'
import { casperEngineEnvironment, casperEngineLayout } from '../src/casper-engine.ts'
import lock from './casper-engine.lock.json' with { type: 'json' }

/** Desktop targets the lock pins an engine for. */
export type CasperEngineTarget = keyof typeof lock.casper.targets

/** One pinned release asset. */
export interface CasperEngineAsset {
  readonly asset: string
  readonly sha256: string
}

/** One pinned GitHub release and its per-target assets. */
export interface CasperEngineRelease {
  readonly repository: string
  readonly version: string
  readonly tag: string
  readonly targets: Readonly<Record<CasperEngineTarget, CasperEngineAsset>>
}

/** The engine lock: Casper with its release checksum file, and uv. */
export interface CasperEngineLock {
  readonly casper: CasperEngineRelease & { readonly sums: CasperEngineAsset }
  readonly uv: CasperEngineRelease
}

/** The Node archive whose npm the app ships: the primary runtime's own pin. */
export interface CasperEngineNodeLock {
  readonly nodeVersion: string
  readonly targets: Readonly<Record<CasperEngineTarget, { readonly nodeArchive: string; readonly nodeSha256: string }>>
}

/** What `versions.json` records for the bundled engine and uv. */
export interface PreparedCasperEngine {
  readonly casper: { readonly version: string; readonly sha256: string }
  readonly uv: { readonly version: string; readonly sha256: string }
}

/**
 * The download address of a pinned release asset.
 * @param release - the pinned release.
 * @param asset - the asset's file name.
 * @returns the GitHub release download URL.
 */
export function releaseAssetUrl(release: Pick<CasperEngineRelease, 'repository' | 'tag'>, asset: string): string {
  return `https://github.com/${release.repository}/releases/download/${encodeURIComponent(release.tag)}/${encodeURIComponent(asset)}`
}

/**
 * Check that a release's `SHA256SUMS` lists an asset with the digest the lock pins,
 * so a lock edit that disagrees with the release fails the build.
 * @param sums - the checksum file's text, `<hex>  <name>` per line.
 * @param asset - the pinned asset.
 * @throws Error when the asset is missing from the file or listed with another digest.
 */
export function checkReleaseSums(sums: string, asset: CasperEngineAsset): void {
  const listed = new Map<string, string>()
  for (const line of sums.split('\n')) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/u.exec(line.trim())
    if (match !== null) listed.set(match[2]!, match[1]!)
  }
  const digest = listed.get(asset.asset)
  if (digest === undefined) throw new Error(`casper engine: SHA256SUMS does not list ${asset.asset}`)
  if (digest !== asset.sha256) throw new Error(`casper engine: SHA256SUMS lists ${asset.asset} as ${digest}, the lock pins ${asset.sha256}`)
}

function findFile(root: string, name: string): string {
  const hit = readdirSync(root, { recursive: true, withFileTypes: true }).find(entry => entry.isFile() && entry.name === name)
  if (hit === undefined) throw new Error(`casper engine: the archive has no ${name}`)
  return join(hit.parentPath, hit.name)
}

/**
 * A launcher in `tools/` for one npm command: it runs the command's script in `npm/bin` with the primary runtime's
 * node, found relative to the launcher, so no node on PATH is needed.
 * @param name - `npx` or `npm`.
 * @param windows - a `.cmd` file for Windows, else a POSIX shell script.
 * @returns the launcher's text.
 */
export function npmLauncher(name: 'npx' | 'npm', windows: boolean): string {
  return windows
    ? [
      '@echo off',
      `rem ${name} from the Node archive the app ships, run by the app's own node.`,
      `"%~dp0..\\..\\primary-runtime\\dependencies\\node\\bin\\node.exe" "%~dp0..\\npm\\bin\\${name}-cli.js" %*`,
      '',
    ].join('\r\n')
    : [
      '#!/bin/sh',
      `# ${name} from the Node archive the app ships, run by the app's own node.`,
      'tools=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)',
      `exec "$tools/../../primary-runtime/dependencies/node/bin/node" "$tools/../npm/bin/${name}-cli.js" "$@"`,
      '',
    ].join('\n')
}

/** Options for {@link prepareCasperEngine}. */
export interface PrepareCasperEngineOptions {
  /** The Desktop target whose assets are fetched. */
  readonly target: CasperEngineTarget
  /** The runtime resource directory; the engine goes in its `casper` folder, which is replaced. */
  readonly runtime: string
  /** The SHA-256-addressed download cache the primary runtime also uses. */
  readonly cache: string
  /** The engine pins; the checked-in lock by default. */
  readonly lock?: CasperEngineLock
  /** The Node pin npm comes from; the primary runtime's lock by default. */
  readonly nodeLock?: CasperEngineNodeLock
}

/**
 * Lay out `runtime/casper`: the engine (`casper`, or `casper.exe` on Windows, mode 755), `tools/` with uv and uvx
 * plus `npx` and `npm` launchers, and `npm/` from the Node archive. Nothing is run; see {@link smokeCasperEngine}.
 * @param options - target, output, cache, and pins.
 * @returns the versions and digests to record in `versions.json`.
 * @throws Error when a download, checksum, or `SHA256SUMS` line does not match the lock.
 */
export async function prepareCasperEngine(options: PrepareCasperEngineOptions): Promise<PreparedCasperEngine> {
  const pins = options.lock ?? lock
  const node = options.nodeLock ?? primaryLock
  const windows = options.target === 'win-x64'
  const layout = casperEngineLayout(options.runtime, windows ? 'win32' : 'darwin')
  const exe = windows ? '.exe' : ''
  rmSync(layout.root, { recursive: true, force: true })
  mkdirSync(layout.tools, { recursive: true })
  const casper = pins.casper.targets[options.target]
  const sumsUrl = releaseAssetUrl(pins.casper, pins.casper.sums.asset)
  const sums = await downloadPrimaryRuntimeAsset(sumsUrl, pins.casper.sums.sha256, options.cache)
  checkReleaseSums(readFileSync(sums, 'utf8'), casper)
  copyFileSync(await downloadPrimaryRuntimeAsset(releaseAssetUrl(pins.casper, casper.asset), casper.sha256, options.cache), layout.engine)
  chmodSync(layout.engine, 0o755)
  const uv = pins.uv.targets[options.target]
  const staging = mkdtempSync(join(tmpdir(), 'dsh-casper-engine-'))
  try {
    const uvArchive = await downloadPrimaryRuntimeAsset(releaseAssetUrl(pins.uv, uv.asset), uv.sha256, options.cache)
    const uvStaging = join(staging, 'uv')
    mkdirSync(uvStaging)
    if (windows) await extractZip(uvArchive, { dir: uvStaging })
    else await extractTar({ file: uvArchive, cwd: uvStaging })
    for (const name of ['uv', 'uvx']) {
      copyFileSync(findFile(uvStaging, name + exe), join(layout.tools, name + exe))
      chmodSync(join(layout.tools, name + exe), 0o755)
    }
    const nodeArtifact = node.targets[options.target]
    const filename = `node-v${node.nodeVersion}-${nodeArtifact.nodeArchive}`
    const nodeArchive = await downloadPrimaryRuntimeAsset(`https://nodejs.org/dist/v${node.nodeVersion}/${filename}`, nodeArtifact.nodeSha256, options.cache)
    const nodeStaging = join(staging, 'node')
    mkdirSync(nodeStaging)
    const npm = join(filename.replace(/\.(?:zip|tar\.gz)$/u, ''), ...(windows ? ['node_modules', 'npm'] : ['lib', 'node_modules', 'npm']))
    if (windows) await extractZip(nodeArchive, { dir: nodeStaging })
    else await extractTar({ file: nodeArchive, cwd: nodeStaging, filter: path => path.startsWith(`${npm}/`) })
    cpSync(join(nodeStaging, npm), layout.npm, { recursive: true })
    for (const name of ['npx', 'npm'] as const) {
      writeFileSync(join(layout.tools, windows ? `${name}.cmd` : name), npmLauncher(name, windows), { mode: 0o755 })
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return { casper: { version: pins.casper.version, sha256: casper.sha256 }, uv: { version: pins.uv.version, sha256: uv.sha256 } }
}

function run(file: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: file.endsWith('.cmd') })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(`casper engine smoke: ${file} ${args.join(' ')} exited with ${String(code)}: ${stderr.trim()}`))
    })
  })
}

/**
 * Start the engine's ACP server and open one conversation: `initialize`, then `session/new`. stdin stays open until
 * both replies arrive, because Casper exits on end of input before answering.
 * @param engine - the engine executable.
 * @param env - the whole child environment.
 * @param cwd - the conversation folder.
 * @param timeoutMs - limit for both replies.
 * @returns the version `initialize` reports and the new conversation's id.
 */
export function openCasperConversation(
  engine: string, env: NodeJS.ProcessEnv, cwd: string, timeoutMs = 60_000,
): Promise<{ version: string; sessionId: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(engine, ['acp'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let buffer = ''
    let stderr = ''
    const replies = new Map<number, (message: { result?: Record<string, unknown>; error?: unknown }) => void>()
    const timer = setTimeout(() => { fail(new Error('no reply in time')) }, timeoutMs)
    const fail = (error: Error): void => {
      clearTimeout(timer)
      child.kill()
      reject(new Error(`casper engine smoke: ${error.message}${stderr.trim() === '' ? '' : `\n${stderr.trim()}`}`, { cause: error }))
    }
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096) })
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buffer += chunk
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (line === '') continue
        let message: { id?: number; method?: string; result?: Record<string, unknown>; error?: unknown }
        try { message = JSON.parse(line) as typeof message } catch (error) {
          fail(new Error(`casper acp wrote a line that is not JSON: ${line.slice(0, 200)}`, { cause: error }))
          return
        }
        if (message.method === undefined && message.id !== undefined) replies.get(message.id)?.(message)
        else if (message.method !== undefined && message.id !== undefined) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not offered by the smoke client' } })}\n`)
        }
      }
    })
    child.once('error', fail)
    child.once('exit', (code, signal) => { fail(new Error(`casper acp exited (${String(code ?? signal)}) before both replies`)) })
    const call = (id: number, method: string, params: unknown) => new Promise<Record<string, unknown>>((answer) => {
      replies.set(id, (message) => {
        if (message.result === undefined) fail(new Error(`${method} failed: ${JSON.stringify(message.error)}`))
        else answer(message.result)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
    void (async () => {
      const initialized = await call(1, 'initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
      const created = await call(2, 'session/new', { cwd, mcpServers: [] })
      clearTimeout(timer)
      child.removeAllListeners('exit')
      child.stdin.end()
      const info = initialized.agentInfo as { version?: unknown } | undefined
      resolve({ version: String(info?.version), sessionId: String(created.sessionId) })
    })()
  })
}

/**
 * Run the bundled engine and tools as a new user's computer would: an empty home, and a PATH of only the system
 * folders plus the app's tool folders, so no installed Casper, bun, Homebrew, node, or uv can answer. Checks
 * `casper --version`, `uv --version`, `npx --version`, and an ACP `initialize` plus `session/new`.
 * @param runtime - the runtime resource directory, prepared or packaged and signed.
 * @param target - the Desktop target; a target other than the build host's is not run.
 * @param versions - the pinned versions the files must report.
 * @returns true when the checks ran, false when the target cannot run here.
 */
export async function smokeCasperEngine(runtime: string, target: CasperEngineTarget, versions: PreparedCasperEngine = {
  casper: { version: lock.casper.version, sha256: lock.casper.targets[target].sha256 },
  uv: { version: lock.uv.version, sha256: lock.uv.targets[target].sha256 },
}): Promise<boolean> {
  const platform = target === 'win-x64' ? 'win32' : 'darwin'
  const arch = target.endsWith('-arm64') ? 'arm64' : 'x64'
  if (platform !== process.platform || arch !== process.arch) return false
  const layout = casperEngineLayout(runtime, platform)
  const { DSH_DESKTOP_CASPER_TOOL_PATH: toolPath } = casperEngineEnvironment(runtime, platform)
  const home = mkdtempSync(join(tmpdir(), 'dsh-casper-engine-home-'))
  try {
    const project = join(home, 'project')
    mkdirSync(project)
    const env: NodeJS.ProcessEnv = platform === 'win32'
      ? { SystemRoot: process.env.SystemRoot, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
        PATH: [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), toolPath].join(';'), CASPER_NO_UPDATE_CHECK: '1' }
      : { HOME: home, PATH: ['/usr/bin', '/bin', toolPath].join(':'), CASPER_NO_UPDATE_CHECK: '1' }
    const casperVersion = await run(layout.engine, ['--version'], env, project)
    if (!casperVersion.startsWith(`casper ${versions.casper.version} `) && casperVersion !== `casper ${versions.casper.version}`) {
      throw new Error(`casper engine smoke: casper --version printed ${JSON.stringify(casperVersion)}, expected ${versions.casper.version}`)
    }
    const exe = platform === 'win32' ? '.exe' : ''
    const uvVersion = await run(join(layout.tools, `uv${exe}`), ['--version'], env, project)
    if (!uvVersion.startsWith(`uv ${versions.uv.version}`)) throw new Error(`casper engine smoke: uv --version printed ${JSON.stringify(uvVersion)}`)
    const npm = (JSON.parse(readFileSync(join(layout.npm, 'package.json'), 'utf8')) as { version: string }).version
    const npxVersion = await run(join(layout.tools, platform === 'win32' ? 'npx.cmd' : 'npx'), ['--version'], env, project)
    if (npxVersion !== npm) throw new Error(`casper engine smoke: npx --version printed ${JSON.stringify(npxVersion)}, expected ${npm}`)
    const opened = await openCasperConversation(layout.engine, env, project)
    if (opened.version !== versions.casper.version) throw new Error(`casper engine smoke: initialize reported ${opened.version}`)
    if (opened.sessionId === '' || opened.sessionId === 'undefined') throw new Error('casper engine smoke: session/new returned no session id')
    console.log(`casper engine smoke: casper ${opened.version} answered initialize and session/new on an empty home; uv ${versions.uv.version}, npx ${npm}`)
    return true
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}
