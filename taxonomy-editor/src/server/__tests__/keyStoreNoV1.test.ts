// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/620 (Security, t/617): the file key store no longer decrypts a legacy v1 file, whose AES key was derived only from
// os.hostname() plus a fixed constant. Such a file is refused (get returns null, rotation aborts), never decrypted and
// never silently migrated. A key saved now still round-trips under v2 material.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { getKeyStore } from '../security/keyStore.js';

let dataRoot: string;
const store = () => getKeyStore(() => dataRoot);
const encPath = (b: string) => path.join(dataRoot, `.aitriad-key-${b}.enc`);

/** Writes a file exactly as the removed v1 scheme did (key = PBKDF2(hostname + const)). */
function writeV1File(backend: string, plaintext: string): void {
  const key = crypto.pbkdf2Sync(os.hostname() + 'aitriad-server-key-v1', 'aitriad-server-key-v1', 100_000, 32, 'sha256');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  fs.writeFileSync(encPath(backend), Buffer.concat([iv, cipher.getAuthTag(), enc]));
}

describe('t/620: no v1 hostname-derived key fallback', () => {
  beforeEach(() => { dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'keynov1-')); });
  afterEach(() => { fs.rmSync(dataRoot, { recursive: true, force: true }); });

  it('a v1-only file is refused, not decrypted, and not rewritten', async () => {
    writeV1File('gemini', 'AIzaV1SecretThatMustNotComeBack0000000');
    const before = fs.readFileSync(encPath('gemini'));
    expect(await store().get('gemini', '_local')).toBeNull();
    expect(fs.readFileSync(encPath('gemini')).equals(before)).toBe(true); // no silent migration
  });

  it('key-material rotation aborts on a v1-only file instead of decrypting it', async () => {
    await store().set('claude', '_local', 'k-claude'); // creates v2 material
    writeV1File('gemini', 'AIzaV1SecretThatMustNotComeBack0000000');
    await expect(store().rotateKeyMaterial()).rejects.toThrow(/legacy v1 files are no longer read/);
  });

  it('a key saved now round-trips under v2 material', async () => {
    await store().set('gemini', '_local', 'k-new');
    expect(await store().get('gemini', '_local')).toBe('k-new');
  });
});
