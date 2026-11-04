import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ShellExecRequest, ShellRunResult } from '@deepseek-ai/dsh-shell'

import * as checks from '../src/index.ts'

type Outcome = Partial<ShellRunResult> | 'throw' | (() => Promise<Partial<ShellRunResult>>)

/** A shell whose commands answer from a mutable script, so a test can change the "code" between runs. */
function scriptedShell(script: Map<string, Outcome>) {
  const ran: string[] = []
  return {
    ran,
    service: {
      sandboxMode: undefined,
      resolve: (request: ShellExecRequest) => ({ ...request, workdir: request.workdir ?? '/w', timeoutMs: request.timeoutMs ?? 1000, onExpiry: 'kill', stdoutMaxBytes: 1 << 20, sandboxPolicy: undefined }),
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

function fakeAgent(id = 'agent-1', cwd = '/w'): FakeAgent {
  return { id, session: { cwd }, steer: vi.fn(), inject: vi.fn() } as unknown as FakeAgent
}

async function setup(script = new Map<string, Outcome>(), config: Partial<checks.Config> = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  const shell = scriptedShell(script)
  ctx.provide('shell', shell.service)
  ctx.provide('workingDirectory', {
    get: (session: { cwd: string }) => session.cwd,
    ensure: (agent: { session: { cwd: string } }) => Promise.resolve(agent.session.cwd),
  })
  // A stand-in mutation tool with the real name `edit`, so its result travels the real pipeline.
  ctx.tools.register(defineTool({
    name: 'edit',
    description: 'test edit',
    parameters: {},
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'edited' }] },
    execute: () => Promise.resolve('edited'),
  }))
  await ctx.plugin(checks, { mutatingTools: ['edit'], replayOnStop: true, maxRepairRounds: 2, outputChars: 2000, maxChecks: 32, ...config })
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

function stopTurn(ctx: Context, agent: Agent, turn = 1) {
  return ctx.serial(agent as never, 'agent/turn-stopping', { agent, turn, signal: new AbortController().signal })
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
    const listed = (await call(ctx, 'check_list', {}, agent)).value as unknown as checks.CheckView[]
    expect(listed.map(item => [item.name, item.status, item.reason])).toEqual([
      ['slow', 'not_run', 'timed_out'],
      ['killed', 'not_run', 'signal'],
      ['missing', 'not_run', 'could_not_start'],
      ['expired', 'not_run', 'could_not_start'],
    ])
    expect(listed.map(checks.describeCheck).every(line => !line.includes('passed'))).toBe(true)
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
    expect(steerText(agent)).toContain('not run (timed_out)')
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
