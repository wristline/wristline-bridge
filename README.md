<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/wristline-lockup-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/brand/wristline-lockup-light.svg">
    <img alt="Wristline" src="docs/brand/wristline-lockup-light.svg" width="360">
  </picture>
</p>

# Wristline Bridge

Wristline Bridge is the small local server that runs on your development machine and lets the
Wristline watch app browse and control AI coding-agent sessions (Claude Code, OpenAI Codex CLI,
and more providers later). It is the companion of the Wristline watch app:
https://github.com/wristline/wristline

It reads the session files the agents already write, so it works with sessions you start in any
terminal. It never sends your data anywhere except to the watches you pair with it.

## Status

Early development. For Claude Code the watch can follow sessions live, answer permission prompts
and questions, and send prompts (sessions running in tmux). For Codex it does the same through
Codex's background app-server (see [Codex](#codex)); without it, Codex sessions are read-only.
Context and plan usage are shown for both, and either CLI answers one-off questions from the
watch ([Quick Ask](#quick-ask)).

Verified with Claude Code 2.1.285 and Codex CLI 0.159.2 on Linux (WSL2). Requires Node.js 22 or
newer.

## Install

```sh
npx wristline-bridge setup     # try it without installing
npm i -g wristline-bridge      # recommended for everyday use
wristline-bridge setup
```

`setup` finds Claude Code (`$CLAUDE_CONFIG_DIR` or `~/.claude`) and Codex (`$CODEX_HOME` or
`~/.codex`), records the paths and tools it found in `~/.config/wristline/config.json` (so a
background service works without your shell profile), and proposes the bridge address from
Tailscale. It then offers the two installs below: the Claude Code hooks (it shows the exact
`settings.json` diff first) and the background service. Run it again after changing
`CODEX_HOME` or installing tools. `--yes` accepts everything without asking.

## Run

```sh
wristline-bridge run           # or just `wristline-bridge`
```

The bridge listens on two loopback ports:

- `127.0.0.1:47770` — the public API for the watch. Publish this one.
- `127.0.0.1:47771` — the local API for the CLI and agent hooks. Never publish it.

Use `--api-port`, `--hook-port`, `--claude-home` and `--codex-home` to override the defaults.

### Background service (systemd)

```sh
wristline-bridge service install --dry-run   # print the unit file and commands only
wristline-bridge service install             # write ~/.config/systemd/user/wristline-bridge.service, enable --now
wristline-bridge service uninstall
loginctl enable-linger "$USER"               # optional: keep it running while logged out, start at boot
```

The unit runs the current `node` binary on this package's `dist/cli.js` and restarts it on
failure (up to 5 times in 2 minutes; after that, `systemctl --user reset-failed wristline-bridge`
and start it again). Install the package globally first (`npm i -g wristline-bridge`): a copy in
the npx cache can disappear, so `service install` refuses one unless you pass `--force`, and it
warns when `node` comes from nvm, fnm or volta. Logs: `journalctl --user -u wristline-bridge -f`
(watch connects and disconnects, and each alert and request sent with the number of connections
it reached; ids only, never their text).

## Claude Code hooks

Claude Code does not write permission prompts or plan limits to disk, so answering from the watch
needs hooks. `wristline-bridge hooks install` shows the diff, asks, backs up
`~/.claude/settings.json` to `~/.config/wristline/backups/`, and then **adds** (never removes or
reorders your entries):

- `PermissionRequest`: an http hook to `http://127.0.0.1:47771/hooks/permission-request` with the
  local token in an `Authorization` header (the install makes the file private, mode 0600; tell
  us if you publish your settings as dotfiles). Its timeout is `permissionWaitSec + 10` seconds.
- `Notification` and `Stop`: asynchronous `curl … || true` commands that tell the bridge a session
  waits for you or finished. They never delay Claude Code and stay quiet while the bridge is
  stopped.
- `statusLine`: your command is replaced by `~/.config/wristline/statusline.sh` (your original is
  saved in `statusline.orig`; `padding` and `refreshInterval` are kept). The script sends the
  status JSON to the bridge in the background (plan usage 5h/7d and context size) and then runs
  your original command unchanged. If you had no status line, it prints nothing, but Claude Code
  still keeps an empty row for it. A report names only the limits Claude Code happens to carry at
  that moment, so the bridge merges them per account: a window it omits keeps its last value until
  its reset time passes. The watch gets usage updates at most once a minute per account.

Restart running Claude Code sessions to pick the hooks up. `wristline-bridge hooks uninstall`
removes exactly these entries, restores your status line and deletes the generated files; the
result is the same JSON as before the install. Both accept `--yes` and `--settings <file>` (for
another settings file, e.g. a project's `.claude/settings.json`).

How requests behave:

- **No watch connected** (monitoring off, and none connected in the last 90 s): the hook answers
  at once and Claude Code shows its terminal dialog exactly as without the bridge.
- **Watch connected:** the request appears on the watch *and* the terminal dialog appears as usual.
  Whichever answers first wins. Answering in the terminal clears it from the watch within ~2 s.
  "Answer on PC", or no answer within `permissionWaitSec` (default 590 s), leaves it to the
  terminal. "Always allow" applies Claude Code's own suggestion for that prompt.
- **Questions** (AskUserQuestion) work the same way; multi-select answers are supported. Free-text
  answers ("Type something") are only available in the terminal.

### Sending prompts from the watch

Prompts are typed into the session's terminal with `tmux send-keys`, so this works only for
Claude Code sessions **running inside tmux** (on the same tmux server as the bridge's user). The
bridge checks that the session really runs in that pane before typing. A session waiting on a
dialog refuses prompts (`awaiting_input`) until it is answered; a busy session queues them. A pane
left in tmux copy mode (scrolled back) refuses them too (`busy`) until you leave copy mode. So do a
session stopped with Ctrl-Z or sent to the background (its shell would run the text as a command)
and a window with `synchronize-panes` on (the text would reach every pane).

Prompts starting with `!` are refused (`unsafe_prefix`), because Claude Code would run them as a
shell command; `/` commands are allowed. Known limitation: the prompt is typed after whatever is
already in the session's input box. If you left half-typed text there, it becomes part of the
prompt; if you left the input in `!` (shell) mode, the prompt runs as a shell command. Clear the
input box before walking away.

## Quick Ask

The watch's "Ask" button sends a spoken question to the bridge, which runs the agent CLI on your
PC once, headless, and returns a short answer (about 80 words, in the language of the question).
A follow-up asked from the answer screen continues the same conversation (a *thread*), so "and
in French?" works. Nothing is added to the session list. `setup` records the `claude` binary in
`config.json` (`bins.claude`, next to `codex`); without it the watch gets `ask_unavailable`.

What runs, in an empty scratch directory (`~/.config/wristline/ask-cwd`, so no project
`CLAUDE.md`/`AGENTS.md` applies) with the question passed as an argument (no shell):

```sh
# first question of a thread
claude -p --output-format json --model haiku --max-turns 1 --tools "" --permission-prompts none \
  --strict-mcp-config --session-id <thread uuid> \
  --append-system-prompt "<answer briefly, in the user's language>" --safe-mode -- "<question>"
# follow-up: the same with --resume <thread uuid> instead of --session-id

codex exec --json -s read-only --skip-git-repo-check -C <scratch dir> [-m <codexModel>] -- "<instruction + question>"
codex exec resume <thread id> --json -c 'sandbox_mode="read-only"' --skip-git-repo-check [-m <codexModel>] -- "<instruction + question>"
```

- **No tools.** Claude Code runs with every tool disabled and permission prompts auto-denied;
  Codex runs in its read-only sandbox (`codex exec` cannot ask for approval; `exec resume` takes
  no `-s`, so the sandbox goes in as a config override). `--safe-mode` also leaves your hooks,
  MCP servers and CLAUDE.md out.
- **Temporary sessions.** Each thread is a CLI session of its own (a Claude Code transcript under
  `~/.claude/projects/-…-wristline-ask-cwd/`, or a Codex rollout; the Codex thread id is taken
  from `codex exec`'s `thread.started` line). The bridge never lists it, reads its items, opens a
  request or raises an alert for it (its hooks are recognised by the session id), and deletes it
  24 hours after the thread's last question or when the watch deletes the thread (Claude Code:
  the transcript and its sub-agent directory; Codex: `codex delete --force <id>`, or the rollout
  and `session_index.jsonl` line by hand when the CLI is missing). Threads are remembered in
  `~/.config/wristline/ask-threads.json` so a bridge restart neither lists nor forgets them.
- **Uses your plan.** Each question is one API turn on the account the CLI is logged into
  (the primary Claude Code home and `CODEX_HOME`). A Haiku answer cost about $0.03 of plan
  usage in our test; Codex sends about 15k input tokens (mostly cached).
- **Limits.** One question at a time per watch (`busy` otherwise), 90 s timeout, answers cut
  at 4000 characters, the last 10 questions kept in memory for 24 hours (or until the bridge
  restarts; a thread from before the restart can still be continued while its session exists).

`config.json` defaults, all optional:

```json
"ask": { "provider": "claude-code", "claudeModel": "haiku", "codexModel": "gpt-6-astra" }
```

`provider` is used only when a watch names none; the watch chooses per question. `claudeModel`
is any `--model` value Claude Code accepts (`haiku`, `sonnet`, a full model id). `codexModel`,
when set, is passed as `-m` and shown on the watch; otherwise Codex uses its own configured model
and the watch shows none.

## Codex

Codex sessions are always listed from `$CODEX_HOME/sessions` (read-only). Control goes through
the Codex **app-server daemon**, the shared background server that `codex` starts by default
(`daemon_auto_start`). The bridge connects to its control socket
(`$CODEX_HOME/app-server-control/app-server-control.sock`) through `codex app-server proxy`,
which needs no extra setup. `GET /api/health` (and the `run` banner) shows the connection in
the Codex provider's `detail`, and the log gets a line whenever it changes (`app-server
connected`, `app-server reconnecting (...)`). While the daemon is not running the bridge stays
read-only, looks again every 15 s, and connects at once when the daemon (re)creates its control
socket — e.g. after a reboot, where the socket appears only when the first `codex` starts.

For threads the daemon has loaded — a `codex` TUI in daemon mode, or other clients of the daemon:

- **Status** comes live from the daemon (running, idle, waiting for approval → `needs_input`).
- **Approvals** for commands, file changes and extra permissions, and **questions**
  (`request_user_input` with choices), appear on the watch *and* in the terminal; whichever
  answers first wins, and an answer in the terminal clears it from the watch at once. "Always
  allow" uses Codex's session approval, or the proposed command rule when that is what Codex
  offers. There is no "answer on PC" and no timeout: Codex waits until someone answers.
- **Prompts** from the watch start a turn (`turn/start`) and show in the TUI like typed ones.
  Refused with `busy` while a turn runs and `awaiting_input` while an approval is open.
- **Plan usage** (`primary`/`secondary` windows) comes from the daemon; without it, from the
  newest rollout.

Limits:

- A `codex` TUI started with `-c`, `--enable`, `--disable`, `--search`, `--profile`, `--oss` or
  `--no-daemon` runs its own embedded server instead of the daemon. Its session is shown and
  followed, but approvals and prompts stay in the terminal (`unsupported`).
- The bridge only rejoins threads the daemon already has loaded; it never loads (resumes) an
  old thread, which would open its rollout a second time.
- The daemon keeps a thread loaded after its TUI exits; prompts sent then run in the daemon
  without a terminal showing them.
- Free-text and secret questions are answered in the terminal only.

Rewinds (`thread/revert`, "rewind" in the TUI) keep the thread id but continue it in a new
rollout file (`rollout-<time>-<thread id>_<segment id>.jsonl`) whose `session_meta.history_base`
names the kept prefix of the earlier file. The bridge lists such a thread once, under its thread
id, from its newest file; the watch sees the kept history followed by the new turns, and prompts
and approvals keep working because the daemon knows the thread by that id. The same
`history_base` link on a thread with a new id (a fork) prepends the origin's kept history and,
until the fork is named, reuses the origin's title; the origin stays listed as its own thread.
Without a `history_base` link a rollout is a thread of its own.

### Codex notifications

When a turn of a thread the daemon has loaded finishes, the bridge sends the watch the same `done`
alert as for Claude Code: up to 500 characters of the turn's last answer, titled by your prompt
(or the thread title when the turn had none). Short answers (under 20 characters), "No response
requested.", interrupted turns, sub-agents and Quick Asks raise none. A thread waiting on an
approval that is not on the watch as a request raises `needs_input` instead. The watch shows
these only while it is connected; alerts of the last 10 minutes are replayed when it reconnects.
Sessions of a TUI with its own embedded server (see Limits) raise no alerts.

For when the watch is away, Codex's own `notify` program can post elsewhere (e.g. Slack). Codex
0.159 runs the command in `$CODEX_HOME/config.toml` (`notify = ["/abs/path/script"]`) after every
completed turn, without waiting for it, with one JSON argument:

```json
{"type": "agent-turn-complete", "thread-id": "…", "turn-id": "…", "cwd": "/work/api",
 "client": "…", "input-messages": ["your prompt"], "last-assistant-message": "…"}
```

(`client` may be absent, `last-assistant-message` `null` and `input-messages` empty.) To avoid a second notification, such a script should stay quiet while
`GET /local/presence?codexThread=<thread-id>` answers both `"watch": true` and `"covered": true`
(`covered` is false for a thread the bridge raises no alert for, such as an embedded-server TUI's;
see the protocol document; it needs the local token from `~/.config/wristline/hook-header`), and skip Quick Ask threads (a `sessionId` in
`~/.config/wristline/ask-threads.json`, or `cwd` = `~/.config/wristline/ask-cwd`) and sub-agent
threads (`source.subagent` in the `session_meta` line that starts the thread's rollout).

To turn them off: on the watch, switch off Wristline's **Task updates** notifications (`done`;
`needs_input` uses **Requests**). For the `notify` script, remove the `notify` line from
`config.toml`. A change reaches Codex sessions started afterwards; running sessions, and the
daemon (`codex app-server daemon restart`), may keep the old setting until they restart.

## Accounts

The bridge can follow several Claude Code and Codex accounts at once. Each account lives in its
own agent home (the directory Claude Code takes from `CLAUDE_CONFIG_DIR` and Codex from
`CODEX_HOME`), and the bridge runs one provider per home:

```sh
wristline-bridge accounts add --claude-home ~/.claude-school --label school
wristline-bridge accounts add --codex-home ~/.codex-school --label school
wristline-bridge accounts                                   # homes, logins and labels
wristline-bridge accounts remove --claude-home ~/.claude-school
```

`add` creates the directory (mode 0700) if needed, records it in `config.json` and prints the
exact next steps: log in there (`CLAUDE_CONFIG_DIR=$HOME/.claude-school claude auth login`), an
alias for your shell profile (`alias claude-school='CLAUDE_CONFIG_DIR=$HOME/.claude-school claude'`;
the bridge never edits your profile), then `hooks install` and a bridge restart. `--label` gives
the account a short name (up to 12 characters) shown on the watch instead of its email; if the
home was not logged in yet, run the same `add` again afterwards. `setup` also proposes homes it
finds (`$CLAUDE_CONFIG_DIR`, `$CODEX_HOME`, `~/.claude*`, `~/.codex*`) and asks about each one;
with `--yes` (or without a terminal) it only lists them with the `accounts add` line to run, so a
backup kept next to your home is never enrolled unasked. Each Claude Code home has its own
`settings.json`, `CLAUDE.md`, memory and plugins; copy what you need, but never `projects/`,
`sessions/`, `.claude.json` or `.credentials.json`: they hold the first home's transcripts, live
sessions and login, and a copy would list every session twice. A symlink to a registered home
counts as the same home. `remove` also forgets the home's login timeline (`claudeLogins`);
`labels` and `codexAccounts` are keyed by account id, shared between homes, and stay.

`hooks install` goes through every registered Claude Code home and gives each its own relay
script (`~/.config/wristline/statusline-<home>.sh`, e.g. `statusline--home-u--claude-school.sh`),
so every home's status line reaches the bridge. A `settings.json` copied from another home is
recognised: its relay entry is replaced rather than saved as your original status line command
(set that again with `/statusline` in the new home if you want one).

Sessions and plan usage then carry `account` (id and label). For Codex the attribution is exact
(rollouts record the creating account, the daemon reports whose limits it sends). For Claude Code
the bridge keeps a timeline of which account each home was logged into (`claudeLogins` in
`config.json`; ids and emails only) and attributes a session to the login in effect at its last
activity; a session whose status line the bridge has seen since its process started is attributed
for certain. Anything else is marked `estimated` (shown with `~` on the watch), in particular after
you switch accounts inside one home with `/login`: that works, but stays an estimate and shares one
usage entry per login. For exact, concurrent use, give each account its own home. The watch shows
plan usage only for the account each home is logged into now; an earlier login's numbers are kept
and come back when a home logs into that account again.

## Reach it from the watch: Tailscale Funnel

The watch talks to the bridge over HTTPS. The simplest way without extra apps on the watch is
[Tailscale Funnel](https://tailscale.com/kb/1223/funnel), which gives your machine a public
`https://<machine>.<tailnet>.ts.net` address:

```sh
tailscale funnel --bg 47770
tailscale funnel status
```

Funnel makes the address reachable from the internet (the name also appears in public certificate
logs). Everything behind it requires a paired device token; see the security model below.

**WSL2:** use the Tailscale client installed on Windows; you do not need Tailscale inside WSL.
With WSL2's default NAT networking, Windows forwards `localhost:47770` into WSL, so the Windows
Funnel reaches the bridge:

```sh
"/mnt/c/Program Files/Tailscale/tailscale.exe" funnel --bg 47770
```

Forwarding only works while the WSL VM is running; keep a WSL process alive (for example a
logon task running `wsl.exe --exec /bin/sleep infinity`) if you close all terminals.

## Pair a watch

With the bridge running:

```sh
wristline-bridge pair
```

prints a 6-digit code (valid for 5 minutes, single use). Enter the bridge address and the code on
the watch. For manual setup, `wristline-bridge pair --token --name "My watch"` prints a long token
to type in instead.

```sh
wristline-bridge devices                 # list paired watches
wristline-bridge devices --revoke <id>   # revoke one; its connections close immediately
```

## Security model

- Only paired devices can use the public API. Each device has its own random 256-bit token; the
  bridge stores only its SHA-256 hash and compares hashes in constant time.
- Pairing codes come from a cryptographic RNG, expire after 5 minutes, work once, and are
  discarded after 5 wrong attempts. More than 20 failed authentications per minute (pairing
  attempts while no window is open count too) lock the public API for 60 s (`429`). Paired
  watches keep working; if someone keeps the lock up while you want to pair, use
  `wristline-bridge pair --token`, which goes through the local port only.
- The local port requires a separate token from `config.json`, because WSL2 also forwards it to
  Windows where a web page could otherwise reach it. It is never meant to be published.
- `~/.config/wristline/` is created with mode 0700 and `config.json` with 0600; `hooks install`
  sets the settings file it writes the local token into to 0600.
- The bridge reads agent files; it never opens Claude Code's `~/.claude/sessions/*.key` or
  `.credentials.json` files. For accounts it reads only `oauthAccount` (id, email, organization)
  from `.claude.json`, and only the `email` and `chatgpt_account_id` claims of the id_token in
  Codex's `auth.json`; token values are never stored, logged or sent anywhere.
- Nothing is sent to the Wristline developers. There is no telemetry.

## Development

```sh
npm install
npm run dev          # node --watch src/cli.ts run (Node's TypeScript type stripping)
npm test             # node --test; synthetic fixtures only
npm run typecheck    # includes tests and scripts
npm run build        # tsc -> dist/
node scripts/fake-watch.ts --url http://127.0.0.1:47770 --code 123456
```

While the watch app is off screen it switches the connection to background mode and hears only
requests, alerts and sessions entering or leaving `needs_input` (no usage, items or list churn);
see "Background mode" in the protocol document.

`scripts/fake-watch.ts` behaves like the watch: it prints events and reads `subscribe <sid>`,
`answer <rid> <optionIds,...> [...]` (one argument per question), `prompt <sid> <text>` from stdin.

The wire protocol is specified in [docs/protocol.md](docs/protocol.md); example payloads are in
`protocol/v1/` and ship in the npm package. After changing `src/protocol.ts`, run
`UPDATE_FIXTURES=1 npm test` and commit the fixtures together with the change.

## License

MIT
