// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/393 (Security p/232#18): a child that tries to escape the sandbox. It tries to write a file, spawn a process and open a
// network connection, and reports each error code. The bytes it receives are the path of the file it tries to write.
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { TextDecoder } from 'node:util';
import { join } from 'node:path';

process.once('message', async (message) => {
  const target = new TextDecoder().decode(message.bytes);
  const report = {};
  try {
    writeFileSync(target, 'escaped');
    report.write = 'WROTE';
  } catch (e) {
    report.write = e.code;
  }
  try {
    writeFileSync(join(process.cwd(), 'inside.txt'), 'escaped');
    report.writeCwd = 'WROTE';
  } catch (e) {
    report.writeCwd = e.code;
  }
  try {
    const result = spawnSync(process.execPath, ['-e', '0']);
    report.spawn = result.error ? result.error.code : 'SPAWNED';
  } catch (e) {
    report.spawn = e.code;
  }
  await new Promise((resolve) => {
    const socket = connect(9, '127.0.0.1');
    socket.on('connect', () => {
      report.net = 'CONNECTED';
      socket.destroy();
      resolve();
    });
    socket.on('error', (e) => {
      report.net = e.code;
      resolve();
    });
  });
  process.send({ ok: true, text: JSON.stringify(report), warnings: [], rss: 0 }, () => process.exit(0));
});
