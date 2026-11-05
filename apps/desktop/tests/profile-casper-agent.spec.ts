/** Casper's Desktop profile drives new Sessions with the Casper agent; other profiles keep the DeepSeek loop. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { composeEntries, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { createPluginProfile } from '../src/project-manager.ts'

type Row = { id?: string; name?: string; disabled?: unknown; config?: Record<string, unknown> }

/** Compose the shipped Desktop profile rows. */
function desktopRows(): Row[] {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-casper-agent-'))
  try {
    const profileDir = join(home, 'profiles', 'desktop')
    createPluginProfile(profileDir)
    const installAnchor = fileURLToPath(new URL('../../cli/package.json', import.meta.url))
    const profile = loadProfileDirectory('dsh desktop', profileDir, installAnchor)
    return composeEntries([...profile.layers.map(layer => layer.patches), profile.patches], () => {})
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/** Source of a Loader `!!js` value, or undefined for a literal. */
function expression(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && '__jsExpr' in value ? String(value.__jsExpr) : undefined
}

/** A Loader-context stub naming the profile. */
function profileCtx(name: string): { get: (key: string) => unknown } {
  return { get: key => key === 'profileContext' ? { name } : undefined }
}

/** Fixed inputs of a shipped expression: environment, Worker presence, home folder, and installed files. */
interface Inputs {
  readonly env?: Record<string, string>
  readonly worker?: boolean
  readonly home?: string
  readonly installed?: readonly string[]
}

/** Evaluate a shipped expression with a Loader context and a fixed `process`; `node:os` and `node:fs` see only `inputs`. */
function evaluate(source: string, ctx: { get: (key: string) => unknown }, inputs: Inputs = {}): unknown {
  const home = inputs.home ?? join('/home', 'user')
  const installed = new Set(inputs.installed ?? [])
  const modules: Record<string, unknown> = {
    'node:os': { homedir: () => home },
    'node:fs': { existsSync: (file: string) => installed.has(file) },
  }
  const fakeProcess = {
    env: inputs.env ?? {},
    platform: process.platform,
    getBuiltinModule: (name: string): unknown => modules[name] ?? process.getBuiltinModule(name),
  }
  // eslint-disable-next-line typescript/no-implied-eval -- evaluates the shipped Loader expression against a fixed context.
  const run = new Function('ctx', 'process', 'WorkerGlobalScope', `return (${source})`) as (ctx: unknown, process: unknown, worker: unknown) => unknown
  return run(ctx, fakeProcess, inputs.worker === true ? {} : undefined)
}

/** The three rows that must agree: the driver, its preset, and the registry default. */
function casperGates(): { agent: string; preset: string; fallback: string } {
  const rows = desktopRows()
  const of = (id: string): unknown => rows.find(entry => entry.id === id)
  const agent = expression((of('casper-agent') as Row | undefined)?.disabled)
  const preset = expression((of('preset-casper') as Row | undefined)?.disabled)
  const fallback = expression((of('agent-preset-registry') as Row | undefined)?.config?.['default'])
  if (agent === undefined || preset === undefined || fallback === undefined) throw new Error('a Casper gate is not an expression')
  return { agent, preset, fallback }
}

it('mounts the Casper agent only on Desktop', () => {
  const row = desktopRows().find(entry => entry.id === 'casper-agent')
  expect(row?.name).toBe('@deepseek-ai/dsh-casper-agent')
  const disabled = expression(row?.disabled)
  expect(disabled).toBeDefined()
  expect(evaluate(disabled ?? '', profileCtx('desktop'))).toBe(false)
  expect(evaluate(disabled ?? '', profileCtx('web'))).toBe(true)
  expect(row?.config).toMatchObject({ presets: ['casper'], args: ['acp'] })
})

it('passes Casper bun on PATH and the OpenRouter key, and no DeepSeek variables', () => {
  const env = expression(desktopRows().find(entry => entry.id === 'casper-agent')?.config?.['env'])
  const value = evaluate(env ?? '', profileCtx('desktop'), { env: { DEEPSEEK_API_KEY: 'x', OPENROUTER_API_KEY: 'y', PATH: '/usr/bin' } }) as Record<string, string>
  expect(Object.keys(value).sort()).toEqual(['OPENROUTER_API_KEY', 'PATH'])
  expect(value['OPENROUTER_API_KEY']).toBe('y')
  expect(value['PATH']).toContain(join('.bun', 'bin'))
  expect(value['PATH']?.endsWith('/usr/bin')).toBe(true)
  const withoutKey = evaluate(env ?? '', profileCtx('desktop'), {}) as Record<string, string>
  expect(Object.keys(withoutKey)).toEqual(['PATH'])
})

it('looks Casper up on PATH, then the installer folders, and falls back to the bare name', () => {
  const command = expression(desktopRows().find(entry => entry.id === 'casper-agent')?.config?.['command']) ?? ''
  const exe = process.platform === 'win32' ? 'casper.exe' : 'casper'
  const home = join('/home', 'user')
  const lookup = (installed: string[], path = ''): unknown => evaluate(command, profileCtx('desktop'), { env: { PATH: path }, home, installed })
  expect(lookup([])).toBe(exe)
  expect(lookup([join(home, '.local', 'bin', exe)])).toBe(join(home, '.local', 'bin', exe))
  expect(lookup([join(home, '.bun', 'bin', exe)])).toBe(join(home, '.bun', 'bin', exe))
  expect(lookup([join('/opt/homebrew/bin', exe)])).toBe(join('/opt/homebrew/bin', exe))
  expect(lookup([join('/usr/local/bin', exe)])).toBe(join('/usr/local/bin', exe))
  // A PATH folder wins over the installer folders.
  expect(lookup([join(home, '.local', 'bin', exe), join('/opt/tools', exe)], '/opt/tools')).toBe(join('/opt/tools', exe))
})

it('declares the Casper preset with the todo list only, on Desktop only', () => {
  const row = desktopRows().find(entry => entry.id === 'preset-casper')
  expect(row?.config?.['id']).toBe('casper')
  const plugins = row?.config?.['plugins'] as { id?: string }[] | undefined
  expect(plugins?.map(plugin => plugin.id)).toEqual(['tool-todo'])
  const disabled = expression(row?.disabled)
  expect(evaluate(disabled ?? '', profileCtx('desktop'))).toBe(false)
  expect(evaluate(disabled ?? '', profileCtx('web'))).toBe(true)
})

it('starts new Sessions on Casper on Desktop and on Standard elsewhere', () => {
  const { fallback } = casperGates()
  expect(evaluate(fallback, profileCtx('desktop'))).toBe('casper')
  expect(evaluate(fallback, profileCtx('web'))).toBe('standard')
})

it('gates the Casper driver, its preset, and the Desktop default the same way, Worker included', () => {
  const { agent, preset, fallback } = casperGates()
  for (const name of ['desktop', 'web', 'cli']) {
    for (const worker of [false, true]) {
      const mounted = evaluate(agent, profileCtx(name), { worker }) === false
      expect(evaluate(preset, profileCtx(name), { worker }) === false).toBe(mounted)
      expect(evaluate(fallback, profileCtx(name), { worker })).toBe(mounted ? 'casper' : 'standard')
    }
  }
  expect(evaluate(agent, profileCtx('desktop'), { worker: true })).toBe(true)
  expect(evaluate(agent, profileCtx('desktop'))).toBe(false)
})
