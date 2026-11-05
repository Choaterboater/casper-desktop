---
description: "Chrome 中的 Casper：让 Casper 通过 Playwright Extension 在用户自己的 Google Chrome 中浏览和操作。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-casper-chrome-bundle

[English](README.md) | 中文

## 概述

让 Casper 在你自己的 Google Chrome 中浏览和操作，使用你的标签页和已登录的网站。此组合包挂载浏览器操作注册表，并以扩展模式挂载 [Playwright MCP 提供方](../browser-use-playwright-mcp/README.zh.md)；扩展模式通过 Playwright Extension 连接，而不是启动单独的浏览器。Web 和 Desktop 随附此功能，默认关闭。在插件页选择 **Chrome 中的 Casper** 即可启用。

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

在 Google Chrome 中安装 [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm)。在 Casper 中打开插件页，在官方分组启用 **Chrome 中的 Casper**。然后让 Casper 在 Chrome 中完成任务。未安装扩展时，第一次浏览器调用会返回一个错误，其中包含该扩展的 Chrome 应用商店链接。

对话中的第一次浏览器工具调用会在 Chrome 中打开扩展的连接页面并等待。在该页面批准连接，并选择 Casper 可以使用的标签页；每个新对话都会再次询问。等待超过 120 秒的调用会失败；批准后让 Casper 重试即可。若要跳过批准，请将扩展显示的 `PLAYWRIGHT_MCP_EXTENSION_TOKEN` 值写入 Casper 的[启动环境](../../util/launch-environment/README.zh.md)，例如 `$DSH_HOME/.env`；提供方只把该变量转发给扩展连接，任何持有该令牌的程序都无需询问即可连接。

每个对话都有自己的 Chrome 工具和自己的连接。扩展会把每个已批准对话的标签页放在单独的标签页组中，并且不会提供其他对话已在使用的标签页。启用插件时已经打开的对话，在 Casper 重启前没有 Chrome 工具。关闭此插件会移除其配置层和这些工具。

智能体会以你的身份操作共享标签页可访问的所有网站，包括你已登录的网站。它可以读取页面内容、填写表单并点击按钮。只共享你希望 Casper 使用的标签页，并留意涉及资金、消息或账户设置的网站上的操作。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 插入两个 Host 行：`casper-chrome-browser-use` 挂载 `@deepseek-ai/dsh-browser-use`，`casper-chrome` 以 `mode: extension` 和 `toolCallTimeoutMs: 120000` 挂载 Playwright 提供方。提供方使用 `--extension --browser chrome` 运行固定版本的 `@playwright/mcp` 服务器。`casper-chrome` 行在 Web 预览 Worker 中禁用，因为该 Worker 无法启动本地服务器。后续配置补丁可以按 id 覆盖任一行。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Playwright MCP 提供方](../browser-use-playwright-mcp/README.zh.md) — 扩展模式、Session 归属与工具行为。
- [浏览器操作](../../../docs/subsystems/browser-use.zh.md) — 提供方选择与 Session 归属。

-----

<a id="model-experience"></a>
## 模型体验

间接影响，通过 [Playwright MCP 提供方](../browser-use-playwright-mcp/README.zh.md#model-experience)，它负责 `mcp__playwright-mcp__*` 工具、工具结果和服务器说明。

#### KV Cache 影响

此配置层不直接添加请求内容；提供方负责其工具目录、服务器说明和结果带来的缓存影响。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- 仅支持 Google Chrome。提供方在 Chrome 的默认用户数据目录中查找扩展；无法选择 Edge、Chrome Beta 及其他 Chromium 构建。
- 每个对话都会建立自己的扩展连接，因此没有令牌时，扩展会在每个对话中以及恢复后各询问一次批准。
- 启用插件期间，每个打开的对话都会运行自己的 Playwright MCP 服务器进程，包括从不使用 Chrome 的对话。
- Desktop 侧栏浏览器工具（`browser_*`）与 Chrome 工具同时可用；模型只能依据它们的名称和描述进行选择。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者上下文 — 点击展开</summary>

此包不包含运行时代码：`src/index.ts` 有意为空，由补丁承载组合。其保留的 npm 名称省略了实验性前缀，以便日后迁移到 `packages/casper` 时保持不变。

</details>
