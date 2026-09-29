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
before pairing). More than 20 failed attempts in a minute lock the public listener for 60 s:
requests without a valid token (and all pairing attempts) then get `429` with `Retry-After`.

Request bodies are limited to 64 KiB (`413 payload_too_large`). Errors have the body
`{"error": <code>}` ([`error-401.json`](../protocol/v1/error-401.json)); codes:
`unauthorized`, `rate_limited`, `bad_request`, `not_found`, `payload_too_large`, `invalid_code`,
`already_resolved`, `internal`, and the prompt block codes below.

## Model

- **Session** — `id` is `<provider>:<nativeId>` (`claude-code` or `codex`). `title` may be empty
  (the watch shows a localised placeholder). `status` is `running`, `idle`, `needs_input` or
  `ended`; a session with an open request is always `needs_input`. `promptBlock`, when present,
  says why a prompt would be refused: `not_live`, `no_tmux`, `awaiting_input`, `busy`,
  `unsupported`; a session with an open request reports `awaiting_input` unless a lasting reason
  applies. `context` is `{used, window}` in tokens.
- **Item** — one entry of a conversation: `kind` is `user`, `assistant`, `tool` or `notice`.
  `seq` starts at 1 and orders items within a session; an updated item (e.g. a tool that finished)
  is sent again with the same `seq`. `text` is at most 4000 UTF-16 code units, `detail` (tool
  output) at most 600; longer text is cut with `…`. `pending` marks a tool still running, `error`
  a failed one.
- **PendingRequest** — something the agent waits on. `kind` is `permission` or `question`. A
  permission carries exactly one question with id `decision` whose option ids are drawn from
  `allow`, `always`, `deny` and `defer` ("answer on the PC"). The bridge sends ids; the watch
  localises the wording.
- **Answers** — `{ "<questionId>": ["<optionId>", ...] }`, every question answered, exactly one
  option for a question with `multi: false`.
- **Usage** — per provider: `windows[]` with `id` (`5h`/`7d` for Claude Code,
  `primary`/`secondary` for Codex), `usedPercent`, optional `resetsAt` (ISO 8601) and `minutes`.

All timestamps are ISO 8601 in UTC.

## REST endpoints (public)

| Method and path | Success | Errors | Fixture |
|---|---|---|---|
| `POST /api/pair` `{code, deviceName}` | `200 {token, deviceId, bridge}` | `400`, `401 invalid_code`, `404` (no pairing window), `429` | `pair.json` |
| `GET /api/health` | `200 {name, version, apiVersion, providers[]}` | `401` | `health.json` |
| `DELETE /api/device` | `204` (revokes the calling device) | `401` | |
| `GET /api/sessions` | `200 {sessions}` sorted needs_input, running, then most recent | `401` | `sessions.json` |
| `GET /api/sessions/:sid/items?before=&limit=40` | `200 {items, hasMore}`: the `limit` (max 200) newest items with `seq < before` | `400`, `404` | `items.json` |
| `POST /api/sessions/:sid/prompt` `{text}` | `202 {}` | `400`, `404`, `409 {error: PromptBlock}`, `413` (text over 4000) | `error-409-prompt-blocked.json` |
| `GET /api/requests` | `200 {requests}` | `401` | `requests.json` |
| `POST /api/requests/:rid` `{answers}` | `200 {}` | `400` (invalid answers), `409 already_resolved` | `error-409-already-resolved.json` |
| `GET /api/usage` | `200 {usage}` | `401` | `usage.json` |
| `GET /api/ws` | WebSocket upgrade | `401`, `429` | |

`:sid` is URL-encoded. The first valid answer to a request wins; later answers and answers to
unknown ids get `409 already_resolved`.

## WebSocket (`/api/ws`)

Server events (JSON text frames):

| `type` | Fields | When | Fixture |
|---|---|---|---|
| `snapshot` | `apiVersion, sessions, requests, usage` | right after connecting | `event-snapshot.json` |
| `session` | `session` | a session was added or changed; at most one per session every 2 s | `event-session.json` |
| `session_removed` | `sessionId` | a session left the list | `event-session-removed.json` |
| `item` | `sessionId, item` | new or updated item, only for the subscribed session | `event-item.json` |
| `request` | `request` | the agent waits for an answer | `event-request-permission.json`, `event-request-question.json` |
| `resolved` | `requestId, by` | answered from the `watch`, in the `terminal`, or `timeout` | `event-resolved.json` |
| `usage` | `usage` | plan usage numbers changed | `event-usage.json` |
| `alert` | `sessionId, alert, text?` | `needs_input` or `done` (text: short summary) | `event-alert.json` |

Client events:

| `type` | Fields | Effect | Fixture |
|---|---|---|---|
| `subscribe` | `sessionId: string \| null` | receive `item` events for this session only (`null` stops) | `client-subscribe.json` |

Unknown client events are ignored. After subscribing, fetch the newest page over REST; items that
arrive in between may be delivered twice and are identified by `seq`.

The server pings every 30 s and drops a connection that missed a pong. Revoking a device closes its
connections with code `4001`. Reconnecting clients receive a fresh `snapshot` and must subscribe
again.

## Local API (not part of the watch protocol)

Port 47771 requires `Authorization: Bearer <hookToken>` from `config.json` (WSL2 forwards loopback
ports to Windows, where any browser page could otherwise post to it). Bodies up to 10 MiB.

- `POST /local/pair` `{}` → `{code, expiresAt}`: opens a 5-minute, single-use pairing window
  (closed after 5 wrong codes). `{"token": true, "name": "..."}` → `{token, deviceId}` instead.
- `GET /local/devices` → `{devices: [{id, name, createdAt}]}`; `DELETE /local/devices/:id` → `204`.
- `POST /local/statusline` — the Claude Code statusLine JSON; `rate_limits` becomes `5h`/`7d`
  usage (`resets_at` epoch seconds → ISO) and `context_window` the session's context
  (`context_window_size`, and `current_usage` input tokens when present).
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
  open; Stop raises `alert done` with `last_assistant_message` (120 characters).
