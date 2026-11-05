import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { UserQuestionError, type AskUserQuestionAnswer, type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import {
  ALLOW, DONT_ALLOW, grantedOrigin, grantProjection, QUESTION_ID, siteQuestion, SiteGrants, type GrantState,
} from '../src/grants.ts'

const ORIGIN = 'https://shop.test'

function call(name: string, id: string): SessionEvent {
  return { type: 'tool/call', data: { turn: 1, step: 1, callId: ToolCallId(id), name, arguments: '{}' } } as SessionEvent
}

function result(id: string, meta?: unknown, isError = false): SessionEvent {
  const message = createToolResultMessage({ callId: ToolCallId(id), content: [], isError })
  return { type: 'tool/result', data: { turn: 1, step: 1, message, ...meta === undefined ? {} : { meta } } } as SessionEvent
}

function fold(events: readonly SessionEvent[]): GrantState {
  return events.reduce((state, event) => grantProjection.apply(state, event), grantProjection.init())
}

describe('grant projection', () => {
  it('records the origin of a successful input result and nothing else', () => {
    expect(fold([call('browser_click', 'c1'), result('c1', { origin: ORIGIN })])).toEqual({ origins: [ORIGIN], calls: [] })
    expect(fold([call('browser_read', 'r1'), result('r1', { origin: ORIGIN })])).toEqual({ origins: [], calls: [] })
    expect(fold([call('browser_type', 't1'), result('t1', { origin: ORIGIN }, true)])).toEqual({ origins: [], calls: [] })
    expect(fold([call('browser_key', 'k1'), result('k1', null)])).toEqual({ origins: [], calls: [] })
    expect(fold([call('browser_scroll', 's1'), result('s1')])).toEqual({ origins: [], calls: [] })
  })

  it('keeps one entry per origin', () => {
    expect(fold([
      call('browser_click', 'c1'), result('c1', { origin: ORIGIN }),
      call('browser_click', 'c2'), result('c2', { origin: ORIGIN }),
    ]).origins).toEqual([ORIGIN])
  })

  it('returns the same state for unrelated events and clears unanswered calls at turn end', () => {
    const start = grantProjection.init()
    expect(grantProjection.apply(start, call('bash', 'b1'))).toBe(start)
    expect(grantProjection.apply(start, result('b1', { origin: ORIGIN }))).toBe(start)
    expect(grantProjection.apply(start, { type: 'turn/end', data: {} } as SessionEvent)).toBe(start)
    expect(grantProjection.apply(start, { type: 'turn/start', data: {} } as SessionEvent)).toBe(start)
    const pending = fold([call('browser_click', 'c1')])
    expect(pending.calls).toEqual(['c1'])
    expect(grantProjection.apply(pending, { type: 'turn/end', data: {} } as SessionEvent)).toEqual({ origins: [], calls: [] })
    expect(grantProjection.stateSchema.parse({ origins: [ORIGIN], calls: [] })).toEqual({ origins: [ORIGIN], calls: [] })
  })

  it('reads only a string origin from result metadata', () => {
    expect(grantedOrigin({ origin: ORIGIN })).toBe(ORIGIN)
    expect(grantedOrigin(undefined)).toBeUndefined()
    expect(grantedOrigin(null)).toBeUndefined()
    expect(grantedOrigin('https://x.test')).toBeUndefined()
    expect(grantedOrigin([ORIGIN])).toBeUndefined()
    expect(grantedOrigin({ origin: 1 })).toBeUndefined()
  })
})

describe('site permission question', () => {
  it('asks one approval question naming the origin', () => {
    const question = siteQuestion(ORIGIN)
    expect(question).toMatchObject({
      id: QUESTION_ID,
      question: `Allow Casper to click and type on ${ORIGIN}?`,
      options: [{ label: ALLOW }, { label: DONT_ALLOW }],
      intent: { kind: 'approval', approve: ALLOW, reject: DONT_ALLOW, subject: { name: ORIGIN } },
    })
    expect(question.detail).toContain(ORIGIN)
  })
})

type Ask = (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>

function answer(selected: string[], custom?: string): AskUserQuestionAnswer {
  return { answers: [{ id: QUESTION_ID, selected, ...custom === undefined ? {} : { custom } }] }
}

function setup(ask?: Ask, durable: readonly string[] = []) {
  const ctx = new Context()
  const asked = vi.fn<Ask>(ask ?? (() => Promise.resolve(answer([ALLOW]))))
  if (ask !== undefined) ctx.provide('userQuestions', { ask: asked } as never)
  const projection = {
    stateOf: () => ({ origins: [...durable], calls: [] }),
  } as Partial<ProjectionHandle<GrantState>> as ProjectionHandle<GrantState>
  const grants = new SiteGrants(ctx, projection)
  const id = SessionId('grants')
  const agent = { id, session: Session.create(id) } as Agent
  return { grants, asked, agent }
}

const signal = (): AbortSignal => new AbortController().signal

describe('per-site permission', () => {
  it('asks once, then remembers an allowed origin for the Session', async () => {
    const { grants, asked, agent } = setup(() => Promise.resolve(answer([ALLOW])))
    expect(grants.allowed(agent.session, ORIGIN)).toBe(false)
    await expect(grants.request(agent, ORIGIN, signal())).resolves.toEqual({ granted: true })
    await expect(grants.request(agent, ORIGIN, signal())).resolves.toEqual({ granted: true })
    expect(asked).toHaveBeenCalledOnce()
    expect(asked.mock.calls[0]?.[0]).toMatchObject({ agent, questions: [siteQuestion(ORIGIN)] })
    expect(grants.allowed(agent.session, ORIGIN)).toBe(true)
    expect(grants.allowed(agent.session, 'https://other.test')).toBe(false)
  })

  it('trusts an origin the Session log already proves', async () => {
    const { grants, asked, agent } = setup(() => Promise.resolve(answer([ALLOW])), [ORIGIN])
    await expect(grants.request(agent, ORIGIN, signal())).resolves.toEqual({ granted: true })
    expect(asked).not.toHaveBeenCalled()
  })

  it('reports a refusal without remembering it', async () => {
    const { grants, asked, agent } = setup(() => Promise.resolve(answer([DONT_ALLOW])))
    const declined = await grants.request(agent, ORIGIN, signal())
    expect(declined).toEqual({
      granted: false,
      code: 'declined',
      message: `The user declined to let you click or type on ${ORIGIN}. Do not retry on this site unless the user asks you to.`,
    })
    await grants.request(agent, ORIGIN, signal())
    expect(asked).toHaveBeenCalledTimes(2)
  })

  it('counts typed answers, missing answers, and several selections as refusals', async () => {
    for (const reply of [answer([ALLOW], 'only once'), { answers: [] }, answer([ALLOW, DONT_ALLOW])]) {
      const { grants, agent } = setup(() => Promise.resolve(reply))
      await expect(grants.request(agent, ORIGIN, signal())).resolves.toMatchObject({ granted: false, code: 'declined' })
    }
    const blank = setup(() => Promise.resolve(answer([ALLOW], '  ')))
    await expect(blank.grants.request(blank.agent, ORIGIN, signal())).resolves.toEqual({ granted: true })
  })

  it('maps question failures to refusal or unavailability', async () => {
    const outcome = async (error: UserQuestionError) => {
      const { grants, agent } = setup(() => Promise.reject(error))
      return grants.request(agent, ORIGIN, signal())
    }
    await expect(outcome(new UserQuestionError('closed', 'ASK_CANCELLED'))).resolves.toMatchObject({ granted: false, code: 'declined' })
    await expect(outcome(new UserQuestionError('child', 'DELEGATED_CALLER'))).resolves.toMatchObject({
      granted: false, code: 'unavailable', message: expect.stringContaining('delegated task') as string,
    })
    await expect(outcome(new UserQuestionError('none', 'NO_PROVIDER'))).resolves.toMatchObject({
      granted: false, code: 'unavailable', message: expect.stringContaining('desktop app') as string,
    })
    await expect(outcome(new UserQuestionError('bad', 'BAD_INTENT'))).rejects.toThrow('bad')
    const { grants, agent } = setup(() => Promise.reject(new Error('broken')))
    await expect(grants.request(agent, ORIGIN, signal())).rejects.toThrow('broken')
  })

  it('reports that no one can be asked without the question service', async () => {
    const { grants, agent } = setup()
    await expect(grants.request(agent, ORIGIN, signal())).resolves.toMatchObject({
      granted: false, code: 'unavailable', message: expect.stringContaining('no one can be asked') as string,
    })
  })

  it('shares one open question between calls for the same origin', async () => {
    const reply = Promise.withResolvers<AskUserQuestionAnswer>()
    const { grants, asked, agent } = setup(() => reply.promise)
    const first = grants.request(agent, ORIGIN, signal())
    const second = grants.request(agent, ORIGIN, signal())
    reply.resolve(answer([DONT_ALLOW]))
    await expect(first).resolves.toMatchObject({ code: 'declined' })
    await expect(second).resolves.toMatchObject({ code: 'declined' })
    expect(asked).toHaveBeenCalledOnce()
  })

  it('asks again when the shared question failed', async () => {
    const first = Promise.withResolvers<AskUserQuestionAnswer>()
    const replies = [first.promise, Promise.resolve(answer([ALLOW]))]
    const { grants, asked, agent } = setup(() => replies.shift() as Promise<AskUserQuestionAnswer>)
    const owner = grants.request(agent, ORIGIN, signal())
    const waiter = grants.request(agent, ORIGIN, signal())
    first.reject(new Error('answer UI crashed'))
    await expect(owner).rejects.toThrow('answer UI crashed')
    await expect(waiter).resolves.toEqual({ granted: true })
    expect(asked).toHaveBeenCalledTimes(2)
  })

  it('stops waiting when its own call is cancelled', async () => {
    const reply = Promise.withResolvers<AskUserQuestionAnswer>()
    const { grants, agent } = setup(() => reply.promise)
    const owner = grants.request(agent, ORIGIN, signal())
    const controller = new AbortController()
    const waiter = grants.request(agent, ORIGIN, controller.signal)
    controller.abort(new Error('cancelled'))
    await expect(waiter).rejects.toThrow('cancelled')
    reply.resolve(answer([ALLOW]))
    await expect(owner).resolves.toEqual({ granted: true })
    const aborted = new AbortController()
    aborted.abort(new Error('already cancelled'))
    await expect(grants.request(agent, 'https://other.test', aborted.signal)).rejects.toThrow('already cancelled')
  })
})
