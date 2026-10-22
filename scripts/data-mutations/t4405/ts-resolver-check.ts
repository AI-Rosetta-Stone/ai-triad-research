// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4405: run the TypeScript source-identity resolver over the simulated post-write corpus that
// Invoke-T4405DuplicateMark.ps1 writes, so the single-id invariant is checked under BOTH resolvers
// (TL t/4398#5 condition 4). Usage: tsx ts-resolver-check.ts <docs.json> <out.json>
//   docs.json: [{ id, metadata, snapshotSha256 }]
//   out.json:  { canonical, resolved, duplicateOfErrors }
import fs from 'node:fs';
import { groupSourceIdentities, type SourceIdentityDoc } from '../../../lib/sourceIndex/types.js';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  process.stderr.write('usage: tsx ts-resolver-check.ts <docs.json> <out.json>\n');
  process.exit(2);
}
const docs = JSON.parse(fs.readFileSync(inPath, 'utf8').replace(/^﻿/, '')) as SourceIdentityDoc[];
const r = groupSourceIdentities(docs);
fs.writeFileSync(outPath, JSON.stringify({ canonical: r.canonical, resolved: r.resolved, duplicateOfErrors: r.duplicateOfErrors }));
