/**
 * The marks of Casper's approval boxes that the Host half sets and the
 * Client card reads, and the diff lines both halves write the same way. No
 * imports, so both halves can inline it.
 * @module @deepseek-ai/dsh-casper-agent/box
 */

/** The question id every Casper approval uses. */
export const PERMISSION_QUESTION_ID = 'casper-permission'

/** The header that marks a box for Casper's approval card; a plan review keeps its own. */
export const CASPER_BOX_HEADER = 'Casper'

/** The most options Casper's card shows; a box with more is left to the generic question card. */
export const MAX_CARD_OPTIONS = 4

/** The most diff lines a box's detail shows; the rest are counted and stay in the edit step. */
export const MAX_DIFF_LINES = 120

/** One file change a box carries from the edit step that raised it. */
export interface BoxDiff {
  /** The file's path. */
  readonly path: string
  /** The text before the change; none for a new file or an insertion. */
  readonly oldText?: string | null | undefined
  /** The text after the change. */
  readonly newText: string
}

/**
 * Write a box's diffs as plain lines: each file's path, then its old lines as
 * `- ` and its new lines as `+ `. At most {@link MAX_DIFF_LINES} lines are
 * shown; a last line counts the rest, which the edit step shows.
 * @param diffs - the box's file changes, in Casper's order.
 * @returns the lines, or undefined when there is no diff.
 */
export function diffLines(diffs: readonly BoxDiff[]): string | undefined {
  const lines: string[] = []
  for (const diff of diffs) {
    lines.push(diff.path, ...linesOf(diff.oldText).map(line => `- ${line}`), ...linesOf(diff.newText).map(line => `+ ${line}`))
  }
  if (lines.length === 0) return undefined
  if (lines.length <= MAX_DIFF_LINES) return lines.join('\n')
  const more = lines.length - MAX_DIFF_LINES
  return [...lines.slice(0, MAX_DIFF_LINES), `… ${String(more)} more ${more === 1 ? 'line' : 'lines'} in the edit step`].join('\n')
}

/** A diff side's lines, without the empty line a final newline leaves; none for an absent or empty side. */
function linesOf(text: string | null | undefined): string[] {
  if (text === undefined || text === null || text === '') return []
  return text.replace(/\r?\n$/, '').split(/\r?\n/)
}
