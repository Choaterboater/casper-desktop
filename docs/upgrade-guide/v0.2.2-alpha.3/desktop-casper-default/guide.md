---
kind: upgrade-guide
description: "Desktop starts new Sessions on the Casper preset, which runs the Casper agent through `casper acp` instead of the DeepSeek agent loop."
---

# Desktop starts new Sessions on the Casper preset

English | [中文](guide.zh.md)

## Change

Previously, the Desktop profile's preset registry defaulted to `standard`, so every new Session ran on the DeepSeek agent loop. Now the Desktop default is `casper`: a new Session runs the Casper agent through a `casper acp` process, started at its first prompt, and a Session's mode cannot switch between Casper and another preset once it exists (the mode picker starts a new Session instead). A default saved in the Agent presets settings page still wins, and existing Sessions keep the preset they recorded. Web and other profiles keep `standard`. A Desktop machine without the `casper` command gets a `CASPER_NOT_FOUND` error on the first prompt of a Casper Session.

## Migration

1. To keep the DeepSeek loop for new Sessions, open the Agent presets settings page and make Standard the default, or pick Standard in the new-session mode picker. Confirm: the picker shows Standard and a new Session's first prompt runs without a Casper process.
2. To use Casper, install the `casper` command on PATH or in `~/.local/bin`, and keep `bun` in `~/.bun/bin`, `/opt/homebrew/bin`, or `/usr/local/bin`. Confirm: a prompt in a new Desktop Session streams Casper's text and ends with its receipt.
