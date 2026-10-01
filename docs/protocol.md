# Wristline protocol, apiVersion 1

The wire format between `wristline-bridge` and the Wristline watch app. The TypeScript types in
[`src/protocol.ts`](../src/protocol.ts) are the source of truth; example payloads for every
response and event live in [`protocol/v1/`](../protocol/v1) and ship in the npm package.

## Compatibility rules

- **Adding a field is compatible.** Clients ignore unknown keys (`Json { ignoreUnknownKeys = true }`).
- **Unknown WebSocket event `type`s are skipped.** Clients decode each message as a JSON object and
  branch on `type` themselves (no class-discriminator polymorphism, which throws on unknown types).
- **Removing a field or changing its meaning bumps `apiVersion`** and adds `protocol/v2/`. The bridge
  reports `apiVersion` in `GET /api/health`, in the pairing response and in the WebSocket
  `snapshot`; a client that does not support it shows an "incompatible" screen.
- A commit that changes the protocol updates this document and the fixtures
  (`UPDATE_FIXTURES=1 npm test`) in the same commit. The app mirrors the types in `Protocol.kt`
  ("mirrors wristline-bridge protocol v1") and decodes every fixture in its tests.
- There is no JSON Schema; the fixtures plus decode tests cover the same ground.
- **A `usage` event with empty `windows` removes the entry** with that `provider` and `account.id`
  ([`event-usage-removed.json`](../protocol/v1/event-usage-removed.json)). Earlier v1 bridges sent
  one only when an entry's last window had reset; bridges since also send one when the entry's
  account is no longer logged in (see Usage). A client drops the entry rather than keeping it with
  no windows.

## Transport and authentication

The bridge listens on two loopback ports:

| Port | Name | Exposed | Used by |
|---|---|---|---|
| 47770 | public API | through Tailscale Funnel (HTTPS) | the watch |
| 47771 | local API | never | the CLI, Claude Code hooks and statusLine |

Every public request except `POST /api/pair`, including the WebSocket upgrade, carries
`Authorization: Bearer <deviceToken>`. A missing or wrong token gets
`401` with `WWW-Authenticate: Bearer realm="wristline"` (the watch uses this to recognise a bridge
before pairing). More than 20 failed attempts in a minute (wrong tokens, wrong codes, and pairing
attempts while no window is open) lock the public listener for 60 s: requests without a valid
token (and all pairing attempts) then get `429` with `Retry-After`.

Request bodies are limited to 64 KiB (`413 payload_too_large`). Errors have the body
`{"error": <code>}` ([`error-401.json`](../protocol/v1/error-401.json)); codes:
`unauthorized`, `rate_limited`, `bad_request`, `not_found`, `payload_too_large`, `invalid_code`,
`already_resolved`, `internal`, `ask_unavailable`, and the prompt block codes below.

## Model

- **Session** — `id` is `<provider>:<nativeId>` (`claude-code` or `codex`). `title` may be empty
  (the watch shows a localised placeholder). `status` is `running`, `idle`, `needs_input` or
  `ended`; a session with an open request is always `needs_input`. Only live sessions (not
  `ended`) are listed and sent in `session` events: a session that ends is sent as
  `session_removed`. `promptBlock`, when present,
  says why a prompt would be refused: `not_live`, `no_tmux`, `awaiting_input`, `busy`,
  `unsupported`; a session with an open request reports `awaiting_input` unless a lasting reason
  applies. `context` is `{used, window}` in tokens. A further code, `unsafe_prefix`, is only
  returned by `POST …/prompt` (never as `promptBlock`): Claude Code prompts whose first
  non-space character is `!` would run as a shell command and are refused. Clients show unknown
  codes with a generic message. `account`, when present, is the account the session belongs to.
  `model`, when known, is the model's name for people and `effort` its reasoning effort (`low`,
  `medium`, `high`, `xhigh`, …; absent when unset or when the model has no effort levels). Claude
  Code: the statusLine's `model.display_name` and `effort.level` once it has reported, else the
  transcript's last assistant turn (`message.model` mapped to a name such as `Fable 5.1`, and
  `effort`). Codex: the model slug (e.g. `gpt-6-astra`) and effort the daemon reports for a thread
  it has loaded (`thread/read`, `thread/started`, `thread/settings/updated`), else the rollout's
  last `turn_context`. A change is sent as a `session` event like any other.
- **Account** — `id` is Claude Code's `oauthAccount.accountUuid` or Codex's `chatgpt_account_id`;
  `label` is a short name for people (a label set with `accounts add --label`, else the email,
  else the organization, else the first 8 characters of `id`) and is never empty. `estimated`
  (Claude Code only) marks an attribution inferred from the home's login timeline rather than
  known for certain. A missing `account` means a single or unknown account.
- **Item** — one entry of a conversation: `kind` is `user`, `assistant`, `tool` or `notice`.
  `seq` starts at 1 and orders items within a session; an updated item (e.g. a tool that finished)
  is sent again with the same `seq`. `text` is at most 4000 UTF-16 code units, `detail` (tool
  output) at most 600; longer text is cut with `…`. `pending` marks a tool still running, `error`
  a failed one.
- **PendingRequest** — something the agent waits on. `kind` is `permission` or `question`. A
  permission carries exactly one question with id `decision` whose option ids are drawn from
  `allow`, `always`, `deny` and `defer` ("answer on the PC"). The bridge sends ids; the watch
  localises the wording. Codex requests never offer `defer` (the terminal shows the same
  request, and whoever answers first wins) and have no timeout; they resolve `by: "terminal"`
  when answered in the terminal or when the agent stops waiting.
- **Answers** — `{ "<questionId>": ["<optionId>", ...] }`, every question answered, exactly one
  option for a question with `multi: false`.
- **Usage** — per provider and account: `windows[]` with `id`, optional `label`, `usedPercent`,
  optional `resetsAt` (ISO 8601) and `minutes`. Claude Code ids are `5h`, `7d`, `7d_<model>` for a
  model-scoped weekly limit (e.g. `7d_opus`), `spend` for a gateway spend limit, else the
  statusLine key, each with a `label` for people (`5h`, `7d`, `7d Opus`, `Spend`); Codex ids are
  `primary`/`secondary`, without `label`. A watch shows `label`, else `id`.
  A usage entry is identified by `provider` plus `account.id` (empty when `account` is absent); a
  `usage` event replaces the entry with the same key, unless its `updatedAt` is older than the
  entry's (a stale snapshot). Once a provider reports a labelled entry, the bridge drops that
  provider's unlabelled one (a watch sees it go on its next `snapshot`) and ignores later unlabelled
  reports of that provider.
  The bridge merges the windows of an entry. Two values of one window `id` are the same window
  when their `resetsAt` are at most 5 minutes apart or either lacks one (Codex servers jitter
  `resets_at` by about a second between reports). When both have a `resetsAt`, usage never
  decreases within a window, so the higher `usedPercent` is kept, with the later `resetsAt` (every
  Claude Code process repeats the limits of its own last API call, so an idle one reports old
  numbers); when either lacks one (Codex sends none for some limits), nothing tells an old report
  from a reset, so the newer report's `usedPercent` is kept, even when lower, with the known
  `resetsAt`. A merged window keeps the optional fields (`label`, `minutes`) either value carries.
  `resetsAt` further apart are two windows, and the one with the later `resetsAt` is kept. Windows
  whose `resetsAt` has passed are dropped before merging. A window is removed only when its
  `resetsAt` has passed (or the entry is dropped), never because one report omitted it (a Claude
  Code statusLine report carries only the limits it happens to name). `GET /api/usage` and the
  `snapshot` always return this merged state; `usage` events are sent at once when an entry first
  appears and then at most once per minute per entry, with the merged state at the time of sending
  (windows merely listed in another order are no change). An event with empty `windows` removes the
  entry: it is sent when a report shows that the entry's last window has reset, and when its account
  is no longer logged in (below); the entry is then absent from `GET /api/usage` and later
  snapshots. The windows a provider reported before it named its account belong to the first
  labelled entry. The bridge sends no event on the passing of a `resetsAt` alone: a watch showing a
  window past its `resetsAt` shows stale numbers until the next report or `snapshot`.
  Only accounts logged in now are sent. An entry with an `account` is in `GET /api/usage`, the
  `snapshot` and `usage` events only while that account is the current login of one of its
  provider's homes (Claude Code: `oauthAccount` of the home's `.claude.json`; Codex: the ChatGPT
  login in the home's `auth.json`), so several homes can show several accounts; an entry without
  `account` is always sent. The numbers of other accounts (a Claude Code process still running under
  an earlier login, Codex rollouts of threads of another account) are kept but not sent. When a
  home's login changes or it logs out, the bridge sends at once, outside the once-a-minute limit, an
  event with empty `windows` for each entry no longer current, then the kept entry of the account
  now logged in, if it has one; a change held back for a removed entry is not sent.

- **Ask** — a Quick Ask (see below): `id` (`ask-<uuid>`), `provider`, `threadId` (the id of the
  first ask of the conversation it belongs to; its own id for a first ask), `question` (the
  watch's text, trimmed), `status` (`running`, `done`, `error`), `createdAt`; when `done`, `answer` (at
  most 4000 code units) and `model` when known (Claude Code: the model's name for people, e.g.
  `Haiku 4.5`; Codex: the bridge's configured `codexModel`, absent when unset); when `done` or
  `error`, `durationMs` (CLI start to exit); when `error`, `error`: `timeout`, `cancelled`,
  `exit_<code>`, `bad_output` (the CLI's output could not be read), or a short message from the
  CLI (e.g. Claude Code's result `subtype` such as `error_max_turns`). Clients show unknown
  codes with a generic message.

- **Alert** — a session finished or waits for input: `id` (uuid), `at` (ISO 8601), `sessionId`,
  `alert` (`needs_input` or `done`), `text?`, `title?` (see the `alert` event). Sent as it happens
  and replayed in the `snapshot` (see "Missed alerts").

All timestamps are ISO 8601 in UTC.

## REST endpoints (public)

| Method and path | Success | Errors | Fixture |
|---|---|---|---|
| `POST /api/pair` `{code, deviceName}` | `200 {token, deviceId, bridge}` | `400`, `401 invalid_code`, `404` (no pairing window), `429` | `pair.json` |
| `GET /api/health` | `200 {name, version, apiVersion, providers[]}`; each provider `{id, status: ok\|not_found, version?, detail?}` (`detail`: English diagnostic text, e.g. the Codex app-server connection) | `401` | `health.json` |
| `DELETE /api/device` | `204` (revokes the calling device) | `401` | |
| `GET /api/sessions` | `200 {sessions}`: live sessions only (not `ended`), sorted needs_input, running, then most recent | `401` | `sessions.json` |
| `GET /api/sessions/:sid/items?before=&limit=40&kinds=` | `200 {items, hasMore}`: the `limit` (max 200) newest items with `seq < before`, only of `kinds` when given; `hasMore`: an older such item exists | `400` (also for an unknown kind), `404` | `items.json`, `items-filtered.json` |
| `POST /api/sessions/:sid/prompt` `{text}` | `202 {}` | `400`, `404`, `409 {error: PromptBlock}`, `413` (text over 4000) | `error-409-prompt-blocked.json`, `error-409-unsafe-prefix.json` |
| `GET /api/requests` | `200 {requests}` | `401` | `requests.json` |
| `POST /api/requests/:rid` `{answers}` | `200 {}` | `400` (invalid answers), `409 already_resolved` | `error-409-already-resolved.json` |
| `GET /api/usage` | `200 {usage}` | `401` | `usage.json` |
| `POST /api/ask` `{provider, text, model?, threadId?}` | `202 {askId}` | `400` (`provider` not `claude-code`/`codex`, empty `text`, non-string `model`, a NUL character in `text` or `model`, non-string or empty `threadId`, a `threadId` of the other provider), `404` (`threadId` is not a thread of this device, or expired), `409 busy` (this device already has an ask running), `413` (text over 4000), `503 ask_unavailable` (that CLI is not installed on the PC) | `ask.json`, `ask-thread.json`, `ask-accepted.json`, `error-409-ask-busy.json`, `error-503-ask-unavailable.json` |
| `GET /api/asks` | `200 {asks}`: this device's asks of the last 24 h, at most 10, newest first, each with its `threadId` | `401` | `asks.json` |
| `DELETE /api/asks/:id` | `204` (a running ask is killed and ends with `error: cancelled`; a finished one is left as it is) | `404` (not this device's ask) | |
| `DELETE /api/asks/thread/:threadId` | `204`: the thread is forgotten, its asks leave `GET /api/asks`, and its CLI session is deleted (a running ask of it is cancelled first) | `404` (not this device's thread) | |
| `GET /api/ws` | WebSocket upgrade | `401`, `429` | |

`:sid` is URL-encoded. A session that ended and left the list still serves its items (and
`subscribe`) while the bridge tracks it: activity within `historyDays` (default 7) and among the
50 most recent per agent home. An open detail screen keeps working; a prompt to it gets
`409 not_live`. Only an unknown `:sid` gets `404`.

The first valid answer to a request wins; later answers and answers to unknown ids get
`409 already_resolved`.

`kinds` is an optional comma-separated list of item kinds without spaces, e.g.
`kinds=user,assistant,notice` to hide tool rows. Paging then counts matching items only: a page
holds up to `limit` of them, skipping other kinds, and `hasMore` says whether an older matching
item exists. `before` is still a `seq`, so the next page asks for `before=<smallest seq of this
page>`. Bridges that predate `kinds` ignore it (here and in `subscribe`) and send every kind.

### Quick Ask

`POST /api/ask` runs the agent CLI once, headless and without tools, for a short answer (Claude
Code: `claude -p --model haiku …`, Codex: `codex exec -s read-only …`; the exact commands are in
the README). `provider` may be omitted by older clients; the bridge then uses its configured
default. `model` overrides the bridge's configured model for that ask.

**Threads.** Every ask belongs to a thread, a conversation the CLI can continue. Without
`threadId` the ask starts a new thread whose id is the ask's own id; with the `threadId` of one
of this device's earlier asks it continues that conversation (Claude Code: `claude -p --resume`,
Codex: `codex exec resume`), so the follow-up can refer to what was said before. The watch groups
`GET /api/asks` by `threadId`. A thread expires 24 h after its last ask, or at once with `DELETE
/api/asks/thread/:threadId`; either way the bridge deletes the CLI's files for it (the Claude Code
transcript, or the Codex rollout via `codex delete`). A `threadId` the bridge does not know (expired,
another device's, or from before the last bridge restart of an ask that never started) gets `404`;
a thread of the other provider `400`. Thread ids survive a bridge restart; the asks themselves do not.

Ask threads are not sessions: nothing appears in `GET /api/sessions`, no `session` event is sent,
their items cannot be read, and Claude Code's hooks for them (PermissionRequest, Notification, Stop)
are recognised by the session id and answer "no decision" without opening a request or raising an
`alert`.

One ask runs per device at a time: a second `POST` while one runs gets `409 busy` (there is no
queue; cancel or wait). A run is killed after 90 s (`error: timeout`). Asks are kept in memory:
the newest 10 per device, none older than 24 h (older ones are dropped whenever an ask is added
or listed), and none after a bridge restart. `ask` events go to the asking device only; after
reconnecting, a watch refreshes `GET /api/asks` (the `snapshot` does not carry asks).

## WebSocket (`/api/ws`)

Server events (JSON text frames):

| `type` | Fields | When | Fixture |
|---|---|---|---|
| `snapshot` | `apiVersion, sessions, requests, usage, alerts` | right after connecting; `sessions` as in `GET /api/sessions` (live only); `alerts`: the last 10 alerts of the past 10 minutes, oldest first (see "Missed alerts") | `event-snapshot.json` |
| `session` | `session` | a live session was added or changed; at most one per session every 2 s | `event-session.json` |
| `session_removed` | `sessionId` | a session ended or left the list; may name a session the watch does not list (ignore it) | `event-session-removed.json` |
| `item` | `sessionId, item` | new or updated item, only for the subscribed session | `event-item.json` |
| `request` | `request` | the agent waits for an answer | `event-request-permission.json`, `event-request-question.json` |
| `resolved` | `requestId, by` | answered from the `watch`, in the `terminal`, or `timeout` | `event-resolved.json` |
| `usage` | `usage` | plan usage numbers or account changed; the entry's merged windows (see Usage); at most one per entry per minute after its first. Empty `windows`: remove the entry (its last window reset, or its account is no longer logged in; a login change is sent at once) | `event-usage.json`, `event-usage-removed.json` |
| `alert` | `id, at, sessionId, alert, text?, title?` | `needs_input` (text: short summary) or `done` (text: up to 500 characters of the answer; title: the prompt that started the turn or the session title); `id` (uuid) and `at` identify it when the `snapshot` replays it | `event-alert.json` |
| `ask` | `askId, provider, status, text?, model?, durationMs?, error?` | a Quick Ask of this device changed: `running` once right after the `202`, then `done` (`text` is the answer, `model` when known) or `error` once; sent to the asking device only | `event-ask-running.json`, `event-ask-done.json`, `event-ask-error.json` |

Client events:

| `type` | Fields | Effect | Fixture |
|---|---|---|---|
| `subscribe` | `sessionId: string \| null`, `kinds?: string[]` | receive `item` events for this session only (`null` stops); with `kinds`, only items of those kinds | `client-subscribe.json`, `client-subscribe-kinds.json` |
| `mode` | `mode: "foreground" \| "background"` | `background`: receive only the events listed under "Background mode"; `foreground` (the default of every new connection): everything | `client-mode.json` |

Unknown client events are ignored. After subscribing, fetch the newest page over REST; items that
arrive in between may be delivered twice and are identified by `seq`.

`kinds` filters every `item` event of the subscription, updates included: with
`["user", "assistant", "notice"]` a tool item is not sent when it appears nor when it finishes.
Absent or `null` means every kind; a kind the bridge does not know simply never matches; a
`subscribe` whose `kinds` is not an array of strings is ignored. Each `subscribe` replaces the
previous subscription and its filter.

The server pings every 30 s and drops a connection that missed a pong. Revoking a device closes its
connections with code `4001`. Reconnecting clients receive a fresh `snapshot` and must subscribe
again (and re-send their `mode`).

### Background mode

While the watch app is not on screen it only needs what should wake the wearer. After `{"type":
"mode", "mode": "background"}` the bridge sends this connection only:

- `request` and `resolved`,
- `alert`,
- `session` events whose `status` changed to or from `needs_input` (as last sent by the bridge;
  a session's first event counts as a change only when it is `needs_input`),
- `session_removed` for a session whose last `session` event was `needs_input` (it ended or left
  the list without a `session` event: the client would otherwise keep showing it as waiting).

Nothing else: no `usage` (removals included: `GET /api/usage` has the current entries), no
`item` (the subscription stays and resumes in the foreground), no other `session` churn or
`session_removed`, no `ask`. `{"type": "mode", "mode": "foreground"}` restores the full stream. A new connection starts in the foreground and always gets its
`snapshot`; after reconnecting, a client re-sends its `mode` (after its `subscribe`). A `mode`
with an unknown value is ignored.

### Missed alerts

A watch is often offline when a turn finishes. The bridge keeps the last 10 `alert`s (`done` and
`needs_input`, every device's) in memory for 10 minutes and puts them in every `snapshot` as
`alerts`, oldest first, exactly as they were sent (same `id`, `at`, `text`, `title`). A
reconnecting watch posts the notifications for the ones it has not shown and remembers their
`id`s: the same alert arrives once as an event and again in each later `snapshot` within those
10 minutes, and `id` is what makes it one alert. Older bridges send a `snapshot` without
`alerts` (treat it as empty). The buffer is gone after a bridge restart.

### Codex alerts

Codex alerts come from the app-server daemon, for threads it has loaded and the bridge has
rejoined. `turn/completed` with `status: "completed"` for a listed thread (not a Quick Ask or
sub-agent thread) raises `alert done` by the same rule as Claude Code's Stop hook (see
`POST /hooks/stop` below): `text` is up to 500 characters of the turn's last `agentMessage` (from
the turn's `item/completed` notifications; `turn.items` of the notification may be empty), and
nothing is raised when that answer, trimmed, is shorter than 20 characters or is "No response
requested.". `title` is the first 60 characters of the turn's first `userMessage` (typed in the
TUI or sent from the watch) on one line; without one, the session title, omitted when there is
none. Interrupted and failed turns raise nothing. A thread whose status gains `waitingOnApproval` raises `alert
needs_input` without `text` when, one second later, it still waits and no request of its session
is open (normally the approval itself is on the watch as a request); a sub-agent's counts for its
parent's session.

## Local API (not part of the watch protocol)

Port 47771 requires `Authorization: Bearer <hookToken>` from `config.json` (WSL2 forwards loopback
ports to Windows, where any browser page could otherwise post to it). Bodies up to 10 MiB.

- `POST /local/pair` `{}` → `{code, expiresAt}`: opens a 5-minute, single-use pairing window
  (closed after 5 wrong codes). `{"token": true, "name": "..."}` → `{token, deviceId}` instead.
- `GET /local/devices` → `{devices: [{id, name, createdAt}]}`; `DELETE /local/devices/:id` → `204`.
- `GET /local/presence` → `{watch, graceUntil?, since}`: `watch` is true only while at least one
  authenticated WebSocket is open right now and its watch answered a ping (sent every 30 s) or
  connected at most 35 s ago, so an alert raised then reaches a watch. (A watch that loses its
  network without closing keeps its socket open until a ping goes unanswered; it counts as gone
  35 s after its last pong.) After the last one closes, permission requests still go to the watch
  for 90 s (see below); during that grace `watch` is false and `graceUntil` (ISO) says when it
  ends. `since` is when `watch` last changed (ISO; the first connect of the run, the last
  disconnect, or when the last pong got too old), `null` before any watch connected. Other Stop
  hooks (e.g. a Slack notifier) stay quiet only while `watch` is true: an alert raised in the
  grace reaches no watch. `?codexThread=<thread id>` adds `covered`: true only while the Codex
  app-server daemon is connected and the bridge has rejoined that thread, the only case in which a
  finished turn of it raises a `done` alert (not for a TUI with its own embedded server, nor while
  the bridge reconnects to the daemon). A Codex `notify` script stays quiet only when `watch` and
  `covered` are both true.
- `POST /local/statusline` — the Claude Code statusLine JSON; every `rate_limits` entry with a
  `used_percentage` becomes a usage window (`five_hour` → `5h`, `seven_day` → `7d`,
  `seven_day_<model>` → `7d_<model>`, `spend_limit` → `spend`; `resets_at` epoch seconds → ISO),
  merged into the account's entry (a window the report omits keeps its last value until it resets),
  and `context_window` the session's context (`context_window_size`, and `current_usage` input
  tokens when present); `model.display_name`
  and `effort.level` become the session's `model` and `effort`. With several Claude
  Code homes, the report goes to the home whose `projects/` holds `transcript_path` (real paths
  compared), else to the home that lists `session_id`, else to the only home unless the path lies
  under some other `projects/` directory; otherwise it is dropped (logged once per session). The
  usage entry carries the home's `account`.
- `POST /hooks/permission-request` — Claude Code's PermissionRequest hook input. Answers an empty
  `200` at once when no watch is present (connected now or within 90 s); otherwise opens a
  request and answers when the watch does: `allow` → `{"hookSpecificOutput": {"hookEventName":
  "PermissionRequest", "decision": {"behavior": "allow"}}}`, `always` → the same plus
  `"updatedPermissions": <permission_suggestions>`, `deny` → `{"behavior": "deny", "message":
  "Denied from watch"}`, `defer`/timeout/answered in the terminal → empty `200`. For
  `AskUserQuestion` the request is a question and the answer is `{"behavior": "allow",
  "updatedInput": {...tool_input, "answers": {"<question>": "<label>[, <label>...]"}}}`.
- `POST /hooks/pre-tool-use` — answers `AskUserQuestion` the same way with `"permissionDecision":
  "allow"` + `updatedInput`; empty `200` for other tools. Not installed by default (see
  [spikes.md](spikes.md), S2).
- `POST /hooks/notification`, `POST /hooks/stop` — empty `200`; `permission_prompt` and
  `agent_needs_input` notifications raise `alert needs_input` when no request of that session is
  open. Stop raises `alert done` with up to 500 characters of `last_assistant_message`, unless the
  trimmed answer is shorter than 20 characters or is "No response requested." (nothing is raised
  then). Its `title` is the first 60 characters of the prompt when the turn was typed by the user
  (found in `transcript_path`: the newest non-tool_result user line, or the `origin` line of the
  same `promptId`, with `origin.kind` `human` and no `isMeta`; reminders, pasted content and
  command wrappers stripped); otherwise (task notification, peer message, scheduled task, local
  command, unreadable transcript) the session title, omitted when there is none.
