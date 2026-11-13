/**
 * Mount of the Casper models card: the generated `casperSignIn` Remote, then
 * the card in the Models settings page's footer, withdrawn before the Remote.
 * @module @deepseek-ai/dsh-casper-agent/client/sign-in-mount
 */
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-casper-agent/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: declares the `settings.models.footer` slot.
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { CasperSignInCard } from './CasperSignInCard.tsx'
import type { CasperSignInCardProps, CasperSignInOperations } from './CasperSignInCard.tsx'
import { NS } from './locales.ts'

/** The card's id in the footer list. */
export const CASPER_SIGN_IN_ENTRY = 'casper-sign-in'

/**
 * Adapt the generated `casperSignIn` methods to the card's operations: a refused call throws its `RemoteError`, and
 * stopping a sign-in disposes its stream, which stops Casper's sign-in.
 * @param remote - the generated `casperSignIn` namespace.
 * @returns the card's operations.
 */
export function signInOperations(remote: Context['remote']['casperSignIn']): CasperSignInOperations {
  return {
    async state(signal) {
      const result = await remote.state(signal)
      if (!result.ok) throw result.error
      return result.value
    },
    async signIn(methodId, key, onFrame, signal) {
      const stream = remote.signIn(methodId, key, signal)
      const stop = (): void => { stream.dispose() }
      signal.addEventListener('abort', stop, { once: true })
      try {
        for await (const frame of stream) onFrame(frame)
      } finally {
        signal.removeEventListener('abort', stop)
      }
    },
    async signOut(provider, signal) {
      const result = await remote.signOut(provider, signal)
      if (!result.ok) throw result.error
    },
  }
}

/**
 * Mount the `casperSignIn` Remote and register the card once its namespace and the slot services are present.
 * @param ctx - the Client plugin lifetime holding `remote`.
 * @param contribution - the generated `casperSignIn` Remote definitions.
 * @returns disposer that withdraws the card, then the Remote.
 */
export async function mountSignIn(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.casperSignIn', 'slots', 'locale'], (child) => {
    const operations = signInOperations(child.remote.casperSignIn)
    const Card = (props: Omit<CasperSignInCardProps, 'operations'>) => createElement(CasperSignInCard, { ...props, operations })
    child.slots.inject('settings.models.footer', () => child.slots.register(
      { name: 'settings.models.footer', id: CASPER_SIGN_IN_ENTRY, order: 100, locale: NS },
      Card,
    ))
  })
  try { await ui } catch (error) { await ui.dispose(); await unmountRemote(); throw error }
  return async () => { await ui.dispose(); await unmountRemote() }
}
