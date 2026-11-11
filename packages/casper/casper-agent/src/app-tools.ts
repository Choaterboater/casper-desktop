/**
 * The app's plugin tools for one Casper connection: an MCP Streamable HTTP
 * server on its own 127.0.0.1 listener, reachable only at a random path with a
 * random bearer token, that forwards calls to the app's tools as the Casper
 * Agent while a Casper turn is open. The same listener serves each of the app's
 * own MCP client rows handed to Casper at a path of its own below that one.
 * @module @deepseek-ai/dsh-casper-agent/app-tools
 */

import { Buffer } from 'node:buffer'
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
  specTypeSchemas,
} from '@modelcontextprotocol/server'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { mcpToolOrigin, type McpToolHints, type McpToolOrigin } from '@deepseek-ai/dsh-mcp-client'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'
import type { ResolvedToolSet, ToolResult, ToolsService } from '@deepseek-ai/dsh-tools'
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
/** The tool Casper calls on its own once per connection to a server, before any turn; see {@link isConnectCheck}. */
export const ACCESS_CHECK = 'access_check'
/** Result of a Team tool call while Team is off for the Session. */
export const TEAM_OFF = 'Team is off for this Session; the person can turn on Enable agent teamwork in the model menu.'

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
  /** Whether it is one of the app's subagent tools, served only while {@link AppToolsOptions.subagents} is on. */
  readonly subagents: boolean
  /** Whether it is one of the app's goal tools, served only while {@link AppToolsOptions.goals} is on. */
  readonly goals: boolean
  /**
   * Whether it is one of the app's Team task-board tools, served only while {@link AppToolsOptions.teams} is on;
   * the app admits a call only while Team is on for the Session.
   */
  readonly teams: boolean
}

/**
 * The tools served, in list order, which is the order Casper takes pins in:
 * the guide and the install first, then the reader, then `present`, which
 * hands the user a file the app shows as a card in the Casper turn. Four are
 * pinned; `cordis_inspect_query` gave its pin to `present`, so each request
 * costs the same, and Casper reaches it through find_capability.
 *
 * The app's subagent tools come last and are never pinned, so Casper's fixed
 * prompt does not grow; Casper finds them through its tool search. `wait_agent`
 * is not served: Casper ends an MCP call after 10 minutes however much progress
 * it sends, and the completion notice reaches Casper on its own.
 *
 * The app's goal tools follow, also never pinned. The app gives a Standard
 * agent their rules in its system prompt, which Casper never reads, so the two
 * that change a goal carry them in {@link GOAL_RULES}.
 *
 * The app's Team task-board tools come last, also never pinned. Casper lists
 * the tools once per connection, so they are listed whether or not Team is on;
 * the app's own check refuses a call while it is off, and the task-creating one
 * carries the Team rules in {@link TEAM_RULES}.
 */
const BRIDGED: readonly BridgedTool[] = [
  { mcp: 'app_skill', dsh: 'skill', readOnly: true, pin: true, guide: false, subagents: false, goals: false, teams: false },
  { mcp: 'plugin_manager', dsh: 'plugin_manager', readOnly: false, pin: true, guide: true, subagents: false, goals: false, teams: false },
  { mcp: 'app_read_file', dsh: undefined, readOnly: true, pin: true, guide: false, subagents: false, goals: false, teams: false },
  { mcp: 'present', dsh: 'present', readOnly: true, pin: true, guide: false, subagents: false, goals: false, teams: false },
  { mcp: 'cordis_inspect_query', dsh: 'cordis_inspect_query', readOnly: true, pin: false, guide: false, subagents: false, goals: false, teams: false },
  { mcp: 'cordis_inspect_list', dsh: 'cordis_inspect_list', readOnly: true, pin: false, guide: true, subagents: false, goals: false, teams: false },
  { mcp: 'subagent', dsh: 'subagent', readOnly: false, pin: false, guide: false, subagents: true, goals: false, teams: false },
  { mcp: 'send_message', dsh: 'send_message', readOnly: false, pin: false, guide: false, subagents: true, goals: false, teams: false },
  { mcp: 'interrupt_agent', dsh: 'interrupt_agent', readOnly: false, pin: false, guide: false, subagents: true, goals: false, teams: false },
  { mcp: 'list_agents', dsh: 'list_agents', readOnly: true, pin: false, guide: false, subagents: true, goals: false, teams: false },
  { mcp: 'list_subagent_models', dsh: 'list_subagent_models', readOnly: true, pin: false, guide: false, subagents: true, goals: false, teams: false },
  { mcp: 'get_goal', dsh: 'get_goal', readOnly: true, pin: false, guide: false, subagents: false, goals: true, teams: false },
  { mcp: 'create_goal', dsh: 'create_goal', readOnly: false, pin: false, guide: false, subagents: false, goals: true, teams: false },
  { mcp: 'update_goal', dsh: 'update_goal', readOnly: false, pin: false, guide: false, subagents: false, goals: true, teams: false },
  { mcp: 'team_task_create', dsh: 'team_task_create', readOnly: false, pin: false, guide: false, subagents: false, goals: false, teams: true },
  { mcp: 'team_task_list', dsh: 'team_task_list', readOnly: true, pin: false, guide: false, subagents: false, goals: false, teams: true },
  { mcp: 'team_task_get', dsh: 'team_task_get', readOnly: true, pin: false, guide: false, subagents: false, goals: false, teams: true },
  { mcp: 'team_task_update', dsh: 'team_task_update', readOnly: false, pin: false, guide: false, subagents: false, goals: false, teams: true },
]

/** The goal rules a Standard agent reads in its system prompt, added to the goal tools that change a goal. */
export const GOAL_RULES = 'Rules: when the Session was reopened, an active goal waits until the person asks to go on; then call update_goal '
  + 'with action resume. Mark a goal complete only when its objective is achieved, and blocked only when the same condition '
  + 'has stopped progress for several goal rounds; difficulty or work left to do is not blocked.'

/** The Team rules a Standard agent reads in its system prompt while Team is on, added to `team_task_create`. */
export const TEAM_RULES = 'Rules: split write work into separate scopes and record them on the task; use blocked_by when work must be ordered. '
  + 'An owner claims a task with its current revision, does the work, then completes it. Task changes wake no one: use send_message '
  + 'when another agent must act. A teammate\'s finish notice reaches you on its own; answer after the teammates you need have finished.'

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
 * @returns the name the app gives it in Settings or in a plugin registration.
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
  /** The app's tool registry; calls resolve in `agent`'s scope, and a Team call's admission is resolved for it. */
  readonly tools: Pick<ToolsService, 'schemas' | 'execute' | 'get' | 'resolve' | 'definitions'>
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
   * Serve the app's subagent tools: `subagent`, `send_message`, `interrupt_agent`, `list_agents` and
   * `list_subagent_models`; true when omitted.
   */
  readonly subagents?: boolean | undefined
  /** Serve the app's goal tools: `get_goal`, `create_goal` and `update_goal`; true when omitted. */
  readonly goals?: boolean | undefined
  /**
   * Serve the app's Team task-board tools: `team_task_create`, `team_task_list`, `team_task_get` and
   * `team_task_update`; true when omitted.
   */
  readonly teams?: boolean | undefined
  /**
   * Send the pictures in an app tool's result to Casper as MCP image content, within {@link MAX_REPLY_BYTES}; true
   * when omitted. False sends a one-line note in place of each.
   */
  readonly images?: boolean | undefined
  /** The app's attachment store, which holds the bytes of a picture in a result; a picture is unreadable when omitted. */
  readonly attachments?: Pick<AttachmentStore, 'readImage'> | undefined
  /**
   * The route the app's checks read when they admit a Team call.
   * @returns the Agent's current model, or a stand-in before it has one.
   */
  readonly route: () => Readonly<ModelSelection>
  /**
   * Run a call inside the caller's initiator boundary, so the app tool sees the Casper Agent as the initiator of
   * what it starts, as a Standard parent's tool call does; the call runs as it is when omitted.
   * @param operation - the call.
   * @returns what `operation` returns.
   */
  readonly initiate?: (<T>(operation: () => T) => T) | undefined
  /**
   * The Settings and plugin-registered servers this connection hands Casper, which the resource tools reach; read at each request.
   * @returns their names, without Casper's `acp-` prefix; none when omitted.
   */
  readonly resourceServers?: (() => readonly string[]) | undefined
  /**
   * The app's own MCP client rows this connection hands Casper, each served at `<url>/<row>`; read at each request,
   * so any other path below the server's is not found.
   * @returns their server names; none when omitted.
   */
  readonly rows?: (() => readonly string[]) | undefined
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
 * The MCP annotations a served tool is listed with.
 * @param readOnly - the bridge's own read-only flag for the row.
 * @param origin - the MCP origin of the app tool the row runs, when it came from an MCP server.
 * @returns that server's own hints verbatim for an MCP tool, never one the bridge adds;
 *   otherwise `{ readOnlyHint: true }` for a read-only row, or undefined.
 */
export function servedAnnotations(readOnly: boolean, origin: McpToolOrigin | undefined): McpToolHints | undefined {
  if (origin !== undefined) return Object.keys(origin.annotations).length === 0 ? undefined : { ...origin.annotations }
  return readOnly ? { readOnlyHint: true } : undefined
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
 * The ACP `mcpServers` entry for one of the app's own MCP client rows, served by a running server. It carries no
 * `casper/clientAsks`, so Casper asks before the row's changes in its own box, and none of its tools is pinned.
 * @param server - the running server.
 * @param row - the row's server name, which Casper names `acp-<row>`.
 * @returns the HTTP entry for the row's own endpoint.
 */
export function rowEntry(server: Pick<AppToolsServer, 'url' | 'token'>, row: string): AcpMcpServer {
  return {
    type: 'http',
    name: row,
    url: `${server.url}/${row}`,
    headers: [{ name: 'Authorization', value: `Bearer ${server.token}` }],
  }
}

/**
 * The app's own MCP client rows the app holds now, in tool registration order: every server a listed tool came
 * from, except the names given, which the MCP manager owns, and the app's own server name.
 * @param tools - the app's tool registry.
 * @param agent - the scope the tools are listed in.
 * @param owned - the Settings and plugin-registered server names.
 * @returns each row's name and the raw names of the tools it lists.
 */
export function clientRows(
  tools: Pick<ToolsService, 'definitions'>,
  agent: Agent,
  owned: ReadonlySet<string>,
): { name: string; tools: string[] }[] {
  const rows = new Map<string, string[]>()
  for (const definition of tools.definitions(agent)) {
    const origin = mcpToolOrigin(definition)
    if (origin === undefined || origin.server === APP_SERVER_NAME || owned.has(origin.server)) continue
    const listed = rows.get(origin.server) ?? []
    listed.push(origin.rawName)
    rows.set(origin.server, listed)
  }
  return [...rows].map(([name, listed]) => ({ name, tools: listed }))
}

/**
 * Whether a call to a row's tool may run outside a Casper turn: only the check Casper makes on its own when it
 * connects, before any prompt. That is Casper's own rule for it: named {@link ACCESS_CHECK}, marked read-only and not
 * destructive by the server, and needing no arguments.
 * @param origin - the tool's MCP origin.
 * @param parameters - its input schema.
 * @returns true for that check.
 */
export function isConnectCheck(origin: McpToolOrigin, parameters: unknown): boolean {
  const { readOnlyHint, destructiveHint } = origin.annotations
  if (origin.rawName !== ACCESS_CHECK || readOnlyHint !== true || destructiveHint === true) return false
  const required: unknown = typeof parameters === 'object' && parameters !== null ? Reflect.get(parameters, 'required') : undefined
  return !Array.isArray(required) || required.length === 0
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
 * Most bytes of text and pictures one reply carries. Casper fails an MCP call whose reply passes 8 MiB; the rest is
 * room for the JSON framing and progress notices.
 */
export const MAX_REPLY_BYTES = 7 * 1024 * 1024
/** Sent in place of a picture that would take the reply past {@link MAX_REPLY_BYTES}. */
export const PICTURE_OVER_BUDGET = '[A picture in this result was not sent: with it the reply would pass the 8 MB Casper takes.]'
/** Sent in place of a picture the app could not read. */
export const PICTURE_UNREADABLE = '[A picture in this result could not be read, so it was not sent.]'

/** Where {@link mcpContent} reads the pictures of a result from. */
export interface McpPictures {
  /** The app's attachment store; every picture is unreadable when undefined. */
  readonly attachments: Pick<AttachmentStore, 'readImage'> | undefined
  /** The call's signal; a read it aborts fails the whole conversion. */
  readonly signal: AbortSignal
}

/** Length of the base64 form of `bytes` bytes. */
function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

/** One picture as MCP image content, or the note sent in its place when it is unreadable or does not fit in `room`. */
async function mcpPicture(ref: ImageAttachmentRef, pictures: McpPictures, room: number): Promise<CallToolResult['content'][number]> {
  // The stored size is exact, so a picture that cannot fit is never read.
  if (base64Length(ref.bytes) > room) return { type: 'text', text: PICTURE_OVER_BUDGET }
  if (pictures.attachments === undefined) return { type: 'text', text: PICTURE_UNREADABLE }
  let data: Uint8Array
  try {
    data = (await pictures.attachments.readImage(ref, pictures.signal)).data
  } catch (error: unknown) {
    // An abort ends the call; any other read failure sends the note.
    if (pictures.signal.aborted) throw error
    return { type: 'text', text: PICTURE_UNREADABLE }
  }
  const base64 = Buffer.from(data).toString('base64')
  if (base64.length > room) return { type: 'text', text: PICTURE_OVER_BUDGET }
  return { type: 'image', data: base64, mimeType: ref.mediaType }
}

/**
 * Map the app's result blocks to MCP content, in the same order. Text passes through. With `pictures`, each picture
 * goes as MCP image content (its stored normalized bytes, base64, with the stored media type) while the text and the
 * pictures before it leave room within {@link MAX_REPLY_BYTES}; otherwise a picture, like every block MCP has no form
 * for, becomes a short note.
 * @param blocks - the app tool's result content.
 * @param pictures - where to read pictures from; undefined sends each as a note.
 * @returns MCP content in the same order.
 */
export async function mcpContent(blocks: readonly ContentBlock[], pictures?: McpPictures): Promise<CallToolResult['content']> {
  // Text counts as it goes on the wire: JSON-escaped, so quotes, newlines and control characters count in full.
  let used = 0
  for (const block of blocks) if (block.type === 'text') used += Buffer.byteLength(JSON.stringify(block.text), 'utf8')
  const content: CallToolResult['content'] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text })
    } else if (block.type === 'image' && block.offloaded !== true && pictures !== undefined) {
      // An offloaded picture keeps its note: the app chose to send no bytes for it.
      const picture = await mcpPicture(block.attachment, pictures, MAX_REPLY_BYTES - used)
      if (picture.type === 'image') used += picture.data.length
      content.push(picture)
    } else {
      content.push({ type: 'text', text: `[${block.type} result not sent]` })
    }
  }
  return content
}

/**
 * A row tool's own MCP result as its server sent it, base64 pictures included, so Casper reads and shrinks them
 * itself. The other blocks and the structured content count first; then each picture goes while it fits within
 * {@link MAX_REPLY_BYTES}, and {@link PICTURE_OVER_BUDGET} goes in place of one that does not.
 * @param value - the app tool's canonical value: the server's `content` and `structuredContent`.
 * @param images - whether pictures go; false sends a one-line note in place of each.
 * @param after - context the app adds after the server's content, which shares the budget; none when omitted.
 * @returns the result, or undefined for a value that is not an MCP result.
 */
export function rowResult(value: unknown, images: boolean, after: CallToolResult['content'] = []): CallToolResult | undefined {
  const parsed = specTypeSchemas.CallToolResult['~standard'].validate(value)
  if (parsed.issues !== undefined) return undefined
  const { content, structuredContent } = parsed.value
  let used = structuredContent === undefined ? 0 : Buffer.byteLength(JSON.stringify(structuredContent), 'utf8')
  for (const block of [...content, ...after]) if (block.type !== 'image') used += Buffer.byteLength(JSON.stringify(block), 'utf8')
  const sent: CallToolResult['content'] = []
  for (const block of content) {
    if (block.type !== 'image') {
      sent.push(block)
    } else if (!images) {
      sent.push({ type: 'text', text: '[image result not sent]' })
    } else if (block.data.length > MAX_REPLY_BYTES - used) {
      sent.push({ type: 'text', text: PICTURE_OVER_BUDGET })
    } else {
      used += block.data.length
      sent.push(block)
    }
  }
  return { content: [...sent, ...after], ...structuredContent === undefined ? {} : { structuredContent } }
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
    const initiate = options.initiate ?? (<T>(operation: () => T): T => operation())
    const signal = AbortSignal.any([ctx.mcpReq.signal, turn])
    let toolSet: ResolvedToolSet | undefined
    try {
      if (tool.teams) {
        // The app registers the Team tools with a check that admits them only while Team is on; it runs here as at a step.
        toolSet = await options.tools.resolve({ agent: options.agent, modelSelection: options.route(), signal })
        if (!toolSet.view(options.agent).has(dsh)) return errorResult(TEAM_OFF)
      }
      const admitted = toolSet
      const batch = await initiate(() => options.tools.execute({
        calls: [{ type: 'tool-call', id, name: dsh, arguments: JSON.stringify(args) }],
        signal,
        agent: options.agent,
        ...admitted === undefined ? {} : { toolSet: admitted },
      }))
      const result = batch.results[0]?.result
      /* v8 ignore next -- an executor returns one result per call. */
      if (result === undefined) return errorResult(`${tool.mcp} returned no result.`)
      if (acpId !== undefined) options.record(acpId, { name: dsh, arguments: JSON.stringify(args), result })
      // Context a tool defers to the next step, such as the wrap-up after a goal round's update_goal, goes with the
      // result and shares its reply budget. Casper sends no pictures from a failed result, so none are read for one.
      const pictures = (options.images ?? true) && !result.isError ? { attachments: options.attachments, signal } : undefined
      const content = await mcpContent([...result.content, ...batch.additionalContexts.flatMap(context => context.content)], pictures)
      if (tool.mcp === 'app_skill' && !result.isError) content.unshift({ type: 'text', text: skillPreface(options.profile, options.installed) })
      return { content, isError: result.isError }
    } catch (error: unknown) {
      return errorResult(`${tool.mcp} failed in the app: ${String(error)}`)
    } finally {
      stop()
      toolSet?.dispose()
    }
  }
  const readFile = async (args: { path: string; offset?: number; limit?: number }): Promise<CallToolResult> => {
    const turn = options.turn()
    if (turn === undefined || turn.aborted) return errorResult(TURN_OVER)
    const read = await readAppFile(options.roots, args)
    return { content: [{ type: 'text', text: read.text }], isError: read.isError }
  }
  const hints = (tool: BridgedTool) => {
    const origin = tool.dsh === undefined ? undefined : mcpToolOrigin(options.tools.get(tool.dsh, options.agent))
    const annotations = servedAnnotations(tool.readOnly, origin)
    return {
      ...annotations === undefined ? {} : { annotations },
      ...tool.pin ? { _meta: { [PIN_META]: true } } : {},
    }
  }
  const description = async (tool: BridgedTool, own: string): Promise<string> => {
    if (tool.mcp === 'app_skill') {
      const listed = options.skills === undefined ? [] : await options.skills.list({ cwd: options.cwd, scope: options.agent })
      return skillDescription(listed.filter(skill => skill.invocation.modelInvocable).map(skill => skill.name))
    }
    if (tool.goals && !tool.readOnly) return `${own} ${GOAL_RULES}`
    if (tool.mcp === 'team_task_create') return `${own} ${TEAM_RULES}`
    return tool.guide ? `${GUIDE_FIRST} ${own}` : own
  }
  const subagents = options.subagents ?? true
  const goals = options.goals ?? true
  const teams = options.teams ?? true
  for (const tool of BRIDGED) {
    if (tool.subagents && !subagents) continue
    if (tool.goals && !goals) continue
    if (tool.teams && !teams) continue
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
    const bridged: BridgedTool = {
      mcp: tool.mcp, dsh: tool.mcp, readOnly: true, pin: false, guide: false, subagents: false, goals: false, teams: false,
    }
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
 * Run one call to a row's tool through the app's tools pipeline as the Casper Agent. It runs while a Casper turn is
 * open, and outside one only when it is the row's connect check; it answers with the server's own result.
 */
async function rowCall(
  options: AppToolsOptions,
  name: string,
  connect: boolean,
  args: Record<string, unknown>,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const turn = options.turn()
  const open = turn !== undefined && !turn.aborted
  if (!open && !connect) return errorResult(TURN_OVER)
  const stop = heartbeat(ctx, options.onError)
  const initiate = options.initiate ?? (<T>(operation: () => T): T => operation())
  // Casper makes its connect check before any prompt, so only the request's own signal ends it.
  const signal = open ? AbortSignal.any([ctx.mcpReq.signal, turn]) : ctx.mcpReq.signal
  try {
    const batch = await initiate(() => options.tools.execute({
      calls: [{ type: 'tool-call', id: ToolCallId(`casper-app:${randomUUID()}`), name, arguments: JSON.stringify(args) }],
      signal,
      agent: options.agent,
    }))
    const result = batch.results[0]?.result
    /* v8 ignore next -- an executor returns one result per call. */
    if (result === undefined) return errorResult(`${name} returned no result.`)
    // Context a tool defers to the next step goes after the result and shares its reply budget.
    const deferred = batch.additionalContexts.flatMap(context => context.content)
    if (result.isError) return { content: await mcpContent([...result.content, ...deferred]), isError: true }
    const raw = rowResult(result.value, options.images ?? true, await mcpContent(deferred))
    if (raw !== undefined) return raw
    // A value that is not an MCP result goes as the app's own content, its pictures read as for an app tool.
    const pictures = (options.images ?? true) ? { attachments: options.attachments, signal } : undefined
    return { content: await mcpContent([...result.content, ...deferred], pictures) }
  } catch (error: unknown) {
    return errorResult(`${name} failed in the app: ${String(error)}`)
  } finally {
    stop()
  }
}

/**
 * Build the per-request MCP server for one row: each tool the row lists now, under the server's own name for it,
 * with its own schema and description and the server's own hints, never pinned.
 */
function rowServer(options: AppToolsOptions, row: string, version: string): McpServer {
  const server = new McpServer({ name: `dsh-desktop/${row}`, version }, { capabilities: SERVER_CAPABILITIES })
  for (const schema of options.tools.schemas(options.agent)) {
    const origin = mcpToolOrigin(options.tools.get(schema.name, options.agent))
    if (origin?.server !== row) continue
    const annotations = servedAnnotations(false, origin)
    const connect = isConnectCheck(origin, schema.parameters)
    server.registerTool(origin.rawName, {
      description: clipDescription(schema.description),
      inputSchema: fromJsonSchema<Record<string, unknown>>(schema.parameters as JsonSchemaType),
      ...annotations === undefined ? {} : { annotations },
    }, (args, ctx) => rowCall(options, schema.name, connect, args, ctx))
  }
  return server
}

/**
 * Start one app tools server on a fresh 127.0.0.1 port with a fresh path and token.
 * Requests are checked in order: path (404), Host (403), any Origin (403), bearer token (401). A path below the
 * server's is found only for a row {@link AppToolsOptions.rows} names at that request.
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
  const handlers = [handler]
  // One handler per row, made at the row's first request.
  const rows = new Map<string, typeof serve>()
  const rowServe = (row: string): typeof serve => {
    let served = rows.get(row)
    if (served === undefined) {
      const made = createMcpHandler(() => rowServer(options, row, version), { onerror: options.onError })
      handlers.push(made)
      served = toNodeHandler(made, { onerror: options.onError })
      rows.set(row, served)
    }
    return served
  }
  const base = `/mcp/${pathId}`
  let host = ''
  const admit = (request: IncomingMessage): number | typeof serve => {
    // An http.Server request always carries its target.
    const path = String(request.url).split('?', 1).join('')
    const row = path.startsWith(`${base}/`) ? path.slice(base.length + 1) : undefined
    if (path !== base && (row === undefined || !(options.rows?.() ?? []).includes(row))) return 404
    if (request.headers.host !== host) return 403
    if (request.headers.origin !== undefined) return 403
    const given = Buffer.from(request.headers.authorization ?? '')
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 401
    return row === undefined ? serve : rowServe(row)
  }
  const listener = createServer((request: IncomingMessage, response: ServerResponse) => {
    const admitted = admit(request)
    if (typeof admitted === 'number') {
      response.writeHead(admitted, admitted === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}).end()
      return
    }
    // The adapter's request type excludes explicit undefined on Node's optional fields.
    admitted(request as NodeIncomingMessageLike, response).catch(
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
      await Promise.all(handlers.map(async (made) => { await made.close() }))
      await stopped
    })()),
  }
}
