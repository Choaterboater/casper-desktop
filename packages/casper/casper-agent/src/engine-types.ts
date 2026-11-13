/**
 * What the `casperEngine` Remote namespace reports about the Casper engine new
 * Sessions start, and its failure codes. Host and Client both read this module.
 * @module @deepseek-ai/dsh-casper-agent/engine-types
 */

import type {} from '@deepseek-ai/dsh-typert-protocol'

/** Which Casper new Sessions start: `bundled` ships with the app, `installed` is found on the computer with `useInstalledCasper` on. */
export type CasperEngineKind = 'bundled' | 'installed'

/** The Casper engine new Sessions start and the version it reports. */
export interface CasperEngineInfo {
  readonly kind: CasperEngineKind
  /** The version `casper --version` prints, such as `0.4.15`. */
  readonly version: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The bundled engine is not an executable file, or no installed Casper was found for `command`. */
    'casper-engine/missing': { readonly kind: CasperEngineKind }
    /** The engine was found but could not run, failed, timed out, or printed no version. */
    'casper-engine/unreadable': { readonly kind: CasperEngineKind }
  }
}
