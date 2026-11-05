// @vitest-environment jsdom
/** The control service reaches only Browser tabs the Sidebar layout records for the named Session. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SidebarRightOpenTab } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SidebarBrowserCommand, SidebarBrowserControlResult } from '../src/types.ts'
import type { BrowserControllerState } from '../src/client/browser/BrowserController.ts'
import { emptyBrowserFrame, type BrowserFrameState } from '../src/client/browser/BrowserFrame.ts'
import { createSidebarBrowserControl, type BrowserControlSession } from '../src/client/control.ts'

type SessionId = SidebarRightOpenTab['sessionId']

const READ: SidebarBrowserCommand = { action: 'read' }
const OK: SidebarBrowserControlResult = { ok: true, observation: { url: 'https://a.example/', title: 'A', text: '' } }
const page = { kind: 'https' as const, url: 'https://a.example/', title: 'A' }

function tab(sessionId: string, tabId: string, kind = 'browser'): SidebarRightOpenTab {
  return { sessionId: sessionId as SessionId, tabId: tabId as TabId, kind, contentId: `sidebar://${kind}/${tabId}` }
}

function controllerState(frame: Partial<BrowserFrameState>, restoreTarget?: typeof page): BrowserControllerState {
  return { frame: { ...emptyBrowserFrame(), ...frame }, restoreTarget, addressFailure: undefined, addressRevision: 0 }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function harness(openTimeoutMs = 1000) {
  const openTabs = createSnapshotStore<readonly SidebarRightOpenTab[]>([
    tab('a', 'a1'), tab('a', 'guide', 'guide'), tab('a', 'a2'), tab('b', 'b1'),
  ])
  const onScreen = createSnapshotStore<string | undefined>('a')
  const revision = createSnapshotStore(0)
  const states = new Map<string, Map<string, BrowserControllerState>>([
    ['a', new Map([['a1', controllerState({ target: page, address: 'observed', live: true })]])],
    ['b', new Map([['b1', controllerState({ live: true })]])],
  ])
  const control = {
    a: vi.fn(async (_tabId: TabId, _command: SidebarBrowserCommand) => OK),
    b: vi.fn(async (_tabId: TabId, _command: SidebarBrowserCommand) => OK),
  }
  const sessions: Record<string, BrowserControlSession> = {
    a: { state: tabId => states.get('a')?.get(tabId), control: control.a },
    b: { state: tabId => states.get('b')?.get(tabId), control: control.b },
  }
  const openTab = vi.fn((_url: string) => {})
  const service = createSidebarBrowserControl({
    openTabs, onScreen, activeTab: () => 'a1', openTab, session: sessionId => sessions[sessionId],
    controllers: revision, applicationOrigin: 'https://casper.example', openTimeoutMs,
  })
  const setState = (sessionId: string, tabId: string, state: BrowserControllerState): void => {
    states.get(sessionId)!.set(tabId, state)
    revision.set(revision.getSnapshot() + 1)
  }
  return { service, openTabs, onScreen, control, openTab, setState }
}

describe('sidebarBrowserControl', () => {
  it('lists only the named Session’s Browser tabs with their live state', () => {
    const h = harness()
    h.setState('a', 'a2', controllerState({}, { ...page, url: 'https://saved.example/', title: 'Saved' }))
    expect(h.service.tabs('a')).toEqual([
      { tabId: 'a1', url: page.url, title: page.title, active: true, live: true },
      { tabId: 'a2', url: 'https://saved.example/', title: 'Saved', active: false, live: false },
    ])
    expect(h.service.tabs('b')).toEqual([{ tabId: 'b1', url: undefined, title: undefined, active: false, live: true }])
    expect(h.service.tabs('missing')).toEqual([])
    h.openTabs.set([...h.openTabs.getSnapshot(), tab('unrendered', 'u1')])
    expect(h.service.tabs('unrendered')).toEqual([{ tabId: 'u1', url: undefined, title: undefined, active: false, live: false }])
  })

  it('never reaches another Session’s tab', async () => {
    const h = harness()
    const signal = new AbortController().signal
    for (const [sessionId, tabId] of [['a', 'b1'], ['b', 'a1'], ['a', 'guide'], ['unrendered', 'a1']] as const) {
      await expect(h.service.control(sessionId, tabId, READ, signal)).resolves.toEqual({
        ok: false, code: 'unavailable', message: 'No browser tab with this id is open in this conversation', outcome: 'not-dispatched',
      })
    }
    h.openTabs.set([...h.openTabs.getSnapshot(), tab('unrendered', 'u1')])
    await expect(h.service.control('unrendered', 'u1', READ, signal)).resolves.toMatchObject({ ok: false, code: 'unavailable' })
    expect(h.control.a).not.toHaveBeenCalled()
    expect(h.control.b).not.toHaveBeenCalled()
    await expect(h.service.control('b', 'b1', READ, signal)).resolves.toBe(OK)
    expect(h.control.b).toHaveBeenCalledExactlyOnceWith('b1', READ)
  })

  it('stops waiting for a dispatched operation when its caller aborts', async () => {
    const h = harness()
    const before = new AbortController()
    before.abort(new Error('before'))
    await expect(h.service.control('a', 'a1', READ, before.signal)).rejects.toThrow('before')
    expect(h.control.a).not.toHaveBeenCalled()
    const pending = Promise.withResolvers<SidebarBrowserControlResult>()
    h.control.a.mockReturnValueOnce(pending.promise)
    const during = new AbortController()
    const call = h.service.control('a', 'a1', READ, during.signal)
    during.abort(new Error('during'))
    await expect(call).rejects.toThrow('during')
    pending.resolve(OK)
    const failed = Promise.withResolvers<SidebarBrowserControlResult>()
    h.control.a.mockReturnValueOnce(failed.promise)
    const rejected = h.service.control('a', 'a1', READ, new AbortController().signal)
    failed.reject(new Error('defect'))
    await expect(rejected).rejects.toThrow('defect')
  })

  it('opens a validated address only in the on-screen Session', async () => {
    const h = harness()
    const signal = new AbortController().signal
    const aborted = new AbortController()
    aborted.abort(new Error('cancelled'))
    await expect(h.service.open('a', 'https://x.example/', aborted.signal)).rejects.toThrow('cancelled')
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://casper.example/app']) {
      await expect(h.service.open('a', url, signal)).resolves.toMatchObject({ ok: false, code: 'invalid-input' })
    }
    await expect(h.service.open('b', 'https://x.example/', signal)).resolves.toEqual({
      ok: false, code: 'unavailable', message: 'Open this conversation in Casper to use its browser.',
    })
    expect(h.openTab).not.toHaveBeenCalled()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    h.openTab.mockImplementationOnce(() => { throw new Error('no type') })
    await expect(h.service.open('a', 'https://x.example/', signal)).resolves.toMatchObject({ ok: false, code: 'operation-failed' })
  })

  it('returns the new tab once its first page has committed', async () => {
    const h = harness()
    h.openTab.mockImplementationOnce(() => { h.openTabs.set([...h.openTabs.getSnapshot(), tab('a', 'new')]) })
    const opening = h.service.open('a', 'x.example', new AbortController().signal)
    expect(h.openTab).toHaveBeenCalledExactlyOnceWith('https://x.example/')
    h.setState('a', 'new', controllerState({ live: true, address: 'requested', loading: true }))
    h.setState('a', 'new', controllerState({ live: true, address: 'observed', loading: true, target: page }))
    h.setState('a', 'new', controllerState({ live: true, address: 'observed', loading: false, target: page }))
    await expect(opening).resolves.toEqual({ ok: true, tab: { tabId: 'new', url: page.url, title: page.title, active: false, live: true } })
  })

  it('treats a load failure as a settled first page and finds a tab added later', async () => {
    const h = harness()
    const opening = h.service.open('a', 'https://x.example/', new AbortController().signal)
    h.openTabs.set([...h.openTabs.getSnapshot(), tab('b', 'elsewhere')])
    h.openTabs.set([...h.openTabs.getSnapshot(), tab('a', 'late')])
    h.setState('a', 'late', controllerState({ live: true, error: { code: -105, description: 'DNS' } }))
    await expect(opening).resolves.toMatchObject({ ok: true, tab: { tabId: 'late', live: true } })
  })

  it('reports a tab closed while opening', async () => {
    const h = harness()
    h.openTab.mockImplementationOnce(() => { h.openTabs.set([...h.openTabs.getSnapshot(), tab('a', 'new')]) })
    const opening = h.service.open('a', 'https://x.example/', new AbortController().signal)
    h.openTabs.set(h.openTabs.getSnapshot().filter(entry => entry.tabId !== 'new'))
    await expect(opening).resolves.toMatchObject({ ok: false, code: 'unavailable' })
  })

  it('bounds the wait and returns a live tab that is still loading', async () => {
    vi.useFakeTimers()
    const h = harness(30_000)
    h.openTab.mockImplementation(() => { h.openTabs.set([...h.openTabs.getSnapshot(), tab('a', `t${String(h.openTab.mock.calls.length)}`)]) })
    const loading = h.service.open('a', 'https://x.example/', new AbortController().signal)
    h.setState('a', 't1', controllerState({ live: true, address: 'requested', loading: true }))
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(loading).resolves.toMatchObject({ ok: true, tab: { tabId: 't1', live: true } })
    const lifeless = h.service.open('a', 'https://x.example/', new AbortController().signal)
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(lifeless).resolves.toMatchObject({ ok: false, code: 'timed-out' })
    h.openTab.mockImplementation(() => {})
    const unseen = h.service.open('a', 'https://x.example/', new AbortController().signal)
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(unseen).resolves.toMatchObject({ ok: false, code: 'timed-out' })
  })

  it('rejects with the caller’s reason and stops observing when aborted while opening', async () => {
    const h = harness()
    const subscribe = h.openTabs.subscribe.bind(h.openTabs)
    const stopped = vi.fn()
    vi.spyOn(h.openTabs, 'subscribe').mockImplementation((listener) => {
      const stop = subscribe(listener)
      return () => { stopped(); stop() }
    })
    const caller = new AbortController()
    const opening = h.service.open('a', 'https://x.example/', caller.signal)
    caller.abort(new Error('stop'))
    await expect(opening).rejects.toThrow('stop')
    expect(stopped).toHaveBeenCalledOnce()
  })
})
