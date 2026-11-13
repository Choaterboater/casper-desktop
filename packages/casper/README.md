---
description: "The casper package group: the Casper agent driver, the Sidebar browser tools with their Desktop Client half, and the desktop profile bundle, for readers choosing or navigating the Casper packages."
kind: "package-group"
---

# casper/ — Casper agent and Sidebar browser

English | [中文](README.zh.md)

## Summary

The casper group adds Casper to the desktop app. Sessions on the Casper preset run the Casper agent instead of the app's own agent loop. The Sidebar browser tools let the agent see and drive the browser tabs beside a conversation; their Client half runs each operation in the desktop app.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Each package except `desktop` is a plugin; `desktop` is a profile bundle that the desktop app does not select yet. The desktop app mounts the Casper agent and both Sidebar browser packages.

| Package | Role |
|---|---|
| [`casper-agent`](casper-agent/README.md) | Drives Casper preset Sessions with the Casper agent over its ACP server |
| [`tool-sidebar-browser`](tool-sidebar-browser/README.md) | Gives the model tools to read and drive the browser tabs beside a conversation |
| [`sidebar-browser-client`](sidebar-browser-client/README.md) | Runs the Sidebar browser tool operations in the desktop app |
| [`desktop`](desktop/README.md) | Holds the desktop app's profile layers: upstream's base and Web layers without the upstream service rows, then the Casper layer |

<a id="related-documentation"></a>
## Related documentation

- [Browser use](../../docs/subsystems/browser-use.md) — browser capability ownership and the `casper-sidebar-browser/*` events.
- [Tools](../../docs/subsystems/tools.md) — the tool pipeline the Sidebar browser tools register on.
- [Core](../../docs/subsystems/core.md) — the `ctx.agents` registry the Casper agent driver plugs into.

<a id="dev-note"></a>
## Dev Note

None.
