import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Device } from './config.ts';

const CODE_TTL_MS = 5 * 60_000;
const CODE_MAX_ATTEMPTS = 5;
const FAILURE_WINDOW_MS = 60_000;
const FAILURE_LIMIT = 20;
const LOCKOUT_MS = 60_000;

export interface AuthOptions {
  devices: Device[];
  /** Persists the device list after pairing or revocation. */
  save(devices: Device[]): Promise<void>;
  now?: () => number;
}

export interface Issued {
  token: string;
  device: Device;
}

interface PairingWindow {
  code: string;
  expiresAt: number;
  attempts: number;
}

export function sha256(text: string): Buffer {
  return createHash('sha256').update(text).digest();
}

/** Constant-time string comparison via fixed-length digests. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export class Auth {
  #devices: Device[];
  readonly #save: AuthOptions['save'];
  readonly #now: () => number;
  #pairing: PairingWindow | undefined;
  #failures: number[] = [];
  #lockedUntil = 0;

  constructor(options: AuthOptions) {
    this.#devices = [...options.devices];
    this.#save = options.save;
    this.#now = options.now ?? Date.now;
  }

  devices(): Device[] {
    return [...this.#devices];
  }

  /** Returns the device a bearer token belongs to. Only token hashes are stored. */
  authenticate(token: string | undefined): Device | undefined {
    if (!token) return undefined;
    const digest = sha256(token);
    let match: Device | undefined;
    for (const device of this.#devices) {
      const stored = Buffer.from(device.tokenSha256, 'hex');
      if (stored.length === digest.length && timingSafeEqual(stored, digest)) match = device;
    }
    return match;
  }

  /** True while failed attempts exceeded 20 per minute; lasts 60 s. */
  locked(): boolean {
    return this.#now() < this.#lockedUntil;
  }

  retryAfterSec(): number {
    return Math.max(1, Math.ceil((this.#lockedUntil - this.#now()) / 1000));
  }

  recordFailure(): void {
    const now = this.#now();
    this.#failures = this.#failures.filter((t) => now - t < FAILURE_WINDOW_MS);
    this.#failures.push(now);
    if (this.#failures.length > FAILURE_LIMIT) {
      this.#lockedUntil = now + LOCKOUT_MS;
      this.#failures = [];
    }
  }

  /** Opens a pairing window with a fresh 6-digit code, replacing any previous one. */
  startPairing(): { code: string; expiresAt: string } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = this.#now() + CODE_TTL_MS;
    this.#pairing = { code, expiresAt, attempts: 0 };
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Redeems a pairing code; the window closes on success, expiry, or the 5th wrong code. */
  async pair(code: string, deviceName: string): Promise<Issued | 'no_window' | 'invalid_code'> {
    const window = this.#pairing;
    if (!window || this.#now() >= window.expiresAt) {
      this.#pairing = undefined;
      return 'no_window';
    }
    if (!safeEqual(code, window.code)) {
      this.recordFailure();
      if (++window.attempts >= CODE_MAX_ATTEMPTS) this.#pairing = undefined;
      return 'invalid_code';
    }
    this.#pairing = undefined;
    return this.issue(deviceName);
  }

  async issue(name: string): Promise<Issued> {
    const token = newToken();
    const device: Device = {
      id: randomBytes(4).toString('hex'),
      name,
      tokenSha256: sha256(token).toString('hex'),
      createdAt: new Date(this.#now()).toISOString(),
    };
    this.#devices = [...this.#devices, device];
    await this.#save(this.#devices);
    return { token, device };
  }

  async revoke(id: string): Promise<boolean> {
    const next = this.#devices.filter((d) => d.id !== id);
    if (next.length === this.#devices.length) return false;
    this.#devices = next;
    await this.#save(next);
    return true;
  }
}
