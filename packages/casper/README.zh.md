---
description: "casper 包组：Casper agent 驱动器、侧栏浏览器工具与其桌面 Client 部分，以及桌面 profile 组合包，供选择或浏览 Casper 包的读者使用。"
kind: "package-group"
---

# casper/ — Casper agent 与侧栏浏览器

[English](README.md) | 中文

## 概述

casper 组为桌面应用加入 Casper。Casper 预设上的会话运行 Casper agent（智能体），而不是应用自身的 agent 循环。侧栏浏览器工具让 agent 查看并操作对话旁的浏览器标签页；其 Client 部分在桌面应用中执行每个操作。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

除 `desktop` 外，每个包都是一个插件；`desktop` 是一个 profile 组合包，桌面应用目前尚未选用它。桌面应用会挂载 Casper agent 和两个侧栏浏览器包。

| 包 | 职责 |
|---|---|
| [`casper-agent`](casper-agent/README.zh.md) | 通过 Casper 的 ACP 服务器，用 Casper agent 驱动 Casper 预设上的会话 |
| [`tool-sidebar-browser`](tool-sidebar-browser/README.zh.md) | 为模型提供读取与操作对话旁浏览器标签页的工具 |
| [`sidebar-browser-client`](sidebar-browser-client/README.zh.md) | 在桌面应用中执行侧栏浏览器工具的操作 |
| [`desktop`](desktop/README.zh.md) | 保存桌面应用的 profile 层：去掉上游服务行的上游 base 与 Web 层，之后是 Casper 层 |

<a id="related-documentation"></a>
## 相关文档

- [浏览器操作](../../docs/subsystems/browser-use.zh.md) — 浏览器能力所有权与 `casper-sidebar-browser/*` 事件。
- [工具](../../docs/subsystems/tools.zh.md) — 侧栏浏览器工具所注册的工具管线。
- [核心](../../docs/subsystems/core.zh.md) — Casper agent 驱动器接入的 `ctx.agents` 注册表。

<a id="dev-note"></a>
## 开发备注

无。
