import { describe, expect, it } from 'vitest'
import type { AgentFactory } from '@deepseek-ai/dsh-agent'
import { casperRoute } from '../src/route.ts'

const factory = {} as AgentFactory

describe('casperRoute', () => {
  const route = casperRoute(['casper'], factory)

  it('selects root Sessions on a Casper preset', () => {
    expect(route.factory).toBe(factory)
    expect(route.selects({ agentPreset: 'casper' })).toBe(true)
    expect(route.selects({ agentPreset: 'casper', isSeeded: true })).toBe(true)
  })

  it('leaves other presets, unnamed presets, and delegated children to the default factory', () => {
    expect(route.selects({ agentPreset: 'standard' })).toBe(false)
    expect(route.selects({})).toBe(false)
    expect(route.selects({ agentPreset: 'casper', origin: 'subagent' })).toBe(false)
  })
})
