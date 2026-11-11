/**
 * The app route a child of a Casper Session runs on: Casper's current model
 * when the app has the same provider and model, otherwise the app's default.
 * @module @deepseek-ai/dsh-casper-agent/child-route
 */

import type { AgentOptions, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'

/**
 * Find the app route for Casper's current model, by exact provider and model id only.
 * @param llm - the app's model routes.
 * @param current - the provider, model and effort Casper last reported.
 * @param signal - stops the adapter's lookup.
 * @returns the route, with Casper's effort only when the model lists it, or undefined when the app has no such route.
 */
export async function matchChildRoute(
  llm: Pick<LlmRuntime, 'listProviders' | 'resolveModelInfo'>,
  current: ModelSelection,
  signal?: AbortSignal,
): Promise<ModelSelection | undefined> {
  if (!llm.listProviders().some(provider => provider.id === current.provider)) return undefined
  let efforts: readonly string[]
  try {
    const info = await llm.resolveModelInfo(current.provider, current.model, signal)
    efforts = info.reasoning?.efforts.map(effort => effort.id) ?? []
  } catch {
    // The adapter does not know this model, or the lookup stopped.
    return undefined
  }
  const effort = current.reasoningEffort
  return {
    provider: current.provider,
    model: current.model,
    ...effort !== undefined && efforts.includes(effort) ? { reasoningEffort: effort } : {},
  }
}

/** The fields of an Agent's options that name its route. */
const ROUTE_FIELDS: ReadonlySet<string> = new Set(['provider', 'model', 'reasoningEffort'])

/**
 * The Agent options a Casper Agent shows the app: the route of `route()` when it returns one, otherwise the
 * options it was created with, read live; every other field comes from those options as it is defined there.
 * @param start - the options the Agent was created with, whose getters may follow the app's default model.
 * @param route - the matched route, read at each access.
 * @returns options whose provider, model and effort follow the match.
 */
export function routedOptions(start: AgentOptions, route: () => ModelSelection | undefined): AgentOptions {
  // Every other field, such as maxTokens, keeps its own getter or value.
  const kept = Object.entries(Object.getOwnPropertyDescriptors(start)).filter(([key]) => !ROUTE_FIELDS.has(key))
  const options: AgentOptions = Object.defineProperties({}, Object.fromEntries(kept))
  const field = (read: (matched: ModelSelection) => string | undefined, fallback: () => string | undefined): PropertyDescriptor => ({
    enumerable: true,
    configurable: true,
    get: () => {
      const matched = route()
      return matched === undefined ? fallback() : read(matched)
    },
  })
  return Object.defineProperties(options, {
    provider: field(matched => matched.provider, () => start.provider),
    model: field(matched => matched.model, () => start.model),
    reasoningEffort: field(matched => matched.reasoningEffort, () => start.reasoningEffort),
  })
}
