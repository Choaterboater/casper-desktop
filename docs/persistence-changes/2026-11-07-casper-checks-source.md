---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-07-casper-checks-source

## Summary

Acknowledges the casper-checks message source kind that the casper-checks plugin already declares, keeping the Session format version unchanged.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing messages and records are unchanged; the only structural difference is the added casper-checks group of source alternatives (bare kind plus the shared context forms) on user and developer messages, which the classifier flags as a union change because the kind is not marked as attribution-only. Old records never contain this kind, so new readers keep their historical meaning. The plugin writes only user steer messages with the source { kind: "casper-checks" } and no further metadata; it keeps its check state in memory and never reads its own kind back from a log, so the kind affects attribution only, not replay, authority, or recovery. Older readers and readers without the plugin preserve an unknown producer kind and its JSON metadata, and derive the recorded text as ordinary context; native V4 source admission refuses only a malformed source (missing, empty, or non-string kind), not an unknown kind. No migration or Session version bump is required.

<a id="verification"></a>
## Verification

From the repository root, node_modules/.bin/vitest run packages/casper/tool-checks/tests/casper-checks.spec.ts: 53 tests passed. node_modules/.bin/vitest run packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts: the 16 read-access tests passed (both compressions), including preservation of an external producer kind and its JSON metadata without the producer installed; the 16 write-access tests could not load the native file-lock binding, which this checkout has not built. tsx scripts/persistence-changes.ts --check failed before this record (unacknowledged union changes on four roots from kind casper-checks) and passes after it; tsx scripts/gen-persistence-catalog.ts --check passes.

<a id="dev-note"></a>
## Dev Note

None.
