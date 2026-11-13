/**
 * Casper's checks as their own Conversation target. Every `casper_check` call
 * and its result are claimed on the Chat target, so the Chat shows no check
 * row and a check Casper runs after its answer leaves the answer the Turn's
 * last row. The `casper-checks` target lists the same calls for the Checks
 * view.
 * @module @deepseek-ai/dsh-casper-agent/client/check-calls
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ConversationNodeContext, ConversationNodeDefinition, ConversationViewBuilder, ConversationViewDefinition,
  ConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { resultText } from './receipt-turn.ts'

/** The tool name the turn writer gives a Casper check. */
export const CASPER_CHECK = 'casper_check'

/** The Conversation target, and the `conversation.view` entry id, of the Checks view. */
export const CHECKS_TARGET = 'casper-checks'

/** One check as the Checks view shows it. */
export interface CasperCheck {
  /** The check call's id, for its Inspect link. */
  readonly callId: string
  readonly turn: number
  /** The call's seq, which orders checks within the Session. */
  readonly seq: number
  /** The check's title as Casper sent it; empty when its arguments do not parse. */
  readonly title: string
  /** `running` until the call's result is loaded. */
  readonly status: 'running' | 'passed' | 'failed'
  /** The result's text; empty while running. */
  readonly output: string
}

/** Snapshot of the Checks target: every loaded check, in Session order. */
export interface CasperChecksSnapshot {
  readonly checks: readonly CasperCheck[]
}

/** A materialized check on the Checks target. */
export interface CasperCheckViewNode extends ConversationViewNode {
  readonly target: typeof CHECKS_TARGET
  readonly data: CasperCheck
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationViewSnapshotMap {
    /** Casper's checks for the Checks view. */
    'casper-checks': CasperChecksSnapshot
  }
}

/**
 * Ids of the `casper_check` calls already dispatched. A `tool/result` carries
 * no tool name, so a check's result is recognized by its call's id. Call ids
 * carry the Casper connection's epoch, so ids from different Sessions do not
 * meet. An id stays after its Session closes: one short string per check.
 */
const checkCalls = new Set<string>()

/**
 * Match one check event for a Definition.
 * @param event - the dispatched Session event.
 * @param exclusive - whether the match claims the event on its target.
 * @returns the call's identity, or null for any other event.
 */
function matchCheck(event: SessionEventLike, exclusive: boolean) {
  const claim = exclusive ? { exclusive: true as const } : {}
  if (event.type === 'tool/call') {
    if (event.data.name !== CASPER_CHECK) return null
    checkCalls.add(String(event.data.callId))
    return { id: String(event.data.callId), role: 'start' as const, ...claim }
  }
  if (event.type === 'tool/result' && event.surfaceOp === 'append') {
    const callId = String(event.data.message.source.callId)
    return checkCalls.has(callId) ? { id: callId, role: 'update' as const, ...claim } : null
  }
  return null
}

/**
 * The check's title from its call's arguments.
 * @param args - the call's JSON arguments.
 * @returns the `title` field, or empty when the arguments do not parse or carry none.
 */
export function checkTitle(args: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch (error: unknown) {
    // Arguments are recorded as Casper sent them; a value that is not JSON shows no title.
    void error
    return ''
  }
  return typeof parsed === 'object' && parsed !== null && 'title' in parsed && typeof parsed.title === 'string'
    ? parsed.title
    : ''
}

/** State of a started check Context; the check itself is read from its matches. */
const STARTED = Object.freeze({})

function checkOf(context: ConversationNodeContext<object>): CasperCheck | undefined {
  const call = context.matches.find(match => match.event.type === 'tool/call')?.event
  if (call?.type !== 'tool/call') return undefined
  const result = context.matches.findLast(match => match.event.type === 'tool/result')?.event
  const settled = result?.type === 'tool/result' ? result.data.message : undefined
  return {
    callId: String(call.data.callId),
    turn: call.data.turn,
    seq: call.seq,
    title: checkTitle(call.data.arguments),
    status: settled === undefined ? 'running' : settled.isError === true ? 'failed' : 'passed',
    output: settled === undefined ? '' : resultText(settled.content),
  }
}

/** Claims each check call and its result on the Chat target and shows no Chat row for them. */
export const checkChatDefinition: ConversationNodeDefinition<object> = {
  kind: 'casper-check-chat',
  target: 'chat',
  match: event => matchCheck(event, true),
  start: () => STARTED,
  update: context => context.state,
  // The Checks view shows the call: the claimed call shows no Chat row.
  buildViewNode: () => null,
}

/** Publishes each check call, with its result once loaded, on the Checks target. */
export const checkViewDefinition: ConversationNodeDefinition<object> = {
  kind: 'casper-check',
  target: CHECKS_TARGET,
  match: event => matchCheck(event, false),
  start: () => STARTED,
  update: context => context.state,
  buildViewNode: (context): CasperCheckViewNode | null => {
    const data = checkOf(context)
    return data === undefined ? null : { key: context.key, kind: context.kind, id: context.id, target: CHECKS_TARGET, data }
  },
}

const NO_CHECKS: readonly CasperCheck[] = []

/** Stable snapshot before a Session has any check. */
export const EMPTY_CHECKS_SNAPSHOT: CasperChecksSnapshot = { checks: NO_CHECKS }

class ChecksSnapshotBuilder implements ConversationViewBuilder<CasperCheckViewNode, CasperChecksSnapshot> {
  private readonly nodes = new Map<string, CasperCheck>()
  private current = EMPTY_CHECKS_SNAPSHOT
  readonly empty = EMPTY_CHECKS_SNAPSHOT

  replace(input: { readonly nodes: readonly CasperCheckViewNode[] }): CasperChecksSnapshot {
    this.nodes.clear()
    for (const node of input.nodes) this.nodes.set(node.key, node.data)
    return this.snapshot()
  }

  apply(input: { readonly upserts: readonly CasperCheckViewNode[] }): CasperChecksSnapshot {
    if (input.upserts.length === 0) return this.current
    for (const node of input.upserts) this.nodes.set(node.key, node.data)
    return this.snapshot()
  }

  private snapshot(): CasperChecksSnapshot {
    this.current = { checks: [...this.nodes.values()].sort((left, right) => left.seq - right.seq) }
    return this.current
  }
}

/** The Checks target's builder. */
export const checksViewDefinition: ConversationViewDefinition<CasperCheckViewNode, CasperChecksSnapshot> = {
  target: CHECKS_TARGET,
  create: () => new ChecksSnapshotBuilder(),
}

/**
 * Register the check Definitions and the Checks target. Each registration
 * rides the caller's effect, so unloading the plugin removes them.
 * @param ctx - Client root context.
 */
export function registerCheckCalls(ctx: Context): void {
  const chat = checkChatDefinition.match.bind(checkChatDefinition)
  ctx.effect(() => ctx.uiConversation.events.register({
    ...checkChatDefinition,
    match: { 'tool/call': chat, 'tool/result': chat },
  }), 'casper-agent: check claim')
  const view = checkViewDefinition.match.bind(checkViewDefinition)
  ctx.effect(() => ctx.uiConversation.events.register({
    ...checkViewDefinition,
    match: { 'tool/call': view, 'tool/result': view },
  }), 'casper-agent: check view definition')
  ctx.effect(() => ctx.uiConversation.views.register(checksViewDefinition), 'casper-agent: checks target')
}
