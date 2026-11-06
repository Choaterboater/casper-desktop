/**
 * Validated deployment choices for the Casper Agent driver.
 * @module @deepseek-ai/dsh-casper-agent/config
 */

import z from '@deepseek-ai/schemastery'

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
  /** Limit for `initialize` plus `session/new` or `session/load` on a fresh process. */
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
}

/** Runtime schema for {@link Config}; the defaults keep teardown inside a 10 s host shutdown window. */
export const Config: z<Config> = z.object({
  presets: z.array(z.string().min(1)).default(['casper']),
  command: z.string().min(1).default('casper'),
  args: z.array(z.string()).default(['acp']),
  model: z.string().min(1),
  effort: z.string().min(1),
  env: z.dict(z.string()).default({}),
  startTimeoutMs: z.natural().min(1).default(30_000),
  cancelGraceMs: z.natural().min(1).default(5_000),
  exitGraceMs: z.natural().min(1).default(2_500),
  killGraceMs: z.natural().min(1).default(5_000),
  stderrTailBytes: z.natural().min(1).default(4_096),
  appTools: z.boolean().default(true),
})
