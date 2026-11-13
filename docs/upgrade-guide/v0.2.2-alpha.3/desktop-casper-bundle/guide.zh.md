---
kind: upgrade-guide
description: "Desktop profile 从 Casper 桌面 bundle 组合，其中没有上游服务行、没有默认网页搜索提供方，也没有默认模型。"
---

# Desktop 从 Casper 桌面 bundle 组合

[English](guide.md) | 中文

## 变更

过去，`$DSH_HOME/profiles/desktop/package.json` 中的 `dsh.profile.bundles` 列出 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app`，由共享 Web 层关闭上游服务行。现在 Desktop profile 列出 `@deepseek-ai/dsh-casper-desktop`，它由这两个 bundle 生成，并去掉了上游服务行：产品遥测与分析、上游账号及其设置页、上游托管的网页搜索、上游模型提供方、Session 日志上传、上游 API 扩展以及插件清单。这些行不存在，而不只是被禁用。

本版本首次启动时会改写一次该列表：Casper bundle 占据 `dsh-base` 或 `dsh-web-app` 中最先出现者的位置，删去另一个，其余插件保持顺序。列表两者都未列出时，启动停止，并给出指明该文件的消息。

该 bundle 还改变了 Desktop 上的三项默认值：

- 不设置网页搜索提供方；在搜索提供方解析成功前，不向模型提供 `web_search`（`web` 行，`offerUnresolvedSearch: false`）。`web_fetch` 不变。
- 不设置默认模型（`agent-default-model` 的 provider 与 model 为空）。模型选择器显示“请选择模型”，在选定模型前 Standard Session 的首个提示会失败。
- 插件管理器还隐藏 `@deepseek-ai/dsh-casper-desktop`、`dsh-base`、`dsh-web-app` 以及其他上游 profile bundle，因此插件页和 `plugin_manager` 工具都无法开启它们。[casper-wire-identity](../casper-wire-identity/guide.zh.md) 中的注册表设置现在来自此 bundle。

## 迁移

1. bundle 列表无需处理。确认：启动一次后，`dsh.profile.bundles` 在原 `@deepseek-ai/dsh-base` 的位置列出 `@deepseek-ai/dsh-casper-desktop`，不再有 `dsh-base` 或 `dsh-web-app`，你的插件保持原有顺序。
2. 如果启动报告 profile 未列出 `@deepseek-ai/dsh-casper-desktop`，请在恢复对话框中选择“禁用第三方插件、备份 profile patch 并重启”，从它写下的 `cordis.patch.yml.bak-*` 文件中恢复你需要的覆盖，然后重新启用插件。确认：应用能启动，插件页列出这些插件。
3. 在 Standard Session 的模型选择器中选择模型；所选模型即成为默认值。已保存的默认值若指向已不存在的提供方，首次使用时会失败，请重新选择模型。确认：新的 Standard Session 的首个提示得到回复。
4. 删除 profile 的 `cordis.patch.yml` 中指向已移除行的覆盖；它们只会记录 `patch: entry ... not found`。覆盖 `plugin-manager` 行会整体替换 Casper bundle 的配置，因此要在其中重述 `hiddenBundles`。确认：启动日志中没有你的覆盖对应的 `not found` 行。
5. 不支持降级：较早的版本会跳过未知 bundle，启动时没有基础层。
