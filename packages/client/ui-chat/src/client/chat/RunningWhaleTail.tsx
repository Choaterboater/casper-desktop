/** Animated Casper ghost mask and static SVG fallback for the running Chat status. */
import css from './ChatView.module.css'

/* Frame 0 of the APNG; apps/web/scripts/render-running-ghost.ts draws both and prints this path. */
const REST_PATH = 'M3 8a5 5 0 0 1 10 0v6l-1.25 -1 -1.25 1 -1.25 -1 -1.25 1 -1.25 -1 -1.25 1 -1.25 -1 -1.25 1zM5.6 7.6a.7 .9 0 1 0 1.4 0a.7 .9 0 1 0-1.4 0zM9 7.6a.7 .9 0 1 0 1.4 0a.7 .9 0 1 0-1.4 0z'

/**
 * Render the decorative running icon; the APNG asset owns its animation timing.
 * @returns mask and static SVG selected by browser capabilities and accessibility preferences.
 */
export function RunningWhaleTail() {
  return (
    <span className={css.runningIcon} aria-hidden="true">
      <span className={css.runningWhaleAnimated} />
      <svg className={css.runningWhaleStill} width="100%" height="100%" viewBox="0 0 16 16" fill="none">
        <path d={REST_PATH} stroke="currentColor" strokeWidth={1} strokeLinejoin="round" />
      </svg>
    </span>
  )
}
