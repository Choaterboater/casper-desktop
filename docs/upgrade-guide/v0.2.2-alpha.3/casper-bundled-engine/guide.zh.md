---
kind: upgrade-guide
description: "Desktop 运行其自带的 Casper 引擎，而不是在电脑上找到的 `casper` 命令；除非开启 `useInstalledCasper`，`casper-agent` 插件需要 `engine`。"
---

# Desktop 运行其自带的 Casper 引擎

[English](guide.md) | 中文

## 变更

过去，`casper-agent` 插件启动由 `command` 找到的 Casper：在 Desktop 上，是 PATH 上的 `casper`，或 `~/.local/bin`、`~/.bun/bin`、`/opt/homebrew/bin`、`/usr/local/bin` 中的 `casper`。现在 Desktop 在其运行时资源中自带一个固定版本的 Casper 引擎（macOS 上为 `Contents/Resources/runtime/casper/casper`，Windows 上为 `resources\runtime\casper\casper.exe`）并运行它，同时把应用的 `node`、`npx`、`npm`、`uv` 与 `uvx` 放在 Casper 的 PATH 末尾。除非你开启，电脑上安装的 Casper 不会被使用。Casper 总会得到 `CASPER_NO_UPDATE_CHECK=1`，因此在应用运行它期间从不自行更新。

该插件新增三个配置字段：`engine`、`useInstalledCasper`（默认 `false`）与 `toolPath`。`useInstalledCasper` 关闭时，`engine` 必须是绝对路径，否则插件加载失败；`command` 只在其开启时生效。自带引擎缺失或无法运行时，该轮以 `CASPER_ENGINE_MISSING` 结束。依赖自己的 Casper 的 Desktop 用户，以及在自己的 `cordis.yml` 中挂载 `@deepseek-ai/dsh-casper-agent` 的人，都会受到影响。

## 迁移

1. 若要在 Desktop 中继续运行电脑上安装的 Casper，打开设置 → 内置插件 → Casper agent，开启 `useInstalledCasper`。确认：Casper 会话运行时，进程列表显示的是你自己的 `casper` 路径，而不是应用内的路径。
2. 在你自己的 `cordis.yml` 中 `@deepseek-ai/dsh-casper-agent` 的那一行，设置 `useInstalledCasper: true` 以保留 `command` 查找，或把 `engine` 设为某个 Casper 可执行文件的绝对路径。确认：插件加载时没有 `engine must be the absolute path` 错误，且 Casper 会话中的提示以 Casper 的回执结束。
