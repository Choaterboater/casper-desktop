/**
 * What a turn's mutation tool calls changed, read from their arguments. File tools name their
 * paths; a shell command or an unrecognised tool may change anything, so its change is unknown.
 * @module @deepseek-ai/dsh-casper-checks/changes
 */

import { basename } from 'node:path'

/** The files one turn's mutation tool calls changed. `unknown` means some call could change any file. */
export interface TurnChanges {
  paths: Set<string>
  unknown: boolean
}

const PATCH_PATH = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gmu
const PROSE = /\.(?:md|mdx|txt|rst|adoc)$/iu
/** Text files a build or installer reads, so changing them can break a check. */
const BUILD_INPUT = /^(?:requirements.*|constraints.*|CMakeLists|runtime)\.txt$/iu

function stringField(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Whether a call of a mutating tool may have changed files. A `str_replace_editor` `view` reads only.
 * @param name - the tool name.
 * @param args - the call's parsed arguments.
 * @returns false only for a call known not to write.
 */
export function mayMutate(name: string, args: unknown): boolean {
  return !(name === 'str_replace_editor' && stringField(args, 'command') === 'view')
}

/**
 * Add one mutation call's changes.
 * @param changes - the turn's changes so far, updated in place.
 * @param name - the tool name.
 * @param args - the call's parsed arguments.
 */
export function addChange(changes: TurnChanges, name: string, args: unknown): void {
  const named = name === 'write' || name === 'edit' ? stringField(args, 'file_path')
    : name === 'str_replace_editor' ? stringField(args, 'path')
      : undefined
  if (named !== undefined) {
    changes.paths.add(named)
    return
  }
  const patch = name === 'apply_patch' ? stringField(args, 'input') : undefined
  const patched = patch === undefined ? [] : [...patch.matchAll(PATCH_PATH)].map(match => String(match[1]).trim())
  if (patched.length === 0) {
    changes.unknown = true
    return
  }
  for (const path of patched) changes.paths.add(path)
}

/**
 * Whether a path is prose no check reads: Markdown and text documents, except text files builds read.
 * @param path - the changed path.
 * @returns true for documentation.
 */
export function isDocumentation(path: string): boolean {
  const name = basename(path)
  if (!PROSE.test(name) || BUILD_INPUT.test(name)) return false
  return !/(?:^|[\\/])requirements[\\/]/u.test(path)
}

/**
 * Whether a turn changed only documentation, so its project checks can be skipped.
 * @param changes - the turn's changes.
 * @returns true when every change is a known documentation path.
 */
export function onlyDocumentation(changes: TurnChanges): boolean {
  return !changes.unknown && changes.paths.size > 0 && [...changes.paths].every(isDocumentation)
}

const SANDBOX_DENIAL = [
  /\bEPERM\b/u,
  /Operation not permitted/u,
  /bootstrap_check_in .*Permission denied \(1100\)/u,
]

/**
 * Whether a failed check's output shows the sandbox refused something, rather than a bug in the code.
 * @param output - the check's retained output.
 * @returns true when a sandbox denial appears in it.
 */
export function blockedBySandbox(output: string): boolean {
  return SANDBOX_DENIAL.some(pattern => pattern.test(output))
}
