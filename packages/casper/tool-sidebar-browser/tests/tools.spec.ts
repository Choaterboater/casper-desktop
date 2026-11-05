import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SidebarBrowserObservation } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { ALLOW, DONT_ALLOW, QUESTION_ID, SiteGrants, type GrantState } from '../src/grants.ts'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import * as browser from '../src/index.ts'
import type { SidebarBrowserToolRequest, SidebarBrowserToolResponse, SidebarBrowserToolTab } from '../src/types.ts'

type Answer = (request: SidebarBrowserToolRequest) => Promise<SidebarBrowserToolResponse> | 'next'
type Ask = (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>

const SHOP: SidebarBrowserToolTab = { tabId: 'tab-1', url: 'https://shop.test/cart', title: 'Cart', active: true, live: true }
const BLANK: SidebarBrowserToolTab = { tabId: 'tab-2', url: null, title: null, active: false, live: false }
const PAGE: SidebarBrowserObservation = { url: 'https://shop.test/cart', title: 'Cart', status: 'dispatched' }
const REF: ImageAttachmentRef = { attachmentId: 'f'.repeat(64) as ImageAttachmentRef['attachmentId'], mediaType: 'image/png', bytes: 5, width: 640, height: 480 }

/** A Client that lists two tabs and observes `PAGE` unless a test scripts another answer. */
function defaultAnswer(request: SidebarBrowserToolRequest): Promise<SidebarBrowserToolResponse> {
  const operation = request.operation
  if (operation.kind === 'tabs') return Promise.resolve({ kind: 'tabs', tabs: [SHOP, BLANK] })
  if (operation.kind === 'open') return Promise.resolve({ kind: 'opened', tab: { ...SHOP, url: operation.url } })
  return Promise.resolve({ kind: 'observed', observation: PAGE })
}

interface Options {
  answer?: Answer
  ask?: Ask | null
  gateway?: { hasLiveClient(): boolean }
  attachments?: { saveImages: (images: readonly unknown[]) => Promise<readonly ImageAttachmentRef[]> } | null
  modalities?: string[] | null
}

let contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts = []
})

async function setup(options: Options = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(SessionProjectionRegistry)
  const asked = vi.fn<Ask>(options.ask ?? (() => Promise.resolve({ answers: [{ id: QUESTION_ID, selected: [ALLOW] }] })))
  if (options.ask !== null) ctx.provide('userQuestions', { ask: asked } as never)
  if (options.gateway !== undefined) ctx.provide('typertGateway', options.gateway as never)
  const saveImages = vi.fn(options.attachments?.saveImages ?? ((images: readonly unknown[]) => Promise.resolve(images.map(() => REF))))
  if (options.attachments !== null) ctx.provide('attachments', { saveImages } as never)
  const resolveModelInfo = vi.fn((_provider: string, model: string) =>
    Promise.resolve({ id: model, ...options.modalities === null ? {} : { inputModalities: options.modalities ?? ['text', 'image'] } }))
  ctx.provide('llm', { resolveModelInfo } as never)
  const requests: SidebarBrowserToolRequest[] = []
  const answer = options.answer ?? defaultAnswer
  ctx.on('casper-sidebar-browser/request', (request, next) => {
    requests.push(request)
    const answered = answer(request)
    return answered === 'next' ? next() : answered
  })
  await ctx.plugin(browser)
  const id = SessionId('browser-session')
  const agent = { id, session: Session.create(id), options: { provider: 'mock', model: 'vision' } } as Agent
  let calls = 0
  const run = (name: string, args: Record<string, unknown>, caller: Agent | null = agent, signal = new AbortController().signal) =>
    executeToolFixture(ctx, { signal, callId: ToolCallId(`call-${++calls}`), name, arguments: args, ...caller === null ? {} : { agent: caller } })
  return { ctx, agent, run, requests, asked, saveImages, resolveModelInfo }
}

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

describe('browser tools: registration and forwarding', () => {
  it('registers the nine tools and removes them when the plugin unloads', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    const fiber = ctx.plugin(browser)
    await fiber
    const names = ['browser_tabs', 'browser_open', 'browser_navigate', 'browser_read', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_key', 'browser_scroll']
    expect(ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('browser_'))).toEqual(names)
    await fiber.dispose()
    expect(ctx.tools.schemas().filter(schema => schema.name.startsWith('browser_'))).toEqual([])
  })

  it('forwards each call with a fresh operation id, the calling agent, and its signal', async () => {
    const { run, requests, agent } = await setup()
    const controller = new AbortController()
    const result = await run('browser_tabs', {}, agent, controller.signal)
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ ok: true, tabs: [SHOP, BLANK] })
    expect(text(result)).toBe('Browser tabs:\n- tab-1 (active): Cart — https://shop.test/cart\n- tab-2 (not loaded): (no title) — (no page)')
    await run('browser_tabs', {})
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({ operation: { kind: 'tabs' }, agent })
    expect(requests[0]?.signal?.aborted).toBe(false)
    expect(requests[0]?.operationId).not.toBe(requests[1]?.operationId)
  })

  it('answers that the desktop app must show the conversation when no Client answers', async () => {
    const { run } = await setup({ answer: () => 'next' })
    const result = await run('browser_tabs', {})
    expect(result.value).toEqual({ ok: false, code: 'unavailable', message: browser.NO_DESKTOP, outcome: 'not-dispatched' })
    expect(text(result)).toBe(`Browser unavailable: ${browser.NO_DESKTOP}`)
  })

  it('does not wait for a Client when none is connected', async () => {
    const { run, requests } = await setup({ gateway: { hasLiveClient: () => false } })
    expect((await run('browser_tabs', {})).value).toMatchObject({ ok: false, message: browser.NO_DESKTOP })
    expect(requests).toEqual([])
    const connected = await setup({ gateway: { hasLiveClient: () => true } })
    expect((await connected.run('browser_tabs', {})).value).toMatchObject({ ok: true })
  })

  it('fails a call without an agent, and a malformed or mismatched answer', async () => {
    const { run } = await setup()
    const orphan = await run('browser_tabs', {}, null)
    expect(orphan.isError).toBe(true)
    expect(text(orphan)).toContain('Browser tools need a calling agent.')
    const malformed = await setup({ answer: () => Promise.resolve({ kind: 'tabs' } as SidebarBrowserToolResponse) })
    expect((await malformed.run('browser_tabs', {})).isError).toBe(true)
    const mismatched = await setup({ answer: () => Promise.resolve({ kind: 'observed', observation: PAGE }) })
    const result = await mismatched.run('browser_tabs', {})
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('The browser answered tabs with an unexpected "observed" response.')
  })

  it('stops waiting for the Client when the call is cancelled', async () => {
    const pending = Promise.withResolvers<SidebarBrowserToolResponse>()
    const { run } = await setup({ answer: () => pending.promise })
    const controller = new AbortController()
    const result = run('browser_tabs', {}, undefined, controller.signal)
    controller.abort(new Error('stop'))
    expect((await result).isError).toBe(true)
    pending.resolve({ kind: 'tabs', tabs: [] })
  })

  it('passes a Client failure through as a value', async () => {
    const { run } = await setup({ answer: () => Promise.resolve({ kind: 'failed', code: 'timed-out', message: 'Too slow.', outcome: 'unknown' }) })
    const result = await run('browser_tabs', {})
    expect(result.value).toEqual({ ok: false, code: 'timed-out', message: 'Too slow.', outcome: 'unknown' })
  })
})

describe('browser_open and browser_navigate', () => {
  it('opens only http and https URLs', async () => {
    const { run, requests } = await setup()
    for (const url of ['javascript:alert(1)', 'not a url', 'file:///etc/passwd']) {
      const result = await run('browser_open', { url })
      expect(result.value).toMatchObject({ ok: false, code: 'invalid-input', outcome: 'not-dispatched' })
    }
    expect(requests).toEqual([])
    const opened = await run('browser_open', { url: 'https://shop.test' })
    expect(requests[0]?.operation).toEqual({ kind: 'open', url: 'https://shop.test/' })
    expect(opened.value).toEqual({ ok: true, tab: { ...SHOP, url: 'https://shop.test/' } })
    expect(text(opened)).toBe('Opened tab tab-1: https://shop.test/')
  })

  it('reports open failures and mismatched answers', async () => {
    const failing = await setup({ answer: () => Promise.resolve({ kind: 'failed', code: 'unavailable', message: 'Not on screen.', outcome: 'not-dispatched' }) })
    expect((await failing.run('browser_open', { url: 'https://a.test' })).value).toMatchObject({ ok: false, message: 'Not on screen.' })
    const mismatched = await setup({ answer: () => Promise.resolve({ kind: 'tabs', tabs: [] }) })
    expect((await mismatched.run('browser_open', { url: 'https://a.test' })).isError).toBe(true)
  })

  it('navigates an existing tab without asking permission', async () => {
    const { run, requests, asked } = await setup()
    expect((await run('browser_navigate', { tabId: 'tab-1', url: 'ftp://x' })).value).toMatchObject({ code: 'invalid-input' })
    const result = await run('browser_navigate', { tabId: 'tab-1', url: 'https://shop.test/cart' })
    expect(requests.at(-1)?.operation).toEqual({ kind: 'control', tabId: 'tab-1', command: { action: 'navigate', url: 'https://shop.test/cart' } })
    expect(result.value).toEqual({ ok: true, url: PAGE.url, title: PAGE.title })
    expect(text(result)).toBe('The tab now shows https://shop.test/cart (title: Cart).')
    expect(asked).not.toHaveBeenCalled()
    const failing = await setup({ answer: () => Promise.resolve({ kind: 'failed', code: 'timed-out', message: 'Slow.', outcome: 'unknown' }) })
    expect((await failing.run('browser_navigate', { tabId: 'tab-1', url: 'https://a.test' })).value).toMatchObject({ ok: false, outcome: 'unknown' })
    const mismatched = await setup({ answer: () => Promise.resolve({ kind: 'tabs', tabs: [] }) })
    expect((await mismatched.run('browser_navigate', { tabId: 'tab-1', url: 'https://a.test' })).isError).toBe(true)
  })
})

describe('browser_read and browser_screenshot', () => {
  it('reads text and element boxes, filling absent fields', async () => {
    const observation: SidebarBrowserObservation = {
      ...PAGE, text: 'Total: $5', truncated: false, elements: [{ ref: 1, role: 'button', name: 'Pay', x: 1, y: 2, width: 3, height: 4 }],
    }
    const full = await setup({ answer: () => Promise.resolve({ kind: 'observed', observation }) })
    const result = await full.run('browser_read', { tabId: 'tab-1' })
    expect(full.requests[0]?.operation).toEqual({ kind: 'control', tabId: 'tab-1', command: { action: 'read' } })
    expect(result.value).toEqual({ ok: true, url: PAGE.url, title: PAGE.title, text: 'Total: $5', truncated: false, elements: observation.elements })
    expect(text(result)).toContain('[1] button "Pay" @ (1,2 3x4)')
    const bare = await setup()
    expect((await bare.run('browser_read', { tabId: 'tab-1' })).value).toEqual({ ok: true, url: PAGE.url, title: PAGE.title, text: '', truncated: false, elements: [] })
    const failing = await setup({ answer: () => Promise.resolve({ kind: 'failed', code: 'unavailable', message: 'Gone.', outcome: 'not-dispatched' }) })
    expect((await failing.run('browser_read', { tabId: 'tab-1' })).value).toMatchObject({ ok: false, message: 'Gone.' })
  })

  it('stores the screenshot and returns it as an image the model sees', async () => {
    const observation: SidebarBrowserObservation = { ...PAGE, image: 'aGVsbG8=', mimeType: 'image/png', width: 320, height: 240 }
    const { run, saveImages, resolveModelInfo, requests } = await setup({ answer: () => Promise.resolve({ kind: 'observed', observation }) })
    const result = await run('browser_screenshot', { tabId: 'tab-1' })
    expect(resolveModelInfo).toHaveBeenCalledWith('mock', 'vision', expect.any(AbortSignal))
    expect(requests[0]?.operation).toEqual({ kind: 'control', tabId: 'tab-1', command: { action: 'screenshot' } })
    expect(saveImages).toHaveBeenCalledOnce()
    expect(result.value).toEqual({ ok: true, url: PAGE.url, title: PAGE.title, width: 320, height: 240, image: REF })
    expect(result.content).toContainEqual({ type: 'image', attachment: REF })
  })

  it('uses the model of the latest request and falls back to the image size', async () => {
    const observation: SidebarBrowserObservation = { ...PAGE, image: 'aGVsbG8=' }
    const { run, agent, resolveModelInfo } = await setup({ answer: () => Promise.resolve({ kind: 'observed', observation }) })
    vi.spyOn(agent.session, 'requestHeader').mockReturnValue({ config: { provider: 'routed', model: 'eyes' } })
    const result = await run('browser_screenshot', { tabId: 'tab-1' })
    expect(resolveModelInfo).toHaveBeenCalledWith('routed', 'eyes', expect.any(AbortSignal))
    expect(result.value).toMatchObject({ width: REF.width, height: REF.height })
  })

  it('explains why a screenshot cannot reach the model, before taking one', async () => {
    const textOnly = await setup({ modalities: ['text'] })
    const blind = await textOnly.run('browser_screenshot', { tabId: 'tab-1' })
    expect(blind.value).toMatchObject({ ok: false, code: 'unavailable', message: 'The current model (vision) cannot view images. Use browser_read for the page text and element positions.' })
    expect(textOnly.requests).toEqual([])
    const undeclared = await setup({ modalities: null })
    expect((await undeclared.run('browser_screenshot', { tabId: 'tab-1' })).value).toMatchObject({ code: 'unavailable' })
    const noStore = await setup({ attachments: null })
    expect((await noStore.run('browser_screenshot', { tabId: 'tab-1' })).value).toMatchObject({ message: expect.stringContaining('cannot be stored') as string })
    const noModel = await setup()
    const anonymous = { id: SessionId('anonymous'), session: Session.create(SessionId('anonymous')), options: {} } as Agent
    expect((await noModel.run('browser_screenshot', { tabId: 'tab-1' }, anonymous)).value).toMatchObject({ message: expect.stringContaining('cannot be stored') as string })
    const providerOnly = { ...anonymous, options: { provider: 'mock' } } as Agent
    expect((await noModel.run('browser_screenshot', { tabId: 'tab-1' }, providerOnly)).value).toMatchObject({ code: 'unavailable' })
  })

  it('fails a screenshot answer without an image or storage', async () => {
    const failing = await setup({ answer: () => Promise.resolve({ kind: 'failed', code: 'result-too-large', message: 'Big.', outcome: 'not-dispatched' }) })
    expect((await failing.run('browser_screenshot', { tabId: 'tab-1' })).value).toMatchObject({ code: 'result-too-large' })
    const imageless = await setup()
    expect(text(await imageless.run('browser_screenshot', { tabId: 'tab-1' }))).toContain('without an image')
    const unstored = await setup({
      answer: () => Promise.resolve({ kind: 'observed', observation: { ...PAGE, image: 'aGVsbG8=' } }),
      attachments: { saveImages: () => Promise.resolve([]) },
    })
    expect(text(await unstored.run('browser_screenshot', { tabId: 'tab-1' }))).toContain('The screenshot was not stored.')
  })
})

describe('input tools and per-site permission', () => {
  it('asks once per site, then sends input bound to the allowed origin', async () => {
    const { run, requests, asked } = await setup()
    const clicked = await run('browser_click', { tabId: 'tab-1', x: 10, y: 20 })
    expect(asked).toHaveBeenCalledOnce()
    expect(asked.mock.calls[0]?.[0].questions[0]?.question).toBe('Allow Casper to click and type on https://shop.test?')
    expect(requests.map(request => request.operation)).toEqual([
      { kind: 'tabs' },
      { kind: 'control', tabId: 'tab-1', command: { action: 'click', x: 10, y: 20 }, origin: 'https://shop.test' },
    ])
    expect(clicked.value).toEqual({ ok: true, url: PAGE.url, title: PAGE.title, origin: 'https://shop.test', status: 'dispatched' })
    expect(clicked.meta).toEqual({ origin: 'https://shop.test' })
    expect(text(clicked)).toBe('Clicked at (10, 20) on https://shop.test/cart. The input was sent; read the page or take a screenshot to see what changed.')
    expect(text(await run('browser_type', { tabId: 'tab-1', text: 'hello' }))).toContain('Typed the text on')
    expect(text(await run('browser_key', { tabId: 'tab-1', key: 'Enter' }))).toContain('Pressed Enter on')
    expect(text(await run('browser_scroll', { tabId: 'tab-1', x: 5, y: 6, deltaY: -300 }))).toContain('Scrolled -300 pixels at (5, 6) on')
    expect(asked).toHaveBeenCalledOnce()
    expect(requests.filter(request => request.operation.kind === 'control').map(request => request.operation)).toEqual([
      { kind: 'control', tabId: 'tab-1', command: { action: 'click', x: 10, y: 20 }, origin: 'https://shop.test' },
      { kind: 'control', tabId: 'tab-1', command: { action: 'type', text: 'hello' }, origin: 'https://shop.test' },
      { kind: 'control', tabId: 'tab-1', command: { action: 'key', key: 'Enter' }, origin: 'https://shop.test' },
      { kind: 'control', tabId: 'tab-1', command: { action: 'scroll', x: 5, y: 6, deltaY: -300 }, origin: 'https://shop.test' },
    ])
  })

  it('sends nothing on a site the user declined', async () => {
    const { run, requests } = await setup({ ask: () => Promise.resolve({ answers: [{ id: QUESTION_ID, selected: [DONT_ALLOW] }] }) })
    const result = await run('browser_click', { tabId: 'tab-1', x: 1, y: 1 })
    expect(result.value).toMatchObject({ ok: false, code: 'declined', outcome: 'not-dispatched' })
    expect(result.meta).toBeNull()
    expect(text(result)).toBe('Browser declined: The user declined to let you click or type on https://shop.test. Do not retry on this site unless the user asks you to.')
    expect(requests.map(request => request.operation.kind)).toEqual(['tabs'])
  })

  it('needs a known tab showing a web page', async () => {
    const { run, asked } = await setup()
    expect((await run('browser_click', { tabId: 'missing', x: 1, y: 1 })).value)
      .toMatchObject({ code: 'invalid-input', message: 'No browser tab has id "missing". Call browser_tabs for the open tabs.' })
    expect((await run('browser_click', { tabId: 'tab-2', x: 1, y: 1 })).value)
      .toMatchObject({ code: 'invalid-input', message: 'Tab "tab-2" shows no web page. Load one with browser_navigate first.' })
    expect(asked).not.toHaveBeenCalled()
    const failing = await setup({ answer: () => Promise.resolve({ kind: 'failed', code: 'unavailable', message: 'Gone.', outcome: 'not-dispatched' }) })
    expect((await failing.run('browser_type', { tabId: 'tab-1', text: 'x' })).value).toMatchObject({ message: 'Gone.' })
    const mismatched = await setup({ answer: () => Promise.resolve({ kind: 'observed', observation: PAGE }) })
    expect((await mismatched.run('browser_key', { tabId: 'tab-1', key: 'Tab' })).isError).toBe(true)
  })

  it('reports a failed input after permission', async () => {
    const answer: Answer = request => request.operation.kind === 'tabs'
      ? defaultAnswer(request)
      : Promise.resolve({ kind: 'failed', code: 'operation-failed', message: 'Tab left.', outcome: 'not-dispatched' })
    const { run } = await setup({ answer })
    const result = await run('browser_scroll', { tabId: 'tab-1', x: 1, y: 1, deltaY: 100 })
    expect(result.value).toMatchObject({ ok: false, code: 'operation-failed' })
    expect(result.meta).toBeNull()
  })

  it('rejects out-of-range input before asking', async () => {
    const { run, requests, asked } = await setup()
    const failures = [
      await run('browser_click', { tabId: 'tab-1', x: -1, y: 0 }),
      await run('browser_click', { tabId: 'tab-1', x: 0, y: 100_001 }),
      await run('browser_scroll', { tabId: 'tab-1', x: 0, y: 0, deltaY: -100_001 }),
      await run('browser_scroll', { tabId: 'tab-1', x: 0, y: -5, deltaY: 1 }),
      await run('browser_type', { tabId: 'tab-1', text: '' }),
      await run('browser_type', { tabId: 'tab-1', text: 'x'.repeat(20_001) }),
    ]
    for (const failure of failures) expect(failure.value).toMatchObject({ ok: false, code: 'invalid-input' })
    expect(failures[0]?.value).toMatchObject({ message: 'x must be between 0 and 100000 CSS pixels.' })
    expect(failures[2]?.value).toMatchObject({ message: 'deltaY must be between -100000 and 100000 CSS pixels.' })
    expect((await run('browser_key', { tabId: 'tab-1', key: 'F5' })).isError).toBe(true)
    expect(requests).toEqual([])
    expect(asked).not.toHaveBeenCalled()
  })
})

describe('call presentation', () => {
  it('titles each pending call from its arguments', () => {
    const projection = {
      stateOf: () => ({ origins: [], calls: [] }),
    } as Partial<ProjectionHandle<GrantState>> as ProjectionHandle<GrantState>
    const ctx = new Context()
    const tools = new Map(browser.browserTools(ctx, new SiteGrants(ctx, projection)).map(tool => [tool.name, tool] as const))
    const present = (name: string, args: unknown) => (tools.get(name) as ToolDefinition).presentCall?.(args)
    expect(present('browser_tabs', {})).toEqual({ card: 'generic', title: 'List browser tabs', kind: 'read' })
    expect(present('browser_open', { url: 'https://a.test' })).toEqual({ card: 'generic', title: 'Open https://a.test', kind: 'fetch' })
    expect(present('browser_navigate', { tabId: 't', url: 'https://a.test' })).toEqual({ card: 'generic', title: 'Go to https://a.test', kind: 'fetch' })
    expect(present('browser_read', { tabId: 't' })).toEqual({ card: 'generic', title: 'Read browser page', kind: 'read' })
    expect(present('browser_screenshot', { tabId: 't' })).toEqual({ card: 'generic', title: 'Screenshot browser page', kind: 'read' })
    expect(present('browser_click', { tabId: 't', x: 1, y: 2 })).toEqual({ card: 'generic', title: 'Click at (1, 2)', kind: 'other' })
    expect(present('browser_type', { tabId: 't', text: 'x' })).toEqual({ card: 'generic', title: 'Type in browser page', kind: 'other' })
    expect(present('browser_key', { tabId: 't', key: 'Enter' })).toEqual({ card: 'generic', title: 'Press Enter', kind: 'other' })
    expect(present('browser_scroll', { tabId: 't', x: 1, y: 2, deltaY: -3 })).toEqual({ card: 'generic', title: 'Scroll up', kind: 'other' })
    expect(present('browser_scroll', { tabId: 't', x: 1, y: 2, deltaY: 3 })).toEqual({ card: 'generic', title: 'Scroll down', kind: 'other' })
    for (const name of ['browser_tabs', 'browser_read', 'browser_screenshot']) expect(tools.get(name)?.isConcurrencySafe?.({ tabId: 't' })).toBe(true)
    expect(Object.keys(tools.get('browser_click') ?? {})).not.toContain('isConcurrencySafe')
  })
})

describe('URL helpers', () => {
  it('derive the web origin of a tab', () => {
    expect(browser.webOrigin('https://shop.test:8443/a?b')).toBe('https://shop.test:8443')
    expect(browser.webOrigin('about:blank')).toBeUndefined()
    expect(browser.webOrigin('nonsense')).toBeUndefined()
    expect(browser.webOrigin(null)).toBeUndefined()
    expect(browser.webUrl('http://a.test')).toBe('http://a.test/')
    expect(browser.KEYS).toContain('Enter')
  })
})
