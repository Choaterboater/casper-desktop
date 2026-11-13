// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { CasperSignInCard, rowsOf, splitLabel } from '../src/client/CasperSignInCard.tsx'
import type { CasperSignInCardProps, CasperSignInOperations } from '../src/client/CasperSignInCard.tsx'
import { de, en, es, fr, ja, NS, pt, ru, zh } from '../src/client/locales.ts'
import { CASPER_SIGN_IN_ENTRY, mountSignIn, signInOperations } from '../src/client/sign-in-mount.ts'
import type { CasperSignInFrame, CasperSignInState } from '../src/types.ts'

afterEach(cleanup)

function translate(key: string, params?: Record<string, unknown>): string {
  const template = (en as Record<string, string>)[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (hole, name: string) => name in params ? String(params[name]) : hole)
}

const STATE: CasperSignInState = {
  methods: [
    { id: 'openrouter:api_key', label: 'OpenRouter · paste an API key', provider: 'openrouter', kind: 'api_key' },
    { id: 'openai-codex:oauth', label: 'OpenAI Codex (ChatGPT plan) · sign in with your browser', provider: 'openai-codex', kind: 'browser' },
    { id: 'github-copilot:oauth', label: 'GitHub Copilot · enter a code at github.com', provider: 'github-copilot', kind: 'device_code' },
  ],
  signIns: [{ provider: 'github-copilot', type: 'oauth' }, { provider: 'claude-subscription', type: 'oauth' }],
}

/** One sign-in the test drives: its arguments and the handles that feed or end its stream. */
interface Run {
  methodId: string
  key: string | undefined
  signal: AbortSignal
  emit: (frame: CasperSignInFrame) => void
  end: () => void
}

/** Operations whose sign-in streams the test feeds frame by frame, with their mocks. */
function scripted(state: CasperSignInState = STATE) {
  let current = state
  const runs: Run[] = []
  const readState = vi.fn<CasperSignInOperations['state']>(async () => current)
  const signIn = vi.fn<CasperSignInOperations['signIn']>((methodId, key, onFrame, signal) => new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
    runs.push({ methodId, key, signal, emit: onFrame, end: resolve })
  }))
  const signOut = vi.fn<CasperSignInOperations['signOut']>(async (provider) => {
    current = { ...current, signIns: current.signIns.filter(entry => entry.provider !== provider) }
  })
  const operations: CasperSignInOperations = { state: readState, signIn, signOut }
  return { operations, readState, signOut, runs, saved: (next: CasperSignInState) => { current = next } }
}

function show(operations: CasperSignInOperations) {
  return render(<CasperSignInCard operations={operations} t={translate as CasperSignInCardProps['t']} />)
}

/** The labels of a row's buttons, in order. */
function buttons(provider: string): string[] {
  return [...row(provider).querySelectorAll('button')].map(button => button.textContent ?? '')
}

/** One button of a row, by its label. */
function button(provider: string, label: string): HTMLButtonElement {
  const found = [...row(provider).querySelectorAll('button')].find(item => item.textContent === label)
  if (found === undefined) throw new Error(`no ${label} button for ${provider}`)
  return found
}

function row(provider: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-provider="${provider}"]`)
  if (found === null) throw new Error(`no row for ${provider}`)
  return found
}

describe('CasperSignInCard', () => {
  it('shows one row per provider with Casper\'s ways, and adds sign-out for saved sign-ins, including one made outside the app', async () => {
    const { operations } = scripted()
    show(operations)
    expect(screen.getByText(en['signIn.title'])).toBeTruthy()
    await screen.findByText('OpenRouter')
    expect([...document.querySelectorAll('[data-provider]')].map(item => item.getAttribute('data-provider')))
      .toEqual(['openrouter', 'openai-codex', 'github-copilot', 'claude-subscription'])
    expect(buttons('openrouter')).toEqual(['Paste an API key'])
    expect(buttons('openai-codex')).toEqual(['Sign in with your browser'])
    expect(row('github-copilot').textContent).toContain(en['signIn.signedIn'])
    expect(buttons('github-copilot')).toEqual(['Enter a code at github.com', en['signIn.signOut']])
    expect(buttons('claude-subscription')).toEqual([en['signIn.signOut']])
  })

  it('runs a browser sign-in: tells where to finish, links the page, then says it is signed in and rereads Casper', async () => {
    const { operations, readState, runs, saved } = scripted()
    show(operations)
    fireEvent.click(await screen.findByText('Sign in with your browser'))
    expect(screen.getByText(en['signIn.waiting'])).toBeTruthy()
    await act(async () => { runs[0]!.emit({ type: 'browser', url: 'https://auth.example.test/start', opened: true }) })
    expect(screen.getByText(en['signIn.browser'])).toBeTruthy()
    expect(screen.getByText(en['signIn.openPage']).getAttribute('href')).toBe('https://auth.example.test/start')
    expect(runs[0]!.methodId).toBe('openai-codex:oauth')
    expect(runs[0]!.key).toBeUndefined()
    saved({ ...STATE, signIns: [...STATE.signIns, { provider: 'openai-codex', type: 'oauth' }] })
    await act(async () => { runs[0]!.emit({ type: 'signed-in', provider: 'openai-codex' }); runs[0]!.end() })
    expect(await screen.findByText(en['signIn.done'])).toBeTruthy()
    await waitFor(() => { expect(row('openai-codex').textContent).toContain(en['signIn.signedIn']) })
    expect(readState).toHaveBeenCalledTimes(2)
  })

  it('asks to open the page when Casper could not, and shows a device code by itself', async () => {
    const { operations, runs } = scripted({ ...STATE, signIns: [] })
    show(operations)
    fireEvent.click(await screen.findByText('Sign in with your browser'))
    await act(async () => { runs[0]!.emit({ type: 'browser', url: 'https://auth.example.test/start', opened: false }) })
    expect(screen.getByText(en['signIn.browserClosed'])).toBeTruthy()
    fireEvent.click(screen.getByText(en['signIn.cancel']))
    fireEvent.click(screen.getByText('Enter a code at github.com'))
    await act(async () => { runs[1]!.emit({ type: 'device_code', url: 'https://github.example.test/login/device', code: 'ABCD-1234' }) })
    expect(screen.getByText('ABCD-1234').tagName).toBe('CODE')
    expect(screen.getByText(en['signIn.openPage']).getAttribute('href')).toBe('https://github.example.test/login/device')
  })

  it('signs in again on a row that already has a saved sign-in', async () => {
    const { operations, runs } = scripted()
    show(operations)
    fireEvent.click(await screen.findByText('Enter a code at github.com'))
    expect(runs[0]!.methodId).toBe('github-copilot:oauth')
    await act(async () => { runs[0]!.emit({ type: 'device_code', url: 'https://github.example.test/login/device', code: 'WXYZ-9876' }) })
    expect(screen.getByText('WXYZ-9876')).toBeTruthy()
    await act(async () => { runs[0]!.emit({ type: 'signed-in', provider: 'github-copilot' }); runs[0]!.end() })
    expect(await screen.findByText(en['signIn.done'])).toBeTruthy()
  })

  it('takes a key in a masked field, hands it to the sign-in only, and keeps it out of the page afterwards', async () => {
    const { operations, runs } = scripted()
    show(operations)
    fireEvent.click(await screen.findByText('Paste an API key'))
    const field = screen.getByLabelText('API key for OpenRouter') as HTMLInputElement
    expect(field.type).toBe('password')
    const save = screen.getByText(en['signIn.keySave']) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(field, { target: { value: '  sk-or-v1-test  ' } })
    fireEvent.click(save)
    expect(runs[0]!.key).toBe('sk-or-v1-test')
    await act(async () => { runs[0]!.emit({ type: 'signed-in', provider: 'openrouter' }); runs[0]!.end() })
    await screen.findByText(en['signIn.done'])
    expect(document.body.innerHTML).not.toContain('sk-or-v1-test')
  })

  it('shows Casper\'s own words when it refuses a sign-in or a sign-out', async () => {
    const { operations, signOut, runs } = scripted()
    signOut.mockRejectedValueOnce(new Error('Casper could not remove that sign-in.'))
    show(operations)
    fireEvent.click(await screen.findByText('Paste an API key'))
    fireEvent.change(screen.getByLabelText('API key for OpenRouter'), { target: { value: 'sk-bad' } })
    fireEvent.click(screen.getByText(en['signIn.keySave']))
    await act(async () => { runs[0]!.emit({ type: 'failed', message: 'OpenRouter refused that key. Nothing was saved.' }); runs[0]!.end() })
    expect((await screen.findByRole('alert')).textContent).toBe('Sign-in failed: OpenRouter refused that key. Nothing was saved.')
    fireEvent.click(button('github-copilot', en['signIn.signOut']))
    await waitFor(() => { expect(row('github-copilot').querySelector('[role="alert"]')?.textContent).toBe('Sign-out failed: Casper could not remove that sign-in.') })
  })

  it('stops a running sign-in on Cancel and when the page closes', async () => {
    const { operations, runs } = scripted({ ...STATE, signIns: [] })
    const view = show(operations)
    fireEvent.click(await screen.findByText('Sign in with your browser'))
    fireEvent.click(screen.getByText(en['signIn.cancel']))
    expect(runs[0]!.signal.aborted).toBe(true)
    expect(screen.getByText(en['signIn.stopped'])).toBeTruthy()
    fireEvent.click(screen.getByText('Sign in with your browser'))
    view.unmount()
    expect(runs[1]!.signal.aborted).toBe(true)
  })

  it('signs out and rereads Casper', async () => {
    const { operations, signOut } = scripted()
    show(operations)
    await screen.findByText('OpenRouter')
    fireEvent.click(button('claude-subscription', en['signIn.signOut']))
    await waitFor(() => { expect(document.querySelector('[data-provider="claude-subscription"]')).toBeNull() })
    expect(signOut).toHaveBeenCalledWith('claude-subscription', expect.any(AbortSignal))
  })

  it('says why Casper could not list its sign-ins and tries again on request', async () => {
    const { operations, readState } = scripted()
    readState.mockRejectedValueOnce(new Error('Casper is not installed.'))
    show(operations)
    expect((await screen.findByRole('alert')).textContent).toBe('Casper could not list its sign-ins: Casper is not installed.')
    fireEvent.click(screen.getByText(en['signIn.retry']))
    expect(await screen.findByText('OpenRouter')).toBeTruthy()
  })
})

describe('Casper sign-in labels', () => {
  it('splits Casper\'s label into a provider name and a capitalized way', () => {
    expect(splitLabel('OpenRouter · paste an API key')).toEqual({ name: 'OpenRouter', way: 'Paste an API key' })
    expect(splitLabel('Ollama')).toEqual({ name: 'Ollama' })
  })

  it('lists no rows when Casper offers nothing and has nothing saved', () => {
    expect(rowsOf({ methods: [], signIns: [] })).toEqual([])
  })
})

describe('signInOperations', () => {
  it('throws a refused call\'s RemoteError and disposes a sign-in stream when stopped', async () => {
    const failure = new RemoteError('casperSignIn/failed', 'Casper is not installed.', { request: 'state' })
    const dispose = vi.fn()
    const frames: CasperSignInFrame[] = [{ type: 'browser', url: 'https://auth.example.test/start', opened: true }]
    const stop = new AbortController()
    const remote = {
      state: vi.fn(async () => ({ ok: false as const, error: failure })),
      signOut: vi.fn(async () => ({ ok: true as const, value: true })),
      signIn: vi.fn(() => ({
        async* [Symbol.asyncIterator]() { yield* frames; stop.abort(); await new Promise(() => {}) },
        dispose, send: vi.fn(), end: vi.fn(),
      })),
    }
    const operations = signInOperations(remote)
    await expect(operations.state(AbortSignal.timeout(1000))).rejects.toBe(failure)
    await operations.signOut('openrouter', AbortSignal.timeout(1000))
    const seen: CasperSignInFrame[] = []
    void operations.signIn('openai-codex:oauth', undefined, frame => seen.push(frame), stop.signal)
    await waitFor(() => { expect(dispose).toHaveBeenCalledTimes(1) })
    expect(seen).toEqual(frames)
    expect(remote.signIn).toHaveBeenCalledWith('openai-codex:oauth', undefined, stop.signal)
  })
})

describe('mountSignIn', () => {
  it('mounts the Remote, then puts the card in the Models page footer with copy in every dictionary', async () => {
    type Options = { name: string; id?: string; order?: number; locale?: string }
    const register = vi.fn((_options: Options, _component: unknown) => () => {})
    const unmountRemote = vi.fn(async () => {})
    const child = {
      remote: { casperSignIn: { state: vi.fn(), signIn: vi.fn(), signOut: vi.fn() } },
      slots: { inject: vi.fn((_name: string, mount: () => () => void) => mount()), register },
    }
    const ui = Object.assign(Promise.resolve(), { dispose: vi.fn(async () => {}) })
    const ctx = {
      remote: { $mount: vi.fn(async () => unmountRemote) },
      inject: vi.fn((_names: string[], run: (inner: typeof child) => void) => { run(child); return ui }),
    }
    const dispose = await mountSignIn(ctx as never, { remote: 'contribution' } as never)
    expect(ctx.remote.$mount).toHaveBeenCalledWith({ remote: 'contribution' })
    expect(ctx.inject.mock.calls[0]?.[0]).toEqual(['remote.casperSignIn', 'slots', 'locale'])
    expect(register.mock.calls[0]?.[0]).toEqual({ name: 'settings.models.footer', id: CASPER_SIGN_IN_ENTRY, order: 100, locale: NS })
    await dispose()
    expect(ui.dispose).toHaveBeenCalledTimes(1)
    expect(unmountRemote).toHaveBeenCalledTimes(1)
    const keys = Object.keys(en).filter(key => key.startsWith('signIn.'))
    for (const dictionary of [zh, ja, es, fr, de, ru, pt]) {
      for (const key of keys) expect((dictionary as Record<string, string>)[key], key).toBeTruthy()
    }
  })
})
