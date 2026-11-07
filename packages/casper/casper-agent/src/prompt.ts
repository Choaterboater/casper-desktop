/**
 * The ACP prompt sent to Casper for one turn's claimed messages.
 * @module @deepseek-ai/dsh-casper-agent/prompt
 */

import { Buffer } from 'node:buffer'
import { pathToFileURL } from 'node:url'
import type { ContentBlock as AcpContentBlock } from '@agentclientprotocol/sdk'
import type { AttachmentStore, FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { fileHandleText } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { encodeSessionReferenceUri } from '@deepseek-ai/dsh-session-reference'
import type { PreparedReference, PreparedReferences } from './references.ts'

/** Text sent in place of a picture when Casper's `initialize` reply does not set `promptCapabilities.image`. */
export const TEXT_ONLY_PICTURE = '[A picture was attached in the app, but this Casper takes text only, so it was not sent.]'

/** Text sent in place of a picture the attachment service could not read. */
export const UNREADABLE_PICTURE = '[A picture was attached in the app but could not be read, so it was not sent.]'

/**
 * Over this many UTF-8 bytes, the mentioned Sessions go as a text block: Casper
 * cuts embedded text past 256 KiB, and a text block reaches it whole.
 */
export const MAX_EMBEDDED_REFERENCE_BYTES = 250 * 1024

/** Note shown when the mentioned Sessions went as a text block because of their size. */
export const LARGE_REFERENCES_NOTE = 'The referenced sessions went as plain text because they are large.\n'

/** The attachment reads the prompt needs; absent when no attachment service is mounted. */
export type PromptAttachments = Pick<AttachmentStore, 'readImage' | 'fileHostPath'>

/** Inputs for {@link promptContent}. */
export interface PromptContentOptions {
  /** The attachment service; without it pictures are unreadable and files have no path. */
  readonly attachments: PromptAttachments | undefined
  /** Whether Casper takes image blocks. */
  readonly images: boolean
  /** Aborts the picture reads. */
  readonly signal: AbortSignal
  /** The claimed messages that mention other Sessions, as the session-reference service prepared them. */
  readonly references?: PreparedReferences | undefined
  /** Whether Casper takes embedded context (`resource` blocks); without it the mentioned Sessions go as text. */
  readonly embedded?: boolean
}

/** One turn's prompt and the notes shown to the user about what was not sent. */
export interface PromptContent {
  /** The prompt blocks in the order the claimed messages hold them. */
  readonly blocks: AcpContentBlock[]
  /** One line per attachment that went as a text placeholder, each ending in a newline. */
  readonly notes: string[]
  /** Whether a block carries the user's words, a picture, or a file path; false when only placeholders remain. */
  readonly readable: boolean
}

/**
 * Whether the claimed messages carry anything to send: non-blank text, an image, or a file.
 * @param messages - the user messages claimed for the turn.
 * @returns false when every block is blank text.
 */
export function hasPromptContent(messages: readonly UserMessage[]): boolean {
  return messages.some(message => message.content.some(block =>
    block.type === 'image' || block.type === 'file' || (block.type === 'text' && block.text.trim() !== '')))
}

/**
 * Build the ACP prompt for one turn. Text blocks that are not blank pass
 * unchanged. A picture becomes an `image` block of its stored normalized
 * bytes; a file becomes a `resource_link` to its read-only host copy, which
 * Casper reads with its file tools. A picture Casper cannot take or the
 * service cannot read, and a file with no host path, become text placeholders
 * with a note each. A message that mentions other Sessions sends its words
 * with each mention as `@label`, then the Sessions' snapshot as one `resource`
 * whose URI names the first of them, so Casper reads it as context and not as
 * the request; without embedded context, or over
 * {@link MAX_EMBEDDED_REFERENCE_BYTES}, the snapshot goes as a text block.
 * @param messages - the user messages claimed for the turn, in claim order.
 * @param options - the attachment service, Casper's image capability, and the turn signal.
 * @returns the blocks, the notes, and whether anything beyond placeholders is sent.
 * @throws the signal's reason when the turn is aborted during a picture read.
 */
export async function promptContent(messages: readonly UserMessage[], options: PromptContentOptions): Promise<PromptContent> {
  const blocks: AcpContentBlock[] = []
  const notes: string[] = []
  let readable = false
  for (const message of messages) {
    const reference = options.references?.get(message.id)
    for (const block of reference?.content ?? message.content) {
      switch (block.type) {
        case 'text':
          if (block.text.trim() === '') break
          blocks.push({ type: 'text', text: block.text })
          readable = true
          break
        case 'image': {
          const image = await imageBlock(block.attachment, options)
          blocks.push(image.block)
          if (image.note === undefined) readable = true
          else notes.push(image.note)
          break
        }
        case 'file': {
          const path = hostPath(block.attachment, options.attachments)
          if (path === undefined) {
            blocks.push({ type: 'text', text: fileHandleText(block.attachment, undefined) })
            notes.push(`Casper could not be given a path to ${block.attachment.name}, so it was not sent.\n`)
          } else {
            blocks.push({ type: 'resource_link', uri: pathToFileURL(path).href, name: block.attachment.name, size: block.attachment.bytes })
            readable = true
          }
          break
        }
        default:
          // Other block kinds do not occur in user messages and are not sent.
          break
      }
    }
    if (reference !== undefined) {
      blocks.push(referenceBlock(reference, options.embedded === true, notes))
      readable = true
    }
  }
  return { blocks, notes, readable }
}

/** The block carrying one message's mentioned Sessions; a large snapshot adds its note. */
function referenceBlock(reference: PreparedReference, embedded: boolean, notes: string[]): AcpContentBlock {
  const { text } = reference
  if (!embedded) return { type: 'text', text }
  if (Buffer.byteLength(text, 'utf8') > MAX_EMBEDDED_REFERENCE_BYTES) {
    notes.push(LARGE_REFERENCES_NOTE)
    return { type: 'text', text }
  }
  return { type: 'resource', resource: { uri: encodeSessionReferenceUri(reference.sessionId), mimeType: 'text/markdown', text } }
}

/** Note shown when Casper takes no pictures. */
const TEXT_ONLY_NOTE = 'This Casper takes text only, so the picture was not sent. Update Casper to send pictures.\n'

/** Note shown when a picture could not be read. */
const UNREADABLE_NOTE = 'The picture could not be read, so it was not sent.\n'

/** The block for one picture, with the note to show when it went as a placeholder. */
async function imageBlock(ref: ImageAttachmentRef, options: PromptContentOptions): Promise<{ block: AcpContentBlock; note?: string }> {
  const unreadable = { block: { type: 'text' as const, text: UNREADABLE_PICTURE }, note: UNREADABLE_NOTE }
  if (!options.images) return { block: { type: 'text', text: TEXT_ONLY_PICTURE }, note: TEXT_ONLY_NOTE }
  if (options.attachments === undefined) return unreadable
  let data: Uint8Array
  try {
    data = (await options.attachments.readImage(ref, options.signal)).data
  } catch (error: unknown) {
    // An abort ends the turn; any other read failure sends the placeholder, and the note tells the user.
    if (options.signal.aborted) throw error
    return unreadable
  }
  return { block: { type: 'image', mimeType: ref.mediaType, data: Buffer.from(data).toString('base64') } }
}

function hostPath(ref: FileAttachmentRef, attachments: PromptAttachments | undefined): string | undefined {
  try {
    return attachments?.fileHostPath(ref)
  } catch (error: unknown) {
    // A malformed durable reference has no path; the file goes as its handle text.
    void error
    return undefined
  }
}
