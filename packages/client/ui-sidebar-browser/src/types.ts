/** Type-only Electron bridge declarations shared by the desktop shell and browser provider. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Main-issued identity of one guest reservation. */
export type DesktopBrowserLeaseId = Branded<'DesktopBrowserLeaseId'>

/** A guest's approved, process-local storage partition. */
export interface DesktopBrowserReservation {
  readonly lease: DesktopBrowserLeaseId
  readonly partition: string
}

/** Main-approved request to open an HTTP(S) page from an existing guest. */
export interface DesktopBrowserOpenRequest {
  readonly lease: DesktopBrowserLeaseId
  readonly url: string
}

/** Origin-scoped operations; no Electron objects or arbitrary IPC cross this interface. */
export interface DesktopBrowserBridge {
  /** @param workspace - resolved storage account. @returns one approved guest reservation. */
  acquire(workspace: string): Promise<DesktopBrowserReservation>
  /** @param lease - the caller's reservation. @returns after its guest has been destroyed. */
  release(lease: DesktopBrowserLeaseId): Promise<void>
  /** @param lease - originating guest. @param listener - approved URL consumer. @returns unsubscribe callback. */
  onOpenRequested(lease: DesktopBrowserLeaseId, listener: (url: string) => void): () => void
  /**
   * Main checks the sender owns the lease and the guest is attached, then runs one bounded operation.
   * @param lease - the caller's reservation. @param command - operation for its guest.
   * @returns the observation, or a failure value; never rejects for operation failures.
   */
  control(lease: DesktopBrowserLeaseId, command: SidebarBrowserCommand): Promise<SidebarBrowserControlResult>
}

/**
 * One validated operation on an existing guest; no caller-supplied script or CDP crosses the bridge. Coordinates are
 * integer CSS pixels of the guest viewport (0 to 100,000), the space of `read` elements and `screenshot` pixels.
 * `scroll.deltaY` is an integer number of CSS pixels from -100,000 to 100,000 and is positive toward the bottom of the
 * page, as in DOM `WheelEvent.deltaY`. `type.text` holds 1 to 20,000 characters and `navigate.url` at most 16 KiB.
 */
export type SidebarBrowserCommand =
  | { readonly action: 'read' }
  | { readonly action: 'screenshot' }
  | { readonly action: 'navigate'; readonly url: string }
  | { readonly action: 'click'; readonly x: number; readonly y: number }
  | { readonly action: 'type'; readonly text: string }
  | { readonly action: 'key'; readonly key: SidebarBrowserKey }
  | { readonly action: 'scroll'; readonly x: number; readonly y: number; readonly deltaY: number }

/** Keys a command may press; printable text goes through `type`. */
export type SidebarBrowserKey = 'Enter' | 'Tab' | 'Escape' | 'Backspace' | 'Delete' | 'ArrowUp' | 'ArrowDown'
  | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End' | 'PageUp' | 'PageDown' | 'Space'

/**
 * One visible interactive element; its rectangle is clipped to the viewport in CSS pixels, the same space `click`
 * uses. Role and name are page-derived and untrusted.
 */
export interface SidebarBrowserElement {
  /** 1-based position in this `read` result; it identifies nothing across reads. */
  readonly ref: number
  readonly role: string
  readonly name: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Facts observed after one command. Page-derived strings are untrusted data. Input commands report only
 * that input was dispatched, never that the page acted on it.
 */
export interface SidebarBrowserObservation {
  readonly url: string
  readonly title: string
  /** `read`: visible page text, at most 20,000 characters. */
  readonly text?: string
  readonly truncated?: boolean
  /** `read`: at most 200 visible interactive elements in document order. */
  readonly elements?: readonly SidebarBrowserElement[]
  /** `screenshot`: base64 PNG scaled to the CSS viewport, so its pixels are click coordinates. */
  readonly image?: string
  readonly mimeType?: 'image/png'
  readonly width?: number
  readonly height?: number
  /** Input commands: delivery facts only. */
  readonly status?: 'dispatched'
}

/** Stable failure identities shared by the bridge, the Client service and model-facing tools. */
export type SidebarBrowserFailureCode = 'invalid-input' | 'unavailable' | 'operation-failed' | 'result-too-large' | 'timed-out'

/** One Sidebar browser tab of a Session as the Client sees it. `live` means a guest page exists to control. */
export interface SidebarBrowserTab {
  readonly tabId: string
  readonly url: string | undefined
  readonly title: string | undefined
  readonly active: boolean
  readonly live: boolean
}

/** Outcome of a Client-side control request; failures are values so they survive the Host round trip. */
export type SidebarBrowserControlResult =
  | { readonly ok: true; readonly observation: SidebarBrowserObservation }
  | { readonly ok: false; readonly code: SidebarBrowserFailureCode; readonly message: string; readonly outcome: 'not-dispatched' | 'unknown' }

/**
 * Client service through which agent-facing plugins drive one Session's Sidebar browser tabs. Present only in the
 * Desktop renderer, where guests exist. Every call is scoped to the Session it names and never reaches another
 * Session's tabs.
 */
export interface SidebarBrowserControl {
  /** @param sessionId - owning Session. @returns that Session's open browser tabs, in Sidebar layout record order. */
  tabs(sessionId: string): readonly SidebarBrowserTab[]
  /**
   * Opens a tab only while that Session is on screen, then waits up to 30 seconds for its first page. Rejects with
   * `signal.reason` once the signal aborts; a tab already opened stays open.
   * @param sessionId - owning Session. @param url - HTTP(S) address. @param signal - caller cancellation.
   * @returns the new tab once its guest is live, or a failure (for example when the Session is not on screen).
   */
  open(sessionId: string, url: string, signal: AbortSignal): Promise<{ readonly ok: true; readonly tab: SidebarBrowserTab }
    | { readonly ok: false; readonly code: SidebarBrowserFailureCode; readonly message: string }>
  /**
   * Rejects with `signal.reason` once the signal aborts; an operation already sent to the page may still complete.
   * @param sessionId - owning Session. @param tabId - one of its tabs. @param command - validated operation.
   * @param signal - caller cancellation. @returns the observation, or a failure value.
   */
  control(sessionId: string, tabId: string, command: SidebarBrowserCommand, signal: AbortSignal): Promise<SidebarBrowserControlResult>
}
