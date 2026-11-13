/** Desktop-owned Platform client identity headers, with the same names and values as the upstream account helper. */
import type { AccountClientMetadata } from '@deepseek-ai/dsh-deepseek-account/types'

/**
 * Reduce a UI language to the region-tagged locale the Platform service expects.
 * @param locale - active UI language such as `zh-CN`, `zh_TW`, or `en-US`.
 * @returns `zh_CN` for any Chinese language, otherwise `en_US`.
 */
function wireLocale(locale: string): 'zh_CN' | 'en_US' {
  return locale.toLowerCase().split(/[-_]/)[0] === 'zh' ? 'zh_CN' : 'en_US'
}

/**
 * Build the client identity headers for one desktop request.
 * @param platform - operating system this shell runs on.
 * @param client - identity of the requesting UI, sampled for this request.
 * @returns the bundle ID (intentionally empty), desktop platform, version, region-tagged locale, and UTC offset in seconds east.
 */
export function desktopPlatformClientHeaders(platform: 'darwin' | 'win32', client: AccountClientMetadata): Record<string, string> {
  return {
    'x-client-bundle-id': '',
    'x-client-platform': platform === 'win32' ? 'desktop-win' : 'desktop-mac',
    'x-client-version': client.version,
    'x-client-locale': wireLocale(client.locale),
    'x-client-timezone-offset': String(client.timezoneOffsetSeconds),
  }
}
