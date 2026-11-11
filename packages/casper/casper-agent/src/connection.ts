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
  type AvailableCommand,
  type ClientConnection,
  type ContentBlock as AcpContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type InitializeResponse,
  type McpServer,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
  type StopReason,
} from '@agentclientprotocol/sdk'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionReferenceErrorCode } from '@deepseek-ai/dsh-session-reference'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { appToolsEntry } from './app-tools.ts'
import type { AppToolsServer } from './app-tools.ts'
import type { Config } from './config.ts'
import { conversationMarkOf } from './conversation.ts'
import type { ForwardedServers } from './forward-servers.ts'
import { findCasper, lookupDetail } from './lookup.ts'

/** ACP error code Casper uses for an unknown or unloadable session. */
const ACP_NOT_FOUND = -32002

/** Limit for Casper's answer to `_casper/idle`; a Casper that does not answer by then is not idle. */
const IDLE_CHECK_MS = 10_000

/**
 * Matches both messages Casper sends with -32002 when a stored conversation is
 * gone: `--resume: no saved conversation in this workspace starts with "<id>". …`
 * when no id matches, and `No saved conversation <id> in <folder>` when the
 * prefix matches another id.
 */
const NO_SAVED_CONVERSATION = /no saved conversation/i

/**
 * A prompt's reply: Casper's stop reason, the ACP session it was sent on, and
 * Casper's mark when it sent one in the shape `session/fork` takes.
 */
export interface PromptReply {
  readonly stopReason: StopReason
  readonly acpSessionId: string
  readonly mark: string | undefined
}

/**
 * Failure codes a Casper turn can end with. `CASPER_TEXT_ONLY` is no longer
 * raised; it stays for `turn/end` records saved by earlier versions.
 */
export type CasperFailureCode =
  | 'CASPER_NOT_FOUND'
  | 'CASPER_START_FAILED'
  | 'CASPER_EXITED'
  | 'CASPER_EMPTY_PROMPT'
  | 'CASPER_MODEL_UNAVAILABLE'
  | 'CASPER_NO_ACCESS_MODES'
  | 'CASPER_ACCESS_NOT_APPLIED'
  | 'CASPER_TEXT_ONLY'
  | `CASPER_RPC_${number}`
  // A session mention that could not be read ends the turn with the session-reference service's own code.
  | SessionReferenceErrorCode

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
   * Receive Casper's whole command list from an `available_commands_update`,
   * which never reaches {@link update}. Called during a `session/load` replay too,
   * since Casper sends the list right after opening a conversation.
   * @param commands - the commands Casper offers, without leading slashes.
   */
  commands(commands: readonly AvailableCommand[]): void
  /**
   * Receive Casper's whole option list from a `config_option_update`, which
   * never reaches {@link update}; the connection has stored it already. Called
   * during a `session/load` replay too.
   * @param options - the model, effort, and other options Casper offers now.
   */
  config(options: readonly SessionConfigOption[]): void
  /**
   * Receive Casper's access mode when Casper changes it itself, from a
   * `current_mode_update` or a changed `mode` option in a `config_option_update`;
   * the connection has stored it already. A mode the client set is not echoed.
   * Called during a `session/load` replay too.
   * @param modeId - the mode Casper is in now, such as `read`, `ask`, or `full`.
   */
  mode(modeId: string): void
  /**
   * Receive Casper's Plan first option when it changes: from a
   * `config_option_update` or a `session/set_config_option` reply, a set this
   * client made included; the connection has stored it already. Called during
   * a `session/load` replay too.
   * @param active - whether every request gets a plan first.
   */
  plan(active: boolean): void
  /**
   * Answer one `session/request_permission`.
   * @param params - Casper's request.
   * @param signal - aborted when Casper withdraws the request or the connection closes.
   * @returns the reply; must not reject.
   */
  permission(params: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse>
  /**
   * Answer one `elicitation/create`: a question Casper asks as a form.
   * @param params - Casper's request.
   * @param signal - aborted when Casper withdraws the request or the connection closes.
   * @returns the reply; must not reject.
   */
  elicitation(params: CreateElicitationRequest, signal: AbortSignal): Promise<CreateElicitationResponse>
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
  /**
   * Build the app's own MCP servers this connection hands Casper after the app tools server; omitted hands none.
   * Called only when Casper's `initialize` reply sets `mcpCapabilities.http` to true.
   * @param signal - aborted when the start is stopped.
   * @returns the entries, their names, and their digest.
   */
  readonly mcpServers?: ((signal: AbortSignal) => Promise<ForwardedServers>) | undefined
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
  private options_: readonly SessionConfigOption[] | undefined
  private modes_: SessionModeState | undefined
  /** Casper's current access mode; undefined for a Casper that offers no modes. */
  private mode_: string | undefined
  /** Casper's Plan first option; undefined for a Casper that offers none. */
  private plan_: boolean | undefined
  /** Updates are dropped while `session/load` replays the conversation the Session already holds. */
  private replaying = false
  private cancelSent = false
  private appTools: AppToolsServer | undefined
  /** Set once the app tools must stay closed: a server started later is closed at once. */
  private appToolsClosed = false
  /** The app's own servers handed to Casper at open; undefined when none was built. */
  private forwarded: ForwardedServers | undefined

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
   * Whether Casper's `initialize` reply set `promptCapabilities.embeddedContext` to true, so prompts may carry
   * `resource` blocks, which Casper reads as context and not as the request.
   */
  get acceptsEmbeddedContext(): boolean {
    return this.initialized?.agentCapabilities?.promptCapabilities?.embeddedContext === true
  }

  /**
   * Whether Casper's `initialize` reply sets `agentCapabilities._meta.casper.steer` to true, so a line the user
   * sends during a prompt may go to Casper with {@link steer}.
   */
  get acceptsSteer(): boolean {
    const casper = this.initialized?.agentCapabilities?._meta?.casper
    return typeof casper === 'object' && casper !== null && (casper as { steer?: unknown }).steer === true
  }

  /** The names of the app's own servers handed to Casper at open; Casper names them `acp-<name>`. */
  get forwardedNames(): readonly string[] {
    return this.forwarded?.names ?? []
  }

  /**
   * The digest of the app's own servers handed to Casper at open; undefined when the connection built none, because
   * Casper takes no HTTP servers or forwarding is off.
   */
  get forwardedDigest(): string | undefined {
    return this.forwarded?.digest
  }

  /**
   * The option list of Casper's latest `session/new` or `session/load` reply,
   * `config_option_update`, or `session/set_config_option` reply; undefined for
   * a Casper that offers none.
   */
  get configOptions(): readonly SessionConfigOption[] | undefined {
    return this.options_
  }

  /**
   * Casper's current access mode, from its `mode` option or `modes`, kept up to
   * date by Casper's updates and by {@link setAccess}; undefined for a Casper
   * that offers neither.
   */
  get accessMode(): string | undefined {
    return this.mode_
  }

  /**
   * Casper's Plan first option (`plan`, `on` or `off`), kept up to date by
   * Casper's updates and by each set's reply; undefined for a Casper that
   * offers none.
   */
  get planMode(): boolean | undefined {
    return this.plan_
  }

  /**
   * Find (see {@link findCasper}), spawn, and open Casper. A stored conversation is reopened with
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
      executable = await findCasper(options.subprocess, config, signal)
    } catch (error: unknown) {
      signal.throwIfAborted()
      if (error instanceof SubprocessExecutableNotFoundError) {
        throw new CasperError('CASPER_NOT_FOUND',
          `Casper was not found at "${config.command}". Install Casper, or pick another mode for this session.${lookupDetail(error)}`, { cause: error })
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
      const opened = await connection.raceStart(connection.open(stored, signal), signal)
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
   * @returns Casper's stop reason, the conversation the prompt was sent on, and Casper's mark when it sent one.
   * @throws CasperError `CASPER_EXITED` when the process exits first, `CASPER_RPC_<code>` for an error reply.
   */
  async prompt(prompt: AcpContentBlock[]): Promise<PromptReply> {
    const sessionId = this.requireSession()
    this.cancelSent = false
    const reply = await this.request(this.requireConnection().agent.request(methods.agent.session.prompt, { sessionId, prompt }))
    await drainInbound()
    return { stopReason: reply.stopReason, acpSessionId: sessionId, mark: conversationMarkOf(reply._meta) }
  }

  /**
   * Send a line during the prompt in flight with `_casper/steer`; Casper reads it at the AI's next step and says so
   * with a `user_message_chunk` carrying `messageId`. Casper queues nothing: a line it refuses stays the app's.
   * @param prompt - the line's blocks.
   * @param messageId - the line's message id, which Casper's read notice carries.
   * @returns whether Casper took the line; false for a refusal, an error reply, or an exit.
   */
  async steer(prompt: AcpContentBlock[], messageId: string): Promise<boolean> {
    if (this.dead) return false
    try {
      const reply = await this.request(this.requireConnection().agent.request<{ steered?: unknown }>(
        '_casper/steer', { sessionId: this.requireSession(), prompt, messageId },
      ))
      return reply.steered === true
    } catch (error: unknown) {
      // A line Casper did not take runs as the next turn.
      void error
      return false
    }
  }

  /**
   * Ask Casper with `_casper/idle` whether the app may close it now: no prompt or model change under way, and no dev
   * server, command, debugger, helper or checks still at work. Casper answers within 10 seconds or not at all.
   * @param signal - stops the check, which then answers false.
   * @returns whether Casper says it is idle; false for a busy reply, an error reply (an older Casper answers -32601),
   *   no answer in time, a stop, or an exit.
   */
  async idle(signal: AbortSignal): Promise<boolean> {
    const limit = AbortSignal.any([signal, AbortSignal.timeout(IDLE_CHECK_MS)])
    if (this.dead || limit.aborted) return false
    // A cancel is cooperative, so the check stops waiting on its own.
    const stopped = Promise.withResolvers<undefined>()
    const onStop = (): void => { stopped.resolve(undefined) }
    limit.addEventListener('abort', onStop, { once: true })
    try {
      const sent = this.request(this.requireConnection().agent.request<{ idle?: unknown } | null>(
        '_casper/idle', { sessionId: this.requireSession() }, { cancellationSignal: limit },
      ))
      sent.catch(() => {
        // A reply after the stop no longer counts.
      })
      const reply = await Promise.race([sent, stopped.promise])
      return reply?.idle === true
    } catch (error: unknown) {
      // Any failure keeps Casper.
      void error
      return false
    } finally {
      limit.removeEventListener('abort', onStop)
    }
  }

  /**
   * Set one of Casper's session options and keep the list it replies with.
   * @param configId - the option, such as `model` or `effort`.
   * @param value - one of the option's listed values.
   * @returns the whole list after the change.
   * @throws CasperError `CASPER_EXITED` when the process exits first, `CASPER_RPC_<code>` for an error reply.
   */
  async setConfigOption(configId: string, value: string): Promise<readonly SessionConfigOption[]> {
    const reply = await this.request(
      this.requireConnection().agent.request(methods.agent.session.setConfigOption, { sessionId: this.requireSession(), configId, value }),
    )
    this.options_ = reply.configOptions
    this.mode_ = modeOf(reply.configOptions, this.modes_)
    this.casperPlan(reply.configOptions)
    return reply.configOptions
  }

  /**
   * Set Casper's access mode: through its `mode` option when it offers one,
   * otherwise through `session/set_mode` when it offers `modes`. The mode is
   * stored only after Casper accepts it.
   * @param modeId - `read`, `ask`, or `full`.
   * @throws CasperError `CASPER_NO_ACCESS_MODES` when Casper offers neither, `CASPER_EXITED` when it
   *   exits first, `CASPER_RPC_<code>` for an error reply.
   */
  async setAccess(modeId: string): Promise<void> {
    const option = modeOption(this.options_)
    if (option !== undefined) {
      await this.setConfigOption(option.id, modeId)
    } else if (this.modes_ !== undefined) {
      const sessionId = this.requireSession()
      await this.request(this.requireConnection().agent.request(methods.agent.session.setMode, { sessionId, modeId }))
    } else {
      throw new CasperError('CASPER_NO_ACCESS_MODES', 'This Casper has no access modes. Update Casper to use the access control.')
    }
    if (this.modes_ !== undefined) this.modes_ = { ...this.modes_, currentModeId: modeId }
    this.mode_ = modeId
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

  private async open(stored: string | undefined, signal: AbortSignal): Promise<Omit<CasperStarted, 'connection'>> {
    const { child, options } = this
    /* v8 ignore next 3 -- 'pipe' dispositions expose both streams by the subprocess contract. */
    if (child.stdin === undefined || child.stdout === undefined) {
      throw new Error('subprocess dropped a piped protocol stream')
    }
    this.connection = createAcpClient({ name: 'casper-desktop' })
      .onNotification(methods.client.session.update, ({ params }) => {
        // The command list is the conversation's current state, not history, so a replay keeps it.
        const { update } = params
        if (update.sessionUpdate === 'available_commands_update') options.handlers.commands(update.availableCommands)
        else if (update.sessionUpdate === 'config_option_update') {
          this.options_ = update.configOptions
          options.handlers.config(update.configOptions)
          this.casperMode(modeOf(update.configOptions, undefined))
          this.casperPlan(update.configOptions)
        } else if (update.sessionUpdate === 'current_mode_update') {
          if (this.modes_ !== undefined) this.modes_ = { ...this.modes_, currentModeId: update.currentModeId }
          this.casperMode(update.currentModeId)
        } else if (!this.replaying) options.handlers.update(params)
      })
      .onRequest(methods.client.session.requestPermission, ({ params, signal }) => options.handlers.permission(params, signal))
      .onRequest(methods.client.elicitation.create, ({ params, signal }) => options.handlers.elicitation(params, signal))
      .connect(ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ))
    const agent = this.connection.agent
    this.initialized = await agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      // Form elicitation: Casper asks its questions as forms instead of skipping them.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
    })
    const mcpServers = [...await this.openAppTools(), ...await this.forwardServers(signal)]
    if (stored !== undefined) {
      this.replaying = true
      try {
        const loaded = await agent.request(methods.agent.session.load, { sessionId: stored, cwd: options.cwd, mcpServers })
        this.keepOptions(loaded)
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
    this.keepOptions(created)
    this.sessionId = created.sessionId
    return { acpSessionId: created.sessionId, reopened: false }
  }

  /** Keep the options and modes of a `session/new` or `session/load` reply. */
  private keepOptions(reply: { configOptions?: SessionConfigOption[] | null; modes?: SessionModeState | null }): void {
    this.options_ = reply.configOptions ?? undefined
    this.modes_ = reply.modes ?? undefined
    this.mode_ = modeOf(this.options_, this.modes_)
    this.plan_ = planOf(this.options_)
  }

  /** Store Casper's Plan first option from a list and tell the handler when it changed. */
  private casperPlan(options: readonly SessionConfigOption[]): void {
    const active = planOf(options)
    if (active === this.plan_) return
    this.plan_ = active
    if (active !== undefined) this.options.handlers.plan(active)
  }

  /** Store a mode Casper reports itself and tell the handler when it changed. */
  private casperMode(modeId: string | undefined): void {
    if (modeId === undefined || modeId === this.mode_) return
    this.mode_ = modeId
    this.options.handlers.mode(modeId)
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

  /** Build the app's own servers when Casper takes HTTP servers and a builder is configured. */
  private async forwardServers(signal: AbortSignal): Promise<McpServer[]> {
    if (this.options.mcpServers === undefined || this.initialized?.agentCapabilities?.mcpCapabilities?.http !== true) return []
    this.forwarded = await this.options.mcpServers(signal)
    return this.forwarded.entries
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

  /**
   * Race one request against the process exit; an error reply becomes `CASPER_RPC_<code>`, an exit `CASPER_EXITED`.
   * Both messages are redacted of the forwarded servers' values.
   */
  private async request<T>(sent: Promise<T>): Promise<T> {
    const exited = this.exit.then((): never => { throw new Error('the Casper process exited') })
    exited.catch(() => {
      // An exit after the reply needs no observer.
    })
    try {
      return await Promise.race([sent, exited])
    } catch (error: unknown) {
      if (error instanceof RequestError) {
        // Casper's words may echo a forwarded value; the cause carries them redacted too, without the reply's data.
        const words = this.redact(error.message)
        const cause = words === error.message ? error : new RequestError(error.code, words)
        throw new CasperError(`CASPER_RPC_${error.code}`, `Casper failed: ${words}`, { cause })
      }
      // An exit or a closed protocol stream: report the exit facts once they arrive.
      throw this.exitError(await this.exitWithin(this.options.config.killGraceMs))
    }
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

  /** The message and Casper's stderr tail, redacted of the forwarded servers' values. */
  private withStderr(message: string): string {
    const tail = this.stderrTail()
    return this.redact(tail === '' ? message : `${message}\n${tail}`)
  }

  /** Replace every value the forwarded servers resolved, longest first, with `[redacted]`. */
  private redact(text: string): string {
    const secrets = [...this.forwarded?.secrets ?? []].sort((left, right) => right.length - left.length)
    return secrets.reduce((out, secret) => out.replaceAll(secret, '[redacted]'), text)
  }
}

/**
 * Read the access mode from Casper's `mode` option, else from its `modes`.
 * @param options - Casper's option list.
 * @param modes - Casper's mode state.
 * @returns the current mode id, or undefined when Casper offers neither.
 */
function modeOf(options: readonly SessionConfigOption[] | undefined, modes: SessionModeState | undefined): string | undefined {
  return modeOption(options)?.currentValue ?? modes?.currentModeId
}

/**
 * Find Casper's access option: the select option of category `mode`.
 * @param options - Casper's option list.
 * @returns the option, or undefined when Casper offers none.
 */
function modeOption(options: readonly SessionConfigOption[] | undefined): Extract<SessionConfigOption, { type: 'select' }> | undefined {
  return options?.find((item): item is Extract<SessionConfigOption, { type: 'select' }> => item.category === 'mode' && item.type === 'select')
}

/**
 * Read Casper's Plan first option: the select option `plan`, `on` or `off`.
 * @param options - Casper's option list.
 * @returns whether it is on, or undefined when Casper offers no such option.
 */
function planOf(options: readonly SessionConfigOption[] | undefined): boolean | undefined {
  const option = options?.find(item => item.id === 'plan' && item.type === 'select')
  if (option === undefined) return undefined
  return option.currentValue === 'on' ? true : option.currentValue === 'off' ? false : undefined
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
