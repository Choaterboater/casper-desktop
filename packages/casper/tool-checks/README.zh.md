---
description: "Casper 检查：在 agent 编辑后运行项目自己的 typecheck、lint、test 与 build，把真实失败发回修复，以回执结束本轮，并通过 check_record、check_replay 与 check_list 保留模型记录的检查；涵盖配置、项目文件与延期的 CLI 行为。"
kind: "package-reference"
---

# @deepseek-ai/dsh-casper-checks

[English](README.md) | 中文

## 概述

在一个顶层轮次修改了文件之后，本插件会在轮次结束前运行项目自己的检查：这些检查来自 `.casper/project.yaml`，或从项目的 manifest 中检测得到。真实失败会发回给 agent（智能体），进入有次数上限的修复回合；被沙箱阻止、超时或无法启动的检查会报告为「无法检查」，绝不会报告为通过。轮次以一份回执结束，说明改了什么、证明了什么。`check_record`、`check_replay` 与 `check_list` 工具保留模型自己记录的检查。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Web 与桌面端预设（`packages/bundle/web-app/presets/{standard,cordis,ptc}.patch.yml`）列出了本插件，但将其关闭（`disabled: true`）：它会在每次编辑后重新运行项目的测试，带来额外的 token 开销。profile 补丁可以覆盖其 `casper-checks` 条目，为某个预设开启它。本插件注入 `tools`、`shell`、`systemPrompt`、`workingDirectory` 与 `fs`。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mutatingTools` | `write`, `edit`, `apply_patch`, `str_replace_editor`, `bash`, `pwsh` | 其结果会使检查过期、并计入本轮改动的工具；`str_replace_editor` 的 `view` 不计入 |
| `replayOnStop` | `true` | 在 `agent/turn-stopping` 时运行项目检查，并重放过期的已记录检查 |
| `maxRepairRounds` | `3` | 一个轮次可使用的修复回合数；项目文件中的 `repair.maxAttempts` 会覆盖它 |
| `outputChars` | `2000` | 每次运行保留的命令输出字符数，由 stdout 与 stderr 共享 |
| `maxChecks` | `32` | 一个 agent 可持有的已记录检查数 |
| `projectChecks` | `true` | 在顶层轮次修改文件后运行项目检查 |
| `projectTimeoutMs` | `600000` | 单项项目检查的时限，最长一小时；`verification.timeoutMs` 会覆盖它 |
| `runUnconfined` | `false` | 在 shell 沙箱不限制项目检查时（`danger-full-access` 或没有沙箱）仍运行它们 |
| `receipt` | `true` | 向 agent 引导（steer）结束时的回执 |

### 检查从哪里来

已知的检查有四项，按以下顺序运行：`typecheck`、`lint`、`test`、`build`。对每一项，第一个给出它的来源胜出：先是 `.casper/project.yaml` 中的 `verify:`，然后是其中的 `commands:`，最后是检测到的命令。

| 项目 | 检测到的命令 |
|---|---|
| Node（`package.json`） | `typecheck`（或 `check-types`、`tsc`）、`lint`、`test` 与 `build` 脚本，以 `<pm> run <script>` 运行；包管理器取自 `packageManager`，否则取自锁文件（`pnpm-lock.yaml`、`yarn.lock`、`bun.lock`、`bun.lockb`），否则使用 npm；`npm init` 生成的占位测试会被跳过 |
| Rust（`Cargo.toml`） | `cargo clippy`、`cargo test`、`cargo build` |
| Go（`go.mod`） | `go test ./...`、`go build ./...` |
| Python（`pyproject.toml`、`requirements.txt`、`requirements-dev.txt`、`requirements_dev.txt`） | 出现这些名称时运行 `mypy .`、`ruff check .` 与 `pytest`，通过 `uv run`（`uv.lock`）、`poetry run`（`poetry.lock` 或 `[tool.poetry]`）、`.venv/bin/python -m` 或 `venv/bin/python -m`，否则使用 `python3 -m` |

靠前的行会保留某个检查名称，即使靠后的行也检测到了它。项目文件接受以下键，并忽略其他键（Casper CLI 可能会读取它们）：

```yaml
verify:
  test: node test.cjs        # typecheck, lint, test, build only
verification:
  mode: auto                 # auto | offer | off
  checks: [typecheck, test]  # default: every check with a command
  timeoutMs: 600000          # 1 to 3600000
repair:
  maxAttempts: 3             # 0 to 10
```

文件存在但无效时，不运行任何项目检查；回执会指出需要修正的键。`offer` 与 `off` 不会自动运行任何检查，回执会说明这一点。命令在轮次的第一个检查点读取，并在该轮的修复回合中保持不变，因此对该文件的编辑从下一轮开始生效。

### 运行什么、何时运行

项目检查在顶层轮次的检查点运行，前提是该轮次自己的修改调用改动了文件。subagent 的轮次不运行项目检查，也不发送回执。如果一个轮次的所有改动都是已知的文档路径（`.md`、`.mdx`、`.txt`、`.rst`、`.adoc`，但不包括 `requirements*.txt`、`constraints*.txt`、`CMakeLists.txt`、`runtime.txt` 以及 `requirements/` 文件夹下的文件），就跳过项目检查；shell 命令算作未知改动。命令和工作目录都相同、且结论仍新鲜的已记录检查会被复用，而不是再运行一次。在起限制作用的沙箱下失败、且输出中出现 `EPERM`、`Operation not permitted` 或 Chromium 的 `bootstrap_check_in … Permission denied (1100)` 的检查记为 `sandbox_blocked`。

该轮次之后的每个检查点都会重新运行因编辑而过期的项目检查，因此每次修复都会用所有选定的检查重新核对。当没有可修复的失败、或修复回合已用完时，每个轮次引导一次回执。全部干净通过时只有一行，例如 `✓ Checks passed · test passed · 1 file changed · after 1 repair`；否则第一行是 `✗ Failed: …`、`– Incomplete: … not proven`、`– Not checked — <reason>` 或 `– Checks skipped — only documentation changed (…)`，随后每项检查一行，再加一行 `Changed:`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`src/project.ts` 基于一个只有两个方法的 `ProjectReader` 发现检查，插件用 `ctx.fs` 为其提供后端。`src/changes.ts` 从文件工具参数和 `apply_patch` 头部读取改动的路径，并对文档路径与沙箱拒绝进行分类。`src/receipt.ts` 决定结论并渲染回执。`src/index.ts` 维护一个修改纪元（epoch）计数器，以及每个目录的最新纪元；如果某个重叠目录在某次结论所属的运行开始之后发生改动，该检查即为过期。它按 agent 保存已记录的检查、该 agent 自己的调用自上次回执以来造成的改动，以及每个轮次的检查点状态：修复回合、该轮发现的项目检查，以及已发送过哪些通知。检查点只以来源 `casper-checks` 进行引导（`agent.steer`），从不改动循环。该行为依据 Casper CLI 的 `docs/VERIFICATION.md` 重建，而非复制。`casper-checks-receipt` headless 快照通过真实组合记录了一次错误修复、它的修复回合以及结束时的回执。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 工具部分与目录

#### 模型看到什么

`check_record`、`check_replay` 与 `check_list` 的工具 schema，以及位于 bash 部分之后的这一段系统提示词：

##### 本字段的逐字文本（如需要）

```markdown
After you change files, Casper runs the project's own checks (typecheck, lint, test, build) before your turn ends, sends you real failures to fix, and gives you a receipt to end your reply with. Fix failing code, not the check: do not weaken .casper/project.yaml or the scripts it runs. To track another command, record it with check_record before editing and replay it with check_replay. Report a check as passed only when its latest non-stale run passed. A check that is not run, stale, or never recorded has no verdict: say so instead of claiming success.
```

#### Token 影响

挂载本插件期间，每个请求都包含一段固定的系统提示词和三个工具 schema。

#### KV Cache 影响

前缀稳定：该段落与 schema 在会话期间不会变化。

### 检查点引导

#### 模型看到什么

在顶层轮次修改文件之后，最多 `maxRepairRounds` 条修复消息，每条列出失败的检查及其输出末尾；然后每个轮次一条回执消息，要求模型原样以该回执结束回复。没有任何改动的轮次不会收到这些消息。

#### Token 影响

每次引导会增加一条用户消息和一个额外的模型步骤；一个干净的编辑轮次会为回执多花一个步骤。

#### KV Cache 影响

只追加：引导内容追加在最新步骤之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **文件夹信任**——CLI 在运行仓库的命令之前会先询问。桌面端还没有信任提示，因此项目检查只在 shell 沙箱对其起限制作用的地方运行（`read-only` 或 `workspace-write`，即随附的默认值）；在其他地方，除非设置了 `runUnconfined`，回执会说明它们没有运行。信任提示需要 Host 与 UI 方面的工作。
- **回执卡片**——回执通过 agent 的最终回复到达用户，这要花一个模型步骤。如果像已修改文件卡片那样，由持久的回执事件渲染一张 Web 卡片，就能省掉这个步骤，并在回复遗漏回执时仍保留它。
- **在沙箱外运行检查**——`sandbox_blocked` 的检查只会被报告，不会重试；CLI 的「这一次在沙箱外运行」选项需要一个审批流程。
- **Subagent 的编辑**——项目检查跟随顶层 agent 自己的修改调用；仅由 subagent 修改的文件不会给父级的轮次带来项目检查。
- **更细的 CLI 行为**——具名检查（`verify.checks.<name>`）、声明的范围与按指纹复用、按改动选择测试、证明某个测试在没有该改动时会失败、应用冒烟与页面检查、保留应用数据、`check` 脚本回退、Python `unittest` 与构建检测，以及仅涉及输出或数据库时的跳过，均未重建。
- **项目文件守卫**——提示词告诉模型不要削弱检查；但目前还没有任何机制阻止对 `.casper/project.yaml` 或其所列脚本的编辑。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为与限制以上文和包代码为准。

- **移除**——本包会保留，直到 Casper 会话经过实际验证；之后可以将其从 Standard 预设中移除。

</details>
