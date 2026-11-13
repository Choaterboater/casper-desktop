import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { casperEngineEnvironment, casperEngineLayout, readBundledCasperVersion } from '../src/casper-engine.ts'

const runtime = join('/', 'App', 'Contents', 'Resources', 'runtime')

describe('casperEngineLayout', () => {
  it('puts the engine and its tools in runtime/casper, beside the primary runtime', () => {
    expect(casperEngineLayout(runtime, 'darwin')).toEqual({
      root: join(runtime, 'casper'),
      engine: join(runtime, 'casper', 'casper'),
      tools: join(runtime, 'casper', 'tools'),
      npm: join(runtime, 'casper', 'npm'),
      nodeBin: join(runtime, 'primary-runtime', 'dependencies', 'node', 'bin'),
    })
  })

  it('names the Windows engine casper.exe', () => {
    expect(casperEngineLayout(runtime, 'win32').engine).toBe(join(runtime, 'casper', 'casper.exe'))
  })
})

describe('casperEngineEnvironment', () => {
  it('hands the Host the engine and a tool path of the app\'s node, then its tools, joined as the target joins PATH', () => {
    const node = join(runtime, 'primary-runtime', 'dependencies', 'node', 'bin')
    expect(casperEngineEnvironment(runtime, 'darwin')).toEqual({
      DSH_DESKTOP_CASPER_ENGINE: join(runtime, 'casper', 'casper'),
      DSH_DESKTOP_CASPER_TOOL_PATH: `${node}:${join(runtime, 'casper', 'tools')}`,
    })
    expect(casperEngineEnvironment(runtime, 'win32').DSH_DESKTOP_CASPER_TOOL_PATH).toBe(`${node};${join(runtime, 'casper', 'tools')}`)
  })
})

describe('readBundledCasperVersion', () => {
  /** A runtime folder whose versions.json holds `content`, or none when it is undefined. */
  function runtimeWith(content: string | undefined): string {
    const folder = mkdtempSync(join(tmpdir(), 'casper-runtime-'))
    if (content !== undefined) writeFileSync(join(folder, 'versions.json'), content)
    return folder
  }

  it('reads the engine version the build recorded beside the engine', () => {
    const folder = runtimeWith(JSON.stringify({ schemaVersion: 1, node: '24.21.0', casper: { version: '0.4.15', sha256: 'a'.repeat(64) } }))
    try {
      expect(readBundledCasperVersion(folder)).toBe('0.4.15')
    } finally {
      rmSync(folder, { recursive: true })
    }
  })

  it('fails when the record is missing, not JSON, or names no version', () => {
    for (const content of [undefined, '{', 'null', '{"casper":{}}', '{"casper":{"version":"latest"}}']) {
      const folder = runtimeWith(content)
      try {
        expect(() => readBundledCasperVersion(folder)).toThrow()
      } finally {
        rmSync(folder, { recursive: true })
      }
    }
    const folder = runtimeWith('{"casper":{"version":7}}')
    try {
      expect(() => readBundledCasperVersion(folder)).toThrow(`casper desktop: ${join(folder, 'versions.json')} records no Casper engine version`)
    } finally {
      rmSync(folder, { recursive: true })
    }
  })
})
