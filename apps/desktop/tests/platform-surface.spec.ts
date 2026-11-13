import { EventEmitter } from 'node:events'
import { expect, it } from 'vitest'
import { CasperPlatformSurface, type DesktopPlatformSurface } from '../src/platform-surface.ts'

it('never opens a Platform document or returns initialization data', async () => {
  const surface: DesktopPlatformSurface = new CasperPlatformSurface()
  const owner = Object.assign(new EventEmitter(), {
    webContents: new EventEmitter(),
    contentView: { addChildView() {}, removeChildView() {} },
    isDestroyed: () => false,
  })
  const bounds = { x: 0, y: 0, width: 100, height: 100 }
  surface.setSession({ origin: 'https://platform.example.com', token: 'secret', userId: null })
  await expect(surface.open(owner, 'usage', bounds)).rejects.toThrow('Upstream Platform pages are not part of Casper')
  expect(surface.bootstrap({ sender: {}, senderFrame: { url: 'https://platform.example.com/usage' } })).toBeNull()
  surface.setBounds(bounds)
  surface.notifyLocaleChanged()
  surface.close()
  await expect(surface.closeAndWait()).resolves.toBeUndefined()
  await expect(surface.dispose()).resolves.toBeUndefined()
})
