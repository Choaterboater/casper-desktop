/**
 * Maps the app's permission preset (the access chip) to Casper's access mode.
 * @module @deepseek-ai/dsh-casper-agent/access
 */

import { AUTO_PRESET, CUSTOM_PRESET } from '@deepseek-ai/dsh-permission-presets'
import type { PresetSpec } from '@deepseek-ai/dsh-permission-presets'

/** Casper's access modes over ACP: Read only, Ask first, and Don't ask (`/permissions all`). */
export type AccessModeId = 'read' | 'ask' | 'full'

/** Every {@link AccessModeId}, strictest first. */
export const ACCESS_MODE_IDS: readonly AccessModeId[] = ['read', 'ask', 'full']

/** The default preset-to-mode table: the Desktop profile's three presets. */
export const DEFAULT_ACCESS_MODES: Readonly<Record<string, AccessModeId>> = {
  'read-only': 'read',
  'workspace-write': 'ask',
  'danger-full-access': 'full',
}

/** Words for each mode in the turn's notes and errors. */
export const ACCESS_MODE_LABELS: Readonly<Record<AccessModeId, string>> = {
  read: 'Read only',
  ask: 'Ask first',
  full: 'Full access',
}

/**
 * The Casper mode for the app's current preset. A read-only sandbox is always
 * `read`, whatever the table says. The derived `custom` preset and the Auto
 * review preset are `ask`, never `full`; so is a preset the table does not list.
 * @param preset - the preset the chip shows, `custom` when the knobs match none.
 * @param sandbox - the Session's sandbox mode, when known.
 * @param map - the configured preset-to-mode table.
 * @returns the mode Casper should be in.
 */
export function accessModeFor(preset: string, sandbox: PresetSpec['sandbox'] | undefined, map: Readonly<Record<string, AccessModeId>>): AccessModeId {
  if (sandbox === 'read-only') return 'read'
  if (preset === CUSTOM_PRESET || preset === AUTO_PRESET) return 'ask'
  return map[preset] ?? 'ask'
}

/**
 * Refuse a table that names a derived preset, which the chip cannot pick.
 * @param map - the configured preset-to-mode table.
 * @throws Error when the table names `custom` or `auto`.
 */
export function checkAccessModes(map: Readonly<Record<string, AccessModeId>>): void {
  for (const name of [CUSTOM_PRESET, AUTO_PRESET]) {
    if (Object.hasOwn(map, name)) throw new Error(`casper-agent: accessModes cannot name "${name}"; it always maps to ask or read`)
  }
}
