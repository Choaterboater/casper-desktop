/**
 * Source-safe Client lifecycle of the `casperEngine` Remote namespace and the
 * General Settings row that reads it. The entry module supplies the generated
 * contribution, so specs mount a fake one.
 * @module @deepseek-ai/dsh-casper-agent/src/client/engine-mount
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-casper-agent/remote'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { engineDe, engineEn, engineEs, engineFr, engineJa, enginePt, engineRu, engineZh, ENGINE_NS } from './engine-locales.ts'
import { EngineVersionRow, type EngineVersionRowInjected } from './EngineVersionRow.tsx'

/**
 * Mount the `casperEngine` namespace and, once it is served, the Casper engine
 * row after the update channel and before the app version.
 * @param ctx - a Client Context injecting `remote`, `slots` and `locale`.
 * @param contribution - the generated `casperEngine` Remote contribution.
 */
export function mountCasperEngine(ctx: Context, contribution: TypertRemoteContribution): void {
  ctx.plugin(async owner => await owner.remote.$mount(contribution))
  ctx.inject(['remote.casperEngine', 'slots', 'locale'], (scope) => {
    scope.effect(() => scope.locale.register(ENGINE_NS, {
      zh: engineZh, en: engineEn, ja: engineJa, es: engineEs, fr: engineFr, de: engineDe, ru: engineRu, pt: enginePt,
    }), 'casper-agent: engine dictionaries')
    const face: EngineVersionRowInjected = { describe: () => scope.remote.casperEngine.describe() }
    scope.slots.inject('settings.general.item', () => scope.slots.register({
      name: 'settings.general.item', id: 'casper-engine', order: 99, locale: ENGINE_NS, inject: () => face,
    }, EngineVersionRow))
  })
}
