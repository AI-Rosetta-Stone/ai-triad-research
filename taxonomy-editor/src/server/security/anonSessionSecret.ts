// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/664: loads the per-environment anonymous-session signing secret `anon-session-hmac` and installs it in
 * anonSessionSigning.ts.
 *
 * - Hosted (Azure Container Apps: CONTAINER_APP_NAME is set): read by NAME from the app's Key Vault
 *   (AZURE_KEYVAULT_URL) with the managed identity. Azure creates the secret per environment (TL t/500#14);
 *   this code never creates it. Missing vault URL, missing secret, a short secret or a read failure leave
 *   signing unavailable: FAIL CLOSED (no anonymous session is minted or verified), with an ERROR and a
 *   flight-recorder event. Never an unsigned or locally generated fallback on a hosted container.
 * - Local / Electron / dev (not hosted): a 32-byte random secret in `<state root>/.aitriad-anon-session-hmac`
 *   (mode 0600), created on first use with a WARN. Single-user, so a local secret only has to be stable.
 *
 * The secret value is never logged, returned or put in an error.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { log } from '../logger.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { getStateRoot } from '../config.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { setAnonSessionSecret, ANON_SESSION_SECRET_MIN_BYTES } from './anonSessionSigning.js';

/** The Key Vault secret name (Azure creates it per environment; t/500#14). */
export const ANON_SESSION_SECRET_NAME = 'anon-session-hmac';
const LOCAL_SECRET_FILE = '.aitriad-anon-session-hmac';

/** Reads a named secret's value from Key Vault, or null when it does not exist. Injectable for tests. */
export type VaultSecretReader = (vaultUrl: string, name: string) => Promise<string | null>;

const readFromKeyVault: VaultSecretReader = async (vaultUrl, name) => {
  const { SecretClient } = await import('@azure/keyvault-secrets');
  const identity = await import('@azure/identity');
  const credential = process.env.NODE_ENV === 'production'
    ? new identity.ManagedIdentityCredential()
    : new identity.DefaultAzureCredential();
  try {
    const resp = await new SecretClient(vaultUrl, credential).getSecret(name);
    return resp?.value ?? null;
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) {
      log.security.warn({ secretName: name }, 'Key Vault: anon-session-hmac does not exist (signing stays unavailable)');
      return null;
    }
    throw err;
  }
};

/** Decodes the stored secret: base64 (Azure stores the random bytes base64-encoded), else the UTF-8 bytes. */
function decodeSecret(value: string): Buffer {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed) && trimmed.length >= 43) {
    const b = Buffer.from(trimmed, 'base64');
    if (b.length >= ANON_SESSION_SECRET_MIN_BYTES) return b;
  }
  return Buffer.from(trimmed, 'utf8');
}

function failClosed(reason: string, err?: unknown): false {
  log.security.error({ reason, secretName: ANON_SESSION_SECRET_NAME, err: err ? (err as Error).name : undefined },
    'Anonymous sessions UNAVAILABLE: the anon-session-hmac signing secret could not be loaded (fail closed)');
  getGlobalRecorder()?.record({
    type: 'system.error',
    component: 'anon-session-signing',
    level: 'error',
    message: `anon-session-hmac not loaded (${reason}); anonymous sessions are refused until it is`,
    error: { name: 'AnonSessionSecretUnavailable', message: reason },
  });
  return false;
}

/** Reads the local secret file, or null when it does not exist. A file shorter than the minimum is refused, not
 *  replaced: overwriting it would race another process reading it (fail closed; the caller logs and records it). */
function readLocalSecret(p: string): Buffer | null {
  let b: Buffer;
  try {
    b = fs.readFileSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      log.security.warn({ file: p }, 'No local anonymous-session secret file yet; one will be created');
      return null;
    }
    throw err;
  }
  if (b.length < ANON_SESSION_SECRET_MIN_BYTES) {
    throw new ActionableError({
      goal: 'Load the local anonymous-session signing secret',
      problem: `${p} is shorter than ${ANON_SESSION_SECRET_MIN_BYTES} bytes`,
      location: 'security/anonSessionSecret.ts',
      nextSteps: ['Delete the file; a new one is created on the next start (anonymous sessions are reset)'],
    });
  }
  return b;
}

/**
 * t/664 (CodeQL js/file-system-race on #5538): no check-then-act. Read the file; if it doesn't exist, create it
 * EXCLUSIVELY ('wx'). If another process created it first (EEXIST), read theirs, so every local process ends up
 * with the same secret.
 */
function loadLocalSecret(): Buffer {
  const p = path.join(getStateRoot(), LOCAL_SECRET_FILE);
  const existing = readLocalSecret(p);
  if (existing) return existing;
  const fresh = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  try {
    fs.writeFileSync(p, fresh, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    log.security.warn({ file: p }, 'Local anonymous-session secret was created by another process first; using that one');
    const theirs = readLocalSecret(p);
    if (theirs) return theirs;
    throw err;
  }
  log.security.warn({ file: p }, 'Created a local anonymous-session signing secret (not hosted; anonymous sessions from before it are reset)');
  return fresh;
}

/**
 * Loads and installs the secret. Resolves true when signing is available, false when it is not (hosted: fail
 * closed). Never throws. Call once at boot; safe to call again (rotation re-reads the vault).
 */
export async function loadAnonSessionSecret(
  env: NodeJS.ProcessEnv = process.env,
  readVault: VaultSecretReader = readFromKeyVault,
): Promise<boolean> {
  const hosted = Boolean((env.CONTAINER_APP_NAME ?? '').trim());
  if (!hosted) {
    try {
      setAnonSessionSecret(loadLocalSecret());
      return true;
    } catch (err) {
      log.security.error({ err: (err as Error).name }, 'Local anonymous-session secret file could not be read or created');
      return failClosed('local secret file could not be read or created', err);
    }
  }
  const vaultUrl = (env.AZURE_KEYVAULT_URL ?? '').trim();
  if (!vaultUrl) return failClosed('AZURE_KEYVAULT_URL is not set on a hosted container');
  let value: string | null;
  try {
    value = await readVault(vaultUrl, ANON_SESSION_SECRET_NAME);
  } catch (err) {
    log.security.error({ err: (err as Error).name, secretName: ANON_SESSION_SECRET_NAME }, 'Key Vault read of anon-session-hmac failed');
    return failClosed('Key Vault read failed', err);
  }
  if (value === null || value.trim() === '') return failClosed('secret anon-session-hmac does not exist in the vault');
  const bytes = decodeSecret(value);
  if (bytes.length < ANON_SESSION_SECRET_MIN_BYTES) return failClosed(`secret is shorter than ${ANON_SESSION_SECRET_MIN_BYTES} bytes`);
  setAnonSessionSecret(bytes);
  log.security.info({ secretName: ANON_SESSION_SECRET_NAME }, 'Anonymous-session signing secret loaded from Key Vault');
  return true;
}
