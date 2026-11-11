/**
 * Casper's mode pill: the access mode Casper picked itself, shown next to the
 * app's access control while the process that picked it runs. Display only:
 * it has no action, and the access control keeps the person's own pick.
 * @module @deepseek-ai/dsh-casper-agent/client/ModePill
 */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the casperAccess key into SessionProjectionMap for useProjection.
import type {} from '../access-view.ts'
import type { NS } from './locales.ts'
import css from './ModePill.module.css'

/** Props of the composer entry: the Session's projections and the pill's copy. */
export type ModePillProps = PropsRuntime<'conversation.input.left'> & PropsLocale<typeof NS>

/**
 * Render the mode Casper picked itself, or nothing when there is none, so a
 * Standard Session and a Casper in the app's mode show no pill.
 * @param props - the Session's projection reader and the pill's translate.
 * @returns the pill, or null.
 */
export function ModePill({ useProjection, t }: Pick<ModePillProps, 'useProjection' | 't'>) {
  const mode = useProjection('casperAccess', value => value?.mode)
  if (mode === undefined) return null
  const name = t(mode === 'read' ? 'pill.read' : mode === 'ask' ? 'pill.ask' : 'pill.full')
  return (
    <span className={css.pill} data-casper-mode={mode} title={t('pill.title')}>
      {t('pill.label', { mode: name })}
    </span>
  )
}
