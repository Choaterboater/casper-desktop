/**
 * The Checks view: every Casper check in the Session, grouped by Turn. Each
 * row shows the check's title and whether it passed; open, it shows the
 * check's output and an Inspect link when the trajectory view is available.
 * @module @deepseek-ai/dsh-casper-agent/client/ChecksView
 */
import { useState, type ReactElement } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { DisclosureRow, IconChecklistOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CasperCheck, CasperChecksSnapshot } from './check-calls.ts'
import type { NS } from './locales.ts'
import css from './ChecksView.module.css'

/** Business values the view's slot entry injects. */
export interface ChecksViewInjected {
  /** Snapshot sources bound by InjectFace. */
  hooks: {
    /** The Checks target's snapshot; InjectFace exposes it as `useCasperChecks`. */
    casperChecks: ObservableSnapshot<CasperChecksSnapshot>
  }
}

/** Full props of the Checks view entry. */
export type ChecksViewProps = ConvViewProps & InjectFace<ChecksViewInjected> & PropsLocale<typeof NS>

type Translate = ChecksViewProps['t']

/**
 * Group checks by their Turn, keeping Session order.
 * @param checks - the checks, in Session order.
 * @returns each Turn with its checks.
 */
export function checksByTurn(checks: readonly CasperCheck[]): [number, CasperCheck[]][] {
  const turns = new Map<number, CasperCheck[]>()
  for (const check of checks) {
    const list = turns.get(check.turn)
    if (list === undefined) turns.set(check.turn, [check])
    else list.push(check)
  }
  return [...turns]
}

/**
 * Render the Checks view.
 * @param props - the Checks snapshot hook, the call inspector, and the view's translate.
 * @returns the checks grouped by Turn, or a note when the Session has none.
 */
export function ChecksView({ useCasperChecks, inspectCall, t }: ChecksViewProps): ReactElement {
  const checks = useCasperChecks(snapshot => snapshot.checks)
  return <div className={css.root} data-view="casper-checks">
    <div className={css.scroll}>
      {checks.length === 0
        ? <p className={css.empty}>{t('checks.empty')}</p>
        : checksByTurn(checks).map(([turn, list]) => <section key={turn} className={css.turn} data-turn={turn}>
          <h3 className={css.heading}>{t('checks.turn', { turn: String(turn) })}</h3>
          {list.map(check => <CheckRow key={check.callId} check={check} inspectCall={inspectCall} t={t} />)}
        </section>)}
    </div>
  </div>
}

interface CheckRowProps {
  readonly check: CasperCheck
  readonly inspectCall: ChecksViewProps['inspectCall']
  readonly t: Translate
}

/** One check: its title and verdict, and open, its output. */
function CheckRow({ check, inspectCall, t }: CheckRowProps) {
  const [open, setOpen] = useState(false)
  const running = check.status === 'running'
  const verdict = running ? t('checks.running') : check.status === 'failed' ? t('checks.failed') : t('checks.passed')
  return <div data-check={check.callId} data-state={check.status}>
    <DisclosureRow title={check.title === '' ? t('checks.untitled') : check.title}
      icon={<IconChecklistOutlineRegular size={14} />}
      open={open} expandable={!running} expandOnRowClick keepContentWhenOpen running={running}
      onToggle={() => { setOpen(value => !value) }}
      collapsedContent={<span className={css.verdict} data-verdict={check.status}>{verdict}</span>}>
      {check.output !== '' && <pre className={css.output}>{check.output}</pre>}
      {inspectCall !== undefined && <button type="button" className={css.link}
        onClick={() => { inspectCall(check.callId) }}>{t('row.inspect')}</button>}
    </DisclosureRow>
  </div>
}
