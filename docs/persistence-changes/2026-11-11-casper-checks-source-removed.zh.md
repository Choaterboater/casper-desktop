---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-11-casper-checks-source-removed

[English](2026-11-11-casper-checks-source-removed.md) | 中文

## 概述

随已关闭的 casper-checks 插件一起移除它声明的 casper-checks 消息来源类型，保持 Session 格式版本不变。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-11-casper-checks-source-removed
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-07-casper-checks-source"
    after: "ddce54a3873dc57113b0cd38ad9b23b3c259186139e8847e5e5f415d86f52482"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-07-casper-checks-source"
    after: "70ea8e7943c5e2d76905bcc2e694e8c3d5b138aaae3609f3e261b8d369a6e35a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-07-casper-checks-source"
    after: "d95c624eddecdacf1ee74356196c09d2f3fcd625714be5e852a6b643fa12a7ca"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-07-casper-checks-source"
    after: "dcb07e04496586d2664d72dab0e94312917da56927b2a0dc3ee53d6a33e32450"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

唯一的结构差异是用户和开发者消息上的 casper-checks 来源分支组（裸 kind 及共享的上下文形式）已移除，分类器将其标记为联合类型变更。新记录从不包含此类型，因为已没有安装的插件写入它。插件开启期间写入的日志可能包含来源为 { kind: "casper-checks" } 且不带其他元数据的用户引导消息。未安装该插件的读取方会保留未知的生产方类型及其 JSON 元数据，并将记录的文本作为普通上下文派生；原生 V4 来源准入只拒绝格式错误的来源（kind 缺失、为空或非字符串），不拒绝未知类型。因此这些日志仍可打开并保留其文本，该类型只影响过归属，从不影响回放、权限或恢复。无需迁移，也无需提升 Session 版本。

<a id="verification"></a>
## 验证

在仓库根目录运行 node_modules/.bin/vitest run packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts：16 个只读访问测试通过（两种压缩方式），包括在未安装生产方时保留外部生产方类型及其 JSON 元数据；16 个写入访问测试无法加载原生文件锁绑定，因为此检出尚未构建该绑定。tsx scripts/persistence-changes.ts --check 在移除插件之后、本记录之前失败（docs/persistence-schema.json 过期，四个根上的 casper-checks 来源分支组已移除），之后通过；tsx scripts/gen-persistence-catalog.ts --check 通过。

<a id="dev-note"></a>
## 开发备注

无。
