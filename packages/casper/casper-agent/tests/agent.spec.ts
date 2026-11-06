import { afterEach, describe, expect, it, vi } from 'vitest'
import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AttachmentStore, { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { FileAttachmentRef, ImageAttachmentLimits, ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { CasperAgent, FRESH_CONVERSATION_NOTICE } from '../src/agent.ts'
import { FORK_UNSUPPORTED } from '../src/factory.ts'
import { TEXT_ONLY_PICTURE } from '../src/prompt.ts'
import { boot, eventsOf, filesText, prompt, turnEnds } from './harness.ts'
import { alive, fakeCasper, gate, waitFor } from './support.ts'
import type { FakeCasper, FakeScript } from './support.ts'

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
      'turn/start', 'step/start', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'step/end',
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

  it('runs steering sent during a prompt as the next turn', async () => {
    const { fake, host } = await setup({ prompts: [] })
    const hold = gate(fake, 'hold')
    fake.script({ prompts: [[{ waitFile: hold.path }], []] })
    const { agent } = await host.create('casper-steer')
    agent.followup(prompt('first'))
    await waitFor(() => fake.calls('session/prompt').length === 1)
    agent.steer(prompt('also this'))
    hold.open()
    await agent.whenIdle()
    expect(promptTexts(fake)).toEqual(['first', 'also this'])
    expect(turnEnds(agent)).toEqual([{ kind: 'completed' }, { kind: 'completed' }])
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
      'turn/start', 'step/start', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'step/end',
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
    const read = Promise.withResolvers<undefined>()
    let reading = false
    // A store that ignores the signal and finishes the read after the Stop.
    class LateAttachments extends StandInAttachments {
      override async readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
        reading = true
        await read.promise
        return { ref, data: PICTURE_BYTES }
      }
    }
    const { fake, host } = await setupWithAttachments({ prompts: [[{ text: 'never\n' }]], promptCapabilities: { image: true } }, LateAttachments)
    const { agent } = await host.create('casper-stop-picture')
    agent.followup(prompt('', 'rpc-stop-picture', [{ type: 'text', text: 'look' }, { type: 'image', attachment: PICTURE }]))
    await waitFor(() => reading)
    agent.cancel({ kind: 'user' })
    read.resolve(undefined)
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

  it('shows only text from Casper messages and leaves other updates out', async () => {
    const { host } = await setup({ prompts: [[{ image: true }, { thought: 'thinking' }, { text: 'ok\n' }]] })
    const { agent } = await host.create('casper-kinds')
    await run(agent, 'go')
    const message = eventsOf(agent).find(event => event.type === 'assistant/message')
    expect(message?.type === 'assistant/message' && message.data.message.content).toEqual([{ type: 'text', text: 'ok\n\nReceipt: verified\n' }])
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
