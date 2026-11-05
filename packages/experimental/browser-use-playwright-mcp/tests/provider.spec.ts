import { existsSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { mountSessionMcp } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import * as Provider from '../src/index.ts'

vi.mock('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp')>(),
  mountSessionMcp: vi.fn(),
}))
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

it('uses the pinned Playwright executable with isolated Chromium launch settings', () => {
  vi.stubEnv('PLAYWRIGHT_MCP_CDP_ENDPOINT', 'http://invalid.example:1')
  Provider.apply(new Context(), Provider.Config({ mode: 'launch', executablePath: '/custom/chromium', toolCallTimeoutMs: 123 }))
  const options = vi.mocked(mountSessionMcp).mock.calls[0]![1]
  expect(existsSync(options.args[0]!)).toBe(true)
  expect(options).toMatchObject({ name: 'playwright-mcp', exclusive: false, command: process.execPath, toolCallTimeoutMs: 123 })
  expect(options.env?.PLAYWRIGHT_MCP_CDP_ENDPOINT).toBe('')
  expect(options.args.slice(1)).toEqual(['--browser', 'chromium', '--isolated', '--headless', '--executable-path', '/custom/chromium'])
  expect('default' in Provider).toBe(false)
})

it('supports headed launch and attaches without launching a browser or creating a profile', () => {
  Provider.apply(new Context(), Provider.Config({ mode: 'launch', headless: false }))
  expect(vi.mocked(mountSessionMcp).mock.calls[0]![1].args.slice(1)).toEqual(['--browser', 'chromium', '--isolated'])
  Provider.apply(new Context(), Provider.Config({ mode: 'attach', endpoint: 'http://127.0.0.1:9222' }))
  const options = vi.mocked(mountSessionMcp).mock.calls[1]![1]
  expect(options.exclusive).toBe(true)
  expect(options.args.slice(1)).toEqual(['--browser', 'chromium', '--cdp-endpoint', 'http://127.0.0.1:9222'])
})

it('connects every live Session separately to the user\'s Chrome through the Playwright Extension', () => {
  vi.stubEnv('PLAYWRIGHT_MCP_BROWSER', 'firefox')
  vi.stubEnv('PLAYWRIGHT_MCP_USER_DATA_DIR', '/unrelated/profile')
  Provider.apply(new Context(), Provider.Config({ mode: 'extension', toolCallTimeoutMs: 456 }))
  const options = vi.mocked(mountSessionMcp).mock.calls[0]![1]
  expect(options).toMatchObject({ name: 'playwright-mcp', exclusive: false, command: process.execPath, toolCallTimeoutMs: 456 })
  expect(options.args.slice(1)).toEqual(['--extension', '--browser', 'chrome'])
  expect(options.env).toMatchObject({ PLAYWRIGHT_MCP_BROWSER: '', PLAYWRIGHT_MCP_USER_DATA_DIR: '' })
  expect(options.env).not.toHaveProperty('PLAYWRIGHT_MCP_EXTENSION_TOKEN')
})

it('forwards the Host\'s extension token only to the extension connection', () => {
  vi.stubEnv('PLAYWRIGHT_MCP_EXTENSION_TOKEN', 'token-from-extension')
  Provider.apply(new Context(), Provider.Config({ mode: 'extension' }))
  Provider.apply(new Context(), Provider.Config({ mode: 'launch' }))
  Provider.apply(new Context(), Provider.Config({ mode: 'attach', endpoint: 'http://127.0.0.1:9222' }))
  const [extension, launch, attach] = vi.mocked(mountSessionMcp).mock.calls.map(call => call[1].env)
  expect(extension?.PLAYWRIGHT_MCP_EXTENSION_TOKEN).toBe('token-from-extension')
  expect(launch?.PLAYWRIGHT_MCP_EXTENSION_TOKEN).toBe('')
  expect(attach?.PLAYWRIGHT_MCP_EXTENSION_TOKEN).toBe('')
})

it('rejects a non-positive extension tool timeout at configuration', () => {
  expect(() => Provider.Config({ mode: 'extension', toolCallTimeoutMs: 0 })).toThrow()
})

it('rejects malformed endpoints before mounting any browser resources', () => {
  expect(() => { Provider.apply(new Context(), Provider.Config({ mode: 'attach', endpoint: 'http://localhost:bad/path' })) }).toThrow('browser endpoint')
  expect(mountSessionMcp).not.toHaveBeenCalled()
})
