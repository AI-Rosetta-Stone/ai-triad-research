// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/393 test fixture: a child that never answers, like a crafted PDF that hangs the parser. Only the parent's kill ends it.
process.once('message', () => {
  for (;;) {}
});
