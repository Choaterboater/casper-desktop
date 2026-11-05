/**
 * Host half of the Sidebar browser Client row. Mounting this package loads its Desktop Client plugin, which answers
 * `casper-sidebar-browser/request`; the Host half contributes nothing.
 * @module @deepseek-ai/dsh-casper-sidebar-browser-client
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'casper-sidebar-browser-client'

/** Register the Client entry through the plugin manifest. */
export function apply(): void {}
