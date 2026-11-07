/**
 * Casper's numbered approval boxes as one user question.
 * @module @deepseek-ai/dsh-casper-agent/permission
 */

import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse, ToolCallUpdate } from '@agentclientprotocol/sdk'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'

/** The question id every Casper approval uses. */
export const PERMISSION_QUESTION_ID = 'casper-permission'

/** The header of Casper's plan Build box in the app. */
export const PLAN_REVIEW_HEADER = 'Plan review'

/** One approval box prepared for the user-questions service. */
export interface PermissionQuestion {
  /** The question shown to the user; its option labels are Casper's choice names. */
  readonly question: AskUserQuestionItem
  /** Casper's options in the order shown: refusals first, then Casper's own order; a plan review offers only its two. */
  readonly options: readonly PermissionOption[]
  /** For a plan review, the option a dismissed review (Discuss) selects: Casper's "Change the plan". */
  readonly change?: PermissionOption
}

/** Inputs of {@link permissionQuestion} beyond Casper's request. */
export interface PermissionQuestionOptions {
  /** The Session call id the box's step is recorded under, so a plan review reopens its plan. */
  readonly callId?: ToolCallId | undefined
}

/** The option labels of Casper's plan Build box, from `_meta.casper.plan`. */
export interface PlanLabels {
  /** The label that builds the plan. */
  readonly approve: string
  /** The label that asks what should change. */
  readonly change: string
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
 * Read the labels of Casper's plan Build box.
 * @param call - the box's tool call, from its `tool_call` update or its request.
 * @returns the labels, or undefined when the call is not a plan box.
 */
export function planLabels(call: Pick<ToolCallUpdate, '_meta'>): PlanLabels | undefined {
  const casper: unknown = call._meta?.casper
  if (typeof casper !== 'object' || casper === null) return undefined
  const plan: unknown = Reflect.get(casper, 'plan')
  if (typeof plan !== 'object' || plan === null) return undefined
  const approve: unknown = Reflect.get(plan, 'approve')
  const change: unknown = Reflect.get(plan, 'change')
  if (typeof approve !== 'string' || approve === '' || typeof change !== 'string' || change === '' || approve === change) return undefined
  return { approve, change }
}

/**
 * Read the plan a Build box shows: its Markdown, which starts with a `# ` title.
 * @param call - the box's tool call.
 * @returns the Markdown, or undefined when the call is not a plan box or carries no titled plan.
 */
export function reviewedPlan(call: Pick<ToolCallUpdate, '_meta' | 'content'>): string | undefined {
  if (planLabels(call) === undefined) return undefined
  const text = toolCallText(call.content)
  return text !== undefined && /^#\s+\S/.test(text) ? text : undefined
}

/**
 * Build the question for one `session/request_permission`. Casper's plan
 * Build box (`_meta.casper.plan`) becomes a plan review: its Build and Change
 * the plan options, the plan as the detail, and the `plan-review` intent, so
 * the app shows its plan card. A box that names options it does not offer, or
 * carries no titled plan, is asked as any other box.
 * @param params - Casper's request.
 * @param extra - the call id of the box's step.
 * @returns the question and the options in question order.
 */
export function permissionQuestion(params: RequestPermissionRequest, extra: PermissionQuestionOptions = {}): PermissionQuestion {
  const review = planReview(params, extra)
  if (review !== undefined) return review
  const refusal = (option: PermissionOption): boolean => option.kind === 'reject_once' || option.kind === 'reject_always'
  const options = [...params.options.filter(refusal), ...params.options.filter(option => !refusal(option))]
  const detail = toolCallText(params.toolCall.content)
  return {
    options,
    question: {
      id: PERMISSION_QUESTION_ID,
      question: params.toolCall.title ?? 'Casper asks for permission',
      ...detail === undefined ? {} : { detail },
      options: options.map(labelOf),
      multiSelect: false,
    },
  }
}

/** The plan review for a Build box whose labels name its options, else undefined. */
function planReview(params: RequestPermissionRequest, extra: PermissionQuestionOptions): PermissionQuestion | undefined {
  const labels = planLabels(params.toolCall)
  const plan = reviewedPlan(params.toolCall)
  if (labels === undefined || plan === undefined) return undefined
  const approve = params.options.find(option => option.name === labels.approve)
  const change = params.options.find(option => option.name === labels.change)
  if (approve === undefined || change === undefined) return undefined
  const options = [approve, change]
  return {
    options,
    change,
    question: {
      id: PERMISSION_QUESTION_ID,
      header: PLAN_REVIEW_HEADER,
      question: params.toolCall.title ?? 'Build this plan?',
      detail: plan,
      options: options.map(labelOf),
      multiSelect: false,
      intent: { kind: 'plan-review', approve: approve.name, ...extra.callId === undefined ? {} : { callId: extra.callId } },
    },
  }
}

function labelOf(option: PermissionOption): { label: string; description?: string } {
  const description = descriptionOf(option)
  return { label: option.name, ...description === undefined ? {} : { description } }
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
 * including a missing question service, answers `cancelled`. A plan review
 * the user dismissed to say what should change (Discuss, a `UserQuestionError`
 * with code `ASK_CANCELLED`) selects Casper's Change the plan; any other
 * failure stays `cancelled`, which Casper treats as Stop.
 * @param params - Casper's request.
 * @param ask - asks the user-questions service, or undefined when none is mounted.
 * @param onError - receives a failed ask for logging.
 * @param extra - the call id of the box's step.
 * @returns the reply for Casper; never rejects.
 */
export async function answerPermission(
  params: RequestPermissionRequest,
  ask: ((question: AskUserQuestionItem) => Promise<AskUserQuestionAnswer>) | undefined,
  onError: (error: unknown) => void,
  extra: PermissionQuestionOptions = {},
): Promise<RequestPermissionResponse> {
  const { question, options, change } = permissionQuestion(params, extra)
  if (ask === undefined) return permissionOutcome(options, undefined)
  try {
    return permissionOutcome(options, await ask(question))
  } catch (error: unknown) {
    if (change !== undefined && error instanceof UserQuestionError && error.code === 'ASK_CANCELLED') {
      return { outcome: { outcome: 'selected', optionId: change.optionId } }
    }
    onError(error)
    return permissionOutcome(options, undefined)
  }
}
