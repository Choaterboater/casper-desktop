/**
 * Casper's receipt and usage data as the app reads them from ACP `_meta`:
 * the receipt on the last message chunk, and a response's tokens on each
 * `usage_update`. Only zod is imported, so both halves can use it.
 * @module @deepseek-ai/dsh-casper-agent/receipt
 */

import { z } from 'zod'

/** Tool name of the call that records Casper's receipt, and the key of its card. */
export const CASPER_RECEIPT = 'casper_receipt'

/**
 * ACP id of a turn's receipt call; the Session's call id ends with it.
 * @param turn - the turn the receipt ends.
 * @returns the id the turn writer records the call under.
 */
export function receiptAcpId(turn: number): string {
  return `casper-receipt-${String(turn)}`
}

/**
 * Test whether a call id is a receipt call's, so its result is known without its call.
 * @param callId - a recorded call id.
 * @returns whether it ends with a receipt's ACP id.
 */
export function isReceiptCallId(callId: string): boolean {
  return /(?:^|:)casper-receipt-\d+$/.test(callId)
}

const count = z.number().int().nonnegative()

/** How a receipt's cost is paid: OpenRouter's is charged, another provider's a catalog estimate, a subscription's has none. */
export type CasperCostKind = 'charged' | 'estimate' | 'subscription'

const receiptSchema = z.object({
  outcome: z.string(),
  verdict: z.string(),
  exitCode: z.number().int(),
  /** Files the request changed; null when Casper could not compare the workspace. */
  changed: z.array(z.string()).nullable(),
  checksRun: z.array(z.object({
    name: z.string(),
    status: z.enum(['pass', 'fail']),
    command: z.string().nullable(),
    exit: z.number().int().nullable(),
    ms: z.number().nonnegative(),
    fresh: z.boolean(),
  })),
  checksNotRun: z.array(z.object({ name: z.string(), reason: z.string() })),
  /** The readable receipt. */
  text: z.string(),
  /** The task's model use; null when no model task ran. An older Casper sends none. */
  usage: z.object({
    turns: count,
    tokens: count.nullable(),
    estimatedCost: z.number().nonnegative().nullable(),
  }).nullable().optional(),
  cost: z.enum(['charged', 'estimate', 'subscription']).nullable().optional(),
  /** The folder the changed files are in. An older Casper sends none. */
  root: z.string().min(1).optional(),
})

/** The receipt fields the app shows; the full `json` receipt event Casper also sends is not kept. */
export type CasperReceipt = z.infer<typeof receiptSchema>

const receiptMetaSchema = z.object({ casper: z.object({ receipt: receiptSchema }) })

/**
 * Read Casper's receipt from a message chunk's `_meta`.
 * @param meta - the chunk's `_meta`.
 * @returns the receipt, or undefined when the chunk carries none or it does not parse.
 */
export function casperReceiptOf(meta: unknown): CasperReceipt | undefined {
  const parsed = receiptMetaSchema.safeParse(meta)
  return parsed.success ? parsed.data.casper.receipt : undefined
}

/**
 * Read a recorded receipt card's meta.
 * @param meta - the `casper_receipt` result's meta.
 * @returns the receipt, or undefined when it does not parse.
 */
export function recordedReceipt(meta: unknown): CasperReceipt | undefined {
  const parsed = receiptSchema.safeParse(meta)
  return parsed.success ? parsed.data : undefined
}

/** One response's tokens in the Session's usage shape (`TokenUsage`). */
export interface CasperTokens {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

/** One response's usage sample. */
export interface CasperUsage {
  readonly tokens: CasperTokens
  /** Whether the response ended to run tools, so its tool call commits it. */
  readonly toolUse: boolean
}

const usageMetaSchema = z.object({
  casper: z.object({
    response: z.object({
      input: count.nullish(),
      cacheRead: count.nullish(),
      cacheWrite: count.nullish(),
      output: count.nullish(),
      tokens: count.nullish(),
      toolUse: z.boolean().optional(),
    }),
    model: z.object({ provider: z.string().nullish(), model: z.string().nullish() }).nullish(),
  }),
})

/**
 * Read one response's tokens from a `usage_update`'s `_meta.casper.response`.
 * Nulls become absent; the total is kept only when it agrees with the parts
 * (equal to the prompt sum plus output when both cache counts are present, at
 * least that sum otherwise).
 * @param update - the `usage_update`.
 * @returns the sample, or undefined unless input and output are counts.
 */
export function usageOf(update: { readonly _meta?: unknown }): CasperUsage | undefined {
  const parsed = usageMetaSchema.safeParse(update._meta)
  if (!parsed.success) return undefined
  const { input, cacheRead, cacheWrite, output, tokens, toolUse } = parsed.data.casper.response
  if (input === null || input === undefined || output === null || output === undefined) return undefined
  const sum = input + (cacheRead ?? 0) + (cacheWrite ?? 0) + output
  const bothCaches = cacheRead !== null && cacheRead !== undefined && cacheWrite !== null && cacheWrite !== undefined
  const consistent = tokens !== null && tokens !== undefined && (bothCaches ? tokens === sum : tokens >= sum)
  const total = consistent ? tokens : undefined
  return {
    tokens: {
      inputTokens: input,
      outputTokens: output,
      ...total === undefined ? {} : { totalTokens: total },
      ...cacheRead === null || cacheRead === undefined ? {} : { cacheReadTokens: cacheRead },
      ...cacheWrite === null || cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite },
    },
    toolUse: toolUse === true,
  }
}

/**
 * The model a `usage_update` names, as `<provider>/<model>`.
 * @param update - the `usage_update`.
 * @returns the name, the model alone without a provider, or undefined when Casper names none.
 */
export function usageModelOf(update: { readonly _meta?: unknown }): string | undefined {
  const parsed = usageMetaSchema.safeParse(update._meta)
  const named = parsed.success ? parsed.data.casper.model : undefined
  const model = named?.model ?? ''
  if (model === '') return undefined
  const provider = named?.provider ?? ''
  return provider === '' ? model : `${provider}/${model}`
}
