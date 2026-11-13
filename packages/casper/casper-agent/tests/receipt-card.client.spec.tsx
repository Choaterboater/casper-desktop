// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyCasperClient } from '../src/client/apply.ts'
import { de, en, es, fr, ja, NS, pt, ru, zh } from '../src/client/locales.ts'
import { ReceiptRow, receiptPath, usageLines, type ReceiptRowProps } from '../src/client/ReceiptRow.tsx'
import type { CasperReceipt } from '../src/receipt.ts'

/** The Client face with a fake `casperEngine` contribution; these specs leave the `remote` scope unserved. */
const apply = (ctx: object) => { applyCasperClient({ inject: () => {}, ...ctx } as never, { package: '@deepseek-ai/dsh-casper-agent', descriptors: [] }) }

afterEach(cleanup)

/** The card's translate over the English dictionary, filling `{name}` holes. */
function translate(key: string, params?: Record<string, unknown>): string {
  const template = (en as Record<string, string>)[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (hole, name: string) => name in params ? String(params[name]) : hole)
}
const t = translate as ReceiptRowProps['t']

const RECEIPT: CasperReceipt = {
  outcome: 'verified',
  verdict: 'Verified: 1 check passed.',
  exitCode: 0,
  changed: ['src/a.ts', 'README.md'],
  checksRun: [
    { name: 'test', status: 'pass', command: 'npm test', exit: 0, ms: 12, fresh: true },
    { name: 'types', status: 'fail', command: null, exit: 2, ms: 30, fresh: true },
  ],
  checksNotRun: [{ name: 'lint', reason: 'not configured' }],
  text: 'Verified: 1 check passed.\nChanged: src/a.ts, README.md',
  usage: { turns: 2, tokens: 1234, estimatedCost: 0.0042 },
  cost: 'estimate',
  root: '/work/project',
}

/** The row's props for a settled `casper_receipt` call whose result carries `meta`. */
function settled(meta: unknown, extra: Partial<ReceiptRowProps> = {}): ReceiptRowProps {
  const block = {
    kind: 'tool-result', seq: 2, time: 2, callId: 'r', name: 'casper_receipt', args: {}, call: { name: 'casper_receipt', argsRaw: '{}' }, callTime: 1,
    content: [{ type: 'text', text: RECEIPT.text }], isError: false, meta, subCalls: [],
  }
  return { phase: 'result', block, callId: 'r', toolName: 'casper_receipt', openFile: vi.fn(), t, ...extra } as ReceiptRowProps
}

function expand(): void {
  fireEvent.click(screen.getAllByRole('button')[0] as HTMLElement)
}

describe('ReceiptRow', () => {
  it('shows the verdict collapsed, then the files, checks and model use', () => {
    const inspect = vi.fn()
    render(<ReceiptRow {...settled(RECEIPT, { inspect })} />)
    expect(screen.getByText('Receipt')).toBeTruthy()
    expect(screen.getByText('Verified: 1 check passed.')).toBeTruthy()
    expect(screen.queryByText('Changed files')).toBeNull()
    expand()
    expect(screen.getByRole('button', { name: 'Open src/a.ts' })).toBeTruthy()
    const run = screen.getByRole('region', { name: 'Checks run' })
    expect(run.textContent).toBe('Checks runtest passednpm testtypes failed')
    expect(screen.getByRole('region', { name: 'Checks not run' }).textContent).toBe('Checks not runlint not configured')
    expect(screen.getByRole('region', { name: 'Model use' }).textContent).toBe('Model use1234 tokens · About $0.0042 (estimate)')
    fireEvent.click(screen.getByRole('button', { name: 'Inspect call' }))
    expect(inspect).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-tool="casper_receipt"]')?.getAttribute('data-state')).toBe('verified')
  })

  it('opens a changed file against the receipt\'s folder', () => {
    const props = settled(RECEIPT)
    render(<ReceiptRow {...props} />)
    expand()
    fireEvent.click(screen.getByRole('button', { name: 'Open src/a.ts' }))
    expect(props.openFile).toHaveBeenCalledWith('/work/project/src/a.ts')
    expect(receiptPath('C:\\work\\', 'a.ts')).toBe('C:\\work\\a.ts')
    expect(receiptPath('/work', '/elsewhere/a.ts')).toBe('/elsewhere/a.ts')
    expect(receiptPath('/work', 'C:\\x\\a.ts')).toBe('C:\\x\\a.ts')
    // An older Casper sends no folder: the path opens as the app reads it, from the Session's folder.
    expect(receiptPath(undefined, 'a.ts')).toBe('a.ts')
  })

  it('says Casper could not compare the workspace, and when nothing changed or ran', () => {
    const view = render(<ReceiptRow {...settled({ ...RECEIPT, changed: null, checksRun: [], checksNotRun: [], usage: null })} />)
    expand()
    expect(screen.getByText('Casper could not compare the workspace')).toBeTruthy()
    expect(screen.getByText('No checks ran')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Model use' })).toBeNull()
    view.unmount()
    render(<ReceiptRow {...settled({ ...RECEIPT, changed: [] })} />)
    expand()
    expect(screen.getByText('No files changed')).toBeTruthy()
  })

  it('names how the cost is paid', () => {
    const usage = { turns: 1, tokens: 50, estimatedCost: 1.5 }
    expect(usageLines({ ...RECEIPT, usage, cost: 'charged' }, t)).toEqual(['50 tokens', 'Charged $1.50'])
    expect(usageLines({ ...RECEIPT, usage: { ...usage, estimatedCost: null }, cost: 'charged' }, t)).toEqual(['50 tokens', 'Cost not known'])
    expect(usageLines({ ...RECEIPT, usage: { ...usage, estimatedCost: null }, cost: 'estimate' }, t)).toEqual(['50 tokens', 'Cost not known'])
    expect(usageLines({ ...RECEIPT, usage, cost: 'subscription' }, t)).toEqual(['50 tokens', 'Paid by your subscription'])
    expect(usageLines({ ...RECEIPT, usage: { ...usage, tokens: null }, cost: null }, t)).toEqual(['Tokens not known'])
    expect(usageLines({ ...RECEIPT, usage: { ...usage, estimatedCost: 0 }, cost: 'estimate' }, t)).toEqual(['50 tokens', 'About $0.00 (estimate)'])
    const { usage: _usage, cost: _cost, root: _root, ...older } = RECEIPT
    expect(usageLines(older, t)).toEqual([])
  })

  it('shows meta that is not a receipt as the receipt\'s text, as the generic row does', () => {
    const inspect = vi.fn()
    render(<ReceiptRow {...settled({ outcome: 'verified' }, { inspect })} />)
    expect(screen.queryByText('Verified: 1 check passed.')).toBeNull()
    expect(document.querySelector('[data-tool="casper_receipt"]')?.getAttribute('data-state')).toBe('plain')
    expand()
    expect(document.querySelector('pre')?.textContent).toBe(RECEIPT.text)
    fireEvent.click(screen.getByRole('button', { name: 'Inspect call' }))
    expect(inspect).toHaveBeenCalledOnce()
    cleanup()
    const empty = settled(undefined)
    render(<ReceiptRow {...{ ...empty, block: { ...empty.block, content: [{ type: 'image', data: '', mimeType: 'image/png' }] } } as ReceiptRowProps} />)
    expand()
    expect(document.querySelector('pre')?.textContent).toContain('image/png')
  })

  it('shows a call still open as running', () => {
    render(<ReceiptRow {...{ phase: 'start', block: { argsRaw: '{}' }, callId: 'r', toolName: 'casper_receipt', openFile: vi.fn(), t } as ReceiptRowProps} />)
    expect(screen.getAllByText('Writing the receipt').length).toBeGreaterThan(0)
    expect(document.querySelector('[data-tool="casper_receipt"]')?.getAttribute('data-state')).toBe('running')
  })

  it('is registered as the casper_receipt tool view with its dictionaries in every language', () => {
    const register = vi.fn((_options: Record<string, unknown>, _component: unknown) => () => {})
    const slots = { inject: vi.fn((_name: string, mount: () => () => void) => mount()), register }
    const locale = { register: vi.fn(() => () => {}), bind: vi.fn(() => vi.fn()) }
    const uiConversation = { events: { register: vi.fn(() => () => {}) }, views: { register: vi.fn(() => () => {}) } }
    apply({ slots, effect: (run: () => unknown) => run(), locale, uiConversation })
    expect(locale.register).toHaveBeenCalledWith(NS, { zh, en, ja, es, fr, de, ru, pt })
    expect(register.mock.calls.map(([options, component]) => [options, component])).toContainEqual([{ name: 'tool.call.toolview', key: 'casper_receipt', locale: NS }, ReceiptRow])
    for (const dictionary of [zh, ja, es, fr, de, ru, pt]) expect(Object.keys(dictionary)).toEqual(Object.keys(en))
  })
})
