import { globSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectCordisCatalog } from '@deepseek-ai/dsh-typert-generator'
import { CASPER_RUNTIME_EVENT_EXCLUSIONS, CASPER_RUNTIME_SERVICE_EXCLUSIONS } from './casper/cordis-catalog-exclusions.ts'
import { DESKTOP_FORBIDDEN_PACKAGES } from './casper/desktop-policy.ts'
import { CORDIS_CATALOG_POLICY } from './gen-cordis-catalog.ts'

const root = resolve(import.meta.dirname, '..')

function forbiddenDirs(): string[] {
  return globSync('packages/*/*/package.json', { cwd: root })
    .filter(path => DESKTOP_FORBIDDEN_PACKAGES.includes((JSON.parse(readFileSync(resolve(root, path), 'utf8')) as { name: string }).name))
    .map(path => `${dirname(path)}/`)
}

describe('Casper runtime Cordis catalog exclusions', () => {
  it('leaves out exactly the runtime services and events that forbidden desktop packages declare', () => {
    const dirs = forbiddenDirs()
    expect(dirs).toHaveLength(DESKTOP_FORBIDDEN_PACKAGES.length)
    const { model } = projectCordisCatalog(root, CORDIS_CATALOG_POLICY)
    const forbidden = (source: string): boolean => dirs.some(dir => source.startsWith(dir))
    expect(model.services.filter(service => forbidden(service.source)).map(service => service.key).sort())
      .toEqual([...CASPER_RUNTIME_SERVICE_EXCLUSIONS].sort())
    expect(model.events.filter(event => forbidden(event.source)).map(event => event.name).sort())
      .toEqual([...CASPER_RUNTIME_EVENT_EXCLUSIONS].sort())
  }, 300_000)
})
