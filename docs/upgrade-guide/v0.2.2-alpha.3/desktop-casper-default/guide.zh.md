---
kind: upgrade-guide
description: "Desktop 的新会话默认使用 Casper 预设，通过 `casper acp` 运行 Casper agent，而不是 DeepSeek agent 循环。"
---

# Desktop 的新会话默认使用 Casper 预设

[English](guide.md) | 中文

## 变更

过去，Desktop profile 的预设注册表默认使用 `standard`，因此每个新会话都运行在 DeepSeek agent 循环上。现在 Desktop 的默认值是 `casper`：新会话通过一个在首条提示时启动的 `casper acp` 进程运行 Casper agent；会话创建后，其模式不能在 Casper 与其他预设之间切换（模式选择器会改为开启新会话）。在 Agent 预设设置页保存的默认值仍然优先，已有会话保留其记录的预设。Web 与其他 profile 仍使用 `standard`。没有 `casper` 命令的 Desktop 机器会在 Casper 会话的首条提示时得到 `CASPER_NOT_FOUND` 错误。

## 迁移

1. 若要让新会话继续使用 DeepSeek 循环，打开 Agent 预设设置页并把 Standard 设为默认，或在新会话的模式选择器中选择 Standard。确认：选择器显示 Standard，且新会话的首条提示运行时没有 Casper 进程。
2. 若要使用 Casper，把 `casper` 命令安装到 PATH 或 `~/.local/bin`，并让 `bun` 位于 `~/.bun/bin`、`/opt/homebrew/bin` 或 `/usr/local/bin`。确认：新 Desktop 会话中的提示会流式显示 Casper 的文本，并以其回执结束。
