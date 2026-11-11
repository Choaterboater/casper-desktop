---
description: "Casper 侧栏浏览器工具的桌面端 Client 部分：通过 sidebarBrowserControl 服务为发起请求的会话回答 casper-sidebar-browser/request，让输入始终绑定在被允许的源上，且绝不把重放的输入发送两次。"
kind: "package-reference"
---

# @deepseek-ai/dsh-casper-sidebar-browser-client

[English](README.md) | 中文

## 概述

这个 Client 插件在 Casper 桌面应用中执行 [`@deepseek-ai/dsh-casper-sidebar-browser`](../tool-sidebar-browser/README.zh.md) 的浏览器操作。对每个 `casper-sidebar-browser/request`，它解析该请求所属的会话，并通过 `sidebarBrowserControl` 操作该会话的浏览器标签页。它只在标签页仍显示用户允许的源（origin）时发送输入，并且在回答重连后重放的请求时不会把输入发送两次。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

`packages/bundle/web-app/cordis.patch.yml` 中的 Web 应用名单以 `casper-sidebar-browser-client` 挂载本包，除非 `profileContext.name` 为 `desktop`，否则处于禁用状态。Host 部分为空；其 `dsh.client` 入口在 `@deepseek-ai/dsh-api-remotes`、`@deepseek-ai/dsh-api-session-controller` 与 `@deepseek-ai/dsh-client-ui-sidebar-browser` 之后加载 Client 插件。Client 插件注入 `sessions` 与 `remote`，并读取可选的 `sidebarBrowserControl` 服务。它没有配置项。

没有该服务（例如在 Web 客户端中）或没有会话作用域的请求会通过 `next()` 委托出去，于是由 Host 工具回答：桌面应用必须显示该对话。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`src/client/index.ts` 通过 `ctx.remote.$on` 监听，并用 `ctx.sessions.scopeOf(this)` 解析会话。`src/client/dispatch.ts` 把每个操作映射到 `tabs`、`open` 或 `control`，把缺失的标签页 URL 与标题转换为 `null`，并且只在 `open` 超时的情况下才把失败的 `open` 标记为 `unknown`。携带源的输入命令只在标签页当前 URL 具有该源时运行；否则以 `operation-failed` 失败，并带有 `not-dispatched`。

重连时仍在等待中的已转发 waterfall（瀑布式事件）会以相同的操作 id 再次送达。`ReplayLog` 由插件实例持有，以会话和操作 id 为键；对重复的 `open`、`navigate`、`click`、`type`、`key` 或 `scroll`，它返回第一次的回答，并在第一次运行仍在进行时共用该回答。只有当第一次的回答是 `not-dispatched` 时，它才再次运行该操作；当第一次运行被中断时，它回答 `operation-failed` 并带有 `unknown`。标签页列表、读取与截图总是会运行。它保留最近的 64 个回答。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 浏览器工具结果

#### 模型看到什么

这些回答会成为 `@deepseek-ai/dsh-casper-sidebar-browser` 渲染的浏览器工具结果；除了针对未知标签页、已离开被允许源的标签页以及被中断的先前尝试的失败消息之外，本包不添加任何自己的文本。

#### Token 影响

不直接产生影响；结果大小取决于 Host 工具。

#### KV Cache 影响

不直接产生影响：Host 工具把结果追加在最新步骤之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **重放记忆**——重复抑制存在于 Client 页面中。页面重新加载会丢失它，而重新加载也会销毁重放输入本应到达的浏览器 guest。
- **源检查的时机**——源检查在命令之前读取标签页列表；在这次读取与输入到达页面之间发生的导航不会被检测到。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
