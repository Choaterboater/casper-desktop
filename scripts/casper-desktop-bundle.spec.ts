/** Casper desktop bundle: the generated layers are current, compose to upstream's minus the removed rows, and an upstream rename fails. */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { bundlePatchPaths, composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { DshBundleManifest } from '../packages/util/package-manifest/src/types.ts'
import { isAgentPresetEntry, isCordisGroupEntry, loadCordisYaml } from './cordis-yaml.ts'
import {
  DESKTOP_BUNDLE_DIR,
  REPOSITORY_ROOT,
  checkDesktopBundle,
  filterPatchList,
  filterPatchText,
  generateDesktopBundle,
} from './casper/desktop-bundle.ts'
import { DESKTOP_REMOVED_ROWS } from './casper/desktop-policy.ts'
import { bundlePluginDependencyErrors, type PackageManifest } from './verify-cordis-config.ts'

const REMOVED_IDS = Object.keys(DESKTOP_REMOVED_ROWS)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const manifest = (dir: string): PackageManifest & { dsh: { bundle: DshBundleManifest } } =>
  JSON.parse(readFileSync(join(REPOSITORY_ROOT, dir, 'package.json'), 'utf8')) as PackageManifest & { dsh: { bundle: DshBundleManifest } }

/** One bundle's patch lists, parsed by the same loader the profile composer uses. */
function layer(dir: string): ReturnType<typeof loadOverlayPatches> {
  return bundlePatchPaths(join(REPOSITORY_ROOT, dir), manifest(dir).dsh.bundle).flatMap(path => loadOverlayPatches('casper-desktop-bundle', path))
}

/** Remove the listed rows from composed entries, recursing into groups. */
function withoutRemovedRows(entries: readonly EntryOptions[]): EntryOptions[] {
  return entries
    .filter(entry => typeof entry.id !== 'string' || !Object.hasOwn(DESKTOP_REMOVED_ROWS, entry.id))
    .map(entry => isCordisGroupEntry(entry) ? { ...entry, config: withoutRemovedRows(entry.config as EntryOptions[]) } : entry)
}

/** Every entry in a composition, groups and Agent preset plugin lists included. */
function allEntries(entries: readonly unknown[]): Record<string, unknown>[] {
  return entries.flatMap((entry): Record<string, unknown>[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const row = entry as Record<string, unknown>
    const nested = isCordisGroupEntry(row) ? row.config : isAgentPresetEntry(row) ? row.config.plugins : []
    return [row, ...allEntries(nested)]
  })
}

describe('Casper desktop bundle', () => {
  it('is current with the upstream bundles it is generated from', () => {
    expect(checkDesktopBundle()).toEqual([])
  })

  it('composes to upstream base and web-app with the removed rows taken out', () => {
    const casper = composeEntries([layer(DESKTOP_BUNDLE_DIR)])
    const upstream = composeEntries([layer('packages/bundle/base'), layer('packages/bundle/web-app')])
    expect(casper).toEqual(withoutRemovedRows(upstream))
    expect(allEntries(upstream).filter(entry => REMOVED_IDS.includes(entry.id as string)).length).toBeGreaterThan(0)
  })

  it('names none of the removed rows, in the composition or in any layer', () => {
    const ids = (entries: readonly unknown[]): unknown[] => allEntries(entries).map(entry => entry.id)
    expect(ids(composeEntries([layer(DESKTOP_BUNDLE_DIR)])).filter(id => REMOVED_IDS.includes(id as string))).toEqual([])
    for (const path of bundlePatchPaths(join(REPOSITORY_ROOT, DESKTOP_BUNDLE_DIR), manifest(DESKTOP_BUNDLE_DIR).dsh.bundle)) {
      const patches = loadCordisYaml(readFileSync(path, 'utf8')) as Record<string, unknown>[]
      const named = [...patches, ...allEntries(patches.flatMap((patch): unknown[] => Array.isArray(patch.insert) ? patch.insert : []))]
      expect(named.map(entry => entry.id).filter(id => REMOVED_IDS.includes(id as string)), path).toEqual([])
    }
  })

  it('resolves every plugin its layers name from its own dependencies', () => {
    const references = allEntries(composeEntries([layer(DESKTOP_BUNDLE_DIR)]))
      .flatMap(entry => typeof entry.name === 'string' ? [{ file: DESKTOP_BUNDLE_DIR, name: entry.name }] : [])
    expect(references.length).toBeGreaterThan(100)
    expect(bundlePluginDependencyErrors(`${DESKTOP_BUNDLE_DIR}/package.json`, manifest(DESKTOP_BUNDLE_DIR), references)).toEqual([])
  })

  it('removes a planted removed row at the top level, in an insert list and inside a group, keeping comments that cover kept rows and !!js text', () => {
    const source = [
      '# header',
      '- insert:',
      '    - id: kept',
      "      disabled: !!js \"ctx.get('profileContext')?.name !== 'desktop'\"",
      '',
      '    # about the removed row',
      '    - id: web-deepseek-api',
      "      name: '@deepseek-ai/dsh-web-deepseek-api'",
      '',
      '    # about the group',
      '    - id: group-row',
      '      name: cordis:group',
      '      group: true',
      '      config:',
      '        - id: inner-kept',
      '          name: inner',
      '        - id: llm-deepseek',
      '          name: removed',
      '          config:',
      '            nested: true',
      '',
      '    # shared by the next two rows',
      '    - id: account-controller',
      '      name: removed',
      '',
      '    - id: shared-kept',
      '      name: kept',
      '- id: session-log-deepseek',
      '  disabled: true',
      '# trailing comment',
      '- id: plugin-manager',
      '  config: {}',
      '',
    ].join('\n')
    const filtered = filterPatchText(source, 'planted.yml')
    expect(filtered.removed).toEqual(['web-deepseek-api', 'llm-deepseek', 'account-controller', 'session-log-deepseek'])
    expect(filtered.inserted).toEqual(['web-deepseek-api', 'llm-deepseek', 'account-controller'])
    expect(filtered.text).toBe([
      '# header',
      '- insert:',
      '    - id: kept',
      "      disabled: !!js \"ctx.get('profileContext')?.name !== 'desktop'\"",
      '',
      '    # about the group',
      '    - id: group-row',
      '      name: cordis:group',
      '      group: true',
      '      config:',
      '        - id: inner-kept',
      '          name: inner',
      '',
      '    # shared by the next two rows',
      '    - id: shared-kept',
      '      name: kept',
      '# trailing comment',
      '- id: plugin-manager',
      '  config: {}',
      '',
    ].join('\n'))
    expect(loadCordisYaml(filtered.text)).toEqual(filterPatchList(loadCordisYaml(source), 'planted.yml'))
  })

  it('fails when a removed row cannot be taken out line by line', () => {
    expect(() => filterPatchText('- insert: [{ id: llm-deepseek, name: x }]\n', 'flow.yml')).toThrow(/does not parse to the source/u)
  })

  /** A copy of the three bundles this generator reads, in a temporary root. */
  function copiedRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'casper-desktop-bundle-'))
    roots.push(root)
    for (const dir of ['packages/bundle/base', 'packages/bundle/web-app', DESKTOP_BUNDLE_DIR]) {
      cpSync(join(REPOSITORY_ROOT, dir), join(root, dir), { recursive: true, filter: source => !source.includes('node_modules') })
    }
    return root
  }

  it('fails and names the id when an upstream rename leaves a listed row uninserted, though a top-level patch still names it', () => {
    const root = copiedRoot()
    expect(generateDesktopBundle(root).length).toBeGreaterThan(2)
    const base = join(root, 'packages/bundle/base/cordis.patch.yml')
    writeFileSync(base, readFileSync(base, 'utf8').replace('    - id: deepseek-account\n', '    - id: renamed-account\n'))
    expect(readFileSync(join(root, 'packages/bundle/web-app/cordis.patch.yml'), 'utf8')).toMatch(/^- id: deepseek-account$/mu)
    expect(() => generateDesktopBundle(root)).toThrow(/not inserted by any source patch file: deepseek-account;/u)
  })

  it('adds each package the Casper layer names as a workspace dependency and refuses a forbidden one', () => {
    const root = copiedRoot()
    const casper = join(root, DESKTOP_BUNDLE_DIR, 'casper.patch.yml')
    const generatedDependencies = (): Record<string, string> => {
      const file = generateDesktopBundle(root).find(output => output.path === `${DESKTOP_BUNDLE_DIR}/package.json`)
      return (JSON.parse(file?.text ?? '{}') as PackageManifest).dependencies ?? {}
    }
    writeFileSync(casper, "- insert:\n    - id: casper-only\n      name: '@casper-test/plugin/sub'\n")
    expect(generatedDependencies()['@casper-test/plugin']).toBe('workspace:*')
    writeFileSync(casper, "- insert:\n    - id: back-again\n      name: '@deepseek-ai/dsh-llm-deepseek-api-key'\n")
    expect(generatedDependencies).toThrow(/names @deepseek-ai\/dsh-llm-deepseek-api-key, which the desktop must not ship/u)
  })
})
