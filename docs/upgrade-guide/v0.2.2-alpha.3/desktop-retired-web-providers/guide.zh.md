---
kind: upgrade-guide
description: "Desktop 启动时会删除指向 Desktop profile 已不再加载的上游提供方的已存网页搜索或网页获取提供方选择。"
---

# Desktop 清除已存的上游网页提供方选择

[English](guide.md) | 中文

## 变更

Desktop profile 不再加载上游网页搜索与网页获取提供方（`web-search-deepseek` 与 `web-deepseek-api` 行；见 [desktop-casper-bundle](../desktop-casper-bundle/guide.zh.md)）。曾在网页搜索与获取设置页选择过它们的 profile，仍在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 中 `web` 条目的 `config` 里保存其 id：`searchProvider: deepseek-search-api`、`searchProvider: deepseek-official` 或 `fetchProvider: deepseek-fetch-api`。此时设置页将该选择显示为“（未加载）”，不提供 `web_search`，且每次 `web_fetch` 调用都以 `configured web provider "deepseek-fetch-api" is not registered` 失败。

现在每次启动都会在 Host 启动前删除这些已存值，因此升级后的首次启动即会清除它们。只删除这三个 id；其他值（包括第三方提供方 id）保持不变。删除后为空的 `config` 也会被删除，从而采用 Desktop 默认值：在你选择前没有搜索提供方，网页获取使用本机直接获取；若同一文件中更早的 `web` 条目设置了自己的 `config`，清空的 `config` 会保留为 `config: {}`，以免更早的选择重新生效。若该 `config` 中仍有其他字段，被清除的字段改为自动选择提供方。注释、其他字段与其他条目保持原文，不含这些值的文件不会被写入。

只编辑 Desktop profile patch。各 profile 共享的 home 级 `$DSH_HOME/cordis.patch.yml` 中的 `web` 条目在其后应用，仍然优先；该文件保持不变，因为 CLI profile 仍会加载这些提供方。

如果文件无法加载，或某个值的写法无法逐行删除（例如流式写法 `{fetchProvider: ...}`，或 YAML 锚点或别名），启动会停止，并给出指明该文件的消息，文件保持不变。

## 迁移

1. 由设置页保存的选择无需处理。确认：启动一次后，`cordis.patch.yml` 中不再出现 `deepseek-search-api`、`deepseek-official` 或 `deepseek-fetch-api`，网页搜索与获取页也不再有显示为“（未加载）”的提供方。
2. 如果启动报告无法删除某个已停用的网页提供方，请从所指文件的 `web` 条目中删除对应的 `searchProvider` 或 `fetchProvider` 行，或在恢复对话框中选择“禁用第三方插件、备份 profile patch 并重启”，再从它写下的 `cordis.patch.yml.bak-*` 文件中恢复你需要的覆盖。确认：应用能启动。
3. 如果启动后网页搜索与获取页仍有显示为“（未加载）”的提供方，请自行从 `$DSH_HOME/cordis.patch.yml` 的 `web` 条目中删除指向已停用 id 的 `searchProvider` 或 `fetchProvider` 行；CLI profile 也读取该文件，因此该修改同样作用于它们。确认：下次启动后，该页不再有显示为“（未加载）”的提供方。
