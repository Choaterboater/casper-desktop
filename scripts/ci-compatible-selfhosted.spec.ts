import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { BUILD_BACKED_NODE_COMPAT_VERSION } from './run-gates.ts'

it('declares the build-backed compatibility minor for installed CLI users', () => {
  for (const manifest of ['package.json', 'apps/cli/package.json']) {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', manifest), 'utf8')) as { engines: { node: string } }
    expect(pkg.engines.node).toBe(`>=${BUILD_BACKED_NODE_COMPAT_VERSION}.0`)
  }
})
