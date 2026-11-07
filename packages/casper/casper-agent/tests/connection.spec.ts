import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { AvailableCommand, CreateElicitationRequest, CreateElicitationResponse, SessionConfigOption, SessionNotification } from '@agentclientprotocol/sdk'
import { randomBytes } from 'node:crypto'
import { appToolsEntry } from '../src/app-tools.ts'
import type { AppToolsServer } from '../src/app-tools.ts'
import { CasperConnection, CasperError, casperArgv, casperEnv, profileEnv } from '../src/connection.ts'
import type { CasperConnectionHandlers, CasperConnectionOptions } from '../src/connection.ts'
import type { Config } from '../src/config.ts'
import { forwardedServers } from '../src/forward-servers.ts'
import type { ForwardedServers } from '../src/forward-servers.ts'
import { alive, casperModes, casperOptions, fakeCasper, gate, optionsWithoutMode, waitFor, withPlan } from './support.ts'
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
  const commands: AvailableCommand[][] = []
  const configs: SessionConfigOption[][] = []
  const modes: string[] = []
  const plans: boolean[] = []
  const forms: { params: CreateElicitationRequest; signal: AbortSignal }[] = []
  const form = { reply: (_params: CreateElicitationRequest, _signal: AbortSignal): Promise<CreateElicitationResponse> => Promise.resolve({ action: 'cancel' }) }
  const handlers: CasperConnectionHandlers = {
    update: (notification) => { updates.push(notification) },
    commands: (list) => { commands.push([...list]) },
    config: (options) => { configs.push([...options]) },
    mode: (modeId) => { modes.push(modeId) },
    plan: (active) => { plans.push(active) },
    permission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
    elicitation: (params, signal) => {
      forms.push({ params, signal })
      return form.reply(params, signal)
    },
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
  return { fake, ctx, updates, commands, configs, modes, plans, forms, form, handlers, start }
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

  it('takes pictures only when the initialize reply sets promptCapabilities.image to true', async () => {
    const { fake, start } = await setup()
    expect((await start()).connection.acceptsImages).toBe(false)
    fake.script({ prompts: [], promptCapabilities: { image: true, audio: false, embeddedContext: true } })
    expect((await start()).connection.acceptsImages).toBe(true)
    fake.script({ prompts: [], promptCapabilities: {} })
    expect((await start()).connection.acceptsImages).toBe(false)
  })

  it('takes embedded context only when the initialize reply sets promptCapabilities.embeddedContext to true', async () => {
    const { fake, start } = await setup()
    expect((await start()).connection.acceptsEmbeddedContext).toBe(false)
    fake.script({ prompts: [], promptCapabilities: { image: false, audio: false, embeddedContext: true } })
    expect((await start()).connection.acceptsEmbeddedContext).toBe(true)
    fake.script({ prompts: [], promptCapabilities: { image: true } })
    expect((await start()).connection.acceptsEmbeddedContext).toBe(false)
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

  it('hands Casper\'s command lists to their handler after session/new, during a load\'s replay, and mid-prompt', async () => {
    const status = { name: 'status', description: 'Inspect project, model, auth and integrations' }
    const review = { name: 'review', description: 'Review changes', input: { hint: '[branch|commit]' } }
    const { start, updates, commands } = await setup({
      prompts: [[{ commandsUpdate: [status] }, { text: 'done\n' }]], known: ['stored-1'], replay: ['earlier request'], commands: [status, review],
    })
    const fresh = await start()
    await waitFor(() => commands.length === 1)
    expect(commands).toEqual([[status, review]])
    await fresh.connection.prompt([{ type: 'text', text: 'go' }])
    expect(commands.at(-1)).toEqual([status])
    expect(updates.map(entry => entry.update.sessionUpdate)).toEqual(['agent_message_chunk', 'agent_message_chunk'])
    commands.length = 0
    updates.length = 0
    await start({}, 'stored-1')
    // The replayed chunks are dropped, but the list sent with them is not.
    expect(commands).toEqual([[status, review]])
    expect(updates).toEqual([])
  })

  it('keeps Casper\'s options from session/new and session/load, and hands option updates to their handler during a replay too', async () => {
    const opus = casperOptions('claude-subscription/claude-opus-5-5')
    const { start, updates, configs } = await setup({
      prompts: [[{ configUpdate: opus }, { text: 'done\n' }]], known: ['stored-1'], configOptions: casperOptions(), replayConfig: true,
    })
    const fresh = await start()
    expect(fresh.connection.configOptions).toEqual(casperOptions())
    await fresh.connection.prompt([{ type: 'text', text: 'go' }])
    expect(configs).toEqual([opus])
    expect(fresh.connection.configOptions).toEqual(opus)
    expect(updates.map(entry => entry.update.sessionUpdate)).toEqual(['agent_message_chunk', 'agent_message_chunk'])
    configs.length = 0
    const loaded = await start({}, 'stored-1')
    expect(configs).toEqual([casperOptions()])
    expect(loaded.connection.configOptions).toEqual(casperOptions())
    expect(updates).toHaveLength(2)
  })

  it('offers no options for a Casper whose replies carry none', async () => {
    const { start } = await setup({ prompts: [], known: ['stored-1'] })
    expect((await start()).connection.configOptions).toBeUndefined()
    expect((await start({}, 'stored-1')).connection.configOptions).toBeUndefined()
  })

  it('sets an option, keeps the list Casper replies with, and maps a refusal to its RPC code without changing the list', async () => {
    const { fake, start } = await setup({ prompts: [], configOptions: casperOptions(), setFails: { effort: 'Casper is working on a prompt; change the model or effort when it ends' } })
    const { connection, acpSessionId } = await start()
    const after = await connection.setConfigOption('model', 'claude-subscription/claude-opus-5-5')
    expect(fake.calls('session/set_config_option').map(entry => entry.params)).toEqual([
      { sessionId: acpSessionId, configId: 'model', value: 'claude-subscription/claude-opus-5-5' },
    ])
    expect(after).toEqual(casperOptions('claude-subscription/claude-opus-5-5'))
    expect(connection.configOptions).toEqual(after)
    const unlisted = await connection.setConfigOption('model', 'openai-codex/gone').catch((error: unknown) => error)
    expect(codeOf(unlisted)).toBe('CASPER_RPC_-32602')
    const busy = await connection.setConfigOption('effort', 'high').catch((error: unknown) => error)
    expect(busy).toMatchObject({ code: 'CASPER_RPC_-32603', message: 'Casper failed: Casper is working on a prompt; change the model or effort when it ends' })
    expect(connection.configOptions).toEqual(after)
  })

  it('keeps Casper\'s Plan first option and hands each change to its handler, a set\'s reply included', async () => {
    const later = withPlan('on').map(option => option.id === 'plan' ? { ...option, currentValue: 'later' } : option)
    const { start, plans } = await setup({
      prompts: [
        [{ configUpdate: withPlan('on') }, { configUpdate: withPlan('on') }, { text: 'planned\n' }],
        // A value other than on or off, or no option at all, is no Plan first option.
        [{ configUpdate: later }, { configUpdate: casperOptions() }, { text: 'gone\n' }],
      ],
      configOptions: withPlan('off'),
    })
    const { connection } = await start()
    expect(connection.planMode).toBe(false)
    expect(plans).toEqual([])
    await connection.prompt([{ type: 'text', text: '/plan on' }])
    // An unchanged list says nothing.
    expect(plans).toEqual([true])
    expect(connection.planMode).toBe(true)
    await connection.setConfigOption('plan', 'off')
    expect(plans).toEqual([true, false])
    expect(connection.planMode).toBe(false)
    await connection.setConfigOption('model', 'claude-subscription/claude-opus-5-5')
    expect(plans).toEqual([true, false])
    await connection.prompt([{ type: 'text', text: 'next' }])
    expect(connection.planMode).toBeUndefined()
    expect(plans).toEqual([true, false])

    const older = await setup({ prompts: [], configOptions: casperOptions() })
    const second = await older.start()
    expect(second.connection.planMode).toBeUndefined()
    await second.connection.setConfigOption('effort', 'high')
    expect(older.plans).toEqual([])
  })

  it('keeps Casper\'s access mode, and hands a mode Casper changes itself to its handler once, during a replay too', async () => {
    const { start, updates, modes } = await setup({
      prompts: [[{ mode: 'full' }, { text: 'done\n' }]], known: ['stored-1'], configOptions: casperOptions(), modes: casperModes(), replayMode: 'read',
    })
    const fresh = await start()
    expect(fresh.connection.accessMode).toBe('ask')
    await fresh.connection.prompt([{ type: 'text', text: 'go' }])
    // Casper reports its own change twice, as current_mode_update and in the option list; the handler hears it once.
    expect(modes).toEqual(['full'])
    expect(fresh.connection.accessMode).toBe('full')
    expect(updates.map(entry => entry.update.sessionUpdate)).toEqual(['agent_message_chunk', 'agent_message_chunk'])
    modes.length = 0
    const loaded = await start({}, 'stored-1')
    expect(modes).toEqual(['read'])
    expect(loaded.connection.accessMode).toBe('read')
    expect(updates).toHaveLength(2)
  })

  it('sets the access mode through Casper\'s mode option, else through session/set_mode, and stores it only once Casper takes it', async () => {
    const withOption = await setup({ prompts: [], configOptions: casperOptions(), modes: casperModes() })
    const first = await withOption.start()
    await first.connection.setAccess('read')
    expect(withOption.fake.calls('session/set_config_option').map(entry => entry.params)).toEqual([
      { sessionId: first.acpSessionId, configId: 'mode', value: 'read' },
    ])
    expect(withOption.fake.calls('session/set_mode')).toEqual([])
    expect(first.connection.accessMode).toBe('read')
    // A client set is not echoed to the handler.
    expect(withOption.modes).toEqual([])

    const modesOnly = await setup({ prompts: [], configOptions: optionsWithoutMode(), modes: casperModes() })
    const second = await modesOnly.start()
    expect(second.connection.accessMode).toBe('ask')
    await second.connection.setAccess('full')
    expect(modesOnly.fake.calls('session/set_mode').map(entry => entry.params)).toEqual([{ sessionId: second.acpSessionId, modeId: 'full' }])
    expect(second.connection.accessMode).toBe('full')
    const unknown = await second.connection.setAccess('nope').catch((error: unknown) => error)
    expect(unknown).toMatchObject({ code: 'CASPER_RPC_-32602', message: 'Casper failed: Unknown mode: nope (read, ask, full)' })
    expect(second.connection.accessMode).toBe('full')

    const refusing = await setup({ prompts: [], modes: casperModes(), setModeError: 'acp_access is off' })
    const third = await refusing.start()
    expect(await third.connection.setAccess('full').catch(codeOf)).toBe('CASPER_RPC_-32603')
    expect(third.connection.accessMode).toBe('ask')

    const older = await setup({ prompts: [] })
    const fourth = await older.start()
    expect(fourth.connection.accessMode).toBeUndefined()
    const none = await fourth.connection.setAccess('read').catch((error: unknown) => error)
    expect(codeOf(none)).toBe('CASPER_NO_ACCESS_MODES')
    expect(older.fake.log().filter(entry => entry.method?.startsWith('session/set') === true)).toEqual([])
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

  it('initialize offers form elicitation and routes elicitation/create to the handler', async () => {
    const { fake, start, updates, forms, form } = await setup({ prompts: [[
      { elicit: { question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }], typed: true, from: 'ai' } },
      { elicit: { question: 'Port?', timeoutMs: 200 } },
    ]] })
    const withdrawn: string[] = []
    form.reply = (params, signal) => params.message === 'Which database?'
      ? Promise.resolve({ action: 'accept', content: { answer: '2', other: 'version 16' } })
      : new Promise((resolve) => {
        signal.addEventListener('abort', () => { withdrawn.push(params.message); resolve({ action: 'cancel' }) }, { once: true })
      })
    const { connection } = await start()
    expect(fake.calls('initialize')[0]?.params).toMatchObject({ clientCapabilities: { elicitation: { form: {} } } })
    expect(await connection.prompt([{ type: 'text', text: 'go' }])).toBe('end_turn')
    expect(forms[0]?.params).toMatchObject({
      sessionId: fake.calls('session/prompt')[0]?.params?.sessionId, toolCallId: 'casper-question-1', mode: 'form', message: 'Which database?',
      _meta: { casper: { question: { from: 'ai', multi: false, typed: true } } },
    })
    expect(fake.log().filter(entry => entry.event === 'elicitation').map(entry => entry.reply ?? { timedOut: entry.timedOut }))
      .toEqual([{ action: 'accept', content: { answer: '2', other: 'version 16' } }, { timedOut: true }])
    // Casper withdrawing its request aborts the handler's signal.
    await waitFor(() => withdrawn.length === 1)
    expect(updates.flatMap(({ update }) => update.sessionUpdate === 'tool_call_update' ? [[update.toolCallId, update.status]] : [])).toEqual([
      ['casper-question-1', 'completed'], ['casper-question-2', 'failed'],
    ])
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

describe('the app\'s own MCP servers', { timeout: 30_000 }, () => {
  const SECRET = 'ghp-forwarded-secret'
  /** A builder over one stdio and one http Settings server that counts its credential reads. */
  function builder(): { build: (signal: AbortSignal) => Promise<ForwardedServers>; reads: () => number } {
    let reads = 0
    const build = (signal: AbortSignal): Promise<ForwardedServers> => forwardedServers({
      entries: {
        github: { transport: 'stdio', command: '/usr/bin/github-mcp', args: [], env: { GITHUB_TOKEN: '${credential:GITHUB_TOKEN}' }, cwd: '/work', url: '', headers: {}, enabled: true },
        docs: { transport: 'streamable-http', command: '', args: [], env: {}, cwd: '', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer ${credential:GITHUB_TOKEN}' }, enabled: true },
      },
      credential: () => { reads += 1; return Promise.resolve(SECRET) },
      resolveExecutable: command => Promise.resolve(command),
      signal,
      skip: () => {},
    })
    return { build, reads: () => reads }
  }

  it('with http true both session/new and session/load get the bridge then the forwarded servers', async () => {
    const { fake, start } = await setup({ prompts: [], known: ['stored-1'], mcpHttp: true })
    const { build } = builder()
    const bridge = stubServer()
    const appTools = (): Promise<AppToolsServer> => Promise.resolve(bridge)
    const fresh = await start({}, undefined, undefined, { appTools, mcpServers: build })
    const reopened = await start({}, 'stored-1', undefined, { appTools, mcpServers: build })
    const forwarded = (await build(new AbortController().signal)).entries
    expect(forwarded.map(entry => entry.name)).toEqual(['github', 'docs'])
    expect(fake.calls('session/new')[0]?.params).toEqual({ cwd: fake.cwd, mcpServers: [appToolsEntry(bridge), ...forwarded] })
    expect(fake.calls('session/load')[0]?.params).toEqual({ sessionId: 'stored-1', cwd: fake.cwd, mcpServers: [appToolsEntry(bridge), ...forwarded] })
    for (const { connection } of [fresh, reopened]) {
      expect(connection.forwardedNames).toEqual(['github', 'docs'])
      expect(connection.forwardedDigest).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('with http false nothing is forwarded and no credential is resolved', async () => {
    const { fake, start } = await setup({ prompts: [] })
    const { build, reads } = builder()
    const { connection } = await start({}, undefined, undefined, { mcpServers: build })
    expect(fake.calls('session/new')[0]?.params).toEqual({ cwd: fake.cwd, mcpServers: [] })
    expect(reads()).toBe(0)
    expect(connection.forwardedNames).toEqual([])
    expect(connection.forwardedDigest).toBeUndefined()
  })

  it('no forwarded value appears in Casper\'s argv or env', async () => {
    const { fake, start } = await setup({ prompts: [], mcpHttp: true })
    const { build, reads } = builder()
    const { connection } = await start({}, undefined, undefined, { mcpServers: build })
    expect(reads()).toBeGreaterThan(0)
    const opened = fake.calls('session/new')[0]
    expect(JSON.stringify(opened?.params)).toContain(SECRET)
    expect(opened?.exposed).toEqual({ argv: false, env: false })
    expect(connection.stderrTail()).not.toContain(SECRET)
  })
})
