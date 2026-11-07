/**
 * The marks of Casper's approval boxes that the Host half sets and the
 * Client card reads. No imports, so both halves can inline it.
 * @module @deepseek-ai/dsh-casper-agent/box
 */

/** The question id every Casper approval uses. */
export const PERMISSION_QUESTION_ID = 'casper-permission'

/** The header that marks a box for Casper's approval card; a plan review keeps its own. */
export const CASPER_BOX_HEADER = 'Casper'

/** The most options Casper's card shows; a box with more is left to the generic question card. */
export const MAX_CARD_OPTIONS = 4
