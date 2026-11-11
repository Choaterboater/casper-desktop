/**
 * The host cache of the model list Casper last sent, which a new Casper
 * Session offers in its picker before its own Casper starts.
 * @module @deepseek-ai/dsh-casper-agent/models-cache
 */

import { z } from 'zod'
import { agentModelSchemas } from '@deepseek-ai/dsh-agent'
import type { AgentModelGroup, ModelSelection } from '@deepseek-ai/dsh-agent'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, DomainFacility } from '@deepseek-ai/dsh-storage-domain'

/** The kept list: Casper's groups and the model it used. */
export interface CasperModelsRecord {
  /** Offered models by provider. */
  readonly groups: readonly AgentModelGroup[]
  /** The model Casper used, or null. */
  readonly current: ModelSelection | null
}

// Unknown keys are dropped, as before, so a stored record written with more fields still opens.
const { group, selection } = agentModelSchemas('strip')
const recordSchema = z.object({ groups: z.array(group), current: selection.nullable() })

/** One global record: the last model list any Casper process sent. */
export const casperModelsDomain = defineDomain({
  name: 'casper_agent_models',
  version: 1,
  tables: {},
  global: { schema: recordSchema, initial: { groups: [], current: null } },
})

/** Reads and writes the cached model list. */
export class CasperModelsCache {
  /** @param domain - the opened `casper_agent_models` domain. */
  constructor(private readonly domain: Domain<typeof casperModelsDomain>) {}

  /**
   * Read the last list.
   * @returns the record; no groups before any Casper sent a list.
   */
  read(): CasperModelsRecord {
    return this.domain.global.get()
  }

  /**
   * Store a list; a list equal to the stored one is not written.
   * @param record - the groups and current model to keep.
   * @returns resolution once the record is written.
   */
  async write(record: CasperModelsRecord): Promise<void> {
    const next = recordSchema.parse({ groups: record.groups, current: record.current })
    if (JSON.stringify(next) === JSON.stringify(this.read())) return
    await this.domain.global.set(next)
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
 * Open the model cache.
 * @param facility - the storage-domain facility.
 * @returns the cache; the caller closes it.
 */
export async function openModelsCache(facility: DomainFacility): Promise<CasperModelsCache> {
  return new CasperModelsCache(await facility.open(casperModelsDomain))
}
