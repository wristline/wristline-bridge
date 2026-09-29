// Which account a Codex home is logged into. `auth.json` holds tokens: only `auth_mode` and two
// claims of the id_token payload are read, and no token value leaves this module or gets logged.
// Verified against Codex CLI 0.159.0.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Account } from '../../protocol.ts';
import { isNotFound, isObject, parseJson, str } from '../../util.ts';

const AUTH_CLAIM = 'https://api.openai.com/auth';

/** The home's ChatGPT login, or undefined when logged out, using an API key, or unreadable. */
export async function readCodexLogin(home: string): Promise<Account | undefined> {
  let text: string;
  try {
    text = await readFile(join(home, 'auth.json'), 'utf8');
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
  const auth = parseJson(text);
  if (!auth || auth.auth_mode === 'apikey') return undefined;
  const idToken = isObject(auth.tokens) ? str(auth.tokens.id_token) : undefined;
  return idToken ? jwtClaims(idToken) : undefined;
}

/** Decodes the payload segment only (no signature check) and keeps just the account id and email. */
function jwtClaims(idToken: string): Account | undefined {
  const payload = idToken.split('.')[1];
  const claims = payload ? parseJson(Buffer.from(payload, 'base64url').toString('utf8')) : undefined;
  const auth = claims && isObject(claims[AUTH_CLAIM]) ? claims[AUTH_CLAIM] : undefined;
  const id = str(auth?.chatgpt_account_id);
  if (!id) return undefined;
  return { id, label: str(claims?.email) || id.slice(0, 8) };
}
