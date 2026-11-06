/**
 * The model handle of a Casper Agent: Casper's own models, not the Host catalog.
 * @module @deepseek-ai/dsh-casper-agent/model
 */

import type { AgentModelsState, Model, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

/**
 * Reads Casper's model from the `agentModels` projection and records picks as
 * `model/selection`. `own.choose` is where a user's pick goes: the Agent checks
 * it against Casper's list and applies it to Casper.
 */
export class CasperModel implements Model {
  readonly own: { choose(selection: Readonly<ModelSelection>): Promise<ModelSelection> }

  /**
   * @param readState - reader of this Session's `agentModels` state.
   * @param session - the Session that records picks.
   * @param choose - the Agent's check-and-apply of one pick.
   */
  constructor(
    private readonly readState: () => AgentModelsState,
    private readonly session: Session,
    choose: (selection: Readonly<ModelSelection>) => Promise<ModelSelection>,
  ) {
    this.own = { choose }
  }

  /**
   * The pick not yet applied, else the model Casper last reported.
   * @returns a detached selection, or undefined before Casper reported one.
   */
  current(): Readonly<ModelSelection> | undefined {
    const { wanted, reported } = this.readState()
    const selection = wanted ?? reported?.current ?? undefined
    return selection === undefined ? undefined : { ...selection }
  }

  /**
   * Record a pick for Casper to apply; a pick equal to the current one is not recorded.
   * @param selection - the pick.
   */
  select(selection: Readonly<ModelSelection>): void {
    const current = this.current()
    if (current !== undefined && current.provider === selection.provider && current.model === selection.model
      && current.reasoningEffort === selection.reasoningEffort) return
    this.session.append('model/selection', {
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    })
  }
}
