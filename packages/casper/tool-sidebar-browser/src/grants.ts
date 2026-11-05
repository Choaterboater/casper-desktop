/**
 * Per-site permission for browser input. A Session allows an origin once; the grant then holds for every later
 * click, type, key, and scroll on that origin in the Session.
 *
 * A grant is remembered in two places. The live set covers the running Session, including calls made from code
 * mode, whose nested results are not logged. The durable set is folded from the Session log: every successful
 * input result records its origin in `tool/result` metadata, so a reopened or forked Session keeps the origins its
 * log proves were used with permission. A grant whose first input failed is live only.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition, ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { UserQuestionError, type AskUserQuestionAnswer, type AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { z } from 'zod'
import { untilAborted } from './abort.ts'
import { siteAccessDisplay } from './locales.ts'

/** Tools whose successful results prove that their origin was allowed. */
export const INPUT_TOOLS: ReadonlySet<string> = new Set(['browser_click', 'browser_type', 'browser_key', 'browser_scroll'])

/** Answer labels of the permission question; the Client localizes what it shows. */
export const ALLOW = 'Allow'
/** Refusal label of the permission question. */
export const DONT_ALLOW = 'Don\'t allow'
/** Question id echoed in the answer. */
export const QUESTION_ID = 'casper-sidebar-browser-site'

/** Durable grants: allowed origins, plus input calls of the current turn whose results have not arrived. */
export interface GrantState {
  origins: string[]
  calls: string[]
}

const EMPTY: GrantState = { origins: [], calls: [] }

/**
 * Read the origin a successful input result recorded.
 * @param meta - `tool/result` metadata.
 * @returns the origin, or `undefined` when the metadata records none.
 */
export function grantedOrigin(meta: JsonValue | undefined): string | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const origin = meta.origin
  return typeof origin === 'string' ? origin : undefined
}

/** Host-only projection of the origins a Session's log proves were allowed. */
export const grantProjection = {
  key: 'casperSidebarBrowserGrants',
  stateVersion: 1,
  stateSchema: z.object({ origins: z.array(z.string()), calls: z.array(z.string()) }),
  init: (): GrantState => EMPTY,
  apply(state: GrantState, event: SessionEvent): GrantState {
    switch (event.type) {
      case 'tool/call':
        return INPUT_TOOLS.has(event.data.name) ? { ...state, calls: [...state.calls, event.data.callId] } : state
      case 'tool/result': {
        const callId = event.data.message.toolCallId
        if (!state.calls.includes(callId)) return state
        const calls = state.calls.filter(id => id !== callId)
        const origin = event.data.message.isError === true ? undefined : grantedOrigin(event.data.meta)
        const origins = origin === undefined || state.origins.includes(origin) ? state.origins : [...state.origins, origin]
        return { origins, calls }
      }
      case 'turn/end':
        return state.calls.length === 0 ? state : { ...state, calls: [] }
      default:
        return state
    }
  },
} satisfies ProjectionDefinition<'casperSidebarBrowserGrants', GrantState>

/** Outcome of a permission check. */
export type GrantDecision =
  | { readonly granted: true }
  | { readonly granted: false; readonly code: 'declined' | 'unavailable'; readonly message: string }

/**
 * Build the permission question for one origin.
 * @param origin - the site's origin.
 * @returns the single approval question.
 */
export function siteQuestion(origin: string): AskUserQuestionItem {
  return {
    id: QUESTION_ID,
    question: `Allow Casper to click and type on ${origin}?`,
    detail: `Casper can then click, type, press keys, and scroll on ${origin} pages in this conversation's browser tabs.`,
    options: [{ label: ALLOW }, { label: DONT_ALLOW }],
    intent: { kind: 'approval', approve: ALLOW, reject: DONT_ALLOW, subject: { name: origin }, display: siteAccessDisplay },
  }
}

function chosen(answer: AskUserQuestionAnswer): boolean {
  const item = answer.answers.find(candidate => candidate.id === QUESTION_ID)
  return item !== undefined && (item.custom ?? '').trim() === '' && item.selected.length === 1 && item.selected[0] === ALLOW
}

const GRANTED: GrantDecision = { granted: true }

/** Per-site permission for one plugin instance: the durable projection plus live grants and pending questions. */
export class SiteGrants {
  private readonly live = new WeakMap<Session, Set<string>>()
  private readonly asking = new WeakMap<Session, Map<string, Promise<GrantDecision>>>()

  /**
   * @param ctx - plugin context that resolves the optional `userQuestions` service.
   * @param projection - registered {@link grantProjection} handle.
   */
  constructor(private readonly ctx: Context, private readonly projection: ProjectionHandle<GrantState>) {}

  /**
   * Check the live and durable grants without asking.
   * @param session - the calling Session.
   * @param origin - the site's origin.
   * @returns whether the Session already allowed the origin.
   */
  allowed(session: Session, origin: string): boolean {
    return this.live.get(session)?.has(origin) === true || this.projection.stateOf(session).origins.includes(origin)
  }

  /**
   * Ask the user once per Session and origin. A call that finds the same origin's question open waits for its
   * answer instead of asking again, and asks itself only when that question failed. A refusal is not remembered,
   * so a later call asks again.
   * @param agent - live calling Agent; its Session owns the grant.
   * @param origin - the site's origin.
   * @param signal - tool-call cancellation.
   * @returns the decision.
   * @throws `signal.reason` when `signal` aborts, or an unexpected question failure.
   */
  async request(agent: Agent, origin: string, signal: AbortSignal): Promise<GrantDecision> {
    const session = agent.session
    const pending = this.asking.get(session) ?? new Map<string, Promise<GrantDecision>>()
    this.asking.set(session, pending)
    for (;;) {
      signal.throwIfAborted()
      if (this.allowed(session, origin)) return GRANTED
      const shared = pending.get(origin)
      if (shared === undefined) {
        const asked = this.ask(agent, origin, signal)
        pending.set(origin, asked)
        try {
          return await asked
        } finally {
          pending.delete(origin)
        }
      }
      const answered = await untilAborted(shared.then(decision => decision, () => undefined), signal)
      if (answered !== undefined) return answered
    }
  }

  private async ask(agent: Agent, origin: string, signal: AbortSignal): Promise<GrantDecision> {
    const questions = this.ctx.get('userQuestions')
    if (questions === undefined) return unavailable('Clicking and typing need the user\'s permission, and no one can be asked here.')
    let answer: AskUserQuestionAnswer
    try {
      answer = await questions.ask({ agent, signal, questions: [siteQuestion(origin)] })
    } catch (error) {
      if (!(error instanceof UserQuestionError)) throw error
      switch (error.code) {
        case 'ASK_CANCELLED':
          return declined(origin)
        case 'DELEGATED_CALLER':
          return unavailable('A delegated task cannot ask the user for site permission. Report what you need to click or type so the main task can do it.')
        case 'NO_PROVIDER':
          return unavailable('Clicking and typing need the user\'s permission, and no one answered the question. The Casper desktop app must show this conversation.')
        default:
          throw error
      }
    }
    if (!chosen(answer)) return declined(origin)
    const live = this.live.get(agent.session) ?? new Set<string>()
    live.add(origin)
    this.live.set(agent.session, live)
    return GRANTED
  }
}

function unavailable(message: string): GrantDecision {
  return { granted: false, code: 'unavailable', message }
}

function declined(origin: string): GrantDecision {
  return {
    granted: false,
    code: 'declined',
    message: `The user declined to let you click or type on ${origin}. Do not retry on this site unless the user asks you to.`,
  }
}
