/**
 * Casper's exclusions from the runtime Cordis catalog that `cordis_inspect` serves to the model: services and events
 * that only packages the desktop never ships provide or declare. The CLI still composes some of them; their reference pages stay published.
 * @module scripts/casper/cordis-catalog-exclusions
 */

/** Context keys of runtime services that come only from packages in `DESKTOP_FORBIDDEN_PACKAGES` (`desktop-policy.ts`). */
export const CASPER_RUNTIME_SERVICE_EXCLUSIONS: readonly string[] = [
  'deepseekAccount',
  'deepseekLlmApiExtensions',
  'productAnalytics',
  'productTelemetry',
  'sessionLogDeepSeek',
]

/** Scoped names of runtime events declared only in packages in `DESKTOP_FORBIDDEN_PACKAGES` (`desktop-policy.ts`). */
export const CASPER_RUNTIME_EVENT_EXCLUSIONS: readonly string[] = [
  'deepseek-account/model-sign-in-required',
  'deepseek-account/session-expired',
  'deepseek-account/signed-out',
]
