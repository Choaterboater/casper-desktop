import { describe, expect, it } from 'vitest'
import { platformClientHeaders } from '@deepseek-ai/dsh-deepseek-account'
import type { AccountClientMetadata } from '@deepseek-ai/dsh-deepseek-account/types'
import { desktopPlatformClientHeaders } from '../src/client-headers.ts'

describe('desktop client headers', () => {
  it.each([
    ['darwin', { version: '1.2.3', locale: 'zh-CN', timezoneOffsetSeconds: 28_800 }],
    ['win32', { version: '0.2.2-alpha.3', locale: 'en-US', timezoneOffsetSeconds: -18_000 }],
    ['darwin', { version: '1.0.0', locale: 'zh_TW', timezoneOffsetSeconds: 0 }],
    ['win32', { version: '2.0.0', locale: 'fr', timezoneOffsetSeconds: 19_800 }],
  ] as const satisfies readonly (readonly ['darwin' | 'win32', AccountClientMetadata])[])(
    'matches the upstream account headers on %s for %j', (platform, client) => {
      const headers = desktopPlatformClientHeaders(platform, client)
      const upstream = platformClientHeaders(platform, client)
      expect(headers).toStrictEqual(upstream)
      expect(Object.keys(headers)).toStrictEqual(Object.keys(upstream))
    })
})
