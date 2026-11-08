---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-07-casper-checks-source

[English](2026-11-07-casper-checks-source.md) | 中文

## 概述

确认 casper-checks 插件已声明的 casper-checks 消息来源类型，保持 Session 格式版本不变。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-07-casper-checks-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "faa7fdd78cbf7156eaa1fcb29191f3e83a115ba4c760e25b16a9b6b4b92b63c1"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "8b4448ebe667e60624f0a020b175c8415c92e3ad13fd2377d8b9ccd5be527c22"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "c8ee1ff9164e3bc0aab40271dc05c6287b1abf3510feb9650c19bb3da1f03fd6"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "a9f03afb0534d7dee3aa09241709499458e092164425534149374f41cbc64cde"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有消息和记录不变；唯一的结构差异是在用户和开发者消息上新增的 casper-checks 来源分支组（裸 kind 及共享的上下文形式），由于该类型未标记为仅归属，分类器将其标记为联合类型变更。旧记录从不包含此类型，因此新读取方保留其历史含义。该插件只写入来源为 { kind: "casper-checks" } 的用户引导消息，不带其他元数据；它在内存中保存检查状态，从不从日志读回自身类型，因此该类型只影响归属，不影响回放、权限或恢复。旧读取方以及未安装该插件的读取方会保留未知的生产方类型及其 JSON 元数据，并将记录的文本作为普通上下文派生；原生 V4 来源准入只拒绝格式错误的来源（kind 缺失、为空或非字符串），不拒绝未知类型。无需迁移，也无需提升 Session 版本。

<a id="verification"></a>
## 验证

在仓库根目录运行 node_modules/.bin/vitest run packages/casper/tool-checks/tests/casper-checks.spec.ts：53 个测试通过。node_modules/.bin/vitest run packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts：16 个只读访问测试通过（两种压缩方式），包括在未安装生产方时保留外部生产方类型及其 JSON 元数据；16 个写入访问测试无法加载原生文件锁绑定，因为此检出尚未构建该绑定。tsx scripts/persistence-changes.ts --check 在本记录之前失败（四个根因 casper-checks 类型出现未确认的联合类型变更），之后通过；tsx scripts/gen-persistence-catalog.ts --check 通过。

<a id="dev-note"></a>
## 开发备注

无。
