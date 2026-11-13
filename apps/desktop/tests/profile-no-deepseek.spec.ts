/** Casper's Desktop profile composes the Casper desktop bundle: no usage reporting, Session upload, account or upstream-hosted services. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { composeEntries, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { OPTIONAL_BUNDLES } from '@deepseek-ai/dsh-official-bundles'
import { isAgentPresetEntry, isCordisGroupEntry } from '../../../scripts/cordis-yaml.ts'
import { DESKTOP_REMOVED_ROWS } from '../../../scripts/casper/desktop-policy.ts'
import { CASPER_DESKTOP_BUNDLE, REPLACED_DESKTOP_BUNDLES } from '../src/casper-desktop-profile.ts'
import { createPluginProfile } from '../src/project-manager.ts'

type Row = { id?: string; name?: string; disabled?: unknown; config?: Record<string, unknown> }

/** Load a new Desktop profile and compose its rows, with the bundles it lists and the composer's warnings. */
function desktopProfile(): { bundles: string[]; skipped: string[]; rows: Row[]; warnings: string[] } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-no-deepseek-'))
  try {
    const profileDir = join(home, 'profiles', 'desktop')
    createPluginProfile(profileDir)
    const installAnchor = fileURLToPath(new URL('../../cli/package.json', import.meta.url))
    const profile = loadProfileDirectory('dsh desktop', profileDir, installAnchor)
    const warnings: string[] = []
    const rows = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches], message => warnings.push(message))
    const bundles = profile.layers.map(layer => layer.packageName)
    return { bundles, skipped: profile.skippedBundles.map(skipped => skipped.packageName), rows, warnings }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/** Compose the shipped Desktop profile rows. */
function desktopRows(): Row[] {
  return desktopProfile().rows
}

/** Every row of a composition, inside groups and Agent preset plugin lists included. */
function allRows(rows: readonly unknown[]): Row[] {
  return rows.flatMap((row): Row[] => {
    if (typeof row !== 'object' || row === null) return []
    const entry = row as Row & Record<string, unknown>
    const nested = isCordisGroupEntry(entry) ? entry.config : isAgentPresetEntry(entry) ? entry.config.plugins : []
    return [entry, ...allRows(nested)]
  })
}

it('composes only the Casper desktop bundle, with every Casper override matching a row', () => {
  const profile = desktopProfile()
  expect(profile.bundles).toEqual([CASPER_DESKTOP_BUNDLE])
  expect(profile.skipped).toEqual([])
  expect(profile.warnings).toEqual([])
})

it('composes none of the rows that report usage to, sign in to, or call DeepSeek-hosted services', () => {
  const ids = allRows(desktopRows()).map(row => row.id)
  expect(ids.length).toBeGreaterThan(100)
  for (const id of Object.keys(DESKTOP_REMOVED_ROWS)) expect(ids, id).not.toContain(id)
})

it('hides the bundles it replaces and itself, so neither the Plugins page nor the plugin_manager tool can switch them', () => {
  const hidden = desktopRows().find(entry => entry.id === 'plugin-manager')?.config?.['hiddenBundles']
  expect(hidden).toEqual(expect.arrayContaining([CASPER_DESKTOP_BUNDLE, ...REPLACED_DESKTOP_BUNDLES]))
})

it('hides every optional bundle DeepSeek ships, so the Plugins page cannot switch one on', () => {
  const hidden = desktopRows().find(entry => entry.id === 'plugin-manager')?.config?.['hiddenBundles']
  const deepseek = OPTIONAL_BUNDLES.filter(name => !name.startsWith('@deepseek-ai/dsh-casper-'))
  expect(deepseek.length).toBeGreaterThan(0)
  expect(hidden).toEqual(expect.arrayContaining(deepseek))
  expect(hidden).not.toContain('@deepseek-ai/dsh-casper-chrome-bundle')
})

it('never asks npmmirror: no registry timing probe, no fallback registry for installs, no npmmirror file reads', () => {
  const rows = desktopRows()
  const pluginManager = rows.find(entry => entry.id === 'plugin-manager')?.config
  expect(rows.find(entry => entry.id === 'ui-plugin-manager')?.config).toMatchObject({ registryProbeEnabled: false })
  expect(pluginManager?.['fallbackRegistries']).toEqual([])
  expect(pluginManager?.['detailNpmFileSources']).toEqual(['jsdelivr', 'unpkg'])
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

it('has no default web search provider and withholds web_search until a search provider resolves', () => {
  expect(desktopRows().find(entry => entry.id === 'web')?.config).toEqual({ fetchProvider: 'http', offerUnresolvedSearch: false })
})

it('has no default model until one is picked', () => {
  expect(desktopRows().find(entry => entry.id === 'agent-default-model')?.config).toEqual({ provider: '', model: '' })
})
