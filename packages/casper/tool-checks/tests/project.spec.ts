import { describe, expect, it } from 'vitest'

import { detectCommands, discoverProjectChecks, parseProjectFile, ProjectFileError } from '../src/project.ts'
import type { ProjectReader } from '../src/project.ts'

/** A working directory held in memory: file paths map to text; a `null` entry exists but is not a file. */
function folder(files: Record<string, string | null>): ProjectReader {
  return {
    read: path => Promise.resolve(typeof files[path] === 'string' ? files[path] : undefined),
    exists: path => Promise.resolve(path in files),
  }
}

const scripts = (entries: Record<string, string>, extra: Record<string, unknown> = {}) => JSON.stringify({ scripts: entries, ...extra })

describe('project checks: .casper/project.yaml', () => {
  it('prefers verify over commands over detected commands, in the standard order', async () => {
    const found = await discoverProjectChecks(folder({
      '.casper/project.yaml': 'verify:\n  test: make test\ncommands:\n  test: ignored\n  lint: make lint\n',
      'package.json': scripts({ build: 'tsc -b', test: 'vitest' }),
    }))
    expect(found.checks).toEqual([
      { name: 'lint', command: 'make lint', source: 'commands' },
      { name: 'test', command: 'make test', source: 'verify' },
      { name: 'build', command: 'npm run build', source: 'detected' },
    ])
  })

  it('runs only the checks verification.checks selects and reads its settings', async () => {
    const found = await discoverProjectChecks(folder({
      '.casper/project.yaml': 'verification:\n  mode: offer\n  checks: [test]\n  timeoutMs: 5000\nrepair:\n  maxAttempts: 1\nunrelated: kept for the CLI\n',
      'package.json': scripts({ lint: 'eslint .', test: 'vitest' }),
    }))
    expect(found).toEqual({ checks: [{ name: 'test', command: 'npm run test', source: 'detected' }], mode: 'offer', timeoutMs: 5000, maxRepairRounds: 1 })
  })

  it('treats an empty project file as no settings', async () => {
    expect(await discoverProjectChecks(folder({ '.casper/project.yaml': '' }))).toEqual({ checks: [], mode: undefined, timeoutMs: undefined, maxRepairRounds: undefined })
    expect(parseProjectFile('verify: ~\nverification: {mode: ~, checks: ~, timeoutMs: ~}').mode).toBeUndefined()
  })

  it.each([
    ['verify: [', 'project.yaml'],
    ['- a list', 'must be a mapping'],
    ['verify: npm test', '`verify` must be a mapping'],
    ['verify:\n  e2e: npx playwright test', '`verify.e2e` is not a known check'],
    ['commands:\n  test: "  "', '`commands.test` must be a nonempty command'],
    ['verification: auto', '`verification` must be a mapping'],
    ['repair: 3', '`repair` must be a mapping'],
    ['verification:\n  mode: always', '`verification.mode` must be auto, offer or off'],
    ['verification:\n  checks: [test, e2e]', '`verification.checks` must list checks'],
    ['verification:\n  checks: test', '`verification.checks` must list checks'],
    ['verification:\n  timeoutMs: 0', '`verification.timeoutMs` must be an integer from 1 to 3600000'],
    ['repair:\n  maxAttempts: 11', '`repair.maxAttempts` must be an integer from 0 to 10'],
    ['repair:\n  maxAttempts: two', '`repair.maxAttempts` must be an integer'],
  ])('rejects %j', (text, message) => {
    expect(() => parseProjectFile(text)).toThrow(ProjectFileError)
    expect(() => parseProjectFile(text)).toThrow(message)
  })
})

describe('project checks: detection', () => {
  it('runs package.json scripts with the declared package manager', async () => {
    expect(await detectCommands(folder({ 'package.json': scripts({ 'typecheck': 'tsc', 'lint': 'eslint .', 'test': 'vitest', 'build': 'vite build' }, { packageManager: 'pnpm@11.0.0' }) })))
      .toEqual({ typecheck: 'pnpm run typecheck', lint: 'pnpm run lint', test: 'pnpm run test', build: 'pnpm run build' })
  })

  it.each([
    [{ 'pnpm-lock.yaml': '' }, 'pnpm'],
    [{ 'yarn.lock': '' }, 'yarn'],
    [{ 'bun.lock': '' }, 'bun'],
    [{ 'bun.lockb': '' }, 'bun'],
    [{}, 'npm'],
  ])('picks the package manager from the lockfile %j', async (lockfiles, pm) => {
    expect(await detectCommands(folder({ 'package.json': scripts({ test: 'x' }, { packageManager: 'deno@2' }), ...lockfiles })))
      .toEqual({ test: `${pm} run test` })
  })

  it('names the typecheck script by its usual aliases and skips the npm placeholder test', async () => {
    expect(await detectCommands(folder({ 'package.json': scripts({ 'check-types': 'tsc', 'test': 'echo "Error: no test specified" && exit 1', 'lint': ' ' }) })))
      .toEqual({ typecheck: 'npm run check-types' })
    expect(await detectCommands(folder({ 'package.json': scripts({ tsc: 'tsc -p .' }) }))).toEqual({ typecheck: 'npm run tsc' })
  })

  it('finds nothing in an unreadable or script-less package.json', async () => {
    expect(await detectCommands(folder({ 'package.json': '{ not json' }))).toEqual({})
    expect(await detectCommands(folder({ 'package.json': '{"name":"x"}' }))).toEqual({})
    expect(await detectCommands(folder({ 'package.json': '[]' }))).toEqual({})
    expect(await detectCommands(folder({ 'package.json': null }))).toEqual({})
  })

  it('detects Rust and Go projects', async () => {
    expect(await detectCommands(folder({ 'Cargo.toml': '' }))).toEqual({ lint: 'cargo clippy', test: 'cargo test', build: 'cargo build' })
    expect(await detectCommands(folder({ 'go.mod': '' }))).toEqual({ test: 'go test ./...', build: 'go build ./...' })
  })

  it('lets an earlier ecosystem keep a check name', async () => {
    expect(await detectCommands(folder({ 'package.json': scripts({ test: 'vitest' }), 'Cargo.toml': '' })))
      .toEqual({ test: 'npm run test', lint: 'cargo clippy', build: 'cargo build' })
  })

  it.each([
    [{ 'uv.lock': '' }, 'uv run pytest', 'uv run ruff check .', 'uv run mypy .'],
    [{ 'poetry.lock': '' }, 'poetry run pytest', 'poetry run ruff check .', 'poetry run mypy .'],
    [{ '.venv/bin/python': '' }, '.venv/bin/python -m pytest', '.venv/bin/python -m ruff check .', '.venv/bin/python -m mypy .'],
    [{ 'venv/bin/python': '' }, 'venv/bin/python -m pytest', 'venv/bin/python -m ruff check .', 'venv/bin/python -m mypy .'],
    [{}, 'python3 -m pytest', 'python3 -m ruff check .', 'python3 -m mypy .'],
  ])('runs Python tools through the project environment %j', async (environment, test, lint, typecheck) => {
    expect(await detectCommands(folder({ 'pyproject.toml': '[dependency-groups]\ndev = ["pytest>=8", "ruff", "mypy"]\n', ...environment })))
      .toEqual({ typecheck, lint, test })
  })

  it('reads Python tools from a requirements file and a poetry table', async () => {
    expect(await detectCommands(folder({ 'requirements-dev.txt': 'pytest==8.0\n' }))).toEqual({ test: 'python3 -m pytest' })
    expect(await detectCommands(folder({ 'pyproject.toml': '[tool.poetry]\n[tool.poetry.group.dev.dependencies]\npytest = "^8"\n' })))
      .toEqual({ test: 'poetry run pytest' })
    expect(await detectCommands(folder({ 'requirements.txt': 'pytest-cov\n' }))).toEqual({})
  })
})
