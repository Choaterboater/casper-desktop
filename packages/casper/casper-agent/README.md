---
description: "The Casper agent driver: Sessions on the Casper preset run the Casper agent over its ACP server instead of the DeepSeek agent loop; configuration, event mapping, approvals, process lifetime, and resume."
kind: "package-reference"
---

# @deepseek-ai/dsh-casper-agent

English | [中文](README.zh.md)

## Summary

This plugin makes the Casper agent the main AI for Sessions on the `casper` preset. It registers a factory route on `ctx.agents`, so those Sessions are driven by one `casper acp` process each instead of the DeepSeek agent loop; every other Session keeps agent-loop. Casper's text, tool steps, checks, plan, and receipt become ordinary Session events, so the Desktop transcript, tool cards, todo list, and Stop work unchanged. Casper's approval boxes reach the user as questions with Casper's own choices. Desktop starts new Sessions on this preset by default.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Desktop profile mounts the plugin from `packages/bundle/web-app/cordis.patch.yml` (row `casper-agent`, disabled outside Desktop and in the in-browser preview) and declares the `casper` preset in `packages/bundle/web-app/presets/casper.patch.yml`. The preset mounts only `tool-todo`, which shows Casper's plan as the todo list. On Desktop the preset registry's default is `casper`; a default saved in Settings still wins. The plugin injects `agents`, `sessions`, `sessionProjections`, `sessionPersistence`, `subprocess`, and `storageDomain`, and uses `userQuestions` when it is mounted.

| Field | Default | Meaning |
|---|---|---|
| `presets` | `['casper']` | Presets whose Sessions Casper drives |
| `command` | `casper` | Casper executable; the Desktop row looks it up on PATH, `~/.local/bin`, `~/.bun/bin`, `/opt/homebrew/bin`, and `/usr/local/bin` |
| `args` | `['acp']` | Arguments that start Casper's ACP server |
| `model` | unset | Passed as `--model`; unset keeps Casper's own default |
| `effort` | unset | Passed as `--effort`; unset keeps Casper's own default |
| `env` | `{}` | Child environment added after the subprocess scrub; the Desktop row passes a PATH that leads with bun's folders and `OPENROUTER_API_KEY` when set |
| `startTimeoutMs` | `30000` | Limit for `initialize` plus `session/new` or `session/load` |
| `cancelGraceMs` | `5000` | Wait for the prompt reply after Stop before Casper is killed |
| `exitGraceMs` | `2500` | Wait for Casper to exit after stdin closes |
| `killGraceMs` | `5000` | Grace between SIGTERM and SIGKILL |
| `stderrTailBytes` | `4096` | Bytes of Casper's stderr kept for failure messages |

The child never receives `DEEPSEEK_*` or `DSH_*` names, or credential-shaped names that `env` does not list.

A Session becomes Casper when it is created on a Casper preset. A blank Session cannot switch between Casper and another preset: the preset registry refuses that switch with `agent-preset/locked` and `newSession: true`, and the mode picker starts a new Session on the chosen preset instead. A stored Session is resumed by the factory its recorded preset selects; a Session that records no preset stays on agent-loop.

A turn that cannot run ends with an error on `turn/end`: `CASPER_NOT_FOUND` when the command cannot be found, `CASPER_START_FAILED` when Casper does not start, `CASPER_EXITED` when it exits mid-turn, `CASPER_TEXT_ONLY` for a prompt that carries an image or file or has no text (nothing is sent to Casper), `CASPER_TURN_LIMIT` at Casper's turn limit, and `CASPER_RPC_<code>` for an error reply. The Session stays usable; the next prompt starts Casper again.

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: registers the projections, opens the sidecar, and registers the factory route |
| [`src/route.ts`](src/route.ts) | Selects root Sessions on the configured presets; delegated children stay on agent-loop |
| [`src/factory.ts`](src/factory.ts) | Creates and resumes Agents with agent-loop's publication order, refuses forks, and tears every Agent down in parallel on unload |
| [`src/agent.ts`](src/agent.ts) | `CasperAgent`: inbox, phases, one prompt per turn, cancel, and process restart |
| [`src/connection.ts`](src/connection.ts) | One `casper acp` process: lookup, spawn, ACP client, `session/new` or `session/load`, prompt, cancel, and disposal |
| [`src/turn.ts`](src/turn.ts) | Writes Casper's updates as steps, assistant messages, tool calls, results, and the todo list |
| [`src/permission.ts`](src/permission.ts) | Turns an approval box into a user question and maps the answer back |
| [`src/sidecar.ts`](src/sidecar.ts) | Host storage domain `casper_agent` mapping each Session to its Casper conversation |

### Turns and events

Each turn claims the queued input and appends `turn/start`, `step/start`, and the claimed `user/message` events unchanged, then flushes the Session before Casper can change files. The claimed text goes to Casper as one `session/prompt`. Casper takes no input while a prompt runs, so steering waits for the next turn.

| Casper update | Session events |
|---|---|
| `agent_message_chunk` text | live `agent/assistant-stream` frames, settled as `assistant/message` |
| `tool_call` | the step's `assistant/message` with a tool-call block, then `tool/call` named `casper_<tool>`; the next text opens a new step |
| `tool_call` while other calls of the step are open | another `assistant/message` in the same step holding only that call's block, then its `tool/call`, so every stored call is advertised and the Session reopens |
| `tool_call_update` completed or failed | `tool/result`; a failed tool is an error result, a refused approval is not |
| check `tool_call` (already completed or failed) | `tool/call` named `casper_check` and its result at once |
| `plan` | `todo/write` with the whole list |
| a call still open when the prompt ends (Stop, exit, or reply) | an error `tool/result` with `TOOL_OUTCOME_UNKNOWN`, as agent-loop records for a failed step, before `step/end` |

The receipt is the last text chunk, so it ends the final assistant message. A prompt reply resolves only after every update received before it has been written. Stop sends `session/cancel` and ends the turn as aborted; Casper is killed when it has not replied within `cancelGraceMs`. Tool call ids carry a random per-process prefix, so a restarted Casper's ids never fold into earlier cards.

### Approvals

`session/request_permission` becomes one `ctx.userQuestions.ask` question with Casper's options as labels, refusals first. One picked label selects that option. Typed text, no pick, a failed or aborted question, and a missing question service answer `cancelled`, which Casper treats as No. The question closes when Casper closes the box itself or the prompt ends.

### Process lifetime and resume

Casper starts at a Session's first prompt, so a missing command never blocks opening a Session. After `session/new`, the conversation id is stored in the sidecar before the prompt is sent. A later process reopens it with `session/load` and drops the replayed updates, since the Session already holds the history; only Casper's no-saved-conversation reply (`-32002` whose message contains "no saved conversation" in any letter case) starts a fresh conversation, and that turn opens with a line saying so. Casper saves a conversation only after its first reply, so a conversation whose process stopped before then starts fresh this way. Another load failure ends the turn and keeps the record. Disposal closes stdin, waits `exitGraceMs`, then terminates the process, which fits Desktop's 10 second host exit. Resume repairs an interrupted turn like agent-loop and starts no process.

<a id="model-experience"></a>
## Model Experience

None, as the Casper process builds its own model requests and this plugin adds nothing to any DeepSeek request.

#### KV Cache effect

The plugin sends no model request, so it has no cache effect; Casper's own requests are outside this repository.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Prompts carry text only; a turn whose input carries an image or file ends with `CASPER_TEXT_ONLY` without sending its text.
- The model picker does not change Casper's model, and the model badge stays empty until the user picks one; `model` and `effort` are deployment config.
- Reasoning, tool output, diffs, token usage, and cost are not shown, because Casper sends none of them; `session/load` replays are not shown.
- The app's MCP servers are not passed to Casper; Casper uses only its own.
- Approvals use the generic question card; there is no fixed approval card or separate Allow-always presentation.
- Steering is delivered as the next prompt.
- Forking a Casper Session is refused.
- Headless, SDK server, ACP, and webhook resumes do not pass a preset, so a Casper Session reopened by them runs on agent-loop.
- Scheduled tasks with no saved preset run in Casper on Desktop, because they create Sessions through the Session Controller with the default preset.
- Only Desktop on macOS and Linux is covered; the Windows lookup is untested.
- Sidecar records are not removed when a Session is deleted, and idle Casper processes are not reaped.
- Subagent, team, and goal features do not run inside Casper Sessions.
- Host-plane title generation may still call a DeepSeek model for Casper Sessions.
- `packages/casper/tool-checks` stays until Casper Sessions are proven live.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

- **Model choice** — driving Casper's model from the GUI picker would restart Casper with `--model` and reopen the conversation with `session/load`.
- **Approval card** — a composer adapter could render Casper's boxes with the shared approval card once Casper's option kinds map onto its fixed actions.
- **Checks plugin** — `packages/casper/tool-checks` can be removed from the Standard preset once Casper Sessions are proven live.

</details>
