import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  extendArchiveManifest,
  parseArchiveManifest,
  renderArchiveManifest,
  validateArchiveArtifacts,
  validateArchiveManifestExtension,
  withoutLanguageSwitcher,
  type ArchiveManifest,
  type SealedArtifactReader,
} from './archived-agent-notes.ts'
import { isArchivedAgentNotePath } from './repo-files.ts'

const BASE = '2026-07-26-example'
const PATH = `process/${BASE}.md`

function fixture(): Map<string, Buffer> {
  return new Map([[PATH, Buffer.from('# Agent Note: Example\n\nStatus: implemented\nArchived: 2026-07-26\n\n## Problem\n\nExample.\n')]])
}

function hash(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

const noBaseline: SealedArtifactReader = () => undefined

/** A sealed note and its retired companions as they existed before the archive became English-only. */
function translatedBaseline(): { manifest: ArchiveManifest; sealed: Buffer; reader: SealedArtifactReader } {
  const sealed = Buffer.from(`# Agent Note: Example\n\nStatus: implemented\nArchived: 2026-07-26\n\nEnglish | [中文](${BASE}.zh.md)\n\n## Problem\n\nExample.\n`)
  const manifest: ArchiveManifest = { version: 1, files: {
    [PATH]: hash(sealed),
    [`process/${BASE}.zh.md`]: `sha256:${'1'.repeat(64)}`,
    [`process/${BASE}.i18n.yaml`]: `sha256:${'2'.repeat(64)}`,
  } }
  return { manifest, sealed, reader: path => path === PATH ? sealed : undefined }
}

describe('archived Agent Notes', () => {
  it('recognizes archived paths with POSIX and Windows separators', () => {
    expect(isArchivedAgentNotePath('.agents/notes/archived/process/example.md')).toBe(true)
    expect(isArchivedAgentNotePath('.agents\\notes\\archived\\process\\example.md')).toBe(true)
    expect(isArchivedAgentNotePath('.agents/notes/implemented/process/example.md')).toBe(false)
  })

  it('accepts one implemented note with matching archive metadata', () => {
    expect(validateArchiveArtifacts(fixture())).toEqual([])
  })

  it.each(['# Agent Note：Example', '# Historical decision'])('preserves historical formatting: %s', (title) => {
    const artifacts = fixture()
    artifacts.set(PATH, Buffer.from(`${title}\nStatus: implemented\nArchived: 2026-07-26\n`))
    expect(validateArchiveArtifacts(artifacts)).toEqual([])
  })

  it.each([
    ['Status: proposed\nArchived: 2026-07-26', /requires `Status: implemented`/],
    ['Status: implemented\n\nArchived: 2026-07-26', /immediately after the status/],
    ['Status: implemented\nArchived: 2026-02-30', /valid date/],
    ['Status: implemented\nArchived: 2026-07-25', /predates the note filename/],
  ])('rejects invalid archive metadata: %s', (metadata, error) => {
    const artifacts = fixture()
    artifacts.set(PATH, Buffer.from(`# Historical decision\n${metadata}\n`))
    expect(validateArchiveArtifacts(artifacts).join('\n')).toMatch(error)
  })

  it.each([`process/${BASE}.zh.md`, `process/${BASE}.i18n.yaml`, `process/${BASE}.txt`])('rejects a non-English artifact %s', (path) => {
    const artifacts = fixture()
    artifacts.set(path, Buffer.from('content\n'))
    expect(validateArchiveArtifacts(artifacts)).toEqual([`${path}: expected {kind}/yyyy-mm-dd-topic.md`])
  })

  it('extends the manifest without permitting a sealed change or removal', () => {
    const artifacts = fixture()
    const first = extendArchiveManifest({ version: 1, files: {} }, artifacts, noBaseline)
    expect(first).toMatchObject({ errors: [], added: [PATH], retired: [] })

    const sealed: ArchiveManifest = { version: 1, files: first.files }
    const changed = new Map(artifacts)
    changed.set(PATH, Buffer.from('changed'))
    expect(extendArchiveManifest(sealed, changed, () => artifacts.get(PATH)).errors).toEqual([`${PATH}: sealed content hash changed`])
    changed.delete(PATH)
    expect(extendArchiveManifest(sealed, changed, noBaseline).errors).toEqual([`${PATH}: sealed artifact is missing`])
  })

  it('rejects replacing manifest seals alongside changed archive content', () => {
    const artifacts = fixture()
    const baseline: ArchiveManifest = { version: 1, files: extendArchiveManifest({ version: 1, files: {} }, artifacts, noBaseline).files }
    const changedArtifacts = new Map(artifacts)
    changedArtifacts.set(PATH, Buffer.from('changed'))
    const replacement = extendArchiveManifest({ version: 1, files: {} }, changedArtifacts, noBaseline)
    const current: ArchiveManifest = { version: 1, files: replacement.files }
    const reader: SealedArtifactReader = () => artifacts.get(PATH)

    expect(extendArchiveManifest(current, changedArtifacts, reader).errors).toEqual([])
    expect(validateArchiveManifestExtension(baseline, current, reader)).toEqual([`${PATH}: sealed manifest hash changed`])
    expect(validateArchiveManifestExtension(baseline, { version: 1, files: {} }, reader)).toEqual([`${PATH}: sealed manifest entry is missing`])
  })

  it('records the English-only retirement of language switchers and translation seals', () => {
    const { manifest, sealed, reader } = translatedBaseline()
    const retired = withoutLanguageSwitcher(PATH, sealed)
    expect(retired.toString('utf8')).not.toContain('中文')
    const artifacts = new Map([[PATH, retired]])
    const extended = extendArchiveManifest(manifest, artifacts, reader)
    expect(extended).toEqual({ files: { [PATH]: hash(retired) }, added: [], retired: [PATH, `process/${BASE}.zh.md`, `process/${BASE}.i18n.yaml`], errors: [] })
    expect(validateArchiveArtifacts(artifacts)).toEqual([])
    expect(validateArchiveManifestExtension(manifest, { version: 1, files: extended.files }, reader)).toEqual([])
    const recorded: ArchiveManifest = { version: 1, files: extended.files }
    expect(extendArchiveManifest(recorded, artifacts, noBaseline)).toMatchObject({ added: [], retired: [], errors: [] })
  })

  it('permits no other change during the English-only retirement', () => {
    const { manifest, sealed, reader } = translatedBaseline()
    const edited = Buffer.from(withoutLanguageSwitcher(PATH, sealed).toString('utf8').replace('Example.', 'Edited.'))
    expect(extendArchiveManifest(manifest, new Map([[PATH, edited]]), reader).errors).toEqual([`${PATH}: sealed content hash changed`])
    const current: ArchiveManifest = { version: 1, files: { [PATH]: hash(edited) } }
    expect(validateArchiveManifestExtension(manifest, current, reader)).toEqual([`${PATH}: sealed manifest hash changed`])
    const retired: ArchiveManifest = { version: 1, files: { [PATH]: hash(withoutLanguageSwitcher(PATH, sealed)) } }
    expect(validateArchiveManifestExtension(manifest, retired, noBaseline)).toEqual([`${PATH}: sealed manifest hash changed`])
    expect(validateArchiveManifestExtension(manifest, { ...retired, files: { ...retired.files, [`process/${BASE}.zh.md`]: manifest.files[`process/${BASE}.zh.md`]! } }, reader))
      .toEqual([`process/${BASE}.zh.md: retired translation seal must leave the manifest`])
    const unswitched = fixture().get(PATH)!
    expect(withoutLanguageSwitcher(PATH, unswitched)).toBe(unswitched)
  })

  it('round-trips the deterministic manifest schema', () => {
    const content = renderArchiveManifest({ 'process/z.md': `sha256:${'a'.repeat(64)}` })
    expect(parseArchiveManifest(content)).toEqual({
      version: 1,
      files: { 'process/z.md': `sha256:${'a'.repeat(64)}` },
    })
  })
})
