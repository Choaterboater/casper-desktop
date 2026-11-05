import type { IconProps } from './icons/props.ts'

/** Native viewBox of {@link GHOST_LOGO_PATH} (width and height in user units). */
export const GHOST_LOGO_VIEWBOX = { width: 24, height: 24 }

/** The ghost silhouette path data, exported for consumers that compose their own svg around the same geometry. */
export const GHOST_LOGO_PATH = 'M3 11.1a9 9 0 0 1 18 0v10.8l-2.25-1.8-2.25 1.8-2.25-1.8-2.25 1.8-2.25-1.8-2.25 1.8-2.25-1.8-2.25 1.8zM7.275 10.65a1.575 2.025 0 1 0 3.15 0 1.575 2.025 0 1 0-3.15 0zM13.575 10.65a1.575 2.025 0 1 0 3.15 0 1.575 2.025 0 1 0-3.15 0z'

/**
 * Render the Casper ghost mark.
 * @param props.size - width in px (default 24; the mark is square).
 * @param props.className - extra class for layout placement.
 * @returns the ghost logo svg (aria-hidden; pair with the wordmark for accessibility).
 */
export function GhostLogo({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox={`0 0 ${GHOST_LOGO_VIEWBOX.width} ${GHOST_LOGO_VIEWBOX.height}`}
      fill="none"
      aria-hidden="true"
    >
      <path d={GHOST_LOGO_PATH} fill="currentColor" fillRule="evenodd" clipRule="evenodd" />
    </svg>
  )
}
