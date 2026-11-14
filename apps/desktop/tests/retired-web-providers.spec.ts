/** Clearing stored choices of web providers the Casper desktop no longer composes from the desktop profile patch. */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  migrateRetiredWebProviders,
  RETIRED_WEB_PROVIDER_IDS,
  RetiredWebProviderMigrationError,
  WEB_ENTRY_NAME,
} from '../src/casper-desktop-profile.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { DesktopProjectManager } from '../src/project-manager.ts'
import { runtimeFixture } from './runtime-fixture.ts'

const roots: string[] = []
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-web-providers-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A profile directory whose patch file holds `text`. */
function profileWithPatch(text: string): { dir: string; path: string } {
  const dir = temporaryRoot()
  const path = join(dir, 'cordis.patch.yml')
  writeFileSync(path, text)
  return { dir, path }
}

const HEADER = '# Your patch layer for this dsh profile.\n'
const OTHER_ROW = '- id: plugin-row\n  disabled: true\n'

describe('migrateRetiredWebProviders', () => {
  it('lists exactly the upstream search and fetch provider ids', () => {
    expect(RETIRED_WEB_PROVIDER_IDS).toEqual(['deepseek-search-api', 'deepseek-official', 'deepseek-fetch-api'])
  })

  it.each(RETIRED_WEB_PROVIDER_IDS.flatMap(id => [['searchProvider', id], ['fetchProvider', id]]))(
    'clears %s: %s and keeps comments, other fields and other rows',
    async (field, id) => {
      const { dir, path } = profileWithPatch(`${HEADER}${OTHER_ROW}# my web choices\n- id: web\n  name: '@deepseek-ai/dsh-web'\n`
        + `  config:\n    ${field}: ${id} # picked in settings\n    offerUnresolvedSearch: false\n# trailing note\n`)
      await expect(migrateRetiredWebProviders(dir)).resolves.toBe(true)
      expect(readFileSync(path, 'utf8')).toBe(`${HEADER}${OTHER_ROW}# my web choices\n- id: web\n  name: '@deepseek-ai/dsh-web'\n`
        + '  config:\n    offerUnresolvedSearch: false\n# trailing note\n')
    },
  )

  it('removes a config left empty, so the composed config applies, and keeps the row', async () => {
    const { dir, path } = profileWithPatch(`${HEADER}- id: web\n  name: '@deepseek-ai/dsh-web'\n  config:\n`
      + '    searchProvider: deepseek-search-api\n    fetchProvider: "deepseek-fetch-api"\n')
    await expect(migrateRetiredWebProviders(dir)).resolves.toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(`${HEADER}- id: web\n  name: '@deepseek-ai/dsh-web'\n`)
  })

  it('names the package the desktop composition loads for the web entry', () => {
    const base = readFileSync(join(import.meta.dirname, '../../../packages/casper/desktop/generated/base.patch.yml'), 'utf8')
    expect(base).toMatch(new RegExp(`- id: web\\n\\s+name: '${WEB_ENTRY_NAME}'\\n`, 'u'))
  })

  it.each([
    [
      'ignores a web row that names another package, which the Host skips',
      '- id: web\n  name: other\n  config:\n    x: 1\n- id: web\n  config:\n    searchProvider: deepseek-official\n',
      '- id: web\n  name: other\n  config:\n    x: 1\n- id: web\n',
    ],
    [
      'edits a web row whose name is the web package',
      `- id: web\n  name: '${WEB_ENTRY_NAME}'\n  config:\n    fetchProvider: deepseek-fetch-api\n`,
      `- id: web\n  name: '${WEB_ENTRY_NAME}'\n`,
    ],
    [
      'edits a web row with a null insert, which the Host applies as an override',
      '- id: web\n  insert: null\n  config:\n    fetchProvider: deepseek-fetch-api\n',
      '- id: web\n  insert: null\n',
    ],
  ])('%s', async (_case, before, after) => {
    const { dir, path } = profileWithPatch(before)
    await expect(migrateRetiredWebProviders(dir)).resolves.toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(after)
  })

  it('clears a retired choice and keeps a supported one in the same row', async () => {
    const { dir, path } = profileWithPatch("- id: web\n  config:\n    searchProvider: 'deepseek-official'\n    fetchProvider: http\n")
    await expect(migrateRetiredWebProviders(dir)).resolves.toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('- id: web\n  config:\n    fetchProvider: http\n')
  })

  it.each([
    [
      'keeps an emptied last config as {} when an earlier web row sets a config the removal would bring back',
      '- id: web\n  config:\n    searchProvider: perplexity\n- id: web\n  config: # mine\n    fetchProvider: deepseek-fetch-api\n',
      '- id: web\n  config:\n    searchProvider: perplexity\n- id: web\n  config: {} # mine\n',
    ],
    [
      'removes every emptied config when no earlier web row keeps one',
      '- id: web\n  config:\n    searchProvider: deepseek-official\n- id: web\n  config:\n    fetchProvider: deepseek-fetch-api\n',
      '- id: web\n- id: web\n',
    ],
    [
      'removes an emptied earlier config that a later web row replaces',
      '- id: web\n  config:\n    searchProvider: deepseek-official\n- id: web\n  config:\n    searchProvider: perplexity\n',
      '- id: web\n- id: web\n  config:\n    searchProvider: perplexity\n',
    ],
    [
      'keeps a leading byte order mark',
      '﻿- id: web\n  config:\n    fetchProvider: deepseek-fetch-api\n    offerUnresolvedSearch: false\n',
      '﻿- id: web\n  config:\n    offerUnresolvedSearch: false\n',
    ],
    [
      'edits a top-level sequence indented by spaces',
      '  - id: plugin-row\n    disabled: true\n  - id: web\n    config:\n      fetchProvider: deepseek-fetch-api\n',
      '  - id: plugin-row\n    disabled: true\n  - id: web\n',
    ],
    [
      'removes a value written on a continuation line with its key',
      '- id: web\n  config:\n    fetchProvider:\n      deepseek-fetch-api\n    offerUnresolvedSearch: false\n',
      '- id: web\n  config:\n    offerUnresolvedSearch: false\n',
    ],
    [
      'keeps a key of the same name nested deeper in the config',
      '- id: web\n  config:\n    extra:\n      fetchProvider: deepseek-fetch-api\n    fetchProvider: deepseek-fetch-api\n',
      '- id: web\n  config:\n    extra:\n      fetchProvider: deepseek-fetch-api\n',
    ],
  ])('%s', async (_name, text, migrated) => {
    const { dir, path } = profileWithPatch(text)
    await expect(migrateRetiredWebProviders(dir)).resolves.toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(migrated)
  })

  it.each([
    ['other provider ids', '- id: web\n  config:\n    searchProvider: perplexity\n    fetchProvider: http\n'],
    ['a !!js expression', '- id: web\n  config:\n    fetchProvider: !!js process.env.FETCH || \'deepseek-fetch-api\'\n'],
    ['a retired id in another row', '- id: other-web\n  config:\n    searchProvider: deepseek-search-api\n'],
    ['a retired id in an inserted row', '- insert:\n    - id: web\n      name: x\n      config:\n        fetchProvider: deepseek-fetch-api\n'],
    ['the new-profile template', '# header\n[]\n'],
    ['no web row', `${HEADER}${OTHER_ROW}`],
  ])('leaves %s byte-identical without writing', async (_name, text) => {
    const { dir, path } = profileWithPatch(text)
    const inode = statSync(path).ino
    await expect(migrateRetiredWebProviders(dir)).resolves.toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(text)
    expect(statSync(path).ino).toBe(inode)
  })

  it('fails loud when the patch cannot be read', async () => {
    const dir = temporaryRoot()
    mkdirSync(join(dir, 'cordis.patch.yml'))
    await expect(migrateRetiredWebProviders(dir)).rejects.toThrow(/cannot be read .*restore read access to it, or back up/su)
  })

  it('does nothing when the profile has no patch file', async () => {
    const dir = temporaryRoot()
    await expect(migrateRetiredWebProviders(dir)).resolves.toBe(false)
    expect(existsSync(join(dir, 'cordis.patch.yml'))).toBe(false)
  })

  it('is idempotent: a second run changes nothing', async () => {
    const { dir, path } = profileWithPatch('- id: web\n  config:\n    fetchProvider: deepseek-fetch-api\n    offerUnresolvedSearch: false\n')
    await expect(migrateRetiredWebProviders(dir)).resolves.toBe(true)
    const migrated = readFileSync(path, 'utf8')
    const inode = statSync(path).ino
    await expect(migrateRetiredWebProviders(dir)).resolves.toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(migrated)
    expect(statSync(path).ino).toBe(inode)
  })

  it.each([
    ['a malformed patch', '- id: web\n  config: [unclosed\n', /cannot be loaded .*fix the YAML, or back up the profile patch/su],
    ['a patch that is not a list', 'id: web\n', /cannot be loaded .*top-level YAML array/su],
    ['a flow-style choice', '- {id: web, config: {fetchProvider: deepseek-fetch-api}}\n', /in a form Casper cannot remove exactly/u],
    ['a flow-style list', '[{id: web, config: {fetchProvider: deepseek-fetch-api}}]\n', /in a form Casper cannot remove exactly/u],
    ['an anchored choice', '- id: web\n  config:\n    fetchProvider: &f deepseek-fetch-api\n', /in a form Casper cannot remove exactly/u],
    [
      'a web config that another row aliases',
      '- id: web\n  config: &c\n    fetchProvider: deepseek-fetch-api\n    offerUnresolvedSearch: false\n- id: other\n  config: *c\n',
      /shares a "web" entry or its config through a YAML anchor and alias/u,
    ],
    [
      'a web config that aliases another row',
      '- id: other\n  config: &c\n    fetchProvider: deepseek-fetch-api\n- id: web\n  config: *c\n',
      /shares a "web" entry or its config through a YAML anchor and alias/u,
    ],
  ])('fails loud on %s and leaves the file unchanged', async (_name, text, message) => {
    const { dir, path } = profileWithPatch(text)
    const failure = migrateRetiredWebProviders(dir)
    await expect(failure).rejects.toBeInstanceOf(RetiredWebProviderMigrationError)
    await expect(failure).rejects.toThrow(message)
    await expect(failure).rejects.toThrow(/Disable third-party plugins, back up profile patch, and restart/u)
    expect(readFileSync(path, 'utf8')).toBe(text)
    expect(readdirSync(dir)).toEqual(['cordis.patch.yml'])
  })
})

describe('DesktopProjectManager.applyRelease', () => {
  function setup(): DesktopProjectManager {
    const root = temporaryRoot()
    const dsh = join(root, 'resources', 'dsh')
    runtimeFixture(dsh)
    return new DesktopProjectManager(resolveDesktopPaths(join(root, '.dsh')), { dsh })
  }

  it('clears a stored retired web provider choice from an existing profile', async () => {
    const manager = setup()
    await manager.applyRelease()
    const path = join(manager.paths.profile, 'cordis.patch.yml')
    writeFileSync(path, `${OTHER_ROW}- id: web\n  config:\n    searchProvider: deepseek-search-api\n    fetchProvider: deepseek-fetch-api\n`)
    await manager.applyRelease()
    expect(readFileSync(path, 'utf8')).toBe(`${OTHER_ROW}- id: web\n`)
  })

  it('stops preparation on a patch it cannot migrate and releases the profile lock', async () => {
    const manager = setup()
    await manager.applyRelease()
    const path = join(manager.paths.profile, 'cordis.patch.yml')
    writeFileSync(path, '- id: web\n  config: [unclosed\n')
    await expect(manager.applyRelease()).rejects.toBeInstanceOf(RetiredWebProviderMigrationError)
    expect(existsSync(manager.paths.lock)).toBe(false)
  })
})
