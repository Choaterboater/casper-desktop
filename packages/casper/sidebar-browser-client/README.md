---
description: "Desktop Client half of the Casper Sidebar browser tools: answers casper-sidebar-browser/request for the requesting Session through the sidebarBrowserControl service, keeps input bound to the allowed origin, and never sends a replayed input twice."
kind: "package-reference"
---

# @deepseek-ai/dsh-casper-sidebar-browser-client

## Summary

This Client plugin runs the browser operations of [`@deepseek-ai/dsh-casper-sidebar-browser`](../tool-sidebar-browser/README.md) in the Casper desktop app. For each `casper-sidebar-browser/request` it resolves the Session the request belongs to and drives that Session's browser tabs through `sidebarBrowserControl`. It sends input only while the tab still shows the origin the user allowed, and answers a request replayed after a reconnect without sending its input twice.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Web application roster in `packages/bundle/web-app/cordis.patch.yml` mounts the package as `casper-sidebar-browser-client`, disabled unless `profileContext.name` is `desktop`. The Host half is empty; its `dsh.client` entry loads the Client plugin after `@deepseek-ai/dsh-api-remotes`, `@deepseek-ai/dsh-api-session-controller`, and `@deepseek-ai/dsh-client-ui-sidebar-browser`. The Client plugin injects `sessions` and `remote` and reads the optional `sidebarBrowserControl` service. It has no configuration.

A request without that service, as in the Web client, or without a Session scope delegates with `next()`, so the Host tool answers that the desktop app must show the conversation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/client/index.ts` listens with `ctx.remote.$on` and resolves the Session with `ctx.sessions.scopeOf(this)`. `src/client/dispatch.ts` maps each operation to `tabs`, `open`, or `control`, converts absent tab URLs and titles to `null`, and marks a failed `open` as `unknown` only when it timed out. An input command that carries an origin runs only when the tab's current URL has that origin; otherwise it fails as `operation-failed` with `not-dispatched`.

A forwarded waterfall still pending at a reconnect is delivered again with the same operation id. `ReplayLog`, owned by the plugin instance and keyed by Session and operation id, returns the first answer of a repeated `open`, `navigate`, `click`, `type`, `key`, or `scroll`, sharing it while the first run is in flight. It runs the operation again only when the first answer was `not-dispatched`, and answers `operation-failed` with `unknown` when the first run was interrupted. Tab lists, reads, and screenshots always run. It keeps the latest 64 answers.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Browser tool results

#### What the model sees

The answers become the browser tool results that `@deepseek-ai/dsh-casper-sidebar-browser` renders; this package adds no text of its own beyond the failure messages for an unknown tab, a tab that left the allowed origin, and an interrupted earlier attempt.

#### Token effect

None directly; result size follows the Host tools.

#### KV Cache effect

None directly: the Host tools append results after the latest step.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Replay memory** — duplicate suppression lives in the Client page. A page reload loses it, and the reload also destroys the browser guests that the replayed input would reach.
- **Origin check timing** — the origin check reads the tab list just before the command; a navigation between that read and the input reaching the page is not detected.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
