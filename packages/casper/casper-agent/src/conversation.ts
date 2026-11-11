/**
 * The per-turn record of which Casper conversation a prompt reply ended, and
 * where: Casper's mark from the reply's `_meta.casper.mark`, so a later fork
 * can cut the conversation at that turn. Only zod is imported.
 * @module @deepseek-ai/dsh-casper-agent/conversation
 */

import { z } from 'zod'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /**
     * Which Casper conversation a prompt reply ended, and Casper's mark for
     * that point when it sends one, so a later fork can cut the conversation
     * at that turn. A plugin record, so an app build without this package
     * keeps and skips it and still opens the Session.
     */
    'plugin:casper-agent/conversation': CasperConversation
  }
}

/** Plugin record type of the per-turn conversation record. */
export const CONVERSATION_RECORD = 'plugin:casper-agent/conversation'

/** One prompt reply's conversation: the ACP session it was sent on, and Casper's mark when it sent one. */
export interface CasperConversation {
  /** The ACP session id of the Casper conversation the prompt was sent on. */
  readonly acpSessionId: string
  /** Where the reply left the conversation; absent when Casper sent no mark or one `session/fork` would refuse. */
  readonly mark?: string
}

/** The mark shape `session/fork` takes in `_meta.casper.at` (Casper's conversation id rule). */
const MARK = /^[A-Za-z0-9_-]{1,128}$/

const markMetaSchema = z.object({ casper: z.object({ mark: z.string().regex(MARK) }) })

/**
 * Read Casper's mark from a prompt reply's `_meta`. Only the shape is checked,
 * never that the mark is in the conversation.
 * @param meta - the reply's `_meta`.
 * @returns the mark, or undefined when the reply carries none or one `session/fork` would refuse.
 */
export function conversationMarkOf(meta: unknown): string | undefined {
  const parsed = markMetaSchema.safeParse(meta)
  return parsed.success ? parsed.data.casper.mark : undefined
}

/**
 * The record of one prompt reply. An absent mark is left out, never `undefined`, so the record is plain JSON.
 * @param acpSessionId - the conversation the prompt was sent on.
 * @param mark - Casper's mark, if any.
 * @returns the record's data.
 */
export function conversationRecord(acpSessionId: string, mark: string | undefined): CasperConversation {
  return mark === undefined ? { acpSessionId } : { acpSessionId, mark }
}

const inheritedSchema = z.object({ acpSessionId: z.string().min(1), mark: z.string().optional() })

/** One plugin record of a Session log, as `pluginRecordOf` returns it. */
export interface ConversationLogRecord {
  /** The record type. */
  readonly type: string
  /** The record's position in the log. */
  readonly seq: number
  /** The record's data, unchecked. */
  readonly data: unknown
}

/**
 * Where a forked Session's Casper conversation is cut: the last conversation
 * record it inherited, which names the source's conversation and Casper's mark
 * for that turn, and whether a later inherited turn may be missing from it.
 * @param records - the Session's plugin records, in log order.
 * @param inheritedEventCount - how many events the fork inherited; records before it came from the source.
 * @param ends - the Session's turn endings, in log order.
 * @returns undefined when the Session has a conversation record of its own, so it is past its fork start; null when it
 *   inherited no record, or one that is not valid; otherwise the record, without a mark `session/fork` would refuse.
 */
export function inheritedConversation(
  records: readonly ConversationLogRecord[],
  inheritedEventCount: number,
  ends: readonly ConversationTurnEnd[] = [],
): ForkPoint | null | undefined {
  const conversations = records.filter(record => record.type === CONVERSATION_RECORD)
  if (conversations.some(record => record.seq >= inheritedEventCount)) return undefined
  const last = conversations.at(-1)
  const parsed = inheritedSchema.safeParse(last?.data)
  if (last === undefined || !parsed.success) return null
  const { acpSessionId, mark } = parsed.data
  const record = conversationRecord(acpSessionId, mark !== undefined && MARK.test(mark) ? mark : undefined)
  return { ...record, behind: forkBehind(ends, last.seq, inheritedEventCount) }
}

/** Failure codes of a turn that ended before its prompt reached Casper, so Casper's conversation did not move. */
const BEFORE_PROMPT: ReadonlySet<string> = new Set([
  'CASPER_NOT_FOUND', 'CASPER_START_FAILED', 'CASPER_EMPTY_PROMPT', 'CASPER_MODEL_UNAVAILABLE', 'CASPER_NO_ACCESS_MODES',
])

/** A forked Session's fork point: the inherited conversation, and whether Casper's copy may miss the last request. */
export interface ForkPoint extends CasperConversation {
  /**
   * True when an inherited turn after the last conversation record was stopped or failed after its prompt may have
   * reached Casper, so the copy, cut at the record's mark, may not have that request.
   */
  readonly behind: boolean
}

/** One turn ending of a Session log: its position and how it ended. */
export interface ConversationTurnEnd {
  /** The `turn/end` event's position in the log. */
  readonly seq: number
  /** How the turn ended. */
  readonly reason: { readonly kind: string; readonly error?: { readonly code?: string } }
}

/**
 * Whether any inherited turn after the record at `recordSeq` was stopped, or failed once its prompt may have reached
 * Casper. Such a turn records no mark, so a copy cut at the record's mark may miss its request. Failures before the
 * prompt, and a mention that could not be read, leave Casper's conversation as it was.
 * @param ends - the Session's turn endings, in log order.
 * @param recordSeq - the position of the conversation record the fork copies from.
 * @param inheritedEventCount - how many events the fork inherited.
 * @returns true when the copy may miss a request the fork shows.
 */
function forkBehind(ends: readonly ConversationTurnEnd[], recordSeq: number, inheritedEventCount: number): boolean {
  return ends.some(({ seq, reason }) => seq > recordSeq && seq < inheritedEventCount && (reason.kind === 'aborted'
    || (reason.kind === 'error' && !BEFORE_PROMPT.has(reason.error?.code ?? '') && !(reason.error?.code ?? '').startsWith('SESSION_REFERENCE_'))))
}
