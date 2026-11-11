/** Casper identity: publisher, upstream credit, website ghost, installer names, and the copied checks staying off. */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REBRAND_RULES, runRebrand } from './casper/rebrand.ts'

const root = resolve(import.meta.dirname, '..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

/** The full-colour website ghost body (64-unit grid) used by tiles and favicons. */
const GHOST = 'M12 30a20 20 0 0 1 40 0v24'
/** The one-colour ghost silhouette (24-unit grid) used by small marks and wordmarks. */
const GHOST_MARK = 'M3 11.1a9 9 0 0 1 18 0v10.8'
/** The lopsided first Casper ghost, replaced by the website ghost. */
const OLD_GHOST = 'M12 2C7.9 2 5 5.1 5 9.2V21'
/** sha256 of the upstream installer and running-status bitmaps, which still drew the old logo. */
const UPSTREAM_WHALE_SHA256: Readonly<Record<string, string>> = {
  'apps/desktop/installer/assets/brand.png': '3276df8a1d3491160e9436a4b5690444c96c1351661901a84581ff216d10fd2f',
  'apps/desktop/installer/assets/brand-2x.png': '2d3538a84ecf40619053218f9f32ee853d26614377cbcd8d3c96a9a0192ac529',
  'apps/desktop/installer/assets/brand-dark.png': '59901811702183ee8047b61ca7d0be9adc6c1bbd8f6d630f859b60b0e583cd9a',
  'apps/desktop/installer/assets/brand-dark-2x.png': 'd9ac067d453cceace270fdf17158a2dccd8df5577f35639699030d6a80c39e40',
  'apps/desktop/installer/assets/uninstaller-sidebar.png': 'f853ea4d1d54fc9aa55565ce05ae51c1f577db835636dadb74db54cd8b00e3ea',
  'packages/client/ui-chat/src/client/assets/running-whale@2x.png': '0fd990d118113d19af7af4480f2b55d610b103451a08be6f7bf5a146823f8bd3',
}
/** The opening of DeepSeek's whale path, which must not ship as Casper's mark. */
const WHALE = /M48\.8354 10\.0479|M22\.9168 1\.43018|M968\.002 326\.025/u

describe('Casper identity', () => {
  it('publishes the desktop app as Choaterboater', () => {
    const manifest = JSON.parse(read('apps/desktop/package.json')) as { author?: unknown }
    expect(manifest.author).toEqual({ name: 'Choaterboater' })
  })

  it('credits DeepSeek Harness (MIT) in the About panel and the README', () => {
    expect(read('apps/desktop/src/main.ts')).toContain("copyright: 'Choaterboater · built on DeepSeek Harness (MIT)'")
    const readme = read('README.md')
    expect(readme.split('\n')[0]).toBe('# Casper')
    expect(readme).toMatch(/built on \[DeepSeek Harness\]\(https:\/\/github\.com\/deepseek-ai\/deepseek-harness\) \(`dsh`, MIT\)/u)
    expect(readme).toContain('not an official DeepSeek product')
  })

  it('names Casper, not DeepSeek Harness, as the product in the root docs', () => {
    for (const path of ['AGENTS.md', 'SAFETY.md', 'CONTRIBUTING.md']) {
      expect(read(path), path).toContain('Casper')
      for (const line of read(path).split('\n').filter(text => text.includes('DeepSeek Harness'))) {
        expect(line, `${path}: ${line}`).toMatch(/built on|fork of|upstream|and so Casper|or DeepSeek Harness/u)
      }
    }
  })

  it('shows the Casper ghost instead of the whale on the website', () => {
    for (const path of ['website/public/favicon.svg', 'website/public/wordmark.svg']) {
      expect(read(path), path).not.toMatch(WHALE)
    }
    expect(read('website/public/favicon.svg')).toContain(GHOST)
    expect(read('website/public/wordmark.svg')).toContain(GHOST_MARK)
    expect(read('website/public/wordmark.svg')).toContain('fill="currentColor"')
  })

  it('draws the website ghost in every icon source and none of the older marks', () => {
    const colour = ['apps/desktop/resources/icon.svg', 'apps/desktop/resources/icon-macos.svg', 'apps/desktop/resources/icon-windows.svg', 'apps/web/public/favicon.svg', 'apps/web/public/favicon-dark.svg', 'packages/client/ui-primitives/src/GhostLogo.tsx']
    const mono = ['packages/client/ui-primitives/src/GhostLogo.tsx', 'apps/desktop/renderer/assets/welcome-brand.svg']
    for (const path of colour) expect(read(path), path).toContain(GHOST)
    for (const path of mono) expect(read(path), path).toContain(GHOST_MARK)
    for (const path of [...colour, ...mono]) {
      expect(read(path), path).not.toContain(OLD_GHOST)
      expect(read(path), path).not.toMatch(WHALE)
    }
    expect(read('apps/desktop/resources/icon-windows.svg')).toContain('<g id="tray-glyph"')
  })

  it('ships no installer or running-status bitmap left over from the upstream whale artwork', () => {
    const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
    expect(Object.keys(UPSTREAM_WHALE_SHA256)).toHaveLength(6)
    for (const [path, upstream] of Object.entries(UPSTREAM_WHALE_SHA256)) {
      expect(digest(readFileSync(resolve(root, path))), path).not.toBe(upstream)
    }
  })

  // The copied checks re-run the project's tests after every edit: they cost tokens without catching more bugs,
  // broke recorded web replays, and called passing checks "blocked by the sandbox".
  it('keeps the copied Casper checks switched off in the Standard, Cordis and PTC modes', () => {
    const row = /- id: casper-checks\n\s+name: '@deepseek-ai\/dsh-casper-checks'\n(?:\s+#[^\n]*\n)*\s+disabled: true\n/u
    for (const mode of ['standard', 'cordis', 'ptc']) {
      const path = `packages/bundle/web-app/presets/${mode}.patch.yml`
      expect(read(path), path).toMatch(row)
    }
  })

  it('names installers casper-<version>-<os>-<arch>', () => {
    expect(read('apps/desktop/scripts/electron-builder-config.mjs')).toContain('artifactName: `casper-\\${version}-\\${os}-\\${arch}')
    expect(read('apps/desktop/scripts/desktop-build-version-discovery.ts')).toContain('casper-(?<version>')
  })

  it('lists already-published installers under the same casper- prefix it parses', () => {
    const discovery = read('apps/desktop/scripts/desktop-build-version-discovery.ts')
    expect(discovery).toContain('Prefix: `${update.binaryKeyPrefix}/casper-`')
    expect(discovery).not.toMatch(/deepseek-harness-/u)
  })

  it('leaves no writer or reader of installer names on the old deepseek-harness- prefix', () => {
    for (const path of ['electron-builder-config.mjs', 'desktop-upload-plan.ts', 'package-macos.ts', 'package-target.ts', 'retain-desktop-ci.ts', 'installed-update-distribution.ts', 'desktop-build-version-discovery.ts']) {
      expect(read(`apps/desktop/scripts/${path}`), path).not.toMatch(/deepseek-harness-(?:\$|\(|[0-9<]|`)/u)
    }
  })

  it('applies every English product-name swap in the rebrand script', () => {
    expect(REBRAND_RULES.length).toBeGreaterThan(0)
    expect(runRebrand(root, false).map(({ rule, state }) => `${state} ${rule.file}: ${rule.from}`)).toEqual([])
  })
})
