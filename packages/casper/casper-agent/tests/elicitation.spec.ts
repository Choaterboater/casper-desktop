import { describe, expect, it, vi } from 'vitest'
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import { answerElicitation, elicitationOutcome, elicitationQuestion, elicitationStep } from '../src/elicitation.ts'

const CHOICES = [
  { const: '1', title: 'SQLite', description: 'one file' },
  { const: '2', title: 'Postgres' },
  { const: '3', title: 'MySQL' },
]

/** A form in the shape Casper sends. */
function form(answer: Record<string, unknown>, extra: Record<string, unknown> = {}, from = 'casper'): CreateElicitationRequest {
  return {
    sessionId: 's-1', toolCallId: 'casper-question-1', mode: 'form', message: 'Which database?',
    requestedSchema: { type: 'object', properties: { answer, ...extra }, required: [] },
    _meta: { casper: { question: { from, multi: answer.type === 'array', typed: 'other' in extra } } },
  }
}

const pick = (typed = false) => form({ type: 'string', title: 'Choose', oneOf: CHOICES }, typed ? { other: { type: 'string', title: 'Or type your answer' } } : {})
const multi = (typed = false) => form({ type: 'array', items: { anyOf: CHOICES } }, typed ? { other: { type: 'string', title: 'Or type your answer' } } : {})
const line = () => form({ type: 'string', title: 'Your answer' })

function answer(selected: string[], custom?: string, id = 'casper-question'): AskUserQuestionAnswer {
  return { answers: [{ id, selected, ...custom === undefined ? {} : { custom } }] }
}

describe('Casper forms', () => {
  it('a form maps to a question', () => {
    expect(elicitationQuestion(form({ type: 'string', title: 'Choose', oneOf: CHOICES }, {}, 'ai'))).toEqual({
      id: 'casper-question', header: 'The AI asks', question: 'Which database?',
      options: [{ label: 'SQLite', description: 'one file' }, { label: 'Postgres' }, { label: 'MySQL' }],
      multiSelect: false,
    })
    expect(elicitationQuestion(multi(true))).toMatchObject({ header: 'Casper asks', multiSelect: true, options: [{ label: 'SQLite' }, { label: 'Postgres' }, { label: 'MySQL' }] })
    expect(elicitationQuestion(line())).toEqual({ id: 'casper-question', header: 'Casper asks', question: 'Which database?' })
    expect(elicitationStep(line())).toBe('casper-question-1')
    expect(elicitationStep({ ...line(), toolCallId: null })).toBeUndefined()
  })

  it('labels map back to consts', () => {
    expect(elicitationOutcome(pick(), answer(['Postgres']))).toEqual({ action: 'accept', content: { answer: '2' } })
    expect(elicitationOutcome(pick(true), answer(['Postgres'], 'version 16'))).toEqual({ action: 'accept', content: { answer: '2', other: 'version 16' } })
    expect(elicitationOutcome(pick(true), answer([], 'DuckDB'))).toEqual({ action: 'accept', content: { other: 'DuckDB' } })
    // Picks keep their order; unknown and repeated labels are dropped.
    expect(elicitationOutcome(multi(), answer(['MySQL', 'Oracle', 'SQLite', 'MySQL']))).toEqual({ action: 'accept', content: { answer: ['3', '1'] } })
    expect(elicitationOutcome(multi(true), answer(['SQLite'], 'and a cache'))).toEqual({ action: 'accept', content: { answer: ['1'], other: 'and a cache' } })
    expect(elicitationOutcome(line(), answer([], '  the  usual  '))).toEqual({ action: 'accept', content: { answer: '  the  usual  ' } })
  })

  it('custom text on a pick-only form declines', () => {
    expect(elicitationOutcome(pick(), answer(['Postgres'], 'version 16'))).toEqual({ action: 'decline' })
    expect(elicitationOutcome(multi(), answer([], 'neither'))).toEqual({ action: 'decline' })
  })

  it('no answer cancels', () => {
    expect(elicitationOutcome(pick(), undefined)).toEqual({ action: 'cancel' })
    expect(elicitationOutcome(pick(), answer([]))).toEqual({ action: 'cancel' })
    expect(elicitationOutcome(pick(true), answer(['Oracle'], '   '))).toEqual({ action: 'cancel' })
    expect(elicitationOutcome(pick(), answer(['Postgres'], undefined, 'another'))).toEqual({ action: 'cancel' })
    expect(elicitationOutcome(line(), answer([]))).toEqual({ action: 'cancel' })
  })

  it('an unknown shape declines', async () => {
    const unknown: CreateElicitationRequest[] = [
      { sessionId: 's-1', mode: 'url', elicitationId: 'e-1', url: 'https://example.invalid', message: 'Sign in' },
      form({ type: 'string' }, { extra: { type: 'string' } }),
      form({ type: 'string', enum: ['a', 'b'] }),
      form({ type: 'number' }),
      form({ type: 'string', oneOf: [] }),
      form({ type: 'string', oneOf: [{ const: 1, title: 'one' }] }),
      form({ type: 'array', items: { type: 'string', enum: ['a'] } }),
      form({ type: 'string', oneOf: CHOICES }, { other: { type: 'number' } }),
      { ...line(), requestedSchema: { type: 'object', properties: { other: { type: 'string' } } } },
    ]
    for (const params of unknown) {
      expect(elicitationQuestion(params)).toBeUndefined()
      expect(elicitationOutcome(params, answer(['SQLite']))).toEqual({ action: 'decline' })
      expect(await answerElicitation(params, undefined, () => {})).toEqual({ action: 'decline' })
    }
  })

  it('asks the question and cancels without a question service or when the ask fails', async () => {
    const ask = vi.fn(() => Promise.resolve(answer(['SQLite'])))
    expect(await answerElicitation(pick(), ask, () => {})).toEqual({ action: 'accept', content: { answer: '1' } })
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ id: 'casper-question', question: 'Which database?' }))
    expect(await answerElicitation(pick(), undefined, () => {})).toEqual({ action: 'cancel' })
    const failures: unknown[] = []
    expect(await answerElicitation(pick(), () => Promise.reject(new Error('dismissed')), (error) => { failures.push(error) })).toEqual({ action: 'cancel' })
    expect(failures).toHaveLength(1)
  })
})
