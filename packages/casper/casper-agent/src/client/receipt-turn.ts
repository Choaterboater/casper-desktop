/**
 * Casper's receipt as its Turn's data: the `casper_receipt` call and its
 * result are claimed on the Chat target, so no step holds them and no
 * collapsed group hides the verdict, and the receipt is published on its
 * Turn for the card at the Turn's tail.
 * @module @deepseek-ai/dsh-casper-agent/client/receipt-turn
 */
import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition, ToolResultNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CASPER_RECEIPT, isReceiptCallId, recordedReceipt, type CasperReceipt } from '../receipt.ts'

/** A Turn's receipt as its card reads it. */
export interface ReceiptTurnData {
  /** The receipt call's id, for its Inspect link. */
  readonly callId: string
  /** The receipt; undefined when the result's meta does not parse. */
  readonly receipt: CasperReceipt | undefined
  /** The receipt's text, shown when the meta does not parse. */
  readonly text: string
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** Casper's receipt for this Turn, shown at its tail. */
    'casper-receipt': ReceiptTurnData
  }
}

interface ReceiptState {
  readonly turn: number
  /** Absent until the call's result is loaded. */
  readonly data: ReceiptTurnData | undefined
}

/** Settled data by result event, so a rebuilt Context keeps the same value. */
const settled = new WeakMap<object, ReceiptState>()

/**
 * The text of a result's content, as the generic row shows it.
 * @param content - the result's content.
 * @returns its text parts, and other parts as JSON, one per line.
 */
export function resultText(content: ToolResultNode['content']): string {
  return content.map(item => item.type === 'text' ? item.text : JSON.stringify(item)).join('\n')
}

function resultState(match: ConversationMatch): ReceiptState | undefined {
  const event = match.event
  if (event.type !== 'tool/result') return undefined
  let state = settled.get(event)
  if (state === undefined) {
    state = { turn: event.data.turn, data: {
      callId: String(event.data.message.source.callId),
      receipt: recordedReceipt(event.data.meta),
      text: resultText(event.data.message.content),
    } }
    settled.set(event, state)
  }
  return state
}

function fallbackState(context: ConversationNodeContext<ReceiptState>): ReceiptState | undefined {
  const match = context.matches.findLast(candidate => candidate.event.type === 'tool/result')
  return match === undefined ? undefined : resultState(match)
}

/** The receipt call and its result, claimed on the Chat target and published on their Turn. */
export const receiptDefinition: ConversationNodeDefinition<ReceiptState> = {
  kind: 'casper-receipt',
  target: 'chat',
  match: (event) => {
    if (event.type === 'tool/call') {
      return event.data.name === CASPER_RECEIPT ? { id: String(event.data.callId), role: 'start', exclusive: true } : null
    }
    if (event.type === 'tool/result' && event.surfaceOp === 'append') {
      const callId = String(event.data.message.source.callId)
      return isReceiptCallId(callId) ? { id: callId, role: 'update', exclusive: true } : null
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'tool/call') throw new Error('casper-receipt start requires tool/call')
    return { turn: match.event.data.turn, data: undefined }
  },
  update: (context, match) => resultState(match) ?? context.state,
  buildLocationData: (context, scope, previous) => {
    const state = context.state?.data === undefined ? fallbackState(context) : context.state
    if (scope !== 'turn' || state?.data === undefined) return null
    if (previous?.kind === 'turn' && previous.key === 'casper-receipt'
      && previous.turn === state.turn && previous.value === state.data) return previous
    return { kind: 'turn', turn: state.turn, key: 'casper-receipt', value: state.data }
  },
  // The card is the Turn tail's: the claimed call shows no row of its own.
  buildViewNode: () => null,
}
