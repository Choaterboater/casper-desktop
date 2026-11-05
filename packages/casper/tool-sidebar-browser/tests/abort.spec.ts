import { describe, expect, it } from 'vitest'
import { untilAborted } from '../src/abort.ts'

describe('untilAborted', () => {
  it('settles with the promise while the signal is live', async () => {
    const signal = new AbortController().signal
    await expect(untilAborted(Promise.resolve(1), signal)).resolves.toBe(1)
    await expect(untilAborted(Promise.reject(new Error('failed')), signal)).rejects.toThrow('failed')
  })

  it('rejects with the abort reason, before or while waiting', async () => {
    const before = new AbortController()
    before.abort(new Error('early'))
    await expect(untilAborted(new Promise(() => {}), before.signal)).rejects.toThrow('early')
    const during = new AbortController()
    const pending = Promise.withResolvers<number>()
    const waiting = untilAborted(pending.promise, during.signal)
    during.abort(new Error('late'))
    await expect(waiting).rejects.toThrow('late')
    pending.resolve(1)
  })
})
