/** The Client face mounts the `account` namespace and withdraws it with the plugin. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, vi } from 'vitest'
import { inject, mountAccount } from '../src/client/mount.ts'

const REMOTE: TypertRemoteContribution = { package: '@deepseek-ai/dsh-api-account-controller', descriptors: [] }

it('mounts the supplied contribution and withdraws it when the plugin unloads', async () => {
  const ctx = new Context()
  const unmount = vi.fn(async () => {})
  const mount = vi.fn(async (_contribution: TypertRemoteContribution) => unmount)
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    $mount = mount
  }
  new Remote()
  try {
    const fiber = ctx.plugin({ inject: [...inject], apply: (child: Context) => mountAccount(child, REMOTE) })
    await fiber
    expect(mount).toHaveBeenCalledExactlyOnceWith(REMOTE)
    expect(unmount).not.toHaveBeenCalled()
    await fiber.dispose()
    expect(unmount).toHaveBeenCalledOnce()
  } finally {
    await ctx.fiber.dispose()
  }
})
