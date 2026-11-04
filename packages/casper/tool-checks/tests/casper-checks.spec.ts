import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ShellExecRequest, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { join } from 'node:path'

import * as checks from '../src/index.ts'

type Outcome = Partial<ShellRunResult> | 'throw' | (() => Promise<Partial<ShellRunResult>>)

/** A shell whose commands answer from a mutable script, so a test can change the "code" between runs. */
function scriptedShell(script: Map<string, Outcome>, sandbox: { mode: string } | undefined) {
  const ran: string[] = []
  const requests: ShellExecRequest[] = []
  return {
    ran,
    requests,
    service: {
      sandboxMode: sandbox?.mode,
      resolve: (request: ShellExecRequest) => {
        requests.push(request)
        return { ...request, workdir: request.workdir ?? '/w', timeoutMs: request.timeoutMs ?? 1000, onExpiry: 'kill', stdoutMaxBytes: 1 << 20, sandboxPolicy: sandbox === undefined ? undefined : { ...sandbox, workspaceRoot: '/w' } }
      },
      execute: (spec: { command: string }) => {
        ran.push(spec.command)
        const outcome = script.get(spec.command) ?? { exitCode: 0 }
        if (outcome === 'throw') return Promise.reject(new Error('spawn ENOENT'))
        const finish = (partial: Partial<ShellRunResult>): ShellRunResult => ({
          exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000,
          stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false }, ...partial,
        })
        const settled = typeof outcome === 'function' ? outcome().then(finish) : Promise.resolve(finish(outcome))
        return Promise.resolve({ result: () => settled })
      },
    },
  }
}

type FakeAgent = Agent & { steer: ReturnType<typeof vi.fn>; inject: ReturnType<typeof vi.fn> }

function fakeAgent(id = 'agent-1', cwd = '/w', header: { origin?: 'subagent'; delegationDepth?: number } = {}): FakeAgent {
  return { id, session: { header: { cwd, ...header } } as Agent['session'], steer: vi.fn(), inject: vi.fn() } as FakeAgent
}

interface Setup {
  /** Files of the working directory by absolute path; a `null` entry is a directory. */
  files?: Record<string, string | null>
  /** The sandbox the shell resolves; `null` for none. */
  sandbox?: { mode: string } | null
  /** Make `workingDirectory.ensure` fail. */
  ensureFails?: boolean
}

async function setup(script = new Map<string, Outcome>(), config: Partial<checks.Config> = {}, options: Setup = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const shell = scriptedShell(script, options.sandbox === null ? undefined : options.sandbox ?? { mode: 'workspace-write' })
  const files = options.files ?? {}
  ctx.provide('shell', shell.service)
  ctx.provide('workingDirectory', {
    get: (session: { header: { cwd: string } }) => {
      if (session.header.cwd === '') throw new Error('no working directory')
      return session.header.cwd
    },
    ensure: (agent: { session: { header: { cwd: string } } }) => options.ensureFails === true
      ? Promise.reject(new Error('cwd gone'))
      : Promise.resolve(agent.session.header.cwd),
  })
  ctx.provide('fs', {
    resolve: (path: string, opts: { cwd: string }) => Promise.resolve({ targetKey: join(opts.cwd, path) }),
    stat: (target: { targetKey: string }) => Promise.resolve(target.targetKey in files ? { type: files[target.targetKey] === null ? 'directory' : 'file' } : undefined),
    readText: (target: { targetKey: string }) => Promise.resolve(files[target.targetKey]),
  })
  // A stand-in mutation tool with the real name `edit`, so its result travels the real pipeline.
  ctx.tools.register(defineTool({
    name: 'edit',
    description: 'test edit',
    parameters: {},
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'edited' }] },
    execute: () => Promise.resolve('edited'),
  }))
  ctx.tools.register(defineTool({
    name: 'bash',
    description: 'test shell',
    parameters: { command: { type: 'string' } },
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'ran' }] },
    execute: () => Promise.resolve('ran'),
  }))
  await ctx.plugin(checks, {
    mutatingTools: config.mutatingTools ?? ['edit', 'bash'],
    replayOnStop: config.replayOnStop ?? true,
    maxRepairRounds: config.maxRepairRounds ?? 2,
    outputChars: 2000,
    maxChecks: config.maxChecks ?? 32,
    projectChecks: config.projectChecks ?? true,
    projectTimeoutMs: 600_000,
    runUnconfined: config.runUnconfined ?? false,
    receipt: config.receipt ?? true,
  })
  return { ctx, shell, script }
}

let calls = 0
function call(ctx: Context, name: string, args: unknown, agent: Agent | undefined, signal = new AbortController().signal) {
  return executeToolFixture(ctx, {
    signal,
    callId: ToolCallId(`call-${++calls}`),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
}

function stopTurn(ctx: Context, agent: Agent, turn = 1, signal = new AbortController().signal) {
  return ctx.serial(agent as never, 'agent/turn-stopping', { agent, turn, signal })
}

const steerText = (agent: FakeAgent, index = -1): string => JSON.stringify(agent.steer.mock.calls.at(index))

describe('casper-checks', () => {
  it('runs a recorded check immediately and reports its baseline verdict', async () => {
    const { ctx, shell } = await setup(new Map([['npm test', { exitCode: 0 }]]))
    const result = await call(ctx, 'check_record', { name: 'test', command: 'npm test' }, fakeAgent())
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ name: 'test', status: 'passed', exitCode: 0, stale: false })
    expect(shell.ran).toEqual(['npm test'])
  })

  it('reports a nonzero exit as failed with its exit code', async () => {
    const { ctx } = await setup(new Map([['npm test', { exitCode: 1, stdout: { text: 'expected 3 got -1', truncated: false } }]]))
    const result = await call(ctx, 'check_record', { name: 'test', command: 'npm test' }, fakeAgent())
    expect(result.value).toMatchObject({ status: 'failed', exitCode: 1, output: 'expected 3 got -1' })
  })

  it('never reports a timed-out, signalled, unstartable or exit-less check as passed', async () => {
    const { ctx } = await setup(new Map<string, Outcome>([
      ['slow', { exitCode: null, timedOut: true }],
      ['killed', { exitCode: null, signal: 'SIGKILL' }],
      ['missing', 'throw'],
      ['expired', { exitCode: null, signal: null }],
    ]))
    const agent = fakeAgent()
    for (const command of ['slow', 'killed', 'missing', 'expired']) await call(ctx, 'check_record', { name: command, command }, agent)
    const listed = await call(ctx, 'check_list', {}, agent)
    expect(listed.value).toEqual([
      expect.objectContaining({ name: 'slow', status: 'not_run', reason: 'timed_out' }),
      expect.objectContaining({ name: 'killed', status: 'not_run', reason: 'signal' }),
      expect.objectContaining({ name: 'missing', status: 'not_run', reason: 'could_not_start' }),
      expect.objectContaining({ name: 'expired', status: 'not_run', reason: 'could_not_start' }),
    ])
    expect(JSON.stringify(listed)).toContain('– not run (timed_out) · slow: slow')
    expect(JSON.stringify(listed)).not.toContain('passed')
  })

  it('marks recorded checks stale after a mutation tool and replay refreshes the verdict', async () => {
    const { ctx, script } = await setup(new Map([['npm test', { exitCode: 0 }]]))
    const agent = fakeAgent()
    await call(ctx, 'check_record', { name: 'test', command: 'npm test' }, agent)
    await call(ctx, 'edit', {}, agent)
    expect((await call(ctx, 'check_list', {}, agent)).value).toEqual([expect.objectContaining({ status: 'passed', stale: true })])
    script.set('npm test', { exitCode: 2 })
    expect((await call(ctx, 'check_replay', {}, agent)).value).toEqual([expect.objectContaining({ status: 'failed', exitCode: 2, stale: false })])
  })

  it('marks a check stale when another agent edits the same or an enclosing directory', async () => {
    const { ctx } = await setup()
    const owner = fakeAgent('a', '/repo/app')
    await call(ctx, 'check_record', { name: 'test', command: 'npm test' }, owner)
    await call(ctx, 'edit', {}, fakeAgent('sub', '/repo'))
    expect((await call(ctx, 'check_list', {}, owner)).value).toEqual([expect.objectContaining({ stale: true })])
  })

  it('leaves a check fresh when the edit happened in an unrelated directory', async () => {
    const { ctx } = await setup()
    const owner = fakeAgent('a', '/repo/app')
    await call(ctx, 'check_record', { name: 'test', command: 'npm test' }, owner)
    await call(ctx, 'edit', {}, fakeAgent('b', '/repo/application'))
    expect((await call(ctx, 'check_list', {}, owner)).value).toEqual([expect.objectContaining({ stale: false })])
    expect((await call(ctx, 'check_list', {}, fakeAgent('b', '/repo/application'))).value).toEqual([])
  })

  it('keeps a pass stale when an edit lands while the check is running', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { ctx, script } = await setup(new Map<string, Outcome>([['npm test', { exitCode: 0 }]]))
    const agent = fakeAgent()
    await call(ctx, 'check_record', { name: 'test', command: 'npm test' }, agent)
    script.set('npm test', () => gate.then(() => ({ exitCode: 0 })))
    const replaying = call(ctx, 'check_replay', {}, agent)
    await call(ctx, 'edit', {}, agent)
    release()
    expect((await replaying).value).toEqual([expect.objectContaining({ status: 'passed', stale: true })])
  })

  it('throws on a cancelled call and keeps the earlier verdict', async () => {
    const { ctx } = await setup(new Map([['npm test', { exitCode: 0 }]]))
    const agent = fakeAgent()
    await call(ctx, 'check_record', { name: 'test', command: 'npm test' }, agent)
    const controller = new AbortController()
    controller.abort()
    expect((await call(ctx, 'check_replay', {}, agent, controller.signal)).isError).toBe(true)
    expect((await call(ctx, 'check_list', {}, agent)).value).toEqual([expect.objectContaining({ status: 'passed', reason: null })])
  })

  it('keeps a check stale when its replay after an edit could not run', async () => {
    const { ctx, script } = await setup(new Map<string, Outcome>([['npm test', { exitCode: 0 }]]))
    const agent = fakeAgent()
    await call(ctx, 'check_record', { name: 'test', command: 'npm test' }, agent)
    await call(ctx, 'edit', {}, agent)
    script.set('npm test', { exitCode: null, timedOut: true })
    expect((await call(ctx, 'check_replay', {}, agent)).value).toEqual([expect.objectContaining({ status: 'not_run', reason: 'timed_out', stale: true })])
  })

  it('marks dropped output and keeps a tail of each stream', () => {
    const run = checks.classifyRun({
      exitCode: 1, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
      stdout: { text: 'x'.repeat(500) + 'STDOUT-END', truncated: false },
      stderr: { text: 'ERR', truncated: true },
    }, 200)
    expect(run.output).toContain('STDOUT-END')
    expect(run.output).toContain('ERR')
    expect(run.output.match(/earlier output truncated/gu)).toHaveLength(2)
  })

  it('replays stale checks when the turn stops and steers a repair on failure', async () => {
    const { ctx, script, shell } = await setup(new Map([['npm test', { exitCode: 0 }]]))
    const agent = fakeAgent()
    await call(ctx, 'check_record', { name: 'test', command: 'npm test' }, agent)
    await call(ctx, 'edit', {}, agent)
    script.set('npm test', { exitCode: 1 })
    await stopTurn(ctx, agent)
    expect(shell.ran).toEqual(['npm test', 'npm test'])
    expect(agent.steer).toHaveBeenCalledTimes(1)
    expect(steerText(agent)).toContain('repair round 1 of 2')
  })

  it('does not replay or steer when no edit happened since the last run', async () => {
    const { ctx, shell } = await setup(new Map([['npm test', { exitCode: 1 }]]))
    const agent = fakeAgent()
    await call(ctx, 'check_record', { name: 'test', command: 'npm test' }, agent)
    await stopTurn(ctx, agent)
    expect(shell.ran).toEqual(['npm test'])
    expect(agent.steer).not.toHaveBeenCalled()
  })

  it('steers once in the same turn to correct the report when a stale check could not run', async () => {
    const { ctx, script, shell } = await setup(new Map<string, Outcome>([['npm test', { exitCode: 0 }]]))
    const agent = fakeAgent()
    await call(ctx, 'check_record', { name: 'test', command: 'npm test' }, agent)
    await call(ctx, 'edit', {}, agent)
    script.set('npm test', { exitCode: null, timedOut: true })
    await stopTurn(ctx, agent)
    await stopTurn(ctx, agent)
    expect(agent.steer).toHaveBeenCalledTimes(1)
    expect(steerText(agent)).toContain('test could not check: timed out')
    expect(steerText(agent)).not.toContain('repair round')
    expect(shell.ran).toHaveLength(2)
  })

  it('stops steering repairs after the configured rounds and steers the agent to report failure', async () => {
    const { ctx } = await setup(new Map([['npm test', { exitCode: 1 }]]))
    const agent = fakeAgent()
    await call(ctx, 'check_record', { name: 'test', command: 'npm test' }, agent)
    for (let round = 0; round < 4; round++) {
      await call(ctx, 'edit', {}, agent)
      await stopTurn(ctx, agent)
    }
    expect(agent.steer).toHaveBeenCalledTimes(3)
    expect(steerText(agent, 1)).toContain('repair round 2 of 2')
    expect(steerText(agent, 2)).toContain('still fail after 2 repair rounds')
    expect(agent.inject).not.toHaveBeenCalled()
  })

  it('gives each new turn a fresh repair budget', async () => {
    const { ctx } = await setup(new Map([['npm test', { exitCode: 1 }]]))
    const agent = fakeAgent()
    await call(ctx, 'check_record', { name: 'test', command: 'npm test' }, agent)
    for (let round = 0; round < 2; round++) {
      await call(ctx, 'edit', {}, agent)
      await stopTurn(ctx, agent, 1)
    }
    await call(ctx, 'edit', {}, agent)
    await stopTurn(ctx, agent, 2)
    expect(steerText(agent)).toContain('repair round 1 of 2')
  })

  it('does not replay at the stop when replayOnStop is off', async () => {
    const { ctx, shell } = await setup(new Map([['npm test', { exitCode: 1 }]]), { replayOnStop: false })
    const agent = fakeAgent()
    await call(ctx, 'check_record', { name: 'test', command: 'npm test' }, agent)
    await call(ctx, 'edit', {}, agent)
    await stopTurn(ctx, agent)
    expect(shell.ran).toHaveLength(1)
    expect(agent.steer).not.toHaveBeenCalled()
  })

  it('forgets a disposed agent\'s checks', async () => {
    const { ctx } = await setup()
    const agent = fakeAgent()
    await call(ctx, 'check_record', { name: 'test', command: 'npm test' }, agent)
    ctx.emit(agent as never, 'agent/disposed', { agent })
    expect((await call(ctx, 'check_list', {}, agent)).value).toEqual([])
  })

  it('caps how many checks one agent may record', async () => {
    const { ctx } = await setup(new Map(), { maxChecks: 1 })
    const agent = fakeAgent()
    await call(ctx, 'check_record', { name: 'a', command: 'x' }, agent)
    expect((await call(ctx, 'check_record', { name: 'b', command: 'x' }, agent)).isError).toBe(true)
    expect((await call(ctx, 'check_record', { name: 'a', command: 'y' }, agent)).isError).toBe(false)
  })

  it('rejects calls without an owning agent and unknown check names', async () => {
    const { ctx } = await setup()
    expect((await call(ctx, 'check_record', { name: 'test', command: 'x' }, undefined)).isError).toBe(true)
    expect((await call(ctx, 'check_replay', { name: 'nope' }, fakeAgent())).isError).toBe(true)
    expect((await call(ctx, 'check_record', { name: 'bad name!', command: 'x' }, fakeAgent())).isError).toBe(true)
  })

  it('tells the model to claim a pass only for a fresh passing run', async () => {
    const { ctx } = await setup()
    const section = (await ctx.systemPrompt.assemble()).sections.find(s => s.name === 'tool:casper-checks')
    expect(JSON.stringify(section)).toContain('Report a check as passed only when its latest non-stale run passed')
  })

  it('labels a stale pass as stale instead of a current pass', () => {
    expect(checks.describeCheck({ name: 'test', command: 'npm test', stale: true, status: 'passed', exitCode: 0, reason: null }))
      .toBe('✓ passed · stale: code changed since this verdict · test: npm test')
  })
})

describe('casper-checks: project checks', () => {
  const node = { '/w/package.json': JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest' } }) }
  const editFile = (ctx: Context, agent: Agent, path = 'src/a.ts') => call(ctx, 'edit', { file_path: path }, agent)

  it('runs the detected checks after an edit and steers a one-line receipt once', async () => {
    const { ctx, shell } = await setup(new Map(), {}, { files: node })
    const agent = fakeAgent()
    await editFile(ctx, agent)
    await stopTurn(ctx, agent)
    expect(shell.ran).toEqual(['npm run lint', 'npm run test'])
    expect(agent.steer).toHaveBeenCalledTimes(1)
    expect(steerText(agent)).toContain('End your reply to the user with this receipt')
    expect(steerText(agent)).toContain('✓ Checks passed · lint passed · test passed · 1 file changed')
    await stopTurn(ctx, agent)
    expect(agent.steer).toHaveBeenCalledTimes(1)
    expect(shell.ran).toHaveLength(2)
  })

  it('does nothing at the stop of a turn that changed nothing', async () => {
    const { ctx, shell } = await setup(new Map(), {}, { files: node })
    const agent = fakeAgent()
    await call(ctx, 'check_list', {}, agent)
    await stopTurn(ctx, agent)
    expect(shell.ran).toEqual([])
    expect(agent.steer).not.toHaveBeenCalled()
  })

  it('sends a real failure back for repair, reruns after the fix, and counts the repair in the receipt', async () => {
    const { ctx, shell, script } = await setup(new Map([['npm run test', { exitCode: 1, stdout: { text: 'expected 3 got 4', truncated: false } }]]), {}, { files: node })
    const agent = fakeAgent()
    await editFile(ctx, agent)
    await stopTurn(ctx, agent)
    expect(steerText(agent)).toContain('repair round 1 of 2')
    expect(steerText(agent)).toContain('expected 3 got 4')
    expect(steerText(agent)).toContain('Fix the code, not the check')
    script.set('npm run test', { exitCode: 0 })
    await editFile(ctx, agent)
    await stopTurn(ctx, agent)
    expect(shell.ran).toEqual(['npm run lint', 'npm run test', 'npm run lint', 'npm run test'])
    expect(steerText(agent)).toContain('✓ Checks passed · lint passed · test passed · 1 file changed · after 1 repair')
  })

  it('reports a failure that outlasts the repair rounds in the receipt', async () => {
    const { ctx } = await setup(new Map([['npm run test', { exitCode: 1 }]]), {}, {
      files: { ...node, '/w/.casper/project.yaml': 'repair:\n  maxAttempts: 0\n' },
    })
    const agent = fakeAgent()
    await editFile(ctx, agent)
    await stopTurn(ctx, agent)
    expect(agent.steer).toHaveBeenCalledTimes(1)
    expect(steerText(agent)).toContain('still fail after 0 repair rounds')
    expect(steerText(agent)).toContain('✗ Failed: test failed')
  })

  it('reports a check the sandbox blocked as could-not-check and starts no repair', async () => {
    const { ctx } = await setup(new Map([['npm run test', { exitCode: 1, stderr: { text: 'listen EPERM: operation not permitted', truncated: false } }]]), {}, { files: node })
    const agent = fakeAgent()
    await editFile(ctx, agent)
    await stopTurn(ctx, agent)
    expect(agent.steer).toHaveBeenCalledTimes(1)
    expect(steerText(agent)).not.toContain('repair round')
    expect(steerText(agent)).toContain('test could not check: blocked by the sandbox, not a bug in the code')
  })

  it('reports a blocked-looking failure outside a confining sandbox as a failure', async () => {
    const { ctx } = await setup(new Map([['npm run test', { exitCode: 1, stderr: { text: 'EPERM', truncated: false } }]]), { runUnconfined: true }, { files: node, sandbox: { mode: 'danger-full-access' } })
    const agent = fakeAgent()
    await editFile(ctx, agent)
    await stopTurn(ctx, agent)
    expect(steerText(agent)).toContain('repair round 1 of 2')
  })

  it('skips the project checks when only documentation changed', async () => {
    const { ctx, shell } = await setup(new Map(), {}, { files: node })
    const agent = fakeAgent()
    await editFile(ctx, agent, 'README.md')
    await stopTurn(ctx, agent)
    expect(shell.ran).toEqual([])
    expect(steerText(agent)).toContain('– Checks skipped — only documentation changed (README.md)')
  })

  it('does not run the project\'s commands when no sandbox confines them', async () => {
    const { ctx, shell } = await setup(new Map(), {}, { files: node, sandbox: null })
    const agent = fakeAgent()
    await call(ctx, 'bash', { command: 'touch x' }, agent)
    await stopTurn(ctx, agent)
    expect(shell.ran).toEqual([])
    expect(steerText(agent)).toContain('no sandbox confines this project\'s commands and folder trust is not available yet, so Casper did not run npm run lint, npm run test')
    expect(steerText(agent)).toContain('Changed: files through shell commands (not listed)')
  })

  it.each([
    ['verification:\n  mode: off\n', 'checking is off for this project'],
    ['verification:\n  mode: offer\n', 'checks are offered, not run, for this project (verification.mode: offer); ask to run: npm run lint, npm run test'],
    ['verify:\n  e2e: playwright\n', '.casper/project.yaml: `verify.e2e` is not a known check; use typecheck, lint, test, build; fix the file'],
  ])('says why the project checks did not run for %j', async (file, reason) => {
    const { ctx, shell } = await setup(new Map(), {}, { files: { ...node, '/w/.casper/project.yaml': file } })
    const agent = fakeAgent()
    await editFile(ctx, agent)
    await stopTurn(ctx, agent)
    expect(shell.ran).toEqual([])
    expect(steerText(agent)).toContain(`– Not checked — ${reason}`)
  })

  it('says when the project has no checks, or the project could not be read', async () => {
    for (const [options, reason] of [
      [{ files: { '/w/package.json': null } }, 'no checks found; say \\"add tests\\" to have some written'],
      [{ ensureFails: true }, 'Casper could not read the project to find its checks (Error: cwd gone)'],
    ] as const) {
      const { ctx } = await setup(new Map(), {}, options)
      const agent = fakeAgent()
      await editFile(ctx, agent)
      await stopTurn(ctx, agent)
      expect(steerText(agent)).toContain(reason)
    }
  })

  it('leaves the project alone when project checks are off, and sends no receipt when receipts are off', async () => {
    const off = await setup(new Map(), { projectChecks: false }, { files: node })
    const agent = fakeAgent()
    await editFile(off.ctx, agent)
    await stopTurn(off.ctx, agent)
    expect(off.shell.ran).toEqual([])
    expect(steerText(agent)).toContain('automatic project checks are off')
    const quiet = await setup(new Map(), { receipt: false }, { files: node })
    const other = fakeAgent()
    await editFile(quiet.ctx, other)
    await stopTurn(quiet.ctx, other)
    expect(quiet.shell.ran).toHaveLength(2)
    expect(other.steer).not.toHaveBeenCalled()
  })

  it('passes the project timeout to the shell', async () => {
    const { ctx, shell } = await setup(new Map(), {}, { files: { ...node, '/w/.casper/project.yaml': 'verification:\n  timeoutMs: 1234\n  checks: [test]\n' } })
    const agent = fakeAgent()
    await editFile(ctx, agent)
    await stopTurn(ctx, agent)
    expect(shell.requests.filter(request => request.signal !== undefined).map(request => [request.command, request.timeoutMs])).toEqual([['npm run test', 1234]])
  })

  it('reuses a fresh verdict of a recorded check with the same command and lists it once', async () => {
    const { ctx, shell } = await setup(new Map(), {}, { files: node })
    const agent = fakeAgent()
    await editFile(ctx, agent)
    await call(ctx, 'check_record', { name: 'unit', command: 'npm run test' }, agent)
    await call(ctx, 'check_record', { name: 'smoke', command: 'node smoke.js' }, agent)
    await stopTurn(ctx, agent)
    expect(shell.ran).toEqual(['npm run test', 'node smoke.js', 'npm run lint'])
    expect(steerText(agent)).toContain('✓ Checks passed · lint passed · test passed · smoke passed')
  })

  it('runs no project checks and sends no receipt for a subagent', async () => {
    const { ctx, shell } = await setup(new Map(), {}, { files: node })
    for (const header of [{ origin: 'subagent' as const }, { delegationDepth: 1 }]) {
      const agent = fakeAgent('sub', '/w', header)
      await editFile(ctx, agent)
      await stopTurn(ctx, agent)
      expect(agent.steer).not.toHaveBeenCalled()
    }
    expect(shell.ran).toEqual([])
  })

  it('does not count a str_replace_editor view as a change', async () => {
    const { ctx, shell } = await setup(new Map(), { mutatingTools: ['str_replace_editor'] }, { files: node })
    ctx.tools.register(defineTool({
      name: 'str_replace_editor',
      description: 'test editor',
      parameters: { command: { type: 'string' }, path: { type: 'string' } },
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'ok' }] },
      execute: () => Promise.resolve('ok'),
    }))
    const agent = fakeAgent()
    await call(ctx, 'str_replace_editor', { command: 'view', path: 'a.ts' }, agent)
    await stopTurn(ctx, agent)
    expect(shell.ran).toEqual([])
    await call(ctx, 'str_replace_editor', { command: 'create', path: 'a.ts' }, agent)
    await stopTurn(ctx, agent)
    expect(shell.ran).toHaveLength(2)
  })

  it('stops at a cancelled checkpoint without a verdict or a receipt', async () => {
    const aborted = new AbortController()
    aborted.abort()
    const { ctx, shell } = await setup(new Map(), {}, { files: node })
    const agent = fakeAgent()
    await editFile(ctx, agent)
    await stopTurn(ctx, agent, 1, aborted.signal)
    expect(shell.ran).toEqual([])
    expect(agent.steer).not.toHaveBeenCalled()
  })

  it('stops when the checkpoint is cancelled while a project check runs', async () => {
    const controller = new AbortController()
    const { ctx, shell } = await setup(new Map<string, Outcome>([['npm run lint', () => {
      controller.abort()
      return Promise.resolve({ exitCode: null, aborted: true })
    }]]), {}, { files: node })
    const agent = fakeAgent()
    await editFile(ctx, agent)
    await stopTurn(ctx, agent, 1, controller.signal)
    expect(shell.ran).toEqual(['npm run lint'])
    expect(agent.steer).not.toHaveBeenCalled()
  })

  it('stops when the checkpoint is cancelled between project checks', async () => {
    const controller = new AbortController()
    const { ctx, shell } = await setup(new Map<string, Outcome>([['npm run lint', () => {
      controller.abort()
      return Promise.resolve({ exitCode: 0 })
    }]]), {}, { files: node })
    const agent = fakeAgent()
    await editFile(ctx, agent)
    await stopTurn(ctx, agent, 1, controller.signal)
    expect(shell.ran).toEqual(['npm run lint'])
    expect(agent.steer).not.toHaveBeenCalled()
  })

  it('stops when the checkpoint is cancelled after replaying recorded checks', async () => {
    const controller = new AbortController()
    const { ctx, shell, script } = await setup(new Map(), {}, { files: node })
    const agent = fakeAgent()
    await call(ctx, 'check_record', { name: 'smoke', command: 'node smoke.js' }, agent)
    await editFile(ctx, agent)
    script.set('node smoke.js', () => {
      controller.abort()
      return Promise.resolve({ exitCode: 0 })
    })
    await stopTurn(ctx, agent, 1, controller.signal)
    expect(shell.ran).toEqual(['node smoke.js', 'node smoke.js'])
    expect(agent.steer).not.toHaveBeenCalled()
  })

  it('forgets a disposed agent\'s pending changes', async () => {
    const { ctx, shell } = await setup(new Map(), {}, { files: node })
    const agent = fakeAgent()
    await editFile(ctx, agent)
    ctx.emit(agent as never, 'agent/disposed', { agent })
    await stopTurn(ctx, agent)
    expect(shell.ran).toEqual([])
  })
})

describe('casper-checks: tool inputs and recorded-check steering', () => {
  it('rejects an empty command and a nonpositive timeout', async () => {
    const { ctx } = await setup()
    expect((await call(ctx, 'check_record', { name: 'a', command: '  ' }, fakeAgent())).isError).toBe(true)
    expect((await call(ctx, 'check_record', { name: 'a', command: 'x', timeoutMs: 0 }, fakeAgent())).isError).toBe(true)
    expect((await call(ctx, 'check_replay', {}, undefined)).isError).toBe(true)
    expect((await call(ctx, 'check_list', {}, undefined)).isError).toBe(true)
  })

  it('renders an empty replay and describes each call', async () => {
    const { ctx } = await setup()
    const replayed = await call(ctx, 'check_replay', {}, fakeAgent())
    expect(JSON.stringify(replayed)).toContain('no checks recorded')
    expect(ctx.tools.get('check_record')?.presentCall?.({ name: 'test', command: 'npm test' })).toEqual({ card: 'terminal', title: 'npm test', description: 'Record check test' })
    expect(ctx.tools.get('check_replay')?.presentCall?.({})).toMatchObject({ title: 'Replay all checks' })
    expect(ctx.tools.get('check_replay')?.presentCall?.({ name: 'test' })).toMatchObject({ title: 'Replay check test' })
    expect(ctx.tools.get('check_list')?.presentCall?.({})).toMatchObject({ title: 'List checks' })
  })

  it('throws when a recording or a replay is cancelled while its command runs', async () => {
    const { ctx, script } = await setup()
    const agent = fakeAgent()
    const recording = new AbortController()
    script.set('slow', () => {
      recording.abort()
      return Promise.reject(new Error('killed'))
    })
    expect((await call(ctx, 'check_record', { name: 'slow', command: 'slow' }, agent, recording.signal)).isError).toBe(true)
    script.set('quick', { exitCode: 0 })
    await call(ctx, 'check_record', { name: 'quick', command: 'quick' }, agent)
    const replaying = new AbortController()
    script.set('quick', () => {
      replaying.abort()
      return Promise.resolve({ exitCode: null, aborted: true })
    })
    expect((await call(ctx, 'check_replay', {}, agent, replaying.signal)).isError).toBe(true)
  })

  it('marks every recorded check stale when an edit has no known working directory', async () => {
    const { ctx } = await setup()
    const owner = fakeAgent('a', '/repo')
    await call(ctx, 'check_record', { name: 'test', command: 'npm test' }, owner)
    await call(ctx, 'edit', {}, fakeAgent('b', ''))
    expect((await call(ctx, 'check_list', {}, owner)).value).toEqual([expect.objectContaining({ stale: true })])
  })

  it('relates the filesystem root to every directory below it', async () => {
    const { ctx } = await setup()
    const rooted = fakeAgent('root', '/')
    const nested = fakeAgent('nested', '/repo')
    await call(ctx, 'check_record', { name: 'test', command: 'npm test' }, rooted)
    await call(ctx, 'check_record', { name: 'test', command: 'npm test' }, nested)
    await call(ctx, 'edit', {}, fakeAgent('x', '/repo'))
    expect((await call(ctx, 'check_list', {}, rooted)).value).toEqual([expect.objectContaining({ stale: true })])
    await call(ctx, 'check_replay', {}, nested)
    await call(ctx, 'edit', {}, fakeAgent('y', '/'))
    expect((await call(ctx, 'check_list', {}, nested)).value).toEqual([expect.objectContaining({ stale: true })])
  })

  it('names checks that could not run inside a repair request', async () => {
    const { ctx } = await setup(new Map<string, Outcome>([['npm test', { exitCode: 1 }], ['slow', { exitCode: null, timedOut: true }]]))
    const agent = fakeAgent()
    await call(ctx, 'check_record', { name: 'test', command: 'npm test' }, agent)
    await call(ctx, 'check_record', { name: 'slow', command: 'slow' }, agent)
    await call(ctx, 'edit', {}, agent)
    await stopTurn(ctx, agent)
    expect(steerText(agent)).toContain('repair round 1 of 2')
    expect(steerText(agent)).toContain('These checks could not run')
  })

  it('stops at a checkpoint cancelled before it replays a recorded check', async () => {
    const aborted = new AbortController()
    aborted.abort()
    const { ctx, shell } = await setup()
    const agent = fakeAgent()
    await call(ctx, 'check_record', { name: 'test', command: 'npm test' }, agent)
    await call(ctx, 'edit', {}, agent)
    await stopTurn(ctx, agent, 1, aborted.signal)
    expect(shell.ran).toEqual(['npm test'])
    expect(agent.steer).not.toHaveBeenCalled()
  })

  it('steers repairs, then a corrected report, when another agent\'s edits break a recorded check', async () => {
    const { ctx } = await setup(new Map<string, Outcome>([['npm test', { exitCode: 1 }], ['slow', { exitCode: null, timedOut: true }]]))
    const owner = fakeAgent('owner')
    await call(ctx, 'check_record', { name: 'test', command: 'npm test' }, owner)
    await call(ctx, 'check_record', { name: 'slow', command: 'slow' }, owner)
    for (let round = 0; round < 3; round++) {
      await call(ctx, 'edit', {}, fakeAgent('helper'))
      await stopTurn(ctx, owner)
    }
    expect(owner.steer).toHaveBeenCalledTimes(3)
    expect(steerText(owner, 2)).toContain('still fail after 2 repair rounds. Stop repairing')
    expect(steerText(owner, 2)).toContain('These checks could not run')
  })

  it('steers once to correct the report when another agent\'s edit leaves a recorded check unrunnable', async () => {
    const { ctx, script } = await setup(new Map<string, Outcome>([['slow', { exitCode: 0 }]]))
    const owner = fakeAgent('owner')
    await call(ctx, 'check_record', { name: 'slow', command: 'slow' }, owner)
    script.set('slow', { exitCode: null, timedOut: true })
    await call(ctx, 'edit', {}, fakeAgent('helper'))
    await stopTurn(ctx, owner)
    expect(owner.steer).toHaveBeenCalledTimes(1)
    expect(steerText(owner)).toContain('some could not run')
  })

  it('goes quiet after reporting a recorded failure that outlasted its repairs', async () => {
    const { ctx } = await setup(new Map<string, Outcome>([['npm test', { exitCode: 1 }]]))
    const owner = fakeAgent('owner')
    await call(ctx, 'check_record', { name: 'test', command: 'npm test' }, owner)
    for (let round = 0; round < 4; round++) {
      await call(ctx, 'edit', {}, fakeAgent('helper'))
      await stopTurn(ctx, owner)
    }
    expect(owner.steer).toHaveBeenCalledTimes(3)
    expect(steerText(owner)).not.toContain('could not run')
  })
})
