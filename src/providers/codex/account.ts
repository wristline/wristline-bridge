// Which account a Codex home is logged into. `auth.json` holds tokens: only `auth_mode` and two
// claims of the id_token payload are read, and no token value leaves this module or gets logged.
// Verified against Codex CLI 0.159.0.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Account } from '../../protocol.ts';
import { isNotFound, isObject, own, parseJson, printable, str } from '../../util.ts';
import type { CodexRpc } from './rpc.ts';

const AUTH_CLAIM = 'https://api.openai.com/auth';

/** The home's ChatGPT login, or undefined when logged out (no `auth.json`) or using an API key. Rejects when `auth.json` cannot be read or is not JSON. */
export async function readCodexLogin(home: string): Promise<Account | undefined> {
  return (await readAuth(home)) ?? undefined;
}

/**
 * What `auth.json` says: the ChatGPT login, undefined for an API key or a login without an account
 * id, null when there is no file (logged out, or the credentials are kept in the OS keyring).
 * Rejects when the file cannot be read or is not JSON: Codex rewrites it in place when it
 * refreshes tokens, so a read can catch it half-written.
 */
async function readAuth(home: string): Promise<Account | undefined | null> {
  const path = join(home, 'auth.json');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  const auth = parseJson(text);
  if (!auth) throw new Error(`${path} is not valid JSON`);
  if (auth.auth_mode === 'apikey') return undefined;
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
  return { id, label: printable(str(claims?.email) ?? '') || id.slice(0, 8) };
}

export interface AccountsOptions {
  /** Account id → email learned so far (`config.codexAccounts`). */
  accounts?: Record<string, string>;
  /** Called with the whole map whenever an email is learned. */
  saveAccounts?: (accounts: Record<string, string>) => Promise<void>;
  /** Account id → label chosen by the user (`config.labels`). */
  labels?: Record<string, string>;
}

/** Labels for the account ids rollouts and the daemon name, learned from the home's login and kept in the config. */
export class CodexAccounts {
  readonly #labels: Record<string, string>;
  readonly #save: ((accounts: Record<string, string>) => Promise<void>) | undefined;
  #accounts: Record<string, string>;
  /** mtime, ctime and size of `auth.json` as last read; it is re-read only when these change. */
  #authStat: string | undefined;
  #current: string | undefined | null = null;
  /** Whether `current` has been set by a read (or the first, failed one). */
  #read = false;

  constructor(options: AccountsOptions) {
    this.#labels = options.labels ?? {};
    this.#accounts = options.accounts ?? {};
    this.#save = options.saveAccounts;
  }

  account(id: string): Account {
    return { id, label: own(this.#labels, id) ?? own(this.#accounts, id) ?? id.slice(0, 8) };
  }

  /** Remembers an account's email so its threads keep their label after a restart. */
  learn(id: string, email: string): void {
    if (own(this.#accounts, id) === email) return;
    this.#accounts = { ...this.#accounts, [id]: email };
    this.#save?.(this.#accounts).catch((err: unknown) => console.error('wristline: codex: saving accounts failed:', err));
  }

  /**
   * The account id of the home's login as `auth.json` last named it: undefined when logged out or
   * using an API key, null when there is no file (or before the first read).
   */
  get current(): string | undefined | null {
    return this.#current;
  }

  /**
   * Learns the home's login from `auth.json` when the file changed; true when `current` was set: by
   * a read, or by a first read that failed (undefined: nothing vouches for an account then). A later
   * failed read (e.g. of the file half-written) keeps the previous login. Never rejects.
   */
  async poll(home: string): Promise<boolean> {
    const path = join(home, 'auth.json');
    let key = 'missing';
    try {
      const st = await stat(path);
      // ctime too: a chmod that makes the file readable changes neither its mtime nor its size.
      key = `${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
    } catch (err) {
      if (!isNotFound(err)) key = 'unreadable';
    }
    if (key === this.#authStat) return false;
    this.#authStat = key; // Set first: an unreadable or broken file is reported once, not every 2 s; its next change is read again.
    try {
      const login = await readAuth(home);
      this.#current = login === null ? null : login?.id;
      if (login) this.learn(login.id, login.label);
    } catch (err) {
      console.error(`wristline: codex: reading the login of ${home} failed:`, err instanceof Error ? err.message : err);
      if (this.#read) return false;
      this.#current = undefined;
    }
    this.#read = true;
    return true;
  }

  /**
   * Who the daemon is logged in as, with its full rate limits: `accountId` is null for a login
   * without one (API key); undefined when the limits could not be read.
   */
  async daemon(rpc: CodexRpc): Promise<{ accountId: string | null; rateLimits: unknown } | undefined> {
    // `account/read` only adds the email; a daemon without it still reports whose limits these are.
    const [read, limits] = await Promise.allSettled([rpc.request('account/read'), rpc.request('account/rateLimits/read')]);
    if (limits.status === 'rejected') {
      console.error('wristline: codex account/rateLimits/read failed:', limits.reason instanceof Error ? limits.reason.message : limits.reason);
      return undefined;
    }
    const response = isObject(limits.value) ? limits.value : {};
    const id = str(response.accountId);
    const email = read.status === 'fulfilled' && isObject(read.value) && isObject(read.value.account) ? printable(str(read.value.account.email) ?? '') : '';
    if (id && email) this.learn(id, email);
    return { accountId: id ?? null, rateLimits: response.rateLimits };
  }
}
