/**
 * The shipped casper preset rows give a Casper Session the app's real plugin tools: the bridge serves the
 * Cordis inspection, skill, present and plugin_manager tools those rows bind in the Casper Agent's scope, a
 * bridged install asks once, through the app's own approval, on the app's existing plugin manager, and a bridged
 * present records the delivery the app's file card reads in the Casper turn.
 */

import { writeFileSync } from 'node:fs'
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
import * as ToolPresent from '../../../deliverables/tool-present/src/index.ts'
import * as ToolCordis from '../../../extensions/tool-cordis/src/index.ts'
import SandboxPolicy from '../../../sandbox/sandbox-policy/src/index.ts'
import * as SkillFilesystem from '../../../skill/skill-filesystem/src/index.ts'
import * as ToolSkill from '../../../skill/tool-skill/src/index.ts'
import * as CasperAgentPlugin from '../src/index.ts'
import { CasperAgent } from '../src/agent.ts'
import { PLUGIN_SKILL, TURN_OVER } from '../src/app-tools.ts'
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
    '@deepseek-ai/dsh-tool-present': ToolPresent,
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

/** Connect to the app tools server a Casper Session offered, as Casper's MCP client does. */
async function appClient(fake: FakeCasper): Promise<Client> {
  const entry = await waitFor(() => fake.log().find(logged => logged.method === 'session/new'))
  const [server] = (entry.params?.['mcpServers'] ?? []) as { url: string; headers: { name: string; value: string }[] }[]
  if (server === undefined) throw new Error('no app server offered')
  const client = new Client({ name: 'casper-test', version: '0.0.0' })
  const headers = Object.fromEntries(server.headers.map(header => [header.name, header.value]))
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }) as Transport)
  cleanups.push(() => client.close())
  return client
}

/** Casper's stop words for find_capability's word search (Casper's src/capabilities/search.ts). */
const STOP_WORDS = new Set(['the', 'a', 'an', 'to', 'of', 'for', 'and', 'in', 'with', 'please', 'tool', 'tools', 'read', 'get', 'show', 'use'])

/** Casper's `tokenize`: lowercase runs of 2+ letters or digits, stop words left out, each once. */
function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 1 && !STOP_WORDS.has(word)))]
}

/** Casper's `termVariants`: the word and its likely singulars. */
function variants(word: string): string[] {
  const forms = new Set([word])
  if (word.length > 4 && word.endsWith('ies')) forms.add(`${word.slice(0, -3)}y`)
  if (word.length > 3 && word.endsWith('es')) forms.add(word.slice(0, -2))
  if (word.length >= 3 && word.endsWith('s') && !word.endsWith('ss')) forms.add(word.slice(0, -1))
  return [...forms]
}

/** Casper's `indexWords`: every variant of every word. */
function indexWords(text: string): Set<string> {
  return new Set(tokenize(text).flatMap(variants))
}

/**
 * The ids find_capability returns for a query, best first, scored as Casper's search scores them: 4 for a word
 * of the tool's name or server, 2 for a 5+ letter word that starts a name word, 1 for a description word.
 */
function findCapability(query: string, server: string, tools: readonly { name: string; description?: string | undefined }[]): string[] {
  const scored = tools.map((tool) => {
    const name = indexWords(`${tool.name} ${server}`)
    const description = indexWords(tool.description ?? '')
    const score = tokenize(query).reduce((sum, term) => {
      if (variants(term).some(form => name.has(form))) return sum + 4
      if (term.length >= 5 && [...name].some(word => word.length > term.length && word.startsWith(term))) return sum + 2
      return sum + (variants(term).some(form => description.has(form)) ? 1 : 0)
    }, 0)
    return { id: `mcp:${server}:${tool.name}`, score }
  })
  return scored.filter(entry => entry.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map(entry => entry.id)
}

it('lists all six app tools, then the resource tools, to Casper from the preset rows', { timeout: 60_000 }, async () => {
  const fake = fakeCasper({ prompts: [[]] })
  cleanups.push(() => { fake.remove() })
  const { create } = await host(fake)
  const agent = await create('casper-preset-list')
  agent.followup(prompt('hi'))
  await agent.whenIdle()
  const client = await appClient(fake)
  // No tool drops out silently: each preset row resolved its tool in the Agent's scope.
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([
    'app_skill', 'plugin_manager', 'app_read_file', 'present', 'cordis_inspect_query', 'cordis_inspect_list',
    'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  ])
})

it('present is in the preset list, after the plugin manager', () => {
  const ids = presetRows().map(row => (row as { id?: unknown }).id)
  expect(presetRows()).toContainEqual({ id: 'present', name: '@deepseek-ai/dsh-tool-present' })
  expect(ids.indexOf('present')).toBe(ids.indexOf('tool-plugin-manager') + 1)
})

it('find_capability for present the report file returns acp-app present', { timeout: 60_000 }, async () => {
  const fake = fakeCasper({ prompts: [[]] })
  cleanups.push(() => { fake.remove() })
  const { create } = await host(fake)
  const agent = await create('casper-preset-find')
  agent.followup(prompt('hi'))
  await agent.whenIdle()
  const { tools } = await (await appClient(fake)).listTools()
  // The real present row's name and description, searched as Casper searches when present is not pinned.
  expect(findCapability('present the report file', 'acp-app', tools)[0]).toBe('mcp:acp-app:present')
})

/** The arguments of a present call for the report file, as the model writes them. */
const PRESENT_ARGS = { files: [{ path: 'report.md', description: 'The report' }] }

/** A current Casper's step for the bridged present call. */
const PRESENT_STEP = { tool: 'present', target: 'report.md', rawInput: PRESENT_ARGS, meta: { tool: 'mcp', mcp: { server: 'acp-app', tool: 'present' } } }

it('a bridged present call shows a file card in the Casper turn', { timeout: 60_000 }, async () => {
  const fake = fakeCasper({ prompts: [[PRESENT_STEP, { mcp: 'present', args: PRESENT_ARGS }, { toolEnd: 1 }]] })
  cleanups.push(() => { fake.remove() })
  writeFileSync(join(fake.cwd, 'report.md'), '# Report\n')
  const { create, seen } = await host(fake)
  const agent = await create('casper-preset-present')
  agent.followup(prompt('write the report and hand it to me'))
  await agent.whenIdle()
  // A file inside the workspace is shown with no ask.
  expect(seen.approvals).toEqual([])

  const [present] = results(fake.log())
  expect(present?.name).toBe('present')
  expect(present?.result).toMatchObject({ isError: false })
  const report = join(fake.cwd, 'report.md')
  expect(JSON.stringify(present?.result)).toContain(`Presented ${report}`)
  // The step is recorded as the app's present call, so Standard's present card draws it with the app's own result.
  const events = eventsOf(agent)
  const ids = callIds(agent)
  expect(events.flatMap(event => event.type === 'tool/call' ? [event.data.name] : [])).toEqual(['present'])
  // ui-deliverables draws a file card for each deliverables/presented event of a turn: this one names the Casper turn and step.
  const [turn] = events.flatMap(event => event.type === 'turn/start' ? [event.data.turn] : [])
  const presented = events.flatMap(event => event.type === 'deliverables/presented' ? [event.data] : [])
  expect(presented).toEqual([{ turn, callId: ids[0], files: [{ path: report, description: 'The report' }] }])
  expect(turn).toBe(1)
})

it('a bridged present call for a file outside the workspace asks the app\'s approval as the Casper Agent first', { timeout: 60_000 }, async () => {
  const args = { files: [{ path: '../outside.md' }] }
  const step = { ...PRESENT_STEP, target: '../outside.md', rawInput: args }
  const fake = fakeCasper({ prompts: [[step, { mcp: 'present', args }, { toolEnd: 1 }]] })
  cleanups.push(() => { fake.remove() })
  writeFileSync(join(fake.root, 'outside.md'), '# Outside\n')
  const { create, seen, asked } = await host(fake)
  const agent = await create('casper-preset-present-outside')
  agent.followup(prompt('hand me the file beside the project'))
  await agent.whenIdle()

  // The app's own approval card asked once, under the call id of the Casper step; Casper's question box never opened.
  expect(seen.approvals).toEqual([{ agent, callId: callIds(agent)[0], toolName: 'present' }])
  expect(asked).toEqual([])
  // The stand-in allowed it, so the file card shows the file.
  const [present] = results(fake.log())
  expect(present?.result).toMatchObject({ isError: false })
  const presented = eventsOf(agent).flatMap(event => event.type === 'deliverables/presented' ? [event.data.files] : [])
  expect(presented).toEqual([[{ path: join(fake.root, 'outside.md') }]])
})

it('a present call after the turn ended returns TURN_OVER and appends nothing', { timeout: 60_000 }, async () => {
  const fake = fakeCasper({ prompts: [[{ late: { mcp: 'present', args: PRESENT_ARGS } }]] })
  cleanups.push(() => { fake.remove() })
  writeFileSync(join(fake.cwd, 'report.md'), '# Report\n')
  const { create } = await host(fake)
  const agent = await create('casper-preset-present-late')
  agent.followup(prompt('go'))
  await agent.whenIdle()
  const late = await waitFor(() => fake.log().find(entry => entry.event === 'mcp'))
  expect(late.result).toEqual({ content: [{ type: 'text', text: TURN_OVER }], isError: true })
  expect(eventsOf(agent).filter(event => event.type === 'deliverables/presented' || event.type === 'tool/call')).toEqual([])
})
