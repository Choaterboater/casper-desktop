/** Desktop renderer analytics sender; browser applications have no collection capability. */
import type { Context } from '@deepseek-ai/cordis'
import productAnalyticsRemote from '@deepseek-ai/dsh-client-product-analytics/remote'
import { mountProductAnalytics } from './mount.ts'
export type {} from '@deepseek-ai/dsh-client-product-analytics/remote'
export type {
  AnalyticsPreset, EntryAnalyticsRegion, ProductEvent, ProductEventMap,
  SidebarAnalyticsEntry, SidebarAnalyticsPosition, TrackProductEvent,
} from '../events.ts'

export { inject } from './mount.ts'

/**
 * Mount this package's own `productAnalytics` Remote namespace and the sender over it.
 * @param ctx - browser application context.
 * @returns disposer that withdraws the sender, then the namespace.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountProductAnalytics(ctx, productAnalyticsRemote)
}
