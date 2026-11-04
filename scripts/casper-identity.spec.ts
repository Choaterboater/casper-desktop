/** Casper identity: publisher, upstream credit, website ghost and installer names. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

/** The ghost body every Casper icon shares. */
const GHOST = 'M12 2C7.9 2 5 5.1 5 9.2V21'
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
      expect(read(path), path).toContain(GHOST)
      expect(read(path), path).not.toMatch(WHALE)
    }
    expect(read('website/public/wordmark.svg')).toContain('fill="currentColor"')
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
})
