---
kind: upgrade-guide
description: "Casper 桌面安装提供的 dsh 命令只管理 desktop profile 的插件；其他所有 profile 都需要 npm CLI。"
---

# Desktop 的 dsh 命令只管理 Desktop 插件

[English](guide.md) | 中文

## 变更

过去，**管理 dsh 命令…**注册的 `dsh` 命令使用 Desktop 运行时运行共享 CLI，因此还能启动 `web`、`headless` 等 profile、转储配置，并管理其他 profile 的插件。现在它只接受三种形式：

- `dsh plugin --profile desktop <pnpm arguments...>`，例如 `add <package>`、`list` 或 `remove <package>`；
- `dsh --version`；
- `dsh --help`，打印该命令自己的帮助。

其他所有调用，包括 `dsh web`、`dsh headless`、`--dump-config` 与 `dsh plugin --profile <other>`，都以状态码 1 退出，并给出 npm CLI 的安装命令 `npm install -g @deepseek-ai/dsh`。npm CLI 提供所有 profile。Desktop 的包集合也不包含除 `dsh-web-app` 外的上游 profile bundle。

受影响的是通过 Desktop 注册的命令运行 `desktop` 以外 profile 的用户。`$DSH_HOME/profiles` 下的 profile 及其数据保持不变。

## 迁移

1. 运行 `npm install -g @deepseek-ai/dsh` 安装 npm CLI。确认：`npm ls -g @deepseek-ai/dsh` 列出该包。
2. 两个命令都已安装时，把 npm CLI 放在 PATH 前面。Desktop 的命令在 macOS 上是 `/usr/local/bin/dsh`；在 Windows 上，Desktop 把它注册到当前用户的 PATH。也可以在 Desktop 中选择**管理 dsh 命令… → 移除**。确认：在新终端中，`dsh --help` 不打印 “This dsh command is installed by Casper”。
3. 使用 Desktop 的命令管理 Desktop 插件，因为 npm CLI 拒绝管理 `desktop` profile 的插件。npm CLI 在 PATH 中排在前面时，用完整路径运行 Desktop 的命令：macOS 上为 `/usr/local/bin/dsh`，Windows 上为 Desktop 安装目录中的 `resources\runtime\cli\bin\dsh.cmd`。先退出 Desktop。确认：通过该命令运行 `dsh plugin --profile desktop list` 会列出 desktop profile 的包。
4. 把运行其他 profile 的脚本改为调用 npm CLI。确认：它们都不再以给出 `npm install -g @deepseek-ai/dsh` 的消息退出。
