import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@agentclientprotocol/sdk'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { BridgedCall } from '../src/app-tools.ts'
import { OPEN_CALL_RESULT, TurnWriter } from '../src/turn.ts'
import { STEP_FAILED } from '../src/views.ts'

/** A writer on turn 1, step 1 over a fresh Session, with counters a test can share across writers. */
function setup(counters = { attempt: 0, revision: 0 }, session = Session.create(SessionId('turn-writer'))) {
  const frames: AssistantStreamFrame[] = []
  const open = (turn: number) => {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    return new TurnWriter({
      session,
      emit: (frame) => { frames.push(frame) },
      turn,
      step: 1,
      nextAttempt: () => ++counters.attempt,
      nextRevision: () => ++counters.revision,
      model: 'casper',
      callId: acpId => ToolCallId(`casper:epoch:${acpId}`),
    })
  }
  const events = (): readonly SessionEvent[] => session.snapshotEvents()
  const types = (): string[] => events().filter(event => event.type !== 'turn/start').map(event => event.type)
  return { session, frames, open, events, types }
}

function tool(id: string, extra: Partial<ToolCall> = {}): ToolCall {
  return { toolCallId: id, title: `bash ${id}`, kind: 'execute', status: 'in_progress', rawInput: { tool: 'bash', target: id }, ...extra }
}

function ofType<T extends SessionEvent['type']>(events: readonly SessionEvent[], type: T): Extract<SessionEvent, { type: T }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type)
}

describe('TurnWriter', () => {
  it('streams text into one attempt committed by assistant/message', () => {
    const { frames, open, events, types } = setup()
    const writer = open(1)
    writer.text('Hello ')
    writer.text('')
    writer.text('world')
    writer.close(false)
    expect(types()).toEqual(['step/start', 'assistant/message', 'step/end'])
    const message = ofType(events(), 'assistant/message')[0]
    expect(message?.data.message.content).toEqual([{ type: 'text', text: 'Hello world' }])
    expect(message?.data.message.source).toMatchObject({ kind: 'model', provider: 'casper', model: 'casper' })
    expect(frames.map(frame => frame.type)).toEqual(['start', 'chunk', 'chunk', 'chunk', 'chunk', 'end'])
    expect(frames.at(-1)).toMatchObject({ outcome: { kind: 'committed', eventType: 'assistant/message', seq: message?.seq } })
  })

  it('puts the tool block in step 1 and continues the text in step 2', () => {
    const { frames, open, events, types } = setup()
    const writer = open(1)
    writer.text('Looking.')
    writer.toolCall(tool('casper-tool-1'))
    writer.toolUpdate({ toolCallId: 'casper-tool-1', status: 'completed' })
    writer.text('Done.')
    writer.close(false)
    expect(types()).toEqual([
      'step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end',
      'step/start', 'assistant/message', 'step/end',
    ])
    const [first, second] = ofType(events(), 'assistant/message')
    expect(first?.data.step).toBe(1)
    expect(first?.data.message.content).toEqual([
      { type: 'text', text: 'Looking.' },
      { type: 'tool-call', id: 'casper:epoch:casper-tool-1', name: 'bash', arguments: JSON.stringify({ command: 'casper-tool-1', description: 'casper-tool-1' }) },
    ])
    expect(second?.data).toMatchObject({ step: 2, message: { content: [{ type: 'text', text: 'Done.' }] } })
    const call = ofType(events(), 'tool/call')[0]
    const result = ofType(events(), 'tool/result')[0]
    expect(call?.data).toMatchObject({ turn: 1, step: 1, callId: 'casper:epoch:casper-tool-1', name: 'bash' })
    // An older Casper's step that sent no output shows none, never the bare status word.
    expect(result?.data.message).toMatchObject({ toolCallId: 'casper:epoch:casper-tool-1', isError: false, content: [{ type: 'text', text: '' }] })
    expect(result?.data.error).toBeUndefined()
    expect(result?.data.meta).toBeUndefined()
    expect(result?.sourceEventSeqs).toEqual([call?.seq])
    expect(frames.filter(frame => frame.type === 'start').map(frame => frame.type === 'start' && frame.step)).toEqual([1, 2])
  })

  it('opens one step per consecutive tool, starting an attempt for a tool that opens a turn or step', () => {
    const { frames, open, events, types } = setup()
    const writer = open(1)
    writer.toolCall(tool('casper-tool-1'))
    writer.toolUpdate({ toolCallId: 'casper-tool-1', status: 'failed', rawOutput: { exit: 1 } })
    writer.toolCall(tool('casper-tool-2'))
    writer.toolUpdate({ toolCallId: 'casper-tool-2', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] })
    writer.toolCall({ toolCallId: 'casper-check-3', title: 'Check test: npm test', kind: 'execute', status: 'completed', rawOutput: { status: 'pass', exit: 0 } })
    writer.close(false)
    expect(types()).toEqual([
      'step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end',
      'step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end',
      'step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end',
    ])
    const ends = frames.filter(frame => frame.type === 'end')
    expect(frames.filter(frame => frame.type === 'start')).toHaveLength(3)
    expect(ends.map(frame => frame.type === 'end' && frame.outcome)).toEqual(
      ofType(events(), 'assistant/message').map(event => ({ kind: 'committed', eventType: 'assistant/message', seq: event.seq })),
    )
    const results = ofType(events(), 'tool/result').map(event => event.data)
    expect(results[0]).toMatchObject({ message: { isError: true, content: [{ type: 'text', text: STEP_FAILED }] }, error: { code: 'CASPER_TOOL_FAILED' } })
    expect(results[1]?.message.content).toEqual([{ type: 'text', text: 'ok' }])
    expect(results[2]?.message).toMatchObject({ isError: false, content: [{ type: 'text', text: 'Check test: npm test\n{"status":"pass","exit":0}' }] })
    expect(ofType(events(), 'tool/call')[2]?.data.name).toBe('casper_check')
  })

  it('marks a failed check as an error result', () => {
    const { open, events } = setup()
    const writer = open(1)
    writer.toolCall({ toolCallId: 'casper-check-1', title: 'Check lint', kind: 'execute', status: 'failed' })
    writer.close(false)
    expect(ofType(events(), 'tool/result')[0]?.data).toMatchObject({ message: { isError: true, content: [{ type: 'text', text: 'Check lint' }] } })
  })

  it('gives a concurrent call its own assistant/message in the same step and holds text until both calls close', () => {
    const { open, events, types } = setup()
    const writer = open(1)
    writer.toolCall(tool('casper-tool-1'))
    writer.toolCall(tool('casper-tool-2'))
    writer.toolCall(tool('casper-tool-2'))
    writer.text('waiting')
    writer.toolUpdate({ toolCallId: 'casper-tool-1', status: 'completed' })
    writer.toolUpdate({ toolCallId: 'casper-tool-1', status: 'completed' })
    writer.toolUpdate({ toolCallId: 'casper-tool-2', status: 'in_progress' })
    expect(types()).not.toContain('step/end')
    writer.toolUpdate({ toolCallId: 'casper-tool-2', status: 'completed' })
    writer.close(false)
    expect(types()).toEqual([
      'step/start', 'assistant/message', 'tool/call', 'assistant/message', 'tool/call', 'tool/result', 'tool/result', 'step/end',
      'step/start', 'assistant/message', 'step/end',
    ])
    const [first, second, third] = ofType(events(), 'assistant/message')
    expect(first?.data.message.content).toMatchObject([{ type: 'tool-call', id: 'casper:epoch:casper-tool-1' }])
    expect(second?.data).toMatchObject({ step: 1, message: { content: [{ type: 'tool-call', id: 'casper:epoch:casper-tool-2', name: 'bash' }] } })
    expect(second?.data.message.content).toHaveLength(1)
    expect(third?.data.message.content).toEqual([{ type: 'text', text: 'waiting' }])
  })

  it('closes calls still open when the prompt ends, then writes the text that waited for them into a final step', () => {
    const { open, events, types } = setup()
    const writer = open(1)
    writer.toolCall(tool('casper-tool-1'))
    writer.text('never closed')
    writer.close(false)
    expect(types()).toEqual(['step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end', 'step/start', 'assistant/message', 'step/end'])
    const call = ofType(events(), 'tool/call')[0]
    const result = ofType(events(), 'tool/result')[0]
    expect(result?.data).toMatchObject({
      step: 1,
      message: { toolCallId: call?.data.callId, isError: true, content: [{ type: 'text', text: OPEN_CALL_RESULT }] },
      error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
    })
    expect(result?.sourceEventSeqs).toEqual([call?.seq])
    expect(ofType(events(), 'assistant/message')[1]?.data.message.content).toEqual([{ type: 'text', text: 'never closed' }])
  })

  it('gives every call and approval still open at a stop exactly one result before step/end', () => {
    const { open, events, types } = setup()
    const writer = open(1)
    writer.text('Working.')
    writer.toolCall(tool('casper-tool-1'))
    writer.toolCall(tool('casper-tool-2'))
    writer.toolCall({ toolCallId: 'casper-approval-3', title: 'Run it?', kind: 'other', status: 'pending' })
    writer.question({ toolCallId: 'casper-approval-3', title: 'Run it?' })
    writer.close(true)
    expect(types()).toEqual([
      'step/start', 'assistant/message', 'tool/call', 'assistant/message', 'tool/call', 'assistant/message', 'tool/call',
      'tool/result', 'tool/result', 'tool/result', 'step/end',
    ])
    const calls = ofType(events(), 'tool/call')
    const results = ofType(events(), 'tool/result')
    expect(results.map(event => event.data.message.toolCallId)).toEqual(calls.map(event => event.data.callId))
    expect(results.map(event => event.sourceEventSeqs)).toEqual(calls.map(event => [event.seq]))
    expect(results.every(event => event.data.message.isError === true && event.data.error?.code === 'TOOL_OUTCOME_UNKNOWN')).toBe(true)
    expect(calls[2]?.data.name).toBe('casper_approval')
  })

  it('closes a refused approval without an error and names it as an approval', () => {
    const { open, events } = setup()
    const writer = open(1)
    writer.toolCall({ toolCallId: 'casper-approval-1', title: 'Write outside the project?', kind: 'other', status: 'pending',
      content: [{ type: 'content', content: { type: 'text', text: '/elsewhere' } }] })
    writer.question({ toolCallId: 'casper-approval-1', title: 'Write outside the project?' })
    writer.toolUpdate({ toolCallId: 'casper-approval-1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: '→ No' } }] })
    writer.close(false)
    const call = ofType(events(), 'tool/call')[0]
    expect(call?.data.name).toBe('casper_approval')
    expect(JSON.parse(call?.data.arguments ?? '{}')).toEqual({ title: 'Write outside the project?', preview: '/elsewhere' })
    expect(ofType(events(), 'tool/result')[0]?.data).toMatchObject({ message: { isError: false, content: [{ type: 'text', text: '→ No' }] } })
  })

  it('opens an approval call when the permission request names a step not seen before', () => {
    const { open, events } = setup()
    const writer = open(1)
    writer.question({ toolCallId: 'casper-approval-2', title: 'Reach 192.0.2.10?' })
    writer.toolUpdate({ toolCallId: 'casper-approval-2', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '→ Yes, this once' } }] })
    writer.question({ toolCallId: 'casper-approval-3' })
    writer.toolUpdate({ toolCallId: 'casper-approval-3', status: 'failed' })
    writer.question({ toolCallId: 'casper-approval-4' })
    writer.toolUpdate({ toolCallId: 'casper-approval-4', status: 'failed', rawOutput: { answer: 'no answer' } })
    writer.close(false)
    expect(ofType(events(), 'tool/call').map(event => event.data)).toMatchObject([
      { name: 'casper_approval', arguments: JSON.stringify({ title: 'Reach 192.0.2.10?' }) },
      { name: 'casper_approval', arguments: JSON.stringify({ title: '' }) },
      { name: 'casper_approval', arguments: JSON.stringify({ title: '' }) },
    ])
    expect(ofType(events(), 'tool/result').map(event => [event.data.message.isError, event.data.message.content])).toEqual([
      [false, [{ type: 'text', text: '→ Yes, this once' }]],
      [false, [{ type: 'text', text: '' }]],
      [false, [{ type: 'text', text: '{"answer":"no answer"}' }]],
    ])
  })

  it('names calls by kind when Casper sends no tool name', () => {
    const { open, events } = setup()
    const writer = open(1)
    writer.toolCall({ toolCallId: 'a', title: 'Web fetch', kind: 'fetch', status: 'in_progress', rawInput: ['not', 'an', 'object'] })
    writer.toolUpdate({ toolCallId: 'a', status: 'completed' })
    writer.toolCall({ toolCallId: 'b', title: 'Odd', status: 'in_progress', rawInput: { tool: 'Web Search!' } })
    writer.toolUpdate({ toolCallId: 'b', status: 'completed' })
    writer.toolCall({ toolCallId: 'c', title: 'Bare', status: 'in_progress' })
    writer.close(false)
    expect(ofType(events(), 'tool/call').map(event => event.data.name)).toEqual(['casper_fetch', 'casper_web_search_', 'casper_tool'])
    expect(JSON.parse(ofType(events(), 'tool/call')[0]?.data.arguments ?? '{}')).toEqual({ title: 'Web fetch' })
  })

  it('records an edit as Standard\'s edit with the patch hunks as its meta diffs', () => {
    const { open, events } = setup()
    const writer = open(1)
    writer.toolCall({
      toolCallId: 'casper-tool-1', title: 'edit src/sum.js', kind: 'edit', status: 'in_progress',
      rawInput: { path: 'src/sum.js', edits: [{ oldText: 'a - b', newText: 'a + b' }] },
      locations: [{ path: '/work/project/src/sum.js' }],
      _meta: { casper: { tool: 'edit', target: 'src/sum.js' } },
    })
    writer.toolUpdate({
      toolCallId: 'casper-tool-1', status: 'completed', rawOutput: { path: 'src/sum.js', added: 1, removed: 1 },
      content: [
        { type: 'diff', path: '/work/project/src/sum.js', oldText: 'one\na - b', newText: 'one\na + b' },
        { type: 'diff', path: '/work/project/src/sum.js', oldText: null, newText: '// sum' },
      ],
    })
    writer.close(false)
    const call = ofType(events(), 'tool/call')[0]
    expect(call?.data).toMatchObject({ name: 'edit', arguments: JSON.stringify({ file_path: 'src/sum.js', old_string: 'a - b', new_string: 'a + b' }) })
    expect(ofType(events(), 'tool/result')[0]?.data).toMatchObject({
      message: { isError: false, content: [{ type: 'text', text: 'Edited src/sum.js (+1 −1)' }] },
      meta: {
        path: '/work/project/src/sum.js',
        diffs: [
          { path: '/work/project/src/sum.js', oldText: 'one\na - b', newText: 'one\na + b' },
          { path: '/work/project/src/sum.js', oldText: null, newText: '// sum' },
        ],
      },
    })
  })

  it('records a shell step that exited 3 as a completed command, as Standard does', () => {
    const { open, events } = setup()
    const writer = open(1)
    writer.toolCall({ toolCallId: 'casper-tool-1', title: 'bash', kind: 'execute', status: 'in_progress', rawInput: { command: 'exit 3' }, _meta: { casper: { tool: 'bash' } } })
    writer.toolUpdate({ toolCallId: 'casper-tool-1', status: 'failed', rawOutput: { exitCode: 3 }, content: [{ type: 'content', content: { type: 'text', text: '```\nbye\n```' } }] })
    writer.close(false)
    const result = ofType(events(), 'tool/result')[0]?.data
    expect(result?.message).toMatchObject({ isError: false, content: [{ type: 'text', text: 'bye\n[exit code: 3]' }] })
    expect(result?.error).toBeUndefined()
  })

  it('records a bridged app call under the app tool\'s name with the app tool\'s own result', () => {
    const { open, events } = setup()
    const writer = open(1)
    const bridged = (meta: unknown): BridgedCall => ({
      name: 'plugin_manager', arguments: '{"action":"list_plugins"}',
      result: { content: [{ type: 'text', text: 'two plugins' }], isError: false, meta: { plugins: 2, of: meta } as never },
    })
    const appCall = (id: string): ToolCall => ({
      toolCallId: id, title: 'plugin_manager', kind: 'other', status: 'in_progress', rawInput: { action: 'list_plugins' },
      _meta: { casper: { tool: 'mcp', mcp: { server: 'acp-app', tool: 'plugin_manager' } } },
    })
    writer.toolCall(appCall('casper-tool-1'))
    writer.bridged('casper-tool-1', bridged('after'))
    writer.toolUpdate({ toolCallId: 'casper-tool-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Casper\'s copy' } }] })
    // The app's result can reach the writer before Casper's own tool_call.
    writer.bridged('casper-tool-2', bridged('before'))
    writer.toolCall(appCall('casper-tool-2'))
    writer.toolUpdate({ toolCallId: 'casper-tool-2', status: 'completed' })
    // A result for a step that never starts is dropped at the end of the prompt.
    writer.bridged('casper-tool-9', bridged('never'))
    writer.close(false)
    expect(ofType(events(), 'tool/call').map(event => [event.data.name, event.data.arguments])).toEqual([
      ['plugin_manager', '{"action":"list_plugins"}'], ['plugin_manager', '{"action":"list_plugins"}'],
    ])
    expect(ofType(events(), 'tool/result').map(event => [event.data.message.content, event.data.meta])).toEqual([
      [[{ type: 'text', text: 'two plugins' }], { plugins: 2, of: 'after' }],
      [[{ type: 'text', text: 'two plugins' }], { plugins: 2, of: 'before' }],
    ])
    const later = open(2)
    later.toolCall(appCall('casper-tool-9'))
    later.toolUpdate({ toolCallId: 'casper-tool-9', status: 'completed' })
    later.close(false)
    expect(ofType(events(), 'tool/result').at(-1)?.data.message.content).toEqual([{ type: 'text', text: '' }])
  })

  it('records a plan as the todo list', () => {
    const { open, events } = setup()
    const writer = open(1)
    writer.plan([
      { content: 'Do the task', priority: 'medium', status: 'completed' },
      { content: 'Run the project\'s checks', priority: 'medium', status: 'in_progress' },
    ])
    writer.close(false)
    expect(ofType(events(), 'todo/write')[0]?.data).toEqual({ todos: [
      { content: 'Do the task', status: 'completed' },
      { content: 'Run the project\'s checks', status: 'in_progress' },
    ] })
  })

  it('settles an interrupted prefix with interrupted: true', () => {
    const { frames, open, events } = setup()
    const writer = open(1)
    writer.text('partial')
    writer.close(true)
    expect(ofType(events(), 'assistant/message')[0]?.data).toMatchObject({ interrupted: true, message: { content: [{ type: 'text', text: 'partial' }] } })
    expect(frames.at(-1)).toMatchObject({ type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message' } })
  })

  it('opens no attempt for a step without text or tools, and settles nothing twice', () => {
    const { frames, open, events, types } = setup()
    const writer = open(1)
    writer.close(false)
    expect(types()).toEqual(['step/start', 'step/end'])
    expect(frames).toEqual([])
    const tooling = open(2)
    tooling.toolCall(tool('casper-tool-1'))
    tooling.toolUpdate({ toolCallId: 'casper-tool-1', status: 'completed' })
    tooling.close(true)
    expect(ofType(events(), 'assistant/message')).toHaveLength(1)
    expect(ofType(events(), 'assistant/attempt')).toHaveLength(0)
  })

  it('keeps revisions and attempt ids monotone across steps and turns', () => {
    const counters = { attempt: 0, revision: 0 }
    const { frames, open } = setup(counters)
    const first = open(1)
    first.text('a')
    first.toolCall(tool('casper-tool-1'))
    first.toolUpdate({ toolCallId: 'casper-tool-1', status: 'completed' })
    first.text('b')
    first.close(false)
    first.step satisfies number
    expect(first.step).toBe(2)
    const second = open(2)
    second.text('c')
    second.close(false)
    const revisions = frames.map(frame => frame.revision)
    expect(revisions).toEqual(revisions.map((_, index) => index + 1))
    expect(new Set(frames.filter(frame => frame.type === 'start').map(frame => frame.attemptId)).size).toBe(3)
  })
})
