/**
 * Casper agent, Client half: Casper's approval card, registered first in the
 * conversation composer chain, so a box Casper asks (a user question with id
 * `casper-permission` and header `Casper`) shows Casper's own rows instead of
 * the generic question card. Every other pending interaction passes on. The
 * receipt card is the keyed tool view of `casper_receipt` calls.
 * @module @deepseek-ai/dsh-casper-agent/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: declares the keyed `tool.call.toolview` slot.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { CASPER_RECEIPT } from '../receipt.ts'
import { CasperBoxCard, selectCasperBox } from './CasperBoxCard.tsx'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.ts'
import { ReceiptRow } from './ReceiptRow.tsx'

export { ARM_DELAY_MS, CasperBoxCard, selectCasperBox } from './CasperBoxCard.tsx'
export type { CasperBox, CasperBoxCardProps } from './CasperBoxCard.tsx'
export { ReceiptRow } from './ReceiptRow.tsx'
export type { ReceiptRowProps } from './ReceiptRow.tsx'

/** Required services: the Slot registry and the locale dictionaries. */
export const inject = ['slots', 'locale']

/**
 * Register Casper's approval card before the question composer (priority -1),
 * and the receipt card as the `casper_receipt` tool view.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'casper-agent: receipt dictionaries')
  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer',
    priority: -1,
    select: ({ pendingInteraction }: ComposerChainProps) => selectCasperBox(pendingInteraction),
  }, CasperBoxCard))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: CASPER_RECEIPT, locale: NS },
    ReceiptRow,
  ))
}
