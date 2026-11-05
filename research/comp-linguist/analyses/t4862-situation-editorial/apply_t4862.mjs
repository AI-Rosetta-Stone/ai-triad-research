// t/4862 /data-mutation apply: 3 situation text edits (sit-485, sit-488, sit-491).
// Reads ONLY frozen_list.json (never re-derives targets). Dry-run by default; --apply writes.
// Usage: node apply_t4862.mjs <path-to-situations.json> [--apply]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const frozen = JSON.parse(fs.readFileSync(path.join(HERE, 'frozen_list.json'), 'utf8'));
const target = process.argv[2];
const apply = process.argv.includes('--apply');
if (!target) { console.error('usage: node apply_t4862.mjs <situations.json> [--apply]'); process.exit(2); }

const ser = (o) => JSON.stringify(o, null, 2) + '\n'; // registered writer: pretty2-lf-nl
const raw = fs.readFileSync(target, 'utf8');
const before = JSON.parse(raw);
if (ser(before) !== raw) { console.error('ABORT: file does not round-trip byte-identically through the real writer'); process.exit(1); }

const after = structuredClone(before);
const byId = new Map(after.nodes.map((n) => [n.id, n]));
for (const [id, spec] of Object.entries(frozen.targets)) {
  const node = byId.get(id);
  if (!node) { console.error(`ABORT: ${id} not found`); process.exit(1); }
  for (const [field, { old, new: nv }] of Object.entries(spec.set ?? {})) {
    if (node[field] !== old) { console.error(`ABORT: ${id}.${field} moved since freeze`); process.exit(1); }
    node[field] = nv;
  }
  for (const [field, old] of Object.entries(spec.remove ?? {})) {
    if (!isDeepStrictEqual(node[field], old)) { console.error(`ABORT: ${id}.${field} moved since freeze`); process.exit(1); }
    delete node[field];
  }
}

// 0-collateral: same count/order; every non-target node deep-equal; targets differ only in listed fields.
const fail = (m) => { console.error('0-COLLATERAL FAIL: ' + m); process.exit(1); };
if (after.nodes.length !== before.nodes.length) fail('node count changed');
const topKeysB = Object.keys(before).filter((k) => k !== 'nodes');
for (const k of topKeysB) if (!isDeepStrictEqual(before[k], after[k])) fail(`top-level key ${k} changed`);
let changedNodes = 0;
before.nodes.forEach((b, i) => {
  const a = after.nodes[i];
  if (a.id !== b.id) fail(`order changed at ${i}`);
  const spec = frozen.targets[b.id];
  if (!spec) { if (!isDeepStrictEqual(a, b)) fail(`non-target ${b.id} changed`); return; }
  changedNodes++;
  const allowed = new Set([...Object.keys(spec.set ?? {}), ...Object.keys(spec.remove ?? {})]);
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!allowed.has(k) && !isDeepStrictEqual(a[k], b[k])) fail(`${b.id}.${k} changed but not listed`);
  }
});
if (changedNodes !== Object.keys(frozen.targets).length) fail('target count mismatch');

const out = ser(after);
const bl = raw.split('\n'), al = out.split('\n');
console.log(`targets: ${changedNodes}/${Object.keys(frozen.targets).length}; lines before ${bl.length} after ${al.length}`);
console.log(apply ? 'MODE: APPLY' : 'MODE: DRY-RUN (no write)');
if (apply) { fs.writeFileSync(target, out); console.log('written:', target); }
console.log('OK: 0-collateral checks passed');
