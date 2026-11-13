/**
 * Source-safe Client lifecycle of the `account` Remote namespace. The entry
 * module supplies the generated contribution, so specs mount a fake one.
 * @module @deepseek-ai/dsh-api-account-controller/src/client/mount
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-account-controller/remote'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

/** Required Client service: the Remote mount face that receives the generated contribution. */
export const inject = ['remote']

/**
 * Mount the `account` namespace for account screens such as `ui-settings-account`.
 * @param ctx - Client root Context injecting `remote`.
 * @param contribution - generated `account` Remote contribution.
 * @returns disposer that withdraws the namespace.
 */
export async function mountAccount(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  return await ctx.remote.$mount(contribution)
}
