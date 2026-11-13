---
kind: upgrade-guide
description: "请求以 Casper desktop 而不是上游 harness 的名义发出；Desktop 插件安装与文件读取不再使用 npmmirror；Session 上传没有内置 collector；生产更新打包需要自己的 origin。"
---

# 请求以 Casper desktop 的名义发出，默认不使用上游服务

[English](guide.md) | 中文

## 变更

- 每个模型提供方请求和每次网页抓取都发送 `User-Agent: casper-desktop/<version> (+https://github.com/Choaterboater/casper-desktop)`，Codex 子代理向 `codex app-server` 自报为 `casper-desktop`，Session 上传记录携带 OTel 资源 `service.name: casper-desktop`。过去三者都使用上游 harness 的名称。按旧产品标识匹配的提供方过滤、日志或 collector 查询会看到新标识。
- Desktop profile 不再比较 npm 注册表与 `registry.npmmirror.com` 的响应速度（`ui-plugin-manager` 的 `registryProbeEnabled: false`），安装插件失败后不再改用 npmmirror 重试（`plugin-manager` 的 `fallbackRegistries: []`），插件 README 和图片只从 jsdelivr 与 unpkg 读取（`plugin-manager` 的 `detailNpmFileSources: [jsdelivr, unpkg]`）。用户在安装对话框中选择的注册表仍然生效。
- Session 上传（`DSH_TELEMETRY_MODE`）在所有 profile 中都没有内置 collector。开启上传而未设置 `DSH_TELEMETRY_OTLP_URL` 时，`session-telemetry-otel` 插件现在拒绝加载；过去会发往上游 collector。
- Desktop 生产打包与上传从 `DOWNLOAD_PROD_ORIGIN` 读取更新 origin；不再有固定的生产 origin，`publishing/production.json` 接受任意 HTTPS origin。

## 迁移

1. 如果插件安装需要镜像，请在安装对话框中选择它，或在 profile 的 `cordis.yml` 中为 `plugin-manager` 行设置 `fallbackRegistries`（以及 `detailNpmFileSources`）。确认：安装对话框显示你选择的注册表。
2. 如果开启 Session 上传，请把 `DSH_TELEMETRY_OTLP_URL` 设为你的 collector 的完整 OTLP 日志地址。确认：进程启动时不再报 `exporter.url is required`。
3. 生产更新打包时，在 `apps/desktop/.env.macos` 或 `apps/desktop/.env.windows` 中设置 `DOWNLOAD_PROD_ORIGIN=https://<你的下载域名>`，或在使用 `DSH_PACKAGING_PRESET=production` 时写入 `$DSH_PACKAGING_CONFIG_DIR/presets/production.env`；CI 发布从 `publishing/production.json` 的 `origin` 读取。确认：打包不再因 `DOWNLOAD_PROD_ORIGIN must be set` 失败。
