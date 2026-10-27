import type { Register } from 'claude-code';

// `wristline-bridge hooks install` copies this mod into the bridge's config directory, beside the
// generated hook.sh, which posts its stdin to the bridge's local listener with the hook token.
export const register: Register = (on) => {
  on('prompt.suggest', { origin: { kind: 'suggestion' } }, async ($, e, next) => {
    // Shown in the terminal as before; the result says whether it is.
    const result = await next(e);
    const root = $.plugin.root;
    const relay = `${root.slice(0, root.lastIndexOf('/'))}/hook.sh`;
    const sessionId = await $.session.id();
    await $.process
      .run([relay, 'prompt-suggestion'], {
        stdin: JSON.stringify({ session_id: sessionId, text: e.text, shown: result.isShown }),
        timeoutMs: 5000,
      })
      .catch(() => undefined);
    return result;
  });
};
