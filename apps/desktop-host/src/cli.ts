/**
 * The `dsh` command a Casper desktop installation provides: it manages the desktop profile's plugins with the immutable
 * runtime the installation carries, and boots no profile. The npm CLI runs every other profile.
 */

import { delimiter, dirname, join, resolve } from 'node:path'
import { runCli } from '@deepseek-ai/dsh/lib/bin.js'
import { installOfficeEngineResolution, runtimeArchivePath } from './office-engine.ts'

/** Install command for the npm CLI, which runs the profiles this command refuses. */
const NPM_CLI_INSTALL = 'npm install -g @deepseek-ai/dsh'

/** Help this command prints; the shared launcher help names profiles the installation does not ship. */
const DESKTOP_CLI_HELP = `Usage: dsh plugin --profile desktop <pnpm arguments...>
       dsh --version
       dsh --help

This dsh command is installed by Casper. It manages the plugins of Casper's desktop profile and runs no other profile.

Examples:
  dsh plugin --profile desktop add <package>      install a plugin
  dsh plugin --profile desktop remove <package>   remove a plugin
  dsh plugin --profile desktop list               list the profile's packages

To run other profiles, such as web or headless, install the dsh CLI from npm: ${NPM_CLI_INSTALL}
`

/** What the command does with one argument list: hand it to the shared CLI, print its own help, or refuse it. */
export type DesktopCliAdmission = 'run' | 'help' | 'reject'

/**
 * Decide whether the command accepts an argument list. The shared CLI runs `--version`, `-V`, and `plugin` whose first
 * option is `--profile desktop` (the name in any case, also written `--profile=desktop`); a later second `--profile` fails in the
 * shared parser. `--help`, `-h`, and either after `plugin` alone print this command's help; everything else is refused.
 * @param argv - The command's arguments, without the executable and script paths.
 * @returns The admission for the arguments.
 */
export function desktopCliAdmission(argv: readonly string[]): DesktopCliAdmission {
  const [first, second, third] = argv
  if (argv.length === 1 && (first === '--version' || first === '-V')) return 'run'
  if (argv.length === 1 && (first === '--help' || first === '-h')) return 'help'
  if (first !== 'plugin') return 'reject'
  if (argv.length === 2 && (second === '--help' || second === '-h')) return 'help'
  if (second === '--profile' && third?.toLowerCase() === 'desktop') return 'run'
  if (second?.startsWith('--profile=') === true && second.slice('--profile='.length).toLowerCase() === 'desktop') return 'run'
  return 'reject'
}

/**
 * Run the command's arguments, `process.argv` after the executable and script paths as the shared CLI reads them: run an
 * admitted command through the shared CLI with Desktop's bundled package manager and reserved-profile plugin access,
 * print this command's help, or refuse the command with exit code 1 and the npm CLI's install command.
 * @param runtimeDir - Prepared or ASAR-contained production DSH package tree.
 * @param supportDir - Physical Desktop runtime directory containing the primary-runtime payload and Node launchers.
 * @returns Completion of the selected CLI command; profile plugins own their process lifetime.
 */
export async function runDesktopCli(runtimeDir: string, supportDir: string): Promise<void> {
  const admission = desktopCliAdmission(process.argv.slice(2))
  switch (admission) {
    case 'help':
      process.stdout.write(DESKTOP_CLI_HELP)
      return
    case 'reject':
      process.stderr.write('dsh: the dsh command installed by Casper only runs "dsh plugin --profile desktop <pnpm arguments...>", '
        + `"dsh --version" and "dsh --help". To run other profiles, such as web or headless, install the dsh CLI from npm: ${NPM_CLI_INSTALL}\n`)
      process.exitCode = 1
      return
    case 'run':
      break
    default:
      throw new Error(`dsh: unknown admission ${String(admission satisfies never)}`)
  }
  installOfficeEngineResolution(runtimeDir)
  await runCli({
    manageDesktopProfile: true,
    packageManager: {
      command: process.execPath,
      args: ['--expose-internals', join(supportDir, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
        PATH: `${join(supportDir, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
      },
    },
  })
}

if (import.meta.main) {
  if (process.platform === 'win32') {
    const { installWindowsCliSignals } = await import('./windows-cli-signals.ts')
    await installWindowsCliSignals()
  }
  const runtimeDir = resolve(import.meta.dirname, '../../../..')
  await runDesktopCli(runtimeDir, join(dirname(runtimeArchivePath(runtimeDir) ?? runtimeDir), 'runtime'))
}
