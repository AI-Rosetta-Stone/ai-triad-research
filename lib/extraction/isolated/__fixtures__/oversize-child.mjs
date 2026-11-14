// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/393 test fixture: a child that returns more text than the parent accepts.
process.once('message', () => {
  process.send({ ok: true, text: 'x'.repeat(2_000_001), warnings: [], rss: 0 }, () => process.exit(0));
});
