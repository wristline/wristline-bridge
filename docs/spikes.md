# Spikes

Observations from running real agents against the bridge. Each entry records the setup, what was
seen, and the decision it led to.

## Phase 2 — Claude Code control (2026-09-29)

**Setup.** Claude Code 2.1.284, model Haiku 4.5, Linux (WSL2), tmux 3.4. A throwaway project
directory whose `.claude/settings.json` held pre-existing entries (async `command` hooks that
appended each hook's stdin to a file, and a statusLine with `padding` and `refreshInterval: 5`);
`wristline-bridge hooks install --settings <that file>` merged the bridge hooks into it. Claude
ran in a dedicated tmux session as `claude --model haiku --setting-sources project,local
--strict-mcp-config` (user settings skipped), the bridge with a separate `XDG_CONFIG_HOME` on
ports 47870/47871, and `scripts/fake-watch.ts` played the watch. Project-level hooks fire for all
events used here, including the http PermissionRequest hook.

### S1 — PermissionRequest while the terminal dialog is up

- **The terminal dialog is shown at the same time as the hook runs.** While the http hook was
  pending, the pane showed the normal "Bash command … Do you want to proceed?" dialog.
- **Answering in the terminal does not end the HTTP request.** The tool ran, but Claude Code kept
  the connection to the bridge open (`ss` showed it ESTABLISHED) and never aborted it, so the
  request stayed open on the watch until the bridge's own timeout. A watch answer sent after
  that is ignored by Claude Code (no effect, no error).
- **The registry tracks the dialog.** `~/.claude/sessions/<pid>.json` switches to
  `status: "waiting"` with `waitingFor: "permission prompt"` when the dialog appears — its
  `statusUpdatedAt` was 3 ms *before* the bridge opened the request — and to `busy` right after it
  is answered.
- Watch answers: `allow` → the dialog closed, "Allowed by PermissionRequest hook", the tool ran.
  `deny` → "Denied by PermissionRequest hook" and the model saw the denial. `always` (with
  `updatedPermissions` = the input's `permission_suggestions`) → allowed, and the suggested
  `setMode: acceptEdits` took effect ("accept edits on"). `defer` → empty 200, the dialog stayed
  and was answered in the terminal.
- Timeout (`permissionWaitSec: 15`): `resolved {by: "timeout"}` after 15 s, the dialog stayed in
  the terminal.
- Without a watch connected: no request was created and the dialog behaved as without the bridge.
- Recorded input (paths shortened):

  ```json
  {"session_id":"eeba9f38-…","transcript_path":"…/eeba9f38-….jsonl","cwd":"…/spike-project",
   "scratchpad_dir":"…","prompt_id":"7078aab3-…","permission_mode":"default",
   "hook_event_name":"PermissionRequest","tool_name":"Bash",
   "tool_input":{"command":"touch s1-terminal.txt","description":"Create a new file named s1-terminal.txt"},
   "permission_suggestions":[
     {"type":"addDirectories","directories":["…/spike-project"],"destination":"session"},
     {"type":"setMode","mode":"acceptEdits","destination":"session"}]}
  ```

  There is no `tool_use_id` in PermissionRequest input (PreToolUse has one).
- The `permission_prompt` Notification arrived while the request was open, so the bridge sent no
  extra `needs_input` alert.

**Decisions.**
1. Because the dialog is up in parallel, waiting longer costs nothing at the PC:
   `permissionWaitSec` default **590** (hook timeout 600), as the plan prescribes for this case.
   "Answer on PC" stays: it clears the request from the watch.
2. The bridge cannot rely on the HTTP abort. Every 2 s refresh now resolves an open request as
   `by: "terminal"` when its session's registry status is no longer `waiting` and changed after
   the request opened, or when the session is gone. Retest: `resolved {by: "terminal"}` arrived
   ~1 s after answering in the terminal, for permissions and for AskUserQuestion. The abort path
   stays for agents that do drop the request.
3. Not verified: several dialogs queued at once (parallel tool calls). If the terminal answers
   one and the next appears before the 2 s refresh, the first request stays on the watch until
   the status leaves `waiting`.

### S2 — AskUserQuestion in an interactive session

- **PermissionRequest fires for AskUserQuestion** (`tool_name: "AskUserQuestion"`), alongside
  PreToolUse; the terminal shows its question dialog at the same time and the registry says
  `waiting` / `waitingFor: "input needed"`.
- Answering with `decision: {behavior: "allow", updatedInput: {...tool_input, answers}}` works: the
  pane printed "User answered Claude's questions: · Which color do you prefer? → blue · Which
  fruits do you like? → apple, cherry … Allowed by PermissionRequest hook", and the model replied
  `ANSWERS: blue / apple, cherry` (multi-select labels joined by `", "`).
- Recorded input:

  ```json
  {"session_id":"eeba9f38-…","prompt_id":"7fbe3659-…","permission_mode":"acceptEdits",
   "hook_event_name":"PermissionRequest","tool_name":"AskUserQuestion",
   "tool_input":{"questions":[
     {"question":"Which color do you prefer?","header":"Color","multiSelect":false,
      "options":[{"label":"red","description":"The color red"},{"label":"blue","description":"The color blue"}]},
     {"question":"Which fruits do you like?","header":"Fruit","multiSelect":true,
      "options":[{"label":"apple","description":"A red or green fruit"},{"label":"banana","description":"A yellow fruit"},
                 {"label":"cherry","description":"A small red fruit"}]}]}}
  ```

**Decision.** PermissionRequest handles AskUserQuestion; `hooks install` does not add a
PreToolUse hook. `POST /hooks/pre-tool-use` still exists (same answer via
`permissionDecision: "allow"` + `updatedInput`) should a later version stop sending
PermissionRequest for it. No tmux keystroke fallback is needed. The terminal's "Type something"
and "Chat about this" choices are not offered on the watch.

### S3 — Registry status and the `tmux` field

| Situation | `status` | `waitingFor` |
|---|---|---|
| Idle at the prompt | `idle` | — |
| Turn running (model or tool) | `busy` | — |
| Permission dialog | `waiting` | `permission prompt` |
| AskUserQuestion dialog | `waiting` | `input needed` |
| `!` typed but not run | `idle` | — |
| `!` command running | `busy` | — |

- `shell` never appeared with 2.1.284; it occurs only in old entries (versions 2.1.178–2.1.198).
  It stays mapped to `running`.
- `tmux` is `"<session>:@<window>.%<pane>"`, e.g. `"wristline-spike:@11.%22"` for the pane
  `tmux list-panes` reported as `%22`. Entries stay on disk after the process exits; this
  machine had several dead entries naming the same pane (`HookShift:@2.%4` five times). Only
  live entries count, and among live entries naming one pane only the newest `updatedAt` may
  receive prompts. `nameSource: "derived"` names such as `spike-project-ee` are placeholders
  (titles skip them).

**Decision.** `waiting` → `needs_input` and `promptBlock: awaiting_input`; `busy` and `idle`
sessions with a pane accept prompts (Claude Code queues a prompt typed while busy: verified, the
queued prompt ran after the running turn). Before typing, the bridge checks that the session's
process runs inside the target pane (`tmux display-message -p -t %N '#{pane_pid}'` + the /proc
parent chain) so a stale or foreign pane never receives keystrokes.

### Live checks

- **Items:** after `subscribe`, `item` events arrived within ~1 s of each transcript write: the
  user prompt, the pending tool, the tool update (same `seq`), the assistant reply.
- **Prompt:** `POST /api/sessions/<sid>/prompt` → `202`; `tmux send-keys -l` followed by a
  separate `Enter` submitted it (not treated as a pasted newline), and it ran. A second prompt
  sent while busy was queued and ran next. Multi-line Korean text arrived as one line
  (`다음 단어만 답해: 둘째` → reply `둘째`).
- **statusLine relay:** the wrapped command still printed its output; `usage` with 5h/7d
  (`resets_at` epoch seconds → ISO) reached the watch within 5 s of the session start, before
  the first prompt. `context_window.current_usage` is `null` until the first API call.
- **Uninstall:** `hooks uninstall` on the spike file gave a file identical to the pre-install one
  under `jq -S` and removed `statusline.sh`, `statusline.orig` and `hook-header`.
- **S12 (bridge stopped):** the http PermissionRequest hook failed silently (normal dialog), but
  http Notification/Stop hooks printed `Stop hook error: connect ECONNREFUSED 127.0.0.1:47871`
  plus a footer notice after every turn. **Decision:** Notification and Stop are installed as
  async `curl … || true` command hooks (token read from `hook-header`); retest: the `done` alert
  still arrives, and with the bridge stopped nothing is shown.
- **S13 (no original statusLine):** with the relay alone (it prints nothing), Claude Code keeps an
  empty row above the mode line where the status line would be. The relay is still needed for
  plan usage, so the row stays; the README mentions it.

## Phase 3 — Codex control (2026-09-29)

**Setup.** Codex CLI 0.159.0, `CODEX_HOME=~/.codex-wsl`, a managed daemon already running as
`codex app-server --remote-control --listen unix:// --managed-daemon`, control socket
`$CODEX_HOME/app-server-control/app-server-control.sock` (a symlink into
`/tmp/codex-daemon-<uid>/`). A throwaway directory with its own `.codex/config.toml` (hooks and
sub-agents off, so the user's global PreToolUse gate did not interfere) and an `AGENTS.md` asking
the model to run commands itself. The TUI ran in a dedicated tmux session as
`codex -a on-request -s read-only`, a spike client connected through `codex app-server proxy`.
Five short turns in total (model `gpt-6-astra`, effort low).

### Transport

- **The control socket speaks WebSocket, not newline-delimited JSON.** `codex app-server proxy
  --sock <path>` is a plain byte pipe between stdio and the socket; the first bytes must be an
  HTTP `Upgrade: websocket` request (answered `101`, with
  `x-codex-websocket-max-unfragmented-message-bytes: 16777216`), after which each JSON-RPC message
  is one WebSocket text frame. Raw JSON lines get no answer. No authentication beyond the
  socket's file permissions (0600).
- Messages omit `jsonrpc`; notifications carry an extra `emittedAtMs`. Server→client request ids
  are small integers counted per connection (0, 1, …).
- With no socket, `proxy` exits 1 at once (`failed to connect to socket … No such file or
  directory`); it never starts a daemon.
- All method and notification names in the plan exist in 0.159.0
  (`codex app-server generate-json-schema`). Also present and used: `serverRequest/resolved`
  (`{threadId, requestId}`) and `thread/closed`.

### S4 — the TUI and the daemon

- **The TUI uses the daemon only without config overrides.** Started with `-c …` or
  `--disable …` it silently runs its own in-process app-server (the binary's reason string:
  "Running without the shared background server: command-line configuration overrides (-c,
  --enable, --disable, or --search)"; the same applies to `--profile`, `--oss`, `--strict-config`,
  `--no-daemon`, …). Its thread then showed as `notLoaded` in `thread/list` and the TUI had no
  connection to the socket. `-a` and `-s` do not prevent daemon mode. In daemon mode the footer
  shows "← for agents".
- **(A) yes.** A daemon-mode TUI creates its thread at startup: every client got `thread/started`
  (status `idle`, `source: "vscode"`, `originator: "codex_chatgpt_android_remote"`), and
  `thread/loaded/list` returned its id. `thread/status/changed`, `thread/started`,
  `thread/closed` and `thread/name/updated` reach clients that never subscribed.
  Title generation runs as a separate `ephemeral: true` thread (ignored by the bridge).
- `thread/resume` of the loaded thread **before its first turn** failed with `-32600 "no rollout
  found for thread id …"` (nothing was loaded). After the first turn it rejoined the running
  thread (`excludeTurns: true`, no overrides) and returned its metadata.
- **(B) yes, both get the approval.** After the rejoin, `item/commandExecution/requestApproval`
  (id 0) reached the bridge client at the same time as the TUI showed its dialog, and the thread
  status became `active` with `activeFlags: ["waitingOnApproval"]`.
  - Bridge answers first (`{"decision":"accept"}`): the TUI's dialog closed, the command ran, all
    clients got `serverRequest/resolved {requestId: 0}`.
  - TUI answers first (`y`): `serverRequest/resolved {requestId: 1}` arrived within ~1 ms; a
    **late** bridge answer (`cancel`, sent 0.1 s later) was ignored — no error response, the
    command ran, the turn completed normally.
  - The request carried `availableDecisions: ["accept", {"acceptWithExecpolicyAmendment": …},
    "cancel"]` — no `acceptForSession` and no `decline` for this escalation request.
- **(C) yes.** `turn/start {threadId, input: [{type: "text", text}]}` from the bridge returned the
  new turn at once; the TUI showed the prompt as a user message and streamed the reply.
- **(D) yes.** `thread/tokenUsage/updated` (per turn, `{total, last, modelContextWindow}`) and
  `account/rateLimits/updated` (after each model response) reached the subscribed client.
  `account/rateLimits/read` returned only a `primary` window (10080 min) for this plan
  (`secondary: null`), plus other limit ids under `rateLimitsByLimitId`.
- Live item ids (`item/started`, `item/completed`) equal the ids in the rollout's
  `item_completed` records, so both sources merge into one item.
- The daemon-written rollout records `task_started`/`task_complete` like the TUI does.

**Decisions.** Branch **A**: approvals, `requestUserInput` questions and prompts are all
supported for threads loaded in the daemon.
1. Transport: spawn `codex app-server proxy --sock <socket>` and run a WebSocket client over its
   stdio (the `ws` package with a stdio-backed connection). The socket's existence is checked
   before spawning, so a machine without the daemon causes no process churn.
2. The bridge rejoins (`thread/resume`) only ids reported by `thread/loaded/list`,
   `thread/started` or a non-`notLoaded` status, retries when the rollout does not exist yet, and
   never resumes anything else.
3. Watch options follow `availableDecisions` when present: `allow` → `accept`, `always` →
   `acceptForSession` (or `acceptWithExecpolicyAmendment` with the proposed amendment when that
   is what is offered), `deny` → `decline` (or `cancel` when `decline` is not offered).
   `defer` is not offered: the TUI's dialog is up anyway and there is no "no decision" answer.
4. No timeout. `serverRequest/resolved`, completion of the item or turn, or losing the connection
   resolves the watch's request as `by: "terminal"`; a late watch answer is harmless.
5. Only TUIs started without `-c/--enable/--disable/--search/--profile` can be controlled; others
   stay read-only (`unsupported`). The README says so.

### Live checks

Bridge built from this commit (`dist/cli.js run`, separate `XDG_CONFIG_HOME`, ports 47870/47871),
`scripts/fake-watch.ts` as the watch, the spike TUI from above.

- **Connect:** the banner showed `app-server connected`; the bridge rejoined exactly one thread,
  the one `thread/loaded/list` reported (2 bridge runs, 2 `rejoined` log lines, both for that
  id; no other `thread/resume`).
- **Status:** the session went `idle` → `running` → `needs_input` / `awaiting_input` while the
  TUI's approval dialog was up, and back.
- **Approval:** the request reached the watch in the same millisecond as the pending tool item
  (`Shell`, options `allow`/`always`/`deny`, `always` described as the proposed rule
  `touch live-c.txt`). Answering `allow` from the watch: `resolved {by: "watch"}`, the TUI's
  dialog closed and the command ran (file created) 40 ms later. A second run confirmed the tool
  item turns from pending to done under the same `seq`.
- **Usage:** `GET /api/usage` returned the daemon's Codex window at once (`primary` 2 %,
  10080 min).
- **Prompt:** `POST …/prompt` → `202`; the TUI showed the prompt and the reply ("WRIST")
  2 s later; the watch got the user item once (same `seq` from the live notification and the
  rollout).
- After the TUI was killed, the daemon still listed the thread in `thread/loaded/list` — a
  loaded thread may have no terminal attached (README: limits).

## Codex rewind and daemon restart (2026-09-30)

**Setup.** Codex CLI 0.159.2, the user's own `CODEX_HOME=~/.codex-wsl`, a TUI in daemon mode
that had rewound a thread (`thread/revert`), and a bridge that had been started ~2.5 h before the
daemon (after a WSL restart, where `/tmp` — and with it the socket the control symlink points to —
is gone).

- **Rewind keeps the thread id and starts a new file.** The new rollout is
  `rollout-<time>-<thread id>_<segment id>.jsonl`; its `session_meta` carries the same `id` and
  `history_base: {thread_id, end_ordinal_exclusive, end_byte_offset}` naming the kept prefix of
  the earlier file (the offset is exactly the byte length of the kept lines; ordinals continue
  across the two files). The earlier file gets no further writes. The segment id is not a thread:
  `thread/loaded/list` and `session_index.jsonl` know only the thread id, `thread/read` of the
  segment id resolves by filename to the thread, and Codex's own `thread/list` shows the thread
  twice (both files). `thread/fork` is a different operation (new id, `forkedFromId`).
- The bridge's filename regex captured the **last** UUID, so the segment was listed as a second,
  uncontrollable session (`unsupported`: the daemon never loads that id) while the thread's real
  session pointed at the dead file. **Decision:** key rollouts by the first UUID, follow the
  newest file per thread, replay the `history_base` prefix chain before it (`JsonlHead`), and
  rebase an open transcript when the file changes; `thread/reverted` triggers a refresh.
- **The daemon socket appears late after a reboot.** Nothing starts the managed daemon at boot;
  the first daemon-mode `codex` does, and the control symlink's target in `/tmp` reappears then.
  The old client retried with a 1–30 s backoff and did reconnect, but the only connection-state
  text in the journal was the startup banner (`app-server not connected`). **Decision:** a fixed
  15 s retry plus an `fs.watch` on the control directory (the socket's inode identity decides,
  since the `/tmp` path is a stable hash), a log line on every state change, `detail` =
  `app-server reconnecting (...)` while retrying, and the old proxy child is killed before a new
  one is spawned.

## Claude Code plan-limit windows (2026-09-30)

**Setup.** Claude Code 2.1.285, the user's own sessions relaying their statusLine every 10 s. A
temporary, uncommitted log in the bridge service printed only the key names under `rate_limits`
(never values); the Claude Code binary was searched for the code that builds the statusLine JSON.

- **Live:** 18 reports in 3 minutes, every one `five_hour` and `seven_day`, each with
  `used_percentage` and `resets_at`.
- **Binary:** the statusLine builder writes only `five_hour`, `seven_day` and, behind a Claude
  gateway, `spend_limit` (`used_percentage`, `resets_at`, optional `used_usd`, `limit_usd`,
  `period`), and leaves out `rate_limits` when none is present. The statusLine schema Claude Code
  documents lists the same three.
- **Model-scoped weekly limits are not in the statusLine.** Claude Code calls the Fable weekly
  limit `seven_day_overage_included`; it reads it, with `seven_day_opus`, `seven_day_sonnet` and
  `seven_day_oauth_apps`, from the OAuth usage endpoint (`limits[]`, projected as
  `model_scoped[]` with `display_name`, `utilization`, `resets_at`), which feeds `/usage`. Other
  rate-limit types named in the binary: `seven_day_cowork`, `seven_day_omelette`.
- **Decision:** the bridge maps every `rate_limits` entry with a `used_percentage`
  (`seven_day_<model>` → `7d_<model>`, `spend_limit` → `spend`, with a `label`), so a window a later
  Claude Code adds to the statusLine reaches the watch without a bridge change. Until then the
  watch gets `5h` and `7d` (plus `spend` behind a gateway); a Fable window would need the OAuth
  usage endpoint as a second source, which the bridge does not read.
