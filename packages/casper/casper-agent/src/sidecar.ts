/**
 * Host storage for the Casper conversation behind each Session.
 * @module @deepseek-ai/dsh-casper-agent/sidecar
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** The Casper conversation a Session continues. */
export interface CasperSessionRecord {
  /** Casper's ACP session id, which is its conversation id. */
  readonly acpSessionId: string
  /** Folder the conversation belongs to; Casper saves conversations per folder. */
  readonly cwd: string
}

const recordSchema = z.object({ acpSessionId: z.string().min(1), cwd: z.string().min(1) })

/** One record per Session; a record that fails validation is moved aside, since losing it only costs Casper's earlier context. */
export const casperAgentDomain = defineDomain({
  name: 'casper_agent',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: { sessions: domainTable<SessionId, CasperSessionRecord>(recordSchema) },
})

/** Reads and writes the Session-to-conversation records. */
export class CasperSidecar {
  /** @param domain - the opened `casper_agent` domain. */
  constructor(private readonly domain: Domain<typeof casperAgentDomain>) {}

  /**
   * Read the conversation a Session continues.
   * @param sessionId - the Session.
   * @param cwd - the Session's folder.
   * @returns the record when one exists for that folder.
   */
  read(sessionId: SessionId, cwd: string): CasperSessionRecord | undefined {
    const record = this.domain.table('sessions').get(sessionId)
    return record?.cwd === cwd ? record : undefined
  }

  /**
   * Store the conversation a Session continues.
   * @param sessionId - the Session.
   * @param record - Casper's conversation id and folder.
   * @returns resolution once the record is written.
   */
  async write(sessionId: SessionId, record: CasperSessionRecord): Promise<void> {
    const current = this.domain.table('sessions').get(sessionId)
    if (current?.acpSessionId === record.acpSessionId && current.cwd === record.cwd) return
    await this.domain.table('sessions').put(sessionId, record)
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
 * Open the sidecar domain.
 * @param facility - the storage-domain facility.
 * @returns the sidecar; the caller closes it.
 */
export async function openSidecar(facility: DomainFacility): Promise<CasperSidecar> {
  return new CasperSidecar(await facility.open(casperAgentDomain))
}
