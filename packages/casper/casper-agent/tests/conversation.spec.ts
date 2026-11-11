import { describe, expect, it } from 'vitest'
import { conversationMarkOf, conversationRecord } from '../src/conversation.ts'

describe('conversationMarkOf', () => {
  it('reads a mark in the shape session/fork takes', () => {
    expect(conversationMarkOf({ casper: { mark: 'entry_1-A', receipt: { outcome: 'verified' } } })).toBe('entry_1-A')
    expect(conversationMarkOf({ casper: { mark: 'x'.repeat(128) } })).toBe('x'.repeat(128))
  })

  it('leaves out a missing mark or one session/fork would refuse', () => {
    for (const meta of [
      undefined, null, 'mark', {}, { casper: null }, { casper: {} }, { casper: { receipt: { outcome: 'verified' } } },
      { casper: { mark: 7 } }, { casper: { mark: null } }, { casper: { mark: '' } }, { casper: { mark: 'a/b' } },
      { casper: { mark: 'a b' } }, { casper: { mark: 'x'.repeat(129) } }, { mark: 'entry-1' },
    ]) expect(conversationMarkOf(meta)).toBeUndefined()
  })
})

describe('conversationRecord', () => {
  it('leaves an absent mark out, so the record is plain JSON', () => {
    expect(conversationRecord('conversation-1', 'entry-1')).toEqual({ acpSessionId: 'conversation-1', mark: 'entry-1' })
    const bare = conversationRecord('conversation-1', undefined)
    expect(bare).toEqual({ acpSessionId: 'conversation-1' })
    expect(Object.keys(bare)).toEqual(['acpSessionId'])
  })
})
