/** Operation dispatch and replay suppression of the Desktop Client half. */

import type {
  SidebarBrowserControl, SidebarBrowserTab,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type {
  SidebarBrowserToolOperation, SidebarBrowserToolRequest, SidebarBrowserToolResponse, SidebarBrowserToolTab,
} from '@deepseek-ai/dsh-casper-sidebar-browser/types'

/** Settled answers kept for replay; a reconnect replays only the few requests that were pending. */
const REPLAY_WINDOW = 64

/**
 * Convert a tab to lossless JSON, with `null` for an absent URL or title.
 * @param tab - the service's view of a tab.
 * @returns its JSON form.
 */
export function toolTab(tab: SidebarBrowserTab): SidebarBrowserToolTab {
  return { tabId: tab.tabId, url: tab.url ?? null, title: tab.title ?? null, active: tab.active, live: tab.live }
}

function failed(code: 'invalid-input' | 'operation-failed', message: string): SidebarBrowserToolResponse {
  return { kind: 'failed', code, message, outcome: 'not-dispatched' }
}

/**
 * Run one operation against the Session's tabs.
 * @param control - the Desktop browser service.
 * @param sessionId - the Session that issued the request.
 * @param operation - the requested operation.
 * @param signal - the tool call's cancellation.
 * @returns the answer; failures are values.
 */
export async function dispatch(
  control: SidebarBrowserControl,
  sessionId: string,
  operation: SidebarBrowserToolOperation,
  signal: AbortSignal,
): Promise<SidebarBrowserToolResponse> {
  switch (operation.kind) {
    case 'tabs':
      return { kind: 'tabs', tabs: control.tabs(sessionId).map(toolTab) }
    case 'open': {
      const opened = await control.open(sessionId, operation.url, signal)
      if (opened.ok) return { kind: 'opened', tab: toolTab(opened.tab) }
      return { kind: 'failed', code: opened.code, message: opened.message, outcome: opened.code === 'timed-out' ? 'unknown' : 'not-dispatched' }
    }
    case 'control': {
      if (operation.origin !== undefined) {
        const tab = control.tabs(sessionId).find(candidate => candidate.tabId === operation.tabId)
        if (tab === undefined) return failed('invalid-input', `No browser tab has id "${operation.tabId}".`)
        const current = tab.url === undefined ? undefined : URL.parse(tab.url)?.origin
        if (current !== operation.origin) {
          return failed('operation-failed', `The tab left ${operation.origin} before the input was sent. Read the page, then try again.`)
        }
      }
      const result = await control.control(sessionId, operation.tabId, operation.command, signal)
      if (result.ok) return { kind: 'observed', observation: result.observation }
      return { kind: 'failed', code: result.code, message: result.message, outcome: result.outcome }
    }
    default:
      // The request crossed the wire from the Host; an operation this Client does not know runs nothing.
      return failed('invalid-input', 'The browser does not know this operation.')
  }
}

/**
 * @param operation - a requested operation.
 * @returns whether running it twice could act on a page twice.
 */
function changesPages(operation: SidebarBrowserToolOperation): boolean {
  return operation.kind === 'open' || (operation.kind === 'control' && operation.command.action !== 'read' && operation.command.action !== 'screenshot')
}

/** Answers of recent `open` and input operations, keyed by Session and operation id, for replayed requests. */
export class ReplayLog {
  private readonly answers = new Map<string, Promise<SidebarBrowserToolResponse>>()

  /**
   * Run a request once per operation id. A replay of an operation that may have reached the page returns the first
   * answer; a replay of one that sent nothing runs again. Reads and screenshots always run.
   * @param sessionId - the Session that issued the request.
   * @param request - the forwarded request's operation id and operation.
   * @param run - runs the operation.
   * @returns the operation's answer.
   */
  async run(
    sessionId: string,
    request: Pick<SidebarBrowserToolRequest, 'operationId' | 'operation'>,
    run: () => Promise<SidebarBrowserToolResponse>,
  ): Promise<SidebarBrowserToolResponse> {
    if (!changesPages(request.operation)) return await run()
    const key = `${sessionId}\u0000${request.operationId}`
    const earlier = this.answers.get(key)
    if (earlier !== undefined) {
      const answer = await earlier.then(value => value, () => undefined)
      if (answer === undefined) {
        return {
          kind: 'failed',
          code: 'operation-failed',
          message: 'An earlier attempt of this action was interrupted.',
          outcome: 'unknown',
        }
      }
      if (answer.kind !== 'failed' || answer.outcome !== 'not-dispatched') return answer
    }
    const answer = run()
    this.answers.delete(key)
    this.answers.set(key, answer)
    for (const oldest of this.answers.keys()) {
      if (this.answers.size <= REPLAY_WINDOW) break
      this.answers.delete(oldest)
    }
    return await answer
  }
}
