/** Pure archive-format and immutable-manifest helpers. */

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { AGENT_NOTE_CLASSES } from './agent-note-tree.ts'

/** Versioned fields in the frozen-content manifest. */
export interface ArchiveManifest {
  version: 1
  files: Readonly<Record<string, string>>
}

/** Reads one artifact's sealed bytes from the trusted baseline; undefined when the baseline lacks it. */
export type SealedArtifactReader = (path: string) => Buffer | undefined

/** Hash one archived artifact independently of the repository's Git object format. */
function archiveContentHash(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse the archive manifest and reject fields or hashes outside its closed schema. */
export function parseArchiveManifest(content: string): ArchiveManifest {
  const value: unknown = JSON.parse(content)
  if (!isRecord(value)) throw new Error('expected a JSON object')
  const fields = Object.keys(value).sort()
  if (fields.join(',') !== 'files,version') throw new Error('expected exactly the fields `version` and `files`')
  if (value.version !== 1) throw new Error('unsupported manifest version (expected 1)')
  if (!isRecord(value.files)) throw new Error('`files` must be an object')
  const files: Record<string, string> = {}
  for (const [path, hash] of Object.entries(value.files)) {
    if (typeof hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`invalid content hash for ${path}`)
    }
    files[path] = hash
  }
  return { version: 1, files }
}

/** Render the archive manifest with deterministic path ordering. */
export function renderArchiveManifest(files: Readonly<Record<string, string>>): string {
  return `${JSON.stringify({
    version: 1,
    files: Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))),
  }, null, 2)}\n`
}

/** Chinese counterparts and pairing records sealed before the archive became English-only. */
const RETIRED_COMPANION = /\.(?:zh\.md|i18n\.yaml)$/u

/**
 * Remove the retired language-switcher paragraph from one sealed English note.
 * @param path - archive-relative path of the English note.
 * @param content - sealed note bytes.
 * @returns the bytes without the `English | [中文](<note>.zh.md)` line and its following blank line, or the input when absent.
 */
export function withoutLanguageSwitcher(path: string, content: Buffer): Buffer {
  const lines = content.toString('utf8').split('\n')
  const index = lines.indexOf(`English | [中文](${basename(path, '.md')}.zh.md)`)
  if (index < 0 || lines[index + 1] !== '') return content
  lines.splice(index, 2)
  return Buffer.from(lines.join('\n'))
}

/** Whether a changed seal is the English-only retirement of exactly this sealed note's language switcher. */
function isSwitcherRetirement(path: string, expected: string, actual: string, sealed: SealedArtifactReader): boolean {
  if (!path.endsWith('.md')) return false
  const content = sealed(path)
  if (content === undefined || archiveContentHash(content) !== expected) return false
  const retired = withoutLanguageSwitcher(path, content)
  return retired !== content && archiveContentHash(retired) === actual
}

/**
 * Reject sealed changes except the English-only retirement: a sealed Chinese counterpart or
 * pairing record leaves the manifest, and a sealed English note loses only its language switcher.
 * @param baseline - manifest at the trusted pre-change commit.
 * @param current - manifest proposed by the working tree.
 * @param sealed - reader for baseline bytes, consulted only for a changed English seal.
 * @returns one message per removed, retained-retired, or changed seal.
 */
export function validateArchiveManifestExtension(
  baseline: ArchiveManifest,
  current: ArchiveManifest,
  sealed: SealedArtifactReader,
): string[] {
  const errors: string[] = []
  for (const [path, expected] of Object.entries(baseline.files)) {
    const actual = current.files[path]
    if (RETIRED_COMPANION.test(path)) {
      if (actual !== undefined) errors.push(`${path}: retired translation seal must leave the manifest`)
    } else if (actual === undefined) errors.push(`${path}: sealed manifest entry is missing`)
    else if (actual !== expected && !isSwitcherRetirement(path, expected, actual, sealed)) {
      errors.push(`${path}: sealed manifest hash changed`)
    }
  }
  return errors
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function validateMetadata(path: string, content: Buffer, sourceBase: string): string[] {
  const errors: string[] = []
  const lines = content.toString('utf8').split('\n')
  const status = lines.findIndex(line => line.startsWith('Status:'))
  if (lines[status] !== 'Status: implemented') errors.push(`${path}: requires \`Status: implemented\``)
  const archived = /^Archived: (\d{4}-\d{2}-\d{2})$/.exec(lines[status + 1] ?? '')?.[1]
  if (status < 0 || archived === undefined || !validDate(archived)) {
    errors.push(`${path}: requires \`Archived: YYYY-MM-DD\` with a valid date immediately after the status`)
  } else if (archived < sourceBase.slice(0, 10)) {
    errors.push(`${path}: archive date ${archived} predates the note filename`)
  }
  return errors
}

/** Validate the closed kind tree and implemented/archive metadata of every English-only note. */
export function validateArchiveArtifacts(artifacts: ReadonlyMap<string, Buffer>): string[] {
  const errors: string[] = []
  for (const [path, content] of [...artifacts].sort(([left], [right]) => left.localeCompare(right))) {
    const match = /^([^/]+)\/(\d{4}-\d{2}-\d{2}-.+)\.md$/.exec(path)
    if (match?.[1] === undefined || match[2] === undefined || match[2].endsWith('.zh')) {
      errors.push(`${path}: expected {kind}/yyyy-mm-dd-topic.md`)
      continue
    }
    if (!(AGENT_NOTE_CLASSES as readonly string[]).includes(match[1])) {
      errors.push(`${path}: unknown Agent Note kind ${JSON.stringify(match[1])}`)
      continue
    }
    errors.push(...validateMetadata(path, content, match[2]))
  }
  return errors
}

/**
 * Preserve every sealed path/hash, apply the English-only retirement, and append hashes for newly archived artifacts.
 * @param existing - manifest currently in the working tree.
 * @param artifacts - every archived file keyed by archive-relative path.
 * @param sealed - reader for baseline bytes, consulted only for a changed English seal.
 * @returns the resulting seals, newly added and retirement-changed paths, and one message per violated seal.
 */
export function extendArchiveManifest(
  existing: ArchiveManifest,
  artifacts: ReadonlyMap<string, Buffer>,
  sealed: SealedArtifactReader,
): { files: Record<string, string>; added: string[]; retired: string[]; errors: string[] } {
  const errors: string[] = []
  const retired: string[] = []
  const files: Record<string, string> = {}
  for (const [path, expected] of Object.entries(existing.files)) {
    const content = artifacts.get(path)
    if (RETIRED_COMPANION.test(path)) {
      retired.push(path)
      continue
    }
    if (content === undefined) {
      errors.push(`${path}: sealed artifact is missing`)
      continue
    }
    const actual = archiveContentHash(content)
    if (actual !== expected) {
      if (isSwitcherRetirement(path, expected, actual, sealed)) retired.push(path)
      else errors.push(`${path}: sealed content hash changed`)
    }
    files[path] = actual
  }
  const added: string[] = []
  for (const [path, content] of [...artifacts].sort(([left], [right]) => left.localeCompare(right))) {
    if (files[path] !== undefined || Object.hasOwn(existing.files, path)) continue
    files[path] = archiveContentHash(content)
    added.push(path)
  }
  return { files, added, retired, errors }
}
