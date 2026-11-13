/**
 * Browser-safe values of the `casperSignIn` Remote namespace: the ways Casper
 * signs in, the sign-ins it has saved, and the steps of one running sign-in.
 * None of them carries a key or a token.
 * @module @deepseek-ai/dsh-casper-agent/types
 */
import type {} from '@deepseek-ai/dsh-typert-protocol'

/** How a sign-in way finishes: a pasted key, a page in the browser, or a code entered on a page. */
export type CasperSignInKind = 'api_key' | 'browser' | 'device_code'

/** One way Casper signs in, as its router lists it. */
export interface CasperSignInMethod {
  /** Casper's method id, sent back to start it. */
  id: string
  /** Casper's label for the way, as `/login` names it. */
  label: string
  /** The model provider the way signs in to. */
  provider: string
  /** What the page shows to finish it. */
  kind: CasperSignInKind
}

/** One sign-in Casper has saved: its provider and kind, never a value. */
export interface CasperSavedSignIn {
  /** The provider the sign-in is for. */
  provider: string
  /** The sign-in's kind as Casper reports it, such as `oauth` or `api_key`. */
  type: string
}

/** What the page shows before a sign-in: the ways and the saved sign-ins. */
export interface CasperSignInState {
  /** The ways the app can run, in Casper's order. */
  methods: CasperSignInMethod[]
  /** The sign-ins Casper has saved. */
  signIns: CasperSavedSignIn[]
}

/**
 * One step of a running sign-in. `browser` and `device_code` come as Casper
 * reports them; the stream ends after `signed-in` or `failed`, or with no last
 * frame when the caller stopped it.
 */
export type CasperSignInFrame =
  | { type: 'browser'; url: string; opened: boolean }
  | { type: 'device_code'; url: string; code: string }
  | { type: 'signed-in'; provider: string }
  | { type: 'failed'; message: string }

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * Casper could not start, or refused a status or sign-out request. The
     * message is Casper's or the start failure's own words; the details name
     * only the request.
     */
    'casperSignIn/failed': { readonly request: 'state' | 'signOut' }
  }
}
