/**
 * The record of the access mode Casper picked itself, which the composer's
 * mode pill shows. Only zod is imported at run time.
 * @module @deepseek-ai/dsh-casper-agent/access-record
 */

import { z } from 'zod'
import type { CasperAccessMode } from './access-view.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /**
     * The access mode Casper picked itself, or null once that pick ended: the
     * app set a mode, Casper went back to the one the app set, or the process
     * that picked it closed. One record per change, read by the `casperAccess`
     * projection for the composer's mode pill. A plugin record, so an app build
     * without this package keeps and skips it and still opens the Session.
     */
    'plugin:casper-agent/access': CasperOwnAccess
  }
}

/** Plugin record type of the access mode Casper picked itself. */
export const ACCESS_RECORD = 'plugin:casper-agent/access'

/** The access mode Casper picked itself, or null when there is none. */
export interface CasperOwnAccess {
  /** The mode Casper is in that the app did not set, or null. */
  readonly mode: CasperAccessMode | null
}

/** Schema of one {@link CasperOwnAccess} record; a record a newer writer extended is refused. */
export const casperOwnAccessSchema: z.ZodType<CasperOwnAccess> = z.object({
  mode: z.enum(['read', 'ask', 'full']).nullable(),
}).strict()
