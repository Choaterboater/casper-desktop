import { describe, expect, it } from 'vitest'
import type { SessionConfigOption, SessionConfigSelectGroup } from '@agentclientprotocol/sdk'
import { effortState, reportOf, valueOf, withCurrent } from '../src/models.ts'
import { casperOptions } from './support.ts'

const EFFORTS = [
  { id: 'auto', name: 'Auto', description: 'classify each request' },
  { id: 'low', name: 'Low', description: 'light reasoning' },
  { id: 'medium', name: 'Medium', description: 'ordinary changes' },
  { id: 'high', name: 'High', description: 'harder changes' },
]

describe('Casper model options', () => {
  it('groups Casper\'s models by provider in its order, with each model\'s efforts and the current model and effort', () => {
    expect(reportOf(casperOptions('claude-subscription/claude-opus-5-5', 'high'))).toEqual({
      groups: [
        { id: 'openai-codex', name: 'openai-codex', models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', reasoning: { efforts: EFFORTS, defaultEffort: 'auto' } }] },
        { id: 'claude-subscription', name: 'Claude Code plan', models: [
          { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', reasoning: { efforts: [EFFORTS[0], EFFORTS[1], EFFORTS[3]], defaultEffort: 'auto' } },
          { id: 'vendor/small:free', name: 'Small', description: 'Sign in again to use this model' },
        ] },
      ],
      current: { provider: 'claude-subscription', model: 'claude-opus-5-5', reasoningEffort: 'high' },
      started: true,
    })
  })

  it('leaves out an effort the current model does not take, and reads a seeded list as not started', () => {
    expect(reportOf(casperOptions('claude-subscription/claude-opus-5-5', 'medium'), false)).toMatchObject({
      current: { provider: 'claude-subscription', model: 'claude-opus-5-5' }, started: false,
    })
    expect(reportOf(casperOptions('claude-subscription/vendor/small:free')).current).toEqual({ provider: 'claude-subscription', model: 'vendor/small:free' })
  })

  it('gives an older Casper\'s current model the effort option\'s values, and no model or effort without options', () => {
    // The fixture's model option holds only groups.
    const older = casperOptions().map((option): SessionConfigOption => option.id !== 'model' || option.type !== 'select' ? option : {
      ...option,
      options: (option.options as SessionConfigSelectGroup[])
        .map(group => ({ ...group, options: group.options.map(({ _meta: _, ...rest }) => rest) })),
    })
    const report = reportOf(older)
    expect(report.groups[0]?.models[0]?.reasoning?.efforts).toEqual(EFFORTS)
    expect(report.groups[1]?.models[0]?.reasoning).toBeUndefined()
    expect(report.current).toEqual({ provider: 'openai-codex', model: 'gpt-6.1-sol', reasoningEffort: 'auto' })
    expect(reportOf(undefined)).toEqual({ groups: [], current: null, started: true })
    expect(reportOf([{ id: 'verbose', name: 'Verbose', type: 'boolean', currentValue: true }])).toEqual({ groups: [], current: null, started: true })
  })

  it('splits ungrouped values at the first slash, names effort values the effort option does not list, and ignores a grouped effort option\'s groups', () => {
    const flat: SessionConfigOption[] = [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'local', options: [
        { value: 'openrouter/vendor/model', name: 'Routed', description: null, _meta: { casper: { efforts: ['xhigh', 7] } } },
        { value: 'local', name: 'Local', _meta: { casper: { efforts: ['low'] } } },
      ] },
      { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [
        { group: 'levels', name: 'Levels', options: [{ value: 'low', name: 'Low' }] },
      ] },
    ]
    expect(reportOf(flat)).toEqual({
      groups: [
        { id: 'openrouter', name: 'openrouter', models: [{ id: 'vendor/model', name: 'Routed', reasoning: { efforts: [{ id: 'xhigh', name: 'xhigh' }] } }] },
        { id: 'casper', name: 'casper', models: [{ id: 'local', name: 'Local', reasoning: { efforts: [{ id: 'low', name: 'Low' }] } }] },
      ],
      current: { provider: 'casper', model: 'local', reasoningEffort: 'low' },
      started: true,
    })
    expect(valueOf(flat, { provider: 'openrouter', model: 'vendor/model' })).toBe('openrouter/vendor/model')
    expect(effortState(flat)).toEqual({ current: 'low', values: ['low'] })
  })

  it('keeps a grouped value without its group prefix as the model id, and reads a grouped effort option for an older Casper', () => {
    const options: SessionConfigOption[] = [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'sol', options: [
        { group: 'openai-codex', name: 'Codex', options: [{ value: 'sol', name: 'Sol' }] },
      ] },
      { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [
        { group: 'levels', name: 'Levels', options: [{ value: 'auto', name: 'Auto' }, { value: 'high', name: 'High' }] },
      ] },
    ]
    expect(reportOf(options)).toEqual({
      groups: [{ id: 'openai-codex', name: 'Codex', models: [
        { id: 'sol', name: 'Sol', reasoning: { efforts: [{ id: 'auto', name: 'Auto' }, { id: 'high', name: 'High' }], defaultEffort: 'auto' } },
      ] }],
      current: { provider: 'openai-codex', model: 'sol', reasoningEffort: 'high' },
      started: true,
    })
    expect(valueOf(options, { provider: 'openai-codex', model: 'sol' })).toBe('sol')
  })

  it('finds the exact value to send for a selection', () => {
    expect(valueOf(casperOptions(), { provider: 'claude-subscription', model: 'vendor/small:free' })).toBe('claude-subscription/vendor/small:free')
    expect(valueOf(casperOptions(), { provider: 'openai-codex', model: 'claude-opus-5-5' })).toBeUndefined()
    expect(valueOf(undefined, { provider: 'openai-codex', model: 'gpt-6.1-sol' })).toBeUndefined()
  })

  it('reads the effort option\'s current value and values', () => {
    expect(effortState(casperOptions(undefined, 'low'))).toEqual({ current: 'low', values: ['auto', 'low', 'medium', 'high'] })
    expect(effortState(casperOptions().filter(option => option.id !== 'effort'))).toBeUndefined()
  })

  it('puts a start value in a seeded list as its current model', () => {
    const cached = reportOf(casperOptions(), false)
    expect(withCurrent(cached, 'claude-subscription/vendor/small:free').current).toEqual({ provider: 'claude-subscription', model: 'vendor/small:free' })
    expect(withCurrent({ groups: [], current: null, started: false }, 'openrouter/vendor/model').current).toEqual({ provider: 'openrouter', model: 'vendor/model' })
    expect(withCurrent(cached, 'sol')).toBe(cached)
    expect(withCurrent(cached, 'openai-codex/')).toBe(cached)
  })
})
