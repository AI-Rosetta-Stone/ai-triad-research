// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4457: write ent-361's frozen re-embedded vector into entity_embeddings.json, right after t/4449's Apply and before
// any extraction or resolution run (SO e/357#2 C2; TL p/360#692). Reads ONLY frozen-t4457-ent361.json (made by
// Invoke-T4457Ent361ReEmbedFreeze.ps1); the vector is never recomputed here.
//
//   --mode dryrun   (default) Proves the write without touching anything:
//                   - entities.json is t/4449's post-write (so this runs only after the rename), and ent-361's source
//                     text there hashes to the frozen src_hash (the vector belongs to exactly this record's text);
//                   - entity_embeddings.json is the frozen pre-write; the old block and _src_hashes line sit at their
//                     frozen lines;
//                   - after: only vectors["ent-361"] and _src_hashes["ent-361"] differ; key order kept everywhere;
//                     every new vector has 384 finite numbers; _src_hashes["ent-361"] = src_hash; revert byte-exact.
//   --mode apply    The same proofs, then writes. Needs --approved-sha256 and both targets clean.
//   --mode revert   Restores the old block and hash line, refusing unless the result is the frozen pre-write bytes.

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
const frozenPath = args.frozen ?? join(here, 'frozen-t4457-ent361.json');
const ENT = 'taxonomy/Origin/entities.json';
const EMB = 'taxonomy/Origin/entity_embeddings.json';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const lf = (s) => s.replace(/\r\n/g, '\n');
const read = (rel) => lf(readFileSync(join(dataDir, rel), 'utf8'));
const git = (...a) => execFileSync('git', ['-C', dataDir, ...a], { encoding: 'utf8' }).trim();
const fail = (msg) => { console.error(`t4457 ${mode} REFUSED: ${msg}`); process.exit(1); };
if (!['dryrun', 'apply', 'revert'].includes(mode)) fail(`unknown --mode ${mode}`);

const frozenText = lf(readFileSync(frozenPath, 'utf8'));
const frozenSha = sha(frozenText);
const F = JSON.parse(frozenText);
const ID = F.id;
console.log(`frozen list: ${frozenPath} sha256=${frozenSha}`);

// Swap the block and the hash line. The hash line sits after the block, so it is swapped first (indices stay valid).
function swap(text, fromBlock, toBlock, fromHash, toHash, blockStart, hashIndex) {
  const lines = text.split('\n');
  if (lines[hashIndex] !== fromHash) fail(`_src_hashes["${ID}"] is not at its frozen line`);
  if (!isDeepStrictEqual(lines.slice(blockStart, blockStart + fromBlock.length), fromBlock)) fail(`vectors["${ID}"] is not at its frozen lines`);
  if (hashIndex <= blockStart) fail('frozen hash line precedes the block; unexpected layout');
  lines[hashIndex] = toHash;
  lines.splice(blockStart, fromBlock.length, ...toBlock);
  return lines.join('\n');
}
// Inverse indices: after the forward swap the hash line moved by the block-length difference.
const shift = F.new.block.length - F.old.block.length;

if (mode === 'revert') {
  const back = swap(read(EMB), F.new.block, F.old.block, F.new.hash_line, F.old.hash_line, F.old.block_start, F.old.hash_line_index + shift);
  if (sha(back) !== F.inputs.embeddings_pre_sha256) fail('the reverted file would not be the frozen pre-write bytes');
  writeAtomic(EMB, back);
  console.log(`reverted vectors["${ID}"] and _src_hashes["${ID}"] to their frozen pre-write bytes`);
  process.exit(0);
}
if (mode === 'apply') {
  if (!args['approved-sha256']) fail('--approved-sha256 is required');
  if (args['approved-sha256'].toLowerCase() !== frozenSha) fail(`the frozen list's sha256 ${frozenSha} is not the approved ${args['approved-sha256']}`);
}

// Order: this write follows t/4449's.
const entText = read(ENT);
if (sha(entText) !== F.inputs.entities_required_sha256) fail(`${ENT} is not t/4449's post-write (${F.inputs.entities_required_sha256.slice(0, 8)}…); apply t/4449 first`);
// Binding: the frozen vector belongs to exactly this record's text (the Get-EntityVectorSource rule).
const e = JSON.parse(entText).entities.find((x) => x.id === ID);
const aliasText = (e.aliases ?? []).join(' ');
const nameText = aliasText ? `${e.name} ${aliasText}` : e.name;
const srcHash = sha(`${nameText}\n${e.description ?? ''}`);
if (srcHash !== F.source.src_hash || nameText !== F.source.name_text || (e.description ?? '') !== F.source.desc_text) fail(`ent-361's text in ${ENT} hashes to ${srcHash}, not the frozen src_hash ${F.source.src_hash}`);

const oldText = read(EMB);
if (sha(oldText) !== F.inputs.embeddings_pre_sha256) fail(`${EMB} changed since the freeze`);
const newText = swap(oldText, F.old.block, F.new.block, F.old.hash_line, F.new.hash_line, F.old.block_start, F.old.hash_line_index);
{
  const a = JSON.parse(oldText), b = JSON.parse(newText);
  if (!isDeepStrictEqual(Object.keys(a), Object.keys(b))) fail('envelope key order changed');
  for (const k of Object.keys(a)) if (!['vectors', '_src_hashes'].includes(k) && !isDeepStrictEqual(a[k], b[k])) fail(`envelope ${k} changed`);
  for (const part of ['vectors', '_src_hashes']) {
    if (!isDeepStrictEqual(Object.keys(a[part]), Object.keys(b[part]))) fail(`${part} key order changed`);
    const changed = Object.keys(a[part]).filter((k) => !isDeepStrictEqual(a[part][k], b[part][k]));
    if (!isDeepStrictEqual(changed, [ID])) fail(`${part}: changed ${changed}, expected only ${ID}`);
  }
  const rec = b.vectors[ID];
  if (!isDeepStrictEqual(Object.keys(rec), F.new.keys)) fail(`new record keys ${Object.keys(rec)} are not the frozen ${F.new.keys}`);
  for (const k of Object.keys(rec)) if (rec[k].length !== 384 || !rec[k].every(Number.isFinite)) fail(`${k} is not 384 finite numbers`);
  if (b._src_hashes[ID] !== F.source.src_hash) fail('_src_hashes entry is not the frozen src_hash');
  const back = swap(newText, F.new.block, F.old.block, F.new.hash_line, F.old.hash_line, F.old.block_start, F.old.hash_line_index + shift);
  if (back !== oldText) fail('revert does not restore the bytes');
}
console.log(`proof OK: entities.json is t/4449's post-write and ${ID}'s text hashes to the frozen src_hash; only vectors["${ID}"] (${F.old.block.length} -> ${F.new.block.length} lines, keys ${F.new.keys}) and _src_hashes["${ID}"] change; key order kept; revert byte-exact. post-write sha256=${sha(newText)}`);

if (mode === 'apply') {
  const dirty = git('status', '--porcelain', '--', EMB);
  if (dirty) fail(`${EMB} has uncommitted changes:\n${dirty}`);
  writeAtomic(EMB, newText);
  if (read(EMB) !== newText) fail('the written file does not read back as the proven bytes');
  console.log(`applied: ${EMB} written. Commit it as its own commit (after t/4449's), then verify on the committed tree.`);
}

function writeAtomic(rel, content) {
  const p = join(dataDir, rel), tmp = `${p}.t4457.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, p);
}
