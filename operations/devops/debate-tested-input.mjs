// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/709 (Security p/102#390): the daily debate-tested sweep reads top-level debates/debate-*.json in the data repo. After t/651 moves
// user content out of that repo it reads 0 files and, with nothing to harvest, still reports `Lag: 0`: a green reading on no input.
// This reads the sweep's own `Found N debate session files` line so the workflow can say "no input (0 files)" instead of passing
// quietly, and refuses to guess when the line is absent.
//
//   backfillDebateTested.ts ... | node operations/devops/debate-tested-input.mjs      -> prints N; exit 2 when the line is not there

import { fileURLToPath } from 'node:url';

/** PURE. The file count from the sweep's output, or null when the `Found N debate session files` line is missing or ambiguous. */
export function sessionFileCount(output) {
  const hits = [...String(output ?? '').matchAll(/^Found (\d+) debate session files\s*$/gm)];
  if (hits.length !== 1) return null;
  const n = Number(hits[0][1]);
  return Number.isSafeInteger(n) ? n : null;
}

/** PURE. The messages for a run that read no input: a `::warning::` and a summary line. */
export function noInputMessages() {
  return {
    warning: '::warning::t/709: the debate-tested sweep read 0 debate session files (no input). Nothing was harvested and no lag was evaluated: this is not a clean reading. If the debates moved out of the data repo (t/651), retire this workflow or point it at its new input.',
    summary: '**no input (0 files)**: the debate-tested sweep read no debate session files, so nothing was harvested and the lag was not evaluated.',
  };
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { data += c; });
  process.stdin.on('end', () => {
    const n = sessionFileCount(data);
    if (n === null) process.exit(2);
    process.stdout.write(String(n));
  });
}
