/** The Settings > MCP servers the app hands Casper: which go, how their credentials resolve, and why one is left out. */

import { describe, expect, it } from 'vitest'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import { CWD_META, forwardedServers, MAX_FORWARDED, SKIP } from '../src/forward-servers.ts'
import type { ForwardEntry, ForwardOptions } from '../src/forward-servers.ts'

/** A stdio entry with the manager's defaults. */
function stdio(fields: Partial<ForwardEntry> = {}): ForwardEntry {
  return { transport: 'stdio', command: '/usr/bin/server', args: [], env: {}, cwd: '', url: '', headers: {}, enabled: true, ...fields }
}

/** A streamable-http entry with the manager's defaults. */
function http(fields: Partial<ForwardEntry> = {}): ForwardEntry {
  return { transport: 'streamable-http', command: '', args: [], env: {}, cwd: '', url: 'https://mcp.example/mcp', headers: {}, enabled: true, ...fields }
}

const VALUES: Record<string, string> = { GITHUB_TOKEN: 'ghp-secret-value', DOCS_KEY: 'docs-secret-value' }

/** Build the list over `entries` with stand-in resolvers; returns the result and the skips. */
async function build(entries: Record<string, ForwardEntry>, overrides: Partial<ForwardOptions> = {}) {
  const skipped: [string, string][] = []
  const looked: string[] = []
  const result = await forwardedServers({
    entries,
    credential: ref => Promise.resolve(VALUES[ref]),
    resolveExecutable: (command) => {
      looked.push(command)
      if (command === 'npx') return Promise.resolve('/opt/node/bin/npx')
      return Promise.reject(new SubprocessExecutableNotFoundError(`${command} not found`))
    },
    signal: new AbortController().signal,
    skip: (name, reason) => { skipped.push([name, reason]) },
    ...overrides,
  })
  return { ...result, skipped, looked }
}

describe('forwardedServers', () => {
  it('npx with a credential env becomes an absolute command and the resolved env', async () => {
    const { entries, names, skipped, looked } = await build({
      github: stdio({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${credential:GITHUB_TOKEN}', DEBUG: '1' } }),
    })
    expect(skipped).toEqual([])
    expect(looked).toEqual(['npx'])
    expect(names).toEqual(['github'])
    expect(entries).toEqual([{
      name: 'github', command: '/opt/node/bin/npx', args: ['-y', '@modelcontextprotocol/server-github'],
      env: [{ name: 'GITHUB_TOKEN', value: 'ghp-secret-value' }, { name: 'DEBUG', value: '1' }],
    }])
    // Casper asks before every change: the app never says it asks itself.
    expect(JSON.stringify(entries)).not.toContain('casper/clientAsks')
  })

  it('a Bearer header becomes an http entry', async () => {
    const { entries, names } = await build({
      docs: http({ headers: { Authorization: 'Bearer ${credential:DOCS_KEY}', 'X-Team': 'blue' } }),
    })
    expect(names).toEqual(['docs'])
    expect(entries).toEqual([{
      type: 'http', name: 'docs', url: 'https://mcp.example/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer docs-secret-value' }, { name: 'X-Team', value: 'blue' }],
    }])
  })

  it('cwd becomes casper/cwd', async () => {
    const { entries } = await build({ files: stdio({ cwd: '/work/files' }) })
    expect(entries).toEqual([{ name: 'files', command: '/usr/bin/server', args: [], env: [], _meta: { [CWD_META]: '/work/files' } }])
  })

  it('each skip carries a reason that holds no value', async () => {
    let calls = 0
    const many = Object.fromEntries(Array.from({ length: MAX_FORWARDED + 1 }, (_, at) => [`many${at}`, stdio()]))
    const { names, skipped, passing } = await build({
      off: stdio({ enabled: false }),
      app: stdio(),
      inArgs: stdio({ args: ['--token', '${credential:GITHUB_TOKEN}'] }),
      inUrl: http({ url: 'https://mcp.example/${credential:DOCS_KEY}' }),
      inCwd: stdio({ cwd: '/work/${credential:DOCS_KEY}' }),
      inCommand: stdio({ command: '/bin/${credential:DOCS_KEY}' }),
      embedded: stdio({ env: { URL: 'https://x:${credential:DOCS_KEY}@example' } }),
      relativeCwd: stdio({ cwd: 'work' }),
      path: stdio({ env: { PATH: '/opt/bin' } }),
      preload: stdio({ env: { DYLD_INSERT_LIBRARIES: '/tmp/x.dylib' } }),
      cookie: http({ headers: { Cookie: 'session=abc' } }),
      missing: stdio({ env: { TOKEN: '${credential:NOT_SET}' } }),
      unknown: stdio({ command: 'not-a-command' }),
      slow: stdio({ command: 'slow-lookup' }),
      ...many,
    }, {
      timeoutMs: 50,
      resolveExecutable: (command) => {
        calls += 1
        if (command === 'slow-lookup') return new Promise(() => { /* never answers */ })
        return Promise.reject(new SubprocessExecutableNotFoundError(`${command} not found`))
      },
    })
    expect(names).toEqual(Array.from({ length: MAX_FORWARDED }, (_, at) => `many${at}`))
    // Only the time limit may pass by the next turn; every other skip is the Settings themselves.
    expect(passing).toEqual(['slow'])
    expect(skipped).toEqual([
      ['off', SKIP.disabled],
      ['app', SKIP.appName],
      ['inArgs', SKIP.placed],
      ['inUrl', SKIP.placed],
      ['inCwd', SKIP.placed],
      ['inCommand', SKIP.placed],
      ['embedded', SKIP.embedded],
      ['relativeCwd', SKIP.cwd],
      ['path', 'PATH cannot be set'],
      ['preload', 'DYLD_INSERT_LIBRARIES cannot be set'],
      ['cookie', 'the connection sets Cookie'],
      ['missing', SKIP.missing],
      ['unknown', SKIP.notFound],
      ['slow', SKIP.timeout],
      [`many${MAX_FORWARDED}`, SKIP.tooMany],
    ])
    expect(calls).toBe(2)
    // No reason carries a credential, a header or env value, or a path.
    const reasons = JSON.stringify(skipped.map(([, reason]) => reason))
    for (const value of [...Object.values(VALUES), 'session=abc', '/opt/bin', '/tmp/x.dylib', 'not-a-command', 'NOT_SET', 'work']) {
      expect(reasons).not.toContain(value)
    }
  })

  it('a credential that cannot be read or a command lookup that fails is left out as passing, and a stopped build rejects', async () => {
    const { skipped, passing } = await build({
      broken: stdio({ env: { TOKEN: '${credential:GITHUB_TOKEN}' } }),
      lookup: stdio({ command: 'flaky' }),
    }, {
      credential: () => Promise.reject(new Error('the keychain is locked: ghp-secret-value')),
      resolveExecutable: () => Promise.reject(new Error('spawn EAGAIN')),
    })
    expect(skipped).toEqual([['broken', SKIP.unreadable], ['lookup', SKIP.unresolved]])
    expect(passing).toEqual(['broken', 'lookup'])
    const stop = new AbortController()
    stop.abort(new Error('stopped'))
    await expect(build({ github: stdio() }, { signal: stop.signal })).rejects.toThrow('stopped')
  })

  it('the digest changes when a credential changes', async () => {
    const entries = { github: stdio({ env: { GITHUB_TOKEN: '${credential:GITHUB_TOKEN}' } }) }
    const first = await build(entries)
    const same = await build(entries)
    const rotated = await build(entries, { credential: () => Promise.resolve('ghp-rotated-value') })
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(same.digest).toBe(first.digest)
    expect(rotated.digest).not.toBe(first.digest)
    expect(first.digest).not.toContain('ghp')
  })
})
