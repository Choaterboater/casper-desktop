/**
 * The `agentModels` projection: the model list an Agent that chooses its own
 * models reports, and a selection recorded before the Agent reported it.
 * @module @deepseek-ai/dsh-agent/agent-models
 */
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { AgentModelGroup, AgentModelsProjection, AgentModelsReport, ModelSelection } from './types.ts'
import { modelSelectionSchema } from './model-selection.ts'

/**
 * Plugin record type of the model list report. The Casper agent declares it in
 * `PluginRecordMap` and writes it; a reader without that declaration retains
 * and skips the record.
 */
export const AGENT_MODELS_RECORD = 'plugin:casper-agent/models'

/** Durable `agentModels` state for one Session. */
export interface AgentModelsState {
  /** The last models record, or null before the first. */
  readonly reported: AgentModelsReport | null
  /** A `model/selection` recorded after that report, or null. */
  readonly wanted: ModelSelection | null
}

/**
 * Schemas of the model list's groups and of one selection.
 * @param unknownKeys - `strict` rejects a key this version does not know, so the
 * projection skips a record a newer writer extended; `strip` drops such a key,
 * so a stored copy stays readable.
 * @returns the group and selection schemas.
 */
export function agentModelSchemas(unknownKeys: 'strict' | 'strip'): { readonly group: z.ZodType<AgentModelGroup>; readonly selection: z.ZodType<ModelSelection> } {
  const object = <S extends z.ZodRawShape>(shape: S) => unknownKeys === 'strict' ? z.strictObject(shape) : z.object(shape)
  const group = object({
    id: z.string(),
    name: z.string(),
    models: z.array(object({
      id: z.string(),
      name: z.string(),
      description: z.string().exactOptional(),
      reasoning: object({
        efforts: z.array(object({ id: z.string(), name: z.string(), description: z.string().exactOptional() })),
        defaultEffort: z.string().exactOptional(),
      }).exactOptional(),
    })),
  })
  return { group, selection: unknownKeys === 'strict' ? modelSelectionSchema.strict() : modelSelectionSchema }
}

const { group: groupSchema, selection: selectionSchema } = agentModelSchemas('strict')

const reportSchema = z.object({ groups: z.array(groupSchema), current: selectionSchema.nullable(), started: z.boolean() }).strict()

/**
 * Compare two selections, an absent effort being its own value.
 * @param left - first selection, or none.
 * @param right - second selection.
 * @returns whether both name the same route and effort.
 */
function sameSelection(left: ModelSelection | null, right: ModelSelection): boolean {
  return left !== null && left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
}

/**
 * The fold: a models record replaces the list and settles any recorded
 * selection; a selection recorded once something was reported is what the view
 * shows as current until the next record. A selection before any record is
 * ignored, since such a Session uses the Host catalog. A malformed record, or
 * one a newer writer extended, is skipped.
 */
export const agentModelsProjectionDefinition: Required<ProjectionDefinition<'agentModels', AgentModelsState>> = {
  key: 'agentModels',
  stateVersion: 1,
  stateSchema: z.object({ reported: reportSchema.nullable(), wanted: selectionSchema.nullable() }),
  init: () => ({ reported: null, wanted: null }),
  apply: (state, event) => {
    if (event.type === 'model/selection') {
      return state.reported === null || sameSelection(state.wanted, event.data) ? state : { ...state, wanted: event.data }
    }
    const record = pluginRecordOf(event)
    if (record?.type !== AGENT_MODELS_RECORD) return state
    // Throwing here would fail every later read of this Session.
    const report = reportSchema.safeParse(record.data)
    return report.success ? { reported: report.data, wanted: null } : state
  },
  wire: {
    viewSchema: z.object({ groups: z.array(groupSchema), current: selectionSchema.nullable(), started: z.boolean() }).nullable(),
    view: (state): AgentModelsProjection | null => state.reported === null
      ? null
      : { groups: state.reported.groups, current: state.wanted ?? state.reported.current, started: state.reported.started },
    summary: false,
  },
}
