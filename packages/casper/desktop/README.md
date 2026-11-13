---
description: "Casper desktop: the desktop app's profile bundle, generated from upstream's base and Web layers without the upstream service rows, for maintainers regenerating or reviewing it."
kind: "package-bundle"
---

# @deepseek-ai/dsh-casper-desktop

English | [中文](README.zh.md)

## Summary

The Casper desktop bundle holds the desktop app's profile layers: copies of upstream's [`dsh-base`](../../bundle/base/README.md) and [`dsh-web-app`](../../bundle/web-app/README.md) patch files with the upstream service rows taken out, followed by a hand-written Casper layer. The desktop app composes only from this bundle; on launch it replaces `dsh-base` and `dsh-web-app` in an existing desktop profile with it. The bundle ships with the dsh installation, and the plugin manager leaves it out of both plugin lists.

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

Do not edit the files under `generated/`. After an upstream sync changes `dsh-base` or `dsh-web-app`, run `pnpm run gen-casper-desktop-bundle`; CI runs `scripts/casper/desktop-bundle.ts --check` through its spec and fails while any generated file is stale. Put Casper-specific overrides in [`casper.patch.yml`](casper.patch.yml), which applies after every generated layer. A row there replaces the generated row's config whole, so it restates every field it keeps. It hides this bundle, the upstream profile bundles it replaces and upstream's optional bundles from the plugin manager; turns off the npm registry probe and the fallback registry and reads plugin READMEs from jsdelivr and unpkg; keeps Session upload off unless the person opts in; leaves the web search provider unset and sets `offerUnresolvedSearch: false`; and sets an empty default model. A package that only `casper.patch.yml` names is added to the generated dependencies as `workspace:*`; naming a forbidden package fails generation.

The removed rows and the packages the desktop must not ship are listed once, in [`scripts/casper/desktop-policy.ts`](../../../scripts/casper/desktop-policy.ts). When upstream renames or drops one of those rows, the generator fails and names the id, because each id must still be inserted by an upstream patch file; update the policy to match.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

`dsh.bundle.patch` lists the generated base layer, the generated Web layer, the generated preset layers in upstream's order, and then `casper.patch.yml`. The generator copies each source file line by line and deletes every top-level patch item and every `insert` item, including items inside groups, whose id is a removed row. A comment block directly above an item, at its indentation, covers that item and the following items without such a comment of their own, and it is deleted only with every item it covers. Every other line, comment and `!!js` expression is copied unchanged under a one-line generated-file header. The generator then checks that each output parses to the source with those rows taken out. It refuses rows that name a plugin by path, because the Loader resolves such names beside the patch file.

The manifest's `files`, `dsh.bundle.patch` and `dependencies` are generated as well. The dependencies are those of both source bundles plus `dsh-web-app` itself, whose Web rows load its code, minus every forbidden package, plus each other package `casper.patch.yml` names. [`scripts/casper-desktop-bundle.spec.ts`](../../../scripts/casper-desktop-bundle.spec.ts) checks that the tree is current, that composing the generated layers equals composing `dsh-base` and `dsh-web-app` with the removed rows taken out, that every `casper.patch.yml` row patches a generated row, that no removed row is present, and that every plugin the layers name resolves from this manifest.

| File | Role |
|---|---|
| [`generated/`](generated) | Filtered copies of the upstream patch files |
| [`casper.patch.yml`](casper.patch.yml) | The hand-written Casper layer |
| [`src/index.ts`](src/index.ts) | Package entry; carries no runtime API |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-base`](../../bundle/base/README.md) and [`dsh-web-app`](../../bundle/web-app/README.md) — the source layers and their per-row comments.
- [app-boot profile section](../../boot/app-boot/README.md) — how profiles resolve and layer bundles.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through each inserted row's package, which owns that row's model-facing behavior. The Casper layer's `web` row withholds `web_search` until a search provider resolves, and with no default model a Standard Session's first prompt fails until a model is picked.

#### KV Cache effect

The bundle adds no request content directly; each inserted row's package owns any cache effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- `dsh-web-app`'s own manifest depends on four forbidden packages (the account controller, the account settings UI, product analytics and product telemetry), so this bundle's install closure still reaches them. The desktop's package closure has to omit them itself.
- A removed row inside a flow-style list, or one whose removal would empty its list, cannot be removed line by line; the generator fails instead.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context — click to expand</summary>

The package ships no runtime code: `src/index.ts` is empty on purpose and the patch files carry the composition.

</details>
