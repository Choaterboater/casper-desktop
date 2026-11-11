import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { casperAgentDomain, CasperSidecar } from '../src/sidecar.ts'
import type { CasperSessionRecord } from '../src/sidecar.ts'
import { boot, prompt } from './harness.ts'
import { fakeCasper, waitFor } from './support.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A sidecar over an in-memory table that records each delete. */
function memorySidecar(ids: string[]) {
  const records = new Map<string, CasperSessionRecord>(ids.map(id => [id, { acpSessionId: `conversation-${id}`, cwd: '/project' }]))
  const deletes: string[][] = []
  const table = {
    keys: () => records.keys(),
    deleteMany: (keys: readonly string[]) => {
      deletes.push([...keys])
      for (const key of keys) records.delete(key)
      return Promise.resolve(keys.length)
    },
  }
  return { sidecar: new CasperSidecar({ table: () => table } as never), records, deletes }
}

describe('Casper\'s sidecar records', { timeout: 60_000 }, () => {
  it('has says whether a Session has a record in any folder, which read keeps to its own folder', () => {
    const records = new Map<string, CasperSessionRecord>([['live', { acpSessionId: 'conversation-live', cwd: '/project' }]])
    const sidecar = new CasperSidecar({ table: () => ({ get: (id: string) => records.get(id) }) } as never)
    expect(sidecar.has('live' as SessionId)).toBe(true)
    expect(sidecar.read('live' as SessionId, '/elsewhere')).toBeUndefined()
    expect(sidecar.has('other' as SessionId)).toBe(false)
  })

  it('prune deletes a record whose session is gone and keeps an archived or unreadable one', async () => {
    const { sidecar, records, deletes } = memorySidecar(['live', 'gone', 'archived', 'unreadable'])
    // An archived Session is still stored; a Session that cannot be read now may still be there.
    const exists = (id: SessionId) => id === 'unreadable' ? Promise.reject(new Error('EACCES')) : Promise.resolve(id !== 'gone')
    expect(await sidecar.prune(exists)).toBe(1)
    expect(deletes).toEqual([['gone']])
    expect([...records.keys()]).toEqual(['live', 'archived', 'unreadable'])
    // Nothing gone writes nothing.
    expect(await sidecar.prune(exists)).toBe(0)
    expect(deletes).toHaveLength(1)
  })

  it('the next start drops the record of a deleted session and keeps the others', async () => {
    const fake = fakeCasper({ prompts: [[{ text: 'one\n' }]] })
    cleanups.push(() => { fake.remove() })
    const first = await boot(fake)
    const { agent } = await first.create('casper-kept')
    agent.followup(prompt('first'))
    await agent.whenIdle()
    const kept = first.record('casper-kept')
    expect(kept).toBeDefined()
    // A record whose Session is not stored, as one deleted outside the app leaves.
    await first.ctx.storageDomain.get('casper_agent')?.table('sessions').put('casper-deleted', { acpSessionId: 'conversation-gone', cwd: fake.cwd })
    expect(first.record('casper-deleted')).toBeDefined()
    await first.ctx.fiber.dispose()

    const second = await boot(fake)
    cleanups.push(() => second.ctx.fiber.dispose())
    await waitFor(() => second.record('casper-deleted') === undefined)
    expect(second.record('casper-kept')).toEqual(kept)
  })

  it('a prune that cannot write is logged, keeps the records, and still lets the plugin close', async () => {
    const fake = fakeCasper({ prompts: [] })
    cleanups.push(() => { fake.remove() })
    const first = await boot(fake)
    await first.ctx.storageDomain.get('casper_agent')?.table('sessions').put('casper-deleted', { acpSessionId: 'conversation-gone', cwd: fake.cwd })
    await first.ctx.fiber.dispose()

    let warn: MockInstance<(...args: unknown[]) => void> | undefined
    const second = await boot(fake, {}, undefined, true, async (ctx) => {
      warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
      // The sidecar's delete fails, as a full disk makes it.
      const open = ctx.storageDomain.open.bind(ctx.storageDomain)
      ctx.storageDomain.open = async (definition) => {
        const domain = await open(definition)
        if (definition.name === casperAgentDomain.name) domain.table('sessions').deleteMany = () => Promise.reject(new Error('disk full'))
        return domain
      }
    })
    cleanups.push(() => second.ctx.fiber.dispose())
    await waitFor(() => warn?.mock.calls.some(([message]) => String(message).includes('records of deleted sessions not dropped: Error: disk full')))
    expect(second.record('casper-deleted')).toBeDefined()
    await second.unloadCasper()
  })
})
