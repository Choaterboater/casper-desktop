---
description: "Casper agent 驱动器：Casper 预设上的会话通过 Casper 的 ACP 服务器运行 Casper agent，而不是 DeepSeek agent 循环；涵盖配置、事件映射、审批、进程生命周期与恢复。"
kind: "package-reference"
---

# @deepseek-ai/dsh-casper-agent

[English](README.md) | 中文

## 概述

本插件让 Casper agent 成为 `casper` 预设上会话的主 AI。`ctx.agents` 上的一条工厂路由让每个这样的会话由一个 `casper acp` 进程驱动，而不是 DeepSeek agent 循环。Casper 的文本、工具步骤、检查、计划与回执都成为普通会话事件，因此桌面端的对话记录、工具卡片、待办列表与停止按钮照常工作。Casper 的审批框以问题形式呈现给用户。每个进程还会通过一个私有 MCP 服务器获得应用自身的工具，用于检查应用和安装插件。桌面端的新会话默认使用此预设。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

桌面端 profile 通过 `packages/bundle/web-app/cordis.patch.yml` 挂载本插件（条目 `casper-agent`，在桌面端以外和浏览器内预览中禁用），并在 `packages/bundle/web-app/presets/casper.patch.yml` 中声明 `casper` 预设。该预设挂载 `tool-todo`（用待办列表展示 Casper 的计划），以及应用工具所运行的条目：`tool-cordis`、`skill-filesystem`（使用 Cordis 预设的技能目录）、`tool-skill` 与 `tool-plugin-manager`；后者绑定应用已有的插件管理器，应用不带 profile 运行时关闭。检查插件与插件市场不会挂载。在桌面端，预设注册表的默认值为 `casper`；设置中保存的默认值仍然优先。本插件注入 `agents`、`sessions`、`sessionProjections`、`sessionPersistence`、`subprocess`、`storageDomain` 与 `tools`，并在挂载了 `userQuestions`、`skills`、`profileContext` 与 `attachments` 时使用它们。

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
| `appTools` | `true` | 向 Casper 提供应用工具；`false` 时发送空的 `mcpServers` 列表 |

子进程不会收到 `DEEPSEEK_*` 或 `DSH_*` 名称，也不会收到 `env` 未列出的凭据类名称。唯一的例外是应用 profile：应用带 profile 运行时，Casper 会收到 `DSH_PROFILE` 与 `DSH_PROFILE_DIR`，使它构建的 bundle 能指明要安装到的 profile。

会话在 Casper 预设上创建时即成为 Casper 会话。空白会话不能在 Casper 与其他预设之间切换：预设注册表以 `agent-preset/locked` 与 `newSession: true` 拒绝这种切换，模式选择器则改为在所选预设上开启新会话。已存储的会话由其记录的预设所选择的工厂恢复；未记录预设的会话仍使用 agent-loop。

无法运行的轮次在 `turn/end` 上以错误结束：找不到命令时为 `CASPER_NOT_FOUND`，Casper 未能启动时为 `CASPER_START_FAILED`，轮次中途退出时为 `CASPER_EXITED`，提示中没有 Casper 能读取的内容时为 `CASPER_EMPTY_PROMPT`：没有文本、图片或文件，或只有无法发送的图片和文件（不会向 Casper 发送任何内容），达到 Casper 的轮次上限时为 `CASPER_TURN_LIMIT`，收到错误回复时为 `CASPER_RPC_<code>`。会话仍可使用；下一条提示会再次启动 Casper。`CASPER_TEXT_ONLY` 已不再产生，只出现在早期版本保存的轮次中。

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
| [`src/views.ts`](src/views.ts) | 把 Casper 的工具步骤记录为做同样事情的 Standard 工具：名称、参数、结果文本与 meta |
| [`src/permission.ts`](src/permission.ts) | 把审批框变成用户问题，并把答案映射回去 |
| [`src/sidecar.ts`](src/sidecar.ts) | Host 存储域 `casper_agent`，把每个会话映射到其 Casper 对话 |
| [`src/app-tools.ts`](src/app-tools.ts) | 应用工具 MCP 服务器：监听、认证、工具列表，以及以 Casper Agent 身份运行的调用 |
| [`src/app-read.ts`](src/app-read.ts) | `app_read_file`：对应用安装目录与 profile 目录的只读访问 |

### 轮次与事件

每轮领取排队的输入，原样追加 `turn/start`、`step/start` 与领取的 `user/message` 事件，然后在 Casper 能改动文件之前刷写会话。领取的消息作为一条 `session/prompt` 发给 Casper，各块保持原有顺序：文本为 `text`；当 Casper 的 `initialize` 回复将 `promptCapabilities.image` 设为 true 时，图片为 `image` 块，内容是其存储的规范化字节的 base64，并带存储的媒体类型；文件为指向附件服务只读宿主副本的 `resource_link`（`file:` URI、名称与字节大小），由 Casper 用自己的文件工具读取。旧版 Casper 无法接收的图片、附件服务无法读取的图片，以及没有宿主路径的文件，各以一行占位文本发送，且该轮回复开头会有一条说明。读取图片期间中止，则该轮以中止结束且不发送提示，即使附件服务仍完成了读取。提示运行期间 Casper 不接受输入，因此引导消息会等到下一轮。

| Casper 更新 | 会话事件 |
|---|---|
| `agent_message_chunk` 文本 | 实时 `agent/assistant-stream` 帧，最终落为 `assistant/message` |
| `tool_call` | 该步骤带工具调用块的 `assistant/message`，随后是带 Standard 工具名称与参数的 `tool/call`，或名为 `casper_<tool>`（见[工具卡片](#tool-cards)）；其后的文本开启新步骤 |
| 该步骤其他调用仍未结束时的 `tool_call` | 同一步骤中另一条只含该调用块的 `assistant/message`，随后是它的 `tool/call`，因此存储的每个调用都已声明，会话可以重新打开 |
| `tool_call_update` 完成或失败 | 带 Standard 结果文本与 meta 的 `tool/result`，从不只写状态词；已运行的 shell 步骤记录其退出码且不是错误，其他失败的步骤是错误，被拒绝的审批不是 |
| 仍在进行中的 `tool_call_update` | 不写入任何内容：调用保持打开，已提出的审批框仍在等待回答 |
| 检查 `tool_call`（已完成或已失败） | 立即写入名为 `casper_check` 的 `tool/call` 及其结果 |
| `plan` | 带完整列表的 `todo/write` |
| 提示结束（停止、退出或回复）时仍未结束的调用 | 在 `step/end` 之前写入带 `TOOL_OUTCOME_UNKNOWN` 的错误 `tool/result`，与 agent-loop 对失败步骤的记录一致 |

回执是最后一个文本块，因此它结束最后一条助手消息。提示回复只有在其之前收到的所有更新都写入后才会完成。停止会发送 `session/cancel` 并以中止结束该轮；若 Casper 在 `cancelGraceMs` 内未回复则被结束。工具调用 id 带有每个进程随机的前缀，因此重启后的 Casper 的 id 不会并入先前的卡片。

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
| [应用工具](#app-tools) | 应用工具自己的名称 | MCP 参数；经 `call_capability` 调用时为其携带的 `arguments` | 应用工具自己的结果与 meta |
| 其他 MCP 工具 | `casper_mcp` | `title`、输入与 `preview` | Casper 的文字 |
| 其他任何工具 | `casper_<tool>`；工具名已以 `casper_` 开头时（如 `casper_check`）沿用其原名 | `title`、输入与 `preview` | Casper 的文字，或其原始输出的 JSON |

已运行的 shell 步骤无论退出码为何都不是错误。其他失败的步骤是错误，内容为 Casper 的文字；Casper 未发送文字时为 `Casper reported that this step failed.`。只有 Casper 报告了绝对路径时才记录 meta 路径，因此该轮的交付物会列出其编辑与写入产生的文件。结果形状不符合预期的步骤保留 Casper 的文本且不带 meta，显示为普通卡片。

### 审批

`session/request_permission` 变成一个 `ctx.userQuestions.ask` 问题，以 Casper 的选项为标签，拒绝项在前。选中一个标签即选择该选项。输入文本、未选择、问题失败或被中止，以及没有问题服务时，都回答 `cancelled`，Casper 将其视为“否”。当 Casper 自行关闭审批框或提示结束时，问题随之关闭。

### 进程生命周期与恢复

Casper 在会话的第一条提示时启动，因此缺少命令不会妨碍打开会话。`session/new` 之后，对话 id 会在发送提示前存入 sidecar。之后的进程用 `session/load` 重新打开它，并丢弃回放的更新，因为会话已经保存了历史；只有 Casper 的“没有已保存对话”回复（`-32002`，消息中含不区分大小写的 "no saved conversation"）会开启新对话，且该轮以一行说明开头，即使该轮随后什么也没有发送。Casper 只在第一次回复后保存对话，因此进程在此之前就停止的对话会以这种方式重新开始。其他加载失败会结束该轮并保留记录。释放时关闭 stdin，等待 `exitGraceMs`，然后终止进程，符合桌面端 10 秒的 Host 退出时限。恢复会像 agent-loop 一样修复中断的轮次，且不启动进程。

<a id="app-tools"></a>
### 应用工具

每个 `casper acp` 进程都有一个专属的 MCP 服务器，在 `initialize` 之后启动，并作为 `session/new` 与 `session/load` 中唯一的 `mcpServers` 条目提供：`type: "http"`，名称 `app`，URL `http://127.0.0.1:<port>/mcp/<pathId>`，一个 `Authorization: Bearer <token>` 请求头，以及 `_meta: {"casper/clientAsks": true}`。路径 id（16 个随机字节）与令牌（32 个随机字节）为每个进程新生成，只在 ACP 管道内传递；它们不会出现在 argv、env、stderr、日志或会话事件中。监听器只绑定 `127.0.0.1`，并按顺序检查每个请求：路径不对为 404，`Host` 不是 `127.0.0.1:<port>` 为 403，带有任何 `Origin` 请求头为 403，令牌不匹配（以恒定时间比较）为 401。进程退出、被终止或被释放时监听器关闭，因此重启后的 Casper 会得到新的路径与令牌，旧的随即失效。

该服务器以 `dsh-desktop` 身份使用 MCP Streamable HTTP，以应用的 dsh 运行时版本作为其版本，不发送 instructions。它不保留 MCP 会话，因此对请求通知流的 GET 回答 405，并声明 `tools.listChanged: false`。它只列出 Casper Agent 能看到的工具，顺序如下，这也是 Casper 选取置顶工具的顺序：

| MCP 工具 | 运行 | 标记 |
|---|---|---|
| `app_skill` | dsh `skill` | 只读，置顶 |
| `plugin_manager` | dsh `plugin_manager` | 置顶 |
| `app_read_file` | 本包的读取器 | 只读，置顶 |
| `cordis_inspect_query` | dsh `cordis_inspect_query` | 只读，置顶 |
| `cordis_inspect_list` | dsh `cordis_inspect_list` | 只读 |

每次调用都通过 `ctx.tools.execute` 运行，并以 Casper Agent 作为 `agent`，因此工具看到的会话、profile 与审批与在 DeepSeek 循环中相同。调用 id 是发起该调用的 Casper 步骤的会话调用 id，取自 `_meta["casper/acpToolCallId"]`；没有该字段的调用会得到新的 id。只有在 Casper 轮次运行期间才接受调用，并随轮次一起中止；轮次结束后到达的调用会得到说明这一点的错误。未完成的调用每 10 秒发送一次进度通知，使 Casper 的空闲计时器不会到期。结果中的文本块作为 MCP 文本传递；其他任何块（例如图片）会变成一行说明，如 `[image result not sent]`。

`plugin_manager` 保留自己的规则：应用隐藏的 bundle 以 `not-offered` 拒绝，每个操作（包括 `install_bundle`）都像在 DeepSeek 循环中一样通过应用自己的审批卡片询问。`clientAsks` 告诉 Casper 该卡片就是关口，因此 Casper 不会为此服务器显示自己的变更框，它的自动回答也永远不会批准安装。

`app_skill` 的描述在 1,000 个字符以内列出 Agent 可加载的技能，以 `cordis-plugin-development` 开头。加载的技能以一行说明开头，告诉 Casper 在其工作区中编写 bundle、用 `app_read_file` 读取技能文件，并使用它获得的 `DSH_PROFILE` 与 `DSH_PROFILE_DIR`；在已安装的应用中，这行说明还会指出那里的包没有 `lib/types`、`src` 与仓库文档，因此插槽属性与主题令牌取自 `cordis_inspect_query`。`app_read_file` 只读取存放应用已安装包的目录（本包之上最近的 `node_modules`；在源码检出中为其 `packages` 与 `docs` 目录）以及 profile 的 `node_modules`。路径以 `path.relative` 比较，真实路径离开该目录的符号链接会被拒绝。一次调用最多按行窗口返回 256 KB 文本；超过这一长度的单行会截取前 256 KB，说明中会注明，下一个窗口从它之后开始。SVG 以外的二进制文件得到一行说明，目录最多列出 500 项，超过 32 MB 的文件会被拒绝。

<a id="model-experience"></a>
## 模型体验

无，因为 Casper 进程自行构造模型请求，本插件不向任何 DeepSeek 请求添加内容。应用工具的名称、描述与结果会进入 Casper 自己的请求。

#### KV Cache 影响

本插件不发送模型请求，因此对缓存没有影响；Casper 自己的请求不在本仓库之内。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- `initialize` 回复未设置 `promptCapabilities.image` 的 Casper 会收到占位文本，而不是每张图片。
- 模型选择器不会更改 Casper 的模型，模型标记在用户选择之前保持为空；`model` 与 `effort` 属于部署配置。
- 推理、token 用量与费用都不会显示，因为 Casper 不发送它们；`session/load` 的回放也不显示。
- 正在运行的 shell 步骤在结束前不显示输出。
- 只有应用工具服务器会传给 Casper；应用中配置的 MCP 服务器不会。
- 应用工具的结果只以文本形式到达 Casper：图片或其他非文本块会变成一行说明。目前提供的工具都不返回图片。
- 在打包的应用中，`app_read_file` 能读到每个已安装包的 `README.md`、`package.json` 与构建出的 `lib/*.js`、技能文件，以及 `ui-theme` 的 `lib/styles`。Desktop 运行时副本会去掉所有 `.d.ts`，各包不发布 `src/`，仓库的 `docs/` 也不在任何包中，因此那里无法读取 `lib/types`、`ui-sidebar` 的 `slots.ts`、`docs/cordis-tutorial` 与 `docs/web-styling.md`；插槽属性与主题令牌改由 `cordis_inspect_query` 获得。尚未随应用提供这些指南。
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
