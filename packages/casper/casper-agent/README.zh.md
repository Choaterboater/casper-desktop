---
description: "Casper agent 驱动器：Casper 预设上的会话通过 Casper 的 ACP 服务器运行 Casper agent，而不是 DeepSeek agent 循环；涵盖配置、事件映射、审批、进程生命周期与恢复。"
kind: "package-reference"
---

# @deepseek-ai/dsh-casper-agent

[English](README.md) | 中文

## 概述

本插件让 Casper agent 成为 `casper` 预设上会话的主 AI。它在 `ctx.agents` 上注册一条工厂路由，这些会话各由一个 `casper acp` 进程驱动，而不是 DeepSeek agent 循环；其他会话仍使用 agent-loop。Casper 的文本、工具步骤、检查、计划与回执都成为普通会话事件，因此桌面端的对话记录、工具卡片、待办列表与停止按钮照常工作。Casper 的审批框以带有 Casper 自身选项的问题呈现给用户。桌面端的新会话默认使用此预设。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

桌面端 profile 通过 `packages/bundle/web-app/cordis.patch.yml` 挂载本插件（条目 `casper-agent`，在桌面端以外和浏览器内预览中禁用），并在 `packages/bundle/web-app/presets/casper.patch.yml` 中声明 `casper` 预设。该预设只挂载 `tool-todo`，用待办列表展示 Casper 的计划。在桌面端，预设注册表的默认值为 `casper`；设置中保存的默认值仍然优先。本插件注入 `agents`、`sessions`、`sessionProjections`、`sessionPersistence`、`subprocess` 与 `storageDomain`，并在挂载了 `userQuestions` 时使用它。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `presets` | `['casper']` | 由 Casper 驱动其会话的预设 |
| `command` | `casper` | Casper 可执行文件；桌面端条目在 PATH、`~/.local/bin`、`~/.bun/bin`、`/opt/homebrew/bin` 与 `/usr/local/bin` 中查找 |
| `args` | `['acp']` | 启动 Casper ACP 服务器的参数 |
| `model` | 未设置 | 以 `--model` 传入；未设置时沿用 Casper 自身的默认值 |
| `effort` | 未设置 | 以 `--effort` 传入；未设置时沿用 Casper 自身的默认值 |
| `env` | `{}` | 在子进程清理之后加入的子进程环境；桌面端条目传入以 bun 目录开头的 PATH，并在已设置时传入 `OPENROUTER_API_KEY` |
| `startTimeoutMs` | `30000` | `initialize` 加上 `session/new` 或 `session/load` 的时限 |
| `cancelGraceMs` | `5000` | 停止后等待提示回复的时间，超时则结束 Casper |
| `exitGraceMs` | `2500` | 关闭 stdin 后等待 Casper 退出的时间 |
| `killGraceMs` | `5000` | SIGTERM 与 SIGKILL 之间的宽限时间 |
| `stderrTailBytes` | `4096` | 为失败信息保留的 Casper stderr 字节数 |

子进程不会收到 `DEEPSEEK_*` 或 `DSH_*` 名称，也不会收到 `env` 未列出的凭据类名称。

会话在 Casper 预设上创建时即成为 Casper 会话。空白会话不能在 Casper 与其他预设之间切换：预设注册表以 `agent-preset/locked` 与 `newSession: true` 拒绝这种切换，模式选择器则改为在所选预设上开启新会话。已存储的会话由其记录的预设所选择的工厂恢复；未记录预设的会话仍使用 agent-loop。

无法运行的轮次在 `turn/end` 上以错误结束：找不到命令时为 `CASPER_NOT_FOUND`，Casper 未能启动时为 `CASPER_START_FAILED`，轮次中途退出时为 `CASPER_EXITED`，提示带有图片或文件、或没有文本时为 `CASPER_TEXT_ONLY`（不会向 Casper 发送任何内容），达到 Casper 的轮次上限时为 `CASPER_TURN_LIMIT`，收到错误回复时为 `CASPER_RPC_<code>`。会话仍可使用；下一条提示会再次启动 Casper。

<a id="understand-the-implementation"></a>
## 理解实现

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：注册投影、打开 sidecar，并注册工厂路由 |
| [`src/route.ts`](src/route.ts) | 选择配置预设上的根会话；委派的子会话仍使用 agent-loop |
| [`src/factory.ts`](src/factory.ts) | 按 agent-loop 的发布顺序创建与恢复 Agent，拒绝 fork，并在卸载时并行销毁所有 Agent |
| [`src/agent.ts`](src/agent.ts) | `CasperAgent`：收件箱、阶段、每轮一条提示、取消与进程重启 |
| [`src/connection.ts`](src/connection.ts) | 一个 `casper acp` 进程：查找、启动、ACP 客户端、`session/new` 或 `session/load`、提示、取消与释放 |
| [`src/turn.ts`](src/turn.ts) | 把 Casper 的更新写成步骤、助手消息、工具调用、结果与待办列表 |
| [`src/permission.ts`](src/permission.ts) | 把审批框变成用户问题，并把答案映射回去 |
| [`src/sidecar.ts`](src/sidecar.ts) | Host 存储域 `casper_agent`，把每个会话映射到其 Casper 对话 |

### 轮次与事件

每轮领取排队的输入，原样追加 `turn/start`、`step/start` 与领取的 `user/message` 事件，然后在 Casper 能改动文件之前刷写会话。领取的文本作为一条 `session/prompt` 发给 Casper。提示运行期间 Casper 不接受输入，因此引导消息会等到下一轮。

| Casper 更新 | 会话事件 |
|---|---|
| `agent_message_chunk` 文本 | 实时 `agent/assistant-stream` 帧，最终落为 `assistant/message` |
| `tool_call` | 该步骤带工具调用块的 `assistant/message`，随后是名为 `casper_<tool>` 的 `tool/call`；其后的文本开启新步骤 |
| 该步骤其他调用仍未结束时的 `tool_call` | 同一步骤中另一条只含该调用块的 `assistant/message`，随后是它的 `tool/call`，因此存储的每个调用都已声明，会话可以重新打开 |
| `tool_call_update` 完成或失败 | `tool/result`；失败的工具是错误结果，被拒绝的审批不是 |
| 检查 `tool_call`（已完成或已失败） | 立即写入名为 `casper_check` 的 `tool/call` 及其结果 |
| `plan` | 带完整列表的 `todo/write` |
| 提示结束（停止、退出或回复）时仍未结束的调用 | 在 `step/end` 之前写入带 `TOOL_OUTCOME_UNKNOWN` 的错误 `tool/result`，与 agent-loop 对失败步骤的记录一致 |

回执是最后一个文本块，因此它结束最后一条助手消息。提示回复只有在其之前收到的所有更新都写入后才会完成。停止会发送 `session/cancel` 并以中止结束该轮；若 Casper 在 `cancelGraceMs` 内未回复则被结束。工具调用 id 带有每个进程随机的前缀，因此重启后的 Casper 的 id 不会并入先前的卡片。

### 审批

`session/request_permission` 变成一个 `ctx.userQuestions.ask` 问题，以 Casper 的选项为标签，拒绝项在前。选中一个标签即选择该选项。输入文本、未选择、问题失败或被中止，以及没有问题服务时，都回答 `cancelled`，Casper 将其视为“否”。当 Casper 自行关闭审批框或提示结束时，问题随之关闭。

### 进程生命周期与恢复

Casper 在会话的第一条提示时启动，因此缺少命令不会妨碍打开会话。`session/new` 之后，对话 id 会在发送提示前存入 sidecar。之后的进程用 `session/load` 重新打开它，并丢弃回放的更新，因为会话已经保存了历史；只有 Casper 的“没有已保存对话”回复（`-32002`，消息中含不区分大小写的 "no saved conversation"）会开启新对话，且该轮以一行说明开头。Casper 只在第一次回复后保存对话，因此进程在此之前就停止的对话会以这种方式重新开始。其他加载失败会结束该轮并保留记录。释放时关闭 stdin，等待 `exitGraceMs`，然后终止进程，符合桌面端 10 秒的 Host 退出时限。恢复会像 agent-loop 一样修复中断的轮次，且不启动进程。

<a id="model-experience"></a>
## 模型体验

无，因为 Casper 进程自行构造模型请求，本插件不向任何 DeepSeek 请求添加内容。

#### KV Cache 影响

本插件不发送模型请求，因此对缓存没有影响；Casper 自己的请求不在本仓库之内。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 提示只携带文本；输入带有图片或文件的轮次会以 `CASPER_TEXT_ONLY` 结束，且不发送其文本。
- 模型选择器不会更改 Casper 的模型，模型标记在用户选择之前保持为空；`model` 与 `effort` 属于部署配置。
- 推理、工具输出、差异、token 用量与费用都不会显示，因为 Casper 不发送它们；`session/load` 的回放也不显示。
- 应用的 MCP 服务器不会传给 Casper；Casper 只使用它自己的服务器。
- 审批使用通用问题卡片；没有固定的审批卡片或单独的“始终允许”呈现。
- 引导消息作为下一条提示送达。
- 拒绝 fork Casper 会话。
- Headless、SDK 服务器、ACP 与 webhook 恢复不传预设，因此由它们重新打开的 Casper 会话运行在 agent-loop 上。
- 未保存预设的定时任务在桌面端运行于 Casper，因为它们通过会话控制器以默认预设创建会话。
- 只覆盖 macOS 与 Linux 上的桌面端；Windows 查找未经测试。
- 删除会话时不会移除 sidecar 记录，空闲的 Casper 进程也不会被回收。
- Subagent、团队与目标功能不在 Casper 会话中运行。
- Host 侧的标题生成仍可能为 Casper 会话调用 DeepSeek 模型。
- `packages/casper/tool-checks` 会保留，直到 Casper 会话经过实际验证。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为与限制以上文和包代码为准。

- **模型选择**——若要由 GUI 选择器决定 Casper 的模型，需要以 `--model` 重启 Casper，并用 `session/load` 重新打开对话。
- **审批卡片**——一旦 Casper 的选项类型能映射到共享审批卡片的固定操作，composer 适配器即可用该卡片呈现 Casper 的审批框。
- **检查插件**——Casper 会话经过实际验证后，可以从 Standard 预设中移除 `packages/casper/tool-checks`。

</details>
