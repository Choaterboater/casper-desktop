/**
 * Prompt text sent to Casper.
 * @module @deepseek-ai/dsh-casper-agent/prompt
 */

import type { ContentBlock as AcpContentBlock } from '@agentclientprotocol/sdk'
import type { UserMessage } from '@deepseek-ai/dsh-session'

/**
 * Whether any claimed message carries an image or a file. Casper reads text
 * only, so such a turn ends with `CASPER_TEXT_ONLY` rather than running
 * without what the user attached.
 * @param messages - the user messages claimed for the turn.
 * @returns true when an image or file block is present.
 */
export function carriesAttachments(messages: readonly UserMessage[]): boolean {
  return messages.some(message => message.content.some(block => block.type === 'image' || block.type === 'file'))
}

/**
 * Build the ACP prompt for one turn's claimed messages: the text blocks only;
 * callers refuse attachments first with {@link carriesAttachments}.
 * @param messages - the user messages claimed for the turn, in claim order.
 * @returns one text block per non-blank text block; empty when no text remains.
 */
export function promptBlocks(messages: readonly UserMessage[]): AcpContentBlock[] {
  return messages.flatMap(message => message.content.flatMap(block =>
    block.type === 'text' && block.text.trim() !== '' ? [{ type: 'text' as const, text: block.text }] : []))
}
