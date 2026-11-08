/**
 * Read-only file access for Casper inside the app's own install and profile
 * folders, which Casper's own tools cannot open when they sit inside
 * `app.asar`.
 * @module @deepseek-ai/dsh-casper-agent/app-read
 */

import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Most bytes of text one call returns. */
export const READ_MAX_BYTES = 256 * 1024
/** Most lines one call may ask for. */
export const READ_MAX_LINES = 4000
/** Most entries one directory listing returns. */
export const LIST_MAX_ENTRIES = 500
/** Largest file read at all; a bigger one is refused rather than loaded. */
const FILE_MAX_BYTES = 32 * 1024 * 1024
/** Bytes inspected for a NUL to tell a binary file. */
const BINARY_PROBE_BYTES = 8 * 1024

/** Arguments of `app_read_file`. */
export interface AppReadRequest {
  /** Absolute path of a file or directory. */
  readonly path: string
  /** Zero-based first line to return. */
  readonly offset?: number
  /** Number of lines to return, 1 to {@link READ_MAX_LINES}. */
  readonly limit?: number
}

/** Text answer of one read; `isError` marks a refusal or failure. */
export interface AppReadResult {
  readonly text: string
  readonly isError: boolean
}

/**
 * Folders `app_read_file` reads from: the folder holding the app's installed
 * `@deepseek-ai/*` packages, and the profile's `node_modules`. A source
 * checkout has no such install folder; its `packages` and `docs` folders take
 * its place.
 * @param anchor - a file inside one installed package (this module's own file).
 * @param profileDir - the profile folder, when the app was started with one.
 * @returns absolute root folders.
 */
export function appReadRoots(anchor: string, profileDir: string | undefined): string[] {
  const roots: string[] = []
  const segments = resolve(anchor).split(sep)
  const modules = segments.lastIndexOf('node_modules')
  if (isInstalled(anchor)) {
    roots.push(segments.slice(0, modules + 1).join(sep))
  } else {
    const packages = segments.lastIndexOf('packages')
    /* v8 ignore next -- every source checkout keeps this package under packages/. */
    const checkout = packages > 0 ? segments.slice(0, packages).join(sep) || sep : dirname(resolve(anchor))
    roots.push(join(checkout, 'packages'), join(checkout, 'docs'))
  }
  if (profileDir !== undefined) roots.push(join(profileDir, 'node_modules'))
  return roots
}

/**
 * Whether `anchor` sits in an installed package folder rather than a source checkout. The Desktop app installs
 * its packages without TypeScript declarations or `src/`, and with none of the repository's `docs/`.
 * @param anchor - a file inside one installed package (this module's own file).
 * @returns true when a `node_modules` folder holds `anchor`.
 */
export function isInstalled(anchor: string): boolean {
  return resolve(anchor).split(sep).lastIndexOf('node_modules') > 0
}

/**
 * The anchor file {@link appReadRoots} starts from: this module itself.
 * @returns the absolute path of this module.
 */
export function selfAnchor(): string {
  return fileURLToPath(import.meta.url)
}

/**
 * Whether `child` is `root` or lies inside it.
 * @param root - absolute folder.
 * @param child - absolute path.
 * @returns true when `child` does not leave `root`.
 */
export function isInside(root: string, child: string): boolean {
  const rel = relative(root, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** The real path of `path`, or undefined when it cannot be resolved (missing, or a filesystem without realpath). */
async function realOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch (error: unknown) {
    // A missing path is reported by the read itself; an archive filesystem may not resolve real paths.
    void error
    return undefined
  }
}

/**
 * Whether `path` is inside one of `roots`, lexically and, when real paths resolve, by real path too.
 * @param roots - absolute folders.
 * @param path - absolute path; `..` segments are read through links, as the file system reads them.
 * @returns true when no root's real folder is left.
 */
export async function contained(roots: readonly string[], path: string): Promise<boolean> {
  const real = await realOrUndefined(path)
  for (const root of roots) {
    const realRoot = await realOrUndefined(root) ?? root
    if (!isInside(root, path) && !isInside(realRoot, path)) continue
    if (real === undefined || isInside(realRoot, real)) return true
  }
  return false
}

/**
 * Read one file as UTF-8 lines, or list one directory, inside `roots`.
 * @param roots - absolute folders the read may reach.
 * @param request - the path and optional line window.
 * @returns the text, or a refusal marked `isError`.
 */
export async function readAppFile(roots: readonly string[], request: AppReadRequest): Promise<AppReadResult> {
  const refuse = (text: string): AppReadResult => ({ text, isError: true })
  if (!isAbsolute(request.path)) return refuse('app_read_file needs an absolute path.')
  const offset = request.offset ?? 0
  const limit = request.limit ?? READ_MAX_LINES
  if (!Number.isInteger(offset) || offset < 0) return refuse('offset must be a whole number of lines, 0 or more.')
  if (!Number.isInteger(limit) || limit < 1 || limit > READ_MAX_LINES) return refuse(`limit must be a whole number from 1 to ${READ_MAX_LINES}.`)
  const path = resolve(request.path)
  if (!await contained(roots, path)) {
    return refuse(`${path} is outside the app's folders. app_read_file reads only under: ${roots.join(', ')}`)
  }
  let info
  try {
    info = await stat(path)
  } catch (error: unknown) {
    return refuse(`${path} could not be read: ${String(error)}`)
  }
  if (info.isDirectory()) {
    const entries = await readdir(path, { withFileTypes: true })
    const listed = entries.slice(0, LIST_MAX_ENTRIES).map(entry => ({ name: entry.name, dir: entry.isDirectory() }))
    const more = entries.length > LIST_MAX_ENTRIES ? { more: entries.length - LIST_MAX_ENTRIES } : {}
    return { text: JSON.stringify({ path, entries: listed, ...more }), isError: false }
  }
  if (info.size > FILE_MAX_BYTES) return refuse(`${path} is ${info.size} bytes, too large to read.`)
  const bytes = await readFile(path)
  if (!path.toLowerCase().endsWith('.svg') && bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
    return { text: `${path} is a binary file (${bytes.length} bytes); app_read_file returns text only.`, isError: false }
  }
  const lines = bytes.toString('utf8').split('\n')
  const window = lines.slice(offset, offset + limit)
  let text = ''
  let size = 0
  let taken = 0
  let cut = ''
  for (const line of window) {
    const next = taken === 0 ? line : `\n${line}`
    const nextSize = Buffer.byteLength(next)
    if (size + nextSize > READ_MAX_BYTES) {
      if (taken === 0) {
        // One line longer than a whole read (minified code): send its head and step past it, never stall on it.
        text = utf8Head(Buffer.from(line), READ_MAX_BYTES)
        taken = 1
        cut = `line ${offset} is ${nextSize} bytes, cut to its first ${Buffer.byteLength(text)}`
      }
      break
    }
    text += next
    size += nextSize
    taken += 1
  }
  const end = offset + taken
  const more = end < lines.length ? `lines ${offset}-${end - 1} of ${lines.length}; continue with offset ${end}` : ''
  const note = [cut, more].filter(part => part !== '').join('; ')
  if (note !== '') text += `\n[app_read_file: ${note}]`
  return { text, isError: false }
}

/**
 * The longest prefix of `bytes` of at most `max` bytes that ends on a whole UTF-8 character.
 * @param bytes - UTF-8 text longer than `max` bytes.
 * @param max - most bytes to keep.
 * @returns the decoded prefix.
 */
function utf8Head(bytes: Buffer, max: number): string {
  let end = max
  // A continuation byte (10xxxxxx) at the cut belongs to a character that started before it; text
  // encoded from a string starts with a lead byte, so the walk stops by index 0.
  while ((bytes.readUInt8(end) & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}
