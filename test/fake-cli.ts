// Stands in for `claude` and `codex` in tests: `node test/fake-cli.ts claude|codex <args...>`.
// Records its argv in $FAKE_ARGV_FILE and its pid in $FAKE_PID_FILE, then behaves per $FAKE_MODE:
// `ok` prints the output recorded from the real CLIs (Claude Code 2.1.285, codex-cli 0.159.2),
// `sleep` waits for a signal, `late` waits for SIGTERM and only then prints its `thread.started`
// (codex; a CLI flushing its output while it shuts down), `fail` reports a failed run, `garbage`
// prints something else. `codex delete` only records its argv and exits 0. The pid file is
// written last, once the mode's handlers are in place.
import { writeFileSync } from 'node:fs';

const kind = process.argv[2];
const args = process.argv.slice(3);
if (process.env.FAKE_ARGV_FILE) writeFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(args));
const sessionFlag = args.includes('--session-id') ? '--session-id' : '--resume';
const sessionId = args[args.indexOf(sessionFlag) + 1] ?? 'd1ffcf59-1253-446e-81e1-7444697bafe3';
if (kind === 'codex' && args[0] === 'delete') process.exit(0);

const claudeOk = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'OK',
  session_id: sessionId,
  num_turns: 1,
  stop_reason: 'end_turn',
  terminal_reason: 'completed',
  duration_ms: 1389,
  duration_api_ms: 1311,
  ttft_ms: 1337,
  total_cost_usd: 0.026572,
  usage: { input_tokens: 10, cache_creation_input_tokens: 13096, cache_read_input_tokens: 0, output_tokens: 74, output_tokens_details: { thinking_tokens: 68 }, service_tier: 'standard' },
  modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 10, outputTokens: 74, costUSD: 0.026572, contextWindow: 200000, canonicalModel: 'claude-haiku-4-5', provider: 'firstParty' } },
  permission_denials: [],
  api_error_status: null,
  uuid: '76690287-f01b-4186-95fd-ba687d425e2a',
};
const codexOk = [
  { type: 'thread.started', thread_id: '01a0f1f1-b81c-72c0-b5d8-3ac445edb941' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'Thinking about it.' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Draft' } },
  { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'OK' } },
  { type: 'turn.completed', usage: { input_tokens: 15377, cached_input_tokens: 7168, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } },
];

switch (process.env.FAKE_MODE) {
  case 'sleep':
    setInterval(() => {}, 1000);
    break;
  case 'late':
    setInterval(() => {}, 1000);
    process.on('SIGTERM', () => {
      if (kind === 'codex') console.log(JSON.stringify(codexOk[0]));
      process.exit(0);
    });
    break;
  case 'fail':
    if (kind === 'claude') {
      console.log(JSON.stringify({ ...claudeOk, subtype: 'error_during_execution', is_error: true, result: 'The request failed', modelUsage: {} }));
    } else {
      for (const e of [codexOk[0], codexOk[1], { type: 'turn.failed', error: { message: 'stream disconnected before completion' } }]) console.log(JSON.stringify(e));
    }
    console.error('something went wrong');
    process.exitCode = 1;
    break;
  case 'garbage':
    console.log('Welcome to the CLI!');
    break;
  default:
    if (kind === 'claude') console.log(JSON.stringify(claudeOk));
    else for (const e of codexOk) console.log(JSON.stringify(e));
}
if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
