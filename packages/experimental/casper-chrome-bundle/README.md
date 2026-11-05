---
description: "Casper in Chrome: let Casper browse and act in the user's own Google Chrome through the Playwright Extension."
kind: "package-bundle"
---

# @deepseek-ai/dsh-casper-chrome-bundle

English | [中文](README.zh.md)

## Summary

Let Casper browse and act in your own Google Chrome, with your tabs and signed-in sites. The bundle mounts the browser-use registry and the [Playwright MCP provider](../browser-use-playwright-mcp/README.md) in extension mode, which connects through the Playwright Extension instead of launching a separate browser. It ships switched off in Web and Desktop. Select **Casper in Chrome** in Plugins to enable it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Install the [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm) in Google Chrome. In Casper, open Plugins and enable **Casper in Chrome** in Official. Then ask Casper to do something in Chrome. Without the extension, the first browser call returns an error that links its Chrome Web Store page.

The first browser tool call in a conversation opens the extension's connection page in Chrome and waits. Approve the connection there and choose the tab Casper may use; the extension asks again for each new conversation. A call that waits longer than 5 minutes fails; ask Casper to try again after approving. To skip the approval, copy the `PLAYWRIGHT_MCP_EXTENSION_TOKEN` value the extension shows into Casper's [launch environment](../../util/launch-environment/README.md), for example `$DSH_HOME/.env`; the provider forwards only that variable to the extension connection, and anyone holding the token can connect without asking.

Every conversation has its own Chrome tools and its own connection. The extension puts each approved conversation's tabs in a separate tab group and does not offer a tab that another conversation already uses. A conversation that was already open when you switched the plugin on has no Chrome tools until Casper restarts. Switching the plugin off removes its profile layer and the tools.

The agent acts as you on every site that the shared tab can reach, including sites where you are signed in. It can read page content, fill forms, and click buttons there. Share only tabs you want Casper to use, and watch actions on sites that hold money, messages, or account settings.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts two Host rows: `casper-chrome-browser-use` mounts `@deepseek-ai/dsh-browser-use`, and `casper-chrome` mounts the Playwright provider with `mode: extension` and `toolCallTimeoutMs: 300000`. The provider runs the pinned `@playwright/mcp` server with `--extension --browser chrome`. The `casper-chrome` row is disabled in the Web preview Worker, which cannot start a local server. Later profile patches can override either row by id.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Playwright MCP provider](../browser-use-playwright-mcp/README.md) — extension mode, Session ownership, and tool behavior.
- [Browser use](../../../docs/subsystems/browser-use.md) — provider selection and Session ownership.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [Playwright MCP provider](../browser-use-playwright-mcp/README.md#model-experience), which owns the `mcp__playwright-mcp__*` tools, their results, and the server instructions.

#### KV Cache effect

The layer adds no request content directly; the provider owns cache effects from its tool catalog, server instructions, and results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Google Chrome only. The provider looks for the extension in Chrome's default user data directory; Edge, Chrome Beta, and other Chromium builds are not selectable.
- Each conversation starts its own extension connection, so without the token the extension asks for approval once per conversation and again after a resume.
- While the plugin is on, every open conversation runs its own Playwright MCP server process, including conversations that never use Chrome.
- The Desktop Sidebar browser tools (`browser_*`) stay available beside the Chrome tools; their names and descriptions are the only cue the model has for choosing between them.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context — click to expand</summary>

The package ships no runtime code: `src/index.ts` is empty on purpose and the patch carries the composition. Its retained npm name omits the experimental prefix so a later move to `packages/casper` keeps it.

</details>
