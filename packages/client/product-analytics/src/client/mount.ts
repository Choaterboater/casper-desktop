/**
 * Source-safe Client lifecycle of the analytics sender: mounts the generated
 * `productAnalytics` Remote contribution the entry module supplies, then
 * provides the `productAnalytics` Client service while that namespace exists.
 * @module @deepseek-ai/dsh-client-product-analytics/src/client/mount
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-product-analytics/remote'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { ProductEvent, ProductEventMap } from '../events.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    productAnalytics: DesktopAnalytics
  }
}

class DesktopAnalytics extends Service {
  private collecting = false
  // RPC dispatch stays in the provider context when Cordis traces a consumer call.
  private readonly submit: (event: ProductEvent) => Promise<void>

  constructor(ctx: Context) {
    super(ctx, 'productAnalytics')
    this.submit = async (event) => {
      try { await ctx.remote.productAnalytics.report(event) } catch (_error) {
        // Missing or disconnected Remote services must not interrupt the interaction.
      }
    }
    if (!('dshDesktop' in globalThis)) return
    const stream = ctx.remote.$stream<boolean>({
      name: 'product analytics policy', open: signal => ctx.remote.productAnalytics.watchPolicy(signal),
      ended: () => new Error('product analytics policy stream ended'),
      carrierFailed: () => { this.collecting = false },
    })
    ctx.effect(() => () => { this.collecting = false; return stream.dispose() })
    void (async () => {
      for await (const frame of stream) { this.collecting = frame.value; frame.accept() }
    })().catch(() => { this.collecting = false })
  }

  /** Whether the synchronized Host configuration currently permits collection. */
  get enabled(): boolean {
    return this.collecting
  }

  /**
   * Send an event without retaining it for reconnect or later enablement.
   * @param name - event name.
   * @param attributes - approved business fields.
   * @param timestamp - occurrence time; defaults to the current time.
   */
  track<K extends keyof ProductEventMap>(name: K, attributes: ProductEventMap[K], timestamp = Date.now()): void {
    if (!this.enabled) return
    const event = { eventName: name, attributes, timestamp } as ProductEvent
    void this.submit(event)
  }
}

/** Required Client service: the Remote mount face that receives the generated contribution. */
export const inject = ['remote']

/**
 * Mount the `productAnalytics` namespace and provide the sender while that namespace is available.
 * @param ctx - Client root Context injecting `remote`.
 * @param contribution - generated `productAnalytics` Remote contribution.
 * @returns disposer that withdraws the sender, then the namespace.
 * @throws the sender's setup failure, after both the sender and the namespace are withdrawn.
 */
export async function mountProductAnalytics(
  ctx: Context,
  contribution: TypertRemoteContribution,
): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(contribution)
  const sender = ctx.inject(['remote.productAnalytics'], (scope: Context) => { new DesktopAnalytics(scope) })
  try {
    await sender
  } catch (error) {
    await sender.dispose()
    await unmount()
    throw error
  }
  return async () => {
    await sender.dispose()
    await unmount()
  }
}
