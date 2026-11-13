// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { PendingQuestion, createWaterfallRequest } from '@deepseek-ai/dsh-client-ui-user-questions/src/client/contract/slots.ts'
import type { QuestionAnswer, QuestionCardSnapshot } from '@deepseek-ai/dsh-client-ui-user-questions/src/client/contract/slots.ts'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { ARM_DELAY_MS, BOX_DIFF_MAX_LINES, CasperBoxCard, detailWithoutDiff, selectCasperBox, type CasperBox, type CasperBoxCardProps } from '../src/client/CasperBoxCard.tsx'
import { diffLines } from '../src/box.ts'
import { apply, inject } from '../src/client/index.ts'
import { de, en, es, fr, ja, NS, pt, ru, zh } from '../src/client/locales.ts'

const SESSION = 's1' as SessionId

const NO = { label: 'No' }
const ONCE = { label: 'Yes, this once', description: 'only this write' }
const SESSION_WIDE = { label: 'Yes, for this session' }
const EVERYTHING = { label: 'Yes to everything this session' }

/** Casper's box as a question; an override set to undefined leaves that field out. */
function box(overrides: { [K in keyof AskUserQuestionItem]?: AskUserQuestionItem[K] | undefined } = {}): AskUserQuestionItem {
  const item: AskUserQuestionItem = {
    id: 'casper-permission',
    header: 'Casper',
    question: 'Write outside the project?',
    detail: 'The AI wants to change notes.txt.\n\n/work/notes.txt\n- old\n+ new',
    options: [NO, ONCE, SESSION_WIDE],
    multiSelect: false,
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) Reflect.deleteProperty(item, key)
    else Reflect.set(item, key, value)
  }
  return item
}

/** A card carrier whose snapshot a test can change and whose answer a test controls. */
function carrier(question: AskUserQuestionItem, answer: (value: QuestionAnswer) => Promise<void> = () => Promise.resolve()) {
  let snapshot: QuestionCardSnapshot = { state: 'open', waitState: 'counting', countdown: undefined, channel: 'waterfall', closed: false }
  const listeners = new Set<() => void>()
  const answers: QuestionAnswer[] = []
  const value: CasperBox = {
    key: 'question:s1:casper-approval-1',
    questions: [question],
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    answer: (given) => {
      answers.push(given)
      return answer(given)
    },
  }
  return {
    value,
    answers,
    set(next: Partial<QuestionCardSnapshot>) {
      snapshot = { ...snapshot, ...next }
      for (const listener of listeners) listener()
    },
  }
}

/** The card's translate over the English dictionary. */
const t = ((key: string) => (en as Record<string, string>)[key] ?? key) as CasperBoxCardProps['t']

function show(value: CasperBox) {
  return render(<CasperBoxCard matched={value} t={t} />)
}

/** A key as a browser delivers it: Enter on a focused button clicks it unless the page took the key. */
function press(target: Element, key: string, init: Record<string, unknown> = {}): void {
  const taken = !fireEvent.keyDown(target, { key, ...init })
  if (!taken && key === 'Enter' && target instanceof HTMLButtonElement) fireEvent.click(target)
}

async function arm(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ARM_DELAY_MS) })
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('selectCasperBox', () => {
  it('selects only Casper\'s marked question with 1 to 4 options', () => {
    const pending = (questions: AskUserQuestionItem[]) => new PendingQuestion(SESSION, questions, ToolCallId('casper:epoch:casper-approval-1'))
    const mine = pending([box()])
    expect(selectCasperBox(mine)).toBe(mine)
    const one = pending([box({ options: [NO] })])
    expect(selectCasperBox(one)).toBe(one)
    const four = pending([box({ options: [NO, ONCE, SESSION_WIDE, EVERYTHING] })])
    expect(selectCasperBox(four)).toBe(four)
    for (const other of [
      pending([box({ options: [NO, ONCE, SESSION_WIDE, EVERYTHING, { label: 'Yes, always for this project' }] })]),
      pending([box({ options: [] })]),
      pending([box({ header: undefined })]),
      pending([box({ header: 'Plan review' })]),
      pending([box({ id: 'casper-question' })]),
      pending([box({ multiSelect: true })]),
      pending([box({ intent: { kind: 'plan-review', approve: 'Yes, this once' }, detail: '# Plan' })]),
      pending([box(), box()]),
      new PendingQuestion(SESSION, [box()], ToolCallId('casper:epoch:casper-approval-2'), undefined, [{ id: 'casper-permission', selected: ['No'] }]),
    ]) expect(selectCasperBox(other)).toBeNull()
    expect(selectCasperBox(undefined)).toBeNull()
    expect(selectCasperBox({ key: 'approval:1', kind: 'approval', sessionId: SESSION } as never)).toBeNull()
  })

  it('leaves a box of only yeses, which Casper sends with no header, to the generic card, so Esc picks no yes', () => {
    const yesOnly = new PendingQuestion(SESSION, [box({ header: undefined, options: [ONCE, SESSION_WIDE] })], ToolCallId('casper:epoch:casper-approval-1'))
    expect(selectCasperBox(yesOnly)).toBeNull()
  })

  it('registers first in the composer chain with its copy, the Slot registry, the locale, the conversation Definitions and the Session bindings injected', () => {
    type Options = { name: string; priority: number; locale: string; select: (owner: { pendingInteraction: unknown }) => unknown }
    const register = vi.fn((_options: Options) => () => {})
    const slots = { inject: vi.fn((_name: string, mount: () => () => void) => mount()), register }
    const effect = vi.fn((run: () => unknown) => run())
    const uiConversation = { events: { register: vi.fn(() => () => {}) }, views: { register: vi.fn(() => () => {}) } }
    const locale = { register: vi.fn(() => () => {}), bind: vi.fn(() => vi.fn()) }
    apply({ slots, effect, locale, uiConversation } as never)
    expect(inject).toEqual(['slots', 'locale', 'uiConversation', 'sessions'])
    expect(locale.register).toHaveBeenCalledWith(NS, { zh, en, ja, es, fr, de, ru, pt })
    for (const dictionary of [zh, ja, es, fr, de, ru, pt]) expect(dictionary['box.details']).not.toBe(en['box.details'])
    expect(slots.inject).toHaveBeenCalledWith('conversation.composer', expect.any(Function))
    const options = register.mock.calls.find(([candidate]) => candidate.name === 'conversation.composer')?.[0]
    expect(options).toMatchObject({ name: 'conversation.composer', priority: -1, locale: NS })
    const mine = new PendingQuestion(SESSION, [box()], ToolCallId('casper:epoch:casper-approval-3'))
    expect(options?.select({ pendingInteraction: mine })).toBe(mine)
    expect(options?.select({ pendingInteraction: undefined })).toBeNull()
  })
})

describe('CasperBoxCard', () => {
  it('renders options in Casper\'s order with descriptions, No first', async () => {
    const { value } = carrier(box({ question: 'The AI wants to write to /elsewhere.\nAllow it?' }))
    show(value)
    expect(screen.getByText('Casper')).toBeTruthy()
    expect(screen.getByText('The AI wants to write to /elsewhere.')).toBeTruthy()
    const detail = document.querySelector('pre')
    expect(detail?.textContent).toBe('Allow it?\n\nThe AI wants to change notes.txt.\n\n/work/notes.txt\n- old\n+ new')
    const rows = screen.getAllByRole('button')
    expect(rows.map(row => row.textContent)).toEqual(['1No', '2Yes, this once', '3Yes, for this session'])
    expect(rows[1]?.getAttribute('aria-describedby')).toBe(screen.getByText('only this write').id)
    expect(rows[0]?.getAttribute('aria-describedby')).toBeNull()
    await arm()
    expect(document.activeElement).toBe(rows[0])
  })

  it('nothing answers in the first 300 ms; then Enter and Esc answer No and 2 answers row two', async () => {
    const first = carrier(box())
    const view = show(first.value)
    const rows = screen.getAllByRole('button')
    const card = view.container.firstElementChild!
    fireEvent.click(rows[1]!)
    press(card, 'Escape')
    press(card, '2')
    rows[0]!.focus()
    press(rows[0]!, 'Enter')
    await act(async () => { await vi.advanceTimersByTimeAsync(ARM_DELAY_MS - 1) })
    press(card, '1')
    expect(first.answers).toEqual([])
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    // Keys with a modifier, a repeat, or an IME composition, and a digit past the last row, count for nothing.
    press(card, '2', { ctrlKey: true })
    press(card, '2', { metaKey: true })
    press(card, '2', { altKey: true })
    press(card, '2', { shiftKey: true })
    press(card, '2', { repeat: true })
    press(card, '2', { isComposing: true })
    press(card, '4')
    press(card, 'a')
    expect(first.answers).toEqual([])
    // Enter has no handler of its own: it clicks the focused row, which is No.
    expect(document.activeElement).toBe(rows[0])
    press(document.activeElement!, 'Enter')
    // Sent once: the card is busy until Casper closes the box.
    press(card, 'Escape')
    fireEvent.click(rows[1]!)
    expect(first.answers).toEqual([{ answers: [{ id: 'casper-permission', selected: ['No'] }] }])
    expect(view.container.firstElementChild?.getAttribute('aria-busy')).toBe('true')
    view.unmount()

    const second = carrier(box())
    const again = show(second.value)
    await arm()
    press(again.container.firstElementChild!, 'Escape')
    expect(second.answers).toEqual([{ answers: [{ id: 'casper-permission', selected: ['No'] }] }])
    again.unmount()

    const third = carrier(box())
    const last = show(third.value)
    await arm()
    press(last.container.firstElementChild!, '2')
    expect(third.answers).toEqual([{ answers: [{ id: 'casper-permission', selected: ['Yes, this once'] }] }])
  })

  it('leaves focus in another field where it was, and a key typed there answers nothing', async () => {
    const { value, answers } = carrier(box())
    const view = render(<><input aria-label="Address" /><CasperBoxCard matched={value} t={t} /></>)
    const field = screen.getByLabelText('Address')
    field.focus()
    await arm()
    expect(document.activeElement).toBe(field)
    // The key goes where the browser sends it: the focused field.
    press(document.activeElement!, '2')
    press(document.activeElement!, 'Escape')
    // A key the card receives while focus is elsewhere counts for nothing either.
    press(view.container.querySelector('[data-casper-box]')!, '3')
    expect(answers).toEqual([])
    // Once the user moves into the card, its keys work.
    const rows = screen.getAllByRole('button')
    rows[0]!.focus()
    press(document.activeElement!, '2')
    expect(answers).toEqual([{ answers: [{ id: 'casper-permission', selected: ['Yes, this once'] }] }])
  })

  it('takes focus from the composer seat it replaces', async () => {
    const { value } = carrier(box())
    render(
      <div data-conversation-session="s1" data-conversation-region="chat">
        <div data-conversation-region="composer">
          <textarea aria-label="Message" />
          <CasperBoxCard matched={value} t={t} />
        </div>
      </div>,
    )
    screen.getByLabelText('Message').focus()
    await arm()
    expect(document.activeElement).toBe(screen.getAllByRole('button')[0])
  })

  it('a keyboard user reaches the scrolling detail, and its keys still answer', async () => {
    const { value, answers } = carrier(box())
    show(value)
    const body = screen.getByRole('group', { name: 'Box details' })
    expect(body.tabIndex).toBe(0)
    expect(body.querySelector('pre')).not.toBeNull()
    await arm()
    body.focus()
    press(body, 'ArrowDown')
    press(body, 'PageDown')
    expect(answers).toEqual([])
    press(body, 'Escape')
    expect(answers).toEqual([{ answers: [{ id: 'casper-permission', selected: ['No'] }] }])
  })

  it('Run this command? shows four rows', async () => {
    const { value, answers } = carrier(box({ question: 'Run this command?  npm test', detail: undefined, options: [NO, ONCE, SESSION_WIDE, EVERYTHING] }))
    const view = show(value)
    expect(screen.getAllByRole('button').map(row => row.textContent)).toEqual([
      '1No', '2Yes, this once', '3Yes, for this session', '4Yes to everything this session',
    ])
    expect(document.querySelector('pre')).toBeNull()
    await arm()
    press(view.container.firstElementChild!, '4')
    expect(answers).toEqual([{ answers: [{ id: 'casper-permission', selected: ['Yes to everything this session'] }] }])
  })

  it('a closed question answers nothing and a failed send can be retried', async () => {
    const closed = carrier(box())
    const view = show(closed.value)
    await arm()
    act(() => { closed.set({ closed: true }) })
    press(view.container.firstElementChild!, 'Escape')
    expect(closed.answers).toEqual([])
    expect(screen.getAllByRole('button').every(row => (row as HTMLButtonElement).disabled)).toBe(true)
    act(() => { closed.set({ closed: false, channel: 'none' }) })
    fireEvent.click(screen.getAllByRole('button')[1]!)
    expect(closed.answers).toEqual([])
    view.unmount()

    let fail = true
    const flaky = carrier(box(), () => fail ? Promise.reject(new Error('the gateway dropped it')) : Promise.resolve())
    show(flaky.value)
    await arm()
    const rows = screen.getAllByRole('button')
    fireEvent.click(rows[1]!)
    await act(async () => { await Promise.resolve() })
    expect(rows.every(row => !(row as HTMLButtonElement).disabled)).toBe(true)
    fail = false
    fireEvent.click(rows[2]!)
    fireEvent.click(rows[1]!)
    expect(flaky.answers.map(answer => answer.answers[0]?.selected)).toEqual([['Yes, this once'], ['Yes, for this session']])
  })

  it('draws an edit\'s diffs with the app\'s diff view, leaves their lines out of the text, and the rows answer as before', async () => {
    const diffs = [{ path: '/work/notes.txt', oldText: 'old\n', newText: 'new\n' }, { path: '/work/fresh.txt', oldText: null, newText: 'fresh' }]
    const detail = `The AI wants to change notes.txt.\n\n${diffLines(diffs) ?? ''}`
    const { value, answers } = carrier(box({ detail, diffs }))
    const view = show(value)
    const body = screen.getByRole('group', { name: 'Box details' })
    expect(body.querySelector('pre')?.textContent).toBe('The AI wants to change notes.txt.')
    const drawn = body.querySelector('[data-diff]')
    expect(drawn).not.toBeNull()
    expect(drawn?.textContent).toContain('/work/notes.txt')
    expect(drawn?.textContent).toContain('/work/fresh.txt')
    expect(drawn?.textContent).toContain('old')
    expect(drawn?.textContent).toContain('fresh')
    // The rows are the card's own, in the same order; the diff view's toolbar sits in the details.
    const rows = within(view.container.querySelector('[role="group"]:not([aria-label])') as HTMLElement).getAllByRole('button')
    expect(rows.map(row => row.textContent)).toEqual(['1No', '2Yes, this once', '3Yes, for this session'])
    await arm()
    expect(document.activeElement).toBe(rows[0])
    press(view.container.firstElementChild!, '2')
    expect(answers).toEqual([{ answers: [{ id: 'casper-permission', selected: ['Yes, this once'] }] }])
  })

  it('a box without diffs, or with approvalDiff off, shows today\'s text only', () => {
    // With approvalDiff off the Host's question has the diff lines as its detail and no diffs (permission.spec.ts).
    const off = box({ detail: '/work/notes.txt\n- old\n+ new' })
    const first = show(carrier(off).value)
    expect(document.querySelector('[data-diff]')).toBeNull()
    expect(document.querySelector('pre')?.textContent).toBe('/work/notes.txt\n- old\n+ new')
    first.unmount()
    show(carrier(box()).value)
    expect(document.querySelector('[data-diff]')).toBeNull()
    expect(document.querySelector('pre')?.textContent).toBe('The AI wants to change notes.txt.\n\n/work/notes.txt\n- old\n+ new')
  })

  it('the Host\'s question draws as the card expects: only the diff lines are cut, and a detail that does not end with them is kept', () => {
    // The question the Host builds for a text line and one diff (permission.spec.ts checks the same shape).
    const question = box({ detail: 'Change one line.\n\n/work/notes.txt\n- old\n+ new', diffs: [{ path: '/work/notes.txt', oldText: 'old', newText: 'new' }] })
    expect(question.diffs).toHaveLength(1)
    expect(detailWithoutDiff(question.detail ?? '', question.diffs ?? [])).toBe('Change one line.')
    expect(detailWithoutDiff('/work/notes.txt\n- old\n+ new', question.diffs ?? [])).toBe('')
    expect(detailWithoutDiff('Something else', question.diffs ?? [])).toBe('Something else')
    expect(BOX_DIFF_MAX_LINES).toBe(9)
  })

  it('answers through a real waterfall once', async () => {
    const pending = new PendingQuestion(SESSION, [box()], ToolCallId('casper:epoch:casper-approval-4'))
    const request = createWaterfallRequest(undefined, undefined, (channel) => { pending.detachWaterfall(channel) })
    pending.attachWaterfall(request.channel)
    show(pending)
    await arm()
    fireEvent.click(screen.getAllByRole('button')[2]!)
    await expect(request.result).resolves.toEqual({ answers: [{ id: 'casper-permission', selected: ['Yes, for this session'] }] })
  })
})
