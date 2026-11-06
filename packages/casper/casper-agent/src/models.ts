/**
 * Casper's model and effort options as the app's model picker shows them.
 * Only the options of category `model` and `thought_level` are read; Casper's
 * access `mode` option is not a model choice.
 * @module @deepseek-ai/dsh-casper-agent/models
 */

import type { SessionConfigOption, SessionConfigSelectGroup, SessionConfigSelectOption } from '@agentclientprotocol/sdk'
import type { AgentModelEffort, AgentModelEntry, AgentModelGroup, AgentModelsReport, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /**
     * Casper's whole model list and the model it uses now, read by the
     * `agentModels` projection. A plugin record, so an app build without this
     * package keeps and skips it and still opens the Session.
     */
    'plugin:casper-agent/models': AgentModelsReport
  }
}

/** The effort Casper picks by itself for each request. */
const AUTO_EFFORT = 'auto'

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>

/** One model value of Casper's `model` option with the selection it stands for. */
interface ModelValue {
  readonly value: string
  readonly selection: { readonly provider: string; readonly model: string }
  readonly option: SessionConfigSelectOption
  readonly groupName: string
}

/**
 * The first select option of one category.
 * @param options - Casper's options.
 * @param category - `model` or `thought_level`.
 * @returns the option, if Casper offers one.
 */
function optionOf(options: readonly SessionConfigOption[] | undefined, category: string): SelectOption | undefined {
  return options?.find((option): option is SelectOption => option.type === 'select' && option.category === category)
}

/**
 * Every value of Casper's `model` option. A grouped value `<group>/<id>` is the
 * group's provider and model id; an ungrouped value is split at its first slash.
 * @param model - the `model` option.
 * @returns the values in Casper's order.
 */
function modelValues(model: SelectOption | undefined): ModelValue[] {
  if (model === undefined) return []
  const values: ModelValue[] = []
  for (const entry of model.options) {
    if ('group' in entry) {
      const group: SessionConfigSelectGroup = entry
      const prefix = `${group.group}/`
      for (const option of group.options) {
        const id = option.value.startsWith(prefix) ? option.value.slice(prefix.length) : option.value
        values.push({ value: option.value, selection: { provider: group.group, model: id }, option, groupName: group.name })
      }
    } else {
      const slash = entry.value.indexOf('/')
      const provider = slash > 0 ? entry.value.slice(0, slash) : 'casper'
      const id = slash > 0 ? entry.value.slice(slash + 1) : entry.value
      values.push({ value: entry.value, selection: { provider, model: id }, option: entry, groupName: provider })
    }
  }
  return values
}

/**
 * The effort values one model takes: its `_meta.casper.efforts`, else, for the
 * current model of a Casper that sends none, the `thought_level` option's values.
 */
function effortValues(entry: ModelValue, current: boolean, effort: SelectOption | undefined): readonly string[] {
  const listed = (entry.option._meta?.casper as { efforts?: unknown } | undefined)?.efforts
  if (Array.isArray(listed)) return listed.filter((value): value is string => typeof value === 'string')
  if (!current || effort === undefined) return []
  return effort.options.flatMap(item => 'group' in item ? item.options : [item]).map(item => item.value)
}

/** One effort's display, named by the `thought_level` option when it lists the value. */
function effortOf(value: string, effort: SelectOption | undefined): AgentModelEffort {
  const listed = effort?.options.flatMap(item => 'group' in item ? item.options : [item]).find(item => item.value === value)
  return {
    id: value,
    name: listed?.name ?? value,
    ...listed?.description == null ? {} : { description: listed.description },
  }
}

/**
 * Build the picker's view of Casper's options.
 * @param options - Casper's options; undefined when it offers none.
 * @param started - whether Casper itself sent them.
 * @returns the groups in Casper's order and the current model with its effort.
 */
export function reportOf(options: readonly SessionConfigOption[] | undefined, started = true): AgentModelsReport {
  const model = optionOf(options, 'model')
  const effort = optionOf(options, 'thought_level')
  const values = modelValues(model)
  const groups: (AgentModelGroup & { models: AgentModelEntry[] })[] = []
  let current: ModelSelection | null = null
  for (const entry of values) {
    const isCurrent = model?.currentValue === entry.value
    const efforts = effortValues(entry, isCurrent, effort)
    const defaultEffort = efforts.includes(AUTO_EFFORT) ? { defaultEffort: AUTO_EFFORT } : {}
    const item: AgentModelEntry = {
      id: entry.selection.model,
      name: entry.option.name,
      ...entry.option.description == null ? {} : { description: entry.option.description },
      ...efforts.length === 0 ? {} : { reasoning: { efforts: efforts.map(value => effortOf(value, effort)), ...defaultEffort } },
    }
    let group = groups.find(candidate => candidate.id === entry.selection.provider)
    if (group === undefined) groups.push(group = { id: entry.selection.provider, name: entry.groupName, models: [] })
    group.models.push(item)
    if (isCurrent) {
      const level = effort !== undefined && typeof effort.currentValue === 'string' && efforts.includes(effort.currentValue) ? effort.currentValue : undefined
      current = { ...entry.selection, ...level === undefined ? {} : { reasoningEffort: ReasoningEffortId(level) } }
    }
  }
  return { groups, current, started }
}

/**
 * The `model` option value that stands for one selection.
 * @param options - Casper's options.
 * @param selection - provider and model id.
 * @returns the exact value to send, or undefined when Casper does not list the model.
 */
export function valueOf(options: readonly SessionConfigOption[] | undefined, selection: Pick<ModelSelection, 'provider' | 'model'>): string | undefined {
  return modelValues(optionOf(options, 'model'))
    .find(entry => entry.selection.provider === selection.provider && entry.selection.model === selection.model)?.value
}

/**
 * The current effort value and the values the `thought_level` option lists.
 * @param options - Casper's options.
 * @returns undefined when Casper offers no effort option.
 */
export function effortState(
  options: readonly SessionConfigOption[] | undefined,
): { readonly current: string; readonly values: readonly string[] } | undefined {
  const effort = optionOf(options, 'thought_level')
  if (effort === undefined || typeof effort.currentValue !== 'string') return undefined
  return { current: effort.currentValue, values: effort.options.flatMap(item => 'group' in item ? item.options : [item]).map(item => item.value) }
}

/**
 * Put a start value in a report as its current model: the listed model whose
 * value or `provider/id` equals it, else the value split at its first slash.
 * @param report - a report, such as the cached one.
 * @param value - a `--model` value such as `openai-codex/gpt-6.1-sol`.
 * @returns the report with that current model, or unchanged for a value with no provider.
 */
export function withCurrent(report: AgentModelsReport, value: string): AgentModelsReport {
  for (const group of report.groups) {
    for (const model of group.models) {
      if (`${group.id}/${model.id}` === value) return { ...report, current: { provider: group.id, model: model.id } }
    }
  }
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return report
  return { ...report, current: { provider: value.slice(0, slash), model: value.slice(slash + 1) } }
}
