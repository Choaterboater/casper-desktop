import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AGENT_MODELS_RECORD } from '@deepseek-ai/dsh-agent'
import { appendPluginRecord, buildForkSeed, pluginRecordOf, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { FORK_BEHIND_NOTICE, FORK_FRESH_NOTICE, FRESH_CONVERSATION_NOTICE } from '../src/agent.ts'
import { CONVERSATION_RECORD } from '../src/conversation.ts'
import { boot, eventsOf, prompt, turnEnds } from './harness.ts'
import type { Booted } from './harness.ts'
import { casperOptions, fakeCasper } from './support.ts'
import type { FakeCasper, FakeLogEntry, FakeScript } from './support.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Overrides = Parameters<typeof boot>[1]

async function setup(script: FakeScript, overrides: Overrides = {}) {
  const fake = fakeCasper(script)
  cleanups.push(() => { fake.remove() })
  const host = await bootOn(fake, overrides)
  return { fake, host }
}

async function bootOn(fake: FakeCasper, overrides: Overrides = {}): Promise<Booted> {
  const host = await boot(fake, overrides)
  cleanups.push(() => host.ctx.fiber.dispose())
  return host
}

async function run(agent: Agent, text: string): Promise<void> {
  agent.followup(prompt(text))
  await agent.whenIdle()
}

/** The `turn/end` events of a Session, in order. */
function turnEndEvents(agent: Agent): SessionEvent[] {
  return eventsOf(agent).filter(event => event.type === 'turn/end')
}

/**
 * Fork a Session as the app's fork command does: the inclusive prefix up to
 * `at`, its inherited marker and closers, on the source's folder and preset.
 */
async function forkOf(host: Booted, fake: FakeCasper, source: Agent, id: string, at: SessionEvent | undefined = eventsOf(source).at(-1)) {
  if (at === undefined) throw new Error('nothing to fork')
  const { agent } = await host.ctx.agents.create({
    sessionId: SessionId(id),
    seed: buildForkSeed(eventsOf(source), at.seq),
    inheritedEventCount: SessionLogOffset(at.seq + 1),
    meta: { cwd: fake.cwd, agentPreset: 'casper', isSeeded: true },
  })
  return agent
}

async function resume(host: Booted, id: string): Promise<Agent> {
  return (await host.ctx.agents.resume({ resumeSessionId: SessionId(id), agentPreset: 'casper' })).agent
}

/** The text of every assistant message in a Session, inherited ones included. */
function replyText(agent: Agent): string {
  return eventsOf(agent).flatMap(event => event.type === 'assistant/message'
    ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    : []).join('')
}

/** How many times the fork notice was written. */
function notices(agent: Agent): number {
  return replyText(agent).split(FORK_FRESH_NOTICE).length - 1
}

/** The conversation records a Session wrote itself, after what it inherited. */
function ownConversations(agent: Agent): unknown[] {
  return eventsOf(agent).flatMap((event) => {
    const record = pluginRecordOf(event)
    return record?.type === CONVERSATION_RECORD && event.seq >= agent.session.inheritedEventCount ? [record.data] : []
  })
}

/** The session methods one process was sent, in order. */
function opens(fake: FakeCasper, pid: number | undefined): (string | undefined)[] {
  return fake.log().filter((entry: FakeLogEntry) => entry.pid === pid && entry.method?.startsWith('session/') === true).map(entry => entry.method)
}

/** A source Session with two answered turns, marks `m1` and `m2`, and its Casper conversation id. */
async function twoTurns(host: Booted, id = 'casper-source') {
  const source = (await host.create(id)).agent
  await run(source, 'one')
  await run(source, 'two')
  const conversation = host.record(id)?.acpSessionId
  expect(conversation).toEqual(expect.any(String))
  return { source, conversation: conversation ?? '' }
}

/** The prompts a source with marks m1 and m2 plays, then the fork's. */
const MARKED = [[{ text: 'one\n' }, { mark: 'm1' }], [{ text: 'two\n' }, { mark: 'm2' }], [{ text: 'fork\n' }, { mark: 'f1' }], [{ mark: 'f2' }], [{ mark: 's3' }]]

describe('Forking a Casper Session', { timeout: 60_000 }, () => {
  it('copies Casper\'s conversation cut at the fork point\'s mark and goes on in the copy, leaving the source\'s alone', async () => {
    const { fake, host } = await setup({ prompts: MARKED, fork: true, forkSessionId: 'copy-1' })
    const { source, conversation } = await twoTurns(host)
    const sourceRecord = host.record('casper-source')
    // The footer's branch button on turn 1 forks at that turn's end.
    const fork = await forkOf(host, fake, source, 'casper-fork', turnEndEvents(source)[0])
    await run(fork, 'go on')
    expect(fake.calls('session/fork').map(entry => entry.params)).toEqual([
      { sessionId: conversation, cwd: fake.cwd, mcpServers: [], _meta: { casper: { at: 'm1' } } },
    ])
    const forkPid = fake.calls('session/fork')[0]?.pid
    expect(opens(fake, forkPid)).toEqual(['session/fork', 'session/prompt'])
    expect(fake.calls('session/prompt').at(-1)?.params?.sessionId).toBe('copy-1')
    expect(host.record('casper-fork')).toEqual({ acpSessionId: 'copy-1', cwd: fake.cwd })
    expect(host.record('casper-source')).toEqual(sourceRecord)
    expect(ownConversations(fork)).toEqual([{ acpSessionId: 'copy-1', mark: 'f1' }])
    expect(notices(fork)).toBe(0)
    expect(replyText(fork)).not.toContain(FRESH_CONVERSATION_NOTICE)
    expect(turnEnds(fork).at(-1)).toEqual({ kind: 'completed' })
    // The fork's next turn stays on its copy, and the source goes on in its own conversation.
    await run(fork, 'again')
    await run(source, 'three')
    expect(fake.calls('session/prompt').slice(-2).map(entry => entry.params?.sessionId)).toEqual(['copy-1', conversation])
    expect(fake.calls('session/fork')).toHaveLength(1)
    expect(fake.calls('session/load')).toEqual([])
  })

  it('a fork after a turn Casper failed during copies up to the turn before and says once that Casper may not have that request', async () => {
    const { fake, host } = await setup({ prompts: [[{ text: 'one\n' }, { mark: 'm1' }], [{ fail: 'runtime failed' }], [{ text: 'fork\n' }, { mark: 'f1' }], [{ mark: 'f2' }]], fork: true })
    const source = (await host.create('casper-failed')).agent
    await run(source, 'one')
    await run(source, 'two')
    expect(turnEnds(source).at(-1)).toMatchObject({ kind: 'error' })
    const fork = await forkOf(host, fake, source, 'casper-fork-failed')
    await run(fork, 'go on')
    await run(fork, 'again')
    expect(fake.calls('session/fork').map(entry => entry.params?.['_meta'])).toEqual([{ casper: { at: 'm1' } }])
    expect(replyText(fork).split(FORK_BEHIND_NOTICE).length - 1).toBe(1)
    expect(notices(fork)).toBe(0)
    // A fork made before the failed turn is exact, so it says nothing.
    const early = await forkOf(host, fake, source, 'casper-fork-early', turnEndEvents(source)[0])
    await run(early, 'from one')
    expect(replyText(early)).not.toContain(FORK_BEHIND_NOTICE)
  })

  it('a fork of the whole Session copies up to the last reply\'s mark', async () => {
    const { fake, host } = await setup({ prompts: MARKED, fork: true })
    const { source, conversation } = await twoTurns(host)
    const fork = await forkOf(host, fake, source, 'casper-fork-whole')
    await run(fork, 'go on')
    expect(fake.calls('session/fork').map(entry => entry.params?.['_meta'])).toEqual([{ casper: { at: 'm2' } }])
    expect(fake.calls('session/fork')[0]?.params?.sessionId).toBe(conversation)
    const copy = host.record('casper-fork-whole')?.acpSessionId
    expect(copy).not.toBe(conversation)
    expect(fake.calls('session/prompt').at(-1)?.params?.sessionId).toBe(copy)
    expect(notices(fork)).toBe(0)
  })

  it('hands the copy the app\'s servers as session/new does', async () => {
    const { fake, host } = await setup({ prompts: MARKED, fork: true }, { appTools: true })
    const { source } = await twoTurns(host)
    const fork = await forkOf(host, fake, source, 'casper-fork-servers')
    await run(fork, 'go on')
    const names = (entry: FakeLogEntry | undefined) => ((entry?.params?.['mcpServers'] ?? []) as { name: string }[]).map(server => server.name)
    expect(names(fake.calls('session/fork')[0])).toEqual(['app'])
    expect(names(fake.calls('session/fork')[0])).toEqual(names(fake.calls('session/new')[0]))
  })

  it('after a restart the fork reopens its own copy and the source its own conversation', async () => {
    const { fake, host } = await setup({ prompts: MARKED, fork: true, forkSessionId: 'copy-1' })
    const { source, conversation } = await twoTurns(host)
    const fork = await forkOf(host, fake, source, 'casper-fork-reopen', turnEndEvents(source)[0])
    await run(fork, 'go on')
    await host.ctx.fiber.dispose()

    const second = await bootOn(fake)
    const reopenedFork = await resume(second, 'casper-fork-reopen')
    await run(reopenedFork, 'again')
    const reopenedSource = await resume(second, 'casper-source')
    await run(reopenedSource, 'three')
    expect(fake.calls('session/load').map(entry => entry.params?.sessionId)).toEqual(['copy-1', conversation])
    expect(fake.calls('session/prompt').slice(-2).map(entry => entry.params?.sessionId)).toEqual(['copy-1', conversation])
    expect(fake.calls('session/fork')).toHaveLength(1)
    expect(notices(reopenedFork)).toBe(0)
  })

  it('a fork that lost its own record after its first turn never copies again', async () => {
    const { fake, host } = await setup({ prompts: MARKED, fork: true, forkSessionId: 'copy-1' })
    const { source } = await twoTurns(host)
    const fork = await forkOf(host, fake, source, 'casper-fork-lost', turnEndEvents(source)[0])
    await run(fork, 'go on')
    await host.ctx.storageDomain.get('casper_agent')?.table('sessions').deleteMany(['casper-fork-lost'])
    await host.ctx.fiber.dispose()

    const second = await bootOn(fake)
    const reopened = await resume(second, 'casper-fork-lost')
    await run(reopened, 'again')
    expect(fake.calls('session/fork')).toHaveLength(1)
    expect(fake.calls('session/load')).toEqual([])
    expect(second.record('casper-fork-lost')?.acpSessionId).not.toBe('copy-1')
    expect(notices(reopened)).toBe(0)
  })

  it('a fork reopened before its first turn still copies the conversation', async () => {
    const { fake, host } = await setup({ prompts: MARKED, fork: true, forkSessionId: 'copy-1' })
    const { source, conversation } = await twoTurns(host)
    await forkOf(host, fake, source, 'casper-fork-early', turnEndEvents(source)[0])
    await host.ctx.fiber.dispose()

    const second = await bootOn(fake)
    const fork = await resume(second, 'casper-fork-early')
    await run(fork, 'go on')
    expect(fake.calls('session/fork').map(entry => [entry.params?.sessionId, entry.params?.['_meta']])).toEqual([
      [conversation, { casper: { at: 'm1' } }],
    ])
    expect(second.record('casper-fork-early')).toEqual({ acpSessionId: 'copy-1', cwd: fake.cwd })
    expect(notices(fork)).toBe(0)
  })

  describe('starts a fresh Casper conversation with one notice line', () => {
    /** Check a fork that started fresh: session/new on its own process, the notice once, and never the source's conversation. */
    async function expectFresh(fake: FakeCasper, host: Booted, fork: Agent, conversation: string, forks: number) {
      await run(fork, 'go on')
      await run(fork, 'again')
      const forkPid = fake.calls('session/prompt').at(-1)?.pid
      expect(opens(fake, forkPid)).toEqual([...forks > 0 ? ['session/fork'] : [], 'session/new', 'session/prompt', 'session/prompt'])
      expect(fake.calls('session/fork')).toHaveLength(forks)
      expect(fake.calls('session/load')).toEqual([])
      const own = host.record(fork.id)?.acpSessionId
      expect(own).toEqual(expect.any(String))
      expect(own).not.toBe(conversation)
      expect(fake.calls('session/prompt').slice(-2).map(entry => entry.params?.sessionId)).toEqual([own, own])
      expect(notices(fork)).toBe(1)
      expect(replyText(fork)).not.toContain(FRESH_CONVERSATION_NOTICE)
      expect(turnEnds(fork).slice(-2)).toEqual([{ kind: 'completed' }, { kind: 'completed' }])
    }

    it('when Casper does not offer session/fork', async () => {
      const { fake, host } = await setup({ prompts: MARKED })
      const { source, conversation } = await twoTurns(host)
      await expectFresh(fake, host, await forkOf(host, fake, source, 'casper-fork-old'), conversation, 0)
    })

    it('when Casper\'s runtime cannot fork (-32601)', async () => {
      const { fake, host } = await setup({ prompts: MARKED, fork: true, forkError: { code: -32601, message: 'Method not found' } })
      const { source, conversation } = await twoTurns(host)
      await expectFresh(fake, host, await forkOf(host, fake, source, 'casper-fork-cannot'), conversation, 1)
    })

    it('when Casper has no such conversation (-32002)', async () => {
      const { fake, host } = await setup({ prompts: MARKED, fork: true })
      const { source } = await twoTurns(host)
      appendPluginRecord(source.session, CONVERSATION_RECORD, { acpSessionId: 'gone-conversation', mark: 'm2' })
      const fork = await forkOf(host, fake, source, 'casper-fork-gone')
      await expectFresh(fake, host, fork, 'gone-conversation', 1)
      expect(fake.calls('session/fork')[0]?.params?.sessionId).toBe('gone-conversation')
    })

    it('when the mark is not in Casper\'s conversation (-32602)', async () => {
      const { fake, host } = await setup({ prompts: MARKED, fork: true })
      const { source, conversation } = await twoTurns(host)
      appendPluginRecord(source.session, CONVERSATION_RECORD, { acpSessionId: conversation, mark: 'not-a-point' })
      await expectFresh(fake, host, await forkOf(host, fake, source, 'casper-fork-no-point'), conversation, 1)
      expect(fake.calls('session/fork')[0]?.params?.['_meta']).toEqual({ casper: { at: 'not-a-point' } })
    })

    it('when the last reply before the fork point sent no mark', async () => {
      const { fake, host } = await setup({ prompts: [[{ mark: 'm1' }], [], [], []], fork: true })
      const { source, conversation } = await twoTurns(host)
      await expectFresh(fake, host, await forkOf(host, fake, source, 'casper-fork-unmarked'), conversation, 0)
    })

    it('when the fork point comes before any Casper reply', async () => {
      const { fake, host } = await setup({ prompts: MARKED, fork: true })
      const { source, conversation } = await twoTurns(host)
      const fork = await forkOf(host, fake, source, 'casper-fork-before', eventsOf(source)[0])
      await expectFresh(fake, host, fork, conversation, 0)
    })

    it('with copyOnFork off, never sending session/fork', async () => {
      const { fake, host } = await setup({ prompts: MARKED, fork: true }, { copyOnFork: false })
      const { source, conversation } = await twoTurns(host)
      await expectFresh(fake, host, await forkOf(host, fake, source, 'casper-fork-off'), conversation, 0)
    })
  })

  it('another failure ends the turn, records nothing, and the next turn copies again', async () => {
    const script: FakeScript = { prompts: MARKED, fork: true, forkSessionId: 'copy-1' }
    const { fake, host } = await setup({ ...script, forkError: { code: -32603, message: 'disk full' } })
    const { source, conversation } = await twoTurns(host)
    const fork = await forkOf(host, fake, source, 'casper-fork-failed', turnEndEvents(source)[0])
    await run(fork, 'go on')
    expect(turnEnds(fork).at(-1)).toMatchObject({ kind: 'error', error: { code: 'CASPER_START_FAILED' } })
    expect(host.record('casper-fork-failed')).toBeUndefined()
    expect(fake.calls('session/new')).toHaveLength(1)
    fake.script(script)
    await run(fork, 'again')
    expect(fake.calls('session/fork').map(entry => [entry.params?.sessionId, entry.params?.['_meta']])).toEqual([
      [conversation, { casper: { at: 'm1' } }], [conversation, { casper: { at: 'm1' } }],
    ])
    expect(host.record('casper-fork-failed')).toEqual({ acpSessionId: 'copy-1', cwd: fake.cwd })
    expect(turnEnds(fork).at(-1)).toEqual({ kind: 'completed' })
    expect(notices(fork)).toBe(0)
  })

  it('a fork that already has a conversation of its own in another folder starts fresh without copying or a notice', async () => {
    const { fake, host } = await setup({ prompts: MARKED, fork: true })
    const { source } = await twoTurns(host)
    const fork = await forkOf(host, fake, source, 'casper-fork-moved')
    await host.ctx.storageDomain.get('casper_agent')?.table('sessions').put('casper-fork-moved', { acpSessionId: 'elsewhere', cwd: `${fake.cwd}-old` })
    await run(fork, 'go on')
    expect(fake.calls('session/fork')).toEqual([])
    expect(fake.calls('session/load')).toEqual([])
    expect(fake.calls('session/new')).toHaveLength(2)
    expect(notices(fork)).toBe(0)
    expect(host.record('casper-fork-moved')?.cwd).toBe(fake.cwd)
  })

  it('the fork\'s model picker keeps the source\'s model until its Casper reports', async () => {
    const { fake, host } = await setup({ prompts: MARKED, fork: true, configOptions: casperOptions('claude-subscription/claude-opus-5-5') })
    const { source } = await twoTurns(host)
    const fork = await forkOf(host, fake, source, 'casper-fork-picker')
    const added = eventsOf(fork)
      .filter(event => event.seq >= fork.session.inheritedEventCount && pluginRecordOf(event)?.type === AGENT_MODELS_RECORD)
    expect(added).toEqual([])
    expect(fork.model.current()).toEqual(source.model.current())
    expect(fork.model.current()).toMatchObject({ provider: 'claude-subscription', model: 'claude-opus-5-5' })
  })
})
