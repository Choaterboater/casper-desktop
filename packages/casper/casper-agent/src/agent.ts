/**
 * The Agent that drives one Session through a `casper acp` process.
 * @module @deepseek-ai/dsh-casper-agent/agent
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  AvailableCommand,
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  StopReason,
} from '@agentclientprotocol/sdk'
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
  PreStepDecision,
} from '@deepseek-ai/dsh-agent'
import { AGENT_MODELS_RECORD, agentEvents } from '@deepseek-ai/dsh-agent'
import { ReactLoopInbox } from '@deepseek-ai/dsh-agent-loop'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-attachment'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
// Type-only: `ctx.mcpManager`, whose Settings and plugin-registered servers are handed to Casper.
import type {} from '@deepseek-ai/dsh-mcp-manager'
import { CUSTOM_PRESET } from '@deepseek-ai/dsh-permission-presets'
// Type-only: the `plan/mode` event and the `plan` projection the composer's plan chip reads.
import type { PlanUnitState } from '@deepseek-ai/dsh-plan-mode'
// Type-only: the `sandbox/mode` event the access chip writes, and `ctx.sandboxPolicy`.
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
// Type-only: `ctx.sessionReferenceResolver`, which reads the Sessions a message mentions.
import type {} from '@deepseek-ai/dsh-session-reference'
// `ctx.sessionTitle`, which writes the Session's title, and the shape a title Casper sends is written in.
import { normalizeSessionTitle, SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import { ACCESS_MODE_IDS, ACCESS_MODE_LABELS, accessModeFor } from './access.ts'
import type { AccessModeId } from './access.ts'
import { ACCESS_RECORD } from './access-record.ts'
import type { CasperOwnAccess } from './access-record.ts'
import { appReadRoots, isInstalled, selfAnchor } from './app-read.ts'
import { matchChildRoute, routedOptions } from './child-route.ts'
import { startAppTools } from './app-tools.ts'
import type { AppToolsProfile, AppToolsServer } from './app-tools.ts'
import { casperCommandId, casperCommands } from './commands.ts'
import type { CasperCommand, CasperCommandCache } from './commands.ts'
import type { Config } from './config.ts'
import { CasperConnection, CasperError } from './connection.ts'
import type { PromptReply } from './connection.ts'
import { CONVERSATION_RECORD, conversationRecord } from './conversation.ts'
import type { ForkPoint } from './conversation.ts'
import { answerElicitation, elicitationQuestion, elicitationStep } from './elicitation.ts'
import { forwardedServers } from './forward-servers.ts'
import type { ForwardedServers } from './forward-servers.ts'
import { CasperModel } from './model.ts'
import { effortState, reportOf, valueOf } from './models.ts'
import type { CasperModelsCache } from './models-cache.ts'
import { answerPermission } from './permission.ts'
import { hasPromptContent, promptContent } from './prompt.ts'
import { casperReceiptOf, usageModelOf, usageOf } from './receipt.ts'
import { hasSessionReference, prepareReferences } from './references.ts'
import type { PreparedReference, PreparedReferences } from './references.ts'
import type { CasperSidecar } from './sidecar.ts'
import { CASPER_PROVIDER, TurnWriter } from './turn.ts'

/** Text that opens a turn whose earlier Casper conversation could not be reopened. */
export const FRESH_CONVERSATION_NOTICE = 'Casper could not reopen its earlier conversation, so this turn starts fresh.\n'

/** Text that opens a fork's first turn when Casper's conversation was not copied into it. */
export const FORK_FRESH_NOTICE = 'This fork starts a fresh Casper conversation, so Casper does not have the messages above.\n'

/** Text that opens a fork's first turn when Casper's copy ends before a stopped or failed request the fork shows. */
export const FORK_BEHIND_NOTICE = 'Casper\'s copy of this conversation ends before the last request, which was stopped or failed, so Casper may not have that request.\n'

/** Model name recorded on assistant messages when the config sets none. */
const DEFAULT_MODEL_LABEL = 'casper'

/** The title source of a name Casper sent; no model made it, so it names none. */
const CASPER_TITLE_PROVIDER = SessionTitleProviderId('casper')

/** The byte cap a title Casper sends is cut to: the app's `maxTitleBytes` in the base bundle. */
const CASPER_TITLE_BYTES = 80

/** The error of a turn that would start Casper after the Agent closed. */
const CLOSING_MESSAGE = 'This session is closing, so Casper was not started.'

/** Projection readers the factory passes to each Agent. */
export interface CasperAgentReaders {
  /** Casper's reported models and a pick not yet applied. */
  readonly agentModels: () => AgentModelsState
  /** Current queued and claimed input. */
  readonly inbox: () => InboxState
  /** The Session's logged Plan first state, which the composer's plan chip shows. */
  readonly plan: () => PlanUnitState
  /** The access mode Casper picked itself, as last recorded; the composer's mode pill shows it. */
  readonly casperAccess: () => CasperOwnAccess
}

/** The steering one prompt has sent to Casper. */
interface PromptSteers {
  /** Ids of the lines sent, whatever Casper replied. */
  readonly forwarded: Set<MessageId>
  /** Each line as it was sent, until Casper says the AI read it or refuses it. */
  readonly accepted: Map<MessageId, UserMessage>
  /** Set once Casper refuses a line: later lines wait for the next turn too, so the lines keep their order. */
  closed: boolean
  /** The sends in flight, one at a time in queue order. */
  chain: Promise<void>
}

/** Where the current prompt's updates go: its connection, turn writer, and turn signal. */
interface PromptSink {
  readonly connection: CasperConnection
  readonly writer: TurnWriter
  readonly signal: AbortSignal
  /** The turn the prompt belongs to; a steered line Casper reads is claimed for it. */
  readonly turn: number
  /** The steering sent during this prompt. */
  readonly steers: PromptSteers
  /**
   * Stop the prompt so the turn ends with `error` instead of Casper's reply.
   * @param error - the turn's error.
   */
  stop(error: CasperError): void
}

/** The outcome of bringing Casper's access mode to the chip's. */
interface AccessSync {
  /** The mode the chip asks for. */
  readonly wanted: AccessModeId
  /** Why Casper is not in that mode, when it is not. */
  readonly failure?: unknown
}

/** A queued line whose mentions were read, as it was when read. */
interface ReadLine {
  /** The line; a line edited since is a new object, and is read again. */
  readonly message: UserMessage
  /** Its prepared mentions; undefined when it names no Session. */
  readonly reference: PreparedReference | undefined
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'maintenance'; abort: AbortController; wakeRequested: boolean }
  | { kind: 'running'; abort: AbortController; wakeRequested: boolean }

/**
 * Whether a line is one of the app's automatic goal rounds, which the goal round driver queues.
 * @param message - a queued line.
 * @returns true for a `goal` source with a positive round.
 */
function isGoalRound(message: UserMessage): boolean {
  // The `goal` source kind belongs to the goal package, which this package does not depend on.
  const source: { readonly kind: string; readonly round?: unknown } = message.source
  return source.kind === 'goal' && Number(source.round) > 0
}

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
 * Steering during a prompt goes to a Casper that takes it (`_casper/steer`)
 * and is recorded as a step's `user/message` once Casper says the AI read it;
 * a line Casper refuses or never reads, and any line for an older Casper, run
 * as the next turn. The process starts at the first prompt and restarts after
 * an exit; once the Agent has sat idle for `idleExitMs` and Casper says nothing
 * of it is still at work, the process is closed and the next prompt reopens it.
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
  /** The open questions of each step, by ACP id; the step's final update withdraws them all. */
  private readonly asks = new Map<string, Set<AbortController>>()
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
  /** Access syncs run one at a time, in the order the chip changed. */
  private accessChain: Promise<unknown> = Promise.resolve()
  /** Whether a live sync waits in the chain; one preset switch writes several events, and one sync covers them all. */
  private liveAccessQueued = false
  /** The access mode this app last set on each connection; a mode Casper picks itself is kept until the chip changes. */
  private readonly accessSet = new WeakMap<CasperConnection, AccessModeId>()
  /** A chip switch that failed while no prompt was open, kept for a turn that is preparing its prompt. */
  private lateAccess: AccessSync | undefined
  /** Reader of the Session's logged Plan first state. */
  private readonly planState: () => PlanUnitState
  /** Reader of the recorded access mode Casper picked itself. */
  private readonly ownAccessState: () => CasperOwnAccess
  /**
   * Connections whose Plan first value is the Session's: the restore ran or was not needed, or the user set it.
   * Until then a restarted Casper's own default is never recorded.
   */
  private readonly planRestored = new WeakSet<CasperConnection>()
  /** Ids of the pending lines queued by {@link steer}; only these go to Casper during a prompt. */
  private readonly steerIds = new Set<MessageId>()
  /** Ids of the steered lines the AI read whose `user/message` still waits for open calls; {@link cancel} keeps them queued. */
  private readonly readSteers = new Set<MessageId>()
  /** Set while a turn reads the Sessions its queued lines mention; {@link cancel} claims the lines first. */
  private claimEarly: (() => void) | undefined
  /** Fires the idle check once the Agent has sat idle for `idleExitMs` with a live Casper. */
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  /** Stops the idle check in flight when the Agent closes. */
  private idleCheck: AbortController | undefined
  /** Counts each start of a turn, maintenance job, access sync, and Plan first set; a check that saw another count closes nothing. */
  private activityCount = 0
  /** Access syncs and Plan first sets still running; Casper is not closed under one. */
  private sideJobs = 0
  /** The closes of earlier processes: the next process starts, and {@link closeConnection} ends, only after they finish. */
  private closing: Promise<void> = Promise.resolve()
  /** The model of the process closed while idle, until the next process opens its conversation. */
  private reapedModel: string | undefined
  /** Set by {@link closeConnection}: no idle check runs and no process starts after it. */
  private closed = false
  /** The app route matching Casper's current model, which {@link options} follow; undefined uses the start options. */
  private childRoute: ModelSelection | undefined
  /** The `provider/model/effort` {@link childRoute} was looked up for. */
  private childRouteKey: string | undefined
  /** Counts each lookup of {@link childRoute}; a lookup that sees another count is dropped. */
  private childRouteSeq = 0
  /** Stops the lookup in flight when the Agent closes. */
  private readonly childRouteStop = new AbortController()
  /**
   * The app's options for this Agent. With `casperChildModel` on, provider, model and effort follow Casper's
   * current model while the app has the same route, so a child of this Session and the app tools that read
   * the parent's route use it; otherwise, and with the switch off, they are the options it was created with.
   */
  readonly options: AgentOptions

  /**
   * @param pluginCtx - the Casper plugin context whose services the Agent uses.
   * @param id - the Session and Agent identity.
   * @param startOptions - the options the Agent was created with: the title reads their route with casperTitles off,
   *   and so do children while the app has no route for Casper's current model.
   * @param session - the Session this Agent drives.
   * @param readers - model-selection, inbox, plan, and Casper's own access projection readers.
   * @param lastTurn - the last turn number recorded in the Session.
   * @param config - the plugin config.
   * @param sidecar - the Session-to-conversation records.
   * @param commandCache - the last command list Casper sent, offered until this Agent's Casper sends its own.
   * @param modelsCache - where the model list Casper sends is kept for the next Session's picker.
   * @param fork - for a fork that has not started its own conversation, the inherited conversation record to copy, or
   *   null when it inherited none; undefined for any other Session.
   */
  constructor(
    private readonly pluginCtx: Context,
    readonly id: SessionId,
    private readonly startOptions: AgentOptions,
    readonly session: Session,
    readers: CasperAgentReaders,
    lastTurn: number,
    private readonly config: Config,
    private readonly sidecar: CasperSidecar,
    private readonly commandCache: CasperCommandCache,
    private readonly modelsCache: CasperModelsCache,
    private fork: ForkPoint | null | undefined,
  ) {
    this.dispatch = agentEvents(pluginCtx, this)
    this.scope = createScope(pluginCtx, this)
    this.ctx = this.scope.ctx
    this.models = readers.agentModels
    this.planState = readers.plan
    this.ownAccessState = readers.casperAccess
    // Casper's own models: a pick is checked against Casper's list and applied to Casper.
    this.model = new CasperModel(readers.agentModels, session, selection => this.chooseModel(selection))
    this.options = config.casperChildModel ? routedOptions(startOptions, () => this.childRoute) : startOptions
    if (config.casperChildModel) {
      // A resumed Session's recorded model counts at once; a route the app adds later is matched when it appears.
      this.matchChildRoute()
      this.ctx.on('llm/adapters-updated', () => { this.matchChildRoute(true) })
      this.ctx.effect(() => () => { this.childRouteStop.abort() }, 'casperAgent.childRoute()')
    }
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
    // The access chip: a preset, sandbox, or approval switch reaches a running Casper at once, even mid-prompt.
    this.ctx.on('session/event', (subject, event) => {
      /* v8 ignore next -- agent-scoped dispatch delivers only this Agent's Session; the check keeps it so under a shared scope. */
      if (subject !== this.session) return
      if (event.type === 'permission/preset' || event.type === 'sandbox/mode' || event.type === 'approval/policy') this.queueLiveAccess()
    })
  }

  get status(): AgentStatus {
    return this.phase.kind === 'running' ? 'running' : 'idle'
  }

  private setPhase(next: Phase): void {
    const previous = this.status
    this.phase = next
    // Work starts only while idle and always ends in idle, so each change enters or leaves idle.
    if (next.kind === 'idle') {
      this.armIdle()
    } else {
      this.activityCount++
      this.disarmIdle()
    }
    if (this.status !== previous) this.dispatch.emit('agent/status', { status: this.status })
  }

  /** Start the idle time when the Agent is idle with a live Casper and `idleExitMs` is not 0. */
  private armIdle(): void {
    this.disarmIdle()
    const connection = this.connection
    // A check in flight starts the idle time again itself when it keeps Casper.
    if (this.closed || this.config.idleExitMs === 0 || this.active !== undefined || this.idleCheck !== undefined) return
    if (connection === undefined || connection.dead) return
    this.idleTimer = setTimeout(() => { void this.reapIdle() }, this.config.idleExitMs)
    // The idle time never keeps the app running.
    this.idleTimer.unref()
  }

  private disarmIdle(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  /**
   * After the idle time, ask Casper whether it may be closed, and close it when
   * it says so and nothing started meanwhile. This is not maintenance: a turn or
   * a model pick during the check runs as usual on the live process and keeps it.
   * A Casper that is not idle, or does not know the request, is asked again after
   * another idle time. The next prompt reopens the conversation with `session/load`.
   */
  private async reapIdle(): Promise<void> {
    this.idleTimer = undefined
    const connection = this.connection
    if (this.closed || this.active !== undefined || connection === undefined || connection.dead) return
    const seen = this.activityCount
    const check = new AbortController()
    this.idleCheck = check
    const idle = await connection.idle(check.signal)
    this.settleIdleCheck(connection, seen, idle)
  }

  /**
   * Act on Casper's idle answer, reading the Agent as it is now.
   * @param connection - the connection that was asked.
   * @param seen - the activity count when the check started.
   * @param idle - Casper's answer.
   */
  private settleIdleCheck(connection: CasperConnection, seen: number, idle: boolean): void {
    // No other check starts while this one is pending.
    this.idleCheck = undefined
    if (this.closed || this.connection !== connection || connection.dead) return
    if (!idle || this.active !== undefined || this.activityCount !== seen || this.sideJobs > 0) {
      // A turn running now starts the idle time again when it ends.
      if (this.active === undefined) this.armIdle()
      return
    }
    this.reapedModel = modelOf(connection)
    this.connection = undefined
    this.pluginCtx.logger.debug(`casper agent "${this.id}": Casper sat idle, so its process is closed until the next prompt`)
    this.closeLater(connection)
  }

  /** Close a process the Agent no longer uses; the next process and {@link closeConnection} wait for it. */
  private closeLater(connection: CasperConnection): void {
    // A mode Casper picked itself ends with its process.
    this.noteOwnAccess()
    const closed = connection.dispose().catch(
      /* v8 ignore next -- dispose fails only when the app tools listener cannot close. */
      (error: unknown) => { this.pluginCtx.logger.warn(`casper agent "${this.id}": Casper did not close cleanly: ${String(error)}`) },
    )
    this.closing = Promise.all([this.closing, closed]).then(() => {})
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
   * Queue steering and send it to the prompt in flight when Casper takes
   * steering; otherwise, or when Casper does not read it, the next turn claims it.
   * @param prompt - the user message.
   */
  steer(prompt: UserMessage): void {
    this.steerIds.add(prompt.id)
    this.send(prompt, 'next-step', true)
    this.forwardSteers()
  }

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
    this.claimEarly?.()
    if (options.keepInbox !== true) {
      this.clearInbox()
      if (active !== undefined) active.wakeRequested = false
    }
    active?.abort.abort(cause)
  }

  /**
   * Cancel the queued input, except the steered lines the AI read: each stays
   * queued until the turn's end writes it, right after its claim.
   */
  private clearInbox(): void {
    if (this.readSteers.size === 0) {
      this.inbox.clear()
      return
    }
    for (const message of this.inbox.nextStep) if (!this.readSteers.has(message.id)) this.inbox.remove(message.id)
    this.inbox.splice('next-turn', 0, this.inbox.nextTurn.length, [])
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
    this.closed = true
    this.disarmIdle()
    this.idleCheck?.abort()
    const connection = this.connection
    this.connection = undefined
    // A mode Casper picked itself ends with its process; recorded while the Session is still open.
    this.noteOwnAccess()
    // A process closed earlier, while idle or for changed servers, is part of the range too.
    await Promise.all([this.closing, connection?.dispose()])
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
    const held = { goalRound: false }
    try {
      reason = await this.runTurn(turn, signal, (current) => { step = current }, () => { held.goalRound = true })
      // As in the app's own loop, a goal round that ends with an error stops the goal's automatic rounds.
      if (reason.kind === 'error' && held.goalRound) this.dispatch.emit('agent/error', { turn, step, error: reason.error })
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
    // A `/plan` sent as a prompt, with or without words, settles to the value Casper ends the turn with.
    this.syncPlan()
    await this.flush()
    if (signal.aborted || !this.inbox.hasPending) return false
    phase.abort = new AbortController()
    phase.wakeRequested = false
    return true
  }

  private async runTurn(
    turn: number, signal: AbortSignal, onStep: (step: number) => void, onGoalRound: () => void,
  ): Promise<TurnEndReason> {
    // Mentioned Sessions are read before Casper starts, so a mention that can't be sent ends the turn without one.
    // The lines stay queued during the read, so a crash then keeps them; a line edited meanwhile is read again.
    const resolver = this.pluginCtx.get('sessionReferenceResolver')
    const read = new Map<MessageId, ReadLine>()
    let readFailure: { readonly error: unknown } | undefined
    let early: UserMessage[] | undefined
    // A Stop during the read claims the lines first, so the turn it ends keeps them. A goal round is never
    // logged unchecked: it is dropped, and the goal round driver pauses its goal when the turn ends.
    this.claimEarly = () => {
      this.claimEarly = undefined
      early = this.claimLines(turn).filter(message => !isGoalRound(message))
      this.logClaimed(turn, early, undefined, onStep)
    }
    try {
      for (;;) {
        const fresh = this.nextTurnLines().filter(message => read.get(message.id)?.message !== message)
        if (resolver === undefined || !fresh.some(hasSessionReference)) break
        const prepared = await prepareReferences(this, resolver, fresh, this.modelLabel(), signal)
        for (const message of fresh) read.set(message.id, { message, reference: prepared.get(message.id) })
      }
    } catch (error: unknown) {
      readFailure = { error }
    } finally {
      this.claimEarly = undefined
    }
    // Claimed in the same tick as the last check, so every claimed mention has been read.
    let claimed = early
    if (claimed === undefined) {
      const lines = this.claimLines(turn)
      // Only a goal round waits for the goal round driver's check; any other turn logs its lines in this tick.
      const admitted = lines.some(isGoalRound) ? await this.admitGoalRound(lines, turn, signal) : lines
      if (admitted === undefined) return { kind: 'blocked' }
      claimed = admitted
      if (claimed.some(isGoalRound)) onGoalRound()
      this.logClaimed(turn, claimed, readFailure === undefined ? read : undefined, onStep)
    }
    if (claimed.length === 0) {
      /* v8 ignore next -- a failed read's lines leave the queue only by hand meanwhile */
      if (readFailure !== undefined) throw readFailure.error
      return { kind: 'completed' }
    }
    const references: PreparedReferences = new Map(claimed.flatMap((message) => {
      const line = read.get(message.id)
      return line?.message === message && line.reference !== undefined ? [[message.id, line.reference] as const] : []
    }))
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
    let sink: PromptSink | undefined
    let answered: PromptReply | undefined
    try {
      if (readFailure !== undefined) throw readFailure.error
      if (!hasPromptContent(claimed)) throw new CasperError('CASPER_EMPTY_PROMPT', 'The request is empty, so nothing was sent to Casper.')
      // The prompt and its turn are durable before Casper can change files.
      await this.flush(true)
      signal.throwIfAborted()
      // Between turns, never during a prompt: changed Settings servers reopen Casper through session/load.
      await this.refreshServers(signal)
      signal.throwIfAborted()
      const opened = await this.ensureConnection(signal)
      connection = opened.connection
      // Said at once, also when a Stop came during the start: the conversation is new even when this turn sends nothing,
      // and the next start reopens it with no line.
      if (opened.fresh) writer.text(FRESH_CONVERSATION_NOTICE)
      if (opened.note !== undefined) writer.text(opened.note)
      signal.throwIfAborted()
      // Access goes first: it is the safety step.
      const accessNote = await this.applyAccess(connection)
      signal.throwIfAborted()
      // A pick made before Casper started or while it was busy reaches Casper before the prompt does.
      await this.applyWanted(connection, signal)
      signal.throwIfAborted()
      // A new Casper keeps the Session's Plan first setting, also when its first turn ended before the restore.
      if (!this.planRestored.has(connection)) await this.applyPlan(connection, signal)
      signal.throwIfAborted()
      const content = await promptContent(claimed, {
        attachments: this.pluginCtx.get('attachments'), images: connection.acceptsImages, signal, references, embedded: connection.acceptsEmbeddedContext,
      })
      // A store may finish a read after a Stop; the prompt is then not sent.
      signal.throwIfAborted()
      if (!content.readable) {
        const pictures = !connection.acceptsImages && claimed.some(message => message.content.some(block => block.type === 'image'))
        throw new CasperError('CASPER_EMPTY_PROMPT', pictures
          ? 'This Casper can\'t take pictures, and the request has no words. Update Casper to send pictures.'
          : 'The attachments could not be read, and the request has no words, so nothing was sent to Casper.')
      }
      // A chip switch that failed after the access step counts as if it failed during the prompt.
      const lateNote = this.lateAccessNote()
      this.updateFailure = undefined
      const stopper = new AbortController()
      const promptSignal = AbortSignal.any([signal, stopper.signal])
      sink = {
        connection, writer, signal: promptSignal, turn,
        steers: { forwarded: new Set(), accepted: new Map(), closed: false, chain: Promise.resolve() },
        stop: (error) => {
          this.updateFailure ??= error
          stopper.abort({ kind: 'user' } satisfies AgentCancelCause)
        },
      }
      this.sink = sink
      if (accessNote !== undefined) writer.text(accessNote)
      if (lateNote !== undefined) writer.text(lateNote)
      for (const note of content.notes) writer.text(note)
      try {
        // Casper's conversation moved on whatever the turn ends with, so the reply is recorded even when the turn fails.
        answered = await this.promptUntilSettled(connection, content.blocks, promptSignal)
      } catch (error: unknown) {
        // A prompt stopped because the chip's mode could not reach Casper ends with that error.
        throw this.takeUpdateFailure() ?? error
      }
      const failure = this.takeUpdateFailure()
      /* v8 ignore next -- see record(). */
      if (failure !== undefined) throw failure
      interrupted = answered.stopReason !== 'end_turn'
      return turnEndFor(answered.stopReason)
    } finally {
      this.sink = undefined
      for (const asks of this.asks.values()) for (const ask of asks) ask.abort()
      this.asks.clear()
      // A send still in flight settles first, so the next turn's claim and its own prompt come after its reply.
      if (sink !== undefined) await settlesWithin(sink.steers.chain, this.config.cancelGraceMs)
      onStep(writer.step)
      writer.close(interrupted)
      // After the turn's last step and before its `turn/end`, so a fork can cut the conversation at this turn.
      if (answered !== undefined) this.recordConversation(answered)
    }
  }

  /**
   * Record which Casper conversation the prompt reply ended, and Casper's mark when it sent one.
   * A failed record costs only an exact fork at this turn, never the turn.
   * @param reply - the prompt's reply.
   */
  private recordConversation(reply: PromptReply): void {
    try {
      appendPluginRecord(this.session, CONVERSATION_RECORD, conversationRecord(reply.acpSessionId, reply.mark))
    } catch (error: unknown) {
      /* v8 ignore start -- an append fails only when the Session is closed under the Agent. */
      this.pluginCtx.logger.warn(`casper agent "${this.id}": conversation not recorded: ${String(error)}`)
      /* v8 ignore stop */
    }
  }

  /** The lines the next turn claims: the queued steering, then the first queued prompt. */
  private nextTurnLines(): UserMessage[] {
    return [...this.inbox.nextStep, ...this.inbox.nextTurn.slice(0, 1)]
  }

  /**
   * Claim the turn's lines: the queued steering, then the first queued prompt.
   * @param turn - the turn that claims the lines.
   * @returns the claimed lines.
   */
  private claimLines(turn: number): UserMessage[] {
    const claimed = this.inbox.claim('next-turn', turn)
    // A claimed line is this turn's prompt, never steering.
    for (const message of claimed) this.steerIds.delete(message.id)
    return claimed
  }

  /**
   * Run the app's step check for claimed lines that hold a goal round, as the
   * DeepSeek loop does before a step: the goal round driver refuses a round
   * that is no longer current, such as one queued before `/goal edit`, pause
   * or clear, and puts the other lines back in the queue. Only a refusal
   * counts: lines the check adds or rewrites are for the DeepSeek loop's
   * request, and Casper reads its own skills and mentions. With `appGoals`
   * off the round is dropped instead, and the driver pauses the goal.
   * @param lines - the claimed lines, a goal round among them.
   * @param turn - the turn that claimed them.
   * @param signal - the turn's signal.
   * @returns the lines to log and send, or undefined when the turn ends blocked without them.
   * @throws the turn's abort when it stops during the check; nothing is logged then.
   */
  private async admitGoalRound(lines: UserMessage[], turn: number, signal: AbortSignal): Promise<UserMessage[] | undefined> {
    if (!this.config.appGoals) {
      const others = lines.filter(message => !isGoalRound(message))
      return others.length === 0 ? undefined : others
    }
    const decision = await this.dispatch.waterfall(
      'agent/pre-step',
      { messages: lines, turn, step: 1, signal, modelSelection: this.routeSelection() },
      () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages: lines }),
    )
    // As in the DeepSeek loop, a Stop during the check logs nothing; the driver put the other lines back.
    signal.throwIfAborted()
    return decision.kind === 'reject' ? undefined : lines
  }

  /**
   * The route the app's step and tool checks read for this Agent: Casper's
   * model, or the configured label before Casper reported one.
   * @returns a detached selection.
   */
  private routeSelection(): ModelSelection {
    return this.model.current() ?? { provider: CASPER_PROVIDER, model: this.modelLabel() }
  }

  /**
   * Log claimed lines, so no line sent to Casper is missing from the log. Each
   * snapshot is logged right after the message that mentions it, in the
   * prompt's order, as a Standard Session logs it.
   * @param turn - the turn that claimed the lines.
   * @param claimed - the lines to log.
   * @param read - the lines whose mentions were read; undefined logs no snapshot.
   * @param onStep - told the step the lines open.
   */
  private logClaimed(
    turn: number,
    claimed: readonly UserMessage[],
    read: ReadonlyMap<MessageId, ReadLine> | undefined,
    onStep: (step: number) => void,
  ): void {
    if (claimed.length === 0) return
    this.session.append('step/start', { turn, step: 1 })
    onStep(1)
    for (const message of claimed) {
      this.session.append('user/message', message, { surfaceOp: 'append' })
      const line = read?.get(message.id)
      if (line?.message === message && line.reference !== undefined) this.session.append('user/message', line.reference.context, { surfaceOp: 'append' })
    }
    this.startTitle()
  }

  /**
   * Start the title the prompt queued. A Standard Session's title starts when
   * its first model request is logged; Casper's requests never are, so it
   * starts here on the app's default model, the route a new Standard Session
   * sends its first request on. A renamed title queues nothing. With
   * `casperTitles` on, the name Casper sends is the title and no model is asked.
   */
  private startTitle(): void {
    if (this.config.casperTitles) return
    const { provider, model } = this.startOptions
    if (provider === undefined || model === undefined) return
    this.pluginCtx.get('sessionTitle')?.startQueued(this.session, { provider, model })
  }

  /**
   * Write the name Casper sent as the Session title, the way the app writes one:
   * a title the person renamed is never written over, the same name is not
   * written twice, and the title cites the human messages the current one
   * cites, so a Session with no title yet takes none.
   * @param text - the name from Casper's `session_info_update`.
   */
  private casperTitle(text: string): void {
    const titles = this.pluginCtx.get('sessionTitle')
    if (!this.config.casperTitles || this.closed || titles === undefined) return
    try {
      const current = titles.get(this.session)
      if (current === undefined || current.source.kind === 'user') return
      const title = normalizeSessionTitle(text, CASPER_TITLE_BYTES)
      if (title.length === 0 || title === current.title) return
      this.session.append('session/title', { title, messageSeqs: [...current.messageSeqs], source: { kind: 'provider', provider: CASPER_TITLE_PROVIDER } })
    } catch (error: unknown) {
      this.pluginCtx.logger.warn(`casper agent "${this.id}": Casper's title not written: ${String(error)}`)
    }
  }

  /** Send the prompt; on abort send `session/cancel` and wait the cancel grace before killing Casper. */
  private async promptUntilSettled(connection: CasperConnection, blocks: Parameters<CasperConnection['prompt']>[0], signal: AbortSignal): Promise<PromptReply> {
    const reply = connection.prompt(blocks)
    // Steering queued while the prompt was prepared goes after it, so Casper has a prompt to steer.
    this.forwardSteers()
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

  /**
   * The live connection, or a new process that reopens the stored conversation. A process closed earlier exits first.
   * A fork with no conversation of its own copies the source's, cut at the inherited mark, or starts fresh with a note.
   * A closed Agent starts none, and a process that finishes starting after the close is closed at once.
   * @returns the connection, whether its conversation is new, and a note when a fork's conversation was not copied or
   *   a Casper closed while idle came back on another model.
   */
  private async ensureConnection(signal: AbortSignal): Promise<{ connection: CasperConnection; fresh: boolean; note?: string }> {
    await settledUnlessStopped(this.closing, signal)
    if (this.closed) throw new CasperError('CASPER_START_FAILED', CLOSING_MESSAGE)
    const live = this.connection
    if (live !== undefined && !live.dead) return { connection: live, fresh: false }
    if (live !== undefined) this.dropConnection(live)
    const cwd = this.session.header.cwd
    if (cwd === undefined) throw new CasperError('CASPER_START_FAILED', 'Casper needs a project folder for this session.')
    const stored = this.sidecar.read(this.id, cwd)
    // A fork that already has a conversation, even in another folder, never copies again.
    const fork = stored === undefined && !this.sidecar.has(this.id) ? this.fork : undefined
    // Only a mark proves an exact copy: the source may have gone on in the same conversation since.
    const copy = fork?.mark !== undefined && this.config.copyOnFork ? { acpSessionId: fork.acpSessionId, at: fork.mark } : undefined
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
        // A name is the conversation's, whichever process sends it, and the one sent after a load reply comes before the start ends.
        title: (text) => { this.casperTitle(text) },
        config: () => { if (owner.connection !== undefined && owner.connection === this.connection) this.report(owner.connection) },
        // Casper's own mode change is kept, never copied to the chip; only Read only is restored.
        mode: () => { if (owner.connection !== undefined && owner.connection === this.connection) this.queueLiveAccess() },
        // Casper's Plan first value is the chip's, whoever changed it.
        plan: () => { if (owner.connection !== undefined && owner.connection === this.connection) this.syncPlan() },
        // A crash ends a mode Casper picked itself; the record follows the live connection, so a late exit clears nothing new.
        exit: () => { this.noteOwnAccess() },
        permission: (params, signal) => this.permission(owner.connection, params, signal),
        elicitation: (params, signal) => this.elicitation(owner.connection, params, signal),
      },
      appTools: this.config.appTools ? connection => this.startAppTools(connection, cwd, profile) : undefined,
      mcpServers: this.forwarder(),
      fork: copy,
    }, stored?.acpSessionId, signal)
    owner.connection = started.connection
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- closeConnection() can run during the start.
    if (this.closed) {
      await started.connection.dispose()
      throw new CasperError('CASPER_START_FAILED', CLOSING_MESSAGE)
    }
    try {
      await this.sidecar.write(this.id, { acpSessionId: started.acpSessionId, cwd })
    } catch (error: unknown) {
      started.connection.terminate()
      throw new CasperError('CASPER_START_FAILED', `Casper's conversation could not be recorded: ${String(error)}`, { cause: error })
    }
    this.fork = undefined
    this.connection = started.connection
    this.report(started.connection)
    const fresh = stored !== undefined && !started.reopened
    const before = this.reapedModel
    this.reapedModel = undefined
    const after = modelOf(started.connection)
    // A fork starts a conversation, never reopens one, so this note is the only one.
    if (fork !== undefined && !started.copied) return { connection: started.connection, fresh, note: FORK_FRESH_NOTICE }
    if (fork?.behind === true) return { connection: started.connection, fresh, note: FORK_BEHIND_NOTICE }
    // The reopened conversation goes on with its own model (Casper's decision 89); a pick waiting to be sent decides instead.
    if (!started.reopened || before === undefined || after === undefined || after === before || this.models().wanted !== null) {
      return { connection: started.connection, fresh }
    }
    return { connection: started.connection, fresh, note: `[Casper reopened on ${after}; it was ${before}.]\n` }
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
      resourceServers: () => connection.forwardedNames,
      subagents: this.config.appSubagents,
      goals: this.config.appGoals,
      teams: this.config.appTeams,
      route: () => this.routeSelection(),
      // A child the app's subagent tool starts is attributed to this Agent, as a Standard parent's tool call is.
      initiate: operation => this.pluginCtx.agents.withInitiator(this, operation),
      onError: (error) => { this.pluginCtx.logger.debug(`casper agent "${this.id}": app tools: ${error.message}`) },
    })
  }

  /**
   * The builder of the Settings servers, then the plugin-registered ones unless `forwardPluginMcpServers` is off,
   * handed to Casper, when forwarding is on and the app has an MCP manager. Each build reads both again, so a plugin
   * that loads or unloads reaches Casper at the next turn. A server left out is logged with its reason, never with a value.
   * @returns the builder, or undefined when nothing is forwarded.
   */
  private forwarder(): ((signal: AbortSignal) => Promise<ForwardedServers>) | undefined {
    const manager = this.pluginCtx.get('mcpManager')
    if (!this.config.forwardMcpServers || manager === undefined) return undefined
    return (signal) => {
      const credentials = this.pluginCtx.get('credentials')
      return forwardedServers({
        entries: manager.config.servers.get(),
        registered: this.config.forwardPluginMcpServers ? manager.registeredEntries() : {},
        // Without a credentials provider, a server that names a credential is left out as not set.
        credential: ref => credentials === undefined
          ? Promise.resolve(undefined)
          : credentials.resolve(ref as CredentialRef).then(found => found?.value),
        resolveExecutable: (command, env, lookup) => this.pluginCtx.subprocess.resolveExecutable(command, env, lookup),
        signal,
        skip: (name, reason) => { this.pluginCtx.logger.info(`casper agent "${this.id}": the MCP server ${name} is not handed to Casper: ${reason}`) },
      })
    }
  }

  /**
   * Before a turn, rebuild the Settings and plugin-registered servers the live Casper was handed. When they changed, Casper is closed, and
   * this turn reopens it through `session/load` with the new list; the session's "Yes, for this session" answers end
   * with it. A rebuild that fails keeps the live Casper, and so does one that leaves out a server Casper was handed for
   * a reason that may pass, so a slow credential store neither drops that server nor restarts Casper twice, unless
   * another server Casper was handed is now turned off, removed or refused for good.
   * @param signal - the turn's signal.
   */
  private async refreshServers(signal: AbortSignal): Promise<void> {
    const live = this.connection
    const build = this.forwarder()
    if (live === undefined || live.dead || live.forwardedDigest === undefined || build === undefined) return
    let rebuilt: ForwardedServers
    try {
      rebuilt = await build(signal)
    } catch (error: unknown) {
      signal.throwIfAborted()
      /* v8 ignore next 2 -- the builder turns each server's failure into a skip; only reading the entries can throw. */
      this.pluginCtx.logger.warn(`casper agent "${this.id}": the MCP servers were not rebuilt: ${String(error)}`)
      return
    }
    // A handed server now turned off, removed or refused for good always reaches Casper, whatever else is passing.
    const gone = live.forwardedNames.some(name => !rebuilt.names.includes(name) && !rebuilt.passing.includes(name))
    if (!gone && rebuilt.passing.some(name => live.forwardedNames.includes(name))) return
    if (rebuilt.digest === live.forwardedDigest || live !== this.connection) return
    // The old process exits before the new one opens the same conversation, and before the Agent's own close ends.
    this.connection = undefined
    this.closeLater(live)
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
   * `/plan on` and `/plan off` (the plan chip's exit runs `/plan off`) set
   * Casper's Plan first option instead when the running Casper offers it.
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
          const plan = command.name === 'plan' ? this.planSwitch(rawInput) : undefined
          if (plan !== undefined) return plan
          this.followup(createUserMessage({ content: [{ type: 'text', text: `/${command.name}${rawInput}` }], source: { kind: 'user' } }))
          return { kind: 'success' }
        },
      }))
    }
  }

  /**
   * Set Casper's Plan first option for `/plan on` or `/plan off`, without a
   * prompt. Casper takes the option during a prompt too.
   * @param rawInput - the command's input after `/plan`.
   * @returns the command's result, or undefined when the line goes to Casper as a prompt: other input,
   *   no running Casper, or a Casper without the option.
   */
  private planSwitch(rawInput: string): Promise<CommandResult> | undefined {
    const value = rawInput.trim()
    const connection = this.connection
    if ((value !== 'on' && value !== 'off') || connection === undefined || connection.dead || connection.planMode === undefined) return undefined
    // The user's choice replaces the Session's last value, so a later turn does not restore the old one.
    this.planRestored.add(connection)
    return this.sideJob(() => connection.setConfigOption('plan', value)).then(
      (): CommandResult => {
        // A Casper already at that value sends no change, while the log can still show the Session's last value.
        this.syncPlan()
        return { kind: 'success', text: value === 'on' ? 'Plan first on: every request gets a plan first.' : 'Plan first off.' }
      },
      (error: unknown): CommandResult => ({ kind: 'error', text: `Casper did not turn Plan first ${value}: ${casperWords(error).replace(/\.$/, '')}.` }),
    )
  }

  /**
   * Record Casper's Plan first value as `plan/mode` when the log says
   * otherwise or a `/plan` selection is still pending, so the plan chip shows
   * what Casper does. Without a value to record (no running Casper, a Casper
   * that offers no option, or a restarted Casper not yet given the Session's
   * value), a pending selection settles to the logged value, so the chip never
   * moves. Never applies Standard's plan-mode controller.
   */
  private syncPlan(): void {
    const connection = this.connection
    const state = this.planState()
    const casper = connection !== undefined && this.planRestored.has(connection) ? connection.planMode : undefined
    const active = casper ?? state.active
    if (state.active === active && state.wanted === null) return
    try {
      this.session.append('plan/mode', { active })
    } catch (error: unknown) {
      /* v8 ignore start -- an append fails only when the Session is closed under the Agent. */
      this.pluginCtx.logger.warn(`casper agent "${this.id}": plan mode not recorded: ${String(error)}`)
      /* v8 ignore stop */
    }
  }

  /**
   * Give a Casper the Session's logged Plan first setting before its first
   * prompt: a restarted Casper starts with its own default while the chip
   * shows the last Casper's value. A Session that was never in Plan first
   * keeps Casper's own default. A Casper that refuses keeps its own value,
   * which the turn's end then records. A turn that ends before the restore
   * leaves it to that Casper's next turn.
   * @param connection - the new connection.
   * @param signal - stops the set.
   * @throws the stop's error when stopped.
   */
  private async applyPlan(connection: CasperConnection, signal: AbortSignal): Promise<void> {
    const casper = connection.planMode
    const { active: logged, entered } = this.planState()
    if (casper !== undefined && entered && casper !== logged) {
      try {
        await this.setUntilStopped(connection, 'plan', logged ? 'on' : 'off', signal)
      } catch (error: unknown) {
        if (signal.aborted) throw error
        this.pluginCtx.logger.debug(`casper agent "${this.id}": Plan first not restored: ${errorText(error)}`)
      }
    }
    this.planRestored.add(connection)
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
        throw new CasperError('CASPER_MODEL_UNAVAILABLE', `Casper can't use ${wanted.provider}/${wanted.model}: ${casperWords(error)}. Pick another model.`, { cause: error })
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
    this.matchChildRoute()
    if (options === undefined) return
    // A failed save costs only the next Session's early picker.
    this.modelsCache.write({ groups: report.groups, current: report.current }).catch((error: unknown) => {
      this.pluginCtx.logger.warn(`casper agent "${this.id}": model list not saved: ${String(error)}`)
    })
  }

  /**
   * Look up the app route for Casper's current model when it changed, or always with `again`, as when the app's
   * routes change. Until the lookup ends, and when it finds none, {@link options} use the start options.
   * @param again - look up even an unchanged model.
   */
  private matchChildRoute(again = false): void {
    if (!this.config.casperChildModel) return
    const current = this.models().reported?.current ?? undefined
    const key = current === undefined ? undefined : `${current.provider}/${current.model}/${current.reasoningEffort ?? ''}`
    if (!again && key === this.childRouteKey) return
    const seq = ++this.childRouteSeq
    this.childRouteKey = key
    this.childRoute = undefined
    const llm = this.pluginCtx.get('llm')
    if (current === undefined || llm === undefined) return
    matchChildRoute(llm, current, this.childRouteStop.signal).then(
      (route) => { if (seq === this.childRouteSeq) this.childRoute = route },
      /* v8 ignore start -- listing the app's routes does not throw; the lookup's own failures mean no route. */
      (error: unknown) => { this.pluginCtx.logger.debug(`casper agent "${this.id}": child model not matched: ${String(error)}`) },
      /* v8 ignore stop */
    )
  }

  /** The `provider/model` Casper last reported, recorded on assistant messages. */
  private modelLabel(): string {
    const current = this.models().reported?.current
    return current == null ? this.config.model ?? DEFAULT_MODEL_LABEL : `${current.provider}/${current.model}`
  }

  /**
   * The Casper access mode the chip asks for.
   * @returns the mode, or undefined when the app mounts no permission presets.
   */
  private wantedAccess(): AccessModeId | undefined {
    const presets = this.pluginCtx.get('permissionPresets')
    if (presets === undefined) return undefined
    const preset = presets.current(this.session)
    // The derived custom preset has no bundle; the sandbox policy owns the Session's mode.
    const sandbox = preset === CUSTOM_PRESET
      ? this.pluginCtx.get('sandboxPolicy')?.resolve({ session: this.session }).mode
      : presets.resolve(preset).sandbox
    return accessModeFor(preset, sandbox, this.config.accessModes)
  }

  /** Run one access job after the ones queued before it. */
  private queueAccess<T>(job: () => Promise<T>): Promise<T> {
    const run = this.accessChain.then(() => this.sideJob(job))
    this.accessChain = run.catch(
      /* v8 ignore next -- each caller observes its own job's failure; syncs report theirs as values. */
      () => {},
    )
    return run
  }

  /**
   * Bring Casper's access mode to the chip's. A mode is sent only when the chip
   * asks for another one than this app last set on the connection, so a mode
   * Casper picks itself (such as "Yes to everything this session") is kept,
   * except that Read only is always restored. A Casper without modes asks as
   * usual, so Ask first needs nothing sent to it.
   * @param connection - the live connection.
   * @returns the wanted mode and any failure, or undefined when the app mounts no permission presets.
   */
  private async syncAccess(connection: CasperConnection): Promise<AccessSync | undefined> {
    try {
      return await this.syncAccessMode(connection)
    } finally {
      // Casper's own change reaches here through its mode handler, and every chip switch does too.
      this.noteOwnAccess()
    }
  }

  /** The body of {@link syncAccess}. */
  private async syncAccessMode(connection: CasperConnection): Promise<AccessSync | undefined> {
    const wanted = this.wantedAccess()
    if (wanted === undefined) return undefined
    const set = this.accessSet.get(connection) ?? connection.accessMode ?? 'ask'
    if (set === wanted && (wanted !== 'read' || connection.accessMode === 'read')) {
      this.accessSet.set(connection, wanted)
      return { wanted }
    }
    try {
      await connection.setAccess(wanted)
    } catch (error: unknown) {
      return { wanted, failure: error }
    }
    this.accessSet.set(connection, wanted)
    return { wanted }
  }

  /**
   * Bring Casper's access to the chip's before a prompt, after any switch queued earlier.
   * @param connection - the live connection.
   * @returns a note for the turn when Full access could not be set; Casper then asks as usual.
   * @throws CasperError `CASPER_ACCESS_NOT_APPLIED` when Read only or Ask first could not be set, `CASPER_EXITED` when Casper exits.
   */
  private async applyAccess(connection: CasperConnection): Promise<string | undefined> {
    const sync = await this.queueAccess(() => this.syncAccess(connection))
    // This sync read the chip after every switch queued before it, so an earlier failure no longer counts.
    this.lateAccess = undefined
    return accessOutcome(sync)
  }

  /**
   * Take a chip switch that failed after the turn's access step, while its
   * prompt was not yet sent. A sync on an earlier connection fails as an exit,
   * which is not kept.
   * @returns a note when Full access could not be set.
   * @throws CasperError `CASPER_ACCESS_NOT_APPLIED` when Read only or Ask first could not be set.
   */
  private lateAccessNote(): string | undefined {
    const late = this.lateAccess
    this.lateAccess = undefined
    return accessOutcome(late)
  }

  /**
   * Send a chip switch to the running Casper at once. When Read only or Ask
   * first cannot be set during a prompt, the prompt stops and the turn ends
   * `CASPER_ACCESS_NOT_APPLIED`; Full access that cannot be set leaves a note.
   * A failure while no prompt is open is kept, so a turn that is still
   * preparing its prompt ends the same way instead of sending it. Without a
   * running Casper the next turn sends it.
   */
  private queueLiveAccess(): void {
    if (this.liveAccessQueued) return
    this.liveAccessQueued = true
    this.queueAccess(async () => {
      // The chip is read when the sync starts, so it covers every switch queued before.
      this.liveAccessQueued = false
      const connection = this.connection
      if (connection === undefined || connection.dead) return
      const sync = await this.syncAccess(connection)
      if (sync?.failure === undefined) {
        // The chip's mode is set now, so a switch that failed before no longer stops a prompt.
        this.lateAccess = undefined
        return
      }
      const { wanted, failure } = sync
      const text = accessFailureText(wanted, failure)
      this.pluginCtx.logger.debug(`casper agent "${this.id}": ${text}`)
      // An exit ends the prompt on its own.
      if (failure instanceof CasperError && failure.code === 'CASPER_EXITED') return
      const sink = this.sinkFor(connection)
      if (sink === undefined) {
        // A turn still preparing its prompt reads it before sending.
        this.lateAccess = sync
        return
      }
      this.record(() => {
        if (wanted === 'full') {
          sink.writer.text(`\n[${text} Casper asks before changes as usual.]\n`)
          return
        }
        sink.writer.text(`\n[${text} The request was stopped.]\n`)
        sink.stop(new CasperError('CASPER_ACCESS_NOT_APPLIED', `${text} The request was stopped.`, { cause: failure }))
      })
    }).catch(
      /* v8 ignore next -- the chip's preset is read only after the presets service is ready. */
      (error: unknown) => { this.pluginCtx.logger.warn(`casper agent "${this.id}": access not synced: ${String(error)}`) },
    )
  }

  /** Run a request outside a turn's phase, such as an access sync or a Plan first set, with Casper kept open meanwhile. */
  private async sideJob<T>(job: () => Promise<T>): Promise<T> {
    this.activityCount++
    this.sideJobs++
    try {
      return await job()
    } finally {
      this.sideJobs--
    }
  }

  /** Send the queued steering to the prompt in flight, after any send already running. */
  private forwardSteers(): void {
    const sink = this.sink
    if (sink === undefined) return
    sink.steers.chain = sink.steers.chain.then(() => this.sendSteers(sink))
  }

  /**
   * Send each steered line still pending, in queue order, while this prompt is
   * open and Casper takes them. A line is marked sent before its request, so a
   * read notice that comes before the reply finds it. A refusal, a failure, a
   * line with a part that would go as a placeholder, or a line with a session
   * mention keeps it, and every line after it, for the next turn.
   */
  private async sendSteers(sink: PromptSink): Promise<void> {
    const { connection, steers } = sink
    for (;;) {
      if (this.sink !== sink || steers.closed || sink.signal.aborted || !connection.acceptsSteer) return
      const pending = [...this.inbox.nextTurn, ...this.inbox.nextStep]
      for (const id of this.steerIds) if (!pending.some(message => message.id === id)) this.steerIds.delete(id)
      const first = this.inbox.nextStep.find(item => this.steerIds.has(item.id) && !steers.forwarded.has(item.id))
      if (first === undefined) return
      const { id } = first
      steers.forwarded.add(id)
      steers.accepted.set(id, first)
      let taken = false
      try {
        const read = (line: UserMessage) => promptContent([line], { attachments: this.pluginCtx.get('attachments'), images: connection.acceptsImages, signal: sink.signal })
        const queued = () => this.inbox.nextStep.find(item => item.id === id)
        let message = first
        let content = await read(message)
        // A picture's read takes a while: a line removed meanwhile is not sent, and an edited one sends its new content.
        let current = queued()
        while (current !== undefined && current !== message) {
          message = current
          steers.accepted.set(id, message)
          content = await read(message)
          current = queued()
        }
        if (current === undefined) {
          steers.forwarded.delete(id)
          steers.accepted.delete(id)
          continue
        }
        // A placeholder's note belongs at the head of a turn's reply, and a mention is read only for a turn,
        // so such a line runs as the next turn.
        taken = content.readable && content.notes.length === 0 && !hasSessionReference(message) && this.sink === sink
          && await connection.steer(content.blocks, message.id)
      } catch (error: unknown) {
        this.pluginCtx.logger.debug(`casper agent "${this.id}": steering not sent: ${errorText(error)}`)
      }
      if (!taken) {
        steers.accepted.delete(id)
        steers.closed = true
        return
      }
    }
  }

  /**
   * Record a steered line Casper says the AI read: claim it from the queue for
   * this turn right before it is written, as it was sent, as the next step's
   * `user/message`. The write waits for open calls and the claim waits with it,
   * so a crash meanwhile leaves the line queued, never lost, and a Stop
   * meanwhile does not cancel it. The rest of the queue goes back unchanged.
   * The notice may come before Casper's reply to the send.
   * @param sink - the prompt's sink.
   * @param messageId - the id the notice carries.
   */
  private steerRead(sink: PromptSink, messageId: string | null | undefined): void {
    if (messageId == null) return
    const id = MessageId(messageId)
    const message = sink.steers.forwarded.has(id) ? sink.steers.accepted.get(id) : undefined
    if (message === undefined) return
    sink.steers.accepted.delete(id)
    this.steerIds.delete(id)
    this.readSteers.add(id)
    sink.writer.steered(message, () => {
      this.readSteers.delete(id)
      // Removed from the queue after it was sent: the AI read it all the same.
      if (!this.inbox.nextStep.some(item => item.id === id)) return
      const batch = this.inbox.claim('next-step', sink.turn)
      this.inbox.splice('next-step', 0, 0, batch.filter(item => item.id !== id))
    })
  }

  /** Forget the current connection and start killing it. */
  private dropConnection(connection: CasperConnection): void {
    this.connection = undefined
    this.noteOwnAccess()
    connection.terminate()
  }

  /**
   * Record the access mode Casper picked itself when it changed, for the
   * composer's mode pill: the live process's mode when it differs from the
   * mode this app last set on it, else null (no pick, the app set a mode,
   * Casper went back to it, or the process ended). With `modePill` off it is
   * always null. Display only: it sets nothing on Casper and never moves the
   * access control. A failed record costs only the pill.
   */
  noteOwnAccess(): void {
    const mode = this.ownAccess()
    if (mode === this.ownAccessState().mode) return
    try {
      appendPluginRecord(this.session, ACCESS_RECORD, { mode })
    } catch (error: unknown) {
      /* v8 ignore start -- an append fails only when the Session is closed under the Agent. */
      this.pluginCtx.logger.warn(`casper agent "${this.id}": Casper's own access mode not recorded: ${String(error)}`)
      /* v8 ignore stop */
    }
  }

  /** The access mode the live Casper picked itself, or null. */
  private ownAccess(): AccessModeId | null {
    const connection = this.connection
    if (!this.config.modePill || connection === undefined || connection.dead) return null
    const set = this.accessSet.get(connection)
    const mode = ACCESS_MODE_IDS.find(id => id === connection.accessMode)
    return set === undefined || mode === undefined || mode === set ? null : mode
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
        case 'agent_message_chunk': {
          // Casper's receipt is a card of its own; a note, the model's words and an older Casper's receipt are text.
          const receipt = casperReceiptOf(update._meta)
          if (receipt !== undefined) sink.writer.receipt(receipt)
          else if (update.content.type === 'text') sink.writer.text(update.content.text)
          return
        }
        case 'usage_update':
          this.usage(sink, update)
          return
        case 'agent_thought_chunk':
          // Casper's reasoning headlines and retries: shown as the step's reasoning block.
          if (update.content.type === 'text') sink.writer.thought(update.content.text)
          return
        case 'tool_call':
          sink.writer.toolCall(update)
          // Each Casper step that changes the workspace is made durable without waiting for the turn.
          void this.flush()
          return
        case 'tool_call_update':
          // Only a final update closes the step; an in-progress one leaves an open box and the write path alone.
          if (update.status !== 'completed' && update.status !== 'failed') return
          for (const ask of this.asks.get(update.toolCallId) ?? []) ask.abort()
          sink.writer.toolUpdate(update)
          void this.flush()
          return
        case 'plan':
          sink.writer.plan(update.entries)
          return
        case 'user_message_chunk':
          // Only Casper's notice for a line this prompt sent counts; a replay never reaches here.
          this.steerRead(sink, update.messageId)
          return
        default:
          // Casper sends no other update kinds; the rest of ACP's set is not shown.
          return
      }
    })
  }

  /**
   * Record a response's usage: its window as the Session's `request/context`
   * when that changed (the context ring's denominator), then its tokens on the
   * step's message (the ring's numerator and the token count).
   * @param sink - the prompt the update belongs to.
   * @param update - Casper's `usage_update`.
   */
  private usage(sink: PromptSink, update: Extract<SessionNotification['update'], { sessionUpdate: 'usage_update' }>): void {
    if (Number.isSafeInteger(update.size) && update.size > 0) {
      const context = { provider: CASPER_PROVIDER, model: usageModelOf(update) ?? this.modelLabel(), contextWindow: update.size }
      const known = this.session.requestContext()
      if (known?.provider !== context.provider || known.model !== context.model || known.contextWindow !== context.contextWindow) {
        this.session.append('request/context', context)
      }
    }
    const sample = usageOf(update)
    if (sample !== undefined) sink.writer.usage(sample.tokens, sample.toolUse)
  }

  private async permission(
    connection: CasperConnection | undefined,
    params: RequestPermissionRequest,
    withdrawn: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    const sink = this.sinkFor(connection)
    if (sink === undefined) return { outcome: { outcome: 'cancelled' } }
    const id = params.toolCall.toolCallId
    // As for a form, the box's step may be closed already; a late box would reopen it.
    if (sink.writer.finished(id)) return { outcome: { outcome: 'cancelled' } }
    this.record(() => { sink.writer.question(params.toolCall) })
    const own = new AbortController()
    this.openAsk(id, own)
    const signal = AbortSignal.any([sink.signal, own.signal, withdrawn])
    const service = this.pluginCtx.get('userQuestions')
    try {
      return await answerPermission(
        params,
        service === undefined ? undefined : async question => service.ask({ agent: this, questions: [question], signal }),
        (error) => { this.pluginCtx.logger.debug(`casper agent "${this.id}": permission question ended: ${String(error)}`) },
        // A plan review reopens the plan recorded under the box's step; any other box is marked for Casper's card,
        // which draws the diffs an edit's box carries.
        { callId: sink.connection.toolCallId(id), card: this.config.approvalCard, diff: this.config.approvalDiff },
      )
    } finally {
      this.closeAsk(id, own)
    }
  }

  /** Keep `own` among the open questions of step `id`, beside any other question on that step. */
  private openAsk(id: string, own: AbortController): void {
    const asks = this.asks.get(id)
    if (asks === undefined) this.asks.set(id, new Set([own]))
    else asks.add(own)
  }

  /** Forget the settled question `own` of step `id`. */
  private closeAsk(id: string, own: AbortController): void {
    const asks = this.asks.get(id)
    asks?.delete(own)
    if (asks?.size === 0) this.asks.delete(id)
  }

  /**
   * Answer one of Casper's forms as a user question on the step it names, as
   * {@link permission} does for a box: the step's card stays open while the
   * user answers and closes with Casper's final update of that step.
   */
  private async elicitation(
    connection: CasperConnection | undefined,
    params: CreateElicitationRequest,
    withdrawn: AbortSignal,
  ): Promise<CreateElicitationResponse> {
    const question = elicitationQuestion(params)
    if (question === undefined) return { action: 'decline' }
    const sink = this.sinkFor(connection)
    if (sink === undefined) return { action: 'cancel' }
    const id = elicitationStep(params)
    // A request is dispatched after the notifications sent behind it, so the step may be closed already.
    if (id !== undefined && sink.writer.finished(id)) return { action: 'cancel' }
    const own = new AbortController()
    if (id !== undefined) {
      const asked = { question: question.question, options: question.options ?? [], multi: question.multiSelect === true }
      this.record(() => { sink.writer.question({ toolCallId: id }, asked) })
      this.openAsk(id, own)
    }
    const signal = AbortSignal.any([sink.signal, own.signal, withdrawn])
    const service = this.pluginCtx.get('userQuestions')
    let answer: AskUserQuestionAnswer | undefined
    try {
      const reply = await answerElicitation(
        params,
        service === undefined ? undefined : async (item) => {
          answer = await service.ask({ agent: this, questions: [item], signal })
          return answer
        },
        (error) => { this.pluginCtx.logger.debug(`casper agent "${this.id}": form question ended: ${String(error)}`) },
      )
      const batch = answer
      if (reply.action === 'accept' && id !== undefined && batch !== undefined) this.record(() => { sink.writer.answered(id, batch) })
      return reply
    } finally {
      if (id !== undefined) this.closeAsk(id, own)
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

/**
 * Wait for an operation that cannot be stopped, unless the signal stops first.
 * @param operation - the operation; it must not reject.
 * @param signal - the turn's signal.
 * @throws the stop's error when stopped.
 */
async function settledUnlessStopped(operation: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const stopped = Promise.withResolvers<void>()
  const onAbort = (): void => { stopped.resolve() }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await Promise.race([operation, stopped.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
  signal.throwIfAborted()
}

/** The `provider/model` a connection's options name as current, or undefined when they name none. */
function modelOf(connection: CasperConnection): string | undefined {
  const current = reportOf(connection.configOptions).current
  return current == null ? undefined : `${current.provider}/${current.model}`
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

/**
 * Casper's own words for a failed request: an error reply carries them as its cause.
 * @param error - the failure.
 * @returns the cause's message, or the failure's own.
 */
function casperWords(error: unknown): string {
  return error instanceof CasperError && error.cause instanceof Error ? error.cause.message : errorText(error)
}

/**
 * Words for an access mode Casper did not take.
 * @param wanted - the mode the chip asks for.
 * @param failure - why it was not set.
 * @returns one sentence.
 */
function accessFailureText(wanted: AccessModeId, failure: unknown): string {
  const label = ACCESS_MODE_LABELS[wanted]
  if (failure instanceof CasperError && failure.code === 'CASPER_NO_ACCESS_MODES') {
    return `This Casper has no access modes, so ${label} could not be set. Update Casper.`
  }
  const words = casperWords(failure)
  return `Casper did not switch to ${label}: ${words.replace(/\.$/, '')}.`
}

/**
 * What the turn does about an access sync: nothing when the mode is set, a
 * note when Full access could not be set, and an error otherwise.
 * @param sync - the sync, or undefined when the app mounts no permission presets.
 * @returns the note, if any.
 * @throws CasperError `CASPER_ACCESS_NOT_APPLIED` when Read only or Ask first could not be set, `CASPER_EXITED` when Casper exited.
 */
function accessOutcome(sync: AccessSync | undefined): string | undefined {
  if (sync?.failure === undefined) return undefined
  const { wanted, failure } = sync
  if (failure instanceof CasperError && failure.code === 'CASPER_EXITED') throw failure
  if (wanted === 'full') return `[${accessFailureText(wanted, failure)} Casper asks before changes as usual.]\n`
  throw new CasperError('CASPER_ACCESS_NOT_APPLIED', `${accessFailureText(wanted, failure)} Nothing was sent to Casper.`, { cause: failure })
}

/** Structured failure of a turn. */
function failureOf(error: unknown): LlmFailure {
  if (error instanceof CasperError) return { code: error.code, message: error.message }
  return { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) }
}
