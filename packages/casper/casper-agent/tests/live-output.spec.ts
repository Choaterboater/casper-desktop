import { afterEach, describe, expect, it } from 'vitest'
import type { ToolCallUpdate } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobEvent, JobView } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { lineList, liveText, newLines } from '../src/live-output.ts'
import { boot, eventsOf, prompt, turnEnds } from './harness.ts'
import { fakeCasper, gate, waitFor } from './support.ts'
import type { FakeScript, FakeStep } from './support.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(script: FakeScript, overrides: Parameters<typeof boot>[1] = {}) {
  const fake = fakeCasper(script)
  cleanups.push(() => { fake.remove() })
  const host = await boot(fake, overrides, undefined, true, async (ctx: Context) => { await ctx.plugin(LocalJobRegistry) })
  cleanups.push(() => host.ctx.fiber.dispose())
  // Every job event any Session's jobs send, as the Jobs panel's rows stream hears them.
  const heard: JobEvent[] = []
  host.ctx.jobs.events.subscribe({ owners: 'all' }, (event) => { heard.push(event) })
  return { fake, host, heard }
}

/** A Casper shell step as a current Casper starts it. */
function shell(command: string): FakeStep {
  return { tool: 'bash', meta: { tool: 'bash' }, rawInput: { command } }
}

/** The shell step's end as a current Casper sends it: the whole output, fenced, with its exit code. */
function shellEnd(output: string): FakeStep {
  return { toolEnd: 1, rawOutput: { exitCode: 0, truncated: false }, content: [`\`\`\`text\n${output}\n\`\`\``] }
}

function jobsOf(ctx: Context, agent: Agent): JobView[] {
  return ctx.jobs.list(agent.id)
}

/** The text of a job's output so far, as the Jobs panel reads it. */
function shown(ctx: Context, agent: Agent, job: JobView): string {
  return ctx.jobs.readAt(job.id, 0, agent.id).chunks.map(chunk => chunk.text).join('')
}

function results(agent: Agent): string[] {
  return eventsOf(agent).flatMap(event => event.type === 'tool/result'
    ? [event.data.message.content.map(block => block.type === 'text' ? block.text : '').join('')]
    : [])
}

function jobRecords(agent: Agent): string[] {
  return eventsOf(agent).flatMap(event => event.type === 'job/registered' || event.type === 'job/settled'
    ? [`${event.type}${event.type === 'job/settled' ? `:${event.data.status}` : ''}`]
    : [])
}

describe('live output windows', () => {
  it('reads only an in-progress update marked live, without its fence', () => {
    const live: ToolCallUpdate = {
      toolCallId: 'casper-tool-1', status: 'in_progress', _meta: { casper: { live: true } },
      content: [{ type: 'content', content: { type: 'text', text: '```text\nl1\nl2\n```' } }],
    }
    expect(liveText(live)).toBe('l1\nl2')
    const { _meta: _unmarked, ...unmarked } = live
    expect(liveText(unmarked)).toBeUndefined()
    expect(liveText({ ...live, _meta: { casper: { live: 'yes' } } })).toBeUndefined()
    expect(liveText({ ...live, status: 'completed' })).toBeUndefined()
    expect(liveText({ ...live, content: [] })).toBeUndefined()
  })

  it('splits lines without the empty one after a last line break', () => {
    expect(lineList('')).toEqual([])
    expect(lineList('a\nb\n')).toEqual(['a', 'b'])
    expect(lineList('a\n\nb')).toEqual(['a', '', 'b'])
  })

  it('adds only the lines a window adds, taking the longest overlap', () => {
    expect(newLines([], ['a', 'b'])).toEqual({ lines: ['a', 'b'], gap: false })
    // The window grew in place, then slid down by one line.
    expect(newLines(['a', 'b'], ['a', 'b', 'c'])).toEqual({ lines: ['c'], gap: false })
    expect(newLines(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual({ lines: ['d'], gap: false })
    // Repeated lines: the longest overlap wins, so a new copy of a line is still added.
    expect(newLines(['x', 'x'], ['x', 'x', 'x'])).toEqual({ lines: ['x'], gap: false })
    expect(newLines(['y', 'x'], ['x', 'x'])).toEqual({ lines: ['x'], gap: false })
    // The same window adds nothing.
    expect(newLines(['a', 'b'], ['a', 'b'])).toEqual({ lines: [], gap: false })
  })

  it('marks a gap when output scrolled past a whole window between two updates', () => {
    expect(newLines(['a', 'b'], ['y', 'z'])).toEqual({ lines: ['y', 'z'], gap: true })
  })
})

describe('Casper commands in the Jobs panel', { timeout: 60_000 }, () => {
  it('shows a running command with its latest lines and ends it with the step, whose card keeps the final output', async () => {
    const fake = fakeCasper({ prompts: [] })
    cleanups.push(() => { fake.remove() })
    const held = gate(fake, 'held')
    fake.script({
      prompts: [[
        shell('npm test'),
        { live: 1, lines: ['l1', 'l2'] },
        // Casper's next window replaces the last one: l2 is shown once.
        { live: 1, lines: ['l2', 'l3'] },
        { waitFile: held.path },
        shellEnd('l1\nl2\nl3\nall passed'),
        { text: 'done\n' },
      ]],
    })
    const host = await boot(fake, {}, undefined, true, async (ctx: Context) => { await ctx.plugin(LocalJobRegistry) })
    cleanups.push(() => host.ctx.fiber.dispose())
    const { agent } = await host.create('casper-live')
    agent.followup(prompt('run the tests'))
    const job = await waitFor(() => {
      const [running] = jobsOf(host.ctx, agent)
      return running !== undefined && shown(host.ctx, agent, running) === 'l1\nl2\nl3\n' ? running : undefined
    })
    expect(job).toMatchObject({ kind: 'casper', label: 'npm test', status: 'running', owner: agent.id })
    expect(jobsOf(host.ctx, agent)).toHaveLength(1)
    // The job names the step's own call, as a Standard shell call's job does.
    const call = eventsOf(agent).find(event => event.type === 'tool/call')
    const registered = eventsOf(agent).find(event => event.type === 'job/registered')
    expect(registered?.type === 'job/registered' && registered.data.toolCall?.callId).toBe(call?.type === 'tool/call' ? call.data.callId : 'none')
    // The card has no result while the command runs: the lines go to the Jobs panel only.
    expect(results(agent)).toEqual([])
    held.open()
    await agent.whenIdle()
    await waitFor(() => jobsOf(host.ctx, agent).length === 0)
    expect(results(agent)).toEqual(['l1\nl2\nl3\nall passed'])
    expect(jobRecords(agent)).toEqual(['job/registered', 'job/settled:completed'])
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
  })

  it('stops the whole request when the person stops the command\'s job', async () => {
    const { fake, host } = await setup({ prompts: [[shell('npm run build'), { live: 1, lines: ['building'] }, { hang: true }]] })
    const { agent } = await host.create('casper-live-stop')
    agent.followup(prompt('build it'))
    const job = await waitFor(() => jobsOf(host.ctx, agent)[0])
    // What the Jobs panel's Stop sends through the job controller.
    expect(host.ctx.jobs.kill(job.id, agent.id, 'cancelled by the user')).toBe('requested')
    await waitFor(() => fake.calls('session/cancel').length === 1)
    await agent.whenIdle()
    expect(turnEnds(agent)).toEqual([{ kind: 'aborted', reason: { kind: 'user' } }])
    await waitFor(() => jobsOf(host.ctx, agent).length === 0)
    expect(jobRecords(agent)).toEqual(['job/registered', 'job/settled:killed'])
    // The step that was still running gets the outcome-unknown result, as after the composer's Stop.
    const result = eventsOf(agent).find(event => event.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.error?.code).toBe('TOOL_OUTCOME_UNKNOWN')
  })

  it('ends a job whose step is still running when the prompt ends', async () => {
    const { host } = await setup({ prompts: [[shell('sleep 5'), { live: 1, lines: ['waiting'] }, { hang: true }]] })
    const { agent } = await host.create('casper-live-end')
    agent.followup(prompt('wait'))
    await waitFor(() => jobsOf(host.ctx, agent)[0])
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    await waitFor(() => jobsOf(host.ctx, agent).length === 0)
    expect(jobRecords(agent)).toEqual(['job/registered', 'job/settled:killed'])
  })

  it('shows a gap when Casper\'s window moved past every line shown', async () => {
    const { host } = await setup({ prompts: [[shell('make'), { live: 1, lines: ['a', 'b'] }, { live: 1, lines: ['y', 'z'] }, { hang: true }]] })
    const { agent } = await host.create('casper-live-gap')
    agent.followup(prompt('make'))
    const job = await waitFor(() => {
      const [running] = jobsOf(host.ctx, agent)
      return running !== undefined && shown(host.ctx, agent, running) === 'a\nb\ny\nz\n' ? running : undefined
    })
    expect(host.ctx.jobs.readAt(job.id, 0, agent.id).chunks.map(chunk => chunk.gapBefore === true)).toEqual([false, true])
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
  })

  it('sends nothing to the Jobs panel with liveOutput off', async () => {
    const { host, heard } = await setup({
      prompts: [[shell('npm test'), { live: 1, lines: ['l1'] }, { live: 1, lines: ['l1', 'l2'] }, shellEnd('l1\nl2')]],
    }, { liveOutput: false })
    const { agent } = await host.create('casper-live-off')
    agent.followup(prompt('run the tests'))
    await agent.whenIdle()
    expect(heard).toEqual([])
    expect(jobRecords(agent)).toEqual([])
    expect(results(agent)).toEqual(['l1\nl2'])
    // No controller serves the Agent, so the registry takes no job for it.
    expect(() => host.ctx.jobs.start({ kind: 'casper', label: 'x', owner: agent.id, run: () => ({ cancel: () => {}, done: Promise.resolve({ status: 'completed' }) }) }))
      .toThrow(/no job controller/)
  })

  it('shows no job for an older Casper that sends no live lines', async () => {
    const { host, heard } = await setup({
      prompts: [[shell('npm test'), { toolUpdate: 1, content: ['partial'] }, shellEnd('ok')]],
    })
    const { agent } = await host.create('casper-live-older')
    agent.followup(prompt('run the tests'))
    await agent.whenIdle()
    expect(heard).toEqual([])
    expect(results(agent)).toEqual(['ok'])
  })

  it('serves only the Casper Agent: a Standard Session still cannot start a job', async () => {
    const { host } = await setup({ prompts: [] })
    const { agent } = await host.create('casper-live-scope')
    const standard = await host.create('standard-live-scope', 'standard')
    const spec = (owner: SessionId) => ({
      kind: 'casper' as const, label: 'x', owner, run: () => ({ cancel: () => {}, done: Promise.resolve({ status: 'completed' as const }) }),
    })
    expect(() => host.ctx.jobs.start(spec(standard.agent.id))).toThrow(/no job controller/)
    const id = host.ctx.jobs.start(spec(agent.id))
    await host.ctx.jobs.wait(id, 5_000, agent.id)
  })

  it('ends the job but not the request when the job registry itself unloads mid-command', async () => {
    const fake = fakeCasper({ prompts: [] })
    cleanups.push(() => { fake.remove() })
    const held = gate(fake, 'held')
    fake.script({ prompts: [[shell('npm test'), { live: 1, lines: ['l1'] }, { waitFile: held.path }, shellEnd('l1\nok'), { text: 'done\n' }]] })
    let registry: { dispose: () => unknown } | undefined
    const host = await boot(fake, {}, undefined, true, async (ctx: Context) => { registry = await ctx.plugin(LocalJobRegistry) })
    cleanups.push(() => host.ctx.fiber.dispose())
    const { agent } = await host.create('casper-live-registry')
    agent.followup(prompt('run the tests'))
    await waitFor(() => jobsOf(host.ctx, agent)[0])
    await registry?.dispose()
    // Only the person's Stop stops the request: the registry's own teardown leaves Casper's turn to its end.
    held.open()
    await agent.whenIdle()
    expect(fake.calls('session/cancel')).toEqual([])
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
    expect(results(agent)).toEqual(['l1\nok'])
  })

  it('leaves no job behind when the Casper plugin unloads mid-command', async () => {
    const { host } = await setup({ prompts: [[shell('npm test'), { live: 1, lines: ['l1'] }, { hang: true }]] })
    const { agent } = await host.create('casper-live-unload')
    agent.followup(prompt('run the tests'))
    await waitFor(() => jobsOf(host.ctx, agent)[0])
    await host.unloadCasper()
    expect(host.ctx.jobs.list(SessionId('casper-live-unload'))).toEqual([])
  })
})
