# AGENTS.md — Archived Agent Notes

Archived Agent Notes under the kind directories are frozen historical snapshots, not current authority. Never edit, reformat, repair, delete, or move a sealed artifact; use an active Agent Note or current documentation for new decisions and facts.

The archival change may only relocate a complete note, insert an `Archived: YYYY-MM-DD` line below its `Status: implemented` line, and repair or delete inbound links. Do not inspect, verify, or repair links out of archived notes.

Run the [`dsh-archive-agent-notes`](../../skills/dsh-archive-agent-notes/SKILL.md) workflow and append new artifact hashes with `pnpm run verify-archived-agent-notes --write`. The normal verifier rejects changed or missing sealed artifacts, unknown kind folders, and invalid archive metadata.

Documentation became English-only once: that change removed every sealed Chinese and pairing-record artifact from the manifest and resealed each English note with its language-switcher line removed. `scripts/archived-agent-notes.ts` permits exactly that retirement and no other content change.
