#!/usr/bin/env node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Canonical JSON writer for the PowerShell write funnel (t/4356 PR C; TL t/4356#2, #4).
//
//   node scripts/json-canonical.mjs --in <json file> --out <target corpus file>
//
// Re-serializes <in> as JSON.stringify(obj, null, 2) + "\n" (UTF-8, no BOM, LF) and writes <out>
// atomically. The format comes from lib/data-formats/file-writers.json (t/4353), the single
// file-to-writer registry: <out> must match a registry key by path suffix and that entry's format must
// be `pretty2-lf-nl`. Anything else is refused, so edges.json (edges-hybrid, Write-EdgesFile) and
// embeddings.json (the Python producer's format) can never be reformatted through here.
//
// Numbers are re-emitted by JavaScript itself, which is why this is Node and not ConvertTo-Json: PowerShell
// can't match JavaScript's number formatting. Exit codes: 0 written, 2 usage, 3 no registry entry,
// 4 wrong format, 5 unreadable or invalid input, 6 write failed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CANONICAL = 'pretty2-lf-nl';

function fail(code, message) {
  process.stderr.write(`json-canonical: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) fail(2, `usage: --in <json file> --out <target file> (got ${argv.join(' ')})`);
    args[key.slice(2)] = value;
  }
  if (!args.in || !args.out) fail(2, 'usage: --in <json file> --out <target file>');
  return args;
}

/**
 * The registry entry for target (forward slashes, case-sensitive): the key that is a path suffix of it, or
 * else the one key with the same file name. The taxonomy directory is configurable (.aitriad.json, tests),
 * so a POV file is identified by its name; an ambiguous or unknown name gets no entry and is refused.
 */
export function findRegistryEntry(registry, target) {
  const norm = target.replace(/\\/g, '/');
  const entries = Object.entries(registry.files ?? {});
  for (const [key, entry] of entries) {
    if (norm === key || norm.endsWith(`/${key}`)) return { key, entry };
  }
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  const byName = entries.filter(([key]) => key.slice(key.lastIndexOf('/') + 1) === base);
  return byName.length === 1 ? { key: byName[0][0], entry: byName[0][1] } : null;
}

/** The canonical text for a parsed document. */
export function canonicalText(obj) {
  return JSON.stringify(obj, null, 2) + '\n';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const registryPath = path.join(here, '..', 'lib', 'data-formats', 'file-writers.json');
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (err) {
    fail(3, `cannot read the format registry ${registryPath}: ${err.message}`);
  }

  const found = findRegistryEntry(registry, path.resolve(args.out));
  if (!found) fail(3, `${args.out} has no entry in lib/data-formats/file-writers.json; add one (Shared Lib, T1) before writing it through the funnel`);
  if (found.entry.format !== CANONICAL) {
    fail(4, `${found.key} is format '${found.entry.format}', not '${CANONICAL}'; write it with its own writer (${(found.entry.writers ?? []).join('; ')})`);
  }

  let obj;
  try {
    const raw = fs.readFileSync(args.in, 'utf8').replace(/^﻿/, '');
    obj = JSON.parse(raw);
  } catch (err) {
    fail(5, `cannot parse ${args.in}: ${err.message}`);
  }

  const tmp = `${args.out}.json-canonical-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, canonicalText(obj), { encoding: 'utf8' });
    fs.renameSync(tmp, args.out);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    fail(6, `cannot write ${args.out}: ${err.message}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
