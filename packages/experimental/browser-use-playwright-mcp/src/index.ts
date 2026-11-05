/** Chromium browser tools from the pinned Playwright MCP server. @module */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { BrowserMcpConfig, mountSessionMcp, validateBrowserMcpConfig } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-working-directory'

/** Cordis identity for the Playwright MCP browser provider. */
export const name = 'experimental-browser-use-playwright-mcp'

/** Services required for scoped MCP startup and prompt readiness checks. */
export const inject = ['browserUse', 'agents', 'tools', 'systemPrompt', 'workingDirectory']

/** Connection to the user's running Google Chrome through the Playwright Extension. */
export interface PlaywrightExtensionConfig {
  /** Connect each live Session separately to the Chrome tabs the user approves for it in the Playwright Extension. */
  mode: 'extension'
  /** Per-call timeout override in milliseconds; omission uses the MCP client default. */
  toolCallTimeoutMs?: number
}

/** Fixed Chromium launch, existing-browser attachment, or Playwright Extension connection settings. */
export type Config = BrowserMcpConfig | PlaywrightExtensionConfig

/** Validate the launch, attachment, or extension configuration before activation. */
export const Config: Schema<Schemastery.TypeS<typeof BrowserMcpConfig> | PlaywrightExtensionConfig, Config> = Schema.union([
  BrowserMcpConfig,
  Schema.object({
    mode: Schema.const('extension').required(),
    toolCallTimeoutMs: Schema.number().min(1),
  }),
])

/** Upstream variable carrying the Playwright Extension token that skips its per-connection approval. */
const EXTENSION_TOKEN = 'PLAYWRIGHT_MCP_EXTENSION_TOKEN'

/**
 * Expose Playwright's upstream tools in each live Session's scope.
 * The pinned npm server runs under the current Node executable; browser state is not persisted by DSH.
 * Extension mode gives each live Session its own server and extension connection in the user's Chrome profile; a
 * Session's first browser tool call opens the extension's connection page in Chrome and waits until the user approves it.
 * @param ctx - provider context supplying browser use, Agents, and tools.
 * @param config - validated browser choice and optional tool timeout.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.mode !== 'extension') validateBrowserMcpConfig(config)
  const cli = join(dirname(fileURLToPath(import.meta.resolve('@playwright/mcp/package.json'))), 'cli.js')
  // Upstream environment options can otherwise replace the configured browser
  // mode or import an unrelated profile. Empty values mean absent to its parser.
  // The extension token selects neither; the subprocess scrub drops every
  // ambient credential-shaped name, so extension mode forwards it explicitly.
  const kept = config.mode === 'extension' ? EXTENSION_TOKEN : undefined
  const env = Object.fromEntries(Object.keys(process.env)
    .filter(key => key.toUpperCase().startsWith('PLAYWRIGHT_MCP_') && key.toUpperCase() !== kept)
    .map(key => [key, '']))
  let args: string[]
  switch (config.mode) {
    case 'extension': {
      const token = process.env[EXTENSION_TOKEN]
      if (token !== undefined && token !== '') env[EXTENSION_TOKEN] = token
      args = [cli, '--extension', '--browser', 'chrome']
      break
    }
    case 'attach':
      args = [cli, '--browser', 'chromium', '--cdp-endpoint', config.endpoint]
      break
    case 'launch':
      args = [cli, '--browser', 'chromium', '--isolated']
      if (config.headless) args.push('--headless')
      if (config.executablePath !== undefined) args.push('--executable-path', config.executablePath)
      break
    /* v8 ignore next -- exhaustive over the closed mode union */
    default:
      return assertNever(config, 'Playwright MCP browser mode')
  }
  mountSessionMcp(ctx, {
    name: 'playwright-mcp',
    // The extension keeps each approved connection in its own tab group and refuses a tab another connection
    // controls, so only a raw debugging-endpoint attachment needs a Session reservation.
    exclusive: config.mode === 'attach',
    command: process.execPath,
    args,
    env,
    ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
  })
}
