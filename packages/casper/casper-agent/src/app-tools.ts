/**
 * The app's plugin tools for one Casper connection: an MCP Streamable HTTP
 * server on its own 127.0.0.1 listener, reachable only at a random path with a
 * random bearer token, that forwards calls to the app's tools as the Casper
 * Agent while a Casper turn is open.
 * @module @deepseek-ai/dsh-casper-agent/app-tools
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { McpServer as AcpMcpServer } from '@agentclientprotocol/sdk'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  type CallToolResult,
  type JsonSchemaType,
  type ServerContext,
} from '@modelcontextprotocol/server'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'
import type { ToolResult, ToolsService } from '@deepseek-ai/dsh-tools'
import { readAppFile, READ_MAX_LINES } from './app-read.ts'

/** Name Casper gets the app's server under; Casper prefixes it with `acp-`. */
export const APP_SERVER_NAME = 'app'
/** `_meta` key on the server entry: the app shows its own approval for every effectful tool. */
export const CLIENT_ASKS_META = 'casper/clientAsks'
/** `_meta` key on a listed tool: Casper keeps it among its direct tools. */
export const PIN_META = 'casper/pin'
/** `_meta` key on a call: the ACP tool call id of the Casper step that made it. */
export const ACP_TOOL_CALL_META = 'casper/acpToolCallId'
/** Longest tool description sent; Casper cuts at 1,024 characters. */
export const DESCRIPTION_MAX = 1000
/** Interval of progress notifications while a call runs. */
export const PROGRESS_INTERVAL_MS = 10_000
/** The skill that teaches plugin building. */
export const PLUGIN_SKILL = 'cordis-plugin-development'
/** Result of a call that arrives while no Casper turn is open. */
export const TURN_OVER = "Casper's turn is over; ask again in a prompt."

const GUIDE_FIRST = `For app plugins, first load ${PLUGIN_SKILL} with app_skill.`

/** One tool served under an MCP name. */
interface BridgedTool {
  /** Name Casper sees. */
  readonly mcp: string
  /** The app tool it runs, or undefined for `app_read_file`, which runs the bridge's own code. */
  readonly dsh: string | undefined
  /** Whether the tool only reads. */
  readonly readOnly: boolean
  /** Whether Casper keeps it among its direct tools. */
  readonly pin: boolean
  /** Whether its description starts with {@link GUIDE_FIRST}. */
  readonly guide: boolean
}

/**
 * The tools served, in list order, which is the order Casper takes pins in:
 * the guide and the install first, then the reader, then `present`, which
 * hands the user a file the app shows as a card in the Casper turn. Four are
 * pinned; `cordis_inspect_query` gave its pin to `present`, so each request
 * costs the same, and Casper reaches it through find_capability.
 */
const BRIDGED: readonly BridgedTool[] = [
  { mcp: 'app_skill', dsh: 'skill', readOnly: true, pin: true, guide: false },
  { mcp: 'plugin_manager', dsh: 'plugin_manager', readOnly: false, pin: true, guide: true },
  { mcp: 'app_read_file', dsh: undefined, readOnly: true, pin: true, guide: false },
  { mcp: 'present', dsh: 'present', readOnly: true, pin: true, guide: false },
  { mcp: 'cordis_inspect_query', dsh: 'cordis_inspect_query', readOnly: true, pin: false, guide: false },
  { mcp: 'cordis_inspect_list', dsh: 'cordis_inspect_list', readOnly: true, pin: false, guide: true },
]

/** Result of a resource tool while no MCP server in the app offers resources. */
export const NO_RESOURCES = 'No MCP server in the app offers resources right now.'

/** Prefix Casper gives every server the app hands it. */
const ACP_PREFIX = 'acp-'

/** One of the app's MCP resource tools, served with a fixed schema whether or not the app has registered it yet. */
interface ResourceTool {
  /** Name Casper sees, which is also the app tool it runs. */
  readonly mcp: string
  /** What it does, before the server list. */
  readonly does: string
  /** Its arguments; `server` is always among them. */
  readonly schema: JsonSchemaType
}

const SERVER_ARG = { type: 'string', description: 'The MCP server, as Casper names it (acp-<name>).' } as const
const CURSOR_ARG = { type: 'string', description: 'Continuation cursor returned by this server.' } as const

/** The resource tools, served after {@link BRIDGED}, read-only and never pinned. */
const RESOURCE_TOOLS: readonly ResourceTool[] = [
  {
    mcp: 'list_mcp_resources',
    does: 'List the resources an MCP server the app hands you offers.',
    schema: { type: 'object', required: ['server'], properties: { server: SERVER_ARG, cursor: CURSOR_ARG } },
  },
  {
    mcp: 'list_mcp_resource_templates',
    does: 'List the parameterized resource URI templates of an MCP server the app hands you.',
    schema: { type: 'object', required: ['server'], properties: { server: SERVER_ARG, cursor: CURSOR_ARG } },
  },
  {
    mcp: 'read_mcp_resource',
    does: 'Read a resource by URI from an MCP server the app hands you; use a listed URI or an expanded template.',
    schema: { type: 'object', required: ['server', 'uri'], properties: { server: SERVER_ARG, uri: { type: 'string', description: 'Resource URI to read.' } } },
  },
]

/**
 * The description of one resource tool: what it does and the servers it reaches.
 * @param does - the tool's own sentence.
 * @param servers - the forwarded servers' names, without Casper's prefix.
 * @returns at most {@link DESCRIPTION_MAX} characters.
 */
export function resourceDescription(does: string, servers: readonly string[]): string {
  return clipDescription(`${does} Servers: ${serverList(servers)}.`)
}

/** The servers as Casper names them, or "none right now". */
function serverList(servers: readonly string[]): string {
  return servers.length === 0 ? 'none right now' : servers.map(name => `${ACP_PREFIX}${name}`).join(', ')
}

/**
 * The app's name for a server Casper names: `acp-x` is `x`.
 * @param server - the server argument Casper sent.
 * @returns the name in the app's Settings.
 */
export function appServerName(server: string): string {
  return server.startsWith(ACP_PREFIX) ? server.slice(ACP_PREFIX.length) : server
}

/**
 * The app tool name a served MCP tool runs under.
 * @param mcp - the MCP tool name Casper called.
 * @returns the app tool's name (`app_read_file` keeps its own), or undefined for a tool this server does not serve.
 */
export function dshNameOf(mcp: string): string | undefined {
  const tool = BRIDGED.find(entry => entry.mcp === mcp)
  if (tool !== undefined) return tool.dsh ?? tool.mcp
  return RESOURCE_TOOLS.some(entry => entry.mcp === mcp) ? mcp : undefined
}

/** One app tool call the server ran for a Casper step. */
export interface BridgedCall {
  /** The app tool that ran. */
  readonly name: string
  /** The arguments it ran with, as JSON. */
  readonly arguments: string
  /** The app tool's own result, `meta` included. */
  readonly result: ToolResult
}

const READ_FILE_DESCRIPTION = 'Read a text file, or list a folder, inside this desktop app\'s installed packages or the profile\'s installed bundles, '
  + 'including skill files and packageDir folders inside app.asar that shell commands cannot open. path is absolute; offset and limit count lines.'

const READ_FILE_SCHEMA: JsonSchemaType = {
  type: 'object',
  required: ['path'],
  properties: {
    path: { type: 'string', description: 'absolute' },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: READ_MAX_LINES },
  },
}

/** The profile the app was started with. */
export interface AppToolsProfile {
  readonly name: string
  readonly dir: string
}

/** What {@link startAppTools} serves and whom it runs calls as. */
export interface AppToolsOptions {
  /** The app's tool registry; calls resolve in `agent`'s scope. */
  readonly tools: Pick<ToolsService, 'schemas' | 'execute'>
  /** The app's skill registry, when composed. */
  readonly skills: Pick<SkillRegistry, 'list'> | undefined
  /** The Casper Agent every call runs as. */
  readonly agent: Agent
  /** The Session folder; skill lookup uses it. */
  readonly cwd: string
  /** The app's profile, when it was started with one. */
  readonly profile: AppToolsProfile | undefined
  /** The app's version, sent as the server version; this package's version when undefined. */
  readonly version: string | undefined
  /** Folders `app_read_file` reads from. */
  readonly roots: readonly string[]
  /** Whether the app runs from installed packages, which carry no `lib/types`, `src/` or repository `docs/`. */
  readonly installed: boolean
  /**
   * The Settings servers this connection hands Casper, which the resource tools reach; read at each request.
   * @returns their names, without Casper's `acp-` prefix; none when omitted.
   */
  readonly resourceServers?: (() => readonly string[]) | undefined
  /**
   * The open Casper prompt's signal.
   * @returns the signal, or undefined while no Casper turn is open.
   */
  readonly turn: () => AbortSignal | undefined
  /**
   * Map a Casper tool call id to the Session's call id.
   * @param acpId - the ACP tool call id.
   * @returns the id Casper's step is recorded under.
   */
  readonly callId: (acpId: string) => ToolCallId
  /**
   * Receive the app tool's own result for the Casper step that made the call,
   * so the step's card shows it as the DeepSeek loop would.
   * @param acpId - the ACP tool call id of the step.
   * @param call - the app tool, its arguments, and its result.
   */
  readonly record: (acpId: string, call: BridgedCall) => void
  /**
   * Receive an out-of-band server failure; never sees the token.
   * @param error - the failure.
   */
  readonly onError: (error: Error) => void
}

/** A running app tools server. */
export interface AppToolsServer {
  /** `http://127.0.0.1:<port>/mcp/<pathId>`. */
  readonly url: string
  /** The bearer token every request must carry. */
  readonly token: string
  /**
   * Stop listening and close every open connection, ending the requests on them; later requests fail. Memoized.
   * @returns resolution once the listener is closed.
   */
  close(): Promise<void>
}

/**
 * The ACP `mcpServers` entry for a running server.
 * @param server - the running server.
 * @returns the one HTTP entry `session/new` and `session/load` carry.
 */
export function appToolsEntry(server: Pick<AppToolsServer, 'url' | 'token'>): AcpMcpServer {
  return {
    type: 'http',
    name: APP_SERVER_NAME,
    url: server.url,
    headers: [{ name: 'Authorization', value: `Bearer ${server.token}` }],
    _meta: { [CLIENT_ASKS_META]: true },
  }
}

/**
 * Cut a description to {@link DESCRIPTION_MAX} characters.
 * @param text - the description.
 * @returns the text, ending in an ellipsis when cut.
 */
export function clipDescription(text: string): string {
  return text.length <= DESCRIPTION_MAX ? text : `${text.slice(0, DESCRIPTION_MAX - 1)}…`
}

/**
 * The `app_skill` description: what to load first, then the other skill names.
 * @param names - model-invocable skill names.
 * @returns at most {@link DESCRIPTION_MAX} characters.
 */
export function skillDescription(names: readonly string[]): string {
  const head = `Load this desktop app's guides. Load ${PLUGIN_SKILL} first to build, install or fix a plugin, page, left or side panel, widget or tool in the app.`
  const others = names.filter(name => name !== PLUGIN_SKILL)
  if (others.length === 0) return head
  let listed = others.length
  for (;;) {
    const tail = listed === others.length ? '.' : ', …'
    const text = `${head} Others: ${others.slice(0, listed).join(', ')}${tail}`
    if (text.length <= DESCRIPTION_MAX || listed === 1) return clipDescription(text)
    listed -= 1
  }
}

/** Preface sentence for an installed app, whose packages carry no declarations, sources or repository docs. */
export const INSTALLED_NOTE = 'This app is installed: its packages have README.md and built lib/*.js but no lib/types or src, '
  + 'and no repository docs; take slot props and theme tokens from cordis_inspect_query (Slots, Theme).'

/**
 * The text that opens every `app_skill` result in Casper mode.
 * @param profile - the app's profile, when it has one.
 * @param installed - whether the app runs from installed packages; adds {@link INSTALLED_NOTE}.
 * @returns the preface.
 */
export function skillPreface(profile: AppToolsProfile | undefined, installed: boolean): string {
  const env = profile === undefined ? '' : `; DSH_PROFILE=${profile.name}, DSH_PROFILE_DIR=${profile.dir}`
  return 'In Casper mode: write the bundle in the workspace with your own tools; read files under this skill\'s base directory '
    + `or any packageDir with app_read_file (they are inside app.asar)${env}. `
    + 'If plugin_manager, app_read_file or a cordis_inspect tool is not in your tool list, reach it through find_capability.'
    + (installed ? ` ${INSTALLED_NOTE}` : '')
}

/**
 * Map the app's result blocks to MCP content; blocks MCP has no form for become a short note.
 * @param blocks - the app tool's result content.
 * @returns MCP text content in the same order.
 */
export function mcpContent(blocks: readonly ContentBlock[]): CallToolResult['content'] {
  return blocks.map((block) => {
    switch (block.type) {
      case 'text':
        return { type: 'text' as const, text: block.text }
      default:
        // Images are attachment references in the app; none of the served tools returns one.
        return { type: 'text' as const, text: `[${block.type} result not sent]` }
    }
  })
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/** The ACP call id a request carries, if any. */
function acpIdOf(meta: Record<string, unknown> | undefined): string | undefined {
  const value = meta?.[ACP_TOOL_CALL_META]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Send progress every {@link PROGRESS_INTERVAL_MS} while a call runs; returns the stop function. */
function heartbeat(ctx: ServerContext, onError: (error: Error) => void): () => void {
  const token = ctx.mcpReq._meta?.progressToken
  if (token === undefined) return () => {}
  let progress = 0
  const timer = setInterval(() => {
    progress += 1
    ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, progress, message: 'still running in the app' } }).catch(
      /* v8 ignore start -- a notification fails only after Casper closed the request's stream; the call's own abort follows. */
      (error: unknown) => { onError(new Error(`progress was not sent: ${String(error)}`)) },
      /* v8 ignore stop */
    )
  }, PROGRESS_INTERVAL_MS)
  return () => { clearInterval(timer) }
}

/** This package's version, the server version when the app gave none. */
function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }
  /* v8 ignore next -- the package manifest always carries a version. */
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

/**
 * The capabilities the server states. It is stateless (a GET is 405), so it
 * sends no list-changed notice and says so; Casper lists the tools again on
 * each new connection instead.
 */
const SERVER_CAPABILITIES = { tools: { listChanged: false } } as const

/** Build the per-request MCP server: descriptions read the current skill catalog and tool registrations. */
async function mcpServer(options: AppToolsOptions, version: string): Promise<McpServer> {
  const server = new McpServer({ name: 'dsh-desktop', version }, { capabilities: SERVER_CAPABILITIES })
  const schemas = new Map(options.tools.schemas(options.agent).map(schema => [schema.name, schema]))
  const run = async (tool: BridgedTool, dsh: string, args: Record<string, unknown>, ctx: ServerContext): Promise<CallToolResult> => {
    const turn = options.turn()
    if (turn === undefined || turn.aborted) return errorResult(TURN_OVER)
    const acpId = acpIdOf(ctx.mcpReq._meta)
    const id = acpId === undefined ? ToolCallId(`casper-app:${randomUUID()}`) : options.callId(acpId)
    const stop = heartbeat(ctx, options.onError)
    try {
      const batch = await options.tools.execute({
        calls: [{ type: 'tool-call', id, name: dsh, arguments: JSON.stringify(args) }],
        signal: AbortSignal.any([ctx.mcpReq.signal, turn]),
        agent: options.agent,
      })
      const result = batch.results[0]?.result
      /* v8 ignore next -- an executor returns one result per call. */
      if (result === undefined) return errorResult(`${tool.mcp} returned no result.`)
      if (acpId !== undefined) options.record(acpId, { name: dsh, arguments: JSON.stringify(args), result })
      const content = mcpContent(result.content)
      if (tool.mcp === 'app_skill' && !result.isError) content.unshift({ type: 'text', text: skillPreface(options.profile, options.installed) })
      return { content, isError: result.isError }
    } catch (error: unknown) {
      return errorResult(`${tool.mcp} failed in the app: ${String(error)}`)
    } finally {
      stop()
    }
  }
  const readFile = async (args: { path: string; offset?: number; limit?: number }): Promise<CallToolResult> => {
    const turn = options.turn()
    if (turn === undefined || turn.aborted) return errorResult(TURN_OVER)
    const read = await readAppFile(options.roots, args)
    return { content: [{ type: 'text', text: read.text }], isError: read.isError }
  }
  const hints = (tool: BridgedTool) => ({
    ...tool.readOnly ? { annotations: { readOnlyHint: true } } : {},
    ...tool.pin ? { _meta: { [PIN_META]: true } } : {},
  })
  const description = async (tool: BridgedTool, own: string): Promise<string> => {
    if (tool.mcp === 'app_skill') {
      const listed = options.skills === undefined ? [] : await options.skills.list({ cwd: options.cwd, scope: options.agent })
      return skillDescription(listed.filter(skill => skill.invocation.modelInvocable).map(skill => skill.name))
    }
    return tool.guide ? `${GUIDE_FIRST} ${own}` : own
  }
  for (const tool of BRIDGED) {
    const dsh = tool.dsh
    if (dsh === undefined) {
      server.registerTool(tool.mcp, {
        description: READ_FILE_DESCRIPTION,
        inputSchema: fromJsonSchema<{ path: string; offset?: number; limit?: number }>(READ_FILE_SCHEMA),
        ...hints(tool),
      }, readFile)
      continue
    }
    const schema = schemas.get(dsh)
    if (schema === undefined) continue
    server.registerTool(tool.mcp, {
      description: clipDescription(await description(tool, schema.description)),
      inputSchema: fromJsonSchema<Record<string, unknown>>(schema.parameters as JsonSchemaType),
      ...hints(tool),
    }, (args, ctx) => run(tool, dsh, args, ctx))
  }
  const forwarded = options.resourceServers?.() ?? []
  for (const tool of RESOURCE_TOOLS) {
    const bridged: BridgedTool = { mcp: tool.mcp, dsh: tool.mcp, readOnly: true, pin: false, guide: false }
    server.registerTool(tool.mcp, {
      description: resourceDescription(tool.does, forwarded),
      inputSchema: fromJsonSchema<Record<string, unknown>>(tool.schema),
      ...hints(bridged),
    }, (args, ctx) => {
      // The app registers its resource tools only while one of its servers offers resources.
      if (!schemas.has(tool.mcp)) return Promise.resolve(errorResult(NO_RESOURCES))
      const name = appServerName(String(args.server))
      const servers = options.resourceServers?.() ?? []
      if (!servers.includes(name)) {
        return Promise.resolve(errorResult(`The app hands Casper no MCP server named ${String(args.server)}. Servers: ${serverList(servers)}.`))
      }
      return run(bridged, tool.mcp, { ...args, server: name }, ctx)
    })
  }
  return server
}

/**
 * Start one app tools server on a fresh 127.0.0.1 port with a fresh path and token.
 * Requests are checked in order: path (404), Host (403), any Origin (403), bearer token (401).
 * @param options - the registries, the Agent, the turn gate, and the call id mapping.
 * @returns the running server.
 */
export async function startAppTools(options: AppToolsOptions): Promise<AppToolsServer> {
  const pathId = randomBytes(16).toString('base64url')
  const token = randomBytes(32).toString('base64url')
  const expected = Buffer.from(`Bearer ${token}`)
  const version = options.version ?? packageVersion()
  const handler = createMcpHandler(() => mcpServer(options, version), { onerror: options.onError })
  const serve = toNodeHandler(handler, { onerror: options.onError })
  let host = ''
  const admit = (request: IncomingMessage): number | undefined => {
    // An http.Server request always carries its target.
    if (String(request.url).split('?')[0] !== `/mcp/${pathId}`) return 404
    if (request.headers.host !== host) return 403
    if (request.headers.origin !== undefined) return 403
    const given = Buffer.from(request.headers.authorization ?? '')
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 401
    return undefined
  }
  const listener = createServer((request: IncomingMessage, response: ServerResponse) => {
    const refused = admit(request)
    if (refused !== undefined) {
      response.writeHead(refused, refused === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}).end()
      return
    }
    // The adapter's request type excludes explicit undefined on Node's optional fields.
    serve(request as NodeIncomingMessageLike, response).catch(
      /* v8 ignore start -- the adapter answers its own failures with 500; this guards a write after the socket closed. */
      (error: unknown) => {
        options.onError(new Error(`app tools request failed: ${String(error)}`))
        response.destroy()
      },
      /* v8 ignore stop */
    )
  })
  const listening = Promise.withResolvers<void>()
  listener.once('error', listening.reject)
  listener.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  listener.off('error', listening.reject)
  // The URL and the Host check come from the socket itself, so they name the address it is bound to.
  const { address, port } = listener.address() as AddressInfo
  host = `${address}:${port}`
  let closing: Promise<void> | undefined
  return {
    url: `http://${host}/mcp/${pathId}`,
    token,
    close: () => (closing ??= (async () => {
      const stopped = new Promise<void>((resolve) => { listener.close(() => { resolve() }) })
      listener.closeAllConnections()
      await handler.close()
      await stopped
    })()),
  }
}
