/**
 * GitHub runs every workflow file in `.github/workflows/`, so Casper CI is the only one kept there.
 * Its bubblewrap cache follows the package the setup script pins.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('GitHub workflow folder', () => {
  it('holds only Casper CI', () => {
    // GitHub runs only `.yml` and `.yaml` files placed directly in the folder.
    const workflows = readdirSync(resolve(root, '.github/workflows')).filter(name => /\.ya?ml$/.test(name)).sort()
    expect(workflows, 'move upstream workflow files to .github/upstream-workflows/, where GitHub never runs them').toEqual(['casper-ci.yml'])
  })
})

describe('Casper CI bubblewrap package', () => {
  it('restores, fetches and saves the package the setup script pins', () => {
    const script = readFileSync(resolve(root, 'scripts/prepare-ci-bubblewrap.sh'), 'utf8')
    const version = /^readonly BUBBLEWRAP_VERSION='([^']+)'$/mu.exec(script)?.[1]
    const url = /^readonly BUBBLEWRAP_URL="([^"]+)"$/mu.exec(script)?.[1]?.replaceAll('${BUBBLEWRAP_VERSION}', version ?? '')
    const deb = `bubblewrap_${version}_amd64.deb`
    const workflow = yaml.load(readFileSync(resolve(root, '.github/workflows/casper-ci.yml'), 'utf8')) as { jobs: { tests: { env: Record<string, string> } } }
    expect(version).toBeDefined()
    expect(workflow.jobs.tests.env).toEqual({
      BUBBLEWRAP_DEB: deb,
      BUBBLEWRAP_LAUNCHPAD_URL: url,
      BUBBLEWRAP_ARCHIVE_URL: `https://archive.ubuntu.com/ubuntu/pool/main/b/bubblewrap/${deb}`,
    })
  })
})
