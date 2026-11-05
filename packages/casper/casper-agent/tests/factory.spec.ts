import { afterEach, describe, expect, it } from 'vitest'
import { modelSelectionProjectionDefinition } from '@deepseek-ai/dsh-agent'
import { inboxProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { SessionId } from '@deepseek-ai/dsh-session'
import { CasperAgent } from '../src/agent.ts'
import { CasperAgentFactory } from '../src/factory.ts'
import { CasperSidecar } from '../src/sidecar.ts'
import { boot, eventsOf, prompt, turnEnds } from './harness.ts'
import { alive, fakeCasper, waitFor } from './support.ts'
import type { FakeScript } from './support.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fixture(script: FakeScript) {
  const fake = fakeCasper(script)
  cleanups.push(() => { fake.remove() })
  return fake
}

describe('CasperAgentFactory', { timeout: 60_000 }, () => {
  it('resumes a Session after a restart without starting Casper, then reopens its conversation at the first prompt', async () => {
    const fake = fixture({ prompts: [[{ text: 'first answer\n' }], [{ text: 'second answer\n' }]], newSessionId: 'conversation-r' })
    const first = await boot(fake)
    const { agent } = await first.create('casper-restart')
    agent.followup(prompt('remember this'))
    await agent.whenIdle()
    // A crash mid-turn leaves an open turn in the log.
    agent.session.append('turn/start', { turn: 2 })
    agent.session.append('step/start', { turn: 2, step: 1 })
    await first.ctx.fiber.dispose()
    expect(fake.pids().every(pid => !alive(pid))).toBe(true)

    const second = await boot(fake)
    cleanups.push(() => second.ctx.fiber.dispose())
    const resumed = (await second.ctx.agents.resume({ resumeSessionId: SessionId('casper-restart'), agentPreset: 'casper' })).agent
    expect(resumed).toBeInstanceOf(CasperAgent)
    expect(fake.pids()).toHaveLength(1)
    expect(turnEnds(resumed)).toEqual([{ kind: 'completed' }, { kind: 'interrupted' }])
    resumed.followup(prompt('what did I say?'))
    await resumed.whenIdle()
    expect(fake.calls('session/load').map(entry => entry.params)).toEqual([{ sessionId: 'conversation-r', cwd: fake.cwd, mcpServers: [] }])
    expect(eventsOf(resumed).filter(event => event.type === 'turn/start').map(event => event.type === 'turn/start' && event.data.turn)).toEqual([1, 2, 3])
    expect(turnEnds(resumed).at(-1)).toEqual({ kind: 'completed' })
  })

  it('leaves delegated children and Sessions resumed without a preset to agent-loop', async () => {
    const fake = fixture({ prompts: [[]] })
    const host = await boot(fake)
    cleanups.push(() => host.ctx.fiber.dispose())
    const child = await host.ctx.agents.create({
      sessionId: SessionId('casper-child'),
      meta: { cwd: fake.cwd, agentPreset: 'casper', origin: 'subagent', parentSession: SessionId('parent') },
    })
    expect(child.agent).not.toBeInstanceOf(CasperAgent)
    const created = await host.create('casper-plain')
    created.agent.followup(prompt('stored'))
    await created.agent.whenIdle()
    await created.dispose()
    const resumed = await host.ctx.agents.resume({ resumeSessionId: SessionId('casper-plain') })
    expect(resumed.agent).not.toBeInstanceOf(CasperAgent)
  })

  it('disposes every live Agent and its process when the plugin unloads', async () => {
    const fake = fixture({ prompts: [[], []] })
    const host = await boot(fake)
    cleanups.push(() => host.ctx.fiber.dispose())
    const first = (await host.create('casper-unload-a')).agent
    const second = (await host.create('casper-unload-b')).agent
    first.followup(prompt('a'))
    second.followup(prompt('b'))
    await first.whenIdle()
    await second.whenIdle()
    const pids = fake.pids()
    expect(pids).toHaveLength(2)
    await host.unloadCasper()
    await waitFor(() => pids.every(pid => !alive(pid)))
    expect(host.ctx.agents.get(first.id)).toBeUndefined()
    expect(host.ctx.agents.get(second.id)).toBeUndefined()
  })

  it('rejects a resume of a Session that is not stored', async () => {
    const fake = fixture({ prompts: [] })
    const host = await boot(fake)
    cleanups.push(() => host.ctx.fiber.dispose())
    await expect(host.ctx.agents.resume({ resumeSessionId: SessionId('casper-missing'), agentPreset: 'casper' })).rejects.toThrow()
    expect(host.ctx.agents.get(SessionId('casper-missing'))).toBeUndefined()
  })

  it('rolls an Agent back when its setup fails', async () => {
    const fake = fixture({ prompts: [] })
    const host = await boot(fake)
    cleanups.push(() => host.ctx.fiber.dispose())
    await expect(host.ctx.agents.create({
      sessionId: SessionId('casper-setup'),
      meta: { cwd: fake.cwd, agentPreset: 'casper' },
      setup: () => { throw new Error('setup refused') },
    })).rejects.toThrow('setup refused')
    expect(host.ctx.agents.get(SessionId('casper-setup'))).toBeUndefined()
    expect(host.ctx.sessions.get(SessionId('casper-setup'))).toBeUndefined()
  })

  it('resumes a cleanly closed Session without repair', async () => {
    const fake = fixture({ prompts: [[]] })
    const first = await boot(fake)
    const created = await first.create('casper-clean')
    created.agent.followup(prompt('one'))
    await created.agent.whenIdle()
    await first.ctx.fiber.dispose()
    const second = await boot(fake)
    cleanups.push(() => second.ctx.fiber.dispose())
    const resumed = await second.ctx.agents.resume({ resumeSessionId: SessionId('casper-clean'), agentPreset: 'casper', signal: new AbortController().signal })
    expect(turnEnds(resumed.agent)).toEqual([{ kind: 'completed' }])
  })

  it('rolls back a creation whose caller aborts during setup', async () => {
    const fake = fixture({ prompts: [] })
    const host = await boot(fake)
    cleanups.push(() => host.ctx.fiber.dispose())
    const controller = new AbortController()
    const creating = host.ctx.agents.create({
      sessionId: SessionId('casper-abort-setup'),
      meta: { cwd: fake.cwd, agentPreset: 'casper' },
      signal: controller.signal,
      setup: () => new Promise(() => {}),
    })
    await waitFor(() => host.ctx.sessions.get(SessionId('casper-abort-setup')) !== undefined)
    controller.abort('stopped')
    await expect(creating).rejects.toThrow(/creation aborted/)
    expect(host.ctx.agents.get(SessionId('casper-abort-setup'))).toBeUndefined()
  })

  it('rolls back a creation still in setup when the plugin unloads', async () => {
    const fake = fixture({ prompts: [] })
    const host = await boot(fake)
    cleanups.push(() => host.ctx.fiber.dispose())
    const creating = host.ctx.agents.create({
      sessionId: SessionId('casper-unload-setup'),
      meta: { cwd: fake.cwd, agentPreset: 'casper' },
      setup: () => new Promise(() => {}),
    })
    const settled = creating.catch((error: unknown) => error)
    await waitFor(() => host.ctx.sessions.get(SessionId('casper-unload-setup')) !== undefined)
    await host.unloadCasper()
    expect(String(await settled)).toContain('not active')
  })

  it('accepts no Agents once disposed', async () => {
    const fake = fixture({ prompts: [] })
    const host = await boot(fake)
    cleanups.push(() => host.ctx.fiber.dispose())
    const domain = host.ctx.storageDomain.get('casper_agent')
    if (domain === undefined) throw new Error('sidecar domain is not open')
    const factory = new CasperAgentFactory(host.ctx, fake.config(), {
      modelSelection: await host.ctx.sessionProjections.register(modelSelectionProjectionDefinition),
      inbox: await host.ctx.sessionProjections.register(inboxProjectionDefinition),
      sidecar: new CasperSidecar(domain as never),
    })
    await factory.dispose()
    await expect(factory.createAgent(host.ctx, { sessionId: SessionId('late-create') })).rejects.toThrow('not active')
    await expect(factory.resume(host.ctx, { resumeSessionId: SessionId('late-resume') })).rejects.toThrow('not active')
  })
})
