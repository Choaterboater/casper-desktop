/** Carrier-neutral page navigation and observable state. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarBrowserCommand, SidebarBrowserControlResult, SidebarBrowserFailureCode } from '../../types.ts'
import type { BrowserTarget } from './url.ts'

/** A loading failure, optionally carrying the underlying browser's diagnostic. */
export interface BrowserLoadError {
  readonly code: number | undefined
  readonly description: string | undefined
}

/** State consumed by common browser chrome, without DOM or carrier identifiers. */
export interface BrowserFrameState {
  readonly target: BrowserTarget | undefined
  readonly address: 'empty' | 'requested' | 'observed' | 'unknown'
  readonly loading: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly error: BrowserLoadError | undefined
  /** Undefined when this provider does not expose a sandbox control. */
  readonly sandboxEnabled: boolean | undefined
  /** Whether a page exists that `control` can reach; always false for providers without agent control. */
  readonly live: boolean
}

/** Optional iframe policy control, not an Electron process-sandbox switch. */
export interface BrowserSandboxControl {
  /** @param enabled - whether the provider's embedding sandbox is enforced. */
  setEnabled(enabled: boolean): void
}

/** Navigation owns page lifetime; mounting and hiding belong to BrowserPresentation. */
export interface BrowserFrame extends HostObservable<BrowserFrameState> {
  readonly sandbox?: BrowserSandboxControl
  /** @param target - validated HTTP(S) address; loading failures are published in state. */
  loadUrl(target: BrowserTarget): void
  /** Move backward when the provider reports an available entry. */
  goBack(): void
  /** Move forward when the provider reports an available entry. */
  goForward(): void
  /** Reload the current address without creating a new history entry. */
  reload(): void
  /**
   * Run one agent operation on the page.
   * @param command - operation from a Session-scoped caller.
   * @returns the observation or a failure value; providers without agent control return `unavailable`.
   */
  control(command: SidebarBrowserCommand): Promise<SidebarBrowserControlResult>
  /** @returns after the page, listeners and pending initialization have been released; repeated calls join disposal. */
  dispose(): Promise<void>
}

/**
 * Create idle navigation state without a page target.
 * @returns state before any page has been requested.
 */
export function emptyBrowserFrame(): BrowserFrameState {
  return { target: undefined, address: 'empty', loading: false, canGoBack: false, canGoForward: false,
    error: undefined, sandboxEnabled: undefined, live: false }
}

/**
 * Build a control failure value.
 * @param code - stable failure identity.
 * @param message - English diagnostic for the agent-facing caller.
 * @param outcome - whether the operation may have reached the page.
 * @returns a failure that survives the Host round trip.
 */
export function browserControlFailure(code: SidebarBrowserFailureCode, message: string,
  outcome: 'not-dispatched' | 'unknown' = 'not-dispatched'): SidebarBrowserControlResult {
  return { ok: false, code, message, outcome }
}
