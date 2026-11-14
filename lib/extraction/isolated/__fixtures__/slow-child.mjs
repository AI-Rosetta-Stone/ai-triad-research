// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/274 test fixture: a child that holds its slot for about a second, so the concurrency cap is observable.
process.once('message', () => {
  setTimeout(() => {
    process.send({ ok: true, text: 'slow', warnings: [], rss: 0 }, () => process.exit(0));
  }, 1000);
});
