import { describe, expect, it } from 'vitest'
import type { PermissionOption, RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { CASPER_BOX_HEADER, MAX_CARD_OPTIONS } from '../src/box.ts'
import {
  answerPermission, diffText, PERMISSION_QUESTION_ID, permissionOutcome, permissionQuestion, planLabels, reviewedPlan, toolCallText,
} from '../src/permission.ts'

const NO: PermissionOption = { optionId: '1', name: 'No', kind: 'reject_once' }
const ONCE: PermissionOption = { optionId: '2', name: 'Yes, this once', kind: 'allow_once', _meta: { casper: { description: 'Only this write' } } }
const SESSION: PermissionOption = { optionId: '3', name: 'Yes for this session', kind: 'allow_always' }

function request(options: PermissionOption[], preview?: string): RequestPermissionRequest {
  return {
    sessionId: 'acp-session',
    toolCall: {
      toolCallId: 'casper-approval-1',
      title: 'Write outside the project?',
      ...preview === undefined ? {} : { content: [{ type: 'content', content: { type: 'text', text: preview } }] },
    },
    options,
  }
}

function answer(selected: string[], custom?: string): AskUserQuestionAnswer {
  return { answers: [{ id: PERMISSION_QUESTION_ID, selected, ...custom === undefined ? {} : { custom } }] }
}

describe('permissionQuestion', () => {
  it('lists Casper options in order with No first and passes descriptions and the preview through', () => {
    const { question, options } = permissionQuestion(request([NO, ONCE, SESSION], '/elsewhere/file.txt'))
    expect(options.map(option => option.optionId)).toEqual(['1', '2', '3'])
    expect(question).toEqual({
      id: PERMISSION_QUESTION_ID,
      header: CASPER_BOX_HEADER,
      question: 'Write outside the project?',
      detail: '/elsewhere/file.txt',
      options: [{ label: 'No' }, { label: 'Yes, this once', description: 'Only this write' }, { label: 'Yes for this session' }],
      multiSelect: false,
    })
    expect(question.intent).toBeUndefined()
  })

  it('moves refusals first when Casper lists a yes first', () => {
    const reject: PermissionOption = { optionId: '4', name: 'No, and stop', kind: 'reject_always' }
    const { options } = permissionQuestion(request([ONCE, NO, SESSION, reject]))
    expect(options.map(option => option.name)).toEqual(['No', 'No, and stop', 'Yes, this once', 'Yes for this session'])
  })

  it('uses a fixed question when Casper sends no title and ignores odd descriptions', () => {
    const odd: PermissionOption = { optionId: '1', name: 'No', kind: 'reject_once', _meta: { casper: 'text' } }
    const empty: PermissionOption = { optionId: '2', name: 'Yes', kind: 'allow_once', _meta: { casper: { description: '' } } }
    const { question } = permissionQuestion({ sessionId: 's', toolCall: { toolCallId: 't' }, options: [odd, empty] })
    expect(question.question).toBe('Casper asks for permission')
    expect(question.options).toEqual([{ label: 'No' }, { label: 'Yes' }])
    expect(question.detail).toBeUndefined()
  })
})

describe('Casper\'s approval card', () => {
  const FILE = '/work/project/notes.txt'

  function boxWith(content: NonNullable<RequestPermissionRequest['toolCall']['content']>, options = [NO, ONCE, SESSION]): RequestPermissionRequest {
    return { sessionId: 'acp-session', toolCall: { toolCallId: 'casper-approval-1', title: 'Write outside the project?', content }, options }
  }

  it('the question carries Casper\'s header, labels, descriptions and the preview followed by diff lines capped at 120', () => {
    const preview: NonNullable<RequestPermissionRequest['toolCall']['content']>[number] = { type: 'content', content: { type: 'text', text: 'The AI wants to change notes.txt.' } }
    const { question, options } = permissionQuestion(boxWith([
      preview,
      { type: 'diff', path: FILE, oldText: 'one\ntwo\n', newText: 'one\n2\n' },
      { type: 'diff', path: '/work/project/new.txt', oldText: null, newText: 'fresh' },
    ]))
    expect(question).toEqual({
      id: PERMISSION_QUESTION_ID,
      header: 'Casper',
      question: 'Write outside the project?',
      detail: [
        'The AI wants to change notes.txt.',
        '',
        FILE, '- one', '- two', '+ one', '+ 2',
        '/work/project/new.txt', '+ fresh',
      ].join('\n'),
      options: [{ label: 'No' }, { label: 'Yes, this once', description: 'Only this write' }, { label: 'Yes for this session' }],
      multiSelect: false,
    })
    expect(options).toEqual([NO, ONCE, SESSION])
    // A diff alone is the whole detail.
    expect(permissionQuestion(boxWith([{ type: 'diff', path: FILE, newText: 'a' }])).question.detail).toBe(`${FILE}\n+ a`)
    // 200 new lines: the path and 119 lines are shown, and the rest are counted.
    const long = Array.from({ length: 200 }, (_, at) => `line ${String(at + 1)}`).join('\n')
    const capped = permissionQuestion(boxWith([preview, { type: 'diff', path: FILE, oldText: '', newText: long }])).question.detail?.split('\n') ?? []
    expect(capped.slice(2)).toHaveLength(121)
    expect(capped[2]).toBe(FILE)
    expect(capped.at(-2)).toBe('+ line 119')
    expect(capped.at(-1)).toBe('… 81 more lines in the edit step')
    expect(diffText([{ type: 'diff', path: FILE, newText: Array.from({ length: 120 }, () => 'x').join('\n') }])?.split('\n').at(-1)).toBe('… 1 more line in the edit step')
    expect(diffText([{ type: 'diff', path: FILE, newText: Array.from({ length: 119 }, () => 'x').join('\n') }])?.split('\n')).toHaveLength(120)
    expect(diffText([preview])).toBeUndefined()
    expect(diffText(undefined)).toBeUndefined()
    expect(MAX_CARD_OPTIONS).toBe(4)
  })

  it('approvalCard off sets no header', () => {
    const { question } = permissionQuestion(request([NO, ONCE], '/elsewhere/file.txt'), { card: false })
    expect(question.header).toBeUndefined()
    expect(question.detail).toBe('/elsewhere/file.txt')
    expect(question.options).toEqual([{ label: 'No' }, { label: 'Yes, this once', description: 'Only this write' }])
  })

  it('a box without a refusal goes to the generic card, so Esc or Enter on row one never says yes', () => {
    const reject: PermissionOption = { optionId: '4', name: 'No, and stop', kind: 'reject_always' }
    expect(permissionQuestion(request([ONCE, reject])).question.header).toBe(CASPER_BOX_HEADER)
    const { question, options } = permissionQuestion(request([ONCE, SESSION], '/elsewhere/file.txt'))
    expect(question.header).toBeUndefined()
    expect(question.detail).toBe('/elsewhere/file.txt')
    expect(question.options).toEqual([{ label: 'Yes, this once', description: 'Only this write' }, { label: 'Yes for this session' }])
    expect(options).toEqual([ONCE, SESSION])
  })

  it('an answer maps a label to its optionId, and typed text or no pick is cancelled', async () => {
    const asked: AskUserQuestionItem[] = []
    const ask = (answerWith: AskUserQuestionAnswer) => async (question: AskUserQuestionItem) => {
      asked.push(question)
      return answerWith
    }
    const box = request([ONCE, NO, SESSION])
    expect(await answerPermission(box, ask(answer(['Yes for this session'])), () => {})).toEqual({ outcome: { outcome: 'selected', optionId: '3' } })
    expect(await answerPermission(box, ask(answer(['No'])), () => {})).toEqual({ outcome: { outcome: 'selected', optionId: '1' } })
    expect(await answerPermission(box, ask(answer(['Yes, this once'], 'but only here')), () => {})).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(await answerPermission(box, ask(answer([])), () => {})).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(asked.map(question => question.header)).toEqual(['Casper', 'Casper', 'Casper', 'Casper'])
    expect((await answerPermission(box, ask(answer(['No'])), () => {}, { card: false }))).toEqual({ outcome: { outcome: 'selected', optionId: '1' } })
    expect(asked.at(-1)?.header).toBeUndefined()
  })

  it('the check-command box keeps its own labels and ids', () => {
    // Casper's box for checks the sandbox blocked: No keeps the sandbox, and its ids are Casper's own.
    const checks: RequestPermissionRequest = {
      sessionId: 'acp-session',
      toolCall: {
        toolCallId: 'casper-approval-7',
        title: 'test failed because Casper\'s sandbox blocked something, not because of a bug in your code. Run this project\'s checks outside the sandbox?',
      },
      options: [
        { optionId: '1', name: 'No', kind: 'reject_once' },
        { optionId: '2', name: 'Yes, this once', kind: 'allow_once' },
        { optionId: '3', name: 'Yes, for this session', kind: 'allow_always' },
      ],
    }
    const { question, options } = permissionQuestion(checks)
    expect(question.header).toBe('Casper')
    expect(question.options).toEqual([{ label: 'No' }, { label: 'Yes, this once' }, { label: 'Yes, for this session' }])
    expect(options.map(option => option.optionId)).toEqual(['1', '2', '3'])
    expect(permissionOutcome(options, answer(['Yes, for this session']))).toEqual({ outcome: { outcome: 'selected', optionId: '3' } })
    // Run this command? offers four rows, the most the card shows.
    const command = permissionQuestion({ ...checks, toolCall: { toolCallId: 'casper-approval-8', title: 'Run this command?  npm test' }, options: [
      ...checks.options, { optionId: '4', name: 'Yes to everything this session', kind: 'allow_always' },
    ] })
    expect(command.question.options?.map(option => option.label)).toEqual(['No', 'Yes, this once', 'Yes, for this session', 'Yes to everything this session'])
    expect(command.options.map(option => option.optionId)).toEqual(['1', '2', '3', '4'])
  })
})

describe('toolCallText', () => {
  it('reads the first non-empty text content', () => {
    expect(toolCallText(undefined)).toBeUndefined()
    expect(toolCallText(null)).toBeUndefined()
    expect(toolCallText([
      { type: 'diff', path: '/a', newText: 'x' },
      { type: 'content', content: { type: 'text', text: '' } },
      { type: 'content', content: { type: 'text', text: 'shown' } },
    ])).toBe('shown')
  })
})

describe('permissionOutcome', () => {
  const options = [NO, ONCE, SESSION]

  it('selects the option whose label was picked', () => {
    expect(permissionOutcome(options, answer(['Yes, this once']))).toEqual({ outcome: { outcome: 'selected', optionId: '2' } })
    expect(permissionOutcome(options, answer(['No']))).toEqual({ outcome: { outcome: 'selected', optionId: '1' } })
  })

  it('cancels for typed text, an empty or unknown pick, several picks, another question, or no answer', () => {
    const cancelled = { outcome: { outcome: 'cancelled' } }
    expect(permissionOutcome(options, answer(['Yes, this once'], 'only if safe'))).toEqual(cancelled)
    expect(permissionOutcome(options, answer([], 'maybe'))).toEqual(cancelled)
    expect(permissionOutcome(options, answer([]))).toEqual(cancelled)
    expect(permissionOutcome(options, answer(['Yes, always']))).toEqual(cancelled)
    expect(permissionOutcome(options, answer(['No', 'Yes, this once']))).toEqual(cancelled)
    expect(permissionOutcome(options, { answers: [{ id: 'other', selected: ['No'] }] })).toEqual(cancelled)
    expect(permissionOutcome(options, undefined)).toEqual(cancelled)
  })
})

describe('answerPermission', () => {
  const cancelled = { outcome: { outcome: 'cancelled' } }

  it('asks the question and maps the answer', async () => {
    const asked: AskUserQuestionItem[] = []
    const result = await answerPermission(request([ONCE, NO]), async (question) => {
      asked.push(question)
      return answer(['Yes, this once'])
    }, () => {})
    expect(asked[0]?.options?.map(option => option.label)).toEqual(['No', 'Yes, this once'])
    expect(result).toEqual({ outcome: { outcome: 'selected', optionId: '2' } })
  })

  it('cancels when no question service is mounted', async () => {
    expect(await answerPermission(request([NO, ONCE]), undefined, () => {})).toEqual(cancelled)
  })

  it.each([
    new UserQuestionError('ASK_ABORTED', 'aborted'),
    new UserQuestionError('NO_PROVIDER', 'no answerer'),
    new Error('api-remotes: forwarded Remote event source ended'),
  ])('cancels and reports when the ask rejects ($message)', async (failure) => {
    const reported: unknown[] = []
    const answer = await answerPermission(request([NO, ONCE]), () => Promise.reject(failure), (error) => { reported.push(error) })
    expect(answer).toEqual(cancelled)
    expect(reported).toEqual([failure])
  })
})

describe('plan review', () => {
  const STOP: PermissionOption = { optionId: '1', name: 'Stop', kind: 'reject_once', _meta: { casper: { description: 'nothing is built' } } }
  const BUILD: PermissionOption = { optionId: '2', name: 'Build', kind: 'allow_once', _meta: { casper: { description: 'the model builds these steps and tests these cases' } } }
  const CHANGE: PermissionOption = { optionId: '3', name: 'Change the plan', kind: 'reject_once', _meta: { casper: { description: 'tell the model what to change, then choose again' } } }
  const PLAN = '# Add a cache\n\n## Steps\n\n1. Cache the reads.\n'
  const LABELS = { approve: 'Build', change: 'Change the plan' }

  function box(meta: unknown = { plan: LABELS }, text = PLAN, options = [STOP, BUILD, CHANGE]): RequestPermissionRequest {
    return {
      sessionId: 'acp-session',
      toolCall: {
        toolCallId: 'casper-approval-1', title: 'Build this plan?', kind: 'other', status: 'pending',
        content: [{ type: 'content', content: { type: 'text', text } }],
        _meta: { casper: meta },
      },
      options,
    }
  }

  it('a plan review item names Build and Change the plan', () => {
    const callId = ToolCallId('casper:epoch:casper-approval-1')
    const { question, options, change } = permissionQuestion(box(), { callId })
    expect(question).toEqual({
      id: PERMISSION_QUESTION_ID,
      header: 'Plan review',
      question: 'Build this plan?',
      detail: PLAN,
      options: [
        { label: 'Build', description: 'the model builds these steps and tests these cases' },
        { label: 'Change the plan', description: 'tell the model what to change, then choose again' },
      ],
      multiSelect: false,
      intent: { kind: 'plan-review', approve: 'Build', callId },
    })
    expect(options).toEqual([BUILD, CHANGE])
    expect(change).toBe(CHANGE)
    expect(permissionQuestion(box()).question.intent).toEqual({ kind: 'plan-review', approve: 'Build' })
    const untitled = box()
    delete untitled.toolCall.title
    expect(permissionQuestion(untitled).question.question).toBe('Build this plan?')
    expect(permissionOutcome(options, answer(['Build']))).toEqual({ outcome: { outcome: 'selected', optionId: '2' } })
    expect(permissionOutcome(options, answer(['Change the plan']))).toEqual({ outcome: { outcome: 'selected', optionId: '3' } })
    expect(permissionOutcome(options, answer(['Stop']))).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('asks a box as usual when its plan labels or its titled plan are missing or do not match its options', () => {
    for (const odd of [
      box(null),
      box({ plan: 'Build' }),
      box({ plan: { approve: 'Build' } }),
      box({ plan: { approve: 'Build', change: 'Build' } }),
      box({ plan: { approve: 'Go', change: 'Change the plan' } }),
      box({ plan: LABELS }, 'Add a cache'),
      box({ plan: LABELS }, PLAN, [STOP, BUILD]),
    ]) {
      const { question, options, change } = permissionQuestion(odd)
      expect(question.intent).toBeUndefined()
      // Asked as any other box: Casper's card, not the plan card.
      expect(question.header).toBe(CASPER_BOX_HEADER)
      expect(change).toBeUndefined()
      expect(options[0]).toBe(STOP)
    }
    expect(planLabels({ _meta: { casper: { plan: LABELS } } })).toEqual(LABELS)
    expect(planLabels({ _meta: null })).toBeUndefined()
    expect(reviewedPlan(box().toolCall)).toBe(PLAN)
    expect(reviewedPlan({ content: box().toolCall.content ?? null })).toBeUndefined()
  })

  it('Build selects Build, and Discuss selects the change option', async () => {
    expect(await answerPermission(box(), async () => answer(['Build']), () => {})).toEqual({ outcome: { outcome: 'selected', optionId: '2' } })
    const reported: unknown[] = []
    const discussed = await answerPermission(box(), () => Promise.reject(new UserQuestionError('dismissed', 'ASK_CANCELLED')), (error) => { reported.push(error) })
    expect(discussed).toEqual({ outcome: { outcome: 'selected', optionId: '3' } })
    expect(reported).toEqual([])
    // Any other box that is dismissed is still No.
    const other = await answerPermission(request([NO, ONCE]), () => Promise.reject(new UserQuestionError('dismissed', 'ASK_CANCELLED')), () => {})
    expect(other).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it.each([
    new UserQuestionError('timed out', 'ASK_TIMED_OUT'),
    new UserQuestionError('aborted', 'ASK_ABORTED'),
    new Error('api-remotes: forwarded Remote event source ended'),
  ])('a timeout or abort is cancelled, which Casper treats as Stop ($message)', async (failure) => {
    const reported: unknown[] = []
    expect(await answerPermission(box(), () => Promise.reject(failure), (error) => { reported.push(error) })).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(reported).toEqual([failure])
    expect(await answerPermission(box(), undefined, () => {})).toEqual({ outcome: { outcome: 'cancelled' } })
  })
})
