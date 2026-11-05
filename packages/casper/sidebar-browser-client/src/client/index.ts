/**
 * Desktop Client half of the Sidebar browser tools. It answers `casper-sidebar-browser/request` for the Session
 * that issued it by driving `sidebarBrowserControl`; a Client without that service, such as the Web client, or a
 * request without a Session delegates with `next()`.
 *
 * A pending waterfall is delivered again after a reconnect with the same operation id. The Client answers a
 * repeated `open` or input command from the first run instead of running it twice, and runs it again only when the
 * first run reported that nothing was sent.
 * @module @deepseek-ai/dsh-casper-sidebar-browser-client/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-browser/client'
import type {} from '@deepseek-ai/dsh-casper-sidebar-browser/types'
import { dispatch, ReplayLog } from './dispatch.ts'

/** Required services: Session scopes and forwarded Host events. */
export const inject = ['sessions', 'remote']

/**
 * Answer the Host's browser requests for the Session each request belongs to.
 * @param ctx - Client context with Session scopes and forwarded Host events.
 */
export function apply(ctx: Context): void {
  const replays = new ReplayLog()
  ctx.remote.$on('casper-sidebar-browser/request', function (request, next) {
    const control = ctx.get('sidebarBrowserControl')
    const sessionId = ctx.sessions.scopeOf(this)
    if (control === undefined || sessionId === undefined) return next()
    const signal = request.signal ?? new AbortController().signal
    return replays.run(sessionId, request, () => dispatch(control, sessionId, request.operation, signal))
  })
}
