/**
 * Casper agent, Client half: Casper's approval card, registered first in the
 * conversation composer chain, so a box Casper asks (a user question with id
 * `casper-permission` and header `Casper`) shows Casper's own rows instead of
 * the generic question card. Every other pending interaction passes on.
 * @module @deepseek-ai/dsh-casper-agent/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { CasperBoxCard, selectCasperBox } from './CasperBoxCard.tsx'

export { ARM_DELAY_MS, CasperBoxCard, selectCasperBox } from './CasperBoxCard.tsx'
export type { CasperBox, CasperBoxCardProps } from './CasperBoxCard.tsx'

/** Required services: the Slot registry. */
export const inject = ['slots']

/**
 * Register Casper's approval card before the question composer (priority -1).
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer',
    priority: -1,
    select: ({ pendingInteraction }: ComposerChainProps) => selectCasperBox(pendingInteraction),
  }, CasperBoxCard))
}
