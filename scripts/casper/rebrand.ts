/**
 * Casper rebrand rules: exact in-place swaps of upstream product copy that upstream owns: the
 * product name in English here, and brand-free wording and the product name in every language in
 * `rebrand-product-copy.ts`. After merging an upstream release, take upstream's version of a
 * conflicting file and run `node --import tsx/esm scripts/casper/rebrand.ts` to re-apply;
 * `--check` exits 1 when a swap is still pending or upstream reworded a line. `--against <ref>`
 * applies every rule in memory to the files as they are at an upstream git ref, such as the
 * upstream import commit, and exits 1 when a rule's `from` is not that ref's text or a rule
 * changes nothing there.
 *
 * The `dsh` command, package, folder, environment-variable and storage names keep their upstream
 * names. Each `from` is upstream text, usually whole source lines, that must occur exactly once in
 * its file, or exactly `count` times for text that repeats, so other languages never match.
 * @module scripts/casper/rebrand
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PRODUCT_COPY_REBRAND_RULES } from './rebrand-product-copy.ts'

/** One exact text swap in one repository file. */
export interface RebrandRule {
  /** Repository-relative path. */
  readonly file: string
  /** Upstream text, unique in the file unless {@link RebrandRule.count} says how often it repeats. */
  readonly from: string
  /** Casper text that replaces it. */
  readonly to: string
  /** Exact number of occurrences, for text that repeats in a file (such as test assertions); every one is swapped. Default 1. */
  readonly count?: number
}

/** Where a rule stands against a file's current text. */
export type RuleState = 'pending' | 'applied' | 'stale' | 'ambiguous'

/** Casper's English product-name swaps, grouped by file. */
const PRODUCT_NAME_REBRAND_RULES: readonly RebrandRule[] = [
  // apps/desktop/src/locale.ts
  { file: 'apps/desktop/src/locale.ts',
    from: 'startupAddressInUse: \'Another DSH instance (such as dsh web or the desktop app) is running. They cannot start at the same time. Quit the other running DSH instance, then restart.\',',
    to: 'startupAddressInUse: \'Another Casper instance is running. They cannot start at the same time. Quit the other running Casper instance, then restart.\',' },
  // packages/client/ui-agent-preset/src/client/locales.ts
  { file: 'packages/client/ui-agent-preset/src/client/locales.ts',
    from: 'sectionIntro: \'Choose the agent’s tools and how it works. Use Standard mode for everyday tasks, or Creator mode to add capabilities to DSH.\',',
    to: 'sectionIntro: \'Choose the agent’s tools and how it works. Use Standard mode for everyday tasks, or Creator mode to add capabilities to Casper.\',' },
  { file: 'packages/client/ui-agent-preset/src/client/locales.ts',
    from: '\'Customize DSH through conversation. Let the agent write plugins that add features or UI, or combine tools and prompts to create your own mode.\',',
    to: '\'Customize Casper through conversation. Let the agent write plugins that add features or UI, or combine tools and prompts to create your own mode.\',' },
  { file: 'packages/client/ui-agent-preset/src/client/locales.ts',
    from: 'createPluginDescription: \'Enter Creator mode and make your own DSH plugin\',',
    to: 'createPluginDescription: \'Enter Creator mode and make your own Casper plugin\',' },
  // packages/client/ui-chat/src/client/conversation-nodes/turn-error.ts
  { file: 'packages/client/ui-chat/src/client/conversation-nodes/turn-error.ts',
    from: 'return { message: \'The DSH process exited before this turn finished.\', code: \'INTERRUPTED\' }',
    to: 'return { message: \'The Casper process exited before this turn finished.\', code: \'INTERRUPTED\' }' },
  // packages/client/ui-chat/src/client/locale.ts
  { file: 'packages/client/ui-chat/src/client/locale.ts',
    from: '\'message.failure.interrupted\': \'The DSH process exited before this turn finished (for example, it was killed, crashed, or timed out while shutting down), so the turn was closed when DSH restarted. Unfinished tool calls have unknown outcomes.\',',
    to: '\'message.failure.interrupted\': \'The Casper process exited before this turn finished (for example, it was killed, crashed, or timed out while shutting down), so the turn was closed when Casper restarted. Unfinished tool calls have unknown outcomes.\',' },
  // packages/client/ui-conversation/src/client/locales.ts
  { file: 'packages/client/ui-conversation/src/client/locales.ts',
    from: '\'error.sessionInUse\': \'This session is already in use, possibly by another running DSH instance (such as dsh web or the desktop app). Quit other running DSH instances and try again.\',',
    to: '\'error.sessionInUse\': \'This session is already in use, possibly by another running Casper instance. Quit other running Casper instances and try again.\',' },
  // packages/client/ui-entry-customization/src/client/locales.ts
  { file: 'packages/client/ui-entry-customization/src/client/locales.ts',
    from: '\'createPrompt.sidebar\': \'Create a DSH plugin with a left sidebar entry.\',',
    to: '\'createPrompt.sidebar\': \'Create a Casper plugin with a left sidebar entry.\',' },
  { file: 'packages/client/ui-entry-customization/src/client/locales.ts',
    from: '\'createPrompt.conversation\': \'Create a DSH conversation view plugin.\',',
    to: '\'createPrompt.conversation\': \'Create a Casper conversation view plugin.\',' },
  { file: 'packages/client/ui-entry-customization/src/client/locales.ts',
    from: '\'createPrompt.rightbar\': \'Create a DSH plugin with a right sidebar entry.\',',
    to: '\'createPrompt.rightbar\': \'Create a Casper plugin with a right sidebar entry.\',' },
  // packages/client/ui-model-selection/src/client/locales.ts
  { file: 'packages/client/ui-model-selection/src/client/locales.ts',
    from: '\'error.sessionInUse\': \'This session is already in use, possibly by another running DSH instance (such as dsh web or the desktop app). Quit other running DSH instances and try again.\',',
    to: '\'error.sessionInUse\': \'This session is already in use, possibly by another running Casper instance. Quit other running Casper instances and try again.\',' },
  // packages/client/ui-plugin-manager/src/client/locales.ts
  { file: 'packages/client/ui-plugin-manager/src/client/locales.ts',
    from: 'restartNotice: \'Restart DSH to apply the change. {reason}\',',
    to: 'restartNotice: \'Restart Casper to apply the change. {reason}\',' },
  { file: 'packages/client/ui-plugin-manager/src/client/locales.ts',
    from: 'restartReasonPackageMoved: \'An installed package now resolves to another directory, or the change replaces a package the DSH installation provides. Uninstall a package before installing it from another location.\',',
    to: 'restartReasonPackageMoved: \'An installed package now resolves to another directory, or the change replaces a package the Casper installation provides. Uninstall a package before installing it from another location.\',' },
  { file: 'packages/client/ui-plugin-manager/src/client/locales.ts',
    from: 'restartReasonHostModule: \'The change reaches modules DSH itself loaded.\',',
    to: 'restartReasonHostModule: \'The change reaches modules Casper itself loaded.\',' },
  { file: 'packages/client/ui-plugin-manager/src/client/locales.ts',
    from: 'restartReasonModuleComparison: \'DSH could not compare the loaded plugins with their files.\',',
    to: 'restartReasonModuleComparison: \'Casper could not compare the loaded plugins with their files.\',' },
  { file: 'packages/client/ui-plugin-manager/src/client/locales.ts',
    from: 'installUpgradeNotice: \'On-demand official plugins offer Update when their version differs from DSH. To update other plugins, uninstall and reinstall them.\',',
    to: 'installUpgradeNotice: \'On-demand official plugins offer Update when their version differs from Casper. To update other plugins, uninstall and reinstall them.\',' },
  { file: 'packages/client/ui-plugin-manager/src/client/locales.ts',
    from: 'installProblemShipped: \'This plugin ships with DSH; upgrading DSH updates it\',',
    to: 'installProblemShipped: \'This plugin ships with Casper; upgrading Casper updates it\',' },
  { file: 'packages/client/ui-plugin-manager/src/client/locales.ts',
    from: 'installBundledTitle: \'This plugin ships with DSH\',',
    to: 'installBundledTitle: \'This plugin ships with Casper\',' },
  { file: 'packages/client/ui-plugin-manager/src/client/locales.ts',
    from: 'sourceTargetSpec: \'Source for this DSH\',',
    to: 'sourceTargetSpec: \'Source for this Casper\',' },
  { file: 'packages/client/ui-plugin-manager/src/client/locales.ts',
    from: 'sourceTargetVersion: \'Version for this DSH\',',
    to: 'sourceTargetVersion: \'Version for this Casper\',' },
  { file: 'packages/client/ui-plugin-manager/src/client/locales.ts',
    from: 'versionsBlocked: \'Newer versions need a DSH update\',',
    to: 'versionsBlocked: \'Newer versions need a Casper update\',' },
  { file: 'packages/client/ui-plugin-manager/src/client/locales.ts',
    from: 'versionsBlockedDetail: \'{version} needs {peers}; this DSH is {runtime}\',',
    to: 'versionsBlockedDetail: \'{version} needs {peers}; this Casper is {runtime}\',' },
  { file: 'packages/client/ui-plugin-manager/src/client/locales.ts',
    from: 'updateLostDetail: \'The connection to DSH was interrupted: {reason}. Refresh the plugin list to see the installed version.\',',
    to: 'updateLostDetail: \'The connection to Casper was interrupted: {reason}. Refresh the plugin list to see the installed version.\',' },
  { file: 'packages/client/ui-plugin-manager/src/client/locales.ts',
    from: 'installDoneRestart: \'Installed; restart DSH to load it. {reason}\',',
    to: 'installDoneRestart: \'Installed; restart Casper to load it. {reason}\',' },
  { file: 'packages/client/ui-plugin-manager/src/client/locales.ts',
    from: 'reasonIncompatibleVersion: \'{plugin} is incompatible with DSH {runtime} (requires {requirements}); running it may cause crashes or data loss.\',',
    to: 'reasonIncompatibleVersion: \'{plugin} is incompatible with Casper {runtime} (requires {requirements}); running it may cause crashes or data loss.\',' },
  { file: 'packages/client/ui-plugin-manager/src/client/locales.ts',
    from: 'reasonIncompatibleVersionUnnamed: \'This plugin is incompatible with the running DSH version; running it may cause crashes or data loss.\',',
    to: 'reasonIncompatibleVersionUnnamed: \'This plugin is incompatible with the running Casper version; running it may cause crashes or data loss.\',' },
  { file: 'packages/client/ui-plugin-manager/src/client/locales.ts',
    from: 'reasonUnsupportedPlatform: \'This plugin does not support the operating system running DSH.\',',
    to: 'reasonUnsupportedPlatform: \'This plugin does not support the operating system running Casper.\',' },
  { file: 'packages/client/ui-plugin-manager/src/client/locales.ts',
    from: 'reasonIncompatibleInstall: \'Install a plugin version compatible with this DSH.\',',
    to: 'reasonIncompatibleInstall: \'Install a plugin version compatible with this Casper.\',' },
  { file: 'packages/client/ui-plugin-manager/src/client/locales.ts',
    from: 'reasonIncompatibleInstalled: \'Uninstall it and install a version compatible with this DSH.\',',
    to: 'reasonIncompatibleInstalled: \'Uninstall it and install a version compatible with this Casper.\',' },
  // packages/client/ui-plugin-market/src/client/locales.ts
  { file: 'packages/client/ui-plugin-market/src/client/locales.ts',
    from: 'statusProvided: \'Provided by DSH\',',
    to: 'statusProvided: \'Provided by Casper\',' },
  { file: 'packages/client/ui-plugin-market/src/client/locales.ts',
    from: 'incompatible: \'This version is not compatible with the running DSH {runtime}; it requires DSH {range}.\',',
    to: 'incompatible: \'This version is not compatible with the running Casper {runtime}; it requires Casper {range}.\',' },
  { file: 'packages/client/ui-plugin-market/src/client/locales.ts',
    from: 'noCompatibleVersion: \'No version is compatible with DSH {runtime}\',',
    to: 'noCompatibleVersion: \'No version is compatible with Casper {runtime}\',' },
  { file: 'packages/client/ui-plugin-market/src/client/locales.ts',
    from: 'exempted: \'This version is not compatible with the running DSH, but you set a compatibility exemption for it.\',',
    to: 'exempted: \'This version is not compatible with the running Casper, but you set a compatibility exemption for it.\',' },
  // packages/client/ui-shortcuts/src/client/locales.ts
  { file: 'packages/client/ui-shortcuts/src/client/locales.ts',
    from: 'future: \'Shortcut configuration in {location} was created by a newer version. Upgrade Harness and try again.\',',
    to: 'future: \'Shortcut configuration in {location} was created by a newer version. Upgrade Casper and try again.\',' },
  { file: 'packages/client/ui-shortcuts/src/client/locales.ts',
    from: '\'web-reload\': \'reload the page\', \'desktop-reload\': \'restart Harness\',',
    to: '\'web-reload\': \'reload the page\', \'desktop-reload\': \'restart Casper\',' },
  // packages/client/ui-sidebar-browser/src/client/locales.ts
  { file: 'packages/client/ui-sidebar-browser/src/client/locales.ts',
    from: '\'error.application-origin\': \'The embedded browser cannot open the DSH application itself.\',',
    to: '\'error.application-origin\': \'The embedded browser cannot open the Casper application itself.\',' },
  // packages/context/harness-dev-context/locale/en.json
  { file: 'packages/context/harness-dev-context/locale/en.json',
    from: '"title": "Harness development context",',
    to: '"title": "Casper development context",' },
  { file: 'packages/context/harness-dev-context/locale/en.json',
    from: '"description": "Give the model the Harness source directory and Web URL without changing its system prompt."',
    to: '"description": "Give the model the Casper source directory and Web URL without changing its system prompt."' },
  // packages/experimental/claude-code-mods/locale/en.json
  { file: 'packages/experimental/claude-code-mods/locale/en.json',
    from: '"description": "Load Claude Code extensions and run their hooks through Harness extension points."',
    to: '"description": "Load Claude Code extensions and run their hooks through Casper extension points."' },
  // packages/experimental/client-ui-creation-recommendations/src/client/locales.ts
  { file: 'packages/experimental/client-ui-creation-recommendations/src/client/locales.ts',
    from: '\'restart-required\': \'The change is saved. Restart DSH to apply it.\',',
    to: '\'restart-required\': \'The change is saved. Restart Casper to apply it.\',' },
  // packages/experimental/client-ui-plugin-recommendations/src/client/locales.ts
  { file: 'packages/experimental/client-ui-plugin-recommendations/src/client/locales.ts',
    from: '\'version-error\': \'This plugin is incompatible with this DSH version. Update DSH and retry.\',',
    to: '\'version-error\': \'This plugin is incompatible with this Casper version. Update Casper and retry.\',' },
  { file: 'packages/experimental/client-ui-plugin-recommendations/src/client/locales.ts',
    from: '\'restart-required\': \'Saved. Restart DSH to apply.\',',
    to: '\'restart-required\': \'Saved. Restart Casper to apply.\',' },
  // packages/experimental/client-ui-voice-input/src/client/locales.ts
  { file: 'packages/experimental/client-ui-voice-input/src/client/locales.ts',
    from: '\'setup.local\': \'Local models will be downloaded to the machine running DSH. No Python or compiler is required.\',',
    to: '\'setup.local\': \'Local models will be downloaded to the machine running Casper. No Python or compiler is required.\',' },
  { file: 'packages/experimental/client-ui-voice-input/src/client/locales.ts',
    from: '\'downloadAdvice.network\': \'Check that the machine running DSH can reach the download source and its model download services. Configure a proxy on that machine if needed, then retry.\',',
    to: '\'downloadAdvice.network\': \'Check that the machine running Casper can reach the download source and its model download services. Configure a proxy on that machine if needed, then retry.\',' },
  { file: 'packages/experimental/client-ui-voice-input/src/client/locales.ts',
    from: '\'downloadAdvice.dns\': \'Check DNS and proxy settings on the machine running DSH. Confirm that it can resolve the download source domain, then retry.\',',
    to: '\'downloadAdvice.dns\': \'Check DNS and proxy settings on the machine running Casper. Confirm that it can resolve the download source domain, then retry.\',' },
  { file: 'packages/experimental/client-ui-voice-input/src/client/locales.ts',
    from: '\'downloadAdvice.timeout\': \'Check the network or proxy connection on the machine running DSH, then retry later. Verified downloaded files are retained.\',',
    to: '\'downloadAdvice.timeout\': \'Check the network or proxy connection on the machine running Casper, then retry later. Verified downloaded files are retained.\',' },
  { file: 'packages/experimental/client-ui-voice-input/src/client/locales.ts',
    from: '\'downloadAdvice.certificate\': \'Check the system clock, trusted certificates and proxy settings on the machine running DSH, then retry.\',',
    to: '\'downloadAdvice.certificate\': \'Check the system clock, trusted certificates and proxy settings on the machine running Casper, then retry.\',' },
  { file: 'packages/experimental/client-ui-voice-input/src/client/locales.ts',
    from: '\'downloadAdvice.storage\': \'Check available disk space and write permission for the model directory on the machine running DSH, then retry.\',',
    to: '\'downloadAdvice.storage\': \'Check available disk space and write permission for the model directory on the machine running Casper, then retry.\',' },
  { file: 'packages/experimental/client-ui-voice-input/src/client/locales.ts',
    from: '\'downloadAdvice.unknown\': \'Check the network, disk space and model directory permissions on the machine running DSH, then retry.\',',
    to: '\'downloadAdvice.unknown\': \'Check the network, disk space and model directory permissions on the machine running Casper, then retry.\',' },
  { file: 'packages/experimental/client-ui-voice-input/src/client/locales.ts',
    from: 'local: \'Audio is recognized on the machine running DSH. If models need downloading, that machine must be able to reach the selected source and its file services. Configure a proxy on that machine if needed.\',',
    to: 'local: \'Audio is recognized on the machine running Casper. If models need downloading, that machine must be able to reach the selected source and its file services. Configure a proxy on that machine if needed.\',' },
  // packages/experimental/hooks-claude-code/locale/en.json
  { file: 'packages/experimental/hooks-claude-code/locale/en.json',
    from: '"description": "Run hooks from Claude Code hooks.json or settings at Harness interception points."',
    to: '"description": "Run hooks from Claude Code hooks.json or settings at Casper interception points."' },
  // packages/experimental/hooks-codex/locale/en.json
  { file: 'packages/experimental/hooks-codex/locale/en.json',
    from: '"description": "Run hooks from Codex hooks.json at Harness interception points."',
    to: '"description": "Run hooks from Codex hooks.json at Casper interception points."' },
  // packages/experimental/inspector-profile/locale/en.json
  { file: 'packages/experimental/inspector-profile/locale/en.json',
    from: '"description": "For troubleshooting: view what DSH recorded for a session in Session log, inspect per-turn and per-step statistics in the Statistics tab, and debug the DSH backend in Chrome DevTools.",',
    to: '"description": "For troubleshooting: view what Casper recorded for a session in Session log, inspect per-turn and per-step statistics in the Statistics tab, and debug the Casper backend in Chrome DevTools.",' },
  // packages/experimental/liveshare/src/client/locales.ts
  { file: 'packages/experimental/liveshare/src/client/locales.ts',
    from: '\'dialog.sessionMode.notGranted\': \'This Harness did not report the session permission back: an older owner build needs an upgrade before the share can carry it.\',',
    to: '\'dialog.sessionMode.notGranted\': \'This Casper did not report the session permission back: an older owner build needs an upgrade before the share can carry it.\',' },
  { file: 'packages/experimental/liveshare/src/client/locales.ts',
    from: '\'dialog.permissions.modeUnsupported\': \'This Harness did not report a session permission, so it cannot be changed here.\',',
    to: '\'dialog.permissions.modeUnsupported\': \'This Casper did not report a session permission, so it cannot be changed here.\',' },
  { file: 'packages/experimental/liveshare/src/client/locales.ts',
    from: '\'manage.sessionModeUnsupported\': \'This Harness did not report a session permission, so it cannot be set here.\',',
    to: '\'manage.sessionModeUnsupported\': \'This Casper did not report a session permission, so it cannot be set here.\',' },
  // packages/experimental/personalized-recommendations/locale/en.json
  { file: 'packages/experimental/personalized-recommendations/locale/en.json',
    from: '"description": "Shows recommendation cards below the answer for what you want from DSH: when you want a page or small tool you can keep, it proposes a new personalized page, built in the background after you click Create; when you ask how to do something in this app or say a capability is missing, it recommends the built-in plugin that provides it, turned on when you click Enable.",',
    to: '"description": "Shows recommendation cards below the answer for what you want from Casper: when you want a page or small tool you can keep, it proposes a new personalized page, built in the background after you click Create; when you ask how to do something in this app or say a capability is missing, it recommends the built-in plugin that provides it, turned on when you click Enable.",' },
  // packages/experimental/webhook/locale/en.json
  { file: 'packages/experimental/webhook/locale/en.json',
    from: '"description": "Create Harness sessions in a workspace through Webhook rules without waiting for completion."',
    to: '"description": "Create Casper sessions in a workspace through Webhook rules without waiting for completion."' },
  // packages/mcp/mcp-client/locale/en.json
  { file: 'packages/mcp/mcp-client/locale/en.json',
    from: '"description": "Connect to MCP servers and make their tools available in Harness."',
    to: '"description": "Connect to MCP servers and make their tools available in Casper."' },
  // packages/storage/storage-sqlite/locale/en.json
  { file: 'packages/storage/storage-sqlite/locale/en.json',
    from: '"description": "Store Harness key-value data in SQLite."',
    to: '"description": "Store Casper key-value data in SQLite."' },
  // packages/subagent/subagent-dsh-sdk/locale/en.json
  { file: 'packages/subagent/subagent-dsh-sdk/locale/en.json',
    from: '"title": "DSH SDK subagent backend",',
    to: '"title": "Casper SDK subagent backend",' },
  { file: 'packages/subagent/subagent-dsh-sdk/locale/en.json',
    from: '"description": "Run Harness in a subprocess through the TypeScript SDK and JSON-RPC over standard input and output."',
    to: '"description": "Run Casper in a subprocess through the TypeScript SDK and JSON-RPC over standard input and output."' },
  // Tests and expected outputs that pin the English copy above.
  { file: 'apps/desktop/tests/expected/fatal-address-in-use-en.txt',
    from: 'Another DSH instance (such as dsh web or the desktop app) is running. They cannot start at the same time. Quit the other running DSH instance, then restart.',
    to: 'Another Casper instance is running. They cannot start at the same time. Quit the other running Casper instance, then restart.' },
  { file: 'packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts',
    from: 'code: \'INTERRUPTED\', message: \'The DSH process exited before this turn finished.\',',
    to: 'code: \'INTERRUPTED\', message: \'The Casper process exited before this turn finished.\',' },
  { file: 'packages/client/ui-entry-customization/tests/menu.client.spec.tsx',
    from: '[\'en\', \'sidebar.panellist.actions\', \'Create a DSH plugin with a left sidebar entry.\'],',
    to: '[\'en\', \'sidebar.panellist.actions\', \'Create a Casper plugin with a left sidebar entry.\'],' },
  { file: 'packages/client/ui-entry-customization/tests/menu.client.spec.tsx',
    from: '[\'en\', \'conversation.session.header.views.actions\', \'Create a DSH conversation view plugin.\'],',
    to: '[\'en\', \'conversation.session.header.views.actions\', \'Create a Casper conversation view plugin.\'],' },
  { file: 'packages/client/ui-entry-customization/tests/menu.client.spec.tsx',
    from: '[\'en\', \'sidebar.right.tab.guide.actions\', \'Create a DSH plugin with a right sidebar entry.\'],',
    to: '[\'en\', \'sidebar.right.tab.guide.actions\', \'Create a Casper plugin with a right sidebar entry.\'],' },
  { file: 'packages/client/ui-plugin-market/tests/discover.client.spec.tsx',
    from: 'expect(screen.getAllByText(\'This version is not compatible with the running DSH 0.2.0; it requires DSH 0.1.0.\')).toHaveLength(2)',
    to: 'expect(screen.getAllByText(\'This version is not compatible with the running Casper 0.2.0; it requires Casper 0.1.0.\')).toHaveLength(2)' },
  { file: 'packages/client/ui-shortcuts/tests/reference.client.spec.tsx',
    from: 'expect(screen.getByRole(\'alert\').textContent).toContain(\'Upgrade Harness and try again.\')',
    to: 'expect(screen.getByRole(\'alert\').textContent).toContain(\'Upgrade Casper and try again.\')' },
  { file: 'packages/client/ui-shortcuts/tests/reference.client.spec.tsx',
    from: '? dictionary === en ? \'Upgrade Harness\' : \'升级 Harness\'',
    to: '? dictionary === en ? \'Upgrade Casper\' : \'升级 Casper\'' },
  { file: 'packages/client/ui-plugin-manager/tests/components.client.spec.tsx',
    from: 'if (title === en.versionsBlocked) expect(within(section()).getByText(`2.0.0 needs @deepseek-ai/dsh >=0.9.0; this DSH is ${runtime}`)).toBeTruthy()',
    to: 'if (title === en.versionsBlocked) expect(within(section()).getByText(`2.0.0 needs @deepseek-ai/dsh >=0.9.0; this Casper is ${runtime}`)).toBeTruthy()' },
  // First-use Default workspace folder: <Documents>/Casper Desktop/default-workspace (kept apart from the Casper CLI's folders).
  { file: 'packages/api/workspace-controller/src/default-directory.ts',
    from: 'return paths.join(directory, \'deepseek-harness\', DEFAULT_WORKSPACE_DIRECTORY)',
    to: 'return paths.join(directory, \'Casper Desktop\', DEFAULT_WORKSPACE_DIRECTORY)' },
  { file: 'packages/api/workspace-controller/src/default-workspace.ts',
    from: ' * `<Documents>/deepseek-harness`. Language-neutral, so one installation keeps',
    to: ' * `<Documents>/Casper Desktop`. Language-neutral, so one installation keeps' },
  { file: 'packages/api/workspace-controller/README.md',
    from: 'The Host places the directory under its account\'s `<Documents>/deepseek-harness`, including on remote Web hosts.',
    to: 'The Host places the directory under its account\'s `<Documents>/Casper Desktop`, including on remote Web hosts.' },
  { file: 'packages/api/workspace-controller/tests/default-directory.host.spec.ts',
    from: '\'/Users/a/文档/deepseek-harness/default-workspace\'',
    to: '\'/Users/a/文档/Casper Desktop/default-workspace\'' },
  { file: 'packages/api/workspace-controller/tests/default-directory.host.spec.ts',
    from: '\'D:\\\\Redirected Documents\\\\deepseek-harness\\\\default-workspace\'',
    to: '\'D:\\\\Redirected Documents\\\\Casper Desktop\\\\default-workspace\'' },
  { file: 'packages/api/workspace-controller/tests/default-directory.host.spec.ts',
    from: '\'/home/a/My Documents/deepseek-harness/default-workspace\'',
    to: '\'/home/a/My Documents/Casper Desktop/default-workspace\'' },
  { file: 'packages/api/workspace-controller/tests/default-directory.host.spec.ts',
    from: '.resolves.toBe(\'/documents/deepseek-harness/default-workspace\')',
    to: '.resolves.toBe(\'/documents/Casper Desktop/default-workspace\')' },
  { file: 'packages/api/workspace-controller/tests/workspace-controller.host.spec.ts',
    from: 'join(root, \'deepseek-harness\', DEFAULT_WORKSPACE_DIRECTORY)',
    to: 'join(root, \'Casper Desktop\', DEFAULT_WORKSPACE_DIRECTORY)' },
  { file: 'apps/web/tests/default-workspace.e2e.ts',
    from: 'join(scaffold.workspaceCwd, \'Documents\', \'deepseek-harness\', \'default-workspace\')',
    to: 'join(scaffold.workspaceCwd, \'Documents\', \'Casper Desktop\', \'default-workspace\')' },
  { file: 'apps/web/tests/default-workspace.e2e.ts',
    from: 'const parent = join(scaffold.workspaceCwd, \'Documents\', \'deepseek-harness\')',
    to: 'const parent = join(scaffold.workspaceCwd, \'Documents\', \'Casper Desktop\')' },
  // Chat running status: a ghost instead of the whale tail, and "Haunting" instead of "Deep diving" (English only).
  { file: 'packages/client/ui-chat/src/client/chat/RunningWhaleTail.tsx',
    from: "const REST_PATH = 'M8.844 13.742C8.967 12.328 8.45 10.4 8.45 9.65C8.45 8.94 8.88 8.43 9.6 8.43C11.285 8.43 12.106 8.281 12.685 8.104C13.71 7.791 14.585 6.768 15.055 5.945C15.137 5.803 14.99 5.641 14.829 5.671C13.829 5.86 12.828 5.376 11.827 4.978C10.659 4.514 9.491 4.707 8.935 4.876C8.805 4.915 8.658 4.819 8.636 4.686C8.468 3.643 7.405 2.615 5.498 2.238C4.54 2.048 3.748 1.574 3.347 1.202C3.252 1.113 3.088 1.125 3.03 1.242C2.628 2.059 2.168 3.82 5.248 6.115C5.82 6.494 6.31 6.785 6.574 7.637C6.72 8.104 6.157 9.168 6.061 9.368C5.157 11.27 5.089 12.19 4.926 13.742'",
    to: "const REST_PATH = 'M3 8a5 5 0 0 1 10 0v6l-1.25 -1 -1.25 1 -1.25 -1 -1.25 1 -1.25 -1 -1.25 1 -1.25 -1 -1.25 1zM5.6 7.6a.7 .9 0 1 0 1.4 0a.7 .9 0 1 0-1.4 0zM9 7.6a.7 .9 0 1 0 1.4 0a.7 .9 0 1 0-1.4 0z'" },
  { file: 'packages/client/ui-chat/src/client/locale.ts',
    from: "  'chat.deepDiving': 'Deep diving',",
    to: "  'chat.deepDiving': 'Haunting'," },
  { file: 'packages/client/ui-chat/src/client/locale.ts',
    from: "  'chat.deepDivingFor': 'Deep diving for {duration} ···',",
    to: "  'chat.deepDivingFor': 'Haunting for {duration} ···'," },
  { file: 'packages/client/ui-chat/README.md',
    from: 'The running “Deep diving” text retains its blue base',
    to: 'The running “Haunting” text retains its blue base' },
  { file: 'packages/client/ui-chat/README.md',
    from: 'The running status shows a whale whose APNG mask inherits the text color.',
    to: 'The running status shows a floating Casper ghost whose APNG mask inherits the text color; `apps/web/scripts/render-running-ghost.ts` renders it.' },
  { file: 'packages/client/ui-chat/README.md',
    from: 'the animated whale uses a 28×28 image',
    to: 'the animated ghost uses a 28×28 image' },
  { file: 'apps/web/tests/live-interactions.e2e.ts',
    from: "page.getByRole('status').filter({ hasText: 'Deep diving' })",
    to: "page.getByRole('status').filter({ hasText: 'Haunting' })" },
  { file: 'apps/web/tests/turn-tail-actions.e2e.ts',
    from: "page.getByRole('status').filter({ hasText: 'Deep diving' })",
    to: "page.getByRole('status').filter({ hasText: 'Haunting' })" },
]

/** Every Casper swap: the English product-name swaps, then the product-copy swaps in every language. */
export const REBRAND_RULES: readonly RebrandRule[] = [...PRODUCT_NAME_REBRAND_RULES, ...PRODUCT_COPY_REBRAND_RULES]

/**
 * Classify one rule against file text.
 * @param text - current file contents.
 * @param rule - the swap to classify.
 * @returns `pending` when `from` occurs exactly {@link RebrandRule.count} times (default once), `applied` when only `to`
 * does, `ambiguous` on more occurrences, otherwise `stale`.
 */
export function ruleState(text: string, rule: RebrandRule): RuleState {
  const expected = rule.count ?? 1
  const pending = text.split(rule.from).length - 1
  const applied = text.split(rule.to).length - 1
  if (pending > expected || applied > expected) return 'ambiguous'
  if (pending === expected) return 'pending'
  return applied === expected && pending === 0 ? 'applied' : 'stale'
}

/** One rule that cannot be applied, with its state. */
export interface RebrandProblem {
  /** The rule. */
  readonly rule: RebrandRule
  /** Why it was not applied. */
  readonly state: RuleState
}

/** Rule results over a set of file texts. */
export interface RebrandRun {
  /** Rules left pending (when not applying), stale, or ambiguous. */
  readonly problems: readonly RebrandProblem[]
  /** Rewritten text of each file a pending rule changed, by repository-relative path. */
  readonly changed: ReadonlyMap<string, string>
}

/**
 * How {@link applyRebrandRules} treats rule states: `check` reports pending rules; `write` applies them; `upstream`
 * applies them to upstream text and also reports a rule that is already applied when reached, since its `from` is not
 * upstream text and it never changes anything.
 */
export type RebrandMode = 'check' | 'write' | 'upstream'

/**
 * Classify rules in order against file texts, applying each pending rule before the next is classified.
 * @param rules - the swaps, in application order.
 * @param read - returns a repository-relative file's text.
 * @param mode - which states are problems and whether pending rules are applied.
 * @returns the problems and the rewritten texts.
 */
export function applyRebrandRules(rules: readonly RebrandRule[], read: (file: string) => string, mode: RebrandMode): RebrandRun {
  const problems: RebrandProblem[] = []
  const texts = new Map<string, string>()
  const changed = new Map<string, string>()
  for (const rule of rules) {
    const text = texts.get(rule.file) ?? read(rule.file)
    const state = ruleState(text, rule)
    if (state === 'pending' && mode !== 'check') {
      const next = text.split(rule.from).join(rule.to)
      texts.set(rule.file, next)
      changed.set(rule.file, next)
    } else {
      texts.set(rule.file, text)
      if (state !== 'applied' || mode === 'upstream') problems.push({ rule, state })
    }
  }
  return { problems, changed }
}

/**
 * Apply or check every rule under a repository root.
 * @param root - repository root.
 * @param write - write pending swaps when true; only report them when false.
 * @returns rules left pending (check mode), stale, or ambiguous.
 */
export function runRebrand(root: string, write: boolean): readonly RebrandProblem[] {
  const { problems, changed } = applyRebrandRules(REBRAND_RULES, file => readFileSync(resolve(root, file), 'utf8'), write ? 'write' : 'check')
  for (const [file, text] of changed) writeFileSync(resolve(root, file), text)
  return problems
}

function main(): void {
  const root = resolve(import.meta.dirname, '../..')
  const againstAt = process.argv.indexOf('--against')
  const ref = againstAt === -1 ? undefined : process.argv[againstAt + 1]
  if (againstAt !== -1 && ref === undefined) throw new Error('rebrand: --against needs a git ref')
  const problems = ref === undefined
    ? runRebrand(root, !process.argv.includes('--check'))
    : applyRebrandRules(REBRAND_RULES, file => execFileSync('git', ['show', `${ref}:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }), 'upstream').problems
  for (const { rule, state } of problems) console.error(`rebrand: ${state} ${rule.file}: ${rule.from}`)
  console.info(`rebrand: ${String(REBRAND_RULES.length - problems.length)}/${String(REBRAND_RULES.length)} rules applied`)
  if (problems.length > 0) process.exitCode = 1
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) main()
