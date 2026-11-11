/**
 * A running Casper command's latest lines as a job in the app's Jobs panel.
 * @module @deepseek-ai/dsh-casper-agent/live-output
 */

import type { ToolCall, ToolCallUpdate } from '@agentclientprotocol/sdk'
import type { JobHandle, JobId, JobOutcome, JobRegistry, JobToolCall } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { unfence, words } from './views.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    /** A running Casper command shown with its latest lines; Stop on it stops the whole request. */
    casper: 'casper'
  }
}

/** The job kind of a running Casper command. */
export const LIVE_JOB_KIND = 'casper'

/** How long a finished command's job is awaited before its row is dropped. */
const SETTLE_WAIT_MS = 5_000

/**
 * The reasons the job registry gives when it ends jobs because it or the
 * Session's Agent is going away, not because the person stopped one: the job
 * ends, but the request is left to its own end.
 */
const TEARDOWN_REASONS: ReadonlySet<string> = new Set(['owner disposed', 'jobs service disposed'])

/**
 * The latest lines Casper sends for a running command: an in-progress update
 * marked `_meta.casper.live`, its text in one fence. Casper sends whole lines,
 * each update replacing the one before.
 * @param update - an ACP `tool_call_update`.
 * @returns the lines' text without its fence, or undefined for any other update.
 */
export function liveText(update: ToolCallUpdate): string | undefined {
  if (update.status !== 'in_progress') return undefined
  const casper: unknown = update._meta?.casper
  if (typeof casper !== 'object' || casper === null || (casper as { live?: unknown }).live !== true) return undefined
  const text = words(update.content)
  return text === undefined ? undefined : unfence(text)
}

/**
 * Split text into its lines, without the empty one after a last line break.
 * @param text - the text.
 * @returns the lines.
 */
export function lineList(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * The lines a replacing window adds to the one before it. The longest run of
 * the previous window's last lines that opens the next window is taken as
 * already shown; with none, the lines in between were never sent.
 * @param previous - the lines shown so far.
 * @param next - the new window.
 * @returns the lines to add, and `gap` when lines were missed before them.
 */
export function newLines(previous: readonly string[], next: readonly string[]): { lines: string[]; gap: boolean } {
  for (let overlap = Math.min(previous.length, next.length); overlap > 0; overlap--) {
    const from = previous.length - overlap
    let same = true
    for (let index = 0; index < overlap && same; index++) same = previous[from + index] === next[index]
    if (same) return { lines: next.slice(overlap), gap: false }
  }
  return { lines: [...next], gap: previous.length > 0 }
}

/** What the live output of one prompt needs from its Agent. */
export interface LiveOutputOptions {
  /** The job registry while it is mounted. */
  readonly jobs: () => JobRegistry | undefined
  /** The Session that owns the jobs. */
  readonly owner: SessionId
  /** The recorded call id of an ACP tool call id. */
  readonly callId: (acpId: string) => JobToolCall['callId']
  /** Stop the whole request, as the composer's Stop does; called when the person stops a command's job. */
  readonly stop: () => void
  /** Report a failure; it never carries a command or its lines. */
  readonly warn: (message: string) => void
}

/** One command's job. */
interface LiveStep {
  readonly id: JobId
  readonly handle: JobHandle
  /** The lines of the last window. */
  lines: string[]
  /** Set once the job was given its outcome. */
  done: boolean
  readonly settle: (outcome: JobOutcome) => void
}

/**
 * The jobs of one prompt's running commands. A command's job starts with the
 * first lines Casper sends for it, gets only the lines each window adds, and
 * ends when the step ends, when the person stops it (which stops the whole
 * request), or when the prompt ends. A failure here never reaches the turn.
 */
export class LiveOutput {
  /** The command (else the title) of each step, kept until its job starts or the step ends. */
  private readonly labels = new Map<string, string>()
  private readonly steps = new Map<string, LiveStep>()
  /** Steps whose job could not start, such as at the registry's job limit; they show only their final output. */
  private readonly refused = new Set<string>()

  /**
   * @param options - what the jobs need from the Agent.
   */
  constructor(private readonly options: LiveOutputOptions) {}

  /**
   * Keep a starting step's command as the label of its job.
   * @param call - the ACP `tool_call`.
   */
  noteCall(call: ToolCall): void {
    // A step that arrives already ended, such as a check, never runs.
    if (call.status === 'completed' || call.status === 'failed') return
    const input: unknown = call.rawInput
    const command = typeof input === 'object' && input !== null ? (input as { command?: unknown }).command : undefined
    const title: unknown = call.title
    const label = typeof command === 'string' && command.trim() !== '' ? command : typeof title === 'string' ? title : ''
    if (label.trim() !== '') this.labels.set(call.toolCallId, label)
  }

  /**
   * Show the lines of a live update in the step's job, starting the job with
   * its first lines; any other update is ignored.
   * @param update - an ACP `tool_call_update`.
   */
  update(update: ToolCallUpdate): void {
    const text = liveText(update)
    const acpId = update.toolCallId
    if (text === undefined || this.refused.has(acpId)) return
    try {
      const next = lineList(text)
      const known = this.steps.get(acpId)
      if (known !== undefined) {
        if (known.done) return
        const added = newLines(known.lines, next)
        known.lines = next
        if (added.lines.length > 0) known.handle.append(`${added.lines.join('\n')}\n`, { channel: 'log', ...added.gap ? { gapBefore: true } : {} })
        return
      }
      if (next.length === 0) return
      const jobs = this.options.jobs()
      if (jobs === undefined) return
      this.start(jobs, acpId, next)
    } catch (error: unknown) {
      // Tried once per step: a registry that refuses it is not asked again at every window.
      if (!this.steps.has(acpId)) this.refused.add(acpId)
      this.options.warn(`a running command's lines are not shown: ${String(error)}`)
    }
  }

  /**
   * End a step's job with the step's own end.
   * @param acpId - the ACP tool call id.
   * @param status - how the step ended.
   */
  end(acpId: string, status: 'completed' | 'failed'): void {
    this.labels.delete(acpId)
    this.refused.delete(acpId)
    const step = this.steps.get(acpId)
    if (step !== undefined) this.finish(step, status)
  }

  /**
   * End every job still running when the prompt ends.
   * @param status - `killed` for a stopped prompt, else `failed`.
   */
  close(status: 'killed' | 'failed'): void {
    this.labels.clear()
    this.refused.clear()
    for (const step of this.steps.values()) this.finish(step, status)
  }

  private start(jobs: JobRegistry, acpId: string, lines: string[]): void {
    const callId = this.options.callId(acpId)
    jobs.start({
      kind: LIVE_JOB_KIND,
      label: this.labels.get(acpId) ?? 'Casper command',
      owner: this.options.owner,
      toolCall: { callId, rootCallId: callId },
      run: (handle) => {
        const done = Promise.withResolvers<JobOutcome>()
        const started: LiveStep = { id: handle.id, handle, lines, done: false, settle: done.resolve }
        this.steps.set(acpId, started)
        // Written inside the starter, so the lines land with the registration.
        handle.append(`${lines.join('\n')}\n`, { channel: 'log' })
        return {
          cancel: (reason) => {
            if (started.done) return
            this.finish(started, 'killed')
            // The job is the whole request: Stop on it stops the request, never only the command. The registry's own
            // teardown only ends the row.
            if (reason === undefined || !TEARDOWN_REASONS.has(reason)) this.options.stop()
          },
          done: done.promise,
        }
      },
    })
    this.labels.delete(acpId)
  }

  /** Give a job its outcome, then drop its row once the registry settles it, as a shell call's row leaves when it ends. */
  private finish(step: LiveStep, status: JobOutcome['status']): void {
    if (step.done) return
    step.done = true
    // The last window is needed only to find the next one's new lines.
    step.lines = []
    step.settle({ status })
    const jobs = this.options.jobs()
    if (jobs === undefined) return
    const owner = this.options.owner
    // Async from the first line, so a registry that throws at once rejects instead.
    void (async () => {
      const view = await jobs.wait(step.id, SETTLE_WAIT_MS, owner)
      if (view.status !== 'running' && view.status !== 'stopping') jobs.remove(step.id, owner)
    })().catch(() => { /* the registry already dropped it, with its owner or on unload */ })
  }
}
