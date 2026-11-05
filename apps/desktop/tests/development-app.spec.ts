/** Cold-start launcher preserves workspace paths without evaluating shell syntax. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { developmentLauncher, developmentPlistValues, writeDevelopmentIcon } from '../scripts/development-app.ts'

it.skipIf(process.platform === 'win32')('passes literal workspace paths and cold-start settings to Electron', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-development-app-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const bundle = join(root, "Casper ' $(false).app")
  const binary = join(bundle, 'Contents', 'MacOS', 'Electron')
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$DSH_HOME" "$DSH_DESKTOP_DEV_APP" "$DSH_DESKTOP_OPEN_DEVTOOLS" "$@"\n', { mode: 0o755 })
  const launcher = join(root, 'launcher')
  const home = join(root, "home ' $(false)")
  writeFileSync(launcher, developmentLauncher({ electron: binary, appRoot: root, directory: root,
    home, userData: join(root, 'browser data'), mainPort: 9229, rendererPort: 9222, hostPort: 9230, openDevtools: '0' }, bundle))
  const result = execFileSync('/bin/sh', [launcher, '--test-launch-argument'], { encoding: 'utf8' })
  expect(result.trimEnd().split('\n')).toEqual([home, '1', '0', '--inspect=127.0.0.1:9229',
    '--remote-debugging-port=9222', `--user-data-dir=${join(root, 'browser data')}`, root, '--test-launch-argument'])
})

it('names the development bundle Casper Dev with the Casper icon', () => {
  const values = developmentPlistValues('/work/apps/desktop')
  expect(values).toMatchObject({
    CFBundleName: 'Casper Dev',
    CFBundleDisplayName: 'Casper Dev',
    CFBundleExecutable: 'CasperDev',
    CFBundleIconFile: 'casper.icns',
  })
  expect(values.CFBundleIdentifier).toMatch(/^com\.casper\.desktop\.dev\.[0-9a-f]{12}$/u)
  expect(developmentPlistValues('/other/apps/desktop').CFBundleIdentifier).not.toBe(values.CFBundleIdentifier)
})

it.skipIf(process.platform !== 'darwin')('builds a macOS icon file from the Casper app icon', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-development-icon-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const icns = join(root, 'casper.icns')
  writeDevelopmentIcon(new URL('../resources/icon-macos.png', import.meta.url).pathname, icns)
  const bytes = readFileSync(icns)
  expect(bytes.subarray(0, 4).toString('latin1')).toBe('icns')
  expect(bytes.readUInt32BE(4)).toBe(bytes.length)
})
