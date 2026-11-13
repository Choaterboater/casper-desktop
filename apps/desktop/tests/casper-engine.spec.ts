import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { casperEngineEnvironment, casperEngineLayout } from '../src/casper-engine.ts'

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
