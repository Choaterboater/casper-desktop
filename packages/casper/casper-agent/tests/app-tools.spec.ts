/** The app tools server: its listener checks, the tools it lists, and how a call reaches the app's tools. */

import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { networkInterfaces } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentId, type ImageAttachmentRef, type ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { createMcpToolDefinition, type McpToolOrigin } from '@deepseek-ai/dsh-mcp-client'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolBatchInput, ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  ACCESS_CHECK,
  appToolsEntry,
  clientRows,
  DESCRIPTION_MAX,
  dshNameOf,
  GOAL_RULES,
  INSTALLED_NOTE,
  isConnectCheck,
  MAX_REPLY_BYTES,
  mcpContent,
  NO_RESOURCES,
  PICTURE_OVER_BUDGET,
  PICTURE_UNREADABLE,
  PLUGIN_SKILL,
  PROGRESS_INTERVAL_MS,
  rowEntry,
  rowResult,
  servedAnnotations,
  skillDescription,
  startAppTools,
  TEAM_OFF,
  TEAM_RULES,
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
/** The app's Team task-board tools, listed after the goal tools and never pinned. */
const TEAM_TOOLS = ['team_task_create', 'team_task_list', 'team_task_get', 'team_task_update']
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
    route: () => ({ provider: 'casper', model: 'casper' }),
    ...overrides,
  })
  cleanups.push(() => server.close())
  return server
}

/** An MCP 1.x client, as Casper uses, connected with the server's bearer header, to the server or one row's endpoint. */
async function client(server: AppToolsServer, row?: string): Promise<Client> {
  const connected = new Client({ name: 'casper-test', version: '0.0.0' })
  const headers = { Authorization: `Bearer ${server.token}` }
  const url = new URL(row === undefined ? server.url : `${server.url}/${row}`)
  await connected.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }) as Transport)
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
    // A server handed no rows finds no path below its own.
    expect(await post(`${server.url}/network`, auth)).toBe(404)
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
      definitions: scope => ctx.tools.definitions(scope),
      execute: input => ctx.tools.execute(input),
      resolve: input => ctx.tools.resolve(input),
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
      resolve: input => ctx.tools.resolve(input),
      definitions: scope => ctx.tools.definitions(scope),
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
    expect([...APP_TOOLS, ...SUBAGENT_TOOLS, ...GOAL_TOOLS, ...TEAM_TOOLS, ...RESOURCE_TOOLS, 'wait_agent', 'other'].map(dshNameOf)).toEqual([
      'skill', 'plugin_manager', 'app_read_file', 'present', 'cordis_inspect_query', 'cordis_inspect_list',
      ...SUBAGENT_TOOLS, ...GOAL_TOOLS, ...TEAM_TOOLS, ...RESOURCE_TOOLS, undefined, undefined,
    ])
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
      resolve: input => ctx.tools.resolve(input),
      definitions: scope => ctx.tools.definitions(scope),
      get: (name, scope) => ctx.tools.get(name, scope),
    }
    const mcp = await client(await serve(agent, ctx, { tools: failing }))
    expect(await mcp.callTool({ name: 'cordis_inspect_list', arguments: {} })).toEqual({
      content: [{ type: 'text', text: 'cordis_inspect_list failed in the app: Error: executor unloaded' }], isError: true,
    })
  })

  it('sends text blocks and names the blocks MCP gets no form for', async () => {
    expect(await mcpContent([{ type: 'text', text: 'shown' }, { type: 'reasoning', text: 'hidden' }])).toEqual([
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

describe('the app\'s Team tools over MCP', { timeout: 60_000 }, () => {
  /** A Host whose Agent scope has stand-ins for the Team tools, each admitted only while `team.on` is set, as the app's are. */
  async function withTeamTools() {
    const booted = await host()
    const team = { on: false, routes: [] as unknown[] }
    const ran: { name: string; agent: unknown }[] = []
    for (const name of TEAM_TOOLS) {
      booted.ctx.tools.register(defineTool({
        name, description: `Stand-in ${name}.`, parameters: { task_id: { type: 'string' } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: (_args, exec) => {
          ran.push({ name, agent: exec.agent })
          return Promise.resolve(`${name} ran`)
        },
      }), {
        when: ({ agent, modelSelection }) => {
          team.routes.push({ agent, modelSelection })
          return team.on
        },
      })
    }
    return { ...booted, ran, team }
  }

  it('lists them after the goal tools whatever the Team mode, unpinned, read-only on the two reads, with the rules on team_task_create', async () => {
    const { ctx, agent } = await withTeamTools()
    const { tools } = await (await client(await serve(agent, ctx))).listTools()
    expect(tools.map(tool => tool.name)).toEqual([...APP_TOOLS, ...TEAM_TOOLS, ...RESOURCE_TOOLS])
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    for (const name of TEAM_TOOLS) expect(byName.get(name)?._meta).toBeUndefined()
    const readOnly = { readOnlyHint: true }
    expect(TEAM_TOOLS.map(name => byName.get(name)?.annotations)).toEqual([undefined, readOnly, readOnly, undefined])
    expect(tools.filter(tool => tool._meta?.['casper/pin'] === true).map(tool => tool.name)).toEqual(['app_skill', 'plugin_manager', 'app_read_file', 'present'])
    expect(byName.get('team_task_create')?.description).toBe(`Stand-in team_task_create. ${TEAM_RULES}`)
    expect(byName.get('team_task_update')?.description).toBe('Stand-in team_task_update.')
    expect(TEAM_RULES.length).toBeLessThan(DESCRIPTION_MAX / 2)
  })

  it('leaves them all out with teams off, and serves the other tools as before', async () => {
    const { ctx, agent, ran } = await withTeamTools()
    const mcp = await client(await serve(agent, ctx, { teams: false }))
    expect((await mcp.listTools()).tools.map(tool => tool.name)).toEqual([...APP_TOOLS, ...RESOURCE_TOOLS])
    await expect(mcp.callTool({ name: 'team_task_list', arguments: {} })).rejects.toThrow(/Tool team_task_list not found/)
    expect(ran).toEqual([])
  })

  it('runs a call only while the app\'s check admits it, with the route it is given, and says Team is off otherwise', async () => {
    const { ctx, agent, ran, team } = await withTeamTools()
    const route = { provider: 'openai-codex', model: 'gpt-6.1-sol' }
    const mcp = await client(await serve(agent, ctx, { route: () => route }))
    expect(await mcp.callTool({ name: 'team_task_list', arguments: {} })).toEqual({ content: [{ type: 'text', text: TEAM_OFF }], isError: true })
    expect(ran).toEqual([])
    team.on = true
    expect(await mcp.callTool({ name: 'team_task_get', arguments: { task_id: 'task-1' } })).toEqual({ content: [{ type: 'text', text: 'team_task_get ran' }], isError: false })
    expect(ran).toEqual([{ name: 'team_task_get', agent }])
    expect(team.routes).toContainEqual({ agent, modelSelection: route })
    // Other tools need no admission and run as before.
    team.routes.length = 0
    expect(await mcp.callTool({ name: 'present', arguments: { files: [] } })).toMatchObject({ isError: false })
    expect(team.routes).toEqual([])
  })
})

describe('pictures in an app tool result', { timeout: 60_000 }, () => {
  /** A 1x1 PNG. */
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  /** Four MiB, the most the app stores for one picture. */
  const LARGE = 4 * 1024 * 1024

  function picture(id: string, bytes: number, mediaType: ImageMediaType = 'image/png'): ContentBlock {
    const attachment: ImageAttachmentRef = { attachmentId: AttachmentId(`sha256:${id.repeat(64)}`), mediaType, bytes, width: 1, height: 1 }
    return { type: 'image', attachment }
  }

  /** An attachment store whose pictures are `stored`, by attachment id; it records every read. */
  function store(stored: Record<string, Uint8Array>) {
    const reads: string[] = []
    const readImage = vi.fn((ref: ImageAttachmentRef, signal?: AbortSignal) => {
      reads.push(ref.attachmentId)
      signal?.throwIfAborted()
      const data = stored[ref.attachmentId]
      return data === undefined ? Promise.reject(new Error('attachment-local/not-found')) : Promise.resolve({ ref, data })
    })
    return { attachments: { readImage }, reads }
  }

  /** How {@link withResult} answers: a failed result, deferred context, and server options. */
  interface ResultOptions {
    readonly isError?: boolean
    readonly contexts?: ContentBlock[][]
    readonly overrides?: Partial<AppToolsOptions>
  }

  /** Serve `present` as an app tool whose result is `content`, with `options.contexts` deferred to the next step. */
  async function withResult(content: ContentBlock[], options: ResultOptions = {}) {
    const { ctx, agent } = await host()
    const tools: AppToolsOptions['tools'] = {
      schemas: scope => ctx.tools.schemas(scope),
      get: (name, scope) => ctx.tools.get(name, scope),
      resolve: input => ctx.tools.resolve(input),
      definitions: scope => ctx.tools.definitions(scope),
      execute: input => Promise.resolve({
        results: input.calls.map(call => ({
          callId: call.id,
          result: options.isError === true
            ? { isError: true as const, error: { message: 'present failed' }, content }
            : { isError: false as const, value: null, content },
        })),
        additionalContexts: (options.contexts ?? []).map(blocks => createUserMessage({ content: blocks, source: { kind: 'user' } })),
        concluded: false,
      }),
    }
    const mcp = await client(await serve(agent, ctx, { tools, ...options.overrides }))
    return mcp.callTool({ name: 'present', arguments: { files: [{ path: 'shot.png' }] } })
  }

  it('sends a picture as MCP image content in its place among the text', async () => {
    const { attachments, reads } = store({ [`sha256:${'a'.repeat(64)}`]: PNG })
    const result = await withResult(
      [{ type: 'text', text: 'before' }, picture('a', PNG.length), { type: 'text', text: 'after' }],
      { overrides: { attachments } },
    )
    expect(result).toEqual({
      content: [
        { type: 'text', text: 'before' },
        { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
        { type: 'text', text: 'after' },
      ],
      isError: false,
    })
    expect(reads).toHaveLength(1)
    // The signal is the call's own, so a turn that ends withdraws the read.
    expect(attachments.readImage.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal)
  })

  it('keeps each stored media type', async () => {
    const types: ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    const ids = ['a', 'b', 'c', 'd']
    const { attachments } = store(Object.fromEntries(ids.map(id => [`sha256:${id.repeat(64)}`, PNG])))
    const pictures = ids.map((id, index) => picture(id, PNG.length, types[index]))
    const result = await withResult(pictures, { overrides: { attachments } }) as { content: { mimeType?: string }[] }
    expect(result.content.map(block => block.mimeType)).toEqual(types)
  })

  it('sends the one-line note with images off, as before', async () => {
    const { attachments, reads } = store({ [`sha256:${'a'.repeat(64)}`]: PNG })
    const result = await withResult([{ type: 'text', text: 'shot' }, picture('a', PNG.length)], { overrides: { attachments, images: false } })
    expect(result).toEqual({ content: [{ type: 'text', text: 'shot' }, { type: 'text', text: '[image result not sent]' }], isError: false })
    expect(reads).toEqual([])
    // With no reader given at all, mcpContent keeps the old note too.
    expect(await mcpContent([picture('a', PNG.length)])).toEqual([{ type: 'text', text: '[image result not sent]' }])
  })

  it('sends the unreadable note when the store fails or is missing', async () => {
    const { attachments } = store({})
    expect(await withResult([picture('a', PNG.length)], { overrides: { attachments } })).toEqual({
      content: [{ type: 'text', text: PICTURE_UNREADABLE }], isError: false,
    })
    expect(await withResult([picture('a', PNG.length)])).toEqual({ content: [{ type: 'text', text: PICTURE_UNREADABLE }], isError: false })
  })

  it('fails the conversion when the call is withdrawn during a read', async () => {
    const aborted = AbortSignal.abort()
    const attachments = { readImage: () => Promise.reject(new Error('aborted')) }
    await expect(mcpContent([picture('a', PNG.length)], { attachments, signal: aborted })).rejects.toThrow('aborted')
  })

  it('sends pictures in order while the reply stays within its budget, and the over-budget note after', async () => {
    const big = new Uint8Array(LARGE)
    const { attachments, reads } = store({ [`sha256:${'a'.repeat(64)}`]: big, [`sha256:${'b'.repeat(64)}`]: big, [`sha256:${'c'.repeat(64)}`]: PNG })
    const result = await withResult([picture('a', LARGE), picture('b', LARGE), picture('c', PNG.length)], { overrides: { attachments } }) as { content: { type: string; text?: string; data?: string }[] }
    expect(result.content.map(block => block.type)).toEqual(['image', 'text', 'image'])
    expect(result.content[0]?.data).toHaveLength(Math.ceil(LARGE / 3) * 4)
    expect(result.content[1]?.text).toBe(PICTURE_OVER_BUDGET)
    // A picture whose stored size cannot fit is never read; a smaller one after it still goes.
    expect(reads).toEqual([`sha256:${'a'.repeat(64)}`, `sha256:${'c'.repeat(64)}`])
    expect(Math.ceil(LARGE / 3) * 4 * 2).toBeGreaterThan(MAX_REPLY_BYTES)
    expect(MAX_REPLY_BYTES).toBeLessThan(8 * 1024 * 1024)
  })

  it('counts the text of the reply against the budget, and checks the bytes read as well as the stored size', async () => {
    const text = 'x'.repeat(MAX_REPLY_BYTES - 8)
    const { attachments, reads } = store({ [`sha256:${'a'.repeat(64)}`]: PNG })
    expect(await mcpContent([{ type: 'text', text }, picture('a', PNG.length)], { attachments, signal: new AbortController().signal })).toEqual([
      { type: 'text', text }, { type: 'text', text: PICTURE_OVER_BUDGET },
    ])
    expect(reads).toEqual([])
    // Text counts as JSON on the wire: a newline is two bytes there, so half the budget of newlines leaves no room.
    const lines = '\n'.repeat(MAX_REPLY_BYTES / 2)
    expect(await mcpContent([{ type: 'text', text: lines }, picture('a', PNG.length)], { attachments, signal: new AbortController().signal })).toEqual([
      { type: 'text', text: lines }, { type: 'text', text: PICTURE_OVER_BUDGET },
    ])
    expect(reads).toEqual([])
    // An offloaded picture keeps its note and is never read.
    const attachment: ImageAttachmentRef = { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png', bytes: PNG.length, width: 1, height: 1 }
    expect(await mcpContent([{ type: 'image', attachment, offloaded: true }], { attachments, signal: new AbortController().signal })).toEqual([
      { type: 'text', text: '[image result not sent]' },
    ])
    expect(reads).toEqual([])
    // A stored size that understates the bytes read still cannot take the reply past the budget.
    const understated = store({ [`sha256:${'b'.repeat(64)}`]: new Uint8Array(MAX_REPLY_BYTES) })
    expect(await mcpContent([picture('b', 3)], { attachments: understated.attachments, signal: new AbortController().signal })).toEqual([
      { type: 'text', text: PICTURE_OVER_BUDGET },
    ])
  })

  it('reads no picture for a failed result, which keeps the note', async () => {
    const { attachments, reads } = store({ [`sha256:${'a'.repeat(64)}`]: PNG })
    expect(await withResult([{ type: 'text', text: 'failed' }, picture('a', PNG.length)], { isError: true, overrides: { attachments } })).toEqual({
      content: [{ type: 'text', text: 'failed' }, { type: 'text', text: '[image result not sent]' }], isError: true,
    })
    expect(reads).toEqual([])
  })

  it('sends a picture in deferred context after the result, within the same budget', async () => {
    const big = new Uint8Array(LARGE)
    const { attachments, reads } = store({ [`sha256:${'a'.repeat(64)}`]: big, [`sha256:${'b'.repeat(64)}`]: big, [`sha256:${'c'.repeat(64)}`]: PNG })
    const result = await withResult([picture('a', LARGE)], {
      contexts: [[{ type: 'text', text: 'wrap up' }, picture('b', LARGE)], [picture('c', PNG.length)]],
      overrides: { attachments },
    }) as { content: { type: string; text?: string; data?: string }[] }
    expect(result.content.map(block => block.text ?? block.type)).toEqual(['image', 'wrap up', PICTURE_OVER_BUDGET, 'image'])
    expect(result.content[3]?.data).toBe(PNG.toString('base64'))
    expect(reads).toEqual([`sha256:${'a'.repeat(64)}`, `sha256:${'c'.repeat(64)}`])
  })

  it('leaves a result with no picture as it was, and the pins as they were', async () => {
    const { attachments, reads } = store({})
    expect(await withResult([{ type: 'text', text: 'presented' }], { overrides: { attachments } })).toEqual({
      content: [{ type: 'text', text: 'presented' }], isError: false,
    })
    expect(reads).toEqual([])
    const { ctx, agent } = await host()
    const { tools } = await (await client(await serve(agent, ctx, { attachments }))).listTools()
    expect(tools.filter(tool => tool._meta?.['casper/pin'] === true).map(tool => tool.name)).toEqual(['app_skill', 'plugin_manager', 'app_read_file', 'present'])
  })
})

describe('the app\'s own MCP client rows over MCP', { timeout: 60_000 }, () => {
  /** A 1x1 PNG, base64. */
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

  /** One MCP result as a server sends it. */
  type Raw = { content: Record<string, unknown>[]; structuredContent?: Record<string, unknown>; isError?: boolean }

  /**
   * A Host whose tool registry holds the `network` row's tools as the MCP client registers them, plus one tool of the
   * `docs` server, which another endpoint serves. Every call the registry runs is recorded.
   */
  async function rowHost() {
    const base = await host()
    const { ctx } = base
    const calls: { name: string; args: unknown; agent: unknown; aborted: boolean }[] = []
    type Fields = Record<string, unknown>
    const register = (server: string, rawName: string, annotations: Fields, inputSchema: Fields, answer: (args: Fields) => Raw) => {
      ctx.tools.register(createMcpToolDefinition(ctx, {
        name: `mcp__${server}__${rawName}`, rawName, description: `The ${rawName} tool of ${server}.`, inputSchema: { type: 'object', ...inputSchema },
        server, annotations,
        call: args => Promise.resolve(answer(args)),
      }))
    }
    register('network', 'find_tool', { readOnlyHint: true, openWorldHint: true }, { properties: { query: { type: 'string' } }, required: ['query'] }, args => ({
      content: [{ type: 'text', text: `found ${String(args.query)}` }], structuredContent: { tools: ['list_sites'] },
    }))
    register('network', ACCESS_CHECK, { readOnlyHint: true, destructiveHint: false }, {}, () => ({
      content: [{ type: 'text', text: '{"products":[]}' }],
    }))
    register('network', 'invoke_tool', { destructiveHint: true }, { properties: { name: { type: 'string' } } }, () => ({
      content: [{ type: 'text', text: 'writes are off' }], isError: true,
    }))
    register('network', 'snapshot', { readOnlyHint: true }, {}, () => ({
      content: [{ type: 'text', text: 'before' }, { type: 'image', data: PNG, mimeType: 'image/png' }, { type: 'text', text: 'after' }],
    }))
    register('docs', 'search', {}, {}, () => ({ content: [{ type: 'text', text: 'docs' }] }))
    const tools: AppToolsOptions['tools'] = {
      schemas: scope => ctx.tools.schemas(scope),
      definitions: scope => ctx.tools.definitions(scope),
      get: (name, scope) => ctx.tools.get(name, scope),
      resolve: input => ctx.tools.resolve(input),
      execute: (input) => {
        for (const call of input.calls) {
          calls.push({ name: call.name, args: JSON.parse(call.arguments), agent: input.agent, aborted: input.signal.aborted })
        }
        return ctx.tools.execute(input)
      },
    }
    return { ...base, tools, calls }
  }

  it('serves a row only at its own path while the row is handed over, with the same Host, Origin and token checks', async () => {
    const { ctx, agent, tools } = await rowHost()
    let rows: string[] = ['network']
    const server = await serve(agent, ctx, { tools, rows: () => rows })
    const url = new URL(server.url)
    const auth = { authorization: `Bearer ${server.token}` }
    expect(await post(`${server.url}/network`, auth)).toBe(200)
    expect(await post(`${server.url}/docs`, auth)).toBe(404)
    expect(await post(`${server.url}/network/more`, auth)).toBe(404)
    expect(await post(`${server.url}/`, auth)).toBe(404)
    expect(await post(`${url.origin}/mcp/other/network`, auth)).toBe(404)
    expect(await post(`${server.url}/network`, { ...auth, host: `localhost:${url.port}` })).toBe(403)
    expect(await post(`${server.url}/network`, { ...auth, origin: `http://127.0.0.1:${url.port}` })).toBe(403)
    expect(await post(`${server.url}/network`, {})).toBe(401)
    expect(await post(`${server.url}/network`, { authorization: `Bearer ${server.token}x` })).toBe(401)
    // The list is read at each request: a row no longer handed over is not found.
    rows = []
    expect(await post(`${server.url}/network`, auth)).toBe(404)
    expect(await post(server.url, auth)).toBe(200)
  })

  it('lists only the row\'s tools under their raw names, with the server\'s own hints and descriptions, never pinned', async () => {
    const { ctx, agent, tools } = await rowHost()
    const server = await serve(agent, ctx, { tools, rows: () => ['network'] })
    const mcp = await client(server, 'network')
    const listed = (await mcp.listTools()).tools
    expect(listed.map(tool => tool.name)).toEqual(['find_tool', ACCESS_CHECK, 'invoke_tool', 'snapshot'])
    const byName = new Map(listed.map(tool => [tool.name, tool]))
    expect(byName.get('find_tool')?.annotations).toEqual({ readOnlyHint: true, openWorldHint: true })
    expect(byName.get(ACCESS_CHECK)?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false })
    expect(byName.get('invoke_tool')?.annotations).toEqual({ destructiveHint: true })
    expect(byName.get('find_tool')?.description).toBe('The find_tool tool of network.')
    expect(byName.get('find_tool')?.inputSchema).toMatchObject({ type: 'object', required: ['query'], properties: { query: { type: 'string' } } })
    for (const tool of listed) expect(tool._meta).toBeUndefined()
    expect(mcp.getServerVersion()).toEqual({ name: 'dsh-desktop/network', version: APP_VERSION })
    // A tool with no hints from its server is listed with none.
    const docs = await client(await serve(agent, ctx, { tools, rows: () => ['docs'] }), 'docs')
    expect((await docs.listTools()).tools.map(tool => [tool.name, tool.annotations])).toEqual([['search', undefined]])
    // The app's own server keeps its tools and its four pins.
    const own = (await (await client(server)).listTools()).tools
    expect(own.some(tool => tool.name === 'find_tool' || tool.name.startsWith('mcp__'))).toBe(false)
    expect(own.filter(tool => tool._meta?.['casper/pin'] === true).map(tool => tool.name)).toEqual(['app_skill', 'plugin_manager', 'app_read_file', 'present'])
  })

  it('runs a call through the app\'s tools as the Casper Agent and answers with the server\'s own result, never recording it', async () => {
    const { ctx, agent, tools, calls } = await rowHost()
    const record = vi.fn()
    const mcp = await client(await serve(agent, ctx, { tools, record, rows: () => ['network'] }), 'network')
    const found = await mcp.callTool({ name: 'find_tool', arguments: { query: 'sites' }, _meta: { 'casper/acpToolCallId': 'casper-tool-1' } })
    expect(found).toEqual({ content: [{ type: 'text', text: 'found sites' }], structuredContent: { tools: ['list_sites'] } })
    expect(calls).toEqual([{ name: 'mcp__network__find_tool', args: { query: 'sites' }, agent, aborted: false }])
    expect(record).not.toHaveBeenCalled()
    // A failed call goes as the app's own failure text.
    expect(await mcp.callTool({ name: 'invoke_tool', arguments: { name: 'x' } })).toEqual({
      content: [{ type: 'text', text: 'Error: writes are off' }], isError: true,
    })
  })

  it('sends the server\'s own pictures in their place, and a note for each with images off', async () => {
    const { ctx, agent, tools } = await rowHost()
    const on = await client(await serve(agent, ctx, { tools, rows: () => ['network'] }), 'network')
    expect(await on.callTool({ name: 'snapshot', arguments: {} })).toEqual({
      content: [{ type: 'text', text: 'before' }, { type: 'image', data: PNG, mimeType: 'image/png' }, { type: 'text', text: 'after' }],
    })
    const off = await client(await serve(agent, ctx, { tools, rows: () => ['network'], images: false }), 'network')
    expect(await off.callTool({ name: 'snapshot', arguments: {} })).toEqual({
      content: [{ type: 'text', text: 'before' }, { type: 'text', text: '[image result not sent]' }, { type: 'text', text: 'after' }],
    })
  })

  it('outside a turn only the connect check runs; every other call is refused as the turn being over', async () => {
    const { ctx, agent, tools, calls } = await rowHost()
    const mcp = await client(await serve(agent, ctx, { tools, rows: () => ['network'], turn: () => undefined }), 'network')
    expect(await mcp.callTool({ name: ACCESS_CHECK, arguments: {} })).toEqual({ content: [{ type: 'text', text: '{"products":[]}' }] })
    for (const name of ['find_tool', 'invoke_tool', 'snapshot']) {
      expect(await mcp.callTool({ name, arguments: name === 'find_tool' ? { query: 'x' } : {} })).toEqual({ content: [{ type: 'text', text: TURN_OVER }], isError: true })
    }
    expect(calls.map(call => call.name)).toEqual([`mcp__network__${ACCESS_CHECK}`])
    const ended = new AbortController()
    ended.abort()
    const over = await client(await serve(agent, ctx, { tools, rows: () => ['network'], turn: () => ended.signal }), 'network')
    expect(await over.callTool({ name: 'find_tool', arguments: { query: 'x' } })).toEqual({ content: [{ type: 'text', text: TURN_OVER }], isError: true })
  })

  it('answers with the app\'s own content for a value that is not an MCP result, and a failure in the app as an error', async () => {
    const { ctx, agent, tools } = await rowHost()
    const picture: ContentBlock = {
      type: 'image', attachment: { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png', bytes: 68, width: 1, height: 1 },
    }
    const plain: AppToolsOptions['tools'] = {
      ...tools,
      execute: input => Promise.resolve({
        results: input.calls.map(call => ({ callId: call.id, result: { isError: false, value: 'plain', content: [{ type: 'text', text: 'plain' }, picture] } })),
        additionalContexts: [createUserMessage({ content: [{ type: 'text', text: 'wrap up' }], source: { kind: 'user' } })],
        concluded: false,
      }),
    }
    const on = await client(await serve(agent, ctx, { tools: plain, rows: () => ['network'] }), 'network')
    expect(await on.callTool({ name: 'snapshot', arguments: {} })).toEqual({
      content: [{ type: 'text', text: 'plain' }, { type: 'text', text: PICTURE_UNREADABLE }, { type: 'text', text: 'wrap up' }],
    })
    const off = await client(await serve(agent, ctx, { tools: plain, rows: () => ['network'], images: false }), 'network')
    expect(await off.callTool({ name: 'snapshot', arguments: {} })).toEqual({
      content: [{ type: 'text', text: 'plain' }, { type: 'text', text: '[image result not sent]' }, { type: 'text', text: 'wrap up' }],
    })
    const failing: AppToolsOptions['tools'] = { ...tools, execute: () => Promise.reject(new Error('registry closed')) }
    const failed = await client(await serve(agent, ctx, { tools: failing, rows: () => ['network'] }), 'network')
    expect(await failed.callTool({ name: 'snapshot', arguments: {} })).toEqual({
      content: [{ type: 'text', text: 'mcp__network__snapshot failed in the app: Error: registry closed' }], isError: true,
    })
  })

  it('isConnectCheck is Casper\'s own rule: access_check, read-only, not destructive, no required arguments', () => {
    const origin: McpToolOrigin = { server: 'network', rawName: ACCESS_CHECK, annotations: { readOnlyHint: true } }
    expect(isConnectCheck(origin, { type: 'object' })).toBe(true)
    expect(isConnectCheck(origin, undefined)).toBe(true)
    expect(isConnectCheck(origin, { type: 'object', required: [] })).toBe(true)
    expect(isConnectCheck(origin, { type: 'object', required: ['product'] })).toBe(false)
    expect(isConnectCheck({ ...origin, rawName: 'find_tool' }, {})).toBe(false)
    expect(isConnectCheck({ ...origin, annotations: {} }, {})).toBe(false)
    expect(isConnectCheck({ ...origin, annotations: { readOnlyHint: true, destructiveHint: true } }, {})).toBe(false)
  })

  it('rowResult keeps the other blocks and structured content first, then pictures while they fit in 7 MiB', () => {
    const image = { type: 'image', data: PNG, mimeType: 'image/png' }
    expect(rowResult({ content: [image], structuredContent: { a: 1 } }, true)).toEqual({ content: [image], structuredContent: { a: 1 } })
    // Text that leaves less room than the picture needs sends the note in its place.
    const text: ContentBlock = { type: 'text', text: 'x'.repeat(MAX_REPLY_BYTES - PNG.length) }
    expect(rowResult({ content: [image, text] }, true)?.content).toEqual([{ type: 'text', text: PICTURE_OVER_BUDGET }, text])
    // Pictures go in order while they fit.
    const room: ContentBlock = { type: 'text', text: 'x'.repeat(MAX_REPLY_BYTES - PNG.length - 100) }
    expect(rowResult({ content: [image, image, room] }, true)?.content).toEqual([image, { type: 'text', text: PICTURE_OVER_BUDGET }, room])
    // Context the app adds after the result goes last and counts first.
    expect(rowResult({ content: [image] }, true, [text])?.content).toEqual([{ type: 'text', text: PICTURE_OVER_BUDGET }, text])
    expect(rowResult({ content: [image] }, false)?.content).toEqual([{ type: 'text', text: '[image result not sent]' }])
    expect(rowResult('not a result', true)).toBeUndefined()
  })

  it('clientRows names each server the tools came from, in order, except the app and the manager\'s own servers', async () => {
    const { ctx, agent, tools } = await rowHost()
    ctx.tools.register(createMcpToolDefinition(ctx, {
      name: 'mcp__app__x', rawName: 'x', description: '', inputSchema: { type: 'object' }, server: 'app', call: () => Promise.resolve({ content: [] }),
    }))
    expect(clientRows(tools, agent, new Set())).toEqual([
      { name: 'network', tools: ['find_tool', ACCESS_CHECK, 'invoke_tool', 'snapshot'] },
      { name: 'docs', tools: ['search'] },
    ])
    expect(clientRows(tools, agent, new Set(['docs']))).toEqual([{ name: 'network', tools: ['find_tool', ACCESS_CHECK, 'invoke_tool', 'snapshot'] }])
  })

  it('rowEntry is the row\'s own endpoint with the bearer header and no casper/clientAsks', () => {
    expect(rowEntry({ url: 'http://127.0.0.1:1/mcp/path', token: 'tok' }, 'network')).toEqual({
      type: 'http', name: 'network', url: 'http://127.0.0.1:1/mcp/path/network', headers: [{ name: 'Authorization', value: 'Bearer tok' }],
    })
  })
})
