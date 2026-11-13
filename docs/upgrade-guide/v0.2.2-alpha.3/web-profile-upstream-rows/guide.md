---
kind: upgrade-guide
description: "The CLI `dsh web` profile composes upstream's Web layer again: the upstream account page, upstream web search and model provider, Session-log upload and the npm registry mirror settings."
---

# The CLI Web profile composes upstream's Web layer again

## Change

Previously, the shared Web bundle `@deepseek-ai/dsh-web-app` switched the upstream service rows off and carried Casper's plugin-manager settings for every profile that used it, including the CLI `dsh web` profile. Those rows and settings now live only in the Casper desktop bundle ([desktop-casper-bundle](../desktop-casper-bundle/guide.md)), so `dsh web` composes upstream's Web layer plus Casper's own additions again. In `dsh web` the upstream account and its Settings page, upstream-hosted web search, the upstream model provider and the Session-log upload switch are back on (product analytics and product telemetry stay Desktop-only rows), the plugin manager may retry a failed install against its fallback registry, the install dialog may time the npm registry against its mirror, and the optional upstream bundles are offered.

## Migration

1. To keep the previous `dsh web` behavior, add to `$DSH_HOME/profiles/web/cordis.patch.yml` a `disabled: true` row for each id you want off (for example `account-controller`, `ui-settings-account`, `web-search-deepseek`, `web-deepseek-api`, `session-log-deepseek`), a `ui-plugin-manager` row with `registryProbeEnabled: false`, and a `plugin-manager` row with `fallbackRegistries: []`, `detailNpmFileSources: [jsdelivr, unpkg]` and the `hiddenBundles` you want. Confirm: `dsh web` starts and the Settings page has no Account section.
2. Nothing changes for Desktop.
