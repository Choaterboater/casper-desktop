/**
 * Client-safe operation, response, and event types that carry one Sidebar browser operation from the Host tools
 * to the Desktop Client showing the calling Agent's Session.
 * @module @deepseek-ai/dsh-casper-sidebar-browser/types
 */

import type { Agent } from '@deepseek-ai/dsh-agent/types'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type {
  SidebarBrowserCommand, SidebarBrowserFailureCode, SidebarBrowserObservation,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

/** One operation on the calling Session's Sidebar browser. */
export type SidebarBrowserToolOperation =
  | { readonly kind: 'tabs' }
  | { readonly kind: 'open'; readonly url: string }
  | {
    readonly kind: 'control'
    readonly tabId: string
    readonly command: SidebarBrowserCommand
    /**
     * Origin the user allowed for an input command. The Client dispatches nothing when the tab's current page
     * has another origin.
     */
    readonly origin?: string
  }

/** One Sidebar browser tab in JSON form: a tab without a page or title carries `null`. */
export interface SidebarBrowserToolTab {
  readonly tabId: string
  readonly url: string | null
  readonly title: string | null
  readonly active: boolean
  readonly live: boolean
}

/** Answer to one operation. Every field is lossless JSON; page-derived strings are untrusted data. */
export type SidebarBrowserToolResponse =
  | { readonly kind: 'tabs'; readonly tabs: readonly SidebarBrowserToolTab[] }
  | { readonly kind: 'opened'; readonly tab: SidebarBrowserToolTab }
  | { readonly kind: 'observed'; readonly observation: SidebarBrowserObservation }
  | {
    readonly kind: 'failed'
    readonly code: SidebarBrowserFailureCode
    readonly message: string
    /** `unknown` when the operation may have reached the page before it failed. */
    readonly outcome: 'not-dispatched' | 'unknown'
  }

/** Payload of the `casper-sidebar-browser/request` waterfall. */
export interface SidebarBrowserToolRequest {
  /**
   * Fresh for every tool call. A request replayed after a reconnect keeps its id, and the Client answers a
   * repeated `open` or input command with the first run's answer instead of running it again.
   */
  readonly operationId: string
  readonly operation: SidebarBrowserToolOperation
  /** Agent identity projected to the corresponding Client Context in transit. */
  readonly agent?: Agent
  /** Cancellation lifetime of the tool call. */
  readonly signal?: AbortSignal
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Run one operation on the Sidebar browser of the Agent's Session. The Desktop Client showing that Session
     * answers; a Client without the browser or without the Session calls `next()`. Scope-filtered dispatch
     * (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @param request - operation, operation id, owner Agent, and cancellation.
     * @param next - delegate to later answerers; the last one reports that no Desktop app answered.
     * @mode waterfall
     */
    'casper-sidebar-browser/request'(
      this: Scoped<Agent>,
      request: SidebarBrowserToolRequest,
      next: () => Promise<SidebarBrowserToolResponse>,
    ): Promise<SidebarBrowserToolResponse>
  }
}
