import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AGENT_MODELS_RECORD, agentModelsProjectionDefinition } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentModelsReport } from '@deepseek-ai/dsh-agent'
import { inboxProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import { planProjectionDefinition } from '@deepseek-ai/dsh-plan-mode'
import { KNOWN_SESSION_EVENT_TYPES, pluginRecordOf, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { casperAccessProjectionDefinition } from '../src/access-projection.ts'
import { CasperAgent } from '../src/agent.ts'
import { CasperCommandCache } from '../src/commands.ts'
import { CasperAgentFactory } from '../src/factory.ts'
import { reportOf } from '../src/models.ts'
import { CasperModelsCache } from '../src/models-cache.ts'
import { CasperSidecar } from '../src/sidecar.ts'
import { boot, eventsOf, prompt, turnEnds } from './harness.ts'
import { alive, casperOptions, fakeCasper, waitFor } from './support.ts'
import type { FakeScript } from './support.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** The model list reports in a Session log, in log order. */
function reports(events: readonly SessionEvent[]): AgentModelsReport[] {
  return events.flatMap((event) => {
    const record = pluginRecordOf(event)
    return record?.type === AGENT_MODELS_RECORD ? [record.data as AgentModelsReport] : []
  })
}

/** Whether an event has the models record's type, whatever its marker. */
function namesModelsRecord(event: SessionEvent): boolean {
  const type: string = event.type
  return type === AGENT_MODELS_RECORD
}

/** The model list reports an Agent's Session holds, in log order. */
function models(agent: Agent): AgentModelsReport[] {
  return reports(eventsOf(agent))
}

function fixture(script: FakeScript) {
  const fake = fakeCasper(script)
  cleanups.push(() => { fake.remove() })
  return fake
}

describe('CasperAgentFactory', { timeout: 60_000 }, () => {
  it('resumes a Session after a restart without starting Casper, then reopens its conversation at the first prompt', async () => {
    // Casper's option updates during the reload's replay wait for the reload to finish.
    const fake = fixture({ prompts: [[{ text: 'first answer\n' }], [{ text: 'second answer\n' }]], newSessionId: 'conversation-r', configOptions: casperOptions(), replayConfig: true })
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
    expect(models(resumed).map(report => report.started)).toEqual([false, true])
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

  it('seeds a new Session\'s picker from the cached list, or the start value, and adds nothing on resume', async () => {
    const fake = fixture({ prompts: [[{ text: 'ok\n' }]], configOptions: casperOptions() })
    const first = await boot(fake, { model: 'openrouter/vendor/model' })
    const { agent: empty } = await first.create('casper-seed-empty')
    expect(models(empty)).toEqual([{ groups: [], current: { provider: 'openrouter', model: 'vendor/model' }, started: false }])
    const { groups, current } = reportOf(casperOptions())
    const domain = first.ctx.storageDomain.get('casper_agent_models')
    if (domain === undefined) throw new Error('model cache is not open')
    await new CasperModelsCache(domain as never).write({ groups, current })
    await first.ctx.fiber.dispose()

    const second = await boot(fake)
    cleanups.push(() => second.ctx.fiber.dispose())
    const { agent: seeded } = await second.create('casper-seed-cached')
    expect(models(seeded)).toEqual([{ groups, current, started: false }])
    const resumed = (await second.ctx.agents.resume({ resumeSessionId: SessionId('casper-seed-empty'), agentPreset: 'casper' })).agent
    expect(models(resumed)).toEqual(models(empty))
    expect(fake.pids()).toEqual([])
  })

  it('stores the model list as a record that a reader without Casper keeps and skips', async () => {
    const fake = fixture({ prompts: [[{ text: 'ok\n' }]], configOptions: casperOptions() })
    const host = await boot(fake)
    cleanups.push(() => host.ctx.fiber.dispose())
    const { agent } = await host.create('casper-models-record')
    agent.followup(prompt('hello'))
    await agent.whenIdle()
    await host.ctx.sessions.flush(agent.session)
    expect(KNOWN_SESSION_EVENT_TYPES.has(AGENT_MODELS_RECORD)).toBe(false)

    // An app build without this package: JSONL persistence and the projection registry, no Casper plugin.
    const reader = new Context()
    cleanups.push(() => reader.fiber.dispose())
    await reader.plugin(JsonlSessionPersistence, { root: join(fake.root, 'sessions'), compression: 'none' })
    const handle = await reader.sessionPersistence.open(agent.session.id, 'read')
    let stored: Awaited<ReturnType<typeof handle.read>>
    try {
      stored = await handle.read()
    } finally {
      await handle.close()
    }
    expect(stored.events.filter(namesModelsRecord).map(event => event.ignorable)).toEqual([true, true])
    expect(reports(stored.events).map(report => report.started)).toEqual([false, true])
    const restored = Session.create(SessionId('casper-models-restored'), stored.events)
    expect(restored.snapshotEvents().slice(0, stored.events.length)).toEqual(stored.events)
    expect(restored.deriveMessages()).toEqual(agent.session.deriveMessages())
    await reader.plugin(SessionProjectionRegistry)
    await reader.sessionProjections.register(agentModelsProjectionDefinition)
    expect(reader.sessionProjections.snapshot(restored).values.agentModels).toEqual({ ...reportOf(casperOptions()), started: true })
  })

  it('refuses a pick in a Session from before Casper reported models, until its Casper starts', async () => {
    const fake = fixture({ prompts: [[{ text: 'standard\n' }], [{ text: 'casper\n' }]], configOptions: casperOptions() })
    const host = await boot(fake)
    cleanups.push(() => host.ctx.fiber.dispose())
    const plain = await host.create('casper-legacy', 'standard')
    // A pick from the app's catalog, before Casper Sessions reported models.
    plain.agent.session.append('model/selection', { provider: 'deepseek', model: 'deepseek-chat' })
    await plain.dispose()
    const { agent } = await host.ctx.agents.resume({ resumeSessionId: SessionId('casper-legacy'), agentPreset: 'casper' })
    expect(agent).toBeInstanceOf(CasperAgent)
    await expect(agent.model.own?.choose({ provider: 'openai-codex', model: 'gpt-6.1-sol' }))
      .rejects.toThrow('Casper lists its models once it starts. Send your first message.')
    expect(agent.model.current()).toBeUndefined()
    agent.followup(prompt('hi'))
    await agent.whenIdle()
    expect(agent.model.current()).toEqual(reportOf(casperOptions()).current)
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
      agentModels: await host.ctx.sessionProjections.register(agentModelsProjectionDefinition),
      inbox: await host.ctx.sessionProjections.register(inboxProjectionDefinition),
      plan: await host.ctx.sessionProjections.register(planProjectionDefinition),
      casperAccess: await host.ctx.sessionProjections.register(casperAccessProjectionDefinition),
      sidecar: new CasperSidecar(domain as never),
      commands: new CasperCommandCache(host.ctx.storageDomain.get('casper_agent_commands') as never),
      models: new CasperModelsCache(host.ctx.storageDomain.get('casper_agent_models') as never),
    })
    await factory.dispose()
    await expect(factory.createAgent(host.ctx, { sessionId: SessionId('late-create') })).rejects.toThrow('not active')
    await expect(factory.resume(host.ctx, { resumeSessionId: SessionId('late-resume') })).rejects.toThrow('not active')
  })
})
