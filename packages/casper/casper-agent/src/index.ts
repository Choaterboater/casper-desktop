/**
 * Casper agent plugin: Sessions on a Casper preset are driven by the Casper
 * agent over its ACP server (`casper acp`) instead of the DeepSeek agent loop.
 * Every other Session keeps the default factory.
 *
 * @module @deepseek-ai/dsh-casper-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import { agentModelsProjectionDefinition, modelSelectionProjectionDefinition } from '@deepseek-ai/dsh-agent'
import { inboxProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { planProjectionDefinition } from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'
import { checkAccessModes } from './access.ts'
import { casperAccessProjectionDefinition } from './access-projection.ts'
import { openCommandCache } from './commands.ts'
import { Config } from './config.ts'
import { CasperAgentFactory } from './factory.ts'
import { openModelsCache } from './models-cache.ts'
import { casperRoute } from './route.ts'
import { openSidecar } from './sidecar.ts'

export { Config } from './config.ts'
export { ACCESS_MODE_IDS, ACCESS_MODE_LABELS, accessModeFor, checkAccessModes, DEFAULT_ACCESS_MODES } from './access.ts'
export type { AccessModeId } from './access.ts'
export { CasperAgent, FORK_BEHIND_NOTICE, FORK_FRESH_NOTICE, FRESH_CONVERSATION_NOTICE } from './agent.ts'
export type { CasperAgentReaders } from './agent.ts'
export { CasperAgentFactory } from './factory.ts'
export type { CasperFactoryDependencies } from './factory.ts'
export { CasperCommandCache, casperCommandId, casperCommands, casperCommandsDomain, openCommandCache } from './commands.ts'
export type { CasperCommand } from './commands.ts'
export { CasperConnection, CasperError, casperArgv, casperEnv } from './connection.ts'
export { CasperModel } from './model.ts'
export { effortState, reportOf, valueOf, withCurrent } from './models.ts'
export { CasperModelsCache, casperModelsDomain, openModelsCache } from './models-cache.ts'
export type { CasperModelsRecord } from './models-cache.ts'
export type { CasperConnectionHandlers, CasperConnectionOptions, CasperFailureCode, CasperStarted } from './connection.ts'
export { casperRoute } from './route.ts'
export { casperAgentDomain, CasperSidecar, openSidecar } from './sidecar.ts'
export type { CasperSessionRecord } from './sidecar.ts'

/** Cordis plugin name. */
export const name = 'casper-agent'

/**
 * Services the factory and its Agents use; the Agent scope inherits them. `userQuestions`, `skills`,
 * `profileContext`, `attachments`, `commands`, `permissionPresets`, `sessionTitle`, and the optional `sessionReferenceResolver`,
 * which reads the Sessions a message mentions, are read when present.
 */
export const inject = ['agents', 'sessions', 'sessionProjections', 'sessionPersistence', 'subprocess', 'storageDomain', 'tools']

/**
 * Register the Casper factory route.
 * @param ctx - plugin context.
 * @param config - validated plugin config.
 * @returns resolution once the route is registered.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  checkAccessModes(config.accessModes)
  // Clients read a Casper Session's badge from agentModels; modelSelection stays registered for the readers that fold it.
  await ctx.sessionProjections.register(modelSelectionProjectionDefinition)
  const agentModels = await ctx.sessionProjections.register(agentModelsProjectionDefinition)
  const inbox = await ctx.sessionProjections.register(inboxProjectionDefinition)
  // Only plan-mode's projection: the composer's plan chip shows Casper's Plan first option. Its controller is never applied.
  const plan = await ctx.sessionProjections.register(planProjectionDefinition)
  // The access mode Casper picked itself, which the composer's mode pill shows.
  const casperAccess = await ctx.sessionProjections.register(casperAccessProjectionDefinition)
  const sidecar = await openSidecar(ctx.storageDomain)
  // Records of Sessions that are gone are dropped in the background; disposal waits for it before closing the sidecar.
  const pruned = sidecar.prune(async sessionId => await ctx.sessionPersistence.stat(sessionId) !== undefined).then(
    (count) => { if (count > 0) ctx.logger.debug(`casper agent: dropped ${count} records of deleted sessions`) },
    (error: unknown) => { ctx.logger.warn(`casper agent: records of deleted sessions not dropped: ${String(error)}`) },
  )
  const commands = await openCommandCache(ctx.storageDomain)
  const models = await openModelsCache(ctx.storageDomain)
  const factory = new CasperAgentFactory(ctx, config, { agentModels, inbox, plan, casperAccess, sidecar, commands, models })
  ctx.effect(() => async () => {
    await factory.dispose()
    await pruned
    await sidecar.close()
    await commands.close()
    await models.close()
  }, 'casperAgent.factory()')
  ctx.effect(() => ctx.agents.route(casperRoute(config.presets, factory)), 'casperAgent.route()')
}
