import { describe, expect, it } from 'vitest'
import { accessModeFor, checkAccessModes, DEFAULT_ACCESS_MODES } from '../src/access.ts'
import { Config } from '../src/config.ts'

describe('the access chip as a Casper mode', () => {
  it('maps the Desktop presets to Read only, Ask first, and Full access', () => {
    expect(accessModeFor('read-only', 'read-only', DEFAULT_ACCESS_MODES)).toBe('read')
    expect(accessModeFor('workspace-write', 'workspace-write', DEFAULT_ACCESS_MODES)).toBe('ask')
    expect(accessModeFor('danger-full-access', 'danger-full-access', DEFAULT_ACCESS_MODES)).toBe('full')
  })

  it('maps custom by its sandbox, and Auto and an unlisted preset to ask, never to full', () => {
    expect(accessModeFor('custom', 'read-only', DEFAULT_ACCESS_MODES)).toBe('read')
    expect(accessModeFor('custom', 'danger-full-access', DEFAULT_ACCESS_MODES)).toBe('ask')
    expect(accessModeFor('custom', undefined, DEFAULT_ACCESS_MODES)).toBe('ask')
    expect(accessModeFor('auto', 'danger-full-access', { ...DEFAULT_ACCESS_MODES, auto: 'full' })).toBe('ask')
    expect(accessModeFor('team-preset', 'danger-full-access', DEFAULT_ACCESS_MODES)).toBe('ask')
  })

  it('keeps a read-only sandbox read only whatever the table says', () => {
    expect(accessModeFor('locked', 'read-only', { locked: 'full' })).toBe('read')
    expect(accessModeFor('team-preset', 'workspace-write', { 'team-preset': 'read' })).toBe('read')
  })

  it('defaults the table to the Desktop presets and refuses one that names custom or auto', () => {
    expect(Config({} as never).accessModes).toEqual(DEFAULT_ACCESS_MODES)
    expect(() => Config({ accessModes: { 'read-only': 'none' } } as never)).toThrow()
    expect(() => { checkAccessModes(DEFAULT_ACCESS_MODES) }).not.toThrow()
    expect(() => { checkAccessModes({ auto: 'full' }) }).toThrow('casper-agent: accessModes cannot name "auto"; it always maps to ask or read')
    expect(() => { checkAccessModes({ custom: 'ask' }) }).toThrow('accessModes cannot name "custom"')
  })
})
