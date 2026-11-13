/**
 * Host owner of the `casperSignIn` Remote namespace: the Models settings
 * page's Casper card reads the ways Casper signs in and what it has saved,
 * runs one sign-in as a stream, and signs out, so Casper's models are set up
 * in the app with no terminal. The work is {@link CasperSignIn}'s; each call
 * starts Casper with the app profile current at that call.
 *
 * A pasted key crosses toward the Host only, in `signIn`'s arguments, and goes
 * to Casper alone; no method returns a key.
 * @module @deepseek-ai/dsh-casper-agent/src/sign-in-controller
 */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Config } from './config.ts'
import { CasperSignIn } from './sign-in.ts'
import type { CasperSignInFrame, CasperSignInState } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `casperSignIn` Remote namespace. */
    casperSignIn: CasperSignInController
  }
}

/** The `casperSignIn` Remote namespace; see the module comment. */
export class CasperSignInController extends TypertRemoteService {
  static inject = ['subprocess', 'typert']

  /**
   * @param ctx - plugin context holding the subprocess service.
   * @param config - the Casper agent plugin config.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'casperSignIn', { namespace: 'casperSignIn' })
  }

  /**
   * Read the ways Casper signs in and the sign-ins it has saved.
   * @param signal - call lifetime; aborting ends Casper.
   * @returns the ways the card can show and the saved sign-ins.
   * @throws RemoteError `casperSignIn/failed` when Casper cannot start or refuses.
   */
  @Remote
  async state(signal: AbortSignal): Promise<CasperSignInState> {
    try {
      return await this.signIns().state(signal)
    } catch (error: unknown) {
      throw failed('state', error, signal)
    }
  }

  /**
   * Run one sign-in and stream its steps; closing the stream stops it.
   * @param methodId - one of {@link state}'s method ids.
   * @param key - the pasted key, for an `api_key` way only.
   * @param signal - stream lifetime.
   * @returns the steps, ending with `signed-in` or `failed` unless stopped.
   */
  @Remote({ mode: 'stream' })
  signIn(methodId: string, key: string | undefined, signal: AbortSignal): AsyncIterable<CasperSignInFrame> {
    return this.signIns().signIn(methodId, key, signal)
  }

  /**
   * Remove the sign-in Casper saved for one provider.
   * @param provider - the provider, as {@link state} names it.
   * @param signal - call lifetime; aborting ends Casper.
   * @returns whether there was a sign-in to remove.
   * @throws RemoteError `casperSignIn/failed` when Casper cannot start or refuses.
   */
  @Remote
  async signOut(provider: string, signal: AbortSignal): Promise<boolean> {
    try {
      return await this.signIns().signOut(provider, signal)
    } catch (error: unknown) {
      throw failed('signOut', error, signal)
    }
  }

  private signIns(): CasperSignIn {
    const context = this.ctx.get('profileContext')
    return new CasperSignIn({
      subprocess: this.ctx.subprocess,
      config: this.config,
      cwd: homedir(),
      ...context === undefined ? {} : { profile: { name: context.name, dir: context.dir } },
    })
  }
}

/** A stop passes through as itself; any other failure becomes `casperSignIn/failed` with its own words. */
function failed(request: 'state' | 'signOut', error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return error
  return new RemoteError('casperSignIn/failed', error instanceof Error ? error.message : String(error), { request }, { cause: error })
}
