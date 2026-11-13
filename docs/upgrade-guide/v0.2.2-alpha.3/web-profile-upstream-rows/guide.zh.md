---
kind: upgrade-guide
description: "CLI `dsh web` profile 重新组合上游的 Web 层：上游账号页、上游网页搜索与模型提供方、Session 日志上传以及 npm 注册表镜像设置。"
---

# CLI Web profile 重新组合上游的 Web 层

[English](guide.md) | 中文

## 变更

过去，共享 Web bundle `@deepseek-ai/dsh-web-app` 为所有使用它的 profile（包括 CLI `dsh web` profile）关闭上游服务行，并携带 Casper 的插件管理器设置。这些行与设置现在只存在于 Casper 桌面 bundle 中（[desktop-casper-bundle](../desktop-casper-bundle/guide.zh.md)），因此 `dsh web` 重新组合上游的 Web 层以及 Casper 自己的新增内容。在 `dsh web` 中，上游账号及其设置页、上游托管的网页搜索、上游模型提供方与 Session 日志上传开关重新开启（产品分析与产品遥测仍是仅限 Desktop 的行），插件管理器可能在安装失败后改用备选注册表重试，安装对话框可能比较 npm 注册表与其镜像的响应速度，上游的可选 bundle 也会提供。

## 迁移

1. 若要保持之前的 `dsh web` 行为，请在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中为每个要关闭的 id 添加一行 `disabled: true`（例如 `account-controller`、`ui-settings-account`、`web-search-deepseek`、`web-deepseek-api`、`session-log-deepseek`），添加一行设置 `registryProbeEnabled: false` 的 `ui-plugin-manager`，并添加一行 `plugin-manager`，设置 `fallbackRegistries: []`、`detailNpmFileSources: [jsdelivr, unpkg]` 以及你需要的 `hiddenBundles`。确认：`dsh web` 能启动，设置页没有账号分区。
2. Desktop 无变化。
