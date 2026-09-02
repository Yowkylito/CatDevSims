/**
 * Secrets never stored in plaintext.
 * Linux/tests: file-backed AES-256-GCM stub (mode 0600).
 * macOS/Windows: use the OS keychain (see README). This module keeps the same API.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Keychain {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}

const MAGIC = "stw1";

function machineKey(dir: string): Buffer {
  const keyPath = join(dir, ".wrap");
  if (existsSync(keyPath)) {
    return readFileSync(keyPath);
  }
  mkdirSync(dir, { recursive: true });
  const raw = randomBytes(32);
  writeFileSync(keyPath, raw, { mode: 0o600 });
  try { chmodSync(keyPath, 0o600); } catch { /* ignore */ }
  return raw;
}

function enc(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [MAGIC, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

function dec(key: Buffer, packed: string): string {
  const parts = packed.split(".");
  if (parts.length !== 4 || parts[0] !== MAGIC) {
    throw new Error("keychain blob is not a steward ciphertext");
  }
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const ct = Buffer.from(parts[3], "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export class FileBackedKeychain implements Keychain {
  readonly dir: string;
  private readonly key: Buffer;
  private readonly storePath: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.key = machineKey(dir);
    this.storePath = join(dir, "store.bin");
  }

  private load(): Record<string, string> {
    if (!existsSync(this.storePath)) return {};
    const packed = readFileSync(this.storePath, "utf8");
    if (!packed) return {};
    return JSON.parse(dec(this.key, packed)) as Record<string, string>;
  }

  private save(map: Record<string, string>): void {
    const packed = enc(this.key, JSON.stringify(map));
    writeFileSync(this.storePath, packed, { mode: 0o600 });
    try { chmodSync(this.storePath, 0o600); } catch { /* ignore */ }
  }

  async get(account: string): Promise<string | null> {
    const map = this.load();
    return map[account] ?? null;
  }

  async set(account: string, secret: string): Promise<void> {
    const map = this.load();
    map[account] = secret;
    this.save(map);
  }

  async delete(account: string): Promise<void> {
    const map = this.load();
    delete map[account];
    this.save(map);
  }

  wipe(): void {
    if (existsSync(this.storePath)) unlinkSync(this.storePath);
  }
}

export function defaultKeychainDir(): string {
  return join(homedir(), ".local", "share", "steward", "keychain");
}

export function createKeychain(dir?: string): Keychain {
  return new FileBackedKeychain(dir ?? defaultKeychainDir());
}

export function deriveWrapKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32);
}
