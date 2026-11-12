/** GitHub runs every workflow file in `.github/workflows/`, so Casper CI is the only one kept there. */

import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('GitHub workflow folder', () => {
  it('holds only Casper CI', () => {
    // GitHub runs only `.yml` and `.yaml` files placed directly in the folder.
    const workflows = readdirSync(resolve(root, '.github/workflows')).filter(name => /\.ya?ml$/.test(name)).sort()
    expect(workflows, 'move upstream workflow files to .github/upstream-workflows/, where GitHub never runs them').toEqual(['casper-ci.yml'])
  })
})
