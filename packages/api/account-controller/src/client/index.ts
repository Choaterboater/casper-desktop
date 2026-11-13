/**
 * Client face: mounts this package's generated `account` Remote namespace, so
 * the namespace exists exactly while the account-controller row is enabled.
 * @module @deepseek-ai/dsh-api-account-controller/client
 */
import type { Context } from '@deepseek-ai/cordis'
import accountRemote from '@deepseek-ai/dsh-api-account-controller/remote'
import { mountAccount } from './mount.ts'
export type {} from '@deepseek-ai/dsh-api-account-controller/remote'

export { inject } from './mount.ts'

/**
 * Mount the generated `account` namespace.
 * @param ctx - Client root Context.
 * @returns disposer that withdraws the namespace.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountAccount(ctx, accountRemote)
}
