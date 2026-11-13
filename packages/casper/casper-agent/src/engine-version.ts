/**
 * The `casperEngine` Remote namespace: which Casper engine new Sessions start,
 * found the way a connection finds it, and the version it prints. General
 * Settings shows the result; the engine is run once per call.
 * @module @deepseek-ai/dsh-casper-agent/engine-version
 */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Config } from './config.ts'
import { casperEnv } from './connection.ts'
import type { CasperEngineInfo } from './engine-types.ts'
import { locateCasper, resolveCasperEngine } from './lookup.ts'

export type { CasperEngineInfo, CasperEngineKind } from './engine-types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Casper engine new Sessions start, for General Settings. */
    casperEngine: CasperEngineService
  }
}

/** `casper --version` prints one short line; a longer reply is not a version. */
const VERSION_OUTPUT_BYTES = 4_096

/**
 * Read the version from `casper --version` output, `casper 0.4.15 (<path>)`.
 * @param output - the engine's stdout.
 * @returns the version, or undefined when the first line names none.
 */
export function parseCasperVersion(output: string): string | undefined {
  return /^casper v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/u.exec(output.trimStart())?.[1]
}

/**
 * Find the engine new Sessions start and run it with `--version`, in Casper's
 * own environment, within `startTimeoutMs`.
 * @param config - the engine, the switch, the lookup environment, and the time limits.
 * @param subprocess - the subprocess service.
 * @param signal - aborts the lookup and the run.
 * @param platform - the host platform.
 * @param ambient - the app's environment.
 * @returns which engine runs and its version.
 * @throws RemoteError `casper-engine/missing` when the engine is not found, `casper-engine/unreadable` when it
 *   cannot run, fails, runs out of time, or prints no version; an Error carrying the abort reason when aborted.
 */
export async function probeCasperEngine(
  config: Config,
  subprocess: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'>,
  signal: AbortSignal,
  platform: NodeJS.Platform = process.platform,
  ambient: NodeJS.ProcessEnv = process.env,
): Promise<CasperEngineInfo> {
  const engine = resolveCasperEngine(config)
  const { kind } = engine
  let executable: string
  try {
    executable = await locateCasper(engine, subprocess, config, signal, platform, ambient)
  } catch (error: unknown) {
    signal.throwIfAborted()
    if (!(error instanceof SubprocessExecutableNotFoundError)) throw error
    throw new RemoteError('casper-engine/missing', `The Casper engine was not found: ${error.message}`, { kind }, { cause: error })
  }
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(config.startTimeoutMs)])
  let output: string
  try {
    const child = subprocess.spawn({
      argv: [executable, '--version'],
      cwd: homedir(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: VERSION_OUTPUT_BYTES }, stderr: { maxBytes: config.stderrTailBytes } },
      graceMs: config.killGraceMs,
      signal: deadline,
      env: casperEnv(config, ambient),
    })
    const outcome = await child.done
    signal.throwIfAborted()
    if (deadline.aborted || outcome.exitCode !== 0) {
      throw new Error(deadline.aborted ? `no reply within ${config.startTimeoutMs} ms` : `exit code ${String(outcome.exitCode)}`)
    }
    /* v8 ignore next -- stdout is spawned in collect mode, so its reader always exists. */
    output = child.collected.stdout?.readFrom(0).text ?? ''
  } catch (error: unknown) {
    signal.throwIfAborted()
    throw new RemoteError('casper-engine/unreadable', `The Casper engine at "${executable}" did not report its version: ${
      error instanceof Error ? error.message : String(error)}`, { kind }, { cause: error })
  }
  const version = parseCasperVersion(output)
  if (version === undefined) {
    throw new RemoteError('casper-engine/unreadable', `The Casper engine at "${executable}" printed no version`, { kind })
  }
  return { kind, version }
}

/** The `casperEngine` Remote namespace over the plugin's config and the subprocess service. */
export class CasperEngineService extends TypertRemoteService {
  /**
   * @param ctx - the casper-agent plugin context, which injects `subprocess`.
   * @param config - the validated plugin config.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'casperEngine')
  }

  /**
   * Report which engine new Sessions start and its version; see {@link probeCasperEngine}.
   * @param signal - the caller's cancellation.
   * @returns which engine runs and its version.
   */
  @Remote
  async describe(signal: AbortSignal): Promise<CasperEngineInfo> {
    return await probeCasperEngine(this.config, this.ctx.subprocess, signal)
  }
}
