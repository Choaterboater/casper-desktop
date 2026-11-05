/** macOS development bundle that loads the current workspace through Electron. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const BUNDLE = 'Casper Dev.app'
const EXECUTABLE = 'CasperDev'
const ICON_FILE = 'casper.icns'
/* The bundle this launcher created before the Casper rename; it also claims `dsh:` links. */
const LEGACY_BUNDLE = 'Harness Dev.app'
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
/* Point sizes of a macOS app icon set; each is also written at twice the size for Retina. */
const ICON_SIZES = [16, 32, 128, 256, 512]

/** Workspace and runtime settings captured for Launch Services cold starts. */
export interface DevelopmentAppOptions {
  readonly electron: string
  readonly appRoot: string
  readonly directory: string
  readonly home: string
  readonly userData: string
  readonly mainPort: number
  readonly rendererPort: number
  readonly hostPort: number
  readonly openDevtools: string
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

/**
 * Prepare and register a disposable .app without changing the installed Electron package.
 * @param options - Current workspace, Electron binary, and private development locations.
 * @returns executable used by the supported desktop development launcher.
 */
export function prepareDevelopmentApp(options: DevelopmentAppOptions): string {
  const source = dirname(dirname(dirname(options.electron)))
  const bundle = join(options.directory, BUNDLE)
  const executable = join(bundle, 'Contents', 'MacOS', EXECUTABLE)
  const stamp = join(bundle, 'Contents', 'Resources', 'dsh-development.json')
  const icon = join(options.appRoot, 'resources', 'icon-macos.png')
  const launcher = developmentLauncher(options, bundle)
  removeLegacyBundle(options.directory)
  const identity = JSON.stringify({ ...options, launcher, plist: readFileSync(join(source, 'Contents', 'Info.plist'), 'utf8'),
    icon: createHash('sha256').update(readFileSync(icon)).digest('hex') })
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== identity) {
    rmSync(bundle, { recursive: true, force: true })
    execFileSync('/usr/bin/ditto', [source, bundle])
    const plist = join(bundle, 'Contents', 'Info.plist')
    for (const [key, value] of Object.entries(developmentPlistValues(options.appRoot))) {
      execFileSync('/usr/bin/plutil', ['-replace', key, '-json', JSON.stringify(value), plist])
    }
    writeDevelopmentIcon(icon, join(bundle, 'Contents', 'Resources', ICON_FILE))
    writeFileSync(executable, launcher, { mode: 0o755 })
    writeFileSync(stamp, identity, { mode: 0o600 })
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'pipe' })
  }
  execFileSync(LSREGISTER, ['-f', bundle])
  return executable
}

/**
 * Info.plist values that make the copied Electron bundle the Casper development app.
 * @param appRoot - desktop app root; its hash keeps each checkout's bundle identifier distinct.
 * @returns plist keys and values for `plutil -replace`.
 */
export function developmentPlistValues(appRoot: string) {
  return {
    CFBundleIdentifier: `com.casper.desktop.dev.${createHash('sha256').update(appRoot).digest('hex').slice(0, 12)}`,
    CFBundleName: 'Casper Dev',
    CFBundleDisplayName: 'Casper Dev',
    CFBundleExecutable: EXECUTABLE,
    CFBundleIconFile: ICON_FILE,
    CFBundleURLTypes: [{ CFBundleURLName: 'Casper', CFBundleURLSchemes: ['dsh'], CFBundleTypeRole: 'Viewer' }],
  }
}

/**
 * Build a macOS `.icns` icon from a square PNG with the system `sips` and `iconutil` tools.
 * @param png - source PNG, at least 1024 px square.
 * @param icns - output icon file; overwritten.
 */
export function writeDevelopmentIcon(png: string, icns: string): void {
  const scratch = mkdtempSync(join(tmpdir(), 'casper-dev-icon-'))
  try {
    const iconset = join(scratch, 'casper.iconset')
    mkdirSync(iconset)
    for (const size of ICON_SIZES) {
      for (const [scale, suffix] of [[1, ''], [2, '@2x']] as const) {
        const pixels = String(size * scale)
        execFileSync('/usr/bin/sips', ['-z', pixels, pixels, png, '--out', join(iconset, `icon_${String(size)}x${String(size)}${suffix}.png`)], { stdio: 'pipe' })
      }
    }
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icns], { stdio: 'pipe' })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Remove the pre-rename development bundle so `dsh:` links open only the current one.
 * @param directory - development build directory that holds the bundles.
 */
function removeLegacyBundle(directory: string): void {
  const legacy = join(directory, LEGACY_BUNDLE)
  if (!existsSync(legacy)) return
  try {
    execFileSync(LSREGISTER, ['-u', legacy], { stdio: 'pipe' })
  } catch (error) {
    // Best effort: Launch Services drops a deleted bundle's record on its next scan.
    console.warn(`desktop development: could not unregister ${legacy}: ${String(error)}`)
  }
  rmSync(legacy, { recursive: true, force: true })
}

/**
 * Create the development executable used by both the CLI and Launch Services.
 * @param options - Persisted development locations and debugging settings.
 * @param bundle - Generated application bundle.
 * @returns shell program with literal arguments and environment values.
 */
export function developmentLauncher(options: DevelopmentAppOptions, bundle: string): string {
  const environment = {
    DSH_HOME: options.home,
    DSH_DESKTOP_DEV_APP: '1',
    DSH_DESKTOP_HOST_INSPECT_PORT: String(options.hostPort),
    DSH_DESKTOP_OPEN_DEVTOOLS: options.openDevtools,
    ELECTRON_ENABLE_LOGGING: '1',
  }
  const args = [
    join(bundle, 'Contents', 'MacOS', 'Electron'),
    `--inspect=127.0.0.1:${String(options.mainPort)}`,
    `--remote-debugging-port=${String(options.rendererPort)}`,
    `--user-data-dir=${options.userData}`,
    options.appRoot,
  ]
  return [
    '#!/bin/sh',
    ...Object.entries(environment).map(([key, value]) => `export ${key}=${quote(value)}`),
    `cd ${quote(options.appRoot)}`,
    `exec ${args.map(quote).join(' ')} "$@"`,
    '',
  ].join('\n')
}
