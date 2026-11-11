/**
 * Casper's approval card: one of Casper's numbered boxes, shown with Casper's
 * own rows in Casper's order (No first), instead of the generic question card.
 * A box that carries an edit's diffs draws them with the app's diff view.
 * @module @deepseek-ai/dsh-casper-agent/client/CasperBoxCard
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { Button, DiffBlock, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DiffBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PendingQuestion, QuestionAnswer } from '@deepseek-ai/dsh-client-ui-user-questions/client'
import { CASPER_BOX_HEADER, diffLines, MAX_CARD_OPTIONS, PERMISSION_QUESTION_ID } from '../box.ts'
import type { BoxDiff } from '../box.ts'
import type { NS } from './locales.ts'
import css from './CasperBoxCard.module.css'

/** How long the card waits before a click or key counts, so a key meant for the composer answers nothing. */
export const ARM_DELAY_MS = 300

/** Diff lines the card shows before the middle folds: as many as Standard mode's edit cards. */
export const BOX_DIFF_MAX_LINES = 9

/**
 * Cut the diff lines a box's detail ends with when the card draws the same
 * diffs: the Host writes them with {@link diffLines} after the box's text.
 * @param detail - the question's detail.
 * @param diffs - the diffs the card draws.
 * @returns the detail without those lines; unchanged when it does not end with them.
 */
export function detailWithoutDiff(detail: string, diffs: readonly BoxDiff[]): string {
  const lines = diffLines(diffs)
  if (lines === undefined || !detail.endsWith(lines)) return detail
  return detail.slice(0, detail.length - lines.length).replace(/\n\n$/, '')
}

/**
 * Whether the armed card may move focus to No: only when focus would
 * otherwise be lost (nothing, or the page, has it), or it sits in the card or
 * in the composer seat the card replaces. Focus in a sidebar, a terminal or
 * another pane stays there, so a key meant for it answers nothing.
 * @param card - the card's root.
 * @returns true to focus No.
 */
function mayTakeFocus(card: HTMLElement | null): boolean {
  if (card === null) return false
  const active = card.ownerDocument.activeElement
  if (active === null || active === card.ownerDocument.body || active === card.ownerDocument.documentElement) return true
  if (card.contains(active)) return true
  const seat = card.closest('[data-conversation-region="composer"]')
  return seat !== null && seat.contains(active)
}

/** The slice of a pending question the card reads and answers through. */
export type CasperBox = Pick<PendingQuestion, 'key' | 'questions' | 'snapshot' | 'subscribe' | 'answer'>

/**
 * Choose Casper's approval card for a pending interaction: only a question
 * with one item that carries Casper's box id and header, a single pick, and
 * 1 to {@link MAX_CARD_OPTIONS} options. A plan review, a read-only card of a
 * settled call, and every other question keep their own cards.
 * @param pending - the Session's pending interaction.
 * @returns the question, or null to let the next composer entry take it.
 */
export function selectCasperBox(pending: ComposerChainProps['pendingInteraction']): PendingQuestion | null {
  if (pending === undefined || pending.kind !== 'question' || !('questions' in pending)) return null
  if (pending.review !== undefined || pending.questions.length !== 1) return null
  const [question] = pending.questions
  const count = question?.options?.length ?? 0
  return question !== undefined
    && question.id === PERMISSION_QUESTION_ID
    && question.header === CASPER_BOX_HEADER
    && question.multiSelect !== true
    && question.intent === undefined
    && count >= 1 && count <= MAX_CARD_OPTIONS
    ? pending
    : null
}

/** Props of the composer entry: the chain's runtime share, the card's copy and the selected box. */
export type CasperBoxCardProps = PropsRuntime<'conversation.composer'> & PropsLocale<typeof NS> & { matched: CasperBox }

/**
 * Render the selected box as Casper's card, reset for each box. The card
 * reads only the selected box and its copy from the chain's props.
 * @param props - the selected box and the card's translate.
 * @returns the card.
 */
export function CasperBoxCard(props: Pick<CasperBoxCardProps, 'matched' | 't'>) {
  return <BoxFlow key={props.matched.key} box={props.matched} t={props.t} />
}

function BoxFlow({ box, t }: { box: CasperBox; t: CasperBoxCardProps['t'] }) {
  const idPrefix = useId()
  const snapshot = useSyncExternalStore(box.subscribe, box.snapshot)
  const question = box.questions[0]
  const options = question?.options ?? []
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)
  const mounted = useRef(true)
  const composing = useRef(false)
  const compositionEnded = useRef(false)
  const first = useRef<HTMLButtonElement>(null)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    mounted.current = true
    const timer = setTimeout(() => { setArmed(true) }, ARM_DELAY_MS)
    return () => {
      mounted.current = false
      clearTimeout(timer)
    }
  }, [])
  useEffect(() => {
    if (armed && mayTakeFocus(root.current)) first.current?.focus()
  }, [armed])
  const canAnswer = (): boolean => {
    const now = box.snapshot()
    return armed && now.channel !== 'none' && !now.closed
  }
  const pick = (index: number): void => {
    const label = options[index]?.label
    if (question === undefined || label === undefined || sending.current || !canAnswer()) return
    sending.current = true
    setBusy(true)
    const answer: QuestionAnswer = { answers: [{ id: question.id, selected: [label] }] }
    void box.answer(answer).catch(() => {
      // A send that failed leaves the box open: the rows work again.
      if (!mounted.current) return
      sending.current = false
      setBusy(false)
    })
  }
  const keydown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || !event.currentTarget.contains(document.activeElement)
      || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    const row = event.key === 'Escape' ? 0 : /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1
    if (row < 0 || row >= options.length) return
    event.preventDefault()
    event.stopPropagation()
    // oxlint-disable-next-line typescript/no-deprecated -- IME 229 covers engines without isComposing.
    if (event.repeat || composing.current || compositionEnded.current || event.nativeEvent.isComposing || event.keyCode === 229) return
    pick(row)
  }
  if (question === undefined) return null
  const [title = '', ...rest] = question.question.split('\n')
  const diffs = question.diffs ?? []
  const detail = diffs.length === 0 ? question.detail ?? '' : detailWithoutDiff(question.detail ?? '', diffs)
  const body = [rest.join('\n').trim(), detail].filter(part => part !== '').join('\n\n')
  return (
    <div ref={root} className={css.root} data-casper-box={box.key} aria-busy={busy}
      onKeyDown={keydown}
      onKeyUpCapture={() => { compositionEnded.current = false }}
      onCompositionStartCapture={() => { composing.current = true }}
      onCompositionEndCapture={() => { composing.current = false; compositionEnded.current = true }}>
      <div className={css.card}>
        <div className={css.strip}><StateDot state={busy ? 'ongoing' : 'warning'} />{question.header}</div>
        <div className={css.body} tabIndex={0} role="group" aria-label={t('box.details')}>
          <div className={css.headline}>{title}</div>
          {body !== '' && <pre className={css.detail}>{body}</pre>}
          {diffs.length > 0 && <DiffBlock diffs={diffs} labels={diffLabels(t)} maxLines={BOX_DIFF_MAX_LINES} className={css.diff} />}
        </div>
        <div className={css.options} role="group">
          {options.map((option, index) => {
            const describedBy = option.description === undefined ? undefined : `${idPrefix}-${String(index)}`
            return (
              <div className={css.option} key={option.label}>
                <Button
                  ref={index === 0 ? first : undefined}
                  variant="outline"
                  className={index === 0 ? `${css.row} ${css.refusal}` : css.row}
                  disabled={busy || snapshot.closed}
                  aria-describedby={describedBy}
                  onClick={() => { pick(index) }}
                >
                  <span className={css.key}>{index + 1}</span>
                  <span className={css.label}>{option.label}</span>
                </Button>
                {describedBy !== undefined && <span id={describedBy} className={css.description}>{option.description}</span>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** The diff view's chrome in the card's own words. */
function diffLabels(t: CasperBoxCardProps['t']): DiffBlockLabels {
  return {
    codeLabel: t('box.diff.code'),
    wrapLabel: t('box.diff.wrap'),
    unwrapLabel: t('box.diff.unwrap'),
    copy: t('box.diff.copy'),
    copied: t('box.diff.copied'),
    collapse: t('box.diff.collapse'),
    collapseAria: t('box.diff.collapseAria'),
    expand: count => t('box.diff.expand', { count: String(count) }),
    expandAria: count => t('box.diff.expandAria', { count: String(count) }),
  }
}
