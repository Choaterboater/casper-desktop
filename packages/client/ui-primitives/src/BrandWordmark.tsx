import { GHOST_LOGO_PATH } from './GhostLogo.tsx'
import type { IconProps } from './icons/props.ts'

/** The product name drawn as brand artwork; it is a proper name, never translated. */
const PRODUCT_NAME = 'Casper'

/** Display options for the official brand wordmark. */
export interface BrandWordmarkProps extends IconProps {
  /** Whether to include the leading ghost mark; defaults to true. */
  includeMark?: boolean | undefined
}

/**
 * Render the full brand wordmark.
 * @param props.size - height in px (default 24; width follows the selected artwork).
 * @param props.className - extra class for layout placement.
 * @param props.includeMark - whether to include the leading ghost mark.
 * @returns the wordmark svg (aria-hidden decorative brand art).
 */
export function BrandWordmark({ size = 24, className, includeMark = true }: BrandWordmarkProps) {
  const width = includeMark ? 182 : 156
  return (
    <svg
      width={(size * width) / 24}
      height={size}
      className={className}
      viewBox={includeMark ? '0 0 182 24' : '26 0 156 24'}
      fill="none"
      aria-hidden="true"
    >
      {includeMark ? <path d={GHOST_LOGO_PATH} fill="currentColor" fillRule="evenodd" clipRule="evenodd" /> : null}
      <text
        x="28"
        y="17.5"
        fill="currentColor"
        fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
        fontSize="16"
        fontWeight="600"
        letterSpacing="-0.2"
      >
        {PRODUCT_NAME}
      </text>
    </svg>
  )
}
