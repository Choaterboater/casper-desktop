import { describe, expect, it } from 'vitest'
import { CONVERSATION_RECORD, conversationMarkOf, conversationRecord, inheritedConversation } from '../src/conversation.ts'

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

describe('inheritedConversation', () => {
  const record = (seq: number, data: unknown, type: string = CONVERSATION_RECORD) => ({ type, seq, data })

  it('takes the last conversation record the fork inherited', () => {
    const records = [
      record(3, { acpSessionId: 'conversation-1', mark: 'entry-1' }),
      record(5, { current: null }, 'plugin:casper-agent/models'),
      record(8, { acpSessionId: 'conversation-1', mark: 'entry-2' }),
    ]
    expect(inheritedConversation(records, 9)).toEqual({ acpSessionId: 'conversation-1', mark: 'entry-2', behind: false })
    expect(inheritedConversation(records.slice(0, 2), 8)).toEqual({ acpSessionId: 'conversation-1', mark: 'entry-1', behind: false })
  })

  it('drops a mark session/fork would refuse and keeps the id', () => {
    for (const mark of ['a/b', '', 'x'.repeat(129)]) {
      const read = inheritedConversation([record(1, { acpSessionId: 'conversation-1', mark })], 2)
      expect(read).toEqual({ acpSessionId: 'conversation-1', behind: false })
      expect(Object.keys(read ?? {})).toEqual(['acpSessionId', 'behind'])
    }
    expect(inheritedConversation([record(1, { acpSessionId: 'conversation-1' })], 2)).toEqual({ acpSessionId: 'conversation-1', behind: false })
  })

  it('is null when the fork inherited no record, or the last one is not valid', () => {
    expect(inheritedConversation([], 4)).toBeNull()
    expect(inheritedConversation([record(1, { current: null }, 'plugin:casper-agent/models')], 4)).toBeNull()
    for (const data of [null, {}, { acpSessionId: '' }, { acpSessionId: 7 }, { acpSessionId: 'conversation-1', mark: 7 }]) {
      expect(inheritedConversation([record(0, { acpSessionId: 'conversation-0', mark: 'entry-0' }), record(1, data)], 4)).toBeNull()
    }
  })

  it('says the copy may miss a request when an inherited turn after the record was stopped or failed once sent', () => {
    const records = [record(3, { acpSessionId: 'conversation-1', mark: 'entry-1' })]
    const end = (seq: number, reason: { kind: string; error?: { code: string } }) => ({ seq, reason })
    const behind = (ends: Parameters<typeof inheritedConversation>[2], count = 20) => inheritedConversation(records, count, ends)?.behind
    // A completed or blocked turn records a mark or sends nothing, and a turn before the record is in the copy.
    expect(behind([end(2, { kind: 'aborted' }), end(4, { kind: 'completed' }), end(6, { kind: 'blocked' })])).toBe(false)
    expect(behind([end(6, { kind: 'aborted' })])).toBe(true)
    expect(behind([end(6, { kind: 'error', error: { code: 'CASPER_RPC_-32603' } })])).toBe(true)
    expect(behind([end(6, { kind: 'error', error: { code: 'CASPER_EXITED' } })])).toBe(true)
    // A failure before the prompt reached Casper, or a mention that could not be read, leaves its conversation as it was.
    for (const code of ['CASPER_NOT_FOUND', 'CASPER_START_FAILED', 'CASPER_EMPTY_PROMPT', 'CASPER_MODEL_UNAVAILABLE', 'CASPER_NO_ACCESS_MODES', 'SESSION_REFERENCE_NOT_FOUND']) {
      expect(behind([end(6, { kind: 'error', error: { code } })])).toBe(false)
    }
    // A turn past the fork point is not the fork's.
    expect(behind([end(6, { kind: 'aborted' })], 6)).toBe(false)
  })

  it('is undefined once the Session has a conversation record of its own', () => {
    const records = [record(1, { acpSessionId: 'conversation-1', mark: 'entry-1' }), record(6, { acpSessionId: 'copy-1', mark: 'entry-2' })]
    expect(inheritedConversation(records, 4)).toBeUndefined()
    expect(inheritedConversation(records, 6)).toBeUndefined()
  })
})
