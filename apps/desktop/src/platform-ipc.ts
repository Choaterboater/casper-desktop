/** Shared names and IPC input decoding for the desktop Platform bridge. */
/** Private desktop channels; the Platform renderer receives bootstrap and locale updates. */
export const PLATFORM_IPC = {
  bootstrap: 'dsh-platform:bootstrap',
  localeChanged: 'dsh-platform:locale-changed',
  open: 'dsh-platform:open',
  bounds: 'dsh-platform:bounds',
  close: 'dsh-platform:close',
} as const

/** Resolved Platform language; Desktop resolves the system preference before sending it. */
export type PlatformLocale = 'en_US' | 'zh_CN'

/** Bounds in desktop content coordinates, supplied by the owned application renderer. */
export interface PlatformBounds { x: number; y: number; width: number; height: number }

/**
 * Decode the renderer rectangle before allocating a native view.
 * @param value - IPC payload.
 * @returns finite, nonnegative integer coordinates.
 */
export function platformBounds(value: unknown): PlatformBounds {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid Platform bounds')
  const row = value as Record<string, unknown>
  const result: PlatformBounds = { x: 0, y: 0, width: 0, height: 0 }
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const n = row[key]
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100_000) throw new Error('Invalid Platform bounds')
    result[key] = Math.round(n)
  }
  return result
}
