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
