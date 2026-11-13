/**
 * Local cross-check of a packaged Casper desktop app: apply the shipped-output gate's host and screen-text rules to every
 * file in `app.asar` (bundles included, which the source-plane gate cannot see), compare its top-level `@deepseek-ai`
 * packages with the closure the gate scans, and require that no omitted or forbidden package is installed at any depth
 * and that the dsh runtime tree, `dsh/`, holds one copy of each workspace package. The Electron shell's own
 * `node_modules` is a separate runtime and may repeat packages the dsh runtime has. Packaging needs macOS or Windows,
 * so this runs locally, not in Casper CI.
 *
 * Usage: `pnpm exec tsx scripts/casper/scan-packaged-app.ts <Casper.app | app.asar> --target <platform>-<arch> [--json <report.json>]`,
 * where the target is the archive's own, such as `darwin-arm64`.
 * It reads the archive only; it never launches the app. Exit status 1 means the workspace package sets differ or the
 * archive installs a package it must not.
 * @module scripts/casper/scan-packaged-app
 */

import { closeSync, existsSync, openSync, readSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { DESKTOP_OMITTED_PACKAGES } from '../../apps/desktop/src/core-package-set.ts'
import { DESKTOP_FORBIDDEN_PACKAGES } from './desktop-policy.ts'
import { DESKTOP_SHIPPED_TARGETS, desktopShippedWorkspacePackages } from './desktop-shipped.ts'
import { FORBIDDEN_HOST, FORBIDDEN_SCREEN_TEXT } from './desktop-shipped-rules.ts'

interface AsarNode {
  readonly files?: Readonly<Record<string, AsarNode>>
  readonly size?: number
  readonly offset?: string
  readonly unpacked?: boolean
}

/** What one packaged app contains, by rule. */
export interface PackagedAppReport {
  /** Forbidden host occurrences by lowercased host. */
  readonly hosts: Readonly<Record<string, number>>
  /** Forbidden screen-text occurrences by match. */
  readonly texts: Readonly<Record<string, number>>
  /** Host and text occurrences by archive path, for files with any. */
  readonly files: Readonly<Record<string, Readonly<Record<string, number>>>>
  /** `@deepseek-ai` packages installed under `dsh/node_modules`. */
  readonly packages: readonly string[]
  /** Folder of every `@deepseek-ai` package installed at any depth, by package name. */
  readonly installed: Readonly<Record<string, readonly string[]>>
}

const INSTALLED_PACKAGE = /(?:^|\/)node_modules\/(@deepseek-ai\/[^/]+)\/package\.json$/u

function readAt(fd: number, length: number, position: number): Buffer {
  const buffer = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const bytes = readSync(fd, buffer, read, length - read, position + read)
    if (bytes === 0) throw new Error(`scan-packaged-app: archive ended at byte ${position + read}`)
    read += bytes
  }
  return buffer
}

/**
 * Scan one `app.asar` archive. Files stored outside the archive (`unpacked`) are skipped; they are native binaries.
 * @param archive - Path of `app.asar`.
 * @returns Occurrence counts and the archive's `@deepseek-ai` packages.
 */
export function scanPackagedApp(archive: string): PackagedAppReport {
  const fd = openSync(archive, 'r')
  try {
    const prefix = readAt(fd, 16, 0)
    const headerSize = prefix.readUInt32LE(4)
    const header = JSON.parse(readAt(fd, prefix.readUInt32LE(12), 16).toString('utf8')) as AsarNode
    const base = 8 + headerSize
    const hosts: Record<string, number> = {}
    const texts: Record<string, number> = {}
    const files: Record<string, Record<string, number>> = {}
    const installed: Record<string, string[]> = {}
    const count = (into: Record<string, number>, file: string, match: string): void => {
      into[match] = (into[match] ?? 0) + 1
      const perFile = files[file] ??= {}
      perFile[match] = (perFile[match] ?? 0) + 1
    }
    const visit = (node: AsarNode, path: string): void => {
      if (node.files !== undefined) {
        for (const [name, child] of Object.entries(node.files)) visit(child, path === '' ? name : `${path}/${name}`)
        return
      }
      const name = INSTALLED_PACKAGE.exec(path)?.[1]
      if (name !== undefined) (installed[name] ??= []).push(path.slice(0, -'/package.json'.length))
      if (node.unpacked === true || node.size === undefined || node.offset === undefined || node.size === 0) return
      const text = readAt(fd, node.size, base + Number(node.offset)).toString('latin1')
      for (const match of text.matchAll(FORBIDDEN_HOST)) count(hosts, path, match[0].toLowerCase())
      if (!/\.(?:[cm]?js|json|ya?ml|html?)$/u.test(path)) return
      const utf8 = Buffer.from(text, 'latin1').toString('utf8')
      for (const match of utf8.matchAll(FORBIDDEN_SCREEN_TEXT)) count(texts, path, match[0])
    }
    visit(header, '')
    const scoped = header.files?.dsh?.files?.node_modules?.files?.['@deepseek-ai']?.files ?? {}
    const packages = Object.keys(scoped).map(name => `@deepseek-ai/${name}`).sort()
    for (const folders of Object.values(installed)) folders.sort()
    return { hosts, texts, files, packages, installed }
  } finally {
    closeSync(fd)
  }
}

function main(): void {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { json: { type: 'string' }, target: { type: 'string' } } })
  const input = positionals[0]
  if (input === undefined) throw new Error('scan-packaged-app: pass the path of Casper.app or app.asar')
  const archive = input.endsWith('.asar') ? input : join(input, 'Contents', 'Resources', 'app.asar')
  if (!existsSync(archive)) throw new Error(`scan-packaged-app: ${archive} does not exist`)
  const target = DESKTOP_SHIPPED_TARGETS.find(candidate => `${candidate.platform}-${candidate.arch}` === values.target)
  if (target === undefined) {
    const known = DESKTOP_SHIPPED_TARGETS.map(candidate => `${candidate.platform}-${candidate.arch}`).join(', ')
    throw new Error(`scan-packaged-app: pass --target as one of ${known}`)
  }
  const report = scanPackagedApp(archive)
  if (values.json !== undefined) writeFileSync(values.json, `${JSON.stringify(report, undefined, 2)}\n`)
  console.log('hosts:', report.hosts)
  console.log('screen text:', report.texts)
  const { closure: expected, workspace } = desktopShippedWorkspacePackages([target])
  const shipped = report.packages.filter(name => workspace.includes(name))
  const missing = expected.filter(name => !shipped.includes(name))
  const extra = shipped.filter(name => !expected.includes(name))
  console.log(`workspace packages: ${shipped.length} in the archive, ${expected.length} in the gate's ${values.target} closure`)
  for (const name of missing) console.error(`scan-packaged-app: the gate scans ${name}, which the archive does not ship`)
  for (const name of extra) console.error(`scan-packaged-app: the archive ships ${name}, which the gate does not scan`)
  const unshippable = new Set([...DESKTOP_OMITTED_PACKAGES, ...DESKTOP_FORBIDDEN_PACKAGES])
  const duplicates = (folders: readonly string[]): string[] => folders.length > 1
    ? folders.map(folder => `${folder}, one of ${folders.length} copies of a workspace package in the dsh runtime`)
    : []
  const disallowed = Object.entries(report.installed).flatMap(([name, folders]) => [
    ...unshippable.has(name) ? folders.map(folder => `${folder}, a package the desktop must not ship`) : [],
    ...duplicates(workspace.includes(name) ? folders.filter(folder => folder.startsWith('dsh/')) : []),
  ])
  console.log(`@deepseek-ai packages at any depth: ${Object.keys(report.installed).length}, disallowed folders: ${disallowed.length}`)
  for (const folder of disallowed) console.error(`scan-packaged-app: the archive installs ${folder}`)
  if (missing.length > 0 || extra.length > 0 || disallowed.length > 0) process.exitCode = 1
}

if (import.meta.main) main()
