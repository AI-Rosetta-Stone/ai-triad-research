// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4437 — follow-up from t/4326's SO review (PR #3691, head 28c51148). #3691's fix depends
// entirely on normalizePrincipalNameHeader rewriting x-ms-client-principal-name in place BEFORE
// anything else reads the raw Easy Auth principal headers on a request — otherwise the GitHub
// identity-spoofing vector t/4326 closed reopens silently. The SO manually verified the ordering
// holds today but asked for a test enforcing it (no AST parser in this codebase's test style —
// see extractRoutes.ts's own line-based scan — so this is a pragmatic textual check, same spirit
// as routeTable.test.ts's verbatim-extraction guard):
//
// 1. Call-order: within handleRequestInner and the WebSocket upgrade handler (the two places a
//    request enters this server), normalizePrincipalNameHeader must be called before any raw
//    x-ms-client-principal-* header read in that same function body.
// 2. Closed allowlist: the set of files anywhere under src/server/ (excluding tests) that read
//    x-ms-client-principal-* directly is fixed. A new file reading it is exactly the "future
//    refactor silently reopens the vector" risk the ticket names — fail loudly, don't let it slip
//    in as an incidental diff. Growing the allowlist is a deliberate, reviewed decision.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SERVER_DIR = path.resolve(__dirname, '..');
const SERVER_TS = path.join(SERVER_DIR, 'server.ts');
const RAW_HEADER_PATTERN = /x-ms-client-principal-(name|id|idp)/;

/** Extract a function/callback body's text starting at the first line matching `startPattern`,
 *  by counting braces from that line's first `{` until they balance. Naive (doesn't parse strings
 *  or comments), but adequate here — mirrors extractRoutes.ts's pragmatic line-based style and the
 *  files under test don't nest unbalanced braces inside string/comment content around these sites. */
function extractBraceBlock(source: string, startPattern: RegExp): string {
  const lines = source.split(/\r?\n/);
  const startIdx = lines.findIndex(l => startPattern.test(l));
  if (startIdx < 0) throw new Error(`Pattern not found: ${startPattern}`);

  let depth = 0;
  let started = false;
  const collected: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') depth--;
    }
    collected.push(line);
    if (started && depth <= 0) break;
  }
  return collected.join('\n');
}

/** Every raw-header-read index in `body` must sit after `normalizeIdx`. */
function assertAllReadsAfter(body: string, normalizeIdx: number): void {
  let searchFrom = 0;
  while (true) {
    const idx = body.slice(searchFrom).search(RAW_HEADER_PATTERN);
    if (idx < 0) break;
    const absoluteIdx = searchFrom + idx;
    expect(absoluteIdx).toBeGreaterThan(normalizeIdx);
    searchFrom = absoluteIdx + 1;
  }
}

describe('t/4437 — normalizePrincipalNameHeader runs before any raw principal-header read', () => {
  const serverSrc = fs.readFileSync(SERVER_TS, 'utf-8');

  it('handleRequestInner calls normalizePrincipalNameHeader before reading x-ms-client-principal-*', () => {
    const body = extractBraceBlock(serverSrc, /^async function handleRequestInner\(/);
    const normalizeIdx = body.indexOf('normalizePrincipalNameHeader(');
    expect(normalizeIdx).toBeGreaterThanOrEqual(0);
    assertAllReadsAfter(body, normalizeIdx);
  });

  it("the WebSocket upgrade handler (server.on('upgrade', ...)) calls normalizePrincipalNameHeader before reading x-ms-client-principal-*", () => {
    const body = extractBraceBlock(serverSrc, /^server\.on\('upgrade',/);
    const normalizeIdx = body.indexOf('normalizePrincipalNameHeader(');
    expect(normalizeIdx).toBeGreaterThanOrEqual(0);
    assertAllReadsAfter(body, normalizeIdx);
  });
});

describe('t/4437 — closed allowlist of files reading x-ms-client-principal-* directly', () => {
  // Fixed as of this test's authoring. A NEW file appearing here means a new code path reads the
  // raw Easy Auth header — it must either route through the already-normalized header/userContext
  // instead, or be deliberately added to this list with a reviewed justification (same bar as
  // extending routeTable.test.ts's snapshot).
  const ALLOWED_FILES = [
    'server.ts',
    'principalName.ts',
    'routes/session.ts',
  ].sort();

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('no file outside the allowlist reads x-ms-client-principal-* directly', () => {
    const actual = new Set<string>();
    for (const file of walk(SERVER_DIR)) {
      const content = fs.readFileSync(file, 'utf-8');
      if (RAW_HEADER_PATTERN.test(content)) {
        actual.add(path.relative(SERVER_DIR, file).replace(/\\/g, '/'));
      }
    }
    expect([...actual].sort()).toEqual(ALLOWED_FILES);
  });
});
