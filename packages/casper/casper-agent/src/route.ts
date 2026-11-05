/**
 * The factory route that sends Casper-preset Sessions to the Casper factory.
 * @module @deepseek-ai/dsh-casper-agent/route
 */

import type { AgentFactory, AgentFactoryRoute } from '@deepseek-ai/dsh-agent'

/**
 * Route root Sessions on the configured presets to `factory`. Delegated
 * children and Sessions without a named preset keep the default factory;
 * forks reach the factory, which refuses them.
 * @param presets - presets Casper drives.
 * @param factory - the Casper Agent factory.
 * @returns the route to register with `ctx.agents.route`.
 */
export function casperRoute(presets: readonly string[], factory: AgentFactory): AgentFactoryRoute {
  return {
    factory,
    selects: facts => facts.origin !== 'subagent' && facts.agentPreset !== undefined && presets.includes(facts.agentPreset),
  }
}
