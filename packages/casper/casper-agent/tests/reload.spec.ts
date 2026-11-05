import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolCall } from '@agentclientprotocol/sdk'
import { Context } from '@deepseek-ai/cordis'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { interruptedTurnClosers, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { TurnWriter } from '../src/turn.ts'
import { CasperAgent } from '../src/agent.ts'
import { boot, eventsOf, prompt, turnEnds } from './harness.ts'
import { fakeCasper } from './support.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * Store a Session's events with the JSONL backend the desktop app uses
 * (Zstandard) and read them back through the same read path that reopening
 * a stored Session takes, which validates every tool lifecycle.
 */
async function storeAndRead(session: Session): Promise<readonly SessionEvent[]> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-casper-reload-'))
  cleanups.push(() => { rmSync(root, { recursive: true, force: true }) })
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
  const writer = await ctx.sessionPersistence.create(session.header)
  await writer.append(session.snapshotEvents())
  await writer.close()
  const reader = await ctx.sessionPersistence.open(session.id, 'read')
  try {
    return (await reader.read()).events
  } finally {
    await reader.close()
  }
}

/** A writer on turn 1, step 1 over a fresh Session. */
function setup() {
  const session = Session.create(SessionId('casper-reload'))
  const frames: AssistantStreamFrame[] = []
  let attempt = 0
  let revision = 0
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const writer = new TurnWriter({
    session,
    emit: (frame) => { frames.push(frame) },
    turn: 1,
    step: 1,
    nextAttempt: () => ++attempt,
    nextRevision: () => ++revision,
    model: 'casper',
    callId: acpId => ToolCallId(`casper:epoch:${acpId}`),
  })
  const end = (): void => {
    writer.close(false)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  return { session, frames, writer, end }
}

function tool(id: string): ToolCall {
  return { toolCallId: id, title: `bash ${id}`, kind: 'execute', status: 'in_progress', rawInput: { tool: 'bash', target: id } }
}

/** The tool-call block ids of each assistant/message, in order. */
function advertised(events: readonly SessionEvent[]): string[][] {
  return events.flatMap(event => event.type === 'assistant/message'
    ? [event.data.message.content.flatMap(block => block.type === 'tool-call' ? [block.id] : [])]
    : [])
}

describe('a Casper turn read back from the stored log', { timeout: 60_000 }, () => {
  it('reads back calls that run at the same time, a check and an approval among them, and text that waited', async () => {
    const { session, frames, writer, end } = setup()
    writer.text('Looking.')
    writer.toolCall(tool('casper-tool-1'))
    writer.toolCall(tool('casper-tool-2'))
    writer.toolUpdate({ toolCallId: 'casper-tool-2', status: 'completed' })
    writer.toolCall({ toolCallId: 'casper-check-3', title: 'Check test', kind: 'execute', status: 'completed', rawOutput: { status: 'pass' } })
    writer.toolCall({ toolCallId: 'casper-approval-4', title: 'Run it?', kind: 'other', status: 'pending' })
    writer.question({ toolCallId: 'casper-approval-4', title: 'Run it?' })
    writer.toolUpdate({ toolCallId: 'casper-approval-4', status: 'completed' })
    writer.text('after')
    writer.toolUpdate({ toolCallId: 'casper-tool-1', status: 'completed' })
    end()
    const stored = await storeAndRead(session)
    expect(stored.map(event => event.type)).toEqual(session.snapshotEvents().map(event => event.type))
    expect(stored.filter(event => event.type !== 'turn/start' && event.type !== 'turn/end').map(event => event.type)).toEqual([
      'step/start',
      'assistant/message', 'tool/call',
      'assistant/message', 'tool/call', 'tool/result',
      'assistant/message', 'tool/call', 'tool/result',
      'assistant/message', 'tool/call', 'tool/result',
      'tool/result', 'step/end',
      'step/start', 'assistant/message', 'step/end',
    ])
    expect(advertised(stored)).toEqual([
      ['casper:epoch:casper-tool-1'], ['casper:epoch:casper-tool-2'], ['casper:epoch:casper-check-3'], ['casper:epoch:casper-approval-4'], [],
    ])
    const messages = stored.filter(event => event.type === 'assistant/message')
    expect(messages.map(event => event.type === 'assistant/message' && event.data.step)).toEqual([1, 1, 1, 1, 2])
    expect(messages[0]?.type === 'assistant/message' && messages[0].data.message.content[0]).toEqual({ type: 'text', text: 'Looking.' })
    expect(messages[4]?.type === 'assistant/message' && messages[4].data.message.content).toEqual([{ type: 'text', text: 'after' }])
    // Each assistant/message is its own attempt, committed in order.
    const starts = frames.filter(frame => frame.type === 'start')
    expect(new Set(starts.map(frame => frame.attemptId)).size).toBe(5)
    expect(frames.filter(frame => frame.type === 'end').map(frame => frame.type === 'end' && frame.outcome)).toEqual(
      messages.map(event => ({ kind: 'committed', eventType: 'assistant/message', seq: event.seq })),
    )
  })

  it('reads back a stop with several calls and an approval still open', async () => {
    const { session, writer } = setup()
    writer.text('Working.')
    writer.toolCall(tool('casper-tool-1'))
    writer.toolCall(tool('casper-tool-2'))
    writer.toolCall({ toolCallId: 'casper-approval-3', title: 'Run it?', kind: 'other', status: 'pending' })
    writer.question({ toolCallId: 'casper-approval-3', title: 'Run it?' })
    writer.text('stopping')
    writer.close(true)
    session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    const stored = await storeAndRead(session)
    expect(stored.map(event => event.type)).toEqual([
      'turn/start', 'step/start',
      'assistant/message', 'tool/call', 'assistant/message', 'tool/call', 'assistant/message', 'tool/call',
      'tool/result', 'tool/result', 'tool/result', 'step/end',
      'step/start', 'assistant/message', 'step/end', 'turn/end',
    ])
    const results = stored.flatMap(event => event.type === 'tool/result' ? [event.data.error?.code] : [])
    expect(results).toEqual(['TOOL_OUTCOME_UNKNOWN', 'TOOL_OUTCOME_UNKNOWN', 'TOOL_OUTCOME_UNKNOWN'])
    expect(stored.at(-3)?.type === 'assistant/message' && stored.at(-3)).toMatchObject({ data: { interrupted: true, message: { content: [{ type: 'text', text: 'stopping' }] } } })
  })

  it('lets resume repair close every call a host crash left open, then reads the repaired log back', async () => {
    const { session, writer } = setup()
    writer.text('Working.')
    writer.toolCall(tool('casper-tool-1'))
    writer.toolCall(tool('casper-tool-2'))
    // The host stops here without close(): the stored tail keeps both calls open.
    const crashed = await storeAndRead(session)
    const closers = interruptedTurnClosers(crashed)
    expect(closers.flatMap(event => event.type === 'tool/result' ? [event.data.message.toolCallId] : [])).toEqual([
      'casper:epoch:casper-tool-1', 'casper:epoch:casper-tool-2',
    ])
    const repaired = Session.create(SessionId('casper-reload'), [...crashed, ...closers])
    const stored = await storeAndRead(repaired)
    expect(stored.find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'interrupted' } } })
    expect(stored.filter(event => event.type === 'tool/result')).toHaveLength(2)
  })

  it('reopens a Casper Session after a restart when its turn ran calls at the same time', async () => {
    const fake = fakeCasper({ prompts: [[
      { text: 'Looking.\n' },
      { tool: 'bash', target: 'ls' },
      { tool: 'read', target: 'README.md' },
      { toolEnd: 2 },
      { check: 'test', status: 'pass' },
      { permission: 'Run it?' },
      { text: 'after\n' },
      { toolEnd: 1 },
    ]] })
    cleanups.push(() => { fake.remove() })
    const first = await boot(fake)
    const { agent } = await first.create('casper-parallel')
    agent.followup(prompt('look around'))
    await agent.whenIdle()
    const written = eventsOf(agent).map(event => event.type)
    expect(written.filter(type => type === 'tool/call')).toHaveLength(4)
    await first.ctx.fiber.dispose()

    const second = await boot(fake)
    cleanups.push(() => second.ctx.fiber.dispose())
    const resumed = (await second.ctx.agents.resume({ resumeSessionId: SessionId('casper-parallel'), agentPreset: 'casper' })).agent
    expect(resumed).toBeInstanceOf(CasperAgent)
    // Resuming only appends its own marker after the stored events.
    expect(eventsOf(resumed).map(event => event.type).slice(0, written.length)).toEqual(written)
    expect(turnEnds(resumed)).toEqual([{ kind: 'completed' }])
  })
})
