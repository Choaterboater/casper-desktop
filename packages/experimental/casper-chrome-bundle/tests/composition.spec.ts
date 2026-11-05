/** The shipped patch rows boot the real Playwright MCP server in extension mode without contacting Chrome. */
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader, { interpolate, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import * as Provider from '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import Llm from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Tools from '@deepseek-ai/dsh-tools'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'

const PROVIDER = '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'

async function patchRows(): Promise<EntryOptions[]> {
  const patch = load(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), {
    schema: entryListSchema,
  }) as { insert: EntryOptions[] }[]
  return patch[0]!.insert
}

it('mounts the browser-use registry and the extension-mode provider, disabled only in a Worker', async () => {
  const rows = await patchRows()
  expect(rows.map(row => row.name)).toEqual(['@deepseek-ai/dsh-browser-use', PROVIDER])
  const provider = rows[1]!
  // The first call in a conversation waits for the user's approval in Chrome, which can take a few minutes.
  expect(provider.config).toMatchObject({ mode: 'extension', toolCallTimeoutMs: 300_000 })
  expect(Provider.Config(provider.config as Provider.Config)).toMatchObject({ mode: 'extension', toolCallTimeoutMs: 300_000 })
  expect(interpolate({}, provider.disabled)).toBe(false)
  expect(interpolate({ WorkerGlobalScope: Object }, provider.disabled)).toBe(true)
})

it('gives each concurrent live Session its own upstream browser tools', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-casper-chrome-'))
  const modules = new Map<string, unknown>([
    ['browserUse', BrowserUse], ['prompt', SystemPrompt], ['tools', Tools], ['toolExecutor', NativeToolExecutor], ['llm', Llm],
    ['sessions', Sessions], ['agents', Agents], ['loop', AgentLoop], ['projections', Projections],
    ['fs', LocalFileSystem], ['workingDirectory', WorkingDirectory],
    ['@deepseek-ai/dsh-browser-use', BrowserUse], [PROVIDER, Provider],
  ])
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    if (!ctx.loader.internal) throw new Error('Loader module importer is unavailable')
    ctx.loader.internal.import = async (specifier: string) => {
      if (!modules.has(specifier)) throw new Error(`Unexpected module ${specifier}`)
      return modules.get(specifier)
    }
    for (const name of ['prompt', 'tools', 'toolExecutor', 'llm', 'sessions', 'agents', 'loop', 'projections', 'fs', 'workingDirectory']) {
      await ctx.loader.create({ name, config: name === 'loop' ? { agents: [] } : {} })
    }
    for (const row of await patchRows()) {
      await ctx.loader.create({ ...row, disabled: Boolean(interpolate({}, row.disabled)) })
    }
    await ctx.loader.await()

    // Creating an Agent starts the pinned server with --extension and lists its tools; no tool call reaches Chrome.
    const owner = await ctx.agents.create({ sessionId: SessionId('casper-chrome-owner'), meta: { cwd: root } })
    await owner.agent.whenIdle()
    const names = ctx.tools.schemas(owner.agent).map(tool => tool.name)
    expect(names).toEqual(expect.arrayContaining([
      'mcp__playwright-mcp__browser_navigate', 'mcp__playwright-mcp__browser_snapshot', 'mcp__playwright-mcp__browser_click',
    ]))

    const other = await ctx.agents.create({ sessionId: SessionId('casper-chrome-other'), meta: { cwd: root } })
    await other.agent.whenIdle()
    expect(ctx.tools.schemas(other.agent).map(tool => tool.name)).toEqual(expect.arrayContaining(names))
    expect(ctx.tools.get('mcp__playwright-mcp__browser_navigate', other.agent))
      .not.toBe(ctx.tools.get('mcp__playwright-mcp__browser_navigate', owner.agent))

    await other.dispose()
    await owner.dispose()
    expect(ctx.tools.schemas(owner.agent)).toEqual([])
    expect(ctx.tools.schemas(other.agent)).toEqual([])
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
