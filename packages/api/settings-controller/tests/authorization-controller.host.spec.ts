import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService, { type AuthorizationFlow } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import AuthorizationController from '../src/authorization.ts'
import type { AuthorizationEventView } from '../src/types.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'

const KEY = credentialKey('llm-pi-ai', 'anthropic')

/** A flow that shows a link, asks for the code, and commits a grant carrying it. */
function pasteCodeFlow(): AuthorizationFlow {
  return {
    key: KEY,
    label: 'Anthropic',
    methods: [{ id: 'oauth', label: 'Sign in with Claude' }],
    async run(session) {
      session.notify({ message: 'Open the page and copy the code.', url: 'https://example.test/authorize' })
      const code = await session.prompt({ kind: 'text', message: 'Paste the code' })
      await session.commit({ kind: 'grant', payload: { code } })
    },
  }
}

async function boot(flow: AuthorizationFlow | undefined = pasteCodeFlow()): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(AuthorizationService)
  if (flow !== undefined) ctx.authorization.registerFlow(flow)
  await ctx.plugin(AuthorizationController)
  return ctx
}

/** Read frames, answering each prompt with `answer` (or declining it when undefined). */
async function drive(ctx: Context, answer: string | undefined, signal = new AbortController().signal): Promise<AuthorizationEventView[]> {
  const frames: AuthorizationEventView[] = []
  for await (const frame of ctx.authorizationController.signIn(KEY, undefined, signal)) {
    frames.push(frame)
    if (frame.type === 'prompt') {
      if (answer === undefined) ctx.authorizationController.decline(frame.promptId)
      else ctx.authorizationController.answer(frame.promptId, answer)
    }
  }
  return frames
}

describe('the authorization Remote namespace the Models page calls', () => {
  it('publishes list, signIn, answer, decline, cancel and signOut in the authorization namespace', async () => {
    const ctx = await boot()
    expect(ctx.authorizationController.typertRemote.namespace).toBe('authorization')
    expect(remoteMethods(ctx.authorizationController).map(entry => entry.method).sort())
      .toEqual(['answer', 'cancel', 'decline', 'list', 'signIn', 'signOut'])
  })

  it('lists registered flows as signed out until a record is stored', async () => {
    const ctx = await boot()
    expect(await ctx.authorizationController.list()).toEqual([{
      key: 'llm-pi-ai/anthropic', label: 'Anthropic',
      methods: [{ id: 'oauth', label: 'Sign in with Claude' }], inFlight: false, signedIn: false,
    }])
  })

  it('lists nothing when no authorization seam is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(AuthorizationController)
    expect(await ctx.authorizationController.list()).toEqual([])
  })

  it('streams the link, takes the pasted code, and reports signed in', async () => {
    const ctx = await boot()
    const frames = await drive(ctx, 'code-123')
    expect(frames.map(frame => frame.type)).toEqual(['notice', 'prompt', 'settled'])
    expect(frames[0]).toEqual({ type: 'notice', message: 'Open the page and copy the code.', url: 'https://example.test/authorize' })
    expect(frames.at(-1)).toEqual({ type: 'settled', status: 'authorized' })
    expect((await ctx.authorizationController.list())[0]?.signedIn).toBe(true)
  })

  it('settles as cancelled when the page declines the prompt', async () => {
    const ctx = await boot()
    expect((await drive(ctx, undefined)).at(-1)).toEqual({ type: 'settled', status: 'cancelled' })
    expect((await ctx.authorizationController.list())[0]?.signedIn).toBe(false)
  })

  it('reports a failing flow as a failed frame instead of breaking the stream', async () => {
    const ctx = await boot({ ...pasteCodeFlow(), run: () => Promise.reject(new Error('provider refused the code')) })
    expect(await drive(ctx, 'x')).toEqual([{ type: 'failed', message: 'provider refused the code' }])
  })

  it('cancels a running attempt when the page closes the stream', async () => {
    const ctx = await boot()
    const controller = new AbortController()
    const frames: AuthorizationEventView[] = []
    for await (const frame of ctx.authorizationController.signIn(KEY, undefined, controller.signal)) {
      frames.push(frame)
      if (frame.type === 'prompt') controller.abort()
    }
    expect(frames.at(-1)).toEqual({ type: 'settled', status: 'cancelled' })
    expect((await ctx.authorizationController.list())[0]?.inFlight).toBe(false)
  })

  it('refuses a key no flow claims and an answer to a prompt that is not open', async () => {
    const ctx = await boot()
    for (const call of [
      () => { ctx.authorizationController.signIn('llm-pi-ai/unknown', undefined, new AbortController().signal) },
      () => { ctx.authorizationController.signIn('not a key', undefined, new AbortController().signal) },
      () => { ctx.authorizationController.answer('llm-pi-ai/anthropic#99', 'x') },
    ]) {
      let failure: unknown
      try { call() } catch (error) { failure = error }
      expect(remoteErrorOf(failure)).toMatchObject({ code: 'authorization/rejected' })
    }
  })

  it('signs out by deleting the stored record', async () => {
    const ctx = await boot()
    await drive(ctx, 'code-123')
    await ctx.authorizationController.signOut(KEY)
    expect((await ctx.authorizationController.list())[0]?.signedIn).toBe(false)
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
  })
})
