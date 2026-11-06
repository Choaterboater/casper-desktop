/** Shared fixtures for the Casper agent tests: the stand-in process, its script, and its log. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Config } from '../src/config.ts'

/** Absolute path of the stand-in `casper acp`. */
export const FAKE_CASPER = fileURLToPath(new URL('./fake-casper-acp.ts', import.meta.url))

/** One logged line of the stand-in. */
export interface FakeLogEntry {
  readonly pid: number
  readonly event?: string
  readonly method?: string
  readonly params?: Record<string, unknown> & { sessionId?: string; cwd?: string; prompt?: unknown[] }
  readonly argv?: string[]
  readonly envNames?: string[]
  readonly path?: string
  readonly cwd?: string
  readonly outcome?: { outcome: string; optionId?: string }
  readonly error?: string
  readonly profile?: { name?: string; dir?: string }
  readonly exposed?: { argv: boolean; env: boolean }
  readonly name?: string
  readonly result?: { content?: { type: string; text?: string }[]; isError?: boolean }
  /** The serverInfo the app's MCP server answered with. */
  readonly server?: { name?: string; version?: string }
}

/** One step of the stand-in's prompt script; see `fake-casper-acp.ts`. */
export type FakeStep = Record<string, unknown>

/** Stand-in behavior; see `fake-casper-acp.ts`. */
export interface FakeScript {
  readonly prompts: FakeStep[][]
  readonly known?: string[]
  readonly loadError?: string
  readonly holdInitialize?: string
  readonly ignoreEof?: boolean
  readonly replay?: string[]
  readonly newSessionId?: string
  readonly promptCapabilities?: { readonly image?: boolean; readonly audio?: boolean; readonly embeddedContext?: boolean }
  /** Casper's command list, sent after `session/new` and during `session/load`. */
  readonly commands?: readonly FakeCommand[]
}

/** One command the stand-in offers, in ACP's `available_commands_update` shape. */
export interface FakeCommand {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string } | null
}

/** A temporary folder holding the Session folder, the script, and the log. */
export interface FakeCasper {
  /** The Session folder. */
  readonly cwd: string
  /** Scratch folder for gate files and storage. */
  readonly root: string
  /** Replace the script the next process start reads. */
  script(next: FakeScript): void
  /** Parsed log lines so far. */
  log(): FakeLogEntry[]
  /** Log lines with one method. */
  calls(method: string): FakeLogEntry[]
  /** Distinct process ids that started. */
  pids(): number[]
  /** Plugin config launching the stand-in. */
  config(overrides?: Partial<Config>): Config
  /** Remove the folder. */
  remove(): void
}

/**
 * Create a stand-in folder.
 * @param script - the initial script.
 * @returns the fixture.
 */
export function fakeCasper(script: FakeScript = { prompts: [] }): FakeCasper {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-casper-agent-')))
  const cwd = join(root, 'project')
  const scriptFile = join(root, 'script.json')
  const logFile = join(root, 'log.jsonl')
  writeFileSync(logFile, '')
  mkdirSync(cwd)
  const write = (next: FakeScript): void => { writeFileSync(scriptFile, JSON.stringify(next)) }
  write(script)
  const log = (): FakeLogEntry[] => readFileSync(logFile, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as FakeLogEntry)
  return {
    cwd,
    root,
    script: write,
    log,
    calls: method => log().filter(entry => entry.method === method),
    pids: () => [...new Set(log().filter(entry => entry.event === 'start').map(entry => entry.pid))],
    config: overrides => ({
      presets: ['casper'],
      command: process.execPath,
      args: [FAKE_CASPER, 'acp'],
      env: { FAKE_CASPER_SCRIPT: scriptFile, FAKE_CASPER_LOG: logFile },
      startTimeoutMs: 20_000,
      cancelGraceMs: 2_000,
      exitGraceMs: 2_000,
      killGraceMs: 2_000,
      stderrTailBytes: 4_096,
      appTools: false,
      ...overrides,
    }),
    remove: () => { rmSync(root, { recursive: true, force: true }) },
  }
}

/**
 * Poll until `check` returns a value other than undefined or false.
 * @param check - the condition.
 * @param timeoutMs - the limit.
 * @returns the condition's value.
 */
export async function waitFor<T>(check: () => T | undefined | false, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value !== undefined && value !== false) return value
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
}

/**
 * Parse JSON text for a test to compare; the value is left untyped.
 * @param text - the JSON text, such as a recorded call's arguments.
 */
export function parsed(text: string): unknown {
  return JSON.parse(text)
}

/**
 * Whether a process is still running.
 * @param pid - the process id.
 * @returns true while signal 0 reaches it.
 */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Create an empty gate file path; the stand-in waits while it does not exist.
 * @param fake - the fixture.
 * @param name - file name.
 * @returns the path, not yet created.
 */
export function gate(fake: FakeCasper, name: string): { path: string; open(): void; exists(): boolean } {
  const path = join(fake.root, name)
  return { path, open: () => { writeFileSync(path, 'go') }, exists: () => existsSync(path) }
}
