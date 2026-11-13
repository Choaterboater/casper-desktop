import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { CasperSignInController } from '../src/sign-in-controller.ts'
import type { CasperSignInFrame } from '../src/sign-in.ts'
import { fakeCasper } from './support.ts'
import type { FakeScript } from './support.ts'

const cleanups: (() => unknown)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const WAY = { id: 'openai-codex:oauth', name: 'OpenAI Codex (ChatGPT plan) · sign in with your browser', _meta: { casper: { provider: 'openai-codex', kind: 'browser' } } }

async function setup(script: Omit<FakeScript, 'prompts'> = {}, command?: string) {
  const fake = fakeCasper({ prompts: [], authMethods: [WAY], ...script })
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  cleanups.push(() => { fake.remove() }, () => ctx.fiber.dispose())
  const controller = new CasperSignInController(ctx, fake.config(command === undefined ? {} : { command }))
  return { fake, controller }
}

describe('CasperSignInController', () => {
  it('answers the Models page with Casper\'s ways and saved sign-ins under casperSignIn', async () => {
    const { controller } = await setup({ signIns: [{ provider: 'openai-codex', type: 'oauth' }] })
    expect(controller.typertRemote.namespace).toBe('casperSignIn')
    expect(await controller.state(AbortSignal.timeout(20_000))).toEqual({
      methods: [{ id: 'openai-codex:oauth', label: WAY.name, provider: 'openai-codex', kind: 'browser' }],
      signIns: [{ provider: 'openai-codex', type: 'oauth' }],
    })
  })

  it('streams a sign-in and signs out through Casper', async () => {
    const { fake, controller } = await setup({ authSteps: [{ step: 'browser', url: 'https://auth.example.test/start', opened: true }] })
    const seen: CasperSignInFrame[] = []
    for await (const frame of controller.signIn('openai-codex:oauth', undefined, AbortSignal.timeout(20_000))) seen.push(frame)
    expect(seen.at(-1)).toEqual({ type: 'signed-in', provider: 'openai-codex' })
    expect(await controller.signOut('openai-codex', AbortSignal.timeout(20_000))).toBe(true)
    expect(fake.calls('_casper/auth/logout')).toHaveLength(1)
  })

  it('reports a Casper that cannot start as casperSignIn/failed with Casper\'s words', async () => {
    const { fake, controller } = await setup({}, join(fakeCasper().root, 'no-casper-here'))
    void fake
    const failure = await controller.state(AbortSignal.timeout(20_000)).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(RemoteError)
    expect((failure as RemoteError).code).toBe('casperSignIn/failed')
    expect((failure as RemoteError).message).toMatch(/Casper/)
  })
})
