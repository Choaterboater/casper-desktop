/** Regression tests for the generated-region grammar. */

import { describe, expect, it } from 'vitest'
import { generatedRegions, renderGeneratedRegion, spliceGeneratedRegion } from './generated-region.ts'

describe('generated regions', () => {
  const BEGIN = '<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->'
  const END = '<!-- END GENERATED cordis-surface -->'

  it('locates marker-delimited regions with their slugs and marker lines', () => {
    const doc = `# T\n\nprose\n\n${BEGIN}\ninjected\n${END}\ntail\n`
    expect(generatedRegions(doc)).toEqual([
      { slug: 'cordis-surface', begin: 4, end: 6, text: `${BEGIN}\ninjected\n${END}` },
    ])
    expect(generatedRegions('# T\n\nprose\n')).toEqual([])
  })

  it('replaces exactly one region with the same slug', () => {
    const doc = `a\n${renderGeneratedRegion('x', 'old')}\n${renderGeneratedRegion('y', 'keep')}\nb\n`
    expect(spliceGeneratedRegion(doc, renderGeneratedRegion('x', 'new\nlines')))
      .toBe(`a\n${renderGeneratedRegion('x', 'new\nlines')}\n${renderGeneratedRegion('y', 'keep')}\nb\n`)
    expect(() => spliceGeneratedRegion('a\n', renderGeneratedRegion('x', 'new')))
      .toThrow("expected exactly 1 generated region 'x', found 0")
  })

  it('rejects unbalanced or nested markers', () => {
    expect(() => generatedRegions(`${END}\n`)).toThrow('without a BEGIN')
    expect(() => generatedRegions(`${BEGIN}\n`)).toThrow('without an END')
    expect(() => generatedRegions(`${BEGIN}\n${BEGIN}\n${END}\n`)).toThrow('nested')
  })

  it('rejects mismatched slugs and malformed marker lines', () => {
    expect(() => generatedRegions('<!-- BEGIN GENERATED a -->\nx\n<!-- END GENERATED b -->\n'))
      .toThrow("END slug 'b' does not match its BEGIN slug 'a'")
    expect(() => generatedRegions('<!-- BEGIN GENERATED a --> trailing\nx\n<!-- END GENERATED a -->\n'))
      .toThrow('malformed generated region marker line')
    expect(() => generatedRegions('x\n<!-- END GENERATED a --> tail\n'))
      .toThrow('malformed generated region marker line')
  })
})
