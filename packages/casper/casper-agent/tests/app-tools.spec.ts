/** The app tools server: its listener checks, the tools it lists, and how a call reaches the app's tools. */

import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { networkInterfaces } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { createMcpToolDefinition, type McpToolOrigin } from '@deepseek-ai/dsh-mcp-client'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolBatchInput, ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  appToolsEntry,
  DESCRIPTION_MAX,
  dshNameOf,
  GOAL_RULES,
  INSTALLED_NOTE,
  mcpContent,
  NO_RESOURCES,
  PLUGIN_SKILL,
  PROGRESS_INTERVAL_MS,
  servedAnnotations,
  skillDescription,
  startAppTools,
  TURN_OVER,
} from '../src/app-tools.ts'
import type { AppToolsOptions, AppToolsServer, BridgedCall } from '../src/app-tools.ts'
import { boot } from './harness.ts'
import { fakeCasper } from './support.ts'

/** The app tools in list order, which is the order Casper takes pins in. */
const APP_TOOLS = ['app_skill', 'plugin_manager', 'app_read_file', 'present', 'cordis_inspect_query', 'cordis_inspect_list']
/** The app's subagent tools, listed after the app tools and never pinned. */
const SUBAGENT_TOOLS = ['subagent', 'send_message', 'interrupt_agent', 'list_agents', 'list_subagent_models']
/** The app's goal tools, listed after the subagent tools and never pinned. */
const GOAL_TOOLS = ['get_goal', 'create_goal', 'update_goal']
/** The resource tools, listed after the app tools. */
const RESOURCE_TOOLS = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']

/** The app version the tests start servers with; no package carries it. */
const APP_VERSION = '9.8.7-app'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** What one fake app tool saw. */
interface Seen {
  readonly name: string
  readonly args: unknown
  readonly exec: ToolExecution
}

/**
 * A Host with a Casper Agent and stand-ins for the app's plugin tools, registered globally so the Agent's scope sees them.
 * @param release - a promise `plugin_manager` waits for before it answers.
 */
async function host(release?: Promise<void>) {
  const fake = fakeCasper()
  cleanups.push(() => { fake.remove() })
  const booted = await boot(fake)
  cleanups.push(() => booted.ctx.fiber.dispose())
  const { agent } = await booted.create('casper-app-tools')
  const seen: Seen[] = []
  const text = (value: string) => [{ type: 'text' as const, text: value }]
  const tools = booted.ctx.tools
  tools.register(defineTool({
    name: 'cordis_inspect_list', description: 'List every Cordis Inspect Provider.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    execute: (args, exec) => { seen.push({ name: 'cordis_inspect_list', args, exec }); return Promise.resolve('providers') },
  }))
  tools.register(defineTool({
    name: 'cordis_inspect_query', description: 'Run a read-only query declared by an Inspect Provider.',
    parameters: {
      platform: { type: 'string', required: true, enum: ['host', 'client'] },
      provider: { type: 'string', required: true },
      method: { type: 'string', required: true },
      input: { type: 'json' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    execute: (args, exec) => { seen.push({ name: 'cordis_inspect_query', args, exec }); return Promise.resolve(`queried ${args.method}`) },
  }))
  tools.register(defineTool({
    name: 'present', description: 'Declare existing files as final deliverables for the user.',
    parameters: { files: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true } } } } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    execute: (args, exec) => { seen.push({ name: 'present', args, exec }); return Promise.resolve('presented') },
  }))
  tools.register(defineTool({
    name: 'skill', description: 'Load the full instructions for a skill.',
    parameters: { name: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    execute: (args, exec) => { seen.push({ name: 'skill', args, exec }); return Promise.resolve(`body of ${args.name}`) },
  }))
  tools.register(defineTool({
    name: 'plugin_manager', description: `Manage profile plugins. ${'More detail. '.repeat(120)}`,
    parameters: { action: { type: 'string', required: true }, target: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    execute: async (args, exec) => {
      seen.push({ name: 'plugin_manager', args, exec })
      await release
      return 'installed'
    },
  }))
  return { ctx: booted.ctx, agent, seen }
}

/** Start a server for `agent` with an open turn unless `turn` says otherwise. */
async function serve(agent: Agent, ctx: Awaited<ReturnType<typeof host>>['ctx'], overrides: Partial<AppToolsOptions> = {}): Promise<AppToolsServer> {
  const open = new AbortController()
  const server = await startAppTools({
    tools: ctx.tools,
    skills: undefined,
    agent,
    cwd: agent.session.header.cwd ?? '',
    profile: { name: 'desktop', dir: '/profiles/desktop' },
    version: APP_VERSION,
    roots: [],
    installed: false,
    turn: () => open.signal,
    callId: acpId => ToolCallId(`casper:test:${acpId}`),
    record: () => {},
    onError: () => {},
    ...overrides,
  })
  cleanups.push(() => server.close())
  return server
}

/** An MCP 1.x client, as Casper uses, connected with the server's bearer header. */
async function client(server: AppToolsServer): Promise<Client> {
  const connected = new Client({ name: 'casper-test', version: '0.0.0' })
  const headers = { Authorization: `Bearer ${server.token}` }
  await connected.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }) as Transport)
  cleanups.push(() => connected.close())
  return connected
}

/** POST an MCP initialize with exact headers and read the status. */
function post(url: string, headers: Record<string, string>): Promise<number> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } } })
  return new Promise((resolve, reject) => {
    const sent = httpRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    }, (response) => { response.resume(); resolve(response.statusCode ?? 0) })
    sent.on('error', reject)
    sent.end(body)
  })
}

describe('app tools listener', { timeout: 60_000 }, () => {
  it('answers only its own path, host, no Origin, and its bearer token', async () => {
    const { ctx, agent } = await host()
    const server = await serve(agent, ctx)
    const url = new URL(server.url)
    const auth = { authorization: `Bearer ${server.token}` }
    expect(url.hostname).toBe('127.0.0.1')
    expect(url.pathname).toMatch(/^\/mcp\/[\w-]{22}$/)
    expect(server.token).toMatch(/^[\w-]{43}$/)
    expect(await post(server.url, auth)).toBe(200)
    expect(await post(`${url.origin}/mcp/other`, auth)).toBe(404)
    expect(await post(`${url.origin}/mcp`, auth)).toBe(404)
    expect(await post(server.url, { ...auth, host: `localhost:${url.port}` })).toBe(403)
    expect(await post(server.url, { ...auth, host: 'attacker.example' })).toBe(403)
    expect(await post(server.url, { ...auth, origin: `http://127.0.0.1:${url.port}` })).toBe(403)
    expect(await post(server.url, {})).toBe(401)
    expect(await post(server.url, { authorization: `Bearer ${server.token}x` })).toBe(401)
    expect(await post(server.url, { authorization: server.token })).toBe(401)
    await server.close()
    await expect(post(server.url, auth)).rejects.toThrow()
  })

  // An address of this machine that is not loopback, when it has one.
  const external = Object.values(networkInterfaces()).flat().find(net => net?.family === 'IPv4' && !net.internal)?.address

  it.skipIf(external === undefined)('is bound to 127.0.0.1 only, so another interface of this machine is refused', async () => {
    const { ctx, agent } = await host()
    const server = await serve(agent, ctx)
    const url = new URL(server.url)
    const auth = { authorization: `Bearer ${server.token}`, host: url.host }
    expect(await post(server.url, auth)).toBe(200)
    // Even with the right Host header and token, the same port on a non-loopback address has no listener.
    await expect(post(`http://${external}:${url.port}${url.pathname}`, auth)).rejects.toThrow(/ECONNREFUSED/)
  })

  it('makes a fresh path and token for every server', async () => {
    const { ctx, agent } = await host()
    const first = await serve(agent, ctx)
    const second = await serve(agent, ctx)
    expect(first.url).not.toBe(second.url)
    expect(new URL(first.url).pathname).not.toBe(new URL(second.url).pathname)
    expect(first.token).not.toBe(second.token)
    expect(appToolsEntry(first)).toEqual({
      type: 'http', name: 'app', url: first.url,
      headers: [{ name: 'Authorization', value: `Bearer ${first.token}` }],
      _meta: { 'casper/clientAsks': true },
    })
  })
})

describe('app tools over MCP', { timeout: 60_000 }, () => {
  it('the tool list order is app_skill, plugin_manager, app_read_file, present, cordis_inspect_query, cordis_inspect_list, then the resource tools', async () => {
    const { ctx, agent } = await host()
    const mcp = await client(await serve(agent, ctx))
    // Casper takes pins in list order: the guide and the install come first.
    expect((await mcp.listTools()).tools.map(tool => tool.name)).toEqual([...APP_TOOLS, ...RESOURCE_TOOLS])
  })

  it('readOnlyHint is set on all but plugin_manager', async () => {
    const { ctx, agent } = await host()
    const { tools } = await (await client(await serve(agent, ctx))).listTools()
    expect(tools.filter(tool => tool.annotations?.readOnlyHint !== true).map(tool => tool.name)).toEqual(['plugin_manager'])
    expect(tools.find(tool => tool.name === 'plugin_manager')?.annotations).toBeUndefined()
    for (const tool of tools.filter(listed => listed.name !== 'plugin_manager')) expect(tool.annotations).toEqual({ readOnlyHint: true })
  })

  it("sends a served MCP tool's own four hints, and adds no readOnlyHint of its own", async () => {
    const { ctx, agent } = await host()
    // plugin_manager stands for a tool mcp-client built from a listed MCP tool; title is not a hint and is dropped.
    const listed = createMcpToolDefinition(ctx, {
      name: 'plugin_manager', rawName: 'manage', description: 'Manage profile plugins.', inputSchema: { type: 'object' },
      server: 'srv', annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false, title: 'Manage' },
      call: () => Promise.resolve({ content: [] }),
    })
    const origins: Record<string, McpToolOrigin> = {
      cordis_inspect_query: { server: 'srv', rawName: 'query', annotations: { readOnlyHint: false, destructiveHint: true } },
      present: { server: 'srv', rawName: 'present', annotations: {} },
    }
    const withOrigins: AppToolsOptions['tools'] = {
      schemas: scope => ctx.tools.schemas(scope),
      execute: input => ctx.tools.execute(input),
      get: (name, scope) => {
        if (name === 'plugin_manager') return listed
        const definition = ctx.tools.get(name, scope)
        const origin = origins[name]
        return definition === undefined || origin === undefined ? definition : { ...definition, mcpOrigin: origin }
      },
    }
    const { tools } = await (await client(await serve(agent, ctx, { tools: withOrigins }))).listTools()
    const byName = new Map(tools.map(tool => [tool.name, tool.annotations]))
    expect(byName.get('plugin_manager')).toEqual({ readOnlyHint: true, idempotentHint: true, openWorldHint: false })
    expect(byName.get('cordis_inspect_query')).toEqual({ readOnlyHint: false, destructiveHint: true })
    expect(byName.get('present')).toBeUndefined()
    // Rows with no MCP origin keep today's annotations.
    expect(byName.get('cordis_inspect_list')).toEqual({ readOnlyHint: true })
    expect(byName.get('app_read_file')).toEqual({ readOnlyHint: true })
  })

  it('servedAnnotations keeps the bridge flag for its own rows and the server hints for an MCP row', () => {
    const origin: McpToolOrigin = { server: 'srv', rawName: 'x', annotations: { readOnlyHint: true, openWorldHint: true } }
    expect(servedAnnotations(true, undefined)).toEqual({ readOnlyHint: true })
    expect(servedAnnotations(false, undefined)).toBeUndefined()
    expect(servedAnnotations(false, origin)).toEqual({ readOnlyHint: true, openWorldHint: true })
    expect(servedAnnotations(true, { ...origin, annotations: {} })).toBeUndefined()
    expect(servedAnnotations(true, { ...origin, annotations: { destructiveHint: true } })).toEqual({ destructiveHint: true })
  })

  it('the pins are app_skill, plugin_manager, app_read_file and present', async () => {
    const { ctx, agent } = await host()
    const { tools } = await (await client(await serve(agent, ctx))).listTools()
    // Four pins, as before present: cordis_inspect_query gave its pin to present, so each request costs the same.
    expect(tools.filter(tool => tool._meta?.['casper/pin'] === true).map(tool => tool.name)).toEqual(['app_skill', 'plugin_manager', 'app_read_file', 'present'])
    for (const tool of tools) expect(tool._meta).toEqual(tool._meta?.['casper/pin'] === true ? { 'casper/pin': true } : undefined)
  })

  it('lists the app tools and the resource tools with short descriptions and their schemas', async () => {
    const { ctx, agent } = await host()
    const summary = (name: string, modelInvocable = true): SkillSummary => ({
      name, description: name, invocation: { modelInvocable, userInvocable: true }, source: 'bundled', provider: 'test',
    })
    const skills = { list: () => Promise.resolve([summary('agent-experience'), summary(PLUGIN_SKILL), summary('hidden-skill', false)]) }
    const mcp = await client(await serve(agent, ctx, { skills }))
    expect(mcp.getInstructions()).toBeUndefined()
    const { tools } = await mcp.listTools()
    expect(tools.map(tool => tool.name)).toEqual([...APP_TOOLS, ...RESOURCE_TOOLS])
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    for (const tool of tools) expect(tool.description?.length ?? 0).toBeLessThanOrEqual(DESCRIPTION_MAX)
    expect(byName.get('plugin_manager')?.description).toMatch(/^For app plugins, first load cordis-plugin-development with app_skill\. Manage profile plugins\./)
    expect(byName.get('plugin_manager')?.description?.endsWith('…')).toBe(true)
    expect(byName.get('cordis_inspect_list')?.description).toMatch(/^For app plugins, first load cordis-plugin-development with app_skill\./)
    expect(byName.get('app_skill')?.description).toBe(skillDescription(['agent-experience', PLUGIN_SKILL]))
    expect(byName.get('app_skill')?.description).toContain('Others: agent-experience.')
    expect(byName.get('app_skill')?.description).not.toContain('hidden-skill')
    expect(byName.get('cordis_inspect_query')?.inputSchema).toMatchObject({
      type: 'object', required: ['platform', 'provider', 'method'],
      properties: { platform: { enum: ['host', 'client'] }, provider: { type: 'string' }, method: { type: 'string' } },
    })
    expect(byName.get('app_read_file')?.inputSchema).toMatchObject({ type: 'object', required: ['path'] })
    // present goes as the app's own tool: its description and schema, no guide line.
    expect(byName.get('present')?.description).toBe('Declare existing files as final deliverables for the user.')
    expect(byName.get('present')?.inputSchema).toMatchObject({ type: 'object', required: ['files'], properties: { files: { type: 'array' } } })
  })

  it('names itself with the app version, or this package\'s version when the app gives none', async () => {
    const { ctx, agent } = await host()
    const named = await client(await serve(agent, ctx))
    expect(named.getServerVersion()).toEqual({ name: 'dsh-desktop', version: APP_VERSION })
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    const unnamed = await client(await serve(agent, ctx, { version: undefined }))
    expect(unnamed.getServerVersion()).toEqual({ name: 'dsh-desktop', version: manifest.version })
    expect(manifest.version).not.toBe(APP_VERSION)
  })

  it('states tools without list-changed notices, since it is stateless and refuses a GET stream', async () => {
    const { ctx, agent } = await host()
    const server = await serve(agent, ctx)
    const mcp = await client(server)
    expect(mcp.getServerCapabilities()).toEqual({ tools: { listChanged: false } })
    const stream = await fetch(server.url, { headers: { authorization: `Bearer ${server.token}`, accept: 'text/event-stream' } })
    await stream.body?.cancel()
    expect(stream.status).toBe(405)
  })

  it('keeps the skill description inside the cap however many skills there are', () => {
    const many = Array.from({ length: 200 }, (_, at) => `skill-number-${at}`)
    const description = skillDescription(many)
    expect(description.length).toBeLessThanOrEqual(DESCRIPTION_MAX)
    expect(description).toMatch(/^Load this desktop app's guides\. Load cordis-plugin-development first/)
    expect(description.endsWith(', …')).toBe(true)
  })

  it('leaves out an app tool the Agent cannot see', async () => {
    const { ctx, agent } = await host()
    const hidden: AppToolsOptions['tools'] = {
      schemas: scope => ctx.tools.schemas(scope).filter(schema => schema.name !== 'plugin_manager'),
      execute: input => ctx.tools.execute(input),
      get: (name, scope) => ctx.tools.get(name, scope),
    }
    const mcp = await client(await serve(agent, ctx, { tools: hidden }))
    expect((await mcp.listTools()).tools.map(tool => tool.name)).toEqual(['app_skill', 'app_read_file', 'present', 'cordis_inspect_query', 'cordis_inspect_list', ...RESOURCE_TOOLS])
  })

  it('runs a call as the Casper Agent under the mapped call id, with no log, and hands its result to the step', async () => {
    const { ctx, agent, seen } = await host()
    const execute = vi.spyOn(ctx.tools, 'execute')
    const recorded: [string, BridgedCall][] = []
    const mcp = await client(await serve(agent, ctx, { record: (...call) => { recorded.push(call) } }))
    const result = await mcp.callTool({
      name: 'cordis_inspect_query',
      arguments: { platform: 'client', provider: 'Slots', method: 'listSubTree' },
      _meta: { 'casper/acpToolCallId': 'casper-tool-3' },
    })
    expect(result).toEqual({ content: [{ type: 'text', text: 'queried listSubTree' }], isError: false })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.exec.agent).toBe(agent)
    expect(seen[0]?.exec.callId).toBe('casper:test:casper-tool-3')
    expect(seen[0]?.args).toEqual({ platform: 'client', provider: 'Slots', method: 'listSubTree' })
    const input = execute.mock.calls[0]?.[0] as ToolBatchInput
    expect(input.agent).toBe(agent)
    expect(input.log).toBeUndefined()
    expect(input.toolSet).toBeUndefined()
    expect(input.calls[0]).toMatchObject({ type: 'tool-call', id: 'casper:test:casper-tool-3', name: 'cordis_inspect_query' })
    expect(recorded.map(([id, call]) => [id, call.name, call.arguments])).toEqual([
      ['casper-tool-3', 'cordis_inspect_query', JSON.stringify({ platform: 'client', provider: 'Slots', method: 'listSubTree' })],
    ])
    expect(recorded[0]?.[1].result).toMatchObject({ content: [{ type: 'text', text: 'queried listSubTree' }], isError: false })
  })

  it('names each served tool after the app tool it runs', () => {
    expect([...APP_TOOLS, ...SUBAGENT_TOOLS, ...GOAL_TOOLS, ...RESOURCE_TOOLS, 'wait_agent', 'other'].map(dshNameOf))
      .toEqual(['skill', 'plugin_manager', 'app_read_file', 'present', 'cordis_inspect_query', 'cordis_inspect_list', ...SUBAGENT_TOOLS, ...GOAL_TOOLS, ...RESOURCE_TOOLS, undefined, undefined])
  })

  it('gives a call without a Casper call id a fresh id of its own, and records no step result for it', async () => {
    const { ctx, agent, seen } = await host()
    const recorded: unknown[] = []
    const mcp = await client(await serve(agent, ctx, { record: (...call) => { recorded.push(call) } }))
    await mcp.callTool({ name: 'cordis_inspect_list', arguments: {} })
    await mcp.callTool({ name: 'cordis_inspect_list', arguments: {} })
    expect(seen.map(entry => entry.exec.callId)).toEqual([expect.stringMatching(/^casper-app:/), expect.stringMatching(/^casper-app:/)])
    expect(seen[0]?.exec.callId).not.toBe(seen[1]?.exec.callId)
    expect(recorded).toEqual([])
  })

  it('refuses every call while no Casper turn is open', async () => {
    const { ctx, agent, seen } = await host()
    const ended = new AbortController()
    ended.abort()
    for (const turn of [() => undefined, () => ended.signal]) {
      const mcp = await client(await serve(agent, ctx, { turn }))
      for (const [name, args] of [['cordis_inspect_list', {}], ['app_read_file', { path: '/x' }], ['plugin_manager', { action: 'list_plugins' }]] as const) {
        expect(await mcp.callTool({ name, arguments: args })).toEqual({ content: [{ type: 'text', text: TURN_OVER }], isError: true })
      }
    }
    expect(seen).toEqual([])
  })

  it('aborts a pending call as soon as the Casper turn ends', async () => {
    const { ctx, agent } = await host()
    const started = Promise.withResolvers<AbortSignal>()
    agent.ctx.tools.register(defineTool({
      name: 'plugin_manager', description: 'Waits for its approval card.', parameters: { action: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: (_args, exec) => {
        started.resolve(exec.signal)
        return new Promise((_resolve, reject) => {
          exec.signal.addEventListener('abort', () => { reject(new Error('card withdrawn')) }, { once: true })
        })
      },
    }))
    const turn = new AbortController()
    const mcp = await client(await serve(agent, ctx, { turn: () => turn.signal }))
    const call = mcp.callTool({ name: 'plugin_manager', arguments: { action: 'install_bundle' } })
    const signal = await started.promise
    expect(signal.aborted).toBe(false)
    turn.abort()
    // The app's call is withdrawn with the turn, not when Casper's MCP request later times out.
    expect(signal.aborted).toBe(true)
    expect(await call).toMatchObject({ isError: true })
  })

  it('starts every app_skill result with the Casper-mode preface', async () => {
    const { ctx, agent } = await host()
    const mcp = await client(await serve(agent, ctx))
    const result = await mcp.callTool({ name: 'app_skill', arguments: { name: PLUGIN_SKILL } }) as { content: { text: string }[] }
    expect(result.content.map(block => block.text)).toEqual([
      [
        'In Casper mode: write the bundle in the workspace with your own tools;',
        'read files under this skill\'s base directory or any packageDir with app_read_file (they are inside app.asar);',
        'DSH_PROFILE=desktop, DSH_PROFILE_DIR=/profiles/desktop.',
        'If plugin_manager, app_read_file or a cordis_inspect tool is not in your tool list, reach it through find_capability.',
      ].join(' '),
      `body of ${PLUGIN_SKILL}`,
    ])
    expect(result.content[0]?.text).not.toContain(INSTALLED_NOTE)
    const bare = await client(await serve(agent, ctx, { profile: undefined }))
    const unprofiled = await bare.callTool({ name: 'app_skill', arguments: { name: PLUGIN_SKILL } }) as { content: { text: string }[] }
    expect(unprofiled.content[0]?.text).not.toContain('DSH_PROFILE')
    // An installed app has no lib/types, src or repository docs, so the skill's pointers to them are redirected.
    const installed = await client(await serve(agent, ctx, { installed: true }))
    const packaged = await installed.callTool({ name: 'app_skill', arguments: { name: PLUGIN_SKILL } }) as { content: { text: string }[] }
    expect(packaged.content[0]?.text.endsWith(` ${INSTALLED_NOTE}`)).toBe(true)
    expect(INSTALLED_NOTE).toContain('no lib/types or src')
  })

  it('reports an executor failure as an error result', async () => {
    const { ctx, agent } = await host()
    const failing: AppToolsOptions['tools'] = {
      schemas: scope => ctx.tools.schemas(scope),
      execute: () => Promise.reject(new Error('executor unloaded')),
      get: (name, scope) => ctx.tools.get(name, scope),
    }
    const mcp = await client(await serve(agent, ctx, { tools: failing }))
    expect(await mcp.callTool({ name: 'cordis_inspect_list', arguments: {} })).toEqual({
      content: [{ type: 'text', text: 'cordis_inspect_list failed in the app: Error: executor unloaded' }], isError: true,
    })
  })

  it('sends text blocks and names the blocks MCP gets no form for', () => {
    expect(mcpContent([{ type: 'text', text: 'shown' }, { type: 'reasoning', text: 'hidden' }])).toEqual([
      { type: 'text', text: 'shown' }, { type: 'text', text: '[reasoning result not sent]' },
    ])
  })

  it('passes a failed app tool result through as an error, from a tool registered in the Agent\'s own scope', async () => {
    const { ctx, agent } = await host()
    agent.ctx.tools.register(defineTool({
      name: 'cordis_inspect_list', description: 'Fails.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => Promise.reject(new Error('no providers')),
    }))
    const mcp = await client(await serve(agent, ctx))
    const result = await mcp.callTool({ name: 'cordis_inspect_list', arguments: {} }) as { content: { text: string }[]; isError: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('no providers')
  })

  it('sends progress every ten seconds while a call is pending', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const release = Promise.withResolvers<undefined>()
    const { ctx, agent, seen } = await host(release.promise)
    const mcp = await client(await serve(agent, ctx))
    const progress: number[] = []
    const call = mcp.callTool({ name: 'plugin_manager', arguments: { action: 'install_bundle', target: '/work/bundle' } }, undefined, {
      onprogress: (update) => { progress.push(update.progress) },
      resetTimeoutOnProgress: true,
    })
    await vi.waitFor(() => { expect(seen).toHaveLength(1) })
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    await vi.waitFor(() => { expect(progress).toEqual([1]) })
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    await vi.waitFor(() => { expect(progress).toEqual([1, 2]) })
    release.resolve(undefined)
    expect(await call).toEqual({ content: [{ type: 'text', text: 'installed' }], isError: false })
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS * 2)
    expect(progress).toEqual([1, 2])
  })

  it('the resource tools are listed with no provider and return the no-server error', async () => {
    const { ctx, agent, seen } = await host()
    const mcp = await client(await serve(agent, ctx, { resourceServers: () => ['docs', 'github'] }))
    const { tools } = await mcp.listTools()
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    for (const name of RESOURCE_TOOLS) {
      expect(byName.get(name)?.description).toMatch(/ Servers: acp-docs, acp-github\.$/)
      expect(byName.get(name)?.inputSchema).toMatchObject({ type: 'object', properties: { server: { type: 'string' } } })
    }
    expect(byName.get('read_mcp_resource')?.inputSchema).toMatchObject({ required: ['server', 'uri'] })
    for (const [name, args] of [
      ['list_mcp_resources', { server: 'acp-docs' }],
      ['list_mcp_resource_templates', { server: 'acp-docs' }],
      ['read_mcp_resource', { server: 'acp-docs', uri: 'docs://intro' }],
    ] as const) {
      expect(await mcp.callTool({ name, arguments: args })).toEqual({ content: [{ type: 'text', text: NO_RESOURCES }], isError: true })
    }
    expect(seen).toEqual([])
    const none = await client(await serve(agent, ctx))
    expect((await none.listTools()).tools.find(tool => tool.name === 'list_mcp_resources')?.description).toMatch(/ Servers: none right now\.$/)
  })

  it('read_mcp_resource for acp-docs runs on docs', async () => {
    const { ctx, agent, seen } = await host()
    ctx.tools.register(defineTool({
      name: 'read_mcp_resource', description: 'Read an MCP resource.',
      parameters: { server: { type: 'string', required: true }, uri: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: (args, exec) => { seen.push({ name: 'read_mcp_resource', args, exec }); return Promise.resolve(`read ${args.uri} on ${args.server}`) },
    }))
    const recorded: [string, BridgedCall][] = []
    const mcp = await client(await serve(agent, ctx, { resourceServers: () => ['docs'], record: (...call) => { recorded.push(call) } }))
    const result = await mcp.callTool({ name: 'read_mcp_resource', arguments: { server: 'acp-docs', uri: 'docs://intro' }, _meta: { 'casper/acpToolCallId': 'casper-tool-4' } })
    expect(result).toEqual({ content: [{ type: 'text', text: 'read docs://intro on docs' }], isError: false })
    expect(seen.map(entry => [entry.name, entry.args, entry.exec.agent === agent])).toEqual([['read_mcp_resource', { server: 'docs', uri: 'docs://intro' }, true]])
    expect(recorded.map(([id, call]) => [id, call.name, call.arguments])).toEqual([
      ['casper-tool-4', 'read_mcp_resource', JSON.stringify({ server: 'docs', uri: 'docs://intro' })],
    ])
    // Only a server this connection hands Casper is reached.
    const other = await mcp.callTool({ name: 'read_mcp_resource', arguments: { server: 'acp-network', uri: 'x://y' } }) as { content: { text: string }[]; isError: boolean }
    expect(other.isError).toBe(true)
    expect(other.content[0]?.text).toBe('The app hands Casper no MCP server named acp-network. Servers: acp-docs.')
    expect(seen).toHaveLength(1)
  })
})

describe('the app\'s subagent tools over MCP', { timeout: 60_000 }, () => {
  /** A Host whose Agent scope has stand-ins for the subagent tools and their controls, wait_agent included. */
  async function withSubagentTools() {
    const booted = await host()
    const ran: { name: string; agent: unknown; initiator: unknown }[] = []
    for (const name of [...SUBAGENT_TOOLS, 'wait_agent']) {
      booted.ctx.tools.register(defineTool({
        name, description: `Stand-in ${name}.`, parameters: { agent_id: { type: 'string' } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: (_args, exec) => {
          ran.push({ name, agent: exec.agent, initiator: booted.ctx.agents.currentInitiator() })
          return Promise.resolve(`${name} ran`)
        },
      }))
    }
    return { ...booted, ran }
  }

  it('lists them after cordis_inspect_list, unpinned, with read-only hints on the two lists only, and never wait_agent', async () => {
    const { ctx, agent } = await withSubagentTools()
    const { tools } = await (await client(await serve(agent, ctx))).listTools()
    expect(tools.map(tool => tool.name)).toEqual([...APP_TOOLS, ...SUBAGENT_TOOLS, ...RESOURCE_TOOLS])
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    for (const name of SUBAGENT_TOOLS) expect(byName.get(name)?._meta).toBeUndefined()
    const readOnly = { readOnlyHint: true }
    expect(SUBAGENT_TOOLS.map(name => byName.get(name)?.annotations)).toEqual([undefined, undefined, undefined, readOnly, readOnly])
    // The pins are the same four, so Casper's fixed prompt does not grow.
    expect(tools.filter(tool => tool._meta?.['casper/pin'] === true).map(tool => tool.name)).toEqual(['app_skill', 'plugin_manager', 'app_read_file', 'present'])
    expect(byName.get('subagent')?.description).toBe('Stand-in subagent.')
  })

  it('leaves them all out with subagents off, and serves the other tools as before', async () => {
    const { ctx, agent, ran } = await withSubagentTools()
    const mcp = await client(await serve(agent, ctx, { subagents: false }))
    expect((await mcp.listTools()).tools.map(tool => tool.name)).toEqual([...APP_TOOLS, ...RESOURCE_TOOLS])
    await expect(mcp.callTool({ name: 'subagent', arguments: {} })).rejects.toThrow(/Tool subagent not found/)
    expect(ran).toEqual([])
  })

  it('runs each call as the Casper Agent inside the initiator boundary it is given', async () => {
    const { ctx, agent, ran } = await withSubagentTools()
    let boundaries = 0
    const initiate = <T>(operation: () => T): T => {
      boundaries += 1
      return ctx.agents.withInitiator(agent, operation)
    }
    const mcp = await client(await serve(agent, ctx, { initiate }))
    for (const name of SUBAGENT_TOOLS) {
      const result = await mcp.callTool({ name, arguments: { agent_id: 'child' } })
      expect(result).toEqual({ content: [{ type: 'text', text: `${name} ran` }], isError: false })
    }
    expect(ran).toEqual(SUBAGENT_TOOLS.map(name => ({ name, agent, initiator: agent })))
    expect(boundaries).toBe(SUBAGENT_TOOLS.length)
    // Without a boundary the call still runs as the Agent, with no initiator of its own.
    const bare = await client(await serve(agent, ctx))
    await bare.callTool({ name: 'list_agents', arguments: {} })
    expect(ran.at(-1)).toEqual({ name: 'list_agents', agent, initiator: undefined })
  })
})

describe('the app\'s goal tools over MCP', { timeout: 60_000 }, () => {
  /** A Host whose Agent scope has stand-ins for the goal tools; update_goal defers a wrap-up, as in a goal round. */
  async function withGoalTools() {
    const booted = await host()
    const ran: { name: string; agent: unknown }[] = []
    for (const name of GOAL_TOOLS) {
      booted.ctx.tools.register(defineTool({
        name, description: `Stand-in ${name}.`, parameters: { action: { type: 'string' } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: (_args, exec) => {
          ran.push({ name, agent: exec.agent })
          if (name === 'update_goal') {
            exec.deferContext(createUserMessage({ content: [{ type: 'text', text: '<goal_complete>wrap up</goal_complete>' }], source: { kind: 'user' } }))
          }
          return Promise.resolve(`${name} ran`)
        },
      }))
    }
    return { ...booted, ran }
  }

  it('lists them after the subagent tools, unpinned, read-only only for get_goal, with the rules on the two that change a goal', async () => {
    const { ctx, agent } = await withGoalTools()
    const { tools } = await (await client(await serve(agent, ctx))).listTools()
    expect(tools.map(tool => tool.name)).toEqual([...APP_TOOLS, ...GOAL_TOOLS, ...RESOURCE_TOOLS])
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    for (const name of GOAL_TOOLS) expect(byName.get(name)?._meta).toBeUndefined()
    expect(GOAL_TOOLS.map(name => byName.get(name)?.annotations)).toEqual([{ readOnlyHint: true }, undefined, undefined])
    // The pins are the same four, so Casper's fixed prompt does not grow.
    expect(tools.filter(tool => tool._meta?.['casper/pin'] === true).map(tool => tool.name)).toEqual(['app_skill', 'plugin_manager', 'app_read_file', 'present'])
    expect(byName.get('get_goal')?.description).toBe('Stand-in get_goal.')
    expect(byName.get('create_goal')?.description).toBe(`Stand-in create_goal. ${GOAL_RULES}`)
    expect(byName.get('update_goal')?.description).toBe(`Stand-in update_goal. ${GOAL_RULES}`)
    expect(GOAL_RULES.length).toBeLessThan(DESCRIPTION_MAX / 2)
  })

  it('leaves them all out with goals off, and serves the other tools as before', async () => {
    const { ctx, agent, ran } = await withGoalTools()
    const mcp = await client(await serve(agent, ctx, { goals: false }))
    expect((await mcp.listTools()).tools.map(tool => tool.name)).toEqual([...APP_TOOLS, ...RESOURCE_TOOLS])
    await expect(mcp.callTool({ name: 'update_goal', arguments: {} })).rejects.toThrow(/Tool update_goal not found/)
    expect(ran).toEqual([])
  })

  it('sends the context a tool defers, such as a goal round\'s wrap-up, after the tool\'s own result', async () => {
    const { ctx, agent, ran } = await withGoalTools()
    const mcp = await client(await serve(agent, ctx))
    expect(await mcp.callTool({ name: 'get_goal', arguments: {} })).toEqual({ content: [{ type: 'text', text: 'get_goal ran' }], isError: false })
    expect(await mcp.callTool({ name: 'update_goal', arguments: { action: 'complete' } })).toEqual({
      content: [{ type: 'text', text: 'update_goal ran' }, { type: 'text', text: '<goal_complete>wrap up</goal_complete>' }],
      isError: false,
    })
    expect(ran).toEqual([{ name: 'get_goal', agent }, { name: 'update_goal', agent }])
  })
})
