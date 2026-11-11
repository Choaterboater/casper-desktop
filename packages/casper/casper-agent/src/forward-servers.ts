/**
 * The app's Settings > MCP servers, then the servers plugins register with
 * the MCP manager, then the app's own MCP client rows, as ACP `mcpServers`
 * entries for Casper: each enabled server Casper would take, with its
 * credentials resolved, so Casper connects to it for the session with its own
 * boxes. A row goes as the app tools server's own endpoint for it.
 * @module @deepseek-ai/dsh-casper-agent/forward-servers
 */

import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'
import { credentialRefsIn, MissingTemplateValue, resolveTemplateString } from '@deepseek-ai/dsh-mcp-client'
import type { McpManagedServerEntry } from '@deepseek-ai/dsh-mcp-manager'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import { APP_SERVER_NAME } from './app-tools.ts'

/** Most servers forwarded; Casper takes eight from one app, and the app's own server is one of them. */
export const MAX_FORWARDED = 7
/** Limit for resolving one server's credentials and command. */
export const FORWARD_TIMEOUT_MS = 5_000
/** `_meta` key on a stdio entry: the absolute folder Casper starts it in. */
export const CWD_META = 'casper/cwd'

/** Why a Settings or plugin-registered server was not forwarded. Every reason is fixed text or a name, never a value. */
export const SKIP = {
  disabled: 'it is turned off in Settings',
  appName: `the name ${APP_SERVER_NAME} is the app's own server`,
  tooMany: `at most ${MAX_FORWARDED} servers are forwarded`,
  cwd: 'cwd must be an absolute path',
  placed: 'a credential in the command, args, cwd or url',
  embedded: 'a credential inside a longer value',
  missing: 'a credential it names is not set',
  unreadable: 'a credential it names could not be read',
  notFound: 'its command was not found',
  unresolved: 'its command could not be resolved',
  timeout: `its credentials and command were not ready within ${FORWARD_TIMEOUT_MS / 1000} s`,
} as const

/** Reasons that may pass by the next turn: a slow or failing credential store or command lookup, not a Settings change. */
const PASSING: ReadonlySet<string> = new Set([SKIP.unreadable, SKIP.unresolved, SKIP.timeout])

/** The fields of one Settings or registered entry that are forwarded, as the manager's resolved snapshot holds them. */
export interface ForwardEntry {
  readonly transport: McpManagedServerEntry['transport']
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly enabled: boolean
}

/** One of the app's own MCP client rows, proxied through the app tools server. */
export interface ForwardRow {
  /** The row's server name; Casper names it `acp-<name>`. */
  readonly name: string
  /** Its entry: the app tools server's endpoint for the row, with the bearer header. */
  readonly entry: McpServer
  /** The raw names of the tools it lists now; a change reaches Casper at the next turn. */
  readonly tools: readonly string[]
}

/** What {@link forwardedServers} reads. */
export interface ForwardOptions {
  /** The Settings entries keyed by server name, in Settings order. */
  readonly entries: Readonly<Record<string, ForwardEntry>>
  /**
   * The servers plugins registered with the MCP manager, in registration order; they take the slots the Settings
   * entries leave. The manager keeps their names apart from the Settings names.
   */
  readonly registered?: Readonly<Record<string, ForwardEntry>>
  /**
   * The app's own MCP client rows, in tool registration order; they take the slots the Settings and registered
   * servers leave. They need no credentials: each entry is the app tools server's own endpoint.
   */
  readonly rows?: readonly ForwardRow[]
  /**
   * Resolve one credential reference.
   * @param ref - the name inside `${credential:…}`.
   * @returns the value, or undefined while it is not set.
   */
  readonly credential: (ref: string) => Promise<string | undefined>
  /**
   * Find a command that is not an absolute path, as the app's own server would start.
   * @param command - the configured command.
   * @param env - the server's resolved environment.
   * @param signal - aborts the lookup.
   * @returns the absolute path.
   */
  readonly resolveExecutable: (command: string, env: Readonly<Record<string, string>>, signal: AbortSignal) => Promise<string>
  /** Aborts the whole build; a server that takes longer than {@link timeoutMs} is skipped instead. */
  readonly signal: AbortSignal
  /**
   * Receive one server that is not forwarded.
   * @param name - the server's name.
   * @param reason - one of {@link SKIP} or a name rule's words; never a value.
   */
  readonly skip: (name: string, reason: string) => void
  /** Limit per server; {@link FORWARD_TIMEOUT_MS} when omitted. */
  readonly timeoutMs?: number
}

/** The forwarded list. */
export interface ForwardedServers {
  /** The entries for `session/new` and `session/load`, after the app's own server. */
  readonly entries: McpServer[]
  /** The forwarded servers' names, rows included; Casper names them `acp-<name>`. */
  readonly names: string[]
  /** The names of the client rows that took a place, which the app tools server serves. */
  readonly rows: string[]
  /**
   * SHA-256 of the entries, values included, and of each placed row's tool names; kept in memory only, to see a
   * change between turns.
   */
  readonly digest: string
  /** Servers left out for a reason that may pass: a credential that could not be read, a lookup error, or the time limit. */
  readonly passing: string[]
  /** Every credential value resolved, as is and URL-encoded; kept in memory only, to redact them from Casper's error text. */
  readonly secrets: readonly string[]
}

// Casper's own rules for an app's servers (its client-servers.ts), applied first so no server is sent only to be refused.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const STARTUP_ENV = /^(?:PATH|NODE_OPTIONS|LD_.*|DYLD_.*)$/i
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/
const OWN_HEADERS = /^(?:host|content-.*|connection|transfer-encoding|mcp-.*|cookie|origin)$/i
const NAME = /^[a-zA-Z0-9_.-]{1,60}$/
const NAME_REFUSED = 'a name Casper does not take'
/** The only places a credential may sit: a whole value, or one token after an auth scheme. */
const WHOLE_CREDENTIAL = /^(?:(?:Bearer|Basic|Token|Bot|ApiKey) )?\$\{credential:[A-Za-z_][A-Za-z0-9_]*\}$/

/** A server left out, with its reason. */
class Skipped extends Error {}

/** The first problem a name rule finds in one entry, before anything is resolved. */
function nameProblem(entry: ForwardEntry): string | undefined {
  if (entry.transport === 'stdio') {
    for (const name of Object.keys(entry.env)) {
      if (!ENV_NAME.test(name)) return 'an env name Casper does not take'
      if (STARTUP_ENV.test(name)) return `${name} cannot be set`
    }
    if (entry.cwd !== '' && !isAbsolute(entry.cwd)) return SKIP.cwd
    return undefined
  }
  for (const name of Object.keys(entry.headers)) {
    if (!HEADER_NAME.test(name)) return 'a header name Casper does not take'
    if (OWN_HEADERS.test(name)) return `the connection sets ${name}`
  }
  return undefined
}

/** The first problem with where the entry's credentials sit. */
function placementProblem(entry: ForwardEntry): string | undefined {
  const fixed = entry.transport === 'stdio' ? [entry.command, ...entry.args, entry.cwd] : [entry.url]
  if (fixed.some(value => credentialRefsIn(value).length > 0)) return SKIP.placed
  const values = Object.values(entry.transport === 'stdio' ? entry.env : entry.headers)
  if (values.some(value => credentialRefsIn(value).length > 0 && !WHOLE_CREDENTIAL.test(value))) return SKIP.embedded
  return undefined
}

/** Settle `work`, or reject with the signal's reason once it aborts. */
async function until<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const stopped = Promise.withResolvers<never>()
  const stop = (): void => { stopped.reject(signal.reason) }
  signal.addEventListener('abort', stop, { once: true })
  try {
    return await Promise.race([work, stopped.promise])
  } finally {
    signal.removeEventListener('abort', stop)
    work.catch(() => {
      // A lookup that lost the race settles unobserved.
    })
  }
}

/** Resolve every value of a map; a credential that is not set or cannot be read skips the server. */
async function resolved(values: Readonly<Record<string, string>>, credential: ForwardOptions['credential']): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    try {
      out[key] = await resolveTemplateString(value, key, credential)
    } catch (error: unknown) {
      throw new Skipped(error instanceof MissingTemplateValue ? SKIP.missing : SKIP.unreadable, { cause: error })
    }
  }
  return out
}

/** ACP's `[{name, value}]` list. */
function pairs(map: Readonly<Record<string, string>>): { name: string; value: string }[] {
  return Object.entries(map).map(([name, value]) => ({ name, value }))
}

/** Build one server's entry; throws {@link Skipped} with the reason it is left out. */
async function oneServer(name: string, entry: ForwardEntry, options: ForwardOptions, signal: AbortSignal): Promise<McpServer> {
  if (entry.transport === 'stdio') {
    const env = await resolved(entry.env, options.credential)
    let command = entry.command
    if (!isAbsolute(command)) {
      try {
        command = await options.resolveExecutable(command, env, signal)
      } catch (error: unknown) {
        if (signal.aborted) throw error
        throw new Skipped(error instanceof SubprocessExecutableNotFoundError ? SKIP.notFound : SKIP.unresolved, { cause: error })
      }
    }
    return { name, command, args: [...entry.args], env: pairs(env), ...entry.cwd === '' ? {} : { _meta: { [CWD_META]: entry.cwd } } }
  }
  const headers = await resolved(entry.headers, options.credential)
  return { type: 'http', name, url: entry.url, headers: pairs(headers) }
}

/**
 * Build the forwarded list: enabled Settings servers, then registered ones,
 * then the app's own client rows, never one named `app`, at most
 * {@link MAX_FORWARDED} in that order, so Settings servers take the slots first. Casper's name rules
 * apply first; a credential may sit only in an env or header value, as the
 * whole value or after an auth scheme. Each server resolves in parallel under
 * its own time limit. No entry carries `casper/clientAsks`, so Casper asks
 * before every change these servers make.
 * @param options - the entries, the resolvers, the signal, and the skip receiver.
 * @returns the entries, their names, their digest, the servers left out for a reason that may pass, and the resolved values.
 * @throws the signal's reason when it aborts.
 */
export async function forwardedServers(options: ForwardOptions): Promise<ForwardedServers> {
  const timeoutMs = options.timeoutMs ?? FORWARD_TIMEOUT_MS
  const secrets = new Set<string>()
  const credential = async (ref: string): Promise<string | undefined> => {
    const value = await options.credential(ref)
    if (value !== undefined && value !== '') secrets.add(value).add(encodeURIComponent(value))
    return value
  }
  // Two lists joined, not one merged record: a record puts digit-only names first, which would let a registered `7`
  // take a slot ahead of every Settings server.
  const all = [...Object.entries(options.entries), ...Object.entries(options.registered ?? {})]
  const built = await Promise.all(all.map(async ([name, entry]): Promise<[string, McpServer | string]> => {
    if (!entry.enabled) return [name, SKIP.disabled]
    if (name === APP_SERVER_NAME) return [name, SKIP.appName]
    const problem = (NAME.test(name) ? undefined : NAME_REFUSED) ?? nameProblem(entry) ?? placementProblem(entry)
    if (problem !== undefined) return [name, problem]
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    try {
      return [name, await until(oneServer(name, entry, { ...options, credential }, signal), signal)]
    } catch (error: unknown) {
      options.signal.throwIfAborted()
      if (error instanceof Skipped) return [name, error.message]
      if (signal.aborted) return [name, SKIP.timeout]
      /* v8 ignore next -- the resolvers above turn every failure into a skip. */
      return [name, SKIP.unreadable]
    }
  }))
  options.signal.throwIfAborted()
  const entries: McpServer[] = []
  const names: string[] = []
  const passing: string[] = []
  // A row is known by its entry, so a placed entry is a row's only when it is that row's own.
  const ofEntry = new Map<McpServer, ForwardRow>()
  const placed: ForwardRow[] = []
  for (const row of options.rows ?? []) {
    if (row.name === APP_SERVER_NAME) {
      built.push([row.name, SKIP.appName])
    } else if (NAME.test(row.name)) {
      built.push([row.name, row.entry])
      ofEntry.set(row.entry, row)
    } else {
      built.push([row.name, NAME_REFUSED])
    }
  }
  for (const [name, result] of built) {
    if (typeof result === 'string') {
      if (PASSING.has(result)) passing.push(name)
      options.skip(name, result)
    } else if (entries.length >= MAX_FORWARDED) {
      options.skip(name, SKIP.tooMany)
    } else {
      entries.push(result)
      names.push(name)
      const row = ofEntry.get(result)
      if (row !== undefined) placed.push(row)
    }
  }
  const hash = createHash('sha256').update(JSON.stringify(entries))
  for (const row of placed) hash.update(JSON.stringify([row.name, [...row.tools].sort()]))
  return { entries, names, rows: placed.map(row => row.name), digest: hash.digest('hex'), passing, secrets: [...secrets] }
}
