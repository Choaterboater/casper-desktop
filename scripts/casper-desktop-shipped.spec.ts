/** Casper desktop shipped-output gate: the real tree passes, and each planted upstream host, word, import or row fails. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  REPOSITORY_ROOT,
  checkDesktopShipped,
  readPendingLedger,
  scanDesktopShipped,
  shrinkPendingLedger,
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

  it('passes on the real tree: every finding is a permanent exemption or in the pending ledger', () => {
    expect(checkDesktopShipped(real, DESKTOP_SHIPPED_EXEMPTIONS, readPendingLedger())).toEqual([])
  })

  it('keeps the pending ledger as small as the tree allows', () => {
    const pending = readPendingLedger()
    expect(shrinkPendingLedger(real, pending)).toEqual(pending)
  })

  it('fails on each planted host, Web-bundle source, word, import, omitted import, row, extra exempted host and deleted credit', () => {
    const evidence = (file: string): string => overlay.get(file) ?? read(file)
    const problems = checkDesktopShipped(planted, DESKTOP_SHIPPED_EXEMPTIONS, readPendingLedger(), evidence)
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
    const problems = checkDesktopShipped(planted, DESKTOP_SHIPPED_EXEMPTIONS, readPendingLedger(), evidence)
    expect(problems.filter(problem => problem.includes(plant))).toEqual([])
    expect(planted.packages.has(pkg)).toBe(false)
  })

  it('reads screen text from literals, templates and JSX, not from comments', () => {
    expect(sourceStrings('a.tsx', "// DeepSeek\nconst a = 'one'; const b = `two ${a} three`; const c = <p>four</p>")).toEqual([
      'one', 'two ', ' three', 'four',
    ])
  })
})
