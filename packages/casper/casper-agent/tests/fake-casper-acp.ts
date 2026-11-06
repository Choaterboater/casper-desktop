/**
 * A stand-in for `casper acp`, run as a child process by the Casper agent
 * tests. It speaks the agent side of ACP over stdio with Casper's wire
 * details (tool ids `casper-tool-N`, `casper-check-N`, `casper-approval-N`,
 * option kinds, the receipt as the last chunk) and is driven by files:
 *
 * - `FAKE_CASPER_SCRIPT` — JSON `{ prompts: Step[][], known?: string[],
 *   loadError?: string, holdInitialize?: string, ignoreEof?: boolean }`.
 *   Prompt N across every process run plays `prompts[N]`; the count is read
 *   from the log. `known` lists conversations saved before the test;
 *   like Casper, an id from `session/new` is saved (and loadable by a later
 *   process) only once a prompt on it has replied. `session/load` of another
 *   id fails with -32002 and Casper's real message
 *   (`--resume: no saved conversation in this workspace starts with "<id>". …`),
 *   or with `loadError` when set. `holdInitialize` names a file whose
 *   existence holds the initialize reply. `ignoreEof` keeps the process alive
 *   after stdin closes, until it is killed.
 * - `FAKE_CASPER_LOG` — JSON lines appended for the start (argv, env names,
 *   PATH, cwd), every request and notification received, every permission
 *   answer, and stdin EOF. Tests poll this file.
 *
 * Steps: `{ text }`, `{ tool, target? }` (starts the next tool id),
 * `{ toolEnd, ok }` (ends tool N), `{ check, status }`, `{ plan }`,
 * `{ permission, options, preview? }`, `{ receipt }`, `{ stop }`,
 * `{ hang: true }` (waits for session/cancel), `{ ignoreCancel: true }` (with
 * hang: never replies), `{ crash }` (exits with that code),
 * `{ waitFile }` (waits until the file exists), `{ stderr }` (writes a
 * line to stderr), `{ fail }` (replies with a -32603 error), `{ image }` and
 * `{ thought }` (updates Casper does not send), `{ late: Step }` (played 50 ms
 * after the reply), `{ exitAfterMs }` (exits with code 5 after that delay),
 * `{ mcp, args? }` (calls that tool on the first `mcpServers` entry with an
 * MCP 1.x client, carrying the current tool id as `casper/acpToolCallId`,
 * and logs `{ event: 'mcp', name, result, server }`, `server` being the answered serverInfo).
 * `replay` lists
 * user chunks sent during a successful `session/load`.
 *
 * @module @deepseek-ai/dsh-casper-agent/tests/fake-casper-acp
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  agent as createAcpAgent,
  methods,
  ndJsonStream,
  RequestError,
  type AgentContext,
  type McpServer,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionResponse,
  type SessionUpdate,
  type StopReason,
} from '@agentclientprotocol/sdk'

interface Step {
  text?: string
  tool?: string
  target?: string
  toolEnd?: number
  ok?: boolean
  check?: string
  status?: 'pass' | 'fail' | 'skip'
  plan?: { content: string; status: 'pending' | 'in_progress' | 'completed' }[]
  permission?: string
  options?: string[]
  preview?: string
  receipt?: string
  stop?: StopReason
  hang?: boolean
  ignoreCancel?: boolean
  crash?: number
  waitFile?: string
  stderr?: string
  fail?: string
  image?: boolean
  thought?: string
  late?: Step
  exitAfterMs?: number
  mcp?: string
  args?: Record<string, unknown>
}

interface Script {
  prompts: Step[][]
  known?: string[]
  loadError?: string
  holdInitialize?: string
  ignoreEof?: boolean
  replay?: string[]
  newSessionId?: string
}

const logFile = process.env.FAKE_CASPER_LOG ?? ''
const script: Script = JSON.parse(readFileSync(process.env.FAKE_CASPER_SCRIPT ?? '', 'utf8')) as Script

function log(entry: Record<string, unknown>): void {
  appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, ...entry })}\n`)
}

/** Conversations saved before the test plus those saved by an earlier prompt reply in any run. */
function savedConversations(): string[] {
  const saved = readFileSync(logFile, 'utf8').split('\n').filter(line => line.includes('"event":"saved"'))
    .map(line => (JSON.parse(line) as { sessionId: string }).sessionId)
  return [...script.known ?? [], ...saved]
}

function promptsSoFar(): number {
  return readFileSync(logFile, 'utf8').split('\n').filter(line => line.includes('"method":"session/prompt"')).length
}

async function until(file: string): Promise<void> {
  while (!existsSync(file)) await new Promise((resolve) => { setTimeout(resolve, 10) })
}

/** Casper's option kinds for its choice labels. */
function optionKind(label: string): 'reject_once' | 'allow_once' | 'allow_always' {
  if (/^no\b/i.test(label)) return 'reject_once'
  if (/session|always|everything/i.test(label)) return 'allow_always'
  return 'allow_once'
}

log({
  event: 'start',
  argv: process.argv.slice(2),
  envNames: Object.keys(process.env).sort(),
  path: process.env.PATH ?? '',
  cwd: process.cwd(),
  profile: { name: process.env.DSH_PROFILE, dir: process.env.DSH_PROFILE_DIR },
})

/** Whether any offered header value also reached this process's argv or environment. */
function exposed(servers: McpServer[]): { argv: boolean; env: boolean } {
  const values = servers.flatMap(server => 'headers' in server ? server.headers.map(header => header.value.replace(/^Bearer /, '')) : [])
  const found = (text: string | undefined): boolean => values.some(value => value !== '' && text?.includes(value) === true)
  return { argv: process.argv.some(found), env: Object.values(process.env).some(found) }
}

let sessionId: string | undefined
let mcpServers: McpServer[] = []
let steps = 0
let boxes = 0
let cancel: ((reason: StopReason) => void) | undefined
let ignoreCancel = false

async function update(client: AgentContext, item: SessionUpdate & Record<string, unknown>): Promise<void> {
  await client.notify(methods.client.session.update, { sessionId: sessionId ?? '', update: item })
}

interface Outcome {
  stop: StopReason
  receipt: string
}

async function play(params: PromptRequest, client: AgentContext): Promise<PromptResponse> {
  const index = promptsSoFar() - 1
  const outcome: Outcome = { stop: 'end_turn', receipt: 'verified' }
  let late: Step | undefined
  for (const step of script.prompts[index] ?? []) {
    await run(step, params, client, outcome)
    late = step.late ?? late
  }
  const text = `\nReceipt: ${outcome.receipt}\n`
  await update(client, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, _meta: { casper: { receipt: { outcome: outcome.receipt } } } })
  if (late !== undefined) {
    const after = late
    setTimeout(() => { void run(after, params, client, { stop: 'end_turn', receipt: 'late' }) }, 50)
  }
  return { stopReason: outcome.stop, _meta: { casper: { receipt: { outcome: outcome.receipt } } } }
}

async function run(step: Step, params: PromptRequest, client: AgentContext, outcome: Outcome): Promise<void> {
  {
    if (step.exitAfterMs !== undefined) setTimeout(() => process.exit(5), step.exitAfterMs)
    if (step.image === true) await update(client, { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'aGk=' } })
    if (step.thought !== undefined) await update(client, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: step.thought } })
    if (step.text !== undefined) await update(client, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: step.text } })
    if (step.tool !== undefined) {
      const id = `casper-tool-${++steps}`
      await update(client, {
        sessionUpdate: 'tool_call', toolCallId: id, title: step.target === undefined ? step.tool : `${step.tool} ${step.target}`,
        kind: step.tool === 'bash' ? 'execute' : 'other', status: 'in_progress',
        rawInput: { tool: step.tool, ...step.target === undefined ? {} : { target: step.target } },
      })
    }
    if (step.toolEnd !== undefined) {
      await update(client, { sessionUpdate: 'tool_call_update', toolCallId: `casper-tool-${step.toolEnd}`, status: step.ok === false ? 'failed' : 'completed' })
    }
    if (step.check !== undefined) {
      await update(client, {
        sessionUpdate: 'tool_call', toolCallId: `casper-check-${++steps}`, title: `Check ${step.check}`, kind: 'execute',
        status: step.status === 'fail' ? 'failed' : 'completed', rawOutput: { status: step.status ?? 'pass', exit: step.status === 'fail' ? 1 : 0, ms: 5 },
      })
    }
    if (step.plan !== undefined) {
      await update(client, { sessionUpdate: 'plan', entries: step.plan.map(entry => ({ ...entry, priority: 'medium' as const })) })
    }
    if (step.permission !== undefined) {
      const toolCallId = `casper-approval-${++boxes}`
      const toolCall = {
        toolCallId, title: step.permission, kind: 'other' as const, status: 'pending' as const,
        ...step.preview === undefined ? {} : { content: [{ type: 'content' as const, content: { type: 'text' as const, text: step.preview } }] },
      }
      await update(client, { sessionUpdate: 'tool_call', ...toolCall })
      const options = (step.options ?? ['No', 'Yes, this once', 'Yes for this session']).map((name, at) => ({
        optionId: String(at + 1), name, kind: optionKind(name),
      }))
      let picked: (typeof options)[number] | undefined
      try {
        const request = { sessionId: params.sessionId, toolCall, options }
        const result = await client.request<RequestPermissionResponse>(methods.client.session.requestPermission, request)
        picked = result.outcome.outcome === 'selected'
          ? options.find(option => result.outcome.outcome === 'selected' && option.optionId === result.outcome.optionId)
          : undefined
        log({ event: 'answer', outcome: result.outcome })
      } catch (error: unknown) {
        log({ event: 'answer', error: String(error) })
      }
      const yes = picked !== undefined && picked.kind !== 'reject_once'
      await update(client, {
        sessionUpdate: 'tool_call_update', toolCallId, status: yes ? 'completed' : 'failed',
        content: [{ type: 'content', content: { type: 'text', text: `→ ${picked?.name ?? 'No (no answer)'}` } }],
      })
    }
    if (step.mcp !== undefined) await callMcp(step.mcp, step.args ?? {})
    if (step.waitFile !== undefined) await until(step.waitFile)
    if (step.stderr !== undefined) process.stderr.write(`${step.stderr}\n`)
    if (step.fail !== undefined) throw new RequestError(-32603, step.fail)
    if (step.crash !== undefined) process.exit(step.crash)
    if (step.receipt !== undefined) outcome.receipt = step.receipt
    if (step.stop !== undefined) outcome.stop = step.stop
    if (step.hang === true) {
      ignoreCancel = step.ignoreCancel === true
      outcome.stop = await new Promise<StopReason>((resolve) => { cancel = resolve })
      outcome.receipt = 'cancelled'
    }
  }
}

/** Call one tool on the app's MCP server the way Casper's MCP client does. */
async function callMcp(name: string, args: Record<string, unknown>): Promise<void> {
  const server = mcpServers[0]
  if (server === undefined || !('type' in server) || server.type !== 'http') {
    log({ event: 'mcp', name, error: 'no http MCP server offered' })
    return
  }
  const headers = Object.fromEntries(server.headers.map(header => [header.name, header.value]))
  const client = new Client({ name: 'fake-casper', version: '0.0.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }) as Transport)
    const result = await client.callTool({ name, arguments: args, _meta: { 'casper/acpToolCallId': `casper-tool-${steps}` } })
    log({ event: 'mcp', name, result, server: client.getServerVersion() })
  } catch (error: unknown) {
    log({ event: 'mcp', name, error: String(error) })
  } finally {
    await client.close()
  }
}

createAcpAgent({ name: 'fake-casper' })
  .onRequest(methods.agent.initialize, async ({ params }) => {
    log({ method: 'initialize', params })
    if (script.holdInitialize !== undefined) await until(script.holdInitialize)
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
      },
      agentInfo: { name: 'casper', title: 'Casper', version: '0.0.0-test' },
      authMethods: [],
    }
  })
  .onRequest(methods.agent.session.new, ({ params }) => {
    log({ method: 'session/new', params, exposed: exposed(params.mcpServers) })
    mcpServers = params.mcpServers
    sessionId = script.newSessionId ?? randomUUID()
    return { sessionId }
  })
  .onRequest(methods.agent.session.load, async ({ params, client }) => {
    log({ method: 'session/load', params, exposed: exposed(params.mcpServers) })
    if (!savedConversations().includes(params.sessionId)) {
      throw new RequestError(-32002, script.loadError
        ?? `--resume: no saved conversation in this workspace starts with "${params.sessionId}". Run casper /resume to list them.`)
    }
    sessionId = params.sessionId
    mcpServers = params.mcpServers
    for (const text of script.replay ?? []) await update(client, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } })
    return {}
  })
  .onRequest(methods.agent.session.prompt, ({ params, client }) => {
    log({ method: 'session/prompt', params })
    return play(params, client).then((reply) => {
      log({ event: 'saved', sessionId: params.sessionId })
      return reply
    })
  })
  .onNotification(methods.agent.session.cancel, ({ params }) => {
    log({ method: 'session/cancel', params })
    if (!ignoreCancel) cancel?.('cancelled')
  })
  .connect(ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ))

process.stdin.on('end', () => {
  log({ event: 'eof' })
  if (script.ignoreEof === true) setInterval(() => { /* stay alive until killed */ }, 1000)
})
