// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/393 test fixture: a child that exhausts its heap, like a parse that needs more memory than the ceiling allows.
process.once('message', () => {
  const hog = [];
  for (;;) hog.push(new Array(1_000_000).fill(1));
});
