/** The app tools server, built on MCP server 2.x, serves the MCP 1.x client Casper uses, at the exact version Casper ships. */

import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { PROGRESS_INTERVAL_MS, startAppTools } from '../src/app-tools.ts'
import type { AppToolsServer } from '../src/app-tools.ts'
import { boot } from './harness.ts'
import { fakeCasper } from './support.ts'

/** The MCP client version Casper ships; these checks are only worth what this pin is. */
const CASPER_SDK = '1.32.0'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** What one stand-in app tool saw. */
interface Seen {
  readonly name: string
  readonly exec: ToolExecution
}

/**
 * A server over a Host with stand-ins for the app's tools.
 * @param release - a promise `plugin_manager` waits for before it answers.
 */
async function server(release?: Promise<void>): Promise<{ target: AppToolsServer; seen: Seen[] }> {
  const fake = fakeCasper()
  cleanups.push(() => { fake.remove() })
  const booted = await boot(fake)
  cleanups.push(() => booted.ctx.fiber.dispose())
  const { agent } = await booted.create('casper-mcp-compat')
  const seen: Seen[] = []
  const stand = (name: string, wait?: Promise<void>) => defineTool({
    name, description: `Stand-in for ${name}.`, parameters: { action: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async (_args, exec) => {
      seen.push({ name, exec })
      await wait
      return `${name} done`
    },
  })
  for (const name of ['cordis_inspect_list', 'cordis_inspect_query', 'skill', 'present']) booted.ctx.tools.register(stand(name))
  booted.ctx.tools.register(stand('plugin_manager', release))
  const target = await startAppTools({
    tools: booted.ctx.tools, skills: undefined, agent, cwd: fake.cwd, profile: undefined, version: '0.0.0-compat', roots: [fake.root], installed: false,
    turn: () => new AbortController().signal, callId: acpId => ToolCallId(`casper:compat:${acpId}`), record: () => {}, onError: () => {},
  })
  cleanups.push(() => target.close())
  return { target, seen }
}

/** A 1.x client connected the way Casper connects: Streamable HTTP with the bearer header. */
async function connect(target: AppToolsServer): Promise<Client> {
  const client = new Client({ name: 'casper', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(target.url), { requestInit: { headers: { Authorization: `Bearer ${target.token}` } } }) as Transport)
  cleanups.push(() => client.close())
  return client
}

/** POST one JSON-RPC message and read the reply's content type and body. */
async function rpc(target: AppToolsServer, body: unknown, version?: string): Promise<{ type: string | null; text: string }> {
  const response = await fetch(target.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${target.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...version === undefined ? {} : { 'mcp-protocol-version': version },
    },
    body: JSON.stringify(body),
  })
  return { type: response.headers.get('content-type'), text: await response.text() }
}

describe('MCP 1.x compatibility', { timeout: 60_000 }, () => {
  it(`runs against the ${CASPER_SDK} client Casper ships`, () => {
    const manifest = JSON.parse(readFileSync(new URL('../node_modules/@modelcontextprotocol/sdk/package.json', import.meta.url), 'utf8')) as { version: string }
    expect(manifest.version).toBe(CASPER_SDK)
  })

  it('agrees on every protocol version the 1.x client offers', async () => {
    const { target } = await server()
    for (const version of SUPPORTED_PROTOCOL_VERSIONS.filter(item => item >= '2025-03-26')) {
      const reply = await rpc(target, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'casper', version: '0' } } })
      expect(reply.text).toContain(`"protocolVersion":"${version}"`)
      expect(reply.text).toContain('"name":"dsh-desktop"')
      expect(reply.text).not.toContain('"instructions"')
      expect(reply.text).not.toContain('"listChanged":true')
    }
  })

  it('lists the tools in pin order with their pins and read hints', async () => {
    const { target } = await server()
    const client = await connect(target)
    expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: false } })
    const { tools } = await client.listTools()
    expect(tools.map(tool => [tool.name, tool._meta?.['casper/pin'] === true, tool.annotations?.readOnlyHint === true])).toEqual([
      ['app_skill', true, true],
      ['plugin_manager', true, false],
      ['app_read_file', true, true],
      ['present', true, true],
      ['cordis_inspect_query', false, true],
      ['cordis_inspect_list', false, true],
      ['list_mcp_resources', false, true],
      ['list_mcp_resource_templates', false, true],
      ['read_mcp_resource', false, true],
    ])
  })

  it('hands the call the ACP tool call id the 1.x client puts in _meta', async () => {
    const { target, seen } = await server()
    const client = await connect(target)
    const result = await client.callTool({ name: 'cordis_inspect_query', arguments: {}, _meta: { 'casper/acpToolCallId': 'casper-tool-7' } })
    expect(result).toEqual({ content: [{ type: 'text', text: 'cordis_inspect_query done' }], isError: false })
    expect(seen.map(entry => [entry.name, entry.exec.callId])).toEqual([['cordis_inspect_query', 'casper:compat:casper-tool-7']])
  })

  it('sends a slow call\'s progress to the 1.x client, which resets its timeout on each', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const release = Promise.withResolvers<undefined>()
    const { target, seen } = await server(release.promise)
    const client = await connect(target)
    const progress: number[] = []
    const call = client.callTool({ name: 'plugin_manager', arguments: { action: 'install_bundle' }, _meta: { 'casper/acpToolCallId': 'casper-tool-8' } }, undefined, {
      onprogress: (update) => { progress.push(update.progress) },
      resetTimeoutOnProgress: true,
    })
    await vi.waitFor(() => { expect(seen).toHaveLength(1) })
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    await vi.waitFor(() => { expect(progress).toEqual([1]) })
    await vi.advanceTimersByTimeAsync(PROGRESS_INTERVAL_MS)
    await vi.waitFor(() => { expect(progress).toEqual([1, 2]) })
    release.resolve(undefined)
    expect(await call).toEqual({ content: [{ type: 'text', text: 'plugin_manager done' }], isError: false })
    expect(seen[0]?.exec.callId).toBe('casper:compat:casper-tool-8')
  })

  it('answers a call as an SSE stream', async () => {
    const { target } = await server()
    const client = await connect(target)
    const read = await client.callTool({ name: 'app_read_file', arguments: { path: '/' } })
    expect(read.isError).toBe(true)
    const call = await rpc(target, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'app_read_file', arguments: { path: '/' } } }, LATEST_PROTOCOL_VERSION)
    expect(call.type).toContain('text/event-stream')
  })
})
