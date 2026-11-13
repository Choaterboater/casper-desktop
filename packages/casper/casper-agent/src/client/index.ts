/**
 * Casper agent, Client half: Casper's approval card, registered first in the
 * conversation composer chain, so a box Casper asks (a user question with id
 * `casper-permission` and header `Casper`) shows Casper's own rows instead of
 * the generic question card. Every other pending interaction passes on. The
 * receipt card is an entry in a completed Turn's tail, outside the Turn's
 * steps, and the keyed tool view of `casper_receipt` calls. Casper's checks
 * leave the Chat for their own Checks view beside it. The mode pill, an
 * entry beside the composer's access control, names an access mode Casper
 * picked itself.
 * @module @deepseek-ai/dsh-casper-agent/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: declares the `conversation.chat.turnTail` slot.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: declares the keyed `tool.call.toolview` slot.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { CASPER_RECEIPT } from '../receipt.ts'
import { CHECKS_TARGET, EMPTY_CHECKS_SNAPSHOT, registerCheckCalls, type CasperChecksSnapshot } from './check-calls.ts'
import { ChecksView, type ChecksViewInjected } from './ChecksView.tsx'
import { CasperBoxCard, selectCasperBox } from './CasperBoxCard.tsx'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.ts'
import { ModePill } from './ModePill.tsx'
import { receiptDefinition } from './receipt-turn.ts'
import { ReceiptRow, ReceiptTail } from './ReceiptRow.tsx'

export { ARM_DELAY_MS, CasperBoxCard, selectCasperBox } from './CasperBoxCard.tsx'
export {
  CASPER_CHECK, CHECKS_TARGET, checkChatDefinition, checkTitle, checkViewDefinition, checksViewDefinition,
  EMPTY_CHECKS_SNAPSHOT,
} from './check-calls.ts'
export type { CasperCheck, CasperChecksSnapshot, CasperCheckViewNode } from './check-calls.ts'
export { ChecksView, checksByTurn } from './ChecksView.tsx'
export type { ChecksViewInjected, ChecksViewProps } from './ChecksView.tsx'
export { ModePill } from './ModePill.tsx'
export type { ModePillProps } from './ModePill.tsx'
export type { CasperBox, CasperBoxCardProps } from './CasperBoxCard.tsx'
export { receiptDefinition, resultText } from './receipt-turn.ts'
export type { ReceiptTurnData } from './receipt-turn.ts'
export { ReceiptRow, ReceiptTail } from './ReceiptRow.tsx'
export type { ReceiptRowProps, ReceiptTailProps } from './ReceiptRow.tsx'

/** Required services: the Slot registry, the locale dictionaries, the conversation Definitions, and the Session bindings. */
export const inject = ['slots', 'locale', 'uiConversation', 'sessions']

/**
 * Register Casper's approval card before the question composer (priority -1),
 * the receipt's Definition with its card in the Turn tail, and the receipt
 * card as the `casper_receipt` tool view, the check Definitions with the
 * Checks view after the trajectory view, and the mode pill after the
 * composer's mode controls.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'casper-agent: card dictionaries')
  // The tab label reads through the bound translate as a thunk, so it follows the active locale.
  const t = ctx.locale.bind(NS)
  registerCheckCalls(ctx)
  const checkSources = new WeakMap<SessionBinding, ObservableSnapshot<CasperChecksSnapshot>>()
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: CHECKS_TARGET,
    order: 20,
    locale: NS,
    label: () => t('checks.view'),
    inject: (sessionId: SessionId): ChecksViewInjected => {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) throw new Error(`casper-agent: session "${sessionId}" is unavailable`)
      let source = checkSources.get(binding)
      if (source === undefined) {
        const target = ctx.uiConversation.binding(binding).target(CHECKS_TARGET)
        source = {
          getSnapshot: () => target.getSnapshot() ?? EMPTY_CHECKS_SNAPSHOT,
          subscribe: listener => target.subscribe(listener),
        }
        checkSources.set(binding, source)
      }
      return { hooks: { casperChecks: source } }
    },
  }, ChecksView))
  const match = receiptDefinition.match.bind(receiptDefinition)
  ctx.effect(() => ctx.uiConversation.events.register({
    ...receiptDefinition,
    match: { 'tool/call': match, 'tool/result': match },
  }), 'casper-agent: receipt definition')
  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer',
    priority: -1,
    select: ({ pendingInteraction }: ComposerChainProps) => selectCasperBox(pendingInteraction),
    locale: NS,
  }, CasperBoxCard))
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register(
    { name: 'conversation.chat.turnTail', id: CASPER_RECEIPT, locale: NS },
    ReceiptTail,
  ))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: CASPER_RECEIPT, locale: NS },
    ReceiptRow,
  ))
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
    { name: 'conversation.input.left', id: 'casper-mode-pill', locale: NS },
    ModePill,
  ))
}
