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
