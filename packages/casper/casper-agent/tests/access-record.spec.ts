import { describe, expect, it } from 'vitest'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { casperAccessProjectionDefinition } from '../src/access-projection.ts'
import { ACCESS_RECORD, casperOwnAccessSchema } from '../src/access-record.ts'

/** A committed plugin record as the log stores it. */
function record(type: string, data: unknown, seq = 1): SessionEvent {
  return { seq, time: seq, type, data, ignorable: true } as never
}

describe('casperAccess', () => {
  const definition = casperAccessProjectionDefinition
  const init = definition.init({} as never, SessionLogOffset(0))

  it('folds each access record and shows null for none', () => {
    expect(init).toEqual({ mode: null })
    expect(definition.wire.view(init)).toBeNull()
    const full = definition.apply(init, record(ACCESS_RECORD, { mode: 'full' }))
    expect(definition.wire.view(full)).toEqual({ mode: 'full' })
    // An unchanged mode keeps the state and the view's reference.
    const again = definition.apply(full, record(ACCESS_RECORD, { mode: 'full' }, 2))
    expect(again).toBe(full)
    expect(definition.wire.view(again)).toBe(definition.wire.view(full))
    const cleared = definition.apply(full, record(ACCESS_RECORD, { mode: null }, 3))
    expect(definition.wire.view(cleared)).toBeNull()
    expect(definition.wire.summary).toBe(false)
  })

  it('skips a malformed record, one a newer writer extended, and every other event', () => {
    const full = definition.apply(init, record(ACCESS_RECORD, { mode: 'full' }))
    for (const event of [
      record(ACCESS_RECORD, { mode: 'everything' }),
      record(ACCESS_RECORD, { mode: 'ask', note: 'newer' }),
      record(ACCESS_RECORD, null),
      record(ACCESS_RECORD, {}),
      record('plugin:casper-agent/models', { mode: 'ask' }),
      { seq: 9, time: 9, type: 'turn/start', data: { turn: 1 } } as never,
    ]) expect(definition.apply(full, event)).toBe(full)
    expect(casperOwnAccessSchema.safeParse({ mode: 'read' }).success).toBe(true)
  })
})
