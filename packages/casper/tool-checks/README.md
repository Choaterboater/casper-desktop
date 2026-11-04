---
description: "Casper checks: run the project's own typecheck, lint, test and build after the agent edits, send real failures back for repair, close the turn with a receipt, and keep model-recorded checks through check_record, check_replay and check_list; configuration, project file, and deferred CLI behaviour."
kind: "package-reference"
---

# @deepseek-ai/dsh-casper-checks

## Summary

After a top-level turn changes files, this plugin runs the project's own checks, from `.casper/project.yaml` or detected from its manifests, before the turn ends. Real failures go back to the agent for bounded repair rounds; a check the sandbox blocked, that timed out, or that could not start is reported as "could not check", never as passed. The turn closes with a receipt of what changed and what was proven. The `check_record`, `check_replay` and `check_list` tools keep checks the model records itself.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The Web and Desktop presets (`packages/bundle/web-app/presets/{standard,cordis,ptc}.patch.yml`) mount the plugin. It injects `tools`, `shell`, `systemPrompt`, `workingDirectory` and `fs`.

| Field | Default | Meaning |
|---|---|---|
| `mutatingTools` | `write`, `edit`, `apply_patch`, `str_replace_editor`, `bash`, `pwsh` | Tools whose results make checks stale and count as the turn's changes; a `str_replace_editor` `view` does not count |
| `replayOnStop` | `true` | Run project checks and replay stale recorded checks at `agent/turn-stopping` |
| `maxRepairRounds` | `3` | Repair rounds one turn may use; `repair.maxAttempts` in the project file overrides it |
| `outputChars` | `2000` | Characters of command output kept per run, shared by stdout and stderr |
| `maxChecks` | `32` | Recorded checks one agent may hold |
| `projectChecks` | `true` | Run the project's checks after a top-level turn changes files |
| `projectTimeoutMs` | `600000` | Deadline of one project check, at most one hour; `verification.timeoutMs` overrides it |
| `runUnconfined` | `false` | Run project checks when the shell sandbox does not confine them (`danger-full-access` or no sandbox) |
| `receipt` | `true` | Steer the closing receipt to the agent |

### Where the checks come from

Four checks are known, run in this order: `typecheck`, `lint`, `test`, `build`. For each, the first source that names it wins: `verify:` in `.casper/project.yaml`, then `commands:` there, then a detected command.

| Project | Detected commands |
|---|---|
| Node (`package.json`) | the `typecheck` (or `check-types`, `tsc`), `lint`, `test` and `build` scripts, run as `<pm> run <script>`; the package manager comes from `packageManager`, else the lockfile (`pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `bun.lockb`), else npm; the `npm init` placeholder test is skipped |
| Rust (`Cargo.toml`) | `cargo clippy`, `cargo test`, `cargo build` |
| Go (`go.mod`) | `go test ./...`, `go build ./...` |
| Python (`pyproject.toml`, `requirements.txt`, `requirements-dev.txt`, `requirements_dev.txt`) | `mypy .`, `ruff check .` and `pytest` when those names appear, through `uv run` (`uv.lock`), `poetry run` (`poetry.lock` or `[tool.poetry]`), `.venv/bin/python -m` or `venv/bin/python -m`, else `python3 -m` |

An earlier row keeps a check name a later row also detects. The project file accepts these keys and ignores others, which the Casper CLI may read:

```yaml
verify:
  test: node test.cjs        # typecheck, lint, test, build only
verification:
  mode: auto                 # auto | offer | off
  checks: [typecheck, test]  # default: every check with a command
  timeoutMs: 600000          # 1 to 3600000
repair:
  maxAttempts: 3             # 0 to 10
```

A file that exists but is invalid runs no project check; the receipt names the key to fix. `offer` and `off` run nothing automatically and the receipt says so. Commands are read at a turn's first checkpoint and kept for its repair rounds, so an edit to the file takes effect next turn.

### What runs, and when

A project check runs at the checkpoint of a top-level turn whose own mutation calls changed files. Subagent turns run no project checks and send no receipt. A turn whose every change is a known documentation path (`.md`, `.mdx`, `.txt`, `.rst`, `.adoc`, except `requirements*.txt`, `constraints*.txt`, `CMakeLists.txt`, `runtime.txt` and files under a `requirements/` folder) skips the project checks; a shell command counts as an unknown change. A recorded check with the same command and working directory whose verdict is fresh is reused instead of run again. A failure under a confining sandbox whose output shows `EPERM`, `Operation not permitted`, or Chromium's `bootstrap_check_in … Permission denied (1100)` is `sandbox_blocked`.

Each later checkpoint in the turn reruns the project checks that edits made stale, so a repair is rechecked with every selected check. When no failure is left to repair, or the rounds are used up, the receipt is steered once per turn. A clean pass is one line, for example `✓ Checks passed · test passed · 1 file changed · after 1 repair`; otherwise the first line is `✗ Failed: …`, `– Incomplete: … not proven`, `– Not checked — <reason>` or `– Checks skipped — only documentation changed (…)`, followed by one line per check and a `Changed:` line.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/project.ts` discovers checks against a two-method `ProjectReader` that the plugin backs with `ctx.fs`. `src/changes.ts` reads changed paths from file-tool arguments and `apply_patch` headers and classifies documentation and sandbox denials. `src/receipt.ts` decides the verdict and renders the receipt. `src/index.ts` keeps one mutation epoch counter and the latest epoch per directory; a check is stale when an overlapping directory changed after its verdict's run started. Per agent it keeps recorded checks, the changes its own calls made since its last receipt, and per-turn checkpoint state: repair rounds, the turn's discovered project checks, and which notices were sent. The checkpoint only steers (`agent.steer`) with source `casper-checks`; it never edits the loop. The behaviour is rebuilt from the Casper CLI's `docs/VERIFICATION.md`, not copied. The `casper-checks-receipt` headless snapshot records a wrong fix, its repair round and the closing receipt through the real composition.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Tool section and catalog

#### What the model sees

The `check_record`, `check_replay` and `check_list` tool schemas, and this system-prompt section after the bash section:

##### Verbatim text for this field, when needed

```markdown
After you change files, Casper runs the project's own checks (typecheck, lint, test, build) before your turn ends, sends you real failures to fix, and gives you a receipt to end your reply with. Fix failing code, not the check: do not weaken .casper/project.yaml or the scripts it runs. To track another command, record it with check_record before editing and replay it with check_replay. Report a check as passed only when its latest non-stale run passed. A check that is not run, stale, or never recorded has no verdict: say so instead of claiming success.
```

#### Token effect

A fixed system-prompt section and three tool schemas in every request while the plugin is mounted.

#### KV Cache effect

Prefix-stable: the section and schemas do not change during a Session.

### Checkpoint steering

#### What the model sees

After a top-level turn changes files, at most `maxRepairRounds` repair messages, each naming the failing checks with their output tail, then one receipt message per turn that tells the model to end its reply with the receipt unchanged. A turn that changed nothing receives none.

#### Token effect

Each steer adds one user message and one more model step; a clean edit turn costs one extra step for the receipt.

#### KV Cache effect

Append-only: steering is appended after the latest step.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Folder trust** — the CLI asks before running a repository's commands. Desktop has no trust prompt yet, so project checks run only where the shell sandbox confines them (`read-only` or `workspace-write`, the shipped default); elsewhere the receipt says they did not run unless `runUnconfined` is set. A trust prompt needs Host and UI work.
- **Receipt card** — the receipt reaches the user through the agent's final reply, which costs one model step. A Web card rendered from a durable receipt event, like the changed-files card, would show it without that step and keep it when the reply omits it.
- **Running checks outside the sandbox** — a `sandbox_blocked` check is reported, not retried; the CLI's "run outside the sandbox this once" choice needs an approval flow.
- **Subagent edits** — project checks follow the top-level agent's own mutation calls; files changed only by a subagent bring no project checks to the parent's turn.
- **Narrower CLI behaviour** — named checks (`verify.checks.<name>`), declared scopes and reuse by fingerprint, changed-test selection, proof that a test fails without the change, app smoke and page checks, keeping app data, the `check` script fallback, Python `unittest` and build detection, and output/database-only skips are not rebuilt.
- **Project-file guard** — the prompt tells the model not to weaken the checks; nothing yet stops an edit to `.casper/project.yaml` or the scripts it names.
