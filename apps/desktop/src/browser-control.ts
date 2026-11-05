/** Validated, lease-scoped Sidebar browser operations; no caller-supplied script or CDP reaches a guest. */
import type { WebContents } from 'electron'
import type {
  SidebarBrowserCommand, SidebarBrowserElement, SidebarBrowserFailureCode, SidebarBrowserKey, SidebarBrowserObservation,
} from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

/** Failure identity that survives transport; dispatched input is never rolled back or retried. */
export class BrowserControlError extends Error {
  /**
   * @param code - stable failure identity.
   * @param message - English diagnostic for the caller; never page-derived.
   * @param outcome - whether the command may have reached the page.
   * @param options - underlying cause.
   */
  constructor(readonly code: SidebarBrowserFailureCode, message: string,
    readonly outcome: 'not-dispatched' | 'unknown' = 'not-dispatched', options?: ErrorOptions) {
    super(message, options)
    this.name = 'BrowserControlError'
  }
}

/** Electron operations the controller uses; tests substitute deterministic guests. */
export type BrowserControlGuest = Pick<WebContents, 'isDestroyed' | 'getURL' | 'getTitle' | 'getZoomFactor'
  | 'executeJavaScriptInIsolatedWorld' | 'capturePage' | 'loadURL' | 'sendInputEvent' | 'insertText'>

/** Main-owned guest and its authorization check, repeated after every asynchronous step. */
export interface BrowserControlTarget {
  readonly guest: BrowserControlGuest
  /** @returns whether the lease still owns this live guest. */
  isAvailable(): boolean
}

/** Bounds for one operation; `navigate` waits for the page load, every other command for its own work. */
export const BROWSER_CONTROL_TIMEOUT_MS = { operation: 15_000, navigate: 30_000 } as const

const TEXT_LIMIT = 20_000
const ELEMENT_LIMIT = 200
const NAME_LIMIT = 200
const TITLE_LIMIT = 4096
const IMAGE_LIMIT = 8 * 1024 * 1024
const COORDINATE_LIMIT = 100_000
const VIEWPORT_LIMIT = 16_384
// Any id other than 0 (the page's world) and 999 (Electron's preload world); page scripts cannot reach it.
const CONTROL_WORLD = 1001

const KEYS: Readonly<Record<SidebarBrowserKey, { readonly keyCode: string; readonly char?: string }>> = {
  // Chromium inserts text and submits forms on the char event; it suppresses that char when keydown was handled.
  Enter: { keyCode: 'Enter', char: '\r' },
  Tab: { keyCode: 'Tab', char: '\t' },
  Space: { keyCode: 'Space', char: ' ' },
  Escape: { keyCode: 'Escape' },
  Backspace: { keyCode: 'Backspace' },
  Delete: { keyCode: 'Delete' },
  ArrowUp: { keyCode: 'Up' },
  ArrowDown: { keyCode: 'Down' },
  ArrowLeft: { keyCode: 'Left' },
  ArrowRight: { keyCode: 'Right' },
  Home: { keyCode: 'Home' },
  End: { keyCode: 'End' },
  PageUp: { keyCode: 'PageUp' },
  PageDown: { keyCode: 'PageDown' },
}

const FIELDS: Readonly<Record<SidebarBrowserCommand['action'], readonly string[]>> = {
  read: ['action'], screenshot: ['action'], navigate: ['action', 'url'], click: ['action', 'x', 'y'],
  type: ['action', 'text'], key: ['action', 'key'], scroll: ['action', 'x', 'y', 'deltaY'],
}

function invalid(message: string): BrowserControlError {
  return new BrowserControlError('invalid-input', message)
}

function text(value: unknown, limit: number, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > limit) {
    throw invalid(`Browser ${field} must be 1 to ${String(limit)} characters`)
  }
  return value
}

function integer(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > COORDINATE_LIMIT) {
    throw invalid(`Browser coordinates must be integers from ${String(minimum)} to ${String(COORDINATE_LIMIT)}`)
  }
  return value
}

function isAction(value: unknown): value is SidebarBrowserCommand['action'] {
  return typeof value === 'string' && Object.hasOwn(FIELDS, value)
}

function isKey(value: string): value is SidebarBrowserKey {
  return Object.hasOwn(KEYS, value)
}

/**
 * Parse one untrusted command; unknown actions, unknown fields and out-of-range values are rejected.
 * @param input - JSON received over IPC.
 * @returns a command that carries no executable caller content.
 * @throws BrowserControlError with `invalid-input`.
 */
export function parseBrowserControl(input: unknown): SidebarBrowserCommand {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw invalid('Browser command must be an object')
  const row = input as Record<string, unknown>
  const action = row.action
  if (!isAction(action)) throw invalid('Unsupported browser command')
  const allowed = FIELDS[action]
  const extra = Object.keys(row).find(key => !allowed.includes(key))
  if (extra !== undefined) throw invalid(`Browser command ${action} does not accept ${JSON.stringify(extra.slice(0, 64))}`)
  switch (action) {
    case 'read': case 'screenshot': return { action }
    case 'navigate': return { action, url: text(row.url, 16 * 1024, 'URL') }
    case 'click': return { action, x: integer(row.x, 0), y: integer(row.y, 0) }
    case 'type': return { action, text: text(row.text, TEXT_LIMIT, 'text') }
    case 'scroll': return { action, x: integer(row.x, 0), y: integer(row.y, 0), deltaY: integer(row.deltaY, -COORDINATE_LIMIT) }
    case 'key': {
      const key = text(row.key, 32, 'key')
      if (!isKey(key)) throw invalid('Unsupported browser key')
      return { action, key }
    }
  }
}

// Fixed source evaluated in an isolated world: page scripts share the DOM but cannot replace these built-ins.
const READ_PAGE = `(() => {
  const clip = (value, limit) => {
    let out = value.slice(0, limit)
    const last = out.charCodeAt(out.length - 1)
    if (out.length < value.length && last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
    return out
  }
  const squash = value => (value || '').replace(/\\s+/g, ' ').trim()
  const raw = document.body ? document.body.innerText : ''
  const text = clip(raw, ${String(TEXT_LIMIT)})
  const width = window.innerWidth
  const height = window.innerHeight
  const declared = new Set(['button', 'link', 'checkbox', 'tab', 'menuitem'])
  const tagRoles = { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', summary: 'button' }
  const inputRoles = { button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', search: 'searchbox' }
  const fields = new Set(['input', 'textarea', 'select'])
  const roleOf = element => {
    const role = squash(element.getAttribute('role')).split(' ')[0]
    if (declared.has(role)) return role
    const tag = element.localName
    if (tag === 'input') return inputRoles[(element.getAttribute('type') || 'text').toLowerCase()] || 'textbox'
    return tagRoles[tag] || (element.isContentEditable ? 'textbox' : 'generic')
  }
  const nameOf = element => {
    const label = squash(element.getAttribute('aria-label'))
    if (label) return label
    const labelled = squash((element.getAttribute('aria-labelledby') || '').split(/\\s+/)
      .map(id => { const owner = id ? document.getElementById(id) : null; return owner ? owner.innerText || owner.textContent : '' }).join(' '))
    if (labelled) return labelled
    const labels = element.labels ? squash(Array.from(element.labels, owner => owner.innerText).join(' ')) : ''
    if (labels) return labels
    if (element.localName === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase()
      if (type === 'button' || type === 'submit' || type === 'reset') return squash(element.value)
      if (type === 'image') return squash(element.getAttribute('alt'))
    }
    const placeholder = squash(element.getAttribute('placeholder'))
    if (placeholder) return placeholder
    const inner = fields.has(element.localName) ? '' : squash(element.innerText)
    if (inner) return inner
    const image = element.querySelector('img[alt]')
    return squash(image ? image.getAttribute('alt') : '') || squash(element.getAttribute('title'))
  }
  const selector = 'a, button, input, textarea, select, summary, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"], [contenteditable="true"], [contenteditable=""]'
  const elements = []
  for (const element of document.querySelectorAll(selector)) {
    if (elements.length >= ${String(ELEMENT_LIMIT)}) break
    if (element.localName === 'input' && (element.getAttribute('type') || '').toLowerCase() === 'hidden') continue
    if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue
    const rect = element.getBoundingClientRect()
    const left = Math.max(0, rect.left)
    const top = Math.max(0, rect.top)
    const right = Math.min(width, rect.right)
    const bottom = Math.min(height, rect.bottom)
    if (right - left < 1 || bottom - top < 1) continue
    elements.push({ ref: elements.length + 1, role: roleOf(element), name: clip(nameOf(element), ${String(NAME_LIMIT)}),
      x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) })
  }
  return { text, truncated: text.length < raw.length, elements }
})()`

const VIEWPORT = '(() => ({ width: window.innerWidth, height: window.innerHeight }))()'
const ROLES = new Set(['button', 'link', 'checkbox', 'tab', 'menuitem', 'combobox', 'textbox', 'radio', 'slider', 'searchbox', 'generic'])

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function bounded(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
}

function malformed(what: string): BrowserControlError {
  return new BrowserControlError('operation-failed', `Browser returned an invalid ${what}`, 'unknown')
}

function parseElement(value: unknown, index: number): SidebarBrowserElement {
  const row = record(value)
  if (row === undefined || row.ref !== index + 1 || typeof row.role !== 'string' || !ROLES.has(row.role)
    || typeof row.name !== 'string' || row.name.length > NAME_LIMIT || !bounded(row.x, 0, COORDINATE_LIMIT)
    || !bounded(row.y, 0, COORDINATE_LIMIT) || !bounded(row.width, 1, COORDINATE_LIMIT) || !bounded(row.height, 1, COORDINATE_LIMIT)) {
    throw malformed('element observation')
  }
  return { ref: row.ref, role: row.role, name: row.name, x: row.x, y: row.y, width: row.width, height: row.height }
}

function parseRead(value: unknown): Pick<SidebarBrowserObservation, 'text' | 'truncated' | 'elements'> {
  const row = record(value)
  if (row === undefined || typeof row.text !== 'string' || row.text.length > TEXT_LIMIT || typeof row.truncated !== 'boolean'
    || !Array.isArray(row.elements) || row.elements.length > ELEMENT_LIMIT) throw malformed('page observation')
  return { text: row.text, truncated: row.truncated, elements: row.elements.map(parseElement) }
}

function parseViewport(value: unknown): { readonly width: number; readonly height: number } {
  const row = record(value)
  if (row === undefined || !bounded(row.width, 0, VIEWPORT_LIMIT) || !bounded(row.height, 0, VIEWPORT_LIMIT)) throw malformed('viewport')
  if (row.width === 0 || row.height === 0) {
    throw new BrowserControlError('operation-failed', 'Browser tab is not visible, so it cannot be captured', 'unknown')
  }
  return { width: row.width, height: row.height }
}

function loadFailure(error: unknown): BrowserControlError {
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    && /^ERR_[A-Z_]{1,64}$/.test(error.code) ? ` (${error.code})` : ''
  return new BrowserControlError('operation-failed', `Browser page failed to load${code}; inspect the tab before another action`,
    'unknown', { cause: error })
}

async function perform(guest: BrowserControlGuest, command: SidebarBrowserCommand): Promise<Partial<SidebarBrowserObservation>> {
  const zoom = guest.getZoomFactor()
  const point = (x: number, y: number) => ({ x: Math.round(x * zoom), y: Math.round(y * zoom) })
  switch (command.action) {
    case 'read':
      return parseRead(await guest.executeJavaScriptInIsolatedWorld(CONTROL_WORLD, [{ code: READ_PAGE }]))
    case 'screenshot': {
      const { width, height } = parseViewport(await guest.executeJavaScriptInIsolatedWorld(CONTROL_WORLD, [{ code: VIEWPORT }]))
      const image = await guest.capturePage()
      if (image.isEmpty()) throw new BrowserControlError('operation-failed', 'Browser tab is not visible, so it cannot be captured', 'unknown')
      const bytes = image.resize({ width, height }).toPNG()
      if (bytes.length > IMAGE_LIMIT) throw new BrowserControlError('result-too-large', 'Browser screenshot exceeds 8 MiB', 'unknown')
      return { image: bytes.toString('base64'), mimeType: 'image/png', width, height }
    }
    case 'navigate':
      try { await guest.loadURL(command.url) }
      catch (error) { throw loadFailure(error) }
      return { status: 'dispatched' }
    case 'click': {
      const at = point(command.x, command.y)
      guest.sendInputEvent({ type: 'mouseMove', ...at })
      guest.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 })
      guest.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 })
      return { status: 'dispatched' }
    }
    case 'type':
      await guest.insertText(command.text)
      return { status: 'dispatched' }
    case 'scroll':
      // Chromium wheel deltas are positive toward the top of the page; the command uses the DOM sign.
      guest.sendInputEvent({ type: 'mouseWheel', ...point(command.x, command.y), deltaX: 0,
        deltaY: -Math.round(command.deltaY * zoom), canScroll: true })
      return { status: 'dispatched' }
    case 'key': {
      const key = KEYS[command.key]
      guest.sendInputEvent({ type: 'keyDown', keyCode: key.keyCode })
      if (key.char !== undefined) guest.sendInputEvent({ type: 'char', keyCode: key.char })
      guest.sendInputEvent({ type: 'keyUp', keyCode: key.keyCode })
      return { status: 'dispatched' }
    }
  }
}

function deadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new BrowserControlError('timed-out',
        `Browser operation did not finish within ${String(milliseconds / 1000)} s; inspect the tab before another action`, 'unknown'))
    }, milliseconds)
  })
  return Promise.race([operation, expired]).finally(() => { clearTimeout(timer) })
}

/**
 * Run one serialized command on an authorized guest. Observations that cross a navigation or a revocation are
 * discarded; input reports delivery only, never the page's reaction.
 * @param target - exact main-owned guest lease.
 * @param command - parsed command.
 * @param allowedNavigation - main-owned HTTP(S) and application-host policy.
 * @returns the bounded observation.
 * @throws BrowserControlError for every failure, including `timed-out` after {@link BROWSER_CONTROL_TIMEOUT_MS}.
 */
export async function executeBrowserControl(target: BrowserControlTarget, command: SidebarBrowserCommand,
  allowedNavigation: (url: string) => boolean): Promise<SidebarBrowserObservation> {
  if (!target.isAvailable()) throw new BrowserControlError('unavailable', 'Browser tab was closed')
  const guest = target.guest
  const url = guest.getURL()
  if (!allowedNavigation(url)) throw new BrowserControlError('unavailable', 'Browser tab is not showing an HTTP(S) page')
  if (command.action === 'navigate' && !allowedNavigation(command.url)) {
    throw invalid('Browser navigation requires a credential-free HTTP(S) URL outside Casper')
  }
  const run = async (): Promise<SidebarBrowserObservation> => {
    let result: Partial<SidebarBrowserObservation>
    try { result = await perform(guest, command) }
    catch (error) {
      if (error instanceof BrowserControlError) throw error
      throw new BrowserControlError('operation-failed', 'Browser operation failed; inspect the tab before another action',
        'unknown', { cause: error })
    }
    if (!target.isAvailable()) throw new BrowserControlError('unavailable', 'Browser tab was closed during the operation', 'unknown')
    const current = guest.getURL()
    if (!allowedNavigation(current) || ((command.action === 'read' || command.action === 'screenshot') && current !== url)) {
      throw new BrowserControlError('unavailable', 'Browser tab navigated during the operation; inspect it again', 'unknown')
    }
    return { url: current, title: guest.getTitle().slice(0, TITLE_LIMIT), ...result }
  }
  return deadline(run(), command.action === 'navigate' ? BROWSER_CONTROL_TIMEOUT_MS.navigate : BROWSER_CONTROL_TIMEOUT_MS.operation)
}
