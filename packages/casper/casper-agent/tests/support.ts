/** Shared fixtures for the Casper agent tests: the stand-in process, its script, and its log. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionConfigOption, SessionModeState } from '@agentclientprotocol/sdk'
import { DEFAULT_ACCESS_MODES } from '../src/access.ts'
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
  /** Whether Casper had closed the box before this reply came. */
  readonly withdrawn?: boolean
  readonly error?: string
  readonly profile?: { name?: string; dir?: string }
  readonly exposed?: { argv: boolean; env: boolean }
  readonly name?: string
  readonly result?: { content?: { type: string; text?: string }[]; isError?: boolean }
  /** The serverInfo the app's MCP server answered with. */
  readonly server?: { name?: string; version?: string }
  /** The app's reply to a form. */
  readonly reply?: { action: string; content?: Record<string, unknown> }
  /** Whether Casper stopped waiting for a form. */
  readonly timedOut?: boolean
  /** Casper's reply to a steer. */
  readonly steered?: boolean
  /** Casper's reply to an idle check. */
  readonly idle?: { idle: boolean; running: string[]; reason?: string }
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
  /** Casper's options in the `session/new` and `session/load` replies; a set changes them. */
  readonly configOptions?: readonly SessionConfigOption[]
  /** A set of one of these option ids fails with -32603 and the message. */
  readonly setFails?: Readonly<Record<string, string>>
  /** Also send the options as a `config_option_update` during a `session/load` replay. */
  readonly replayConfig?: boolean
  /** Exit with this code on any set. */
  readonly setExit?: number
  /** A set of one of these option ids is logged, then answered only once the named file exists. */
  readonly holdSet?: Readonly<Record<string, string>>
  /** Casper's mode state in the `session/new` and `session/load` replies; `session/set_mode` changes it. */
  readonly modes?: SessionModeState
  /** `session/set_mode` fails with -32603 and this message. */
  readonly setModeError?: string
  /** Change the mode and send a `current_mode_update` during a `session/load` replay. */
  readonly replayMode?: string
  /** Say in `initialize` that `_casper/steer` takes steering. */
  readonly steer?: boolean
  /** The reply to each steer in order; a missing one is true. */
  readonly steerReplies?: readonly boolean[]
  /** Wait this long before replying to a steer. */
  readonly steerReplyDelayMs?: number
  /** Say in `initialize` that Casper takes HTTP MCP servers, so the app hands it its own. */
  readonly mcpHttp?: boolean
  /** The reply to each idle check of a process in order, the last repeating; null answers -32601 as an older Casper. */
  readonly idle?: readonly { readonly idle: boolean; readonly running: readonly string[]; readonly reason?: 'off' | 'busy' }[] | null
  /** Each idle reply waits until this file exists. */
  readonly holdIdle?: string
  /** The options of a successful `session/load` reply and from then on, as when Casper puts back the conversation's model. */
  readonly loadConfigOptions?: readonly SessionConfigOption[]
  /** Casper's stored name, sent as a `session_info_update` right after a successful `session/load` reply. */
  readonly title?: string
  /** Say in `initialize` that Casper takes `session/fork`. */
  readonly fork?: boolean
  /** `session/fork` fails with this error. */
  readonly forkError?: { readonly code: number; readonly message: string }
  /** The id of a copy `session/fork` makes. */
  readonly forkSessionId?: string
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
      // The stand-in runs as the installed Casper; tests of the bundled engine set engine and turn this off.
      useInstalledCasper: true,
      command: process.execPath,
      args: [FAKE_CASPER, 'acp'],
      env: { FAKE_CASPER_SCRIPT: scriptFile, FAKE_CASPER_LOG: logFile },
      toolPath: [],
      startTimeoutMs: 20_000,
      cancelGraceMs: 2_000,
      exitGraceMs: 2_000,
      killGraceMs: 2_000,
      stderrTailBytes: 4_096,
      appTools: false,
      appSubagents: true,
      appGoals: true,
      appTeams: true,
      appToolImages: true,
      casperChildModel: true,
      casperTitles: true,
      copyOnFork: true,
      accessModes: { ...DEFAULT_ACCESS_MODES },
      approvalCard: true,
      approvalDiff: true,
      forwardMcpServers: true,
      forwardPluginMcpServers: true,
      forwardMcpClientRows: true,
      modePill: true,
      liveOutput: true,
      // Tests that close an idle Casper set their own idle time.
      idleExitMs: 0,
      // Tests of the warm start turn it on; the others count processes from the first prompt.
      prewarm: false,
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

/**
 * Casper's model, effort, and access options in the shape `casper acp` sends them.
 * @param model - the current model value.
 * @param effort - the current effort value.
 * @returns the option list.
 */
export function casperOptions(model = 'openai-codex/gpt-6.1-sol', effort = 'auto'): SessionConfigOption[] {
  return [
    {
      id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model,
      options: [
        { group: 'openai-codex', name: 'openai-codex', options: [
          { value: 'openai-codex/gpt-6.1-sol', name: 'GPT-6.1 Sol', _meta: { casper: { efforts: ['auto', 'low', 'medium', 'high'] } } },
        ] },
        { group: 'claude-subscription', name: 'Claude Code plan', options: [
          { value: 'claude-subscription/claude-opus-5-5', name: 'Claude Opus 5.5', _meta: { casper: { efforts: ['auto', 'low', 'high'] } } },
          { value: 'claude-subscription/vendor/small:free', name: 'Small', description: 'Sign in again to use this model', _meta: { casper: { efforts: [] } } },
        ] },
      ],
    },
    {
      id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: effort,
      options: [
        { value: 'auto', name: 'Auto', description: 'classify each request' },
        { value: 'low', name: 'Low', description: 'light reasoning' },
        { value: 'medium', name: 'Medium', description: 'ordinary changes' },
        { value: 'high', name: 'High', description: 'harder changes' },
      ],
    },
    {
      id: 'mode', name: 'Access', category: 'mode', type: 'select', currentValue: 'ask',
      options: [{ value: 'read', name: 'Read only' }, { value: 'ask', name: 'Ask first' }, { value: 'full', name: 'Don\'t ask' }],
    },
  ]
}

/**
 * Casper's Plan first option in the shape `casper acp` sends it: no category,
 * just before the access option, which stays last.
 * @param current - `on` or `off`.
 * @param options - the list to put it in.
 * @returns the list with the option before `mode`.
 */
export function withPlan(current: 'on' | 'off' = 'off', options: SessionConfigOption[] = casperOptions()): SessionConfigOption[] {
  const plan: SessionConfigOption = {
    id: 'plan', name: 'Plan first', type: 'select', currentValue: current,
    options: [
      { value: 'off', name: 'Off' },
      { value: 'on', name: 'Plan first', description: 'every request gets a plan first; nothing is built until you choose Build' },
    ],
  }
  const at = options.findIndex(option => option.category === 'mode')
  return at === -1 ? [...options, plan] : [...options.slice(0, at), plan, ...options.slice(at)]
}

/**
 * Casper's mode state in the shape `casper acp` sends it next to its options.
 * @param current - the current mode.
 * @returns the mode state.
 */
export function casperModes(current = 'ask'): SessionModeState {
  return {
    currentModeId: current,
    availableModes: [{ id: 'read', name: 'Read only' }, { id: 'ask', name: 'Ask first' }, { id: 'full', name: 'Don\'t ask' }],
  }
}

/** Casper's model and effort options without its access option, as a Casper that offers only `modes` sends them. */
export function optionsWithoutMode(): SessionConfigOption[] {
  return casperOptions().filter(option => option.category !== 'mode')
}
