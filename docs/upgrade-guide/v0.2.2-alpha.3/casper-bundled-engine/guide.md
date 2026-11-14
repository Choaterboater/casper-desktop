---
kind: upgrade-guide
description: "Desktop runs the Casper engine it ships instead of a `casper` command found on the computer, and the `casper-agent` plugin needs `engine` unless `useInstalledCasper` is on."
---

# Desktop runs the Casper engine it ships

## Change

Previously, the `casper-agent` plugin started the Casper that `command` found: on Desktop, `casper` on PATH or in `~/.local/bin`, `~/.bun/bin`, `/opt/homebrew/bin`, or `/usr/local/bin`. Now Desktop ships a pinned Casper engine in its runtime resources (`Contents/Resources/runtime/casper/casper` on macOS, `resources\runtime\casper\casper.exe` on Windows) and runs it, with the app's `node`, `npx`, `npm`, `uv`, and `uvx` at the end of Casper's PATH. A Casper installed on the computer is not used unless you turn it on. Casper always gets `CASPER_NO_UPDATE_CHECK=1`, so it never updates itself while the app runs it.

The plugin has three new config fields: `engine`, `useInstalledCasper` (default `false`), and `toolPath`. With `useInstalledCasper` off, `engine` must be an absolute path, or the plugin fails to load; `command` applies only with it on. A bundled engine that is missing or cannot run ends the turn with `CASPER_ENGINE_MISSING`. Desktop users who rely on their own Casper, and anyone who mounts `@deepseek-ai/dsh-casper-agent` from their own `cordis.yml`, are affected.

## Migration

1. To keep running the Casper installed on your computer in Desktop, open Settings → Built-in plugins → Casper agent and turn on `useInstalledCasper`. Confirm: while a Casper Session runs, the process list shows your own `casper` path, not one inside the app.
2. In your own `cordis.yml` row for `@deepseek-ai/dsh-casper-agent`, set `useInstalledCasper: true` to keep the `command` lookup, or set `engine` to the absolute path of a Casper executable. Confirm: the plugin loads without the `engine must be the absolute path` error, and a prompt in a Casper Session ends with Casper's receipt.
