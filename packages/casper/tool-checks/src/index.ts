/**
 * Casper checks: run the project's own checks after the agent edits, send real failures back for a
 * bounded number of repair rounds, and close the turn with a receipt of what changed and what was
 * proven. A check that did not run is never reported as passed.
 *
 * Project checks (typecheck, lint, test, build) come from `.casper/project.yaml` or are detected
 * from the repository's manifests, and run at the `agent/turn-stopping` checkpoint of a top-level
 * turn that changed files, only where the shell sandbox confines them unless configured otherwise.
 * Model-facing `check_record`, `check_replay` and `check_list` tools keep per-agent recorded checks;
 * a mutation tool result in a working directory marks every check whose directory overlaps it
 * stale, whichever agent made the edit, and an edit that lands while a check runs leaves that run
 * stale. The checkpoint replays stale recorded checks too.
 * @module @deepseek-ai/dsh-casper-checks
 */

import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-fs'
import { sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, MessageSource } from '@deepseek-ai/dsh-llm'
import type { CollectedOutput, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import { addChange, blockedBySandbox, mayMutate, onlyDocumentation } from './changes.ts'
import type { TurnChanges } from './changes.ts'
import { discoverProjectChecks, ProjectFileError } from './project.ts'
import type { ProjectChecks, ProjectReader } from './project.ts'
import { formatReceipt } from './receipt.ts'
import type { CheckStatus, NotRunReason, ReceiptCheck } from './receipt.ts'

export type { CheckStatus, NotRunReason, ReceiptCheck, ReceiptInput, ReceiptVerdict } from './receipt.ts'
export { formatReceipt, receiptVerdict } from './receipt.ts'
export type { CheckSource, ProjectCheck, ProjectChecks, ProjectReader, StandardCheck, VerificationMode } from './project.ts'
export { detectCommands, discoverProjectChecks, parseProjectFile, PROJECT_FILE, ProjectFileError, STANDARD_CHECKS } from './project.ts'
export type { TurnChanges } from './changes.ts'
export { addChange, blockedBySandbox, isDocumentation, mayMutate, onlyDocumentation } from './changes.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'casper-checks': { kind: 'casper-checks' } & ContextFormed
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'casper-checks'
export const inject = ['tools', 'shell', 'systemPrompt', 'workingDirectory', 'fs']

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
  /** Tool names whose results invalidate checks and count as a turn's changes. */
  mutatingTools: string[]
  /** Replay stale checks and run project checks at the turn-stopping checkpoint. */
  replayOnStop: boolean
  /** Repair rounds the checkpoint may force in one turn; `repair.maxAttempts` in the project file overrides it. */
  maxRepairRounds: number
  /** Characters of command output retained per run, shared between stdout and stderr. */
  outputChars: number
  /** Recorded checks one agent may hold. */
  maxChecks: number
  /** Run the project's checks after a top-level turn changes files; `verification.mode` in the project file overrides it. */
  projectChecks: boolean
  /** Deadline of one project check; `verification.timeoutMs` in the project file overrides it. */
  projectTimeoutMs: number
  /** Run project checks even when the shell sandbox does not confine them. */
  runUnconfined: boolean
  /** Steer the closing receipt to the agent so its final reply carries it. */
  receipt: boolean
}

export const Config: z<Config> = z.object({
  mutatingTools: z.array(z.string()).default(['write', 'edit', 'apply_patch', 'str_replace_editor', 'bash', 'pwsh']),
  replayOnStop: z.boolean().default(true),
  maxRepairRounds: z.natural().default(3),
  outputChars: z.natural().min(200).default(2000),
  maxChecks: z.natural().min(1).default(32),
  projectChecks: z.boolean().default(true),
  projectTimeoutMs: z.natural().min(1).max(3_600_000).default(600_000),
  runUnconfined: z.boolean().default(false),
  receipt: z.boolean().default(true),
})

const SOURCE: MessageSource = { kind: 'casper-checks' }
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u
const TRUNCATED = '[… earlier output truncated]\n'
const NOT_RUN_REASONS = ['timed_out', 'signal', 'could_not_start', 'aborted', 'sandbox_blocked'] as const

const RUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    command: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['passed', 'failed', 'not_run'] },
    exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], required: true },
    reason: { oneOf: [{ type: 'string', enum: NOT_RUN_REASONS }, { type: 'null' }], required: true },
    stale: { type: 'boolean', required: true },
    output: { type: 'string', required: true },
  },
} as const

/** Canonical per-check result projected onto the tool outputs. */
export interface CheckView extends ReceiptCheck {
  output: string
}

/** A recorded or project check. `verdictEpoch` is the mutation epoch when its last verdict-producing run started. */
interface CheckEntry {
  name: string
  command: string
  workdir: string
  timeoutMs: number | null
  last: CheckRun
  verdictEpoch: number
}

/** The project checks of one turn, discovered at its first checkpoint and kept through its repair rounds. */
interface TurnProject {
  /** Checks to run, or empty when `notChecked` says why none run. */
  entries: CheckEntry[]
  notChecked: string
  maxRepairRounds: number
}

/** Per-agent stop checkpoint state; reset whenever the turn number changes. */
interface StopState {
  turn: number
  rounds: number
  notRunNotified: boolean
  exhaustedNotified: boolean
  receiptSent: boolean
  /** Related-mutation epoch at which each recorded check was last replayed by this checkpoint. */
  replayedAt: Map<string, number>
  project: TurnProject | undefined
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
 * Classify a finished shell run. Only a real exit code yields a verdict, and a failure whose output
 * shows a sandbox denial under a confining sandbox is `sandbox_blocked`, not a verdict on the code.
 * @param result - the executor's run result.
 * @param outputChars - output budget shared by the two streams.
 * @param confined - whether the sandbox confined the run.
 * @returns the run classification.
 */
export function classifyRun(result: ShellRunResult, outputChars: number, confined = false): CheckRun {
  const streams = [result.stdout, result.stderr].filter(stream => stream.text.length > 0)
  const output = streams.map(stream => tail(stream, Math.floor(outputChars / streams.length))).join('\n')
  if (result.timedOut) return { status: 'not_run', exitCode: null, reason: 'timed_out', output }
  if (result.aborted) return { status: 'not_run', exitCode: null, reason: 'aborted', output }
  if (result.exitCode === null) return { status: 'not_run', exitCode: null, reason: result.signal === null ? 'could_not_start' : 'signal', output }
  if (result.exitCode !== 0 && confined && blockedBySandbox(output)) return { status: 'not_run', exitCode: result.exitCode, reason: 'sandbox_blocked', output }
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

function isTopLevel(agent: Agent): boolean {
  const header = agent.session.header
  return header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0
}

const CONFINED_MODES: ReadonlySet<string> = new Set(['read-only', 'workspace-write'])

/**
 * Register the checks tools, the project checks and the turn-stopping checkpoint.
 * @param ctx - registrant context.
 * @param config - deployment policy.
 */
export function apply(ctx: Context, config: Config): void {
  const mutating = new Set(config.mutatingTools)
  const byAgent = new Map<string, Map<string, CheckEntry>>()
  const stopStates = new Map<string, StopState>()
  /** Changes each agent's own mutation calls made since its last receipt. */
  const pending = new Map<string, TurnChanges>()
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
      const confined = spec.sandboxPolicy !== undefined && CONFINED_MODES.has(spec.sandboxPolicy.mode)
      const execution = await ctx.shell.execute(spec)
      return classifyRun(await execution.result(), config.outputChars, confined)
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
    text: 'After you change files, Casper runs the project\'s own checks (typecheck, lint, test, build) '
      + 'before your turn ends, sends you real failures to fix, and gives you a receipt to end your reply with. '
      + 'Fix failing code, not the check: do not weaken .casper/project.yaml or the scripts it runs. '
      + 'To track another command, record it with check_record before editing and replay it with check_replay. '
      + 'Report a check as passed only when its latest non-stale run passed. A check that is not run, '
      + 'stale, or never recorded has no verdict: say so instead of claiming success.',
  })

  ctx.on('tools/result', (exec) => {
    if (exec.agent === undefined || !mutating.has(exec.name) || !mayMutate(exec.name, exec.arguments)) return
    epoch += 1
    if (isTopLevel(exec.agent)) {
      let changes = pending.get(exec.agent.id)
      if (changes === undefined) {
        changes = { paths: new Set(), unknown: false }
        pending.set(exec.agent.id, changes)
      }
      addChange(changes, exec.name, exec.arguments)
    }
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
    pending.delete(agent.id)
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
        if (!await replay(entry, exec.signal)) throw toolAborted()
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
      state = {
        turn, rounds: 0, notRunNotified: false, exhaustedNotified: false, receiptSent: false, replayedAt: new Map(), project: undefined,
      }
      stopStates.set(agent.id, state)
    }
    return state
  }

  const steer = (agent: Agent, text: string): void => {
    agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: SOURCE }))
  }

  const readerFor = (workdir: string, signal: AbortSignal): ProjectReader => {
    const stat = async (path: string) => ctx.fs.stat(await ctx.fs.resolve(path, { cwd: workdir, signal }), signal)
    return {
      read: async (path) => {
        const target = await ctx.fs.resolve(path, { cwd: workdir, signal })
        if ((await ctx.fs.stat(target, signal))?.type !== 'file') return undefined
        return ctx.fs.readText(target, signal)
      },
      exists: async path => await stat(path) !== undefined,
    }
  }

  /** Discover this turn's project checks; a reason replaces them when none may run. */
  const projectFor = async (agent: Agent, changes: TurnChanges, signal: AbortSignal): Promise<TurnProject> => {
    const none = (notChecked: string, maxRepairRounds = config.maxRepairRounds): TurnProject => ({
      entries: [], notChecked, maxRepairRounds,
    })
    if (!config.projectChecks) return none('automatic project checks are off')
    if (onlyDocumentation(changes)) return none('only documentation changed')
    let workdir: string
    let found: ProjectChecks
    try {
      workdir = await ctx.workingDirectory.ensure(agent, signal)
      found = await discoverProjectChecks(readerFor(workdir, signal))
    } catch (error) {
      if (error instanceof ProjectFileError) return none(`${error.message}; fix the file to run the project's checks`)
      return none(`Casper could not read the project to find its checks (${String(error)})`)
    }
    const maxRepairRounds = found.maxRepairRounds ?? config.maxRepairRounds
    if (found.mode === 'off') return none('checking is off for this project (verification.mode: off)', maxRepairRounds)
    const [first] = found.checks
    if (first === undefined) return none('no checks found; say "add tests" to have some written', maxRepairRounds)
    const commands = found.checks.map(check => check.command).join(', ')
    if (found.mode === 'offer') return none(`checks are offered, not run, for this project (verification.mode: offer); ask to run: ${commands}`, maxRepairRounds)
    const policy = ctx.shell.resolve({ command: first.command, workdir }).sandboxPolicy
    if (!config.runUnconfined && (policy === undefined || !CONFINED_MODES.has(policy.mode))) {
      return none(`no sandbox confines this project's commands and folder trust is not available yet, so Casper did not run ${commands}`, maxRepairRounds)
    }
    const timeoutMs = found.timeoutMs ?? config.projectTimeoutMs
    return {
      entries: found.checks.map(check => ({
        name: check.name,
        command: check.command,
        workdir,
        timeoutMs,
        last: { status: 'not_run', exitCode: null, reason: 'could_not_start', output: '' },
        verdictEpoch: -1,
      })),
      notChecked: '',
      maxRepairRounds,
    }
  }

  /** Reuse a fresh verdict of a recorded check with the same command instead of running it again. */
  const reuse = (entry: CheckEntry, recorded: Map<string, CheckEntry> | undefined): boolean => {
    for (const other of recorded?.values() ?? []) {
      if (other.command !== entry.command || other.workdir !== entry.workdir || other.last.status === 'not_run' || isStale(other)) continue
      entry.last = other.last
      entry.verdictEpoch = other.verdictEpoch
      return true
    }
    return false
  }

  /** Run checks in order; false when the checkpoint was cancelled before or during one. */
  const runAll = async (entries: CheckEntry[], signal: AbortSignal, ran: (entry: CheckEntry, at: number) => void): Promise<boolean> => {
    for (const entry of entries) {
      const at = relatedMutation(entry.workdir)
      if (signal.aborted || !await replay(entry, signal)) return false
      ran(entry, at)
    }
    return true
  }

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
    const checks = byAgent.get(agent.id)
    const changes = pending.get(agent.id)
    const state = stopStateOf(agent, turn)
    // Replay a stale recorded check at most once per code change within this turn.
    const due = [...checks?.values() ?? []]
      .filter(entry => isStale(entry) && state.replayedAt.get(entry.name) !== relatedMutation(entry.workdir))
    if (due.length === 0 && changes === undefined) return
    if (!await runAll(due, signal, (entry, at) => state.replayedAt.set(entry.name, at))) return
    if (signal.aborted) return
    // The turn's own changes bring its project checks, discovered once per turn.
    const work = changes === undefined ? undefined : { changes, project: state.project ??= await projectFor(agent, changes, signal) }
    const projectDue = work?.project.entries.filter(entry => entry.verdictEpoch < 0 || isStale(entry)) ?? []
    const fresh = projectDue.filter(entry => !reuse(entry, checks))
    if (!await runAll(fresh, signal, () => undefined)) return
    const maxRounds = work?.project.maxRepairRounds ?? config.maxRepairRounds
    const ran = [...projectDue, ...due]
    const failedEntries = ran.filter(entry => entry.last.status === 'failed')
    const notRun = ran.map(view).filter(item => item.status === 'not_run')
    const notRunText = notRun.length === 0 ? '' : `\n\nThese checks could not run, so they have no verdict; do not report them as passed:\n${notRun.map(describeCheck).join('\n')}`
    if (failedEntries.length > 0 && state.rounds < maxRounds) {
      state.rounds += 1
      if (notRun.length > 0) state.notRunNotified = true
      steer(agent, `Casper ran the checks after your edits and these fail (repair round ${String(state.rounds)} of ${String(maxRounds)}). `
        + `Fix the code, not the check:\n${failedEntries.map(entry => `${describeCheck(view(entry))}\n${entry.last.output}`).join('\n\n')}${notRunText}`)
      return
    }
    const failed = failedEntries.map(view)
    if (work !== undefined) {
      pending.delete(agent.id)
      if (!config.receipt || state.receiptSent) return
      state.receiptSent = true
      state.notRunNotified = true
      state.exhaustedNotified = true
      const project = work.project.entries
      const recorded = [...checks?.values() ?? []]
        .filter(entry => !project.some(item => item.command === entry.command && item.workdir === entry.workdir))
      const receipt = formatReceipt({
        checks: [...project, ...recorded].map(view),
        changes: work.changes,
        repairs: state.rounds,
        notChecked: work.project.notChecked,
        documentationOnly: onlyDocumentation(work.changes),
      })
      const exhausted = failed.length > 0 ? ` These checks still fail after ${String(maxRounds)} repair rounds: stop repairing and say so.` : ''
      steer(agent, `Casper checked your edits.${exhausted} End your reply to the user with this receipt, unchanged, and claim nothing it does not show:\n\n${receipt}`)
      return
    }
    if (failed.length > 0 && !state.exhaustedNotified) {
      state.exhaustedNotified = true
      if (notRun.length > 0) state.notRunNotified = true
      steer(agent, `Casper checks still fail after ${String(maxRounds)} repair rounds. Stop repairing and correct your report: these checks failed.\n${failed.map(describeCheck).join('\n')}${notRunText}`)
      return
    }
    if (notRun.length > 0 && !state.notRunNotified) {
      state.notRunNotified = true
      steer(agent, `Casper replayed your checks after your edits, but some could not run. Correct your report: they have no verdict and must not be reported as passed.\n${notRun.map(describeCheck).join('\n')}`)
    }
  })
}
