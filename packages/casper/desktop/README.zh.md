---
description: "Casper 桌面版：桌面应用的 profile 组合包，由上游的 base 与 Web 层去掉上游服务行后生成，供维护者重新生成或审阅。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-casper-desktop

[English](README.md) | 中文

## 概述

Casper 桌面版组合包保存桌面应用的 profile 层：上游 [`dsh-base`](../../bundle/base/README.zh.md) 与 [`dsh-web-app`](../../bundle/web-app/README.zh.md) patch 文件的副本，去掉了上游服务行，之后是一个手写的 Casper 层。桌面应用目前尚未从它组合，仍运行 `dsh-base` 与 `dsh-web-app`。此组合包随 dsh 安装一起提供，插件管理器不会在两个插件列表中显示它。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

不要编辑 `generated/` 下的文件。上游同步改动 `dsh-base` 或 `dsh-web-app` 后，运行 `pnpm run gen-casper-desktop-bundle`；CI 通过其 spec 运行 `scripts/casper/desktop-bundle.ts --check`，只要有生成文件过期就会失败。Casper 专属的覆盖写在 [`casper.patch.yml`](casper.patch.yml) 中，它在所有生成层之后应用，目前为空。只由 `casper.patch.yml` 引用的包会以 `workspace:*` 加入生成的依赖；引用禁止的包会使生成失败。

被移除的行以及桌面应用不得随附的包只在 [`scripts/casper/desktop-policy.ts`](../../../scripts/casper/desktop-policy.ts) 中列出一次。上游重命名或删除其中某一行时，生成器会失败并给出该 id，因为每个 id 仍须由某个上游 patch 文件插入；请同步更新该策略。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

`dsh.bundle.patch` 依次列出生成的 base 层、生成的 Web 层、按上游顺序生成的各预设层，最后是 `casper.patch.yml`。生成器逐行复制每个源文件，删除 id 属于被移除行的每个顶层 patch 项和每个 `insert` 项（包括分组内的项）；项正上方、同缩进的注释块覆盖该项及其后没有自己这种注释的项，只有当它覆盖的项全部删除时才随之删除。其余每一行、注释和 `!!js` 表达式都原样复制，并在开头加上一行生成文件标头。随后生成器检查每个输出解析后等于去掉这些行的源文件。它拒绝以路径命名插件的行，因为 Loader 会相对于 patch 文件解析此类名称。

清单中的 `files`、`dsh.bundle.patch` 与 `dependencies` 也是生成的。依赖为两个源组合包的依赖，加上 `dsh-web-app` 本身（其 Web 行加载它的代码），再减去所有禁止的包，并加上 `casper.patch.yml` 引用的其他每个包。[`scripts/casper-desktop-bundle.spec.ts`](../../../scripts/casper-desktop-bundle.spec.ts) 检查树是最新的，组合这些层等于组合去掉被移除行的 `dsh-base` 与 `dsh-web-app`，不存在任何被移除的行，并且这些层引用的每个插件都能从本清单解析。

| 文件 | 职责 |
|---|---|
| [`generated/`](generated) | 上游 patch 文件过滤后的副本 |
| [`casper.patch.yml`](casper.patch.yml) | 手写的 Casper 层 |
| [`src/index.ts`](src/index.ts) | 包入口；不提供运行时 API |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-base`](../../bundle/base/README.zh.md) 与 [`dsh-web-app`](../../bundle/web-app/README.zh.md) — 源层及其逐行注释。
- [app-boot profile 章节](../../boot/app-boot/README.zh.md) — profile 如何解析与叠加组合包。

-----

<a id="model-experience"></a>
## 模型体验

间接体现：每个插入行的包负责该行面向模型的行为。

#### KV Cache 影响

此组合包本身不直接添加请求内容；每个插入行的包负责相应的缓存影响。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- 桌面应用尚未选用此组合包，因此目前没有任何组合来自它。
- `dsh-web-app` 自己的清单依赖四个禁止的包（账户控制器、账户设置界面、产品分析与产品遥测），因此此组合包的安装闭包仍会到达它们。桌面应用的包闭包必须自行排除它们。
- 位于流式列表中的被移除行，或删除后会使其列表变空的行，无法逐行删除；此时生成器会失败。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文 — 点击展开</summary>

此包不提供运行时代码：`src/index.ts` 有意留空，组合由 patch 文件承载。

</details>
