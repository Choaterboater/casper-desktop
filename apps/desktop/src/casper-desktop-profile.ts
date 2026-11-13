/**
 * The Casper desktop profile's bundle list, the move of an existing profile off upstream's Web template bundles, and
 * the removal of stored choices of web providers the desktop no longer composes.
 * @module
 */

import { randomBytes } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { loadOptionalPatches, PROFILE_PATCH_FILENAME, readProfileManifest, writeProfileBundles } from '@deepseek-ai/dsh-app-boot'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** The bundle a desktop profile composes from: upstream's base and Web layers without the upstream service rows. */
export const CASPER_DESKTOP_BUNDLE = '@deepseek-ai/dsh-casper-desktop'

/** Bundles of upstream's Web profile template that {@link CASPER_DESKTOP_BUNDLE} replaces in a desktop profile. */
export const REPLACED_DESKTOP_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** Template bundles of a new desktop profile, and the list native recovery restores. */
export const CASPER_DESKTOP_BUNDLES: readonly string[] = [CASPER_DESKTOP_BUNDLE]

/**
 * Rewrite the desktop profile's `dsh.profile.bundles` so {@link CASPER_DESKTOP_BUNDLE} takes the position of the first
 * template bundle it lists (the Casper bundle or one of {@link REPLACED_DESKTOP_BUNDLES}), the other template bundles
 * are dropped, and every other bundle keeps its order. Writes only when the list changes; every other manifest field is
 * kept. The caller holds the desktop profile lock with the Host stopped.
 * @param profileDir - The desktop profile directory, whose `package.json` exists.
 * @returns Whether the manifest was rewritten.
 * @throws {Error} When the manifest cannot be read, when `dsh.profile.bundles` is not a list of package names, or when
 *   it names no template bundle; the manifest is then left unchanged, and native recovery
 *   (`DesktopProjectManager.disableAllPlugins`) restores the template.
 */
export function migrateCasperDesktopBundles(profileDir: string): boolean {
  const manifest = readProfileManifest('dsh', profileDir)
  const path = join(profileDir, 'package.json')
  // The manifest is file data: its declared type is not trusted until the list is checked.
  const declared: unknown = manifest.dsh?.profile?.bundles
  if (!Array.isArray(declared) || !declared.every((name): name is string => typeof name === 'string')) {
    throw new Error(`desktop project: dsh.profile.bundles in ${path} must be a list of package names`)
  }
  const template = new Set([CASPER_DESKTOP_BUNDLE, ...REPLACED_DESKTOP_BUNDLES])
  const first = declared.findIndex(name => template.has(name))
  if (first === -1) {
    throw new Error(`desktop project: ${path} lists no ${CASPER_DESKTOP_BUNDLE}; restore it with the recovery dialog's `
      + '"Disable third-party plugins, back up profile patch, and restart"')
  }
  const bundles = declared.flatMap((name, index) => {
    if (index === first) return [CASPER_DESKTOP_BUNDLE]
    return template.has(name) ? [] : [name]
  })
  if (bundles.length === declared.length && bundles.every((name, index) => name === declared[index])) return false
  writeProfileBundles(profileDir, manifest, bundles)
  return true
}

/**
 * Provider ids of the upstream web search and fetch plugins (rows `web-search-deepseek` and `web-deepseek-api`) that
 * the desktop no longer composes. A desktop profile can still store one as the user's `searchProvider` or
 * `fetchProvider` choice in its `web` patch row: the Web search settings page then lists it as not loaded, and a stored
 * fetch id makes every `web_fetch` call fail because no registered provider has that id.
 * {@link migrateRetiredWebProviders} clears these stored choices so the desktop's composed selection applies.
 */
export const RETIRED_WEB_PROVIDER_IDS: readonly string[] = ['deepseek-search-api', 'deepseek-official', 'deepseek-fetch-api']

/** Patch row id of the web search and fetch seam. */
const WEB_ENTRY_ID = 'web'

/** The package the `web` entry loads; `applyPatches` skips a `web` row that names another package. */
export const WEB_ENTRY_NAME = '@deepseek-ai/dsh-web'

/** Config fields of the `web` row that store a provider id. */
const WEB_PROVIDER_FIELDS = ['searchProvider', 'fetchProvider'] as const

/** Recovery action that backs up and resets the profile patch without loading the profile. */
const PATCH_RECOVERY = 'back up the profile patch with the recovery dialog\'s '
  + '"Disable third-party plugins, back up profile patch, and restart"'

/**
 * Failure to clear retired web provider choices from a desktop profile patch; the patch is left unchanged. The message
 * names the file, what to repair, and the recovery dialog action that backs the patch up instead.
 */
export class RetiredWebProviderMigrationError extends Error {
  /** Stable machine code for this failure. */
  readonly code = 'DESKTOP_RETIRED_WEB_PROVIDER_MIGRATION'

  /**
   * @param path - The profile patch that could not be migrated.
   * @param reason - What prevented the edit and how to repair the file.
   * @param options - The underlying failure, when there is one.
   */
  constructor(readonly path: string, reason: string, options?: ErrorOptions) {
    super(`desktop project: ${path} ${reason}, or ${PATCH_RECOVERY}`, options)
    this.name = 'RetiredWebProviderMigrationError'
  }
}

/** Whether a parsed YAML value is a mapping. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read the profile patch with the boot reader, so a file the Host cannot load is refused here too. */
function readPatches(path: string): ReturnType<typeof loadOptionalPatches> {
  try {
    return loadOptionalPatches('dsh', path)
  } catch (error) {
    throw new RetiredWebProviderMigrationError(path, `cannot be loaded (${error instanceof Error ? error.message : String(error)}); `
      + 'fix the YAML', { cause: error })
  }
}


/** A patch list as the boot reader returns it. */
type PatchList = NonNullable<ReturnType<typeof loadOptionalPatches>>

/**
 * Whether a patch row overrides the `web` entry, by the rule `applyPatches` uses: a row with a falsy `insert`, whose
 * `name`, when set, is the entry's package.
 */
function isWebOverride(patch: PatchList[number]): boolean {
  const name: unknown = patch.name
  return patch.id === WEB_ENTRY_ID && !patch.insert && (!name || name === WEB_ENTRY_NAME)
}

/**
 * How one `web` row is edited: the retired fields cleared from its `config`, and what becomes of that `config`:
 * `keep` when other fields remain, `drop` to remove an emptied `config`, `empty` to keep an emptied one as `{}`.
 */
interface WebRowEdit {
  readonly fields: ReadonlySet<string>
  readonly config: 'keep' | 'drop' | 'empty'
}

/**
 * Plan the edit of every `web` override row whose `config` stores a retired provider id. Rows apply in order and the
 * last `web` override row that sets `config` replaces every earlier `config` in the composed entry, so an emptied
 * `config` is dropped (the bundle's composed config then applies) unless it is that last one and an earlier `web` row
 * keeps a `config` the drop would bring back; that last `config` then stays as `{}`, the previous composed config
 * without its retired values.
 * @param patches - The parsed profile patch.
 * @returns The edits by row index; empty when no `web` row stores a retired id.
 */
function planWebRowEdits(patches: PatchList): Map<number, WebRowEdit> {
  const rows = patches.flatMap((patch, index) => isWebOverride(patch) ? [index] : [])
  const cleared = new Map<number, Set<string>>()
  for (const row of rows) {
    // The patch list is file data: a row's config is not trusted to be a mapping until checked.
    const config: unknown = patches[row]?.config
    if (!isRecord(config)) continue
    const fields = new Set(WEB_PROVIDER_FIELDS.filter((field) => {
      const value = config[field]
      return typeof value === 'string' && RETIRED_WEB_PROVIDER_IDS.includes(value)
    }))
    if (fields.size > 0) cleared.set(row, fields)
  }
  const sets = (row: number): boolean => Object.hasOwn(patches[row] ?? {}, 'config')
  const emptied = (row: number): boolean => {
    const config: unknown = patches[row]?.config
    return isRecord(config) && Object.keys(config).length === cleared.get(row)?.size
  }
  const last = rows.findLast(sets)
  const earlierKept = last !== undefined && rows.some(row => row < last && sets(row) && !emptied(row))
  return new Map([...cleared].map(([row, fields]) => {
    const config = !emptied(row) ? 'keep' : row === last && earlierKept ? 'empty' : 'drop'
    return [row, { fields, config }]
  }))
}

/**
 * Objects the parsed patch list reaches more than once. js-yaml returns one object for an anchored node and each of its
 * aliases, so an edit of such an object would also change the rows that alias it.
 */
function sharedObjects(value: unknown, seen = new Set<object>(), shared = new Set<object>()): Set<object> {
  if (typeof value !== 'object' || value === null) return shared
  if (seen.has(value)) {
    shared.add(value)
    return shared
  }
  seen.add(value)
  for (const child of Object.values(value)) sharedObjects(child, seen, shared)
  return shared
}

/** Number of leading spaces of a line; YAML indents with spaces only. */
function indentOf(line: string): number {
  return /^ */u.exec(line)?.[0].length ?? 0
}

/** Whether a line holds YAML content rather than only blanks or a comment. */
function isContent(line: string): boolean {
  return !/^\s*(?:#[^\n]*)?$/u.test(line)
}

/** One line of a single-line plain or quoted scalar, with an optional comment; anchors, aliases, tags and flow are refused. */
const SCALAR_LINE = /^[ \t]*(?:'[^']*'|"[^"\\]*"|[^\s#'"&*!|>{[%@`][^\s#]*)[ \t]*(?:#.*)?\r?$/u

/** A `config:` key with no inline value, from the key's column on. */
const CONFIG_KEY = /^config[ \t]*:[ \t]*(?:#.*)?\r?$/u

/**
 * Apply {@link planWebRowEdits} to the patch text without reformatting it. The top-level sequence may be indented; each
 * edited row must hold `config:` as a block mapping, and each cleared field must be a direct child of that mapping
 * written as a plain or quoted scalar on the key line or on more-indented continuation lines, which are removed with
 * the key. A key of the same name nested deeper is not a direct child and stays.
 * @param lines - The patch text split at line feeds, without a leading byte order mark.
 * @param rows - The number of rows the parsed patch holds.
 * @param edits - The planned edits by row index.
 * @returns The edited lines, or `undefined` when the text is not in a form this edit can map to the parsed rows.
 */
function editWebRows(lines: readonly string[], rows: number, edits: ReadonlyMap<number, WebRowEdit>): string[] | undefined {
  const first = lines.find(isContent)
  const sequence = first === undefined ? undefined : /^( *)-(?:[ \t]|\r?$)/u.exec(first)?.[1]?.length
  if (sequence === undefined) return undefined
  const starts = lines.flatMap((line, index) =>
    isContent(line) && indentOf(line) === sequence && /^ *-(?:[ \t]|\r?$)/u.test(line) ? [index] : [])
  if (starts.length !== rows) return undefined
  const removed = new Set<number>()
  const replaced = new Map<number, string>()
  for (const [row, edit] of edits) {
    const start = starts[row]
    if (start === undefined) return undefined
    const end = starts[row + 1] ?? lines.length
    // The row's keys start after the dash on its first line, or on the next content line when the dash stands alone.
    const dashed = /^( *- +)([^#\s])/u.exec(lines[start] ?? '')
    const next = lines.slice(start + 1, end).find(isContent)
    const keys = dashed?.[1]?.length ?? (next === undefined ? undefined : indentOf(next))
    if (keys === undefined) return undefined
    const configLine = lines.slice(start, end).findIndex((line, offset) =>
      (offset === 0 ? dashed !== null : isContent(line) && indentOf(line) === keys) && CONFIG_KEY.test(line.slice(keys)))
    if (configLine === -1) return undefined
    const key = start + configLine
    let blockEnd = key + 1
    while (blockEnd < end && (!isContent(lines[blockEnd] ?? '') || indentOf(lines[blockEnd] ?? '') > keys)) blockEnd++
    const children = lines.slice(key + 1, blockEnd).find(isContent)
    if (children === undefined) return undefined
    const childIndent = indentOf(children)
    for (const field of edit.fields) {
      const offset = lines.slice(key + 1, blockEnd).findIndex(line =>
        indentOf(line) === childIndent && new RegExp(`^ *${field}[ \\t]*:`, 'u').test(line))
      if (offset === -1) return undefined
      const fieldLine = key + 1 + offset
      let valueEnd = fieldLine + 1
      while (valueEnd < blockEnd && (!isContent(lines[valueEnd] ?? '') || indentOf(lines[valueEnd] ?? '') > childIndent)) valueEnd++
      while (valueEnd > fieldLine + 1 && !isContent(lines[valueEnd - 1] ?? '')) valueEnd--
      const inline = (lines[fieldLine] ?? '').replace(/^ *\w+[ \t]*:/u, '')
      const continuation = lines.slice(fieldLine + 1, valueEnd).filter(isContent)
      const values = isContent(inline) ? [inline, ...continuation] : continuation
      if (values.length === 0 || !values.every(value => SCALAR_LINE.test(value))) return undefined
      for (let index = fieldLine; index < valueEnd; index++) removed.add(index)
    }
    if (edit.config === 'drop') {
      // Removing the dash line would merge the row into the previous one.
      if (configLine === 0) return undefined
      removed.add(key)
    } else if (edit.config === 'empty') {
      replaced.set(key, (lines[key] ?? '').replace(/^(.*?config[ \t]*:)/u, '$1 {}'))
    }
  }
  return lines.flatMap((line, index) => removed.has(index) ? [] : [replaced.get(index) ?? line])
}

/**
 * Remove each `searchProvider` or `fetchProvider` value naming one of {@link RETIRED_WEB_PROVIDER_IDS} from the `web`
 * rows of the desktop profile patch (`cordis.patch.yml`). Any other value, including a third-party provider id, stays.
 * The last `web` row that sets `config` replaces the composed config, so a cleared field selects automatically (no
 * search provider until the user picks one; the desktop's only fetch provider, Direct fetch). A `config` left empty is
 * removed so the bundle's composed config applies, except when an earlier `web` row sets a `config` the removal would
 * bring back: the emptied `config` then stays as `{}`. The file is edited line by line, so comments, layout, a leading
 * byte order mark and every other row keep their text; before the edit replaces the file, the result is loaded with the
 * boot reader and must equal the parsed original with exactly these edits, every other row unchanged. Writes only when
 * a value is cleared. The shared home patch (`$DSH_HOME/cordis.patch.yml`) is not edited. The caller holds the desktop
 * profile lock with the Host stopped.
 * @param profileDir - The desktop profile directory.
 * @returns Whether the profile patch was rewritten; a missing patch, or one without a retired choice, is not.
 * @throws {RetiredWebProviderMigrationError} When the patch cannot be loaded, when an edited `web` row or its `config`
 *   is shared through a YAML anchor and alias, or when a retired choice is written in a form the line edit cannot
 *   remove exactly (for example flow style, an anchored value, or a `config:` with an inline value); the patch is then
 *   left unchanged.
 */
export async function migrateRetiredWebProviders(profileDir: string): Promise<boolean> {
  const path = join(profileDir, PROFILE_PATCH_FILENAME)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new RetiredWebProviderMigrationError(path, `cannot be read (${String(error)}); restore read access to it`, { cause: error })
  }
  const original = readPatches(path)
  if (original === undefined) return false
  const edits = planWebRowEdits(original)
  if (edits.size === 0) return false

  const shared = sharedObjects(original)
  for (const row of edits.keys()) {
    const patch = original[row]
    const config: unknown = patch?.config
    if (patch !== undefined && (shared.has(patch) || (isRecord(config) && shared.has(config)))) {
      throw new RetiredWebProviderMigrationError(path, `shares a "${WEB_ENTRY_ID}" entry or its config through a YAML anchor `
        + 'and alias, so Casper cannot remove a retired web provider from it alone; write that entry out without the anchor')
    }
  }
  // Edits go to a copy: the parsed original stays the reference every unedited row is compared with.
  const expected = structuredClone(original)
  for (const [row, { fields, config }] of edits) {
    const patch = expected[row]
    const cleared: unknown = patch?.config
    if (patch === undefined || !isRecord(cleared)) continue
    if (config === 'drop') Reflect.deleteProperty(patch, 'config')
    else if (config === 'empty') patch.config = {}
    else for (const field of fields) Reflect.deleteProperty(cleared, field)
  }

  const unsupported = `stores a retired web provider (${RETIRED_WEB_PROVIDER_IDS.join(', ')}) as searchProvider or `
    + `fetchProvider in a "${WEB_ENTRY_ID}" entry in a form Casper cannot remove exactly; delete that line yourself`
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : ''
  const lines = editWebRows(text.slice(bom.length).split('\n'), original.length, edits)
  if (lines === undefined) throw new RetiredWebProviderMigrationError(path, unsupported)
  const next = bom + lines.join('\n')
  const candidate = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(candidate, next, { mode: 0o600, flag: 'wx' })
    // The candidate sits beside the patch, so relative insert paths resolve as they will after the replacement.
    let edited: ReturnType<typeof loadOptionalPatches>
    try {
      edited = loadOptionalPatches('dsh', candidate)
    } catch (error) {
      throw new RetiredWebProviderMigrationError(path, unsupported, { cause: error })
    }
    const exact = edited?.length === original.length && edited.every((patch, row) =>
      isDeepStrictEqual(patch, edits.has(row) ? expected[row] : original[row]))
    if (!exact) throw new RetiredWebProviderMigrationError(path, unsupported)
  } finally {
    rmSync(candidate, { force: true })
  }
  await writeFileAtomic(path, next, { mode: 0o600 })
  return true
}
