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
import { ConversationNodeAssembler, type TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { apply } from '../src/client/index.ts'
import { en, NS } from '../src/client/locales.ts'
import { receiptDefinition } from '../src/client/receipt-turn.ts'
import { ReceiptTail, type ReceiptTailProps } from '../src/client/ReceiptRow.tsx'
import { CASPER_RECEIPT, isReceiptCallId, receiptAcpId, type CasperReceipt } from '../src/receipt.ts'

afterEach(cleanup)

function translate(key: string, params?: Record<string, unknown>): string {
  const template = (en as Record<string, string>)[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (hole, name: string) => name in params ? String(params[name]) : hole)
}

/** A Casper turn as `turn.spec.ts` checks the turn writer records it: a call, the answer's text, then the receipt in a step of its own. */
const TURN = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/receipt-turn.json'), 'utf8')) as {
  readonly receipt: CasperReceipt
  readonly events: readonly SessionEvent[]
}
const RECEIPT = TURN.receipt
const RECEIPT_CALL = `casper:epoch:${receiptAcpId(1)}`
/** The step the turn writer gives the receipt, after the call's step and the answer's. */
const RECEIPT_STEP = 3

function at(seq: number, type: string, data: unknown, extra: Record<string, unknown> = {}): SessionLiveEventEntry {
  return { type: 'event', event: { seq, time: 1_700_000_000_000 + seq, type, data, ...extra } as SessionEvent }
}

function result(callId: string, text: string) {
  return {
    turn: 1, step: 2,
    message: { id: `result-${callId}`, role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: [{ type: 'text', text }], isError: false },
  }
}

/**
 * The recorded turn as the live window carries it.
 * @param meta - the receipt result's meta, or undefined for the turn without its receipt step.
 * @returns the turn's entries.
 */
function casperTurn(meta: unknown): SessionLiveEventEntry[] {
  return TURN.events
    .filter(event => meta !== undefined || !('step' in event.data && event.data.step === RECEIPT_STEP))
    .map(event => ({ type: 'event', event: {
      ...event,
      time: 1_700_000_000_000 + event.seq,
      ...event.type === 'tool/result' && event.data.step === RECEIPT_STEP ? { data: { ...event.data, meta } } : {},
    } as SessionEvent }))
}

function chat(entries: readonly SessionLiveEventEntry[]): ChatSnapshot {
  const definitions = [
    assistantDefinition, turnProcessDefinition, processEvidenceDefinition, toolDefinition, turnTailDefinition, receiptDefinition,
  ]
  const assembler = new ConversationNodeAssembler(
    { entries: () => definitions, fallbackEntry: () => undefined },
    { entries: () => [chatViewDefinition] },
  )
  assembler.replaceWindow(entries, false)
  assembler.activateTarget('chat')
  return assembler.snapshot('chat') as ChatSnapshot
}

function closedTurn(snapshot: ChatSnapshot): TurnLocation {
  const tail = snapshot.nodes.values().find(node => node.kind === 'turn-tail')
  if (tail === undefined || (tail.location.kind !== 'turn' && tail.location.kind !== 'step')) throw new Error('no closed turn')
  return tail.location.turn
}

/**
 * The tail entry's props for a Turn.
 * @param turn - the closed Turn.
 * @param inspect - whether the trajectory view is available, so the owner carries `inspectCall`.
 * @returns the props.
 */
function tailProps(turn: TurnLocation, inspect = true): ReceiptTailProps {
  const inspectCall = inspect ? vi.fn() : undefined
  return { turn, seq: TURN.events.at(-1)?.seq, openFile: vi.fn(), inspectCall, t: translate } as ReceiptTailProps
}

describe('the receipt at the turn\'s tail', () => {
  it('leaves the receipt call out of the steps and shows its verdict at the turn\'s tail', () => {
    const snapshot = chat(casperTurn(RECEIPT))
    const calls = snapshot.nodes.values().filter(node => node.kind === 'tool-call')
    // The read is still a step; the receipt is no call in a step, so no collapsed group holds it.
    expect(calls.map(node => node.id)).toEqual(['casper:epoch:casper-tool-1'])
    const turn = closedTurn(snapshot)
    expect(turn.data.get('casper-receipt')).toEqual({ callId: RECEIPT_CALL, receipt: RECEIPT, text: RECEIPT.text })
    const props = tailProps(turn)
    render(<ReceiptTail {...props} />)
    expect(screen.getByText('Verified: 1 check passed.')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button')[0] as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: 'Open src/a.ts' }))
    expect(props.openFile).toHaveBeenCalledWith('/work/project/src/a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Inspect call' }))
    expect(props.inspectCall).toHaveBeenCalledWith(RECEIPT_CALL)
  })

  it('shows no Inspect link while the trajectory view is unavailable', () => {
    render(<ReceiptTail {...tailProps(closedTurn(chat(casperTurn(RECEIPT))), false)} />)
    fireEvent.click(screen.getAllByRole('button')[0] as HTMLElement)
    expect(screen.getByRole('button', { name: 'Open src/a.ts' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Inspect call' })).toBeNull()
  })

  it('keeps the receipt\'s own step last in the turn, so the answer before it is not the turn\'s anchored answer', () => {
    const nodes = [...chat(casperTurn(RECEIPT)).nodes.values()]
    // The step's assistant message holds the receipt's call block, so the answer is not the turn's last step.
    expect(nodes.find(node => node.kind === 'turn-process')?.data).toMatchObject({ answerAnchorSeq: null, answerStep: null })
  })

  it('leaves the answer the turn\'s last row, so the turn can be forked from it', () => {
    const tail = chat(casperTurn(RECEIPT)).nodes.values().find(node => node.kind === 'turn-tail')?.data as TurnTailChatData
    // The receipt step's message holds only the claimed call, so it adds no row after the answer.
    expect(tail.closing?.blocks).toEqual([{ kind: 'text', text: 'Done.' }])
    expect(tail.branchUnavailable).toBe(false)
  })

  it('shows the receipt\'s text when its meta does not parse, and nothing for a turn without one', () => {
    const turn = closedTurn(chat(casperTurn({ outcome: 'verified' })))
    expect(turn.data.get('casper-receipt')).toEqual({ callId: RECEIPT_CALL, receipt: undefined, text: RECEIPT.text })
    const props = tailProps(turn)
    render(<ReceiptTail {...props} />)
    expect(document.querySelector('[data-tool="casper_receipt"]')?.getAttribute('data-state')).toBe('plain')
    fireEvent.click(screen.getAllByRole('button')[0] as HTMLElement)
    expect(document.querySelector('pre')?.textContent).toBe(RECEIPT.text)
    fireEvent.click(screen.getByRole('button', { name: 'Inspect call' }))
    expect(props.inspectCall).toHaveBeenCalledWith(RECEIPT_CALL)
    cleanup()
    const plain = closedTurn(chat(casperTurn(undefined)))
    expect(plain.data.get('casper-receipt')).toBeUndefined()
    expect(render(<ReceiptTail {...tailProps(plain)} />).container.innerHTML).toBe('')
  })

  it('claims only the receipt call and its result', () => {
    expect(isReceiptCallId(RECEIPT_CALL)).toBe(true)
    expect(isReceiptCallId(receiptAcpId(12))).toBe(true)
    expect(isReceiptCallId('casper:0a1b:casper-receipt-x')).toBe(false)
    expect(isReceiptCallId('casper:0a1b:read-1')).toBe(false)
    const call = at(1, 'tool/call', { turn: 1, step: 1, callId: 'c', name: 'read', arguments: '{}' }).event
    expect(receiptDefinition.match(call)).toBeNull()
    const replaced = at(2, 'tool/result', result(RECEIPT_CALL, 'x'), { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }).event
    expect(receiptDefinition.match(replaced)).toBeNull()
    expect(receiptDefinition.match(at(3, 'turn/start', { turn: 1 }).event)).toBeNull()
  })

  it('is registered as a turn tail entry beside the conversation definition', () => {
    const register = vi.fn((_options: Record<string, unknown>, _component: unknown) => () => {})
    const slots = { inject: vi.fn((_name: string, mount: () => () => void) => mount()), register }
    const locale = { register: vi.fn(() => () => {}) }
    const events = { register: vi.fn(() => () => {}) }
    apply({ slots, effect: (run: () => unknown) => run(), locale, uiConversation: { events } } as never)
    expect(events.register).toHaveBeenCalledWith(expect.objectContaining({ kind: 'casper-receipt', target: 'chat' }))
    expect(register.mock.calls.map(([options, component]) => [options, component]))
      .toContainEqual([{ name: 'conversation.chat.turnTail', id: CASPER_RECEIPT, locale: NS }, ReceiptTail])
  })
})
