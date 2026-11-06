import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { FileAttachmentRef, ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, fileHandleText } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { hasPromptContent, promptContent, TEXT_ONLY_PICTURE, UNREADABLE_PICTURE } from '../src/prompt.ts'
import type { PromptAttachments } from '../src/prompt.ts'

const PICTURE: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png', bytes: 3, width: 1, height: 1, name: 'shot.png',
}
const NOTES: FileAttachmentRef = { attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`), name: 'notes.txt', bytes: 2048 }
const HOST_PATH = join('/attachments', 'files', 'notes.txt')

function user(content: UserMessage['content']): UserMessage {
  return createUserMessage({ content, source: { kind: 'user' } })
}

/** An attachment service whose picture reads return fixed bytes and whose files live under one folder. */
function service(overrides: Partial<PromptAttachments> = {}): PromptAttachments {
  return {
    readImage: (ref: ImageAttachmentRef): Promise<StoredImageAttachment> => Promise.resolve({ ref, data: Uint8Array.of(1, 2, 3) }),
    fileHostPath: () => HOST_PATH,
    ...overrides,
  }
}

const live = new AbortController().signal

describe('promptContent', () => {
  it('keeps text, pictures, and files in the order the claimed messages hold them', async () => {
    const content = await promptContent([
      user([{ type: 'text', text: 'Why is this button grey?' }, { type: 'image', attachment: PICTURE }]),
      user([{ type: 'text', text: '  ' }, { type: 'file', attachment: NOTES }, { type: 'text', text: 'and this' }]),
    ], { attachments: service(), images: true, signal: live })
    expect(content).toEqual({
      blocks: [
        { type: 'text', text: 'Why is this button grey?' },
        { type: 'image', mimeType: 'image/png', data: 'AQID' },
        { type: 'resource_link', uri: pathToFileURL(HOST_PATH).href, name: 'notes.txt', size: 2048 },
        { type: 'text', text: 'and this' },
      ],
      notes: [],
      readable: true,
    })
  })

  it('sends a placeholder and a note for a picture when Casper takes text only', async () => {
    const content = await promptContent([user([{ type: 'text', text: 'look' }, { type: 'image', attachment: PICTURE }])],
      { attachments: service(), images: false, signal: live })
    expect(content.blocks).toEqual([{ type: 'text', text: 'look' }, { type: 'text', text: TEXT_ONLY_PICTURE }])
    expect(content.notes).toEqual(['This Casper takes text only, so the picture was not sent. Update Casper to send pictures.\n'])
    expect(content.readable).toBe(true)
  })

  it('sends a placeholder and a note for a picture that cannot be read or has no service', async () => {
    const failing = service({ readImage: () => Promise.reject(new Error('digest mismatch')) })
    for (const attachments of [failing, undefined]) {
      const content = await promptContent([user([{ type: 'image', attachment: PICTURE }])], { attachments, images: true, signal: live })
      expect(content).toEqual({
        blocks: [{ type: 'text', text: UNREADABLE_PICTURE }],
        notes: ['The picture could not be read, so it was not sent.\n'],
        readable: false,
      })
    }
  })

  it('sends a file with no host path as its handle text with a note', async () => {
    const malformed = service({ fileHostPath: () => { throw new Error('bad reference') } })
    for (const attachments of [service({ fileHostPath: () => undefined }), malformed, undefined]) {
      const content = await promptContent([user([{ type: 'file', attachment: NOTES }])], { attachments, images: true, signal: live })
      expect(content).toEqual({
        blocks: [{ type: 'text', text: fileHandleText(NOTES, undefined) }],
        notes: ['Casper could not be given a path to notes.txt, so it was not sent.\n'],
        readable: false,
      })
    }
  })

  it('passes an abort during a picture read on instead of sending a placeholder', async () => {
    const stop = new AbortController()
    const reason = new Error('stopped')
    const attachments = service({
      readImage: (_ref, signal) => { stop.abort(reason); return Promise.reject(signal?.reason as Error) },
    })
    await expect(promptContent([user([{ type: 'image', attachment: PICTURE }])], { attachments, images: true, signal: stop.signal }))
      .rejects.toBe(reason)
  })

  it('leaves out blocks that do not belong in a user prompt', async () => {
    const content = await promptContent([user([{ type: 'reasoning', text: 'thinking' } as never, { type: 'text', text: 'hi' }])],
      { attachments: undefined, images: false, signal: live })
    expect(content).toEqual({ blocks: [{ type: 'text', text: 'hi' }], notes: [], readable: true })
  })
})

describe('hasPromptContent', () => {
  it('finds words, a picture, or a file in any claimed message', () => {
    expect(hasPromptContent([])).toBe(false)
    expect(hasPromptContent([user([{ type: 'text', text: '  ' }])])).toBe(false)
    expect(hasPromptContent([user([{ type: 'text', text: '' }]), user([{ type: 'text', text: 'plain' }])])).toBe(true)
    expect(hasPromptContent([user([{ type: 'image', attachment: PICTURE }])])).toBe(true)
    expect(hasPromptContent([user([{ type: 'file', attachment: NOTES }])])).toBe(true)
  })
})
