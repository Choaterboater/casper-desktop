---
description: "The Casper agent driver: Sessions on the Casper preset run the Casper agent over its ACP server instead of the DeepSeek agent loop; configuration, event mapping, approvals, process lifetime, and resume."
kind: "package-reference"
---

# @deepseek-ai/dsh-casper-agent

English | [中文](README.zh.md)

## Summary

This plugin makes the Casper agent the main AI for Sessions on the `casper` preset. A factory route on `ctx.agents` drives each with one `casper acp` process instead of the DeepSeek agent loop. Casper's text, steps, checks, plan, and receipt become Session events, so the transcript, tool cards, todo list, and Stop work unchanged. Approval boxes become questions, the access control sets Casper's mode, and the model picker lists Casper's models. Each process also gets the app's tools over a private MCP server, to inspect the app and install plugins. Desktop starts new Sessions on this preset by default.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Desktop profile mounts the plugin from `packages/bundle/web-app/cordis.patch.yml` (row `casper-agent`, disabled outside Desktop and in the in-browser preview) and declares the `casper` preset in `packages/bundle/web-app/presets/casper.patch.yml`. The preset mounts `tool-todo`, which shows Casper's plan as the todo list, and the rows the app tools run: `tool-cordis`, `skill-filesystem` (with the Cordis preset's skill folders), `tool-skill`, and `tool-plugin-manager`, which binds the app's existing plugin manager and is off when the app runs without a profile. The Checks plugin and the plugin market are not mounted. On Desktop the preset registry's default is `casper`; a default saved in Settings still wins. The plugin injects `agents`, `sessions`, `sessionProjections`, `sessionPersistence`, `subprocess`, `storageDomain`, and `tools`, and uses `userQuestions`, `skills`, `profileContext`, `attachments`, `commands`, `permissionPresets`, and `sandboxPolicy` when they are mounted.

| Field | Default | Meaning |
|---|---|---|
| `presets` | `['casper']` | Presets whose Sessions Casper drives |
| `command` | `casper` | Casper executable; the Desktop row looks it up on PATH, `~/.local/bin`, `~/.bun/bin`, `/opt/homebrew/bin`, and `/usr/local/bin` |
| `args` | `['acp']` | Arguments that start Casper's ACP server |
| `model` | unset | Start model, passed as `--model`; unset keeps Casper's own default. The [model picker](#model-picker) changes it per Session |
| `effort` | unset | Start effort, passed as `--effort`; unset keeps Casper's own default. The model picker changes it per Session |
| `env` | `{}` | Child environment added after the subprocess scrub; the Desktop row passes a PATH that leads with bun's folders and `OPENROUTER_API_KEY` when set |
| `startTimeoutMs` | `30000` | Limit for `initialize` plus `session/new` or `session/load` |
| `cancelGraceMs` | `5000` | Wait for the prompt reply after Stop before Casper is killed |
| `exitGraceMs` | `2500` | Wait for Casper to exit after stdin closes |
| `killGraceMs` | `5000` | Grace between SIGTERM and SIGKILL |
| `stderrTailBytes` | `4096` | Bytes of Casper's stderr kept for failure messages |
| `appTools` | `true` | Offer the app tools to Casper; `false` sends an empty `mcpServers` list |
| `accessModes` | `{ read-only: read, workspace-write: ask, danger-full-access: full }` | The [access mode](#access-control) each permission preset sets; `custom` and `auto` cannot be listed |
| `approvalCard` | `true` | Show Casper's boxes with [Casper's approval card](#approvals); `false` shows the generic question card |

The child never receives `DEEPSEEK_*` or `DSH_*` names, or credential-shaped names that `env` does not list. The one exception is the app profile: when the app runs with a profile, Casper gets `DSH_PROFILE` and `DSH_PROFILE_DIR`, so a bundle it builds can name the profile it installs into.

A Session becomes Casper when it is created on a Casper preset. A blank Session cannot switch between Casper and another preset: the preset registry refuses that switch with `agent-preset/locked` and `newSession: true`, and the mode picker starts a new Session on the chosen preset instead. A stored Session is resumed by the factory its recorded preset selects; a Session that records no preset stays on agent-loop.

A turn that cannot run ends with an error on `turn/end`: `CASPER_NOT_FOUND` when the command cannot be found, `CASPER_START_FAILED` when Casper does not start, `CASPER_EXITED` when it exits mid-turn, `CASPER_EMPTY_PROMPT` for a prompt with nothing Casper can read: no text, picture, or file, or only pictures and files that could not be sent (nothing is sent to Casper), `CASPER_TURN_LIMIT` at Casper's turn limit, `CASPER_MODEL_UNAVAILABLE` when Casper refuses the picked model or effort (no prompt is sent), `CASPER_ACCESS_NOT_APPLIED` when Casper does not take Read only or Ask first (no prompt is sent, or the running prompt stops), and `CASPER_RPC_<code>` for an error reply. The Session stays usable; the next prompt starts Casper again. `CASPER_TEXT_ONLY` is no longer raised; it appears only in turns saved by earlier versions.

<a id="understand-the-implementation"></a>
## Understand the implementation

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: registers the projections, opens the sidecar, and registers the factory route |
| [`src/route.ts`](src/route.ts) | Selects root Sessions on the configured presets; delegated children stay on agent-loop |
| [`src/factory.ts`](src/factory.ts) | Creates and resumes Agents with agent-loop's publication order, refuses forks, and tears every Agent down in parallel on unload |
| [`src/agent.ts`](src/agent.ts) | `CasperAgent`: inbox, phases, one prompt per turn, steering sent to the prompt in flight, cancel, and process restart |
| [`src/connection.ts`](src/connection.ts) | One `casper acp` process: lookup, spawn, ACP client, `session/new` or `session/load`, prompt, cancel, and disposal |
| [`src/turn.ts`](src/turn.ts) | Writes Casper's updates as steps, assistant messages, tool calls, results, and the todo list |
| [`src/views.ts`](src/views.ts) | Records a Casper tool step under the Standard tool that does the same job: its name, arguments, result text, and meta |
| [`src/permission.ts`](src/permission.ts) | Turns an approval box into a user question headed `Casper`, with the raising step's diff lines in its detail, and maps the answer back; a plan Build box becomes a plan review |
| [`src/box.ts`](src/box.ts) | The box's question id, header, and card limit, shared by both halves |
| [`src/client/index.ts`](src/client/index.ts) | Client half: registers Casper's approval card first in the conversation composer chain |
| [`src/client/CasperBoxCard.tsx`](src/client/CasperBoxCard.tsx) | Casper's approval card: which questions it takes, its rows, keys, and answer |
| [`src/elicitation.ts`](src/elicitation.ts) | Turns one of Casper's forms (`elicitation/create`) into a user question and maps the answer back |
| [`src/sidecar.ts`](src/sidecar.ts) | Host storage domain `casper_agent` mapping each Session to its Casper conversation |
| [`src/commands.ts`](src/commands.ts) | Casper's commands for the `/` menu, and host storage domain `casper_agent_commands` keeping the last list |
| [`src/app-tools.ts`](src/app-tools.ts) | The app tools MCP server: listener, auth, tool list, and calls run as the Casper Agent |
| [`src/app-read.ts`](src/app-read.ts) | `app_read_file`: read-only access to the app's install and profile folders |
| [`src/models.ts`](src/models.ts) | Reads Casper's `model` and `thought_level` options as the picker's groups, efforts, and current model |
| [`src/model.ts`](src/model.ts) | `CasperModel`: the Agent's model handle, which hands picks to Casper instead of the Host catalog |
| [`src/models-cache.ts`](src/models-cache.ts) | Host storage domain `casper_agent_models` keeping the last model list |
| [`src/access.ts`](src/access.ts) | Maps the permission preset to Casper's access mode |

### Turns and events

Each turn claims the queued input and appends `turn/start`, `step/start`, and the claimed `user/message` events unchanged, then flushes the Session before Casper can change files. The claimed messages go to Casper as one `session/prompt`, their blocks in order: text as `text`; a picture as an `image` block holding its stored normalized bytes in base64 with the stored media type, when Casper's `initialize` reply sets `promptCapabilities.image` to true; and a file as a `resource_link` to the attachment service's read-only host copy (`file:` URI, name, and byte size), which Casper reads with its own file tools. A picture an older Casper cannot take, a picture the attachment service cannot read, and a file with no host path are sent as one line of placeholder text each, and the turn's reply opens with a note saying so. An abort during a picture read ends the turn as aborted and sends no prompt, even when the attachment service finishes the read.

A line steered in during a prompt goes to a Casper whose `initialize` reply sets `agentCapabilities._meta.casper.steer`, as `_casper/steer` with the Session's Casper conversation id, the line's blocks, and its message id: right after the prompt is sent, one line at a time in queue order. The line stays queued until Casper sends its read notice, a `user_message_chunk` carrying that `messageId`; the line is then claimed for the turn and recorded, as it was sent, as the `user/message` that opens the next step. A line Casper refuses or never reads, or one with a part that would go as a placeholder, runs as the next turn with every line queued after it, and so does every line for an older Casper. Stop clears an unread line with the rest of the queue.

| Casper update | Session events |
|---|---|
| `agent_message_chunk` text | live `agent/assistant-stream` frames, settled as `assistant/message` |
| `tool_call` | the step's `assistant/message` with a tool-call block, then `tool/call` with the Standard tool's name and arguments, or `casper_<tool>` (see [Tool cards](#tool-cards)); the next text opens a new step |
| `tool_call` while other calls of the step are open | another `assistant/message` in the same step holding only that call's block, then its `tool/call`, so every stored call is advertised and the Session reopens |
| `tool_call_update` completed or failed | `tool/result` with the Standard result text and meta, never a bare status word; a shell step that ran records its exit code and is not an error, any other failed step is, and a refused approval is not |
| `tool_call_update` still in progress | nothing: the call stays open and an asked approval box stays asked |
| check `tool_call` (already completed or failed) | `tool/call` named `casper_check` and its result at once |
| `plan` | `todo/write` with the whole list |
| `user_message_chunk` read notice for a steered line | that line's `user/message`, opening the next step once the step's open calls close, or joining the step when Casper has written nothing in it yet |
| a call still open when the prompt ends (Stop, exit, or reply) | an error `tool/result` with `TOOL_OUTCOME_UNKNOWN`, as agent-loop records for a failed step, before `step/end` |

The receipt is the last text chunk, so it ends the final assistant message. A prompt reply resolves only after every update received before it has been written. Stop sends `session/cancel` and ends the turn as aborted; Casper is killed when it has not replied within `cancelGraceMs`. Tool call ids carry a random per-process prefix, so a restarted Casper's ids never fold into earlier cards.

<a id="tool-cards"></a>
### Tool cards

Casper names each step in `_meta.casper.tool`, and its `rawInput` holds the model's own arguments. The Session records the step under the Standard tool that does the same job, so Standard's cards draw it: the diff card for edits and writes, the terminal card for shell steps, the read preview, the search card, and the web card. An older Casper that sends only `rawInput` `{tool, target}` is mapped from those two fields.

| Casper tool | Recorded as | Arguments | Result |
|---|---|---|---|
| `edit` | `edit` | `file_path`, the first edit's `old_string` and `new_string`, and `edits` when there are several, read from each form pi's edit takes; when Casper hides both sides behind one placeholder, `old_string` is `<not shown: the text it replaced>` | Casper's words, or `Edited <path> (+a −r)`; meta `path` and `diffs` |
| `write` | `write` | `file_path`, `content` | Casper's words, or `Created` or `Updated <path>`; meta `operation`, `path`, and `diffs`, empty for a new file |
| `bash`, `powershell` | `bash`, `pwsh` | `command`, `description` (Casper's, else the command's first line), `timeoutMs` | the output without its fence, then `[exit code: N]` unless N is 0 |
| `read` | `read` | `file_path`, `offset`, `limit` | the file envelope with meta `path`, `offset`, `lines`, `totalLines`, and `lang` when the window was read whole or Casper counted its lines, as it does for a window that stops before the end of the file; otherwise the text alone |
| `grep` | `grep` | `pattern`, `path`, `include` (only a glob Standard accepts) | meta `shape: matches`, `files`, `total`, `truncated` |
| `find`, `ls` | `glob` | `pattern` (`*` for `ls`), `path` | meta `shape: paths`, `paths`, `total`, `truncated` |
| `web_search` | `web_search` | `queries` | meta `sources`, `truncated`, `answer` |
| `web_fetch` | `web_fetch` | `url` | meta `url`, `statusCode`, `truncated` |
| `ask` | `ask_user_question` | one question with id `casper-question`: `question`, `options`, `multi_select` | the answers given in the app as `{answers}`, else Casper's words |
| an [app tool](#app-tools) | the app tool's own name | the MCP arguments; for a call through `call_capability`, the `arguments` it carries | the app tool's own result and meta |
| another MCP tool | `casper_mcp` | `title`, the input, and `preview` | Casper's words |
| any other tool | `casper_<tool>`, or the tool's own name when it already starts with `casper_`, such as `casper_check` | `title`, the input, and `preview` | Casper's words, or its raw output as JSON |

A shell step that ran is never an error, whatever its exit code. Any other failed step is an error with Casper's words, or `Casper reported that this step failed.` when it sent none. A meta path is recorded only when Casper reports an absolute one, so the turn's deliverables list the files its edits and writes produced. A step whose result does not have the expected shape keeps Casper's text with no meta, which draws the plain card.

<a id="approvals"></a>
### Approvals

`session/request_permission` becomes one `ctx.userQuestions.ask` question with id `casper-permission`, headed `Casper`, with Casper's options as labels, refusals first, and their descriptions. Its detail is the box's text, then the diffs of the step that raised the box: each file's path, its old lines as `- ` and its new lines as `+ `, at most 120 lines and then `… N more lines in the edit step`. A box from an older Casper carries no diffs and shows its text only. One picked label selects that option. Typed text, no pick, a failed or aborted question, and a missing question service answer `cancelled`, which Casper treats as No. The question closes when Casper closes the box itself or the prompt ends.

The plugin's Client half shows such a question with Casper's approval card, registered first in the conversation composer chain (priority -1). The card takes only a question with one item, that id and header, a single pick, and 1 to 4 options; any other question, a plan review included, keeps its own card. The title is the question's first line, and its other lines and the detail follow as plain text. Each option is one row in Casper's order, No first, with its number and its description under it. The card counts nothing in its first 300 ms, then focuses No unless focus is in another field outside the composer seat, where it stays. Its keys count only while focus is in the card, and its scrolling detail can be reached with Tab. Esc answers No, and a digit picks that row; a key with a modifier, a repeated key, and a key during IME composition count for nothing. Enter has no handler of its own, so it clicks the focused row. An answer is sent once: the card stays busy until Casper closes the box, and the rows work again if the send fails. A closed question answers nothing. With `approvalCard: false` the box has no header and the generic question card asks it.

The client's `initialize` offers `clientCapabilities.elicitation.form`, so Casper asks the AI's questions and its own typed or multi-pick questions as forms instead of skipping them. An `elicitation/create` in Casper's shape (form mode, an `answer` field that is a titled single pick, a titled multi pick, or a typed line, and an optional `other` field for typed words) becomes one question with id `casper-question`, headed `The AI asks` for the AI's question and `Casper asks` otherwise. Picked labels go back as their values in the order picked, and typed words go back as `other`, or as the `answer` of a typed line. Typed words on a form without `other`, and a form in any other shape, decline; no answer, a failed or aborted question, a form outside a prompt, and a missing question service cancel, which Casper treats as skipped. The form's step is recorded as `ask_user_question`: the ask tool's own step, or the pending `casper-question-N` step Casper opens for its own question. An answer recorded in the app becomes that step's result as `{answers}` when Casper completes it, so Standard's question card shows the answer. The question closes when Casper closes the step or withdraws the request, or the prompt ends.

Casper's plan Build box carries `_meta.casper.plan` with its Build and Change the plan labels, and the plan as Markdown that starts with a `# ` title. It becomes a plan review: one question headed `Plan review` with the plan as its detail, only those two options, and the `plan-review` intent with the call id of the box's step, so the app shows its plan card. The step is recorded as `exit_plan_mode` with `{plan}`, so the plan card and the Plan tab open the plan. Build selects Build. Dismissing the card to say what should change (Discuss, `ASK_CANCELLED`) selects Change the plan, and Casper then asks what should change as a form. A timeout, an abort, and a missing question service answer `cancelled`, which Casper treats as Stop. A box without the labels, or whose labels name none of its options, is asked as any other box.

<a id="access-control"></a>
### Access control

The composer's access control (the permission preset) sets Casper's access mode. With the default `accessModes`, Read Only is `read` (Casper blocks every change it can see), Workspace Write is `ask` (Casper's usual boxes), and Full access is `full` (Casper's `/permissions all`). A read-only sandbox is always `read`; the derived `custom` preset, Auto, and a preset the table does not list are `ask`, never `full`. Without the presets service nothing is sent.

The mode goes in Casper's `mode` config option, or in `session/set_mode` when Casper offers only `modes`. It is sent before each prompt, after a Casper restart, and as soon as the preset changes, during a prompt too; one switch sends one request. A mode Casper picks itself, such as "Yes to everything this session" or `/permissions all`, is kept until the preset changes and never moves the control: only the person's own pick sets the preset. The exception is Read Only, which the app sets again whenever Casper leaves it.

When Read Only or Workspace Write cannot be set before a prompt, the turn ends `CASPER_ACCESS_NOT_APPLIED` and no prompt is sent; a Casper without modes runs Workspace Write as usual. When it cannot be set during a prompt, the prompt stops and the turn ends the same way; a switch that fails while the turn is still preparing its prompt, such as during a picture read or a model set, ends the turn the same way with no prompt sent. Full access that cannot be set leaves a note in the reply, and Casper asks as usual.

### Casper's commands

Casper sends its slash commands, the user's own `~/.casper/commands` included, in `available_commands_update`, right after it opens a conversation and again when the list changes; the list is kept during a `session/load` replay. When the `commands` registry is mounted, each command is registered for this Agent only, with Casper's description, its input hint, and the definition id `@deepseek-ai/dsh-casper-agent/<name>`, so it appears in that Session's `/` menu and in no other Session's. A later list replaces the earlier one, and an unchanged list registers nothing. A name the registry would refuse, the composer's own `model` and `file`, a command without a description, and a name that already resolves to another command, such as the app's `/permission`, `/export`, or `/feedback`, are not offered; the app's command keeps the name.

The identity tells clients to treat the line as a prompt ([ui-commands](../../client/ui-commands/README.md)): picking a command inserts `/name`, with a trailing space when it takes input, and Enter sends the typed line, attachments included, as an ordinary prompt that Casper runs as its own command. A surface that executes the command instead queues the same line as the next prompt. The last list is kept in the host storage domain `casper_agent_commands` (one global record), and each new Agent offers it before its own Casper starts. An Agent registers its commands only once it is published: each registration makes every client repull its Sessions' menus, and a repull resumes a Session that is not live, so an Agent whose creation fails registers nothing.

Casper's `plan` option (Plan first: every request gets a plan first) is shown by the composer's plan chip. The plugin registers only plan-mode's `plan` projection, never its controller, and records Casper's value as `plan/mode` whenever the option changes and at the end of each turn, so a `/plan` sent as a prompt, with or without words, leaves the chip as Casper left it. While a Casper that offers the option is running, `/plan on` and `/plan off`, the chip's exit included, set the option with `session/set_config_option` and send no prompt; otherwise the line goes to Casper as a prompt. Once a Session has been in Plan first, a restarted Casper gets the Session's last value before its first prompt; a Casper that refuses keeps its own value. A Casper without the option never moves the chip.

<a id="model-picker"></a>
### Model picker

Casper sends its options in the `session/new` and `session/load` replies and again in `config_option_update`. The option of category `model` is the model list, grouped by provider, and each model lists the efforts it takes in `_meta.casper.efforts`; the option of category `thought_level` is the effort and names those values. An older Casper that sends no `_meta.casper.efforts` gives its current model the effort option's values. Casper's `mode` option is not read here. Each changed list is recorded as the plugin record `plugin:casper-agent/models`, which an app build without this package keeps and skips, so it still opens the Session. The `agentModels` projection skips a malformed record and gives the composer badge and `/model` the list, Casper's current model and effort, and whether Casper itself sent them ([ui-model-selection](../../client/ui-model-selection/README.md#agent-offered-models)). Messages are labelled with the model Casper reported.

A pick goes to the Agent, not the Host catalog: it is checked against Casper's list, recorded as `model/selection`, and sent with `session/set_config_option` (`model` first, then `effort` when it differs). A pick for a model Casper does not list, or an effort its model does not take, is refused at once; a model with no efforts takes none. While Casper is idle the pick is sent at once and no prompt is sent. A pick made during a prompt, or before Casper starts, is sent at the start of the next turn, before the prompt. When Casper refuses it, the turn ends `CASPER_MODEL_UNAVAILABLE` with Casper's words and no prompt, and the badge shows Casper's model again. A pick made while an earlier one is being sent is sent next, so the last pick wins. ACP cannot cancel a set, so a Stop while Casper has not answered one kills Casper; the pick stays and reaches the next Casper before its first prompt. A model Casper changes itself, such as with its own `/model`, moves the badge and labels the messages after it.

A new Session shows the list kept in the host storage domain `casper_agent_models` (one global record) until its own Casper starts, with `model` from the config as its current model when set; before any Casper has sent a list, the picker says Casper lists its models once it starts. A resumed Session keeps what its history recorded. A Session created before this list was recorded refuses a pick until its Casper starts.

### Process lifetime and resume

Casper starts at a Session's first prompt, so a missing command never blocks opening a Session. After `session/new`, the conversation id is stored in the sidecar before the prompt is sent. A later process reopens it with `session/load` and drops the replayed updates, since the Session already holds the history; only Casper's no-saved-conversation reply (`-32002` whose message contains "no saved conversation" in any letter case) starts a fresh conversation, and that turn opens with a line saying so, even when it then sends nothing. Casper saves a conversation only after its first reply, so a conversation whose process stopped before then starts fresh this way. Another load failure ends the turn and keeps the record. Disposal closes stdin, waits `exitGraceMs`, then terminates the process, which fits Desktop's 10 second host exit. Resume repairs an interrupted turn like agent-loop and starts no process.

<a id="app-tools"></a>
### App tools

Each `casper acp` process gets one MCP server of its own, started after `initialize` and offered in `session/new` and `session/load` as the only `mcpServers` entry: `type: "http"`, name `app`, URL `http://127.0.0.1:<port>/mcp/<pathId>`, an `Authorization: Bearer <token>` header, and `_meta: {"casper/clientAsks": true}`. The path id (16 random bytes) and token (32 random bytes) are made fresh for each process and travel only inside the ACP pipe; they are not in argv, env, stderr, logs, or Session events. The listener binds `127.0.0.1` only and checks each request in order: wrong path is 404, a `Host` other than `127.0.0.1:<port>` is 403, any `Origin` header is 403, and a token that does not match (compared in constant time) is 401. It closes when the process exits, is terminated, or is disposed, so a restarted Casper gets a new path and token and the old ones stop working.

The server speaks MCP Streamable HTTP as `dsh-desktop`, with the app's dsh runtime version as its version, and sends no instructions. It keeps no MCP session, so it answers a GET for a notice stream with 405 and states `tools.listChanged: false`. It lists only the tools the Casper Agent can see, in this order, which is the order Casper takes pins in:

| MCP tool | Runs | Marked |
|---|---|---|
| `app_skill` | dsh `skill` | read-only, pinned |
| `plugin_manager` | dsh `plugin_manager` | pinned |
| `app_read_file` | this package's reader | read-only, pinned |
| `cordis_inspect_query` | dsh `cordis_inspect_query` | read-only, pinned |
| `cordis_inspect_list` | dsh `cordis_inspect_list` | read-only |

Every call runs through `ctx.tools.execute` with the Casper Agent as `agent`, so the tool sees the same Session, profile, and approvals as in the DeepSeek loop. The call id is the Session call id of the Casper step that made the call, taken from `_meta["casper/acpToolCallId"]`; a call without one gets a fresh id. A call is accepted only while a Casper turn runs and is aborted with it; a call that arrives after the turn gets an error that says so. A pending call sends a progress notification every 10 seconds so Casper's idle timer does not expire. A result's text blocks pass through as MCP text; any other block, such as an image, becomes a one-line note like `[image result not sent]`.

`plugin_manager` keeps its own rules: bundles the app hides are refused as `not-offered`, and each action, `install_bundle` included, asks with the app's own approval card as it does in the DeepSeek loop. `clientAsks` tells Casper that card is the gate, so Casper shows no change box of its own for this server and its automatic answers never approve an install. Under Full access the app's card no longer asks, so Casper in its `full` mode ignores `clientAsks` and asks in its own box: one box either way.

`app_skill`'s description names the skills the Agent can load, starting with `cordis-plugin-development`, within 1,000 characters. A loaded skill opens with a line telling Casper to write bundles in its workspace, read the skill's files with `app_read_file`, and use the `DSH_PROFILE` and `DSH_PROFILE_DIR` it was given; in an installed app the line adds that packages there have no `lib/types` or `src` and no repository docs, so slot props and theme tokens come from `cordis_inspect_query`. `app_read_file` reads only under the folder holding the app's installed packages (the nearest `node_modules` above this package; in a source checkout, its `packages` and `docs` folders) and the profile's `node_modules`. Paths are compared with `path.relative`, and a symlink whose real path leaves the folder is refused. One call returns at most 256 KB of text in a line window; a single line longer than that is cut to its first 256 KB, the note says so, and the next window starts after it. A binary file other than SVG gets a one-line note, a folder lists at most 500 entries, and a file over 32 MB is refused.

<a id="model-experience"></a>
## Model Experience

None, as the Casper process builds its own model requests and this plugin adds nothing to any DeepSeek request. The app tools' names, descriptions, and results do reach Casper's own requests.

#### KV Cache effect

The plugin sends no model request, so it has no cache effect; Casper's own requests are outside this repository.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A Casper whose `initialize` reply does not set `promptCapabilities.image` gets a placeholder instead of each picture.
- A pick is checked against the list Casper last sent; a model Casper later finds signed out is refused when the pick is sent.
- Reasoning, token usage, and cost are not shown, because Casper sends none of them; `session/load` replays are not shown.
- A running shell step shows no output until it ends.
- Only the app tools server is passed to Casper; the app's configured MCP servers are not.
- App tool results reach Casper as text only: an image or other non-text block becomes a note. None of the served tools returns an image today.
- In a packaged app `app_read_file` reaches each installed package's `README.md`, `package.json` and built `lib/*.js`, the skill files, and `ui-theme`'s `lib/styles`. The Desktop runtime copy drops every `.d.ts`, packages publish no `src/`, and the repository's `docs/` ship in no package, so `lib/types`, `ui-sidebar`'s `slots.ts`, `docs/cordis-tutorial` and `docs/web-styling.md` cannot be read there; slot props and theme tokens come from `cordis_inspect_query` instead. Shipping those guides with the app is not done.
- Casper's approval card shows a diff as plain `- ` and `+ ` lines, at most 120, not as a diff view.
- A mode Casper picks itself is not shown: the access control keeps showing the preset.
- Steering reaches an older Casper, whose `initialize` reply does not set `agentCapabilities._meta.casper.steer`, as the next prompt.
- Before any Casper has sent its command list in this app, Casper's commands are missing from the `/` menu until the Session's first prompt starts Casper.
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

- **Checks plugin** — `packages/casper/tool-checks` can be removed from the Standard preset once Casper Sessions are proven live.

</details>
