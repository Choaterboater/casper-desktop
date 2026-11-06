/** `app_read_file`: reads inside the app's folders only, in line windows, with size and listing limits. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appReadRoots, isInside, isInstalled, LIST_MAX_ENTRIES, readAppFile, READ_MAX_BYTES, READ_MAX_LINES } from '../src/app-read.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/** An install folder, a profile folder, and an outside folder under one temporary root. */
function folders() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-casper-app-read-')))
  cleanups.push(() => { rmSync(root, { recursive: true, force: true }) })
  const install = join(root, 'app', 'node_modules')
  const skill = join(install, '@deepseek-ai', 'dsh-agent-preset', 'skills', 'cordis-plugin-development')
  const profile = join(root, 'profile', 'node_modules')
  const outside = join(root, 'outside')
  for (const dir of [join(skill, 'references'), join(profile, 'my-bundle'), outside, join(root, 'app', 'node_modules-sibling')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), 'line 0\nline 1\nline 2\nline 3\n')
  writeFileSync(join(skill, 'references', 'ui-plugin.md'), '# UI plugins\n')
  writeFileSync(join(profile, 'my-bundle', 'README.md'), 'profile bundle\n')
  writeFileSync(join(outside, 'secret.txt'), 'outside\n')
  writeFileSync(join(root, 'app', 'node_modules-sibling', 'x.md'), 'sibling\n')
  return { root, install, skill, profile, outside, roots: [install, profile] }
}

/** Assert that `read` is a refusal whose text contains `fragment`. */
function refused(read: { text: string; isError: boolean }, fragment = ''): void {
  expect(read.isError).toBe(true)
  expect(read.text).toContain(fragment)
}

describe('appReadRoots', () => {
  it('uses the installed node_modules folder and the profile node_modules', () => {
    const anchor = join(sep, 'Applications', 'App.app', 'Contents', 'Resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-casper-agent', 'lib', 'index.js')
    expect(appReadRoots(anchor, join(sep, 'profiles', 'desktop'))).toEqual([
      join(sep, 'Applications', 'App.app', 'Contents', 'Resources', 'app.asar', 'dsh', 'node_modules'),
      join(sep, 'profiles', 'desktop', 'node_modules'),
    ])
  })

  it('uses a source checkout\'s packages and docs folders, and no profile folder without a profile', () => {
    const anchor = join(sep, 'work', 'checkout', 'packages', 'casper', 'casper-agent', 'src', 'app-read.ts')
    expect(appReadRoots(anchor, undefined)).toEqual([join(sep, 'work', 'checkout', 'packages'), join(sep, 'work', 'checkout', 'docs')])
  })

  it('tells an installed package folder from a source checkout', () => {
    expect(isInstalled(join(sep, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-casper-agent', 'lib', 'index.js'))).toBe(true)
    expect(isInstalled(join(sep, 'work', 'checkout', 'packages', 'casper', 'casper-agent', 'src', 'app-read.ts'))).toBe(false)
  })
})

describe('readAppFile', () => {
  it('reads a file inside the install folder and inside the profile folder', async () => {
    const { skill, profile, roots } = folders()
    expect(await readAppFile(roots, { path: join(skill, 'references', 'ui-plugin.md') })).toEqual({ text: '# UI plugins\n', isError: false })
    expect(await readAppFile(roots, { path: join(profile, 'my-bundle', 'README.md') })).toEqual({ text: 'profile bundle\n', isError: false })
  })

  it('returns a line window and says where to continue', async () => {
    const { skill, roots } = folders()
    const read = await readAppFile(roots, { path: join(skill, 'SKILL.md'), offset: 1, limit: 2 })
    expect(read).toEqual({ text: 'line 1\nline 2\n[app_read_file: lines 1-2 of 5; continue with offset 3]', isError: false })
    expect((await readAppFile(roots, { path: join(skill, 'SKILL.md'), offset: 3 })).text).toBe('line 3\n')
  })

  it('refuses a relative path, a .. escape, a sibling folder with the same prefix, and a folder outside', async () => {
    const { root, install, outside, roots } = folders()
    refused(await readAppFile(roots, { path: 'node_modules/x' }), 'absolute')
    refused(await readAppFile(roots, { path: `${install}${sep}..${sep}..${sep}outside${sep}secret.txt` }), 'outside the app')
    expect(await readAppFile(roots, { path: join(root, 'app', 'node_modules-sibling', 'x.md') })).toMatchObject({ isError: true })
    expect(await readAppFile(roots, { path: join(outside, 'secret.txt') })).toMatchObject({ isError: true })
  })

  it.skipIf(process.platform === 'win32')('refuses a symlink inside a root that leads outside it', async () => {
    const { install, outside, roots } = folders()
    symlinkSync(outside, join(install, 'escape'))
    symlinkSync(join(outside, 'secret.txt'), join(install, 'secret-link.txt'))
    refused(await readAppFile(roots, { path: join(install, 'escape', 'secret.txt') }), 'outside the app')
    expect(await readAppFile(roots, { path: join(install, 'secret-link.txt') })).toMatchObject({ isError: true })
  })

  it('reports a missing file and bad windows as errors', async () => {
    const { install, skill, roots } = folders()
    refused(await readAppFile(roots, { path: join(install, 'missing.md') }), 'could not be read')
    expect(await readAppFile(roots, { path: join(skill, 'SKILL.md'), offset: -1 })).toMatchObject({ isError: true })
    expect(await readAppFile(roots, { path: join(skill, 'SKILL.md'), limit: 0 })).toMatchObject({ isError: true })
    expect(await readAppFile(roots, { path: join(skill, 'SKILL.md'), limit: READ_MAX_LINES + 1 })).toMatchObject({ isError: true })
  })

  it('caps one read at 256 KB', async () => {
    const { install, roots } = folders()
    const line = 'x'.repeat(1023)
    writeFileSync(join(install, 'big.txt'), Array.from({ length: 400 }, () => line).join('\n'))
    const read = await readAppFile(roots, { path: join(install, 'big.txt') })
    expect(read.isError).toBe(false)
    const [body, note] = read.text.split('\n[app_read_file: ')
    expect(Buffer.byteLength(body ?? '')).toBeLessThanOrEqual(READ_MAX_BYTES)
    expect(note).toMatch(/^lines 0-255 of 400; continue with offset 256\]$/)
  })

  it('sends the head of a line longer than one read and continues after it', async () => {
    const { install, roots } = folders()
    writeFileSync(join(install, 'min.js'), `${'a'.repeat(300 * 1024)}\nsecond line`)
    const first = await readAppFile(roots, { path: join(install, 'min.js') })
    expect(first.isError).toBe(false)
    const [head, note] = first.text.split('\n[app_read_file: ')
    expect(head).toBe('a'.repeat(READ_MAX_BYTES))
    expect(note).toBe(`line 0 is ${300 * 1024} bytes, cut to its first ${READ_MAX_BYTES}; lines 0-0 of 2; continue with offset 1]`)
    expect(await readAppFile(roots, { path: join(install, 'min.js'), offset: 1 })).toEqual({ text: 'second line', isError: false })
  })

  it('cuts an overlong line on a whole character and says so when it is the last line', async () => {
    const { install, roots } = folders()
    // 'a' then two-byte characters: byte READ_MAX_BYTES falls inside one, so the cut steps back a byte.
    writeFileSync(join(install, 'wide.css'), `a${'é'.repeat(READ_MAX_BYTES)}`)
    const read = await readAppFile(roots, { path: join(install, 'wide.css') })
    const [head, note] = read.text.split('\n[app_read_file: ')
    expect(head).toBe(`a${'é'.repeat(READ_MAX_BYTES / 2 - 1)}`)
    expect(Buffer.byteLength(head ?? '')).toBe(READ_MAX_BYTES - 1)
    expect(note).toBe(`line 0 is ${1 + READ_MAX_BYTES * 2} bytes, cut to its first ${READ_MAX_BYTES - 1}]`)
  })

  it('refuses a file too large to load and reports a path under a root that does not exist', async () => {
    const { root, install, roots } = folders()
    writeFileSync(join(install, 'huge.log'), '')
    truncateSync(join(install, 'huge.log'), 33 * 1024 * 1024)
    refused(await readAppFile(roots, { path: join(install, 'huge.log') }), 'too large')
    const gone = join(root, 'profile-not-created', 'node_modules')
    refused(await readAppFile([gone], { path: join(gone, 'x.md') }), 'could not be read')
  })

  it('returns a note for a binary file and text for an SVG', async () => {
    const { install, roots } = folders()
    writeFileSync(join(install, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
    writeFileSync(join(install, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    const png = await readAppFile(roots, { path: join(install, 'icon.png') })
    expect(png.isError).toBe(false)
    expect(png.text).toContain('binary file (7 bytes)')
    expect(await readAppFile(roots, { path: join(install, 'icon.svg') })).toEqual({ text: '<svg xmlns="http://www.w3.org/2000/svg"/>', isError: false })
  })

  it('lists a folder, at most 500 entries', async () => {
    const { install, skill, roots } = folders()
    const top = JSON.parse((await readAppFile(roots, { path: skill })).text) as { path: string; entries: { name: string; dir: boolean }[] }
    expect(top.path).toBe(skill)
    expect(top.entries).toContainEqual({ name: 'SKILL.md', dir: false })
    expect(top.entries).toContainEqual({ name: 'references', dir: true })
    const many = join(install, 'many')
    mkdirSync(many)
    for (let at = 0; at < LIST_MAX_ENTRIES + 3; at++) writeFileSync(join(many, `f${at}`), '')
    const listing = JSON.parse((await readAppFile(roots, { path: many })).text) as { entries: unknown[]; more: number }
    expect(listing.entries).toHaveLength(LIST_MAX_ENTRIES)
    expect(listing.more).toBe(3)
  })
})

describe('isInside', () => {
  it('compares by relative path, never by string prefix', () => {
    expect(isInside(join(sep, 'a', 'b'), join(sep, 'a', 'b'))).toBe(true)
    expect(isInside(join(sep, 'a', 'b'), join(sep, 'a', 'b', 'c'))).toBe(true)
    expect(isInside(join(sep, 'a', 'b'), join(sep, 'a', 'bc'))).toBe(false)
    expect(isInside(join(sep, 'a', 'b'), join(sep, 'a'))).toBe(false)
    expect(isInside(join(sep, 'a', 'b'), join(sep, 'a', 'b', '..', 'c'))).toBe(false)
  })
})
