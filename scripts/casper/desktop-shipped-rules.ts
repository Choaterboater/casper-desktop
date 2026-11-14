/**
 * What the Casper desktop shipped-output gate rejects, and the findings it accepts permanently.
 * @module scripts/casper/desktop-shipped-rules
 */

/** Upstream and npm-mirror hosts the desktop must not name in any shipped file, matched case-insensitively with subdomains. */
export const FORBIDDEN_HOST = /(?<![a-z0-9-])(?:[a-z0-9-]+\.)*(?:deepseek\.com|deepseeksvc\.com|npmmirror\.com)(?![a-z0-9-])/giu

/** Upstream product names the desktop must not show, matched in string literals, locale values and config values. */
export const FORBIDDEN_SCREEN_TEXT = /DeepSeek|深度求索/gu

/**
 * Upstream's short product names, DSH and Harness, matched in locale dictionary values only. `DSH_*` environment
 * variable names, `$DSH_*` references, the lowercase `dsh` command and identifiers such as `backToHarness` do not match.
 */
export const FORBIDDEN_PRODUCT_NAME = /(?<![\w$])(?:DSH|Harness)(?!\w)/gu

/** Locale dictionaries: `locale/<language>.json` files and sources such as `locales.ts`, `guide-locales.ts` or `locales/en.ts`. */
export const LOCALE_DICTIONARY = new RegExp(
  String.raw`(?:^|/)(?:locale/(?:[^/]+/)*[a-z]{2}\.json|(?:[a-z]+-)*locales?(?:-[a-z]+)*\.tsx?|locales/[a-z-]+\.tsx?)$`,
  'u',
)

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
  /**
   * Dictionary keys that hold every accepted occurrence. An occurrence is covered when the last `key: '…` before it on
   * its line names one of these keys, or when it lies inside one of these key names.
   */
  readonly keys?: readonly string[]
}

const PI_AI = 'node_modules/@earendil-works/pi-ai/dist'
const PI_AI_CATALOG = 'the pi-ai model catalog lists the upstream provider, which a user may add in Settings → Models'
const OTEL = 'node_modules/@opentelemetry/semantic-conventions/build'
const OTEL_DOC = 'a link in a doc comment of the OpenTelemetry attribute list; never requested'
const MODELS = 'packages/client/ui-settings-models'
const MODELS_UPSTREAM = 'copy for the upstream official-provider and account routes (settings namespace llm-deepseek, '
  + 'provider deepseek-account), which the desktop does not compose, so it never renders'
const WEB_SEARCH = 'packages/client/ui-settings-web-search/src/client'
const WEB_SEARCH_UPSTREAM = 'labels and guide link of the upstream search and fetch providers, which the desktop does not '
  + 'compose; launch clears a desktop profile\'s stored choice of one'
const NPM_MIRROR = 'the plugin manager\'s npm-mirror constants; the desktop bundle sets fallbackRegistries: [] and turns the '
  + 'registry probe off, and the CLI keeps upstream\'s mirror'

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
  {
    rule: 'text',
    file: `${MODELS}/src/client/locales.ts`,
    match: 'DeepSeek',
    count: 16,
    reason: MODELS_UPSTREAM,
    keys: ['deepSeekAccount', 'onboardingDescription'],
  },
  {
    rule: 'host',
    file: `${MODELS}/src/client/locales.ts`,
    match: 'api.deepseek.com',
    count: 8,
    reason: MODELS_UPSTREAM,
    keys: ['deepSeekBaseUrl'],
  },
  {
    rule: 'text',
    file: `${MODELS}/src/client/DeepSeekOnboardingDialog.tsx`,
    match: 'DeepSeek',
    count: 1,
    reason: `${MODELS_UPSTREAM}; the error of a state that cannot occur`,
    evidence: "throw new Error('unexpected DeepSeek onboarding state')",
  },
  { rule: 'host', file: `${MODELS}/README.md`, match: 'api.deepseek.com', count: 1, reason: `the README describes the ${MODELS_UPSTREAM}` },
  {
    rule: 'text',
    file: 'packages/client/ui-model-selection/src/client/locales.ts',
    match: 'DeepSeek',
    count: 8,
    reason: 'the model picker\'s heading for the upstream account provider (deepseek-account), which the desktop does not compose',
    keys: ['provider.account'],
  },
  {
    rule: 'text',
    file: 'packages/extensions/cordis-client-runner/src/client/slot-catalog.ts',
    match: 'DeepSeek',
    count: 1,
    reason: 'a static occupant label in the generated slot catalog that names the upstream onboarding dialog; never rendered',
    evidence: 'DeepSeekOnboardingDialog id',
  },
  {
    rule: 'text',
    file: `${WEB_SEARCH}/locales.ts`,
    match: 'DeepSeek',
    count: 28,
    reason: WEB_SEARCH_UPSTREAM,
    keys: ['providerDeepSeek', 'providerDeepSeekFetch', 'providerLegacy'],
  },
  {
    rule: 'host',
    file: `${WEB_SEARCH}/locales.ts`,
    match: 'api-docs.deepseek.com',
    count: 8,
    reason: WEB_SEARCH_UPSTREAM,
    keys: ['searchGuideUrl'],
  },
  {
    rule: 'text',
    file: `${WEB_SEARCH}/WebSearchCard.tsx`,
    match: 'DeepSeek',
    count: 2,
    reason: `dictionary key names of the ${WEB_SEARCH_UPSTREAM}`,
    evidence: "'providerDeepSeek",
  },
  { rule: 'host', file: 'packages/boot/plugin-manager/README.md', match: 'registry.npmmirror.com', count: 1, reason: NPM_MIRROR },
  {
    rule: 'host',
    file: 'packages/boot/plugin-manager/src/registry.ts',
    match: 'registry.npmmirror.com',
    count: 1,
    reason: NPM_MIRROR,
    evidence: "export const NPMMIRROR_REGISTRY = 'https://registry.npmmirror.com/'",
  },
  {
    rule: 'host',
    file: 'packages/boot/plugin-market/src/index.ts',
    match: 'registry.npmmirror.com',
    count: 1,
    reason: NPM_MIRROR,
    evidence: "'registry.npmmirror.com'",
  },
  { rule: 'host', file: 'packages/client/ui-plugin-manager/README.md', match: 'registry.npmmirror.com', count: 1, reason: NPM_MIRROR },
  {
    rule: 'host',
    file: 'packages/client/ui-plugin-manager/src/client/presentation.ts',
    match: 'registry.npmmirror.com',
    count: 1,
    reason: NPM_MIRROR,
    evidence: "['registry.npmmirror.com', 'registryNpmmirror']",
  },
  {
    rule: 'host',
    file: 'packages/client/ui-plugin-manager/src/index.ts',
    match: 'registry.npmmirror.com',
    count: 1,
    reason: NPM_MIRROR,
    evidence: "'https://registry.npmmirror.com/-/ping'",
  },
  {
    rule: 'host',
    file: 'packages/util/plugin-detail/src/files.ts',
    match: 'registry.npmmirror.com',
    count: 1,
    reason: NPM_MIRROR,
    evidence: 'https://registry.npmmirror.com/${name}/${version}/files/',
  },
  {
    rule: 'text',
    file: 'packages/experimental/client-ui-cot-translation/src/client/locales.ts',
    match: 'DeepSeek',
    count: 32,
    reason: 'experimental chain-of-thought translation copy; it ships only for the hidden cot-translation and liveshare '
      + 'bundles, which the desktop plugin manager does not offer, and names the upstream service its paid providers use',
    keys: ['deepseekAccount', 'deepseekOfficial', 'paidNotice', 'providerUnavailable'],
  },
]
