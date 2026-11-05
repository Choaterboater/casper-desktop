import type { IconProps } from './icons/props.ts'

/** Native viewBox of {@link GHOST_LOGO_PATH} (width and height in user units). */
export const GHOST_LOGO_VIEWBOX = { width: 24, height: 24 }

/** The single-colour ghost silhouette with its eyes cut out, for marks drawn in `currentColor` such as the wordmark. */
export const GHOST_LOGO_PATH = 'M3 11.1a9 9 0 0 1 18 0v10.8l-2.25-1.8-2.25 1.8-2.25-1.8-2.25 1.8-2.25-1.8-2.25 1.8-2.25-1.8-2.25 1.8zM7.275 10.65a1.575 2.025 0 1 0 3.15 0 1.575 2.025 0 1 0-3.15 0zM13.575 10.65a1.575 2.025 0 1 0 3.15 0 1.575 2.025 0 1 0-3.15 0z'

/* The website ghost (website/public/favicon.svg), drawn in its own colours so it reads on light and dark surfaces. */
const INK = { outline: '#0f766e', body: '#f4f7fb', eyes: '#1b2430', shine: '#fff', cheeks: '#5eead4' }
const BODY_PATH = 'M12 30a20 20 0 0 1 40 0v24l-5-4-5 4-5-4-5 4-5-4-5 4-5-4-5 4z'
/* The skirt with its points swapped; it keeps BODY_PATH's commands and number count, so `d` morphs between them. */
const BODY_WAVE_PATH = 'M12 30a20 20 0 0 1 40 0v24l-5 0-5-4-5 4-5-4-5 4-5-4-5 4-5 0z'

/** Props for {@link GhostLogo}. */
export interface GhostLogoProps extends IconProps {
  /** Ripple the skirt while true; the caller decides when motion is allowed. */
  wave?: boolean | undefined
}

/**
 * Render the Casper ghost mark in the website's colours.
 * @param props.size - width in px (default 24; the mark is square).
 * @param props.className - extra class for layout placement.
 * @param props.wave - ripple the skirt in a 1.6 s loop while true.
 * @returns the ghost logo svg (aria-hidden; pair with the wordmark for accessibility).
 */
export function GhostLogo({ size = 24, className, wave = false }: GhostLogoProps) {
  return (
    <svg width={size} height={size} className={className} viewBox="7 7 50 50" fill="none" aria-hidden="true">
      <path d={BODY_PATH} fill={INK.body} stroke={INK.outline} strokeWidth={3} strokeLinejoin="round">
        {wave && (
          <animate
            attributeName="d"
            values={`${BODY_PATH};${BODY_WAVE_PATH};${BODY_PATH}`}
            keyTimes="0;0.5;1"
            calcMode="spline"
            keySplines="0.45 0 0.55 1;0.45 0 0.55 1"
            dur="1.6s"
            repeatCount="indefinite"
          />
        )}
      </path>
      <ellipse cx="25" cy="29" rx="3.5" ry="4.5" fill={INK.eyes} />
      <ellipse cx="39" cy="29" rx="3.5" ry="4.5" fill={INK.eyes} />
      <circle cx="26.2" cy="27.4" r="1.2" fill={INK.shine} />
      <circle cx="40.2" cy="27.4" r="1.2" fill={INK.shine} />
      <path d="M28 37q4 3.5 8 0" stroke={INK.eyes} strokeWidth={2.4} strokeLinecap="round" />
      <circle cx="20" cy="35" r="2.4" fill={INK.cheeks} opacity={0.7} />
      <circle cx="44" cy="35" r="2.4" fill={INK.cheeks} opacity={0.7} />
    </svg>
  )
}
