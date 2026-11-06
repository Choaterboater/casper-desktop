/**
 * A Host composition for Casper Agent tests: agent-loop as the default factory,
 * JSONL persistence, storage, subprocesses, and the Casper plugin.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent, AgentHandle, AgentStatus, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import * as CasperAgentPlugin from '../src/index.ts'
import type { Config } from '../src/config.ts'
import type { CasperSessionRecord } from '../src/sidecar.ts'
import type { FakeCasper } from './support.ts'

/** Answers a user question, or waits; the default picks the label `Yes, this once`. */
export type Answerer = (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>

/** A booted Host and what it observed. */
export interface Booted {
  readonly ctx: Context
  readonly asked: AskUserQuestionRequest[]
  readonly statuses: { agent: Agent; status: AgentStatus }[]
  readonly frames: { agent: Agent; frame: AssistantStreamFrame }[]
  readonly errors: { agent: Agent; error: unknown }[]
  /** Create a Session on the Casper preset (or another preset). */
  create(id: string, agentPreset?: string): Promise<AgentHandle>
  /** Read the sidecar record of a Session. */
  record(id: string): CasperSessionRecord | undefined
  /** Unload the Casper plugin. */
  unloadCasper(): Promise<void>
}

/**
 * Boot a Host over a data folder; booting again on the same folder resumes its Sessions.
 * @param fake - the stand-in fixture whose root holds sessions and storage.
 * @param overrides - plugin config overrides.
 * @param answer - the question answerer.
 * @param questions - whether the user-questions service is mounted.
 * @param mount - mounts further services, such as an attachment store, before the Casper plugin.
 * @returns the booted Host.
 */
export async function boot(
  fake: FakeCasper,
  overrides: Partial<Config> = {},
  answer?: Answerer,
  questions = true,
  mount?: (ctx: Context) => Promise<void>,
): Promise<Booted> {
  const ctx = new Context()
  const asked: AskUserQuestionRequest[] = []
  const statuses: Booted['statuses'] = []
  const frames: Booted['frames'] = []
  const errors: Booted['errors'] = []
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(fake.root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(fake.root, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(LocalSubprocessRuntime)
  if (questions) await ctx.plugin(UserQuestionService)
  await ctx.plugin({
    name: 'test-answerer',
    apply(inner: Context) {
      inner.on('user-questions/request', (request) => {
        asked.push(request)
        return answer?.(request) ?? Promise.resolve({ answers: [{ id: request.questions[0]?.id ?? '', selected: ['Yes, this once'] }] })
      })
      inner.on('agent/status', ({ agent, status }) => { statuses.push({ agent, status }) })
      inner.on('agent/assistant-stream', ({ agent, frame }) => { frames.push({ agent, frame }) })
      inner.on('agent/error', ({ agent, error }) => { errors.push({ agent, error }) })
    },
  })
  await mount?.(ctx)
  const casper = ctx.plugin(CasperAgentPlugin, fake.config(overrides))
  await casper
  return {
    ctx, asked, statuses, frames, errors,
    unloadCasper: async () => { await casper.dispose() },
    create: (id, agentPreset = 'casper') => ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: fake.cwd, agentPreset } }),
    record: id => ctx.storageDomain.get('casper_agent')?.table('sessions').get(id) as CasperSessionRecord | undefined,
  }
}

/**
 * A user prompt as the GUI sends it.
 * @param text - the prompt text.
 * @param rpcId - the request id the GUI echo waits for.
 * @param content - content blocks replacing the text.
 * @returns the message.
 */
export function prompt(text: string, rpcId = `rpc-${text}`, content?: ContentBlock[]): UserMessage {
  return createUserMessage({ content: content ?? [{ type: 'text', text }], source: { kind: 'user', rpcId } })
}

/**
 * Every event of a live Session.
 * @param agent - the Agent.
 * @returns the events in order.
 */
export function eventsOf(agent: Agent): readonly SessionEvent[] {
  return agent.session.snapshotEvents()
}

/**
 * The `turn/end` reasons of a live Session.
 * @param agent - the Agent.
 * @returns the reasons in order.
 */
export function turnEnds(agent: Agent): unknown[] {
  return eventsOf(agent).flatMap(event => event.type === 'turn/end' ? [event.data.reason] : [])
}

/**
 * Every file under a folder joined as text.
 * @param dir - the folder.
 * @returns the joined contents.
 */
export function filesText(dir: string): string {
  let text = ''
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    text += statSync(path).isDirectory() ? filesText(path) : readFileSync(path, 'utf8')
  }
  return text
}
