/**
 * The `casperAccess` projection: the access mode Casper picked itself, folded
 * from its records, for the composer's mode pill.
 * @module @deepseek-ai/dsh-casper-agent/access-projection
 */

import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { ACCESS_RECORD, casperOwnAccessSchema } from './access-record.ts'
import type { CasperOwnAccess } from './access-record.ts'
import type { CasperOwnAccessView } from './access-view.ts'

const viewSchema: z.ZodType<CasperOwnAccessView | null> = z.object({ mode: z.enum(['read', 'ask', 'full']) }).strict().nullable()

/** Whether a state names a mode; such a state is already the view's shape. */
function picked(state: CasperOwnAccess): state is CasperOwnAccessView {
  return state.mode !== null
}

/**
 * The fold: each access record replaces the mode; a malformed record, or one a
 * newer writer extended, is skipped. The view is null when there is no mode.
 */
export const casperAccessProjectionDefinition: Required<ProjectionDefinition<'casperAccess', CasperOwnAccess>> = {
  key: 'casperAccess',
  stateVersion: 1,
  stateSchema: casperOwnAccessSchema,
  init: () => ({ mode: null }),
  apply: (state, event) => {
    const record = pluginRecordOf(event)
    if (record?.type !== ACCESS_RECORD) return state
    // Throwing here would fail every later read of this Session.
    const parsed = casperOwnAccessSchema.safeParse(record.data)
    return parsed.success && parsed.data.mode !== state.mode ? parsed.data : state
  },
  wire: {
    viewSchema,
    // The state is the view's own shape, so an unchanged mode keeps its reference.
    view: state => picked(state) ? state : null,
    summary: false,
  },
}
