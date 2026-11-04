/**
 * Host owner of the `authorization` Remote namespace: the sign-in half of
 * `ctx.authorization` as a configuration page drives it. A page lists the
 * registered flows, opens one attempt as a stream of notices and prompts,
 * answers each prompt through a separate call, and can cancel or sign out.
 *
 * No method returns a credential. Prompt answers cross toward the Host only,
 * and notices are the flow's own secret-free reports.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/src/authorization.ts
 */

import { Context } from '@deepseek-ai/cordis'
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type { AuthorizationPrompt, AuthorizationService } from '@deepseek-ai/dsh-authorization'
import { parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { AuthorizationEntryView, AuthorizationEventView } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `authorization` Remote namespace. */
    authorizationController: AuthorizationController
  }
}

/** One prompt waiting for its page's answer. */
interface PendingPrompt {
  readonly resolve: (value: string) => void
  readonly reject: (error: Error) => void
}

/** Raised when a prompt's own signal withdraws it; deliberately not a decline. */
class PromptWithdrawnError extends Error {
  constructor() {
    super('the authorization prompt was withdrawn by its flow')
    this.name = 'PromptWithdrawnError'
  }
}

/**
 * A single-consumer queue bridging the attempt's callbacks to the stream's
 * async iteration. `close()` ends iteration once the buffered frames drain.
 */
class EventQueue {
  private readonly items: AuthorizationEventView[] = []
  private wake: (() => void) | undefined
  private closed = false

  push(item: AuthorizationEventView): void {
    if (this.closed) return
    this.items.push(item)
    this.wake?.()
  }

  close(): void {
    this.closed = true
    this.wake?.()
  }

  async *drain(): AsyncIterable<AuthorizationEventView> {
    for (;;) {
      const next = this.items.shift()
      if (next !== undefined) { yield next; continue }
      if (this.closed) return
      await new Promise<void>((resolve) => { this.wake = resolve })
      this.wake = undefined
    }
  }
}

/** Project a flow prompt onto the wire frame, keeping only declared fields. */
function promptFrame(promptId: string, prompt: AuthorizationPrompt): AuthorizationEventView {
  switch (prompt.kind) {
    case 'select':
      return {
        type: 'prompt', promptId, kind: 'select', message: prompt.message,
        options: prompt.options.map(option => ({
          id: option.id, label: option.label,
          ...option.description === undefined ? {} : { description: option.description },
        })),
      }
    case 'text':
    case 'secret':
      return {
        type: 'prompt', promptId, kind: prompt.kind, message: prompt.message,
        ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
      }
  }
}

/**
 * Host service backing the generated `ctx.remote.authorization` namespace. It
 * stays registered when no authorization seam is mounted, so `list` answers an
 * empty roster and the other calls report the missing service.
 */
export class AuthorizationController extends TypertRemoteService {
  private readonly prompts = new Map<string, PendingPrompt>()
  private nextPrompt = 0

  /** @param ctx - Host context where `ctx.authorization` and `ctx.credentials` may be mounted. */
  constructor(ctx: Context) {
    super(ctx, 'authorizationController', { namespace: 'authorization' })
  }

  /**
   * List every registered sign-in flow with whether it is signed in.
   * @returns one view per flow in registration order; empty when no seam is mounted.
   */
  @Remote
  async list(): Promise<AuthorizationEntryView[]> {
    const authorization = this.ctx.get('authorization')
    if (authorization === undefined) return []
    const credentials = this.ctx.get('credentials')
    return Promise.all(authorization.list().map(async entry => ({
      key: entry.key,
      label: entry.label,
      methods: entry.methods.map(method => ({ id: method.id, label: method.label })),
      inFlight: entry.inFlight,
      signedIn: credentials === undefined ? false : (await credentials.describeRecord(entry.key)).configured,
    })))
  }

  /**
   * Run one sign-in attempt and stream its notices, prompts, and outcome.
   * Closing the stream withdraws the attempt.
   * @param key - the `<scope>/<id>` record a listed flow writes.
   * @param method - one of that flow's method ids, or undefined for its first.
   * @param signal - stream lifetime; aborting cancels the attempt.
   * @returns frames ending with `settled` or `failed`.
   * @throws RemoteError when the key names no flow or no seam is mounted.
   */
  @Remote({ mode: 'stream' })
  signIn(key: string, method: string | undefined, signal: AbortSignal): AsyncIterable<AuthorizationEventView> {
    const authorization = this.seam()
    const record = this.flowKey(authorization, key)
    const queue = new EventQueue()
    const owned: string[] = []
    void authorization.begin({
      key: record,
      ...method === undefined ? {} : { method },
      signal,
      interaction: {
        notify: (notice) => {
          queue.push({
            type: 'notice', message: notice.message,
            ...notice.url === undefined ? {} : { url: notice.url },
            ...notice.code === undefined ? {} : { code: notice.code },
          })
        },
        prompt: prompt => new Promise<string>((resolve, reject) => {
          const promptId = `${key}#${String(++this.nextPrompt)}`
          owned.push(promptId)
          const settle = (): void => { this.prompts.delete(promptId) }
          this.prompts.set(promptId, {
            resolve: (value) => { settle(); resolve(value) },
            reject: (error) => { settle(); reject(error) },
          })
          prompt.signal?.addEventListener('abort', () => {
            if (!this.prompts.has(promptId)) return
            this.prompts.get(promptId)?.reject(new PromptWithdrawnError())
            queue.push({ type: 'prompt-withdrawn', promptId })
          }, { once: true })
          queue.push(promptFrame(promptId, prompt))
        }),
      },
    }).then(
      (outcome) => { queue.push({ type: 'settled', status: outcome.status }) },
      (error: unknown) => { queue.push({ type: 'failed', message: error instanceof Error ? error.message : String(error) }) },
    ).finally(() => {
      // A prompt still open when the attempt ends has nobody left to answer it.
      for (const promptId of owned) this.prompts.get(promptId)?.reject(new PromptWithdrawnError())
      queue.close()
    })
    return queue.drain()
  }

  /**
   * Answer one open prompt of a running sign-in.
   * @param promptId - the id its `prompt` frame carried.
   * @param value - the typed text, or the chosen option's id.
   * @throws RemoteError when no prompt with that id is open.
   */
  @Remote
  answer(promptId: string, value: string): void {
    this.pending(promptId).resolve(value)
  }

  /**
   * Decline one open prompt; the attempt settles as cancelled.
   * @param promptId - the id its `prompt` frame carried.
   * @throws RemoteError when no prompt with that id is open.
   */
  @Remote
  decline(promptId: string): void {
    this.pending(promptId).reject(new AuthorizationDeclinedError())
  }

  /**
   * Withdraw the attempt running for a key, if any.
   * @param key - the `<scope>/<id>` record of a listed flow.
   * @throws RemoteError when the key names no flow or no seam is mounted.
   */
  @Remote
  cancel(key: string): void {
    const authorization = this.seam()
    authorization.cancel(this.flowKey(authorization, key))
  }

  /**
   * Delete the stored sign-in for a key.
   * @param key - the `<scope>/<id>` record of a listed flow.
   * @throws RemoteError when the key names no flow, a seam is missing, or the store refuses.
   */
  @Remote
  async signOut(key: string): Promise<void> {
    const record = this.flowKey(this.seam(), key)
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) {
      throw new RemoteError('gateway/internal', 'credentials service is absent: sign-out has nothing to delete', {})
    }
    try {
      await credentials.deleteRecord(record)
    } catch (error: unknown) {
      throw new RemoteError('authorization/rejected', error instanceof Error ? error.message : String(error), { key }, { cause: error })
    }
  }

  /** Resolve the optional seam or report how to supply it. */
  private seam(): AuthorizationService {
    const authorization = this.ctx.get('authorization')
    if (authorization === undefined) {
      throw new RemoteError('gateway/internal', 'authorization service is absent: this deployment mounts no sign-in flows', {})
    }
    return authorization
  }

  /** Brand a wire key, accepting only one a registered flow claims. */
  private flowKey(authorization: AuthorizationService, key: string): CredentialKey {
    let record: CredentialKey
    try {
      record = parseCredentialKey(key)
    } catch {
      throw new RemoteError('authorization/rejected', `"${key}" is not a credential record key`, { key })
    }
    if (authorization.describe(record) === undefined) {
      throw new RemoteError('authorization/rejected', `no sign-in flow is registered for "${key}"`, { key })
    }
    return record
  }

  /** Look up an open prompt or report that it is gone. */
  private pending(promptId: string): PendingPrompt {
    const prompt = this.prompts.get(promptId)
    if (prompt === undefined) {
      throw new RemoteError('authorization/rejected', 'that sign-in question is no longer open', { key: promptId.split('#')[0] ?? '' })
    }
    return prompt
  }
}

export default AuthorizationController
