/** Casper's Desktop profile sends nothing to DeepSeek: no usage reporting, Session upload, account or DeepSeek-only services. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { composeEntries, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { createPluginProfile } from '../src/project-manager.ts'

type Row = { id?: string; name?: string; disabled?: unknown; config?: Record<string, unknown> }

/** Compose the shipped Desktop profile rows. */
function desktopRows(): Row[] {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-no-deepseek-'))
  try {
    const profileDir = join(home, 'profiles', 'desktop')
    createPluginProfile(profileDir)
    const installAnchor = fileURLToPath(new URL('../../cli/package.json', import.meta.url))
    const profile = loadProfileDirectory('dsh desktop', profileDir, installAnchor)
    return composeEntries([...profile.layers.map(layer => layer.patches), profile.patches], () => {})
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/** Rows that report usage to, sign in to, or call DeepSeek-hosted services. */
const DEEPSEEK_ROWS = [
  'desktop-product-telemetry', 'product-analytics', 'deepseek-account', 'llm-deepseek-account', 'account-controller',
  'ui-settings-account', 'web-search-deepseek', 'web-deepseek-api', 'session-log-deepseek', 'deepseek-llm-api-extensions',
  'llm-deepseek', 'plugin-package-inventory-deepseek',
]

it('disables every row that reports usage to or calls DeepSeek', () => {
  const rows = desktopRows()
  for (const id of DEEPSEEK_ROWS) {
    const row = rows.find(entry => entry.id === id)
    expect(row, id).toBeDefined()
    expect(row?.disabled, id).toBe(true)
  }
})

it('uploads no Session logs unless the user opts in', () => {
  const mode = desktopRows().find(entry => entry.id === 'session-telemetry-otel')?.config?.['mode']
  const source = typeof mode === 'object' && mode !== null && '__jsExpr' in mode ? String(mode.__jsExpr) : String(mode)
  // eslint-disable-next-line typescript/no-implied-eval -- evaluates the shipped Loader expression against a fixed env.
  const evaluate = new Function('process', `return (${source})`) as (process: { env: Record<string, string | undefined> }) => unknown
  expect(evaluate({ env: {} })).toBe('DISABLED')
  expect(evaluate({ env: { DSH_TELEMETRY_MODE: 'FEEDBACK_ONLY' } })).toBe('FEEDBACK_ONLY')
})

it('has no DeepSeek collector to fall back to when the user opts in to Session upload', () => {
  const exporter = desktopRows().find(entry => entry.id === 'session-telemetry-otel')?.config?.['exporter']
  const url = typeof exporter === 'object' && exporter !== null && 'url' in exporter ? exporter.url : undefined
  const source = typeof url === 'object' && url !== null && '__jsExpr' in url ? String(url.__jsExpr) : String(url)
  expect(source).not.toMatch(/deepseek/iu)
  // eslint-disable-next-line typescript/no-implied-eval -- evaluates the shipped Loader expression against a fixed env.
  const evaluate = new Function('process', `return (${source})`) as (process: { env: Record<string, string | undefined> }) => unknown
  expect(evaluate({ env: { DSH_TELEMETRY_MODE: 'FEEDBACK_ONLY' } })).toBeUndefined()
  expect(evaluate({ env: { DSH_TELEMETRY_OTLP_URL: 'https://collector.example/v1/logs' } })).toBe('https://collector.example/v1/logs')
  expect(exporter).toMatchObject({ compression: 'gzip', timeoutMillis: 1000 })
})

it('keeps a non-DeepSeek model provider available', () => {
  const piAi = desktopRows().find(entry => entry.id === 'llm-pi-ai')
  expect(piAi?.name).toBe('@deepseek-ai/dsh-llm-pi-ai')
  expect(piAi?.disabled).not.toBe(true)
})
