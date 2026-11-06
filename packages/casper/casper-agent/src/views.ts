/**
 * Casper's tool calls in the shape of the Standard mode's tools: the tool
 * name, the arguments, and the `tool/result` text and `meta` the app's
 * built-in tool cards read. Pure functions over the ACP wire values.
 * @module @deepseek-ai/dsh-casper-agent/views
 */

import { isAbsolute } from 'node:path'
import type { ToolCall, ToolCallContent, ToolCallLocation, ToolCallUpdate } from '@agentclientprotocol/sdk'
import type { ToolResult } from '@deepseek-ai/dsh-tools'
import { readLangHintForPath } from '@deepseek-ai/dsh-util-code-language'
import { APP_SERVER_NAME, dshNameOf } from './app-tools.ts'
import { toolCallText } from './permission.ts'

/** Name an MCP call to a server other than the app's is recorded under. */
export const CASPER_MCP = 'casper_mcp'

/** Result text of a failed step that sent no words of its own. */
export const STEP_FAILED = 'Casper reported that this step failed.'

/** The old side recorded when Casper hid both sides of an edit behind one placeholder, so it still reads as a change. */
export const HIDDEN_OLD_TEXT = '<not shown: the text it replaced>'

/** Casper's placeholder for file text it does not send, such as text that holds or adds a secret. */
const NOT_SHOWN = /^<not shown: [^>]*>$/

/** Casper's name for the app's own MCP server: Casper prefixes the name the app offers with `acp-`. */
const APP_SERVER = `acp-${APP_SERVER_NAME}`

/** A JSON value, as `tool/result` `meta` holds. */
export type Json = Exclude<ToolResult['meta'], undefined>

/** How one Casper tool call is recorded in the Session. */
export interface StandardView {
  /** `standard` for a call shown as a Standard tool, `mcp` for an MCP call, `casper` for any other. */
  readonly kind: 'standard' | 'mcp' | 'casper'
  /** Casper's own tool name, which picks the result mapping. */
  readonly tool: string
  /** Name recorded on `tool/call`: a Standard tool name or `casper_<tool>`. */
  readonly name: string
  /** JSON arguments recorded on `tool/call`. */
  readonly arguments: string
  /** The call's title, kept for results that carry no text. */
  readonly title: string
  /** The file path the model gave a file tool, as it gave it. */
  readonly path: string | undefined
  /** Absolute paths Casper reported for the call. */
  readonly locations: readonly string[]
}

/** The `tool/result` a final update is recorded as. */
export interface StandardResult {
  /** The result's text. */
  readonly text: string
  /** Whether the result is an error. */
  readonly isError: boolean
  /** The `meta` a Standard tool card reads, when there is one. */
  readonly meta?: Json
}

type Fields = Readonly<Record<string, unknown>>

function record(value: unknown): Fields | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Fields : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined
}

function lineCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function firstLine(value: string): string {
  const end = value.indexOf('\n')
  return end < 0 ? value : value.slice(0, end)
}

/** The field an older Casper's `target` holds for each tool: the pattern, the path, or the command. */
const LEGACY_TARGET: Readonly<Record<string, string>> = {
  bash: 'command', powershell: 'command',
  read: 'path', edit: 'path', write: 'path', ls: 'path',
  grep: 'pattern', find: 'pattern',
}

/**
 * Whether a grep `glob` is a single include pattern the Standard search card
 * takes: not blank, not negated, and not a top-level comma list.
 * @param include - the pattern.
 * @returns whether the card accepts it.
 */
export function validInclude(include: string): boolean {
  if (include.trim() === '' || include.startsWith('!')) return false
  let depth = 0
  for (const character of include) {
    if (character === '{') depth += 1
    else if (character === '}') depth = Math.max(0, depth - 1)
    else if (character === ',' && depth === 0) return false
  }
  return true
}

/**
 * Every replacement of a Casper `edit`, in each form pi's edit takes: an
 * `edits` array, its JSON text, one `edits` object, and the older top-level
 * `oldText`/`newText` pair.
 */
function editPairs(input: Fields): { oldText: string; newText: string }[] {
  let edits: unknown = input.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits)
    } catch {
      edits = undefined
    }
  }
  const listed: unknown[] = Array.isArray(edits) ? edits : record(edits) === undefined ? [] : [edits]
  return [...listed, input].flatMap((entry: unknown) => {
    const edit = record(entry)
    return typeof edit?.oldText === 'string' && typeof edit.newText === 'string' ? [{ oldText: edit.oldText, newText: edit.newText }] : []
  })
}

/** Standard arguments for a Casper `edit`: the first replacement as `old_string`/`new_string`, every one in `edits`. */
function editArgs(input: Fields): Fields {
  const edits = editPairs(input)
  const [first] = edits
  // Casper sends one placeholder for both sides of an edit it hides; the old side then says what it stands for.
  const hidden = first !== undefined && first.oldText === first.newText && NOT_SHOWN.test(first.oldText)
  return {
    ...pathArg(input),
    ...first === undefined ? {} : { old_string: hidden ? HIDDEN_OLD_TEXT : first.oldText, new_string: first.newText },
    ...edits.length > 1 ? { edits } : {},
  }
}

function pathArg(input: Fields): Fields {
  const path = text(input.path)
  return path === undefined ? {} : { file_path: path }
}

function shellArgs(input: Fields, description: string | undefined, title: string): Fields {
  const command = text(input.command)
  const seconds = typeof input.timeout === 'number' && input.timeout > 0 ? input.timeout : undefined
  return {
    ...command === undefined ? {} : { command },
    description: description ?? (command === undefined ? title : firstLine(command)),
    ...seconds === undefined ? {} : { timeoutMs: seconds * 1000 },
  }
}

function readArgs(input: Fields): Fields {
  const offset = positiveInteger(input.offset)
  const limit = positiveInteger(input.limit)
  return { ...pathArg(input), ...offset === undefined ? {} : { offset }, ...limit === undefined ? {} : { limit } }
}

function searchArgs(input: Fields, pattern: string | undefined, include: boolean): Fields {
  const path = text(input.path)
  const glob = include && typeof input.glob === 'string' && validInclude(input.glob) ? input.glob : undefined
  return {
    ...pattern === undefined ? {} : { pattern },
    ...path === undefined ? {} : { path },
    ...glob === undefined ? {} : { include: glob },
  }
}

/** The Standard tool name and arguments of each mapped Casper tool. */
function mapped(tool: string, input: Fields, casper: Fields | undefined, title: string): { name: string; args: Fields } | undefined {
  switch (tool) {
    case 'edit':
      return { name: 'edit', args: editArgs(input) }
    case 'write':
      return { name: 'write', args: { ...pathArg(input), ...typeof input.content === 'string' ? { content: input.content } : {} } }
    case 'bash':
      return { name: 'bash', args: shellArgs(input, text(casper?.description), title) }
    case 'powershell':
      return { name: 'pwsh', args: shellArgs(input, text(casper?.description), title) }
    case 'read':
      return { name: 'read', args: readArgs(input) }
    case 'grep':
      return { name: 'grep', args: searchArgs(input, typeof input.pattern === 'string' ? input.pattern : undefined, true) }
    case 'find':
      return { name: 'glob', args: searchArgs(input, text(input.pattern), false) }
    case 'ls':
      return { name: 'glob', args: searchArgs(input, '*', false) }
    case 'web_search':
      return { name: 'web_search', args: text(input.query) === undefined ? {} : { queries: [input.query] } }
    case 'web_fetch':
      return { name: 'web_fetch', args: text(input.url) === undefined ? {} : { url: input.url } }
    default:
      return undefined
  }
}

/** The name an MCP call is recorded under: the app tool it bridges to, or {@link CASPER_MCP}. */
function mcpName(mcp: Fields): string {
  if (mcp.server !== APP_SERVER || typeof mcp.tool !== 'string') return CASPER_MCP
  return dshNameOf(mcp.tool) ?? CASPER_MCP
}

/** JSON arguments of an unmapped Casper call: its title, raw input, and preview text. */
function casperArguments(title: string, input: Fields, content: ToolCall['content']): string {
  const preview = toolCallText(content)
  return JSON.stringify({ title, ...input, ...preview === undefined ? {} : { preview } })
}

/**
 * Map one in-progress Casper tool call to the Standard tool it shows as.
 * The tool comes from `_meta.casper.tool`; an older Casper that sends no
 * `_meta` names it in `rawInput.tool` with the call's main argument in
 * `rawInput.target`, and the kind is the last resort.
 * @param call - the ACP `tool_call`.
 * @returns the recorded name, arguments, and what the result mapping needs.
 */
export function standardCall(call: ToolCall): StandardView {
  const casper = record(call._meta?.casper)
  const raw = record(call.rawInput) ?? {}
  const tool = text(casper?.tool) ?? text(raw.tool) ?? call.kind ?? 'tool'
  const legacyField = LEGACY_TARGET[tool]
  const input: Fields = casper === undefined
    ? legacyField === undefined || text(raw.target) === undefined ? {} : { [legacyField]: raw.target }
    : raw
  const locations = (call.locations ?? []).map((location: ToolCallLocation) => location.path).filter(path => isAbsolute(path))
  const base = { tool, title: call.title, path: text(input.path), locations }
  const mcp = record(casper?.mcp)
  if (mcp !== undefined) {
    const name = mcpName(mcp)
    if (name === CASPER_MCP) return { ...base, kind: 'mcp', name, arguments: casperArguments(call.title, input, call.content) }
    // `call_capability` carries the app tool's own arguments inside its own.
    const args = tool === 'call_capability' ? record(input.arguments) ?? {} : input
    return { ...base, kind: 'mcp', name, arguments: JSON.stringify(args) }
  }
  const standard = mapped(tool, input, casper, call.title)
  if (standard !== undefined) return { ...base, kind: 'standard', name: standard.name, arguments: JSON.stringify(standard.args) }
  // A Casper tool already named `casper_<x>`, such as `casper_check`, keeps its name.
  const safe = tool.toLowerCase().replaceAll(/[^a-z0-9_]/g, '_')
  const name = safe.startsWith('casper_') ? safe : `casper_${safe}`
  return { ...base, kind: 'casper', name, arguments: casperArguments(call.title, casper === undefined ? raw : input, call.content) }
}

/**
 * Strip one Markdown code fence around the whole text.
 * @param value - the text, fenced or not.
 * @returns the fenced body, or the text itself when it is not one fenced block.
 */
export function unfence(value: string): string {
  const fenced = /^(`{3,}|~{3,})[^\n]*\n(?:([\s\S]*)\n)?\1[ \t]*\n?$/.exec(value)
  return fenced === null ? value : fenced[2] ?? ''
}

/**
 * Shell output with the exit-code marker the Standard terminal card reads.
 * @param output - the command's output.
 * @param exitCode - the exit code; null for an explicitly missing one.
 * @returns the output, ending in `[exit code: N]` unless the code is 0.
 */
export function exitText(output: string, exitCode: number | null): string {
  return exitCode === 0 ? output : `${output}\n[exit code: ${String(exitCode)}]`
}

/** The read window the Standard read card takes from `meta`. */
export interface ReadEnvelope {
  /** The read tool's model-facing envelope around the numbered lines. */
  readonly text: string
  /** The `meta` the read card reads. */
  readonly meta: { path: string; offset: number; lines: { number: number; text: string }[]; totalLines: number; lang?: string }
}

/** The facts {@link readEnvelope} builds a window from. */
export interface ReadWindowFacts {
  /** The path as the model gave it, shown in the envelope. */
  readonly displayPath: string
  /** The path recorded in `meta`: absolute when Casper reported one. */
  readonly path: string
  /** 1-based first line. */
  readonly offset: number
  /** The text read, one file line per line. */
  readonly body: string
  /** Lines of `body` that are file lines; later lines (Casper's notes) are dropped. All of them when undefined. */
  readonly lines: number | undefined
  /** Lines in the whole file; the window reaches the end of the file when undefined. */
  readonly totalLines: number | undefined
}

/**
 * Build the Standard read tool's envelope and `meta` for one window.
 * @param facts - the path, window, and text.
 * @returns the envelope, or undefined when the lines do not fit the file's line count.
 */
export function readEnvelope(facts: ReadWindowFacts): ReadEnvelope | undefined {
  const split = facts.body === '' ? [] : facts.body.replace(/\n$/, '').split('\n')
  if (facts.lines !== undefined && facts.lines > split.length) return undefined
  const shown = facts.lines === undefined ? split : split.slice(0, facts.lines)
  const end = facts.offset - 1 + shown.length
  const totalLines = facts.totalLines ?? end
  if (end > totalLines) return undefined
  const lines = shown.map((line, index) => ({ number: facts.offset + index, text: line }))
  const footer = end < totalLines
    ? `(Showing lines ${facts.offset}-${end} of ${totalLines}. Use offset=${end + 1} to continue.)`
    : `(End of file - total ${totalLines} lines)`
  const body = lines.length > 0 ? `${lines.map(line => `${line.number}: ${line.text}`).join('\n')}\n\n${footer}` : footer
  const lang = readLangHintForPath(facts.path)
  return {
    text: `<path>${facts.displayPath}</path>\n<type>file</type>\n<content>\n${body}\n</content>`,
    meta: { path: facts.path, offset: facts.offset, lines, totalLines, ...lang === undefined ? {} : { lang } },
  }
}

type Diff = Extract<ToolCallContent, { type: 'diff' }>

function words(content: ToolCallUpdate['content']): string | undefined {
  const parts = (content ?? []).flatMap(item => item.type === 'content' && item.content.type === 'text' ? [item.content.text] : [])
  const joined = parts.join('\n')
  return joined === '' ? undefined : joined
}

function diffsOf(content: ToolCallUpdate['content']): Diff[] {
  return (content ?? []).filter((item): item is Diff => item.type === 'diff')
}

/** The absolute path of the changed or read file: a location, then `rawOutput.path`, then a diff's path. */
function absolutePath(view: StandardView, update: ToolCallUpdate, output: Fields | undefined, diffs: readonly Diff[]): string | undefined {
  const candidates = [
    ...(update.locations ?? []).map(location => location.path),
    ...view.locations,
    output?.path,
    ...diffs.map(diff => diff.path),
  ]
  return candidates.find((path): path is string => typeof path === 'string' && isAbsolute(path))
}

function changeSummary(verb: string, path: string, output: Fields | undefined): string {
  const added = output?.added
  const removed = output?.removed
  return typeof added === 'number' && typeof removed === 'number' ? `${verb} ${path} (+${added} −${removed})` : `${verb} ${path}`
}

/** One diff as the Standard card's hunk; no old text is an insertion or a new file. */
function hunk(diff: Diff): { path: string; oldText: string | null; newText: string } {
  return { path: diff.path, oldText: diff.oldText ?? null, newText: diff.newText }
}

function fileResult(view: StandardView, update: ToolCallUpdate, output: Fields | undefined): StandardResult {
  const diffs = diffsOf(update.content)
  const path = absolutePath(view, update, output, diffs)
  const shown = view.path ?? path ?? view.title
  const pathMeta = path === undefined ? {} : { path }
  const hunks = diffs.map(hunk)
  if (view.tool === 'edit') {
    return {
      text: words(update.content) ?? changeSummary('Edited', shown, output),
      isError: false,
      meta: { ...pathMeta, ...hunks.length > 0 ? { diffs: hunks } : {} },
    }
  }
  // A write sends one diff of the whole file; a new file's diff has no old text.
  const [whole] = hunks
  const created = output?.created === true || whole?.oldText === null
  return {
    text: words(update.content) ?? changeSummary(created ? 'Created' : 'Updated', shown, output),
    isError: false,
    meta: { operation: created ? 'create' : 'update', ...pathMeta, ...whole === undefined ? {} : { diffs: created ? [] : [whole] } },
  }
}

function shellResult(update: ToolCallUpdate, output: Fields | undefined): StandardResult {
  const shown = unfence(words(update.content) ?? '')
  const exitCode = output?.exitCode
  if (typeof exitCode === 'number') return { text: exitText(shown, exitCode), isError: false }
  if (update.status === 'failed') return { text: shown === '' ? STEP_FAILED : shown, isError: true }
  return { text: exitCode === null ? exitText(shown, null) : shown, isError: false }
}

function readResult(view: StandardView, update: ToolCallUpdate, output: Fields | undefined): StandardResult {
  const body = unfence(words(update.content) ?? '')
  const displayPath = view.path ?? text(output?.path)
  // Casper marks a window that stops before the end of the file truncated, and still counts its lines exactly.
  const counted = lineCount(output?.lines) !== undefined && lineCount(output?.totalLines) !== undefined
  const whole = output !== undefined && (output.truncated !== true || counted) && output.image === undefined
  const envelope = whole && displayPath !== undefined
    ? readEnvelope({
      displayPath,
      path: absolutePath(view, update, output, []) ?? displayPath,
      offset: positiveInteger(output.offset) ?? 1,
      body,
      lines: lineCount(output.lines),
      totalLines: lineCount(output.totalLines),
    })
    : undefined
  return envelope === undefined ? { text: body, isError: false } : { text: envelope.text, isError: false, meta: envelope.meta }
}

/**
 * A value read from the ACP wire, typed as JSON.
 * @param value - a parsed wire value.
 * @returns the value, or undefined when it holds anything JSON cannot, such as an undefined field.
 */
export function wireJson(value: unknown): Json | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    const items: Json[] = []
    for (const item of value) {
      const json = wireJson(item)
      if (json === undefined) return undefined
      items.push(json)
    }
    return items
  }
  const fields = record(value)
  if (fields === undefined) return undefined
  const out: Record<string, Json> = {}
  for (const [key, item] of Object.entries(fields)) {
    const json = wireJson(item)
    if (json === undefined) return undefined
    out[key] = json
  }
  return out
}

/** `meta` of a search or web result: the `rawOutput` fields the Standard card reads; the card validates their shape. */
function shapeMeta(tool: string, output: Fields | undefined): Json | undefined {
  if (output === undefined) return undefined
  const { truncated, total } = output
  switch (tool) {
    case 'grep':
      return output.shape === 'matches' ? wireJson({ shape: 'matches', files: output.files, total, truncated }) : undefined
    case 'find':
    case 'ls':
      return output.shape === 'paths' ? wireJson({ shape: 'paths', paths: output.paths, total, truncated }) : undefined
    case 'web_search':
      return wireJson({ sources: output.sources, truncated, ...output.answer === undefined ? {} : { answer: output.answer } })
    default:
      return wireJson({ url: output.url, statusCode: output.statusCode, truncated })
  }
}

/**
 * Map a final `tool_call_update` to the result the Standard card reads.
 * A failed step is an error result with Casper's words, except a shell step
 * with an exit code, which Standard records as a completed command.
 * @param view - how the call was recorded.
 * @param update - the completed or failed update.
 * @returns the result's text, error flag, and `meta`.
 */
export function standardResult(view: StandardView, update: ToolCallUpdate): StandardResult {
  const output = record(update.rawOutput)
  if (view.kind === 'standard' && (view.tool === 'bash' || view.tool === 'powershell')) return shellResult(update, output)
  if (update.status === 'failed') return { text: words(update.content) ?? STEP_FAILED, isError: true }
  if (view.kind !== 'standard') {
    return { text: words(update.content) ?? (update.rawOutput === undefined || update.rawOutput === null ? '' : JSON.stringify(update.rawOutput)), isError: false }
  }
  switch (view.tool) {
    case 'edit':
    case 'write':
      return fileResult(view, update, output)
    case 'read':
      return readResult(view, update, output)
    default: {
      // grep, find, ls, web_search, and web_fetch.
      const meta = shapeMeta(view.tool, output)
      return { text: unfence(words(update.content) ?? ''), isError: false, ...meta === undefined ? {} : { meta } }
    }
  }
}
