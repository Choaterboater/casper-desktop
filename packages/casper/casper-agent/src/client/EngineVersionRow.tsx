/** The Casper engine row in General Settings: which engine new Sessions start and its version. */
import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CasperEngineInfo } from '../engine-types.ts'
import type { CasperEngineKey } from './engine-locales.ts'
import css from './EngineVersionRow.module.css'

/** The row's Remote read, stable for the registration's lifetime. */
export interface EngineVersionRowInjected {
  readonly describe: () => Promise<RemoteResult<CasperEngineInfo>>
}

/**
 * The row's text for one answer: the version and where the engine comes from,
 * or what went wrong.
 * @param result - the `casperEngine.describe` answer.
 * @returns the dictionary key and its values.
 */
export function engineLine(result: RemoteResult<CasperEngineInfo>): { key: CasperEngineKey; version?: string } {
  if (result.ok) return { key: result.value.kind === 'bundled' ? 'engine.bundled' : 'engine.installed', version: result.value.version }
  if (result.error.code === 'casper-engine/missing') {
    return { key: result.error.details.kind === 'bundled' ? 'engine.missingBundled' : 'engine.missingInstalled' }
  }
  return { key: 'engine.unknown' }
}

/**
 * Ask the Host once per mount, so opening Settings after turning
 * `useInstalledCasper` on or off shows the engine new Sessions start.
 * @param props - the Remote read and localized copy.
 * @returns the General Settings row.
 */
export function EngineVersionRow({ describe, t }: PropsLocale<'casper-engine'> & InjectFace<EngineVersionRowInjected>) {
  const [line, setLine] = useState<{ key: CasperEngineKey; version?: string }>({ key: 'engine.checking' })
  useEffect(() => {
    let live = true
    void describe().then((result) => { if (live) setLine(engineLine(result)) })
    return () => { live = false }
  }, [describe])
  return <div className={css.row}>{t(line.key, line.version === undefined ? {} : { version: line.version })}</div>
}
