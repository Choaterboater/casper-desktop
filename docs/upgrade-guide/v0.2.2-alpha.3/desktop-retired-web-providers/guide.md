---
kind: upgrade-guide
description: "Desktop launch removes a stored web search or fetch provider choice that names an upstream provider the Desktop profile no longer loads."
---

# Desktop clears stored upstream web provider choices

English | [中文](guide.zh.md)

## Change

The Desktop profile no longer loads the upstream web search and fetch providers (rows `web-search-deepseek` and `web-deepseek-api`; see [desktop-casper-bundle](../desktop-casper-bundle/guide.md)). A profile that picked one of them on the Web search and fetch settings page still stores its id in the `config` of the `web` entry in `$DSH_HOME/profiles/desktop/cordis.patch.yml`: `searchProvider: deepseek-search-api`, `searchProvider: deepseek-official`, or `fetchProvider: deepseek-fetch-api`. The page then listed that choice as "(not loaded)", `web_search` was withheld, and every `web_fetch` call failed with `configured web provider "deepseek-fetch-api" is not registered`.

Each launch now removes these stored values before the Host starts, so the first launch after upgrading clears them. Only these three ids are removed; any other value, including a third-party provider id, stays. A `config` left empty is removed too, so the Desktop defaults apply: no search provider until you pick one, and Direct fetch; when an earlier `web` entry in the same file sets its own `config`, the emptied one stays as `config: {}` so that earlier choice does not return. When other fields remain in that `config`, the cleared field selects a provider automatically. Comments, other fields and other entries keep their text, and a file without these values is not written.

Only the Desktop profile patch is edited. A `web` entry in the home-level `$DSH_HOME/cordis.patch.yml`, which every profile shares, applies after it and still wins; that file stays unchanged because the CLI profiles still load these providers.

If the file cannot be loaded, or a value is written in a form that cannot be removed line by line (for example flow style `{fetchProvider: ...}`, or a YAML anchor or alias), startup stops with a message that names the file, and the file stays unchanged.

## Migration

1. Nothing is needed for choices saved by the settings page. Confirm: after one launch, `cordis.patch.yml` names none of `deepseek-search-api`, `deepseek-official` or `deepseek-fetch-api`, and the Web search and fetch page lists no provider as "(not loaded)".
2. If startup reports a retired web provider it cannot remove, delete that `searchProvider` or `fetchProvider` line from the `web` entry in the named file, or choose "Disable third-party plugins, back up profile patch, and restart" in the recovery dialog and restore the overrides you need from the `cordis.patch.yml.bak-*` file it writes. Confirm: the app starts.
3. If the Web search and fetch page still lists a provider as "(not loaded)" after a launch, delete the `searchProvider` or `fetchProvider` line that names the retired id from the `web` entry in `$DSH_HOME/cordis.patch.yml` yourself; the CLI profiles read that file too, so the change applies to them as well. Confirm: after the next launch, the page lists no provider as "(not loaded)".
