/**
 * Per-session model directory: the ONE state both selection entries share.
 * The /model popup and composer seat combine one shared Host catalog with the
 * Session's durable selection projection, then submit through the same
 * selectModel call. A switch made in either entry updates this shared state.
 * A Session whose Agent offers its own models (a non-null `agentModels` view)
 * shows that list instead of the Host catalog.
 */
import type { AgentModelsProjection, ModelSelectionProjection } from '@deepseek-ai/dsh-agent/types'
import type { TrackProductEvent } from '@deepseek-ai/dsh-client-product-analytics/client'
import type {
  ModelCatalogFailure, ModelProviderGroup, ModelSelection,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelCatalogDirectory } from './catalog.ts'

/** Directory snapshot both entries render from. */
export interface ModelDirectoryState {
  /** Saved selection, retained even when its provider or model leaves the catalog. */
  current: ModelSelection | null
  /** Saved effort caption retained when the selected model is unavailable. */
  retainedEffort?: string
  /** Whether the current selection is present in the available catalog; null while unresolved. */
  routable: boolean | null
  /** Successfully loaded provider groups (last good load). */
  groups: readonly ModelProviderGroup[]
  /** Provider-local failures from the last load; usable groups stay usable. */
  failures: readonly ModelCatalogFailure[]
  /** Lifecycle of the in-flight operation. */
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  /** Selection submitted by the latest `select` until it settles; null otherwise. */
  pending: ModelSelection | null
  /** Whole-request or selection failure text; null when none. */
  error: string | null
  /** Present when the Session's Agent offers its own models; `started` once the Agent itself sent them. */
  agent?: { readonly started: boolean }
}

/** One session's shared directory controller; disposed with the session scope. */
export class ModelDirectory {
  /** The shared snapshot both entries render from (uSES-safe store). */
  readonly store: SnapshotStore<ModelDirectoryState> = createSnapshotStore<ModelDirectoryState>({
    current: null, routable: null, groups: [], failures: [], status: 'idle', pending: null, error: null,
  })

  /** Latest selection operation wins; an older response never overwrites a newer one. */
  private generation = 0
  private disposed = false
  private readonly unsubscribeCatalog: () => void
  private readonly unsubscribeSelection: () => void
  private readonly unsubscribeOffered: () => void

  /**
   * @param sessions - the session wire face (captured from the plugin's root connection).
   * @param sessionId - the owning session.
   * @param available - whether this session may use Agent-bound model RPCs.
   * @param catalog - Host-generation catalog shared by every Session.
   * @param projected - durable model selection projected from Session history.
   * @param offered - the Agent's own model list projected from Session history; null for Host-catalog Agents.
   * @param isBlank - whether this Session has no first message yet.
   * @param track - desktop-only callback after a successful user selection.
   */
  constructor(
    private readonly sessions: Pick<TypertClientRemote['session'], 'selectModel'>,
    private readonly sessionId: SessionId,
    private readonly available: () => boolean,
    private readonly catalog: ModelCatalogDirectory,
    private readonly projected: ObservableSnapshot<unknown>,
    private readonly offered: ObservableSnapshot<unknown>,
    private readonly isBlank: () => boolean,
    private readonly track?: TrackProductEvent,
  ) {
    this.unsubscribeCatalog = catalog.store.subscribe(() => { this.syncInputs() })
    this.unsubscribeSelection = projected.subscribe(() => { this.syncInputs() })
    this.unsubscribeOffered = offered.subscribe(() => { this.syncInputs() })
    this.syncInputs()
  }

  /**
   * Ensure the Host generation's shared available catalog is loaded; a Session
   * whose Agent offers its own models needs no catalog.
   * @returns the fresh directory value.
   */
  async load(): Promise<ModelDirectoryState> {
    this.assertAvailable()
    if (agentModelsView(this.offered.getSnapshot()) === null) await this.catalog.load()
    this.syncInputs()
    return this.store.getSnapshot()
  }

  /**
   * Select the complete provider/model/reasoning selection. The durable
   * projection frame updates the shared current; failures surface on the store
   * and return with the operation so each entry can present its own failure.
   * @param selection - provider, provider-owned model id, and optional adapter-owned effort.
   * @returns the selection outcome, including the original Remote failure.
   */
  async select(selection: ModelSelection): Promise<RemoteResult<void>> {
    this.assertAvailable()
    const previous = this.store.getSnapshot().current
    const previousEffort = previous?.reasoningEffort ?? (previous === null ? undefined : this.reasoningFor(previous)?.defaultEffort)
    const nextEffort = selection.reasoningEffort ?? this.reasoningFor(selection)?.defaultEffort
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'selecting'; s.pending = selection; s.error = null })
    const result = await this.sessions.selectModel({
      sessionId: this.sessionId,
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: selection.reasoningEffort },
    })
    if (this.disposed || generation !== this.generation) {
      return result.ok ? { ok: true, value: undefined } : result
    }
    if (!result.ok) {
      this.store.update((s) => {
        s.status = 'error'
        s.pending = null
        s.error = `${result.error.code}: ${result.error.message}`
      })
      return result
    }
    if (previous !== null) {
      const from = `${previous.provider}/${previous.model}`
      const to = `${selection.provider}/${selection.model}`
      if (from !== to) this.track?.('model_switch', { ...this.isBlank() ? {} : { session_id: this.sessionId }, switch_from: from, switch_to: to })
      if (from === to && previousEffort !== nextEffort) this.track?.('thinking_level_switch', {
        ...this.isBlank() ? {} : { session_id: this.sessionId }, model_name: to, switch_from: previousEffort ?? 'default', switch_to: nextEffort ?? 'default',
      })
    }
    this.store.update((s) => { s.status = 'ready'; s.pending = null; s.error = null })
    this.syncInputs()
    return { ok: true, value: undefined }
  }

  /**
   * Invalidate an in-flight selection response from the previous Host generation.
   */
  resetConnected(): void {
    if (this.disposed) return
    ++this.generation
    this.store.update((state) => {
      if (state.status === 'selecting') state.status = 'idle'
      state.pending = null
      state.error = null
    })
    this.syncInputs()
  }

  /** Scope teardown: late settlements lose write access to the store. */
  dispose(): void {
    this.disposed = true
    this.unsubscribeOffered()
    this.unsubscribeSelection()
    this.unsubscribeCatalog()
  }

  /** Reasoning metadata of one model: from the Agent's own list, else the Host catalog. */
  private reasoningFor(selection: ModelSelection): ModelProviderGroup['models'][number]['reasoning'] {
    const offered = agentModelsView(this.offered.getSnapshot())
    if (offered === null) return this.catalog.reasoningFor(selection)
    return offered.groups.find(group => group.id === selection.provider)
      ?.models.find(model => model.id === selection.model)?.reasoning
  }

  private assertAvailable(): void {
    if (!this.available()) {
      throw new Error('model selection is unavailable for addressed subagent sessions')
    }
  }

  private syncInputs(): void {
    if (this.disposed) return
    const offered = agentModelsView(this.offered.getSnapshot())
    if (offered !== null) {
      this.syncOffered(offered)
      return
    }
    const catalog = this.catalog.store.getSnapshot()
    const projected = modelSelectionProjection(this.projected.getSnapshot())
    const intended = projected?.next ?? catalog.value?.default
    const reasoning = intended === undefined ? undefined : this.catalog.reasoningFor(intended)
    const effort = intended?.reasoningEffort ?? reasoning?.defaultEffort
    const retainedEffort = effort === undefined ? undefined
      : reasoning?.efforts.find(level => level.id === effort)?.name ?? effort
    if (catalog.status !== 'ready' || catalog.value === null || projected === undefined) {
      this.store.set({
        current: catalog.value === null ? null : this.store.getSnapshot().current,
        ...retainedEffort === undefined ? {} : { retainedEffort },
        routable: null,
        groups: catalog.value?.groups ?? [],
        failures: catalog.value?.failures ?? [],
        status: catalog.status === 'error' ? 'error' : 'loading',
        pending: this.store.getSnapshot().pending,
        error: catalog.error,
      })
      return
    }
    const selection = projected.next ?? catalog.value.default
    const routable = catalog.value.groups.some(group => group.id === selection.provider
      && group.models.some(model => model.id === selection.model))
    this.store.set({
      current: selection,
      ...retainedEffort === undefined ? {} : { retainedEffort },
      routable,
      groups: catalog.value.groups,
      failures: catalog.value.failures,
      status: this.store.getSnapshot().status === 'selecting'
        ? 'selecting'
        : 'ready',
      pending: this.store.getSnapshot().pending,
      error: null,
    })
  }

  /** State from the Agent's own list: no catalog, no failures; the Agent refuses what it cannot use. */
  private syncOffered(offered: AgentModelsProjection): void {
    const { current, groups } = offered
    const reasoning = current === null ? undefined : this.reasoningFor(current)
    const effort = current?.reasoningEffort ?? reasoning?.defaultEffort
    const retainedEffort = effort === undefined ? undefined
      : reasoning?.efforts.find(level => level.id === effort)?.name ?? effort
    const snapshot = this.store.getSnapshot()
    this.store.set({
      current,
      ...retainedEffort === undefined ? {} : { retainedEffort },
      routable: current === null ? null : groups.some(group => group.id === current.provider
        && group.models.some(model => model.id === current.model)),
      groups,
      failures: [],
      status: snapshot.status === 'selecting' ? 'selecting' : 'ready',
      pending: snapshot.pending,
      error: null,
      agent: { started: offered.started },
    })
  }
}

/**
 * The text an empty model list shows: the Agent's own words when it offers its models.
 * @param state - one directory snapshot.
 * @returns the `model` dictionary key.
 */
export function emptyModelsKey(state: Pick<ModelDirectoryState, 'agent'>): 'empty.models' | 'empty.agentNotStarted' | 'empty.agentModels' {
  if (state.agent === undefined) return 'empty.models'
  return state.agent.started ? 'empty.agentModels' : 'empty.agentNotStarted'
}

/**
 * Read the Agent's own model list.
 * @param value - the `agentModels` projection face's value.
 * @returns the list, or null when the Agent uses the Host catalog.
 */
function agentModelsView(value: unknown): AgentModelsProjection | null {
  return value === undefined || value === null ? null : value as AgentModelsProjection
}

function modelSelectionProjection(value: unknown): ModelSelectionProjection | undefined {
  return value === undefined ? undefined : value as ModelSelectionProjection
}
