// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/393 (Security p/102#81): a probe child that reports what the sandbox lets it see. The bytes it receives are the path
// of a file outside the child's working directory; the probe tries to read it and reports the result.
import { readFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';

process.once('message', (message) => {
  const outsidePath = new TextDecoder().decode(message.bytes);
  let outsideReadable = false;
  try {
    readFileSync(outsidePath, 'utf8');
    outsideReadable = true;
  } catch {
    outsideReadable = false;
  }
  const report = {
    sentinelSeen: process.env.T393_SENTINEL !== undefined,
    envKeys: Object.keys(process.env).sort(),
    cwd: process.cwd(),
    outsideReadable,
  };
  process.send({ ok: true, text: JSON.stringify(report), warnings: [], rss: 0 }, () => process.exit(0));
});
