import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { carriesAttachments, promptBlocks } from '../src/prompt.ts'

/** An image block; only its type matters to the prompt builder. */
const IMAGE = { type: 'image' } as never
/** A file block; only its type matters to the prompt builder. */
const FILE = { type: 'file' } as never

function user(content: UserMessage['content']): UserMessage {
  return createUserMessage({ content, source: { kind: 'user' } })
}

describe('promptBlocks', () => {
  it('keeps every text block of every claimed message in order', () => {
    expect(promptBlocks([
      user([{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }]),
      user([{ type: 'text', text: 'third' }]),
    ])).toEqual([{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }, { type: 'text', text: 'third' }])
  })

  it('leaves out images, files, and blank text', () => {
    expect(promptBlocks([user([IMAGE, { type: 'text', text: '  ' }, { type: 'text', text: 'look' }])])).toEqual([{ type: 'text', text: 'look' }])
  })

  it('gives no blocks when nothing is text', () => {
    expect(promptBlocks([])).toEqual([])
    expect(promptBlocks([user([IMAGE])])).toEqual([])
  })
})

describe('carriesAttachments', () => {
  it('finds an image or file in any claimed message', () => {
    expect(carriesAttachments([user([{ type: 'text', text: 'plain' }])])).toBe(false)
    expect(carriesAttachments([])).toBe(false)
    expect(carriesAttachments([user([{ type: 'text', text: 'a' }]), user([IMAGE, { type: 'text', text: 'look' }])])).toBe(true)
    expect(carriesAttachments([user([FILE])])).toBe(true)
  })
})
