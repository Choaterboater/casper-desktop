/**
 * Session mentions in a Casper turn. A user message that names other
 * Sessions (`@[label](dsh-session:…)`) is read by the app's session-reference
 * service before Casper starts; the prompt then carries the readable words and
 * the other Sessions' snapshot as context.
 * @module @deepseek-ai/dsh-casper-agent/references
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import { parseSessionReferenceText, SESSION_REFERENCE_SCHEME, SessionReferenceError } from '@deepseek-ai/dsh-session-reference'
import type { SessionReferenceErrorCode, SessionReferenceInput, SessionReferenceResolver } from '@deepseek-ai/dsh-session-reference'
import { CasperError } from './connection.ts'
import { CASPER_PROVIDER } from './turn.ts'

/** One mentioned message, ready for the prompt. */
export interface PreparedReference {
  /** The message's blocks with each mention replaced by its readable `@label`. */
  readonly content: readonly ContentBlock[]
  /** The first Session the message names; the context's URI carries it. */
  readonly sessionId: SessionId
  /** The service's untrusted snapshot of every Session the message names. */
  readonly text: string
  /** The snapshot as the service's context message; the Session logs it right after the message that mentions it. */
  readonly context: UserMessage
}

/** The mentioned messages of one turn, by message id. */
export type PreparedReferences = ReadonlyMap<MessageId, PreparedReference>

/** The resolver reads {@link prepareReferences} needs. */
export type ReferenceResolver = Pick<SessionReferenceResolver, 'prepare'>

/** What the user is told for each code the service ends a turn with. */
const WORDS: Record<SessionReferenceErrorCode, string> = {
  SESSION_REFERENCE_INVALID_CONFIG: 'Session mentions are not set up correctly in this app',
  SESSION_REFERENCE_INVALID_REFERENCE: 'A session mention in the request is not valid',
  SESSION_REFERENCE_SELF_REFERENCE: 'A session can\'t mention itself',
  SESSION_REFERENCE_TOO_MANY: 'The request mentions too many sessions',
  SESSION_REFERENCE_READ_FAILED: 'A mentioned session could not be read',
  SESSION_REFERENCE_BUDGET_EXCEEDED: 'A mentioned session is too large to send',
  SESSION_REFERENCE_CANCELLED: 'Reading the mentioned sessions was stopped',
}

/**
 * Whether a message may name another Session. A line that does is not steered:
 * it runs as a turn of its own, so its mention is read.
 * @param message - a queued user message.
 * @returns true when a text block holds the session-reference scheme.
 */
export function hasSessionReference(message: UserMessage): boolean {
  return message.content.some(block => block.type === 'text' && block.text.includes(SESSION_REFERENCE_SCHEME))
}

/**
 * Read the Sessions each claimed user message names. Messages without a
 * mention are left out of the result, and the claimed messages are not changed,
 * so the Session log keeps what the user typed; each snapshot comes with the
 * context message a Standard Session logs for it.
 * @param agent - the Casper Agent; a mention of its own Session is refused.
 * @param resolver - the app's session-reference service.
 * @param messages - the turn's claimed messages.
 * @param model - the model label recorded for the turn.
 * @param signal - the turn signal.
 * @returns the prepared messages by id; empty when none mentions a Session.
 * @throws CasperError with the service's code when a mention cannot be read; the signal's error when the turn stops.
 */
export async function prepareReferences(
  agent: Agent,
  resolver: ReferenceResolver,
  messages: readonly UserMessage[],
  model: string,
  signal: AbortSignal,
): Promise<PreparedReferences> {
  const prepared = new Map<MessageId, PreparedReference>()
  try {
    for (const message of messages) {
      if (message.source.kind !== 'user') continue
      const references: SessionReferenceInput[] = []
      const content = message.content.map((block): ContentBlock => {
        if (block.type !== 'text') return block
        const parsed = parseSessionReferenceText(block.text)
        references.push(...parsed.references)
        return { type: 'text', text: parsed.text }
      })
      const first = references[0]
      if (first === undefined) continue
      const resolved = await resolver.prepare(agent, content, references, { provider: CASPER_PROVIDER, model }, signal)
      signal.throwIfAborted()
      const context = resolved.additionalContext
      /* v8 ignore if -- a parsed mention always leaves one normalized reference */
      if (context === undefined) throw new Error('session-reference preparation omitted context for a mention')
      const text = context.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n\n')
      prepared.set(message.id, { content: resolved.content, sessionId: first.sessionId, text, context })
    }
  } catch (error: unknown) {
    if (signal.aborted) throw error
    if (error instanceof SessionReferenceError) {
      throw new CasperError(error.code, `${WORDS[error.code]}, so nothing was sent to Casper.`, { cause: error })
    }
    throw error
  }
  return prepared
}
