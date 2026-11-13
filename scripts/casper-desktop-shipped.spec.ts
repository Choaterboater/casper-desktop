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
const ROW_PLANT = 'packages/bundle/web-app/presets/casper.patch.yml'
const EXEMPT_HOST_PLANT = 'packages/llm/llm-pi-ai/src/provider-data.generated.ts'
const CREDIT_FILE = 'apps/desktop/src/main.ts'
const OUTSIDE_PLANT = 'packages/test-support/llm-mock-server/src/index.ts'
const localePlant = (locale: string): string => `packages/llm/llm/locale/${locale}.json`

function plantedOverlay(): Map<string, string> {
  const overlay = new Map<string, string>([
    [HOST_PLANT, `${read(HOST_PLANT)}\nexport const PLANTED_ENDPOINT = 'https://api.deepseek.com/v1'\n`],
    [IMPORT_PLANT, `${read(IMPORT_PLANT)}\nimport '@deepseek-ai/dsh-llm-deepseek-api-key'\n`],
    [ROW_PLANT, `${read(ROW_PLANT)}\n- id: llm-deepseek\n  disabled: false\n`],
    [EXEMPT_HOST_PLANT, `${read(EXEMPT_HOST_PLANT)}\nexport const PLANTED_SECOND = 'https://api.deepseek.com/beta'\n`],
    [CREDIT_FILE, read(CREDIT_FILE).replace("copyright: 'Choaterboater · built on DeepSeek Harness (MIT)'", "copyright: 'Choaterboater'")],
    [OUTSIDE_PLANT, `${read(OUTSIDE_PLANT)}\nexport const PLANTED_OUTSIDE = 'https://api.deepseek.com/v1'\n`],
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

  it('fails on each planted host, word, import, row, extra exempted host and deleted credit', () => {
    const evidence = (file: string): string => overlay.get(file) ?? read(file)
    const problems = checkDesktopShipped(planted, DESKTOP_SHIPPED_EXEMPTIONS, readPendingLedger(), evidence)
    expect(problems).toContain(`new: host api.deepseek.com in ${HOST_PLANT} (1x)`)
    expect(problems).toContain(`new: import @deepseek-ai/dsh-llm-deepseek-api-key in ${IMPORT_PLANT} (1x)`)
    expect(problems).toContain('new: row llm-deepseek enabled in composition (1x)')
    expect(problems).toContain(`new: host api.deepseek.com in ${EXEMPT_HOST_PLANT} occurs 2x, the exemption allows 1`)
    expect(problems).toContain(`stale: text DeepSeek in ${CREDIT_FILE} no longer occurs, remove the exemption entry`)
    for (const locale of DESKTOP_LOCALES) expect(problems).toContain(`new: text DeepSeek in ${localePlant(locale)} (1x)`)
  })

  it('ignores a plant outside the shipped closure', () => {
    const evidence = (file: string): string => overlay.get(file) ?? read(file)
    const problems = checkDesktopShipped(planted, DESKTOP_SHIPPED_EXEMPTIONS, readPendingLedger(), evidence)
    expect(problems.filter(problem => problem.includes(OUTSIDE_PLANT))).toEqual([])
    expect(planted.packages.has('@deepseek-ai/dsh-llm-mock-server')).toBe(false)
  })

  it('reads screen text from literals, templates and JSX, not from comments', () => {
    expect(sourceStrings('a.tsx', "// DeepSeek\nconst a = 'one'; const b = `two ${a} three`; const c = <p>four</p>")).toEqual([
      'one', 'two ', ' three', 'four',
    ])
  })
})
