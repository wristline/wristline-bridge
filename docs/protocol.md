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
`already_resolved`, `internal`, and the prompt block codes below.

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

## WebSocket (`/api/ws`)

Server events (JSON text frames):

| `type` | Fields | When | Fixture |
|---|---|---|---|
| `snapshot` | `apiVersion, sessions, requests, usage` | right after connecting; `sessions` as in `GET /api/sessions` (live only) | `event-snapshot.json` |
| `session` | `session` | a live session was added or changed; at most one per session every 2 s | `event-session.json` |
| `session_removed` | `sessionId` | a session ended or left the list; may name a session the watch does not list (ignore it) | `event-session-removed.json` |
| `item` | `sessionId, item` | new or updated item, only for the subscribed session | `event-item.json` |
| `request` | `request` | the agent waits for an answer | `event-request-permission.json`, `event-request-question.json` |
| `resolved` | `requestId, by` | answered from the `watch`, in the `terminal`, or `timeout` | `event-resolved.json` |
| `usage` | `usage` | plan usage numbers or account changed | `event-usage.json` |
| `alert` | `sessionId, alert, text?, title?` | `needs_input` (text: short summary) or `done` (text: up to 500 characters of the answer; title: the prompt that started the turn or the session title) | `event-alert.json` |

Client events:

| `type` | Fields | Effect | Fixture |
|---|---|---|---|
| `subscribe` | `sessionId: string \| null`, `kinds?: string[]` | receive `item` events for this session only (`null` stops); with `kinds`, only items of those kinds | `client-subscribe.json`, `client-subscribe-kinds.json` |

Unknown client events are ignored. After subscribing, fetch the newest page over REST; items that
arrive in between may be delivered twice and are identified by `seq`.

`kinds` filters every `item` event of the subscription, updates included: with
`["user", "assistant", "notice"]` a tool item is not sent when it appears nor when it finishes.
Absent or `null` means every kind; a kind the bridge does not know simply never matches; a
`subscribe` whose `kinds` is not an array of strings is ignored. Each `subscribe` replaces the
previous subscription and its filter.

The server pings every 30 s and drops a connection that missed a pong. Revoking a device closes its
connections with code `4001`. Reconnecting clients receive a fresh `snapshot` and must subscribe
again.

## Local API (not part of the watch protocol)

Port 47771 requires `Authorization: Bearer <hookToken>` from `config.json` (WSL2 forwards loopback
ports to Windows, where any browser page could otherwise post to it). Bodies up to 10 MiB.

- `POST /local/pair` `{}` → `{code, expiresAt}`: opens a 5-minute, single-use pairing window
  (closed after 5 wrong codes). `{"token": true, "name": "..."}` → `{token, deviceId}` instead.
- `GET /local/devices` → `{devices: [{id, name, createdAt}]}`; `DELETE /local/devices/:id` → `204`.
- `GET /local/presence` → `{watch, since}`: `watch` is true while a watch is connected or
  disconnected less than 90 s ago (the same rule that routes permission requests to the watch);
  `since` is when that state began (ISO; the first connect of the run, or the last disconnect),
  `null` before any watch connected. Other Stop hooks (e.g. a Slack notifier) use it to stay
  quiet while the watch shows the alert.
- `POST /local/statusline` — the Claude Code statusLine JSON; every `rate_limits` entry with a
  `used_percentage` becomes a usage window (`five_hour` → `5h`, `seven_day` → `7d`,
  `seven_day_<model>` → `7d_<model>`, `spend_limit` → `spend`; `resets_at` epoch seconds → ISO)
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
