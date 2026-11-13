import { afterEach, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { CasperError } from '../src/connection.ts'
import { CasperSignIn } from '../src/sign-in.ts'
import type { CasperSignInFrame } from '../src/sign-in.ts'
import { alive, fakeCasper, waitFor } from './support.ts'
import type { FakeScript } from './support.ts'

const cleanups: (() => unknown)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** Casper's sign-in ways as its router lists them in `initialize`. */
const WAYS = [
  { id: 'openrouter:api_key', name: 'OpenRouter · paste an API key', _meta: { casper: { provider: 'openrouter', kind: 'api_key' } } },
  { id: 'openai-codex:oauth', name: 'OpenAI Codex (ChatGPT plan) · sign in with your browser', _meta: { casper: { provider: 'openai-codex', kind: 'browser' } } },
  { id: 'github-copilot:oauth', name: 'GitHub Copilot · enter a code at github.com', _meta: { casper: { provider: 'github-copilot', kind: 'device_code' } } },
]

async function setup(script: Omit<FakeScript, 'prompts'> = {}) {
  const fake = fakeCasper({ prompts: [], authMethods: WAYS, ...script })
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  cleanups.push(() => { fake.remove() }, () => ctx.fiber.dispose())
  const signIn = new CasperSignIn({ subprocess: ctx.subprocess, config: fake.config(), cwd: fake.root })
  return { fake, signIn }
}

async function frames(stream: AsyncIterable<CasperSignInFrame>): Promise<CasperSignInFrame[]> {
  const seen: CasperSignInFrame[] = []
  for await (const frame of stream) seen.push(frame)
  return seen
}

describe('CasperSignIn', () => {
  it('lists the ways Casper signs in and what it has saved, then lets its process go', async () => {
    const { fake, signIn } = await setup({ signIns: [{ provider: 'github-copilot', type: 'oauth' }] })
    expect(await signIn.state(AbortSignal.timeout(20_000))).toEqual({
      methods: [
        { id: 'openrouter:api_key', label: 'OpenRouter · paste an API key', provider: 'openrouter', kind: 'api_key' },
        { id: 'openai-codex:oauth', label: 'OpenAI Codex (ChatGPT plan) · sign in with your browser', provider: 'openai-codex', kind: 'browser' },
        { id: 'github-copilot:oauth', label: 'GitHub Copilot · enter a code at github.com', provider: 'github-copilot', kind: 'device_code' },
      ],
      signIns: [{ provider: 'github-copilot', type: 'oauth' }],
    })
    expect(fake.calls('_casper/auth/status')).toHaveLength(1)
    expect(fake.calls('session/new')).toHaveLength(0)
    const [pid] = fake.pids()
    await waitFor(() => !alive(pid!))
  })

  it('leaves out a way whose kind the app cannot show, such as a terminal-only sign-in', async () => {
    const { signIn } = await setup({ authMethods: [...WAYS, { id: 'later:way', name: 'Later', _meta: { casper: { provider: 'later', kind: 'hologram' } } }, { id: 'bare', name: 'Bare' }] })
    expect((await signIn.state(AbortSignal.timeout(20_000))).methods.map(method => method.id))
      .toEqual(['openrouter:api_key', 'openai-codex:oauth', 'github-copilot:oauth'])
  })

  it('streams a browser sign-in\'s page and ends signed in, after which Casper names the sign-in', async () => {
    const { fake, signIn } = await setup({ authSteps: [{ step: 'browser', url: 'https://auth.example.test/start', opened: true }] })
    expect(await frames(signIn.signIn('openai-codex:oauth', undefined, AbortSignal.timeout(20_000)))).toEqual([
      { type: 'browser', url: 'https://auth.example.test/start', opened: true },
      { type: 'signed-in', provider: 'openai-codex' },
    ])
    expect(fake.calls('authenticate')[0]?.params).toEqual({ methodId: 'openai-codex:oauth', keyGiven: false })
  })

  it('shows a device sign-in\'s page and code', async () => {
    const { signIn } = await setup({ authSteps: [{ step: 'device_code', url: 'https://github.example.test/login/device', code: 'ABCD-1234' }] })
    expect(await frames(signIn.signIn('github-copilot:oauth', undefined, AbortSignal.timeout(20_000)))).toEqual([
      { type: 'device_code', url: 'https://github.example.test/login/device', code: 'ABCD-1234' },
      { type: 'signed-in', provider: 'github-copilot' },
    ])
  })

  it('hands a pasted key to Casper and to nothing it streams back', async () => {
    const { fake, signIn } = await setup()
    const key = 'sk-or-v1-test-0123456789'
    const seen = await frames(signIn.signIn('openrouter:api_key', key, AbortSignal.timeout(20_000)))
    expect(seen).toEqual([{ type: 'signed-in', provider: 'openrouter' }])
    expect(fake.calls('authenticate')[0]?.params).toEqual({ methodId: 'openrouter:api_key', keyGiven: true })
    expect(JSON.stringify(seen)).not.toContain(key)
    expect((await signIn.state(AbortSignal.timeout(20_000))).signIns).toEqual([{ provider: 'openrouter', type: 'api_key' }])
  })

  it('ends a refused sign-in with Casper\'s own words', async () => {
    const { signIn } = await setup({ authError: 'OpenRouter refused that key. Nothing was saved.' })
    expect(await frames(signIn.signIn('openrouter:api_key', 'sk-bad', AbortSignal.timeout(20_000)))).toEqual([
      { type: 'failed', message: 'OpenRouter refused that key. Nothing was saved.' },
    ])
  })

  it('stops a running sign-in when its stream closes, and lets its process go', async () => {
    const { fake, signIn } = await setup({
      holdAuth: join(fakeCasper().root, 'never'),
      authSteps: [{ step: 'browser', url: 'https://auth.example.test/start', opened: false }],
    })
    const stop = new AbortController()
    const seen: CasperSignInFrame[] = []
    for await (const frame of signIn.signIn('openai-codex:oauth', undefined, stop.signal)) {
      seen.push(frame)
      if (frame.type === 'browser') stop.abort()
    }
    expect(seen).toEqual([{ type: 'browser', url: 'https://auth.example.test/start', opened: false }])
    await waitFor(() => fake.calls('_casper/auth/cancel').length === 1)
    const [pid] = fake.pids()
    await waitFor(() => !alive(pid!))
  })

  it('signs out of one provider and says whether there was a sign-in to remove', async () => {
    const { fake, signIn } = await setup({ signIns: [{ provider: 'openrouter', type: 'oauth' }, { provider: 'anthropic', type: 'oauth' }] })
    expect(await signIn.signOut('openrouter', AbortSignal.timeout(20_000))).toBe(true)
    expect(await signIn.signOut('openrouter', AbortSignal.timeout(20_000))).toBe(false)
    expect(fake.calls('_casper/auth/logout').map(entry => entry.params)).toEqual([{ provider: 'openrouter' }, { provider: 'openrouter' }])
  })

  it('reports an engine that cannot be found as Casper\'s start failure', async () => {
    const { fake } = await setup()
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    cleanups.push(() => ctx.fiber.dispose())
    const missing = new CasperSignIn({ subprocess: ctx.subprocess, config: fake.config({ command: join(fake.root, 'no-casper-here') }), cwd: fake.root })
    const failure = await missing.state(AbortSignal.timeout(20_000)).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CasperError)
    expect((failure as CasperError).code).toBe('CASPER_NOT_FOUND')
    writeFileSync(join(fake.root, 'unused'), '')
  })
})
