// @vitest-environment jsdom
/** The Casper engine row in General Settings, its copy, and the `casperEngine` mount. */
import assert from 'node:assert/strict'
import { act, cleanup, render, screen } from '@testing-library/react'
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RemoteError, type RemoteFailure, type RemoteResult, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CasperEngineInfo } from '../src/engine-types.ts'
import { applyCasperClient } from '../src/client/apply.ts'
import { mountCasperEngine } from '../src/client/engine-mount.ts'
import {
  engineDe, engineEn, engineEs, engineFr, engineJa, enginePt, engineRu, engineZh, ENGINE_NS,
} from '../src/client/engine-locales.ts'
import { EngineVersionRow, engineLine, type EngineVersionRowInjected } from '../src/client/EngineVersionRow.tsx'

afterEach(cleanup)

const REMOTE: TypertRemoteContribution = { package: '@deepseek-ai/dsh-casper-agent', descriptors: [] }

type Answer = RemoteResult<CasperEngineInfo>
const ok = (kind: CasperEngineInfo['kind'], version = '0.4.15'): Answer => ({ ok: true, value: { kind, version } })
const failed = (error: RemoteFailure): Answer => ({ ok: false, error })

function translate(key: string, params?: Record<string, unknown>): string {
  const template = (engineEn as Record<string, string>)[key] ?? key
  return template.replace(/\{(\w+)\}/g, (hole, name: string) => params !== undefined && name in params ? String(params[name]) : hole)
}

type RowProps = Parameters<typeof EngineVersionRow>[0]

function isFace(value: Record<string, unknown> | undefined): value is Record<string, unknown> & EngineVersionRowInjected {
  return typeof value?.describe === 'function'
}

function show(describe: EngineVersionRowInjected['describe']) {
  return render(<EngineVersionRow describe={describe} t={translate as RowProps['t']} />)
}

describe('engineLine', () => {
  it('names the version and where the engine comes from', () => {
    expect(engineLine(ok('bundled'))).toEqual({ key: 'engine.bundled', version: '0.4.15' })
    expect(engineLine(ok('installed', '0.5.0'))).toEqual({ key: 'engine.installed', version: '0.5.0' })
  })

  it('tells a missing bundled engine from a Casper missing on the computer, and shows any other failure as unknown', () => {
    expect(engineLine(failed(new RemoteError('casper-engine/missing', 'gone', { kind: 'bundled' })))).toEqual({ key: 'engine.missingBundled' })
    expect(engineLine(failed(new RemoteError('casper-engine/missing', 'gone', { kind: 'installed' })))).toEqual({ key: 'engine.missingInstalled' })
    expect(engineLine(failed(new RemoteError('casper-engine/unreadable', 'odd', { kind: 'bundled' })))).toEqual({ key: 'engine.unknown' })
    expect(engineLine(failed(new RemoteError('gateway/internal', 'down', {})))).toEqual({ key: 'engine.unknown' })
  })
})

describe('EngineVersionRow', () => {
  it('says it is checking until the Host answers, then shows the answer', async () => {
    let answer: (value: Answer) => void = () => {}
    const describe = vi.fn(() => new Promise<Answer>((resolve) => { answer = resolve }))
    show(describe)
    expect(screen.getByText('Casper engine: checking')).toBeTruthy()
    await act(async () => { answer(ok('bundled')) })
    expect(screen.getByText('Casper engine: 0.4.15, shipped with the app')).toBeTruthy()
    expect(describe).toHaveBeenCalledOnce()
  })

  it('ignores an answer that arrives after the row closed', async () => {
    let answer: (value: Answer) => void = () => {}
    const view = show(() => new Promise<Answer>((resolve) => { answer = resolve }))
    view.unmount()
    await act(async () => { answer(ok('installed')) })
    expect(view.container.innerHTML).toBe('')
  })
})

describe('mountCasperEngine', () => {
  it('mounts the namespace, then adds the row after the update channel with its copy in every dictionary', async () => {
    const ctx = new Context()
    const unmount = vi.fn(async () => {})
    const mount = vi.fn(async (_contribution: TypertRemoteContribution) => unmount)
    class Remote extends Service {
      constructor() { super(ctx, 'remote') }
      $mount = mount
    }
    new Remote()
    const describe = vi.fn(async (): Promise<Answer> => ok('bundled'))
    ctx.provide('remote.casperEngine', { describe })
    ctx.provide('locale', new LocaleRuntime(ctx))
    try {
      await ctx.plugin(SlotRegistry)
      ctx.slots.register({ name: 'root', children: { 'settings.general.item': { kind: 'list', scope: 'root' } } } as never, () => null)
      await ctx.plugin({ inject: ['remote'], apply: (plugin: Context) => { mountCasperEngine(plugin, REMOTE) } })
      await vi.waitFor(() => { expect(ctx.slots.entries('settings.general.item')).toHaveLength(1) })
      expect(mount).toHaveBeenCalledExactlyOnceWith(REMOTE)
      const [entry] = ctx.slots.entries('settings.general.item')
      expect(entry).toMatchObject({ options: { id: 'casper-engine', order: 99 }, locale: ENGINE_NS, component: EngineVersionRow })
      const face = entry?.inject?.()
      assert(isFace(face))
      await expect(face.describe()).resolves.toEqual(ok('bundled'))
      expect(describe).toHaveBeenCalledOnce()
      for (const dictionary of [engineZh, engineJa, engineEs, engineFr, engineDe, engineRu, enginePt]) {
        expect(Object.keys(dictionary).sort()).toEqual(Object.keys(engineEn).sort())
      }
    } finally {
      await ctx.fiber.dispose()
    }
    expect(unmount).toHaveBeenCalledOnce()
  })

  it('is mounted by the Client face once remote is served', () => {
    const scope = { plugin: vi.fn(), inject: vi.fn() }
    const ctx = {
      effect: (run: () => unknown) => run(),
      locale: { register: vi.fn(() => () => {}), bind: vi.fn(() => vi.fn()) },
      uiConversation: { events: { register: vi.fn(() => () => {}) }, views: { register: vi.fn(() => () => {}) } },
      slots: { inject: vi.fn(), register: vi.fn() },
      inject: vi.fn((_keys: string[], run: (scope: unknown) => void) => { run(scope) }),
    }
    applyCasperClient(ctx as never, REMOTE)
    expect(ctx.inject).toHaveBeenCalledWith(['remote'], expect.any(Function))
    expect(scope.plugin).toHaveBeenCalledOnce()
    expect(scope.inject).toHaveBeenCalledWith(['remote.casperEngine', 'slots', 'locale'], expect.any(Function))
  })
})
