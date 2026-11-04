/** MCP resource ownership in the shipped Desktop composition. */

import * as fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { composeEntries, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { createPluginProfile } from '../src/project-manager.ts'

it('retains one shared resource consumer in the Desktop Web profile', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-mcp-'))
  try {
    const profileDir = join(home, 'profiles', 'desktop')
    createPluginProfile(profileDir)
    const installAnchor = fileURLToPath(new URL('../../cli/package.json', import.meta.url))
    const profile = loadProfileDirectory('dsh desktop', profileDir, installAnchor)
    const warnings: string[] = []
    const rows = composeEntries([
      ...profile.layers.map(layer => layer.patches),
      profile.patches,
    ], message => warnings.push(message))

    expect(rows.filter(row => row.name === '@deepseek-ai/dsh-mcp-resources')).toEqual([
      { id: 'mcp-resources', name: '@deepseek-ai/dsh-mcp-resources' },
    ])
    // Casper ships only casper-network-mcp in the Web/Desktop composition.
    const clients = rows.filter(row => row.name === '@deepseek-ai/dsh-mcp-client')
    expect(clients.map(row => row.id)).toEqual(['mcp-network'])
    expect(clients[0]).toMatchObject({ id: 'mcp-network', config: { serverName: 'network', transport: 'stdio' } })
    expect(rows.find(row => row.id === 'webserver')).toMatchObject({ name: '@deepseek-ai/dsh-host-webserver' })
    expect(rows.find(row => row.id === 'webserver')?.disabled).not.toBe(true)
    expect(warnings).toEqual([])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

/** Compose the shipped Desktop profile and return its casper-network-mcp row. */
function networkRow(): { config: { command: unknown; args: string[]; env: unknown } } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-network-'))
  try {
    const profileDir = join(home, 'profiles', 'desktop')
    createPluginProfile(profileDir)
    const installAnchor = fileURLToPath(new URL('../../cli/package.json', import.meta.url))
    const profile = loadProfileDirectory('dsh desktop', profileDir, installAnchor)
    const rows = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches], () => {})
    const row = rows.find(entry => entry.id === 'mcp-network')
    if (row === undefined) throw new Error('the Desktop profile has no mcp-network row')
    return row as never
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

it('starts casper-network-mcp pinned and read-only so it cannot change a network device', () => {
  const { config } = networkRow()
  expect(config.args).toEqual(['--from', 'casper-network-mcp==0.1.7', 'casper-network-mcp', '--read-only'])
})

/** Evaluate the shipped `command` expression with a chosen PATH, home folder and platform. */
function resolveUvx(options: { path: string; home: string; root: string; platform?: NodeJS.Platform }): string {
  const { command } = networkRow().config
  const source = typeof command === 'object' && command !== null && '__jsExpr' in command ? String(command.__jsExpr) : String(command)
  // Only files inside the test's temp folder count, so a real /opt/homebrew/bin/uvx cannot change the outcome.
  const scopedFs = { existsSync: (file: string) => file.startsWith(options.root) && fs.existsSync(file) }
  const modules: Record<string, unknown> = { 'node:fs': scopedFs, 'node:path': path, 'node:os': { homedir: () => options.home } }
  const fakeProcess = { platform: options.platform ?? 'darwin', env: { PATH: options.path }, getBuiltinModule: (id: string) => modules[id] }
  // eslint-disable-next-line typescript/no-implied-eval -- evaluates the shipped Loader expression against a fixed fake process.
  return (new Function('process', `return (${source})`) as (process: unknown) => string)(fakeProcess)
}

it('finds uvx on PATH, then in uv\'s default install folder, before falling back to the bare name', () => {
  const root = mkdtempSync(join(tmpdir(), 'casper-uvx-'))
  try {
    const onPath = join(root, 'bin')
    const home = join(root, 'home')
    fs.mkdirSync(onPath, { recursive: true })
    fs.mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    expect(resolveUvx({ path: onPath, home, root })).toBe('uvx')
    fs.writeFileSync(join(home, '.local', 'bin', 'uvx'), '')
    expect(resolveUvx({ path: onPath, home, root })).toBe(join(home, '.local', 'bin', 'uvx'))
    fs.writeFileSync(join(onPath, 'uvx'), '')
    expect(resolveUvx({ path: onPath, home, root })).toBe(join(onPath, 'uvx'))
    fs.writeFileSync(join(home, '.local', 'bin', 'uvx.exe'), '')
    expect(resolveUvx({ path: '', home, root, platform: 'win32' })).toBe(join(home, '.local', 'bin', 'uvx.exe'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('passes only product login variables to casper-network-mcp', () => {
  const { env } = networkRow().config
  const source = typeof env === 'object' && env !== null && '__jsExpr' in env ? String(env.__jsExpr) : String(env)
  // eslint-disable-next-line typescript/no-implied-eval -- evaluates the shipped Loader expression against a fixed fake env.
  const evaluate = new Function('process', `return (${source})`) as (process: { env: Record<string, string | undefined> }) => Record<string, string>
  expect(evaluate({ env: {
    MIST_API_TOKEN: 'mist', CENTRAL_CLIENT_SECRET: 'central', CLEARPASS_BASE_URL: 'https://cppm', CENTRAL_TEMP_CLIENT_ID: 'temp',
    AWS_SECRET_ACCESS_KEY: 'aws', OPENAI_API_KEY: 'openai', HOME: '/home/user', MIST_UNSET: undefined,
  } })).toEqual({ MIST_API_TOKEN: 'mist', CENTRAL_CLIENT_SECRET: 'central', CLEARPASS_BASE_URL: 'https://cppm', CENTRAL_TEMP_CLIENT_ID: 'temp' })
})
