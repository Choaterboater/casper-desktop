/** Platform account surface that the Electron main process drives; Casper composes an inert implementation. */
import type { EventEmitter } from 'node:events'
import type { View, WebFrameMain } from 'electron'
import type { PlatformSession } from '@deepseek-ai/dsh-deepseek-account'
import type { PlatformBounds, PlatformLocale } from './platform-ipc.ts'

/** Application window that would contain a Platform document. */
export type PlatformSurfaceOwner = Pick<EventEmitter, 'on' | 'removeListener'> & {
  webContents: Pick<EventEmitter, 'on' | 'removeListener'>
  contentView: Pick<View, 'addChildView' | 'removeChildView'>
  isDestroyed(): boolean
}

/** Electron-provided identity of a renderer asking for Platform initialization. */
export type PlatformSurfaceSender = { sender: object; senderFrame: Pick<WebFrameMain, 'url'> | null }

/** Credentials and resolved language copied into an isolated Platform preload. */
export type PlatformSurfaceBootstrap = Pick<PlatformSession, 'origin' | 'token'> & { locale: PlatformLocale }

/** Members of the upstream Platform view that the Electron main process calls. */
export interface DesktopPlatformSurface {
  /** @param next - private Host credentials, or null while signed out. */
  setSession(next: PlatformSession | null): void
  /**
   * Open a supported Platform page inside the owner window.
   * @param owner - application window containing the page.
   * @param page - explicit supported Platform page.
   * @param bounds - validated renderer rectangle.
   * @returns when loading finishes; rejects when no page can be opened.
   */
  open(owner: PlatformSurfaceOwner, page: 'usage' | 'top-up', bounds: PlatformBounds): Promise<void>
  /** @param bounds - current application viewport rectangle. */
  setBounds(bounds: PlatformBounds): void
  /**
   * Return initialization data only to the current Platform main frame.
   * @param event - Electron-provided sender identity.
   * @returns credentials and language, or null when no Platform document is open.
   */
  bootstrap(event: PlatformSurfaceSender): PlatformSurfaceBootstrap | null
  /** Notify the current document after the Desktop language changes. */
  notifyLocaleChanged(): void
  /** Destroy the current document. */
  close(): void
  /** @returns after the current document and its storage cleanup finish. */
  closeAndWait(): Promise<void>
  /** @returns after the surface stops accepting documents and its cleanup finishes. */
  dispose(): Promise<void>
}

/** Casper surface: upstream Platform pages are never shown, so it owns no native view or credentials. */
export class CasperPlatformSurface implements DesktopPlatformSurface {
  setSession(): void {}

  open(): Promise<void> {
    return Promise.reject(new Error('Upstream Platform pages are not part of Casper'))
  }

  setBounds(): void {}

  bootstrap(): null { return null }

  notifyLocaleChanged(): void {}

  close(): void {}

  closeAndWait(): Promise<void> { return Promise.resolve() }

  dispose(): Promise<void> { return Promise.resolve() }
}
