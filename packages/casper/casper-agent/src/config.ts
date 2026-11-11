/**
 * Validated deployment choices for the Casper Agent driver.
 * @module @deepseek-ai/dsh-casper-agent/config
 */

import z from '@deepseek-ai/schemastery'
import { ACCESS_MODE_IDS, DEFAULT_ACCESS_MODES } from './access.ts'
import type { AccessModeId } from './access.ts'

/** Deployment choices for driving Sessions through `casper acp`. */
export interface Config {
  /** Agent presets whose Sessions Casper drives; Sessions on any other preset keep the default factory. */
  presets: string[]
  /** Casper executable: an absolute path, or a bare name looked up on the child's PATH. */
  command: string
  /** Arguments that start Casper's ACP server. */
  args: string[]
  /** Start model passed as `--model` after `args`; unset keeps Casper's own default. The model picker changes it per Session. */
  model?: string
  /** Start effort passed as `--effort` after `args`; unset keeps Casper's own default. The model picker changes it per Session. */
  effort?: string
  /** Child environment entries merged after the subprocess scrub, so a listed key reaches Casper. */
  env: Record<string, string>
  /** Limit for `initialize` plus `session/new`, `session/load` or `session/fork` on a fresh process. */
  startTimeoutMs: number
  /** Wait for the prompt reply after `session/cancel` before the process is killed. */
  cancelGraceMs: number
  /** Wait for the process to exit after stdin closes before termination starts. */
  exitGraceMs: number
  /** Termination grace between SIGTERM and SIGKILL. */
  killGraceMs: number
  /** Bytes of Casper's stderr kept for start and exit failure messages. */
  stderrTailBytes: number
  /**
   * Offer Casper the app's plugin tools (Cordis inspection, the app's skills, file reads inside the app, and
   * plugin_manager) as one MCP server on a 127.0.0.1 listener for each Casper process; false offers none.
   */
  appTools: boolean
  /**
   * Serve Casper the app's subagent tools with the app tools: `subagent` starts a Standard agent as a child of the
   * Casper Session, and `send_message`, `interrupt_agent`, `list_agents` and `list_subagent_models` control it; false
   * leaves them out. Needs appTools.
   */
  appSubagents: boolean
  /**
   * Serve Casper the app's goal tools with the app tools (`get_goal`, `create_goal`, `update_goal`) and run the
   * rounds of a goal set with `/goal` or those tools as Casper turns; false leaves the tools out, and a round that
   * comes due is dropped, which pauses the goal. Needs appTools for the tools.
   */
  appGoals: boolean
  /**
   * Serve Casper the app's Team task-board tools with the app tools (`team_task_create`, `team_task_list`,
   * `team_task_get`, `team_task_update`), which work while the Session's Team switch is on; false leaves them out.
   * Teammates are the app's subagents, so it needs appTools, and appSubagents to start them.
   */
  appTeams: boolean
  /**
   * Run a child the app's subagent tool starts on Casper's current model when the app has a route with the same
   * provider and model id, keeping Casper's effort only when that model lists it; otherwise, and when false, the child
   * runs on the app's default model.
   */
  casperChildModel: boolean
  /**
   * Name the Session with the title Casper sends, made without a model call, unless the person renamed it; an older
   * Casper that sends none leaves the title of the opening words. false writes the title on the app's default model.
   */
  casperTitles: boolean
  /**
   * Start a fork of a Casper Session with Casper's own conversation copied up to the fork point (`session/fork`). When
   * Casper cannot copy it exactly, and with false, the fork starts a fresh Casper conversation and its first turn says so.
   */
  copyOnFork: boolean
  /**
   * The app's permission presets and the Casper access mode each sets: `read`, `ask`, or `full`. A preset the
   * table does not list, the derived `custom`, and Auto set `ask`; a read-only sandbox always sets `read`.
   */
  accessModes: Record<string, AccessModeId>
  /** Show Casper's boxes with Casper's approval card; off shows the generic question card. */
  approvalCard: boolean
  /** Draw the diff an edit's box carries in Casper's approval card; needs approvalCard. Off shows the diff as text lines. */
  approvalDiff: boolean
  /**
   * Hand Casper the enabled Settings > MCP servers, credentials resolved, when Casper takes HTTP servers; Casper
   * connects to them for the session and asks before their changes. A change reaches Casper at the next turn.
   */
  forwardMcpServers: boolean
  /**
   * Also hand Casper the servers plugins register with the MCP manager, after the Settings servers and within the
   * same 7; needs forwardMcpServers. A plugin that loads or unloads reaches Casper at the next turn.
   */
  forwardPluginMcpServers: boolean
  /**
   * Show the access mode Casper picks itself, such as "Yes to everything this session", as a pill next to the access
   * control until Casper's process closes; the control never moves. Off records none and clears one already shown.
   */
  modePill: boolean
  /**
   * Show each running Casper command's latest lines in the Jobs panel while it runs; Stop on that job stops the whole
   * request, as the composer's Stop does. Off: a command shows only its final output in its card.
   */
  liveOutput: boolean
  /**
   * Idle time after which the plugin asks Casper whether it may close the process (`_casper/idle`); a Casper that
   * says it is idle is closed and the next prompt reopens its conversation. 0 keeps the process until the Session closes.
   */
  idleExitMs: number
}

/** Runtime schema for {@link Config}; the defaults keep teardown inside a 10 s host shutdown window. */
export const Config: z<Config> = z.object({
  presets: z.array(z.string().min(1)).default(['casper']),
  command: z.string().min(1).default('casper'),
  args: z.array(z.string()).default(['acp']),
  model: z.string().min(1),
  effort: z.string().min(1),
  env: z.dict(z.string()).default({}),
  startTimeoutMs: z.natural().min(1).default(120_000),
  cancelGraceMs: z.natural().min(1).default(5_000),
  exitGraceMs: z.natural().min(1).default(2_500),
  killGraceMs: z.natural().min(1).default(5_000),
  stderrTailBytes: z.natural().min(1).default(4_096),
  appTools: z.boolean().default(true),
  appSubagents: z.boolean().default(true),
  appGoals: z.boolean().default(true),
  appTeams: z.boolean().default(true),
  casperChildModel: z.boolean().default(true),
  casperTitles: z.boolean().default(true),
  copyOnFork: z.boolean().default(true),
  accessModes: z.dict(z.union(ACCESS_MODE_IDS as AccessModeId[])).default({ ...DEFAULT_ACCESS_MODES }),
  approvalCard: z.boolean().default(true),
  approvalDiff: z.boolean().default(true),
  forwardMcpServers: z.boolean().default(true),
  forwardPluginMcpServers: z.boolean().default(true),
  modePill: z.boolean().default(true),
  liveOutput: z.boolean().default(true),
  idleExitMs: z.natural().default(900_000),
})
