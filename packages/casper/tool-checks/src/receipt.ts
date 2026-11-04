/**
 * The closing receipt of a turn that changed files: a verdict line, then one line per check that
 * did not pass and what changed. A clean pass is one line.
 * @module @deepseek-ai/dsh-casper-checks/receipt
 */

import type { TurnChanges } from './changes.ts'

/** Why a check produced no verdict. `sandbox_blocked` means the sandbox refused something the check needed. */
export type NotRunReason = 'timed_out' | 'signal' | 'could_not_start' | 'aborted' | 'sandbox_blocked'

/** Outcome of one check run. `not_run` is never a pass. */
export type CheckStatus = 'passed' | 'failed' | 'not_run'

/** One check as the receipt reports it. */
export interface ReceiptCheck {
  name: string
  command: string
  status: CheckStatus
  exitCode: number | null
  reason: NotRunReason | null
  stale: boolean
}

/** The receipt's overall verdict. */
export type ReceiptVerdict = 'passed' | 'failed' | 'incomplete' | 'not_checked' | 'skipped'

/** Everything one receipt states. */
export interface ReceiptInput {
  /** Checks Casper ran or reused for this turn, project checks first. */
  checks: ReceiptCheck[]
  changes: TurnChanges
  /** Repair rounds this turn used. */
  repairs: number
  /** Why no check ran, when `checks` is empty. */
  notChecked: string
  /** True when only documentation changed and the project checks were skipped for it. */
  documentationOnly: boolean
}

const LISTED_FILES = 3

/**
 * Decide the receipt's verdict. A stale or unrun check is never a pass.
 * @param input - the receipt's facts.
 * @returns the verdict.
 */
export function receiptVerdict(input: ReceiptInput): ReceiptVerdict {
  if (input.checks.length === 0) return input.documentationOnly ? 'skipped' : 'not_checked'
  if (input.checks.some(check => check.status === 'failed' && !check.stale)) return 'failed'
  if (input.checks.some(check => check.status !== 'passed' || check.stale)) return 'incomplete'
  return 'passed'
}

function checkLine(check: ReceiptCheck): string {
  const stale = check.stale ? ' (stale: code changed after this run)' : ''
  if (check.status === 'passed') return `✓ ${check.name} passed${stale} · ${check.command}`
  if (check.status === 'failed') return `✗ ${check.name} failed (exit ${String(check.exitCode)})${stale} · ${check.command}`
  const why = check.reason === 'sandbox_blocked'
    ? 'blocked by the sandbox, not a bug in the code'
    : String(check.reason).replaceAll('_', ' ')
  return `– ${check.name} could not check: ${why} · ${check.command}`
}

function fileList(paths: string[]): string {
  const shown = paths.slice(0, LISTED_FILES).join(', ')
  return paths.length > LISTED_FILES ? `${shown} and ${String(paths.length - LISTED_FILES)} more` : shown
}

function changedLine(changes: TurnChanges): string {
  const paths = [...changes.paths].sort()
  const count = `${String(paths.length)} file${paths.length === 1 ? '' : 's'}`
  if (!changes.unknown) return `Changed: ${count} (${fileList(paths)})`
  return paths.length === 0 ? 'Changed: files through shell commands (not listed)' : `Changed: ${count} (${fileList(paths)}) and files through shell commands`
}

/**
 * Render the receipt as plain text.
 * @param input - the receipt's facts.
 * @returns the receipt, verdict first.
 */
export function formatReceipt(input: ReceiptInput): string {
  const verdict = receiptVerdict(input)
  const repairs = input.repairs === 0 ? '' : ` · after ${String(input.repairs)} repair${input.repairs === 1 ? '' : 's'}`
  if (verdict === 'skipped') return `– Checks skipped — only documentation changed (${fileList([...input.changes.paths].sort())})`
  if (verdict === 'not_checked') return `– Not checked — ${input.notChecked}\n${changedLine(input.changes)}`
  if (verdict === 'passed') {
    const paths = input.changes.paths.size
    const changed = input.changes.unknown ? 'files changed through shell commands' : `${String(paths)} file${paths === 1 ? '' : 's'} changed`
    return `✓ Checks passed · ${input.checks.map(check => `${check.name} passed`).join(' · ')} · ${changed}${repairs}`
  }
  const failed = input.checks.filter(check => check.status === 'failed' && !check.stale).map(check => check.name)
  const unproven = input.checks.filter(check => check.status !== 'failed' && (check.status !== 'passed' || check.stale)).map(check => check.name)
  const head = verdict === 'failed'
    ? `✗ Failed: ${failed.join(', ')} failed${repairs}`
    : `– Incomplete: ${unproven.join(', ')} not proven${repairs}`
  return [head, ...input.checks.map(checkLine), changedLine(input.changes)].join('\n')
}
