#!/usr/bin/env node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4486 (t/4410 item 2) — builds the offline IPv4 country database the free-pool geo guard
// (freePoolGeoGuard.ts) looks up at request time, so the server never makes a third-party
// IP-lookup call. Source: DB-IP "Country Lite" (download.db-ip.com), CC-BY 4.0 — attribution is
// required and lives in THIRD-PARTY-NOTICES.txt + the generated file's own `attribution` field.
//
// IPv4 only (v1 scope, TL-acknowledged deviation on t/4486): an IPv6 client address falls through
// the runtime guard's "not resolvable" branch, which is a SAFE direction (fail-closed, refuses
// the free pool) — it over-restricts rather than under-restricts. Extending to IPv6 is tracked as
// a follow-up, not required for initial ship.
//
// Usage:
//   node src/server/ai/scripts/build-geo-db.mjs [path/to/dbip-country-lite.csv.gz]
//   (no arg) downloads the current month's file from download.db-ip.com/free/.
//
// Output: src/server/ai/data/geoCountryIpv4.json — a JSON object (NOT a .ts array, t/4486#2):
//   { sourceDate, generatedAt, licence, attribution, sha256, rowCount, packed }
// `packed` is a single string of fixed-width 10-char records (8 hex chars = big-endian uint32
// range-start, 2 chars = ISO country code), sorted ascending by start, covering the full IPv4
// space contiguously (DB-IP Lite's own invariant — row[i].end + 1 == row[i+1].start). Adjacent
// rows sharing a country are merged at build time, so the runtime index needs only each range's
// start: the next record's start - 1 is implicitly this range's end.

import { createWriteStream, createReadStream, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { createGunzip } from 'zlib';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// src/server/ai/scripts -> src/server/ai
const AI_DIR = path.resolve(__dirname, '..');
const OUT_DIR = path.join(AI_DIR, 'data');
const OUT_FILE = path.join(OUT_DIR, 'geoCountryIpv4.json');
const TMP_DOWNLOAD = path.join(AI_DIR, 'scripts', '.tmp-dbip-download.csv.gz');

const ATTRIBUTION = 'IP Geolocation by DB-IP (https://db-ip.com)';
const LICENCE = 'CC-BY-4.0';

function ipv4ToUint32(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

/** Node's fetch() body is a web ReadableStream; fs.WriteStream is a classic Node stream.
 *  Pipe one into the other without pulling the whole (tens-of-MB) file into memory. */
async function streamToFile(readableStream, destPath) {
  const fileStream = createWriteStream(destPath);
  const writable = new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        fileStream.write(Buffer.from(chunk), err => (err ? reject(err) : resolve()));
      });
    },
    close() {
      return new Promise(resolve => fileStream.end(resolve));
    },
  });
  await readableStream.pipeTo(writable);
}

async function downloadCurrentMonth() {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const url = `https://download.db-ip.com/free/dbip-country-lite-${ym}.csv.gz`;
  console.log(`Downloading ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText} (${url})`);
  await streamToFile(res.body, TMP_DOWNLOAD);
  return { filePath: TMP_DOWNLOAD, sourceDate: `${ym}-01` };
}

async function parseGzCsv(gzPath) {
  const rows = []; // { start: uint32, country: string }
  const stream = createReadStream(gzPath).pipe(createGunzip());
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const [startIp, , country] = line.split(',');
    if (!startIp || !country) continue;
    if (startIp.includes(':')) continue; // IPv6 row — v1 scope is IPv4-only (see header note)
    const start = ipv4ToUint32(startIp);
    if (start === null) continue;
    rows.push({ start, country });
  }
  return rows;
}

/** Merge adjacent rows sharing a country (DB-IP Lite is already sorted + contiguous for IPv4,
 *  so this is a simple linear pass). Only `start` needs to survive — see header note. */
function mergeAdjacent(rows) {
  rows.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const row of rows) {
    const last = merged[merged.length - 1];
    if (last && last.country === row.country) continue; // same country as the run already open
    merged.push(row);
  }
  return merged;
}

function pack(rows) {
  let out = '';
  for (const { start, country } of rows) {
    const hex = start.toString(16).padStart(8, '0');
    const cc = country.toUpperCase().padEnd(2, ' ').slice(0, 2);
    out += hex + cc;
  }
  return out;
}

async function main() {
  const argPath = process.argv[2];
  let csvGzPath = argPath;
  let sourceDate;
  let cleanupTmp = false;
  if (!csvGzPath) {
    const dl = await downloadCurrentMonth();
    csvGzPath = dl.filePath;
    sourceDate = dl.sourceDate;
    cleanupTmp = true;
  } else {
    // Expect the DB-IP filename convention dbip-country-lite-YYYY-MM.csv.gz; fall back to today.
    const m = path.basename(csvGzPath).match(/(\d{4}-\d{2})/);
    sourceDate = m ? `${m[1]}-01` : new Date().toISOString().slice(0, 10);
  }

  console.log(`Parsing ${csvGzPath} ...`);
  const rows = await parseGzCsv(csvGzPath);
  console.log(`Parsed ${rows.length} IPv4 rows.`);
  const merged = mergeAdjacent(rows);
  console.log(`Merged to ${merged.length} rows (adjacent same-country ranges collapsed).`);

  const packed = pack(merged);
  const sha256 = createHash('sha256').update(packed).digest('hex');

  const output = {
    sourceDate,
    generatedAt: new Date().toISOString(),
    licence: LICENCE,
    attribution: ATTRIBUTION,
    sha256,
    rowCount: merged.length,
    packed,
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(output), 'utf-8');
  console.log(`Wrote ${OUT_FILE} (${merged.length} rows, sha256 ${sha256.slice(0, 12)}...).`);

  if (cleanupTmp) {
    try { unlinkSync(csvGzPath); } catch { /* best-effort cleanup */ }
  }
}

main().catch(err => {
  console.error('build-geo-db failed:', err);
  process.exit(1);
});
