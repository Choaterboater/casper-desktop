/**
 * The provider card's sign-in field: a button per sign-in method the Host
 * offers for this provider, the link or device code the flow shows, any code
 * it asks for, and a sign-out once a sign-in is stored. Renders nothing when
 * the Host offers no flow for the provider.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AuthorizationEntryView, AuthorizationEventView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelsOperations } from './operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** The record scope the pi-ai adapter stores its provider sign-ins under. */
const SIGN_IN_SCOPE = 'llm-pi-ai'

/** Props of {@link ProviderSignIn}. */
export interface ProviderSignInProps {
  /** The provider id whose flow, if any, this field drives. */
  provider: string
  /** Host operations the field calls. */
  operations: Pick<ModelsOperations, 'listSignIns' | 'signIn' | 'answerSignIn' | 'signOut'>
  /** Page dictionary lookup. */
  t: (key: keyof typeof en) => string
  /** Disables every control while the card is busy. */
  disabled?: boolean
}

type Prompt = Extract<AuthorizationEventView, { type: 'prompt' }>

/** What the field shows after the last frame. */
type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; notice?: Extract<AuthorizationEventView, { type: 'notice' }>; prompt?: Prompt }
  | { kind: 'done' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string }

/**
 * Render the sign-in field for one provider card.
 * @param props - provider id, Host operations, and copy.
 * @returns the field, or null when the Host offers no sign-in for this provider.
 */
export function ProviderSignIn(props: ProviderSignInProps): ReactNode {
  const { provider, operations, t } = props
  const key = `${SIGN_IN_SCOPE}/${provider}`
  const [entry, setEntry] = useState<AuthorizationEntryView | undefined>()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [answer, setAnswer] = useState('')
  const running = useRef<AbortController | undefined>(undefined)

  const refresh = async (): Promise<void> => {
    const flows = await operations.listSignIns()
    setEntry(flows.find(flow => flow.key === key))
  }
  useEffect(() => {
    void refresh()
    // Leaving the card withdraws an attempt nobody can finish any more.
    return () => { running.current?.abort() }
  }, [key])

  if (entry === undefined || entry.methods.length === 0) return null

  const start = (method: string): void => {
    const controller = new AbortController()
    running.current = controller
    setAnswer('')
    setPhase({ kind: 'running' })
    void operations.signIn(key, method, controller.signal, (frame) => {
      switch (frame.type) {
        case 'notice':
          setPhase(current => ({ kind: 'running', notice: frame, ...current.kind === 'running' && current.prompt !== undefined ? { prompt: current.prompt } : {} }))
          return
        case 'prompt':
          setAnswer('')
          setPhase(current => ({ kind: 'running', prompt: frame, ...current.kind === 'running' && current.notice !== undefined ? { notice: current.notice } : {} }))
          return
        case 'prompt-withdrawn':
          setPhase(current => current.kind === 'running' && current.prompt?.promptId === frame.promptId
            ? { kind: 'running', ...current.notice === undefined ? {} : { notice: current.notice } }
            : current)
          return
        case 'settled':
          setPhase({ kind: frame.status === 'authorized' ? 'done' : 'cancelled' })
          return
        case 'failed':
          setPhase({ kind: 'failed', message: frame.message })
      }
    }).finally(() => {
      if (running.current === controller) running.current = undefined
      void refresh()
    })
  }

  const respond = async (prompt: Prompt, value: string | undefined): Promise<void> => {
    const refused = await operations.answerSignIn(prompt.promptId, value)
    if (refused !== undefined) setPhase({ kind: 'failed', message: refused })
    else setPhase(current => current.kind === 'running' ? { kind: 'running', ...current.notice === undefined ? {} : { notice: current.notice } } : current)
  }

  const signOut = async (): Promise<void> => {
    const refused = await operations.signOut(key)
    setPhase(refused === undefined ? { kind: 'idle' } : { kind: 'failed', message: refused })
    await refresh()
  }

  const busy = props.disabled === true || phase.kind === 'running'
  return (
    <div className={styles['field']} data-testid="provider-sign-in">
      <span className={styles['fieldLabel']}>{t('signInLabel')}</span>
      {entry.signedIn && phase.kind !== 'running'
        ? (
          <div className={styles['editorActions']}>
            <p className={styles['savedNotice']}>{t('signedIn')}</p>
            <button type="button" className={styles['secondaryButton']} disabled={busy} onClick={() => { void signOut() }}>{t('signOut')}</button>
          </div>
        )
        : (
          <div className={styles['editorActions']}>
            {entry.methods.map(method => (
              <button key={method.id} type="button" className={styles['primaryButton']} disabled={busy} onClick={() => { start(method.id) }}>
                {method.label}
              </button>
            ))}
            {phase.kind === 'running'
              ? <button type="button" className={styles['secondaryButton']} onClick={() => { running.current?.abort(); setPhase({ kind: 'cancelled' }) }}>{t('cancel')}</button>
              : null}
          </div>
        )}
      {phase.kind === 'running'
        ? (
          <>
            <p className={styles['advancedHint']} role="status">{phase.notice?.message ?? t('signInWaiting')}</p>
            {phase.notice?.url === undefined
              ? null
              : <a className={styles['linkButton']} href={phase.notice.url} target="_blank" rel="noopener noreferrer">{t('signInOpenPage')}</a>}
            {phase.notice?.code === undefined
              ? null
              : <p className={styles['notice']}>{t('signInCode').replace('{code}', () => phase.notice?.code ?? '')}</p>}
            {phase.prompt === undefined
              ? null
              : (
                <form onSubmit={(event) => { event.preventDefault(); if (phase.prompt !== undefined) void respond(phase.prompt, answer) }}>
                  <label className={styles['fieldLabel']}>{phase.prompt.message}</label>
                  {phase.prompt.kind === 'select'
                    ? (
                      <select className={styles['selectInput']} value={answer} aria-label={phase.prompt.message} onChange={(event) => { setAnswer(event.target.value) }}>
                        <option value="" disabled>{phase.prompt.message}</option>
                        {(phase.prompt.options ?? []).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                      </select>
                    )
                    : (
                      <input
                        className={styles['input']}
                        type={phase.prompt.kind === 'secret' ? 'password' : 'text'}
                        autoComplete="off"
                        spellCheck={false}
                        value={answer}
                        placeholder={phase.prompt.placeholder}
                        aria-label={phase.prompt.message}
                        onChange={(event) => { setAnswer(event.target.value) }}
                      />
                    )}
                  <div className={styles['editorActions']}>
                    <button type="submit" className={styles['primaryButton']} disabled={answer.trim() === ''}>{t('signInSubmit')}</button>
                    <button type="button" className={styles['secondaryButton']} onClick={() => { if (phase.prompt !== undefined) void respond(phase.prompt, undefined) }}>{t('signInDecline')}</button>
                  </div>
                </form>
              )}
          </>
        )
        : null}
      {phase.kind === 'done' ? <p className={styles['savedNotice']} role="status">{t('signInDone')}</p> : null}
      {phase.kind === 'cancelled' ? <p className={styles['advancedHint']} role="status">{t('signInCancelled')}</p> : null}
      {phase.kind === 'failed' ? <p className={styles['error']} role="alert">{t('signInFailed').replace('{message}', () => phase.message)}</p> : null}
    </div>
  )
}
