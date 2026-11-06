/**
 * Casper's slash commands in the app's command menu, and the host cache that
 * offers the last list before Casper starts.
 * @module @deepseek-ai/dsh-casper-agent/commands
 */

import { z } from 'zod'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { PROMPT_COMMAND_ID_PREFIX } from '@deepseek-ai/dsh-commands/builtin'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, DomainFacility } from '@deepseek-ai/dsh-storage-domain'

/** One command Casper offers, as the menu shows it. */
export interface CasperCommand {
  /** Name without the leading slash. */
  readonly name: string
  /** Casper's description. */
  readonly description: string
  /** Casper's input hint; present only for a command that takes words after its name. */
  readonly hint?: string
}

/** The registry's command-name rule. */
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u

/** Names the app's composer contributes itself, so a Casper command of that name would collide in the menu. */
const CLIENT_NAMES: ReadonlySet<string> = new Set(['model', 'file'])

/**
 * The commands of one `available_commands_update` the menu can show: a name
 * the registry accepts, not a client contribution's, with a description; the
 * first of two equal names wins.
 * @param list - Casper's list.
 * @returns the commands in Casper's order.
 */
export function casperCommands(list: readonly AvailableCommand[]): CasperCommand[] {
  const seen = new Set<string>()
  const commands: CasperCommand[] = []
  for (const command of list) {
    if (!COMMAND_NAME.test(command.name) || CLIENT_NAMES.has(command.name) || seen.has(command.name)) continue
    if (command.description.trim() === '') continue
    seen.add(command.name)
    const hint = command.input?.hint.trim() ?? ''
    commands.push({ name: command.name, description: command.description, ...hint === '' ? {} : { hint } })
  }
  return commands
}

/**
 * The definition identity of one Casper command; clients send its line as a prompt.
 * @param name - the command name.
 * @returns {@link PROMPT_COMMAND_ID_PREFIX} followed by the name.
 */
export function casperCommandId(name: string): CommandDefinitionId {
  return CommandDefinitionId(`${PROMPT_COMMAND_ID_PREFIX}${name}`)
}

const commandSchema = z.object({ name: z.string(), description: z.string(), hint: z.string().exactOptional() })

/** One global record: the last command list any Casper process sent. */
export const casperCommandsDomain = defineDomain({
  name: 'casper_agent_commands',
  version: 1,
  tables: {},
  global: { schema: z.object({ commands: z.array(commandSchema) }), initial: { commands: [] } },
})

/** Reads and writes the cached command list. */
export class CasperCommandCache {
  /** @param domain - the opened `casper_agent_commands` domain. */
  constructor(private readonly domain: Domain<typeof casperCommandsDomain>) {}

  /**
   * Read the last list.
   * @returns the commands, empty before any Casper sent a list.
   */
  read(): readonly CasperCommand[] {
    return this.domain.global.get().commands
  }

  /**
   * Store a list; a list equal to the stored one is not written.
   * @param commands - the commands to keep.
   * @returns resolution once the record is written.
   */
  async write(commands: readonly CasperCommand[]): Promise<void> {
    if (JSON.stringify(commands) === JSON.stringify(this.read())) return
    await this.domain.global.set({ commands: [...commands] })
  }

  /**
   * Close the domain.
   * @returns resolution once pending writes drain.
   */
  close(): Promise<void> {
    return this.domain.close()
  }
}

/**
 * Open the command cache.
 * @param facility - the storage-domain facility.
 * @returns the cache; the caller closes it.
 */
export async function openCommandCache(facility: DomainFacility): Promise<CasperCommandCache> {
  return new CasperCommandCache(await facility.open(casperCommandsDomain))
}
