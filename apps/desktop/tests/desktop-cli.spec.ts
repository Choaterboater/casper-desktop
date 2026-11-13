/** The installed CLI manages only the desktop profile's plugins, with shared pnpm and Electron's package-operation environment. */

import { delimiter, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runCli } from '@deepseek-ai/dsh/lib/bin.js'
import { desktopCliAdmission, runDesktopCli } from '../../desktop-host/src/cli.ts'
import { installOfficeEngineResolution } from '../../desktop-host/src/office-engine.ts'

vi.mock('@deepseek-ai/dsh/lib/bin.js', () => ({ runCli: vi.fn() }))
vi.mock('../../desktop-host/src/office-engine.ts', () => ({ installOfficeEngineResolution: vi.fn() }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  process.exitCode = undefined
})

it.each(['system-bin', undefined])('dispatches with bundled pnpm when PATH is %s', async (path) => {
  vi.stubEnv('PATH', path)
  const runtime = join('Application 中文 with spaces', 'resources', 'app.asar', 'dsh')
  const support = join('Application 中文 with spaces', 'resources', 'runtime')

  vi.spyOn(process, 'argv', 'get').mockReturnValue(['electron', 'cli.js', 'plugin', '--profile', 'desktop', 'add', 'plugin-package'])
  await runDesktopCli(runtime, support)

  expect(installOfficeEngineResolution).toHaveBeenCalledExactlyOnceWith(runtime)
  expect(runCli).toHaveBeenCalledExactlyOnceWith({
    manageDesktopProfile: true,
    packageManager: {
      command: process.execPath,
      args: ['--expose-internals', join(support, 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
        PATH: `${join(support, 'bin')}${delimiter}${path ?? ''}`,
      },
    },
  })
})

it.each([
  [['--version'], 'run'],
  [['-V'], 'run'],
  [['plugin', '--profile', 'desktop', 'add', 'plugin-package'], 'run'],
  [['plugin', '--profile', 'Desktop', 'remove', 'plugin-package'], 'run'],
  [['plugin', '--profile=DESKTOP', 'list'], 'run'],
  [['plugin', '--PROFILE=desktop', 'list'], 'reject'],
  [['plugin', '--profile', 'desktop', '--help'], 'run'],
  [['--help'], 'help'],
  [['-h'], 'help'],
  [['plugin', '--help'], 'help'],
  [['plugin', '-h'], 'help'],
  [[], 'reject'],
  [['web'], 'reject'],
  [['headless', 'run the tests'], 'reject'],
  [['--profile', 'desktop'], 'reject'],
  [['desktop'], 'reject'],
  [['--version', 'web'], 'reject'],
  [['web', '--help'], 'reject'],
  [['--dump-config', '--profile', 'web'], 'reject'],
  [['plugin', '--profile', 'web', 'add', 'plugin-package'], 'reject'],
  [['plugin', 'add', '--profile', 'desktop'], 'reject'],
  [['plugin'], 'reject'],
] as const)('admits %j as %s', (argv, admission) => {
  expect(desktopCliAdmission(argv)).toBe(admission)
})

it('prints its own help without starting the shared CLI', async () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['electron', 'cli.js', '--help'])
  await runDesktopCli('runtime', 'support')
  expect(stdout).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Usage: dsh plugin --profile desktop <pnpm arguments...>'))
  expect(process.exitCode).toBeUndefined()
  expect(runCli).not.toHaveBeenCalled()
  expect(installOfficeEngineResolution).not.toHaveBeenCalled()
})

it('refuses another profile with exit code 1 and the npm CLI install command', async () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['electron', 'cli.js', 'web'])
  await runDesktopCli('runtime', 'support')
  expect(stderr).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(/only runs "dsh plugin --profile desktop .*npm install -g @deepseek-ai\/dsh\n$/u),
  )
  expect(process.exitCode).toBe(1)
  expect(runCli).not.toHaveBeenCalled()
  expect(installOfficeEngineResolution).not.toHaveBeenCalled()
})
