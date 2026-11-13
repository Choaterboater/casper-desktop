---
kind: upgrade-guide
description: "The Desktop profile composes from the Casper desktop bundle, which has no upstream service rows, no default web search provider and no default model."
---

# Desktop composes from the Casper desktop bundle

English | [中文](guide.zh.md)

## Change

Previously, `dsh.profile.bundles` in `$DSH_HOME/profiles/desktop/package.json` listed `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`, and the shared Web layer switched the upstream service rows off. Now the Desktop profile lists `@deepseek-ai/dsh-casper-desktop`, which is generated from those two bundles with the upstream service rows taken out: product telemetry and analytics, the upstream account and its Settings page, upstream-hosted web search, the upstream model provider, Session-log upload, the upstream API extensions and the plugin inventory. Those rows are absent, not disabled.

The first launch of this release rewrites the list once: the Casper bundle takes the place of the first of `dsh-base` or `dsh-web-app`, the other is dropped, and every plugin keeps its order. A list that names neither stops startup with a message that names the file.

The bundle also changes three defaults on Desktop:

- No web search provider is set, and `web_search` is not offered to the model until a search provider resolves (`web` row, `offerUnresolvedSearch: false`). `web_fetch` is unchanged.
- No default model is set (`agent-default-model` has an empty provider and model). The model picker shows "Select model", and a Standard Session's first prompt fails until a model is picked.
- The plugin manager also hides `@deepseek-ai/dsh-casper-desktop` and `dsh-web-app`, so neither the Plugins page nor the `plugin_manager` tool can switch them on. Desktop does not install `dsh-base` or the other upstream profile bundles at all. The registry settings from [casper-wire-identity](../casper-wire-identity/guide.md) now come from this bundle.

## Migration

1. Nothing is needed for the bundle list. Confirm: after one launch, `dsh.profile.bundles` lists `@deepseek-ai/dsh-casper-desktop` where `@deepseek-ai/dsh-base` was, no `dsh-base` or `dsh-web-app`, and your plugins in their previous order.
2. If startup reports that the profile lists no `@deepseek-ai/dsh-casper-desktop`, choose "Disable third-party plugins, back up profile patch, and restart" in the recovery dialog, restore any overrides you need from the `cordis.patch.yml.bak-*` file it writes, then re-enable your plugins. Confirm: the app starts and the Plugins page lists them.
3. Pick a model in a Standard Session's model picker; the pick becomes the default. A saved default that names a provider no longer present fails at its first use, so pick a model again. Confirm: a new Standard Session's first prompt gets a reply.
4. Remove overrides in the profile's `cordis.patch.yml` that name a removed row; they only log `patch: entry ... not found`. An override of the `plugin-manager` row replaces the Casper bundle's config whole, so restate `hiddenBundles` in it. Confirm: startup logs no `not found` line for your overrides.
5. Downgrading is not supported: an earlier release skips the unknown bundle and starts without the base layers.
