import { describe, expect, it } from 'vitest'
import { casperReceiptOf, recordedReceipt, usageModelOf, usageOf } from '../src/receipt.ts'

/** A `usage_update` carrying these response counts and this model. */
function update(response: Record<string, unknown>, model?: unknown): { _meta: unknown } {
  return { _meta: { casper: { response, ...model === undefined ? {} : { model } } } }
}

describe('usageOf', () => {
  it('keeps a total equal to the prompt sum plus output when both cache counts are present', () => {
    expect(usageOf(update({ input: 100, cacheRead: 40, cacheWrite: 10, output: 20, tokens: 170, toolUse: true }))).toEqual({
      tokens: { inputTokens: 100, outputTokens: 20, totalTokens: 170, cacheReadTokens: 40, cacheWriteTokens: 10 }, toolUse: true,
    })
    expect(usageOf(update({ input: 100, cacheRead: 40, cacheWrite: 10, output: 20, tokens: 171 }))?.tokens).toEqual({
      inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 10,
    })
  })

  it('keeps a total of at least the sum when a cache count is missing, and turns nulls into absent fields', () => {
    expect(usageOf(update({ input: 100, cacheRead: null, cacheWrite: 10, output: 20, tokens: 200 }))).toEqual({
      tokens: { inputTokens: 100, outputTokens: 20, totalTokens: 200, cacheWriteTokens: 10 }, toolUse: false,
    })
    expect(usageOf(update({ input: 100, cacheRead: 5, output: 20, tokens: 110 }))?.tokens)
      .toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 })
    expect(usageOf(update({ input: 100, output: 20, tokens: null }))?.tokens).toEqual({ inputTokens: 100, outputTokens: 20 })
  })

  it('reads nothing unless input and output are counts', () => {
    expect(usageOf(update({ input: null, output: 20, tokens: 20 }))).toBeUndefined()
    expect(usageOf(update({ input: 10, output: null }))).toBeUndefined()
    expect(usageOf(update({ input: 10 }))).toBeUndefined()
    expect(usageOf(update({ input: -1, output: 2 }))).toBeUndefined()
    expect(usageOf(update({ input: 1.5, output: 2 }))).toBeUndefined()
    expect(usageOf({ _meta: { casper: {} } })).toBeUndefined()
    expect(usageOf({})).toBeUndefined()
  })
})

describe('usageModelOf', () => {
  it('names the model as provider/model, the model alone, or nothing', () => {
    expect(usageModelOf(update({}, { provider: 'openai', model: 'gpt-5' }))).toBe('openai/gpt-5')
    expect(usageModelOf(update({}, { provider: null, model: 'gpt-5' }))).toBe('gpt-5')
    expect(usageModelOf(update({}, { provider: '', model: 'gpt-5' }))).toBe('gpt-5')
    expect(usageModelOf(update({}, { provider: 'openai', model: null }))).toBeUndefined()
    expect(usageModelOf(update({}, null))).toBeUndefined()
    expect(usageModelOf(update({}))).toBeUndefined()
    expect(usageModelOf({})).toBeUndefined()
  })
})

describe('casperReceiptOf', () => {
  const receipt = {
    outcome: 'verified', verdict: 'Verified', exitCode: 0, changed: null, checksRun: [], checksNotRun: [], text: 'Verified',
    json: { type: 'receipt' },
  }

  it('reads an older Casper\'s receipt without usage, cost or root, and drops the json event', () => {
    expect(casperReceiptOf({ casper: { receipt } })).toEqual({
      outcome: 'verified', verdict: 'Verified', exitCode: 0, changed: null, checksRun: [], checksNotRun: [], text: 'Verified',
    })
    expect(recordedReceipt(casperReceiptOf({ casper: { receipt } }))).toBeDefined()
  })

  it('reads nothing from a chunk without a whole receipt', () => {
    expect(casperReceiptOf(undefined)).toBeUndefined()
    expect(casperReceiptOf({ casper: { note: true } })).toBeUndefined()
    expect(casperReceiptOf({ casper: { receipt: { outcome: 'verified' } } })).toBeUndefined()
    expect(casperReceiptOf({ casper: { receipt: { ...receipt, cost: 'free' } } })).toBeUndefined()
    expect(recordedReceipt({ ...receipt, root: '' })).toBeUndefined()
  })
})
