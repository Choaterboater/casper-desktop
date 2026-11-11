---
description: "The casper package group: the Casper agent driver, the Casper checks, and the Sidebar browser tools with their Desktop Client half, for readers choosing or navigating the Casper packages."
kind: "package-group"
---

# casper/ — Casper agent, checks, and Sidebar browser

English | [中文](README.zh.md)

## Summary

The casper group adds Casper to the desktop app. Sessions on the Casper preset run the Casper agent instead of the app's own agent loop. The checks plugin runs the project's own checks after edits and closes each turn with a receipt. The Sidebar browser tools let the agent see and drive the browser tabs beside a conversation; their Client half runs each operation in the desktop app.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Each package is a plugin. The desktop app mounts the Casper agent and both Sidebar browser packages; the checks plugin's preset rows are off for now.

| Package | Role |
|---|---|
| [`casper-agent`](casper-agent/README.md) | Drives Casper preset Sessions with the Casper agent over its ACP server |
| [`tool-checks`](tool-checks/README.md) | Runs the project's checks after edits, sends failures back, and closes the turn with a receipt |
| [`tool-sidebar-browser`](tool-sidebar-browser/README.md) | Gives the model tools to read and drive the browser tabs beside a conversation |
| [`sidebar-browser-client`](sidebar-browser-client/README.md) | Runs the Sidebar browser tool operations in the desktop app |

<a id="related-documentation"></a>
## Related documentation

- [Browser use](../../docs/subsystems/browser-use.md) — browser capability ownership and the `casper-sidebar-browser/*` events.
- [Tools](../../docs/subsystems/tools.md) — the tool pipeline the checks and Sidebar browser tools register on.
- [Core](../../docs/subsystems/core.md) — the `ctx.agents` registry the Casper agent driver plugs into.

<a id="dev-note"></a>
## Dev Note

None.
