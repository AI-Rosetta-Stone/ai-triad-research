// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * API-key storage abstraction.
 *
 * - Local mode (default): AES-256-GCM encrypted file on the data volume, one
 *   file per backend — identical behavior to the pre-2026-04 implementation.
 *   Single-user: userId is ignored.
 *
 * - Azure mode (AZURE_KEYVAULT_URL set): one Key Vault secret per (user,
 *   backend). The container app authenticates to the vault via its
 *   system-assigned managed identity. Secret names are deterministic hashes
 *   of the principal so they fit KV's name constraints.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';
import type { AIBackend } from '../config.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { renameSyncWithRetry } from '../../../../lib/debate/persistence.js';

const require = createRequire(import.meta.url);
import { log } from '../logger.js';

/** Outcome of a key-material rotation (t/809). */
export interface KeyRotationResult {
  store: 'local' | 'azure-key-vault';
  /** Number of backend key files re-encrypted under the new material. */
  rotated: number;
  /** Which backends were re-encrypted. */
  backends: AIBackend[];
  /** Set when rotation is not applicable to this store (e.g. Key Vault). */
  skipped?: string;
}

export interface KeyStore {
  /** Raw stored value for (backend,user). May be a single legacy key or a JSON
   *  array of keys (t/835); callers wanting the list should use getKeys(). */
  get(backend: AIBackend, userId: string): Promise<string | null>;
  set(backend: AIBackend, userId: string, key: string): Promise<void>;
  /** Remove the stored key for this backend/user. Idempotent (no-op if absent). */
  delete(backend: AIBackend, userId: string): Promise<void>;
  /**
   * Rotate the encryption key material and re-encrypt all stored keys under it
   * (t/809). Defense-in-depth: limits exposure if the old material leaks. No-op
   * for stores that delegate encryption to the platform (Azure Key Vault).
   */
  rotateKeyMaterial(): Promise<KeyRotationResult>;

  // ── Single-key per backend (t/1426; replaces t/835 multi-key). ──────────────
  /** The key for (backend,user) as a one-element list, or []. Truncates legacy
   *  multi-key values on read and rewrites the store. */
  getKeys(backend: AIBackend, userId: string): Promise<string[]>;
  /** Store a single key (takes first element; empty list deletes the entry). */
  setKeys(backend: AIBackend, userId: string, keys: string[]): Promise<void>;
  /** Replace the stored key (not append); returns [key]. */
  addKey(backend: AIBackend, userId: string, key: string): Promise<string[]>;
  /** Remove the key at `index` (only 0 is meaningful); returns the new list. */
  removeKey(backend: AIBackend, userId: string, index: number): Promise<string[]>;
}

/**
 * Parse a raw stored value into a key list (t/835). A value that JSON-parses to
 * a string array is multi-key; anything else is treated as one legacy key.
 * Empty / blank values yield []. Blank entries are dropped.
 */
export function parseKeys(raw: string | null): string[] {
  if (raw == null) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const arr: unknown = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        return arr.filter((k): k is string => typeof k === 'string' && k.trim().length > 0).map(k => k.trim());
      }
    } catch { /* silent by design — non-JSON value is a legacy single key */ }
  }
  return [trimmed];
}

/**
 * Single-key-per-backend logic (t/1426, replaces t/835 multi-key).
 * Legacy multi-key values are truncated to the first key on read and rewritten.
 */
abstract class BaseKeyStore implements KeyStore {
  abstract get(backend: AIBackend, userId: string): Promise<string | null>;
  abstract set(backend: AIBackend, userId: string, key: string): Promise<void>;
  abstract delete(backend: AIBackend, userId: string): Promise<void>;
  abstract rotateKeyMaterial(): Promise<KeyRotationResult>;

  async getKeys(backend: AIBackend, userId: string): Promise<string[]> {
    const keys = parseKeys(await this.get(backend, userId));
    if (keys.length > 1) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'key-store', level: 'info',
        message: `Truncated ${keys.length} stored keys to 1 for ${backend}`,
        data: { backend, truncatedCount: keys.length - 1 },
      });
      await this.set(backend, userId, keys[0]);
      return [keys[0]];
    }
    return keys;
  }

  async setKeys(backend: AIBackend, userId: string, keys: string[]): Promise<void> {
    const clean = keys
      .map(k => typeof k === 'string' ? k.trim() : '')
      .filter(k => k.length > 0);
    if (clean.length === 0) { await this.delete(backend, userId); return; }
    if (clean.length > 1) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'key-store', level: 'info',
        message: `setKeys called with ${clean.length} keys — storing first only`,
        data: { backend, truncatedCount: clean.length - 1 },
      });
    }
    await this.set(backend, userId, clean[0]);
  }

  async addKey(backend: AIBackend, userId: string, key: string): Promise<string[]> {
    const trimmed = key.trim();
    if (!trimmed) return this.getKeys(backend, userId);
    await this.set(backend, userId, trimmed);
    return [trimmed];
  }

  async removeKey(backend: AIBackend, userId: string, index: number): Promise<string[]> {
    if (index === 0) await this.delete(backend, userId);
    return this.getKeys(backend, userId);
  }
}

// ── Local file store (single-user, unchanged behavior) ────────────────────────

class LocalFileKeyStore extends BaseKeyStore {
  constructor(private resolveDataRoot: () => string) { super(); }

  private filePath(backend: AIBackend): string {
    return path.join(this.resolveDataRoot(), `.aitriad-key-${backend}.enc`);
  }

  private materialPath(): string {
    return path.join(this.resolveDataRoot(), '.aitriad-key-material');
  }

  /** PBKDF2-derive the AES-256 key from raw key material. */
  private deriveFromMaterial(material: Buffer): Buffer {
    return crypto.pbkdf2Sync(material, 'aitriad-server-key-v2', 100_000, 32, 'sha256');
  }

  // S11: Derive key from random material stored on disk instead of hostname.
  private derivedKey(): Buffer {
    return this.deriveFromMaterial(this.readOrCreateMaterial());
  }

  /** Load the on-disk key material, creating fresh 64-byte material if missing
   *  or too short. Written mode 0600. */
  private readOrCreateMaterial(): Buffer {
    const keyFile = this.materialPath();
    if (fs.existsSync(keyFile)) {
      const material = fs.readFileSync(keyFile);
      if (material.length >= 32) return material;
    }
    const fresh = crypto.randomBytes(64);
    this.writeFileAtomic(keyFile, fresh, 0o600);
    return fresh;
  }

  /** Atomic write: temp file in the same dir + rename (rename is atomic on a
   *  single filesystem), so a crash never leaves a half-written file. */
  private writeFileAtomic(p: string, buf: Buffer, mode?: number): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${crypto.randomBytes(6).toString('hex')}`;
    fs.writeFileSync(tmp, buf, mode !== undefined ? { mode } : undefined);
    renameSyncWithRetry(tmp, p);
  }

  private encrypt(plaintext: string, key: Buffer): Buffer {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  }

  // t/620 (Security, t/617): the v1 key derivation (PBKDF2 of os.hostname() plus a fixed constant) is gone. Anyone with
  // the .enc file and the host name could decrypt a v1 file, and host names are low-entropy. A v1-only file is now
  // refused, never decrypted; the user re-enters the key in Settings, which writes it under v2 material.

  private decrypt(filepath: string, key: Buffer): string {
    const combined = fs.readFileSync(filepath);
    const iv = combined.subarray(0, 16);
    const tag = combined.subarray(16, 32);
    const encrypted = combined.subarray(32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf-8');
  }

  async get(backend: AIBackend, _userId: string): Promise<string | null> {
    const p = this.filePath(backend);
    if (!fs.existsSync(p)) return null;
    try {
      return this.decrypt(p, this.derivedKey());
    } catch (err) {
      // t/620: no v1 (hostname-derived) fallback. The file is either encrypted under other key material or is a legacy
      // v1 file; either way it is not decrypted. WARN so the user knows to re-enter the key.
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'key-store',
        level: 'warn',
        message: `Stored ${backend} key cannot be decrypted with the current key material (a legacy v1 file is no longer read, t/620); re-enter it in Settings`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      log.server.warn({ backend }, 'Stored API key cannot be decrypted with the current key material; legacy v1 files are no longer read (t/620). Re-enter the key in Settings.');
      return null;
    }
  }

  async set(backend: AIBackend, _userId: string, key: string): Promise<void> {
    this.writeFileAtomic(this.filePath(backend), this.encrypt(key, this.derivedKey()));
  }

  /** Discover which backends have an encrypted key file on disk. */
  private discoverBackends(): AIBackend[] {
    const root = this.resolveDataRoot();
    if (!fs.existsSync(root)) return [];
    const re = /^\.aitriad-key-(.+)\.enc$/;
    return fs.readdirSync(root)
      .map(f => re.exec(f)?.[1])
      .filter((b): b is string => !!b) as AIBackend[];
  }

  /**
   * t/809: rotate the key material and re-encrypt every stored key under it.
   * Crash-safe: decrypt everything first (abort untouched if any key can't be
   * read), encrypt all under the new material to temp files, then swap the
   * material and rename the temps into place — so a failure can't leave keys
   * encrypted under material that no longer exists.
   */
  async rotateKeyMaterial(): Promise<KeyRotationResult> {
    const backends = this.discoverBackends();
    if (backends.length === 0) {
      // Nothing encrypted yet — just (re)seed material so it exists going forward.
      this.writeFileAtomic(this.materialPath(), crypto.randomBytes(64), 0o600);
      return { store: 'local', rotated: 0, backends: [] };
    }

    const oldKey = this.derivedKey();

    // 1. Decrypt all to memory first; abort the whole rotation if any fails.
    const plaintext = new Map<AIBackend, string>();
    for (const backend of backends) {
      const p = this.filePath(backend);
      try {
        plaintext.set(backend, this.decrypt(p, oldKey));
      } catch (err) {
        // t/620: no v1 fallback here either; a file the current material can't open aborts the rotation.
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'key-store', level: 'error',
          message: `Key rotation aborted: cannot decrypt ${backend} with the current material`,
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        throw new ActionableError({
          goal: 'Rotate key material and re-encrypt all stored API keys',
          problem: `Could not decrypt the stored key for '${backend}' with the current material (legacy v1 files are no longer read, t/620); rotating now would orphan it.`,
          location: `keyStore.ts LocalFileKeyStore.rotateKeyMaterial (${p})`,
          nextSteps: [
            'Verify .aitriad-key-material has not been replaced out-of-band',
            `Re-save the '${backend}' key via the Settings dialog, then retry rotation`,
          ],
          innerError: err,
        });
      }
    }

    // 2. Encrypt all under fresh material → temp files (no originals touched yet).
    const newMaterial = crypto.randomBytes(64);
    const newKey = this.deriveFromMaterial(newMaterial);
    const staged: { final: string; tmp: string }[] = [];
    try {
      for (const [backend, value] of plaintext) {
        const final = this.filePath(backend);
        const tmp = `${final}.rot-${crypto.randomBytes(6).toString('hex')}`;
        fs.writeFileSync(tmp, this.encrypt(value, newKey));
        staged.push({ final, tmp });
      }
      // 3. Swap material, then move each re-encrypted file into place.
      this.writeFileAtomic(this.materialPath(), newMaterial, 0o600);
      for (const { final, tmp } of staged) renameSyncWithRetry(tmp, final);
    } catch (err) {
      for (const { tmp } of staged) { try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* telemetry — silent by design */ } }
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'key-store', level: 'error',
        message: 'Key rotation failed while writing re-encrypted keys',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw new ActionableError({
        goal: 'Rotate key material and re-encrypt all stored API keys',
        problem: `Writing re-encrypted key files failed: ${String(err)}`,
        location: 'keyStore.ts LocalFileKeyStore.rotateKeyMaterial',
        nextSteps: ['Check free disk space and write permissions on the data root', 'Retry rotation'],
        innerError: err,
      });
    }

    log.server.info({ rotated: backends.length, backends }, 'Rotated key material');
    return { store: 'local', rotated: backends.length, backends };
  }

  async delete(backend: AIBackend, _userId: string): Promise<void> {
    const p = this.filePath(backend);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'key-store',
        level: 'warn',
        message: `Failed to delete local key for ${backend}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }
  }
}

// ── Azure Key Vault store (per-user) ──────────────────────────────────────────

interface AzureSecretClient {
  getSecret(name: string): Promise<{ value?: string } | null>;
  setSecret(name: string, value: string): Promise<unknown>;
  beginDeleteSecret(name: string): Promise<unknown>;
}

class AzureKeyVaultKeyStore extends BaseKeyStore {
  private client: AzureSecretClient | null = null;
  private readonly vaultUrl: string;
  private cache = new Map<string, { value: string; expires: number }>();
  private readonly cacheTtlMs = 5 * 60 * 1000;

  constructor(vaultUrl: string) {
    super();
    this.vaultUrl = vaultUrl;
  }

  /**
   * Lazily build the Key Vault client on first use. The Azure SDKs are loaded via
   * dynamic import() (ESM-safe; a bare require() crashes under native ESM) so
   * local installs that skip the optional Azure packages still build and run.
   */
  private async getClient(): Promise<AzureSecretClient> {
    if (this.client) return this.client;
    const { SecretClient } = await import('@azure/keyvault-secrets');
    const identity = await import('@azure/identity');
    // ManagedIdentityCredential in production avoids multi-second startup delays
    // from DefaultAzureCredential probing credential types that won't work.
    const credential = process.env.NODE_ENV === 'production'
      ? new identity.ManagedIdentityCredential()
      : new identity.DefaultAzureCredential();
    this.client = new SecretClient(this.vaultUrl, credential) as AzureSecretClient;
    return this.client;
  }

  private secretName(backend: AIBackend, userId: string): string {
    // KV secret names: alphanumeric + hyphens, ≤127 chars. Hash the principal
    // to avoid leaking emails into secret names and to sidestep charset issues.
    const hash = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 32);
    return `apikey-${backend}-${hash}`;
  }

  /** A getSecret failure that means the secret simply doesn't exist (benign),
   *  vs. a real vault error. Key Vault surfaces this as code 'SecretNotFound'
   *  or HTTP 404. */
  private static isSecretNotFoundError(err: unknown): boolean {
    const code = (err as { code?: string; statusCode?: number })?.code;
    const status = (err as { statusCode?: number })?.statusCode;
    return code === 'SecretNotFound' || status === 404;
  }

  async get(backend: AIBackend, userId: string): Promise<string | null> {
    const name = this.secretName(backend, userId);
    const hit = this.cache.get(name);
    if (hit && hit.expires > Date.now()) return hit.value || null;
    try {
      const client = await this.getClient();
      const resp = await client.getSecret(name);
      const value = resp?.value ?? null;
      if (value) this.cache.set(name, { value, expires: Date.now() + this.cacheTtlMs });
      return value;
    } catch (err: unknown) {
      const isNotFound = AzureKeyVaultKeyStore.isSecretNotFoundError(err);
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'key-store',
        level: isNotFound ? 'debug' : 'error',
        message: isNotFound ? `Secret not found: ${name}` : 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      if (isNotFound) {
        this.cache.set(name, { value: '', expires: Date.now() + this.cacheTtlMs });
        return null;
      }
      log.server.warn({ secretName: name, err }, 'Key Vault getSecret failed');
      return null;
    }
  }

  async set(backend: AIBackend, userId: string, key: string): Promise<void> {
    const name = this.secretName(backend, userId);
    const client = await this.getClient();
    await client.setSecret(name, key);
    this.cache.delete(name);
  }

  async delete(backend: AIBackend, userId: string): Promise<void> {
    const name = this.secretName(backend, userId);
    this.cache.delete(name);
    try {
      const client = await this.getClient();
      await client.beginDeleteSecret(name);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      const status = (err as { statusCode?: number })?.statusCode;
      if (code === 'SecretNotFound' || status === 404) return; // already gone — idempotent
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'key-store',
        level: 'warn',
        message: `Failed to delete Key Vault secret for ${backend}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      log.server.warn({ secretName: name, err }, 'Key Vault beginDeleteSecret failed');
    }
  }

  /**
   * No-op (t/809): Key Vault encrypts secrets at rest with Microsoft- or
   * customer-managed keys and rotates them natively — there is no application-held
   * key material to rotate. Rotate via Azure (Key Vault keys / CMK), not here.
   */
  async rotateKeyMaterial(): Promise<KeyRotationResult> {
    return {
      store: 'azure-key-vault',
      rotated: 0,
      backends: [],
      skipped: 'Key Vault manages encryption keys natively; rotate via Azure (CMK), not application code.',
    };
  }
}

// ── Selector ──────────────────────────────────────────────────────────────────

let _store: KeyStore | null = null;

export function getKeyStore(resolveDataRoot: () => string): KeyStore {
  if (_store) return _store;
  const vaultUrl = process.env.AZURE_KEYVAULT_URL;
  if (vaultUrl) {
    log.server.info({ vaultUrl }, 'Using Azure Key Vault');
    _store = new AzureKeyVaultKeyStore(vaultUrl);
  } else {
    log.server.info('Using local encrypted file store');
    _store = new LocalFileKeyStore(resolveDataRoot);
  }
  return _store;
}
