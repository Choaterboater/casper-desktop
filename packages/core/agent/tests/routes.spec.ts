import { unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory, AgentRouteFacts, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'

function stubAgent(rawId: string): Agent {
  const id = SessionId(rawId)
  return {
    id,
    options: {},
    session: Session.create(id),
    model: unsupportedModel(),
    inbox: { nextTurn: [], nextStep: [] } as never,
    status: 'idle',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function recordingFactory(label: string, log: string[]) {
  const owners: Context[] = []
  const factory: AgentFactory = {
    async createAgent(ownerCtx: Context, options: CreateAgentOptions) {
      owners.push(ownerCtx)
      log.push(`${label}:create:${options.sessionId}`)
      return { agent: stubAgent(options.sessionId), dispose: () => Promise.resolve() }
    },
    async resume(ownerCtx: Context, options: ResumeAgentOptions) {
      owners.push(ownerCtx)
      log.push(`${label}:resume:${options.resumeSessionId}`)
      return { agent: stubAgent(options.resumeSessionId), dispose: () => Promise.resolve() }
    },
  }
  return { factory, owners }
}

async function registry(): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  return ctx
}

describe('AgentRegistry routes', () => {
  it('routes create and resume by preset and falls back to the default factory', async () => {
    const ctx = await registry()
    const log: string[] = []
    const fallback = recordingFactory('default', log)
    const routed = recordingFactory('routed', log)
    ctx.agents.setFactory(fallback.factory)
    const seen: AgentRouteFacts[] = []
    ctx.agents.route({ factory: routed.factory, selects: (facts) => { seen.push(facts); return facts.agentPreset === 'x' } })

    const created = await ctx.agents.create({ sessionId: SessionId('a'), meta: { agentPreset: 'x' } })
    await ctx.agents.create({ sessionId: SessionId('b'), meta: { agentPreset: 'standard' } })
    await ctx.agents.create({ sessionId: SessionId('c') })
    const resumed = await ctx.agents.resume({ resumeSessionId: SessionId('d'), agentPreset: 'x' })
    await ctx.agents.resume({ resumeSessionId: SessionId('e') })

    expect(log).toEqual(['routed:create:a', 'default:create:b', 'default:create:c', 'routed:resume:d', 'default:resume:e'])
    expect(seen[0]).toEqual({ agentPreset: 'x', origin: undefined, isSeeded: undefined })
    expect(seen.at(-1)).toEqual({ agentPreset: undefined })
    expect(ctx.agents.servesRoute(created.agent, { agentPreset: 'x' })).toBe(true)
    expect(ctx.agents.servesRoute(created.agent, { agentPreset: 'standard' })).toBe(false)
    expect(ctx.agents.servesRoute(resumed.agent, { agentPreset: 'x' })).toBe(true)
    expect(ctx.agents.servesRoute(stubAgent('never-built'), { agentPreset: 'x' })).toBe(true)
  })

  it('passes origin and fork facts to the route', async () => {
    const ctx = await registry()
    const log: string[] = []
    ctx.agents.setFactory(recordingFactory('default', log).factory)
    ctx.agents.route({
      factory: recordingFactory('routed', log).factory,
      selects: facts => facts.agentPreset === 'x' && facts.origin !== 'subagent' && facts.isSeeded !== true,
    })
    await ctx.agents.create({ sessionId: SessionId('child'), meta: { agentPreset: 'x', origin: 'subagent' } })
    await ctx.agents.create({ sessionId: SessionId('fork'), meta: { agentPreset: 'x', isSeeded: true } })
    await ctx.agents.create({ sessionId: SessionId('root'), meta: { agentPreset: 'x' } })
    expect(log).toEqual(['default:create:child', 'default:create:fork', 'routed:create:root'])
  })

  it('falls back to the default once the route is disposed', async () => {
    const ctx = await registry()
    const log: string[] = []
    ctx.agents.setFactory(recordingFactory('default', log).factory)
    const dispose = ctx.agents.route({ factory: recordingFactory('routed', log).factory, selects: () => true })
    await ctx.agents.create({ sessionId: SessionId('before') })
    dispose()
    dispose()
    await ctx.agents.create({ sessionId: SessionId('after') })
    expect(log).toEqual(['routed:create:before', 'default:create:after'])
  })

  it('lets the first selecting route win', async () => {
    const ctx = await registry()
    const log: string[] = []
    ctx.agents.route({ factory: recordingFactory('first', log).factory, selects: facts => facts.agentPreset === 'x' })
    ctx.agents.route({ factory: recordingFactory('second', log).factory, selects: () => true })
    await ctx.agents.create({ sessionId: SessionId('a'), meta: { agentPreset: 'x' } })
    await ctx.agents.create({ sessionId: SessionId('b'), meta: { agentPreset: 'y' } })
    expect(log).toEqual(['first:create:a', 'second:create:b'])
  })

  it('compares routes with and without a default factory', async () => {
    const ctx = await registry()
    const log: string[] = []
    const routed = recordingFactory('routed', log)
    ctx.agents.route({ factory: routed.factory, selects: facts => facts.agentPreset === 'x' })
    expect(ctx.agents.sameRoute({ agentPreset: 'a' }, { agentPreset: 'b' })).toBe(true)
    expect(ctx.agents.sameRoute({ agentPreset: 'a' }, { agentPreset: 'x' })).toBe(false)
    await expect(ctx.agents.create({ sessionId: SessionId('none') })).rejects.toThrow(/no agent factory/)
    ctx.agents.setFactory(recordingFactory('default', log).factory)
    expect(ctx.agents.sameRoute({}, { agentPreset: 'standard' })).toBe(true)
    expect(ctx.agents.sameRoute({ agentPreset: 'x' }, { agentPreset: 'x' })).toBe(true)
    expect(ctx.agents.sameRoute({ agentPreset: 'x' }, {})).toBe(false)
  })

  it('passes the calling context to a plain-object route factory', async () => {
    const ctx = await registry()
    const routed = recordingFactory('routed', [])
    ctx.agents.route({ factory: routed.factory, selects: () => true })
    let callerFiber: Context['fiber'] | undefined
    await ctx.plugin(Object.assign(async (inner: Context) => {
      callerFiber = inner.fiber
      await inner.agents.create({ sessionId: SessionId('owned') })
    }, { inject: ['agents'] }))
    expect(routed.owners[0]?.fiber).toBe(callerFiber)
  })

  it('canonicalizes a traced Service route factory', async () => {
    const ctx = await registry()
    class RoutedFactory extends Service implements AgentFactory {
      constructor(inner: Context) {
        super(inner, 'routedFactory')
      }
      async createAgent(_ownerCtx: Context, options: CreateAgentOptions) {
        return { agent: stubAgent(options.sessionId), dispose: () => Promise.resolve() }
      }
      async resume(_ownerCtx: Context, options: ResumeAgentOptions) {
        return { agent: stubAgent(options.resumeSessionId), dispose: () => Promise.resolve() }
      }
    }
    await ctx.plugin(RoutedFactory)
    type Traced = Context & { routedFactory: RoutedFactory }
    // The same Service, read through two plugin contexts, is the default factory and serves preset x.
    await ctx.plugin(Object.assign((inner: Context) => {
      inner.agents.setFactory((inner as Traced).routedFactory)
    }, { inject: ['agents', 'routedFactory'] }))
    await ctx.plugin(Object.assign((inner: Context) => {
      inner.agents.route({ factory: (inner as Traced).routedFactory, selects: facts => facts.agentPreset === 'x' })
    }, { inject: ['agents', 'routedFactory'] }))
    expect(ctx.agents.sameRoute({ agentPreset: 'x' }, {})).toBe(true)
    const handle = await ctx.agents.create({ sessionId: SessionId('traced'), meta: { agentPreset: 'x' } })
    expect(ctx.agents.servesRoute(handle.agent, {})).toBe(true)
  })
})
