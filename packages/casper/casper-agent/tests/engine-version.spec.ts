/** The `casperEngine` namespace: which engine new Sessions start, found as a connection finds it, and its `--version`. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { Config } from '../src/config.ts'
import { CasperEngineService, parseCasperVersion, probeCasperEngine } from '../src/engine-version.ts'

const ENGINE = '/App/Contents/Resources/runtime/casper/casper'
const INSTALLED = '/Users/u/.local/bin/casper'

/** What the fake engine does when spawned: print, exit, hang until its deadline, or fail to spawn. */
type Run =
  | { readonly print: string; readonly exitCode?: number }
  | { readonly hang: true }
  | { readonly spawnError: unknown }
  | { readonly doneError: Error }

/** A subprocess service whose lookup finds `found` (or throws it) and whose spawn plays `run`. */
function subprocessOf(found: string | Error, run: Run = { print: `casper 0.4.15 (${ENGINE})\n` }) {
  const spawned: SubprocessSpawnSpec[] = []
  const asked: string[] = []
  const service: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'> = {
    resolveExecutable: (command) => {
      asked.push(command)
      return typeof found === 'string' ? Promise.resolve(found) : Promise.reject(found)
    },
    spawn: (spec) => {
      spawned.push(spec)
      if ('spawnError' in run) throw run.spawnError
      const done: Promise<SubprocessOutcome> = 'doneError' in run
        ? Promise.reject(run.doneError)
        : 'hang' in run
          ? new Promise((resolve) => {
            const killed = () => { resolve({ exitCode: null, signal: 'SIGTERM' }) }
            if (spec.signal?.aborted === true) killed()
            else spec.signal?.addEventListener('abort', killed, { once: true })
          })
          : Promise.resolve({ exitCode: run.exitCode ?? 0, signal: null })
      const text = 'print' in run ? run.print : ''
      return {
        done,
        collected: { stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) } },
      } as Pick<SubprocessHandle, 'done' | 'collected'> as SubprocessHandle
    },
  }
  return { service, spawned, asked }
}

const bundled = (overrides: Record<string, unknown> = {}) => Config({ engine: ENGINE, ...overrides } as never)
const installed = (overrides: Record<string, unknown> = {}) => bundled({ useInstalledCasper: true, ...overrides })
const live = () => new AbortController().signal

/** The Remote failure a probe threw, or a failure of the test. */
async function failureOf(probe: Promise<unknown>) {
  return remoteErrorOf(await probe.then(() => { throw new Error('the probe succeeded') }, (error: unknown) => error))
}

describe('parseCasperVersion', () => {
  it('reads the version from the first line, with or without a leading v or a pre-release tag', () => {
    expect(parseCasperVersion('casper 0.4.15 (/opt/casper)\n')).toBe('0.4.15')
    expect(parseCasperVersion('\ncasper v1.2.3-rc.1\n')).toBe('1.2.3-rc.1')
    expect(parseCasperVersion('casper 2.0.0')).toBe('2.0.0')
  })

  it('finds none in other output', () => {
    expect(parseCasperVersion('')).toBeUndefined()
    expect(parseCasperVersion('v26.13.0')).toBeUndefined()
    expect(parseCasperVersion('casper 0.4')).toBeUndefined()
    expect(parseCasperVersion('casper 0.4.15x')).toBeUndefined()
  })
})

describe('probeCasperEngine', () => {
  it('runs the bundled engine with --version in Casper\'s environment and reports it as bundled', async () => {
    const { service, spawned, asked } = subprocessOf(ENGINE)
    await expect(probeCasperEngine(bundled({ toolPath: ['/App/tools'] }), service, live(), 'darwin', { PATH: '/usr/bin' }))
      .resolves.toEqual({ kind: 'bundled', version: '0.4.15' })
    expect(asked).toEqual([ENGINE])
    expect(spawned).toHaveLength(1)
    const [spec] = spawned
    expect(spec?.argv).toEqual([ENGINE, '--version'])
    expect(spec?.stdio.stdin).toBe('ignore')
    expect(spec?.env).toMatchObject({ CASPER_NO_UPDATE_CHECK: '1', PATH: '/usr/bin:/App/tools' })
  })

  it('reports the installed Casper with the switch on', async () => {
    const { service, asked } = subprocessOf(INSTALLED, { print: 'casper 0.5.0 (/Users/u/.local/bin/casper)\n' })
    await expect(probeCasperEngine(installed(), service, live(), 'darwin', {})).resolves.toEqual({ kind: 'installed', version: '0.5.0' })
    expect(asked).toEqual(['casper'])
  })

  it('reports a missing bundled engine or installed Casper as casper-engine/missing, naming which', async () => {
    const missing = new SubprocessExecutableNotFoundError('not found')
    expect(await failureOf(probeCasperEngine(bundled(), subprocessOf(missing).service, live(), 'darwin', {})))
      .toMatchObject({ code: 'casper-engine/missing', details: { kind: 'bundled' } })
    expect(await failureOf(probeCasperEngine(installed(), subprocessOf(missing).service, live(), 'darwin', {})))
      .toMatchObject({ code: 'casper-engine/missing', details: { kind: 'installed' } })
  })

  it('passes any other lookup failure on unchanged', async () => {
    const broken = new Error('lookup broke')
    await expect(probeCasperEngine(bundled(), subprocessOf(broken).service, live(), 'darwin', {})).rejects.toBe(broken)
  })

  it('reports an engine that cannot run, fails, runs out of time, or prints no version as casper-engine/unreadable', async () => {
    const runs: Run[] = [
      { spawnError: new Error('EACCES') },
      { spawnError: 'EACCES' },
      { doneError: new Error('provider gone') },
      { print: 'casper 0.4.15\n', exitCode: 2 },
      { hang: true },
      { print: 'v26.13.0\n' },
    ]
    for (const run of runs) {
      const failure = await failureOf(probeCasperEngine(bundled({ startTimeoutMs: 5 }), subprocessOf(ENGINE, run).service, live(), 'darwin', {}))
      expect(failure).toMatchObject({ code: 'casper-engine/unreadable', details: { kind: 'bundled' } })
    }
  })

  it('stops with the caller\'s abort reason during the lookup or the run', async () => {
    const lookup = new AbortController()
    const reason = new Error('closed')
    const slow: Pick<SubprocessRuntime, 'resolveExecutable' | 'spawn'> = {
      ...subprocessOf(ENGINE).service,
      resolveExecutable: () => {
        lookup.abort(reason)
        return Promise.reject(new SubprocessExecutableNotFoundError('not found'))
      },
    }
    await expect(probeCasperEngine(bundled(), slow, lookup.signal, 'darwin', {})).rejects.toBe(reason)
    const run = new AbortController()
    const probe = probeCasperEngine(bundled(), subprocessOf(ENGINE, { hang: true }).service, run.signal, 'darwin', {})
    await Promise.resolve()
    run.abort(reason)
    await expect(probe).rejects.toBe(reason)
  })
})

describe('CasperEngineService', () => {
  it('answers describe from the plugin config and the subprocess service', async () => {
    const ctx = new Context()
    ctx.provide('subprocess', subprocessOf(ENGINE).service)
    try {
      const service = new CasperEngineService(ctx, bundled())
      await expect(service.describe(live())).resolves.toEqual({ kind: 'bundled', version: '0.4.15' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
