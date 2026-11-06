/**
 * One `casper acp` process and its ACP client connection.
 * @module @deepseek-ai/dsh-casper-agent/connection
 */

import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import {
  client as createAcpClient,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type ClientConnection,
  type ContentBlock as AcpContentBlock,
  type InitializeResponse,
  type McpServer,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type StopReason,
} from '@agentclientprotocol/sdk'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { appToolsEntry } from './app-tools.ts'
import type { AppToolsServer } from './app-tools.ts'
import type { Config } from './config.ts'

/** ACP error code Casper uses for an unknown or unloadable session. */
const ACP_NOT_FOUND = -32002

/**
 * Matches both messages Casper sends with -32002 when a stored conversation is
 * gone: `--resume: no saved conversation in this workspace starts with "<id>". …`
 * when no id matches, and `No saved conversation <id> in <folder>` when the
 * prefix matches another id.
 */
const NO_SAVED_CONVERSATION = /no saved conversation/i

/**
 * Failure codes a Casper turn can end with. `CASPER_TEXT_ONLY` is no longer
 * raised; it stays for `turn/end` records saved by earlier versions.
 */
export type CasperFailureCode =
  | 'CASPER_NOT_FOUND'
  | 'CASPER_START_FAILED'
  | 'CASPER_EXITED'
  | 'CASPER_EMPTY_PROMPT'
  | 'CASPER_TEXT_ONLY'
  | `CASPER_RPC_${number}`

/** A Casper failure with the code its turn ends with. */
export class CasperError extends Error {
  override readonly name = 'CasperError'

  /**
   * @param code - the code recorded on `turn/end`.
   * @param message - the message shown to the user.
   * @param options - the underlying cause.
   */
  constructor(readonly code: CasperFailureCode, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** Receivers for Casper's messages to the client. */
export interface CasperConnectionHandlers {
  /**
   * Receive one `session/update`; called in arrival order.
   * @param notification - the update and its session id.
   */
  update(notification: SessionNotification): void
  /**
   * Answer one `session/request_permission`.
   * @param params - Casper's request.
   * @returns the reply; must not reject.
   */
  permission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>
}

/** Inputs for starting one Casper process. */
export interface CasperConnectionOptions {
  /** Subprocess service that resolves and spawns Casper. */
  readonly subprocess: SubprocessRuntime
  /** Command, arguments, environment, and timeouts. */
  readonly config: Config
  /** Session folder; Casper's process and conversation both use it. */
  readonly cwd: string
  /** Receivers for updates and permission requests. */
  readonly handlers: CasperConnectionHandlers
  /** The app's profile; Casper's shell gets it as `DSH_PROFILE` and `DSH_PROFILE_DIR`. */
  readonly profile?: { readonly name: string; readonly dir: string } | undefined
  /**
   * Start the app tools server this connection offers Casper; omitted offers none.
   * The server closes when the process exits, is terminated, or the connection is disposed.
   * @param connection - the connection being opened, for its call id mapping.
   * @returns the running server.
   */
  readonly appTools?: ((connection: CasperConnection) => Promise<AppToolsServer>) | undefined
}

/** A started connection and the Casper conversation it holds. */
export interface CasperStarted {
  /** The live connection. */
  readonly connection: CasperConnection
  /** Casper's conversation id. */
  readonly acpSessionId: string
  /** Whether the stored conversation was reopened; false when a fresh one replaced it or none was stored. */
  readonly reopened: boolean
}

/**
 * Build the argv that starts Casper's ACP server.
 * @param executable - the resolved Casper executable.
 * @param config - arguments plus the optional model and effort.
 * @returns the argv with `--model` and `--effort` appended only when configured.
 */
export function casperArgv(executable: string, config: Pick<Config, 'args' | 'model' | 'effort'>): string[] {
  return [
    executable,
    ...config.args,
    ...config.model === undefined ? [] : ['--model', config.model],
    ...config.effort === undefined ? [] : ['--effort', config.effort],
  ]
}

/**
 * Build the explicit child environment: every ambient `DEEPSEEK_*` name is
 * removed (the subprocess scrub already drops credential-shaped and `DSH_*`
 * names), then the configured entries are added.
 * @param configured - the configured entries.
 * @param ambient - the parent environment.
 * @returns the spawn `env` overlay.
 */
export function casperEnv(configured: Readonly<Record<string, string>>, ambient: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const removed = Object.keys(ambient).filter(name => /^DEEPSEEK_/i.test(name)).map(name => [name, undefined] as const)
  return { ...Object.fromEntries(removed), ...configured }
}

/**
 * The profile entries of Casper's environment. They are explicit spawn
 * entries, so they pass the subprocess scrub of `DSH_*` names.
 * @param profile - the app's profile, when it has one.
 * @returns `DSH_PROFILE` and `DSH_PROFILE_DIR`, or nothing without a profile.
 */
export function profileEnv(profile: CasperConnectionOptions['profile']): Record<string, string> {
  return profile === undefined ? {} : { DSH_PROFILE: profile.name, DSH_PROFILE_DIR: profile.dir }
}

/**
 * One `casper acp` process. The process starts with {@link CasperConnection.start};
 * any exit marks the connection dead and rejects the prompt in flight. Tool
 * call ids carry a per-connection epoch so a restarted process cannot reuse a
 * Session's earlier ids.
 */
export class CasperConnection {
  /** Random per-connection prefix of every tool call id. */
  readonly epoch = randomUUID().slice(0, 8)
  private exitedState = false
  private disposal: Promise<void> | undefined
  private readonly exit: Promise<SubprocessOutcome | undefined>
  private connection: ClientConnection | undefined
  private sessionId: string | undefined
  private initialized: InitializeResponse | undefined
  /** Updates are dropped while `session/load` replays the conversation the Session already holds. */
  private replaying = false
  private cancelSent = false
  private appTools: AppToolsServer | undefined
  /** Set once the app tools must stay closed: a server started later is closed at once. */
  private appToolsClosed = false

  private constructor(
    private readonly child: SubprocessHandle,
    private readonly options: CasperConnectionOptions,
  ) {
    this.exit = child.done.then(
      (outcome) => { this.exited(); return outcome },
      /* v8 ignore next -- done rejects only for a spawn or provider failure, which leaves no exit facts. */
      () => { this.exited(); return undefined },
    )
  }

  /** Whether the process has exited or was terminated. */
  get dead(): boolean {
    return this.exitedState
  }

  /** Whether Casper's `initialize` reply set `promptCapabilities.image` to true, so prompts may carry image blocks. */
  get acceptsImages(): boolean {
    return this.initialized?.agentCapabilities?.promptCapabilities?.image === true
  }

  /**
   * Resolve, spawn, and open Casper. A stored conversation is reopened with
   * `session/load`; only Casper's "no saved conversation" reply falls back to
   * `session/new`. The child is terminated when start fails or is aborted.
   * @param options - subprocess service, config, folder, and receivers.
   * @param stored - the stored Casper conversation id, if any.
   * @param signal - aborts the start.
   * @returns the connection and its conversation.
   * @throws CasperError `CASPER_NOT_FOUND` when the command cannot be resolved and `CASPER_START_FAILED` otherwise;
   *   an Error carrying the abort reason as its cause when aborted.
   */
  static async start(options: CasperConnectionOptions, stored: string | undefined, signal: AbortSignal): Promise<CasperStarted> {
    const { config } = options
    let executable: string
    try {
      executable = await options.subprocess.resolveExecutable(config.command, config.env, signal)
    } catch (error: unknown) {
      signal.throwIfAborted()
      if (error instanceof SubprocessExecutableNotFoundError) {
        throw new CasperError('CASPER_NOT_FOUND',
          `Casper was not found at "${config.command}". Install Casper, or pick another mode for this session.`, { cause: error })
      }
      throw new CasperError('CASPER_START_FAILED', `Casper could not start: ${errorText(error)}`, { cause: error })
    }
    let child: SubprocessHandle
    try {
      child = options.subprocess.spawn({
        argv: casperArgv(executable, config),
        cwd: options.cwd,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: config.stderrTailBytes } },
        graceMs: config.killGraceMs,
        env: { ...profileEnv(options.profile), ...casperEnv(config.env) },
      })
    } catch (error: unknown) {
      throw new CasperError('CASPER_START_FAILED', `Casper could not start: ${errorText(error)}`, { cause: error })
    }
    const connection = new CasperConnection(child, options)
    try {
      const opened = await connection.raceStart(connection.open(stored), signal)
      return { connection, ...opened }
    } catch (error: unknown) {
      if (signal.aborted) {
        connection.terminate()
        throw new Error('Casper start was stopped', { cause: signal.reason })
      }
      if (error instanceof CasperError) {
        connection.terminate()
        throw error
      }
      // A closed protocol stream usually precedes the exit facts.
      const exit = error instanceof RequestError ? 'running' : await connection.exitWithin(config.killGraceMs)
      connection.terminate()
      const reason = exit === 'running' ? errorText(error) : `Casper exited while starting (${outcomeText(exit)})`
      throw new CasperError('CASPER_START_FAILED', connection.withStderr(`Casper could not start: ${reason}`), { cause: error })
    }
  }

  /**
   * Map one Casper tool call id to a call id unique in the Session.
   * @param acpId - Casper's tool call id.
   * @returns `casper:<epoch>:<acpId>`.
   */
  toolCallId(acpId: string): ToolCallId {
    return ToolCallId(`casper:${this.epoch}:${acpId}`)
  }

  /**
   * Send one prompt. Resolves after every update received before the reply
   * has been delivered to the handlers.
   * @param prompt - the prompt blocks.
   * @returns Casper's stop reason.
   * @throws CasperError `CASPER_EXITED` when the process exits first, `CASPER_RPC_<code>` for an error reply.
   */
  async prompt(prompt: AcpContentBlock[]): Promise<StopReason> {
    const sessionId = this.requireSession()
    this.cancelSent = false
    const exited = this.exit.then((): never => { throw new Error('the Casper process exited') })
    exited.catch(() => {
      // An exit after the reply needs no observer.
    })
    let stopReason: StopReason
    try {
      stopReason = (await Promise.race([
        this.requireConnection().agent.request(methods.agent.session.prompt, { sessionId, prompt }),
        exited,
      ])).stopReason
    } catch (error: unknown) {
      if (error instanceof RequestError) {
        throw new CasperError(`CASPER_RPC_${error.code}`, `Casper failed: ${error.message}`, { cause: error })
      }
      // An exit or a closed protocol stream: report the exit facts once they arrive.
      throw this.exitError(await this.exitWithin(this.options.config.killGraceMs))
    }
    await drainInbound()
    return stopReason
  }

  /** Ask Casper to stop the prompt in flight; sent at most once per prompt. */
  cancel(): void {
    if (this.cancelSent || this.dead) return
    this.cancelSent = true
    const sent = this.requireConnection().agent.notify(methods.agent.session.cancel, { sessionId: this.requireSession() })
    /* v8 ignore next -- a notify fails only when the process is gone; the exit watch settles the prompt. */
    sent.catch(() => {})
  }

  /** Start termination without waiting for the exit; the subprocess service escalates to SIGKILL. The app tools close. */
  terminate(): void {
    this.exitedState = true
    this.revokeAppTools()
    this.child.terminate()
  }

  /**
   * Close stdin, wait up to `exitGraceMs` for Casper to exit, then terminate and
   * wait for the process range to empty. Memoized.
   * @returns resolution once the process range is empty.
   */
  dispose(): Promise<void> {
    return (this.disposal ??= (async () => {
      this.child.stdin?.end()
      /* v8 ignore start -- waitForExit rejects only when the provider can no longer observe its process range. */
      const unobservable = (): boolean => false
      /* v8 ignore stop */
      const exited = await this.child.waitForExit(AbortSignal.timeout(this.options.config.exitGraceMs)).catch(unobservable)
      if (!exited) {
        this.terminate()
        await this.child.waitForExit().catch(unobservable)
      }
      this.exitedState = true
      await this.closeAppTools()
      this.connection?.close()
    })())
  }

  /**
   * Read the kept tail of Casper's stderr.
   * @returns the tail, trimmed; empty when Casper wrote nothing.
   */
  stderrTail(): string {
    /* v8 ignore next -- stderr is spawned in collect mode, so its reader always exists. */
    return this.child.collected.stderr?.readFrom(0).text.trim() ?? ''
  }

  private async open(stored: string | undefined): Promise<Omit<CasperStarted, 'connection'>> {
    const { child, options } = this
    /* v8 ignore next 3 -- 'pipe' dispositions expose both streams by the subprocess contract. */
    if (child.stdin === undefined || child.stdout === undefined) {
      throw new Error('subprocess dropped a piped protocol stream')
    }
    this.connection = createAcpClient({ name: 'casper-desktop' })
      .onNotification(methods.client.session.update, ({ params }) => {
        if (!this.replaying) options.handlers.update(params)
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) => options.handlers.permission(params))
      .connect(ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ))
    const agent = this.connection.agent
    this.initialized = await agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    const mcpServers = await this.openAppTools()
    if (stored !== undefined) {
      this.replaying = true
      try {
        await agent.request(methods.agent.session.load, { sessionId: stored, cwd: options.cwd, mcpServers })
        this.sessionId = stored
        return { acpSessionId: stored, reopened: true }
      } catch (error: unknown) {
        if (!(error instanceof RequestError) || error.code !== ACP_NOT_FOUND || !NO_SAVED_CONVERSATION.test(error.message)) {
          throw error
        }
      } finally {
        await drainInbound()
        this.replaying = false
      }
    }
    const created = await agent.request(methods.agent.session.new, { cwd: options.cwd, mcpServers })
    this.sessionId = created.sessionId
    return { acpSessionId: created.sessionId, reopened: false }
  }

  /** Start the app tools server, if configured, and return the `mcpServers` list that offers it. */
  private async openAppTools(): Promise<McpServer[]> {
    if (this.options.appTools === undefined) return []
    const server = await this.options.appTools(this)
    if (this.appToolsClosed) {
      await server.close()
      throw new Error('the Casper process stopped while its app tools started')
    }
    this.appTools = server
    return [appToolsEntry(server)]
  }

  /** Close the app tools server for good; later requests fail. */
  private async closeAppTools(): Promise<void> {
    this.appToolsClosed = true
    await this.appTools?.close()
  }

  /** Mark the process gone and revoke the app tools. */
  private exited(): void {
    this.exitedState = true
    this.revokeAppTools()
  }

  /** Close the app tools server without waiting. */
  private revokeAppTools(): void {
    this.closeAppTools().catch(
      /* v8 ignore start -- closing an HTTP listener fails only when it never listened; nothing is left to revoke. */
      (error: unknown) => { void error },
      /* v8 ignore stop */
    )
  }

  private async raceStart<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    const limit = AbortSignal.any([signal, AbortSignal.timeout(this.options.config.startTimeoutMs)])
    const stopped = Promise.withResolvers<never>()
    const onStop = (): void => {
      stopped.reject(signal.aborted
        ? signal.reason
        : new CasperError('CASPER_START_FAILED', this.withStderr(`Casper did not start within ${this.options.config.startTimeoutMs} ms`)))
    }
    limit.throwIfAborted()
    limit.addEventListener('abort', onStop, { once: true })
    const exited = this.exit.then((outcome): never => {
      throw new CasperError('CASPER_START_FAILED', this.withStderr(`Casper exited while starting (${outcomeText(outcome)})`))
    })
    try {
      return await Promise.race([operation, stopped.promise, exited])
    } finally {
      limit.removeEventListener('abort', onStop)
      operation.catch(() => {
        // A start that lost the race settles after the child is terminated.
      })
      exited.catch(() => {
        // Observed by the race above.
      })
    }
  }

  private async exitWithin(ms: number): Promise<SubprocessOutcome | undefined | 'running'> {
    let timer: ReturnType<typeof setTimeout> | undefined
    /* v8 ignore next -- a process that closed its protocol stream normally exits well within the grace. */
    const running = new Promise<'running'>((resolve) => { timer = setTimeout(() => { resolve('running') }, ms) })
    try {
      return await Promise.race([this.exit, running])
    } finally {
      clearTimeout(timer)
    }
  }

  private requireConnection(): ClientConnection {
    /* v8 ignore next -- start() returns a connection only after open() connected it. */
    if (this.connection === undefined) throw new Error('Casper connection is not open')
    return this.connection
  }

  private requireSession(): string {
    /* v8 ignore next -- start() returns a connection only after its session opened. */
    if (this.sessionId === undefined) throw new Error('Casper connection has no session')
    return this.sessionId
  }

  private exitError(outcome: SubprocessOutcome | undefined | 'running'): CasperError {
    return new CasperError('CASPER_EXITED', this.withStderr(`The Casper process exited before this turn finished (${outcomeText(outcome)}).`))
  }

  private withStderr(message: string): string {
    const tail = this.stderrTail()
    return tail === '' ? message : `${message}\n${tail}`
  }
}

/**
 * Wait one macrotask. Inbound ACP messages are dispatched through microtask
 * chains in arrival order; after this yield every message read before the
 * awaited reply has reached its handler.
 */
function drainInbound(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve) })
}

function outcomeText(outcome: SubprocessOutcome | undefined | 'running'): string {
  /* v8 ignore next -- see exitWithin: missing exit facts are a provider failure or a stuck process. */
  if (outcome === undefined || outcome === 'running') return 'exit unknown'
  return outcome.signal === null ? `exit code ${String(outcome.exitCode)}` : `signal ${outcome.signal}`
}

function errorText(error: unknown): string {
  /* v8 ignore next -- the subprocess and ACP layers throw Errors. */
  return error instanceof Error ? error.message : String(error)
}
