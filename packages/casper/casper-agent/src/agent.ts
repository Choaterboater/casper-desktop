/**
 * The Agent that drives one Session through a `casper acp` process.
 * @module @deepseek-ai/dsh-casper-agent/agent
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AvailableCommand, RequestPermissionRequest, RequestPermissionResponse, SessionNotification, StopReason } from '@agentclientprotocol/sdk'
import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentModelsState,
  AgentStatus,
  CancelOptions,
  InboxState,
  InboxTarget,
  ModelSelection,
} from '@deepseek-ai/dsh-agent'
import { AGENT_MODELS_RECORD, agentEvents } from '@deepseek-ai/dsh-agent'
import { ReactLoopInbox } from '@deepseek-ai/dsh-agent-loop'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'
import { appReadRoots, isInstalled, selfAnchor } from './app-read.ts'
import { startAppTools } from './app-tools.ts'
import type { AppToolsProfile, AppToolsServer } from './app-tools.ts'
import { casperCommandId, casperCommands } from './commands.ts'
import type { CasperCommand, CasperCommandCache } from './commands.ts'
import type { Config } from './config.ts'
import { CasperConnection, CasperError } from './connection.ts'
import { CasperModel } from './model.ts'
import { effortState, reportOf, valueOf } from './models.ts'
import type { CasperModelsCache } from './models-cache.ts'
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
  /** Casper's reported models and a pick not yet applied. */
  readonly agentModels: () => AgentModelsState
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
  readonly model: CasperModel
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
  /** The Casper commands this Agent offers in the command menu. */
  private offered: readonly CasperCommand[]
  /** The command registry once it is mounted; registrations made through it belong to this Agent's scope. */
  private commandRegistry: Pick<Context, 'commands'> | undefined
  /** Disposers of the current command registrations. */
  private readonly commandOffs: (() => void)[] = []
  /** Whether the factory published this Agent; commands are registered only from then on. */
  private published = false
  /** Reader of Casper's reported models and a pick not yet applied. */
  private readonly models: () => AgentModelsState

  /**
   * @param pluginCtx - the Casper plugin context whose services the Agent uses.
   * @param id - the Session and Agent identity.
   * @param options - Agent options; Casper chooses its own model, so they are kept unread.
   * @param session - the Session this Agent drives.
   * @param readers - model-selection and inbox projection readers.
   * @param lastTurn - the last turn number recorded in the Session.
   * @param config - the plugin config.
   * @param sidecar - the Session-to-conversation records.
   * @param commandCache - the last command list Casper sent, offered until this Agent's Casper sends its own.
   * @param modelsCache - where the model list Casper sends is kept for the next Session's picker.
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
    private readonly commandCache: CasperCommandCache,
    private readonly modelsCache: CasperModelsCache,
  ) {
    this.dispatch = agentEvents(pluginCtx, this)
    this.scope = createScope(pluginCtx, this)
    this.ctx = this.scope.ctx
    this.models = readers.agentModels
    // Casper's own models: a pick is checked against Casper's list and applied to Casper.
    this.model = new CasperModel(readers.agentModels, session, selection => this.chooseModel(selection))
    this.inbox = new ReactLoopInbox(readers.inbox, session, this.dispatch)
    this.lastTurn = lastTurn
    this.offered = commandCache.read()
    // The registry is optional: without one, Casper's commands are typed as prompt text.
    this.ctx.inject(['commands'], (commandCtx) => {
      this.commandRegistry = commandCtx
      commandCtx.effect(() => () => {
        this.commandRegistry = undefined
        this.commandOffs.length = 0
      }, 'casperAgent.commands()')
      this.registerCommands()
    })
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
    const label = (): string => this.modelLabel()
    const writer: TurnWriter = new TurnWriter({
      session: this.session,
      emit: (frame) => { this.dispatch.emit('agent/assistant-stream', { frame }) },
      turn,
      step: 1,
      nextAttempt: () => ++this.attempts,
      nextRevision: () => ++this.revision,
      // Read when each message is recorded, so a model Casper reports mid-turn labels the messages after it.
      get model() { return label() },
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
      // A pick made before Casper started or while it was busy reaches Casper before the prompt does.
      await this.applyWanted(connection, signal)
      signal.throwIfAborted()
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
        commands: (list) => { this.offerCommands(list) },
        config: () => { if (owner.connection !== undefined && owner.connection === this.connection) this.report(owner.connection) },
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
    this.report(started.connection)
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
      record: (acpId, call) => { this.sinkFor(connection)?.writer.bridged(acpId, call) },
      onError: (error) => { this.pluginCtx.logger.debug(`casper agent "${this.id}": app tools: ${error.message}`) },
    })
  }

  /**
   * Offer the commands of Casper's latest `available_commands_update`, replacing
   * the earlier list, and keep them for the next Agent's menu.
   * @param list - Casper's whole list.
   */
  private offerCommands(list: readonly AvailableCommand[]): void {
    const commands = casperCommands(list)
    if (JSON.stringify(commands) === JSON.stringify(this.offered)) return
    this.offered = commands
    this.registerCommands()
    // A failed save costs only the next Agent's early menu; this one already changed.
    this.commandCache.write(commands).catch((error: unknown) => {
      this.pluginCtx.logger.warn(`casper agent "${this.id}": command list not saved: ${String(error)}`)
    })
  }

  /**
   * Offer the commands once the factory has published this Agent. Each
   * registration emits `commands/change`, which makes every client repull its
   * Sessions' menus, and a repull resumes a Session that is not live; an Agent
   * whose creation fails therefore registers nothing, so it cannot start
   * another round.
   */
  publishCommands(): void {
    this.published = true
    this.registerCommands()
  }

  /**
   * Register the offered commands for this Agent only. A name that resolves to
   * another command, such as the app's own `/permission`, `/export`, or
   * `/feedback`, keeps that command. Each registration's line is sent to Casper
   * as a prompt; clients that know the identity send the typed line instead.
   */
  private registerCommands(): void {
    for (const off of this.commandOffs.splice(0)) off()
    const registry = this.commandRegistry?.commands
    if (registry === undefined || !this.published) return
    for (const command of this.offered) {
      // This Agent's own registrations were just removed, so any match belongs to another plugin.
      if (registry.find(this, command.name) !== undefined) continue
      this.commandOffs.push(registry.register({
        definitionId: casperCommandId(command.name),
        name: command.name,
        description: command.description,
        ...command.hint === undefined ? {} : { input: { hint: command.hint } },
        handler: ({ rawInput }) => {
          this.followup(createUserMessage({ content: [{ type: 'text', text: `/${command.name}${rawInput}` }], source: { kind: 'user' } }))
          return { kind: 'success' }
        },
      }))
    }
  }

  /**
   * Check a user's pick against Casper's list, record it, and apply it at once
   * when Casper is running and idle; otherwise the next turn applies it before
   * its prompt.
   * @param selection - the pick.
   * @returns the recorded pick; an effort the model does not offer efforts for is dropped.
   * @throws Error when Casper does not list the model or effort; CasperError `CASPER_MODEL_UNAVAILABLE` when Casper refuses it.
   */
  private async chooseModel(selection: Readonly<ModelSelection>): Promise<ModelSelection> {
    const { reported } = this.models()
    if (reported === null) throw new Error('Casper lists its models once it starts. Send your first message.')
    const label = `${selection.provider}/${selection.model}`
    const entry = reported.groups.find(group => group.id === selection.provider)?.models.find(model => model.id === selection.model)
    if (entry === undefined) throw new Error(`Casper can't use ${label}: it is not one of your signed-in models. Pick one from the list.`)
    const efforts = entry.reasoning?.efforts.map(effort => effort.id) ?? []
    const effort = selection.reasoningEffort
    if (effort !== undefined && efforts.length > 0 && !efforts.includes(effort)) {
      throw new Error(`${label} has no effort ${effort}. Choose: ${efforts.join(', ')}`)
    }
    const picked: ModelSelection = {
      provider: selection.provider,
      model: selection.model,
      ...effort === undefined || efforts.length === 0 ? {} : { reasoningEffort: effort },
    }
    this.model.select(picked)
    const connection = this.connection
    if (this.active === undefined && connection !== undefined && !connection.dead && this.models().wanted !== null) {
      await this.runMaintenance(signal => this.applyWanted(connection, signal))
    }
    return picked
  }

  /**
   * Send the recorded pick to Casper as `session/set_config_option` for the
   * model, then the effort, and report Casper's list afterwards, which
   * settles the pick. A pick recorded while the sets run is sent next, so the
   * last pick wins. ACP cannot cancel a set, so a stop kills Casper and keeps
   * the pick for the next Casper.
   * @param connection - the live connection.
   * @param signal - stops the sets.
   * @throws CasperError `CASPER_MODEL_UNAVAILABLE` when Casper does not take the pick, `CASPER_EXITED` when it exits;
   *   the stop's error when stopped.
   */
  private async applyWanted(connection: CasperConnection, signal: AbortSignal): Promise<void> {
    for (;;) {
      const { wanted } = this.models()
      if (wanted === null) return
      try {
        await this.sendPick(connection, wanted, signal)
      } catch (error: unknown) {
        if (signal.aborted) throw error
        // A newer pick replaces the one Casper refused.
        if (!samePick(this.models().wanted, wanted)) continue
        this.report(connection, true)
        if (error instanceof CasperError && error.code === 'CASPER_EXITED') throw error
        // An error reply carries Casper's own words as its cause.
        const words = error instanceof CasperError && error.cause instanceof Error ? error.cause.message : errorText(error)
        throw new CasperError('CASPER_MODEL_UNAVAILABLE', `Casper can't use ${wanted.provider}/${wanted.model}: ${words}. Pick another model.`, { cause: error })
      }
      if (samePick(this.models().wanted, wanted)) {
        this.report(connection, true)
        return
      }
    }
  }

  /** Send one pick's model, then its effort, when Casper's differ. */
  private async sendPick(connection: CasperConnection, wanted: ModelSelection, signal: AbortSignal): Promise<void> {
    const current = reportOf(connection.configOptions).current
    if (current?.provider !== wanted.provider || current.model !== wanted.model) {
      const value = valueOf(connection.configOptions, wanted)
      if (value === undefined) throw new Error('it is not one of the models this Casper offers')
      await this.setUntilStopped(connection, 'model', value, signal)
    }
    const effort = effortState(connection.configOptions)
    if (wanted.reasoningEffort !== undefined && effort !== undefined && effort.current !== wanted.reasoningEffort) {
      await this.setUntilStopped(connection, 'effort', wanted.reasoningEffort, signal)
    }
  }

  /** Set one option; a stop before Casper answers kills Casper, which has no cancel for a set. */
  private async setUntilStopped(connection: CasperConnection, configId: string, value: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const sent = connection.setConfigOption(configId, value)
    const stopped = Promise.withResolvers<'stopped'>()
    const onAbort = (): void => { stopped.resolve('stopped') }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      if (await Promise.race([sent, stopped.promise]) !== 'stopped') return
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
    sent.catch(() => {
      // Casper is being killed; its answer no longer counts.
    })
    this.dropConnection(connection)
    throw new Error('the model pick was stopped', { cause: signal.reason })
  }

  /**
   * Record Casper's current option list as its models record when it changed, and
   * keep it for the next Session's picker. While a pick waits to be applied,
   * only the apply itself reports (`settle`), so a list Casper sends meanwhile
   * does not drop the pick.
   * @param connection - the connection whose options are read.
   * @param settle - report even an unchanged list, which settles the pick.
   */
  private report(connection: CasperConnection, settle = false): void {
    const state = this.models()
    if (!settle && state.wanted !== null) return
    const options = connection.configOptions
    // A Casper without options keeps the list the Session already shows.
    if (options === undefined && (!settle || state.reported === null)) return
    const report = options === undefined && state.reported !== null ? state.reported : reportOf(options)
    if (state.wanted === null && JSON.stringify(state.reported) === JSON.stringify(report)) return
    try {
      appendPluginRecord(this.session, AGENT_MODELS_RECORD, report)
    } catch (error: unknown) {
      /* v8 ignore start -- an append fails only when the Session is closed under the Agent. */
      this.pluginCtx.logger.warn(`casper agent "${this.id}": model list not recorded: ${String(error)}`)
      return
      /* v8 ignore stop */
    }
    if (options === undefined) return
    // A failed save costs only the next Session's early picker.
    this.modelsCache.write({ groups: report.groups, current: report.current }).catch((error: unknown) => {
      this.pluginCtx.logger.warn(`casper agent "${this.id}": model list not saved: ${String(error)}`)
    })
  }

  /** The `provider/model` Casper last reported, recorded on assistant messages. */
  private modelLabel(): string {
    const current = this.models().reported?.current
    return current == null ? this.config.model ?? DEFAULT_MODEL_LABEL : `${current.provider}/${current.model}`
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
          // Only a final update closes the step; an in-progress one leaves an open box and the write path alone.
          if (update.status !== 'completed' && update.status !== 'failed') return
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

/** Whether two picks name the same model and effort. */
function samePick(left: ModelSelection | null, right: ModelSelection): boolean {
  return left?.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
}

function errorText(error: unknown): string {
  /* v8 ignore next -- a pick fails with an Error: its own refusal or the connection's. */
  return error instanceof Error ? error.message : String(error)
}

/** Structured failure of a turn. */
function failureOf(error: unknown): LlmFailure {
  if (error instanceof CasperError) return { code: error.code, message: error.message }
  return { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }
}
