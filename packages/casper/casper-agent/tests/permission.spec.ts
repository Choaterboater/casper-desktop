import { describe, expect, it } from 'vitest'
import type { PermissionOption, RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { answerPermission, PERMISSION_QUESTION_ID, permissionOutcome, permissionQuestion, toolCallText } from '../src/permission.ts'

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
