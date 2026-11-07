import { afterEach, describe, expect, it, vi } from 'vitest'
import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime, { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import AttachmentStore, { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { FileAttachmentRef, ImageAttachmentLimits, ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SessionReferenceResolver, { encodeSessionReferenceUri, formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'
import { planProjectionDefinition } from '@deepseek-ai/dsh-plan-mode'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { contextPressureProjectionDefinition, tokenUsageProjectionDefinition } from '@deepseek-ai/dsh-token-meter/src/usage-projection.ts'
import { CasperAgent, FRESH_CONVERSATION_NOTICE } from '../src/agent.ts'
import { CasperCommandCache } from '../src/commands.ts'
import { CasperConnection } from '../src/connection.ts'
import { reportOf } from '../src/models.ts'
import { CasperModelsCache } from '../src/models-cache.ts'
import { FORK_UNSUPPORTED } from '../src/factory.ts'
import type { ForwardEntry } from '../src/forward-servers.ts'
import { MAX_EMBEDDED_REFERENCE_BYTES, TEXT_ONLY_PICTURE } from '../src/prompt.ts'
import { boot, eventsOf, filesText, mountPermissionPresets, prompt, turnEnds } from './harness.ts'
import { alive, casperModes, casperOptions, fakeCasper, gate, optionsWithoutMode, parsed, waitFor, withPlan } from './support.ts'
import type { FakeCasper, FakeCommand, FakeScript } from './support.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Overrides = Parameters<typeof boot>[1]
type Answer = Parameters<typeof boot>[2]

async function setup(script: FakeScript, overrides: Overrides = {}, answer?: Answer, questions = true) {
  const fake = fakeCasper(script)
  cleanups.push(() => { fake.remove() })
  const host = await boot(fake, overrides, answer, questions)
  cleanups.push(() => host.ctx.fiber.dispose())
  return { fake, host }
}

/** Picture bytes the stand-in attachment store returns. */
const PICTURE_BYTES = Uint8Array.of(137, 80, 78, 71)
const PICTURE: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png', bytes: 4, width: 1, height: 1, name: 'shot.png',
}
const NOTES: FileAttachmentRef = { attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`), name: 'notes.txt', bytes: 2048 }
/** A file the stand-in store has no host copy of. */
const UNSAVED: FileAttachmentRef = { attachmentId: AttachmentId(`sha256:${'c'.repeat(64)}`), name: 'gone.txt', bytes: 1 }
const NOTES_HOST_PATH = join('/attachments', 'files', 'notes.txt')

/** An attachment store that returns fixed picture bytes and keeps only `notes.txt` on the host. */
class StandInAttachments extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 16, maxImagesPerMessage: 4, maxMessageImageBytes: 64, maxImagePixels: 4, maxImageDimension: 4, mediaTypes: ['image/png'],
  }

  validateImage(): Promise<void> {
    return Promise.resolve()
  }

  saveImage(): Promise<ImageAttachmentRef> {
    return Promise.resolve(PICTURE)
  }

  readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    return Promise.resolve({ ref, data: PICTURE_BYTES })
  }

  override fileHostPath(ref: FileAttachmentRef): string | undefined {
    return ref.name === NOTES.name ? NOTES_HOST_PATH : undefined
  }
}

/** A stand-in store whose picture read ignores the turn's signal and finishes only on `release`. */
function heldPictureStore() {
  const read = Promise.withResolvers<undefined>()
  const state = { reading: false }
  class HeldAttachments extends StandInAttachments {
    override async readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
      state.reading = true
      await read.promise
      return { ref, data: PICTURE_BYTES }
    }
  }
  return { store: HeldAttachments, reading: () => state.reading, release: () => { read.resolve(undefined) } }
}

async function setupWithAttachments(script: FakeScript, store: typeof StandInAttachments = StandInAttachments) {
  const fake = fakeCasper(script)
  cleanups.push(() => { fake.remove() })
  const host = await boot(fake, {}, undefined, true, async (ctx) => { await ctx.plugin(store) })
  cleanups.push(() => host.ctx.fiber.dispose())
  return { fake, host }
}

async function run(agent: Agent, text: string): Promise<void> {
  agent.followup(prompt(text))
  await agent.whenIdle()
}

function types(agent: Agent): string[] {
  return eventsOf(agent).map(event => event.type).filter(type => !type.startsWith('agent/inbox'))
}

function promptTexts(fake: FakeCasper): string[] {
  return fake.calls('session/prompt').map(entry => (entry.params?.prompt as { text: string }[]).map(block => block.text).join('|'))
}

describe('CasperAgent', { timeout: 60_000 }, () => {
  it('runs a prompt as one turn: user message, Casper steps, receipt, and status', async () => {
    const { fake, host } = await setup({ prompts: [[
      { text: 'Reading.\n' },
      { tool: 'read', target: 'README.md' },
      { toolEnd: 1 },
      { check: 'test', status: 'pass' },
      { plan: [{ content: 'Do the task', status: 'completed' }] },
      { text: 'Done.\n' },
    ]] })
    const { agent } = await host.create('casper-run')
    expect(agent).toBeInstanceOf(CasperAgent)
    expect(fake.pids()).toEqual([])
    const message = prompt('Fix the bug', 'rpc-fix')
    agent.followup(message)
    expect(agent.status).toBe('running')
    await agent.whenIdle()
    expect(agent.status).toBe('idle')
    expect(types(agent)).toEqual([
      'plugin:casper-agent/models', 'turn/start', 'step/start', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'step/end',
      'step/start', 'assistant/message', 'tool/call', 'tool/result', 'todo/write', 'step/end',
      'step/start', 'assistant/message', 'step/end', 'turn/end',
    ])
    const user = eventsOf(agent).find(event => event.type === 'user/message')
    expect(user?.data).toEqual(message)
    const final = eventsOf(agent).filter(event => event.type === 'assistant/message').at(-1)
    expect(final?.type === 'assistant/message' && final.data.message.content).toEqual([{ type: 'text', text: 'Done.\n\nReceipt: verified\n' }])
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
    expect(promptTexts(fake)).toEqual(['Fix the bug'])
    expect(host.statuses.filter(entry => entry.agent === agent).map(entry => entry.status)).toEqual(['running', 'idle'])
    expect(host.frames.filter(entry => entry.frame.type === 'start')).toHaveLength(3)
    expect(agent.model.current()).toBeUndefined()
    // The completed turn is durable without disposal.
    expect(filesText(join(fake.root, 'sessions'))).toContain('"turn/end"')
    expect(host.record('casper-run')).toEqual({ acpSessionId: expect.any(String) as string, cwd: fake.cwd })
  })

  it('maps Casper stop reasons and error replies to turn endings', async () => {
    const { host } = await setup({ prompts: [[{ stop: 'max_turn_requests' }], [{ stop: 'refusal' }], [{ fail: 'runtime failed' }]] })
    const { agent } = await host.create('casper-stops')
    await run(agent, 'one')
    await run(agent, 'two')
    await run(agent, 'three')
    expect(turnEnds(agent)).toEqual([
      { kind: 'error', error: { code: 'CASPER_TURN_LIMIT', message: 'Casper stopped at its turn limit.' } },
      { kind: 'error', error: { code: 'CASPER_STOP_REFUSAL', message: 'Casper stopped: refusal.' } },
      { kind: 'error', error: { code: 'CASPER_RPC_-32603', message: 'Casper failed: runtime failed' } },
    ])
    expect(host.errors.filter(entry => entry.agent === agent)).toHaveLength(1)
  })

  describe('steering', () => {
    /** The user messages recorded in the Session, as their text, with their step. */
    function userMessages(agent: Agent): { step: number; text: string }[] {
      let step = 0
      return eventsOf(agent).flatMap((event) => {
        if (event.type === 'step/start') step = event.data.step
        if (event.type !== 'user/message') return []
        return [{ step, text: event.data.content.map(block => block.type === 'text' ? block.text : '').join('') }]
      })
    }

    function steerTexts(fake: FakeCasper): string[] {
      return fake.calls('_casper/steer').map(entry => (entry.params?.prompt as { text: string }[]).map(block => block.text).join('|'))
    }

    it('sends steering during a prompt to Casper and records it where Casper reads it', async () => {
      const { fake, host } = await setup({ steer: true, prompts: [[{ text: 'Working.\n' }, { steerRead: 1 }, { text: 'Adjusted.\n' }]] })
      const { agent } = await host.create('casper-steer')
      agent.followup(prompt('first'))
      await waitFor(() => fake.calls('session/prompt').length === 1)
      const line = prompt('also this')
      agent.steer(line)
      await agent.whenIdle()
      expect(promptTexts(fake)).toEqual(['first'])
      expect(fake.calls('_casper/steer').map(entry => entry.params)).toEqual([{
        sessionId: fake.calls('session/prompt')[0]?.params?.sessionId, prompt: [{ type: 'text', text: 'also this' }], messageId: line.id,
      }])
      expect(types(agent)).toEqual([
        'plugin:casper-agent/models', 'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end',
        'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
      ])
      expect(eventsOf(agent).filter(event => event.type === 'user/message').at(-1)?.data).toEqual(line)
      const words = eventsOf(agent).flatMap(event => event.type === 'assistant/message' ? [event.data.message.content] : [])
      expect(words).toEqual([[{ type: 'text', text: 'Working.\n' }], [{ type: 'text', text: 'Adjusted.\n\nReceipt: verified\n' }]])
      expect([...agent.inbox.nextTurn, ...agent.inbox.nextStep]).toEqual([])
      expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
    })

    it('a refused steer, an old Casper or an unread steer runs as the next turn', async () => {
      for (const [name, script] of [
        ['refused', { steer: true, steerReplies: [false] }],
        ['old', {}],
        ['unread', { steer: true }],
      ] as const) {
        const { fake, host } = await setup({ prompts: [] })
        const hold = gate(fake, 'hold')
        fake.script({ ...script, prompts: [[{ waitFile: hold.path }], []] })
        const { agent } = await host.create(`casper-steer-${name}`)
        agent.followup(prompt('first'))
        await waitFor(() => fake.calls('session/prompt').length === 1)
        agent.steer(prompt('also this'))
        if (name === 'old') await new Promise((resolve) => { setTimeout(resolve, 100) })
        else await waitFor(() => fake.log().some(entry => entry.event === 'steer-reply'))
        hold.open()
        await agent.whenIdle()
        expect(steerTexts(fake), name).toEqual(name === 'old' ? [] : ['also this'])
        expect(promptTexts(fake), name).toEqual(['first', 'also this'])
        expect(userMessages(agent).map(entry => entry.text), name).toEqual(['first', 'also this'])
        expect(turnEnds(agent), name).toEqual([{ kind: 'completed' }, { kind: 'completed' }])
      }
    })

    it('forwards no steer after a refused one, so the lines keep their order', async () => {
      const { fake, host } = await setup({ prompts: [] })
      const hold = gate(fake, 'hold')
      fake.script({ steer: true, steerReplies: [false], prompts: [[{ waitFile: hold.path }], []] })
      const { agent } = await host.create('casper-steer-order')
      agent.followup(prompt('first'))
      await waitFor(() => fake.calls('session/prompt').length === 1)
      agent.steer(prompt('one'))
      agent.steer(prompt('two'))
      await waitFor(() => fake.log().some(entry => entry.event === 'steer-reply'))
      await new Promise((resolve) => { setTimeout(resolve, 100) })
      hold.open()
      await agent.whenIdle()
      expect(steerTexts(fake)).toEqual(['one'])
      expect(promptTexts(fake)).toEqual(['first', 'one|two'])
    })

    it('a read notice that comes before the steer reply is recorded once with no second turn', async () => {
      const { fake, host } = await setup({ steer: true, steerReplyDelayMs: 300, prompts: [[{ steerRead: 1 }, { text: 'ok\n' }]] })
      const { agent } = await host.create('casper-steer-early')
      agent.followup(prompt('first'))
      await waitFor(() => fake.calls('session/prompt').length === 1)
      agent.steer(prompt('also this'))
      await agent.whenIdle()
      // The prompt waited for the late reply, so it came before the turn ended.
      expect(fake.log().filter(entry => entry.event === 'steer-reply').map(entry => entry.steered)).toEqual([true])
      expect(userMessages(agent)).toEqual([{ step: 1, text: 'first' }, { step: 1, text: 'also this' }])
      expect(promptTexts(fake)).toEqual(['first'])
      expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
    })

    it('two steers read at separate steps are recorded in order', async () => {
      const { fake, host } = await setup({ steer: true, prompts: [[
        { text: 'Reading.\n' }, { steerRead: 1 }, { tool: 'bash', target: 'ls' }, { toolEnd: 1 }, { steerRead: 2 }, { text: 'Done.\n' },
      ]] })
      const { agent } = await host.create('casper-steer-two')
      agent.followup(prompt('first'))
      await waitFor(() => fake.calls('session/prompt').length === 1)
      agent.steer(prompt('one'))
      agent.steer(prompt('two'))
      await agent.whenIdle()
      expect(steerTexts(fake)).toEqual(['one', 'two'])
      expect(userMessages(agent)).toEqual([{ step: 1, text: 'first' }, { step: 2, text: 'one' }, { step: 3, text: 'two' }])
      expect(promptTexts(fake)).toEqual(['first'])
      expect([...agent.inbox.nextTurn, ...agent.inbox.nextStep]).toEqual([])
    })

    it('Stop clears an unread steer and keepInbox runs it next turn', async () => {
      const { fake, host } = await setup({ steer: true, prompts: [[{ hang: true }], [{ hang: true }], []] })
      const { agent } = await host.create('casper-steer-stop')
      agent.followup(prompt('first'))
      await waitFor(() => fake.calls('session/prompt').length === 1)
      agent.steer(prompt('dropped'))
      await waitFor(() => fake.log().some(entry => entry.event === 'steer-reply'))
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
      expect([...agent.inbox.nextTurn, ...agent.inbox.nextStep]).toEqual([])
      agent.followup(prompt('second'))
      await waitFor(() => fake.calls('session/prompt').length === 2)
      agent.steer(prompt('kept'))
      await waitFor(() => fake.log().filter(entry => entry.event === 'steer-reply').length === 2)
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      await agent.whenIdle()
      expect(agent.inbox.nextStep.map(message => message.content)).toEqual([[{ type: 'text', text: 'kept' }]])
      await run(agent, 'third')
      expect(steerTexts(fake)).toEqual(['dropped', 'kept'])
      expect(promptTexts(fake)).toEqual(['first', 'second', 'kept|third'])
      expect(userMessages(agent).map(entry => entry.text)).toEqual(['first', 'second', 'kept', 'third'])
    })

    it('an edited pending line records the original that was sent', async () => {
      const { fake, host } = await setup({ prompts: [] })
      const hold = gate(fake, 'hold')
      fake.script({ steer: true, prompts: [[{ waitFile: hold.path }, { steerRead: 1 }, { text: 'ok\n' }]] })
      const { agent } = await host.create('casper-steer-edit')
      agent.followup(prompt('first'))
      await waitFor(() => fake.calls('session/prompt').length === 1)
      const line = prompt('also this')
      agent.steer(line)
      await waitFor(() => fake.log().some(entry => entry.event === 'steer-reply'))
      expect(agent.inbox.replace(line.id, { ...line, content: [{ type: 'text', text: 'edited' }] })).toBe(true)
      hold.open()
      await agent.whenIdle()
      expect(userMessages(agent).map(entry => entry.text)).toEqual(['first', 'also this'])
      expect([...agent.inbox.nextTurn, ...agent.inbox.nextStep]).toEqual([])
      expect(promptTexts(fake)).toEqual(['first'])
    })

    it('a steer typed while preparing reaches Casper after the prompt', async () => {
      const held = heldPictureStore()
      const { fake, host } = await setupWithAttachments({ steer: true, promptCapabilities: { image: true }, prompts: [[{ steerRead: 1 }, { text: 'ok\n' }]] }, held.store)
      const { agent } = await host.create('casper-steer-preparing')
      agent.followup(prompt('', 'rpc-steer-picture', [{ type: 'text', text: 'look' }, { type: 'image', attachment: PICTURE }]))
      await waitFor(() => held.reading())
      agent.steer(prompt('also this'))
      await new Promise((resolve) => { setTimeout(resolve, 50) })
      expect(fake.calls('_casper/steer')).toEqual([])
      held.release()
      await agent.whenIdle()
      const methods = fake.log().flatMap(entry => entry.method === 'session/prompt' || entry.method === '_casper/steer' ? [entry.method] : [])
      expect(methods).toEqual(['session/prompt', '_casper/steer'])
      expect(userMessages(agent).map(entry => entry.text)).toEqual(['look', 'also this'])
      expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
    })

    it('a picture line removed while its picture is read is never sent or recorded', async () => {
      const held = heldPictureStore()
      const { fake, host } = await setupWithAttachments({ prompts: [] }, held.store)
      const hold = gate(fake, 'hold')
      fake.script({ steer: true, promptCapabilities: { image: true }, prompts: [[{ waitFile: hold.path }, { text: 'ok\n' }]] })
      const { agent } = await host.create('casper-steer-removed-reading')
      agent.followup(prompt('first'))
      await waitFor(() => fake.calls('session/prompt').length === 1)
      const line = prompt('', 'rpc-steer-removed', [{ type: 'text', text: 'look' }, { type: 'image', attachment: PICTURE }])
      agent.steer(line)
      await waitFor(() => held.reading())
      expect(agent.inbox.remove(line.id)).toBe(true)
      held.release()
      await new Promise((resolve) => { setTimeout(resolve, 100) })
      hold.open()
      await agent.whenIdle()
      expect(fake.calls('_casper/steer')).toEqual([])
      expect(userMessages(agent).map(entry => entry.text)).toEqual(['first'])
      expect(promptTexts(fake)).toEqual(['first'])
      expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
    })

    it('a picture line edited while its picture is read sends and records the edit', async () => {
      const held = heldPictureStore()
      const { fake, host } = await setupWithAttachments({ steer: true, promptCapabilities: { image: true }, prompts: [[{ steerRead: 1 }, { text: 'ok\n' }]] }, held.store)
      const { agent } = await host.create('casper-steer-edited-reading')
      agent.followup(prompt('first'))
      await waitFor(() => fake.calls('session/prompt').length === 1)
      const line = prompt('', 'rpc-steer-edited', [{ type: 'text', text: 'look' }, { type: 'image', attachment: PICTURE }])
      agent.steer(line)
      await waitFor(() => held.reading())
      expect(agent.inbox.replace(line.id, { ...line, content: [{ type: 'text', text: 'edited' }] })).toBe(true)
      held.release()
      await agent.whenIdle()
      expect(steerTexts(fake)).toEqual(['edited'])
      expect(userMessages(agent).map(entry => entry.text)).toEqual(['first', 'edited'])
      expect(promptTexts(fake)).toEqual(['first'])
      expect([...agent.inbox.nextTurn, ...agent.inbox.nextStep]).toEqual([])
    })

    it('a late reply after the prompt ended causes no duplicate', async () => {
      const { fake, host } = await setup({ prompts: [] }, { cancelGraceMs: 100 })
      const hold = gate(fake, 'hold')
      fake.script({ steer: true, steerReplyDelayMs: 600, prompts: [[{ waitFile: hold.path }], [{ text: 'ok\n' }]] })
      const { agent } = await host.create('casper-steer-late')
      agent.followup(prompt('first'))
      await waitFor(() => fake.calls('session/prompt').length === 1)
      agent.steer(prompt('also this'))
      await waitFor(() => fake.calls('_casper/steer').length === 1)
      hold.open()
      await agent.whenIdle()
      await waitFor(() => fake.log().some(entry => entry.event === 'steer-reply'))
      await new Promise((resolve) => { setTimeout(resolve, 100) })
      await agent.whenIdle()
      expect(promptTexts(fake)).toEqual(['first', 'also this'])
      expect(userMessages(agent).map(entry => entry.text)).toEqual(['first', 'also this'])
      expect(turnEnds(agent)).toEqual([{ kind: 'completed' }, { kind: 'completed' }])
      expect([...agent.inbox.nextTurn, ...agent.inbox.nextStep]).toEqual([])
    })
  })

  it('gives a tool that is still running at a Stop an outcome-unknown result', async () => {
    const { fake, host } = await setup({ prompts: [[{ tool: 'bash', target: 'npm test' }, { hang: true }]] })
    const { agent } = await host.create('casper-stop-tool')
    agent.followup(prompt('run the tests'))
    await waitFor(() => eventsOf(agent).some(event => event.type === 'tool/call'))
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    expect(fake.calls('session/cancel')).toHaveLength(1)
    // Casper's cancelled receipt waited for the open call, so it lands in a final step.
    expect(types(agent)).toEqual([
      'plugin:casper-agent/models', 'turn/start', 'step/start', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'step/end',
      'step/start', 'assistant/message', 'step/end', 'turn/end',
    ])
    const call = eventsOf(agent).find(event => event.type === 'tool/call')
    const result = eventsOf(agent).find(event => event.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data).toMatchObject({
      message: { toolCallId: call?.type === 'tool/call' ? call.data.callId : '', isError: true },
      error: { code: 'TOOL_OUTCOME_UNKNOWN' },
    })
  })

  it('stops a prompt with session/cancel and keeps queued input', async () => {
    const { fake, host } = await setup({ prompts: [[{ text: 'working\n' }, { hang: true }]] })
    const { agent } = await host.create('casper-stop')
    agent.followup(prompt('long task'))
    await waitFor(() => host.frames.some(entry => entry.agent === agent && entry.frame.type === 'chunk'))
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    await agent.whenIdle()
    expect(fake.calls('session/cancel')).toHaveLength(1)
    expect(turnEnds(agent)).toEqual([{ kind: 'aborted', reason: { kind: 'user' } }])
    const partial = eventsOf(agent).find(event => event.type === 'assistant/message')
    expect(partial?.type === 'assistant/message' && partial.data.interrupted).toBe(true)
    expect(fake.pids().every(pid => alive(pid))).toBe(true)
  })

  it('kills a Casper that ignores the cancel once the grace passes, and starts it again for the next prompt', async () => {
    // The first prompt replies, so Casper has saved the conversation before it hangs.
    const { fake, host } = await setup({ prompts: [[], [{ hang: true, ignoreCancel: true }], []], newSessionId: 'conversation-1' }, { cancelGraceMs: 300 })
    const { agent } = await host.create('casper-hung')
    await run(agent, 'warm up')
    agent.followup(prompt('hang'))
    await waitFor(() => fake.calls('session/prompt').length === 2)
    const [first] = fake.pids()
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    await agent.whenIdle()
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }, { kind: 'aborted', reason: { kind: 'user' } }])
    await waitFor(() => !alive(first ?? 0))
    await run(agent, 'again')
    expect(fake.pids()).toHaveLength(2)
    expect(fake.calls('session/load').map(entry => entry.params?.sessionId)).toEqual(['conversation-1'])
    expect(turnEnds(agent).at(-1)).toEqual({ kind: 'completed' })
  })

  it('ends a turn whose Casper exits as CASPER_EXITED, then reopens the conversation in a new process with new call ids', async () => {
    // The first prompt replies, so Casper has saved the conversation before the crash.
    const { fake, host } = await setup({
      prompts: [[], [{ tool: 'bash', target: 'ls' }, { crash: 9 }], [{ tool: 'bash', target: 'ls' }, { toolEnd: 1 }]],
      newSessionId: 'conversation-2',
    })
    const { agent } = await host.create('casper-crash')
    await run(agent, 'warm up')
    await run(agent, 'first')
    expect(turnEnds(agent)[1]).toMatchObject({ kind: 'error', error: { code: 'CASPER_EXITED' } })
    expect(host.errors.filter(entry => entry.agent === agent)).toHaveLength(1)
    // The call the crash cut off has a result, so its card is not left running.
    const cutOff = eventsOf(agent).filter(event => event.type === 'tool/result')
    expect(cutOff.map(event => event.type === 'tool/result' && event.data.error?.code)).toEqual(['TOOL_OUTCOME_UNKNOWN'])
    await run(agent, 'second')
    expect(fake.pids()).toHaveLength(2)
    expect(fake.calls('session/load').map(entry => entry.params?.sessionId)).toEqual(['conversation-2'])
    const callIds = eventsOf(agent).flatMap(event => event.type === 'tool/call' ? [event.data.callId] : [])
    expect(callIds).toHaveLength(2)
    expect(new Set(callIds).size).toBe(2)
    expect(callIds.every(id => id.endsWith(':casper-tool-1'))).toBe(true)
    const resultIds = eventsOf(agent).flatMap(event => event.type === 'tool/result' ? [event.data.message.toolCallId] : [])
    expect(resultIds).toEqual(callIds)
    const texts = eventsOf(agent).flatMap(event => event.type === 'assistant/message' ? event.data.message.content : [])
    expect(texts).not.toContainEqual({ type: 'text', text: expect.stringContaining('could not reopen') as string })
  })

  it('starts fresh after a restart when Casper never saved the conversation, as before its first reply', async () => {
    const { fake, host } = await setup({ prompts: [[{ crash: 1 }], []], newSessionId: 'conversation-unsaved' })
    const { agent } = await host.create('casper-unsaved')
    await run(agent, 'first')
    await run(agent, 'second')
    expect(fake.calls('session/load').map(entry => entry.params?.sessionId)).toEqual(['conversation-unsaved'])
    expect(fake.calls('session/new')).toHaveLength(2)
    expect(turnEnds(agent).at(-1)).toEqual({ kind: 'completed' })
    expect(host.record('casper-unsaved')).toEqual({ acpSessionId: 'conversation-unsaved', cwd: fake.cwd })
  })

  it('says so when Casper could not reopen the stored conversation', async () => {
    const { fake, host } = await setup({ prompts: [[{ crash: 1 }], []] })
    const { agent } = await host.create('casper-fresh')
    await run(agent, 'first')
    await run(agent, 'second')
    expect(fake.calls('session/load')).toHaveLength(1)
    expect(fake.calls('session/new')).toHaveLength(2)
    const notice = eventsOf(agent).filter(event => event.type === 'assistant/message').at(-1)
    expect(notice?.type === 'assistant/message' && notice.data.message.content[0]).toEqual({
      type: 'text', text: `${FRESH_CONVERSATION_NOTICE}\nReceipt: verified\n`,
    })
  })

  it('ends the turn with CASPER_NOT_FOUND when Casper is not installed and stays usable', async () => {
    const { host } = await setup({ prompts: [] }, { command: 'casper-not-installed-for-test' })
    const { agent } = await host.create('casper-missing')
    await run(agent, 'one')
    await run(agent, 'two')
    expect(turnEnds(agent)).toMatchObject([
      { kind: 'error', error: { code: 'CASPER_NOT_FOUND', message: expect.stringContaining('Install Casper') as string } },
      { kind: 'error', error: { code: 'CASPER_NOT_FOUND' } },
    ])
    expect(agent.status).toBe('idle')
  })

  it('refuses an empty prompt without starting Casper', async () => {
    const { fake, host } = await setup({ prompts: [] })
    const { agent } = await host.create('casper-blank')
    await run(agent, '   ')
    expect(turnEnds(agent)).toEqual([
      { kind: 'error', error: { code: 'CASPER_EMPTY_PROMPT', message: 'The request is empty, so nothing was sent to Casper.' } },
    ])
    expect(fake.pids()).toEqual([])
  })

  it('sends a picture as an image block and a file as a link to its saved copy, in the order attached', async () => {
    const { fake, host } = await setupWithAttachments({ prompts: [[{ text: 'It is disabled.\n' }]], promptCapabilities: { image: true } })
    const { agent } = await host.create('casper-picture')
    agent.followup(prompt('', 'rpc-picture', [
      { type: 'text', text: 'Why is this button grey?' }, { type: 'image', attachment: PICTURE }, { type: 'file', attachment: NOTES },
    ]))
    await agent.whenIdle()
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
    expect(fake.calls('session/prompt')[0]?.params?.prompt).toEqual([
      { type: 'text', text: 'Why is this button grey?' },
      { type: 'image', mimeType: 'image/png', data: Buffer.from(PICTURE_BYTES).toString('base64') },
      { type: 'resource_link', uri: pathToFileURL(NOTES_HOST_PATH).href, name: 'notes.txt', size: 2048 },
    ])
    const reply = eventsOf(agent).filter(event => event.type === 'assistant/message').at(-1)
    expect(reply?.type === 'assistant/message' && reply.data.message.content).toEqual([{ type: 'text', text: 'It is disabled.\n\nReceipt: verified\n' }])
  })

  it('gives an older Casper a placeholder for a picture and tells the user it was not sent', async () => {
    const { fake, host } = await setupWithAttachments({ prompts: [[{ text: 'Only words.\n' }]] })
    const { agent } = await host.create('casper-old-picture')
    agent.followup(prompt('', 'rpc-old-picture', [{ type: 'text', text: 'fix the layout shown here' }, { type: 'image', attachment: PICTURE }]))
    await agent.whenIdle()
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
    expect(fake.calls('session/prompt')[0]?.params?.prompt).toEqual([
      { type: 'text', text: 'fix the layout shown here' }, { type: 'text', text: TEXT_ONLY_PICTURE },
    ])
    const reply = eventsOf(agent).filter(event => event.type === 'assistant/message').at(-1)
    expect(reply?.type === 'assistant/message' && reply.data.message.content).toEqual([{ type: 'text', text:
      'This Casper takes text only, so the picture was not sent. Update Casper to send pictures.\nOnly words.\n\nReceipt: verified\n' }])
  })

  it('sends nothing when only placeholders would remain', async () => {
    const old = await setupWithAttachments({ prompts: [] })
    const { agent } = await old.host.create('casper-only-placeholders')
    agent.followup(prompt('', 'rpc-only-picture', [{ type: 'image', attachment: PICTURE }]))
    await agent.whenIdle()
    agent.followup(prompt('', 'rpc-only-unsaved-file', [{ type: 'file', attachment: UNSAVED }]))
    await agent.whenIdle()
    const current = await setup({ prompts: [], promptCapabilities: { image: true } })
    const other = await current.host.create('casper-unreadable-picture')
    other.agent.followup(prompt('', 'rpc-unreadable', [{ type: 'image', attachment: PICTURE }]))
    await other.agent.whenIdle()
    const unreadable = 'The attachments could not be read, and the request has no words, so nothing was sent to Casper.'
    expect([...turnEnds(agent), ...turnEnds(other.agent)]).toEqual([
      { kind: 'error', error: { code: 'CASPER_EMPTY_PROMPT', message: 'This Casper can\'t take pictures, and the request has no words. Update Casper to send pictures.' } },
      { kind: 'error', error: { code: 'CASPER_EMPTY_PROMPT', message: unreadable } },
      { kind: 'error', error: { code: 'CASPER_EMPTY_PROMPT', message: unreadable } },
    ])
    expect([...old.fake.calls('session/prompt'), ...current.fake.calls('session/prompt')]).toEqual([])
  })

  it('says Casper started a new conversation even when that turn then sends nothing', async () => {
    const { fake, host } = await setupWithAttachments({ prompts: [[{ crash: 1 }], [{ text: 'ok\n' }]] })
    const { agent } = await host.create('casper-fresh-picture')
    await run(agent, 'first')
    agent.followup(prompt('', 'rpc-fresh-picture', [{ type: 'image', attachment: PICTURE }]))
    await agent.whenIdle()
    await run(agent, 'third')
    expect(fake.calls('session/load')).toHaveLength(1)
    expect(turnEnds(agent)).toMatchObject([
      { kind: 'error', error: { code: 'CASPER_EXITED' } },
      { kind: 'error', error: { code: 'CASPER_EMPTY_PROMPT' } },
      { kind: 'completed' },
    ])
    const texts = eventsOf(agent).flatMap(event => event.type === 'assistant/message'
      ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
      : [])
    expect(texts.filter(text => text.includes(FRESH_CONVERSATION_NOTICE))).toHaveLength(1)
    expect(texts.at(-1)).toBe('ok\n\nReceipt: verified\n')
  })

  it('sends no prompt when the turn stops during a picture read, even when the read still finishes', async () => {
    // A store that ignores the signal and finishes the read after the Stop.
    const held = heldPictureStore()
    const { fake, host } = await setupWithAttachments({ prompts: [[{ text: 'never\n' }]], promptCapabilities: { image: true } }, held.store)
    const { agent } = await host.create('casper-stop-picture')
    agent.followup(prompt('', 'rpc-stop-picture', [{ type: 'text', text: 'look' }, { type: 'image', attachment: PICTURE }]))
    await waitFor(() => held.reading())
    agent.cancel({ kind: 'user' })
    held.release()
    await agent.whenIdle()
    expect(turnEnds(agent)).toEqual([{ kind: 'aborted', reason: { kind: 'user' } }])
    expect(fake.calls('session/prompt')).toEqual([])
  })

  it('asks the user with Casper options in order and sends the picked option', async () => {
    const { fake, host } = await setup({ prompts: [[{ permission: 'Write outside the project?', options: ['Yes, this once', 'No', 'Yes for this session'], preview: '/elsewhere/file' }]] })
    const { agent } = await host.create('casper-ask')
    await run(agent, 'write it')
    expect(host.asked).toHaveLength(1)
    expect(host.asked[0]?.agent).toBe(agent)
    expect(host.asked[0]?.questions[0]).toMatchObject({
      question: 'Write outside the project?', detail: '/elsewhere/file',
      options: [{ label: 'No' }, { label: 'Yes, this once' }, { label: 'Yes for this session' }],
    })
    expect(fake.log().filter(entry => entry.event === 'answer').map(entry => entry.outcome)).toEqual([{ outcome: 'selected', optionId: '1' }])
    const result = eventsOf(agent).find(event => event.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message).toMatchObject({ isError: false, content: [{ type: 'text', text: '→ Yes, this once' }] })
  })

  it('keeps a box open and the write path alone on an in-progress update', async () => {
    let flushes = (): number => 0
    let flushesAtAsk = -1
    let flushesAfter = -1
    let abortedWhileOpen: boolean | undefined
    const { fake, host } = await setup({ prompts: [[{
      permission: 'Run it?', during: [{ toolUpdate: 'box', content: ['still deciding'] }, { tool: 'bash', target: 'ls' }],
    }, { toolEnd: 1 }]] }, {}, async (request) => {
      flushesAtAsk = flushes()
      // The second tool's call is recorded only after the box's in-progress update was received.
      await waitFor(() => eventsOf(request.agent!).filter(event => event.type === 'tool/call').length === 2)
      flushesAfter = flushes()
      abortedWhileOpen = request.signal?.aborted
      return { answers: [{ id: request.questions[0]?.id ?? '', selected: ['Yes, this once'] }] }
    })
    const flush = vi.spyOn(host.ctx.sessions, 'flush')
    flushes = () => flush.mock.calls.length
    const { agent } = await host.create('casper-box-progress')
    await run(agent, 'go')
    expect(abortedWhileOpen).toBe(false)
    // Only the second tool's call flushed while the box was open.
    expect(flushesAfter - flushesAtAsk).toBe(1)
    expect(fake.log().filter(entry => entry.event === 'answer').map(entry => entry.outcome)).toEqual([{ outcome: 'selected', optionId: '2' }])
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
  })

  it('records a current Casper\'s steps as Standard tools with their output', async () => {
    const path = (name: string) => `/work/project/${name}`
    const { host } = await setup({ prompts: [[
      {
        tool: 'edit', kind: 'edit', rawInput: { path: 'sum.js', edits: [{ oldText: 'a - b', newText: 'a + b' }] },
        meta: { tool: 'edit', target: 'sum.js' }, locations: [{ path: path('sum.js') }],
      },
      { toolEnd: 1, content: [{ type: 'diff', path: path('sum.js'), oldText: 'return a - b', newText: 'return a + b' }], rawOutput: { added: 1, removed: 1 } },
      { tool: 'bash', rawInput: { command: 'node sum.js' }, meta: { tool: 'bash', description: 'Run the sum' } },
      { toolEnd: 2, ok: false, content: ['```text\n5\n```'], rawOutput: { exitCode: 3, truncated: false } },
    ]] })
    const { agent } = await host.create('casper-standard-steps')
    await run(agent, 'fix sum.js')
    const calls = eventsOf(agent).flatMap(event => event.type === 'tool/call' ? [[event.data.name, parsed(event.data.arguments)]] : [])
    expect(calls).toEqual([
      ['edit', { file_path: 'sum.js', old_string: 'a - b', new_string: 'a + b' }],
      ['bash', { command: 'node sum.js', description: 'Run the sum' }],
    ])
    const results = eventsOf(agent).flatMap(event => event.type === 'tool/result' ? [event.data] : [])
    expect(results[0]).toMatchObject({
      message: { isError: false, content: [{ type: 'text', text: 'Edited sum.js (+1 −1)' }] },
      meta: { path: path('sum.js'), diffs: [{ path: path('sum.js'), oldText: 'return a - b', newText: 'return a + b' }] },
    })
    expect(results[1]).toMatchObject({ message: { isError: false, content: [{ type: 'text', text: '5\n[exit code: 3]' }] } })
    expect(results[1]?.error).toBeUndefined()
  })

  it('answers cancelled when the question fails, and when the turn stops while asking', async () => {
    const { fake, host } = await setup({ prompts: [[{ permission: 'Reach 192.0.2.10?' }], [{ permission: 'Reach 192.0.2.11?' }]] },
      {}, (request) => {
        if (request.questions[0]?.question.endsWith('10?') === true) return Promise.reject(new UserQuestionError('NO_PROVIDER', 'no answerer'))
        return new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
        })
      })
    const { agent } = await host.create('casper-no-answer')
    await run(agent, 'one')
    agent.followup(prompt('two'))
    await waitFor(() => host.asked.length === 2)
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    expect(fake.log().filter(entry => entry.event === 'answer').map(entry => entry.outcome)).toEqual([{ outcome: 'cancelled' }, { outcome: 'cancelled' }])
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }, { kind: 'aborted', reason: { kind: 'user' } }])
  })

  it('kills a Casper that is still starting when the turn stops, and starts cleanly afterwards', async () => {
    const { fake, host } = await setup({ prompts: [] })
    const hold = gate(fake, 'hold-initialize')
    fake.script({ prompts: [[]], holdInitialize: hold.path })
    const { agent } = await host.create('casper-cancel-start')
    agent.followup(prompt('first'))
    await waitFor(() => fake.calls('initialize').length === 1)
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    expect(turnEnds(agent)).toEqual([{ kind: 'aborted', reason: { kind: 'user' } }])
    await waitFor(() => fake.pids().every(pid => !alive(pid)))
    expect(host.record('casper-cancel-start')).toBeUndefined()
    hold.open()
    await run(agent, 'second')
    expect(turnEnds(agent).at(-1)).toEqual({ kind: 'completed' })
    expect(fake.calls('session/load')).toEqual([])
    expect(host.record('casper-cancel-start')).toBeDefined()
  })

  it('runs two Sessions in their own processes with their own questions and records', async () => {
    const { fake, host } = await setup({ prompts: [] })
    const hold = gate(fake, 'hold-both')
    fake.script({ prompts: [[{ permission: 'First?' }, { waitFile: hold.path }], [{ permission: 'Second?' }, { hang: true }]] })
    const first = (await host.create('casper-a')).agent
    const second = (await host.create('casper-b')).agent
    first.followup(prompt('a'))
    await waitFor(() => host.asked.length === 1)
    second.followup(prompt('b'))
    await waitFor(() => host.asked.length === 2)
    expect(host.asked.map(request => request.agent)).toEqual([first, second])
    second.cancel({ kind: 'user' })
    await second.whenIdle()
    expect(first.status).toBe('running')
    hold.open()
    await first.whenIdle()
    expect(fake.pids()).toHaveLength(2)
    expect(turnEnds(first)).toEqual([{ kind: 'completed' }])
    expect(turnEnds(second)).toEqual([{ kind: 'aborted', reason: { kind: 'user' } }])
    expect(host.record('casper-a')?.acpSessionId).not.toBe(host.record('casper-b')?.acpSessionId)
  })

  it('kills the process when the Agent is disposed', async () => {
    const { fake, host } = await setup({ prompts: [[]] })
    const handle = await host.create('casper-dispose')
    await run(handle.agent, 'start')
    const [pid] = fake.pids()
    expect(alive(pid ?? 0)).toBe(true)
    await handle.dispose()
    expect(alive(pid ?? 0)).toBe(false)
    expect(host.ctx.agents.get(handle.agent.id)).toBeUndefined()
  })

  it('stops a running prompt and its process when the Agent is disposed', async () => {
    const script = { prompts: [[{ hang: true, ignoreCancel: true }]], ignoreEof: true }
    const { fake, host } = await setup(script, { exitGraceMs: 300, killGraceMs: 500 })
    const handle = await host.create('casper-dispose-busy')
    handle.agent.followup(prompt('busy'))
    await waitFor(() => fake.calls('session/prompt').length === 1)
    const [pid] = fake.pids()
    const started = Date.now()
    await handle.dispose()
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(alive(pid ?? 0)).toBe(false)
    expect(turnEnds(handle.agent)).toEqual([{ kind: 'aborted', reason: { kind: 'disposed' } }])
  })

  it('refuses a fork', async () => {
    const { host } = await setup({ prompts: [] })
    await expect(host.ctx.agents.create({ sessionId: 'casper-fork' as never, meta: { agentPreset: 'casper', isSeeded: true } }))
      .rejects.toThrow(FORK_UNSUPPORTED)
  })

  it('runs maintenance only while idle and replays input queued behind it', async () => {
    const { fake, host } = await setup({ prompts: [[]] })
    const { agent } = await host.create('casper-maintenance')
    const release = Promise.withResolvers<undefined>()
    const job = agent.runMaintenance(() => release.promise)
    expect(() => agent.runMaintenance(() => Promise.resolve())).toThrow(/already has active work/)
    agent.followup(prompt('queued'))
    expect(fake.calls('session/prompt')).toEqual([])
    release.resolve(undefined)
    await job
    await agent.whenIdle()
    expect(promptTexts(fake)).toEqual(['queued'])
    agent.inject(prompt('context only'))
    expect(agent.status).toBe('idle')
    agent.cancel({ kind: 'user' })
    expect(agent.inbox.nextStep).toEqual([])
    await expect(agent.runMaintenance(() => { throw new Error('maintenance failed') })).rejects.toThrow('maintenance failed')
    expect(agent.status).toBe('idle')
  })

  it('starts an agent-loop Agent for a Session on another preset', async () => {
    const { host } = await setup({ prompts: [] })
    const { agent } = await host.create('standard-session', 'standard')
    expect(agent).not.toBeInstanceOf(CasperAgent)
  })

  it('runs input sent after a cancel as the next turn, and records a hook cause', async () => {
    const { fake, host } = await setup({ prompts: [[{ hang: true }], []] })
    const { agent } = await host.create('casper-hook')
    agent.followup(prompt('first'))
    await waitFor(() => fake.calls('session/prompt').length === 1)
    agent.cancel({ kind: 'hook', reason: 'policy stop' })
    agent.followup(prompt('after the stop'))
    await agent.whenIdle()
    expect(turnEnds(agent)).toEqual([{ kind: 'aborted', reason: { kind: 'hook', reason: 'policy stop' } }, { kind: 'completed' }])
    expect(promptTexts(fake)).toEqual(['first', 'after the stop'])
  })

  it('opens and closes a turn whose waking input was removed before it was claimed', async () => {
    const { fake, host } = await setup({ prompts: [] })
    const { agent } = await host.create('casper-cleared')
    const stop = host.ctx.on('agent/inbox/inserted', ({ agent: subject }) => {
      if (subject === agent) agent.inbox.clear()
    })
    agent.followup(prompt('removed'))
    stop()
    await agent.whenIdle()
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
    expect(fake.pids()).toEqual([])
  })

  it('drops updates and refuses permission requests that arrive outside a prompt', async () => {
    const { fake, host } = await setup({ prompts: [[{ text: 'answer\n', late: { text: 'too late\n', permission: 'Late?' } }]] })
    const { agent } = await host.create('casper-late')
    await run(agent, 'go')
    await waitFor(() => fake.log().some(entry => entry.event === 'answer'))
    expect(fake.log().find(entry => entry.event === 'answer')?.outcome).toEqual({ outcome: 'cancelled' })
    expect(host.asked).toEqual([])
    expect(eventsOf(agent).filter(event => event.type === 'tool/call')).toEqual([])
    expect(JSON.stringify(eventsOf(agent))).not.toContain('too late')
  })

  it('shows Casper\'s thoughts as reasoning', async () => {
    const { host } = await setup({ prompts: [[{ image: true }, { thought: 'Reading the tests\n\n' }, { thought: 'Fixing the parser\n\n' }, { text: 'ok\n' }]] })
    const { agent } = await host.create('casper-kinds')
    await run(agent, 'go')
    const message = eventsOf(agent).find(event => event.type === 'assistant/message')
    // A picture in a message is still left out; the thoughts are one reasoning block before the answer.
    expect(message?.type === 'assistant/message' && message.data.message.content).toEqual([
      { type: 'reasoning', text: 'Reading the tests\n\nFixing the parser\n\n' },
      { type: 'text', text: 'ok\n\nReceipt: verified\n' },
    ])
  })

  it('ends a question that is still open when Casper exits', async () => {
    const aborted: string[] = []
    const { host } = await setup({ prompts: [[{ exitAfterMs: 300, permission: 'Wait for me?' }]] }, {}, request => new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => {
        aborted.push(request.questions[0]?.question ?? '')
        reject(new Error('aborted'))
      }, { once: true })
    }))
    const { agent } = await host.create('casper-exit-asking')
    await run(agent, 'go')
    expect(turnEnds(agent)).toMatchObject([{ kind: 'error', error: { code: 'CASPER_EXITED' } }])
    await waitFor(() => aborted.length === 1)
  })

  it('answers cancelled when no question service is mounted', async () => {
    const { fake, host } = await setup({ prompts: [[{ permission: 'Anyone there?' }]] }, {}, undefined, false)
    const { agent } = await host.create('casper-no-service')
    await run(agent, 'go')
    expect(fake.log().find(entry => entry.event === 'answer')?.outcome).toEqual({ outcome: 'cancelled' })
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
  })

  it('records a prompt Casper cancelled on its own as a user stop', async () => {
    const { host } = await setup({ prompts: [[{ stop: 'cancelled' }]] })
    const { agent } = await host.create('casper-self-cancel')
    await run(agent, 'go')
    expect(turnEnds(agent)).toEqual([{ kind: 'aborted', reason: { kind: 'user' } }])
  })

  it('does not prompt when the turn cannot be made durable, and still ends later turns after a failed flush', async () => {
    const { fake, host } = await setup({ prompts: [[]] })
    const { agent } = await host.create('casper-flush')
    const flush = vi.spyOn(host.ctx.sessions, 'flush')
    flush.mockRejectedValueOnce('disk full')
    await run(agent, 'one')
    expect(turnEnds(agent)).toEqual([{ kind: 'error', error: { code: 'UNKNOWN', message: 'disk full' } }])
    expect(fake.pids()).toEqual([])
    flush.mockRejectedValueOnce(new Error('disk offline'))
    await run(agent, 'two')
    expect(turnEnds(agent).at(-1)).toEqual({ kind: 'error', error: { code: 'UNKNOWN', message: 'disk offline' } })
    flush.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('disk full'))
    await run(agent, 'three')
    expect(turnEnds(agent).at(-1)).toEqual({ kind: 'completed' })
    flush.mockRestore()
  })

  it('stops Casper when its conversation cannot be recorded', async () => {
    const { fake, host } = await setup({ prompts: [] })
    const { agent } = await host.create('casper-sidecar')
    const table = host.ctx.storageDomain.get('casper_agent')?.table('sessions')
    if (table === undefined) throw new Error('sidecar domain is not open')
    const put = vi.spyOn(table, 'put').mockRejectedValueOnce(new Error('storage offline'))
    await run(agent, 'go')
    put.mockRestore()
    expect(turnEnds(agent)).toMatchObject([{ kind: 'error', error: { code: 'CASPER_START_FAILED', message: expect.stringContaining('storage offline') as string } }])
    await waitFor(() => fake.pids().length === 1 && fake.pids().every(pid => !alive(pid)))
  })

  it('needs a project folder', async () => {
    const { fake, host } = await setup({ prompts: [] })
    const { agent } = await host.ctx.agents.create({ sessionId: SessionId('casper-no-folder'), meta: { agentPreset: 'casper' } })
    await run(agent, 'go')
    expect(turnEnds(agent)).toEqual([{ kind: 'error', error: { code: 'CASPER_START_FAILED', message: 'Casper needs a project folder for this session.' } }])
    expect(fake.pids()).toEqual([])
  })
})

describe('Casper\'s commands in the command menu', { timeout: 60_000 }, () => {
  const STATUS: FakeCommand = { name: 'status', description: 'Inspect project, model, auth and integrations' }
  const REVIEW: FakeCommand = { name: 'review', description: 'Review your changes', input: { hint: '[branch|commit]' } }
  const DIFF: FakeCommand = { name: 'diff', description: 'Show the changes', input: null }

  /** A Host with the command registry and the app's own `/permission` and `/export`. */
  async function setupMenu(script: FakeScript) {
    const fake = fakeCasper(script)
    cleanups.push(() => { fake.remove() })
    const host = await boot(fake, {}, undefined, true, async (ctx) => {
      await ctx.plugin(CommandRuntime)
      await ctx.plugin({
        name: 'app-commands',
        inject: ['commands'],
        apply: (inner: Context) => {
          for (const name of ['permission', 'export']) {
            inner.commands.register({ definitionId: CommandDefinitionId(`app/${name}`), name, description: `The app's ${name}`, handler: () => ({ kind: 'success' }) })
          }
        },
      })
    })
    cleanups.push(() => host.ctx.fiber.dispose())
    return { fake, host }
  }

  function menu(host: Awaited<ReturnType<typeof setupMenu>>['host'], agent: Agent): string[] {
    return host.ctx.commands.list(agent).map(command => `${command.name} ${command.definitionId ?? ''} ${command.input?.hint ?? ''}`.trim())
  }

  function cached(host: { ctx: Context }): unknown {
    return host.ctx.storageDomain.get('casper_agent_commands')?.global.get()
  }

  it('offers Casper\'s commands to its own Agent only, keeps the app\'s names, and sends a picked command to Casper', async () => {
    const { fake, host } = await setupMenu({
      commands: [
        STATUS, REVIEW, { name: 'permission', description: 'Casper permissions' }, { name: 'export', description: 'Casper export' },
        { name: 'model', description: 'Casper model' }, { name: 'file', description: 'Casper file' }, { name: 'Bad Name', description: 'not a name' },
        { name: 'blank', description: '  ' }, { name: 'status', description: 'a second status' }, { name: 'hint', description: 'blank hint', input: { hint: ' ' } },
      ],
      prompts: [[{ text: 'ready\n' }], [{ text: 'status shown\n' }]],
    })
    const { agent } = await host.create('casper-menu')
    const { agent: other } = await host.create('standard-session', 'standard')
    expect(menu(host, agent)).toEqual(['export app/export', 'permission app/permission'])
    await run(agent, 'hi')
    await waitFor(() => menu(host, agent).length === 5)
    expect(menu(host, agent)).toEqual([
      'export app/export',
      'hint @deepseek-ai/dsh-casper-agent/hint',
      'permission app/permission',
      'review @deepseek-ai/dsh-casper-agent/review [branch|commit]',
      'status @deepseek-ai/dsh-casper-agent/status',
    ])
    expect(menu(host, other)).toEqual(['export app/export', 'permission app/permission'])
    // A surface that executes the command instead of sending its line queues the line for Casper.
    const executed = await host.ctx.commands.execute(agent, '/review  main', [], new AbortController().signal)
    expect(executed?.result).toEqual({ kind: 'success' })
    await waitFor(() => fake.calls('session/prompt').length === 2)
    await agent.whenIdle()
    expect(promptTexts(fake)).toEqual(['hi', '/review  main'])
  })

  it('replaces the list with Casper\'s next one, skips an unchanged one, and offers the last list before the next Agent starts Casper', async () => {
    const { fake, host } = await setupMenu({
      commands: [STATUS, REVIEW],
      prompts: [[{ commandsUpdate: [DIFF, REVIEW] }, { text: 'one\n' }], [{ commandsUpdate: [DIFF, REVIEW] }, { text: 'two\n' }]],
    })
    const { agent } = await host.create('casper-menu-first')
    await run(agent, 'first')
    await waitFor(() => menu(host, agent).includes('diff @deepseek-ai/dsh-casper-agent/diff'))
    expect(menu(host, agent)).toEqual([
      'diff @deepseek-ai/dsh-casper-agent/diff', 'export app/export', 'permission app/permission',
      'review @deepseek-ai/dsh-casper-agent/review [branch|commit]',
    ])
    await waitFor(() => JSON.stringify(cached(host)) === JSON.stringify({ commands: [
      { name: 'diff', description: 'Show the changes' }, { name: 'review', description: 'Review your changes', hint: '[branch|commit]' },
    ] }))
    let changes = 0
    host.ctx.on('commands/change', () => { changes += 1 })
    await run(agent, 'second')
    expect(changes).toBe(0)
    const { agent: next } = await host.create('casper-menu-next')
    await waitFor(() => menu(host, next).includes('diff @deepseek-ai/dsh-casper-agent/diff'))
    expect(menu(host, next)).toEqual(menu(host, agent))
    expect(fake.pids()).toHaveLength(1)
  })

  it('offers the cached list only once the Agent is published, so a creation that fails changes no menu', async () => {
    const { fake, host } = await setupMenu({ commands: [STATUS], prompts: [[{ text: 'ok\n' }]] })
    const { agent: first } = await host.create('casper-menu-cache')
    await run(first, 'hi')
    await waitFor(() => JSON.stringify(cached(host)) === JSON.stringify({ commands: [{ name: 'status', description: STATUS.description }] }))
    // Every change makes each client repull its Sessions' menus, and a repull resumes a Session that is not live.
    const live: boolean[] = []
    host.ctx.on('commands/change', () => { live.push(host.ctx.agents.get(SessionId('casper-menu-late')) !== undefined) })
    for (const id of ['casper-menu-refused', 'casper-menu-refused-again']) {
      await expect(host.ctx.agents.create({
        sessionId: SessionId(id), meta: { cwd: fake.cwd, agentPreset: 'casper' }, setup: () => { throw new Error('setup refused') },
      })).rejects.toThrow('setup refused')
    }
    expect(live).toEqual([])
    const { agent } = await host.create('casper-menu-late')
    expect(menu(host, agent)).toContain('status @deepseek-ai/dsh-casper-agent/status')
    expect(live).toEqual([true])
  })

  it('changes the menu even when the list cannot be saved', async () => {
    const { host } = await setupMenu({ commands: [STATUS], prompts: [[{ text: 'ok\n' }], [{ commandsUpdate: [DIFF] }, { text: 'ok\n' }]] })
    const { agent } = await host.create('casper-menu-unsaved')
    await run(agent, 'hi')
    await waitFor(() => JSON.stringify(cached(host)) === JSON.stringify({ commands: [{ name: 'status', description: STATUS.description }] }))
    const global = host.ctx.storageDomain.get('casper_agent_commands')?.global
    if (global === undefined) throw new Error('command cache is not open')
    const set = vi.spyOn(global, 'set').mockRejectedValue(new Error('disk full'))
    await run(agent, 'again')
    await waitFor(() => set.mock.calls.length === 1)
    await waitFor(() => menu(host, agent).includes('diff @deepseek-ai/dsh-casper-agent/diff'))
    expect(menu(host, agent)).toEqual(['diff @deepseek-ai/dsh-casper-agent/diff', 'export app/export', 'permission app/permission'])
    expect(cached(host)).toEqual({ commands: [{ name: 'status', description: STATUS.description }] })
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }, { kind: 'completed' }])
    set.mockRestore()
  })

  it('keeps the list without a command registry, and a failed save does not fail the turn', async () => {
    const { fake, host } = await setup({ commands: [STATUS], prompts: [[{ text: 'ok\n' }], [{ commandsUpdate: [DIFF] }, { text: 'ok\n' }]] })
    const { agent } = await host.create('casper-no-menu')
    await run(agent, 'hi')
    await waitFor(() => JSON.stringify(cached(host)) === JSON.stringify({ commands: [{ name: 'status', description: STATUS.description }] }))
    const global = host.ctx.storageDomain.get('casper_agent_commands')?.global
    if (global === undefined) throw new Error('command cache is not open')
    const set = vi.spyOn(global, 'set').mockRejectedValueOnce(new Error('disk full'))
    await run(agent, 'again')
    await waitFor(() => set.mock.calls.length === 1)
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }, { kind: 'completed' }])
    expect(fake.pids()).toHaveLength(1)
    // Another Agent sending the list already stored writes nothing.
    const domain = host.ctx.storageDomain.get('casper_agent_commands')
    if (domain === undefined) throw new Error('command cache is not open')
    await new CasperCommandCache(domain as never).write([{ name: 'status', description: STATUS.description }])
    expect(set.mock.calls).toHaveLength(1)
    set.mockRestore()
  })
})

describe('Casper\'s models in the model picker', { timeout: 60_000 }, () => {
  const SOL = { provider: 'openai-codex', model: 'gpt-6.1-sol' }
  const OPUS = { provider: 'claude-subscription', model: 'claude-opus-5-5' }

  function view(host: { ctx: Context }, agent: Agent): unknown {
    return host.ctx.sessionProjections.snapshot(agent.session).values.agentModels
  }

  function current(host: { ctx: Context }, agent: Agent): unknown {
    return (view(host, agent) as { current?: unknown } | null | undefined)?.current
  }

  function sets(fake: FakeCasper): unknown[] {
    return fake.calls('session/set_config_option').map(entry => [entry.params?.configId, entry.params?.value])
  }

  /** The methods Casper received after initialize, in order. */
  function methodsOf(fake: FakeCasper): string[] {
    return fake.log().flatMap(entry => entry.method === undefined || entry.method === 'initialize' ? [] : [entry.method])
  }

  function labels(agent: Agent): unknown[] {
    return eventsOf(agent).flatMap(event => event.type === 'assistant/message' ? [event.data.message.source] : [])
  }

  /** Keep Casper's list in the host cache, as an earlier Casper Session would have. */
  async function cacheList(host: { ctx: Context }, options = casperOptions()): Promise<void> {
    const domain = host.ctx.storageDomain.get('casper_agent_models')
    if (domain === undefined) throw new Error('model cache is not open')
    const { groups, current: model } = reportOf(options)
    await new CasperModelsCache(domain as never).write({ groups, current: model })
  }

  it('reports Casper\'s models and labels its messages with the model it uses', async () => {
    // Casper resends the same list mid-prompt, which records nothing new.
    const { host } = await setup({ configOptions: casperOptions(), prompts: [[{ configUpdate: casperOptions() }, { text: 'hi\n' }]] })
    const { agent } = await host.create('casper-models')
    // No Casper has listed its models yet, so the picker says Casper lists them once it starts.
    expect(view(host, agent)).toEqual({ groups: [], current: null, started: false })
    await run(agent, 'hello')
    expect(view(host, agent)).toEqual({ ...reportOf(casperOptions()), started: true })
    expect(types(agent).filter(type => type === 'plugin:casper-agent/models')).toHaveLength(2)
    expect(agent.model.current()).toEqual({ ...SOL, reasoningEffort: 'auto' })
    expect(labels(agent).at(-1)).toMatchObject({ provider: 'casper', model: 'openai-codex/gpt-6.1-sol' })
    await waitFor(() => JSON.stringify(host.ctx.storageDomain.get('casper_agent_models')?.global.get())
      === JSON.stringify({ groups: reportOf(casperOptions()).groups, current: { ...SOL, reasoningEffort: 'auto' } }))
  })

  it('applies a pick at once while Casper is idle, without a prompt, and refuses a model or effort Casper does not list', async () => {
    const { fake, host } = await setup({ configOptions: casperOptions(), prompts: [[{ text: 'one\n' }]] })
    const { agent } = await host.create('casper-pick-idle')
    await run(agent, 'first')
    const own = agent.model.own
    if (own === undefined) throw new Error('a Casper Agent chooses its own models')
    expect(await own.choose({ ...OPUS, reasoningEffort: ReasoningEffortId('high') })).toEqual({ ...OPUS, reasoningEffort: 'high' })
    expect(sets(fake)).toEqual([['model', 'claude-subscription/claude-opus-5-5'], ['effort', 'high']])
    expect(fake.calls('session/prompt')).toHaveLength(1)
    expect(current(host, agent)).toEqual({ ...OPUS, reasoningEffort: 'high' })
    expect(types(agent).slice(-2)).toEqual(['model/selection', 'plugin:casper-agent/models'])
    // The same pick again records and sends nothing.
    await own.choose({ ...OPUS, reasoningEffort: ReasoningEffortId('high') })
    expect(sets(fake)).toHaveLength(2)
    // A new effort for the same model sends only the effort.
    expect(await own.choose({ ...OPUS, reasoningEffort: ReasoningEffortId('low') })).toEqual({ ...OPUS, reasoningEffort: 'low' })
    expect(sets(fake).slice(2)).toEqual([['effort', 'low']])
    await expect(own.choose({ provider: 'openai-codex', model: 'gpt-gone' })).rejects.toThrow(
      'Casper can\'t use openai-codex/gpt-gone: it is not one of your signed-in models. Pick one from the list.')
    await expect(own.choose({ ...OPUS, reasoningEffort: ReasoningEffortId('medium') })).rejects.toThrow(
      'claude-subscription/claude-opus-5-5 has no effort medium. Choose: auto, low, high')
    // A model with no effort choices takes no effort.
    expect(await own.choose({ provider: 'claude-subscription', model: 'vendor/small:free', reasoningEffort: ReasoningEffortId('high') }))
      .toEqual({ provider: 'claude-subscription', model: 'vendor/small:free' })
    expect(sets(fake).at(-1)).toEqual(['model', 'claude-subscription/vendor/small:free'])
    expect(fake.calls('session/prompt')).toHaveLength(1)
  })

  it('sends a pick made before Casper starts ahead of the first prompt, and follows a model Casper changes itself', async () => {
    const { fake, host } = await setup({
      configOptions: casperOptions(),
      prompts: [[
        { text: 'switching\n' }, { tool: 'read', target: 'README.md' }, { toolEnd: 1 },
        { configUpdate: casperOptions(`${SOL.provider}/${SOL.model}`, 'low') }, { text: 'switched\n' },
      ]],
    })
    await cacheList(host)
    const { agent } = await host.create('casper-pick-early')
    expect(view(host, agent)).toEqual({ ...reportOf(casperOptions()), started: false })
    await agent.model.own?.choose({ ...OPUS, reasoningEffort: ReasoningEffortId('high') })
    expect(fake.pids()).toEqual([])
    expect(current(host, agent)).toEqual({ ...OPUS, reasoningEffort: 'high' })
    await run(agent, 'go')
    expect(methodsOf(fake)).toEqual(['session/new', 'session/set_config_option', 'session/set_config_option', 'session/prompt'])
    expect(sets(fake)).toEqual([['model', 'claude-subscription/claude-opus-5-5'], ['effort', 'high']])
    // Casper's own /model mid-prompt moves the badge and labels the messages after it.
    expect(current(host, agent)).toEqual({ ...SOL, reasoningEffort: 'low' })
    expect(labels(agent).map(source => (source as { model: string }).model)).toEqual(['claude-subscription/claude-opus-5-5', 'openai-codex/gpt-6.1-sol'])
  })

  it('keeps a pick made during a prompt for the next turn, even when Casper changes its model meanwhile', async () => {
    const fake = fakeCasper({ prompts: [] })
    cleanups.push(() => { fake.remove() })
    const hold = gate(fake, 'hold')
    fake.script({
      configOptions: casperOptions(),
      prompts: [[{ waitFile: hold.path }, { configUpdate: casperOptions(undefined, 'low') }, { text: 'one\n' }], [{ text: 'two\n' }]],
    })
    const host = await boot(fake)
    cleanups.push(() => host.ctx.fiber.dispose())
    const { agent } = await host.create('casper-pick-busy')
    agent.followup(prompt('first'))
    await waitFor(() => fake.calls('session/prompt').length === 1)
    await agent.model.own?.choose(OPUS)
    expect(sets(fake)).toEqual([])
    hold.open()
    await agent.whenIdle()
    expect(current(host, agent)).toEqual(OPUS)
    await run(agent, 'second')
    expect(methodsOf(fake).slice(-2)).toEqual(['session/set_config_option', 'session/prompt'])
    expect(sets(fake)).toEqual([['model', 'claude-subscription/claude-opus-5-5']])
    expect(current(host, agent)).toEqual({ ...OPUS, reasoningEffort: 'low' })
  })

  it('sends a pick made while an earlier one is being sent, even one Casper then refuses, so the last pick wins', async () => {
    const fake = fakeCasper({ prompts: [] })
    cleanups.push(() => { fake.remove() })
    const holdModel = gate(fake, 'hold-model')
    const holdEffort = gate(fake, 'hold-effort')
    fake.script({
      configOptions: casperOptions(),
      holdSet: { model: holdModel.path, effort: holdEffort.path },
      setFails: { effort: 'high is not offered now' },
      prompts: [[{ text: 'one\n' }]],
    })
    const host = await boot(fake)
    cleanups.push(() => host.ctx.fiber.dispose())
    await cacheList(host)
    const { agent } = await host.create('casper-pick-twice')
    // In a turn: the second pick is sent after the first.
    await agent.model.own?.choose(OPUS)
    agent.followup(prompt('first'))
    await waitFor(() => sets(fake).length === 1)
    expect(await agent.model.own?.choose(SOL)).toEqual(SOL)
    expect(current(host, agent)).toEqual(SOL)
    holdModel.open()
    await agent.whenIdle()
    expect(methodsOf(fake)).toEqual(['session/new', 'session/set_config_option', 'session/set_config_option', 'session/prompt'])
    expect(sets(fake)).toEqual([['model', 'claude-subscription/claude-opus-5-5'], ['model', 'openai-codex/gpt-6.1-sol']])
    expect(current(host, agent)).toEqual({ ...SOL, reasoningEffort: 'auto' })
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
    // While idle: Casper refuses the first pick's effort, and the second pick replaces it.
    const first = agent.model.own?.choose({ ...OPUS, reasoningEffort: ReasoningEffortId('high') })
    await waitFor(() => sets(fake).length === 4)
    await agent.model.own?.choose(SOL)
    holdEffort.open()
    await first
    expect(sets(fake).slice(2)).toEqual([['model', 'claude-subscription/claude-opus-5-5'], ['effort', 'high'], ['model', 'openai-codex/gpt-6.1-sol']])
    expect(current(host, agent)).toEqual({ ...SOL, reasoningEffort: 'auto' })
    expect(fake.calls('session/prompt')).toHaveLength(1)
  })

  it('kills a Casper that never answers a pick when the user stops it, and sends the pick to the next Casper', async () => {
    const fake = fakeCasper({ prompts: [] })
    cleanups.push(() => { fake.remove() })
    const hold = gate(fake, 'hold-set')
    fake.script({ configOptions: casperOptions(), holdSet: { model: hold.path }, prompts: [[{ text: 'one\n' }], [{ text: 'two\n' }]] })
    const host = await boot(fake)
    cleanups.push(() => host.ctx.fiber.dispose())
    const { agent } = await host.create('casper-pick-hung')
    await run(agent, 'first')
    // Idle: the pick's own call fails, and Casper is killed.
    const [idlePid] = fake.pids()
    const idle = agent.model.own?.choose(OPUS).then(() => 'chosen', (error: unknown) => error)
    await waitFor(() => sets(fake).length === 1)
    agent.cancel({ kind: 'user' })
    expect(await idle).toMatchObject({ message: 'the model pick was stopped' })
    await waitFor(() => !alive(idlePid ?? 0))
    await agent.whenIdle()
    expect(current(host, agent)).toEqual(OPUS)
    // In a turn: the turn ends aborted with no prompt sent, and Casper is killed.
    agent.followup(prompt('second'))
    await waitFor(() => sets(fake).length === 2)
    const turnPid = fake.pids().at(-1)
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    await waitFor(() => !alive(turnPid ?? 0))
    expect(turnEnds(agent).at(-1)).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
    expect(promptTexts(fake)).toEqual(['first'])
    // Once Casper answers sets again, the next turn sends the pick first.
    hold.open()
    await run(agent, 'third')
    expect(sets(fake)).toHaveLength(3)
    expect(promptTexts(fake)).toEqual(['first', 'third'])
    expect(turnEnds(agent).at(-1)).toEqual({ kind: 'completed' })
    expect(current(host, agent)).toEqual({ ...OPUS, reasoningEffort: 'auto' })
  })

  it('ends the turn CASPER_MODEL_UNAVAILABLE without a prompt when Casper refuses a pick, and shows Casper\'s model again', async () => {
    const refusal = 'claude-subscription is signed out: run casper /login'
    const { fake, host } = await setup({ configOptions: casperOptions(), setFails: { model: refusal }, prompts: [[{ text: 'one\n' }], [{ text: 'two\n' }]] })
    await cacheList(host)
    const { agent } = await host.create('casper-pick-refused')
    await agent.model.own?.choose(OPUS)
    await run(agent, 'first')
    const message = `Casper can't use claude-subscription/claude-opus-5-5: ${refusal}. Pick another model.`
    expect(turnEnds(agent)).toEqual([{ kind: 'error', error: { code: 'CASPER_MODEL_UNAVAILABLE', message } }])
    expect(fake.calls('session/prompt')).toEqual([])
    expect(current(host, agent)).toEqual({ ...SOL, reasoningEffort: 'auto' })
    // Refused while idle, the pick's own call fails with the same words.
    await expect(agent.model.own?.choose(OPUS)).rejects.toMatchObject({ code: 'CASPER_MODEL_UNAVAILABLE', message })
    expect(current(host, agent)).toEqual({ ...SOL, reasoningEffort: 'auto' })
    await run(agent, 'second')
    expect(turnEnds(agent).at(-1)).toEqual({ kind: 'completed' })
    expect(promptTexts(fake)).toEqual(['second'])
  })

  it('keeps the list it showed for a Casper that offers no options, and refuses a pick it cannot send', async () => {
    const { fake, host } = await setup({ prompts: [[{ text: 'one\n' }], [{ text: 'two\n' }]] })
    await cacheList(host)
    const { agent } = await host.create('casper-pick-older')
    await agent.model.own?.choose(OPUS)
    await run(agent, 'first')
    expect(turnEnds(agent)).toEqual([{ kind: 'error', error: {
      code: 'CASPER_MODEL_UNAVAILABLE',
      message: 'Casper can\'t use claude-subscription/claude-opus-5-5: it is not one of the models this Casper offers. Pick another model.',
    } }])
    expect(view(host, agent)).toEqual({ ...reportOf(casperOptions()), started: false })
    await run(agent, 'second')
    expect(promptTexts(fake)).toEqual(['second'])
    expect(view(host, agent)).toEqual({ ...reportOf(casperOptions()), started: false })
  })

  it('reports a Casper exit during a pick as an exit, and keeps the list when it cannot be saved', async () => {
    const { fake, host } = await setup({ configOptions: casperOptions(), setExit: 3, prompts: [[{ text: 'one\n' }]] })
    const { agent } = await host.create('casper-pick-exit')
    const global = host.ctx.storageDomain.get('casper_agent_models')?.global
    if (global === undefined) throw new Error('model cache is not open')
    const set = vi.spyOn(global, 'set').mockRejectedValueOnce(new Error('disk full'))
    await run(agent, 'first')
    await waitFor(() => set.mock.calls.length === 1)
    set.mockRestore()
    await expect(agent.model.own?.choose(OPUS)).rejects.toMatchObject({ code: 'CASPER_EXITED' })
    expect(current(host, agent)).toEqual({ ...SOL, reasoningEffort: 'auto' })
    expect(fake.pids()).toHaveLength(1)
  })
})

describe('The access chip in a Casper session', { timeout: 60_000 }, () => {
  async function setupChip(script: FakeScript) {
    const fake = fakeCasper(script)
    cleanups.push(() => { fake.remove() })
    const host = await boot(fake, {}, undefined, true, mountPermissionPresets)
    cleanups.push(() => host.ctx.fiber.dispose())
    return { fake, host }
  }

  /** Pick a preset on the chip, as the app's `/permission` does. */
  function chip(host: { ctx: Context }, agent: Agent, preset: string): void {
    host.ctx.permissionPresets.set(agent.session, preset)
  }

  /** The access modes the app sent, through either set method. */
  function accessSets(fake: FakeCasper): unknown[] {
    return fake.log().flatMap((entry) => {
      if (entry.method === 'session/set_mode') return [entry.params?.modeId]
      if (entry.method === 'session/set_config_option' && entry.params?.configId === 'mode') return [entry.params.value]
      return []
    })
  }

  /** The methods Casper received after initialize, in order. */
  function methodsOf(fake: FakeCasper): string[] {
    return fake.log().flatMap(entry => entry.method === undefined || entry.method === 'initialize' ? [] : [entry.method])
  }

  function replyTexts(agent: Agent): string[] {
    return eventsOf(agent).flatMap(event => event.type === 'assistant/message'
      ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
      : [])
  }

  it('sends Read only before the first prompt and nothing more while the chip stays, and sends nothing for Workspace Write', async () => {
    const { fake, host } = await setupChip({ configOptions: casperOptions(), modes: casperModes(), prompts: [[{ text: 'one\n' }], [{ text: 'two\n' }]] })
    const { agent } = await host.create('casper-chip-read')
    chip(host, agent, 'read-only')
    await run(agent, 'first')
    expect(methodsOf(fake)).toEqual(['session/new', 'session/set_config_option', 'session/prompt'])
    expect(accessSets(fake)).toEqual(['read'])
    await run(agent, 'second')
    expect(accessSets(fake)).toEqual(['read'])
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }, { kind: 'completed' }])

    const other = await host.create('casper-chip-default')
    await run(other.agent, 'third')
    expect(accessSets(fake)).toEqual(['read'])
  })

  it('sends a chip switch to a running prompt at once, and a custom chip with a read-only sandbox as Read only', async () => {
    const fake = fakeCasper({ prompts: [] })
    cleanups.push(() => { fake.remove() })
    const hold = gate(fake, 'hold')
    fake.script({ configOptions: optionsWithoutMode(), modes: casperModes(), prompts: [[{ waitFile: hold.path }, { text: 'one\n' }]] })
    const host = await boot(fake, {}, undefined, true, mountPermissionPresets)
    cleanups.push(() => host.ctx.fiber.dispose())
    const { agent } = await host.create('casper-chip-live')
    agent.followup(prompt('first'))
    await waitFor(() => fake.calls('session/prompt').length === 1)
    chip(host, agent, 'danger-full-access')
    // Casper offers only modes here, so the switch goes as session/set_mode while the prompt runs.
    await waitFor(() => fake.calls('session/set_mode').length === 1)
    expect(accessSets(fake)).toEqual(['full'])
    expect(agent.status).toBe('running')
    hold.open()
    await agent.whenIdle()
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
    // Knobs that match no preset make the chip custom; its read-only sandbox is Read only, sent while Casper is idle.
    agent.session.append('sandbox/mode', { mode: 'read-only' })
    agent.session.append('approval/policy', { policy: 'never' })
    expect(host.ctx.permissionPresets.current(agent.session)).toBe('custom')
    await waitFor(() => accessSets(fake).length === 2)
    expect(accessSets(fake)).toEqual(['full', 'read'])
  })

  it('keeps a mode Casper picks itself without moving the chip, and restores only Read only', async () => {
    const { fake, host } = await setupChip({
      configOptions: casperOptions(),
      prompts: [[{ mode: 'full' }, { text: 'one\n' }], [{ text: 'two\n' }], [{ mode: 'ask' }, { text: 'three\n' }], [{ text: 'four\n' }]],
    })
    const { agent } = await host.create('casper-chip-own')
    await run(agent, 'first')
    // "Yes to everything this session" in Casper's own box: the chip stays, and nothing is sent back.
    expect(host.ctx.permissionPresets.current(agent.session)).toBe('workspace-write')
    await run(agent, 'second')
    expect(accessSets(fake)).toEqual([])
    chip(host, agent, 'read-only')
    await waitFor(() => accessSets(fake).length === 1)
    await run(agent, 'third')
    // Casper left Read only on its own, so the app set it again.
    await waitFor(() => accessSets(fake).length === 2)
    expect(accessSets(fake)).toEqual(['read', 'read'])
    await run(agent, 'fourth')
    expect(accessSets(fake)).toEqual(['read', 'read'])
    expect(turnEnds(agent).every(reason => (reason as { kind: string }).kind === 'completed')).toBe(true)
  })

  it('fails closed for Read only on a Casper without modes, and runs Workspace Write and a Full access note as usual', async () => {
    const { fake, host } = await setupChip({ prompts: [[{ text: 'one\n' }], [{ text: 'two\n' }]] })
    const { agent } = await host.create('casper-chip-older')
    await run(agent, 'first')
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
    chip(host, agent, 'read-only')
    await run(agent, 'second')
    expect(turnEnds(agent).at(-1)).toEqual({ kind: 'error', error: {
      code: 'CASPER_ACCESS_NOT_APPLIED',
      message: 'This Casper has no access modes, so Read only could not be set. Update Casper. Nothing was sent to Casper.',
    } })
    expect(promptTexts(fake)).toEqual(['first'])
    chip(host, agent, 'danger-full-access')
    await run(agent, 'third')
    expect(turnEnds(agent).at(-1)).toEqual({ kind: 'completed' })
    expect(promptTexts(fake)).toEqual(['first', 'third'])
    expect(replyTexts(agent).at(-1)).toBe(
      '[This Casper has no access modes, so Full access could not be set. Update Casper. Casper asks before changes as usual.]\ntwo\n\nReceipt: verified\n')
  })

  it('stops a running prompt when Read only cannot reach Casper, and leaves a note when Full access cannot', async () => {
    const fake = fakeCasper({ prompts: [] })
    cleanups.push(() => { fake.remove() })
    const hold = gate(fake, 'hold')
    fake.script({
      configOptions: casperOptions(), setFails: { mode: 'acp_access is off.' },
      prompts: [[{ waitFile: hold.path }, { text: 'one\n' }], [{ hang: true }]],
    })
    const host = await boot(fake, {}, undefined, true, mountPermissionPresets)
    cleanups.push(() => host.ctx.fiber.dispose())
    const { agent } = await host.create('casper-chip-refused')
    agent.followup(prompt('first'))
    await waitFor(() => fake.calls('session/prompt').length === 1)
    chip(host, agent, 'danger-full-access')
    // The note streams into the running reply.
    await waitFor(() => JSON.stringify(host.frames.filter(entry => entry.agent === agent).map(entry => entry.frame)).includes('Full access'))
    hold.open()
    await agent.whenIdle()
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
    expect(replyTexts(agent).join('')).toContain('[Casper did not switch to Full access: acp_access is off. Casper asks before changes as usual.]\n')
    agent.followup(prompt('second'))
    await waitFor(() => fake.calls('session/prompt').length === 2)
    chip(host, agent, 'read-only')
    await agent.whenIdle()
    expect(fake.calls('session/cancel')).toHaveLength(1)
    expect(turnEnds(agent).at(-1)).toEqual({ kind: 'error', error: {
      code: 'CASPER_ACCESS_NOT_APPLIED', message: 'Casper did not switch to Read only: acp_access is off. The request was stopped.',
    } })
    // The turn's start retried Full access, then the chip's Read only was refused mid-prompt.
    expect(accessSets(fake)).toEqual(['full', 'full', 'read'])
  })

  it('ends a turn whose chip switch fails while it prepares its prompt, and sends no prompt; Full access leaves a note', async () => {
    /** A Casper that takes pictures, a picture read the test releases, and a watch on the app's access sets. */
    async function preparing(script: FakeScript, id: string) {
      const held = heldPictureStore()
      const fake = fakeCasper({ ...script, promptCapabilities: { image: true } })
      cleanups.push(() => { fake.remove() })
      const host = await boot(fake, {}, undefined, true, async (ctx) => {
        await mountPermissionPresets(ctx)
        await ctx.plugin(held.store)
      })
      cleanups.push(() => host.ctx.fiber.dispose())
      const { agent } = await host.create(id)
      const setAccess = vi.spyOn(CasperConnection.prototype, 'setAccess')
      cleanups.push(() => { setAccess.mockRestore() })
      agent.followup(prompt('', `rpc-${id}`, [{ type: 'text', text: 'look' }, { type: 'image', attachment: PICTURE }]))
      await waitFor(() => held.reading())
      return { fake, host, agent, setAccess, release: held.release }
    }

    // A Casper without modes: Read only cannot be set while the picture is read.
    const older = await preparing({ prompts: [[{ text: 'edited\n' }]] }, 'casper-chip-preparing')
    chip(older.host, older.agent, 'read-only')
    await waitFor(() => older.setAccess.mock.settledResults.length === 1)
    older.release()
    await older.agent.whenIdle()
    expect(turnEnds(older.agent)).toEqual([{ kind: 'error', error: {
      code: 'CASPER_ACCESS_NOT_APPLIED',
      message: 'This Casper has no access modes, so Read only could not be set. Update Casper. Nothing was sent to Casper.',
    } }])
    expect(older.fake.calls('session/prompt')).toEqual([])
    older.setAccess.mockRestore()

    // A Casper that refuses Full access: the prompt runs with a note.
    const refusing = await preparing({ configOptions: casperOptions(), setFails: { mode: 'acp_access is off.' }, prompts: [[{ text: 'asked\n' }]] }, 'casper-chip-preparing-full')
    chip(refusing.host, refusing.agent, 'danger-full-access')
    await waitFor(() => refusing.setAccess.mock.settledResults.length === 1)
    refusing.release()
    await refusing.agent.whenIdle()
    expect(turnEnds(refusing.agent)).toEqual([{ kind: 'completed' }])
    expect(replyTexts(refusing.agent).at(-1)).toBe('[Casper did not switch to Full access: acp_access is off. Casper asks before changes as usual.]\nasked\n\nReceipt: verified\n')
  })

  it('ends the turn CASPER_EXITED when Casper exits on an access switch, and starts it again for the next prompt', async () => {
    const { fake, host } = await setupChip({ configOptions: casperOptions(), setExit: 3, prompts: [[{ text: 'one\n' }], [{ text: 'two\n' }]] })
    const { agent } = await host.create('casper-chip-exit')
    await run(agent, 'first')
    const [pid] = fake.pids()
    chip(host, agent, 'read-only')
    // The switch reaches the idle Casper at once, which exits on it.
    await waitFor(() => pid !== undefined && !alive(pid))
    await run(agent, 'second')
    expect(fake.pids()).toHaveLength(2)
    expect(turnEnds(agent).at(-1)).toMatchObject({ kind: 'error', error: { code: 'CASPER_EXITED' } })
    expect(accessSets(fake)).toEqual(['read', 'read'])
    expect(promptTexts(fake)).toEqual(['first'])
  })
})

describe('Casper\'s forms', { timeout: 60_000 }, () => {
  const DATABASES = [{ label: 'SQLite', description: 'one file' }, { label: 'Postgres' }]

  function replies(fake: FakeCasper): unknown[] {
    return fake.log().filter(entry => entry.event === 'elicitation').map(entry => entry.reply ?? { timedOut: entry.timedOut })
  }

  function results(agent: Agent): { isError: boolean; text: string }[] {
    return eventsOf(agent).flatMap(event => event.type === 'tool/result'
      ? [{ isError: event.data.message.isError === true, text: event.data.message.content.map(block => block.type === 'text' ? block.text : '').join('') }]
      : [])
  }

  it('an accepted form sends answer and other', async () => {
    const { fake, host } = await setup({ prompts: [[{ elicit: { question: 'Which database?', options: DATABASES, typed: true } }]] }, {},
      request => Promise.resolve({ answers: [{ id: request.questions[0]?.id ?? '', selected: ['Postgres'], custom: 'version 16' }] }))
    const { agent } = await host.create('casper-form-accept')
    await run(agent, 'set it up')
    expect(host.asked).toHaveLength(1)
    expect(host.asked[0]?.agent).toBe(agent)
    expect(host.asked[0]?.questions).toEqual([{
      id: 'casper-question', header: 'Casper asks', question: 'Which database?',
      options: [{ label: 'SQLite', description: 'one file' }, { label: 'Postgres' }], multiSelect: false,
    }])
    expect(replies(fake)).toEqual([{ action: 'accept', content: { answer: '2', other: 'version 16' } }])
    expect(results(agent)).toEqual([{ isError: false, text: JSON.stringify({ answers: [{ id: 'casper-question', selected: ['Postgres'], custom: 'version 16' }] }) }])
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
  })

  it('the AI\'s question is headed The AI asks', async () => {
    const { fake, host } = await setup({ prompts: [[{ elicit: { question: 'Which port?', from: 'ai', hint: 'A port number' } }]] }, {},
      request => Promise.resolve({ answers: [{ id: request.questions[0]?.id ?? '', selected: [], custom: '8080' }] }))
    const { agent } = await host.create('casper-form-ai')
    await run(agent, 'serve it')
    expect(host.asked[0]?.questions).toEqual([{ id: 'casper-question', header: 'The AI asks', question: 'Which port?' }])
    expect(replies(fake)).toEqual([{ action: 'accept', content: { answer: '8080' } }])
    const call = eventsOf(agent).find(event => event.type === 'tool/call')
    expect(call?.type === 'tool/call' && [call.data.name, parsed(call.data.arguments)]).toEqual([
      'ask_user_question', { questions: [{ id: 'casper-question', question: 'Which port?', options: [], multi_select: false }] },
    ])
  })

  it('the ask step is recorded once as ask_user_question', async () => {
    const asked = { question: 'Which databases?', options: DATABASES, multi: true }
    const { fake, host } = await setup({ prompts: [[
      { tool: 'ask', rawInput: asked, meta: { tool: 'ask' } },
      { elicit: { ...asked, from: 'ai', onStep: 1 } },
    ]] }, {}, request => Promise.resolve({ answers: [{ id: request.questions[0]?.id ?? '', selected: ['Postgres', 'SQLite'] }] }))
    const { agent } = await host.create('casper-form-ask-step')
    await run(agent, 'store it')
    expect(host.asked[0]?.questions[0]).toMatchObject({ header: 'The AI asks', multiSelect: true })
    expect(replies(fake)).toEqual([{ action: 'accept', content: { answer: ['2', '1'] } }])
    const calls = eventsOf(agent).flatMap(event => event.type === 'tool/call' ? [[event.data.name, parsed(event.data.arguments)]] : [])
    expect(calls).toEqual([[
      'ask_user_question',
      { questions: [{ id: 'casper-question', question: 'Which databases?', options: [{ label: 'SQLite', description: 'one file' }, { label: 'Postgres' }], multi_select: true }] },
    ]])
    expect(results(agent)).toEqual([{ isError: false, text: JSON.stringify({ answers: [{ id: 'casper-question', selected: ['Postgres', 'SQLite'] }] }) }])
  })

  it('Casper\'s final update closes an open card', async () => {
    const skipped = JSON.stringify({ answers: [], skipped: true, remaining: 7 })
    const aborted: string[] = []
    const fake = fakeCasper()
    cleanups.push(() => { fake.remove() })
    const shown = gate(fake, 'card-shown')
    const askStep = { tool: 'ask', rawInput: { question: 'Which database?', options: DATABASES }, meta: { tool: 'ask' } }
    const asked = { question: 'Which database?', options: DATABASES, from: 'ai', onStep: 1 }
    fake.script({ prompts: [
      [askStep, { elicit: asked, during: [{ waitFile: shown.path }, { toolEnd: 1, content: [skipped] }] }],
      // A form whose step Casper closed already, as when its close overtakes the request: no card opens.
      [askStep, { toolEnd: 2, content: [skipped] }, { elicit: { ...asked, onStep: 2 } }],
    ] })
    const host = await boot(fake, {}, request => new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => {
        aborted.push(request.questions[0]?.question ?? '')
        reject(new Error('aborted'))
      }, { once: true })
      shown.open()
    }))
    cleanups.push(() => host.ctx.fiber.dispose())
    const { agent } = await host.create('casper-form-closed')
    await run(agent, 'go')
    await run(agent, 'again')
    expect(host.asked).toHaveLength(1)
    expect(aborted).toEqual(['Which database?'])
    expect(replies(fake)).toEqual([{ action: 'cancel' }, { action: 'cancel' }])
    expect(results(agent)).toEqual([{ isError: false, text: skipped }, { isError: false, text: skipped }])
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }, { kind: 'completed' }])
  })

  it('cancels a form without a question service or outside a prompt, and a skipped question is not an error', async () => {
    const { fake, host } = await setup({ prompts: [[{ elicit: { question: 'Anyone there?', options: DATABASES } }, { text: 'done\n', late: { elicit: { question: 'Late?', options: DATABASES } } }]] },
      {}, undefined, false)
    const { agent } = await host.create('casper-form-no-service')
    await run(agent, 'go')
    await waitFor(() => replies(fake).length === 2)
    expect(replies(fake)).toEqual([{ action: 'cancel' }, { action: 'cancel' }])
    expect(results(agent)).toEqual([{ isError: false, text: '— skipped' }])
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
  })
})

describe('Plan review and Plan first', { timeout: 60_000 }, () => {
  const PLAN = '# Add a cache\n\n## Steps\n\n1. Cache the reads.\n'
  const PLAN_COMMAND: FakeCommand = { name: 'plan', description: 'Plan first, or plan one request', input: { hint: '[on|off|request]' } }

  /** A Host with the command registry, so `/plan` runs as a command. */
  async function setupPlan(script: FakeScript, answer?: Answer) {
    const fake = fakeCasper(script)
    cleanups.push(() => { fake.remove() })
    const host = await boot(fake, {}, answer, true, async (ctx) => { await ctx.plugin(CommandRuntime) })
    cleanups.push(() => host.ctx.fiber.dispose())
    const plan = await host.ctx.sessionProjections.register(planProjectionDefinition)
    /** What the composer's plan chip reads. */
    const chip = (agent: Agent) => planProjectionDefinition.wire.view(plan.stateOf(agent.session))
    const execute = async (agent: Agent, line: string) => {
      const executed = await host.ctx.commands.execute(agent, line, [], new AbortController().signal)
      return executed?.result
    }
    return { fake, host, chip, execute }
  }

  function modes(agent: Agent): unknown[] {
    return eventsOf(agent).flatMap(event => event.type === 'plan/mode' ? [event.data] : [])
  }

  function planSets(fake: FakeCasper): unknown[] {
    return fake.calls('session/set_config_option').flatMap(entry => entry.params?.configId === 'plan' ? [entry.params.value] : [])
  }

  function answers(fake: FakeCasper): unknown[] {
    return fake.log().filter(entry => entry.event === 'answer').map(entry => entry.outcome ?? entry.error)
  }

  it('a plan Build box is a plan review: Build builds, Discuss changes the plan, and a timeout stops', async () => {
    const replies = [
      (id: string) => Promise.resolve({ answers: [{ id, selected: ['Build'] }] }),
      () => Promise.reject(new UserQuestionError('dismissed to discuss', 'ASK_CANCELLED')),
      () => Promise.reject(new UserQuestionError('no answer in time', 'ASK_TIMED_OUT')),
    ]
    const { fake, host } = await setupPlan({ prompts: [[{ planBox: PLAN }], [{ planBox: PLAN }], [{ planBox: PLAN }]] },
      request => (replies.shift() ?? replies[0])?.(request.questions[0]?.id ?? '') ?? Promise.reject(new Error('unexpected')))
    const { agent } = await host.create('casper-plan-review')
    await run(agent, '/plan add a cache')
    const call = eventsOf(agent).find(event => event.type === 'tool/call')
    expect(call?.type === 'tool/call' && [call.data.name, parsed(call.data.arguments)]).toEqual(['exit_plan_mode', { plan: PLAN }])
    expect(host.asked[0]?.questions).toEqual([{
      id: 'casper-permission',
      header: 'Plan review',
      question: 'Build this plan?',
      detail: PLAN,
      options: [
        { label: 'Build', description: 'the model builds these steps and tests these cases' },
        { label: 'Change the plan', description: 'tell the model what to change, then choose again' },
      ],
      multiSelect: false,
      intent: { kind: 'plan-review', approve: 'Build', callId: call?.type === 'tool/call' ? call.data.callId : undefined },
    }])
    await run(agent, 'again')
    await run(agent, 'once more')
    expect(answers(fake)).toEqual([
      { outcome: 'selected', optionId: '2' },
      { outcome: 'selected', optionId: '3' },
      { outcome: 'cancelled' },
    ])
    const results = eventsOf(agent).flatMap(event => event.type === 'tool/result' ? [[event.data.message.isError, event.data.message.content]] : [])
    expect(results).toEqual([
      [false, [{ type: 'text', text: '→ Build' }]],
      [false, [{ type: 'text', text: '→ Change the plan' }]],
      [false, [{ type: 'text', text: '→ No (no answer)' }]],
    ])
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }, { kind: 'completed' }, { kind: 'completed' }])
  })

  it('Casper\'s plan option going on sets plan mode active and the chip shows it', async () => {
    const { host, chip } = await setupPlan({
      configOptions: withPlan('off'),
      prompts: [[{ text: 'one\n' }], [{ configUpdate: withPlan('on') }, { text: 'Plan first is on.\n' }], [{ text: 'three\n' }]],
    })
    const { agent } = await host.create('casper-plan-option')
    await run(agent, 'one')
    expect(modes(agent)).toEqual([])
    expect(chip(agent)).toEqual({ active: false, pending: false })
    await run(agent, '/plan on')
    expect(modes(agent)).toEqual([{ active: true }])
    expect(chip(agent)).toEqual({ active: true, pending: false })
    await run(agent, 'three')
    expect(modes(agent)).toEqual([{ active: true }])
  })

  it('slash plan off sets the option and sends no prompt', async () => {
    const { fake, host, chip, execute } = await setupPlan({ commands: [PLAN_COMMAND], configOptions: withPlan('on'), prompts: [[{ text: 'one\n' }]] })
    const { agent } = await host.create('casper-plan-off')
    await run(agent, 'one')
    expect(chip(agent)).toEqual({ active: true, pending: false })
    // The plan chip's exit runs /plan off.
    expect(await execute(agent, '/plan off')).toEqual({ kind: 'success', text: 'Plan first off.' })
    expect(chip(agent)).toEqual({ active: false, pending: false })
    expect(await execute(agent, '/plan  on ')).toEqual({ kind: 'success', text: 'Plan first on: every request gets a plan first.' })
    expect(chip(agent)).toEqual({ active: true, pending: false })
    expect(planSets(fake)).toEqual(['off', 'on'])
    expect(modes(agent)).toEqual([{ active: true }, { active: false }, { active: true }])
    expect(promptTexts(fake)).toEqual(['one'])
  })

  it('bare slash plan and slash plan with words leave the chip inactive after the turn', async () => {
    const { fake, host, chip, execute } = await setupPlan({
      commands: [PLAN_COMMAND], configOptions: withPlan('off'), prompts: [[{ text: 'one\n' }], [{ planBox: PLAN }], [{ text: 'planned\n' }]],
    }, request => Promise.reject(new UserQuestionError(`${request.questions.length} unanswered`, 'ASK_TIMED_OUT')))
    const { agent } = await host.create('casper-plan-once')
    await run(agent, 'one')
    expect(await execute(agent, '/plan')).toEqual({ kind: 'success' })
    // Until Casper's turn ends, the chip shows the /plan the user chose.
    expect(chip(agent)).toEqual({ active: false, pending: true })
    await waitFor(() => fake.calls('session/prompt').length === 2)
    await agent.whenIdle()
    expect(chip(agent)).toEqual({ active: false, pending: false })
    expect(await execute(agent, '/plan add a cache')).toEqual({ kind: 'success' })
    await waitFor(() => fake.calls('session/prompt').length === 3)
    await agent.whenIdle()
    expect(chip(agent)).toEqual({ active: false, pending: false })
    expect(promptTexts(fake)).toEqual(['one', '/plan', '/plan add a cache'])
    expect(planSets(fake)).toEqual([])
    expect(modes(agent)).toEqual([{ active: false }, { active: false }])
  })

  it('a restarted Casper gets the Session\'s Plan first setting before the prompt', async () => {
    const { fake, host, chip } = await setupPlan({
      configOptions: withPlan('off'), replayConfig: true, newSessionId: 'conversation-plan',
      prompts: [[{ configUpdate: withPlan('on') }, { text: 'on\n' }], [{ crash: 9 }], [{ text: 'planned\n' }]],
    })
    const { agent } = await host.create('casper-plan-restart')
    await run(agent, '/plan on')
    await run(agent, 'crash')
    expect(turnEnds(agent)[1]).toMatchObject({ kind: 'error', error: { code: 'CASPER_EXITED' } })
    await run(agent, 'next')
    expect(fake.calls('session/load').map(entry => entry.params?.sessionId)).toEqual(['conversation-plan'])
    const order = fake.log().filter(entry => entry.method === 'session/set_config_option' || entry.method === 'session/prompt').map(entry => entry.method)
    expect(order).toEqual(['session/prompt', 'session/prompt', 'session/set_config_option', 'session/prompt'])
    expect(planSets(fake)).toEqual(['on'])
    expect(chip(agent)).toEqual({ active: true, pending: false })
    expect(modes(agent)).toEqual([{ active: true }])
    // Turned off, then restarted on a Casper whose own default is on: it is turned off again.
    fake.script({
      configOptions: withPlan('on'), replayConfig: true,
      prompts: [[], [], [], [{ configUpdate: withPlan('off') }, { text: 'off\n' }], [{ crash: 9 }], [{ text: 'still off\n' }]],
    })
    // The next prompt starts a Casper that reads the new script.
    if (!(agent instanceof CasperAgent)) throw new Error('not a Casper agent')
    await agent.closeConnection()
    await run(agent, '/plan off')
    await run(agent, 'crash')
    await run(agent, 'last')
    expect(planSets(fake)).toEqual(['on', 'off'])
    expect(chip(agent)).toEqual({ active: false, pending: false })
    expect(modes(agent)).toEqual([{ active: true }, { active: false }])
  })

  it('a Casper that refuses Plan first keeps its own value, and slash plan reaches a stopped Casper as a prompt', async () => {
    const { fake, host, chip, execute } = await setupPlan({
      commands: [PLAN_COMMAND], configOptions: withPlan('off'), setFails: { plan: 'Plan first is busy.' },
      prompts: [[{ configUpdate: withPlan('on') }, { text: 'on\n' }], [{ crash: 9 }], [{ text: 'not restored\n' }]],
    })
    const { agent } = await host.create('casper-plan-refused')
    await run(agent, 'one')
    expect(chip(agent)).toEqual({ active: true, pending: false })
    expect(await execute(agent, '/plan off')).toEqual({ kind: 'error', text: 'Casper did not turn Plan first off: Plan first is busy.' })
    expect(chip(agent)).toEqual({ active: true, pending: false })
    await run(agent, 'crash')
    // The Casper that ran it has exited, so the line goes to the next Casper as a prompt.
    expect(await execute(agent, '/plan on')).toEqual({ kind: 'success' })
    await waitFor(() => fake.calls('session/prompt').length === 3)
    await agent.whenIdle()
    expect(promptTexts(fake)).toEqual(['one', 'crash', '/plan on'])
    expect(planSets(fake)).toEqual(['off', 'on'])
    expect(turnEnds(agent).at(-1)).toEqual({ kind: 'completed' })
    expect(chip(agent)).toEqual({ active: false, pending: false })
  })

  it('a stop while a restarted Casper takes Plan first kills it and sends no prompt', async () => {
    const fake = fakeCasper({ prompts: [] })
    cleanups.push(() => { fake.remove() })
    const hold = gate(fake, 'hold-plan')
    fake.script({
      configOptions: withPlan('off'), holdSet: { plan: hold.path },
      prompts: [[{ configUpdate: withPlan('on') }, { text: 'on\n' }], [{ crash: 9 }], [{ text: 'restored\n' }]],
    })
    const host = await boot(fake)
    cleanups.push(() => host.ctx.fiber.dispose())
    const plan = await host.ctx.sessionProjections.register(planProjectionDefinition)
    const { agent } = await host.create('casper-plan-stop')
    await run(agent, 'one')
    await run(agent, 'crash')
    agent.followup(prompt('next'))
    await waitFor(() => planSets(fake).length === 1)
    const pid = fake.pids().at(-1)
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    await waitFor(() => !alive(pid ?? 0))
    expect(turnEnds(agent).at(-1)).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
    expect(promptTexts(fake)).toEqual(['one', 'crash'])
    // The killed Casper's own default is not recorded, so the next Casper gets Plan first again.
    expect(modes(agent)).toEqual([{ active: true }])
    expect(planProjectionDefinition.wire.view(plan.stateOf(agent.session))).toEqual({ active: true, pending: false })
    hold.open()
    await run(agent, 'last')
    expect(planSets(fake)).toEqual(['on', 'on'])
    expect(promptTexts(fake)).toEqual(['one', 'crash', 'last'])
    expect(modes(agent)).toEqual([{ active: true }])
  })

  it('a restarted Casper whose model pick fails gets Plan first on its next turn, and a slash plan off before then is kept', async () => {
    const refusal = 'claude-subscription is signed out: run casper /login'
    const opus = { provider: 'claude-subscription', model: 'claude-opus-5-5' }
    const { fake, host, chip, execute } = await setupPlan({
      commands: [PLAN_COMMAND], configOptions: withPlan('off'), setFails: { model: refusal },
      prompts: [[{ configUpdate: withPlan('on') }, { text: 'on\n' }], [{ crash: 9 }], [{ text: 'restored\n' }], [{ crash: 9 }], [{ text: 'kept\n' }]],
    })
    const { agent } = await host.create('casper-plan-pick')
    await run(agent, 'one')
    await run(agent, 'crash')
    // Chosen while no Casper runs, the pick is applied by the next turn, which Casper refuses.
    await agent.model.own?.choose(opus)
    await run(agent, 'next')
    expect(turnEnds(agent).at(-1)).toMatchObject({ kind: 'error', error: { code: 'CASPER_MODEL_UNAVAILABLE' } })
    expect(modes(agent)).toEqual([{ active: true }])
    expect(chip(agent)).toEqual({ active: true, pending: false })
    await run(agent, 'again')
    expect(planSets(fake)).toEqual(['on'])
    expect(promptTexts(fake)).toEqual(['one', 'crash', 'again'])
    expect(chip(agent)).toEqual({ active: true, pending: false })
    // Again restarted with a refused pick; the user turns Plan first off before the next prompt.
    await run(agent, 'crash')
    await agent.model.own?.choose(opus)
    await run(agent, 'next')
    expect(await execute(agent, '/plan off')).toEqual({ kind: 'success', text: 'Plan first off.' })
    expect(chip(agent)).toEqual({ active: false, pending: false })
    await run(agent, 'last')
    expect(planSets(fake)).toEqual(['on', 'off'])
    expect(promptTexts(fake)).toEqual(['one', 'crash', 'again', 'crash', 'last'])
    expect(chip(agent)).toEqual({ active: false, pending: false })
    expect(modes(agent)).toEqual([{ active: true }, { active: false }])
  })

  it('a Casper without Plan first sends slash plan as a prompt and never moves the chip', async () => {
    const { fake, host, chip, execute } = await setupPlan({
      commands: [PLAN_COMMAND], prompts: [[{ text: 'one\n' }], [{ text: 'planned\n' }], [{ text: 'on\n' }]],
    })
    const { agent } = await host.create('casper-plan-older')
    await run(agent, 'one')
    for (const [line, prompts] of [['/plan add a cache', 2], ['/plan on', 3]] as const) {
      expect(await execute(agent, line)).toEqual({ kind: 'success' })
      await waitFor(() => fake.calls('session/prompt').length === prompts)
      await agent.whenIdle()
      expect(chip(agent)).toEqual({ active: false, pending: false })
    }
    expect(promptTexts(fake)).toEqual(['one', '/plan add a cache', '/plan on'])
    expect(planSets(fake)).toEqual([])
  })
})

describe('Casper\'s approval card', () => {
  const FILE = '/work/project/sum.js'

  it('a box a running step raises is headed Casper and shows the step\'s diff lines', async () => {
    const { fake, host } = await setup({ prompts: [[
      { tool: 'edit', kind: 'edit', rawInput: { path: 'sum.js', edits: [{ oldText: 'a - b', newText: 'a + b' }] }, meta: { tool: 'edit', target: 'sum.js' } },
      {
        permission: 'Change sum.js outside the project?', preview: 'The AI wants to change sum.js.', onStep: 1, locations: [{ path: FILE }],
        diffs: [{ path: FILE, oldText: 'return a - b\n', newText: 'return a + b\n' }],
      },
      { toolEnd: 1 },
    ]] })
    const { agent } = await host.create('casper-card-diff')
    await run(agent, 'fix it')
    expect(host.asked[0]?.questions).toEqual([{
      id: 'casper-permission',
      header: 'Casper',
      question: 'Change sum.js outside the project?',
      detail: `The AI wants to change sum.js.\n\n${FILE}\n- return a - b\n+ return a + b`,
      options: [{ label: 'No' }, { label: 'Yes, this once' }, { label: 'Yes for this session' }],
      multiSelect: false,
    }])
    expect(fake.log().filter(entry => entry.event === 'answer').map(entry => entry.outcome)).toEqual([{ outcome: 'selected', optionId: '2' }])
    // approvalCard off asks the same box on the generic question card.
    const generic = await setup({ prompts: [[{ permission: 'Run it?' }]] }, { approvalCard: false })
    await run((await generic.host.create('casper-card-off')).agent, 'go')
    expect(generic.host.asked[0]?.questions[0]?.header).toBeUndefined()
  })

  it('Casper closing a box withdraws the card and answers cancelled', async () => {
    let withdrawn: boolean | undefined
    const { fake, host } = await setup({ prompts: [[{ permission: 'Run it?', during: [{ withdraw: true }] }, { text: 'done\n' }]] },
      {}, request => new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => {
          withdrawn = true
          reject(new UserQuestionError('ASK_ABORTED', 'withdrawn'))
        }, { once: true })
      }))
    const { agent } = await host.create('casper-card-withdrawn')
    await run(agent, 'go')
    expect(host.asked).toHaveLength(1)
    expect(withdrawn).toBe(true)
    expect(fake.log().filter(entry => entry.event === 'answer').map(entry => [entry.outcome, entry.withdrawn]))
      .toEqual([[{ outcome: 'cancelled' }, true]])
    const result = eventsOf(agent).find(event => event.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.content).toEqual([{ type: 'text', text: '→ No (access set to Read only)' }])
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
  })
})

describe('Casper\'s usage and receipt', { timeout: 60_000 }, () => {
  /** The token-meter's folds the composer's context ring and token pill read. */
  function meters(agent: Agent) {
    let usage: Parameters<typeof tokenUsageProjectionDefinition.apply>[0] = tokenUsageProjectionDefinition.init()
    let pressure: Parameters<typeof contextPressureProjectionDefinition.apply>[0] = contextPressureProjectionDefinition.init()
    for (const event of eventsOf(agent)) {
      usage = tokenUsageProjectionDefinition.apply(usage, event)
      pressure = contextPressureProjectionDefinition.apply(pressure, event)
    }
    return { pill: tokenUsageProjectionDefinition.wire.view(usage), ring: contextPressureProjectionDefinition.wire.view(pressure) }
  }

  function contexts(agent: Agent): unknown[] {
    return eventsOf(agent).flatMap(event => event.type === 'request/context' ? [event.data] : [])
  }

  it('usage_update feeds the ring and the pill', async () => {
    const { host } = await setup({ prompts: [[
      { text: 'Looking.\n', usage: { input: 1000, cacheRead: 500, cacheWrite: 0, output: 100, tokens: 1600, toolUse: true, cost: 0.02, costKind: 'estimate' } },
      { tool: 'bash', target: 'ls' },
      { toolEnd: 1 },
      { text: 'Done.\n', usage: { input: 200, cacheRead: 1500, cacheWrite: 0, output: 50, tokens: 1750 } },
    ]] })
    const { agent } = await host.create('casper-usage')
    await run(agent, 'go')
    const messages = eventsOf(agent).flatMap(event => event.type === 'assistant/message'
      ? [[event.data.step, event.data.message.content.map(block => block.type), event.data.usage]]
      : [])
    expect(messages).toEqual([
      [1, ['text', 'tool-call'], { inputTokens: 1000, outputTokens: 100, totalTokens: 1600, cacheReadTokens: 500, cacheWriteTokens: 0 }],
      [2, ['text'], { inputTokens: 200, outputTokens: 50, totalTokens: 1750, cacheReadTokens: 1500, cacheWriteTokens: 0 }],
      // An older Casper's receipt is text, after the committed answer.
      [3, ['text'], undefined],
    ])
    expect(contexts(agent)).toEqual([{ provider: 'casper', model: 'openai/gpt-5', contextWindow: 200_000 }])
    const { pill, ring } = meters(agent)
    expect(pill).toEqual({ uncachedInputTokens: 1200, outputTokens: 150, cacheReadTokens: 2000, cacheWriteTokens: 0 })
    expect(ring).toMatchObject({ contextWindow: 200_000, pressureTokens: 1700 })
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
  })

  it('request/context is appended once with provider casper and again after a model change, never after a reload', async () => {
    const opus = { provider: 'anthropic', model: 'claude-opus-5-5' }
    const fake = fakeCasper({
      newSessionId: 'conversation-usage',
      prompts: [
        [{ text: 'a\n', usage: { input: 10, output: 1 } }, { text: 'b\n', usage: { input: 20, output: 2 } }],
        [{ text: 'c\n', usage: { input: 30, output: 3, ...opus } }, { text: 'd\n', usage: { input: 40, output: 4, ...opus, size: 0 } }],
        [{ text: 'e\n', usage: { input: 50, output: 5, ...opus } }, { text: 'f\n', usage: { output: 6, tokens: 66, provider: null, model: null, size: 1000 } }],
      ],
    })
    cleanups.push(() => { fake.remove() })
    const first = await boot(fake)
    const { agent } = await first.create('casper-usage-context')
    await run(agent, 'one')
    await run(agent, 'two')
    expect(contexts(agent)).toEqual([
      { provider: 'casper', model: 'openai/gpt-5', contextWindow: 200_000 },
      { provider: 'casper', model: 'anthropic/claude-opus-5-5', contextWindow: 200_000 },
    ])
    // A window of 0 is not a window: the response's tokens still count.
    const last = eventsOf(agent).filter(event => event.type === 'assistant/message').at(-2)
    expect(last?.type === 'assistant/message' && last.data.usage).toEqual({ inputTokens: 40, outputTokens: 4 })
    await first.ctx.fiber.dispose()

    const second = await boot(fake)
    cleanups.push(() => second.ctx.fiber.dispose())
    const resumed = (await second.ctx.agents.resume({ resumeSessionId: SessionId('casper-usage-context'), agentPreset: 'casper' })).agent
    await run(resumed, 'three')
    expect(fake.calls('session/load')).toHaveLength(1)
    // A response without input and output counts still gives its window, and no tokens.
    const final = eventsOf(resumed).filter(event => event.type === 'assistant/message').at(-1)
    expect(final?.type === 'assistant/message' && [final.data.message.content, final.data.usage]).toEqual([[{ type: 'text', text: 'f\n\nReceipt: verified\n' }], undefined])
    // The same model and window after the reload add nothing; a Casper that names no model is labelled as its messages are.
    expect(contexts(resumed)).toEqual([
      { provider: 'casper', model: 'openai/gpt-5', contextWindow: 200_000 },
      { provider: 'casper', model: 'anthropic/claude-opus-5-5', contextWindow: 200_000 },
      { provider: 'casper', model: 'casper', contextWindow: 1000 },
    ])
  })

  it('the receipt chunk is a casper_receipt card', async () => {
    const { fake, host } = await setup({ prompts: [[
      { text: 'Done.\n', usage: { input: 10, output: 2, toolUse: false } },
      { note: '[memory] saved: the tests use vitest' },
      { fullReceipt: {
        verdict: 'Verified: 1 check passed.', changed: ['src/a.ts'], text: 'Verified: 1 check passed.\nChanged: src/a.ts',
        checksRun: [{ name: 'test', status: 'pass', command: 'npm test', exit: 0, ms: 12, fresh: true }],
        checksNotRun: [{ name: 'lint', reason: 'not configured' }],
        usage: { turns: 1, tokens: 12, estimatedCost: 0.001 }, cost: 'estimate',
      } },
    ]] })
    const { agent } = await host.create('casper-receipt-card')
    await run(agent, 'go')
    const texts = eventsOf(agent).flatMap(event => event.type === 'assistant/message'
      ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
      : [])
    // The note is text of its own step; the receipt's words are the card's, never a message.
    expect(texts).toEqual(['Done.\n', '\n\n[memory] saved: the tests use vitest\n'])
    const call = eventsOf(agent).find(event => event.type === 'tool/call')
    expect(call?.type === 'tool/call' && [call.data.name, call.data.arguments]).toEqual(['casper_receipt', JSON.stringify({ verdict: 'Verified: 1 check passed.' })])
    const result = eventsOf(agent).find(event => event.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.content).toEqual([{ type: 'text', text: 'Verified: 1 check passed.\nChanged: src/a.ts' }])
    expect(result?.type === 'tool/result' && result.data.meta).toEqual({
      outcome: 'verified', verdict: 'Verified: 1 check passed.', exitCode: 0, changed: ['src/a.ts'],
      checksRun: [{ name: 'test', status: 'pass', command: 'npm test', exit: 0, ms: 12, fresh: true }],
      checksNotRun: [{ name: 'lint', reason: 'not configured' }],
      text: 'Verified: 1 check passed.\nChanged: src/a.ts', usage: { turns: 1, tokens: 12, estimatedCost: 0.001 }, cost: 'estimate', root: fake.cwd,
    })
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
  })

  it('malformed receipt meta is plain text', async () => {
    const { host } = await setup({ prompts: [[{ text: 'Done.\n' }, { fullReceipt: { exitCode: 'zero' } }]] })
    const { agent } = await host.create('casper-receipt-bad')
    await run(agent, 'go')
    expect(eventsOf(agent).some(event => event.type === 'tool/call')).toBe(false)
    const final = eventsOf(agent).filter(event => event.type === 'assistant/message').at(-1)
    expect(final?.type === 'assistant/message' && final.data.message.content).toEqual([{ type: 'text', text: 'Done.\n\n\nReceipt: verified\n' }])
  })
})

describe('Settings MCP servers in a Casper session', { timeout: 60_000 }, () => {
  const SECRET = 'docs-forwarded-secret'
  type Entry = ForwardEntry
  /** A stdio Settings entry whose credential the stand-in provider resolves. */
  const docs = (args: string[] = []): Entry => ({
    transport: 'stdio', command: process.execPath, args, env: { DOCS_TOKEN: '${credential:DOCS_TOKEN}' }, cwd: '', url: '', headers: {}, enabled: true,
  })

  /** The stand-in provider: only DOCS_TOKEN is set. */
  const stored = (ref: string) => Promise.resolve(ref === 'DOCS_TOKEN' ? { value: SECRET, source: 'test' } : undefined)

  /**
   * Boot with a stand-in MCP manager over `entries` and a credentials provider; `network` also mounts the
   * bundled-style row, and `resolve` replaces the provider's lookup.
   */
  async function withServers(
    script: FakeScript, entries: Record<string, Entry>, overrides: Overrides = {}, network = false, resolve = stored,
  ) {
    const fake = fakeCasper(script)
    cleanups.push(() => { fake.remove() })
    const host = await boot(fake, overrides, undefined, true, async (ctx) => {
      ctx.provide('mcpManager', { config: { servers: { get: () => entries } } } as never)
      ctx.provide('credentials', { resolve: (ref: string) => resolve(ref) } as never)
      // A row of its own, as the shipped network server is: never one of the Settings servers.
      if (network) {
        await ctx.plugin(McpClient, {
          transport: 'stdio', serverName: 'network', command: process.execPath, args: ['-e', ''], reconnect: { enabled: false },
        } as never)
      }
    })
    cleanups.push(() => host.ctx.fiber.dispose())
    return { fake, host }
  }

  /** The server names of every `session/new` and `session/load`, in order. */
  function offered(fake: FakeCasper): { method: string | undefined; pid: number; names: string[] }[] {
    return fake.log().filter(entry => entry.method === 'session/new' || entry.method === 'session/load').map(entry => ({
      method: entry.method, pid: entry.pid, names: ((entry.params?.['mcpServers'] ?? []) as { name: string }[]).map(server => server.name),
    }))
  }

  it('forwardMcpServers false sends the bridge only', async () => {
    const off = { appTools: true, forwardMcpServers: false }
    const { fake, host } = await withServers({ prompts: [[]], mcpHttp: true }, { docs: docs() }, off)
    const { agent } = await host.create('casper-forward-off')
    await run(agent, 'hi')
    expect(offered(fake)).toEqual([{ method: 'session/new', pid: fake.pids()[0], names: ['app'] }])
  })

  it('a Settings server reaches session/new and the bundled network row does not', async () => {
    const { fake, host } = await withServers({ prompts: [[]], mcpHttp: true }, { docs: docs(['docs-server.js']) }, {}, true)
    const { agent } = await host.create('casper-forward-docs')
    await run(agent, 'hi')
    const opened = fake.calls('session/new')[0]
    expect(opened?.params?.['mcpServers']).toEqual([{ name: 'docs', command: process.execPath, args: ['docs-server.js'], env: [{ name: 'DOCS_TOKEN', value: SECRET }] }])
    expect(opened?.exposed).toEqual({ argv: false, env: false })
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
    // The credential reaches Casper only inside the ACP request, never the Session log.
    expect(filesText(join(fake.root, 'sessions'))).not.toContain(SECRET)
  })

  it('a changed Settings entry reopens through session/load between turns, never during a prompt', async () => {
    const entries: Record<string, Entry> = { docs: docs(['v1.js']) }
    const { fake, host } = await withServers({ prompts: [] }, entries)
    const midPrompt = gate(fake, 'mid-prompt')
    fake.script({ prompts: [[{ waitFile: midPrompt.path }], [], []], mcpHttp: true })
    const { agent } = await host.create('casper-forward-change')
    agent.followup(prompt('first'))
    await waitFor(() => fake.calls('session/prompt').length === 1)
    // Changed while the prompt runs: the running Casper keeps going on its list.
    entries.docs = docs(['v2.js'])
    midPrompt.open()
    await agent.whenIdle()
    expect(fake.pids()).toHaveLength(1)
    expect(offered(fake).map(entry => entry.method)).toEqual(['session/new'])
    await run(agent, 'second')
    const [first, second] = fake.pids()
    expect(second).toBeDefined()
    await waitFor(() => !alive(first ?? 0))
    const reopened = fake.calls('session/load')
    expect(reopened).toHaveLength(1)
    expect(reopened[0]?.pid).toBe(second)
    expect(reopened[0]?.params?.['mcpServers']).toMatchObject([{ name: 'docs', args: ['v2.js'] }])
    expect(fake.calls('session/prompt').map(entry => entry.pid)).toEqual([first, second])
    // An unchanged list keeps the live Casper.
    await run(agent, 'third')
    expect(fake.pids()).toEqual([first, second])
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }, { kind: 'completed' }, { kind: 'completed' }])
  })

  it('a handed server whose credential cannot be read for one turn keeps the live Casper', async () => {
    let failing = false
    const resolve = (ref: string) => failing ? Promise.reject(new Error('keychain busy')) : stored(ref)
    const { fake, host } = await withServers({ prompts: [[], [], []], mcpHttp: true }, { docs: docs() }, {}, false, resolve)
    const { agent } = await host.create('casper-forward-passing')
    await run(agent, 'first')
    failing = true
    await run(agent, 'second')
    failing = false
    await run(agent, 'third')
    // Neither the failing turn nor the recovered one restarts Casper, and it keeps the server it was handed.
    expect(fake.pids()).toHaveLength(1)
    expect(offered(fake)).toEqual([{ method: 'session/new', pid: fake.pids()[0], names: ['docs'] }])
    expect(fake.calls('session/prompt').map(entry => entry.pid)).toEqual([fake.pids()[0], fake.pids()[0], fake.pids()[0]])
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }, { kind: 'completed' }, { kind: 'completed' }])
  })
})

describe('Session mentions in a Casper session', { timeout: 60_000 }, () => {
  /** The query engine over the Host's live and saved Sessions, without search. */
  class StandInQuery extends SessionQueryEngine {
    override searchSessions(): ReturnType<SessionQueryEngine['searchSessions']> {
      return Promise.resolve({ items: [] })
    }

    override searchEvents(...args: Parameters<SessionQueryEngine['searchEvents']>): ReturnType<SessionQueryEngine['searchEvents']> {
      return this.readSurface(args[0].sessionId).then(surface => ({ session: surface.session, items: [] }))
    }
  }

  /** A Host with the session-reference service, as the app mounts it. */
  async function withReferences(script: FakeScript) {
    const fake = fakeCasper(script)
    cleanups.push(() => { fake.remove() })
    const host = await boot(fake, {}, undefined, true, async (ctx) => {
      await ctx.plugin(StandInQuery)
      await ctx.plugin(SessionReferenceResolver)
    })
    cleanups.push(() => host.ctx.fiber.dispose())
    return { fake, host }
  }

  /** A mention of a Session as the composer inserts it. */
  const mention = (id: string, label = id) => formatSessionReferenceMention({ sessionId: SessionId(id), label })

  /** The blocks of each prompt Casper received. */
  function prompts(fake: FakeCasper): unknown[][] {
    return fake.calls('session/prompt').map(entry => entry.params?.prompt ?? [])
  }

  /** The context resource of a prompt's blocks, if any. */
  function resourceOf(blocks: unknown[]): { uri: string; mimeType: string; text: string } | undefined {
    const found = blocks.find((block): block is { type: 'resource'; resource: { uri: string; mimeType: string; text: string } } =>
      (block as { type?: string }).type === 'resource')
    return found?.resource
  }

  it('the prompt carries the other session\'s text and the log keeps the raw mention', async () => {
    const { fake, host } = await withReferences({ prompts: [[{ text: 'The cache key is the path.\n' }], [{ text: 'Fixed.\n' }]], promptCapabilities: { embeddedContext: true } })
    const other = await host.create('casper-ref-source')
    await run(other.agent, 'why does the cache miss?')
    const { agent } = await host.create('casper-ref-target')
    const typed = `look at ${mention('casper-ref-source', 'Cache chat')} and fix it`
    await run(agent, typed)
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
    const blocks = prompts(fake)[1] ?? []
    expect(blocks[0]).toEqual({ type: 'text', text: 'look at @Cache chat and fix it' })
    const resource = resourceOf(blocks)
    expect(resource).toMatchObject({ uri: encodeSessionReferenceUri(SessionId('casper-ref-source')), mimeType: 'text/markdown' })
    expect(resource?.text).toContain('## Referenced sessions')
    expect(resource?.text).toContain('why does the cache miss?')
    expect(resource?.text).toContain('The cache key is the path.')
    expect(blocks).toHaveLength(2)
    // The Session log keeps what the user typed.
    const logged = eventsOf(agent).find(event => event.type === 'user/message')
    expect(logged?.type === 'user/message' && logged.data.content).toEqual([{ type: 'text', text: typed }])
  })

  it('an older Casper gets the other session as a text block', async () => {
    const { fake, host } = await withReferences({ prompts: [[{ text: 'Noted.\n' }], [{ text: 'ok\n' }]] })
    await run((await host.create('casper-ref-old-source')).agent, 'the first chat')
    const { agent } = await host.create('casper-ref-old-target')
    await run(agent, `continue ${mention('casper-ref-old-source', 'First')}`)
    const blocks = prompts(fake)[1] as { type: string; text?: string }[]
    expect(blocks.map(block => block.type)).toEqual(['text', 'text'])
    expect(blocks[0]?.text).toBe('continue @First')
    expect(blocks[1]?.text).toContain('the first chat')
  })

  it('a self mention ends the turn with its code and starts no Casper', async () => {
    const { fake, host } = await withReferences({ prompts: [] })
    const { agent } = await host.create('casper-ref-self')
    await run(agent, `as said in ${mention('casper-ref-self')}`)
    expect(turnEnds(agent)).toEqual([{ kind: 'error', error: {
      code: 'SESSION_REFERENCE_SELF_REFERENCE', message: 'A session can\'t mention itself, so nothing was sent to Casper.',
    } }])
    expect(fake.pids()).toEqual([])
  })

  it('an unreadable session and a malformed reference end with their codes', async () => {
    const { fake, host } = await withReferences({ prompts: [] })
    const { agent } = await host.create('casper-ref-broken')
    await run(agent, `see ${mention('no-such-session')}`)
    await run(agent, 'see @[Broken](dsh-session:not!canonical)')
    expect(turnEnds(agent)).toEqual([
      { kind: 'error', error: { code: 'SESSION_REFERENCE_READ_FAILED', message: 'A mentioned session could not be read, so nothing was sent to Casper.' } },
      { kind: 'error', error: { code: 'SESSION_REFERENCE_INVALID_REFERENCE', message: 'A session mention in the request is not valid, so nothing was sent to Casper.' } },
    ])
    expect(fake.pids()).toEqual([])
  })

  it('three references at full budget arrive whole', async () => {
    // Each source's newest message, which the service keeps and cuts last, is a long reply.
    const long = [1, 2, 3].map(index => [{ text: `chat ${index} ${'x'.repeat(80_000)}\n` }])
    const { fake, host } = await withReferences({ prompts: [...long, [{ text: 'ok\n' }]], promptCapabilities: { embeddedContext: true } })
    const sources = ['casper-ref-big-1', 'casper-ref-big-2', 'casper-ref-big-3']
    for (const id of sources) await run((await host.create(id)).agent, 'write a lot')
    const { agent } = await host.create('casper-ref-big-target')
    await run(agent, `compare ${sources.map(id => mention(id)).join(' ')}`)
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }])
    const blocks = prompts(fake)[3] ?? []
    expect(blocks).toHaveLength(2)
    const text = resourceOf(blocks)?.text ?? ''
    // Each Session fills the service's 64 KiB budget, and all three still go as one resource Casper takes whole.
    expect(Buffer.byteLength(text)).toBeGreaterThan(3 * 60 * 1024)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_EMBEDDED_REFERENCE_BYTES)
    for (const index of [1, 2, 3]) expect(text).toContain(`chat ${index} xxx`)
    const reply = eventsOf(agent).filter(event => event.type === 'assistant/message').at(-1)
    expect(reply?.type === 'assistant/message' && reply.data.message.content).toEqual([{ type: 'text', text: 'ok\n\nReceipt: verified\n' }])
  })

  it('slash plan with a mention carries the context', async () => {
    const { fake, host } = await withReferences({ prompts: [[{ text: 'Cache by path.\n' }], [{ text: 'planned\n' }]], promptCapabilities: { embeddedContext: true } })
    await run((await host.create('casper-ref-plan-source')).agent, 'how should we cache?')
    const { agent } = await host.create('casper-ref-plan')
    await run(agent, `/plan add the cache from ${mention('casper-ref-plan-source', 'Design')}`)
    const blocks = prompts(fake)[1] ?? []
    expect(blocks[0]).toEqual({ type: 'text', text: '/plan add the cache from @Design' })
    expect(resourceOf(blocks)?.text).toContain('Cache by path.')
  })

  it('a steered line with a mention runs as the next turn, so its mention is read', async () => {
    const { fake, host } = await withReferences({ prompts: [] })
    const hold = gate(fake, 'hold')
    fake.script({ steer: true, promptCapabilities: { embeddedContext: true }, prompts: [[{ text: 'Seen.\n' }], [{ waitFile: hold.path }], []] })
    await run((await host.create('casper-ref-steer-source')).agent, 'the earlier chat')
    const { agent } = await host.create('casper-ref-steer')
    agent.followup(prompt('first'))
    await waitFor(() => fake.calls('session/prompt').length === 2)
    agent.steer(prompt(`also ${mention('casper-ref-steer-source', 'Earlier')}`))
    await new Promise((resolve) => { setTimeout(resolve, 100) })
    hold.open()
    await agent.whenIdle()
    expect(fake.calls('_casper/steer')).toEqual([])
    const blocks = prompts(fake)[2] ?? []
    expect(blocks[0]).toEqual({ type: 'text', text: 'also @Earlier' })
    expect(resourceOf(blocks)?.text).toContain('the earlier chat')
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }, { kind: 'completed' }])
  })
})

describe('Closing an idle Casper', { timeout: 60_000 }, () => {
  /** A short idle time, so a test sees the check. */
  const IDLE = { idleExitMs: 200 }
  const COMPLETED = { kind: 'completed' }

  /** Where in the log one process logged an event, or -1. */
  function at(fake: FakeCasper, pid: number | undefined, test: (entry: ReturnType<FakeCasper['log']>[number]) => boolean, nth = 1): number {
    let seen = 0
    return fake.log().findIndex(entry => entry.pid === pid && test(entry) && ++seen === nth)
  }

  const idleReply = (entry: { event?: string }) => entry.event === 'idle-reply'
  const eof = (entry: { event?: string }) => entry.event === 'eof'

  function replyText(agent: Agent): string {
    return eventsOf(agent).flatMap(event => event.type === 'assistant/message'
      ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
      : []).join('')
  }

  it('an idle Casper is closed and the next prompt reopens it with session/load and no fresh notice', async () => {
    const { fake, host } = await setup({ prompts: [[{ text: 'one\n' }], [{ text: 'two\n' }]] }, IDLE)
    const { agent } = await host.create('casper-idle-close')
    await run(agent, 'first')
    const [first] = fake.pids()
    await waitFor(() => at(fake, first, eof) !== -1 && !alive(first ?? 0))
    const conversation = host.record('casper-idle-close')?.acpSessionId
    expect(fake.calls('_casper/idle').map(entry => entry.params)).toEqual([{ sessionId: conversation }])
    // The check is not a turn, and the closed process leaves the Agent idle.
    expect(agent.status).toBe('idle')
    expect(turnEnds(agent)).toEqual([COMPLETED])
    await run(agent, 'second')
    const second = fake.pids()[1]
    expect(second).toBeDefined()
    expect(fake.calls('session/load')).toMatchObject([{ pid: second, params: { sessionId: conversation } }])
    expect(fake.calls('session/prompt').map(entry => entry.pid)).toEqual([first, second])
    expect(replyText(agent)).not.toContain(FRESH_CONVERSATION_NOTICE)
    expect(replyText(agent)).not.toContain('reopened')
    expect(turnEnds(agent)).toEqual([COMPLETED, COMPLETED])
  })

  it('a Casper running a dev server is kept and asked again later', async () => {
    const idle = [{ idle: false, running: ['dev server'] }, { idle: true, running: [] }]
    const { fake, host } = await setup({ prompts: [[{ text: 'serving\n' }]], idle }, IDLE)
    const { agent } = await host.create('casper-idle-server')
    await run(agent, 'start the server')
    const [pid] = fake.pids()
    await waitFor(() => at(fake, pid, eof) !== -1)
    // Closed only after the second check said idle.
    expect(fake.calls('_casper/idle')).toHaveLength(2)
    expect(at(fake, pid, idleReply, 2)).toBeGreaterThan(-1)
    expect(at(fake, pid, eof)).toBeGreaterThan(at(fake, pid, idleReply, 2))
  })

  it('an old Casper without the request is kept', async () => {
    const { fake, host } = await setup({ prompts: [[{ text: 'one\n' }], [{ text: 'two\n' }]], idle: null }, IDLE)
    const { agent } = await host.create('casper-idle-old')
    await run(agent, 'first')
    const [pid] = fake.pids()
    // Its -32601 reads as not idle; it is asked again after another idle time.
    await waitFor(() => fake.calls('_casper/idle').length >= 2)
    expect(alive(pid ?? 0)).toBe(true)
    expect(at(fake, pid, eof)).toBe(-1)
    await run(agent, 'second')
    expect(fake.pids()).toEqual([pid])
    expect(fake.calls('session/load')).toEqual([])
    expect(turnEnds(agent)).toEqual([COMPLETED, COMPLETED])
  })

  it('a prompt during a pending check runs on the old process once, and maintenance during the check succeeds', async () => {
    const { fake, host } = await setup({ prompts: [] }, IDLE)
    const check = gate(fake, 'idle-check')
    const midPrompt = gate(fake, 'mid-prompt')
    fake.script({ configOptions: casperOptions(), holdIdle: check.path, prompts: [[{ text: 'one\n' }], [{ waitFile: midPrompt.path }, { text: 'two\n' }]] })
    const { agent } = await host.create('casper-idle-during')
    await run(agent, 'first')
    const [pid] = fake.pids()
    await waitFor(() => fake.calls('_casper/idle').length === 1)
    // A model pick while Casper is asked runs as maintenance on the live process.
    const own = agent.model.own
    if (own === undefined) throw new Error('a Casper Agent chooses its own models')
    await own.choose({ provider: 'claude-subscription', model: 'claude-opus-5-5' })
    expect(fake.calls('session/set_config_option').map(entry => entry.pid)).toEqual([pid])
    agent.followup(prompt('second'))
    await waitFor(() => fake.calls('session/prompt').length === 2)
    // Casper answers idle while the prompt runs: the prompt keeps its process.
    check.open()
    await waitFor(() => at(fake, pid, idleReply) !== -1)
    midPrompt.open()
    await agent.whenIdle()
    expect(fake.calls('session/prompt').map(entry => entry.pid)).toEqual([pid, pid])
    expect(turnEnds(agent)).toEqual([COMPLETED, COMPLETED])
    // The next idle time closes it.
    await waitFor(() => at(fake, pid, eof) !== -1)
    expect(at(fake, pid, idleReply, 2)).toBeGreaterThan(-1)
    expect(at(fake, pid, eof)).toBeGreaterThan(at(fake, pid, idleReply, 2))
    expect(fake.pids()).toEqual([pid])
  })

  it('a turn that starts and ends during the check prevents the close', async () => {
    const { fake, host } = await setup({ prompts: [] }, IDLE)
    const check = gate(fake, 'idle-check')
    fake.script({ holdIdle: check.path, prompts: [[{ text: 'one\n' }], [{ text: 'two\n' }]] })
    const { agent } = await host.create('casper-idle-turn')
    await run(agent, 'first')
    const [pid] = fake.pids()
    await waitFor(() => fake.calls('_casper/idle').length === 1)
    await run(agent, 'second')
    check.open()
    await waitFor(() => at(fake, pid, eof) !== -1)
    // The first idle reply came after the turn, so only a later check closed Casper.
    expect(at(fake, pid, idleReply, 2)).toBeGreaterThan(-1)
    expect(at(fake, pid, eof)).toBeGreaterThan(at(fake, pid, idleReply, 2))
    expect(fake.calls('session/prompt').map(entry => entry.pid)).toEqual([pid, pid])
    expect(turnEnds(agent)).toEqual([COMPLETED, COMPLETED])
  })

  it('a prompt during a close starts the new process only after the old one exits', async () => {
    // A Casper that ignores the end of its input holds the close for the exit grace.
    const script = { prompts: [[{ text: 'one\n' }], [{ text: 'two\n' }]], ignoreEof: true }
    const { fake, host } = await setup(script, { ...IDLE, exitGraceMs: 500, killGraceMs: 500 })
    const { agent } = await host.create('casper-idle-closing')
    await run(agent, 'first')
    const [first] = fake.pids()
    await waitFor(() => at(fake, first, eof) !== -1)
    expect(alive(first ?? 0)).toBe(true)
    agent.followup(prompt('second'))
    await waitFor(() => fake.pids().length === 2)
    expect(alive(first ?? 0)).toBe(false)
    await agent.whenIdle()
    expect(fake.calls('session/load').map(entry => entry.pid)).toEqual([fake.pids()[1]])
    expect(turnEnds(agent)).toEqual([COMPLETED, COMPLETED])
  })

  it('a prompt stopped while the old Casper closes ends at once and starts no new process', async () => {
    const script = { prompts: [[{ text: 'one\n' }], [{ text: 'two\n' }]], ignoreEof: true }
    // The exit grace holds the close long enough to stop the prompt while it waits.
    const { fake, host } = await setup(script, { ...IDLE, exitGraceMs: 4_000, killGraceMs: 500 })
    const { agent } = await host.create('casper-idle-stopped')
    await run(agent, 'first')
    const [first] = fake.pids()
    await waitFor(() => at(fake, first, eof) !== -1)
    agent.followup(prompt('second'))
    await waitFor(() => eventsOf(agent).filter(event => event.type === 'user/message').length === 2)
    // The turn writes nothing while it waits for the close, so it is given time to reach the wait.
    await new Promise((resolve) => { setTimeout(resolve, 300) })
    const stopped = Date.now()
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    expect(Date.now() - stopped).toBeLessThan(2_000)
    // The stop did not wait for the old process to exit.
    expect(alive(first ?? 0)).toBe(true)
    expect(turnEnds(agent)).toEqual([COMPLETED, { kind: 'aborted', reason: { kind: 'user' } }])
    await waitFor(() => !alive(first ?? 0))
    expect(fake.pids()).toEqual([first])
    expect(fake.calls('session/load')).toEqual([])
  })

  it('a Casper that exited while idle is not asked, and the next prompt reopens it', async () => {
    const { fake, host } = await setup({ prompts: [[{ text: 'one\n' }, { exitAfterMs: 20 }], [{ text: 'two\n' }]] }, IDLE)
    const { agent } = await host.create('casper-idle-exited')
    await run(agent, 'first')
    const [first] = fake.pids()
    await waitFor(() => !alive(first ?? 0))
    // A negative: nothing to poll for, so the test waits past two idle times.
    await new Promise((resolve) => { setTimeout(resolve, 500) })
    expect(fake.calls('_casper/idle')).toEqual([])
    await run(agent, 'second')
    expect(fake.calls('session/load').map(entry => entry.pid)).toEqual([fake.pids()[1]])
    expect(turnEnds(agent)).toEqual([COMPLETED, COMPLETED])
  })

  it('idleExitMs 0 never asks, and dispose during a check finishes in time', async () => {
    const { fake, host } = await setup({ prompts: [[{ text: 'kept\n' }]] }, { idleExitMs: 0 })
    const kept = await host.create('casper-idle-off')
    await run(kept.agent, 'first')
    // A negative: nothing to poll for, so the test waits several idle times of the other Agent below.
    await new Promise((resolve) => { setTimeout(resolve, 600) })
    expect(fake.calls('_casper/idle')).toEqual([])

    const other = fakeCasper({ prompts: [] })
    cleanups.push(() => { other.remove() })
    const check = gate(other, 'idle-check')
    other.script({ holdIdle: check.path, prompts: [[{ text: 'one\n' }]] })
    const asked = await boot(other, { ...IDLE, exitGraceMs: 300, killGraceMs: 500 })
    cleanups.push(() => asked.ctx.fiber.dispose())
    const handle = await asked.create('casper-idle-dispose')
    await run(handle.agent, 'first')
    const [pid] = other.pids()
    await waitFor(() => other.calls('_casper/idle').length === 1)
    const started = Date.now()
    await handle.dispose()
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(alive(pid ?? 0)).toBe(false)
    expect(other.calls('_casper/idle')).toHaveLength(1)
  })

  it('a reopened Casper on another model says so and sends no set', async () => {
    const script = {
      configOptions: casperOptions(), loadConfigOptions: casperOptions('claude-subscription/claude-opus-5-5'),
      prompts: [[{ text: 'one\n' }], [{ text: 'two\n' }]],
    }
    const { fake, host } = await setup(script, IDLE)
    const { agent } = await host.create('casper-idle-model')
    await run(agent, 'first')
    const [pid] = fake.pids()
    await waitFor(() => !alive(pid ?? 0))
    await run(agent, 'second')
    expect(replyText(agent)).toContain('[Casper reopened on claude-subscription/claude-opus-5-5; it was openai-codex/gpt-6.1-sol.]\n')
    expect(fake.calls('session/set_config_option')).toEqual([])
    expect(agent.model.current()).toMatchObject({ provider: 'claude-subscription', model: 'claude-opus-5-5' })
  })

  it('Read only set before a close reaches the reopened Casper before its first prompt', async () => {
    const fake = fakeCasper({ configOptions: casperOptions(), modes: casperModes(), prompts: [[{ text: 'one\n' }], [{ text: 'two\n' }]] })
    cleanups.push(() => { fake.remove() })
    const host = await boot(fake, IDLE, undefined, true, mountPermissionPresets)
    cleanups.push(() => host.ctx.fiber.dispose())
    const { agent } = await host.create('casper-idle-read')
    await run(agent, 'first')
    const [first] = fake.pids()
    host.ctx.permissionPresets.set(agent.session, 'read-only')
    await waitFor(() => !alive(first ?? 0))
    await run(agent, 'second')
    const second = fake.pids()[1]
    const reopened = fake.log().flatMap(entry => entry.pid === second && entry.method !== undefined && entry.method !== 'initialize'
      ? [[entry.method, entry.params?.configId ?? null, entry.params?.value ?? null]]
      : [])
    expect(reopened).toEqual([
      ['session/load', null, null],
      ['session/set_config_option', 'mode', 'read'],
      ['session/prompt', null, null],
    ])
    expect(turnEnds(agent)).toEqual([COMPLETED, COMPLETED])
  })
})
