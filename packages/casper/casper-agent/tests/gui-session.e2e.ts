/**
 * A GUI Session on the Casper preset through the real Session Controller,
 * the real preset registry, and the stand-in `casper acp`. Keyless: no model
 * is called.
 */

import { Buffer } from 'node:buffer'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import type { SessionFollowFrame, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { createSessionTestRemote } from '../../../api/session-controller/tests/test-remote.ts'
import * as CasperAgentPlugin from '../src/index.ts'
import { CasperAgent } from '../src/agent.ts'
import { alive, fakeCasper, waitFor } from './support.ts'
import type { FakeCasper } from './support.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * Boot the Desktop-shaped Host: Casper is the default preset, Standard runs on agent-loop.
 * @param fake - the stand-in Casper.
 * @param mount - mounts further services, such as the attachment store, before the Session Controller.
 */
async function host(fake: FakeCasper, mount?: (ctx: Context) => Promise<void>) {
  const ctx = new Context()
  const asked: AskUserQuestionRequest[] = []
  const statuses: [SessionId, boolean][] = []
  ctx.baseUrl = pathToFileURL(fake.root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  ctx.loader.internal = {
    version: 'v2',
    import(specifier: string) {
      if (specifier !== '@deepseek-ai/dsh-tool-todo') return Promise.reject(new Error(`unexpected plugin ${specifier}`))
      return Promise.resolve(ToolTodo)
    },
  } as never
  await ctx.plugin(TypertRegistry)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(fake.root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(fake.root, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentPresetRegistry, { default: 'casper' })
  await ctx.plugin({
    inject: ['agentPresets'],
    async* apply(child: Context) {
      yield await child.agentPresets.register({ id: 'standard', plugins: [] })
      yield await child.agentPresets.register({ id: 'casper', name: 'Casper', plugins: [{ id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } }] })
    },
  })
  await ctx.plugin({
    name: 'test-browser',
    apply(inner: Context) {
      inner.on('user-questions/request', (request) => {
        asked.push(request)
        return Promise.resolve({ answers: [{ id: request.questions[0]?.id ?? '', selected: ['Yes, this once'] }] })
      })
      inner.on('api-session/status', (sessionId, running) => { statuses.push([sessionId, running]) })
    },
  })
  await ctx.plugin(CasperAgentPlugin, fake.config())
  await mount?.(ctx)
  // No Workspaces: a named blank Session is reused by identity alone.
  ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [], archivedSessionIds: [] } as never)
  const remote = await createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }), cwd: fake.cwd })
  return { ctx, remote, asked, statuses }
}

function ok<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function events(agent: Agent | undefined): readonly SessionEvent[] {
  return agent?.session.snapshotEvents() ?? []
}

it('runs a Casper Session from the GUI: stream, tools, approval, plan, receipt, stop, preset switch, and relaunch', async () => {
  const fake = fakeCasper({
    prompts: [
      [
        { text: 'Looking at the project.\n' },
        { tool: 'bash', target: 'npm test' },
        { toolEnd: 1 },
        { permission: 'Write outside the project?', preview: '/elsewhere/notes.txt' },
        { check: 'test', status: 'pass' },
        { plan: [{ content: 'Do the task', status: 'completed' }, { content: 'Run the project\'s checks', status: 'completed' }] },
      ],
      [{ text: 'Working.\n' }, { hang: true }],
      [{ text: 'You asked me to fix the bug.\n' }],
    ],
    newSessionId: 'conversation-gui',
  })
  cleanups.push(() => { fake.remove() })
  const first = await host(fake)
  let firstDisposed = false
  cleanups.push(() => firstDisposed ? undefined : first.ctx.fiber.dispose())

  // A new Session with no named preset runs the Desktop default, Casper.
  const created = ok(await first.remote.create({ cwd: fake.cwd }))
  expect(created.agentPreset).toBe('casper')
  const sessionId = created.sessionId
  const agent = first.ctx.agents.get(sessionId)
  expect(agent).toBeInstanceOf(CasperAgent)
  expect(fake.pids()).toEqual([])

  const follow = new AbortController()
  const frames: SessionFollowFrame[] = []
  const following = (async () => {
    for await (const frame of first.remote.follow({ address: { kind: 'session', sessionId }, assistantStream: true }, follow.signal)) frames.push(frame)
  })().catch(() => {
    // The follow ends when the test aborts it.
  })

  ok(await first.remote.prompt({ requestId: 'req-fix' as SessionRequestId, sessionId, mode: 'queue', content: [{ type: 'text', text: 'Fix the bug' }] }))
  await waitFor(() => events(agent).some(event => event.type === 'turn/end'))
  await agent?.whenIdle()
  const types = events(agent).map(event => event.type).filter(type => !type.startsWith('agent/inbox') && type !== 'agent-preset/selected')
  expect(types).toEqual([
    'turn/start', 'step/start', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'step/end',
    'step/start', 'assistant/message', 'tool/call', 'tool/result', 'step/end',
    'step/start', 'assistant/message', 'tool/call', 'tool/result', 'todo/write', 'step/end',
    'step/start', 'assistant/message', 'step/end',
    'turn/end',
  ])
  const user = events(agent).find(event => event.type === 'user/message')
  expect(user?.type === 'user/message' && user.data.source).toMatchObject({ kind: 'user', rpcId: 'req-fix' })
  expect(events(agent).at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  expect(fake.log().filter(entry => entry.event === 'answer').map(entry => entry.outcome)).toEqual([{ outcome: 'selected', optionId: '2' }])
  expect(first.asked[0]?.questions[0]?.options?.map(option => option.label)).toEqual(['No', 'Yes, this once', 'Yes for this session'])
  expect(first.statuses.filter(([id]) => id === sessionId).map(([, running]) => running)).toEqual([true, false])
  await waitFor(() => frames.some(frame => frame.type === 'assistant-stream' && frame.frame.type === 'end'))
  const settled = new Set<number>(events(agent).filter(event => event.type === 'assistant/message').map(event => event.seq))
  const ends = frames.flatMap(frame => frame.type === 'assistant-stream' && frame.frame.type === 'end' ? [frame.frame.outcome] : [])
  expect(ends.length).toBeGreaterThan(0)
  for (const outcome of ends) expect(outcome.kind === 'committed' && settled.has(outcome.seq)).toBe(true)

  // Stop cancels the running prompt.
  ok(await first.remote.prompt({ requestId: 'req-long' as SessionRequestId, sessionId, mode: 'queue', content: [{ type: 'text', text: 'Do a long task' }] }))
  await waitFor(() => fake.calls('session/prompt').length === 2)
  ok(await first.remote.cancel({ sessionId }))
  await waitFor(() => events(agent).filter(event => event.type === 'turn/end').length === 2)
  expect(events(agent).at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  expect(fake.calls('session/cancel')).toHaveLength(1)
  follow.abort()
  await following

  // The mode picker cannot move a blank Casper Session onto agent-loop; a new Session takes the pick.
  const blank = ok(await first.remote.create({ cwd: fake.cwd }))
  const blankAgent = first.ctx.agents.get(blank.sessionId)
  if (blankAgent === undefined) throw new Error('blank Session has no Agent')
  await expect(first.ctx.agentPresets.select(blankAgent, 'standard')).rejects.toMatchObject({ code: 'agent-preset/locked', details: { newSession: true } })
  const switched = ok(await first.remote.create({ sessionId: blank.sessionId, cwd: fake.cwd, agentPreset: 'standard' }))
  expect(switched.sessionId).not.toBe(blank.sessionId)
  expect(switched.agentPreset).toBe('standard')
  expect(first.ctx.agents.get(switched.sessionId)).not.toBeInstanceOf(CasperAgent)
  expect(first.ctx.agents.get(blank.sessionId)).toBe(blankAgent)
  expect(fake.pids()).toHaveLength(1)

  // After a relaunch the first Session continues Casper's conversation.
  const [oldPid] = fake.pids()
  await first.ctx.fiber.dispose()
  firstDisposed = true
  expect(alive(oldPid ?? 0)).toBe(false)
  const second = await host(fake)
  cleanups.push(() => second.ctx.fiber.dispose())
  ok(await second.remote.prompt({ requestId: 'req-again' as SessionRequestId, sessionId, mode: 'queue', content: [{ type: 'text', text: 'What did I ask?' }] }))
  const resumed = second.ctx.agents.get(sessionId)
  expect(resumed).toBeInstanceOf(CasperAgent)
  await waitFor(() => events(resumed).filter(event => event.type === 'turn/end').length === 3)
  expect(fake.calls('session/load').map(entry => entry.params?.sessionId)).toEqual(['conversation-gui'])
  expect(events(resumed).at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
}, 120_000)

/** A 1x1 PNG, as the composer sends a pasted picture. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

it('sends a picture and an uploaded file from the GUI to Casper through the real controller and attachment store', async () => {
  const fake = fakeCasper({ prompts: [[{ text: 'It is blue.\n' }]], promptCapabilities: { image: true } })
  cleanups.push(() => { fake.remove() })
  const receipts = new Map<string, { readonly type: 'file'; readonly attachment: FileAttachmentRef }>()
  const booted = await host(fake, async (ctx) => {
    await ctx.plugin(LocalAttachmentStore, { dshHome: join(fake.root, 'dsh') })
    // The upload service stages files the real store saved; the controller resolves and admits them.
    ctx.provide('fileUploads', {
      registerAgentResolver: () => () => {},
      resolve: (_agent: Agent, receiptId: string) => receipts.get(receiptId),
      bindPrompt: () => ({ commit: () => {}, [Symbol.dispose]: () => {} }),
      retirePrompt: () => {},
    } as never)
  })
  cleanups.push(() => booted.ctx.fiber.dispose())
  const notes = await booted.ctx.attachments.admitEncodedFile({ data: Buffer.from('the notes\n').toString('base64'), name: 'notes.txt' })
  receipts.set('receipt-notes', { type: 'file', attachment: notes })

  const { sessionId } = ok(await booted.remote.create({ cwd: fake.cwd }))
  const agent = booted.ctx.agents.get(sessionId)
  ok(await booted.remote.prompt({
    requestId: 'req-picture' as SessionRequestId, sessionId, mode: 'queue',
    content: [
      { type: 'text', text: 'What colour?' },
      { type: 'image', mediaType: 'image/png', data: PNG },
      { type: 'file', receiptId: 'receipt-notes' as never },
    ],
  }))
  const sent = await waitFor(() => fake.calls('session/prompt')[0]?.params?.prompt as { type: string; mimeType?: string; data?: string; uri?: string; name?: string }[] | undefined)
  await waitFor(() => events(agent).some(event => event.type === 'turn/end'))
  expect(events(agent).at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  expect(sent.map(block => block.type)).toEqual(['text', 'image', 'resource_link'])
  const user = events(agent).find(event => event.type === 'user/message')
  const picture = user?.type === 'user/message' ? user.data.content.find(block => block.type === 'image') : undefined
  if (picture?.type !== 'image') throw new Error('the picture was not recorded')
  // The image block holds the bytes the store kept for the recorded picture.
  const stored = await booted.ctx.attachments.readImage(picture.attachment)
  expect(sent[1]).toEqual({ type: 'image', mimeType: stored.ref.mediaType, data: Buffer.from(stored.data).toString('base64') })
  // The link names the store's own copy of the uploaded file.
  expect(sent[2]).toMatchObject({ type: 'resource_link', name: 'notes.txt' })
  const linked = fileURLToPath(sent[2]?.uri ?? '')
  expect(existsSync(linked)).toBe(true)
  expect(readFileSync(linked, 'utf8')).toBe('the notes\n')
}, 120_000)
