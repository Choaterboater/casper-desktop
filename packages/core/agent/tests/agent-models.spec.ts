import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AGENT_MODELS_RECORD, agentModelsProjectionDefinition } from '@deepseek-ai/dsh-agent'
import type { AgentModelsReport } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import SessionStore, { appendPluginRecord, SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** The Casper agent's declaration, repeated for this package's tests. */
    'plugin:casper-agent/models': AgentModelsReport
  }
}

function report(session: Session, data: AgentModelsReport): void {
  appendPluginRecord(session, AGENT_MODELS_RECORD, data)
}

const REPORT: AgentModelsReport = {
  groups: [{
    id: 'alpha',
    name: 'Alpha',
    models: [
      { id: 'a1', name: 'A one', reasoning: { efforts: [{ id: 'auto', name: 'Auto' }, { id: 'high', name: 'High' }], defaultEffort: 'auto' } },
      { id: 'org/a2', name: 'A two', description: 'signed out' },
    ],
  }],
  current: { provider: 'alpha', model: 'a1', reasoningEffort: ReasoningEffortId('auto') },
  started: true,
}

async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const projection = await ctx.sessionProjections.register(agentModelsProjectionDefinition)
  const session = ctx.sessions.create(SessionId('agent-models'))
  const view = () => ctx.sessionProjections.snapshot(session).values.agentModels
  return { session, state: () => projection.stateOf(session), view }
}

describe('agentModels projection', () => {
  it('has no view and ignores selections until the Agent reports its models', async () => {
    const { session, state, view } = await harness()
    expect(view()).toBeNull()
    session.append('model/selection', { provider: 'alpha', model: 'a1' })
    expect(state()).toEqual({ reported: null, wanted: null })
    expect(view()).toBeNull()
  })

  it('shows a selection recorded after a report as current until the next report settles it', async () => {
    const { session, state, view } = await harness()
    report(session, REPORT)
    expect(view()).toEqual({ groups: REPORT.groups, current: REPORT.current, started: true })
    const wanted = { provider: 'alpha', model: 'org/a2' }
    session.append('model/selection', wanted)
    expect(view()).toEqual({ groups: REPORT.groups, current: wanted, started: true })
    const before = state()
    session.append('model/selection', wanted)
    expect(state()).toBe(before)
    report(session, { ...REPORT, current: wanted })
    expect(state()).toEqual({ reported: { ...REPORT, current: wanted }, wanted: null })
  })

  it('reports a list seeded before the Agent started, and an Agent with no models', async () => {
    const { session, view } = await harness()
    report(session, { groups: [], current: null, started: false })
    expect(view()).toEqual({ groups: [], current: null, started: false })
    report(session, { groups: [], current: null, started: true })
    expect(view()).toEqual({ groups: [], current: null, started: true })
  })

  it('skips a malformed record, a newer one with fields it does not know, and an unmarked event of the same name', async () => {
    const { session, state, view } = await harness()
    report(session, REPORT)
    const before = state()
    for (const bad of [{ groups: 'none', current: null, started: true }, { groups: REPORT.groups, current: REPORT.current }, { ...REPORT, next: 1 },
      { ...REPORT, groups: [{ ...REPORT.groups[0], extra: true }] }]) report(session, bad as never)
    expect(state()).toBe(before)
    const unmarked = { type: AGENT_MODELS_RECORD, seq: 9, time: 0, data: REPORT }
    expect(agentModelsProjectionDefinition.apply(before, unmarked as never)).toBe(before)
    expect(view()).toEqual({ groups: REPORT.groups, current: REPORT.current, started: true })
  })

  it('keeps its view out of Session summaries and validates its stored state', () => {
    expect(agentModelsProjectionDefinition.wire.summary).toBe(false)
    const state = { reported: REPORT, wanted: null }
    expect(agentModelsProjectionDefinition.stateSchema.parse(state)).toEqual(state)
    expect(() => agentModelsProjectionDefinition.stateSchema.parse({ reported: { groups: [], current: null }, wanted: null })).toThrow()
  })
})
