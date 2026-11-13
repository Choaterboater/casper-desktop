/**
 * The Casper desktop profile's bundle list, and the move of an existing profile off upstream's Web template bundles.
 * @module
 */

import { join } from 'node:path'
import { readProfileManifest, writeProfileBundles } from '@deepseek-ai/dsh-app-boot'

/** The bundle a desktop profile composes from: upstream's base and Web layers without the upstream service rows. */
export const CASPER_DESKTOP_BUNDLE = '@deepseek-ai/dsh-casper-desktop'

/** Bundles of upstream's Web profile template that {@link CASPER_DESKTOP_BUNDLE} replaces in a desktop profile. */
export const REPLACED_DESKTOP_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** Template bundles of a new desktop profile, and the list native recovery restores. */
export const CASPER_DESKTOP_BUNDLES: readonly string[] = [CASPER_DESKTOP_BUNDLE]

/**
 * Rewrite the desktop profile's `dsh.profile.bundles` so {@link CASPER_DESKTOP_BUNDLE} takes the position of the first
 * template bundle it lists (the Casper bundle or one of {@link REPLACED_DESKTOP_BUNDLES}), the other template bundles
 * are dropped, and every other bundle keeps its order. Writes only when the list changes; every other manifest field is
 * kept. The caller holds the desktop profile lock with the Host stopped.
 * @param profileDir - The desktop profile directory, whose `package.json` exists.
 * @returns Whether the manifest was rewritten.
 * @throws {Error} When the manifest cannot be read, when `dsh.profile.bundles` is not a list of package names, or when
 *   it names no template bundle; the manifest is then left unchanged, and native recovery
 *   (`DesktopProjectManager.disableAllPlugins`) restores the template.
 */
export function migrateCasperDesktopBundles(profileDir: string): boolean {
  const manifest = readProfileManifest('dsh', profileDir)
  const path = join(profileDir, 'package.json')
  // The manifest is file data: its declared type is not trusted until the list is checked.
  const declared: unknown = manifest.dsh?.profile?.bundles
  if (!Array.isArray(declared) || !declared.every((name): name is string => typeof name === 'string')) {
    throw new Error(`desktop project: dsh.profile.bundles in ${path} must be a list of package names`)
  }
  const template = new Set([CASPER_DESKTOP_BUNDLE, ...REPLACED_DESKTOP_BUNDLES])
  const first = declared.findIndex(name => template.has(name))
  if (first === -1) {
    throw new Error(`desktop project: ${path} lists no ${CASPER_DESKTOP_BUNDLE}; restore it with the recovery dialog's `
      + '"Disable third-party plugins, back up profile patch, and restart"')
  }
  const bundles = declared.flatMap((name, index) => {
    if (index === first) return [CASPER_DESKTOP_BUNDLE]
    return template.has(name) ? [] : [name]
  })
  if (bundles.length === declared.length && bundles.every((name, index) => name === declared[index])) return false
  writeProfileBundles(profileDir, manifest, bundles)
  return true
}
