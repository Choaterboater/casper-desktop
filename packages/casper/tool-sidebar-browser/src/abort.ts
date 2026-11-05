/** Cancellation helper shared by the Host tools. */

import { addAbortListener } from 'node:events'

/**
 * Wait for a promise unless the signal aborts first. The promise keeps running; its later settlement is ignored.
 * @param promise - the awaited work.
 * @param signal - caller cancellation.
 * @returns the promise's value.
 * @throws `signal.reason` once the signal aborts, or the promise's rejection.
 */
export async function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const cancelled = Promise.withResolvers<never>()
  using _listener = addAbortListener(signal, () => {
    cancelled.reject(signal.reason)
  })
  return await Promise.race([promise, cancelled.promise])
}
