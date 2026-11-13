// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatSnapshot, TurnTailChatData } from '@deepseek-ai/dsh-client-ui-chat/client'
import { assistantDefinition } from '@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/assistant.ts'
import { chatViewDefinition } from '@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { toolDefinition } from '@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/tool.ts'
import { processEvidenceDefinition, turnProcessDefinition } from '@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/turn-process.ts'
import { turnTailDefinition } from '@deepseek-ai/dsh-client-ui-chat/src/client/conversation-nodes/turn-tail.ts'
import { ConversationNodeAssembler, type ConversationNodeContext } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import {
  checkChatDefinition, checkTitle, checkViewDefinition, checksViewDefinition, EMPTY_CHECKS_SNAPSHOT,
  type CasperCheck, type CasperChecksSnapshot,
} from '../src/client/check-calls.ts'
import { ChecksView, checksByTurn, type ChecksViewProps } from '../src/client/ChecksView.tsx'
import { apply } from '../src/client/index.ts'
import { en, NS } from '../src/client/locales.ts'
import { receiptDefinition } from '../src/client/receipt-turn.ts'

afterEach(cleanup)

function translate(key: string, params?: Record<string, unknown>): string {
  const template = (en as Record<string, string>)[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (hole, name: string) => name in params ? String(params[name]) : hole)
}

/** A Casper turn as `turn.spec.ts` checks the turn writer records it: a call, the answer's text, then the receipt in a step of its own. */
const TURN = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/receipt-turn.json'), 'utf8')) as {
  readonly events: readonly SessionEvent[]
}
const CHECK = 'casper:epoch:casper-tool-2'
/** The last seq of the answer's step; the check's step follows it. */
const ANSWER_END = 8
/** Events the check's step adds before the receipt's step. */
const CHECK_EVENTS = 5

function entry(seq: number, type: string, data: unknown, extra: Record<string, unknown> = {}): SessionLiveEventEntry {
  return { type: 'event', event: { seq, time: 1_700_000_000_000 + seq, type, data, ...extra } as SessionEvent }
}

/** A check's recorded result. */
interface CheckResult {
  readonly text: string
  readonly isError: boolean
}

/**
 * The step the turn writer records for a check Casper runs after its answer.
 * @param result - the check's result, or null while it runs.
 * @returns the step's entries, at the seqs after the answer's step.
 */
function checkStep(result: CheckResult | null): SessionLiveEventEntry[] {
  const at = ANSWER_END + 1
  const args = JSON.stringify({ title: 'casper_check test' })
  return [
    entry(at, 'step/start', { turn: 1, step: 3 }),
    entry(at + 1, 'assistant/message', { turn: 1, step: 3, message: {
      id: 'check-message', role: 'assistant', source: { kind: 'model', provider: 'casper', model: 'casper' },
      content: [{ type: 'tool-call', id: CHECK, name: 'casper_check', arguments: args }],
    } }),
    entry(at + 2, 'tool/call', { turn: 1, step: 3, callId: CHECK, name: 'casper_check', arguments: args }),
    ...result === null ? [] : [entry(at + 3, 'tool/result', { turn: 1, step: 3, message: {
      id: `result-${CHECK}`, role: 'tool', toolCallId: CHECK, source: { kind: 'tool', callId: CHECK },
      content: [{ type: 'text', text: result.text }], isError: result.isError,
    } }, { surfaceOp: 'append' })],
    entry(at + 4, 'step/end', { turn: 1, step: 3 }),
  ]
}

const PASSED: CheckResult = { text: 'casper_check test\n{"status":"pass"}', isError: false }

/**
 * The recorded turn with a check after its answer.
 * @param result - the check's result, or null while it runs.
 * @returns the turn's entries.
 */
function turnWithCheck(result: CheckResult | null = PASSED): SessionLiveEventEntry[] {
  const events = TURN.events.map(event => ({ ...event, time: 1_700_000_000_000 + event.seq }))
  const before = events.filter(event => event.seq <= ANSWER_END)
  const after = events.filter(event => event.seq > ANSWER_END).map(event => ({
    ...event,
    seq: event.seq + CHECK_EVENTS,
    ...'step' in event.data ? { data: { ...event.data, step: 4 } } : {},
  }) as SessionEvent)
  return [
    ...before.map(event => ({ type: 'event' as const, event })),
    ...checkStep(result),
    ...after.map(event => ({ type: 'event' as const, event })),
  ]
}

function assembler(entries: readonly SessionLiveEventEntry[]): ConversationNodeAssembler {
  const definitions = [
    assistantDefinition, turnProcessDefinition, processEvidenceDefinition, toolDefinition, turnTailDefinition,
    receiptDefinition, checkChatDefinition, checkViewDefinition,
  ]
  const built = new ConversationNodeAssembler(
    { entries: () => definitions, fallbackEntry: () => undefined },
    { entries: () => [chatViewDefinition, checksViewDefinition] },
  )
  built.replaceWindow(entries, false)
  return built
}

function chat(entries: readonly SessionLiveEventEntry[]): ChatSnapshot {
  const built = assembler(entries)
  built.activateTarget('chat')
  return built.snapshot('chat') as ChatSnapshot
}

function checks(entries: readonly SessionLiveEventEntry[]): CasperChecksSnapshot {
  const built = assembler(entries)
  built.activateTarget('casper-checks')
  return built.snapshot('casper-checks') as CasperChecksSnapshot
}

describe('Casper checks', () => {
  it('leaves a check Casper runs after its answer out of the Chat, so the turn can be forked from its answer', () => {
    const snapshot = chat(turnWithCheck())
    const calls = snapshot.nodes.values().filter(node => node.kind === 'tool-call').map(node => node.id)
    expect([...calls]).toEqual(['casper:epoch:casper-tool-1'])
    const tail = snapshot.nodes.values().find(node => node.kind === 'turn-tail')?.data as TurnTailChatData
    expect(tail.closing?.blocks).toEqual([{ kind: 'text', text: 'Done.' }])
    expect(tail.branchUnavailable).toBe(false)
  })

  it('lists each check on the Checks target with its verdict and output', () => {
    expect(checks(turnWithCheck()).checks).toEqual([{
      callId: CHECK, turn: 1, seq: ANSWER_END + 3, title: 'casper_check test', status: 'passed',
      output: 'casper_check test\n{"status":"pass"}',
    }])
    expect(checks(turnWithCheck({ text: 'casper_check test failed', isError: true })).checks[0]).toMatchObject({ status: 'failed' })
    expect(checks(turnWithCheck(null)).checks[0]).toMatchObject({ status: 'running', output: '' })
    expect(checks(TURN.events.map(event => ({ type: 'event' as const, event }))).checks).toEqual([])
  })

  it('matches only check calls and the appended results of calls it matched', () => {
    const call = entry(1, 'tool/call', { turn: 1, step: 1, callId: 'casper:x:read', name: 'read', arguments: '{}' }).event
    expect(checkChatDefinition.match(call)).toBeNull()
    const check = entry(2, 'tool/call', { turn: 1, step: 1, callId: 'casper:x:check', name: 'casper_check', arguments: '{}' }).event
    expect(checkChatDefinition.match(check)).toEqual({ id: 'casper:x:check', role: 'start', exclusive: true })
    expect(checkViewDefinition.match(check)).toEqual({ id: 'casper:x:check', role: 'start' })
    const message = (callId: string) => ({ turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId }, content: [] } })
    expect(checkChatDefinition.match(entry(3, 'tool/result', message('casper:x:check'), { surfaceOp: 'append' }).event))
      .toEqual({ id: 'casper:x:check', role: 'update', exclusive: true })
    expect(checkChatDefinition.match(entry(4, 'tool/result', message('casper:x:read'), { surfaceOp: 'append' }).event)).toBeNull()
    const replaced = entry(5, 'tool/result', message('casper:x:check'), { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 } }).event
    expect(checkChatDefinition.match(replaced)).toBeNull()
    expect(checkChatDefinition.match(entry(6, 'turn/start', { turn: 1 }).event)).toBeNull()
  })

  it('keeps a started state and builds no node for a Context without its call', () => {
    const empty = { key: 'k', kind: 'casper-check', id: 'k', matches: [], start: undefined, state: undefined, current: new Map() } as ConversationNodeContext<object>
    const match = entry(1, 'turn/start', { turn: 1 })
    const state = {}
    expect(checkChatDefinition.update({ ...empty, state }, match as never)).toBe(state)
    expect(checkViewDefinition.update({ ...empty, state }, match as never)).toBe(state)
    expect(checkViewDefinition.buildViewNode?.(empty)).toBeNull()
    expect(checkChatDefinition.buildViewNode?.(empty)).toBeNull()
  })

  it('reads the check\'s title from its arguments', () => {
    expect(checkTitle('{"title":"npm test"}')).toBe('npm test')
    expect(checkTitle('{"title":1}')).toBe('')
    expect(checkTitle('[]')).toBe('')
    expect(checkTitle('null')).toBe('')
    expect(checkTitle('not json')).toBe('')
  })

  it('keeps the target\'s snapshot when an update changes no check, and Session order when one does', () => {
    const builder = checksViewDefinition.create()
    expect(builder.apply({ upserts: [], timeline: undefined as never })).toBe(EMPTY_CHECKS_SNAPSHOT)
    const node = (key: string, seq: number, status: CasperCheck['status']) => ({
      key, kind: 'casper-check', id: key, target: 'casper-checks' as const, data: check({ callId: key, seq, status }),
    })
    builder.replace({ nodes: [node('late', 9, 'passed'), node('early', 2, 'running')], timeline: undefined as never })
    const updated = builder.apply({ upserts: [node('early', 2, 'failed')], timeline: undefined as never })
    expect(updated.checks.map(item => [item.callId, item.status])).toEqual([['early', 'failed'], ['late', 'passed']])
  })
})

function check(overrides: Partial<CasperCheck>): CasperCheck {
  return { callId: 'c1', turn: 1, seq: 1, title: 'npm test', status: 'passed', output: 'ok', ...overrides }
}

function viewProps(list: readonly CasperCheck[], inspectCall: ((callId: string) => void) | undefined): ChecksViewProps {
  const snapshot: CasperChecksSnapshot = { checks: list }
  return {
    useCasperChecks: (select: (value: CasperChecksSnapshot) => unknown) => select(snapshot),
    inspectCall, t: translate,
  } as never
}

describe('the Checks view', () => {
  it('says so when the Session has no check', () => {
    render(<ChecksView {...viewProps([], undefined)} />)
    expect(screen.getByText('No checks have run in this Session.')).toBeTruthy()
  })

  it('groups checks by turn and opens a finished check\'s output and Inspect link', () => {
    const inspectCall = vi.fn()
    render(<ChecksView {...viewProps([
      check({}), check({ callId: 'c2', seq: 2, title: '', status: 'failed', output: 'exit 1' }),
      check({ callId: 'c3', turn: 2, seq: 3, title: 'lint', status: 'running', output: '' }),
    ], inspectCall)} />)
    expect(screen.getAllByRole('heading').map(node => node.textContent)).toEqual(['Turn 1', 'Turn 2'])
    expect(screen.getByText('Check')).toBeTruthy()
    expect(document.querySelector('[data-check="c2"] [data-verdict="failed"]')?.textContent).toBe('failed')
    expect(document.querySelector('[data-check="c3"] [data-verdict="running"]')?.textContent).toBe('running')
    fireEvent.click(screen.getByText('npm test'))
    expect(screen.getByText('ok')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Inspect call' }))
    expect(inspectCall).toHaveBeenCalledWith('c1')
  })

  it('shows no Inspect link while the trajectory view is unavailable', () => {
    render(<ChecksView {...viewProps([check({})], undefined)} />)
    fireEvent.click(screen.getByText('npm test'))
    expect(screen.queryByRole('button', { name: 'Inspect call' })).toBeNull()
  })

  it('keeps Session order within each turn', () => {
    expect(checksByTurn([check({}), check({ callId: 'c2', turn: 2 }), check({ callId: 'c3' })]).map(([turn, list]) =>
      [turn, list.map(item => item.callId)])).toEqual([[1, ['c1', 'c3']], [2, ['c2']]])
  })
})

describe('the Checks view registration', () => {
  it('registers the view after the trajectory view with one snapshot source per Session binding', () => {
    const register = vi.fn((_options: Record<string, unknown>, _component: unknown) => () => {})
    const slots = { inject: vi.fn((_name: string, mount: () => () => void) => mount()), register }
    const t = vi.fn(() => 'Checks')
    const locale = { register: vi.fn(() => () => {}), bind: vi.fn(() => t) }
    const published = { checks: [check({})] }
    const state: { snapshot?: CasperChecksSnapshot } = {}
    const target = { getSnapshot: () => state.snapshot, subscribe: vi.fn(() => () => {}) }
    const uiConversation = {
      events: { register: vi.fn(() => () => {}) },
      views: { register: vi.fn(() => () => {}) },
      binding: vi.fn(() => ({ target: () => target })),
    }
    const binding = { sessionId: 's1' }
    const sessions = { binding: vi.fn((id: string) => id === 's1' ? binding : undefined) }
    apply({ slots, effect: (run: () => unknown) => run(), locale, uiConversation, sessions, inject: () => {} } as never)
    expect(uiConversation.events.register).toHaveBeenCalledWith(expect.objectContaining({ kind: 'casper-check-chat', target: 'chat' }))
    expect(uiConversation.events.register).toHaveBeenCalledWith(expect.objectContaining({ kind: 'casper-check', target: 'casper-checks' }))
    expect(uiConversation.views.register).toHaveBeenCalledWith(checksViewDefinition)
    const [options, component] = register.mock.calls.find(([candidate]) => candidate.name === 'conversation.view') ?? []
    expect(component).toBe(ChecksView)
    expect(options).toMatchObject({ id: 'casper-checks', order: 20, locale: NS })
    interface Source { getSnapshot: () => unknown; subscribe: (listener: () => void) => () => void }
    const view = options as { label: () => string; inject: (id: string) => { hooks: { casperChecks: Source } } }
    expect(view.label()).toBe('Checks')
    expect(t).toHaveBeenCalledWith('checks.view')
    const source = view.inject('s1').hooks.casperChecks
    expect(view.inject('s1').hooks.casperChecks).toBe(source)
    expect(uiConversation.binding).toHaveBeenCalledTimes(1)
    expect(source.getSnapshot()).toBe(EMPTY_CHECKS_SNAPSHOT)
    state.snapshot = published
    expect(source.getSnapshot()).toBe(published)
    const listener = vi.fn()
    source.subscribe(listener)
    expect(target.subscribe).toHaveBeenCalledWith(listener)
    expect(() => view.inject('gone')).toThrow('casper-agent: session "gone" is unavailable')
  })
})
