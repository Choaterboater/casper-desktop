/** Verify and append-seal the frozen Agent Note archive. */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AGENT_NOTE_CLASSES, agentNoteRoot } from './agent-note-tree.ts'
import {
  extendArchiveManifest,
  parseArchiveManifest,
  renderArchiveManifest,
  validateArchiveArtifacts,
  validateArchiveManifestExtension,
  type ArchiveManifest,
} from './archived-agent-notes.ts'

const args = process.argv.slice(2)
const writeMode = args.length === 1 && args[0] === '--write'
if (args.length > 0 && !writeMode) {
  console.error('verify-archived-agent-notes: usage: tsx scripts/verify-archived-agent-notes.ts [--write]')
  process.exit(1)
}

const archiveRoot = resolve(agentNoteRoot, 'archived')
const manifestPath = resolve(archiveRoot, 'manifest.json')
const repoRoot = resolve(agentNoteRoot, '../..')
const manifestRepoPath = '.agents/notes/archived/manifest.json'
const errors: string[] = []
const allowedRootFiles = new Set(['AGENTS.md', 'manifest.json'])
const kinds = new Set<string>()

if (!existsSync(resolve(archiveRoot, 'AGENTS.md'))) errors.push('archived/AGENTS.md is required')
const artifacts = new Map<string, Buffer>()
for (const entry of readdirSync(archiveRoot, { withFileTypes: true })) {
  if (entry.isFile()) {
    if (!allowedRootFiles.has(entry.name)) errors.push(`archived/${entry.name}: unexpected root file`)
    continue
  }
  if (!entry.isDirectory()) {
    errors.push(`archived/${entry.name}: only regular files and kind directories are allowed`)
    continue
  }
  if (!(AGENT_NOTE_CLASSES as readonly string[]).includes(entry.name)) {
    errors.push(`archived/${entry.name}/: unknown Agent Note kind`)
    continue
  }
  kinds.add(entry.name)
  for (const child of readdirSync(resolve(archiveRoot, entry.name), { withFileTypes: true })) {
    const rel = `${entry.name}/${child.name}`
    if (!child.isFile()) {
      errors.push(`${rel}: archived kind directories contain regular files only`)
      continue
    }
    artifacts.set(rel, readFileSync(resolve(archiveRoot, rel)))
  }
}
for (const kind of AGENT_NOTE_CLASSES) {
  if (!kinds.has(kind)) errors.push(`archived/${kind}/: required kind directory is missing`)
}
errors.push(...validateArchiveArtifacts(artifacts))

function runGit(args: string[]): string {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git exited with status ${result.status}`)
  return result.stdout
}

/** Read one sealed artifact from the baseline commit; undefined when that commit lacks it. */
function readBaselineArtifact(ref: string, path: string): Buffer | undefined {
  const result = spawnSync('git', ['show', `${ref}:.agents/notes/archived/${path}`], { cwd: repoRoot })
  if (result.error !== undefined) throw result.error
  return result.status === 0 ? result.stdout : undefined
}

function readBaselineManifest(ref: string): ArchiveManifest {
  runGit(['cat-file', '-e', `${ref}^{commit}`])
  const manifestEntry = runGit(['ls-tree', '--name-only', ref, '--', manifestRepoPath]).trim()
  if (manifestEntry === '') return { version: 1, files: {} }
  return parseArchiveManifest(runGit(['show', `${ref}:${manifestRepoPath}`]))
}

let manifest: ArchiveManifest = { version: 1, files: {} }
if (existsSync(manifestPath)) {
  try {
    manifest = parseArchiveManifest(readFileSync(manifestPath, 'utf8'))
  } catch (error: unknown) {
    errors.push(`archived/manifest.json: ${error instanceof Error ? error.message : String(error)}`)
  }
} else if (!writeMode) {
  errors.push('archived/manifest.json is required; seal new artifacts with `pnpm run verify-archived-agent-notes --write`')
}

// CI supplies its trusted pre-change commit; local writes compare with committed HEAD.
const baselineRef = process.env.DSH_ARCHIVE_BASE_REF ?? 'HEAD'
const extended = extendArchiveManifest(manifest, artifacts, path => readBaselineArtifact(baselineRef, path))
errors.push(...extended.errors)
// Write mode validates the manifest it would write; check mode validates the committed one.
const validated: ArchiveManifest = writeMode ? { version: 1, files: extended.files } : manifest
try {
  const baseline = readBaselineManifest(baselineRef)
  errors.push(...validateArchiveManifestExtension(baseline, validated, path => readBaselineArtifact(baselineRef, path)))
} catch (error: unknown) {
  errors.push(`archived/manifest.json: cannot read baseline ${JSON.stringify(baselineRef)}: ${error instanceof Error ? error.message : String(error)}`)
}
if (!writeMode) {
  for (const path of extended.added) errors.push(`${path}: archived artifact is not sealed in manifest.json`)
  for (const path of extended.retired) errors.push(`${path}: English-only retirement is not recorded in manifest.json`)
}

if (errors.length > 0) {
  console.error('verify-archived-agent-notes: archive rules violated:')
  for (const error of errors) console.error(`  ${error}`)
  process.exit(1)
}

if (writeMode) {
  const rendered = renderArchiveManifest(extended.files)
  if (!existsSync(manifestPath) || readFileSync(manifestPath, 'utf8') !== rendered) {
    writeFileSync(manifestPath, rendered)
  }
  console.log(`verify-archived-agent-notes: sealed ${extended.added.length} new artifact(s); recorded ${extended.retired.length} English-only retirement(s); other seals unchanged.`)
} else {
  console.log(`verify-archived-agent-notes: ${artifacts.size} frozen artifact(s) checked across ${kinds.size} kind(s).`)
}
