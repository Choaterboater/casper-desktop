/**
 * Casper desktop policy: the upstream service rows and packages the desktop app must not compose or ship.
 * This module is the only list of them; the shipped-output gate and the desktop bundle read it from here.
 * @module scripts/casper/desktop-policy
 */

/** Row id and the package it loads, for each upstream service row the desktop must not compose. */
export const DESKTOP_REMOVED_ROWS: Readonly<Record<string, string>> = {
  'desktop-product-telemetry': '@deepseek-ai/dsh-host-product-telemetry-otel',
  'product-analytics': '@deepseek-ai/dsh-client-product-analytics',
  'deepseek-account': '@deepseek-ai/dsh-deepseek-account-platform',
  'llm-deepseek-account': '@deepseek-ai/dsh-llm-deepseek-account',
  'account-controller': '@deepseek-ai/dsh-api-account-controller',
  'ui-settings-account': '@deepseek-ai/dsh-client-ui-settings-account',
  'web-search-deepseek': '@deepseek-ai/dsh-web-search-deepseek',
  'web-deepseek-api': '@deepseek-ai/dsh-web-deepseek-api',
  'session-log-deepseek': '@deepseek-ai/dsh-session-log-deepseek',
  'deepseek-llm-api-extensions': '@deepseek-ai/dsh-deepseek-llm-api-extensions',
  'llm-deepseek': '@deepseek-ai/dsh-llm-deepseek-api-key',
  'plugin-package-inventory-deepseek': '@deepseek-ai/dsh-plugin-package-inventory-deepseek',
}

/** Packages the desktop must neither ship nor import: every removed row's package plus the two libraries only they use. */
export const DESKTOP_FORBIDDEN_PACKAGES: readonly string[] = [
  ...Object.values(DESKTOP_REMOVED_ROWS),
  '@deepseek-ai/dsh-deepseek-account',
  '@deepseek-ai/dsh-llm-deepseek',
].sort()
