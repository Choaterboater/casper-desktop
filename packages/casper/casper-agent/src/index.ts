/**
 * Casper agent plugin: Sessions on a Casper preset are driven by the Casper
 * agent over its ACP server (`casper acp`) instead of the DeepSeek agent loop.
 * Every other Session keeps the default factory.
 *
 * @module @deepseek-ai/dsh-casper-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import { modelSelectionProjectionDefinition } from '@deepseek-ai/dsh-agent'
import { inboxProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'
import { Config } from './config.ts'
import { CasperAgentFactory } from './factory.ts'
import { casperRoute } from './route.ts'
import { openSidecar } from './sidecar.ts'

export { Config } from './config.ts'
export { CasperAgent, FRESH_CONVERSATION_NOTICE } from './agent.ts'
export type { CasperAgentReaders } from './agent.ts'
export { CasperAgentFactory, FORK_UNSUPPORTED } from './factory.ts'
export type { CasperFactoryDependencies } from './factory.ts'
export { CasperConnection, CasperError, casperArgv, casperEnv } from './connection.ts'
export type { CasperConnectionHandlers, CasperConnectionOptions, CasperFailureCode, CasperStarted } from './connection.ts'
export { casperRoute } from './route.ts'
export { casperAgentDomain, CasperSidecar, openSidecar } from './sidecar.ts'
export type { CasperSessionRecord } from './sidecar.ts'

/** Cordis plugin name. */
export const name = 'casper-agent'

/**
 * Services the factory and its Agents use; the Agent scope inherits them. `userQuestions`, `skills`, and
 * `profileContext` are read when present.
 */
export const inject = ['agents', 'sessions', 'sessionProjections', 'sessionPersistence', 'subprocess', 'storageDomain', 'tools']

/**
 * Register the Casper factory route.
 * @param ctx - plugin context.
 * @param config - validated plugin config.
 * @returns resolution once the route is registered.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const modelSelection = await ctx.sessionProjections.register(modelSelectionProjectionDefinition)
  const inbox = await ctx.sessionProjections.register(inboxProjectionDefinition)
  const sidecar = await openSidecar(ctx.storageDomain)
  const factory = new CasperAgentFactory(ctx, config, { modelSelection, inbox, sidecar })
  ctx.effect(() => async () => {
    await factory.dispose()
    await sidecar.close()
  }, 'casperAgent.factory()')
  ctx.effect(() => ctx.agents.route(casperRoute(config.presets, factory)), 'casperAgent.route()')
}
