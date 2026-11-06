/**
 * The Agent that drives one Session through a `casper acp` process.
 * @module @deepseek-ai/dsh-casper-agent/agent
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RequestPermissionRequest, RequestPermissionResponse, SessionNotification, StopReason } from '@agentclientprotocol/sdk'
import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxState,
  InboxTarget,
  ModelSelectionProjectionState,
} from '@deepseek-ai/dsh-agent'
import { AgentModel, agentEvents } from '@deepseek-ai/dsh-agent'
import { ReactLoopInbox } from '@deepseek-ai/dsh-agent-loop'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-attachment'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'
import { appReadRoots, isInstalled, selfAnchor } from './app-read.ts'
import { startAppTools } from './app-tools.ts'
import type { AppToolsProfile, AppToolsServer } from './app-tools.ts'
import type { Config } from './config.ts'
import { CasperConnection, CasperError } from './connection.ts'
import { answerPermission } from './permission.ts'
import { hasPromptContent, promptContent } from './prompt.ts'
import type { CasperSidecar } from './sidecar.ts'
import { TurnWriter } from './turn.ts'

/** Text that opens a turn whose earlier Casper conversation could not be reopened. */
export const FRESH_CONVERSATION_NOTICE = 'Casper could not reopen its earlier conversation, so this turn starts fresh.\n'

/** Model name recorded on assistant messages when the config sets none. */
const DEFAULT_MODEL_LABEL = 'casper'

/** Projection readers the factory passes to each Agent. */
export interface CasperAgentReaders {
  /** Current model selection. */
  readonly modelSelection: () => ModelSelectionProjectionState
  /** Current queued and claimed input. */
  readonly inbox: () => InboxState
}

/** Where the current prompt's updates go: its connection, turn writer, and turn signal. */
interface PromptSink {
  readonly connection: CasperConnection
  readonly writer: TurnWriter
  readonly signal: AbortSignal
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'maintenance'; abort: AbortController; wakeRequested: boolean }
  | { kind: 'running'; abort: AbortController; wakeRequested: boolean }

/**
 * Copy the cause `cancel()` aborted a signal with.
 * @param signal - a signal this Agent owns.
 * @returns the cause, or undefined while the signal is live.
 */
function cancelCauseOf(signal: AbortSignal): AgentCancelCause | undefined {
  if (!signal.aborted) return undefined
  // `cancel()` is the only aborter of the signals this Agent owns.
  const cause = signal.reason as AgentCancelCause
  return cause.kind === 'hook' ? { kind: 'hook', reason: cause.reason } : { kind: cause.kind }
}

/**
 * Drives one Session through Casper. Each turn claims queued input, sends its
 * text as one `session/prompt`, and records Casper's updates as steps.
 * Casper takes no input during a prompt, so steering waits for the next turn.
 * The process starts at the first prompt and restarts after an exit.
 */
export class CasperAgent implements Agent {
  readonly model: AgentModel
  readonly inbox: ReactLoopInbox
  /** The Agent-scoped registration boundary; the factory unwinds it after the driver stops. */
  readonly scope: Scope
  readonly ctx: Context
  private readonly dispatch: AgentEventDispatch
  private phase: Phase = { kind: 'idle' }
  private activityDone: Promise<void> = Promise.resolve()
  private lastTurn: number
  private revision = 0
  private attempts = 0
  private connection: CasperConnection | undefined
  private sink: PromptSink | undefined
  /** First failure recording an update; it ends the turn as an error. */
  private updateFailure: Error | undefined
  private readonly asks = new Map<string, AbortController>()

  /**
   * @param pluginCtx - the Casper plugin context whose services the Agent uses.
   * @param id - the Session and Agent identity.
   * @param options - Agent options; Casper chooses its own model, so they are kept unread.
   * @param session - the Session this Agent drives.
   * @param readers - model-selection and inbox projection readers.
   * @param lastTurn - the last turn number recorded in the Session.
   * @param config - the plugin config.
   * @param sidecar - the Session-to-conversation records.
   */
  constructor(
    private readonly pluginCtx: Context,
    readonly id: SessionId,
    readonly options: AgentOptions,
    readonly session: Session,
    readers: CasperAgentReaders,
    lastTurn: number,
    private readonly config: Config,
    private readonly sidecar: CasperSidecar,
  ) {
    this.dispatch = agentEvents(pluginCtx, this)
    this.scope = createScope(pluginCtx, this)
    this.ctx = this.scope.ctx
    // No fallback route: the badge shows a model only after the user picks one.
    this.model = new AgentModel(readers.modelSelection, session, {})
    this.inbox = new ReactLoopInbox(readers.inbox, session, this.dispatch)
    this.lastTurn = lastTurn
  }

  get status(): AgentStatus {
    return this.phase.kind === 'running' ? 'running' : 'idle'
  }

  private setPhase(next: Phase): void {
    const previous = this.status
    this.phase = next
    if (this.status !== previous) this.dispatch.emit('agent/status', { status: this.status })
  }

  /** The active turn or maintenance phase, or undefined while idle. */
  private get active(): Exclude<Phase, { kind: 'idle' }> | undefined {
    return this.phase.kind === 'idle' ? undefined : this.phase
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    // Waking input cannot join an aborted activity, so it waits for the next turn.
    const afterAbort = wakeup && this.active?.abort.signal.aborted === true
    this.inbox.splice(afterAbort ? 'next-turn' : target, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(afterAbort)
  }

  /**
   * Queue a prompt for the next turn and wake the driver.
   * @param prompt - the user message.
   */
  followup(prompt: UserMessage): void { this.send(prompt, 'next-turn', true) }

  /**
   * Queue steering; Casper takes no input during a prompt, so the next turn claims it.
   * @param prompt - the user message.
   */
  steer(prompt: UserMessage): void { this.send(prompt, 'next-step', true) }

  /**
   * Queue context for the next turn without waking the driver.
   * @param context - the user message.
   */
  inject(context: UserMessage): void { this.send(context, 'next-step', false) }

  /**
   * Stop the active turn or maintenance job.
   * @param cause - why the work stops; recorded on the turn's end.
   * @param options - `keepInbox` keeps queued input for the next turn.
   */
  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    const active = this.active
    if (options.keepInbox !== true) {
      this.inbox.clear()
      if (active !== undefined) active.wakeRequested = false
    }
    active?.abort.abort(cause)
  }

  /**
   * Run a job while no turn runs; input queued meanwhile wakes the driver afterwards.
   * @param job - the work, given a signal that `cancel()` aborts.
   * @returns the job's result.
   * @throws Error when a turn or another job is active.
   */
  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active !== undefined) throw new Error(`agent "${this.id}" already has active work`)
    const phase: Extract<Phase, { kind: 'maintenance' }> = { kind: 'maintenance', abort: new AbortController(), wakeRequested: false }
    const settled = Promise.withResolvers<void>()
    this.activityDone = settled.promise
    this.setPhase(phase)
    const finish = (): void => {
      this.setPhase({ kind: 'idle' })
      const replay = phase.wakeRequested && cancelCauseOf(phase.abort.signal)?.kind !== 'disposed'
      if (replay && this.inbox.hasPending) this.wakeDriver()
      settled.resolve()
    }
    // The job starts synchronously; a synchronous throw becomes its rejection.
    return (async () => job(phase.abort.signal))().finally(finish)
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  /**
   * Stop and release the Casper process. The factory calls this after the
   * driver is idle.
   * @returns resolution once the process range is empty.
   */
  async closeConnection(): Promise<void> {
    const connection = this.connection
    this.connection = undefined
    await connection?.dispose()
  }

  private wakeDriver(wakeAfterAbort = false): void {
    const active = this.active
    if (active !== undefined) {
      // A live driver claims queued work itself; maintenance and an aborted driver replay the wake when they finish.
      const latch = active.kind === 'maintenance' || wakeAfterAbort
      if (latch && cancelCauseOf(active.abort.signal)?.kind !== 'disposed') active.wakeRequested = true
      return
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({ kind: 'running', abort: new AbortController(), wakeRequested: false })
    this.pluginCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) { /* the next queued turn */ }
    } catch (error: unknown) {
      /* v8 ignore start -- turn() records every failure on turn/end; only a rejected turn/start or turn/end append reaches here. */
      this.pluginCtx.logger.warn(`casper agent "${this.id}": turn failed: ${String(error)}`)
      /* v8 ignore stop */
    } finally {
      /* v8 ignore next -- kick owns the running phase until it returns */
      if (this.phase.kind === 'running') {
        const { wakeRequested } = this.phase
        this.setPhase({ kind: 'idle' })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  /** Run one turn; returns whether another queued turn follows. */
  private async turn(): Promise<boolean> {
    /* v8 ignore next -- kick() calls turn() only while running */
    if (this.phase.kind !== 'running') return false
    const phase = this.phase
    const { signal } = phase.abort
    const turn = this.lastTurn + 1
    this.session.append('turn/start', { turn })
    this.lastTurn = turn
    let reason: TurnEndReason
    let step = 0
    try {
      reason = await this.runTurn(turn, signal, (current) => { step = current })
    } catch (error: unknown) {
      const cause = cancelCauseOf(signal)
      if (cause !== undefined) {
        reason = { kind: 'aborted', reason: cause }
      } else {
        reason = { kind: 'error', error: failureOf(error) }
        this.dispatch.emit('agent/error', { turn, step, error })
      }
    }
    this.session.append('turn/end', { turn, reason })
    await this.flush()
    if (signal.aborted || !this.inbox.hasPending) return false
    phase.abort = new AbortController()
    phase.wakeRequested = false
    return true
  }

  private async runTurn(turn: number, signal: AbortSignal, onStep: (step: number) => void): Promise<TurnEndReason> {
    const claimed = this.inbox.claim('next-turn', turn)
    if (claimed.length === 0) return { kind: 'completed' }
    this.session.append('step/start', { turn, step: 1 })
    onStep(1)
    for (const message of claimed) this.session.append('user/message', message, { surfaceOp: 'append' })
    let connection: CasperConnection | undefined
    const writer: TurnWriter = new TurnWriter({
      session: this.session,
      emit: (frame) => { this.dispatch.emit('agent/assistant-stream', { frame }) },
      turn,
      step: 1,
      nextAttempt: () => ++this.attempts,
      nextRevision: () => ++this.revision,
      model: this.config.model ?? DEFAULT_MODEL_LABEL,
      callId: acpId => (connection as CasperConnection).toolCallId(acpId),
    })
    let interrupted = true
    try {
      if (!hasPromptContent(claimed)) throw new CasperError('CASPER_EMPTY_PROMPT', 'The request is empty, so nothing was sent to Casper.')
      // The prompt and its turn are durable before Casper can change files.
      await this.flush(true)
      signal.throwIfAborted()
      const opened = await this.ensureConnection(signal)
      signal.throwIfAborted()
      connection = opened.connection
      // Said at once: the conversation is new even when this turn sends nothing.
      if (opened.fresh) writer.text(FRESH_CONVERSATION_NOTICE)
      const content = await promptContent(claimed, { attachments: this.pluginCtx.get('attachments'), images: connection.acceptsImages, signal })
      // A store may finish a read after a Stop; the prompt is then not sent.
      signal.throwIfAborted()
      if (!content.readable) {
        const pictures = !connection.acceptsImages && claimed.some(message => message.content.some(block => block.type === 'image'))
        throw new CasperError('CASPER_EMPTY_PROMPT', pictures
          ? 'This Casper can\'t take pictures, and the request has no words. Update Casper to send pictures.'
          : 'The attachments could not be read, and the request has no words, so nothing was sent to Casper.')
      }
      this.updateFailure = undefined
      this.sink = { connection, writer, signal }
      for (const note of content.notes) writer.text(note)
      const stopReason = await this.promptUntilSettled(connection, content.blocks, signal)
      const failure = this.takeUpdateFailure()
      /* v8 ignore next -- see record(). */
      if (failure !== undefined) throw failure
      interrupted = stopReason !== 'end_turn'
      return turnEndFor(stopReason)
    } finally {
      this.sink = undefined
      for (const ask of this.asks.values()) ask.abort()
      this.asks.clear()
      onStep(writer.step)
      writer.close(interrupted)
    }
  }

  /** Send the prompt; on abort send `session/cancel` and wait the cancel grace before killing Casper. */
  private async promptUntilSettled(connection: CasperConnection, blocks: Parameters<CasperConnection['prompt']>[0], signal: AbortSignal): Promise<StopReason> {
    const reply = connection.prompt(blocks)
    const aborted = Promise.withResolvers<'aborted'>()
    const onAbort = (): void => { aborted.resolve('aborted') }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const first = await Promise.race([reply, aborted.promise])
      if (first !== 'aborted') return first
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
    reply.catch(() => {
      // The turn ends aborted whatever Casper replies.
    })
    connection.cancel()
    // Disposal stops the process itself; a user cancel gives Casper time to stop cleanly.
    if (cancelCauseOf(signal)?.kind !== 'disposed') {
      const settled = await settlesWithin(reply, this.config.cancelGraceMs)
      if (!settled) this.dropConnection(connection)
    }
    throw new Error('the prompt was stopped', { cause: signal.reason })
  }

  private async ensureConnection(signal: AbortSignal): Promise<{ connection: CasperConnection; fresh: boolean }> {
    const live = this.connection
    if (live !== undefined && !live.dead) return { connection: live, fresh: false }
    if (live !== undefined) this.dropConnection(live)
    const cwd = this.session.header.cwd
    if (cwd === undefined) throw new CasperError('CASPER_START_FAILED', 'Casper needs a project folder for this session.')
    const stored = this.sidecar.read(this.id, cwd)
    const context = this.pluginCtx.get('profileContext')
    const profile = context === undefined ? undefined : { name: context.name, dir: context.dir }
    // Updates count only while this connection is the Agent's current one.
    const owner: { connection?: CasperConnection } = {}
    const started = await CasperConnection.start({
      subprocess: this.pluginCtx.subprocess,
      config: this.config,
      cwd,
      profile,
      handlers: {
        update: (notification) => { this.receive(owner.connection, notification) },
        permission: params => this.permission(owner.connection, params),
      },
      appTools: this.config.appTools ? connection => this.startAppTools(connection, cwd, profile) : undefined,
    }, stored?.acpSessionId, signal)
    owner.connection = started.connection
    try {
      await this.sidecar.write(this.id, { acpSessionId: started.acpSessionId, cwd })
    } catch (error: unknown) {
      started.connection.terminate()
      throw new CasperError('CASPER_START_FAILED', `Casper's conversation could not be recorded: ${String(error)}`, { cause: error })
    }
    this.connection = started.connection
    return { connection: started.connection, fresh: stored !== undefined && !started.reopened }
  }

  /**
   * Serve the app's plugin tools to one connection. A call runs as this Agent
   * only while that connection's prompt is open, under the call id of the
   * Casper step that made it.
   */
  private startAppTools(connection: CasperConnection, cwd: string, profile: AppToolsProfile | undefined): Promise<AppToolsServer> {
    return startAppTools({
      tools: this.pluginCtx.tools,
      skills: this.pluginCtx.get('skills'),
      agent: this,
      cwd,
      profile,
      // The desktop app ships the dsh runtime of its own version.
      version: getDshRuntimeVersion(),
      roots: appReadRoots(selfAnchor(), profile?.dir),
      installed: isInstalled(selfAnchor()),
      turn: () => this.sinkFor(connection)?.signal,
      callId: acpId => connection.toolCallId(acpId),
      onError: (error) => { this.pluginCtx.logger.debug(`casper agent "${this.id}": app tools: ${error.message}`) },
    })
  }

  /** Forget the current connection and start killing it. */
  private dropConnection(connection: CasperConnection): void {
    this.connection = undefined
    connection.terminate()
  }

  /** The current prompt's sink when `connection` is the one prompting; updates outside a prompt are dropped. */
  private sinkFor(connection: CasperConnection | undefined): PromptSink | undefined {
    const sink = this.sink
    return sink?.connection === connection ? sink : undefined
  }

  /** Read and clear the first failure recorded while applying updates. */
  private takeUpdateFailure(): Error | undefined {
    const failure = this.updateFailure
    this.updateFailure = undefined
    return failure
  }

  /** Apply one update to the turn; the first failure ends the turn as an error. */
  private record(apply: () => void): void {
    try {
      apply()
    } catch (error: unknown) {
      /* v8 ignore start -- the SDK validates updates, so only a Session-level append failure reaches here. */
      this.updateFailure ??= error instanceof Error ? error : new Error(String(error))
      /* v8 ignore stop */
    }
  }

  private receive(connection: CasperConnection | undefined, notification: SessionNotification): void {
    const sink = this.sinkFor(connection)
    if (sink === undefined) return
    const { update } = notification
    this.record(() => {
      switch (update.sessionUpdate) {
        case 'agent_message_chunk':
          if (update.content.type === 'text') sink.writer.text(update.content.text)
          return
        case 'tool_call':
          sink.writer.toolCall(update)
          // Each Casper step that changes the workspace is made durable without waiting for the turn.
          void this.flush()
          return
        case 'tool_call_update':
          this.asks.get(update.toolCallId)?.abort()
          sink.writer.toolUpdate(update)
          void this.flush()
          return
        case 'plan':
          sink.writer.plan(update.entries)
          return
        default:
          // Casper sends no other update kinds; the rest of ACP's set is not shown.
          return
      }
    })
  }

  private async permission(connection: CasperConnection | undefined, params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const sink = this.sinkFor(connection)
    if (sink === undefined) return { outcome: { outcome: 'cancelled' } }
    this.record(() => { sink.writer.question(params.toolCall) })
    const id = params.toolCall.toolCallId
    const own = new AbortController()
    this.asks.set(id, own)
    const signal = AbortSignal.any([sink.signal, own.signal])
    const service = this.pluginCtx.get('userQuestions')
    try {
      return await answerPermission(
        params,
        service === undefined ? undefined : async question => service.ask({ agent: this, questions: [question], signal }),
        (error) => { this.pluginCtx.logger.debug(`casper agent "${this.id}": permission question ended: ${String(error)}`) },
      )
    } finally {
      if (this.asks.get(id) === own) this.asks.delete(id)
    }
  }

  /** Flush the Session's write path; `required` turns a failure into the turn's error. */
  private async flush(required = false): Promise<void> {
    try {
      await this.pluginCtx.sessions.flush(this.session)
    } catch (error: unknown) {
      if (required) throw error
      this.pluginCtx.logger.warn(`casper agent "${this.id}": session flush failed: ${String(error)}`)
    }
  }
}

/** Resolve whether `operation` settles within `ms`. */
async function settlesWithin(operation: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => { resolve(false) }, ms) })
  try {
    return await Promise.race([operation.then(() => true, () => true), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Map Casper's stop reason to the turn's end. */
function turnEndFor(stopReason: StopReason): TurnEndReason {
  switch (stopReason) {
    case 'end_turn':
      return { kind: 'completed' }
    case 'cancelled':
      // Our own cancel never reaches here: an aborted prompt ends through its abort.
      return { kind: 'aborted', reason: { kind: 'user' } }
    case 'max_turn_requests':
      return { kind: 'error', error: { code: 'CASPER_TURN_LIMIT', message: 'Casper stopped at its turn limit.' } }
    default:
      return { kind: 'error', error: { code: `CASPER_STOP_${stopReason.toUpperCase()}`, message: `Casper stopped: ${stopReason}.` } }
  }
}

/** Structured failure of a turn. */
function failureOf(error: unknown): LlmFailure {
  if (error instanceof CasperError) return { code: error.code, message: error.message }
  return { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }
}
