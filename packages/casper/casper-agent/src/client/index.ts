/**
 * Casper agent, Client half: Casper's approval card, registered first in the
 * conversation composer chain, so a box Casper asks (a user question with id
 * `casper-permission` and header `Casper`) shows Casper's own rows instead of
 * the generic question card. Every other pending interaction passes on. The
 * receipt card is an entry in a completed Turn's tail, outside the Turn's
 * steps, and the keyed tool view of `casper_receipt` calls. Casper's checks
 * leave the Chat for their own Checks view beside it. The mode pill, an
 * entry beside the composer's access control, names an access mode Casper
 * picked itself. The Casper engine row in General Settings reads the
 * `casperEngine` Remote namespace, mounted once `remote` is served.
 * @module @deepseek-ai/dsh-casper-agent/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import casperEngineRemote from '@deepseek-ai/dsh-casper-agent/remote'
import { applyCasperClient } from './apply.ts'

export { inject } from './apply.ts'
export { ARM_DELAY_MS, CasperBoxCard, selectCasperBox } from './CasperBoxCard.tsx'
export type { CasperBox, CasperBoxCardProps } from './CasperBoxCard.tsx'
export {
  CASPER_CHECK, CHECKS_TARGET, checkChatDefinition, checkTitle, checkViewDefinition, checksViewDefinition,
  EMPTY_CHECKS_SNAPSHOT,
} from './check-calls.ts'
export type { CasperCheck, CasperChecksSnapshot, CasperCheckViewNode } from './check-calls.ts'
export { ChecksView, checksByTurn } from './ChecksView.tsx'
export type { ChecksViewInjected, ChecksViewProps } from './ChecksView.tsx'
export { mountCasperEngine } from './engine-mount.ts'
export { EngineVersionRow, engineLine } from './EngineVersionRow.tsx'
export type { EngineVersionRowInjected } from './EngineVersionRow.tsx'
export { ModePill } from './ModePill.tsx'
export type { ModePillProps } from './ModePill.tsx'
export { receiptDefinition, resultText } from './receipt-turn.ts'
export type { ReceiptTurnData } from './receipt-turn.ts'
export { ReceiptRow, ReceiptTail } from './ReceiptRow.tsx'
export type { ReceiptRowProps, ReceiptTailProps } from './ReceiptRow.tsx'

/**
 * Register the Casper cards, the mode pill and the Casper engine row (see {@link applyCasperClient}).
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  applyCasperClient(ctx, casperEngineRemote)
}
