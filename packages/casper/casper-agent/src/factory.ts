/**
 * Creates, resumes, publishes, and tears down Casper Agents.
 * @module @deepseek-ai/dsh-casper-agent/factory
 */

import type { Context } from '@deepseek-ai/cordis'
import { AGENT_MODELS_RECORD } from '@deepseek-ai/dsh-agent'
import type {
  AgentFactory,
  AgentHandle,
  AgentModelsReport,
  AgentModelsState,
  AgentOptions,
  AgentSetup,
  CreateAgentOptions,
  InboxState,
  ResumeAgentOptions,
  SessionStartSource,
} from '@deepseek-ai/dsh-agent'
import { appendPluginRecord, interruptedTurnClosers, pluginRecordOf, SessionLogOffset, SessionPreparation } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type { PlanUnitState } from '@deepseek-ai/dsh-plan-mode'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { CasperOwnAccess } from './access-record.ts'
import { CasperAgent } from './agent.ts'
import type { CasperCommandCache } from './commands.ts'
import type { Config } from './config.ts'
import { inheritedConversation } from './conversation.ts'
import type { ForkPoint } from './conversation.ts'
import { withCurrent } from './models.ts'
import type { CasperModelsCache } from './models-cache.ts'
import type { CasperSidecar } from './sidecar.ts'

/** Projection handles and storage the factory shares with every Agent. */
export interface CasperFactoryDependencies {
  /** The registered `agentModels` projection. */
  readonly agentModels: ProjectionHandle<AgentModelsState>
  /** The registered `inbox` projection, shared with agent-loop. */
  readonly inbox: ProjectionHandle<InboxState>
  /** The registered `plan` projection, shared with plan-mode; the composer's plan chip reads it. */
  readonly plan: ProjectionHandle<PlanUnitState>
  /** The registered `casperAccess` projection; the composer's mode pill reads it. */
  readonly casperAccess: ProjectionHandle<CasperOwnAccess>
  /** The Session-to-conversation records. */
  readonly sidecar: CasperSidecar
  /** The last command list Casper sent. */
  readonly commands: CasperCommandCache
  /** The last model list Casper sent. */
  readonly models: CasperModelsCache
}

/** One Session's write handle and the count of events already stored through it. */
interface StoredSession {
  readonly handle: SessionHandle
  storedCount: number
}

interface Initialization {
  readonly session: Session
  readonly stored: StoredSession
  readonly agentOptions: AgentOptions
  readonly source: SessionStartSource
  readonly setup: AgentSetup | undefined
  readonly signal: AbortSignal | undefined
  /** For a fork that has not started its own conversation: the inherited record to copy from, or null when it has none. */
  readonly fork: ForkPoint | null | undefined
}

/**
 * The fork point of a forked Session, read from the events the factory already holds.
 * @param events - the Session's events, inherited prefix first.
 * @param inheritedEventCount - how many events the fork inherited.
 * @returns see {@link inheritedConversation}.
 */
function forkPointOf(events: readonly SessionEvent[], inheritedEventCount: number): ForkPoint | null | undefined {
  return inheritedConversation(events.flatMap((event) => {
    const record = pluginRecordOf(event)
    return record === undefined ? [] : [record]
  }), inheritedEventCount, events.flatMap(event => event.type === 'turn/end' ? [{ seq: event.seq, reason: event.data.reason }] : []))
}

/** Throw one collected failure as itself, or several as one AggregateError. */
function throwFailures(failures: readonly unknown[], message: string): void {
  /* v8 ignore start -- teardown steps fail only when a provider cannot release its resource. */
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, message)
  /* v8 ignore stop */
}

/** Settle `value`, or reject with the signal's reason once it aborts. */
async function untilAborted<T>(value: PromiseLike<T> | T, signal: AbortSignal): Promise<T> {
  const stopped = Promise.withResolvers<never>()
  const stop = (): void => { stopped.reject(signal.reason) }
  signal.throwIfAborted()
  signal.addEventListener('abort', stop, { once: true })
  return await Promise.race([Promise.resolve(value), stopped.promise]).finally(() => { signal.removeEventListener('abort', stop) })
}

/**
 * The Agent factory for Casper Sessions. Sessions persist through the mounted
 * persistence backend exactly as agent-loop Sessions do; resume repairs an
 * interrupted turn and starts no process. Factory disposal tears every live
 * Agent down in parallel.
 */
export class CasperAgentFactory implements AgentFactory {
  private accepting = true
  private readonly stopping = new AbortController()
  private readonly live = new Set<() => Promise<void>>()
  private readonly pending = new Set<Promise<unknown>>()

  /**
   * @param ctx - the Casper plugin context.
   * @param config - the plugin config.
   * @param deps - projection handles, the sidecar, and the command cache.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly deps: CasperFactoryDependencies,
  ) {}

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    this.assertAccepting()
    const preparation = SessionPreparation.create(this.ctx.sessions.prepare(options.sessionId, {
      ...options.seed === undefined ? {} : { seed: options.seed },
      meta: { ...options.meta },
      ...options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount },
    }))
    // A fork's Casper conversation is cut where the inherited log ends.
    const fork = options.meta?.isSeeded === true ? forkPointOf(options.seed ?? [], options.inheritedEventCount ?? 0) : undefined
    return this.track((async () => {
      using owned = preparation
      const handle = await this.ctx.sessionPersistence.create(owned.session.header, {
        inheritedEventCount: owned.session.inheritedEventCount,
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
      return await this.initialize(ownerCtx, {
        session: owned.session,
        stored: { handle, storedCount: 0 },
        agentOptions: options.agentOptions ?? {},
        source: 'startup',
        setup: options.setup,
        signal: options.signal,
        fork,
      })
    })())
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    this.assertAccepting()
    const id = options.resumeSessionId
    const signal = AbortSignal.any([...options.signal === undefined ? [] : [options.signal], this.stopping.signal])
    return this.track((async () => {
      let handle: SessionHandle | undefined = await this.ctx.sessionPersistence.open(id, 'write', { signal })
      let preparation: SessionPreparation | undefined
      try {
        const cold = await handle.read(0, undefined, { signal })
        signal.throwIfAborted()
        const closers = interruptedTurnClosers(cold.events)
        if (closers.length > 0) await handle.append(closers)
        preparation = SessionPreparation.create(this.ctx.sessions.prepare(id, {
          seed: [...cold.events, ...closers],
          meta: structuredClone(handle.header),
          inheritedEventCount: handle.inheritedEventCount,
          eventState: cold.eventState,
        }))
        const stored = { handle, storedCount: cold.events.length + closers.length }
        // A fork reopened before its first Casper start still copies; one with a conversation record of its own does not.
        const fork = handle.header.isSeeded ? forkPointOf(cold.events, handle.inheritedEventCount) : undefined
        handle = undefined
        return await this.initialize(ownerCtx, {
          session: preparation.session,
          stored,
          agentOptions: options.agentOptions ?? {},
          source: 'resume',
          setup: options.setup,
          signal: options.signal,
          fork,
        })
      } finally {
        preparation?.[Symbol.dispose]()
        /* v8 ignore next 3 -- the load failure stays primary over a failed close. */
        await handle?.close().catch(() => {
          // The load failure stays primary.
        })
      }
    })())
  }

  /**
   * Stop accepting Agents and tear down every live one in parallel.
   * @returns resolution once every Agent and pending creation settled.
   */
  async dispose(): Promise<void> {
    this.accepting = false
    this.stopping.abort(new Error('casper agent factory is not active'))
    const settled = await Promise.allSettled([...[...this.live].map(dispose => dispose()), ...this.pending])
    const failures: unknown[] = []
    for (const result of settled) {
      /* v8 ignore next -- see throwFailures. */
      if (result.status === 'rejected') failures.push(result.reason)
    }
    throwFailures(failures, 'casper agent factory disposal failed')
  }

  /** The list a new Session shows before its Casper starts: the cached one, with the configured `--model` as current. */
  private seed(): AgentModelsReport {
    const cached = this.deps.models.read()
    const report: AgentModelsReport = { groups: cached.groups, current: cached.current, started: false }
    return this.config.model === undefined ? report : withCurrent(report, this.config.model)
  }

  private assertAccepting(): void {
    if (!this.accepting) throw new Error('casper agent factory is not active')
  }

  private track<T>(job: Promise<T>): Promise<T> {
    const settled = job.then(() => undefined, () => undefined)
    this.pending.add(settled)
    void settled.then(() => { this.pending.delete(settled) })
    return job
  }

  /**
   * Publish one Agent on an acquired Session: store the unstored suffix,
   * enter and announce the Session, run setup and its commit, then enter and
   * announce the Agent, all inside maintenance so queued input waits.
   */
  private async initialize(ownerCtx: Context, init: Initialization): Promise<AgentHandle> {
    const { session, stored } = init
    const id = session.id
    const abort = new AbortController()
    const onCallerAbort = (): void => { abort.abort(new Error(`agent "${id}" creation aborted`)) }
    const onStop = (): void => { abort.abort(this.stopping.signal.reason) }
    init.signal?.addEventListener('abort', onCallerAbort, { once: true })
    this.stopping.signal.addEventListener('abort', onStop, { once: true })
    const unlisten = (): void => {
      init.signal?.removeEventListener('abort', onCallerAbort)
      this.stopping.signal.removeEventListener('abort', onStop)
    }
    const agent = new CasperAgent(
      this.ctx, id, init.agentOptions, session,
      {
        agentModels: this.deps.agentModels.readerFor(session),
        inbox: this.deps.inbox.readerFor(session),
        plan: this.deps.plan.readerFor(session),
        casperAccess: this.deps.casperAccess.readerFor(session),
      },
      this.ctx.agents.turnBoundaryOf(session).lastTurn,
      this.config,
      this.deps.sidecar,
      this.deps.commands,
      this.deps.models,
      init.fork,
    )

    let ready = false
    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    let disposing: Promise<void> | undefined
    const teardown = (): Promise<void> => (disposing ??= (async () => {
      abort.abort(new Error(`agent "${id}" lifecycle disposed`))
      unlisten()
      const failures: unknown[] = []
      const step = async (operation: () => Promise<void> | void): Promise<void> => {
        try {
          await operation()
        } catch (error: unknown) {
          /* v8 ignore next -- see throwFailures. */
          failures.push(error)
        }
      }
      await step(async () => {
        agent.cancel({ kind: 'disposed' }, { keepInbox: !ready })
        await agent.whenIdle()
      })
      await step(() => agent.closeConnection())
      await step(() => agent.scope.dispose())
      await step(() => stored.handle.close())
      try {
        detachAgent?.()
        detachSession?.()
      } finally {
        untrack()
      }
      throwFailures(failures, `agent "${id}" disposal failed`)
    })())
    const untrack = ((): (() => void) => {
      this.live.add(teardown)
      return () => { this.live.delete(teardown) }
    })()
    /* v8 ignore next -- replaced by the owner effect below; only an inactive owner leaves it in place. */
    let unfollowOwner: () => Promise<void> | void = () => {}
    const dispose = async (): Promise<void> => {
      try {
        await teardown()
      } finally {
        await unfollowOwner()
      }
    }

    try {
      ownerCtx.fiber.assertActive()
      unfollowOwner = ownerCtx.effect(() => () => teardown(), `casperAgent.lifecycle(${id})`)
      return await agent.runMaintenance(async () => {
        try {
          abort.signal.throwIfAborted()
          // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read, as agent-loop stores its suffix.
          const suffix = session.snapshotEvents(SessionLogOffset(stored.storedCount))
          if (suffix.length > 0) await stored.handle.append(suffix)
          stored.storedCount += suffix.length
          abort.signal.throwIfAborted()
          detachSession = agent.ctx.sessions.enter(session)
          agent.ctx.sessions.announce(session)
          // A new Session's picker offers the last list Casper sent, or the start value, until its own Casper reports; a
          // fork keeps the source's, since a copied conversation goes on with the source's model.
          if (init.source === 'startup' && !session.header.isSeeded) appendPluginRecord(session, AGENT_MODELS_RECORD, this.seed())
          // A new Agent has no process yet, so a mode a closed process picked itself (a killed app's) is cleared.
          agent.noteOwnAccess()
          const commit = await untilAborted(init.setup?.(agent.ctx, agent), abort.signal)
          abort.signal.throwIfAborted()
          commit?.commit()
          abort.signal.throwIfAborted()
          // The persistence backend routes announced live events into the write handle by Session id.
          detachAgent = this.ctx.agents.enter(agent)
          await this.ctx.agents.announce(agent, init.source, abort.signal)
          abort.signal.throwIfAborted()
          ready = true
          agent.publishCommands()
          return { agent, dispose }
        } catch (error: unknown) {
          // A failed initialization keeps queued input for the next owner.
          agent.cancel({ kind: 'disposed' }, { keepInbox: true })
          throw error
        }
      })
    } catch (error: unknown) {
      /* v8 ignore next 3 -- the initialization failure stays primary over a failed teardown. */
      await dispose().catch(() => {
        // The initialization failure stays primary.
      })
      throw error
    }
  }
}
