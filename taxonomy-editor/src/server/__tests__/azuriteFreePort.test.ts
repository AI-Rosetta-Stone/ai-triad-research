// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/687 (TL p/50#203): the Azurite test harness fails fast when its own emulator can't take the port, instead of a
 * readiness probe being answered by whatever else listens there.
 */
import { describe, it, expect } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freeAzuritePort, spawnOwnAzurite } from './azuriteFreePort.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const AZURITE_MAIN = path.resolve(here, '../../../node_modules/azurite/dist/src/blob/main.js');

describe('Azurite harness (t/687)', () => {
  it('freeAzuritePort returns a port nothing is listening on', async () => {
    const port = await freeAzuritePort();
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve()); });
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('spawnOwnAzurite resolves once its own child listens, on the port asked for', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurite-harness-ok-'));
    const port = await freeAzuritePort();
    const child = await spawnOwnAzurite(AZURITE_MAIN, dir, port);
    try {
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* emulator may still hold a handle */ }
    }
  }, 30_000);

  it('spawnOwnAzurite rejects when another process holds the port (never resolves on a foreign listener)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurite-harness-taken-'));
    const port = await freeAzuritePort();
    const squatter = net.createServer(socket => socket.destroy());
    await new Promise<void>((resolve, reject) => { squatter.once('error', reject); squatter.listen(port, '127.0.0.1', () => resolve()); });
    try {
      await expect(spawnOwnAzurite(AZURITE_MAIN, dir, port, 15_000)).rejects.toThrow(/spawnOwnAzurite/);
    } finally {
      await new Promise<void>(resolve => squatter.close(() => resolve()));
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* nothing to clean if it never started */ }
    }
  }, 30_000);
});
