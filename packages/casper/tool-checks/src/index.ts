/**
 * Casper checks: record a command before editing, replay it after, and never report a check that
 * did not run as passed. Model-facing `check_record`, `check_replay` and `check_list` tools keep
 * per-agent check state. A mutation tool result in a working directory marks every check whose
 * directory overlaps it stale, whichever agent made the edit, and an edit that lands while a check
 * runs leaves that run stale. The `agent/turn-stopping` checkpoint replays stale checks before the
 * turn may end and steers the agent: into a bounded repair round when a check fails, and once per
 * turn to correct its report when a check could not run or is still failing.
 * @module @deepseek-ai/dsh-casper-checks
 */

import type {} from '@deepseek-ai/dsh-working-directory'
import { sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, MessageSource } from '@deepseek-ai/dsh-llm'
import type { CollectedOutput, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'casper-checks': { kind: 'casper-checks' } & ContextFormed
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'casper-checks'
export const inject = ['tools', 'shell', 'systemPrompt', 'workingDirectory']

/** Outcome of one check run. `not_run` is never a pass. */
export type CheckStatus = 'passed' | 'failed' | 'not_run'

/** Why a check produced no verdict. */
export type NotRunReason = 'timed_out' | 'signal' | 'could_not_start' | 'aborted'

/** One run of one check. */
export interface CheckRun {
  status: CheckStatus
  exitCode: number | null
  reason: NotRunReason | null
  /** Tails of stdout and stderr, each marked when bytes were dropped. */
  output: string
}

/** Deployment configuration. */
export interface Config {
  /** Tool names whose results invalidate recorded checks. */
  mutatingTools: string[]
  /** Replay stale checks at the turn-stopping checkpoint. */
  replayOnStop: boolean
  /** Repair rounds the checkpoint may force in one turn before it stops steering repairs. */
  maxRepairRounds: number
  /** Characters of command output retained per run, shared between stdout and stderr. */
  outputChars: number
  /** Recorded checks one agent may hold. */
  maxChecks: number
}

export const Config: z<Config> = z.object({
  mutatingTools: z.array(z.string()).default(['write', 'edit', 'apply_patch', 'str_replace_editor', 'bash', 'pwsh']),
  replayOnStop: z.boolean().default(true),
  maxRepairRounds: z.natural().default(3),
  outputChars: z.natural().min(200).default(2000),
  maxChecks: z.natural().min(1).default(32),
})

const SOURCE: MessageSource = { kind: 'casper-checks' }
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u
const TRUNCATED = '[… earlier output truncated]\n'

const RUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    command: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['passed', 'failed', 'not_run'] },
    exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
    reason: { oneOf: [{ type: 'string', enum: ['timed_out', 'signal', 'could_not_start', 'aborted'] }, { type: 'null' }], required: true },
    stale: { type: 'boolean', required: true },
    output: { type: 'string', required: true },
  },
} as const

/** Canonical per-check result projected onto the tool outputs. */
export interface CheckView {
  name: string
  command: string
  status: CheckStatus
  exitCode: number | null
  reason: NotRunReason | null
  stale: boolean
  output: string
}

/** A recorded check. `verdictEpoch` is the mutation epoch when its last verdict-producing run started. */
interface CheckEntry {
  name: string
  command: string
  workdir: string
  timeoutMs: number | null
  last: CheckRun
  verdictEpoch: number
}

/** Per-agent stop checkpoint state; reset whenever the turn number changes. */
interface StopState {
  turn: number
  rounds: number
  notRunNotified: boolean
  exhaustedNotified: boolean
  /** Related-mutation epoch at which each check was last replayed by this checkpoint. */
  replayedAt: Map<string, number>
}

/**
 * One line per check, verdict first; a stale verdict says so instead of claiming the current code.
 * @param entry - the check to describe.
 * @returns the summary line.
 */
export function describeCheck(entry: Pick<CheckView, 'name' | 'command' | 'status' | 'exitCode' | 'reason' | 'stale'>): string {
  const { status, exitCode, reason } = entry
  const verdict = status === 'passed' ? '✓ passed' : status === 'failed' ? `✗ failed (exit ${String(exitCode)})` : `– not run (${String(reason)})`
  return `${verdict}${entry.stale ? ' · stale: code changed since this verdict' : ''} · ${entry.name}: ${entry.command}`
}

function tail(stream: CollectedOutput, chars: number): string {
  const cut = stream.text.length > chars
  const text = cut ? stream.text.slice(stream.text.length - chars) : stream.text
  return (cut || stream.truncated) && text.length > 0 ? TRUNCATED + text : text
}

/**
 * Classify a finished shell run. Only a real exit code yields a verdict.
 * @param result - the executor's run result.
 * @param outputChars - output budget shared by the two streams.
 * @returns the run classification.
 */
export function classifyRun(result: ShellRunResult, outputChars: number): CheckRun {
  const streams = [result.stdout, result.stderr].filter(stream => stream.text.length > 0)
  const output = streams.map(stream => tail(stream, Math.floor(outputChars / streams.length))).join('\n')
  if (result.timedOut) return { status: 'not_run', exitCode: null, reason: 'timed_out', output }
  if (result.aborted) return { status: 'not_run', exitCode: null, reason: 'aborted', output }
  if (result.exitCode === null) return { status: 'not_run', exitCode: null, reason: result.signal === null ? 'could_not_start' : 'signal', output }
  return { status: result.exitCode === 0 ? 'passed' : 'failed', exitCode: result.exitCode, reason: null, output }
}

/** Whether two absolute directories share files (equal, or one contains the other). */
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep) || b.startsWith(a.endsWith(sep) ? a : a + sep)
}

function toolAborted(): HarnessError {
  const error = new HarnessError('tool call aborted', TOOL_ABORTED)
  error.name = 'AbortError'
  return error
}

/**
 * Register the checks tools and the turn-stopping replay.
 * @param ctx - registrant context.
 * @param config - deployment policy.
 */
export function apply(ctx: Context, config: Config): void {
  const mutating = new Set(config.mutatingTools)
  const byAgent = new Map<string, Map<string, CheckEntry>>()
  const stopStates = new Map<string, StopState>()
  /** Monotonic count of mutation tool results, and the epoch of the latest one per directory. */
  let epoch = 0
  const lastMutation = new Map<string, number>()

  const relatedMutation = (workdir: string): number => {
    let latest = 0
    for (const [directory, at] of lastMutation) if (at > latest && overlaps(directory, workdir)) latest = at
    return latest
  }
  const isStale = (entry: CheckEntry): boolean => relatedMutation(entry.workdir) > entry.verdictEpoch
  const view = (entry: CheckEntry): CheckView => ({ name: entry.name, command: entry.command, ...entry.last, stale: isStale(entry) })

  const checksOf = (agent: Agent): Map<string, CheckEntry> => {
    let checks = byAgent.get(agent.id)
    if (checks === undefined) {
      checks = new Map()
      byAgent.set(agent.id, checks)
    }
    return checks
  }

  const run = async (command: string, workdir: string, timeoutMs: number | null, signal: AbortSignal): Promise<CheckRun> => {
    try {
      const spec = ctx.shell.resolve({ command, workdir, ...timeoutMs === null ? {} : { timeoutMs }, signal })
      const execution = await ctx.shell.execute(spec)
      return classifyRun(await execution.result(), config.outputChars)
    } catch (error) {
      if (signal.aborted) return { status: 'not_run', exitCode: null, reason: 'aborted', output: '' }
      return { status: 'not_run', exitCode: null, reason: 'could_not_start', output: String(error) }
    }
  }

  /**
   * Run one check and commit its outcome. A cancelled run commits nothing and returns false. A run
   * without a verdict replaces the shown outcome but keeps the earlier verdict's epoch, so staleness
   * survives it. A verdict takes the epoch from before the run, so an edit during the run stays visible.
   */
  const replay = async (entry: CheckEntry, signal: AbortSignal): Promise<boolean> => {
    const startEpoch = epoch
    const outcome = await run(entry.command, entry.workdir, entry.timeoutMs, signal)
    if (outcome.reason === 'aborted' || signal.aborted) return false
    entry.last = outcome
    if (outcome.status !== 'not_run') entry.verdictEpoch = startEpoch
    return true
  }

  ctx.systemPrompt.section({
    name: 'tool:casper-checks',
    order: ctx.systemPrompt.getSectionOrder('TOOL_BASH') + 1,
    interpolate: false,
    text: 'Before editing, record the project\'s own checks (tests, lint, build) with check_record. After '
      + 'editing, replay them with check_replay; stale checks are replayed again before your turn ends. '
      + 'Report a check as passed only when its latest non-stale run passed. A check that is not run, '
      + 'stale, or never recorded has no verdict: say so instead of claiming success.',
  })

  ctx.on('tools/result', (exec) => {
    if (exec.agent === undefined || !mutating.has(exec.name)) return
    epoch += 1
    let directory: string | undefined
    try {
      directory = ctx.workingDirectory.get(exec.agent.session)
    } catch {
      directory = undefined
    }
    if (directory !== undefined) {
      lastMutation.set(directory, epoch)
      return
    }
    // Unknown directory: invalidate every recorded directory rather than risk a stale pass.
    for (const checks of byAgent.values()) for (const entry of checks.values()) lastMutation.set(entry.workdir, epoch)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    byAgent.delete(agent.id)
    stopStates.delete(agent.id)
  })

  ctx.tools.register(defineTool({
    name: 'check_record',
    description: 'Record a project check (a shell command whose exit code 0 means pass), run it now as the '
      + 'baseline, and keep it for replay. Recording a name again replaces it.',
    parameters: {
      name: { type: 'string', required: true, description: 'Short id, e.g. test, lint, build.' },
      command: { type: 'string', required: true, description: 'Shell command run in the working directory.' },
      timeoutMs: { type: 'integer', description: 'Optional deadline; a timeout is reported as not run.' },
    },
    output: { schema: RUN_SCHEMA, render: (_args, value) => [{ type: 'text', text: `recorded: ${describeCheck(value)}` }] },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('check_record requires an owning agent session')
      if (!NAME_PATTERN.test(args.name)) throw new Error('invalid check name: use letters, digits, ".", "_" or "-" (max 64)')
      if (args.command.trim().length === 0) throw new Error('invalid check: `command` must be non-empty')
      if (args.timeoutMs !== undefined && args.timeoutMs <= 0) throw new Error('invalid check: `timeoutMs` must be positive')
      const checks = checksOf(exec.agent)
      if (!checks.has(args.name) && checks.size >= config.maxChecks) {
        throw new Error(`too many checks: at most ${String(config.maxChecks)} per agent; record over an existing name instead`)
      }
      if (exec.signal.aborted) throw toolAborted()
      const workdir = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const entry: CheckEntry = {
        name: args.name,
        command: args.command,
        workdir,
        timeoutMs: args.timeoutMs ?? null,
        last: { status: 'not_run', exitCode: null, reason: 'could_not_start', output: '' },
        verdictEpoch: epoch,
      }
      if (!await replay(entry, exec.signal)) throw toolAborted()
      checks.set(entry.name, entry)
      return view(entry)
    },
    presentCall: args => ({ card: 'terminal', title: args.command, description: `Record check ${args.name}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'check_replay',
    description: 'Replay recorded checks against the current code. Omit `name` to replay every check.',
    parameters: { name: { type: 'string', description: 'One recorded check; omit for all.' } },
    output: {
      schema: { type: 'array', items: RUN_SCHEMA },
      render: (_args, value) => [{ type: 'text', text: value.length === 0 ? 'no checks recorded' : value.map(describeCheck).join('\n') }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('check_replay requires an owning agent session')
      const checks = checksOf(exec.agent)
      const selected = args.name === undefined ? [...checks.values()] : [checks.get(args.name)]
      if (selected.some(entry => entry === undefined)) throw new Error(`no recorded check named ${JSON.stringify(args.name)}`)
      const results: CheckView[] = []
      for (const entry of selected as CheckEntry[]) {
        if (exec.signal.aborted || !await replay(entry, exec.signal)) throw toolAborted()
        results.push(view(entry))
      }
      return results
    },
    presentCall: args => ({ card: 'generic', title: args.name === undefined ? 'Replay all checks' : `Replay check ${args.name}`, kind: 'execute' }),
  }))

  ctx.tools.register(defineTool({
    name: 'check_list',
    description: 'List recorded checks with their latest verdict and whether code changed since.',
    parameters: {},
    output: {
      schema: { type: 'array', items: RUN_SCHEMA },
      render: (_args, value) => [{ type: 'text', text: value.length === 0 ? 'no checks recorded' : value.map(describeCheck).join('\n') }],
    },
    execute(_args, exec) {
      if (exec.agent === undefined) throw new Error('check_list requires an owning agent session')
      return Promise.resolve([...checksOf(exec.agent).values()].map(view))
    },
    presentCall: () => ({ card: 'generic', title: 'List checks', kind: 'read' }),
  }))

  if (!config.replayOnStop) return

  const stopStateOf = (agent: Agent, turn: number): StopState => {
    let state = stopStates.get(agent.id)
    if (state === undefined || state.turn !== turn) {
      state = { turn, rounds: 0, notRunNotified: false, exhaustedNotified: false, replayedAt: new Map() }
      stopStates.set(agent.id, state)
    }
    return state
  }

  const steer = (agent: Agent, text: string): void => {
    agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: SOURCE }))
  }

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
    const checks = byAgent.get(agent.id)
    if (checks === undefined) return
    const state = stopStateOf(agent, turn)
    // Replay a stale check at most once per code change within this turn.
    const due = [...checks.values()].filter(entry => isStale(entry) && state.replayedAt.get(entry.name) !== relatedMutation(entry.workdir))
    if (due.length === 0) return
    for (const entry of due) {
      if (signal.aborted) return
      const at = relatedMutation(entry.workdir)
      if (!await replay(entry, signal)) return
      state.replayedAt.set(entry.name, at)
    }
    const views = due.map(view)
    const failed = views.filter(item => item.status === 'failed')
    const notRun = views.filter(item => item.status === 'not_run')
    const notRunText = notRun.length === 0 ? '' : `\n\nThese checks could not run, so they have no verdict; do not report them as passed:\n${notRun.map(describeCheck).join('\n')}`
    if (failed.length > 0 && state.rounds < config.maxRepairRounds) {
      state.rounds += 1
      if (notRun.length > 0) state.notRunNotified = true
      steer(agent, `Casper replayed your checks after your edits and these fail (repair round ${String(state.rounds)} of ${String(config.maxRepairRounds)}). Fix the code, not the check:\n${due.filter(entry => entry.last.status === 'failed').map(entry => `${describeCheck(view(entry))}\n${entry.last.output}`).join('\n\n')}${notRunText}`)
      return
    }
    if (failed.length > 0 && !state.exhaustedNotified) {
      state.exhaustedNotified = true
      if (notRun.length > 0) state.notRunNotified = true
      steer(agent, `Casper checks still fail after ${String(config.maxRepairRounds)} repair rounds. Stop repairing and correct your report: these checks failed.\n${failed.map(describeCheck).join('\n')}${notRunText}`)
      return
    }
    if (notRun.length > 0 && !state.notRunNotified) {
      state.notRunNotified = true
      steer(agent, `Casper replayed your checks after your edits, but some could not run. Correct your report: they have no verdict and must not be reported as passed.\n${notRun.map(describeCheck).join('\n')}`)
    }
  })
}
