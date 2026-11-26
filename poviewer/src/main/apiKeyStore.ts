// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ActionableError } from '../../../lib/debate/errors.js';
import { DEFAULT_MODEL } from '../../../lib/ai-client/index.js';

const CONFIG_DIR = path.join(os.homedir(), '.poviewer');
const KEY_PATH = path.join(CONFIG_DIR, 'apikey.enc');
const PLAIN_KEY_PATH = path.join(CONFIG_DIR, 'apikey.txt');

function ensureConfigDir(): void {
  // recursive:true is idempotent — no existsSync guard needed (and a guard
  // would be a check-then-act race, CodeQL js/file-system-race).
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function hasErrnoCode(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code;
}

/** Delete a file, treating "already gone" as success (EAFP — no existsSync). */
function unlinkIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    /* telemetry — silent by design (ENOENT = already gone, the desired state) */
    if (!hasErrnoCode(err, 'ENOENT')) throw err;
  }
}

// One-time migration of the legacy plaintext key file (pre-t/2534 fallback).
// Only runs when safeStorage is available. EAFP throughout (CodeQL
// js/file-system-race): the plaintext file is read directly (ENOENT = no
// legacy file), and the encrypted write uses the atomic 'wx' flag so an
// existing encrypted key — always newer, since storeApiKey deletes the
// plaintext file on every encrypted write — is never overwritten.
function migrateLegacyPlaintextKey(): void {
  let legacyRaw: string;
  try {
    legacyRaw = fs.readFileSync(PLAIN_KEY_PATH, 'utf-8');
  } catch (err) {
    /* telemetry — silent by design (ENOENT = no legacy file, nothing to migrate) */
    if (hasErrnoCode(err, 'ENOENT')) return;
    throw err;
  }

  const legacyKey = legacyRaw.trim();
  if (legacyKey) {
    ensureConfigDir();
    try {
      // 'wx' = exclusive create: fails with EEXIST if an encrypted key already
      // exists, preserving the never-overwrite-newer-key invariant atomically.
      fs.writeFileSync(KEY_PATH, safeStorage.encryptString(legacyKey), { flag: 'wx' });
    } catch (err) {
      /* telemetry — silent by design (EEXIST = encrypted key already present, keep it) */
      if (!hasErrnoCode(err, 'EEXIST')) throw err;
    }
  }
  unlinkIfExists(PLAIN_KEY_PATH);
}

export function storeApiKey(key: string): void {
  // Refuse instead of falling back to plaintext on disk (t/2534 M3) —
  // mirrors summary-viewer's apiKeyStore behavior.
  if (!safeStorage.isEncryptionAvailable()) {
    throw new ActionableError({
      goal: 'Store API key securely via Electron safeStorage',
      problem: 'Encryption is not available on this system',
      location: 'apiKeyStore.ts:storeApiKey',
      nextSteps: [
        'Ensure the OS keychain/credential manager is available (e.g., libsecret on Linux, Keychain on macOS)',
        'Set the API key via environment variable instead (GEMINI_API_KEY)',
        'On Linux, install gnome-keyring or kwallet and restart the app',
      ],
    });
  }
  ensureConfigDir();
  const encrypted = safeStorage.encryptString(key);
  fs.writeFileSync(KEY_PATH, encrypted);
  // Remove the legacy plaintext file if present (EAFP, ENOENT tolerated)
  unlinkIfExists(PLAIN_KEY_PATH);
}

export function getApiKey(): string | null {
  if (safeStorage.isEncryptionAvailable()) {
    migrateLegacyPlaintextKey();
    let encrypted: Buffer;
    try {
      encrypted = fs.readFileSync(KEY_PATH);
    } catch (err) {
      /* telemetry — silent by design (ENOENT = no key stored yet) */
      if (hasErrnoCode(err, 'ENOENT')) return null;
      throw err;
    }
    return safeStorage.decryptString(encrypted);
  }

  // safeStorage unavailable: never read (or silently keep serving) a plaintext
  // key — refuse with instructions if a legacy file is present. Existence-only
  // probe: the file is deliberately never opened on this branch.
  if (fs.existsSync(PLAIN_KEY_PATH)) {
    throw new ActionableError({
      goal: 'Load the stored API key',
      problem: `A legacy plaintext key file exists at ${PLAIN_KEY_PATH}, but OS encryption (safeStorage) is unavailable, so it cannot be migrated to encrypted storage or used safely`,
      location: 'apiKeyStore.ts:getApiKey',
      nextSteps: [
        'Ensure the OS keychain/credential manager is available (e.g., libsecret on Linux, Keychain on macOS), then relaunch — the key will be migrated to encrypted storage automatically',
        `Or delete ${PLAIN_KEY_PATH} and set the key via the GEMINI_API_KEY environment variable`,
        'On Linux, install gnome-keyring or kwallet and restart the app',
      ],
    });
  }

  return null;
}

/**
 * Presence check for the renderer (t/2534 M4): the raw key never crosses IPC.
 * Returns false when no usable key exists — including the refuse case where a
 * legacy plaintext file is present but safeStorage is unavailable.
 */
export function hasApiKey(): boolean {
  try {
    return getApiKey() !== null;
  } catch {
    /* telemetry — silent by design */
    return false;
  }
}

export async function validateApiKey(key: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: key });
    // Lightweight validation: generate minimal content to verify key
    await ai.models.generateContent({
      model: DEFAULT_MODEL,
      contents: 'Say "ok"',
      config: { maxOutputTokens: 5 },
    });
    return { valid: true };
  } catch (err: unknown) {
    /* telemetry — silent by design */
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { valid: false, error: message };
  }
}
