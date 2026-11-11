import { describe, expect, it } from 'vitest'

import { addChange, blockedBySandbox, isDocumentation, mayMutate, onlyDocumentation } from '../src/changes.ts'
import type { TurnChanges } from '../src/changes.ts'
import { formatReceipt, receiptVerdict } from '../src/receipt.ts'
import type { ReceiptCheck, ReceiptInput } from '../src/receipt.ts'

const changed = (paths: string[], unknown = false): TurnChanges => ({ paths: new Set(paths), unknown })
const check = (name: string, partial: Partial<ReceiptCheck> = {}): ReceiptCheck => ({
  name, command: `npm run ${name}`, status: 'passed', exitCode: 0, reason: null, stale: false, ...partial,
})
const receipt = (partial: Partial<ReceiptInput>): ReceiptInput => ({
  checks: [], changes: changed(['src/a.ts']), repairs: 0, notChecked: '', documentationOnly: false, ...partial,
})

describe('turn changes', () => {
  it('reads changed paths from file tool arguments', () => {
    const changes = changed([])
    addChange(changes, 'write', { file_path: 'src/a.ts' })
    addChange(changes, 'edit', { file_path: 'README.md' })
    addChange(changes, 'str_replace_editor', { command: 'str_replace', path: 'src/b.ts' })
    addChange(changes, 'apply_patch', { input: '*** Begin Patch\n*** Update File: src/c.ts\n*** Move to: src/d.ts\n*** Add File: e.md\n*** Delete File: f.ts\n*** End Patch' })
    expect([...changes.paths].sort()).toEqual(['README.md', 'e.md', 'f.ts', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'])
    expect(changes.unknown).toBe(false)
  })

  it('marks a shell command, an unnamed edit or an unreadable patch as an unknown change', () => {
    for (const [name, args] of [['bash', { command: 'sed -i s/a/b/ x' }], ['edit', null], ['write', { file_path: '' }], ['apply_patch', { input: 'garbage' }], ['apply_patch', {}]] as const) {
      const changes = changed([])
      addChange(changes, name, args)
      expect(changes.unknown, name).toBe(true)
    }
  })

  it('counts a str_replace_editor view as a read', () => {
    expect(mayMutate('str_replace_editor', { command: 'view', path: 'a' })).toBe(false)
    expect(mayMutate('str_replace_editor', { command: 'create', path: 'a' })).toBe(true)
    expect(mayMutate('bash', 'not an object')).toBe(true)
  })

  it('treats prose as documentation but not the text files builds read', () => {
    expect(['README.md', 'guide/intro.mdx', 'NOTES.txt', 'a.rst', 'b.adoc'].every(isDocumentation)).toBe(true)
    expect(['requirements-dev.txt', 'constraints.txt', 'CMakeLists.txt', 'runtime.txt', 'requirements/base.txt', 'a.yaml', 'a.json', 'a.ts'].some(isDocumentation)).toBe(false)
  })

  it('skips checks only when every known change is documentation', () => {
    expect(onlyDocumentation(changed(['README.md']))).toBe(true)
    expect(onlyDocumentation(changed(['README.md', 'src/a.ts']))).toBe(false)
    expect(onlyDocumentation(changed(['README.md'], true))).toBe(false)
    expect(onlyDocumentation(changed([]))).toBe(false)
  })

  it('recognises sandbox denials in check output', () => {
    expect(blockedBySandbox('listen EPERM: operation not permitted 127.0.0.2:3000')).toBe(true)
    expect(blockedBySandbox('bind: Operation not permitted')).toBe(true)
    expect(blockedBySandbox('bootstrap_check_in org.chromium.Chromium: Permission denied (1100)')).toBe(true)
    expect(blockedBySandbox('expected 3, received 4')).toBe(false)
  })
})

describe('receipt', () => {
  it('is one line for a clean pass', () => {
    expect(formatReceipt(receipt({ checks: [check('lint'), check('test')], repairs: 1 })))
      .toBe('✓ Checks passed · lint passed · test passed · 1 file changed · after 1 repair')
    expect(formatReceipt(receipt({ checks: [check('test')], changes: changed(['a.ts', 'b.ts']) })))
      .toBe('✓ Checks passed · test passed · 2 files changed')
    expect(formatReceipt(receipt({ checks: [check('test')], changes: changed([], true) })))
      .toBe('✓ Checks passed · test passed · files changed through shell commands')
  })

  it('puts a failure first and lists every check and the changes', () => {
    const input = receipt({
      checks: [check('lint'), check('test', { status: 'failed', exitCode: 1 })],
      changes: changed(['d.ts', 'c.ts', 'b.ts', 'a.ts']),
      repairs: 3,
    })
    expect(receiptVerdict(input)).toBe('failed')
    expect(formatReceipt(input)).toBe([
      '✗ Failed: test failed · after 3 repairs',
      '✓ lint passed · npm run lint',
      '✗ test failed (exit 1) · npm run test',
      'Changed: 4 files (a.ts, b.ts, c.ts and 1 more)',
    ].join('\n'))
  })

  it('never counts a check that did not run, or a stale pass, as passed', () => {
    const input = receipt({
      checks: [
        check('test', { status: 'not_run', exitCode: 1, reason: 'sandbox_blocked' }),
        check('build', { status: 'not_run', exitCode: null, reason: 'could_not_start' }),
        check('lint', { stale: true }),
        check('typecheck', { status: 'failed', exitCode: 2, stale: true }),
      ],
      changes: changed(['a.ts'], true),
    })
    expect(receiptVerdict(input)).toBe('incomplete')
    expect(formatReceipt(input)).toBe([
      '– Incomplete: test, build, lint not proven',
      '– test could not check: blocked by the sandbox, not a bug in the code · npm run test',
      '– build could not check: could not start · npm run build',
      '✓ lint passed (stale: code changed after this run) · npm run lint',
      '✗ typecheck failed (exit 2) (stale: code changed after this run) · npm run typecheck',
      'Changed: 1 file (a.ts) and files through shell commands',
    ].join('\n'))
  })

  it('says why nothing was checked', () => {
    expect(formatReceipt(receipt({ notChecked: 'no checks found', changes: changed([], true) })))
      .toBe('– Not checked — no checks found\nChanged: files through shell commands (not listed)')
    expect(formatReceipt(receipt({ documentationOnly: true, changes: changed(['README.md', 'guide/a.md']) })))
      .toBe('– Checks skipped — only documentation changed (README.md, guide/a.md)')
  })
})
