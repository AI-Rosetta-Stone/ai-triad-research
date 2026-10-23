// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4404 T2: write the frozen per-entity source attribution into entities.json (/data-mutation step 2).
// Reads ONLY frozen-t4404-source-refs.json (made by Invoke-T4404SourceRefsFreeze.ps1); nothing is re-derived.
//
//   --mode dryrun   (default) Proves the write without touching the file:
//                     - entities.json bytes are the frozen pre_sha256;
//                     - the file round-trips byte-exact through the canonical serializer
//                       (JSON.stringify(o, null, 2) + "\n", lib/data-formats/file-writers.json);
//                     - every frozen entity's current source_refs equals its frozen old_source_refs;
//                     - after the write, old == new with the three fields stripped (deep-equal), entity count and
//                       order unchanged, every non-target entity serializes byte-identically;
//                     - revert of the simulated write restores the original bytes exactly.
//   --mode apply    The same proofs, then writes. Needs --approved-sha256 <frozen list sha256> (the PI's sign-off)
//                   and a clean target file (git status --porcelain), so no other actor's WIP is entangled.
//   --mode revert   Restores the frozen old_source_refs and removes the two added keys, refusing unless the
//                   result is byte-identical to the frozen pre_sha256.
//
// The added keys go directly after source_refs, in the order the mint writes them (source_refs_basis,
// source_refs_status). Timestamps are not touched: the diff is limited to the three fields.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? a.concat([[v.slice(2), all[i + 1]]]) : a), []));
const mode = args.mode ?? 'dryrun';
const dataDir = args['data-dir'] ?? 'C:\\Users\\jsnov\\repos\\ai-triad-data';
const frozenPath = args.frozen ?? join(here, 'frozen-t4404-source-refs.json');
const entRel = 'taxonomy/Origin/entities.json';
const entPath = join(dataDir, entRel);
const ADDED = ['source_refs_basis', 'source_refs_status'];

const sha = (s) => createHash('sha256').update(s).digest('hex');
const canon = (o) => JSON.stringify(o, null, 2) + '\n';
const fail = (msg) => { console.error(`t4404 ${mode} REFUSED: ${msg}`); process.exit(1); };

if (!['dryrun', 'apply', 'revert'].includes(mode)) fail(`unknown --mode ${mode}`);
const frozenText = readFileSync(frozenPath, 'utf8').replace(/\r\n/g, '\n');
const frozenSha = sha(frozenText);
const frozen = JSON.parse(frozenText);
console.log(`frozen list: ${frozenPath} sha256=${frozenSha}`);
if (mode === 'apply') {
  if (!args['approved-sha256']) fail('--approved-sha256 is required (the PI sign-off on the frozen list hash)');
  if (args['approved-sha256'].toLowerCase() !== frozenSha) fail(`the frozen list's sha256 ${frozenSha} is not the approved ${args['approved-sha256']}`);
}

// LF-normalized: the working tree may hold CRLF while the blob is LF (eol=lf). The write is LF, as the blob.
const raw = readFileSync(entPath, 'utf8').replace(/\r\n/g, '\n');
const store = JSON.parse(raw);
if (canon(store) !== raw) fail(`${entRel} does not round-trip byte-exact through the canonical serializer`);

// Set an entity's fields: source_refs replaced, the added keys placed right after it (or removed).
function rebuild(entity, refs, basis, status) {
  const out = {};
  for (const [k, v] of Object.entries(entity)) {
    if (ADDED.includes(k)) continue;
    if (k === 'source_refs') {
      out.source_refs = refs;
      if (basis !== undefined) { out.source_refs_basis = basis; out.source_refs_status = status; }
    } else out[k] = v;
  }
  return out;
}

const byId = new Map(store.entities.map((e, i) => [e.id, i]));
const targets = new Map();
for (const fe of frozen.entities) {
  if (!byId.has(fe.id)) fail(`frozen entity ${fe.id} is not in ${entRel}`);
  if (targets.has(fe.id)) fail(`frozen entity ${fe.id} is listed twice`);
  targets.set(fe.id, fe);
}

function applyTo(src) {
  return { ...src, entities: src.entities.map((e) => {
    const fe = targets.get(e.id);
    return fe ? rebuild(e, [...fe.source_refs], { ...fe.source_refs_basis }, fe.source_refs_status) : e;
  }) };
}
function revertFrom(src) {
  return { ...src, entities: src.entities.map((e) => {
    const fe = targets.get(e.id);
    return fe ? rebuild(e, [...fe.old_source_refs], undefined, undefined) : e;
  }) };
}
const strip = (s) => s.entities.map((e) => (targets.has(e.id) ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'source_refs' && !ADDED.includes(k))) : e));

function proveWrite(oldStore, newStore, oldText) {
  const errs = [];
  if (newStore.entities.length !== oldStore.entities.length) errs.push('entity count changed');
  oldStore.entities.forEach((e, i) => { if (newStore.entities[i]?.id !== e.id) errs.push(`entity order changed at ${i}`); });
  if (!isDeepStrictEqual(Object.keys(newStore), Object.keys(oldStore))) errs.push('envelope keys changed');
  for (const k of Object.keys(oldStore)) if (k !== 'entities' && !isDeepStrictEqual(oldStore[k], newStore[k])) errs.push(`envelope ${k} changed`);
  if (!isDeepStrictEqual(strip(oldStore), strip(newStore))) errs.push('a field other than source_refs / the added keys changed');
  oldStore.entities.forEach((e, i) => {
    const n = newStore.entities[i];
    if (!targets.has(e.id)) { if (canon(e) !== canon(n)) errs.push(`non-target ${e.id} changed`); return; }
    const fe = targets.get(e.id);
    if (!isDeepStrictEqual(n.source_refs, fe.source_refs)) errs.push(`${e.id}: source_refs is not the frozen value`);
    if (!n.source_refs.every((d) => fe.old_source_refs.includes(d))) errs.push(`${e.id}: a doc outside the current list`);
    if (!isDeepStrictEqual(Object.keys(n.source_refs_basis), n.source_refs)) errs.push(`${e.id}: basis keys differ from source_refs`);
    if ((n.source_refs.length === 0) !== (n.source_refs_status === 'none-matched')) errs.push(`${e.id}: status disagrees with the list`);
  });
  if (canon(revertFrom(newStore)) !== oldText) errs.push('revert of the write does not restore the original bytes');
  return errs;
}

if (mode === 'revert') {
  const reverted = canon(revertFrom(store));
  if (sha(reverted) !== frozen.inputs.entities_pre_sha256) fail('the reverted file would not be the frozen pre-write bytes');
  writeAtomic(reverted);
  console.log(`reverted ${targets.size} entities; sha256=${sha(reverted)} == frozen pre_sha256`);
  process.exit(0);
}

if (sha(raw) !== frozen.inputs.entities_pre_sha256) fail(`${entRel} changed since the freeze (sha256 ${sha(raw)})`);
const drift = [];
for (const [id, fe] of targets) {
  const cur = store.entities[byId.get(id)];
  if (!isDeepStrictEqual(cur.source_refs, fe.old_source_refs)) drift.push(id);
  if (ADDED.some((k) => k in cur)) drift.push(`${id} (already has the added keys)`);
}
if (drift.length) fail(`current source_refs differ from the frozen old_source_refs: ${drift.join(', ')}`);

const next = applyTo(store);
const text = canon(next);
const errs = proveWrite(store, JSON.parse(text), raw);
if (errs.length) fail(errs.join('\n  '));
const changedEntities = store.entities.filter((e, i) => canon(e) !== canon(next.entities[i])).length;
console.log(`proof OK: ${targets.size} targets (${changedEntities} serialize differently), ${store.entities.length - targets.size} non-target entities byte-identical, revert restores the bytes; post-write sha256=${sha(text)}`);

if (mode === 'apply') {
  const dirty = execFileSync('git', ['-C', dataDir, 'status', '--porcelain', '--', entRel], { encoding: 'utf8' }).trim();
  if (dirty) fail(`${entRel} has uncommitted changes; commit or set aside that WIP as its own commit first:\n${dirty}`);
  writeAtomic(text);
  const back = readFileSync(entPath, 'utf8');
  if (back !== text) fail('the written file does not read back as the proven bytes');
  console.log(`applied: ${entRel} written (sha256=${sha(back)}). Commit it as its own commit, then verify on the committed tree.`);
}

function writeAtomic(content) {
  const tmp = `${entPath}.t4404.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, entPath);
}
