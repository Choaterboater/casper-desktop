/** A Casper Session offers Casper the app's tools: Casper's calls run as the Casper Agent inside its turn, under its step's call id. */

import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { TURN_OVER } from '../src/app-tools.ts'
import { boot, eventsOf, prompt } from './harness.ts'
import { fakeCasper, parsed, waitFor } from './support.ts'
import type { FakeLogEntry, FakeScript } from './support.ts'

/** The app's runtime version in these tests; no package carries it, so a fallback cannot pass for it. */
const { RUNTIME_VERSION } = vi.hoisted(() => ({ RUNTIME_VERSION: '9.8.7-runtime' }))

vi.mock('@deepseek-ai/dsh-app-boot', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-app-boot')>(),
  getDshRuntimeVersion: () => RUNTIME_VERSION,
}))

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A Host with the app tools on and a stand-in `cordis_inspect_query` that records what it saw. */
async function host(script: FakeScript) {
  const fake = fakeCasper(script)
  cleanups.push(() => { fake.remove() })
  const booted = await boot(fake, { appTools: true })
  cleanups.push(() => booted.ctx.fiber.dispose())
  const seen: ToolExecution[] = []
  booted.ctx.tools.register(defineTool({
    name: 'cordis_inspect_query', description: 'Run a read-only query.',
    parameters: { platform: { type: 'string', required: true }, provider: { type: 'string', required: true }, method: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: (args, exec) => { seen.push(exec); return Promise.resolve(`queried ${args.method}`) },
  }))
  return { fake, booted, seen }
}

/** The app server entries Casper was offered, in order. */
function offered(fake: { log(): FakeLogEntry[] }): { url: string; token: string }[] {
  return fake.log().flatMap((entry) => {
    if (entry.method !== 'session/new' && entry.method !== 'session/load') return []
    const servers = (entry.params?.['mcpServers'] ?? []) as { url: string; headers: { value: string }[] }[]
    return servers.map(server => ({ url: server.url, token: server.headers[0]?.value.replace(/^Bearer /, '') ?? '' }))
  })
}

/** Whether a POST to `url` with `token` gets any HTTP answer. */
function reachable(url: string, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sent = httpRequest(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, (response) => {
      response.resume()
      resolve(true)
    })
    sent.on('error', () => { resolve(false) })
    sent.end('{}')
  })
}

const QUERY = { platform: 'client', provider: 'Slots', method: 'listSubTree' }

describe('app tools in a Casper Session', { timeout: 60_000 }, () => {
  it('runs Casper\'s call as the Casper Agent under the call id of the step that made it, on a server named with the app version', async () => {
    const { fake, booted, seen } = await host({ prompts: [[
      { tool: 'cordis_inspect_query', target: 'Slots', rawInput: QUERY, meta: { tool: 'mcp', mcp: { server: 'acp-app', tool: 'cordis_inspect_query' } } },
      { mcp: 'cordis_inspect_query', args: QUERY },
      { toolEnd: 1, content: ['Casper\'s own copy of the output'] },
    ]] })
    const { agent } = await booted.create('casper-app-call')
    agent.followup(prompt('show the slots'))
    await agent.whenIdle()
    const call = fake.log().find(entry => entry.event === 'mcp')
    expect(call?.result).toEqual({ content: [{ type: 'text', text: 'queried listSubTree' }], isError: false })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.agent).toBe(agent)
    const recorded = eventsOf(agent).flatMap(event => event.type === 'tool/call' ? [event.data.callId] : [])
    expect(recorded).toHaveLength(1)
    expect(seen[0]?.callId).toBe(recorded[0])
    expect(seen[0]?.callId).toMatch(/^casper:[0-9a-f]{8}:casper-tool-1$/)
    expect(call?.server).toEqual({ name: 'dsh-desktop', version: RUNTIME_VERSION })
    // The step is recorded as the app tool, with the app tool's own result.
    const named = eventsOf(agent).flatMap(event => event.type === 'tool/call' ? [[event.data.name, parsed(event.data.arguments)]] : [])
    expect(named).toEqual([['cordis_inspect_query', QUERY]])
    const result = eventsOf(agent).find(event => event.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.content).toEqual([{ type: 'text', text: 'queried listSubTree' }])
    const [entry] = offered(fake)
    expect(JSON.stringify(eventsOf(agent))).not.toContain(entry?.token)
  })

  it('refuses a call that arrives after the turn ended', async () => {
    const { fake, booted, seen } = await host({ prompts: [[{ late: { mcp: 'cordis_inspect_query', args: QUERY } }]] })
    const { agent } = await booted.create('casper-app-late')
    agent.followup(prompt('go'))
    await agent.whenIdle()
    const late = await waitFor(() => fake.log().find(entry => entry.event === 'mcp'))
    expect(late.result).toEqual({ content: [{ type: 'text', text: TURN_OVER }], isError: true })
    expect(seen).toEqual([])
  })

  it('withdraws a pending app call when the user stops the turn', async () => {
    const { fake, booted } = await host({ prompts: [[
      { tool: 'plugin_manager', target: 'install_bundle' },
      { mcp: 'plugin_manager', args: { action: 'install_bundle' } },
      { toolEnd: 1 },
    ]] })
    let pending: AbortSignal | undefined
    booted.ctx.tools.register(defineTool({
      name: 'plugin_manager', description: 'Waits for its approval card.', parameters: { action: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: (_args, exec) => {
        pending = exec.signal
        return new Promise((_resolve, reject) => {
          exec.signal.addEventListener('abort', () => { reject(new Error('card withdrawn')) }, { once: true })
        })
      },
    }))
    const { agent } = await booted.create('casper-app-stop')
    agent.followup(prompt('install it'))
    const signal = await waitFor(() => pending)
    expect(signal.aborted).toBe(false)
    agent.cancel({ kind: 'user' })
    await waitFor(() => signal.aborted)
    await agent.whenIdle()
    const call = await waitFor(() => fake.log().find(entry => entry.event === 'mcp'))
    expect(call.result).toMatchObject({ isError: true })
  })

  it('gives a restarted Casper a new path and token and revokes the old ones', async () => {
    const { fake, booted } = await host({ prompts: [[{ crash: 3 }], []] })
    const handle = await booted.create('casper-app-restart')
    const { agent } = handle
    agent.followup(prompt('first'))
    await agent.whenIdle()
    agent.followup(prompt('second'))
    await agent.whenIdle()
    const [first, second] = offered(fake)
    expect(first !== undefined && second !== undefined).toBe(true)
    expect(new URL(first?.url ?? '').pathname).not.toBe(new URL(second?.url ?? '').pathname)
    expect(first?.token).not.toBe(second?.token)
    expect(await reachable(first?.url ?? '', first?.token ?? '')).toBe(false)
    expect(await reachable(second?.url ?? '', second?.token ?? '')).toBe(true)
    await handle.dispose()
    expect(await reachable(second?.url ?? '', second?.token ?? '')).toBe(false)
  })

  it('gives Casper the app profile in its environment', async () => {
    const { fake, booted } = await host({ prompts: [[]] })
    const dir = join(fake.root, 'profiles', 'desktop')
    booted.ctx.provide('profileContext', {
      name: 'desktop', dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(fake.root, 'package.json'), cwd: fake.cwd, home: fake.root,
      startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
    })
    const { agent } = await booted.create('casper-app-profile')
    agent.followup(prompt('go'))
    await agent.whenIdle()
    expect(fake.log().find(entry => entry.event === 'start')?.profile).toEqual({ name: 'desktop', dir })
  })

  it('runs Casper\'s subagent call as the Casper Agent and with it as the initiator, as a Standard parent\'s call', async () => {
    const SUBAGENT_ARGS = { description: 'scan', prompt: 'Scan the folder.' }
    const script: FakeScript = { prompts: [[{ tool: 'subagent', target: 'scan' }, { mcp: 'subagent', args: SUBAGENT_ARGS }, { toolEnd: 1 }]] }
    for (const appSubagents of [true, false]) {
      const fake = fakeCasper(script)
      cleanups.push(() => { fake.remove() })
      const booted = await boot(fake, { appTools: true, appSubagents })
      cleanups.push(() => booted.ctx.fiber.dispose())
      const ran: { agent: unknown; initiator: unknown }[] = []
      booted.ctx.tools.register(defineTool({
        name: 'subagent', description: 'Start a child.',
        parameters: { description: { type: 'string', required: true }, prompt: { type: 'string', required: true } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: (_args, exec) => {
          ran.push({ agent: exec.agent, initiator: booted.ctx.agents.currentInitiator() })
          return Promise.resolve('started subagent child-1')
        },
      }))
      const { agent } = await booted.create(`casper-app-subagent-${String(appSubagents)}`)
      agent.followup(prompt('delegate'))
      await agent.whenIdle()
      const call = await waitFor(() => fake.log().find(entry => entry.event === 'mcp'))
      if (appSubagents) {
        expect(call.result).toEqual({ content: [{ type: 'text', text: 'started subagent child-1' }], isError: false })
        expect(ran).toEqual([{ agent, initiator: agent }])
      } else {
        // Off: the tool is not listed, so Casper's call finds no such tool and nothing runs.
        expect(call.error).toMatch(/Tool subagent not found/)
        expect(ran).toEqual([])
      }
    }
  })

  it('offers no server when the app tools are off', async () => {
    const fake = fakeCasper({ prompts: [[]] })
    cleanups.push(() => { fake.remove() })
    const booted = await boot(fake, { appTools: false })
    cleanups.push(() => booted.ctx.fiber.dispose())
    const { agent } = await booted.create('casper-app-off')
    agent.followup(prompt('go'))
    await agent.whenIdle()
    expect(fake.calls('session/new')[0]?.params?.['mcpServers']).toEqual([])
  })
})
