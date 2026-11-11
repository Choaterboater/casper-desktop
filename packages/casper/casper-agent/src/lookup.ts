/**
 * Finding the Casper executable. The configured lookup runs first; on Windows,
 * when it finds nothing for the default name, the folders Casper's installer
 * and bun use are tried too, since the app's PATH may predate the install.
 * @module @deepseek-ai/dsh-casper-agent/lookup
 */

import { win32 } from 'node:path'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Config } from './config.ts'

/** The one lookup this module needs from the subprocess service. */
export type ExecutableLookup = Pick<SubprocessRuntime, 'resolveExecutable'>

/** A Windows lookup that found no Casper it can start: the folders it tried and any scripts it passed over. */
export class CasperLookupError extends SubprocessExecutableNotFoundError {
  /**
   * @param folders - the folders tried after PATH.
   * @param scripts - `.cmd`, `.bat`, or other script files found, which the app cannot start.
   * @param options - the first lookup's not-found error, when there was one.
   */
  constructor(readonly folders: readonly string[], readonly scripts: readonly string[], options?: ErrorOptions) {
    super(`casper-agent: no casper.exe on PATH or in ${folders.length === 0 ? 'the install folders' : folders.join(', ')}`, options)
    this.name = 'CasperLookupError'
  }
}

/**
 * Whether a command is the default name the fallback applies to: the config
 * default `casper` or the Desktop row's `casper.exe`, in any letter case.
 * Any other command is the user's own choice, so the fallback stays off.
 * @param command - the configured command.
 * @returns true for a bare `casper` or `casper.exe`.
 */
export function isDefaultCasperName(command: string): boolean {
  return /^casper(?:\.exe)?$/i.test(command)
}

/**
 * The Windows files tried after PATH, in order: the installer's own override
 * folder, the installer's default folder, and bun's moved home. An unset,
 * empty, or relative variable gives no entry, and a repeated path is tried once.
 * @param ambient - the app's environment.
 * @returns absolute Windows paths to `casper.exe`.
 */
export function windowsCasperCandidates(ambient: NodeJS.ProcessEnv): string[] {
  const under = (name: string, ...rest: string[]): string[] => {
    const base = ambient[name]
    return base !== undefined && win32.isAbsolute(base) ? [win32.join(base, ...rest)] : []
  }
  return [...new Set([
    ...under('CASPER_INSTALL_DIR', 'casper.exe'),
    ...under('LOCALAPPDATA', 'Programs', 'casper', 'casper.exe'),
    ...under('BUN_INSTALL', 'bin', 'casper.exe'),
  ])]
}

/** Not a `.exe` or `.com`: a `.cmd`, `.bat`, or other PATHEXT script, which the process runner cannot start without a shell. */
function isScript(path: string): boolean {
  return !/\.(?:exe|com)$/i.test(path)
}

/**
 * Find the Casper executable. The configured lookup's hit is kept as it is.
 * On Windows, for the default name only, a miss tries `casper` with PATHEXT
 * on PATH and then {@link windowsCasperCandidates}; a `.cmd`, `.bat`, or other
 * script found on the way is passed over and named in the error.
 * @param lookup - the subprocess service.
 * @param config - the configured command and child environment.
 * @param signal - aborts the lookup.
 * @param platform - the host platform.
 * @param ambient - the app's environment.
 * @returns the absolute executable path.
 * @throws SubprocessExecutableNotFoundError when nothing is found, as a {@link CasperLookupError} after the Windows fallback;
 *   any other lookup error unchanged.
 */
export async function findCasper(
  lookup: ExecutableLookup,
  config: Pick<Config, 'command' | 'env'>,
  signal: AbortSignal,
  platform: NodeJS.Platform = process.platform,
  ambient: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const fallback = platform === 'win32' && isDefaultCasperName(config.command)
  const scripts: string[] = []
  let missed: SubprocessExecutableNotFoundError | undefined
  try {
    const hit = await lookup.resolveExecutable(config.command, config.env, signal)
    if (!fallback || !isScript(hit)) return hit
    scripts.push(hit)
  } catch (error: unknown) {
    if (!fallback || !(error instanceof SubprocessExecutableNotFoundError)) throw error
    missed = error
  }
  const candidates = windowsCasperCandidates(ambient)
  const names = config.command.toLowerCase() === 'casper' ? candidates : ['casper', ...candidates]
  for (const name of names) {
    signal.throwIfAborted()
    try {
      const hit = await lookup.resolveExecutable(name, config.env, signal)
      if (!isScript(hit)) return hit
      scripts.push(hit)
    } catch (error: unknown) {
      if (!(error instanceof SubprocessExecutableNotFoundError)) throw error
    }
  }
  throw new CasperLookupError(candidates.map(candidate => win32.dirname(candidate)), scripts, { cause: missed })
}

/**
 * The words a not-found message adds for a Windows lookup: the folders tried
 * and any script found. Empty for any other not-found error.
 * @param error - the lookup's not-found error.
 * @returns text that starts with a space, or the empty string.
 */
export function lookupDetail(error: SubprocessExecutableNotFoundError): string {
  if (!(error instanceof CasperLookupError)) return ''
  const where = error.folders.length === 0 ? ' Looked on PATH.' : ` Looked on PATH and in ${error.folders.join(', ')}.`
  const scripts = error.scripts.length === 0
    ? ''
    : ` Found ${error.scripts.join(', ')}, which the app cannot start; install casper.exe with Casper's Windows installer.`
  return where + scripts
}
