/**
 * What the Casper desktop shipped-output gate rejects, and the few findings it accepts permanently.
 * Findings still waiting for a later Step 3 change live in `desktop-shipped.pending.json` instead.
 * @module scripts/casper/desktop-shipped-rules
 */

/** Upstream and npm-mirror hosts the desktop must not name in any shipped file, matched case-insensitively with subdomains. */
export const FORBIDDEN_HOST = /(?<![a-z0-9-])(?:[a-z0-9-]+\.)*(?:deepseek\.com|deepseeksvc\.com|npmmirror\.com)(?![a-z0-9-])/giu

/** Upstream product names the desktop must not show, matched in string literals, locale values and config values. */
export const FORBIDDEN_SCREEN_TEXT = /DeepSeek|深度求索/gu

/** Locales whose dictionaries the gate must have read; a missing one means the scan stopped seeing a dictionary. */
export const DESKTOP_LOCALES: readonly string[] = ['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh']

/** Packages that must be in the scanned set; their absence means the closure walk broke, not that the app got cleaner. */
export const REQUIRED_SHIPPED_PACKAGES: readonly string[] = [
  '@deepseek-ai/dsh-casper-agent',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@earendil-works/pi-ai',
]

/** Fewer scanned packages than this means the closure walk broke. */
export const MINIMUM_SHIPPED_PACKAGES = 300

/** The kinds of finding the gate reports. */
export type FindingRule = 'host' | 'text' | 'package' | 'import' | 'row'

/** One finding: how often one match occurs for one rule in one shipped file (or, for `package` and `row`, in the closure). */
export interface Finding {
  /** Which rule matched. */
  readonly rule: FindingRule
  /** Repository-relative file, `node_modules/<package>/<path>` for third-party files, or `closure` / `composition`. */
  readonly file: string
  /** The host, text, package name or row state that matched. */
  readonly match: string
  /** Occurrences in that file. */
  readonly count: number
}

/** A finding accepted permanently, with the reason it ships. */
export interface Exemption extends Finding {
  /** Why the desktop ships this. */
  readonly reason: string
  /** Exact text the file must contain `count` times, pinning which occurrence is accepted. */
  readonly evidence?: string
}

const PI_AI = 'node_modules/@earendil-works/pi-ai/dist'
const PI_AI_CATALOG = 'the pi-ai model catalog lists the upstream provider, which a user may add in Settings → Models'
const OTEL = 'node_modules/@opentelemetry/semantic-conventions/build'
const OTEL_DOC = 'a link in a doc comment of the OpenTelemetry attribute list; never requested'

/**
 * Permanent exemptions. Each names an exact count, so a second occurrence fails, and a stale entry fails too.
 * The upstream provider stays selectable as an ordinary model provider through the pi-ai catalog.
 */
export const DESKTOP_SHIPPED_EXEMPTIONS: readonly Exemption[] = [
  {
    rule: 'text',
    file: 'apps/desktop/src/main.ts',
    match: 'DeepSeek',
    count: 1,
    reason: 'the required MIT credit in the About panel',
    evidence: "copyright: 'Choaterboater · built on DeepSeek Harness (MIT)'",
  },
  { rule: 'host', file: 'packages/llm/llm-pi-ai/src/provider-data.generated.ts', match: 'api.deepseek.com', count: 1, reason: PI_AI_CATALOG },
  { rule: 'host', file: `${PI_AI}/api/openai-completions.js`, match: 'deepseek.com', count: 1, reason: 'pi-ai recognizes the upstream provider by its base URL' },
  { rule: 'host', file: `${PI_AI}/providers/data/deepseek.json`, match: 'api.deepseek.com', count: 2, reason: PI_AI_CATALOG },
  { rule: 'host', file: `${PI_AI}/providers/deepseek.js`, match: 'api.deepseek.com', count: 1, reason: PI_AI_CATALOG },
  { rule: 'host', file: `${OTEL}/esm/experimental_attributes.js`, match: 'www.deepseek.com', count: 1, reason: OTEL_DOC },
  { rule: 'host', file: `${OTEL}/esnext/experimental_attributes.js`, match: 'www.deepseek.com', count: 1, reason: OTEL_DOC },
  { rule: 'host', file: `${OTEL}/src/experimental_attributes.js`, match: 'www.deepseek.com', count: 1, reason: OTEL_DOC },
]
