/**
 * Where the Casper engine the app ships lives inside the runtime resources,
 * the Host environment entries that hand it to the casper-agent row, and the
 * engine version the build recorded.
 */

import { readFileSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'

/** Files and folders of the bundled engine under one runtime resource directory. */
export interface CasperEngineLayout {
  /** Folder holding the engine and its tools. */
  readonly root: string
  /** The engine executable, `casper` or `casper.exe`. */
  readonly engine: string
  /** Folder with `uv`, `uvx`, `npx` and `npm`. */
  readonly tools: string
  /** The npm package `npx` and `npm` run, taken from the pinned Node archive. */
  readonly npm: string
  /** Folder holding the primary runtime's `node`. */
  readonly nodeBin: string
}

/**
 * Lay out the bundled engine under a runtime resource directory.
 * @param runtime - `Contents/Resources/runtime` when packaged, the target's build `runtime` folder in development.
 * @param platform - the target platform, which names the engine `casper.exe` on Windows; paths join as the host's.
 * @returns the engine's absolute paths.
 */
export function casperEngineLayout(runtime: string, platform: NodeJS.Platform): CasperEngineLayout {
  const root = join(runtime, 'casper')
  return {
    root,
    engine: join(root, platform === 'win32' ? 'casper.exe' : 'casper'),
    tools: join(root, 'tools'),
    npm: join(root, 'npm'),
    nodeBin: join(runtime, 'primary-runtime', 'dependencies', 'node', 'bin'),
  }
}

/**
 * The Host environment entries the casper-agent row reads: the engine path, and
 * the folders that go at the end of Casper's PATH (the app's node, then its uv,
 * uvx, npx and npm). The subprocess scrub keeps `DSH_*` names from Casper itself.
 * @param runtime - the runtime resource directory.
 * @param platform - the target platform, which also picks the PATH delimiter.
 * @returns `DSH_DESKTOP_CASPER_ENGINE` and `DSH_DESKTOP_CASPER_TOOL_PATH`.
 */
export function casperEngineEnvironment(runtime: string, platform: NodeJS.Platform): {
  readonly DSH_DESKTOP_CASPER_ENGINE: string
  readonly DSH_DESKTOP_CASPER_TOOL_PATH: string
} {
  const layout = casperEngineLayout(runtime, platform)
  return {
    DSH_DESKTOP_CASPER_ENGINE: layout.engine,
    DSH_DESKTOP_CASPER_TOOL_PATH: [layout.nodeBin, layout.tools].join((platform === 'win32' ? win32 : posix).delimiter),
  }
}

/**
 * The version of the engine the app ships, as the build recorded it in
 * `runtime/versions.json` (`casper.version`) beside the engine.
 * @param runtime - the runtime resource directory.
 * @returns the version, such as `0.4.15`.
 * @throws Error when the file cannot be read, is not JSON, or records no version.
 */
export function readBundledCasperVersion(runtime: string): string {
  const path = join(runtime, 'versions.json')
  const recorded = JSON.parse(readFileSync(path, 'utf8')) as { casper?: { version?: unknown } } | null
  const version = recorded?.casper?.version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`casper desktop: ${path} records no Casper engine version`)
  }
  return version
}
