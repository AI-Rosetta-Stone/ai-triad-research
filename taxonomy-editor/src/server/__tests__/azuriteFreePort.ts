// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/503 (Quality p/58#75): a free TCP port for a test file's own Azurite.
 *
 * The Azurite suites used fixed ports (10001, 10002, 10006, 10007, 10011, 10012) and names that repeat in every run
 * (`lease-1.lock`, `t1`, `_test-1`). When two runs overlapped on one machine (several sessions share it), the second
 * Azurite failed to bind with its output silenced, its readiness probe answered from the first run's emulator, and
 * both runs leased the same blobs: a first acquire on a "fresh" blob read false, and a 15 s lease outlived 16 s.
 * A port the OS hands out per run gives every run its own emulator and storage directory.
 *
 * The port is released before Azurite binds it, so another process could take it in between; that window is
 * milliseconds, against the minutes a fixed port was shared.
 */
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * t/687 (TL p/50#203): start this file's own Azurite and resolve only once THAT child reports it is listening on
 * `port`. If the child exits first (for example it lost the port to another process between freeAzuritePort and the
 * bind), or never reports within `timeoutMs`, reject, so the suite fails fast instead of a readiness probe being
 * answered by someone else's emulator. stdout is read only for the listening line; stderr goes to the test output.
 */
export function spawnOwnAzurite(azuriteMain: string, location: string, port: number, timeoutMs = 20_000): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      [azuriteMain, '--silent', '--skipApiVersionCheck', '--location', location, '--blobHost', '127.0.0.1', '--blobPort', String(port)],
      { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`spawnOwnAzurite: Azurite did not report listening on 127.0.0.1:${port} within ${timeoutMs} ms. Output: ${output.slice(-500)}`));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      reject(new Error(`spawnOwnAzurite: Azurite exited (code ${code}, signal ${signal}) before listening on port ${port}; another process may hold it. Output: ${output.slice(-500)}`));
    };
    child.once('exit', onExit);
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.includes(`successfully listens on http://127.0.0.1:${port}`)) {
        clearTimeout(timer);
        child.off('exit', onExit);
        child.stdout?.removeAllListeners('data');
        child.stdout?.resume(); // keep draining, so a full pipe never blocks the emulator
        resolve(child);
      }
    });
  });
}

export function freeAzuritePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('freeAzuritePort: the OS returned no TCP port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}
