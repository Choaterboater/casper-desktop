/**
 * Project-check discovery: the commands Casper runs on its own after edits. `.casper/project.yaml`
 * `verify:` wins over its `commands:`, which win over commands detected from the repository's
 * manifests (Node scripts, Rust, Go, Python tools). Only the four standard checks are known.
 * @module @deepseek-ai/dsh-casper-checks/project
 */

import { parse } from 'yaml'

/** The standard checks, in the order they run. */
export const STANDARD_CHECKS = ['typecheck', 'lint', 'test', 'build'] as const

/** One standard check name. */
export type StandardCheck = typeof STANDARD_CHECKS[number]

/** How automatic checking behaves for a project. */
export type VerificationMode = 'auto' | 'offer' | 'off'

/** Path of the project file, relative to the working directory. */
export const PROJECT_FILE = '.casper/project.yaml'

/** Where one discovered command came from. */
export type CheckSource = 'verify' | 'commands' | 'detected'

/** One discovered project check. */
export interface ProjectCheck {
  name: StandardCheck
  command: string
  source: CheckSource
}

/** The project's checks and the settings its file declares. Unset settings are `undefined`. */
export interface ProjectChecks {
  checks: ProjectCheck[]
  mode: VerificationMode | undefined
  timeoutMs: number | undefined
  maxRepairRounds: number | undefined
}

/** Read access to the working directory; both methods take paths relative to it. */
export interface ProjectReader {
  /** @returns the file's text, or undefined when it is absent or not a regular file. */
  read(path: string): Promise<string | undefined>
  /** @returns whether the path exists. */
  exists(path: string): Promise<boolean>
}

/** `.casper/project.yaml` could not be used; no project checks run until it is fixed. */
export class ProjectFileError extends Error {
  override name = 'ProjectFileError'
}

const MAX_TIMEOUT_MS = 3_600_000
const MAX_REPAIR_ROUNDS = 10
/** The script `npm init` writes; it fails on purpose and tests nothing. */
const NPM_PLACEHOLDER_TEST = /no test specified/u

type Commands = Partial<Record<StandardCheck, string>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readCommands(value: unknown, key: string): Commands {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) throw new ProjectFileError(`${PROJECT_FILE}: \`${key}\` must be a mapping of check names to commands`)
  const commands: Commands = {}
  for (const [name, command] of Object.entries(value)) {
    if (!(STANDARD_CHECKS as readonly string[]).includes(name)) {
      throw new ProjectFileError(`${PROJECT_FILE}: \`${key}.${name}\` is not a known check; use ${STANDARD_CHECKS.join(', ')}`)
    }
    if (typeof command !== 'string' || command.trim().length === 0) {
      throw new ProjectFileError(`${PROJECT_FILE}: \`${key}.${name}\` must be a nonempty command`)
    }
    commands[name as StandardCheck] = command
  }
  return commands
}

function readInteger(value: unknown, key: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ProjectFileError(`${PROJECT_FILE}: \`${key}\` must be an integer from ${String(min)} to ${String(max)}`)
  }
  return value
}

interface ProjectFile {
  verify: Commands
  commands: Commands
  mode: VerificationMode | undefined
  selected: StandardCheck[] | undefined
  timeoutMs: number | undefined
  maxRepairRounds: number | undefined
}

/**
 * Parse `.casper/project.yaml`. Unknown top-level keys are ignored, since the file also holds
 * settings for the Casper CLI; a known key with a wrong value fails.
 * @param text - the file's text.
 * @returns the check settings it declares.
 * @throws ProjectFileError when the YAML or a known key is invalid.
 */
export function parseProjectFile(text: string): ProjectFile {
  let document: unknown
  try {
    document = parse(text)
  } catch (error) {
    throw new ProjectFileError(`${PROJECT_FILE}: ${(error as Error).message.split('\n')[0]}`)
  }
  if (document === null || document === undefined) document = {}
  if (!isRecord(document)) throw new ProjectFileError(`${PROJECT_FILE}: the file must be a mapping`)
  const verification = document['verification'] ?? {}
  const repair = document['repair'] ?? {}
  if (!isRecord(verification)) throw new ProjectFileError(`${PROJECT_FILE}: \`verification\` must be a mapping`)
  if (!isRecord(repair)) throw new ProjectFileError(`${PROJECT_FILE}: \`repair\` must be a mapping`)
  const mode = verification['mode']
  if (mode !== undefined && mode !== null && mode !== 'auto' && mode !== 'offer' && mode !== 'off') {
    throw new ProjectFileError(`${PROJECT_FILE}: \`verification.mode\` must be auto, offer or off`)
  }
  const selected = verification['checks']
  if (selected !== undefined && selected !== null
    && !(Array.isArray(selected) && selected.every(name => (STANDARD_CHECKS as readonly unknown[]).includes(name)))) {
    throw new ProjectFileError(`${PROJECT_FILE}: \`verification.checks\` must list checks from ${STANDARD_CHECKS.join(', ')}`)
  }
  return {
    verify: readCommands(document['verify'], 'verify'),
    commands: readCommands(document['commands'], 'commands'),
    mode: mode ?? undefined,
    selected: (selected ?? undefined) as StandardCheck[] | undefined,
    timeoutMs: readInteger(verification['timeoutMs'], 'verification.timeoutMs', 1, MAX_TIMEOUT_MS),
    maxRepairRounds: readInteger(repair['maxAttempts'], 'repair.maxAttempts', 0, MAX_REPAIR_ROUNDS),
  }
}

async function packageManager(reader: ProjectReader, manifest: Record<string, unknown>): Promise<string> {
  const declared = manifest['packageManager']
  if (typeof declared === 'string') {
    const tool = declared.split('@')[0]
    if (tool === 'pnpm' || tool === 'yarn' || tool === 'bun' || tool === 'npm') return tool
  }
  if (await reader.exists('pnpm-lock.yaml')) return 'pnpm'
  if (await reader.exists('yarn.lock')) return 'yarn'
  if (await reader.exists('bun.lock') || await reader.exists('bun.lockb')) return 'bun'
  return 'npm'
}

async function detectNode(reader: ProjectReader): Promise<Commands> {
  const text = await reader.read('package.json')
  if (text === undefined) return {}
  let manifest: unknown
  try {
    manifest = JSON.parse(text)
  } catch {
    // An unparsable package.json has no scripts Casper could name; the project's own tools report it.
    return {}
  }
  if (!isRecord(manifest) || !isRecord(manifest['scripts'])) return {}
  const scripts = manifest['scripts']
  const has = (name: string): boolean => {
    const script = scripts[name]
    return typeof script === 'string' && script.trim().length > 0
  }
  const pm = await packageManager(reader, manifest)
  const run = (script: string): string => `${pm} run ${script}`
  const found: Commands = {}
  const typecheck = ['typecheck', 'check-types', 'tsc'].find(has)
  if (typecheck !== undefined) found.typecheck = run(typecheck)
  if (has('lint')) found.lint = run('lint')
  if (has('test') && !NPM_PLACEHOLDER_TEST.test(scripts['test'] as string)) found.test = run('test')
  if (has('build')) found.build = run('build')
  return found
}

async function detectRust(reader: ProjectReader): Promise<Commands> {
  if (!await reader.exists('Cargo.toml')) return {}
  return { lint: 'cargo clippy', test: 'cargo test', build: 'cargo build' }
}

async function detectGo(reader: ProjectReader): Promise<Commands> {
  if (!await reader.exists('go.mod')) return {}
  return { test: 'go test ./...', build: 'go build ./...' }
}

async function pythonRunner(reader: ProjectReader, pyproject: string): Promise<(tool: string, args: string) => string> {
  const join = (head: string, args: string): string => args.length === 0 ? head : `${head} ${args}`
  if (await reader.exists('uv.lock')) return (tool, args) => join(`uv run ${tool}`, args)
  if (await reader.exists('poetry.lock') || pyproject.includes('[tool.poetry]')) return (tool, args) => join(`poetry run ${tool}`, args)
  for (const venv of ['.venv', 'venv']) {
    if (await reader.exists(`${venv}/bin/python`)) return (tool, args) => join(`${venv}/bin/python -m ${tool}`, args)
  }
  return (tool, args) => join(`python3 -m ${tool}`, args)
}

async function detectPython(reader: ProjectReader): Promise<Commands> {
  const pyproject = await reader.read('pyproject.toml') ?? ''
  const requirements = (await Promise.all(['requirements.txt', 'requirements-dev.txt', 'requirements_dev.txt'].map(name => reader.read(name))))
    .filter(text => text !== undefined)
  if (pyproject.length === 0 && requirements.length === 0) return {}
  const manifests = [pyproject, ...requirements].join('\n')
  const mentions = (tool: string): boolean => new RegExp(`(^|[^A-Za-z0-9_-])${tool}([^A-Za-z0-9_-]|$)`, 'mu').test(manifests)
  const run = await pythonRunner(reader, pyproject)
  const found: Commands = {}
  if (mentions('mypy')) found.typecheck = run('mypy', '.')
  if (mentions('ruff')) found.lint = run('ruff', 'check .')
  if (mentions('pytest')) found.test = run('pytest', '')
  return found
}

/**
 * Detect check commands from the repository's manifests. Earlier ecosystems win a check name.
 * @param reader - the working directory.
 * @returns the detected commands by check name.
 */
export async function detectCommands(reader: ProjectReader): Promise<Commands> {
  const found: Commands = {}
  for (const detect of [detectNode, detectRust, detectGo, detectPython]) {
    for (const [name, command] of Object.entries(await detect(reader))) found[name as StandardCheck] ??= command
  }
  return found
}

/**
 * Discover the project's checks.
 * @param reader - the working directory.
 * @returns the selected checks in run order and the project file's settings.
 * @throws ProjectFileError when `.casper/project.yaml` exists but is invalid.
 */
export async function discoverProjectChecks(reader: ProjectReader): Promise<ProjectChecks> {
  const text = await reader.read(PROJECT_FILE)
  const file = text === undefined ? undefined : parseProjectFile(text)
  const detected = await detectCommands(reader)
  const checks: ProjectCheck[] = []
  for (const name of STANDARD_CHECKS) {
    if (file?.selected !== undefined && !file.selected.includes(name)) continue
    const verify = file?.verify[name]
    const command = file?.commands[name]
    if (verify !== undefined) checks.push({ name, command: verify, source: 'verify' })
    else if (command !== undefined) checks.push({ name, command, source: 'commands' })
    else if (detected[name] !== undefined) checks.push({ name, command: detected[name], source: 'detected' })
  }
  return { checks, mode: file?.mode, timeoutMs: file?.timeoutMs, maxRepairRounds: file?.maxRepairRounds }
}
