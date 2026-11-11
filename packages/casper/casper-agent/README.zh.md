---
description: "Casper agent 驱动器：Casper 预设上的会话通过 Casper 的 ACP 服务器运行 Casper agent，而不是 DeepSeek agent 循环；涵盖配置、事件映射、审批、进程生命周期与恢复。"
kind: "package-reference"
---

# @deepseek-ai/dsh-casper-agent

[English](README.md) | 中文

## 概述

本插件让 Casper agent 成为 `casper` 预设上会话的主 AI。`ctx.agents` 上的一条工厂路由让每个这样的会话由一个 `casper acp` 进程驱动，而不是 DeepSeek agent 循环。Casper 的文本、工具步骤、检查、计划与回执都成为普通会话事件，因此桌面端的对话记录、工具卡片、待办列表与停止按钮照常工作。审批框变成问题，权限控件设置 Casper 的模式，模型选择器列出 Casper 的模型。每个进程还会通过一个私有 MCP 服务器获得应用自身的工具，用于检查应用和安装插件。桌面端的新会话默认使用此预设。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

桌面端 profile 通过 `packages/bundle/web-app/cordis.patch.yml` 挂载本插件（条目 `casper-agent`，在桌面端以外和浏览器内预览中禁用），并在 `packages/bundle/web-app/presets/casper.patch.yml` 中声明 `casper` 预设。该预设挂载 `tool-todo`（用待办列表展示 Casper 的计划），以及应用工具所运行的条目：`tool-cordis`、`skill-filesystem`（使用 Cordis 预设的技能目录）、`tool-skill` 与 `tool-plugin-manager`；后者绑定应用已有的插件管理器，应用不带 profile 运行时关闭。该预设还挂载 `present`，以及 `tool-subagent-control` 与 `tool-subagent`（`spawn` 后端、`agentPreset: standard`，并开启模型选择与 `list_subagent_models`），它们把应用的[子代理](#subagents)交给 Casper；还挂载 `command-goal` 与 `tool-goal`，它们让 Casper 会话使用应用的[目标](#goals)。应用的[团队](#team)服务与任务板工具不需要预设条目：基础补丁为每个会话挂载它们。插件市场不会挂载。在桌面端，预设注册表的默认值为 `casper`；设置中保存的默认值仍然优先。本插件注入 `agents`、`sessions`、`sessionProjections`、`sessionPersistence`、`subprocess`、`storageDomain` 与 `tools`，并在挂载了 `userQuestions`、`skills`、`profileContext`、`attachments`、`commands`、`permissionPresets`、`sandboxPolicy`、`mcpManager`、`credentials`、`sessionReferenceResolver` 与 `jobs` 时使用它们。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `presets` | `['casper']` | 由 Casper 驱动其会话的预设 |
| `command` | `casper` | Casper 可执行文件；桌面端条目在 PATH、`~/.local/bin`、`~/.bun/bin`、`/opt/homebrew/bin` 与 `/usr/local/bin` 中查找。在 Windows 上，若这样找不到，插件还会在 PATH 上按每个 PATHEXT 后缀尝试 `casper`，然后在 `CASPER_INSTALL_DIR`、`%LOCALAPPDATA%\Programs\casper`（Casper 安装程序的文件夹）与 `%BUN_INSTALL%\bin` 中尝试 `casper.exe`；找到的 `.cmd`、`.bat` 或其他脚本只在错误中列出，不会启动。`command` 设为 `casper` 或 `casper.exe` 以外的值即可关闭此行为 |
| `args` | `['acp']` | 启动 Casper ACP 服务器的参数 |
| `model` | 未设置 | 起始模型，以 `--model` 传入；未设置时沿用 Casper 自身的默认值。[模型选择器](#model-picker)可按会话更改 |
| `effort` | 未设置 | 起始推理等级，以 `--effort` 传入；未设置时沿用 Casper 自身的默认值。模型选择器可按会话更改 |
| `env` | `{}` | 在子进程清理之后加入的子进程环境；桌面端条目传入以 bun 目录开头的 PATH，并在已设置时传入 `OPENROUTER_API_KEY` |
| `startTimeoutMs` | `120000` | `initialize` 加上 `session/new`、`session/load` 或 `session/fork` 的时限 |
| `cancelGraceMs` | `5000` | 停止后等待提示回复的时间，超时则结束 Casper |
| `exitGraceMs` | `2500` | 关闭 stdin 后等待 Casper 退出的时间 |
| `killGraceMs` | `5000` | SIGTERM 与 SIGKILL 之间的宽限时间 |
| `stderrTailBytes` | `4096` | 为失败信息保留的 Casper stderr 字节数 |
| `appTools` | `true` | 向 Casper 提供应用工具；`false` 时发送空的 `mcpServers` 列表 |
| `appSubagents` | `true` | 随应用工具向 Casper 提供应用的[子代理工具](#subagents)；需要 `appTools`，`false` 时不提供 |
| `appGoals` | `true` | 随应用工具向 Casper 提供应用的[目标工具](#goals)，并把目标的各轮作为 Casper 的轮次运行；这些工具需要 `appTools`，`false` 时不提供，到期的一轮会被丢弃，目标随之暂停 |
| `appTeams` | `true` | 随应用工具向 Casper 提供应用的[团队工具](#team)；会话的团队开关打开时才可用，需要 `appTools`，`false` 时不提供 |
| `appToolImages` | `true` | 把应用工具结果中的图片作为 MCP 图片内容发给 Casper，每次回复不超过 7 MiB；`false` 时每张图片换成一行说明，与以前相同 |
| `casperChildModel` | `true` | 应用有相同提供方与模型时，让[子代理](#subagents)在 Casper 当前的模型上运行；`false` 时所有子代理都在应用的默认模型上运行 |
| `casperTitles` | `true` | 用 Casper 发来的标题（不调用模型生成）为会话命名；`false` 时在应用的默认模型上生成标题 |
| `copyOnFork` | `true` | [分叉](#forks)启动时复制 Casper 截至分叉点的对话；`false` 时每个分叉都从新的 Casper 对话开始，其第一轮会说明这一点 |
| `accessModes` | `{ read-only: read, workspace-write: ask, danger-full-access: full }` | 每个权限预设设置的[访问模式](#access-control)；不能列出 `custom` 与 `auto` |
| `approvalCard` | `true` | 用 [Casper 的审批卡片](#approvals)显示 Casper 的审批框；`false` 时显示通用问题卡片 |
| `approvalDiff` | `true` | 在 [Casper 的审批卡片](#approvals)中绘制编辑的审批框所带的差异；需要 `approvalCard`，`false` 时以文本行显示差异 |
| `forwardMcpServers` | `true` | 把已启用的[「设置 > MCP 服务器」](#settings-mcp-servers)交给 Casper；`false` 时只发送应用工具服务器 |
| `forwardPluginMcpServers` | `true` | 同时把[插件向 MCP 管理器注册的服务器](#settings-mcp-servers)交给 Casper，排在设置中的服务器之后，并共用同样的 7 个名额；需要 `forwardMcpServers`，`false` 时不交给 Casper |
| `modePill` | `true` | 把 [Casper 自己选择的访问模式](#access-control)作为一个标签显示在权限控件旁边；`false` 时不记录，并清除已显示的标签 |
| `liveOutput` | `true` | 在 Casper 命令运行时，于[后台任务面板](#jobs-panel)中显示其最新的几行；在该任务上点停止会停止整个请求。`false` 时命令只在其卡片中显示最终输出 |
| `idleExitMs` | `900000` | 空闲多久后询问 Casper 能否[关闭](#process-lifetime-and-resume)其进程（15 分钟）；`0` 时保留进程直到会话关闭 |

子进程不会收到 `DEEPSEEK_*` 或 `DSH_*` 名称，也不会收到 `env` 未列出的凭据类名称。唯一的例外是应用 profile：应用带 profile 运行时，Casper 会收到 `DSH_PROFILE` 与 `DSH_PROFILE_DIR`，使它构建的 bundle 能指明要安装到的 profile。

会话在 Casper 预设上创建时即成为 Casper 会话。空白会话不能在 Casper 与其他预设之间切换：预设注册表以 `agent-preset/locked` 与 `newSession: true` 拒绝这种切换，模式选择器则改为在所选预设上开启新会话。桌面端重新打开已存储的会话时（从会话列表、为后续消息，或为指向它的定时任务），由其记录的预设所选择的工厂运行它，因此 Casper 会话会在 Casper 中重新打开；未记录预设的会话仍使用 agent-loop。其他会重新打开会话的应用列在[已知限制](#known-limitations-and-deferred-work)中。

无法运行的轮次在 `turn/end` 上以错误结束：找不到命令时为 `CASPER_NOT_FOUND`，Casper 未能启动时为 `CASPER_START_FAILED`，轮次中途退出时为 `CASPER_EXITED`，提示中没有 Casper 能读取的内容时为 `CASPER_EMPTY_PROMPT`：没有文本、图片或文件，或只有无法发送的图片和文件（不会向 Casper 发送任何内容），达到 Casper 的轮次上限时为 `CASPER_TURN_LIMIT`，Casper 拒绝所选模型或推理等级时为 `CASPER_MODEL_UNAVAILABLE`（不发送提示），Casper 未接受仅可查看或工作区内修改时为 `CASPER_ACCESS_NOT_APPLIED`（不发送提示，或停止正在运行的提示），[提及的会话](#session-mentions)无法发送时为某个 `SESSION_REFERENCE_*` 代码（不启动 Casper），收到错误回复时为 `CASPER_RPC_<code>`。会话仍可使用；下一条提示会再次启动 Casper。`CASPER_TEXT_ONLY` 已不再产生，只出现在早期版本保存的轮次中。

<a id="understand-the-implementation"></a>
## 理解实现

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：注册投影（其中包括 `casperAccess`）、打开 sidecar，并注册工厂路由 |
| [`src/lookup.ts`](src/lookup.ts) | 查找 Casper 可执行文件，并在 Windows 上回退到安装程序与 bun 的文件夹 |
| [`src/route.ts`](src/route.ts) | 选择配置预设上的根会话；委派的子会话仍使用 agent-loop |
| [`src/factory.ts`](src/factory.ts) | 按 agent-loop 的发布顺序创建与恢复 Agent，用继承的日志创建分叉并从中找到分叉点，并在卸载时并行销毁所有 Agent |
| [`src/agent.ts`](src/agent.ts) | `CasperAgent`：收件箱、阶段、每轮一条提示、把引导消息发给正在运行的提示、取消与进程重启 |
| [`src/connection.ts`](src/connection.ts) | 一个 `casper acp` 进程：查找、启动、ACP 客户端、`session/new`、`session/load` 或 `session/fork`、提示、取消与释放 |
| [`src/turn.ts`](src/turn.ts) | 把 Casper 的更新写成步骤、带推理的助手消息、工具调用、结果与待办列表 |
| [`src/views.ts`](src/views.ts) | 把 Casper 的工具步骤记录为做同样事情的 Standard 工具：名称、参数、结果文本与 meta |
| [`src/live-output.ts`](src/live-output.ts) | 把运行中命令的最新几行作为其任务显示在[后台任务面板](#jobs-panel)中，以及该任务上的停止 |
| [`src/permission.ts`](src/permission.ts) | 把审批框变成标题为 `Casper` 的用户问题，detail 中带有发起步骤的差异行，并把答案映射回去；计划 Build 框变成计划审阅 |
| [`src/box.ts`](src/box.ts) | 审批框的问题 id、标题与卡片上限，由两半共用 |
| [`src/receipt.ts`](src/receipt.ts) | 从 ACP `_meta` 读取 Casper 的回执与一次响应的 token，由两半共用 |
| [`src/conversation.ts`](src/conversation.ts) | `plugin:casper-agent/conversation` 记录，以及对提示回复 `_meta` 中 Casper 标记的检查 |
| [`src/client/index.ts`](src/client/index.ts) | 客户端一半：把 Casper 的审批卡片注册为对话输入框链的第一项，把回执卡片注册到已完成一轮的尾部，把回执卡片注册为 `casper_receipt` 的工具视图，并把模式标签注册在输入框的模式控件之后 |
| [`src/client/receipt-turn.ts`](src/client/receipt-turn.ts) | 在 Chat 目标上认领 `casper_receipt` 调用及其结果，使其不属于任何步骤，并把回执发布到它所在的一轮 |
| [`src/client/CasperBoxCard.tsx`](src/client/CasperBoxCard.tsx) | Casper 的审批卡片：它接管哪些问题、它的行、按键与回答 |
| [`src/client/ReceiptRow.tsx`](src/client/ReceiptRow.tsx) | Casper 的回执卡片：结论、已更改的文件、检查与模型用量，文案在 [`src/client/locales.ts`](src/client/locales.ts) |
| [`src/elicitation.ts`](src/elicitation.ts) | 把 Casper 的表单（`elicitation/create`）变成用户问题，并把答案映射回去 |
| [`src/sidecar.ts`](src/sidecar.ts) | Host 存储域 `casper_agent`，把每个会话映射到其 Casper 对话 |
| [`src/commands.ts`](src/commands.ts) | 供 `/` 菜单使用的 Casper 命令，以及保存最后一份列表的 Host 存储域 `casper_agent_commands` |
| [`src/app-tools.ts`](src/app-tools.ts) | 应用工具 MCP 服务器：监听、认证、工具列表，以及以 Casper Agent 身份运行的调用 |
| [`src/child-route.ts`](src/child-route.ts) | 与 Casper 当前模型相符的应用路由，会话的子代理在其上运行 |
| [`src/forward-servers.ts`](src/forward-servers.ts) | 交给 Casper 的「设置 > MCP 服务器」：哪些会发送、解析后的凭据、某个服务器被略过的原因，以及列表的摘要 |
| [`src/references.ts`](src/references.ts) | 通过会话引用服务读取消息提及的会话，并把其失败映射为该轮的代码 |
| [`src/app-read.ts`](src/app-read.ts) | `app_read_file`：对应用安装目录与 profile 目录的只读访问 |
| [`src/models.ts`](src/models.ts) | 把 Casper 的 `model` 与 `thought_level` 选项读成选择器的分组、推理等级与当前模型 |
| [`src/model.ts`](src/model.ts) | `CasperModel`：Agent 的模型句柄，把选择交给 Casper 而不是 Host 目录 |
| [`src/models-cache.ts`](src/models-cache.ts) | 保存最后一份模型列表的 Host 存储域 `casper_agent_models` |
| [`src/access.ts`](src/access.ts) | 把权限预设映射为 Casper 的访问模式 |
| [`src/access-record.ts`](src/access-record.ts) | 记录 Casper 自己选择的访问模式的 `plugin:casper-agent/access` 记录 |
| [`src/access-projection.ts`](src/access-projection.ts) | 由这些记录折叠出的、模式标签读取的 `casperAccess` 投影 |
| [`src/access-view.ts`](src/access-view.ts) | `casperAccess` 视图的类型，两半共用 |
| [`src/client/ModePill.tsx`](src/client/ModePill.tsx) | 输入框权限控件旁的 Casper 模式标签 |

<a id="turns-and-events"></a>
### 轮次与事件

每轮领取排队的输入，原样追加 `turn/start`、`step/start` 与领取的 `user/message` 事件，然后在 Casper 能改动文件之前刷写会话。领取的消息作为一条 `session/prompt` 发给 Casper，各块保持原有顺序：文本为 `text`；当 Casper 的 `initialize` 回复将 `promptCapabilities.image` 设为 true 时，图片为 `image` 块，内容是其存储的规范化字节的 base64，并带存储的媒体类型；文件为指向附件服务只读宿主副本的 `resource_link`（`file:` URI、名称与字节大小），由 Casper 用自己的文件工具读取。旧版 Casper 无法接收的图片、附件服务无法读取的图片，以及没有宿主路径的文件，各以一行占位文本发送，且该轮回复开头会有一条说明。读取图片期间中止，则该轮以中止结束且不发送提示，即使附件服务仍完成了读取。

挂载了 `ctx.sessionTitle` 时，会话的标题是 Casper 在 `session_info_update` 中发来的名称，它由请求本身的文字生成，不调用模型。Casper 在处理为对话命名的那个请求时、在输入 `/rename` 之后，以及在已有名称的对话的 `session/load` 回复之后立即发送它；在加载的回放期间和两次提示之间也会接收该名称。名称会像应用截断标题那样截断到 80 字节，并写为一个 `session/title` 事件，来源为 `{kind: 'provider', provider: 'casper'}`，不带模型，引用当前标题所引用的人类消息。之后的名称会替换它，相同的名称不会写两次，在会话还没有任何标题时到达的名称会被丢弃。用户重命名过的标题永远不会被覆盖。不会启动任何生成标题的模型调用，因此不发送名称的较旧 Casper 会保留由开头文字生成的回退标题。

设置 `casperTitles: false` 时，Casper 的名称被忽略，该轮在记录领取的消息后立即启动其提示排队的标题工作，所用路由取自 Agent 选项：即应用的默认模型，也就是新的标准会话发送第一个请求所用的模型。标准会话的标题在记录其第一个模型请求时启动，而 Casper 的请求从不被记录，因此若没有这一步，Casper 会话会一直保留回退标题。该标题的写入方式与标准会话相同，用户重命名过的标题永远不会被覆盖。

提示运行期间插入的引导消息，会以 `_casper/steer` 发给 `initialize` 回复中设置了 `agentCapabilities._meta.casper.steer` 的 Casper，带上该会话的 Casper 对话 id、该消息的块及其消息 id：在提示发出后立即发送，按队列顺序一次一条。该消息会一直留在队列中，直到 Casper 发来已读通知，即带有该 `messageId` 的 `user_message_chunk`；此时该消息按发送时的内容记录为开启下一步的 `user/message`，并在记录前一刻被本轮领取。若该步仍有未结束的调用，该消息会等待这些调用结束并留在队列中，停止也不会清除它。Casper 拒绝或始终未读的消息，以及含有会以占位文本发送的部分或含有会话提及的消息，会连同其后排队的所有消息作为下一轮运行；旧版 Casper 收到的所有消息也是如此。停止会把未读的消息与队列其余部分一起清除。

| Casper 更新 | 会话事件 |
|---|---|
| `agent_message_chunk` 文本 | 实时 `agent/assistant-stream` 帧，最终落为 `assistant/message` |
| `agent_thought_chunk` 文本（Casper 的推理标题与重试） | 同一帧与消息中的推理块，按到达顺序与文本并列；步骤中仍有未结束的调用时，它与文本一起等待 |
| `tool_call` | 该步骤带工具调用块的 `assistant/message`，随后是带 Standard 工具名称与参数的 `tool/call`，或名为 `casper_<tool>`（见[工具卡片](#tool-cards)）；其后的文本开启新步骤 |
| 该步骤其他调用仍未结束时的 `tool_call` | 同一步骤中另一条只含该调用块的 `assistant/message`，随后是它的 `tool/call`，因此存储的每个调用都已声明，会话可以重新打开 |
| `tool_call_update` 完成或失败 | 带 Standard 结果文本与 meta 的 `tool/result`，从不只写状态词；已运行的 shell 步骤记录其退出码且不是错误，其他失败的步骤是错误，被拒绝的审批不是 |
| 仍在进行中的 `tool_call_update` | 不写入任何内容：调用保持打开，已提出的审批框仍在等待回答 |
| 带 `_meta.casper.live` 的仍在进行中的 `tool_call_update`（运行中命令的最新几行） | 步骤中不写入任何内容；`liveOutput` 开启时，这些行进入该命令在[后台任务面板](#jobs-panel)中的任务，任务注册表追加其 `job/registered` 与 `job/settled` 记录 |
| 检查 `tool_call`（已完成或已失败） | 立即写入名为 `casper_check` 的 `tool/call` 及其结果 |
| `plan` | 带完整列表的 `todo/write` |
| 带有 `title` 的 `session_info_update` | `casperTitles` 开启时，一个为会话命名的 `session/title` 事件（见上文），无论是否有提示在运行；缺少或为 null 的标题不改变任何东西 |
| 模型响应后的 `usage_update` | 其上下文窗口（`size`，为正整数时）记为 `request/context`，provider 为 `casper`，model 为 `_meta.casper.model` 中的 `<provider>/<model>`，仅在与会话已有的不同时追加；其 token（`_meta.casper.response`，输入与输出均为计数时）作为 `usage` 块和结算该响应的 `assistant/message` 的 `usage`：带 `toolUse` 的响应由其第一个调用提交，纯文本响应立即提交，因此之后的文本开启新步骤 |
| 带 `_meta.casper.receipt` 的 `agent_message_chunk` | 一个立即结束的 `casper_receipt` 工具调用，结果是回执文本，meta 是回执（不含 `json` 事件），显示为该轮尾部的回执卡片，位于该轮步骤之外，无需展开步骤即可看到结论；无法解析的 meta 按文本处理 |
| 引导消息的 `user_message_chunk` 已读通知 | 该消息的 `user/message`，在该步骤未结束的调用结束后开启下一步；若 Casper 在该步骤中尚未写入任何内容，则并入该步骤 |
| 提示结束（停止、退出或回复）时仍未结束的调用 | 在 `step/end` 之前写入带 `TOOL_OUTCOME_UNKNOWN` 的错误 `tool/result`，与 agent-loop 对失败步骤的记录一致 |
| `session/prompt` 的回复 | 在该轮最后一个 `step/end` 之后、`turn/end` 之前写入 `plugin:casper-agent/conversation` 记录 `{acpSessionId, mark?}`：提示发往的 Casper 对话，以及仅当 Casper 在 `_meta.casper.mark` 中以 `session/fork` 接受的形式（字母、数字、`_` 和 `-`，最多 128 个）发送标记时才有的 `mark`；旧版 Casper 的记录只有 id，被停止或没有回复的提示不写记录 |

回执是最后一个块，因此它的卡片结束该轮；旧脚本只带简单回执 meta 时按文本处理，结束最后一条助手消息。Casper 用 `_meta.casper.note` 标记的提示与模型文本一样按文本显示。提示回复只有在其之前收到的所有更新都写入后才会完成。停止会发送 `session/cancel` 并以中止结束该轮；若 Casper 在 `cancelGraceMs` 内未回复则被结束。工具调用 id 带有每个进程随机的前缀，因此重启后的 Casper 的 id 不会并入先前的卡片。

<a id="jobs-panel"></a>
### 后台任务面板

shell 步骤运行期间，Casper 把它最新的完整几行作为仍在进行中的 `tool_call_update` 发送，标记为 `_meta.casper.live`，文本放在一个围栏中，每次更新替换上一次。Casper 只在其自身的 `acp_live_output` 设置开启（默认）时发送，使用 netconan 期间从不发送。`liveOutput` 开启且挂载了应用的任务注册表（`jobs`）时，Agent 在它自己的作用域中挂接一个任务控制器，因此只有该 Agent 的会话能持有这类任务，也不会有任务工具交给 Casper。步骤的首批行会启动一个类型为 `casper` 的任务，以其命令命名，关联到该步骤的调用，归该会话所有；后台任务面板把它与会话的其他任务一起列出。之后的每次更新只追加新的行：已显示的最后几行中，开启新窗口的最长一段视为已显示；与之毫无重合的窗口会在一个缺口标记之后追加。这些行只保存在内存中的 `log` 通道上，从不写入会话，应用按 Casper 发送的样子显示它们，密钥已由 Casper 隐藏。

任务随步骤结束而结束，状态为 `completed` 或 `failed`；若提示先结束，则为 `killed` 或 `failed`。任务结束后其行即离开，与 Standard 的 shell 调用的行一样。会话日志中会有注册表的 `job/registered` 与 `job/settled` 记录，它们写有命令，与 `tool/call` 已写的一样。在该任务上点停止会停止整个请求，与输入框的停止相同：Casper 收到 `session/cancel`，该轮以中止结束，从不只停止该命令。Casper 没有为其发送任何行的步骤没有对应的行：很快结束的命令、较旧的 Casper、`acp_live_output: off`、被隐藏的命令、行中含有密钥的步骤，或注册表拒绝的任务（例如超过单个会话的上限）。无论哪种情况，步骤的卡片都会得到 Casper 的最终输出。`liveOutput: false` 时不挂接控制器，这些行被丢弃。

<a id="tool-cards"></a>
### 工具卡片

Casper 在 `_meta.casper.tool` 中给每个步骤命名，其 `rawInput` 是模型自己的参数。会话把该步骤记录为做同样事情的 Standard 工具，因此由 Standard 的卡片绘制：编辑与写入用差异卡片，shell 步骤用终端卡片，以及读取预览、搜索卡片与网页卡片。只发送 `rawInput` `{tool, target}` 的旧版 Casper 按这两个字段映射。

| Casper 工具 | 记录为 | 参数 | 结果 |
|---|---|---|---|
| `edit` | `edit` | `file_path`、第一处编辑的 `old_string` 与 `new_string`，有多处时还有 `edits`，按 pi 的 edit 接受的每种形式读取；Casper 用同一个占位文本隐藏两侧时，`old_string` 为 `<not shown: the text it replaced>` | Casper 的文字，或 `Edited <path> (+a −r)`；meta `path` 与 `diffs` |
| `write` | `write` | `file_path`、`content` | Casper 的文字，或 `Created` 或 `Updated <path>`；meta `operation`、`path` 与 `diffs`，新文件的 `diffs` 为空 |
| `bash`、`powershell` | `bash`、`pwsh` | `command`、`description`（Casper 给出的，否则为命令的第一行）、`timeoutMs` | 去掉围栏的输出，退出码 N 不为 0 时其后为 `[exit code: N]` |
| `read` | `read` | `file_path`、`offset`、`limit` | 整个窗口都读出，或 Casper 精确计数了其行数时（窗口在文件结尾之前停止时即如此），为文件信封，带 meta `path`、`offset`、`lines`、`totalLines` 与 `lang`；否则只有文本 |
| `grep` | `grep` | `pattern`、`path`、`include`（只保留 Standard 接受的 glob） | meta `shape: matches`、`files`、`total`、`truncated` |
| `find`、`ls` | `glob` | `pattern`（`ls` 为 `*`）、`path` | meta `shape: paths`、`paths`、`total`、`truncated` |
| `web_search` | `web_search` | `queries` | meta `sources`、`truncated`、`answer` |
| `web_fetch` | `web_fetch` | `url` | meta `url`、`statusCode`、`truncated` |
| `ask` | `ask_user_question` | 一个 id 为 `casper-question` 的问题：`question`、`options`、`multi_select`；以及作为 `description` 的问题本身，即该行的摘要 | 在应用中给出的答案，记为 `{answers}`；否则为 Casper 的文字 |
| [应用工具](#app-tools) | 应用工具自己的名称 | MCP 参数；经 `call_capability` 调用时为其携带的 `arguments` | 应用工具自己的结果与 meta |
| 其他 MCP 工具 | `casper_mcp` | `title`、`description`、输入与 `preview` | Casper 的文字 |
| 其他任何工具 | `casper_<tool>`；工具名已以 `casper_` 开头时（如 `casper_check`）沿用其原名 | `title`、`description`（步骤作用的对象；否则为去掉工具名的标题）、输入与 `preview` | Casper 的文字，或其原始输出的 JSON |

已运行的 shell 步骤无论退出码为何都不是错误。其他失败的步骤是错误，内容为 Casper 的文字；Casper 未发送文字时为 `Casper reported that this step failed.`；若文字是一份 JSON 报告（如失败的检查），其前面会加上一行供该行显示：步骤标题、`failed`，以及报告中的命令与退出码。只有 Casper 报告了绝对路径时才记录 meta 路径，因此该轮的交付物会列出其编辑与写入产生的文件。结果形状不符合预期的步骤保留 Casper 的文本且不带 meta，显示为普通卡片。

<a id="approvals"></a>
### 审批

`session/request_permission` 变成一个 `ctx.userQuestions.ask` 问题，id 为 `casper-permission`，标题为 `Casper`，以 Casper 的选项为标签，拒绝项在前，并带有选项说明。其 detail 是审批框的文本，随后是发起该框的步骤的差异：每个文件的路径，旧行以 `- ` 开头，新行以 `+ ` 开头，最多 120 行，之后是 `… N more lines in the edit step`。标记给 Casper 卡片的审批框还把这些差异作为问题的 `diffs` 带上：路径、旧文本与新文本，每处更改一项。较旧的 Casper 发来的审批框不带差异，只显示文本。选中一个标签即选择该选项。输入文本、未选择、问题失败或被中止，以及没有问题服务时，都回答 `cancelled`，Casper 将其视为“否”。当 Casper 自行关闭审批框或撤回请求，或提示结束时，问题随之关闭。Casper 已关闭的步骤发来的审批框不会打开卡片，并回答 `cancelled`。

本插件的客户端一半用 Casper 的审批卡片显示这样的问题，该卡片注册为对话输入框链的第一项（优先级 -1）。卡片只接管只有一项、带有上述 id 与标题、单选且有 1 到 4 个选项的问题；其他任何问题（包括计划审阅）保留各自的卡片。标题是问题的第一行，其余各行与 detail 以纯文本跟在后面。问题带有 `diffs` 时，卡片用应用的差异视图（即 Standard 模式编辑步骤所用的那个）绘制它们，超过 9 行即折叠，并从文本中去掉这些差异行。只有编辑的审批框带差异：写入的审批框、含有密钥的编辑、某一侧大于 256 KB 的编辑以及 Casper 未检查的路径都只显示文本。`approvalDiff: false` 时，卡片以文本行显示差异。每个选项是一行，按 Casper 的顺序排列，“否”在前，带有编号，说明在其下方。卡片在最初 300 毫秒内不计任何操作，之后聚焦“否”；但若焦点位于输入框区域之外的其他字段，焦点保留在原处。只有焦点在卡片内时其按键才计入，可滚动的详情可以用 Tab 到达。Esc 回答“否”，数字选择对应的行；带修饰键的按键、重复按键以及输入法组字中的按键都不计。Enter 没有自己的处理，因此它点击获得焦点的行。回答只发送一次：卡片保持忙碌，直到 Casper 关闭审批框；发送失败时各行恢复可用。已关闭的问题不作任何回答。`approvalCard: false` 时，或审批框没有拒绝选项时（此时在第一行按 Esc 或 Enter 会回答“是”），审批框不带标题，由通用问题卡片询问。

客户端的 `initialize` 提供 `clientCapabilities.elicitation.form`，因此 Casper 会把 AI 的问题以及它自己需要输入文字或多选的问题作为表单发来，而不是跳过。符合 Casper 形状的 `elicitation/create`（表单模式，一个 `answer` 字段，为带标题的单选、带标题的多选或一行输入文字，以及一个可选的 `other` 字段用于输入文字）变成一个 id 为 `casper-question` 的问题；AI 的问题标题为 `The AI asks`，其余为 `Casper asks`。选中的标签按选择顺序以其值发回，输入的文字以 `other` 发回，一行输入的问题则作为 `answer` 发回。在没有 `other` 的表单上输入文字，以及其他任何形状的表单，都回答 decline；没有回答、问题失败或被中止、提示之外的表单，以及没有问题服务时，都回答 cancel，Casper 视为跳过。表单所属的步骤记录为 `ask_user_question`：即 ask 工具自己的步骤，或 Casper 为自己的问题打开的待处理 `casper-question-N` 步骤。在应用中记录的答案会在 Casper 完成该步骤时成为其结果 `{answers}`，因此 Standard 的问题卡片会显示答案。当 Casper 关闭该步骤或撤回请求，或提示结束时，问题随之关闭。

Casper 的计划 Build 框带有 `_meta.casper.plan`，其中是 Build 与 Change the plan 两个标签，计划本身是以 `# ` 标题开头的 Markdown。它会变成计划审阅：一个标题为 `Plan review` 的问题，以计划为 detail，只提供这两个选项，并带有 `plan-review` 意图与该框步骤的调用 id，因此应用会显示其计划卡片。该步骤记录为 `exit_plan_mode`，参数为 `{plan}`，因此计划卡片与 Plan 标签页可以打开该计划。Build 选择 Build。为了说明要改什么而关闭卡片（Discuss，`ASK_CANCELLED`）会选择 Change the plan，随后 Casper 以表单询问要改什么。超时、中止以及没有问题服务时，都回答 `cancelled`，Casper 视为 Stop。没有这些标签的框，或其标签与任何选项都不对应的框，按普通审批框询问。

<a id="access-control"></a>
### 访问权限

输入框的权限控件（权限预设）设置 Casper 的访问模式。使用默认的 `accessModes` 时，「仅可查看」对应 `read`（Casper 阻止它能识别的每一项更改），「工作区内修改」对应 `ask`（Casper 平常的审批框），「完全权限」对应 `full`（Casper 的 `/permissions all`）。只读沙箱始终对应 `read`；派生的 `custom` 预设、Auto 以及映射表未列出的预设对应 `ask`，绝不对应 `full`。未挂载预设服务时不发送任何内容。

模式通过 Casper 的 `mode` 配置项发送；Casper 只提供 `modes` 时改用 `session/set_mode`。它在每条提示之前、Casper 重启之后以及预设一变化时发送，提示运行期间也是如此；一次切换只发送一个请求。Casper 自己选择的模式，例如“本会话全部同意”或 `/permissions all`，会保留到预设再次变化，且从不改动该控件：只有用户本人的选择会设置预设。例外是「仅可查看」：Casper 一旦离开它，应用会再次设置。

在选择该模式的进程运行期间，输入框会在权限与计划控件之后用一个单独的标签显示这种模式，例如 `Casper set Don't ask`（中文界面为“Casper 已设为不询问”）。该标签只用于显示：它没有操作，不向 Casper 发送任何内容，权限控件与预设保持不变。每次变化都记录为插件记录 `plugin:casper-agent/access` `{mode}`：当 Casper 所处的模式与应用上次为该进程设置的模式不同时为该模式，否则为 `null`；不含本包的应用构建会保留并跳过它。`casperAccess` 投影折叠这些记录，跳过格式错误的记录，并且不计入会话摘要。Casper 回到应用设置的模式、用户在控件上选择另一个模式（包括 Casper 选的那个），以及进程结束时（空闲时关闭、因 MCP 服务器变化而关闭、随会话关闭，或退出），标签都会清除。重新打开的会话若其日志仍记着某个模式（已关闭的应用可能留下这种记录），会在打开时写入 `null`，因此该模式不会显示。`modePill: false` 时不记录任何模式，已显示的标签会在下一次访问同步时清除。

提示之前无法设置「仅可查看」或「工作区内修改」时，该轮以 `CASPER_ACCESS_NOT_APPLIED` 结束，不发送提示；没有模式的 Casper 照常以「工作区内修改」运行。提示运行期间无法设置时，提示停止，该轮同样以此结束；该轮仍在准备提示时（例如读取图片或设置模型期间）切换失败，该轮同样以此结束且不发送提示。无法设置「完全权限」时，回复中留下一条说明，Casper 照常询问。

### Casper 的命令

Casper 通过 `available_commands_update` 发送它的斜杠命令（包括用户自己的 `~/.casper/commands`），在打开对话之后立即发送，列表变化时再次发送；`session/load` 回放期间也会保留该列表。挂载了 `commands` 注册表时，每条命令只为本 Agent 注册，带有 Casper 的描述、输入提示与定义 id `prompt:@deepseek-ai/dsh-casper-agent/<name>`，因此它出现在该会话的 `/` 菜单中，而不出现在其他会话的菜单中。之后的列表替换之前的列表，未变化的列表不注册任何内容。注册表会拒绝的名称、输入框自己的 `model` 与 `file`、没有描述的命令，以及已经解析为其他命令的名称（例如应用的 `/permission`、`/export` 或 `/feedback`）都不会提供；该名称仍归应用的命令。

身份开头的 `PROMPT_COMMAND_ID_PREFIX`（`prompt:`）告诉客户端把这一行当作提示处理（[ui-commands](../../client/ui-commands/README.zh.md)）：选择命令会插入 `/name`，命令接受输入时带一个尾随空格；按 Enter 会把输入的这一行连同附件作为普通提示发送，由 Casper 作为它自己的命令运行。改为执行命令的界面会把同一行排入下一条提示。最后一份列表保存在 Host 存储域 `casper_agent_commands`（一条全局记录）中，每个新 Agent 在自己的 Casper 启动之前就提供它。Agent 只在发布之后才注册命令：每次注册都会让所有客户端重新拉取其 Session 的菜单，而重新拉取会恢复未运行的 Session，因此创建失败的 Agent 不注册任何命令。

Casper 的 `plan` 选项（Plan first：每个请求都先得到一份计划）由输入框的计划标签显示。插件只注册 plan-mode 的 `plan` 投影，从不应用其控制器；每当该选项变化以及每轮结束时，都把 Casper 的值记录为 `plan/mode`，因此作为提示发送的 `/plan`（无论是否带文字）会让标签停在 Casper 留下的状态。当提供该选项的 Casper 正在运行时，`/plan on` 与 `/plan off`（包括标签的退出操作）通过 `session/set_config_option` 设置该选项，不发送提示；否则这一行作为提示发给 Casper。会话进入过 Plan first 之后，重新启动的 Casper 会在第一个提示之前得到会话最后的值；拒绝的 Casper 保留自己的值。不提供该选项的 Casper 从不改变标签。

<a id="model-picker"></a>
### 模型选择器

Casper 在 `session/new` 与 `session/load` 的回复中发送它的选项，并在 `config_option_update` 中再次发送。类别为 `model` 的选项是按提供方分组的模型列表，每个模型在 `_meta.casper.efforts` 中列出它接受的推理等级；类别为 `thought_level` 的选项是推理等级，并为这些值命名。不发送 `_meta.casper.efforts` 的旧版 Casper 会让当前模型使用推理等级选项的值。这里不读取 Casper 的 `mode` 选项。每次变化的列表记录为插件记录 `plugin:casper-agent/models`；没有此包的应用版本会保留并跳过它，因此仍能打开该 Session。`agentModels` 投影跳过格式错误的记录，并向输入框标记与 `/model` 提供该列表、Casper 当前的模型与推理等级，以及它们是否由 Casper 自己发送（[ui-model-selection](../../client/ui-model-selection/README.zh.md#agent-offered-models)）。消息以 Casper 报告的模型标注。

选择交给 Agent，而不是 Host 目录：它会按 Casper 的列表检查，记录为 `model/selection`，并通过 `session/set_config_option` 发送（先 `model`，推理等级不同时再发 `effort`）。Casper 未列出的模型，或该模型不接受的推理等级，会立即被拒绝；没有推理等级的模型不带推理等级。Casper 空闲时选择会立即发送，且不发送提示。在提示运行期间或 Casper 启动之前做出的选择，会在下一轮开始、发送提示之前发送。Casper 拒绝时，该轮以 `CASPER_MODEL_UNAVAILABLE` 结束并附上 Casper 的原话，不发送提示，标记重新显示 Casper 的模型。在前一个选择发送期间做出的选择会接着发送，因此以最后一次选择为准。ACP 无法取消设置请求，因此 Casper 尚未答复设置时按下停止会结束 Casper；选择会保留，并在下一个 Casper 的第一条提示之前送达。Casper 自己更改的模型（例如通过它自己的 `/model`）会移动标记，并标注之后的消息。

新会话在自己的 Casper 启动之前显示保存在 Host 存储域 `casper_agent_models`（一条全局记录）中的列表，设置了配置中的 `model` 时以它为当前模型；在任何 Casper 发送列表之前，选择器会说明 Casper 启动后才会列出模型。恢复的会话保留其历史记录的内容。在记录此列表之前创建的会话，在其 Casper 启动之前会拒绝选择。

<a id="process-lifetime-and-resume"></a>
### 进程生命周期与恢复

Casper 在会话的第一条提示时启动，因此缺少命令不会妨碍打开会话。`session/new` 之后，对话 id 会在发送提示前存入 sidecar。之后的进程用 `session/load` 重新打开它，并丢弃回放的更新，因为会话已经保存了历史；只有 Casper 的“没有已保存对话”回复（`-32002`，消息中含不区分大小写的 "no saved conversation"）会开启新对话，且该轮以一行说明开头，即使该轮随后什么也没有发送。Casper 只在第一次回复后保存对话，因此进程在此之前就停止的对话会以这种方式重新开始。其他加载失败会结束该轮并保留记录。只有当会话的项目文件夹仍是存入记录时的文件夹时，才会使用该记录：文件夹已改变的会话会开启新的 Casper 对话，且该轮没有说明这一点的行。释放时关闭 stdin，等待 `exitGraceMs`，然后终止进程，符合桌面端 10 秒的 Host 退出时限。恢复会像 agent-loop 一样修复中断的轮次，且不启动进程。

每次提示回复还会在会话日志中留下一条 `plugin:casper-agent/conversation` 记录（见[轮次与事件](#turns-and-events)）：该轮发往哪个 Casper 对话，以及 Casper 为其回复在该对话中停下的位置给出的标记。它的用途是让[分叉](#forks)能在该轮处截断 Casper 对话；重新打开仍使用 sidecar。它是插件记录，因此没有此包的应用构建会保留并跳过它，仍能打开会话。无法写入的记录会记为一条警告，该轮照常结束。

会话在 Casper 运行时空闲满 `idleExitMs` 后，插件用 `_casper/idle`（Casper 的决策 91）询问 Casper 能否关闭进程。回复只列出工作的种类：没有提示或模型更改正在进行，也没有开发服务器、命令、调试器、助手或检查仍在工作（包括写给 AI 的说明仍在写入的命令）时，Casper 才算空闲；Casper 自己的 `acp_idle_exit: off` 总是回答不空闲。Casper 回答空闲且期间没有任何工作开始时，进程会像释放时一样被关闭。检查期间的一轮、一次模型选择、一次访问切换或一次「先计划」设置都会保留进程并重新开始计时；Casper 不空闲、10 秒内没有回答或不认识该请求（`-32601`）时也会保留，并在下一个空闲时长后再次询问。下一条提示要等旧进程退出后才启动 Casper，并用 `session/load` 重新打开对话，不会出现新对话的那一行。加载时 Casper 沿用对话自己的模型；若它不是被关闭的进程所用的模型，该轮以 `[Casper reopened on <model>; it was <model>.]` 开头，插件不发送模型设置。被关闭的进程只为本会话允许的内容随之结束：「本会话内都同意」的回答，以及 Casper 自己选的访问模式，其[标签](#access-control)随之清除。重新打开的 Casper 在第一条提示之前会再次得到访问控制的模式和会话的「先计划」值。

<a id="forks"></a>
### 分叉

从某一轮的分支按钮或会话的分叉命令得到的 Casper 会话分叉，包含源会话截至分叉点的消息。`copyOnFork` 开启时，分叉第一次启动 Casper 会复制 Casper 的对话与之对应：它发送 `session/fork`（由 Casper 的 `sessionCapabilities.fork` 提供），带上分叉继承的最后一条 `plugin:casper-agent/conversation` 记录中的对话和标记（作为 `_meta.casper.at`），并像 `session/new` 一样把应用的服务器交给副本。Casper 不回放任何内容，副本沿用源会话的模型。副本的 id 作为分叉自己的对话存入 sidecar，之后的启动用 `session/load` 重新打开它，源会话保留自己的对话。在分叉的 Casper 报告之前，分叉的模型选择器显示源会话的模型。

当 Casper 无法精确复制时，分叉改用 `session/new` 开启新的 Casper 对话，其第一轮以一行开头，说明 Casper 没有上面的消息：Casper 不提供 `session/fork` 或回答 `-32601`、没有该对话（`-32002`）或没有该标记（`-32602`）、分叉没有继承任何记录，或最后一条记录没有标记。标记总是会发送，因此副本不会多于分叉所显示的内容；没有标记就无法证明副本是精确的。`copyOnFork` 关闭时，每个分叉都以这种方式重新开始。分叉从不打开或复用源会话的对话。其他失败会作为启动失败结束该轮，下一轮会再次尝试复制。已经有自己对话（在任何文件夹中）的分叉不会再次复制，上面的文件夹规则仍然适用。

每次启动时，插件会在后台删除 `sessionPersistence.stat` 已找不到的会话的 sidecar 记录；应用本身没有删除会话的功能。已归档的会话仍然保存着，会保留其记录；检查失败的会话也会保留。

<a id="app-tools"></a>
### 应用工具

每个 `casper acp` 进程都有一个专属的 MCP 服务器，在 `initialize` 之后启动，并作为 `session/new` 与 `session/load` 中第一个 `mcpServers` 条目提供，排在[设置中的服务器](#settings-mcp-servers)之前：`type: "http"`，名称 `app`，URL `http://127.0.0.1:<port>/mcp/<pathId>`，一个 `Authorization: Bearer <token>` 请求头，以及 `_meta: {"casper/clientAsks": true}`。路径 id（16 个随机字节）与令牌（32 个随机字节）为每个进程新生成，只在 ACP 管道内传递；它们不会出现在 argv、env、stderr、日志或会话事件中。监听器只绑定 `127.0.0.1`，并按顺序检查每个请求：路径不对为 404，`Host` 不是 `127.0.0.1:<port>` 为 403，带有任何 `Origin` 请求头为 403，令牌不匹配（以恒定时间比较）为 401。进程退出、被终止或被释放时监听器关闭，因此重启后的 Casper 会得到新的路径与令牌，旧的随即失效。

该服务器以 `dsh-desktop` 身份使用 MCP Streamable HTTP，以应用的 dsh 运行时版本作为其版本，不发送 instructions。它不保留 MCP 会话，因此对请求通知流的 GET 回答 405，并声明 `tools.listChanged: false`。它只列出 Casper Agent 能看到的工具，顺序如下，这也是 Casper 选取置顶工具的顺序：

| MCP 工具 | 运行 | 标记 |
|---|---|---|
| `app_skill` | dsh `skill` | 只读，置顶 |
| `plugin_manager` | dsh `plugin_manager` | 置顶 |
| `app_read_file` | 本包的读取器 | 只读，置顶 |
| `present` | dsh `present` | 只读，置顶 |
| `cordis_inspect_query` | dsh `cordis_inspect_query` | 只读 |
| `cordis_inspect_list` | dsh `cordis_inspect_list` | 只读 |
| `subagent` | dsh `subagent` | |
| `send_message` | dsh `send_message` | |
| `interrupt_agent` | dsh `interrupt_agent` | |
| `list_agents` | dsh `list_agents` | 只读 |
| `list_subagent_models` | dsh `list_subagent_models` | 只读 |
| `get_goal` | dsh `get_goal` | 只读 |
| `create_goal` | dsh `create_goal` | |
| `update_goal` | dsh `update_goal` | |
| `team_task_create` | dsh `team_task_create` | |
| `team_task_list` | dsh `team_task_list` | 只读 |
| `team_task_get` | dsh `team_task_get` | 只读 |
| `team_task_update` | dsh `team_task_update` | |
| `list_mcp_resources` | dsh `list_mcp_resources` | 只读 |
| `list_mcp_resource_templates` | dsh `list_mcp_resource_templates` | 只读 |
| `read_mcp_resource` | dsh `read_mcp_resource` | 只读 |

只读工具列出时带有 `readOnlyHint: true`，因此 Casper 运行它时不询问。若某个提供的工具所对应的应用工具是通过 `@deepseek-ai/dsh-mcp-client` 来自某个 MCP 服务器，则改为带上该服务器自己的 `readOnlyHint`、`destructiveHint`、`idempotentHint` 与 `openWorldHint` 列出，本服务器不会自行添加任何提示；上表中没有工具来自 MCP 服务器。

三个资源工具总会列出，使用固定的 schema，其描述按 Casper 的命名（`acp-<name>`）列出此进程获得的设置服务器与插件注册的服务器。调用会把 `acp-<name>` 映射为应用的服务器 `<name>`，并且只在此进程获得的服务器上运行。应用中没有服务器提供资源时，应用没有这些工具，调用返回 "No MCP server in the app offers resources right now."

`present` 来自 Casper 预设的 `@deepseek-ai/dsh-tool-present` 行。调用会针对当前的 Casper 轮次、以发起调用的 Casper 步骤的调用 id 记录 `deliverables/presented`，因此应用会像在 Standard 中一样，在该轮次中把每个文件显示为卡片；轮次结束后到达的调用会得到轮次已结束的错误，并且不记录任何内容。Casper 只保留四个置顶工具，因此 `present` 占用了 `cordis_inspect_query` 原先的置顶位置，Casper 通过 find_capability 找到 `cordis_inspect_query`。

每次调用都通过 `ctx.tools.execute` 运行，并以 Casper Agent 作为 `agent`，因此工具看到的会话、profile 与审批与在 DeepSeek 循环中相同。调用 id 是发起该调用的 Casper 步骤的会话调用 id，取自 `_meta["casper/acpToolCallId"]`；没有该字段的调用会得到新的 id。只有在 Casper 轮次运行期间才接受调用，并随轮次一起中止；轮次结束后到达的调用会得到说明这一点的错误。未完成的调用每 10 秒发送一次进度通知，使 Casper 的空闲计时器不会到期。结果中的文本块作为 MCP 文本传递。`appToolImages` 开启时，每张图片在原位置作为 MCP 图片内容发送：内容是其存储的规范化字节的 base64，并带存储的媒体类型（PNG、JPEG、WebP 或 GIF）。回复超过 8 MiB 时 Casper 会让该次调用失败，因此文本和前面的图片必须在 7 MiB 内留出空间：放不下的图片变成 "[A picture in this result was not sent: with it the reply would pass the 8 MB Casper takes.]"，应用读不出的图片变成 "[A picture in this result could not be read, so it was not sent.]"。工具推迟到下一步的上下文跟在结果之后，共用这一额度。失败的结果（Casper 本来就会丢弃其中的图片）以及 `appToolImages` 关闭时的所有结果中，每张图片都变成 `[image result not sent]`，且不会被读取。Casper 每个结果最多保留 8 张图片，并把每张缩小到符合其自身限制；不支持 MCP 图片的旧版 Casper、无法看图的模型，或 Casper 设置了 `mcp_pictures: off` 时，模型看到的是 Casper 自己的说明。其他任何块（例如推理）会变成一行说明，如 `[reasoning result not sent]`。

`plugin_manager` 保留自己的规则：应用隐藏的 bundle 以 `not-offered` 拒绝，每个操作（包括 `install_bundle`）都像在 DeepSeek 循环中一样通过应用自己的审批卡片询问。`clientAsks` 告诉 Casper 该卡片就是关口，因此 Casper 不会为此服务器显示自己的变更框，它的自动回答也永远不会批准安装。在「完全权限」下应用的卡片不再询问，因此处于 `full` 模式的 Casper 会忽略 `clientAsks`，改用自己的框询问：无论哪种情况都只有一个框。

`app_skill` 的描述在 1,000 个字符以内列出 Agent 可加载的技能，以 `cordis-plugin-development` 开头。加载的技能以一行说明开头，告诉 Casper 在其工作区中编写 bundle、用 `app_read_file` 读取技能文件，并使用它获得的 `DSH_PROFILE` 与 `DSH_PROFILE_DIR`；在已安装的应用中，这行说明还会指出那里的包没有 `lib/types`、`src` 与仓库文档，因此插槽属性与主题令牌取自 `cordis_inspect_query`。`app_read_file` 只读取存放应用已安装包的目录（本包之上最近的 `node_modules`；在源码检出中为其 `packages` 与 `docs` 目录）以及 profile 的 `node_modules`。路径以 `path.relative` 比较，真实路径离开该目录的符号链接会被拒绝。一次调用最多按行窗口返回 256 KB 文本；超过这一长度的单行会截取前 256 KB，说明中会注明，下一个窗口从它之后开始。SVG 以外的二进制文件得到一行说明，目录最多列出 500 项，超过 32 MB 的文件会被拒绝。

<a id="subagents"></a>
### 子代理

这五个子代理工具来自预设的 `tool-subagent` 与 `tool-subagent-control` 条目，在 `appSubagents` 开启时提供。它们不置顶，因此 Casper 的固定提示大小不变；Casper 通过其工具搜索（find_capability）找到它们，就像找到 `cordis_inspect_query` 一样。关闭后，这些条目仍会挂载，但工具不会提供给 Casper。

`subagent` 为 Casper 会话启动一个子代理，与标准会话中相同。子代理是运行在 DeepSeek 代理循环上的标准代理：它挂载 `standard` 预设，因为 `casper` 预设没有 shell 与文件工具；Casper 路由从不接收子代理，因此不会再启动第二个 `casper acp`。它在会话的文件夹中工作，并以 Casper 会话为父会话列在其下。该调用以 Casper Agent 的身份、在其发起者边界内运行，因此子代理与标准父会话的调用一样归属于 Casper 会话，Casper 的步骤显示应用的子代理卡片。子代理在会话的路由上运行；调用中的 `provider` 与 `model` 只能在应用的模型设置允许时指定其他路由。

当应用有一个提供方 id 相同的路由，且该路由的适配器认识同一个模型 id 时（例如 Casper 与应用都使用 `openrouter`），会话的路由就是 Casper 当前的模型。只有当应用为该模型列出了 Casper 的推理等级时，才会一并采用该等级，因此 Casper 的 `auto` 从不采用，而由模型自己的默认值生效。不按相近的名称匹配：提供方在应用中没有路由的 Casper 模型，例如 `claude-subscription`，或应用的模型页面没有 `openai-codex` 路由时的 `openai-codex`，会让子代理留在应用的默认模型上。每当 Casper 报告另一个模型、重新打开的会话启动以及应用的路由变化时，都会检查一次匹配；检查完成之前使用应用的默认模型。匹配只看路由而不看密钥，因此匹配到但未设置密钥的路由会让子代理的第一次请求失败，该失败作为子代理的通知返回。Casper 调用的、读取会话路由来检查图片或为图片计价的应用工具（例如 MCP 工具返回的图片结果）也会看到同一路由。设置 `casperTitles: false` 时，标题仍使用应用的默认模型。设置 `casperChildModel: false` 时，所有子代理都在应用的默认模型上运行。

该调用立即返回。子代理完成时，应用的完成通知会发给 Casper：Casper 一轮正在运行时作为引导消息，Casper 空闲时作为下一条提示，这会开始新的一轮 Casper。`send_message`、`interrupt_agent`、`list_agents` 与 `list_subagent_models` 对 Casper 的子代理的作用，与对标准父会话的子代理相同。`wait_agent` 不提供：无论发送多少进度，Casper 都会在 10 分钟后结束任何 MCP 调用，这会使更长的等待失败，并在本次任务剩余时间内失去应用工具；而且通知本来就会自行到达。

子代理与标准会话的子代理一样遵循应用自己的规则，而不是 Casper 的私密位置列表。它们使用应用的沙箱，从不询问（任何需要询问的操作都会被拒绝），并且只有在 Casper 会话处于 Auto 或「完全权限」时才获得相应权限。因此，子代理可能读取 `~/.ssh` 这类 Casper 自己会询问或拒绝的位置。Casper 自己的读取不变。Casper 的访问模式仍作用于调用本身：在「仅可查看」下，Casper 拒绝 `subagent`、`send_message` 与 `interrupt_agent`；在「完全权限」下，Casper 忽略 `clientAsks`，在自己的审批框中询问，选择「本会话内都同意」后会覆盖之后的调用，与 `plugin_manager` 相同；「工作区内修改」不增加审批框。子代理在 Casper 自己的步骤之外改动文件。

<a id="goals"></a>
### 目标

预设的 `command-goal` 与 `tool-goal` 条目让 Casper 会话使用应用的 `/goal` 命令与目标工具。目标服务、它的轮次驱动器与目标栏属于应用，已对每个会话生效。在 Casper 会话中输入 `/goal <目标>` 设置目标的方式与标准会话相同，目标栏会显示它。Casper 自己没有 `/goal`，即使有同名命令，应用的命令也会优先。

`appGoals` 开启时，应用工具还会提供 `get_goal`、`create_goal` 与 `update_goal`，排在子代理工具之后且不置顶，因此 Casper 的固定提示大小不变。每次调用都以 Casper Agent 的身份、在其发起者边界内运行，因此应用的目标检查能看到当前的 Casper 轮次。`create_goal`，以及带 `edit`、`pause` 或 `resume` 的 `update_goal`，需要由用户发起的一轮；`complete` 与 `blocked` 在该目标自己的轮次中也可使用。标准代理在系统提示中读取目标规则，而 Casper 看不到系统提示，因此 `create_goal` 与 `update_goal` 在描述末尾带上这些规则。`update_goal` 在目标的轮次中把目标标为完成或受阻时，应用的收尾说明（标准代理会在下一步作为上下文收到）会跟在工具结果之后。

驱动器排入的每一轮都作为一轮 Casper 运行，其提示就是该轮的文本。在记录这一轮之前，Casper 轮次会像 DeepSeek 循环在每一步之前那样运行应用的 `agent/pre-step` 检查，传入认领的消息，并以 Casper 当前的模型作为路由。驱动器会拒绝已不再有效的一轮，例如在 Casper 忙于其他工作时排入、随后又被 `/goal edit`、暂停或清除改动的一轮，并把认领的其他消息放回队列。被拒绝的一轮不记录也不发送任何内容，以 `blocked` 结束；放回的消息作为下一轮运行。只有拒绝才算数：检查添加的消息（例如技能列表或模型提示）是给 DeepSeek 循环的请求用的，不会发送。其他轮次不运行检查。在检查期间或读取被提及的会话时按下停止，这一轮会被丢弃而不记录，驱动器随之暂停目标。Casper 以错误结束的一轮（例如达到其轮次上限）会像 DeepSeek 循环那样报告该错误，因此驱动器不再排入新的轮次；普通轮次的错误不会这样报告。

`appGoals` 关闭时，这些条目仍会挂载，因此 `/goal` 仍能设置目标，但工具不会提供，到期的一轮会被丢弃，既不检查也不发送提示。只含这一轮的轮次以 `blocked` 结束；与它一起认领的其他消息仍会运行。驱动器随后暂停目标。

Casper 的访问模式对这些调用的作用与子代理工具相同：在「仅可查看」下，Casper 拒绝 `create_goal` 与 `update_goal`；在「完全权限」下，Casper 在自己的审批框中询问；「工作区内修改」不增加审批框。

<a id="team"></a>
### 团队

Casper 会话的模型菜单与标准会话一样显示应用的**启用智能体团队协作**开关。该开关保存在 Casper 会话上，而 Casper 会话是其会话树的根，因此它也为 Casper 用 `subagent` 启动的标准子代理打开团队模式：子代理获得任务板工具与团队规则，并读取同一个任务板。新会话默认关闭团队模式。

`appTeams` 开启时，应用工具还会提供 `team_task_create`、`team_task_list`、`team_task_get` 与 `team_task_update`，排在目标工具之后且不置顶。Casper 每个连接只读取一次工具列表，因此无论团队模式开关如何，这些工具都会列出。每次调用都会像标准步骤提供这些工具之前那样，为该会话运行应用自己的团队检查，并以 Casper 当前的模型作为路由；团队模式关闭时，调用返回 "Team is off for this Session; the person can turn on Enable agent teamwork in the model menu."，不运行任何操作。标准代理在系统提示中读取团队规则，因此 `team_task_create` 在描述末尾带上这些规则。这些调用以 Casper Agent 的身份、在其发起者边界内运行，Casper 的访问模式对它们的作用与目标工具相同。

`appTeams` 关闭时，Casper 不会得到这四个工具。开关仍会显示，因为模型菜单无法读取本插件的设置；它仍会为 Casper 的标准子代理打开团队模式。

<a id="settings-mcp-servers"></a>
### 设置中的 MCP 服务器

当 Casper 的 `initialize` 回复把 `mcpCapabilities.http` 设为 true 时（除非 Casper 的 `acp_mcp` 为 off，否则都会如此），每个进程还会在应用工具服务器之后获得「设置 > MCP 服务器」中已启用的服务器（`ctx.mcpManager` 配置的条目），按设置中的顺序最多 7 个。Casper 在该会话中以 `acp-<name>` 连接它们，并在它们做出每项更改前用自己的框询问：这些条目从不带 `casper/clientAsks`。命令不是绝对路径的 stdio 服务器会像应用启动它时那样查找命令，其 `env` 变为 ACP 的列表，设置了的 `cwd` 作为 `_meta["casper/cwd"]` 发送；streamable-http 服务器以 `type: "http"` 及其请求头发送。

插件向 MCP 管理器注册的服务器（`ctx.mcpManager.registeredEntries()`）排在其后，按注册顺序，并共用同样的 7 个名额：设置中的服务器先占名额，第七个之后的服务器会被略过，日志中留下与其他服务器相同的一行 `at most 7 servers are forwarded`。因其他原因被略过的服务器会把名额让给下一个。插件注册的服务器遵守下面的全部规则；插件加载或卸载时，与设置中的更改一样，会在下一轮到达 Casper。内置的 network 服务器是自成一行的 MCP 客户端条目，不是注册的服务器，因此不在其中。

凭据（`${credential:NAME}`）通过 `ctx.credentials` 解析，其值在 ACP 请求中发送，从不出现在 argv、env、日志或会话事件中；Casper 会在其显示的内容中隐藏每个这样的值及其 URL 编码形式。凭据只能是整个 env 或请求头的值，或者跟在 `Bearer`、`Basic`、`Token`、`Bot` 或 `ApiKey` 和一个空格之后。以下情况下服务器会被略过，并在应用日志中留下一行，写明其名称和固定原因但不含任何值：已停用、名为 `app`、命令、args、cwd 或 url 中带有凭据或凭据位于更长的值中、设置了 `PATH`、`NODE_OPTIONS`、`LD_*` 或 `DYLD_*`、设置了由连接自己管理的请求头（`Host`、`Content-*`、`Connection`、`Transfer-Encoding`、`Mcp-*`、`Cookie`、`Origin`）、cwd 为相对路径、引用的凭据未设置或无法读取、命令找不到，或 5 秒内未准备好。

共有四个关闭开关：设置中服务器自己的开关、本插件的 `forwardMcpServers: false`（同时略过插件注册的服务器）、只针对插件注册服务器的 `forwardPluginMcpServers: false`，以及 Casper 的 `acp_mcp: off`。设置中的更改、插件的加载或卸载，或凭据的变化会在下一轮到达 Casper：在发送提示之前会重新构建列表，若与之前不同（以保存在内存中的 SHA-256 比较），进程会被关闭，该轮通过 `session/load` 用新列表重新打开对话。这次重新打开会结束 Casper 的「本会话内都同意」回答。无法构建的列表会保留正在运行的进程；若列表因凭据无法读取、命令查找失败或 5 秒内未就绪而漏掉 Casper 已获得的服务器，也会保留该进程。更改从不打断提示。每个对话都运行各 stdio 服务器自己的副本。

<a id="session-mentions"></a>
### 会话提及

消息可以按输入框插入的形式 `@[label](dsh-session:…)` 提及其他会话。挂载了 `ctx.sessionReferenceResolver` 时，该轮在其消息仍在队列中时读取它们，因此读取期间崩溃不会丢失这些消息，并在启动 Casper 之前读取；期间被编辑的消息会重新读取：每条用户消息的文本由 `parseSessionReferenceText` 解析，服务的 `prepare` 在其常规预算下读取所提及的会话（最多 3 个，且不能是本会话），provider 为 `casper`，model 为该轮的模型标签。随后提示先带上消息的文字，其中每个提及写作 `@label`，再跟一个 `resource` 块：`uri` 是第一个被提及会话的 `encodeSessionReferenceUri`，`mimeType` 为 `text/markdown`，`text` 是服务为所有被提及会话生成的不可信快照。Casper 把没有文件对应的嵌入文本当作上下文而不是请求来读（Casper 的决定 90），因此不会据此列出检查清单或提议，`/` 命令也只取输入的文字。决定 90 之前的 Casper 同样设置 `promptCapabilities.embeddedContext`，却把这段文本当作请求的一部分来读，而其 `initialize` 回复无法区分两者，因此这需要带有决定 90 的 Casper。

当 Casper 的 `initialize` 回复没有设置 `promptCapabilities.embeddedContext` 时，快照改以 `text` 块发送；超过 250 KiB 时也是如此，因为 Casper 会截断超过 256 KiB 的嵌入文本，这种情况下回复开头会写 "The referenced sessions went as plain text because they are large."。会话日志保留输入时的消息及其提及，并紧接在该消息之后记录服务的上下文消息（`user/message`，来源类型 `session-reference`，形式 `recall`），其快照文本与 Casper 收到的相同，与标准会话的记录方式一致。无法发送的提及会让该轮以服务的代码结束（`SESSION_REFERENCE_SELF_REFERENCE`、`SESSION_REFERENCE_READ_FAILED`、`SESSION_REFERENCE_INVALID_REFERENCE`、`SESSION_REFERENCE_TOO_MANY`、`SESSION_REFERENCE_BUDGET_EXCEEDED`），且不启动 Casper；读取会话期间停止则该轮以中止结束，其消息仍会记录。没有该服务时，提及按输入的文本发给 Casper。带有提及的引导消息不会被引导发送：它作为下一轮运行，以便读取其提及。

<a id="model-experience"></a>
## 模型体验

无，因为 Casper 进程自行构造模型请求，本插件不向应用自己的 agent 循环的任何请求添加内容。应用工具的名称、描述与结果会进入 Casper 自己的请求，资源工具的描述还会列出交给 Casper 的服务器，被提及会话的快照也会作为上下文进入 Casper 的请求。

#### KV Cache 影响

本插件不发送模型请求，因此对缓存没有影响；Casper 自己的请求不在本仓库之内。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- `initialize` 回复未设置 `promptCapabilities.image` 的 Casper 会收到占位文本，而不是每张图片。
- 选择按 Casper 最后发送的列表检查；Casper 之后发现已退出登录的模型，会在发送选择时被拒绝。
- 自身既无文本也无调用的响应，其用量计入下一个调用的步骤；若接着出现的是文本，则不计入；不发送 `usage_update` 的 Casper 不显示上下文环与 token 数。提示看起来与模型文本相同。推理只显示 Casper 作为思考发送的标题与重试，不显示模型自身的推理。`session/load` 的回放也不显示。
- 正在运行的 shell 步骤在结束前不显示输出。
- 自成一行的 MCP 客户端条目（例如内置的 network 服务器）尚不会交给 Casper；只有「设置 > MCP 服务器」和插件向 MCP 管理器注册的服务器会。每个对话都会启动各 stdio 服务器自己的副本。
- 目前提供的工具都不返回图片；会返回图片的应用文件读取与浏览器截图并未提供。不向模型展示 MCP 图片的 Casper 仍会收到图片字节，每次回复最多 7 MiB。
- 在打包的应用中，`app_read_file` 能读到每个已安装包的 `README.md`、`package.json` 与构建出的 `lib/*.js`、技能文件，以及 `ui-theme` 的 `lib/styles`。Desktop 运行时副本会去掉所有 `.d.ts`，各包不发布 `src/`，仓库的 `docs/` 也不在任何包中，因此那里无法读取 `lib/types`、`ui-sidebar` 的 `slots.ts`、`docs/cordis-tutorial` 与 `docs/web-styling.md`；插槽属性与主题令牌改由 `cordis_inspect_query` 获得。尚未随应用提供这些指南。
- Casper 的审批卡片只为编辑的审批框绘制差异。Casper 在写入的审批框中不发送差异，含有密钥、某一侧大于 256 KB 或涉及其未检查路径的编辑也不发送，因此这些审批框只显示文本。
- 应用未经正常关闭就退出后，在会话下次打开之前，会话日志仍记着 Casper 自己选择的访问模式；只有打开的会话会清除它。
- 对 `initialize` 回复中未设置 `agentCapabilities._meta.casper.steer` 的旧版 Casper，引导消息作为下一条提示送达。
- 在本应用中还没有任何 Casper 发送过命令列表之前，Casper 的命令不会出现在 `/` 菜单中，直到会话的第一条提示启动 Casper。
- 被停止的轮次，或 Casper 以错误结束的轮次，不写标记，因此在该轮分叉时只复制到前一轮为止的 Casper 对话，而分叉仍显示该轮的输出。此时分叉的第一轮以一行开头，说明 Casper 可能没有那条请求。提示到达 Casper 之前就失败的轮次（例如 Casper 拒绝了所选模型）不影响副本的精确性，也不会加这一行。
- `dsh --profile acp` 与 SDK 服务器重新打开已存储的会话时不传预设，也没有 Casper 驱动，因此在那里重新打开的 Casper 会话运行在 DeepSeek agent 循环上，并使用该应用选择的模型，而不是在 Casper 中运行。桌面端下次打开它时，Casper 会重新加载自己的对话，其中没有在别处添加的轮次。一次性运行器会拒绝记录了预设的会话，webhook 只会在其规则指定的预设上创建新会话。
- 没有保存预设的定时任务在 Casper 中运行：在自动化任务页面创建的任务会在默认预设上创建其会话，而桌面端的默认预设是 Casper，除非设置中指定了其他预设。由 Standard 会话的提醒工具创建的任务会保留该会话的预设，指向现有 Casper 会话的任务会作为其下一条提示在那里运行。Casper 会话自身没有提醒工具。
- 只有 macOS 与 Linux 上的桌面端运行过 Casper 会话。在 Windows 上，可执行文件查找只由单元测试检查，且应用不会读取安装程序保存的 Path，因此不在应用自身环境中的自定义安装文件夹要在应用重启后才能找到。
- 已删除会话的 sidecar 记录要到下次启动时才会删除；已归档的会话会保留其进程，直到空闲满 `idleExitMs`。决策 91 之前的 Casper 在空闲时不会被关闭。
- `appTeams` 关闭时，Casper 会话中仍显示团队开关，并且它仍控制其标准子代理。Casper 的子代理是标准代理，只有应用有相同路由时才使用 Casper 的模型，否则使用应用的默认模型；它们遵循应用的规则而不是 Casper 的私密位置，并且不能用 `wait_agent` 等待。
- `casperTitles` 关闭时，Casper 会话的标题由应用的默认模型（可能是 DeepSeek 模型）生成，而不是由 Casper 所运行的模型生成。
- 用户在应用中给 Casper 会话起的名称会保留，因此之后向 Casper 输入的 `/rename` 只会重命名 Casper 自己的对话。在 Casper 发送名称之前就已有标题的会话，可能会在 Casper 下次重新打开它时采用 Casper 保存的名称。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
