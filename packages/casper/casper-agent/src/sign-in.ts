/**
 * Casper's own sign-ins, for the Models settings page: the ways Casper signs
 * in, the sign-ins it has saved, one sign-in at a time, and sign-out. Casper's
 * ACP router answers these before any conversation exists (`initialize`'s
 * `authMethods`, `authenticate`, `_casper/auth/update`, `_casper/auth/cancel`,
 * `_casper/auth/status`, `_casper/auth/logout`), and the logins live in
 * Casper's own login file, never in the app's credential store.
 *
 * Each operation starts one `casper acp` process with no conversation, found
 * and spawned as a Session's is, and ends it when the operation ends.
 * @module @deepseek-ai/dsh-casper-agent/src/sign-in
 */

import { Readable, Writable } from 'node:stream'
import { client as createAcpClient, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { ClientConnection } from '@agentclientprotocol/sdk'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Config } from './config.ts'
import { CasperError, casperArgv, casperEnv, casperNotFound, profileEnv } from './connection.ts'
import type { CasperConnectionOptions } from './connection.ts'
import { locateCasper, resolveCasperEngine } from './lookup.ts'
import type { CasperSavedSignIn, CasperSignInFrame, CasperSignInKind, CasperSignInMethod, CasperSignInState } from './types.ts'

export type { CasperSavedSignIn, CasperSignInFrame, CasperSignInKind, CasperSignInMethod, CasperSignInState } from './types.ts'

const KINDS: ReadonlySet<string> = new Set<CasperSignInKind>(['api_key', 'browser', 'device_code'])

/** What {@link CasperSignIn} needs to start Casper. */
export interface CasperSignInOptions {
  /** The subprocess service that spawns Casper. */
  subprocess: SubprocessRuntime
  /** The plugin config: engine, command, environment, and limits. */
  config: Config
  /** The folder Casper starts in; its router opens no conversation there. */
  cwd: string
  /** The app profile Casper is told about, as a Session's Casper is. */
  profile?: CasperConnectionOptions['profile']
}

/** Casper's `_casper/auth/update` params as they arrive. */
interface AuthUpdate {
  methodId?: unknown
  step?: unknown
  url?: unknown
  code?: unknown
  opened?: unknown
}

/** One started router: its requests, its notifications, its listed ways, and its end. */
interface Router {
  readonly methods: CasperSignInMethod[]
  request<T>(method: string, params: Record<string, unknown>): Promise<T>
  notify(method: string, params: Record<string, unknown>): Promise<void>
  onUpdate(listener: (update: AuthUpdate) => void): void
  dispose(): Promise<void>
}

/** Casper's sign-ins over ACP; see the module comment. */
export class CasperSignIn {
  /**
   * @param options - how to start Casper.
   */
  constructor(private readonly options: CasperSignInOptions) {}

  /**
   * Read the ways Casper signs in and the sign-ins it has saved.
   * @param signal - stops the read and Casper with it.
   * @returns the ways the page can show, and the saved sign-ins.
   * @throws CasperError `CASPER_ENGINE_MISSING`, `CASPER_NOT_FOUND` or `CASPER_START_FAILED` when Casper cannot start;
   *   the ACP error when Casper refuses the status request.
   */
  state(signal: AbortSignal): Promise<CasperSignInState> {
    return this.withRouter(signal, async (router) => {
      const status = await router.request<{ signIns?: unknown }>('_casper/auth/status', {})
      return { methods: router.methods, signIns: savedOf(status.signIns) }
    })
  }

  /**
   * Remove the sign-in Casper saved for one provider.
   * @param provider - the provider, as {@link state} names it.
   * @param signal - stops the request and Casper with it.
   * @returns whether there was a sign-in to remove.
   * @throws as {@link state} does.
   */
  signOut(provider: string, signal: AbortSignal): Promise<boolean> {
    return this.withRouter(signal, async (router) => {
      const reply = await router.request<{ removed?: unknown }>('_casper/auth/logout', { provider })
      return reply.removed === true
    })
  }

  /**
   * Run one sign-in and stream its steps. A key goes to Casper in the
   * `authenticate` request only. Stopping `signal` sends `_casper/auth/cancel`
   * and ends Casper; the stream then ends with no last frame.
   * @param methodId - one of {@link state}'s method ids.
   * @param key - the pasted key, for an `api_key` way only.
   * @param signal - the stream's lifetime.
   * @returns the steps, ending with `signed-in` or `failed` unless stopped.
   */
  async *signIn(methodId: string, key: string | undefined, signal: AbortSignal): AsyncIterable<CasperSignInFrame> {
    const frames: CasperSignInFrame[] = []
    let wake: (() => void) | undefined
    const ended = { done: false }
    const push = (frame: CasperSignInFrame): void => {
      frames.push(frame)
      wake?.()
    }
    const run = this.withRouter(signal, async (router) => {
      router.onUpdate((update) => {
        const frame = frameOf(update, methodId)
        if (frame !== undefined) push(frame)
      })
      const reply = await router.request<{ _meta?: { casper?: { provider?: unknown } } }>('authenticate', {
        methodId, ...key === undefined ? {} : { _meta: { casper: { key } } },
      })
      const provider = reply._meta?.casper?.provider
      push({ type: 'signed-in', provider: typeof provider === 'string' ? provider : '' })
    }, router => router.notify('_casper/auth/cancel', {})).catch((error: unknown) => {
      if (!signal.aborted) push({ type: 'failed', message: errorText(error) })
    }).finally(() => {
      ended.done = true
      wake?.()
    })
    const onAbort = (): void => { wake?.() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      for (;;) {
        const next = frames.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        if (ended.done || signal.aborted) return
        await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      // A caller that stops early does not wait for Casper to end; the router ends on its own after the cancel.
      if (!signal.aborted) await run
    }
  }

  /**
   * Run `work` on a started router and end the router after it. A stop once the router is open runs `onStop` first,
   * so a cancel reaches Casper before its stdin closes, then ends the router.
   */
  private async withRouter<T>(
    signal: AbortSignal,
    work: (router: Router) => Promise<T>,
    onStop?: (router: Router) => Promise<void>,
  ): Promise<T> {
    const router = await this.open(signal)
    const stop = (): void => {
      void (async () => {
        await onStop?.(router)
        await router.dispose()
      })()
    }
    signal.addEventListener('abort', stop, { once: true })
    try {
      return await work(router)
    } finally {
      signal.removeEventListener('abort', stop)
      await router.dispose()
    }
  }

  private async open(signal: AbortSignal): Promise<Router> {
    const { config, subprocess, cwd, profile } = this.options
    const engine = resolveCasperEngine(config)
    let executable: string
    try {
      executable = await locateCasper(engine, subprocess, config, signal)
    } catch (error: unknown) {
      signal.throwIfAborted()
      if (error instanceof SubprocessExecutableNotFoundError) throw casperNotFound(engine, error)
      throw new CasperError('CASPER_START_FAILED', `Casper could not start: ${errorText(error)}`, { cause: error })
    }
    signal.throwIfAborted()
    let child: SubprocessHandle
    try {
      child = subprocess.spawn({
        argv: casperArgv(executable, { args: config.args }),
        cwd,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: config.stderrTailBytes } },
        graceMs: config.killGraceMs,
        env: { ...profileEnv(profile), ...casperEnv(config) },
      })
    } catch (error: unknown) {
      throw new CasperError('CASPER_START_FAILED', `Casper could not start: ${errorText(error)}`, { cause: error })
    }
    const dispose = disposer(child, config)
    const onAbort = (): void => { void dispose() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      /* v8 ignore next 3 -- 'pipe' dispositions expose both streams by the subprocess contract. */
      if (child.stdin === undefined || child.stdout === undefined) {
        throw new Error('subprocess dropped a piped protocol stream')
      }
      let listener: ((update: AuthUpdate) => void) | undefined
      const connection: ClientConnection = createAcpClient({ name: 'casper-desktop' })
        .onNotification('_casper/auth/update', params => params as AuthUpdate, ({ params }) => { listener?.(params) })
        .connect(ndJsonStream(
          Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        ))
      const limit = AbortSignal.any([signal, AbortSignal.timeout(config.startTimeoutMs)])
      const initialized = await raceStop(connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }), limit, () => new CasperError('CASPER_START_FAILED', `Casper did not start within ${config.startTimeoutMs} ms`))
      // From here a stop belongs to withRouter, which sends any cancel before Casper's stdin closes.
      signal.removeEventListener('abort', onAbort)
      return {
        methods: methodsOf(initialized.authMethods),
        request: <T>(method: string, params: Record<string, unknown>) => connection.agent.request<T>(method, params),
        notify: async (method, params) => {
          try {
            await connection.agent.notify(method, params)
          } catch (error: unknown) {
            // Casper ended first, so nothing is left to tell.
            void error
          }
        },
        onUpdate: (next) => { listener = next },
        dispose: async () => {
          await dispose()
          connection.close()
        },
      }
    } catch (error: unknown) {
      signal.removeEventListener('abort', onAbort)
      await dispose()
      signal.throwIfAborted()
      if (error instanceof CasperError) throw error
      throw new CasperError('CASPER_START_FAILED', `Casper could not start: ${errorText(error)}`, { cause: error })
    }
  }
}

/** End a router: close stdin, wait `exitGraceMs`, then terminate. Memoized. */
function disposer(child: SubprocessHandle, config: Pick<Config, 'exitGraceMs'>): () => Promise<void> {
  let disposal: Promise<void> | undefined
  return () => (disposal ??= (async () => {
    child.stdin?.end()
    /* v8 ignore next -- waitForExit rejects only when the provider can no longer observe its process range. */
    const unobservable = (): boolean => false
    const exited = await child.waitForExit(AbortSignal.timeout(config.exitGraceMs)).catch(unobservable)
    if (!exited) {
      child.terminate()
      await child.waitForExit().catch(unobservable)
    }
  })())
}

/** Settle with `operation`, or reject when `limit` aborts: the caller's reason, or `timedOut()` for the time limit. */
async function raceStop<T>(operation: Promise<T>, limit: AbortSignal, timedOut: () => Error): Promise<T> {
  limit.throwIfAborted()
  const stopped = Promise.withResolvers<never>()
  const onStop = (): void => { stopped.reject(limit.reason instanceof DOMException && limit.reason.name === 'TimeoutError' ? timedOut() : limit.reason) }
  limit.addEventListener('abort', onStop, { once: true })
  try {
    return await Promise.race([operation, stopped.promise])
  } finally {
    limit.removeEventListener('abort', onStop)
    operation.catch(() => { /* A start that lost the race settles after the child ends. */ })
  }
}

/** The ways the page can show: each listed way with an id, a label, a provider, and a known kind. */
function methodsOf(listed: unknown): CasperSignInMethod[] {
  if (!Array.isArray(listed)) return []
  const found: CasperSignInMethod[] = []
  for (const item of listed as unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    const way = item as { id?: unknown; name?: unknown; _meta?: { casper?: { provider?: unknown; kind?: unknown } } }
    const casper = way._meta?.casper
    if (typeof way.id !== 'string' || typeof way.name !== 'string') continue
    if (typeof casper?.provider !== 'string' || typeof casper.kind !== 'string' || !KINDS.has(casper.kind)) continue
    found.push({ id: way.id, label: way.name, provider: casper.provider, kind: casper.kind as CasperSignInKind })
  }
  return found
}

/** The saved sign-ins in a status reply; an entry without a provider and a kind is left out. */
function savedOf(listed: unknown): CasperSavedSignIn[] {
  if (!Array.isArray(listed)) return []
  return (listed as unknown[]).flatMap((item) => {
    if (typeof item !== 'object' || item === null) return []
    const { provider, type } = item as { provider?: unknown; type?: unknown }
    return typeof provider === 'string' && typeof type === 'string' ? [{ provider, type }] : []
  })
}

/** One update as a frame, when it is for this sign-in and is a step the page shows. */
function frameOf(update: AuthUpdate, methodId: string): CasperSignInFrame | undefined {
  if (update.methodId !== methodId || typeof update.url !== 'string') return undefined
  if (update.step === 'browser') return { type: 'browser', url: update.url, opened: update.opened === true }
  if (update.step === 'device_code' && typeof update.code === 'string') return { type: 'device_code', url: update.url, code: update.code }
  return undefined
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
