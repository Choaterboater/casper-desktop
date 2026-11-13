/** Casper desktop shipped-output gate: the real tree passes, and each planted upstream host, word, import or row fails. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  REPOSITORY_ROOT,
  checkDesktopShipped,
  occurrencesOutsideKeys,
  scanDesktopShipped,
  sourceStrings,
  type ShippedScan,
} from './casper/desktop-shipped.ts'
import { DESKTOP_LOCALES, DESKTOP_SHIPPED_EXEMPTIONS } from './casper/desktop-shipped-rules.ts'

const SCAN_TIMEOUT_MS = 300_000
const read = (path: string): string => readFileSync(join(REPOSITORY_ROOT, path), 'utf8')

/** Files a plant changes; each in a different file so every plant yields its own problem. */
const HOST_PLANT = 'packages/llm/llm/src/index.ts'
const IMPORT_PLANT = 'packages/casper/casper-agent/src/index.ts'
const ROW_PLANT = 'packages/casper/desktop/casper.patch.yml'
const EXEMPT_HOST_PLANT = 'packages/llm/llm-pi-ai/src/provider-data.generated.ts'
const CREDIT_FILE = 'apps/desktop/src/main.ts'
/** The Web bundle's package publishes `dist/`; the gate reads its sources instead. */
const WEB_SOURCE_PLANT = 'apps/web/src/main.ts'
const OUTSIDE_PLANT = 'packages/test-support/llm-mock-server/src/index.ts'
/** Kept code that imports a package the closure omits; the omitted bundle the second plant lands in is not shipped. */
const OMITTED_IMPORT_PLANT = 'apps/cli/src/bin.ts'
const OMITTED_PLANT = 'packages/bundle/headless/cordis.patch.yml'
const localePlant = (locale: string): string => `packages/llm/llm/locale/${locale}.json`
/** A dictionary source and a plain source; only the dictionary's product-name use is a finding. */
const DICTIONARY_PLANT = 'packages/client/ui-chat/src/client/locale.ts'
const NON_DICTIONARY_PLANT = 'packages/client/ui-chat/src/client/conversation-nodes/turn-error.ts'

function plantedOverlay(): Map<string, string> {
  const overlay = new Map<string, string>([
    [HOST_PLANT, `${read(HOST_PLANT)}\nexport const PLANTED_ENDPOINT = 'https://api.deepseek.com/v1'\n`],
    [IMPORT_PLANT, `${read(IMPORT_PLANT)}\nimport '@deepseek-ai/dsh-llm-deepseek-api-key'\n`],
    [ROW_PLANT, `${read(ROW_PLANT)}\n- insert:\n    - id: llm-deepseek\n`],
    [EXEMPT_HOST_PLANT, `${read(EXEMPT_HOST_PLANT)}\nexport const PLANTED_SECOND = 'https://api.deepseek.com/beta'\n`],
    [CREDIT_FILE, read(CREDIT_FILE).replace("copyright: 'Choaterboater · built on DeepSeek Harness (MIT)'", "copyright: 'Choaterboater'")],
    [WEB_SOURCE_PLANT, `${read(WEB_SOURCE_PLANT)}\nexport const PLANTED_WEB = 'https://platform.deepseek.com/'\n`],
    [OUTSIDE_PLANT, `${read(OUTSIDE_PLANT)}\nexport const PLANTED_OUTSIDE = 'https://api.deepseek.com/v1'\n`],
    [OMITTED_IMPORT_PLANT, `${read(OMITTED_IMPORT_PLANT)}\nimport '@deepseek-ai/dsh-base'\n`],
    [OMITTED_PLANT, `${read(OMITTED_PLANT)}\n# https://api.deepseek.com/v1\n`],
    [DICTIONARY_PLANT, `${read(DICTIONARY_PLANT)}\nexport const PLANTED_NAME = 'Restart DSH; it reads $DSH_HOME and DSH_HOME.'\nexport const PLANTED_SHORT = 'Restart Harness (backToHarness).'\n`],
    [NON_DICTIONARY_PLANT, `${read(NON_DICTIONARY_PLANT)}\nexport const PLANTED_LOG = 'DSH process'\n`],
  ])
  for (const locale of DESKTOP_LOCALES) {
    const dictionary = JSON.parse(read(localePlant(locale))) as Record<string, unknown>
    overlay.set(localePlant(locale), JSON.stringify({ ...dictionary, plantedTitle: 'DeepSeek' }))
  }
  return overlay
}

describe('Casper desktop shipped output', () => {
  let real: ShippedScan
  let planted: ShippedScan
  let overlay: Map<string, string>

  beforeAll(() => {
    real = scanDesktopShipped()
    overlay = plantedOverlay()
    planted = scanDesktopShipped(overlay)
  }, SCAN_TIMEOUT_MS)

  it('passes on the real tree: every finding is a permanent exemption', () => {
    expect(checkDesktopShipped(real, DESKTOP_SHIPPED_EXEMPTIONS)).toEqual([])
  })

  it('fails on each planted host, Web-bundle source, word, product name, import, omitted import, row, extra exempted host and deleted credit', () => {
    const evidence = (file: string): string => overlay.get(file) ?? read(file)
    const problems = checkDesktopShipped(planted, DESKTOP_SHIPPED_EXEMPTIONS, evidence)
    expect(problems).toContain(`new: text DSH in ${DICTIONARY_PLANT} (1x)`)
    expect(problems).toContain(`new: text Harness in ${DICTIONARY_PLANT} (1x)`)
    expect(problems.filter(problem => problem.includes(NON_DICTIONARY_PLANT))).toEqual([])
    expect(problems).toContain(`new: host api.deepseek.com in ${HOST_PLANT} (1x)`)
    expect(problems).toContain(`new: import @deepseek-ai/dsh-llm-deepseek-api-key in ${IMPORT_PLANT} (1x)`)
    expect(problems).toContain(`new: import @deepseek-ai/dsh-base in ${OMITTED_IMPORT_PLANT} (1x)`)
    expect(problems).toContain('new: row llm-deepseek enabled in composition (1x)')
    expect(problems).toContain(`new: host platform.deepseek.com in ${WEB_SOURCE_PLANT} (1x)`)
    expect(problems).toContain(`new: host api.deepseek.com in ${EXEMPT_HOST_PLANT} occurs 2x, the exemption allows 1`)
    expect(problems).toContain(`stale: text DeepSeek in ${CREDIT_FILE} no longer occurs, remove the exemption entry`)
    for (const locale of DESKTOP_LOCALES) expect(problems).toContain(`new: text DeepSeek in ${localePlant(locale)} (1x)`)
  })

  it.each([
    [OUTSIDE_PLANT, '@deepseek-ai/dsh-llm-mock-server'],
    [OMITTED_PLANT, '@deepseek-ai/dsh-headless'],
  ])('ignores a plant in %s, outside the shipped closure', (plant, pkg) => {
    const evidence = (file: string): string => overlay.get(file) ?? read(file)
    const problems = checkDesktopShipped(planted, DESKTOP_SHIPPED_EXEMPTIONS, evidence)
    expect(problems.filter(problem => problem.includes(plant))).toEqual([])
    expect(planted.packages.has(pkg)).toBe(false)
  })

  it('fails when an exempted name moves to a dictionary key its exemption does not list, at the same count', () => {
    const file = 'packages/client/ui-settings-models/src/client/locales.ts'
    const text = read(file)
    const moved = text.replace("deepSeekAccount: 'DeepSeek Account',", "deepSeekAccount: 'Account', title: 'DeepSeek models',")
    expect(moved).not.toBe(text)
    const problems = checkDesktopShipped(real, DESKTOP_SHIPPED_EXEMPTIONS, path => (path === file ? moved : read(path)))
    expect(problems).toEqual([
      `text DeepSeek in ${file}: 1 occurrence(s) lie outside the exempted keys deepSeekAccount, onboardingDescription`,
    ])
  })

  it.each([
    ["  providerDeepSeek: 'DeepSeek Search API',", 0],
    ["  | 'providerDeepSeek' | 'providerLocal'", 0],
    ["  a: 'x', providerDeepSeek: 'DeepSeek'", 0],
    ["  title: 'DeepSeek', providerDeepSeek: 'y'", 1],
    ["  url: 'https://DeepSeek.example'", 1],
  ])('counts occurrences outside the listed keys in %s', (line, outside) => {
    expect(occurrencesOutsideKeys(line, 'DeepSeek', ['providerDeepSeek'])).toBe(outside)
  })

  it('matches an exempted host case-insensitively, as the host scan does', () => {
    const text = "  deepSeekBaseUrl: 'https://api.deepseek.com',\n  title: 'See API.DeepSeek.com',\n"
    expect(occurrencesOutsideKeys(text, 'api.deepseek.com', ['deepSeekBaseUrl'], true)).toBe(1)
    expect(occurrencesOutsideKeys(text, 'api.deepseek.com', ['deepSeekBaseUrl'])).toBe(0)
  })

  it('reads no screen text from module specifiers', () => {
    const source = "import a from './DeepSeekA.tsx'\nimport type { B } from './DeepSeekB.ts'\nexport * from './DeepSeekC.ts'\n"
      + "type C = import('./DeepSeekD.ts').C\nimport e = require('./DeepSeekE.ts')\nconst f = import('./DeepSeekF.ts')\nconst g = 'DeepSeek'"
    expect(sourceStrings('a.ts', source)).toEqual(['DeepSeek'])
  })

  it('reads screen text from literals, templates and JSX, not from comments', () => {
    expect(sourceStrings('a.tsx', "// DeepSeek\nconst a = 'one'; const b = `two ${a} three`; const c = <p>four</p>")).toEqual([
      'one', 'two ', ' three', 'four',
    ])
  })
})
