import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type {
  SidebarBrowserCommand, SidebarBrowserControl, SidebarBrowserControlResult, SidebarBrowserTab,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import * as clientPlugin from '../src/client/index.ts'
import * as hostRow from '../src/index.ts'
import { dispatch, ReplayLog, toolTab } from '../src/client/dispatch.ts'
import type { SidebarBrowserToolOperation, SidebarBrowserToolResponse } from '@deepseek-ai/dsh-casper-sidebar-browser/types'

const SESSION = 'session-1'
const SHOP: SidebarBrowserTab = { tabId: 'tab-1', url: 'https://shop.test/cart', title: 'Cart', active: true, live: true }
const BLANK: SidebarBrowserTab = { tabId: 'tab-2', url: undefined, title: undefined, active: false, live: false }
const CLICK: SidebarBrowserCommand = { action: 'click', x: 1, y: 2 }
const OBSERVED: SidebarBrowserControlResult = { ok: true, observation: { url: SHOP.url as string, title: 'Cart', status: 'dispatched' } }

function fakeControl(tabs: readonly SidebarBrowserTab[] = [SHOP, BLANK]) {
  return {
    tabs: vi.fn((_sessionId: string) => tabs),
    open: vi.fn<SidebarBrowserControl['open']>(() => Promise.resolve({ ok: true, tab: SHOP })),
    control: vi.fn<SidebarBrowserControl['control']>(() => Promise.resolve(OBSERVED)),
  } satisfies SidebarBrowserControl
}

const signal = new AbortController().signal

describe('Client dispatch', () => {
  it('lists the Session\'s tabs as JSON', async () => {
    const control = fakeControl()
    expect(await dispatch(control, SESSION, { kind: 'tabs' }, signal)).toEqual({
      kind: 'tabs',
      tabs: [toolTab(SHOP), { tabId: 'tab-2', url: null, title: null, active: false, live: false }],
    })
    expect(control.tabs).toHaveBeenCalledWith(SESSION)
  })

  it('opens a tab, marking only a timed-out open as possibly done', async () => {
    const control = fakeControl()
    expect(await dispatch(control, SESSION, { kind: 'open', url: 'https://a.test/' }, signal)).toEqual({ kind: 'opened', tab: toolTab(SHOP) })
    expect(control.open).toHaveBeenCalledWith(SESSION, 'https://a.test/', signal)
    control.open.mockResolvedValueOnce({ ok: false, code: 'unavailable', message: 'Not on screen.' })
    expect(await dispatch(control, SESSION, { kind: 'open', url: 'https://a.test/' }, signal))
      .toEqual({ kind: 'failed', code: 'unavailable', message: 'Not on screen.', outcome: 'not-dispatched' })
    control.open.mockResolvedValueOnce({ ok: false, code: 'timed-out', message: 'Slow.' })
    expect(await dispatch(control, SESSION, { kind: 'open', url: 'https://a.test/' }, signal))
      .toMatchObject({ kind: 'failed', code: 'timed-out', outcome: 'unknown' })
  })

  it('runs a command and passes its observation or failure through', async () => {
    const control = fakeControl()
    expect(await dispatch(control, SESSION, { kind: 'control', tabId: 'tab-1', command: { action: 'read' } }, signal))
      .toEqual({ kind: 'observed', observation: OBSERVED.ok ? OBSERVED.observation : undefined })
    expect(control.control).toHaveBeenCalledWith(SESSION, 'tab-1', { action: 'read' }, signal)
    control.control.mockResolvedValueOnce({ ok: false, code: 'timed-out', message: 'Slow.', outcome: 'unknown' })
    expect(await dispatch(control, SESSION, { kind: 'control', tabId: 'tab-1', command: CLICK }, signal))
      .toEqual({ kind: 'failed', code: 'timed-out', message: 'Slow.', outcome: 'unknown' })
  })

  it('sends input only while the tab still shows the allowed origin', async () => {
    const control = fakeControl()
    const input = (tabId: string, origin: string): SidebarBrowserToolOperation => ({ kind: 'control', tabId, command: CLICK, origin })
    expect(await dispatch(control, SESSION, input('tab-1', 'https://shop.test'), signal)).toMatchObject({ kind: 'observed' })
    expect(await dispatch(control, SESSION, input('tab-1', 'https://evil.test'), signal)).toEqual({
      kind: 'failed', code: 'operation-failed', outcome: 'not-dispatched',
      message: 'The tab left https://evil.test before the input was sent. Read the page, then try again.',
    })
    expect(await dispatch(control, SESSION, input('tab-2', 'https://shop.test'), signal)).toMatchObject({ code: 'operation-failed' })
    expect(await dispatch(control, SESSION, input('gone', 'https://shop.test'), signal))
      .toEqual({ kind: 'failed', code: 'invalid-input', message: 'No browser tab has id "gone".', outcome: 'not-dispatched' })
    const odd = fakeControl([{ ...SHOP, url: 'not a url' }])
    expect(await dispatch(odd, SESSION, input('tab-1', 'https://shop.test'), signal)).toMatchObject({ code: 'operation-failed' })
    expect(control.control).toHaveBeenCalledOnce()
    expect(odd.control).not.toHaveBeenCalled()
  })

  it('runs nothing for an operation it does not know', async () => {
    const control = fakeControl()
    const unknown = JSON.parse('{ "kind": "download" }') as SidebarBrowserToolOperation
    expect(await dispatch(control, SESSION, unknown, signal)).toEqual({
      kind: 'failed', code: 'invalid-input', message: 'The browser does not know this operation.', outcome: 'not-dispatched',
    })
  })
})

describe('replayed requests', () => {
  const click: SidebarBrowserToolOperation = { kind: 'control', tabId: 'tab-1', command: CLICK }
  const answer: SidebarBrowserToolResponse = { kind: 'observed', observation: { url: 'https://shop.test/', title: 'Shop' } }

  it('answers a repeated input from its first run', async () => {
    const log = new ReplayLog()
    const run = vi.fn(() => Promise.resolve(answer))
    expect(await log.run(SESSION, { operationId: 'op', operation: click }, run)).toBe(answer)
    expect(await log.run(SESSION, { operationId: 'op', operation: click }, run)).toBe(answer)
    expect(run).toHaveBeenCalledOnce()
    await log.run('session-2', { operationId: 'op', operation: click }, run)
    await log.run(SESSION, { operationId: 'other', operation: { kind: 'open', url: 'https://a.test/' } }, run)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('shares an input still running with its replay', async () => {
    const log = new ReplayLog()
    const first = Promise.withResolvers<SidebarBrowserToolResponse>()
    const run = vi.fn(() => first.promise)
    const original = log.run(SESSION, { operationId: 'op', operation: click }, run)
    const replay = log.run(SESSION, { operationId: 'op', operation: click }, run)
    first.resolve(answer)
    expect(await original).toBe(answer)
    expect(await replay).toBe(answer)
    expect(run).toHaveBeenCalledOnce()
  })

  it('runs again only when the first run sent nothing', async () => {
    const log = new ReplayLog()
    const notSent: SidebarBrowserToolResponse = { kind: 'failed', code: 'unavailable', message: 'No guest.', outcome: 'not-dispatched' }
    const maybeSent: SidebarBrowserToolResponse = { kind: 'failed', code: 'timed-out', message: 'Slow.', outcome: 'unknown' }
    const run = vi.fn<() => Promise<SidebarBrowserToolResponse>>()
      .mockResolvedValueOnce(notSent).mockResolvedValueOnce(answer).mockResolvedValueOnce(maybeSent)
    expect(await log.run(SESSION, { operationId: 'a', operation: click }, run)).toBe(notSent)
    expect(await log.run(SESSION, { operationId: 'a', operation: click }, run)).toBe(answer)
    expect(await log.run(SESSION, { operationId: 'b', operation: click }, run)).toBe(maybeSent)
    expect(await log.run(SESSION, { operationId: 'b', operation: click }, run)).toBe(maybeSent)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('never repeats an input whose first run was interrupted', async () => {
    const log = new ReplayLog()
    const run = vi.fn<() => Promise<SidebarBrowserToolResponse>>().mockRejectedValueOnce(new Error('disconnected'))
    await expect(log.run(SESSION, { operationId: 'op', operation: click }, run)).rejects.toThrow('disconnected')
    expect(await log.run(SESSION, { operationId: 'op', operation: click }, run)).toEqual({
      kind: 'failed', code: 'operation-failed', message: 'An earlier attempt of this action was interrupted.', outcome: 'unknown',
    })
    expect(run).toHaveBeenCalledOnce()
  })

  it('always runs reads, screenshots, and tab lists', async () => {
    const log = new ReplayLog()
    const run = vi.fn(() => Promise.resolve(answer))
    for (const operation of [
      { kind: 'tabs' },
      { kind: 'control', tabId: 'tab-1', command: { action: 'read' } },
      { kind: 'control', tabId: 'tab-1', command: { action: 'screenshot' } },
    ] satisfies SidebarBrowserToolOperation[]) {
      await log.run(SESSION, { operationId: 'same', operation }, run)
      await log.run(SESSION, { operationId: 'same', operation }, run)
    }
    expect(run).toHaveBeenCalledTimes(6)
  })

  it('forgets the oldest answers beyond its window', async () => {
    const log = new ReplayLog()
    const run = vi.fn(() => Promise.resolve(answer))
    for (let index = 0; index <= 64; index++) await log.run(SESSION, { operationId: `op-${index}`, operation: click }, run)
    await log.run(SESSION, { operationId: 'op-64', operation: click }, run)
    expect(run).toHaveBeenCalledTimes(65)
    await log.run(SESSION, { operationId: 'op-0', operation: click }, run)
    expect(run).toHaveBeenCalledTimes(66)
  })
})

describe('Host row', () => {
  it('is a named function plugin without a default export that contributes nothing', () => {
    expect('default' in hostRow).toBe(false)
    expect(hostRow.name).toBe('casper-sidebar-browser-client')
    expect(() => { hostRow.apply() }).not.toThrow()
  })
})

describe('Client plugin', () => {
  let ctx: Context | undefined
  afterEach(async () => {
    await ctx?.fiber.dispose()
    ctx = undefined
  })

  type Listener = (this: Context, request: unknown, next: () => Promise<SidebarBrowserToolResponse>) => Promise<SidebarBrowserToolResponse>

  async function mount(control: SidebarBrowserControl | undefined, scoped: string | undefined) {
    ctx = new Context()
    let listener: Listener | undefined
    const scopeOf = vi.fn((_owner: Context) => scoped)
    ctx.provide('sessions', { scopeOf } as never)
    ctx.provide('remote', { $on: (_event: string, handler: Listener) => { listener = handler; return () => {} } } as never)
    if (control !== undefined) ctx.provide('sidebarBrowserControl', control as never)
    await ctx.plugin(clientPlugin)
    expect(clientPlugin.inject).toEqual(['sessions', 'remote'])
    const owner = ctx
    const next = vi.fn(() => Promise.resolve<SidebarBrowserToolResponse>({ kind: 'tabs', tabs: [] }))
    const call = (request: unknown) => (listener as Listener).call(owner, request, next)
    return { call, next, scopeOf }
  }

  it('answers for the request\'s Session through the browser service', async () => {
    const control = fakeControl()
    const { call, next, scopeOf } = await mount(control, SESSION)
    const controller = new AbortController()
    const answer = await call({ operationId: 'op', operation: { kind: 'control', tabId: 'tab-1', command: CLICK }, signal: controller.signal })
    expect(answer).toEqual({ kind: 'observed', observation: OBSERVED.ok ? OBSERVED.observation : undefined })
    expect(control.control).toHaveBeenCalledWith(SESSION, 'tab-1', CLICK, controller.signal)
    expect(scopeOf).toHaveBeenCalledOnce()
    await call({ operationId: 'op', operation: { kind: 'control', tabId: 'tab-1', command: CLICK } })
    expect(control.control).toHaveBeenCalledOnce()
    await call({ operationId: 'op-2', operation: { kind: 'control', tabId: 'tab-1', command: CLICK } })
    expect(control.control.mock.calls[1]?.[3]).toBeInstanceOf(AbortSignal)
    expect(next).not.toHaveBeenCalled()
  })

  it('delegates without the browser service or a Session', async () => {
    const withoutService = await mount(undefined, SESSION)
    await withoutService.call({ operationId: 'op', operation: { kind: 'tabs' } })
    expect(withoutService.next).toHaveBeenCalledOnce()
    await ctx?.fiber.dispose()
    const control = fakeControl()
    const withoutSession = await mount(control, undefined)
    await withoutSession.call({ operationId: 'op', operation: { kind: 'tabs' } })
    expect(withoutSession.next).toHaveBeenCalledOnce()
    expect(control.tabs).not.toHaveBeenCalled()
  })
})
