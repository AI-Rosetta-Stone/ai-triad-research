// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4450 (e), T2 /data-mutation: bring ent-054 under the tombstone invariant (merged_into set => status
// 'deprecated', no vector; CL t/4450#2). ent-054 is 'approved' with merged_into 'ent-042' (t/3118 curation).
//
//   --mode freeze   Reads both files at the data repo's origin/main (which must equal the clean working tree),
//                   locates the exact edits and writes frozen-t4450-ent054.json: each file's pre-write sha256,
//                   the one status value, and the two removed embeddings blocks VERBATIM (for a byte-exact revert).
//   --mode dryrun   (default) Reads ONLY the frozen list and proves the write without touching anything:
//                   entities.json: exactly one value changes (ent-054 status approved -> deprecated); everything
//                   else deep-equal; the text diff is that one line; canonical round-trip.
//                   entity_embeddings.json: a pure deletion of the two frozen blocks (vectors["ent-054"] and
//                   _src_hashes["ent-054"]); old == new plus those two keys, key order kept; no other byte moves.
//                   Revert of the simulated write restores both files byte-exactly.
//   --mode apply    The same proofs, then writes. Needs --approved-sha256 (the frozen list's) and clean targets.
//   --mode revert   Restores both files, refusing unless each matches its frozen pre-write sha256.
//
// entity_embeddings.json is written by PowerShell (ConvertTo-Json: "1.2E-34" exponents), so it can't round-trip
// through the canonical serializer; the edit is a line-level deletion, proven structurally instead.

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
const frozenPath = args.frozen ?? join(here, 'frozen-t4450-ent054.json');
const ID = 'ent-054';
const ENT = 'taxonomy/Origin/entities.json';
const EMB = 'taxonomy/Origin/entity_embeddings.json';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const canon = (o) => JSON.stringify(o, null, 2) + '\n';
const lf = (s) => s.replace(/\r\n/g, '\n');
const read = (rel) => lf(readFileSync(join(dataDir, rel), 'utf8'));
const git = (...a) => execFileSync('git', ['-C', dataDir, ...a], { encoding: 'utf8' }).trim();
const fail = (msg) => { console.error(`t4450 ${mode} REFUSED: ${msg}`); process.exit(1); };
if (!['freeze', 'dryrun', 'apply', 'revert'].includes(mode)) fail(`unknown --mode ${mode}`);

// The lines of one top-level object member `    "<id>": ...` inside `parent`, as [start, endExclusive).
function memberLines(lines, parent, id) {
  const p = lines.indexOf(`  "${parent}": {`);
  if (p < 0) fail(`no "${parent}" object`);
  const start = lines.findIndex((l, i) => i > p && l.startsWith(`    "${id}": `));
  if (start < 0) fail(`no ${parent}["${id}"]`);
  if (lines[start].endsWith('{')) {
    const end = lines.findIndex((l, i) => i > start && /^    \}/.test(l));
    if (end < 0) fail(`unterminated ${parent}["${id}"]`);
    if (lines[end] !== '    },') fail(`${parent}["${id}"] is the last member; this writer handles a mid-object member only`);
    return [start, end + 1];
  }
  if (!lines[start].endsWith(',')) fail(`${parent}["${id}"] is the last member; this writer handles a mid-object member only`);
  return [start, start + 1];
}

function entEdit(text) {
  const store = JSON.parse(text);
  const e = store.entities.find((x) => x.id === ID);
  if (!e) fail(`${ID} not in ${ENT}`);
  return { ...store, entities: store.entities.map((x) => (x.id === ID ? { ...x, status: 'deprecated' } : x)) };
}

function embRemove(text, blocks) {
  let lines = text.split('\n');
  // Remove later blocks first, so earlier line numbers stay valid.
  for (const b of [...blocks].sort((a, z) => z.start - a.start)) {
    const got = lines.slice(b.start, b.start + b.lines.length);
    if (!isDeepStrictEqual(got, b.lines)) fail(`embeddings block ${b.parent}["${ID}"] is not at its frozen lines`);
    lines = [...lines.slice(0, b.start), ...lines.slice(b.start + b.lines.length)];
  }
  return lines.join('\n');
}
function embRestore(text, blocks) {
  let lines = text.split('\n');
  for (const b of [...blocks].sort((a, z) => a.start - z.start)) lines = [...lines.slice(0, b.start), ...b.lines, ...lines.slice(b.start)];
  return lines.join('\n');
}

if (mode === 'freeze') {
  const head = git('rev-parse', 'HEAD'), main = git('rev-parse', 'origin/main');
  if (head !== main) fail(`data HEAD ${head} is not origin/main ${main}`);
  const dirty = git('status', '--porcelain', '--', ENT, EMB);
  if (dirty) fail(`targets have uncommitted changes:\n${dirty}`);
  const entText = read(ENT), embText = read(EMB);
  if (canon(JSON.parse(entText)) !== entText) fail(`${ENT} does not round-trip canonically`);
  const e = JSON.parse(entText).entities.find((x) => x.id === ID);
  if (!(e && e.status === 'approved' && e.merged_into === 'ent-042')) fail(`${ID} is not the approved tombstone of ent-042 this packet fixes: ${JSON.stringify(e && { status: e.status, merged_into: e.merged_into })}`);
  const lines = embText.split('\n');
  const blocks = ['vectors', '_src_hashes'].map((parent) => {
    const [s, x] = memberLines(lines, parent, ID);
    return { parent, start: s, lines: lines.slice(s, x) };
  });
  const frozen = {
    _doc: 't/4450 (e) frozen list: ent-054 status approved -> deprecated, and its vector + _src_hash removed (Invoke-T4450Ent054Fix.mjs). The write reads only this file.',
    inputs: { data_commit: head, entities_pre_sha256: sha(entText), embeddings_pre_sha256: sha(embText) },
    entities_edit: { id: ID, field: 'status', old: 'approved', new: 'deprecated', merged_into: e.merged_into },
    embeddings_removals: blocks.map((b) => ({ parent: b.parent, start: b.start, line_count: b.lines.length, sha256: sha(b.lines.join('\n')), lines: b.lines })),
  };
  writeFileSync(frozenPath, JSON.stringify(frozen, null, 2) + '\n', 'utf8');
  console.log(`frozen list: ${frozenPath} sha256=${sha(lf(readFileSync(frozenPath, 'utf8')))}`);
  console.log(`entities_pre=${frozen.inputs.entities_pre_sha256} embeddings_pre=${frozen.inputs.embeddings_pre_sha256}; removals: ${blocks.map((b) => `${b.parent}@${b.start}+${b.lines.length}`).join(', ')}`);
  process.exit(0);
}

const frozenText = lf(readFileSync(frozenPath, 'utf8'));
const frozenSha = sha(frozenText);
const frozen = JSON.parse(frozenText);
console.log(`frozen list: ${frozenPath} sha256=${frozenSha}`);
const blocks = frozen.embeddings_removals.map((r) => ({ parent: r.parent, start: r.start, lines: r.lines }));
for (const r of frozen.embeddings_removals) if (sha(r.lines.join('\n')) !== r.sha256 || r.lines.length !== r.line_count) fail(`frozen block ${r.parent} fails its own hash`);

if (mode === 'revert') {
  const ent = read(ENT), emb = read(EMB);
  const entBack = canon({ ...JSON.parse(ent), entities: JSON.parse(ent).entities.map((x) => (x.id === ID ? { ...x, status: frozen.entities_edit.old } : x)) });
  const embBack = embRestore(emb, blocks);
  if (sha(entBack) !== frozen.inputs.entities_pre_sha256) fail('reverted entities.json would not be the frozen pre-write bytes');
  if (sha(embBack) !== frozen.inputs.embeddings_pre_sha256) fail('reverted entity_embeddings.json would not be the frozen pre-write bytes');
  writeAtomic(ENT, entBack); writeAtomic(EMB, embBack);
  console.log('reverted both files to their frozen pre-write bytes');
  process.exit(0);
}

if (mode === 'apply') {
  if (!args['approved-sha256']) fail('--approved-sha256 is required (the PI/TL sign-off on the frozen list hash)');
  if (args['approved-sha256'].toLowerCase() !== frozenSha) fail(`the frozen list's sha256 ${frozenSha} is not the approved ${args['approved-sha256']}`);
}

const entOld = read(ENT), embOld = read(EMB);
if (sha(entOld) !== frozen.inputs.entities_pre_sha256) fail(`${ENT} changed since the freeze`);
if (sha(embOld) !== frozen.inputs.embeddings_pre_sha256) fail(`${EMB} changed since the freeze`);

// entities.json: one value.
const entNew = canon(entEdit(entOld));
{
  const a = JSON.parse(entOld), b = JSON.parse(entNew);
  const changed = a.entities.filter((x, i) => !isDeepStrictEqual(x, b.entities[i])).map((x) => x.id);
  if (!isDeepStrictEqual(changed, [ID])) fail(`entities changed other than ${ID}: ${changed}`);
  const before = a.entities.find((x) => x.id === ID), after = b.entities.find((x) => x.id === ID);
  if (!isDeepStrictEqual({ ...before, status: 'deprecated' }, after) || !isDeepStrictEqual(Object.keys(before), Object.keys(after))) fail(`${ID}: more than its status changed`);
  for (const k of Object.keys(a)) if (k !== 'entities' && !isDeepStrictEqual(a[k], b[k])) fail(`envelope ${k} changed`);
  const ol = entOld.split('\n'), nl = entNew.split('\n');
  const diff = ol.map((l, i) => (l !== nl[i] ? i : -1)).filter((i) => i >= 0);
  if (ol.length !== nl.length || diff.length !== 1 || !/"status": "deprecated",?$/.test(nl[diff[0]])) fail('entities.json text diff is not exactly the one status line');
}

// entity_embeddings.json: two pure deletions.
const embNew = embRemove(embOld, blocks);
{
  const a = JSON.parse(embOld), b = JSON.parse(embNew);
  const expect = { ...a, vectors: { ...a.vectors }, _src_hashes: { ...a._src_hashes } };
  delete expect.vectors[ID]; delete expect._src_hashes[ID];
  if (!isDeepStrictEqual(expect, b)) fail('embeddings: old minus the two keys is not deep-equal to new');
  if (!isDeepStrictEqual(Object.keys(expect.vectors), Object.keys(b.vectors)) || !isDeepStrictEqual(Object.keys(a), Object.keys(b))) fail('embeddings: key order changed');
  if (ID in b.vectors || ID in b._src_hashes) fail('embeddings: ent-054 still present');
  if (embRestore(embNew, blocks) !== embOld) fail('embeddings: revert does not restore the bytes');
}
const entRevert = canon({ ...JSON.parse(entNew), entities: JSON.parse(entNew).entities.map((x) => (x.id === ID ? { ...x, status: 'approved' } : x)) });
if (entRevert !== entOld) fail('entities: revert does not restore the bytes');
console.log(`proof OK: entities.json one value (${ID} status approved -> deprecated, one line); entity_embeddings.json two pure deletions (${blocks.map((b) => `${b.parent}: ${b.lines.length} lines`).join(', ')}); revert byte-exact. post-write sha256: entities=${sha(entNew)} embeddings=${sha(embNew)}`);

if (mode === 'apply') {
  const dirty = git('status', '--porcelain', '--', ENT, EMB);
  if (dirty) fail(`targets have uncommitted changes; set that WIP aside as its own commit first:\n${dirty}`);
  writeAtomic(ENT, entNew); writeAtomic(EMB, embNew);
  if (read(ENT) !== entNew || read(EMB) !== embNew) fail('the written files do not read back as the proven bytes');
  console.log(`applied: ${ENT} and ${EMB} written. Commit them as their own commit, then verify on the committed tree.`);
}

function writeAtomic(rel, content) {
  const p = join(dataDir, rel), tmp = `${p}.t4450.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, p);
}
