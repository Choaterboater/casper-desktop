/**
 * Casper's receipt card: the `casper_receipt` call's row. Collapsed it shows
 * the verdict; open it lists the changed files (each opens against the
 * receipt's folder), the checks run and not run, and the model use. A
 * result whose meta is not a receipt shows the receipt's text, as the
 * generic row does.
 * @module @deepseek-ai/dsh-casper-agent/client/ReceiptRow
 */
import { useState } from 'react'
import { DisclosureRow, IconChecklistOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { recordedReceipt, type CasperReceipt } from '../receipt.ts'
import type { NS } from './locales.ts'
import css from './ReceiptRow.module.css'

/** Props of the keyed `casper_receipt` row. */
export type ReceiptRowProps = ToolCallViewProps & PropsLocale<typeof NS>

type Translate = ReceiptRowProps['t']

/* v8 ignore next -- A row that cannot expand never calls its toggle. */
const noop = (): void => undefined

/**
 * Join a changed file to the receipt's folder, with the folder's own separator.
 * @param root - the receipt's folder, when Casper sent one.
 * @param file - the changed file, relative to it.
 * @returns the path to open.
 */
export function receiptPath(root: string | undefined, file: string): string {
  if (root === undefined || file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file)) return file
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${separator}${file}`
}

/**
 * A dollar amount as the receipt shows it.
 * @param amount - the cost in dollars.
 * @returns the amount, with four places under a cent.
 */
function dollars(amount: number): string {
  return `$${amount.toFixed(amount > 0 && amount < 0.01 ? 4 : 2)}`
}

/**
 * The receipt's model use in words: its tokens and how its cost is paid.
 * @param receipt - the receipt.
 * @param t - the card's translate.
 * @returns the lines, or none when no model task ran.
 */
export function usageLines(receipt: CasperReceipt, t: Translate): string[] {
  const usage = receipt.usage
  if (usage === null || usage === undefined) return []
  const tokens = usage.tokens === null ? t('row.tokensUnknown') : t('row.tokens', { count: String(usage.tokens) })
  const amount = usage.estimatedCost
  switch (receipt.cost) {
    case 'subscription': return [tokens, t('row.subscription')]
    case 'charged': return [tokens, amount === null ? t('row.costUnknown') : t('row.charged', { amount: dollars(amount) })]
    case 'estimate': return [tokens, amount === null ? t('row.costUnknown') : t('row.estimate', { amount: dollars(amount) })]
    default: return [tokens]
  }
}

/**
 * Render the `casper_receipt` row.
 * @param props - the keyed toolview props and the card's translate.
 * @returns the receipt card, or the receipt's text when its meta does not parse.
 */
export function ReceiptRow(props: ReceiptRowProps) {
  if (props.phase !== 'result') {
    return <div data-tool="casper_receipt" data-state="running">
      <DisclosureRow title={props.t('row.title')} icon={<IconChecklistOutlineRegular size={14} />}
        open={false} expandable={false} onToggle={noop} running
        collapsedContent={<span className={css.summary}>{props.t('row.running')}</span>} />
    </div>
  }
  const receipt = recordedReceipt(props.block.meta)
  return receipt === undefined
    ? <PlainReceipt {...props} />
    : <ReceiptCard receipt={receipt} openFile={props.openFile} inspect={props.inspect} t={props.t} />
}

/** The generic shape: the receipt's text behind the verdict-less title. */
function PlainReceipt({ block, inspect, t }: Extract<ReceiptRowProps, { phase: 'result' }>) {
  const [open, setOpen] = useState(false)
  const text = block.content.map(item => item.type === 'text' ? item.text : JSON.stringify(item)).join('\n')
  return <div data-tool="casper_receipt" data-state="plain">
    <DisclosureRow title={t('row.title')} icon={<IconChecklistOutlineRegular size={14} />}
      open={open && text !== ''} expandable={text !== ''} expandOnRowClick keepContentWhenOpen
      onToggle={() => { setOpen(value => !value) }}>
      <pre className={css.text}>{text}</pre>
      {inspect && <button type="button" className={css.link} onClick={inspect}>{t('row.inspect')}</button>}
    </DisclosureRow>
  </div>
}

interface ReceiptCardProps {
  readonly receipt: CasperReceipt
  readonly openFile: ReceiptRowProps['openFile']
  readonly inspect: ReceiptRowProps['inspect']
  readonly t: Translate
}

function ReceiptCard({ receipt, openFile, inspect, t }: ReceiptCardProps) {
  const [open, setOpen] = useState(false)
  const usage = usageLines(receipt, t)
  const checks = receipt.checksRun.length + receipt.checksNotRun.length
  return <div data-tool="casper_receipt" data-state={receipt.outcome}>
    <DisclosureRow title={t('row.title')} icon={<IconChecklistOutlineRegular size={14} />}
      open={open} expandable expandOnRowClick keepContentWhenOpen
      onToggle={() => { setOpen(value => !value) }}
      collapsedContent={<span className={css.summary}>{receipt.verdict}</span>}>
      <div className={css.body}>
        <section aria-label={t('row.changed')}>
          <div className={css.heading}>{t('row.changed')}</div>
          {receipt.changed === null
            ? <p className={css.note}>{t('row.notCompared')}</p>
            : receipt.changed.length === 0
              ? <p className={css.note}>{t('row.noChanges')}</p>
              : <ul className={css.list}>{receipt.changed.map(file => <li key={file}>
                <button type="button" className={css.link} aria-label={t('row.open', { path: file })}
                  onClick={() => { openFile(receiptPath(receipt.root, file)) }}>{file}</button>
              </li>)}</ul>}
        </section>
        <section aria-label={t('row.checksRun')}>
          <div className={css.heading}>{t('row.checksRun')}</div>
          {checks === 0 ? <p className={css.note}>{t('row.noChecks')}</p> : null}
          {receipt.checksRun.length > 0
            ? <ul className={css.list}>{receipt.checksRun.map(check => <li key={check.name} data-status={check.status}>
              <span className={css.name}>{check.name}</span> {t(check.status === 'pass' ? 'row.pass' : 'row.fail')}
              {check.command === null ? null : <code className={css.command}>{check.command}</code>}
            </li>)}</ul>
            : null}
        </section>
        {receipt.checksNotRun.length > 0
          ? <section aria-label={t('row.checksNotRun')}>
            <div className={css.heading}>{t('row.checksNotRun')}</div>
            <ul className={css.list}>{receipt.checksNotRun.map(check => <li key={check.name}>
              <span className={css.name}>{check.name}</span> {check.reason}
            </li>)}</ul>
          </section>
          : null}
        {usage.length > 0
          ? <section aria-label={t('row.usage')}>
            <div className={css.heading}>{t('row.usage')}</div>
            <p className={css.note}>{usage.join(' · ')}</p>
          </section>
          : null}
        {inspect && <button type="button" className={css.link} onClick={inspect}>{t('row.inspect')}</button>}
      </div>
    </DisclosureRow>
  </div>
}
