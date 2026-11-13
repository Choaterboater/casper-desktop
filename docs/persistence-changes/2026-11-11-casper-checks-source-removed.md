---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-11-casper-checks-source-removed

## Summary

Removes the casper-checks message source kind together with the switched-off casper-checks plugin that declared it, keeping the Session format version unchanged.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

The only structural difference is that the casper-checks group of source alternatives (bare kind plus the shared context forms) is gone from user and developer messages, which the classifier flags as a union change. New records never contain this kind, because no installed plugin writes it any more. Logs written while the plugin was on may hold user steer messages with the source { kind: "casper-checks" } and no further metadata. Readers without the plugin preserve an unknown producer kind and its JSON metadata and derive the recorded text as ordinary context; native V4 source admission refuses only a malformed source (missing, empty, or non-string kind), not an unknown kind. So those logs still open and keep their text, and the kind affected attribution only, never replay, authority, or recovery. No migration or Session version bump is required.

<a id="verification"></a>
## Verification

From the repository root, node_modules/.bin/vitest run packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts: the 16 read-access tests passed (both compressions), including preservation of an external producer kind and its JSON metadata without the producer installed; the 16 write-access tests could not load the native file-lock binding, which this checkout has not built. tsx scripts/persistence-changes.ts --check failed after the plugin was removed and before this record (docs/persistence-schema.json stale, with the casper-checks source group gone from four roots) and passes after it; tsx scripts/gen-persistence-catalog.ts --check passes.

<a id="dev-note"></a>
## Dev Note

None.
