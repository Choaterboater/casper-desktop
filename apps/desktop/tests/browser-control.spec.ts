/** Agent control reaches only attached guests leased to the calling window, one bounded operation at a time. */
import { EventEmitter } from 'node:events'
import type { BrowserWindow, WebContents } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import type { SidebarBrowserControlResult } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DesktopBrowserGuests } from '../src/browser-guests.ts'
import { BROWSER_CONTROL_TIMEOUT_MS, BrowserControlError, parseBrowserControl } from '../src/browser-control.ts'

vi.mock('electron', () => ({
  app: { isPackaged: true },
  session: { fromPartition: () => Object.assign(new EventEmitter(), {
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {},
    setDisplayMediaRequestHandler() {}, webRequest: { onBeforeRequest() {} },
  }) },
}))

afterEach(() => { vi.useRealTimers() })

const element = { ref: 1, role: 'button', name: 'Search', x: 10, y: 20, width: 80, height: 24 }
const page = { text: 'Fixture heading', truncated: false, elements: [element] }

function owner(): WebContents & { destroy(): void } {
  let destroyed = false
  // Object.create skips EventEmitter construction; Node initializes listener storage on first use.
  return Object.assign(Object.create(EventEmitter.prototype) as WebContents, {
    isDestroyed: () => destroyed, send: vi.fn(), destroy: () => { destroyed = true },
  })
}

function setup() {
  const manager = new DesktopBrowserGuests(() => 'http://127.0.0.1:62105')
  const window = owner()
  const reservation = manager.acquire(window, 'workspace')
  manager.bind(Object.assign({} as BrowserWindow, { webContents: window }), () => () => {})
  let destroyed = false
  let url = 'about:blank'
  let zoom = 1
  const scaled = { toPNG: vi.fn(() => Buffer.from('png')) }
  const image = { isEmpty: vi.fn(() => false), resize: vi.fn((_size: { width: number; height: number }) => scaled) }
  const evaluate = vi.fn(async (_world: number, scripts: readonly { code: string }[]): Promise<unknown> =>
    scripts[0]!.code.includes('innerText') ? page : { width: 800, height: 600 })
  const guest = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed, getURL: () => url, getTitle: () => 'Fixture', getZoomFactor: () => zoom,
    executeJavaScriptInIsolatedWorld: evaluate, capturePage: vi.fn(async () => image),
    loadURL: vi.fn(async (next: string) => { url = next }), sendInputEvent: vi.fn(), insertText: vi.fn(async (_text: string) => {}),
    setWindowOpenHandler: vi.fn(), close: vi.fn(() => { destroyed = true; guest.emit('destroyed') }),
  })
  const reject = vi.fn()
  window.emit('will-attach-webview', { preventDefault: reject }, {}, { src: `about:blank#${reservation.lease}`, partition: reservation.partition })
  expect(reject).not.toHaveBeenCalled()
  window.emit('did-attach-webview', {}, guest)
  url = `about:blank#${reservation.lease}`
  guest.emit('dom-ready')
  url = 'https://fixture.example/'
  return {
    manager, window, reservation, guest, evaluate, image, scaled,
    navigate: (next: string) => { url = next }, zoom: (value: number) => { zoom = value },
    call: (command: unknown, sender: WebContents = window, lease: unknown = reservation.lease) => manager.control(sender, lease, command),
  }
}

function failure(code: string, outcome: 'not-dispatched' | 'unknown'): Partial<SidebarBrowserControlResult> {
  return { ok: false, code: code as 'unavailable', outcome }
}

it('reads visible text and interactive elements through fixed isolated-world code', async () => {
  const fixture = setup()
  await expect(fixture.call({ action: 'read' })).resolves.toEqual({ ok: true, observation: {
    url: 'https://fixture.example/', title: 'Fixture', text: 'Fixture heading', truncated: false, elements: [element],
  } })
  const [world, scripts] = fixture.evaluate.mock.calls[0]!
  expect(world).not.toBe(0)
  expect(world).not.toBe(999)
  expect(scripts[0]!.code).toContain('checkVisibility')
  expect(scripts[0]!.code).toContain('clip(raw, 20000)')
  fixture.evaluate.mockResolvedValueOnce({ ...page, extra: 'dropped', elements: [{ ...element, extra: 'dropped' }] })
  await expect(fixture.call({ action: 'read' })).resolves.toEqual({ ok: true, observation: {
    url: 'https://fixture.example/', title: 'Fixture', text: 'Fixture heading', truncated: false, elements: [element],
  } })
})

it.each([
  ['oversized text', { ...page, text: 'a'.repeat(20_001) }],
  ['missing flag', { text: '', elements: [] }],
  ['too many elements', { ...page, elements: Array.from({ length: 201 }, (_, index) => ({ ...element, ref: index + 1 })) }],
  ['unordered refs', { ...page, elements: [{ ...element, ref: 2 }] }],
  ['unknown role', { ...page, elements: [{ ...element, role: 'x'.repeat(10) }] }],
  ['long name', { ...page, elements: [{ ...element, name: 'n'.repeat(201) }] }],
  ['fractional rectangle', { ...page, elements: [{ ...element, x: 1.5 }] }],
  ['empty rectangle', { ...page, elements: [{ ...element, width: 0 }] }],
  ['non-object', 'text'],
])('rejects a page observation with %s', async (_label, value) => {
  const fixture = setup()
  fixture.evaluate.mockResolvedValueOnce(value)
  await expect(fixture.call({ action: 'read' })).resolves.toMatchObject(failure('operation-failed', 'unknown'))
})

it('scales screenshots to the CSS viewport and bounds the PNG', async () => {
  const fixture = setup()
  await expect(fixture.call({ action: 'screenshot' })).resolves.toEqual({ ok: true, observation: {
    url: 'https://fixture.example/', title: 'Fixture', image: Buffer.from('png').toString('base64'), mimeType: 'image/png',
    width: 800, height: 600,
  } })
  expect(fixture.image.resize).toHaveBeenCalledWith({ width: 800, height: 600 })
  fixture.scaled.toPNG.mockReturnValueOnce(Buffer.alloc(8 * 1024 * 1024 + 1))
  await expect(fixture.call({ action: 'screenshot' })).resolves.toMatchObject(failure('result-too-large', 'unknown'))
  fixture.image.isEmpty.mockReturnValueOnce(true)
  await expect(fixture.call({ action: 'screenshot' })).resolves.toMatchObject(failure('operation-failed', 'unknown'))
  for (const viewport of [{ width: 0, height: 600 }, { width: 800 }, null]) {
    fixture.evaluate.mockResolvedValueOnce(viewport)
    await expect(fixture.call({ action: 'screenshot' })).resolves.toMatchObject(failure('operation-failed', 'unknown'))
  }
})

it('dispatches input in CSS pixels without claiming the page reacted', async () => {
  const fixture = setup()
  fixture.zoom(1.5)
  for (const command of [
    { action: 'click', x: 10, y: 20 }, { action: 'type', text: 'hello' }, { action: 'scroll', x: 2, y: 4, deltaY: 200 },
    { action: 'key', key: 'Enter' }, { action: 'key', key: 'ArrowDown' }, { action: 'navigate', url: 'https://fixture.example/next' },
  ]) await expect(fixture.call(command)).resolves.toMatchObject({ ok: true, observation: { status: 'dispatched' } })
  expect(fixture.guest.sendInputEvent.mock.calls.map(([event]: unknown[]) => event)).toEqual([
    { type: 'mouseMove', x: 15, y: 30 },
    { type: 'mouseDown', x: 15, y: 30, button: 'left', clickCount: 1 },
    { type: 'mouseUp', x: 15, y: 30, button: 'left', clickCount: 1 },
    { type: 'mouseWheel', x: 3, y: 6, deltaX: 0, deltaY: -300, canScroll: true },
    { type: 'keyDown', keyCode: 'Enter' }, { type: 'char', keyCode: '\r' }, { type: 'keyUp', keyCode: 'Enter' },
    { type: 'keyDown', keyCode: 'Down' }, { type: 'keyUp', keyCode: 'Down' },
  ])
  expect(fixture.guest.insertText).toHaveBeenCalledExactlyOnceWith('hello')
  expect(fixture.guest.loadURL).toHaveBeenCalledExactlyOnceWith('https://fixture.example/next')
})

it.each([['Space', ' '], ['Tab', '\t']])('sends %s with the character Chromium inserts', async (key, char) => {
  const fixture = setup()
  await fixture.call({ action: 'key', key })
  expect(fixture.guest.sendInputEvent).toHaveBeenCalledWith({ type: 'char', keyCode: char })
})

it.each(['file:///private/secret', 'javascript:alert(1)', 'https://user:pass@fixture.example', 'http://localhost:62105/'])('rejects navigation to %s before dispatch', async (url) => {
  const fixture = setup()
  await expect(fixture.call({ action: 'navigate', url })).resolves.toMatchObject(failure('invalid-input', 'not-dispatched'))
  expect(fixture.guest.loadURL).not.toHaveBeenCalled()
})

it('reports a failed page load with its Chromium code and does not retry', async () => {
  const fixture = setup()
  fixture.guest.loadURL.mockRejectedValueOnce(Object.assign(new Error('failed'), { code: 'ERR_NAME_NOT_RESOLVED' }))
  const result = await fixture.call({ action: 'navigate', url: 'https://missing.example/' })
  expect(result).toMatchObject(failure('operation-failed', 'unknown'))
  expect(!result.ok && result.message).toContain('ERR_NAME_NOT_RESOLVED')
  fixture.guest.loadURL.mockRejectedValueOnce(new Error('no code'))
  const uncoded = await fixture.call({ action: 'navigate', url: 'https://missing.example/' })
  expect(!uncoded.ok && uncoded.message).not.toContain('(')
  expect(fixture.guest.loadURL).toHaveBeenCalledTimes(2)
})

it.each(['about:blank', 'http://127.0.0.1:62105/private'])('refuses to operate on a guest at %s', async (url) => {
  const fixture = setup()
  fixture.navigate(url)
  await expect(fixture.call({ action: 'read' })).resolves.toMatchObject(failure('unavailable', 'not-dispatched'))
  expect(fixture.evaluate).not.toHaveBeenCalled()
})

it.each([null, [], {}, { action: 'eval' }, { action: 'read', tabId: 'x' }, { action: 'click', x: Number.NaN, y: 1 },
  { action: 'click', x: -1, y: 1 }, { action: 'click', x: 1.5, y: 1 }, { action: 'click', x: 1 }, { action: 'scroll', x: 1, y: 1, deltaY: 100_001 },
  { action: 'type', text: '' }, { action: 'type', text: 'x'.repeat(20_001) }, { action: 'key', key: 'F12' }, { action: 'key', key: 'toString' },
  { action: 'navigate', url: 7 }])('rejects malformed command %#', (input) => {
  expect(() => parseBrowserControl(input)).toThrow(BrowserControlError)
})

it('accepts the bounds of every numeric field', () => {
  expect(parseBrowserControl({ action: 'scroll', x: 0, y: 100_000, deltaY: -100_000 })).toEqual({ action: 'scroll', x: 0, y: 100_000, deltaY: -100_000 })
})

it('returns a malformed command as a value without touching the guest', async () => {
  const fixture = setup()
  await expect(fixture.call({ action: 'eval', code: '1' })).resolves.toMatchObject(failure('invalid-input', 'not-dispatched'))
  await expect(fixture.call({ action: 'read' }, fixture.window, 7)).resolves.toMatchObject(failure('invalid-input', 'not-dispatched'))
  expect(fixture.evaluate).not.toHaveBeenCalled()
})

it('answers another window, an unknown lease and an unattached lease identically', async () => {
  const fixture = setup()
  const unattached = fixture.manager.acquire(fixture.window, 'workspace')
  const results = await Promise.all([
    fixture.call({ action: 'click', x: 1, y: 1 }, owner()),
    fixture.call({ action: 'click', x: 1, y: 1 }, fixture.window, 'not-a-lease'),
    fixture.call({ action: 'click', x: 1, y: 1 }, fixture.window, unattached.lease),
  ])
  for (const result of results) expect(result).toEqual(results[0])
  expect(results[0]).toMatchObject(failure('unavailable', 'not-dispatched'))
  expect(fixture.guest.sendInputEvent).not.toHaveBeenCalled()
})

it('serializes one lease and does not deliver input queued behind a release', async () => {
  const fixture = setup()
  let finish: (value: unknown) => void = () => {}
  let entered: () => void = () => {}
  const started = new Promise<void>((resolve) => { entered = resolve })
  fixture.evaluate.mockImplementationOnce(() => { entered(); return new Promise((resolve) => { finish = resolve }) })
  const reading = fixture.call({ action: 'read' })
  await started
  const typing = fixture.call({ action: 'type', text: 'must not be delivered' })
  await Promise.resolve()
  expect(fixture.guest.insertText).not.toHaveBeenCalled()
  await fixture.manager.release(fixture.window, fixture.reservation.lease)
  finish(page)
  await expect(reading).resolves.toMatchObject(failure('unavailable', 'unknown'))
  await expect(typing).resolves.toMatchObject(failure('unavailable', 'not-dispatched'))
  expect(fixture.guest.insertText).not.toHaveBeenCalled()
  await expect(fixture.call({ action: 'read' })).resolves.toMatchObject(failure('unavailable', 'not-dispatched'))
})

it('times out a hung page without blocking the next command', async () => {
  vi.useFakeTimers()
  const fixture = setup()
  fixture.evaluate.mockImplementationOnce(() => new Promise(() => {}))
  const hung = fixture.call({ action: 'read' })
  const next = fixture.call({ action: 'click', x: 1, y: 1 })
  await vi.advanceTimersByTimeAsync(BROWSER_CONTROL_TIMEOUT_MS.operation - 1)
  expect(fixture.guest.sendInputEvent).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  await expect(hung).resolves.toMatchObject(failure('timed-out', 'unknown'))
  await expect(next).resolves.toMatchObject({ ok: true, observation: { status: 'dispatched' } })
  fixture.guest.loadURL.mockImplementationOnce(() => new Promise(() => {}))
  const loading = fixture.call({ action: 'navigate', url: 'https://slow.example/' })
  await vi.advanceTimersByTimeAsync(BROWSER_CONTROL_TIMEOUT_MS.operation)
  let settled = false
  void loading.then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(BROWSER_CONTROL_TIMEOUT_MS.navigate - BROWSER_CONTROL_TIMEOUT_MS.operation)
  await expect(loading).resolves.toMatchObject(failure('timed-out', 'unknown'))
})

it('discards observations after navigation and refuses a destroyed window', async () => {
  const fixture = setup()
  fixture.evaluate.mockImplementationOnce(async () => { fixture.navigate('https://fixture.example/changed'); return page })
  await expect(fixture.call({ action: 'read' })).resolves.toMatchObject(failure('unavailable', 'unknown'))
  fixture.guest.insertText.mockImplementationOnce(async () => { fixture.navigate('about:blank') })
  await expect(fixture.call({ action: 'type', text: 'x' })).resolves.toMatchObject(failure('unavailable', 'unknown'))
  fixture.navigate('https://fixture.example/')
  fixture.window.destroy()
  await expect(fixture.call({ action: 'click', x: 1, y: 1 })).resolves.toMatchObject(failure('unavailable', 'not-dispatched'))
})

it('reports unexpected native failures as unknown and does not retry effects', async () => {
  const fixture = setup()
  fixture.guest.insertText.mockRejectedValueOnce(new Error('native failure'))
  await expect(fixture.call({ action: 'type', text: 'hello' })).resolves.toMatchObject(failure('operation-failed', 'unknown'))
  expect(fixture.guest.insertText).toHaveBeenCalledTimes(1)
})

it('propagates defects that are not control failures', async () => {
  const fixture = setup()
  fixture.guest.getURL = () => { throw new TypeError('defect') }
  await expect(fixture.call({ action: 'read' })).rejects.toThrow('defect')
})
