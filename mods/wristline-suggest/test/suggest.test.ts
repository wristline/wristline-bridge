import { test, expect } from 'claude-code/testing';

test('the engine suggestion goes to hook.sh beside the mod, with session id, text and shown', async ($, on) => {
  const runs: { argv: readonly string[]; stdin?: string }[] = [];
  on('process.run', async (_$, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin });
    return { value: { exitCode: 0, stdout: '', stderr: '' } };
  });
  on('session.id', async () => ({ value: 'sess-1' }));
  on('prompt.suggest', async () => ({ isShown: true }));
  // origin is normally stamped by the engine; pass the engine's own kind explicitly
  const result = await $.prompt.suggest({ text: 'run the tests', origin: { kind: 'suggestion' } } as never);
  expect(result).toEqual({ isShown: true });
  expect(runs.length).toBe(1);
  // hook.sh in the folder that holds the mod: mods/ here, the bridge's config directory once installed.
  expect(runs[0].argv).toEqual([expect.stringMatching(/\/mods\/hook\.sh$/), 'prompt-suggestion']);
  expect(JSON.parse(runs[0].stdin ?? '{}')).toEqual({ session_id: 'sess-1', text: 'run the tests', shown: true });
});

test('a suggestion the box cannot show is still reported, as shown: false', async ($, on) => {
  const bodies: string[] = [];
  on('process.run', async (_$, e) => {
    bodies.push(e.init?.stdin ?? '');
    return { value: { exitCode: 0, stdout: '', stderr: '' } };
  });
  on('session.id', async () => ({ value: 'sess-1' }));
  on('prompt.suggest', async () => ({ isShown: false }));
  await $.prompt.suggest({ text: 'commit it', origin: { kind: 'suggestion' } } as never);
  expect(JSON.parse(bodies[0] ?? '{}').shown).toBe(false);
});

test('a failing relay does not change what the terminal shows', async ($, on) => {
  on('process.run', async () => {
    throw new Error('ENOENT');
  });
  on('session.id', async () => ({ value: 'sess-1' }));
  on('prompt.suggest', async () => ({ isShown: true }));
  expect(await $.prompt.suggest({ text: 'x', origin: { kind: 'suggestion' } } as never)).toEqual({ isShown: true });
});

test('a plugin-origin suggestion is not forwarded', async ($, on) => {
  let n = 0;
  on('process.run', async () => {
    n++;
    return { value: { exitCode: 0, stdout: '', stderr: '' } };
  });
  on('prompt.suggest', async () => ({ isShown: true }));
  await $.prompt.suggest({ text: 'from a plugin' });
  expect(n).toBe(0);
});
