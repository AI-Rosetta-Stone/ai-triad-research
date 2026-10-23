// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4449, T2 /data-mutation: correct ent-361's name. The source (rise-authoritarian-informationalism-escalating-
// surveillance-2026-6) says "February 2024"; the election was held on 23 February 2025 (Bundeswahlleiterin press
// release 27/25; t/4449#2). CL decisions (t/4449#3): rename, REPLACE the aliases (the "February 2024" forms would
// mislink to Pakistan's and Indonesia's Feb 2024 elections), and record the source's slip in the free-text field.
//
//   --mode freeze   Reads entities.json at the data repo's origin/main (= the clean working tree), checks ent-361 is
//                   the record this packet fixes, and writes frozen-t4449-ent361.json (pre-write sha256, old and new
//                   values of each changed field).
//   --mode dryrun   (default) Reads ONLY the frozen list: only ent-361 changes, only the frozen fields; key order
//                   kept (external_refs replaced in place), description_provenance appended last (where every existing record has it); canonical;
//                   the text diff touches only ent-361's lines; revert byte-exact.
//   --mode apply    The same proofs, then writes. Needs --approved-sha256 and a clean target.
//   --mode revert   Restores the frozen old values, refusing unless the result is the frozen pre-write bytes.
//
// Scope: entities.json only. ent-361's vector in entity_embeddings.json embeds name + aliases + description, so it
// goes stale here; refreshing it is a separate write (t/4449 packet notes), not hidden in this one.

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
const frozenPath = args.frozen ?? join(here, 'frozen-t4449-ent361.json');
const ID = 'ent-361';
const ENT = 'taxonomy/Origin/entities.json';

// The CL-approved values (t/4449#3).
const NEW = {
  name: '2025 German federal election',
  aliases: ['21st Bundestag election', 'Bundestagswahl 2025', 'February 2025 German federal election'],
  // CL t/4449#5: description is embedded, so it carries no 2024 tokens; the source's slip lives in the frozen evidence.
  description: 'The snap federal election to the 21st German Bundestag, held on 23 February 2025.',
  external_refs: [{ label: 'Bundeswahlleiterin press release 27/25 (election date)', url: 'https://bundeswahlleiterin.de/en/info/presse/mitteilungen/bundestagswahl-2025/27_25_vorlaeufiges-ergebnis.html' }],
  description_provenance: 'ai-drafted',
};
const EXPECT_OLD = { name: '2024 German federal election', aliases: ['February 2024 elections', 'Germany February 2024 elections'], description: '', external_refs: [] };

const sha = (s) => createHash('sha256').update(s).digest('hex');
const canon = (o) => JSON.stringify(o, null, 2) + '\n';
const lf = (s) => s.replace(/\r\n/g, '\n');
const read = () => lf(readFileSync(join(dataDir, ENT), 'utf8'));
const git = (...a) => execFileSync('git', ['-C', dataDir, ...a], { encoding: 'utf8' }).trim();
const fail = (msg) => { console.error(`t4449 ${mode} REFUSED: ${msg}`); process.exit(1); };
if (!['freeze', 'dryrun', 'apply', 'revert'].includes(mode)) fail(`unknown --mode ${mode}`);

// Set the frozen new values on ent-361: existing keys keep their place; a new key is appended last.
function withValues(entity, values) {
  const out = { ...entity };
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}
const mapEnt = (store, f) => ({ ...store, entities: store.entities.map((e) => (e.id === ID ? f(e) : e)) });

if (mode === 'freeze') {
  const head = git('rev-parse', 'HEAD'), main = git('rev-parse', 'origin/main');
  if (head !== main) fail(`data HEAD ${head} is not origin/main ${main}`);
  if (git('status', '--porcelain', '--', ENT)) fail(`${ENT} has uncommitted changes`);
  const text = read();
  if (canon(JSON.parse(text)) !== text) fail(`${ENT} does not round-trip canonically`);
  const e = JSON.parse(text).entities.find((x) => x.id === ID);
  if (!e) fail(`${ID} not found`);
  for (const [k, v] of Object.entries(EXPECT_OLD)) if (!isDeepStrictEqual(e[k], v)) fail(`${ID}.${k} is ${JSON.stringify(e[k])}, not the value this packet fixes`);
  if ('description_provenance' in e) fail(`${ID} already has description_provenance`);
  const old = Object.fromEntries(Object.keys(NEW).map((k) => [k, k in e ? e[k] : null]));
  const frozen = {
    _doc: 't/4449 frozen list: ent-361 renamed to the 2025 election, aliases replaced, description recorded (Invoke-T4449Ent361Rename.mjs). The write reads only this file.',
    inputs: { data_commit: head, entities_pre_sha256: sha(text) },
    id: ID,
    old,
    new: NEW,
    evidence: 'The source (rise-authoritarian-informationalism-escalating-surveillance-2026-6) says the AfD spread deepfakes during "the most recent elections in February 2024"; the election was held on 23 February 2025 (Bundeswahlleiterin press release 27/25; the cited DW article previews that vote). t/4449#2; CL decisions t/4449#3, #5. ent-361 vector re-embed: t/4457.',
  };
  writeFileSync(frozenPath, JSON.stringify(frozen, null, 2) + '\n', 'utf8');
  console.log(`frozen list: ${frozenPath} sha256=${sha(lf(readFileSync(frozenPath, 'utf8')))}`);
  process.exit(0);
}

const frozenText = lf(readFileSync(frozenPath, 'utf8'));
const frozenSha = sha(frozenText);
const frozen = JSON.parse(frozenText);
console.log(`frozen list: ${frozenPath} sha256=${frozenSha}`);
const oldValues = Object.fromEntries(Object.entries(frozen.old).map(([k, v]) => [k, v === null ? undefined : v]));

if (mode === 'revert') {
  const back = canon(mapEnt(JSON.parse(read()), (e) => withValues(e, oldValues)));
  if (sha(back) !== frozen.inputs.entities_pre_sha256) fail('the reverted file would not be the frozen pre-write bytes');
  writeAtomic(back);
  console.log('reverted ent-361 to its frozen pre-write bytes');
  process.exit(0);
}
if (mode === 'apply') {
  if (!args['approved-sha256']) fail('--approved-sha256 is required');
  if (args['approved-sha256'].toLowerCase() !== frozenSha) fail(`the frozen list's sha256 ${frozenSha} is not the approved ${args['approved-sha256']}`);
}

const oldText = read();
if (sha(oldText) !== frozen.inputs.entities_pre_sha256) fail(`${ENT} changed since the freeze`);
const a = JSON.parse(oldText);
const next = mapEnt(a, (e) => withValues(e, frozen.new));
const newText = canon(next);
{
  const b = JSON.parse(newText);
  const changed = a.entities.filter((x, i) => !isDeepStrictEqual(x, b.entities[i])).map((x) => x.id);
  if (!isDeepStrictEqual(changed, [ID])) fail(`entities changed other than ${ID}: ${changed}`);
  for (const k of Object.keys(a)) if (k !== 'entities' && !isDeepStrictEqual(a[k], b[k])) fail(`envelope ${k} changed`);
  const before = a.entities.find((x) => x.id === ID), after = b.entities.find((x) => x.id === ID);
  const keysChanged = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !isDeepStrictEqual(before[k], after[k]));
  if (!isDeepStrictEqual(keysChanged.sort(), Object.keys(frozen.new).sort())) fail(`${ID}: changed keys ${keysChanged} are not the frozen ones`);
  const ko = Object.keys(after);
  if (!isDeepStrictEqual(ko.slice(0, Object.keys(before).length), Object.keys(before)) || ko[ko.length - 1] !== 'description_provenance') fail(`${ID}: key order not kept, or description_provenance not last`);
  // Text: every changed line sits inside ent-361's object.
  const ol = oldText.split('\n'), nl = newText.split('\n');
  const span = (lines) => { const s = lines.findIndex((l) => l === `      "id": "${ID}",`) - 1; let e = s + 1; while (lines[e] !== '    },' && lines[e] !== '    }') e++; return [s, e]; };
  const [os, oe] = span(ol), [ns, ne] = span(nl);
  if (os !== ns || !isDeepStrictEqual(ol.slice(0, os), nl.slice(0, ns)) || !isDeepStrictEqual(ol.slice(oe + 1), nl.slice(ne + 1))) fail('text changes outside ent-361');
  if (canon(mapEnt(b, (e) => withValues(e, oldValues))) !== oldText) fail('revert does not restore the bytes');
}
console.log(`proof OK: only ${ID} changes, only its frozen keys (${Object.keys(frozen.new).join(', ')}; description_provenance appended last); text diff confined to its object; revert byte-exact. post-write sha256=${sha(newText)}`);

if (mode === 'apply') {
  if (git('status', '--porcelain', '--', ENT)) fail(`${ENT} has uncommitted changes`);
  writeAtomic(newText);
  if (read() !== newText) fail('the written file does not read back as the proven bytes');
  console.log(`applied: ${ENT} written. Commit it as its own commit, then verify on the committed tree.`);
}

function writeAtomic(content) {
  const p = join(dataDir, ENT), tmp = `${p}.t4449.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, p);
}
