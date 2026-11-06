/**
 * Writes one Casper prompt's `session/update` stream into Session events and
 * live assistant frames.
 * @module @deepseek-ai/dsh-casper-agent/turn
 */

import type { PlanEntry, ToolCall, ToolCallUpdate } from '@agentclientprotocol/sdk'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { AssistantStreamAttempt } from '@deepseek-ai/dsh-agent-loop'
import { createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import { TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tool-todo'
import type { BridgedCall } from './app-tools.ts'
import { toolCallText } from './permission.ts'
import { standardCall, standardResult } from './views.ts'
import type { Json, StandardView } from './views.ts'

/** Provider name recorded on Casper's assistant messages. */
export const CASPER_PROVIDER = 'casper'

/** Result text of a Casper call that was still open when its prompt ended. */
export const OPEN_CALL_RESULT = 'Casper stopped before this step reported a result, so its outcome is unknown.'

/** Inputs of one {@link TurnWriter}; counters are owned by the Agent so they stay monotone across turns. */
export interface TurnWriterOptions {
  /** Session the turn appends to. */
  readonly session: Session
  /** Publishes one live assistant frame. */
  readonly emit: (frame: AssistantStreamFrame) => void
  /** Turn number of the open turn. */
  readonly turn: number
  /** Step number already opened with `step/start`. */
  readonly step: number
  /** Allocates the next attempt number for this Agent. */
  readonly nextAttempt: () => number
  /** Allocates the next live frame revision for this Agent. */
  readonly nextRevision: () => number
  /** Model name recorded on assistant messages. */
  readonly model: string
  /** Maps a Casper tool call id to a call id unique in the Session. */
  readonly callId: (acpId: string) => ToolCallId
}

interface OpenCall {
  readonly callId: ToolCallId
  readonly callSeq: SessionSeq
  readonly step: number
  question: boolean
  /** How a Casper tool step was recorded; undefined for checks and approval boxes. */
  readonly view: StandardView | undefined
  /** The app tool's own result, when the step ran one through the app tools server. */
  bridged: BridgedCall | undefined
}

/** One `tool/result` to append. */
interface ResultBody {
  readonly content: ContentBlock[]
  readonly isError: boolean
  readonly meta?: Json | undefined
}

/**
 * Turns Casper's updates into steps. Text streams into the step's first
 * assistant attempt, and the first tool call of the step commits it as
 * `assistant/message` with that call's block, followed by `tool/call`. A call
 * that starts while other calls of the step are open joins the same step: it
 * gets an attempt of its own, committed as an `assistant/message` holding only
 * its block, before its `tool/call`, so every call is advertised once as a
 * stored log requires. Text after a committed step opens the next step once
 * every open call has its result; text that arrives while calls are open waits
 * for them.
 */
export class TurnWriter {
  private currentStep: number
  private attempt: AssistantStreamAttempt | undefined
  private committed = false
  private openText: { index: number; text: string } | undefined
  private blockIndex = 0
  private readonly openCalls = new Map<string, OpenCall>()
  /** App tool results that arrived before their step's `tool_call`. */
  private readonly earlyBridged = new Map<string, BridgedCall>()
  private buffered: string[] = []

  /** @param options - the Session, frame publisher, positions, counters, and id mapping. */
  constructor(private readonly options: TurnWriterOptions) {
    this.currentStep = options.step
  }

  /** The step currently open. */
  get step(): number {
    return this.currentStep
  }

  /**
   * Stream assistant text.
   * @param text - the chunk's text.
   */
  text(text: string): void {
    if (text === '') return
    if (this.committed) {
      if (this.openCalls.size > 0) {
        this.buffered.push(text)
        return
      }
      this.nextStep()
    }
    const attempt = this.ensureAttempt()
    if (this.openText === undefined) {
      this.openText = { index: this.blockIndex++, text: '' }
      attempt.push({ type: 'block-start', index: this.openText.index, blockType: 'text' })
    }
    this.openText.text += text
    attempt.push({ type: 'text-delta', index: this.openText.index, text })
  }

  /**
   * Record a `tool_call` update. A running step is recorded as the Standard
   * tool it maps to ({@link standardCall}); a call that arrives already
   * completed or failed (a Casper check) is `casper_check` and closed at once,
   * and a pending one (an approval box) is `casper_approval`.
   * @param call - the ACP tool call.
   */
  toolCall(call: ToolCall): void {
    const terminal = call.status === 'completed' || call.status === 'failed'
    if (!terminal && call.status !== 'pending') {
      const view = standardCall(call)
      this.startCall(call.toolCallId, view.name, view.arguments, view)
      return
    }
    this.startCall(call.toolCallId, terminal ? 'casper_check' : 'casper_approval', callArguments(call.title, call.content), undefined)
    if (terminal) {
      const output = call.rawOutput === undefined ? '' : `\n${JSON.stringify(call.rawOutput)}`
      const failed = call.status === 'failed'
      this.finishCall(call.toolCallId, open => textResult(`${call.title}${output}`, failed && !open.question))
    }
  }

  /**
   * Keep the app tool's own result for the Casper step that ran it; the
   * step's final update is then recorded with that result and its `meta`, so
   * the step's card is the app tool's own.
   * @param acpId - the ACP tool call id of the step.
   * @param call - the app tool, its arguments, and its result.
   */
  bridged(acpId: string, call: BridgedCall): void {
    const open = this.openCalls.get(acpId)
    if (open === undefined) {
      this.earlyBridged.set(acpId, call)
      return
    }
    open.bridged = call
  }

  /**
   * Make sure an approval box has an open call, and mark it as a question so
   * a No closes it without an error.
   * @param call - the tool call carried by `session/request_permission`.
   */
  question(call: ToolCallUpdate): void {
    const open = this.openCalls.get(call.toolCallId)
    if (open !== undefined) {
      open.question = true
      return
    }
    this.startCall(call.toolCallId, 'casper_approval', callArguments(call.title ?? '', call.content), undefined)
    const started = this.openCalls.get(call.toolCallId)
    if (started !== undefined) started.question = true
  }

  /**
   * Record a `tool_call_update`; only a completed or failed status closes the
   * call. A tool step's result is the Standard one ({@link standardResult}),
   * or the app tool's own when the step ran one; an approval box keeps
   * Casper's words, and its refusal is not an error.
   * @param update - the ACP tool call update.
   */
  toolUpdate(update: ToolCallUpdate): void {
    if (update.status !== 'completed' && update.status !== 'failed') return
    const failed = update.status === 'failed'
    this.finishCall(update.toolCallId, (open) => {
      const bridged = open.bridged?.result
      if (bridged !== undefined) return { content: bridged.content, isError: bridged.isError, meta: bridged.meta }
      if (open.view === undefined || open.question) {
        const text = toolCallText(update.content) ?? (update.rawOutput === undefined ? '' : JSON.stringify(update.rawOutput))
        return textResult(text, failed && !open.question)
      }
      const result = standardResult(open.view, update)
      return { ...textResult(result.text, result.isError), meta: result.meta }
    })
  }

  /**
   * Record a whole plan as the Session's todo list.
   * @param entries - the ACP plan entries, in order.
   */
  plan(entries: readonly PlanEntry[]): void {
    this.options.session.append('todo/write', { todos: entries.map(entry => ({ content: entry.content, status: entry.status })) })
  }

  /**
   * Settle the open attempt and close the open step. Every call still open
   * gets an outcome-unknown error result first, as agent-loop records for a
   * failed step, so no card is left running; text that was waiting for those
   * calls is then written into a final step.
   * @param interrupted - whether the prompt ended without completing.
   */
  close(interrupted: boolean): void {
    const open = [...this.openCalls.values()]
    this.openCalls.clear()
    this.earlyBridged.clear()
    for (const call of open) {
      this.appendResult(call, textResult(OPEN_CALL_RESULT, true), { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN })
    }
    if (this.buffered.length > 0) {
      const waiting = this.buffered
      this.buffered = []
      for (const text of waiting) this.text(text)
    }
    const attempt = this.attempt
    if (attempt !== undefined && !attempt.ended) {
      if (!interrupted) this.closeText(attempt)
      // An attempt starts only with a text block, so an unsettled one always has visible content.
      const content = interrupted ? attempt.interruptedBlocks() : attempt.blocks()
      attempt.settle('assistant/message', () => this.options.session.append('assistant/message', {
        turn: this.options.turn,
        step: this.currentStep,
        message: createAssistantMessage({ content, source: { provider: CASPER_PROVIDER, model: this.options.model } }),
        ...interrupted ? { interrupted: true as const } : {},
        stream: attempt.stream,
      }, { surfaceOp: 'append' }).seq)
    }
    this.options.session.append('step/end', { turn: this.options.turn, step: this.currentStep })
  }

  private ensureAttempt(): AssistantStreamAttempt {
    if (this.attempt !== undefined) return this.attempt
    const attempt = new AssistantStreamAttempt(
      this.options.session.id,
      this.options.nextAttempt(),
      this.options.nextRevision,
      this.options.turn,
      this.currentStep,
      this.options.emit,
    )
    attempt.start()
    this.attempt = attempt
    return attempt
  }

  private closeText(attempt: AssistantStreamAttempt): void {
    const open = this.openText
    if (open === undefined) return
    this.openText = undefined
    attempt.push({ type: 'block-end', index: open.index, block: { type: 'text', text: open.text } })
  }

  private nextStep(): void {
    const { session, turn } = this.options
    session.append('step/end', { turn, step: this.currentStep })
    this.currentStep += 1
    session.append('step/start', { turn, step: this.currentStep })
    this.attempt = undefined
    this.committed = false
    this.openText = undefined
    this.blockIndex = 0
  }

  private startCall(acpId: string, name: string, args: string, view: StandardView | undefined): void {
    if (this.openCalls.has(acpId)) return
    const callId = this.options.callId(acpId)
    if (this.committed && this.openCalls.size === 0) this.nextStep()
    if (this.committed) {
      // Other calls are open, so this call joins the step in an attempt of its own.
      this.attempt = undefined
      this.blockIndex = 0
    }
    const attempt = this.ensureAttempt()
    this.closeText(attempt)
    const index = this.blockIndex++
    attempt.push({ type: 'block-start', index, blockType: 'tool-call' })
    attempt.push({ type: 'tool-call-delta', index, id: callId, name, argumentsDelta: args })
    attempt.push({ type: 'block-end', index, block: { type: 'tool-call', id: callId, name, arguments: args } })
    attempt.settle('assistant/message', () => this.options.session.append('assistant/message', {
      turn: this.options.turn,
      step: this.currentStep,
      message: createAssistantMessage({ content: attempt.blocks(), source: { provider: CASPER_PROVIDER, model: this.options.model } }),
      stream: attempt.stream,
    }, { surfaceOp: 'append' }).seq)
    this.committed = true
    const callSeq = this.options.session.append('tool/call', {
      turn: this.options.turn, step: this.currentStep, callId, name, arguments: args,
    }).seq
    const bridged = this.earlyBridged.get(acpId)
    this.earlyBridged.delete(acpId)
    this.openCalls.set(acpId, { callId, callSeq, step: this.currentStep, question: false, view, bridged })
  }

  private finishCall(acpId: string, resultOf: (open: OpenCall) => ResultBody): void {
    const open = this.openCalls.get(acpId)
    if (open === undefined) return
    this.openCalls.delete(acpId)
    const result = resultOf(open)
    this.appendResult(open, result, result.isError ? { name: 'CasperToolFailed', code: 'CASPER_TOOL_FAILED' } : undefined)
    if (this.openCalls.size > 0 || this.buffered.length === 0) return
    const waiting = this.buffered
    this.buffered = []
    for (const chunk of waiting) this.text(chunk)
  }

  private appendResult(open: OpenCall, result: ResultBody, error: { name: string; code: string } | undefined): void {
    this.options.session.append('tool/result', {
      turn: this.options.turn,
      step: open.step,
      message: createToolResultMessage({ callId: open.callId, content: result.content, isError: result.isError }),
      ...error === undefined ? {} : { error },
      ...result.meta === undefined ? {} : { meta: result.meta },
    }, { surfaceOp: 'append', sourceEventSeqs: [open.callSeq] })
  }
}

function textResult(text: string, isError: boolean): ResultBody {
  return { content: [{ type: 'text', text }], isError }
}

/** JSON arguments of a check or approval box: its title and preview text. */
function callArguments(title: string, content: ToolCallUpdate['content']): string {
  const preview = toolCallText(content)
  return JSON.stringify({ title, ...preview === undefined ? {} : { preview } })
}
