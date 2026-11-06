import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import { randomBytes } from 'node:crypto'
import { appToolsEntry } from '../src/app-tools.ts'
import type { AppToolsServer } from '../src/app-tools.ts'
import { CasperConnection, CasperError, casperArgv, casperEnv, profileEnv } from '../src/connection.ts'
import type { CasperConnectionHandlers, CasperConnectionOptions } from '../src/connection.ts'
import type { Config } from '../src/config.ts'
import { alive, fakeCasper, gate, waitFor } from './support.ts'
import type { FakeScript } from './support.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(script: FakeScript = { prompts: [] }) {
  const fake = fakeCasper(script)
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  cleanups.push(() => { fake.remove() }, () => ctx.fiber.dispose())
  const updates: SessionNotification[] = []
  const handlers: CasperConnectionHandlers = {
    update: (notification) => { updates.push(notification) },
    permission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
  }
  const start = async (
    overrides: Partial<Config> = {},
    stored?: string,
    signal = new AbortController().signal,
    extra: Partial<CasperConnectionOptions> = {},
  ) => {
    const options = { subprocess: ctx.subprocess, config: fake.config(overrides), cwd: fake.cwd, handlers, ...extra }
    const started = await CasperConnection.start(options, stored, signal)
    cleanups.push(() => started.connection.dispose())
    return started
  }
  return { fake, ctx, updates, handlers, start }
}

/** A stand-in app tools server with a fresh token that records whether it was closed. */
function stubServer(): AppToolsServer & { closed: () => boolean } {
  let closed = false
  return {
    url: `http://127.0.0.1:9/mcp/${randomBytes(16).toString('base64url')}`,
    token: randomBytes(32).toString('base64url'),
    close: () => { closed = true; return Promise.resolve() },
    closed: () => closed,
  }
}

function codeOf(error: unknown): string | undefined {
  return error instanceof CasperError ? error.code : undefined
}

describe('casperArgv and casperEnv', () => {
  it('appends model and effort only when configured', () => {
    expect(casperArgv('/bin/casper', { args: ['acp'] })).toEqual(['/bin/casper', 'acp'])
    expect(casperArgv('/bin/casper', { args: ['acp'], model: 'm', effort: 'e' })).toEqual(['/bin/casper', 'acp', '--model', 'm', '--effort', 'e'])
  })

  it('gives the profile name and folder only when the app has a profile', () => {
    expect(profileEnv({ name: 'desktop', dir: '/profiles/desktop' })).toEqual({ DSH_PROFILE: 'desktop', DSH_PROFILE_DIR: '/profiles/desktop' })
    expect(profileEnv(undefined)).toEqual({})
  })

  it('removes every ambient DEEPSEEK_ name and keeps configured entries', () => {
    expect(casperEnv({ PATH: '/x', DEEPSEEK_KEEP: 'chosen' }, { DEEPSEEK_BASE_URL: 'u', deepseek_lower: 'l', HOME: '/home/user' }))
      .toEqual({ DEEPSEEK_BASE_URL: undefined, deepseek_lower: undefined, PATH: '/x', DEEPSEEK_KEEP: 'chosen' })
  })
})

describe('CasperConnection', { timeout: 30_000 }, () => {
  it('starts Casper with its arguments and an environment without DeepSeek or harness names', async () => {
    const { fake, start } = await setup()
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test-value')
    vi.stubEnv('DEEPSEEK_BASE_URL', 'https://example.invalid')
    vi.stubEnv('DSH_CASPER_AGENT_TEST', 'harness')
    const base = fake.config()
    const started = await start({ model: 'm', effort: 'e', env: { ...base.env, PATH: `/opt/fake/.bun/bin:${process.env.PATH ?? ''}`, OPENROUTER_API_KEY: 'or-test' } })
    expect(started.reopened).toBe(false)
    expect(started.acpSessionId).toMatch(/^[0-9a-f-]{36}$/)
    const launch = fake.log().find(entry => entry.event === 'start')
    expect(launch?.argv).toEqual(['acp', '--model', 'm', '--effort', 'e'])
    expect(launch?.path?.split(':')[0]).toBe('/opt/fake/.bun/bin')
    expect(launch?.cwd).toBe(fake.cwd)
    expect(launch?.envNames).toContain('OPENROUTER_API_KEY')
    expect(launch?.envNames?.filter(name => /^(DEEPSEEK_|DSH_)/i.test(name))).toEqual([])
    expect(fake.calls('initialize')[0]?.params).toMatchObject({ clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
    expect(fake.calls('session/new')[0]?.params).toEqual({ cwd: fake.cwd, mcpServers: [] })
  })

  it('passes the app profile to Casper as DSH_PROFILE and DSH_PROFILE_DIR', async () => {
    const { fake, start } = await setup()
    await start({}, undefined, undefined, { profile: { name: 'desktop', dir: join(fake.root, 'profile') } })
    expect(fake.log().find(entry => entry.event === 'start')?.profile).toEqual({ name: 'desktop', dir: join(fake.root, 'profile') })
  })

  it('offers the app tools server in session/new and session/load, never in argv, env, or stderr', async () => {
    const { fake, start } = await setup({ prompts: [], known: ['stored-1'] })
    const servers: ReturnType<typeof stubServer>[] = []
    const appTools = (): Promise<AppToolsServer> => { const server = stubServer(); servers.push(server); return Promise.resolve(server) }
    const fresh = await start({}, undefined, undefined, { appTools })
    const reopened = await start({}, 'stored-1', undefined, { appTools })
    expect(servers).toHaveLength(2)
    const [first, second] = servers
    expect(fake.calls('session/new')[0]?.params).toEqual({ cwd: fake.cwd, mcpServers: [appToolsEntry(first ?? stubServer())] })
    expect(fake.calls('session/load')[0]?.params).toEqual({ sessionId: 'stored-1', cwd: fake.cwd, mcpServers: [appToolsEntry(second ?? stubServer())] })
    expect(first?.token).not.toBe(second?.token)
    expect(first?.url).not.toBe(second?.url)
    for (const entry of [...fake.calls('session/new'), ...fake.calls('session/load')]) expect(entry.exposed).toEqual({ argv: false, env: false })
    for (const { connection } of [fresh, reopened]) {
      for (const server of servers) expect(connection.stderrTail()).not.toContain(server.token)
    }
  })

  it('closes the app tools server on dispose, on terminate, and when Casper exits', async () => {
    const { fake, start } = await setup({ prompts: [[{ crash: 3 }]] })
    const servers: ReturnType<typeof stubServer>[] = []
    const appTools = (): Promise<AppToolsServer> => { const server = stubServer(); servers.push(server); return Promise.resolve(server) }
    const disposed = await start({}, undefined, undefined, { appTools })
    expect(servers[0]?.closed()).toBe(false)
    await disposed.connection.dispose()
    expect(servers[0]?.closed()).toBe(true)
    const terminated = await start({}, undefined, undefined, { appTools })
    terminated.connection.terminate()
    expect(servers[1]?.closed()).toBe(true)
    const crashed = await start({}, undefined, undefined, { appTools })
    await crashed.connection.prompt([{ type: 'text', text: 'go' }]).catch(() => {})
    await waitFor(() => servers[2]?.closed())
    expect(fake.calls('session/new')).toHaveLength(3)
  })

  it('fails the start and closes a server whose process stopped while the server started', async () => {
    const { start } = await setup()
    const server = stubServer()
    const failure = await start({}, undefined, undefined, {
      appTools: (connection) => { connection.terminate(); return Promise.resolve(server) },
    }).catch((error: unknown) => error)
    expect(codeOf(failure)).toBe('CASPER_START_FAILED')
    expect(server.closed()).toBe(true)
  })

  it('reopens a stored conversation and drops its replayed updates', async () => {
    const { fake, start, updates } = await setup({ prompts: [], known: ['stored-1'], replay: ['earlier request'] })
    const started = await start({}, 'stored-1')
    expect(started).toMatchObject({ acpSessionId: 'stored-1', reopened: true })
    expect(fake.calls('session/load')[0]?.params).toEqual({ sessionId: 'stored-1', cwd: fake.cwd, mcpServers: [] })
    expect(fake.calls('session/new')).toEqual([])
    expect(updates).toEqual([])
  })

  it('starts a fresh conversation only when Casper has no saved one', async () => {
    const { fake, start } = await setup({ prompts: [] })
    const started = await start({}, 'gone-1')
    expect(started.reopened).toBe(false)
    expect(started.acpSessionId).not.toBe('gone-1')
    expect(fake.calls('session/new')).toHaveLength(1)
  })

  it('treats both of Casper\'s real no-saved-conversation replies as a missing conversation', async () => {
    const { fake, start } = await setup({ prompts: [], loadError: '--resume: no saved conversation in this workspace starts with "gone-2". Run casper /resume to list them.' })
    expect((await start({}, 'gone-2')).reopened).toBe(false)
    fake.script({ prompts: [], loadError: `No saved conversation gone-3 in ${fake.cwd}` })
    expect((await start({}, 'gone-3')).reopened).toBe(false)
    expect(fake.calls('session/new')).toHaveLength(2)
  })

  it('fails the start and keeps the conversation when the load fails for another reason', async () => {
    const { fake, start } = await setup({ prompts: [], loadError: 'Login expired for the selected provider' })
    const failure = await start({}, 'stored-2').catch((error: unknown) => error)
    expect(codeOf(failure)).toBe('CASPER_START_FAILED')
    expect(String(failure)).toContain('Login expired')
    expect(fake.calls('session/new')).toEqual([])
  })

  it('reports a command that cannot be found or run as not installed', async () => {
    const { fake, start } = await setup()
    const missing = await start({ command: 'casper-not-installed-for-test' }).catch((error: unknown) => error)
    expect(codeOf(missing)).toBe('CASPER_NOT_FOUND')
    expect(String(missing)).toContain('casper-not-installed-for-test')
    expect(codeOf(await start({ command: fake.root }).catch((error: unknown) => error))).toBe('CASPER_NOT_FOUND')
    // Windows has no execute bit: access(X_OK) accepts any file there.
    if (process.platform !== 'win32') {
      const plain = join(fake.root, 'not-executable')
      writeFileSync(plain, '#!/bin/sh\n')
      chmodSync(plain, 0o644)
      expect(codeOf(await start({ command: plain }).catch((error: unknown) => error))).toBe('CASPER_NOT_FOUND')
    }
    const relative = await start({ command: 'bin/casper' }).catch((error: unknown) => error)
    expect(codeOf(relative)).toBe('CASPER_START_FAILED')
    expect(fake.pids()).toEqual([])
  })

  it('fails and kills a start that runs past its limit', async () => {
    const { fake, start } = await setup()
    fake.script({ prompts: [], holdInitialize: gate(fake, 'never').path })
    const failure = await start({ startTimeoutMs: 1_500 }).catch((error: unknown) => error)
    expect(codeOf(failure)).toBe('CASPER_START_FAILED')
    expect(String(failure)).toContain('did not start within 1500 ms')
    await waitFor(() => fake.pids().every(pid => !alive(pid)))
  })

  it('kills the child when the start is aborted', async () => {
    const { fake, start } = await setup()
    fake.script({ prompts: [], holdInitialize: gate(fake, 'never').path })
    const controller = new AbortController()
    const starting = start({}, undefined, controller.signal).catch((error: unknown) => error)
    await waitFor(() => fake.calls('initialize').length === 1)
    controller.abort(new Error('stopped by test'))
    const failure = await starting
    expect(failure).toMatchObject({ message: 'Casper start was stopped', cause: { message: 'stopped by test' } })
    const [pid] = fake.pids()
    await waitFor(() => !alive(pid ?? 0))
  })

  it('fails a start whose folder is gone before spawning', async () => {
    const { fake, ctx, handlers } = await setup()
    const failure = await CasperConnection.start(
      { subprocess: ctx.subprocess, config: fake.config(), cwd: join(fake.root, 'deleted'), handlers }, undefined, new AbortController().signal,
    ).catch((error: unknown) => error)
    expect(codeOf(failure)).toBe('CASPER_START_FAILED')
    expect(fake.pids()).toEqual([])
  })

  it('fails a start whose spawn request is refused', async () => {
    const { fake, start } = await setup()
    const failure = await start({ killGraceMs: 2 ** 40 }).catch((error: unknown) => error)
    expect(codeOf(failure)).toBe('CASPER_START_FAILED')
    expect(fake.pids()).toEqual([])
  })

  it('fails a start whose process exits, with its stderr', async () => {
    const { fake, start } = await setup()
    const failure = await start({ args: ['-e', 'process.stderr.write("broken install\\n"); process.exit(4)'] }).catch((error: unknown) => error)
    expect(codeOf(failure)).toBe('CASPER_START_FAILED')
    expect(String(failure)).toMatch(/exited while starting \(exit code 4\)[\s\S]*broken install/)
    expect(fake.pids()).toEqual([])
  })

  it('delivers every update before the prompt reply resolves', async () => {
    const { start, updates } = await setup({ prompts: [[{ text: 'one\n' }, { tool: 'bash', target: 'ls' }, { toolEnd: 1 }]] })
    const { connection } = await start()
    expect(await connection.prompt([{ type: 'text', text: 'go' }])).toBe('end_turn')
    expect(updates.map(entry => entry.update.sessionUpdate)).toEqual(['agent_message_chunk', 'tool_call', 'tool_call_update', 'agent_message_chunk'])
    expect(updates.at(-1)?.update).toMatchObject({ _meta: { casper: { receipt: { outcome: 'verified' } } } })
    expect(connection.toolCallId('casper-tool-1')).toBe(`casper:${connection.epoch}:casper-tool-1`)
  })

  it('rejects the prompt with the exit and stderr when Casper exits mid-prompt', async () => {
    const { start } = await setup({ prompts: [[{ text: 'partial\n' }, { stderr: 'out of memory' }, { crash: 3 }]] })
    const { connection } = await start()
    const failure = await connection.prompt([{ type: 'text', text: 'go' }]).catch((error: unknown) => error)
    expect(codeOf(failure)).toBe('CASPER_EXITED')
    expect(String(failure)).toMatch(/exit code 3[\s\S]*out of memory/)
    expect(connection.dead).toBe(true)
  })

  it('maps an error reply to its RPC code and keeps the connection', async () => {
    const { start } = await setup({ prompts: [[{ fail: 'runtime failed' }], []] })
    const { connection } = await start()
    const failure = await connection.prompt([{ type: 'text', text: 'go' }]).catch((error: unknown) => error)
    expect(codeOf(failure)).toBe('CASPER_RPC_-32603')
    expect(connection.dead).toBe(false)
    expect(await connection.prompt([{ type: 'text', text: 'again' }])).toBe('end_turn')
  })

  it('sends session/cancel once per prompt', async () => {
    const { fake, start } = await setup({ prompts: [[{ hang: true }]] })
    const { connection } = await start()
    const reply = connection.prompt([{ type: 'text', text: 'go' }])
    await waitFor(() => fake.calls('session/prompt').length === 1)
    connection.cancel()
    connection.cancel()
    expect(await reply).toBe('cancelled')
    expect(fake.calls('session/cancel')).toHaveLength(1)
  })

  it('closes stdin and waits for a cooperative exit on dispose', async () => {
    const { fake, start } = await setup()
    const { connection } = await start()
    const [pid] = fake.pids()
    await connection.dispose()
    await connection.dispose()
    expect(fake.log().some(entry => entry.event === 'eof')).toBe(true)
    expect(alive(pid ?? 0)).toBe(false)
    expect(connection.dead).toBe(true)
    connection.cancel()
  })

  it('kills a child that ignores stdin EOF after the exit grace', async () => {
    const { fake, start } = await setup({ prompts: [], ignoreEof: true })
    const { connection } = await start({ exitGraceMs: 200, killGraceMs: 500 })
    const [pid] = fake.pids()
    await connection.dispose()
    expect(alive(pid ?? 0)).toBe(false)
  })
})
