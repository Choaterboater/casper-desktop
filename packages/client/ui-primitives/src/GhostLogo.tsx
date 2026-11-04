import type { IconProps } from './icons/props.ts'

/** Native viewBox of {@link GHOST_LOGO_PATH} (width and height in user units). */
export const GHOST_LOGO_VIEWBOX = { width: 24, height: 24 }

/** The ghost silhouette path data, exported for consumers that compose their own svg around the same geometry. */
export const GHOST_LOGO_PATH = 'M12 2C7.9 2 5 5.1 5 9.2V21c0 .8.9 1.2 1.5.7l1.6-1.3 1.6 1.3c.4.3 1 .3 1.4 0l1.9-1.6 1.9 1.6c.4.3 1 .3 1.4 0l1.6-1.3 1.6 1.3c.6.5 1.5.1 1.5-.7V9.2C19 5.1 16.1 2 12 2zM10 8.5a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6zM14 8.5a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6z'

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
