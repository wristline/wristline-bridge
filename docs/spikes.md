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
