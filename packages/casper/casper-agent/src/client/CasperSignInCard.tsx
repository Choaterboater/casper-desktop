/**
 * The Models settings page's Casper models card: one row per provider Casper
 * signs in to, with the ways Casper offers, the step a running sign-in is on,
 * and sign-out once Casper has a saved sign-in. A row with a saved sign-in
 * keeps its ways, to sign in again or another way. One sign-in runs at a
 * time; leaving the page stops it.
 * @module @deepseek-ai/dsh-casper-agent/client/CasperSignInCard
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CasperSignInFrame, CasperSignInMethod, CasperSignInState } from '../types.ts'
import css from './CasperSignInCard.module.css'
import type { NS } from './locales.ts'

/** What the card asks the Host; each call throws an Error carrying the words to show. */
export interface CasperSignInOperations {
  /**
   * Read the ways Casper signs in and its saved sign-ins.
   * @param signal - stops the read.
   * @returns Casper's ways and saved sign-ins.
   */
  state(signal: AbortSignal): Promise<CasperSignInState>
  /**
   * Run one sign-in, reporting each step.
   * @param methodId - the way to run.
   * @param key - the pasted key, for an `api_key` way.
   * @param onFrame - receives each step.
   * @param signal - stops the sign-in.
   * @returns resolution once the stream ends.
   */
  signIn(methodId: string, key: string | undefined, onFrame: (frame: CasperSignInFrame) => void, signal: AbortSignal): Promise<void>
  /**
   * Remove one provider's saved sign-in.
   * @param provider - the provider.
   * @param signal - stops the request.
   * @returns resolution once Casper answers.
   */
  signOut(provider: string, signal: AbortSignal): Promise<void>
}

/** Props of {@link CasperSignInCard}: the Host operations and the namespace's translate. */
export type CasperSignInCardProps = PropsLocale<typeof NS> & { operations: CasperSignInOperations }

type Load =
  | { status: 'loading' }
  | { status: 'ready'; state: CasperSignInState }
  | { status: 'failed'; message: string }

/** The one sign-in in progress: waiting for a key, or running with its latest page step. */
type Running =
  | { phase: 'key'; method: CasperSignInMethod }
  | { phase: 'running'; method: CasperSignInMethod; step?: Extract<CasperSignInFrame, { type: 'browser' | 'device_code' }> }

/** The last outcome a row shows. */
interface Outcome { provider: string; kind: 'done' | 'failed' | 'stopped' | 'signOutFailed'; message?: string }

/** One provider's row: its name, its ways, and whether Casper has a sign-in saved for it. */
interface Row { provider: string; name: string; methods: CasperSignInMethod[]; signedIn: boolean }

/**
 * Split Casper's `Name · way` label; a label without the separator names the provider only.
 * @param label - Casper's label.
 * @returns the provider name and the way, when the label has one.
 */
export function splitLabel(label: string): { name: string; way?: string } {
  const at = label.indexOf(' · ')
  if (at < 0) return { name: label }
  const way = label.slice(at + 3).trim()
  return { name: label.slice(0, at).trim(), ...way === '' ? {} : { way: way.charAt(0).toUpperCase() + way.slice(1) } }
}

/**
 * Group Casper's ways by provider in Casper's order, then add saved sign-ins no listed way covers.
 * @param state - Casper's ways and saved sign-ins.
 * @returns one row per provider.
 */
export function rowsOf(state: CasperSignInState): Row[] {
  const rows = new Map<string, Row>()
  const saved = new Set(state.signIns.map(entry => entry.provider))
  for (const method of state.methods) {
    const row = rows.get(method.provider)
    if (row !== undefined) {
      row.methods.push(method)
      continue
    }
    const name = splitLabel(method.label).name
    rows.set(method.provider, { provider: method.provider, name, methods: [method], signedIn: saved.has(method.provider) })
  }
  for (const provider of saved) {
    if (!rows.has(provider)) rows.set(provider, { provider, name: provider, methods: [], signedIn: true })
  }
  return [...rows.values()]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Render the Casper models card.
 * @param props - Host operations and translate.
 * @returns the card.
 */
export function CasperSignInCard({ operations, t }: CasperSignInCardProps): ReactNode {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [running, setRunning] = useState<Running | undefined>()
  const [outcome, setOutcome] = useState<Outcome | undefined>()
  const [key, setKey] = useState('')
  const [signingOut, setSigningOut] = useState<string | undefined>()
  const stop = useRef<AbortController | undefined>(undefined)
  const page = useRef(new AbortController())

  const refresh = async (): Promise<void> => {
    try {
      const state = await operations.state(page.current.signal)
      if (!page.current.signal.aborted) setLoad({ status: 'ready', state })
    } catch (error: unknown) {
      if (!page.current.signal.aborted) setLoad({ status: 'failed', message: messageOf(error) })
    }
  }

  useEffect(() => {
    page.current = new AbortController()
    void refresh()
    return () => {
      page.current.abort()
      stop.current?.abort()
    }
  }, [operations])

  const run = (method: CasperSignInMethod, given: string | undefined): void => {
    const controller = new AbortController()
    stop.current = controller
    setKey('')
    setOutcome(undefined)
    setRunning({ phase: 'running', method })
    let last: Outcome | undefined
    void operations.signIn(method.id, given, (frame) => {
      switch (frame.type) {
        case 'browser':
        case 'device_code':
          setRunning({ phase: 'running', method, step: frame })
          return
        case 'signed-in':
          last = { provider: method.provider, kind: 'done' }
          return
        case 'failed':
          last = { provider: method.provider, kind: 'failed', message: frame.message }
      }
    }, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) last = { provider: method.provider, kind: 'failed', message: messageOf(error) }
    }).finally(() => {
      if (stop.current !== controller || page.current.signal.aborted) return
      stop.current = undefined
      setRunning(undefined)
      setOutcome(last ?? { provider: method.provider, kind: 'stopped' })
      void refresh()
    })
  }

  const start = (method: CasperSignInMethod): void => {
    setOutcome(undefined)
    if (method.kind === 'api_key') {
      setKey('')
      setRunning({ phase: 'key', method })
    } else run(method, undefined)
  }

  const cancel = (): void => {
    const controller = stop.current
    const provider = running?.method.provider
    stop.current = undefined
    controller?.abort()
    setRunning(undefined)
    setKey('')
    if (controller !== undefined && provider !== undefined) setOutcome({ provider, kind: 'stopped' })
  }

  const signOut = async (provider: string): Promise<void> => {
    setOutcome(undefined)
    setSigningOut(provider)
    try {
      await operations.signOut(provider, page.current.signal)
    } catch (error: unknown) {
      if (!page.current.signal.aborted) setOutcome({ provider, kind: 'signOutFailed', message: messageOf(error) })
    }
    if (page.current.signal.aborted) return
    setSigningOut(undefined)
    await refresh()
  }

  const busy = running !== undefined || signingOut !== undefined
  return (
    <section className={css.card} aria-labelledby="casper-sign-in-title" data-testid="casper-sign-in">
      <h3 id="casper-sign-in-title" className={css.title}>{t('signIn.title')}</h3>
      <p className={css.intro}>{t('signIn.intro')}</p>
      {load.status === 'loading' ? <p className={css.hint} role="status">{t('signIn.loading')}</p> : null}
      {load.status === 'failed'
        ? (
          <div className={css.actions}>
            <p className={css.error} role="alert">{t('signIn.loadFailed', { message: load.message })}</p>
            <button type="button" className={css.secondary} onClick={() => { setLoad({ status: 'loading' }); void refresh() }}>{t('signIn.retry')}</button>
          </div>
        )
        : null}
      {load.status === 'ready' && rowsOf(load.state).length === 0 ? <p className={css.hint}>{t('signIn.none')}</p> : null}
      {load.status === 'ready'
        ? (
          <ul className={css.rows}>
            {rowsOf(load.state).map((row) => {
              const mine = running?.method.provider === row.provider ? running : undefined
              const told = outcome?.provider === row.provider ? outcome : undefined
              return (
                <li key={row.provider} className={css.row} data-provider={row.provider}>
                  <div className={css.head}>
                    <span className={css.name}>{row.name}</span>
                    {row.signedIn && mine === undefined ? <span className={css.signedIn}>{t('signIn.signedIn')}</span> : null}
                  </div>
                  {mine === undefined
                    ? (
                      <div className={css.actions}>
                        {row.methods.map(method => (
                          <button
                            key={method.id}
                            type="button"
                            className={row.signedIn ? css.secondary : css.primary}
                            disabled={busy}
                            onClick={() => { start(method) }}
                          >
                            {splitLabel(method.label).way ?? t('signIn.start')}
                          </button>
                        ))}
                        {row.signedIn
                          ? <button type="button" className={css.secondary} disabled={busy} onClick={() => { void signOut(row.provider) }}>{t('signIn.signOut')}</button>
                          : null}
                      </div>
                    )
                    : null}
                  {mine?.phase === 'key'
                    ? (
                      <form
                        className={css.keyForm}
                        onSubmit={(event) => { event.preventDefault(); if (key.trim() !== '') run(mine.method, key.trim()) }}
                      >
                        <label className={css.label} htmlFor={`casper-key-${row.provider}`}>{t('signIn.keyLabel', { provider: row.name })}</label>
                        <input
                          id={`casper-key-${row.provider}`}
                          className={css.input}
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          value={key}
                          onChange={(event) => { setKey(event.target.value) }}
                        />
                        <div className={css.actions}>
                          <button type="button" className={css.secondary} onClick={cancel}>{t('signIn.cancel')}</button>
                          <button type="submit" className={css.primary} disabled={key.trim() === ''}>{t('signIn.keySave')}</button>
                        </div>
                      </form>
                    )
                    : null}
                  {mine?.phase === 'running'
                    ? (
                      <div className={css.step}>
                        {mine.step === undefined ? <p className={css.hint} role="status">{t('signIn.waiting')}</p> : null}
                        {mine.step?.type === 'browser'
                          ? <p className={css.hint} role="status">{t(mine.step.opened ? 'signIn.browser' : 'signIn.browserClosed')}</p>
                          : null}
                        {mine.step?.type === 'device_code'
                          ? <p className={css.hint} role="status">{t('signIn.code')} <code className={css.code}>{mine.step.code}</code></p>
                          : null}
                        <div className={css.actions}>
                          {mine.step === undefined
                            ? null
                            : <a className={css.secondary} href={mine.step.url} target="_blank" rel="noopener noreferrer">{t('signIn.openPage')}</a>}
                          <button type="button" className={css.secondary} onClick={cancel}>{t('signIn.cancel')}</button>
                        </div>
                      </div>
                    )
                    : null}
                  {told?.kind === 'done' ? <p className={css.done} role="status">{t('signIn.done')}</p> : null}
                  {told?.kind === 'stopped' ? <p className={css.hint} role="status">{t('signIn.stopped')}</p> : null}
                  {told?.kind === 'failed' ? <p className={css.error} role="alert">{t('signIn.failed', { message: told.message ?? '' })}</p> : null}
                  {told?.kind === 'signOutFailed' ? <p className={css.error} role="alert">{t('signIn.signOutFailed', { message: told.message ?? '' })}</p> : null}
                </li>
              )
            })}
          </ul>
        )
        : null}
    </section>
  )
}
