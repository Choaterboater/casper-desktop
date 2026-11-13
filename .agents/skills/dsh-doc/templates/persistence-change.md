# Template: persistence-change

Use this template for `docs/persistence-changes/YYYY-MM-DD-slug.md`. The folder README is an index, not a record. A record acknowledges only mechanically detected persistence-type changes. Its generated JSON sibling retains complete after schemas so verification needs no Git baseline.

## Frontmatter

```yaml
---
description: "The persisted types changed and the compatibility decision this record explains."
kind: persistence-change
---
```

## Skeleton

The generator fills the machine declaration and schema companion. Structural changes outside the established same-version cases require an explicit compatibility decision. Supply `--prose` JSON with authored `summary`, `compatibility`, and `verification` strings. Use Compatibility to explain both reader directions and Verification to record executed checks. The [cookbook](../../../../docs/cookbook/reviewing-persistence-type-changes.md) shows the operation. Use the actual generated root names, record ids, and digests in the following fields.

````markdown
# Persistence change: <specific persisted change>

## Summary

Describe the mechanically detected change and its version decision.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: YYYY-MM-DD-slug
baseline: false
changes:
  - root: event:example/message
    previous: YYYY-MM-DD-predecessor
    after: <generated-64-character-sha256-hex>
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Explain the declared decision for every detected path: how older readers preserve meaning, safely ignore optional data, or refuse required features before execution or recovery; and how new readers preserve historical meaning and mixed representations. Feature absence retains existing behavior. For a version bump, link the adjacent migration and its verification owner.

<a id="verification"></a>
## Verification

Record the commands actually run and their outcomes. Link focused tests or preserved evidence that support the compatibility explanation.

<a id="dev-note"></a>
## Dev Note

None.
````

## Rules

- Keep exactly one `yaml persistence-change` block; the verifier parses it.
- The filename stem and `id` agree. A root's `previous` identifies its predecessor record; `null` introduces a root. Its `after` matches the generated companion schema digest; `null` records deletion.
- One initial `baseline: true` record covers the complete inventory. Routine changes use `baseline: false` and preserve accepted predecessors. A version-bump record carries its own increasing `SessionHeader.version` transition.
- Structural differences alone do not infer a bump. A same-version change requiring review needs explicit `--decision same-version`; a changed header version infers `version-bump`. An explicit decision cannot waive the required header increase. The command supplies no source changes or validation claims.
- Explain only the detected persistence-type changes. This kind permits the before/after facts and historical evidence needed for that transition; behavior-only changes remain out of scope.
- Record creation and terminal-record update generate the catalog pair and consistency sidecars. Review both languages and retain the generated companions. Direct prose edits still require re-recording pairing; do not hand-maintain schema nodes or digests.
- Use explicit `--update` only for an unaccepted terminal record. It rejects baselines and depended-on records; `--prose` replaces its authored explanations, while omission preserves them. A flagged same-version update requires explicit `--decision same-version`; reassess the explanation against the complete transition. Accepted records receive successors.
- The [folder reference](../../../../docs/persistence-changes/README.md) owns compatibility rules; the [cookbook](../../../../docs/cookbook/reviewing-persistence-type-changes.md) owns commands and recovery.
