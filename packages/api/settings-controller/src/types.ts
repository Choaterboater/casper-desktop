/**
 * Browser-safe failure vocabulary of the configuration surfaces this package
 * serves. The redacted views themselves live with their seam in
 * `@deepseek-ai/dsh-settings/types`, whose Cordis event declarations already
 * register that file for the Client compilation face.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * The provider refused a valid credential write, for example because the
     * stored document no longer parses. The details name only the reference,
     * never the value.
     */
    'credential/rejected': { readonly ref: string }
    /**
     * A sign-in request named no registered flow, an unknown prompt, or the
     * store refused a sign-out. The details name only the record key.
     */
    'authorization/rejected': { readonly key: string }
  }
}

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}

/** One sign-in method a flow offers, as a configuration page labels its button. */
export interface AuthorizationMethodView {
  readonly id: string
  readonly label: string
}

/**
 * One registered sign-in flow as a configuration page sees it. Carries no
 * credential: `signedIn` reports only that a record is stored.
 */
export interface AuthorizationEntryView {
  /** The `<scope>/<id>` credential record the flow writes. */
  readonly key: string
  /** User-facing name of what is being signed into. */
  readonly label: string
  /** Methods offered, most preferred first. */
  readonly methods: readonly AuthorizationMethodView[]
  /** Whether an attempt for this key is running. */
  readonly inFlight: boolean
  /** Whether a record is currently stored for this key. */
  readonly signedIn: boolean
}

/** One choice of a `select` prompt. */
export interface AuthorizationPromptOptionView {
  readonly id: string
  readonly label: string
  readonly description?: string
}

/**
 * One frame of a sign-in stream. Notices never carry a secret; a prompt is
 * answered through `authorization/answer` with its `promptId`, and the stream
 * ends after `settled` or `failed`.
 */
export type AuthorizationEventView =
  | { readonly type: 'notice'; readonly message: string; readonly url?: string; readonly code?: string }
  | {
    readonly type: 'prompt'
    readonly promptId: string
    readonly kind: 'text' | 'secret' | 'select'
    readonly message: string
    readonly placeholder?: string
    readonly options?: readonly AuthorizationPromptOptionView[]
  }
  | { readonly type: 'prompt-withdrawn'; readonly promptId: string }
  | { readonly type: 'settled'; readonly status: 'authorized' | 'cancelled' }
  | { readonly type: 'failed'; readonly message: string }
