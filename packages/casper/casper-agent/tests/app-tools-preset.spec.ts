/**
 * The shipped casper preset rows give a Casper Session the app's real plugin tools: the bridge serves the
 * Cordis inspection, skill and plugin_manager tools those rows bind in the Casper Agent's scope, and a
 * bridged install asks once, through the app's own approval, on the app's existing plugin manager.
 */

import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
// The preset's other rows, imported from their sources as the Loader would load their packages.
import * as PluginManagerTools from '../../../boot/plugin-manager/src/tools.ts'
import * as ToolCordis from '../../../extensions/tool-cordis/src/index.ts'
import SandboxPolicy from '../../../sandbox/sandbox-policy/src/index.ts'
import * as SkillFilesystem from '../../../skill/skill-filesystem/src/index.ts'
import * as ToolSkill from '../../../skill/tool-skill/src/index.ts'
import * as CasperAgentPlugin from '../src/index.ts'
import { CasperAgent } from '../src/agent.ts'
import { PLUGIN_SKILL } from '../src/app-tools.ts'
import { prompt, eventsOf } from './harness.ts'
import { fakeCasper, waitFor } from './support.ts'
import type { FakeCasper, FakeLogEntry, FakeScript } from './support.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** The shipped preset file, relative to this test. */
const PRESET_FILE = fileURLToPath(new URL('../../../bundle/web-app/presets/casper.patch.yml', import.meta.url))
/** The web-app bundle's manifest: the preset's `!!js` paths resolve from it, as from an installed app. */
const WEB_APP_MANIFEST = new URL('../../../bundle/web-app/package.json', import.meta.url).href
/** A bundle the app's plugin manager does not offer. */
const HIDDEN = '@deepseek-ai/dsh-experimental-plugin-market-bundle'

/** The plugin rows of the shipped `preset-casper` declaration, `!!js` values left for the Loader. */
function presetRows(): unknown[] {
  const [patch] = loadOverlayPatches('casper-agent test', PRESET_FILE) as { insert?: { id?: string; config?: { plugins?: unknown[] } }[] }[]
  const row = patch?.insert?.find(entry => entry.id === 'preset-casper')
  if (row?.config?.plugins === undefined) throw new Error('the casper preset declares no plugins')
  return row.config.plugins
}

/** What the app's stand-in services saw. */
interface Seen {
  readonly approvals: { agent: unknown; callId: unknown; toolName: string }[]
  readonly installs: string[]
  readonly queries: unknown[]
}

/** Boot a Desktop-shaped Host whose casper preset is the shipped rows, with stand-ins for the app's own services. */
async function host(fake: FakeCasper) {
  const ctx = new Context()
  const asked: AskUserQuestionRequest[] = []
  const seen: Seen = { approvals: [], installs: [], queries: [] }
  ctx.baseUrl = WEB_APP_MANIFEST
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  const modules: Record<string, unknown> = {
    '@deepseek-ai/dsh-tool-todo': ToolTodo,
    '@deepseek-ai/dsh-tool-cordis': ToolCordis,
    '@deepseek-ai/dsh-skill-filesystem': SkillFilesystem,
    '@deepseek-ai/dsh-tool-skill': ToolSkill,
    '@deepseek-ai/dsh-plugin-manager/tools': PluginManagerTools,
  }
  ctx.loader.internal = {
    version: 'v2',
    import(specifier: string) {
      return specifier in modules ? Promise.resolve(modules[specifier]) : Promise.reject(new Error(`unexpected plugin ${specifier}`))
    },
  } as never
  await ctx.plugin(TypertRegistry)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(JsonlSessionPersistence, { root: join(fake.root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(fake.root, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: fake.cwd })
  const dir = join(fake.root, 'profiles', 'desktop')
  ctx.provide('profileContext', {
    name: 'desktop', dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(fake.root, 'package.json'), cwd: fake.cwd, home: fake.root,
    startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  } as never)
  // The app's own services: its approval card, its one plugin manager (which refuses a hidden bundle), its inspection.
  ctx.provide('approval', {
    request: (request: { agent: unknown; callId: unknown; toolName: string }) => {
      seen.approvals.push({ agent: request.agent, callId: request.callId, toolName: request.toolName })
      return Promise.resolve('allowed-once')
    },
  } as never)
  ctx.provide('pluginManager', {
    installBundle: (spec: string) => {
      seen.installs.push(spec)
      return Promise.resolve(spec === HIDDEN
        ? { changed: false, application: 'failed', error: { code: 'not-offered' } }
        : { changed: true, application: 'applied' })
    },
  } as never)
  ctx.provide('cordisInspect', {
    list: () => [{ platform: 'client', provider: 'Slots', methods: ['listSubTree'] }],
    query: (...args: unknown[]) => { seen.queries.push(args.slice(0, 3)); return Promise.resolve({ slots: ['main', 'sidebar.panellist'] }) },
  } as never)
  await ctx.plugin(AgentPresetRegistry, { default: 'casper' })
  await ctx.plugin({
    inject: ['agentPresets'],
    async* apply(child: Context) {
      yield await child.agentPresets.register({ id: 'casper', name: 'Casper', plugins: presetRows() as never })
    },
  })
  await ctx.plugin({
    name: 'test-answerer',
    apply(inner: Context) {
      inner.on('user-questions/request', (request) => {
        asked.push(request)
        return Promise.resolve({ answers: [{ id: request.questions[0]?.id ?? '', selected: ['Yes, this once'] }] })
      })
    },
  })
  await ctx.plugin(CasperAgentPlugin, fake.config({ appTools: true }))
  cleanups.push(() => ctx.fiber.dispose())
  // As the Session Controller does: the preset mounts into the new Agent's scope before it is published.
  const create = async (id: string): Promise<Agent> => (await ctx.agents.create({
    sessionId: SessionId(id), meta: { cwd: fake.cwd, agentPreset: 'casper' },
    setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'casper') },
  })).agent
  return { ctx, asked, seen, create }
}

/** The MCP results the stand-in Casper logged, in call order. */
function results(log: FakeLogEntry[]): { name: unknown; result: unknown }[] {
  return log.filter(entry => entry.event === 'mcp').map(entry => ({ name: entry.name, result: entry.result }))
}

/** The `tool/call` ids the Session recorded for Casper's steps, in order. */
function callIds(agent: Agent): unknown[] {
  return eventsOf(agent).flatMap(event => event.type === 'tool/call' ? [event.data.callId] : [])
}

it('serves the preset\'s real tools, and a bridged install asks once through the app\'s approval as the Casper Agent', { timeout: 60_000 }, async () => {
  const script: FakeScript = { prompts: [[
    { tool: 'app_skill', target: PLUGIN_SKILL },
    { mcp: 'app_skill', args: { name: PLUGIN_SKILL } },
    { toolEnd: 1 },
    { tool: 'cordis_inspect_query', target: 'Slots' },
    { mcp: 'cordis_inspect_query', args: { platform: 'client', provider: 'Slots', method: 'listSubTree' } },
    { toolEnd: 2 },
    { tool: 'plugin_manager', target: 'install' },
    { mcp: 'plugin_manager', args: { action: 'install_bundle', target: '/work/bundle' } },
    { toolEnd: 3 },
    { tool: 'plugin_manager', target: 'install hidden' },
    { mcp: 'plugin_manager', args: { action: 'install_bundle', target: HIDDEN } },
    { toolEnd: 4 },
  ]] }
  const fake = fakeCasper(script)
  cleanups.push(() => { fake.remove() })
  const { ctx, asked, seen, create } = await host(fake)
  const agent = await create('casper-preset-tools')
  expect(agent).toBeInstanceOf(CasperAgent)
  // The rows bind in the Casper Agent's own scope, not the Host's.
  const scoped = ctx.tools.schemas(agent).map(schema => schema.name)
  for (const name of ['todo_write', 'cordis_inspect_list', 'cordis_inspect_query', 'skill', 'plugin_manager']) expect(scoped).toContain(name)
  agent.followup(prompt('build a left panel plugin'))
  await agent.whenIdle()

  const [skill, query, install, hidden] = results(fake.log())
  expect(skill?.name).toBe('app_skill')
  const skillText = JSON.stringify(skill?.result)
  expect(skillText).toContain('In Casper mode')
  // The real skill body, read from the agent-preset skills folder the preset row names.
  expect(skillText).toContain('plugin_manager')
  expect(skillText).toContain('install_bundle')
  expect(query?.result).toMatchObject({ isError: false })
  expect(JSON.stringify(query?.result)).toContain('sidebar.panellist')
  expect(seen.queries).toEqual([['client', 'Slots', 'listSubTree']])

  // Each install asked the app's approval once, as the Casper Agent, under the call id of the Casper step.
  const ids = callIds(agent)
  expect(seen.approvals).toEqual([
    { agent, callId: ids[2], toolName: 'plugin_manager' },
    { agent, callId: ids[3], toolName: 'plugin_manager' },
  ])
  expect(ids[2]).toMatch(/^casper:[0-9a-f]{8}:casper-tool-3$/)
  // The installs reached the app's one plugin manager service, and Casper's own question box never opened.
  expect(seen.installs).toEqual(['/work/bundle', HIDDEN])
  expect(asked).toEqual([])
  expect(install?.result).toMatchObject({ isError: false })
  expect(JSON.stringify(install?.result)).toContain('applied')
  // The manager's refusal of a bundle it hides reaches Casper with its next step.
  expect(JSON.stringify(hidden?.result)).toContain('not-offered')
  expect(JSON.stringify(hidden?.result)).toContain('does not offer that bundle')
})

it('lists all five app tools to Casper from the preset rows', { timeout: 60_000 }, async () => {
  const fake = fakeCasper({ prompts: [[]] })
  cleanups.push(() => { fake.remove() })
  const { create } = await host(fake)
  const agent = await create('casper-preset-list')
  agent.followup(prompt('hi'))
  await agent.whenIdle()
  const entry = await waitFor(() => fake.log().find(logged => logged.method === 'session/new'))
  const [server] = (entry.params?.['mcpServers'] ?? []) as { url: string; headers: { name: string; value: string }[] }[]
  if (server === undefined) throw new Error('no app server offered')
  const client = new Client({ name: 'casper-test', version: '0.0.0' })
  const headers = Object.fromEntries(server.headers.map(header => [header.name, header.value]))
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }) as Transport)
  cleanups.push(() => client.close())
  // No tool drops out silently: each preset row resolved its tool in the Agent's scope.
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['app_skill', 'plugin_manager', 'app_read_file', 'cordis_inspect_query', 'cordis_inspect_list'])
})
