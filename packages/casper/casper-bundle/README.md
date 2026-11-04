---
description: "Casper's installable bundle: the read-only casper-network-mcp server, for users adding Casper's network server to a composition."
kind: "package-bundle"
---

# @deepseek-ai/dsh-casper-bundle

## Summary

One Cordis patch that adds Casper's MCP server. casper-network-mcp (`mcp__network__*`) reads Aruba Central, Juniper Mist, ClearPass, UXI and OpsRamp, and starts with `--read-only`, so it cannot change a network device. The Web and Desktop profiles already ship the same row; this bundle is the installable copy for other compositions.

## Table of Contents

- [Use this package](#use-this-package)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Install the bundle in a running composition, or apply its `cordis.patch.yml` with `dsh --patch`. Do not install it into the Web or Desktop profile: those profiles already register the `network` server name, and a second registration of a name fails to load.

casper-network-mcp runs through `uvx`, so install [uv](https://docs.astral.sh/uv/) first. The patch finds `uvx` on `PATH` or in uv's default install folders (`~/.local/bin`, `~/.cargo/bin`, `/opt/homebrew/bin`, `/usr/local/bin`). The server receives only variables named `MIST_*`, `CENTRAL_*`, `CLEARPASS_*`, `UXI_*` or `OPSRAMP_*`; a product without a login still starts and answers `login_missing`.

<a id="dev-note"></a>
### Dev Note

The package ships no runtime code: `src/index.ts` is empty on purpose and the patch carries the composition. Keep its row identical to the matching row at the end of `packages/bundle/web-app/cordis.patch.yml`.
