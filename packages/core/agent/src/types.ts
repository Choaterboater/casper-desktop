/**
 * Durable agent session-event vocabulary shared with type-only consumers.
 *
 * @module @deepseek-ai/dsh-agent/types
 */

import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
// Type-only: the Workspace registry's archive-admission family map this registry merges `turn` into.
import type {} from '@deepseek-ai/dsh-workspace/types'
import type { OptionalSessionSeq, SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection/types'
import type { TypertContext, TypertLookup } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Public live-agent handle; the runtime face augments its live capabilities. */
export interface Agent {
  /** Session-backed Agent identity. */
  readonly id: SessionId
}

declare module '@deepseek-ai/dsh-workspace/types' {
  interface SessionActivityKindMap {
    /** The session's own Agent is inside a turn, including one waiting for an approval or an answer. */
    turn: true
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    agent: TypertLookup<Agent, SessionId>
  }

  interface TypertContextMap {
    /** Agent Context identity shared by Host and Client adapters. */
    agent: TypertContext<SessionId>
  }
}

/** One of the two ordered pending-message lists owned by an agent. */
export type InboxTarget = 'next-turn' | 'next-step'

/** Complete pending Inbox value reconstructed from durable splices. */
export interface InboxState {
  readonly 'next-turn': readonly UserMessage[]
  readonly 'next-step': readonly UserMessage[]
}

/**
 * Wire-JSON pending Inbox value. Each message round-trips the session log
 * losslessly, but the fold state's full `UserMessage` type cannot cross a
 * typert Remote boundary (its source union carries an `unknown` replay
 * field), so the typed projection table keeps this JSON-safe form.
 */
export interface InboxWireState {
  readonly 'next-turn': readonly JsonValue[]
  readonly 'next-step': readonly JsonValue[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Pending agent input reconstructed from durable inbox splices. */
    inbox: InboxWireState
  }
}

/** Turn and step positions recorded in a Session. */
export interface TurnBoundaryProjection {
  /** Seq of the open turn's `turn/start`, or null between turns. */
  readonly openTurnStartSeq: OptionalSessionSeq
  /** Seq of the latest `step/start` event, or null before the first step. */
  readonly lastStepStartSeq: OptionalSessionSeq
  /** The latest step boundary (`step/start` or `step/end`) and its seq, or null before the first step boundary. */
  readonly lastStepBoundary: { readonly kind: 'start' | 'end'; readonly seq: SessionSeq } | null
  /** Turn number of the latest `turn/start`; 0 before the first turn. */
  readonly lastTurn: number
}

/** Complete provider, model, and optional reasoning effort chosen for one Session's model steps. */
export interface ModelSelection {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  reasoningEffort?: ReasoningEffortId
}

/** Client view of the durable model-selection fold. */
export interface ModelSelectionProjection {
  /** Selection used by the latest recorded model request. */
  readonly lastUsed: ModelSelection | null
  /** Selection the next model step uses; null while the Agent's initial options supply the route. */
  readonly next: ModelSelection | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Recorded model selection for the next model step and the latest request. */
    modelSelection: ModelSelectionProjection
    /**
     * The models an Agent that chooses its own models offers, or null for an
     * Agent that uses the Host model catalog. Excluded from Session summaries.
     */
    agentModels: SessionProjectionSummaryExcluded<AgentModelsProjection> | null
  }
}

/** One reasoning effort an Agent-offered model takes. */
export interface AgentModelEffort {
  /** Value a selection carries as `reasoningEffort`. */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** Optional one-line explanation. */
  readonly description?: string
}

/** One model an Agent offers inside its provider group. */
export interface AgentModelEntry {
  /** Provider-owned model id, the selection's `model`. */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** Why the model cannot be used now, or another note the Agent attaches. */
  readonly description?: string
  /** Efforts the Agent takes for this model; absent when it offers none. */
  readonly reasoning?: {
    readonly efforts: readonly AgentModelEffort[]
    /** Effort the Agent picks by itself, when it lists one. */
    readonly defaultEffort?: string
  }
}

/** One provider and the models an Agent offers from it, in the Agent's order. */
export interface AgentModelGroup {
  /** Provider route, the selection's `provider`. */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** The provider's models. */
  readonly models: readonly AgentModelEntry[]
}

/** What an Agent that chooses its own models last reported in its models record. */
export interface AgentModelsReport {
  /** Offered models by provider. */
  readonly groups: readonly AgentModelGroup[]
  /** The model the Agent uses now, or null when it has none. */
  readonly current: ModelSelection | null
  /** Whether the Agent's own process sent the list; false for a list seeded before it started. */
  readonly started: boolean
}

/** Client view of the `agentModels` fold: the reported list, with a selection not yet applied as current. */
export interface AgentModelsProjection {
  /** Offered models by provider. */
  readonly groups: readonly AgentModelGroup[]
  /** A recorded selection the Agent has not reported yet, else the Agent's current model. */
  readonly current: ModelSelection | null
  /** Whether the Agent's own process sent the list. */
  readonly started: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One normalized mutation of an agent's durable pending-message lists.
     * The session-projection registry applies the committed event before
     * `Session.append()` returns; Inbox live notifications follow that commit.
     */
    'agent/inbox/spliced': {
      target: InboxTarget
      start: number
      removedCount?: number
      inserted: UserMessage[]
      outcome?: 'canceled'
    }
    /**
     * Complete model selection that applies from the next model step until a
     * later selection. Log-only: it never enters derived model history.
     */
    'model/selection': ModelSelection
  }
}
