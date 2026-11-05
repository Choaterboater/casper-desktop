// @vitest-environment jsdom
/** Browser type, Slot, locale, and HMR disposal through the real registries. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShortcutRegistry } from '@deepseek-ai/dsh-client-shortcuts/src/client/registry.ts'
import type { ShortcutCommand, ShortcutPlatform } from '@deepseek-ai/dsh-client-shortcuts/client'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { BrowserBody } from '../src/client/view/BrowserBody.tsx'
import { BrowserTitle } from '../src/client/view/BrowserTitle.tsx'
import type { BrowserInjected } from '../src/client/browser/BrowserController.ts'
import { BROWSER_ID, BROWSER_KIND } from '../src/client/definition.tsx'
import { apply, inject } from '../src/client/index.ts'
import { en, ja, zh, es, fr, de, ru, pt } from '../src/client/locales.ts'
import { createBrowserStore } from '../src/client/browser/store.ts'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { DesktopBrowserBridge, DesktopBrowserLeaseId, SidebarBrowserControlResult } from '../src/types.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
})

interface Recorded {
  name: string
  key: string
  locale?: string
  store?: unknown
  inject?: unknown
  component: unknown
}

async function boot(platform: ShortcutPlatform = 'macos', runtime: 'desktop' | 'web' = 'desktop') {
  const ctx = new Context()
  contexts.push(ctx)
  const tabs = new SidebarRightTabRegistry(ctx)
  const registered: Recorded[] = []
  const slots = {
    inject: vi.fn((_name: string, register: () => () => void) => register()),
    register: vi.fn((options: Omit<Recorded, 'component'>, component: unknown) => {
      const entry: Recorded = { ...options, component }
      registered.push(entry)
      return () => { registered.splice(registered.indexOf(entry), 1) }
    }),
  }
  const dictionaries = new Map<string, unknown>()
  const locale = {
    bind: vi.fn(() => (key: string) => key),
    register: vi.fn((namespace: string, value: unknown) => {
      dictionaries.set(namespace, value)
      return () => { dictionaries.delete(namespace) }
    }),
  }
  const openTabs = createSnapshotStore<readonly { sessionId: string; tabId: TabId; kind?: string }[]>([])
  const mounted = createSnapshotStore<string | undefined>(undefined)
  const target = { sessionId: 'session', paneId: 'pane' }
  const sidebar = { openTabs, mounted, commandTarget: vi.fn<() => typeof target | undefined>(() => target),
    openTabFromTarget: vi.fn(), openTab: vi.fn(), active: vi.fn<() => { id: TabId } | undefined>(() => undefined) }
  const registry = new ShortcutRegistry(runtime, platform)
  ctx.provide('sidebarRight', sidebar as never)
  ctx.provide('shortcuts', { register: (command: ShortcutCommand) => registry.register(command) } as never)
  ctx.provide('sidebarRightTabs', tabs as never)
  ctx.provide('workspaces', { list: createSnapshotStore({ phase: 'ready', items: [] }) } as never)
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, tabs, registered, dictionaries, fiber, openTabs, mounted, registry, sidebar, target }
}

function desktopBridge() {
  const bridge = {
    acquire: vi.fn(async () => ({ lease: 'control-lease' as DesktopBrowserLeaseId, partition: 'test-partition' })),
    release: vi.fn(async () => {}),
    onOpenRequested: vi.fn(() => () => {}),
    control: vi.fn(async (): Promise<SidebarBrowserControlResult> => ({ ok: true, observation: { url: 'https://b.example/', title: 'B', status: 'dispatched' } })),
  } satisfies DesktopBrowserBridge
  vi.stubGlobal('dshDesktop', { protocolVersion: 1, browser: bridge })
  return bridge
}

describe('ui-sidebar-browser apply', () => {
  it.each([0, 1])('binds and rebinds session controllers under desktop protocol %s', async (protocolVersion) => {
    const acquire = vi.fn(async () => ({ lease: 'test-lease' as DesktopBrowserLeaseId, partition: 'test-partition' }))
    const bridge: DesktopBrowserBridge = {
      acquire,
      release: vi.fn(async () => {}),
      onOpenRequested: vi.fn(() => () => {}),
      control: vi.fn(),
    }
    vi.stubGlobal('dshDesktop', { protocolVersion, browser: bridge })
    const h = await boot()
    expect(h.tabs.get(BROWSER_KIND)?.keepMounted).toBe(protocolVersion === 1)
    const injectFace = h.registered.find(entry => entry.name === 'sidebar.right.pane.tab')!.inject as
      (sessionId: string, actions: Parameters<BrowserInjected['rebind']>[0]) => BrowserInjected
    const firstStore = createBrowserStore().create(`apply-first-${protocolVersion}`)
    const replacementStore = createBrowserStore().create(`apply-replacement-${protocolVersion}`)
    const controller = injectFace('session', firstStore.actions)
    expect(injectFace('session', replacementStore.actions)).toBe(controller)
    const host = document.createElement('div')
    host.id = `browser-apply-${protocolVersion}`
    document.body.append(host)
    const signal = new AbortController()
    const tabId = 'apply-tab' as TabId
    try {
      controller.mount({ tabId, signal: signal.signal, viewportId: host.id, applicationOrigin: 'https://dsh.example',
        initial: undefined, initialUrl: 'https://example.test/', openTab: vi.fn() })
      expect(replacementStore.getSnapshot().byTab[tabId]).toBeDefined()
      expect(firstStore.getSnapshot().byTab[tabId]).toBeUndefined()
      if (protocolVersion === 1) await vi.waitFor(() => { expect(acquire).toHaveBeenCalledWith('session:session') })
      else expect(host.querySelector('iframe')).not.toBeNull()
      h.openTabs.set([{ sessionId: 'other', tabId }, { sessionId: 'session', tabId: 'other-tab' as TabId }])
      signal.abort()
      expect(replacementStore.getSnapshot().byTab[tabId]).toBeUndefined()
      const reopened = new AbortController()
      controller.mount({ tabId, signal: reopened.signal, viewportId: host.id, applicationOrigin: 'https://dsh.example',
        initial: undefined, initialUrl: 'https://retained.example/', openTab: vi.fn() })
      h.openTabs.set([{ sessionId: 'session', tabId }])
      reopened.abort()
      expect(replacementStore.getSnapshot().byTab[tabId]).toBeDefined()
      const active = new AbortController()
      controller.mount({ tabId, signal: active.signal, viewportId: host.id, applicationOrigin: 'https://dsh.example',
        initial: undefined, initialUrl: undefined, openTab: vi.fn() })
      await h.fiber.dispose()
      expect(controller.keyedHooks.browserState(tabId)).toBeUndefined()
    } finally {
      await h.fiber.dispose()
      host.remove()
    }
  })

  it('provides agent control only with the Desktop bridge and withdraws it on unload', async () => {
    const web = await boot('macos', 'web')
    expect(web.ctx.get('sidebarBrowserControl')).toBeUndefined()
    await web.fiber.dispose()
    desktopBridge()
    const desktop = await boot()
    expect(desktop.ctx.get('sidebarBrowserControl')).toBeDefined()
    await desktop.fiber.dispose()
    expect(desktop.ctx.get('sidebarBrowserControl')).toBeUndefined()
  })

  it('routes control from the named Session to its own live guest only', async () => {
    const bridge = desktopBridge()
    const h = await boot()
    const control = h.ctx.get('sidebarBrowserControl')!
    const injectFace = h.registered.find(entry => entry.name === 'sidebar.right.pane.tab')!.inject as
      (sessionId: string, actions: Parameters<BrowserInjected['rebind']>[0]) => BrowserInjected
    injectFace('session-a', createBrowserStore().create('control-a').actions)
    const sessionB = injectFace('session-b', createBrowserStore().create('control-b').actions)
    const tabId = 'tab-b' as TabId
    h.openTabs.set([{ sessionId: 'session-b', tabId, kind: BROWSER_KIND }, { sessionId: 'session-c', tabId: 'tab-c' as TabId, kind: BROWSER_KIND }])
    const host = document.createElement('div')
    host.id = 'browser-control-route'
    document.body.append(host)
    const signal = new AbortController().signal
    const read = { action: 'read' } as const
    try {
      expect(control.tabs('session-a')).toEqual([])
      expect(control.tabs('session-c')).toEqual([{ tabId: 'tab-c', url: undefined, title: undefined, active: false, live: false }])
      await expect(control.control('session-c', 'tab-c', read, signal)).resolves.toMatchObject({ ok: false, code: 'unavailable' })
      expect(control.tabs('session-b')).toEqual([{ tabId, url: undefined, title: undefined, active: false, live: false }])
      sessionB.mount({ tabId, signal, viewportId: host.id, applicationOrigin: 'https://dsh.example', initial: undefined,
        initialUrl: 'https://b.example/', openTab: vi.fn() })
      await vi.waitFor(() => { expect(host.querySelector('webview')).not.toBeNull() })
      const guest = Object.assign(host.querySelector('webview')!, {
        loadURL: vi.fn(async () => {}), getURL: () => 'https://b.example/', getTitle: () => 'B', isLoading: () => false,
        canGoBack: () => false, canGoForward: () => false, clearHistory: vi.fn(),
      })
      await expect(control.control('session-b', tabId, read, signal)).resolves.toMatchObject({ ok: false, code: 'unavailable' })
      guest.dispatchEvent(new Event('dom-ready'))
      guest.dispatchEvent(new Event('did-navigate'))
      expect(control.tabs('session-b')).toEqual([{ tabId, url: 'https://b.example/', title: 'B', active: false, live: true }])
      await expect(control.control('session-a', tabId, read, signal)).resolves.toMatchObject({ ok: false, code: 'unavailable', outcome: 'not-dispatched' })
      expect(bridge.control).not.toHaveBeenCalled()
      await expect(control.control('session-b', tabId, read, signal)).resolves.toMatchObject({ ok: true })
      expect(bridge.control).toHaveBeenCalledExactlyOnceWith('control-lease', read)
      await expect(control.open('session-a', 'https://a.example/', signal)).resolves.toMatchObject({ ok: false, code: 'unavailable' })
      h.mounted.set('session-b')
      expect(control.tabs('session-b')[0]?.active).toBe(false)
      h.sidebar.active.mockReturnValue({ id: tabId })
      expect(control.tabs('session-b')[0]?.active).toBe(true)
      h.mounted.set('session-a')
      expect(control.tabs('session-b')[0]?.active).toBe(false)
      const cancel = new AbortController()
      const opening = control.open('session-a', 'a.example', cancel.signal)
      expect(h.sidebar.openTab).toHaveBeenCalledExactlyOnceWith(BROWSER_KIND, { params: { url: 'https://a.example/' } })
      cancel.abort(new Error('cancelled'))
      await expect(opening).rejects.toThrow('cancelled')
    } finally {
      await h.fiber.dispose()
      host.remove()
    }
  })

  it('registers a multi-instance builtin and its body and title', async () => {
    const { tabs, registered, dictionaries } = await boot()
    const definition = tabs.get(BROWSER_KIND)
    expect(definition).toMatchObject({ id: BROWSER_ID, kind: BROWSER_KIND, multiple: true, priority: 'builtin' })
    expect(definition?.title('sidebar://browser')).toBe('type.label')
    expect(definition?.guide?.map(entry => [entry.order, entry.title(), entry.description?.()]))
      .toEqual([[30, 'guide.title', 'guide.description']])
    expect(dictionaries.get('sidebarBrowser')).toEqual({ zh, en, ja, es, fr, de, ru, pt })
    expect(dictionaries.get('sidebarBrowser')).toMatchObject({
      zh: { 'guide.description': '浏览网页' },
      en: { 'guide.description': 'Browse web pages' },
    })
    expect(registered.map(entry => [entry.name, entry.key, entry.locale, entry.component])).toEqual([
      ['sidebar.right.pane.tab', BROWSER_ID, 'sidebarBrowser', BrowserBody],
      ['sidebar.right.pane.tab.title', BROWSER_ID, undefined, BrowserTitle],
    ])
    expect(registered[0]?.store).toBeDefined()
    expect(registered[0]?.inject).toBeTypeOf('function')
    const injectFace = registered[0]?.inject as ((sessionId: string, actions: unknown) => unknown)
    const browser = injectFace('session', { replace: vi.fn(), forget: vi.fn() }) as BrowserInjected
    expect(browser.keyedHooks.browserState('missing')).toBeUndefined()
    expect(typeof browser.mount).toBe('function')
  })

  it.each(['macos', 'windows'] as const)('opens the resolved Browser target with the %s default and releases the shortcut', async (platform) => {
    const h = await boot(platform)
    try {
      expect(h.registry.catalog.getSnapshot()[0]?.keys).toEqual(platform === 'macos' ? ['⌘', 'T'] : ['Ctrl', '+', 'T'])
      expect(h.tabs.get(BROWSER_KIND)?.guide?.[0]?.commandId).toBe('browser.new')
      const gesture = { code: 'KeyT', control: platform === 'windows', meta: platform === 'macos',
        alt: false, shift: false, repeat: false, composing: false, defaultPrevented: false }
      const context = { region: 'page' as const, modal: null, target: null }
      const consume = vi.fn()
      expect(h.registry.dispatch(gesture, context, consume).status).toBe('handled')
      expect(h.sidebar.openTabFromTarget).toHaveBeenCalledExactlyOnceWith('browser', h.target)
      h.registry.dispatch({ ...gesture, repeat: true }, context, consume)
      expect(h.sidebar.openTabFromTarget).toHaveBeenCalledOnce()
      h.sidebar.commandTarget.mockReturnValue(undefined)
      expect(h.registry.dispatch(gesture, context, consume).status).toBe('blocked')
    } finally { await h.fiber.dispose() }
    expect(h.registry.catalog.getSnapshot()).toEqual([])
  })

  it('publishes the macOS Web Browser default', async () => {
    const h = await boot('macos', 'web')
    try { expect(h.registry.catalog.getSnapshot()[0]?.binding).toEqual({ code: 'KeyT', modifiers: ['alt', 'meta'] }) }
    finally { await h.fiber.dispose() }
  })

  it('removes every registration when the plugin is disposed', async () => {
    const { tabs, registered, dictionaries, fiber } = await boot()
    await fiber.dispose()
    expect(tabs.get(BROWSER_KIND)).toBeUndefined()
    expect(registered).toEqual([])
    expect(dictionaries.size).toBe(0)
  })
})
