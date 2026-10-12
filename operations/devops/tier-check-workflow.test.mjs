// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4103, e/291: the tier-check skew fallback must judge R1 with SELF-CONTAINED code in the
// workflow, never the PR's own (head) predicate module. These tests extract the exact
// BEGIN/END r1-inline block from .github/workflows/tier-check.yml and run it, so they test the
// code the workflow actually executes, not a copy of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const workflow = readFileSync(path.join(root, '.github', 'workflows', 'tier-check.yml'), 'utf8');
const config = JSON.parse(readFileSync(path.join(root, '.github', 'ci', 'tier-paths.json'), 'utf8'));

function extractBlock() {
  const start = workflow.indexOf('// BEGIN r1-inline');
  const end = workflow.indexOf('// END r1-inline');
  assert.ok(start >= 0 && end > start, 'r1-inline markers must exist in tier-check.yml');
  return workflow.slice(start, end);
}

function loadInline() {
  // eslint-disable-next-line no-new-func
  return new Function(`${extractBlock()}\nreturn inlineR1Fallback;`)();
}

const files = (...names) => names.map((filename) => ({ filename, status: 'modified' }));

test('the inline fallback imports and references no predicate module (head or base)', () => {
  // Code lines only: the block's comment legitimately names the old head call it replaces.
  const block = extractBlock().split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const banned of ['import(', 'require(', 'headModule', 'baseModule', 'evaluateR1Only', 'factsFromListFiles', 'extractTier']) {
    assert.ok(!block.includes(banned), `inline block must not reference ${banned}`);
  }
});

test('r1FallbackCheck calls the inline fallback, not the head module', () => {
  const fn = workflow.slice(workflow.indexOf('async function r1FallbackCheck'), workflow.indexOf('if (baseConfigText === null)'));
  assert.match(fn, /inlineR1Fallback\(files, pr\.body, config\)/);
  assert.ok(!fn.includes('headModule'), 'r1FallbackCheck must not use headModule');
});

test('ATTACK ARM: a predicate-only PR that bumps TIER_CHECK_API and stubs evaluateR1Only still gets R1', () => {
  // The skew path is reached because the head bumped TIER_CHECK_API. Whatever the head module
  // now says (a stubbed evaluateR1Only returning no hits), the fallback never consults it.
  const inline = loadInline();
  const r = inline(files('operations/devops/tier-check-predicate.mjs'), 'Tier: T1 (small fix)', config);
  assert.equal(r.pass, false);
  assert.deepEqual(r.comments, ['R1: touches operations/devops/tier-check-predicate.mjs, must declare Tier: T2']);
});

test('CONTROL: a non-R1 PR on the same skew path stays a clean skip', () => {
  const r = loadInline()(files('lib/debate/aiAdapter.ts', 'docs/notes.md'), 'Tier: T0', config);
  assert.equal(r.pass, true);
  assert.deepEqual(r.comments, []);
});

test('an R1 path declared T2 passes', () => {
  const r = loadInline()(files('.github/ci/tier-paths.json'), 'Tier: T2 (gate config)', config);
  assert.equal(r.pass, true);
});

test('R1 globs match (Move-PiCredential*.ps1) and a missing tier line still fails', () => {
  const r = loadInline()(files('operations/devops/Move-PiCredentialToKeePass.ps1'), 'no tier line here', config);
  assert.equal(r.pass, false);
  assert.equal(r.tier, null);
});

test('reads the REST listFiles field `filename`, ignoring malformed entries', () => {
  const r = loadInline()([{ path: '.github/ci/tier-paths.json' }, null, { filename: 'README.md' }], 'Tier: T0', config);
  assert.equal(r.pass, true, 'an entry with only `path` (the GraphQL shape) must not count');
});

// ── e/291 SO C1: the head predicate is never imported anywhere in the step ──────────────────
function scriptCodeLines() {
  return workflow.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

test('C1: the whole step imports only the BASE copy (a temp file), never the head predicate', () => {
  const code = scriptCodeLines();
  const imports = code.match(/import\([^)]*\)/g) ?? [];
  assert.deepEqual(imports, ['import(pathToFileURL(predicatePath)'], `unexpected imports: ${imports.join(' | ')}`);
  assert.ok(!code.includes('headModule'), 'no headModule binding may exist');
  assert.match(code, /readFileSync\(path\.join\(process\.env\.GITHUB_WORKSPACE, 'operations', 'devops', 'tier-check-predicate\.mjs'\), 'utf8'\)/,
    'the head predicate is read as TEXT');
  assert.match(code, /baseModule\.checkApiVersion\(baseModule\.TIER_CHECK_API, headApi\)/, 'the version check runs base code');
});

test('C1: the head API is parsed from text; anything malformed reads as null (forces the skew path)', () => {
  const src = /\/(\^export const TIER_CHECK_API[^\n]*?)\/m\.exec/.exec(workflow);
  assert.ok(src, 'the fixed regex must be present in the workflow');
  const re = new RegExp(src[1], 'm');
  const parse = (t) => { const m = re.exec(t); return m ? Number(m[1]) : null; };
  assert.equal(parse('// x\nexport const TIER_CHECK_API = 3;\n'), 3);
  assert.equal(parse('export const TIER_CHECK_API = globalThis.x;'), null, 'a computed value must not parse');
  assert.equal(parse('export let TIER_CHECK_API = 3;'), null);
  assert.equal(parse('  export const TIER_CHECK_API = 3;'), null, 'must be a top-level declaration at line start');
  assert.equal(parse(''), null);
});

// ── e/291 SO C2: a rename away from an R1 path is still an R1 change ──────────────────────
test('C2: a rename AWAY from an R1 path, declared T1, fails (inline fallback)', () => {
  const renamed = [{ filename: 'docs/old-tier-paths.json', previous_filename: '.github/ci/tier-paths.json', status: 'renamed' }];
  const r = loadInline()(renamed, 'Tier: T1', config);
  assert.equal(r.pass, false);
  assert.deepEqual(r.comments, ['R1: touches .github/ci/tier-paths.json, must declare Tier: T2']);
});

test('C2: factsFromListFiles (main path) also judges the previous name of a rename', async () => {
  const { factsFromListFiles, checkR1 } = await import('./tier-check-predicate.mjs');
  const { paths } = factsFromListFiles([{ filename: 'docs/x.yml', previous_filename: '.github/workflows/tier-check.yml', patch: '@@' }]);
  assert.deepEqual(paths, ['docs/x.yml', '.github/workflows/tier-check.yml']);
  assert.equal(checkR1(paths, config), '.github/workflows/tier-check.yml');
});

// ── e/291 SO C3: inline fallback and checkR1 agree on every entry and near-miss ──────────
test('C3: inlineR1Fallback agrees with the predicate checkR1 on every r1 entry, glob sample and near-miss', async () => {
  const { checkR1 } = await import('./tier-check-predicate.mjs');
  const inline = loadInline();
  const candidates = new Set();
  for (const p of config.r1Paths) {
    for (const v of [p, `${p}.bak`, `x/${p}`, p.toUpperCase(), p.slice(1), `${p}/`]) candidates.add(v);
  }
  for (const g of config.r1Globs ?? []) {
    for (const fill of ['', 'X', 'a/b', '.ps1']) candidates.add(g.split('*').join(fill));
    candidates.add(`x/${g.split('*').join('Y')}`);
  }
  assert.ok(candidates.size > 30, 'the parity set must be substantial');
  for (const p of candidates) {
    const fromPredicate = checkR1([p], config) !== null;
    const fromInline = !inline(files(p), 'Tier: T1', config).pass;
    assert.equal(fromInline, fromPredicate, `parity broken for "${p}": inline=${fromInline} predicate=${fromPredicate}`);
  }
});
