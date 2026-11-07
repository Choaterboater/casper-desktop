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
 *   after stdin closes, until it is killed. `promptCapabilities` replaces the
 *   `initialize` reply's (default: text only, as an older Casper). `commands`
 *   is sent as an `available_commands_update` right after the `session/new`
 *   reply, and after the replayed chunks of a successful `session/load`
 *   (before its reply, so it arrives while the client drops the replay).
 *   `configOptions` is the option list of the `session/new` and `session/load`
 *   replies; `session/set_config_option` (logged like any request) sets a
 *   listed value and replies with the whole list, refuses an unlisted one with
 *   -32602, fails with -32603 and `setFails[configId]` when set, exits
 *   with code `setExit` when set, and answers only once the file
 *   `holdSet[configId]` exists when set.
 *   `replayConfig` also sends the list as a `config_option_update` among the
 *   replayed chunks of a successful `session/load`. `modes` is the mode state
 *   of the same replies; `session/set_mode` (logged) sets a listed mode, refuses
 *   another with -32602, and fails with -32603 and `setModeError` when set. A
 *   set of the `mode` option or of the mode changes both. `replayMode` changes
 *   the mode and sends a `current_mode_update` among the replayed chunks of a
 *   successful `session/load`.
 * - `FAKE_CASPER_LOG` — JSON lines appended for the start (argv, env names,
 *   PATH, cwd), every request and notification received, every permission
 *   answer, and stdin EOF. Tests poll this file.
 *
 * Steps: `{ text }`, `{ tool, target? }` (starts the next tool id, with an
 * older Casper's `rawInput: { tool, target }`), `{ toolEnd, ok }` (ends tool
 * N), `{ toolUpdate }` (an in-progress update of tool N, or of the open box
 * for `'box'`), `{ check, status }`, `{ plan }`, `{ permission, options,
 * preview?, diffs?, locations?, onStep?, during? }` (`during` steps play while
 * the box waits for its answer; as C9 sends a box a running step raises, the
 * pending step and the request carry the preview text followed by `diffs` as
 * diff content, the `locations`, and `_meta.casper.step: 'casper-tool-N'` for
 * `onStep: N`; a `{ withdraw: true }` step in `during` closes the box as a
 * switch to Read only does, before the reply, which is still logged with
 * `withdrawn: true`), `{ receipt }`, `{ stop }`,
 * `{ hang: true }` (waits for session/cancel), `{ ignoreCancel: true }` (with
 * hang: never replies), `{ crash }` (exits with that code),
 * `{ waitFile }` (waits until the file exists), `{ stderr }` (writes a
 * line to stderr), `{ fail }` (replies with a -32603 error), `{ image }` (a
 * picture in a message, which Casper does not send), `{ thought }` (an
 * `agent_thought_chunk` with that text, as Casper sends a reasoning headline
 * or a retry), `{ commandsUpdate }` (sends
 * that `available_commands_update` list), `{ configUpdate }` (replaces the
 * option list and sends it as a `config_option_update`), `{ mode }` (Casper
 * changes its own access mode, as "Yes to everything this session" does: a
 * `current_mode_update`, then a `config_option_update` when it has a `mode`
 * option), `{ late: Step }` (played 50 ms
 * after the reply), `{ exitAfterMs }` (exits with code 5 after that delay),
 * `{ mcp, args? }` (calls that tool on the first `mcpServers` entry with an
 * MCP 1.x client, carrying the current tool id as `casper/acpToolCallId`,
 * and logs `{ event: 'mcp', name, result, server }`, `server` being the answered serverInfo).
 * With `mcpHttp: true` the `initialize` reply sets `mcpCapabilities.http`, as
 * a Casper whose `acp_mcp` is not off does, so the app hands it its own
 * servers after the app tools server. `session/new` and `session/load` log
 * whether any header or env value of any entry (a header's `Bearer ` cut)
 * also reached this process's argv or environment.
 * A `tool`, `toolEnd`, or `toolUpdate` step also takes the fields a current
 * Casper sends: `rawInput` (the model's arguments, replacing the older
 * shape), `meta` (sent as `_meta.casper`), `locations`, `content` (plain
 * strings become text content), `rawOutput`, and `kind`.
 * `replay` lists
 * user chunks sent during a successful `session/load`.
 *
 * `{ planBox: markdown, during? }` raises Casper's plan Build box as C8 sends
 * it: a pending `casper-approval-N` step titled `Build this plan?` whose text
 * content is the review Markdown, `_meta.casper.plan: {approve: 'Build',
 * change: 'Change the plan'}` on the step and on the request, and the options
 * Stop (reject_once), Build (allow_once) and Change the plan (reject_once) with
 * their descriptions in `_meta.casper.description`. The answer is logged and
 * the step closes like any box: completed for Build, failed with the picked
 * name otherwise.
 *
 * `{ elicit: { question, options?, multi?, typed?, from?, hint?, onStep?,
 * timeoutMs?, schema? }, during? }` asks a question as Casper's AcpAsker does
 * when the client offered `clientCapabilities.elicitation.form`. With
 * `onStep: N` it is the ask tool's question on the running `casper-tool-N`:
 * after the reply that step completes with the ask tool's result
 * (`{answers, skipped, remaining}`). Otherwise Casper opens its own pending
 * `casper-question-N` step first (title `The AI asks: ` plus the question when
 * `from` is `ai`, `_meta.casper.question`) and closes it completed with
 * `→ a | b` or failed with `— skipped`. The form is `elicitation/create` with
 * `answer` (a `oneOf` single pick, an `items.anyOf` multi pick, or a typed line
 * titled `hint` when there are no options), `other` when `typed` and there are
 * options, and `_meta.casper.question: {from, multi, typed}`; `schema` replaces
 * the requested schema. Only `accept` counts: `answer` values map back to
 * labels by index, unknown ones are dropped, `other` counts only when typed, a
 * single pick prefers the typed words, a multi pick puts them last, and a
 * line's spaces collapse. `timeoutMs` withdraws the request with
 * `$/cancel_request` after that delay and treats it as skipped. Each reply is
 * logged as `{ event: 'elicitation', reply }` (or `error`, or `timedOut`).
 *
 * Steering as C10 sends it: with `steer: true` the `initialize` reply sets
 * `agentCapabilities._meta.casper.steer`, and `_casper/steer` (logged like any
 * request) answers `{steered, messageId}` with `steerReplies[n]` for the n-th
 * steer of this process (default true), after `steerReplyDelayMs`; the reply
 * is logged as `{ event: 'steer-reply', steered }`. A `{ steerRead: n }` step
 * waits until the n-th steer has arrived, then sends Casper's read notice: a
 * `user_message_chunk` with the steer's words, its `messageId`, and
 * `_meta.casper.steered: true`.
 *
 * Usage, notes and the receipt as C12 sends them: a `{ usage: { input?,
 * cacheRead?, cacheWrite?, output?, tokens?, toolUse?, size?, cost?,
 * costKind?, provider?, model? } }` step sends a `usage_update` whose `used` is
 * the prompt sum plus output (or `tokens` when input or output is missing),
 * `size` the window (default 200000), `cost` `{amount, currency: 'USD'}` when
 * set, and `_meta.casper` `{response: {input, cacheRead, cacheWrite, output,
 * tokens, toolUse}, model: {provider, model}, cost: costKind}`, missing counts
 * sent as null (provider and model default to `openai` and `gpt-5`). A
 * `{ note }` step sends an `agent_message_chunk` with the note as its own
 * paragraph and `_meta.casper.note: true`. A `{ fullReceipt: fields }` step
 * makes the last chunk and the reply carry a whole receipt (outcome, verdict,
 * exitCode, changed, checksRun, checksNotRun, text, json, usage, cost, and
 * root, which defaults to this process's folder), with `fields` replacing
 * those; the chunk's text is the receipt's text. Without it the receipt is
 * the bare `{outcome}` of an older script.
 *
 * The idle check as C17 sends it: `_casper/idle` (logged like any request)
 * answers `idle[n]` for the n-th check of this process, the last one repeating
 * (default `{idle: true, running: []}`), and logs `{ event: 'idle-reply',
 * idle }`; with `idle: null` it fails with -32601, as a Casper from before
 * decision 91 does. `holdIdle` names a file whose existence holds each reply.
 * `loadConfigOptions` replaces the option list in a successful `session/load`
 * reply and from then on, as Casper does when it puts back the conversation's
 * own model (decision 89).
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
  type AvailableCommand,
  type CreateElicitationResponse,
  type McpServer,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionUpdate,
  type StopReason,
  type ToolKind,
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
  diffs?: { path: string; oldText?: string | null; newText: string }[]
  onStep?: number
  withdraw?: boolean
  planBox?: string
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
  toolUpdate?: number | 'box'
  during?: Step[]
  rawInput?: Record<string, unknown>
  meta?: Record<string, unknown>
  locations?: { path: string; line?: number }[]
  content?: (string | Record<string, unknown>)[]
  rawOutput?: unknown
  kind?: ToolKind
  commandsUpdate?: AvailableCommand[]
  configUpdate?: SessionConfigOption[]
  mode?: string
  elicit?: Elicit
  steerRead?: number
  usage?: Usage
  note?: string
  fullReceipt?: Record<string, unknown>
}

/** A response's usage as C12's usageUpdate sends it; see the module comment. */
interface Usage {
  input?: number | null
  cacheRead?: number | null
  cacheWrite?: number | null
  output?: number | null
  tokens?: number | null
  toolUse?: boolean
  size?: number
  cost?: number
  costKind?: 'charged' | 'estimate' | 'subscription' | null
  provider?: string | null
  model?: string | null
}

/** The `usage_update` C12 sends after a main-runtime response. */
function usageUpdate(usage: Usage): SessionUpdate & Record<string, unknown> {
  const response = {
    input: usage.input ?? null, cacheRead: usage.cacheRead ?? null, cacheWrite: usage.cacheWrite ?? null, output: usage.output ?? null,
  }
  const used = response.input !== null && response.output !== null
    ? response.input + (response.cacheRead ?? 0) + (response.cacheWrite ?? 0) + response.output
    : usage.tokens ?? 0
  return {
    sessionUpdate: 'usage_update', used, size: usage.size ?? 200_000,
    ...usage.cost === undefined ? {} : { cost: { amount: usage.cost, currency: 'USD' } },
    _meta: { casper: {
      response: { ...response, tokens: usage.tokens ?? null, toolUse: usage.toolUse ?? false },
      model: { provider: usage.provider === undefined ? 'openai' : usage.provider, model: usage.model === undefined ? 'gpt-5' : usage.model },
      cost: usage.costKind ?? null,
    } },
  }
}

/** A question Casper asks as a form; see the module comment. */
interface Elicit {
  question: string
  options?: { label: string; description?: string }[]
  multi?: boolean
  typed?: boolean
  from?: 'ai' | 'casper'
  hint?: string
  onStep?: number
  timeoutMs?: number
  schema?: Record<string, unknown>
}

/** A step's ACP fields beyond the id, status, and title. */
function wire(step: Step): Record<string, unknown> {
  return {
    ...step.meta === undefined ? {} : { _meta: { casper: step.meta } },
    ...step.locations === undefined ? {} : { locations: step.locations },
    ...step.content === undefined
      ? {}
      : { content: step.content.map(item => typeof item === 'string' ? { type: 'content', content: { type: 'text', text: item } } : item) },
    ...step.rawOutput === undefined ? {} : { rawOutput: step.rawOutput },
  }
}

interface Script {
  prompts: Step[][]
  known?: string[]
  loadError?: string
  holdInitialize?: string
  ignoreEof?: boolean
  replay?: string[]
  newSessionId?: string
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean }
  commands?: AvailableCommand[]
  configOptions?: SessionConfigOption[]
  setFails?: Record<string, string>
  replayConfig?: boolean
  setExit?: number
  holdSet?: Record<string, string>
  modes?: SessionModeState
  setModeError?: string
  replayMode?: string
  steer?: boolean
  steerReplies?: boolean[]
  steerReplyDelayMs?: number
  mcpHttp?: boolean
  idle?: IdleReply[] | null
  holdIdle?: string
  loadConfigOptions?: SessionConfigOption[]
}

/** The `_casper/idle` reply C17 sends. */
interface IdleReply {
  idle: boolean
  running: string[]
  reason?: 'off' | 'busy'
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

/** Whether any offered header or env value also reached this process's argv or environment. */
function exposed(servers: McpServer[]): { argv: boolean; env: boolean } {
  const values = servers.flatMap(server => 'headers' in server
    ? server.headers.map(header => header.value.replace(/^Bearer /, ''))
    : 'env' in server ? server.env.map(variable => variable.value) : [])
  const found = (text: string | undefined): boolean => values.some(value => value !== '' && text?.includes(value) === true)
  return { argv: process.argv.some(found), env: Object.values(process.env).some(found) }
}

let sessionId: string | undefined
let mcpServers: McpServer[] = []
let steps = 0
let boxes = 0
let questions = 0
let cancel: ((reason: StopReason) => void) | undefined
let ignoreCancel = false
/** This process's options; a set changes them. */
let configOptions: SessionConfigOption[] | undefined = script.configOptions
/** This process's mode state; a set changes it. */
let modes: SessionModeState | undefined = script.modes
/** The steers this process received, in order: their words and message ids. */
const steered: { text: string; messageId: string }[] = []
/** The idle checks this process answered. */
let idleChecks = 0

/** Change the access mode in both the `mode` option and the mode state. */
function setModeTo(modeId: string): void {
  if (modes !== undefined) modes = { ...modes, currentModeId: modeId }
  configOptions = configOptions?.map(item => item.category === 'mode' && item.type === 'select' ? { ...item, currentValue: modeId } : item)
}

/** The fields of a `session/new` or `session/load` reply beyond the id. */
function opened(): Record<string, unknown> {
  return { ...configOptions === undefined ? {} : { configOptions }, ...modes === undefined ? {} : { modes } }
}

/** The listed values of one select option, groups flattened. */
function valuesOf(option: SessionConfigOption): string[] {
  if (option.type !== 'select') return []
  return option.options.flatMap(item => 'group' in item ? item.options : [item]).map(item => item.value)
}

async function update(client: AgentContext, item: SessionUpdate & Record<string, unknown>): Promise<void> {
  await client.notify(methods.client.session.update, { sessionId: sessionId ?? '', update: item })
}

interface Outcome {
  stop: StopReason
  receipt: string
  /** A whole receipt's fields, as C12 sends it. */
  full?: Record<string, unknown>
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
  const receipt: Record<string, unknown> = outcome.full === undefined
    ? { outcome: outcome.receipt }
    : {
      outcome: outcome.receipt, verdict: `Receipt: ${outcome.receipt}`, exitCode: 0, changed: [], checksRun: [], checksNotRun: [], text: text.trim(),
      json: { type: 'receipt', outcome: outcome.receipt }, usage: null, cost: null, root: process.cwd(), ...outcome.full,
    }
  const shown = outcome.full === undefined ? text : `\n\n${String(receipt.text)}\n`
  await update(client, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: shown }, _meta: { casper: { receipt } } })
  if (late !== undefined) {
    const after = late
    setTimeout(() => { void run(after, params, client, { stop: 'end_turn', receipt: 'late' }) }, 50)
  }
  return { stopReason: outcome.stop, _meta: { casper: { receipt } } }
}

async function run(step: Step, params: PromptRequest, client: AgentContext, outcome: Outcome): Promise<void> {
  {
    if (step.exitAfterMs !== undefined) setTimeout(() => process.exit(5), step.exitAfterMs)
    if (step.image === true) await update(client, { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'aGk=' } })
    if (step.thought !== undefined) await update(client, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: step.thought } })
    if (step.text !== undefined) await update(client, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: step.text } })
    if (step.note !== undefined) {
      await update(client, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n\n${step.note}\n` }, _meta: { casper: { note: true } } })
    }
    if (step.usage !== undefined) await update(client, usageUpdate(step.usage))
    if (step.fullReceipt !== undefined) outcome.full = step.fullReceipt
    if (step.commandsUpdate !== undefined) await update(client, { sessionUpdate: 'available_commands_update', availableCommands: step.commandsUpdate })
    if (step.configUpdate !== undefined) {
      configOptions = step.configUpdate
      await update(client, { sessionUpdate: 'config_option_update', configOptions: step.configUpdate })
    }
    if (step.mode !== undefined) {
      setModeTo(step.mode)
      await update(client, { sessionUpdate: 'current_mode_update', currentModeId: step.mode })
      if (configOptions?.some(item => item.category === 'mode') === true) await update(client, { sessionUpdate: 'config_option_update', configOptions })
    }
    if (step.tool !== undefined) {
      const id = `casper-tool-${++steps}`
      await update(client, {
        sessionUpdate: 'tool_call', toolCallId: id, title: step.target === undefined ? step.tool : `${step.tool} ${step.target}`,
        kind: step.kind ?? (step.tool === 'bash' ? 'execute' : 'other'), status: 'in_progress',
        rawInput: step.rawInput ?? { tool: step.tool, ...step.target === undefined ? {} : { target: step.target } },
        ...wire(step),
      })
    }
    if (step.toolUpdate !== undefined) {
      const toolCallId = step.toolUpdate === 'box' ? `casper-approval-${boxes}` : `casper-tool-${step.toolUpdate}`
      await update(client, { sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress', ...wire(step) })
    }
    if (step.toolEnd !== undefined) {
      await update(client, {
        sessionUpdate: 'tool_call_update', toolCallId: `casper-tool-${step.toolEnd}`, status: step.ok === false ? 'failed' : 'completed', ...wire(step),
      })
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
      const content = [
        ...step.preview === undefined ? [] : [{ type: 'content' as const, content: { type: 'text' as const, text: step.preview } }],
        ...(step.diffs ?? []).map(diff => ({ type: 'diff' as const, ...diff })),
      ]
      const toolCall = {
        toolCallId, title: step.permission, kind: 'other' as const, status: 'pending' as const,
        ...content.length === 0 ? {} : { content },
        ...step.locations === undefined ? {} : { locations: step.locations },
        ...step.onStep === undefined ? {} : { _meta: { casper: { step: `casper-tool-${String(step.onStep)}` } } },
      }
      await update(client, { sessionUpdate: 'tool_call', ...toolCall })
      const options = (step.options ?? ['No', 'Yes, this once', 'Yes for this session']).map((name, at) => ({
        optionId: String(at + 1), name, kind: optionKind(name),
      }))
      let picked: (typeof options)[number] | undefined
      let withdrawn = false
      try {
        const request = { sessionId: params.sessionId, toolCall, options }
        const asked = client.request<RequestPermissionResponse>(methods.client.session.requestPermission, request)
        for (const meanwhile of step.during ?? []) {
          if (meanwhile.withdraw !== true) {
            await run(meanwhile, params, client, outcome)
            continue
          }
          // AcpAsker.withdrawAll: Casper stops waiting without a $/cancel_request and closes the step as No.
          withdrawn = true
          await update(client, {
            sessionUpdate: 'tool_call_update', toolCallId, status: 'failed',
            content: [{ type: 'content', content: { type: 'text', text: READ_ONLY_NO } }],
          })
        }
        const result = await asked
        picked = result.outcome.outcome === 'selected' && !withdrawn
          ? options.find(option => result.outcome.outcome === 'selected' && option.optionId === result.outcome.optionId)
          : undefined
        log({ event: 'answer', outcome: result.outcome, ...withdrawn ? { withdrawn } : {} })
      } catch (error: unknown) {
        log({ event: 'answer', error: String(error) })
      }
      const yes = picked !== undefined && picked.kind !== 'reject_once'
      if (!withdrawn) {
        await update(client, {
          sessionUpdate: 'tool_call_update', toolCallId, status: yes ? 'completed' : 'failed',
          content: [{ type: 'content', content: { type: 'text', text: `→ ${picked?.name ?? 'No (no answer)'}` } }],
        })
      }
    }
    if (step.planBox !== undefined) await planBox(step.planBox, step.during ?? [], params, client, outcome)
    if (step.elicit !== undefined) await elicit(step.elicit, step.during ?? [], params, client, outcome)
    if (step.mcp !== undefined) await callMcp(step.mcp, step.args ?? {})
    if (step.steerRead !== undefined) await steerRead(step.steerRead, client)
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

/** The text of a box closed by a switch to Read only (src/acp/permission.ts READ_ONLY_NO). */
const READ_ONLY_NO = '→ No (access set to Read only)'

/** Casper's plan choices (safe-choices.ts PLAN_CHOICES) and the kinds C8 gives them. */
const PLAN_CHOICES = [
  { name: 'Stop', description: 'nothing is built', kind: 'reject_once' },
  { name: 'Build', description: 'the model builds these steps and tests these cases', kind: 'allow_once' },
  { name: 'Change the plan', description: 'tell the model what to change, then choose again', kind: 'reject_once' },
] as const

/** Raise the plan Build box as C8's AcpAsker does for a question with `review`. */
async function planBox(markdown: string, during: Step[], params: PromptRequest, client: AgentContext, outcome: Outcome): Promise<void> {
  const toolCallId = `casper-approval-${++boxes}`
  const toolCall = {
    toolCallId, title: 'Build this plan?', kind: 'other' as const, status: 'pending' as const,
    content: [{ type: 'content' as const, content: { type: 'text' as const, text: markdown } }],
    _meta: { casper: { plan: { approve: 'Build', change: 'Change the plan' } } },
  }
  await update(client, { sessionUpdate: 'tool_call', ...toolCall })
  const options = PLAN_CHOICES.map((choice, at) => ({
    optionId: String(at + 1), name: choice.name, kind: choice.kind, _meta: { casper: { description: choice.description } },
  }))
  let picked: (typeof options)[number] | undefined
  try {
    const request = { sessionId: params.sessionId, toolCall, options }
    const asked = client.request<RequestPermissionResponse>(methods.client.session.requestPermission, request)
    for (const meanwhile of during) await run(meanwhile, params, client, outcome)
    const result = await asked
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

/** The form Casper sends for one question (C7's questionSchema, without the hiding). */
function questionSchema(asked: Elicit): Record<string, unknown> {
  const options = asked.options ?? []
  const oneOf = options.map(({ label, description }, at) => ({
    const: String(at + 1), title: label, ...description === undefined ? {} : { description },
  }))
  const answer = options.length === 0
    ? { type: 'string', title: asked.hint ?? 'Your answer' }
    : asked.multi === true ? { type: 'array', items: { anyOf: oneOf } } : { type: 'string', title: 'Choose', oneOf }
  const other = asked.typed === true && options.length > 0 ? { other: { type: 'string', title: 'Or type your answer' } } : {}
  return { type: 'object', properties: { answer, ...other }, required: options.length === 0 ? ['answer'] : [] }
}

/** The answer Casper reads from a form reply (C7's formAnswer). */
function formAnswer(result: CreateElicitationResponse | undefined, asked: Elicit): string[] | undefined {
  if (result?.action !== 'accept' || !('content' in result)) return undefined
  const content = (result.content ?? {}) as Record<string, unknown>
  const options = asked.options ?? []
  const other = asked.typed === true && typeof content.other === 'string' && content.other.trim() !== '' ? content.other.trim() : undefined
  if (options.length === 0) {
    const line = typeof content.answer === 'string' ? content.answer.replace(/\s+/g, ' ').trim() : ''
    return line === '' ? undefined : [line]
  }
  const values = Array.isArray(content.answer) ? content.answer : content.answer === undefined ? [] : [content.answer]
  const picks = values.flatMap(value => typeof value === 'string' ? [options[Number(value) - 1]?.label].filter((label): label is string => label !== undefined) : [])
  const typed = other === undefined ? [] : [other]
  const answer = asked.multi === true ? [...picks, ...typed] : other === undefined ? picks.slice(0, 1) : typed
  return answer.length === 0 ? undefined : answer
}

/** Ask one question as a form, on the ask tool's step or on a question step of Casper's own. */
async function elicit(asked: Elicit, during: Step[], params: PromptRequest, client: AgentContext, outcome: Outcome): Promise<void> {
  const own = asked.onStep === undefined
  const toolCallId = own ? `casper-question-${++questions}` : `casper-tool-${asked.onStep}`
  const multi = asked.multi === true
  const typed = asked.typed === true || (asked.options ?? []).length === 0
  if (own) {
    await update(client, {
      sessionUpdate: 'tool_call', toolCallId, title: `${asked.from === 'ai' ? 'The AI asks: ' : ''}${asked.question}`, kind: 'other', status: 'pending',
      _meta: { casper: { question: { question: asked.question, options: asked.options ?? [], multi, typed } } },
    })
  }
  const withdraw = new AbortController()
  const timer = asked.timeoutMs === undefined ? undefined : setTimeout(() => { withdraw.abort() }, asked.timeoutMs)
  let result: CreateElicitationResponse | undefined
  try {
    const request = {
      sessionId: params.sessionId, toolCallId, mode: 'form', message: asked.question,
      requestedSchema: asked.schema ?? questionSchema(asked),
      _meta: { casper: { question: { from: asked.from ?? 'casper', multi, typed } } },
    }
    const sent = client.request<CreateElicitationResponse>(methods.client.elicitation.create, request, {
      cancellationSignal: withdraw.signal,
    })
    const withdrawn = new Promise<'withdrawn'>((resolve) => { withdraw.signal.addEventListener('abort', () => { resolve('withdrawn') }, { once: true }) })
    for (const meanwhile of during) await run(meanwhile, params, client, outcome)
    const settled = await Promise.race([sent, withdrawn])
    sent.catch(() => { /* a withdrawn request may still settle */ })
    if (settled === 'withdrawn') log({ event: 'elicitation', timedOut: true })
    else {
      result = settled
      log({ event: 'elicitation', reply: result })
    }
  } catch (error: unknown) {
    log({ event: 'elicitation', error: String(error) })
  } finally {
    clearTimeout(timer)
  }
  const answer = formAnswer(result, asked)
  if (own) {
    await update(client, {
      sessionUpdate: 'tool_call_update', toolCallId, status: answer === undefined ? 'failed' : 'completed',
      content: [{ type: 'content', content: { type: 'text', text: answer === undefined ? '— skipped' : `→ ${answer.join(' | ')}` } }],
    })
    return
  }
  const reply = JSON.stringify({ answers: answer ?? [], skipped: answer === undefined, remaining: 7 })
  await update(client, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: reply } }] })
}

/** Wait for the n-th steer, then send Casper's notice that the AI read it. */
async function steerRead(n: number, client: AgentContext): Promise<void> {
  while (steered.length < n) await new Promise((resolve) => { setTimeout(resolve, 10) })
  const entry = steered[n - 1]
  if (entry === undefined) return
  await update(client, {
    sessionUpdate: 'user_message_chunk', content: { type: 'text', text: entry.text }, messageId: entry.messageId, _meta: { casper: { steered: true } },
  })
}

/** The words of a steer's prompt, as Casper reads them. */
function steerText(prompt: unknown): string {
  const blocks = Array.isArray(prompt) ? prompt as { type?: unknown; text?: unknown }[] : []
  return blocks.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n').trim()
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
        promptCapabilities: script.promptCapabilities ?? { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: script.mcpHttp === true, sse: false },
        ...script.steer === true ? { _meta: { casper: { steer: true } } } : {},
      },
      agentInfo: { name: 'casper', title: 'Casper', version: '0.0.0-test' },
      authMethods: [],
    }
  })
  .onRequest(methods.agent.session.new, ({ params, client }) => {
    log({ method: 'session/new', params, exposed: exposed(params.mcpServers) })
    mcpServers = params.mcpServers
    sessionId = script.newSessionId ?? randomUUID()
    const availableCommands = script.commands
    // Like Casper, the list follows the reply.
    if (availableCommands !== undefined) setImmediate(() => { void update(client, { sessionUpdate: 'available_commands_update', availableCommands }) })
    return { sessionId, ...opened() }
  })
  .onRequest(methods.agent.session.load, async ({ params, client }) => {
    log({ method: 'session/load', params, exposed: exposed(params.mcpServers) })
    if (!savedConversations().includes(params.sessionId)) {
      throw new RequestError(-32002, script.loadError
        ?? `--resume: no saved conversation in this workspace starts with "${params.sessionId}". Run casper /resume to list them.`)
    }
    sessionId = params.sessionId
    mcpServers = params.mcpServers
    // Casper puts back the conversation's own model on a load.
    if (script.loadConfigOptions !== undefined) configOptions = script.loadConfigOptions
    for (const text of script.replay ?? []) await update(client, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } })
    if (script.commands !== undefined) await update(client, { sessionUpdate: 'available_commands_update', availableCommands: script.commands })
    if (script.replayConfig === true && configOptions !== undefined) await update(client, { sessionUpdate: 'config_option_update', configOptions })
    if (script.replayMode !== undefined) {
      setModeTo(script.replayMode)
      await update(client, { sessionUpdate: 'current_mode_update', currentModeId: script.replayMode })
    }
    return opened()
  })
  .onRequest(methods.agent.session.prompt, ({ params, client }) => {
    log({ method: 'session/prompt', params })
    return play(params, client).then((reply) => {
      log({ event: 'saved', sessionId: params.sessionId })
      return reply
    })
  })
  .onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
    log({ method: 'session/set_config_option', params })
    if (script.setExit !== undefined) process.exit(script.setExit)
    const hold = script.holdSet?.[params.configId]
    if (hold !== undefined) await until(hold)
    const failure = script.setFails?.[params.configId]
    if (failure !== undefined) throw new RequestError(-32603, failure)
    const option = configOptions?.find(item => item.id === params.configId)
    if (option === undefined || typeof params.value !== 'string' || !valuesOf(option).includes(params.value)) {
      throw new RequestError(-32602, `Casper can't use ${String(params.value)}: it is not one of your signed-in models. Pick one from the list.`)
    }
    const { value } = params
    if (option.category === 'mode') setModeTo(value)
    configOptions = (configOptions ?? []).map(item => item.id === params.configId && item.type === 'select' ? { ...item, currentValue: value } : item)
    return { configOptions }
  })
  .onRequest(methods.agent.session.setMode, ({ params }) => {
    log({ method: 'session/set_mode', params })
    if (script.setModeError !== undefined) throw new RequestError(-32603, script.setModeError)
    if (modes?.availableModes.some(mode => mode.id === params.modeId) !== true) {
      throw new RequestError(-32602, `Unknown mode: ${params.modeId} (read, ask, full)`)
    }
    setModeTo(params.modeId)
    return {}
  })
  .onRequest('_casper/steer', params => params as { sessionId: string; prompt: unknown; messageId: string }, async ({ params }) => {
    log({ method: '_casper/steer', params })
    steered.push({ text: steerText(params.prompt), messageId: params.messageId })
    const answer = script.steerReplies?.[steered.length - 1] ?? true
    if (script.steerReplyDelayMs !== undefined) await new Promise((resolve) => { setTimeout(resolve, script.steerReplyDelayMs) })
    log({ event: 'steer-reply', steered: answer })
    return { steered: answer, messageId: params.messageId }
  })
  .onRequest('_casper/idle', params => params as { sessionId: string }, async ({ params }) => {
    log({ method: '_casper/idle', params })
    // A Casper from before decision 91 has no such request.
    if (script.idle === null) throw RequestError.methodNotFound('_casper/idle')
    if (params.sessionId !== sessionId) throw new RequestError(-32002, 'Unknown session')
    if (script.holdIdle !== undefined) await until(script.holdIdle)
    const replies = script.idle ?? [{ idle: true, running: [] }]
    const reply = replies[Math.min(idleChecks++, replies.length - 1)] ?? { idle: true, running: [] }
    log({ event: 'idle-reply', idle: reply })
    return reply
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
