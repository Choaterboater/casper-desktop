// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CasperOwnAccessView } from '../src/access-view.ts'
import { apply } from '../src/client/index.ts'
import { de, en, es, fr, ja, NS, pt, ru, zh } from '../src/client/locales.ts'
import { ModePill, type ModePillProps } from '../src/client/ModePill.tsx'

afterEach(cleanup)

function translate(key: string, params?: Record<string, unknown>): string {
  const template = (en as Record<string, string>)[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (hole, name: string) => name in params ? String(params[name]) : hole)
}

/** A projection reader that serves one `casperAccess` value. */
function reading(value: CasperOwnAccessView | null | undefined): ModePillProps['useProjection'] {
  return (key: string, selector?: (current: unknown) => unknown) => {
    const current = key === 'casperAccess' ? value : undefined
    return selector === undefined ? current : selector(current)
  }
}

function show(value: CasperOwnAccessView | null | undefined) {
  return render(<ModePill useProjection={reading(value)} t={translate as ModePillProps['t']} />)
}

describe('ModePill', () => {
  it('names the mode Casper picked itself, with the reason in its title, and offers no action', () => {
    const view = show({ mode: 'full' })
    const pill = screen.getByText('Casper set Don\'t ask')
    expect(pill.getAttribute('data-casper-mode')).toBe('full')
    expect(pill.getAttribute('title')).toBe(en['pill.title'])
    expect(view.container.querySelector('button, a, [role="button"], [tabindex]')).toBeNull()
    view.unmount()
    show({ mode: 'ask' })
    expect(screen.getByText('Casper set Ask first')).toBeTruthy()
    cleanup()
    show({ mode: 'read' })
    expect(screen.getByText('Casper set Read only')).toBeTruthy()
  })

  it('shows nothing when Casper is in the mode the app set, or in a Session without the projection', () => {
    expect(show(null).container.innerHTML).toBe('')
    expect(show(undefined).container.innerHTML).toBe('')
  })

  it('registers after the composer\'s mode controls with its copy in every dictionary', () => {
    type Options = { name: string; id?: string; locale?: string }
    const register = vi.fn((_options: Options, _component: unknown) => () => {})
    const slots = { inject: vi.fn((_name: string, mount: () => () => void) => mount()), register }
    const effect = vi.fn((run: () => unknown) => run())
    const uiConversation = { events: { register: vi.fn(() => () => {}) }, views: { register: vi.fn(() => () => {}) } }
    const locale = { register: vi.fn(() => () => {}), bind: vi.fn(() => vi.fn()) }
    apply({ slots, effect, locale, uiConversation, inject: () => {} } as never)
    const entry = register.mock.calls.find(call => call[0].name === 'conversation.input.left')
    expect(entry?.[0]).toEqual({ name: 'conversation.input.left', id: 'casper-mode-pill', locale: NS })
    expect(entry?.[1]).toBe(ModePill)
    for (const dictionary of [zh, ja, es, fr, de, ru, pt]) {
      for (const key of ['pill.label', 'pill.read', 'pill.ask', 'pill.full', 'pill.title'] as const) expect(dictionary[key]).not.toBe(en[key])
      expect(dictionary['pill.label']).toContain('{mode}')
    }
  })
})
