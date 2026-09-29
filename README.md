# Wristline Bridge

Wristline Bridge is the small local server that runs on your development machine and lets the
Wristline watch app browse and control AI coding-agent sessions (Claude Code, OpenAI Codex CLI,
and more providers later). It is the companion of the Wristline watch app:
https://github.com/wristline/wristline

It reads the session files the agents already write, so it works with sessions you start in any
terminal. It never sends your data anywhere except to the watches you pair with it.

## Status

Early development. For Claude Code the watch can follow sessions live, answer permission prompts
and questions, and send prompts (sessions running in tmux). Codex sessions are read-only for now.
Context and plan usage are shown for both.

Verified with Claude Code 2.1.284 and Codex CLI 0.159.0 on Linux (WSL2). Requires Node.js 22 or
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
failure. Install the package globally first (`npm i -g wristline-bridge`); a copy in the npx
cache can disappear. Logs: `journalctl --user -u wristline-bridge -f`.

## Claude Code hooks

Claude Code does not write permission prompts or plan limits to disk, so answering from the watch
needs hooks. `wristline-bridge hooks install` shows the diff, asks, backs up
`~/.claude/settings.json` to `~/.config/wristline/backups/`, and then **adds** (never removes or
reorders your entries):

- `PermissionRequest`: an http hook to `http://127.0.0.1:47771/hooks/permission-request` with the
  local token in an `Authorization` header (the file is otherwise private to you; tell us if you
  publish your settings as dotfiles). Its timeout is `permissionWaitSec + 10` seconds.
- `Notification` and `Stop`: asynchronous `curl … || true` commands that tell the bridge a session
  waits for you or finished. They never delay Claude Code and stay quiet while the bridge is
  stopped.
- `statusLine`: your command is replaced by `~/.config/wristline/statusline.sh` (your original is
  saved in `statusline.orig`; `padding` and `refreshInterval` are kept). The script sends the
  status JSON to the bridge in the background (plan usage 5h/7d and context size) and then runs
  your original command unchanged. If you had no status line, it prints nothing, but Claude Code
  still keeps an empty row for it.

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
dialog refuses prompts (`awaiting_input`) until it is answered; a busy session queues them.

Known limitation: the prompt is typed after whatever is already in the session's input box. If
you left half-typed text there, it becomes part of the prompt; if you left the input in `!`
(shell) mode, the prompt runs as a shell command. Clear the input box before walking away.

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
  discarded after 5 wrong attempts. More than 20 failed authentications per minute lock the
  public API for 60 s (`429`).
- The local port requires a separate token from `config.json`, because WSL2 also forwards it to
  Windows where a web page could otherwise reach it. It is never meant to be published.
- `~/.config/wristline/` is created with mode 0700 and `config.json` with 0600.
- The bridge reads agent files; it never opens Claude Code's `~/.claude/sessions/*.key` files.
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

`scripts/fake-watch.ts` behaves like the watch: it prints events and reads `subscribe <sid>`,
`answer <rid> <optionIds,...> [...]` (one argument per question), `prompt <sid> <text>` from stdin.

The wire protocol is specified in [docs/protocol.md](docs/protocol.md); example payloads are in
`protocol/v1/` and ship in the npm package. After changing `src/protocol.ts`, run
`UPDATE_FIXTURES=1 npm test` and commit the fixtures together with the change.

## License

MIT
