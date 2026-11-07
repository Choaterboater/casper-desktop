/**
 * Casper's forms (`elicitation/create`) as one user question.
 * @module @deepseek-ai/dsh-casper-agent/elicitation
 */

import type { CreateElicitationRequest, CreateElicitationResponse } from '@agentclientprotocol/sdk'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { CASPER_QUESTION_ID } from './views.ts'

/** One choice of a form: the value Casper reads back and the label shown. */
interface FormChoice {
  readonly value: string
  readonly label: string
  readonly description: string | undefined
}

/** A form in the shape Casper sends: one `answer` field and, when typed words count, an `other` field. */
interface CasperForm {
  /** The choices of a pick, in order; undefined for a typed line. */
  readonly choices: readonly FormChoice[] | undefined
  /** Whether several choices may be picked. */
  readonly multi: boolean
  /** Whether the form takes typed words beside a pick. */
  readonly other: boolean
  /** Whether the question is the AI's own, not Casper's. */
  readonly fromAi: boolean
}

type Fields = Readonly<Record<string, unknown>>

function record(value: unknown): Fields | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Fields : undefined
}

/** The titled choices of a `oneOf` or `anyOf` list; undefined when any entry is not one. */
function choicesOf(list: unknown): FormChoice[] | undefined {
  if (!Array.isArray(list) || list.length === 0) return undefined
  const choices: FormChoice[] = []
  for (const entry of list) {
    const option = record(entry)
    if (typeof option?.const !== 'string' || typeof option.title !== 'string') return undefined
    const description = typeof option.description === 'string' && option.description !== '' ? option.description : undefined
    choices.push({ value: option.const, label: option.title, description })
  }
  return choices
}

/**
 * Read a form Casper sends: form mode, properties `answer` and optionally
 * `other`, nothing else. `answer` is a titled single pick (`oneOf`), a
 * titled multi pick (`items.anyOf`), or a plain string for a typed line.
 */
function formOf(params: CreateElicitationRequest): CasperForm | undefined {
  if (params.mode !== 'form' || !('requestedSchema' in params)) return undefined
  const properties = record(record(params.requestedSchema)?.properties)
  if (properties === undefined || !('answer' in properties)) return undefined
  if (Object.keys(properties).some(key => key !== 'answer' && key !== 'other')) return undefined
  const answer = record(properties.answer)
  const other = properties.other !== undefined
  if (answer === undefined || (other && record(properties.other)?.type !== 'string')) return undefined
  const fromAi = record(record(params._meta?.casper)?.question)?.from === 'ai'
  if (answer.type === 'array') {
    const choices = choicesOf(record(answer.items)?.anyOf)
    return choices === undefined ? undefined : { choices, multi: true, other, fromAi }
  }
  if (answer.type !== 'string' || answer.enum !== undefined) return undefined
  // A typed line's words are its answer, so a line has no separate `other`.
  if (answer.oneOf === undefined) return { choices: undefined, multi: false, other: false, fromAi }
  const choices = choicesOf(answer.oneOf)
  return choices === undefined ? undefined : { choices, multi: false, other, fromAi }
}

/**
 * The ACP tool call a form belongs to.
 * @param params - Casper's request.
 * @returns the step's ACP id, or undefined when the form names none.
 */
export function elicitationStep(params: CreateElicitationRequest): string | undefined {
  const id: unknown = 'toolCallId' in params ? params.toolCallId : undefined
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * Build the question for one `elicitation/create`.
 * @param params - Casper's request.
 * @returns the question, headed `The AI asks` for the AI's own question and `Casper asks` otherwise;
 *   undefined for a form not in the shape Casper sends.
 */
export function elicitationQuestion(params: CreateElicitationRequest): AskUserQuestionItem | undefined {
  const form = formOf(params)
  if (form === undefined) return undefined
  return {
    id: CASPER_QUESTION_ID,
    header: form.fromAi ? 'The AI asks' : 'Casper asks',
    question: params.message,
    ...form.choices === undefined
      ? {}
      : {
        options: form.choices.map(({ label, description }) => ({ label, ...description === undefined ? {} : { description } })),
        multiSelect: form.multi,
      },
  }
}

/**
 * Map the user's answer to Casper's reply. Picked labels map back to their
 * values in the order picked, unknown labels are dropped, and typed words go
 * in `other` only when the form has it; a typed line's words are its
 * `answer`. Typed words on a pick-only form decline; no answer cancels.
 * @param params - Casper's request.
 * @param answer - the answer, or undefined when the question failed.
 * @returns the `elicitation/create` result.
 */
export function elicitationOutcome(params: CreateElicitationRequest, answer: AskUserQuestionAnswer | undefined): CreateElicitationResponse {
  const form = formOf(params)
  if (form === undefined) return { action: 'decline' }
  const item = answer?.answers.find(entry => entry.id === CASPER_QUESTION_ID)
  if (item === undefined) return { action: 'cancel' }
  const typed = item.custom !== undefined && item.custom.trim() !== '' ? item.custom : undefined
  if (form.choices === undefined) return typed === undefined ? { action: 'cancel' } : { action: 'accept', content: { answer: typed } }
  const choices = form.choices
  const values = [...new Set(item.selected.flatMap((label) => {
    const choice = choices.find(entry => entry.label === label)
    return choice === undefined ? [] : [choice.value]
  }))]
  if (typed !== undefined && !form.other) return { action: 'decline' }
  if (values.length === 0 && typed === undefined) return { action: 'cancel' }
  const [first] = values
  const picked = form.multi ? values.length === 0 ? {} : { answer: values } : first === undefined ? {} : { answer: first }
  return { action: 'accept', content: { ...picked, ...typed === undefined ? {} : { other: typed } } }
}

/**
 * Ask the user one form and map the answer. A form not in Casper's shape
 * declines; a missing question service and a failed ask cancel.
 * @param params - Casper's request.
 * @param ask - asks the user-questions service, or undefined when none is mounted.
 * @param onError - receives a failed ask for logging.
 * @returns the reply for Casper; never rejects.
 */
export async function answerElicitation(
  params: CreateElicitationRequest,
  ask: ((question: AskUserQuestionItem) => Promise<AskUserQuestionAnswer>) | undefined,
  onError: (error: unknown) => void,
): Promise<CreateElicitationResponse> {
  const question = elicitationQuestion(params)
  if (question === undefined) return { action: 'decline' }
  if (ask === undefined) return { action: 'cancel' }
  try {
    return elicitationOutcome(params, await ask(question))
  } catch (error: unknown) {
    onError(error)
    return { action: 'cancel' }
  }
}
