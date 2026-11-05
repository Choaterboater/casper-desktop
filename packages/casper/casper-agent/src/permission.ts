/**
 * Casper's numbered approval boxes as one user question.
 * @module @deepseek-ai/dsh-casper-agent/permission
 */

import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'

/** The question id every Casper approval uses. */
export const PERMISSION_QUESTION_ID = 'casper-permission'

/** One approval box prepared for the user-questions service. */
export interface PermissionQuestion {
  /** The question shown to the user; its option labels are Casper's choice names. */
  readonly question: AskUserQuestionItem
  /** Casper's options in the order shown: refusals first, then Casper's own order. */
  readonly options: readonly PermissionOption[]
}

/**
 * Read the first non-empty text content of an ACP tool call or update.
 * @param content - the tool call's content list.
 * @returns the text, or undefined when there is none.
 */
export function toolCallText(content: RequestPermissionRequest['toolCall']['content']): string | undefined {
  for (const item of content ?? []) {
    if (item.type === 'content' && item.content.type === 'text' && item.content.text !== '') return item.content.text
  }
  return undefined
}

/**
 * Build the question for one `session/request_permission`.
 * @param params - Casper's request.
 * @returns the question and the options in question order.
 */
export function permissionQuestion(params: RequestPermissionRequest): PermissionQuestion {
  const refusal = (option: PermissionOption): boolean => option.kind === 'reject_once' || option.kind === 'reject_always'
  const options = [...params.options.filter(refusal), ...params.options.filter(option => !refusal(option))]
  const detail = toolCallText(params.toolCall.content)
  return {
    options,
    question: {
      id: PERMISSION_QUESTION_ID,
      question: params.toolCall.title ?? 'Casper asks for permission',
      ...detail === undefined ? {} : { detail },
      options: options.map((option) => {
        const description = descriptionOf(option)
        return { label: option.name, ...description === undefined ? {} : { description } }
      }),
      multiSelect: false,
    },
  }
}

function descriptionOf(option: PermissionOption): string | undefined {
  const casper: unknown = option._meta?.casper
  if (typeof casper !== 'object' || casper === null) return undefined
  const description: unknown = Reflect.get(casper, 'description')
  return typeof description === 'string' && description !== '' ? description : undefined
}

/**
 * Map the user's answer to Casper's reply. Only one picked label that names an
 * option, with no typed text, selects that option; anything else is
 * `cancelled`, which Casper treats as No.
 * @param options - the options in question order.
 * @param answer - the answer, or undefined when the question failed.
 * @returns the `session/request_permission` result.
 */
export function permissionOutcome(
  options: readonly PermissionOption[],
  answer: AskUserQuestionAnswer | undefined,
): RequestPermissionResponse {
  const item = answer?.answers.find(entry => entry.id === PERMISSION_QUESTION_ID)
  const picked = item !== undefined && item.selected.length === 1 && (item.custom ?? '') === ''
    ? options.find(option => option.name === item.selected[0])
    : undefined
  return picked === undefined
    ? { outcome: { outcome: 'cancelled' } }
    : { outcome: { outcome: 'selected', optionId: picked.optionId } }
}

/**
 * Ask the user one approval box and map the answer. Every failure of the ask,
 * including a missing question service, answers `cancelled`.
 * @param params - Casper's request.
 * @param ask - asks the user-questions service, or undefined when none is mounted.
 * @param onError - receives a failed ask for logging.
 * @returns the reply for Casper; never rejects.
 */
export async function answerPermission(
  params: RequestPermissionRequest,
  ask: ((question: AskUserQuestionItem) => Promise<AskUserQuestionAnswer>) | undefined,
  onError: (error: unknown) => void,
): Promise<RequestPermissionResponse> {
  const { question, options } = permissionQuestion(params)
  if (ask === undefined) return permissionOutcome(options, undefined)
  try {
    return permissionOutcome(options, await ask(question))
  } catch (error: unknown) {
    onError(error)
    return permissionOutcome(options, undefined)
  }
}
