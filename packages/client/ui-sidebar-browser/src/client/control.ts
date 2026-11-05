/** Session-scoped agent control of Desktop Sidebar Browser tabs. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SidebarRightOpenTab } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type {
  SidebarBrowserCommand, SidebarBrowserControl, SidebarBrowserControlResult, SidebarBrowserFailureCode, SidebarBrowserTab,
} from '../types.ts'
import type { BrowserControllerState } from './browser/BrowserController.ts'
import { browserControlFailure } from './browser/BrowserFrame.ts'
import { parseBrowserAddress } from './browser/url.ts'
import { BROWSER_KIND } from './definition.tsx'

/** One Session's Browser tab controllers, as the control service reads them. */
export interface BrowserControlSession {
  /** @param tabId - one of the Session's tabs. @returns its state, or `undefined` before its body first mounts. */
  state(tabId: TabId): BrowserControllerState | undefined
  /** @param tabId - one of the Session's tabs. @param command - agent operation. @returns the page's result. */
  control(tabId: TabId, command: SidebarBrowserCommand): Promise<SidebarBrowserControlResult>
}

/** Sidebar facts and Browser controllers the service combines. */
export interface SidebarBrowserControlSources {
  /** Authoritative tab membership of every Session. */
  readonly openTabs: ObservableSnapshot<readonly SidebarRightOpenTab[]>
  /** The Session on screen, the only one that can open a tab. */
  readonly onScreen: ObservableSnapshot<string | undefined>
  /** @returns the on-screen Session's active tab. */
  readonly activeTab: () => string | undefined
  /** @param url - validated address; opens a Browser tab in the on-screen Session. */
  readonly openTab: (url: string) => void
  /** @param sessionId - owning Session. @returns its controllers, or `undefined` before its Sidebar first renders. */
  readonly session: (sessionId: string) => BrowserControlSession | undefined
  /** Changes whenever a controller is created, changes state or is forgotten. */
  readonly controllers: ObservableSnapshot<unknown>
  /** Casper document origin, which an address may not target. */
  readonly applicationOrigin: string
  /** Bound for a new tab's first page. */
  readonly openTimeoutMs: number
}

type OpenResult = Awaited<ReturnType<SidebarBrowserControl['open']>>

function openFailure(code: SidebarBrowserFailureCode, message: string): OpenResult {
  return { ok: false, code, message }
}

/**
 * Wait until `check` returns a value, re-evaluating on every source change.
 * @returns the value, or `undefined` after `timeoutMs`; rejects with `signal.reason` on abort.
 */
function settle<T>(sources: readonly ObservableSnapshot<unknown>[], signal: AbortSignal, timeoutMs: number,
  check: () => T | undefined): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const stops: (() => void)[] = []
    const stop = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      for (const unsubscribe of stops.splice(0)) unsubscribe()
    }
    const abort = (): void => {
      stop()
      const reason: unknown = signal.reason
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the caller-owned AbortSignal reason.
      reject(reason)
    }
    const evaluate = (): void => {
      const value = check()
      if (value === undefined) return
      stop()
      resolve(value)
    }
    const timer = setTimeout(() => { stop(); resolve(undefined) }, timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    for (const source of sources) stops.push(source.subscribe(evaluate))
    evaluate()
  })
}

/**
 * Resolve with the operation's result unless the signal aborts first; the operation itself is not cancelled.
 * @returns the result; rejects with `signal.reason` on abort.
 */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      const reason: unknown = signal.reason
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the caller-owned AbortSignal reason.
      reject(reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    void operation.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}

/**
 * Build the `sidebarBrowserControl` service. Every call names its Session and reaches only Browser tabs that the
 * Sidebar layout records for that Session.
 * @param sources - Sidebar membership, on-screen Session, tab opening and per-Session controllers.
 * @returns the service.
 */
export function createSidebarBrowserControl(sources: SidebarBrowserControlSources): SidebarBrowserControl {
  const owned = (sessionId: string): readonly SidebarRightOpenTab[] => sources.openTabs.getSnapshot()
    .filter(tab => tab.sessionId === sessionId && tab.kind === BROWSER_KIND)
  const describe = (sessionId: string, tabId: TabId): SidebarBrowserTab => {
    const state = sources.session(sessionId)?.state(tabId)
    const target = state?.frame.target ?? state?.restoreTarget
    return {
      tabId, url: target?.url, title: target?.title,
      active: sources.onScreen.getSnapshot() === sessionId && sources.activeTab() === tabId,
      live: state?.frame.live ?? false,
    }
  }
  return {
    tabs: sessionId => owned(sessionId).map(tab => describe(sessionId, tab.tabId)),

    async open(sessionId, url, signal) {
      signal.throwIfAborted()
      const parsed = parseBrowserAddress(url, sources.applicationOrigin)
      if (!parsed.ok) return openFailure('invalid-input', `Browser address is not an allowed HTTP(S) URL (${parsed.reason})`)
      if (sources.onScreen.getSnapshot() !== sessionId) {
        return openFailure('unavailable', 'Open this conversation in Casper to use its browser.')
      }
      const before = new Set(owned(sessionId).map(tab => tab.tabId))
      try { sources.openTab(parsed.target.url) }
      catch (error) {
        console.error('Sidebar Browser tab could not be opened', error)
        return openFailure('operation-failed', 'Browser tab could not be opened')
      }
      let opened: TabId | undefined
      const settled = await settle([sources.openTabs, sources.controllers], signal, sources.openTimeoutMs, () => {
        const tabs = owned(sessionId)
        opened ??= tabs.find(tab => !before.has(tab.tabId))?.tabId
        if (opened === undefined) return undefined
        if (!tabs.some(tab => tab.tabId === opened)) return 'closed'
        const frame = sources.session(sessionId)?.state(opened)?.frame
        return frame?.live === true && ((frame.address === 'observed' && !frame.loading) || frame.error !== undefined)
          ? 'ready' : undefined
      })
      if (settled === 'closed') return openFailure('unavailable', 'Browser tab was closed while opening')
      // A live tab whose first page is still loading is usable; only a tab without a page is a failure.
      if (opened !== undefined && describe(sessionId, opened).live) return { ok: true, tab: describe(sessionId, opened) }
      return openFailure('timed-out', 'Browser tab did not open its page in time; list tabs before retrying')
    },

    async control(sessionId, tabId, command, signal) {
      signal.throwIfAborted()
      const tab = owned(sessionId).find(candidate => candidate.tabId === tabId)
      const session = sources.session(sessionId)
      if (tab === undefined || session === undefined) {
        return browserControlFailure('unavailable', 'No browser tab with this id is open in this conversation')
      }
      return abortable(session.control(tab.tabId, command), signal)
    },
  }
}
