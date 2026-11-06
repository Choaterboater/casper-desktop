/** First-party command identities and input spellings shared by Host and Client adapters. */
import type { CommandDescriptor } from './types.ts'

const BUILTINS = {
  goal: '@deepseek-ai/dsh-command-goal',
  plan: '@deepseek-ai/dsh-plan-mode',
  feedback: '@deepseek-ai/dsh-command-feedback',
  compact: '@deepseek-ai/dsh-command-compact',
  permission: '@deepseek-ai/dsh-permission-presets',
  export: '@deepseek-ai/dsh-session-log-export',
} as const

/** Stable first-party capabilities, independent of their registered command names. */
export type BuiltinCommandName = keyof typeof BUILTINS

/** English and Simplified Chinese spellings recognized by command input. */
export const builtinCommandTokens = {
  en: { goal: 'goal', plan: 'plan', feedback: 'feedback', compact: 'compact', permission: 'permission', export: 'export' },
  zh: { goal: '目标', plan: '计划', feedback: '反馈', compact: '压缩', permission: '权限', export: '导出' },
} as const satisfies Record<'en' | 'zh', Record<BuiltinCommandName, string>>

/**
 * Identify a first-party definition after scoped shadowing.
 * @param descriptor - effective descriptor from the receiving Agent's catalog.
 * @returns its capability name, or undefined for another definition.
 */
export function builtinCommandName(descriptor: CommandDescriptor): BuiltinCommandName | undefined {
  return (Object.keys(BUILTINS) as BuiltinCommandName[])
    .find(name => descriptor.definitionId === BUILTINS[name])
}

/**
 * Definition identity prefix of commands that run as ordinary prompt text: the
 * agent behind the Session reads the typed `/name …` line itself, so a client
 * inserts and sends the line instead of executing it. The Casper agent
 * registers each command Casper offers as this prefix plus its name.
 */
export const PROMPT_COMMAND_ID_PREFIX = '@deepseek-ai/dsh-casper-agent/'

/**
 * Identify a command whose line is sent as a prompt rather than executed.
 * @param descriptor - effective descriptor from the receiving Agent's catalog.
 * @returns whether its definition identity starts with {@link PROMPT_COMMAND_ID_PREFIX}.
 */
export function isPromptCommand(descriptor: CommandDescriptor): boolean {
  return descriptor.definitionId?.startsWith(PROMPT_COMMAND_ID_PREFIX) === true
}

const TOKEN_ALIASES = new Map<string, BuiltinCommandName>(
  (Object.keys(BUILTINS) as BuiltinCommandName[]).flatMap(name =>
    [builtinCommandTokens.zh[name], builtinCommandTokens.en[name]].map(token => [token, name] as const)),
)

/**
 * Resolve typed spelling without overriding an exact scoped command name.
 * @param token - typed name without its leading slash.
 * @param descriptors - effective descriptors in the receiving Agent's catalog.
 * @returns the matching descriptor; aliases only select their first-party definition.
 */
export function resolveCommand(token: string, descriptors: readonly CommandDescriptor[]): CommandDescriptor | undefined {
  const exact = descriptors.find(descriptor => descriptor.name === token)
  if (exact !== undefined) return exact
  const name = TOKEN_ALIASES.get(token)
  if (name === undefined) return undefined
  return descriptors.find(descriptor => descriptor.definitionId === BUILTINS[name])
}
