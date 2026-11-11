/** Finding Casper: the configured lookup first, and on Windows the installer's and bun's folders for the default name. */

import { describe, expect, it } from 'vitest'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import { CasperLookupError, findCasper, isDefaultCasperName, lookupDetail, windowsCasperCandidates } from '../src/lookup.ts'
import type { ExecutableLookup } from '../src/lookup.ts'

const INSTALL = 'C:\\Users\\u\\AppData\\Local\\Programs\\casper\\casper.exe'
const CUSTOM = 'D:\\Tools\\casper\\casper.exe'
const BUN = 'D:\\bun\\bin\\casper.exe'
const AMBIENT = { CASPER_INSTALL_DIR: 'D:\\Tools\\casper', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', BUN_INSTALL: 'D:\\bun' }

/** A lookup that finds only `found` (name to path) and records every name it was asked for. */
function lookupOf(found: Record<string, string>): ExecutableLookup & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    resolveExecutable: (command) => {
      asked.push(command)
      const hit = found[command]
      return hit === undefined ? Promise.reject(new SubprocessExecutableNotFoundError(`${command} not found`)) : Promise.resolve(hit)
    },
  }
}

const signal = new AbortController().signal

/** Run the lookup for `command` as Windows would, with `ambient` as the app's environment. */
function onWindows(lookup: ExecutableLookup, command = 'casper.exe', ambient: NodeJS.ProcessEnv = AMBIENT) {
  return findCasper(lookup, { command, env: {} }, signal, 'win32', ambient)
}

describe('windowsCasperCandidates', () => {
  it('tries the installer override, the installer folder, then bun, once each', () => {
    expect(windowsCasperCandidates(AMBIENT)).toEqual([CUSTOM, INSTALL, BUN])
    expect(windowsCasperCandidates({ ...AMBIENT, CASPER_INSTALL_DIR: 'C:\\Users\\u\\AppData\\Local\\Programs\\casper' })).toEqual([INSTALL, BUN])
  })

  it('leaves out unset, empty, and relative folders', () => {
    expect(windowsCasperCandidates({})).toEqual([])
    expect(windowsCasperCandidates({ CASPER_INSTALL_DIR: '', LOCALAPPDATA: 'AppData\\Local', BUN_INSTALL: 'D:\\bun' })).toEqual([BUN])
  })
})

describe('isDefaultCasperName', () => {
  it('is true only for a bare casper or casper.exe', () => {
    for (const name of ['casper', 'casper.exe', 'Casper', 'CASPER.EXE']) expect(isDefaultCasperName(name)).toBe(true)
    for (const name of ['casper.cmd', 'casper-dev', 'C:\\casper\\casper.exe', '/usr/local/bin/casper', 'bin/casper']) {
      expect(isDefaultCasperName(name)).toBe(false)
    }
  })
})

describe('findCasper', () => {
  it('keeps the configured lookup\'s hit and tries nothing else', async () => {
    const lookup = lookupOf({ 'casper.exe': 'C:\\bin\\casper.exe' })
    expect(await onWindows(lookup)).toBe('C:\\bin\\casper.exe')
    expect(lookup.asked).toEqual(['casper.exe'])
  })

  it('finds the installer\'s casper.exe on Windows when PATH predates the install', async () => {
    const lookup = lookupOf({ [INSTALL]: INSTALL })
    expect(await onWindows(lookup, 'casper.exe', { LOCALAPPDATA: AMBIENT.LOCALAPPDATA })).toBe(INSTALL)
    expect(lookup.asked).toEqual(['casper.exe', 'casper', INSTALL])
  })

  it('retries casper.exe as a bare name so PATHEXT finds it, and does not retry a bare casper', async () => {
    expect(await onWindows(lookupOf({ casper: 'C:\\bin\\casper.EXE' }))).toBe('C:\\bin\\casper.EXE')
    const bare = lookupOf({ [BUN]: BUN })
    expect(await onWindows(bare, 'casper')).toBe(BUN)
    expect(bare.asked).toEqual(['casper', CUSTOM, INSTALL, BUN])
  })

  it('passes over a .cmd, .bat, or other script and names it when nothing else is found', async () => {
    const script = 'C:\\Users\\u\\AppData\\Roaming\\npm\\casper.cmd'
    const first = await onWindows(lookupOf({ casper: script }), 'casper').catch((error: unknown) => error)
    expect(first).toBeInstanceOf(CasperLookupError)
    expect(first).toMatchObject({ scripts: [script], folders: ['D:\\Tools\\casper', 'C:\\Users\\u\\AppData\\Local\\Programs\\casper', 'D:\\bun\\bin'] })
    expect((first as CasperLookupError).cause).toBeUndefined()
    const later = await onWindows(lookupOf({ casper: script, [CUSTOM]: 'D:\\Tools\\casper\\casper.bat' }), 'casper.exe', { CASPER_INSTALL_DIR: AMBIENT.CASPER_INSTALL_DIR })
      .catch((error: unknown) => error)
    expect(later).toMatchObject({ scripts: [script, 'D:\\Tools\\casper\\casper.bat'] })
    expect((later as CasperLookupError).cause).toBeInstanceOf(SubprocessExecutableNotFoundError)
    expect(await onWindows(lookupOf({ casper: script, [INSTALL]: INSTALL }), 'casper')).toBe(INSTALL)
    const other = await onWindows(lookupOf({ casper: 'C:\\bin\\casper.JS' }), 'casper', {}).catch((error: unknown) => error)
    expect(other).toMatchObject({ scripts: ['C:\\bin\\casper.JS'] })
    expect(await onWindows(lookupOf({ casper: 'C:\\bin\\casper.COM' }), 'casper', {})).toBe('C:\\bin\\casper.COM')
  })

  it('throws a not-found error with the folders tried when nothing is found', async () => {
    const empty = await onWindows(lookupOf({}), 'casper.exe', {}).catch((error: unknown) => error)
    expect(empty).toBeInstanceOf(SubprocessExecutableNotFoundError)
    expect(empty).toMatchObject({ folders: [], scripts: [], message: expect.stringContaining('the install folders') as string })
    const named = await onWindows(lookupOf({})).catch((error: unknown) => error)
    expect(String(named)).toContain('D:\\Tools\\casper, C:\\Users\\u\\AppData\\Local\\Programs\\casper, D:\\bun\\bin')
  })

  it('keeps a script the user named, and every hit on macOS and Linux', async () => {
    const script = 'C:\\tools\\casper.cmd'
    expect(await onWindows(lookupOf({ [script]: script }), script)).toBe(script)
    for (const platform of ['darwin', 'linux'] as const) {
      expect(await findCasper(lookupOf({ casper: '/opt/casper.cmd' }), { command: 'casper', env: {} }, signal, platform, AMBIENT)).toBe('/opt/casper.cmd')
    }
  })

  it('has no fallback on macOS and Linux, or for a command the user set', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const lookup = lookupOf({ [INSTALL]: INSTALL })
      const failure = await findCasper(lookup, { command: 'casper', env: {} }, signal, platform, AMBIENT).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(SubprocessExecutableNotFoundError)
      expect(failure).not.toBeInstanceOf(CasperLookupError)
      expect(lookup.asked).toEqual(['casper'])
    }
    for (const command of ['C:\\Casper\\casper.exe', 'casper-dev']) {
      const lookup = lookupOf({ [INSTALL]: INSTALL })
      expect(await onWindows(lookup, command).catch((error: unknown) => error)).not.toBeInstanceOf(CasperLookupError)
      expect(lookup.asked).toEqual([command])
    }
  })

  it('passes any other lookup error on unchanged, from the first lookup or the fallback', async () => {
    const broken = new Error('relative path')
    const first: ExecutableLookup = { resolveExecutable: () => Promise.reject(broken) }
    expect(await onWindows(first).catch((error: unknown) => error)).toBe(broken)
    const later: ExecutableLookup = {
      resolveExecutable: command => Promise.reject(command === 'casper.exe' ? new SubprocessExecutableNotFoundError('missing') : broken),
    }
    expect(await onWindows(later).catch((error: unknown) => error)).toBe(broken)
  })

  it('stops the walk when aborted', async () => {
    const controller = new AbortController()
    const asked: string[] = []
    const lookup: ExecutableLookup = {
      resolveExecutable: (command) => {
        asked.push(command)
        controller.abort(new Error('stopped'))
        return Promise.reject(new SubprocessExecutableNotFoundError(`${command} not found`))
      },
    }
    const failure = await findCasper(lookup, { command: 'casper.exe', env: {} }, controller.signal, 'win32', AMBIENT).catch((error: unknown) => error)
    expect(failure).toMatchObject({ message: 'stopped' })
    expect(asked).toEqual(['casper.exe'])
  })

  it('uses the host platform and environment by default', async () => {
    const lookup = lookupOf({ casper: 'C:\\bin\\casper.exe' })
    expect(await findCasper(lookup, { command: 'casper', env: {} }, signal)).toBe('C:\\bin\\casper.exe')
  })
})

describe('lookupDetail', () => {
  it('names the folders tried and any script, and adds nothing for another not-found error', () => {
    expect(lookupDetail(new SubprocessExecutableNotFoundError('missing'))).toBe('')
    expect(lookupDetail(new CasperLookupError([], []))).toBe(' Looked on PATH.')
    expect(lookupDetail(new CasperLookupError(['D:\\bun\\bin'], ['C:\\npm\\casper.cmd']))).toBe(
      ' Looked on PATH and in D:\\bun\\bin. Found C:\\npm\\casper.cmd, which the app cannot start; install casper.exe with Casper\'s Windows installer.',
    )
  })
})
