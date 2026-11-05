// @vitest-environment jsdom
/** The provider card's sign-in field drives one Host sign-in flow end to end. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AuthorizationEntryView, AuthorizationEventView } from '@deepseek-ai/dsh-api-remotes/client'
import { ProviderSignIn } from '../src/client/ProviderSignIn.tsx'
import type { ModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en): string => en[key]

function entry(signedIn: boolean): AuthorizationEntryView {
  return { key: 'llm-pi-ai/anthropic', label: 'Anthropic', methods: [{ id: 'oauth', label: 'Sign in with Claude' }], inFlight: false, signedIn }
}

/** Operations whose sign-in stream the test feeds frame by frame. */
function operations(flows: AuthorizationEntryView[]) {
  let emit: ((frame: AuthorizationEventView) => void) | undefined
  let finish: (() => void) | undefined
  const ops = {
    listSignIns: vi.fn(() => Promise.resolve(flows)),
    signIn: vi.fn((_key: string, _method: string, _signal: AbortSignal, onFrame: (frame: AuthorizationEventView) => void) => {
      emit = onFrame
      return new Promise<void>((resolve) => { finish = resolve })
    }),
    answerSignIn: vi.fn(() => Promise.resolve(undefined)),
    signOut: vi.fn(() => Promise.resolve(undefined)),
  } satisfies Pick<ModelsOperations, 'listSignIns' | 'signIn' | 'answerSignIn' | 'signOut'>
  return { ops, emit: (frame: AuthorizationEventView) => emit?.(frame), finish: () => finish?.() }
}

it('renders nothing when the Host offers no sign-in for the provider', async () => {
  const { ops } = operations([])
  const view = render(<ProviderSignIn provider="anthropic" operations={ops} t={t} />)
  await waitFor(() => { expect(ops.listSignIns).toHaveBeenCalled() })
  expect(view.container.innerHTML).toBe('')
})

it('shows the sign-in link, sends the pasted code, and reports signed in', async () => {
  const feed = operations([entry(false)])
  render(<ProviderSignIn provider="anthropic" operations={feed.ops} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Claude' }))
  expect(feed.ops.signIn).toHaveBeenCalledWith('llm-pi-ai/anthropic', 'oauth', expect.any(AbortSignal), expect.any(Function))

  feed.emit({ type: 'notice', message: 'Open the page and copy the code.', url: 'https://example.test/authorize' })
  expect((await screen.findByRole('link', { name: en.signInOpenPage })).getAttribute('href')).toBe('https://example.test/authorize')

  feed.emit({ type: 'prompt', promptId: 'p1', kind: 'text', message: 'Paste the code' })
  fireEvent.change(await screen.findByRole('textbox', { name: 'Paste the code' }), { target: { value: 'code-123' } })
  fireEvent.click(screen.getByRole('button', { name: en.signInSubmit }))
  await waitFor(() => { expect(feed.ops.answerSignIn).toHaveBeenCalledWith('p1', 'code-123') })

  feed.emit({ type: 'settled', status: 'authorized' })
  feed.finish()
  expect(await screen.findByText(en.signInDone)).toBeTruthy()
})

it('shows a device code to enter on the verification page', async () => {
  const feed = operations([entry(false)])
  render(<ProviderSignIn provider="anthropic" operations={feed.ops} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Claude' }))
  feed.emit({ type: 'notice', message: 'Enter the code.', url: 'https://example.test/device', code: 'ABCD-1234' })
  expect(await screen.findByText(en.signInCode.replace('{code}', 'ABCD-1234'))).toBeTruthy()
})

it('reports a failed sign-in with the Host message', async () => {
  const feed = operations([entry(false)])
  render(<ProviderSignIn provider="anthropic" operations={feed.ops} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Claude' }))
  feed.emit({ type: 'failed', message: 'provider refused the code' })
  expect((await screen.findByRole('alert')).textContent).toBe(en.signInFailed.replace('{message}', 'provider refused the code'))
})

it('withdraws the attempt when the user cancels', async () => {
  const feed = operations([entry(false)])
  render(<ProviderSignIn provider="anthropic" operations={feed.ops} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in with Claude' }))
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  const signal = feed.ops.signIn.mock.calls[0]![2]
  expect(signal.aborted).toBe(true)
  expect(await screen.findByText(en.signInCancelled)).toBeTruthy()
})

it('offers sign-out once a sign-in is stored', async () => {
  const feed = operations([entry(true)])
  render(<ProviderSignIn provider="anthropic" operations={feed.ops} t={t} />)
  expect(await screen.findByText(en.signedIn)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.signOut }))
  await waitFor(() => { expect(feed.ops.signOut).toHaveBeenCalledWith('llm-pi-ai/anthropic') })
})

it('leaves the API key method to the card key field and keeps the other methods', async () => {
  const flow = (methods: AuthorizationEntryView['methods'], signedIn = false): AuthorizationEntryView =>
    ({ key: 'llm-pi-ai/anthropic', label: 'Anthropic', methods, inFlight: false, signedIn })
  const both = operations([flow([{ id: 'oauth', label: 'Sign in with Claude' }, { id: 'api-key', label: 'Anthropic API key' }])])
  render(<ProviderSignIn provider="anthropic" operations={both.ops} t={t} keyFieldShown />)
  expect(await screen.findByRole('button', { name: 'Sign in with Claude' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Anthropic API key' })).toBeNull()
  cleanup()

  const keyOnly = operations([flow([{ id: 'api-key', label: 'Anthropic API key' }])])
  const view = render(<ProviderSignIn provider="anthropic" operations={keyOnly.ops} t={t} keyFieldShown />)
  await waitFor(() => { expect(keyOnly.ops.listSignIns).toHaveBeenCalled() })
  expect(view.container.innerHTML).toBe('')
  cleanup()

  const stored = operations([flow([{ id: 'api-key', label: 'Anthropic API key' }], true)])
  render(<ProviderSignIn provider="anthropic" operations={stored.ops} t={t} keyFieldShown />)
  expect(await screen.findByRole('button', { name: en.signOut })).toBeTruthy()
  cleanup()

  const keyless = operations([flow([{ id: 'api-key', label: 'Anthropic API key' }])])
  render(<ProviderSignIn provider="anthropic" operations={keyless.ops} t={t} />)
  expect(await screen.findByRole('button', { name: 'Anthropic API key' })).toBeTruthy()
})
