/**
 * The access mode Casper picked itself, as the composer's mode pill reads it.
 * Only a type import, so both halves can inline it.
 * @module @deepseek-ai/dsh-casper-agent/access-view
 */

import type { SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection/types'

/** A mode Casper can be in: Read only (`read`), Ask first (`ask`), or Don't ask (`full`). */
export type CasperAccessMode = 'read' | 'ask' | 'full'

/** The mode Casper picked itself while the process that picked it runs. */
export interface CasperOwnAccessView {
  /** The mode Casper is in, which the app's access control did not set. */
  readonly mode: CasperAccessMode
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The access mode Casper picked itself, or null when it is in the mode the
     * app set, or the process that picked it ended. The composer's mode pill
     * shows it. Excluded from Session summaries.
     */
    casperAccess: SessionProjectionSummaryExcluded<CasperOwnAccessView> | null
  }
}
