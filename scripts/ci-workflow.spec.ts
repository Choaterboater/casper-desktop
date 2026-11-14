import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('CI scripts and Vitest configuration', () => {
  it('splits both Wine TypeScript faces and retains their aggregate heap budgets', () => {
    const wineGates = readFileSync(resolve(root, 'scripts/wine-windows-gates.sh'), 'utf8')

    const references = wineGates.indexOf(
      'wine_node "$scratch/logs/host-references.log" --import tsx/esm scripts/compile-referenced-projects.ts host',
    )
    const aggregate = wineGates.indexOf(
      'wine_node "$scratch/logs/host-tsc.log" --max-old-space-size=8192 "$tsc_js" -p tsconfig.host.json --pretty false',
    )
    const metadata = wineGates.indexOf('wine_node "$scratch/logs/host-typert.log" --import tsx/esm scripts/generate-typert.ts')
    expect(metadata).toBeGreaterThan(-1)
    expect(references).toBeGreaterThan(metadata)
    expect(aggregate).toBeGreaterThan(references)
    expect(wineGates).not.toContain('-b tsconfig.host.json')
    const clientReferences = wineGates.indexOf('wine_node "$scratch/logs/client-references.log" --import tsx/esm scripts/compile-referenced-projects.ts client')
    const clientAggregate = wineGates.indexOf('wine_node "$scratch/logs/client-tsc.log" --max-old-space-size=8192 "$tsc_js" -p tsconfig.client.json --pretty false')
    expect(clientReferences).toBeGreaterThan(aggregate)
    expect(clientAggregate).toBeGreaterThan(clientReferences)
    expect(wineGates).not.toContain('-b tsconfig.client.json')
    expect(wineGates).toContain('  "$scratch/logs/client-references.log" \\')
  })

  it('keeps supported LSP source under native Windows coverage', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain('packages/lsp/lsp-stdio/src/connection.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/index.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/instance.ts')
  })

  it('keeps every Vitest project process-isolated on native Windows', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain("pool: process.platform === 'win32' ? 'threads' : 'forks'")
    expect(config.match(/pool: 'forks'/g)).toHaveLength(2)
  })

  it('applies the lane test budget inside every Vitest project', () => {
    // Each inline project spreads coverageTestTimeoutOptions, the only route
    // for DSH_COVERAGE_TEST_TIMEOUT_MS into projects; the behavior itself is
    // pinned by scripts/lane-test-budget.spec.ts.
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).toContain('const laneTestBudget = coverageTestTimeoutOptions(process.env[COVERAGE_TEST_TIMEOUT_ENV])')
    expect(config.match(/^ {10}\.\.\.laneTestBudget,$/gm)).toHaveLength(2)
  })
})

describe('bubblewrap preparation script', () => {
  it('pins bubblewrap to a recorded Launchpad build and excludes Ubuntu pool downloads', () => {
    const script = readFileSync(resolve(root, 'scripts/prepare-ci-bubblewrap.sh'), 'utf8')
    const url = /^readonly BUBBLEWRAP_URL="([^"]+)"$/mu.exec(script)?.[1]

    expect(url).toMatch(
      /^https:\/\/launchpad\.net\/ubuntu\/\+source\/bubblewrap\/[^/]+\/\+build\/\d+\/\+files\/bubblewrap_[^/]+_amd64\.deb$/u,
    )
    // Ubuntu removes superseded versions from its live package pool.
    expect(script).not.toMatch(/https?:\/\/[^/'"\s]+\/ubuntu(?:-ports)?\/pool\//u)
  })
})
