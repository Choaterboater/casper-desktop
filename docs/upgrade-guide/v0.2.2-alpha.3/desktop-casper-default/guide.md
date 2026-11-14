---
kind: upgrade-guide
description: "Desktop starts new Sessions on the Casper preset, which runs the Casper agent through `casper acp` instead of the DeepSeek agent loop."
---

# Desktop starts new Sessions on the Casper preset

## Change

Previously, the Desktop profile's preset registry defaulted to `standard`, so every new Session ran on the DeepSeek agent loop. Now the Desktop default is `casper`: a new Session runs the Casper agent through a `casper acp` process, started at its first prompt, and a Session's mode cannot switch between Casper and another preset once it exists (the mode picker starts a new Session instead). A default saved in the Agent presets settings page still wins, and existing Sessions keep the preset they recorded. Web and other profiles keep `standard`. Desktop runs the Casper engine it ships ([casper-bundled-engine](../casper-bundled-engine/guide.md)), so a Casper Session starts without a `casper` command on the computer.

## Migration

1. To keep the DeepSeek loop for new Sessions, open the Agent presets settings page and make Standard the default, or pick Standard in the new-session mode picker. Confirm: the picker shows Standard and a new Session's first prompt runs without a Casper process.
2. To use Casper, sign in once with `/login` in a terminal `casper`, since the bundled engine reads the same `~/.casper` sign-ins; to run your own Casper instead of the bundled engine, follow [casper-bundled-engine](../casper-bundled-engine/guide.md). Confirm: a prompt in a new Desktop Session streams Casper's text and ends with its receipt.
