---
description: "Casper's installable bundle: the read-only casper-network-mcp server, for users adding Casper's network server to a composition."
kind: "package-bundle"
---

# @deepseek-ai/dsh-casper-bundle

## Summary

One Cordis patch that adds Casper's MCP server. casper-network-mcp (`mcp__network__*`) reads Aruba Central, Juniper Mist, ClearPass, UXI and OpsRamp, and starts with `--read-only`, so it cannot change a network device. The Web and Desktop profiles already ship the same row; this bundle is the installable copy for other compositions.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Install the bundle in a running composition, or apply its `cordis.patch.yml` with `dsh --patch`. Do not install it into the Web or Desktop profile: those profiles already register the `network` server name, and a second registration of a name fails to load.

casper-network-mcp runs through `uvx`, so install [uv](https://docs.astral.sh/uv/) first. The patch finds `uvx` on `PATH` or in uv's default install folders (`~/.local/bin`, `~/.cargo/bin`, `/opt/homebrew/bin`, `/usr/local/bin`). The server receives only variables named `MIST_*`, `CENTRAL_*`, `CLEARPASS_*`, `UXI_*` or `OPSRAMP_*`; a product without a login still starts and answers `login_missing`.

## Model Experience

Indirectly, through [`@deepseek-ai/dsh-mcp-client`](../../mcp/mcp-client/README.md#model-experience), which owns what the model sees. The bundle adds one client row, so the model gets the tools the server lists as `mcp__network__*`, plus any instructions it returns.

#### KV Cache effect

The bundle adds no request content of its own. The MCP client owns the cache effect of the tool definitions and server instructions; they stay stable while the server's tool list is unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The server is pinned (`casper-network-mcp==0.1.7`); a newer server release needs a manual bump in this patch and in the Web app patch.
- No gate checks that this row matches the row in `packages/bundle/web-app/cordis.patch.yml`; they are kept in step by hand.
- The first start downloads the server through `uvx`, so it needs network access and takes longer than later starts.
- [`docs/DETAIL.md`](docs/DETAIL.md) notes the Casper persona composition and is not published, because the package has no locale file that links it.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context — click to expand</summary>

The package ships no runtime code: `src/index.ts` is empty on purpose and the patch carries the composition. Keep its row identical to the matching row at the end of `packages/bundle/web-app/cordis.patch.yml`.

</details>
