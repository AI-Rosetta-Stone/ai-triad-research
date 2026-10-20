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

function extractRequirementsNoteBlock() {
  const start = workflow.indexOf('// BEGIN requirements-note');
  const end = workflow.indexOf('// END requirements-note');
  assert.ok(start >= 0 && end > start, 'requirements-note markers must exist in tier-check.yml');
  return workflow.slice(start, end);
}

function loadTierRequirementsNote() {
  // eslint-disable-next-line no-new-func
  return new Function(`${extractRequirementsNoteBlock()}\nreturn tierRequirementsNote;`)();
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

// t/4182: the import() check above only ever caught `import()`. A `require(` or a
// `createRequire(...)(...)` of the head predicate text (e.g. the path read at
// `GITHUB_WORKSPACE/.../tier-check-predicate.mjs`) would execute the untrusted head code just
// as surely, and this test previously would not have noticed. Pure, so a fixture string can
// drive it without a real workflow file.
function structureIssues(code) {
  const issues = [];
  const imports = code.match(/import\([^)]*\)/g) ?? [];
  if (!(imports.length === 1 && imports[0] === 'import(pathToFileURL(predicatePath)')) {
    issues.push(`unexpected imports: ${imports.join(' | ')}`);
  }
  if (code.includes('headModule')) issues.push('no headModule binding may exist');
  const headRequires = [...code.matchAll(/require\(([^)]*)\)/g)].filter(([, arg]) => arg.includes('tier-check-predicate'));
  if (headRequires.length) issues.push(`head predicate must not be require()'d: ${headRequires.map((m) => m[0]).join(', ')}`);
  if (code.includes('createRequire')) {
    issues.push("createRequire must not appear (it can dynamically require the head predicate, bypassing the text-read discipline)");
  }
  return issues;
}

test('C1: the whole step imports only the BASE copy (a temp file), never the head predicate', () => {
  const code = scriptCodeLines();
  assert.deepEqual(structureIssues(code), []);
  assert.match(code, /readFileSync\(path\.join\(process\.env\.GITHUB_WORKSPACE, 'operations', 'devops', 'tier-check-predicate\.mjs'\), 'utf8'\)/,
    'the head predicate is read as TEXT');
  assert.match(code, /baseModule\.checkApiVersion\(baseModule\.TIER_CHECK_API, headApi\)/, 'the version check runs base code');
});

test('CONTROL: legitimate require() of node builtins in the step preamble does not false-positive', () => {
  // require('url'), require('child_process'), require('fs'), require('os'), require('path')
  // are all present in the real step and must not trip the head-require check.
  const code = scriptCodeLines();
  assert.ok(/require\('url'\)/.test(code) && /require\('path'\)/.test(code), 'fixture precondition: builtin requires are present');
  assert.deepEqual(structureIssues(code), []);
});

test('RED ARM: a fixture require()-ing the head predicate path fails the structure check', () => {
  const fixture = `
    const { pathToFileURL } = require('url');
    import(pathToFileURL(predicatePath));
    const headModuleBad = require(path.join(process.env.GITHUB_WORKSPACE, 'operations', 'devops', 'tier-check-predicate.mjs'));
  `;
  const issues = structureIssues(fixture);
  assert.ok(issues.some((i) => i.includes("head predicate must not be require()'d")), `expected a head-require issue, got: ${issues.join(' | ')}`);
});

test('RED ARM: a fixture using createRequire fails the structure check', () => {
  const fixture = `
    const { createRequire } = require('module');
    const req = createRequire(import.meta.url);
    import(pathToFileURL(predicatePath));
    req('operations/devops/tier-check-predicate.mjs');
  `;
  const issues = structureIssues(fixture);
  assert.ok(issues.some((i) => i.includes('createRequire')), `expected a createRequire issue, got: ${issues.join(' | ')}`);
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

// ── t/4343: early visibility into what a declared tier still needs before merge ────────────
test('tierRequirementsNote: T1 names the reviewer-App approval (comment accepted during transition) and the enforcing gate', () => {
  const note = loadTierRequirementsNote()('T1');
  assert.match(note, /Approved \(<role>\):/);
  assert.match(note, /reviewer-App review/);
  assert.match(note, /accepted during the transition/);
  assert.match(note, /t1-approval-guard/);
});

test('tierRequirementsNote: T2 names the TL approval path and the PI-only exception, not a bare "PI"', () => {
  const note = loadTierRequirementsNote()('T2');
  assert.match(note, /Second Opinion/);
  assert.match(note, /consult-hold/);
  assert.match(note, /\bTL\b/);
  assert.match(note, /dissents or didn't review/);
  assert.match(note, /PI-only decision/);
  assert.match(note, /consult-hold-guard/);
});

test('both notes link to the AGENTS.md Change Tiers heading, and that heading still exists', () => {
  const t1 = loadTierRequirementsNote()('T1');
  const t2 = loadTierRequirementsNote()('T2');
  const anchor = 'AGENTS.md#change-tiers-and-decision-rights-t4092-pi-approved-2026-10-07';
  assert.ok(t1.includes(anchor), 'T1 note must link the Change Tiers heading');
  assert.ok(t2.includes(anchor), 'T2 note must link the Change Tiers heading');

  const rootAgentsMd = readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(rootAgentsMd, /^## Change Tiers and Decision Rights \(t\/4092, PI-approved 2026-10-07\)$/m,
    'the heading the notes link to must still exist verbatim in root AGENTS.md -- a rename here must fail this test, not drift silently');
});

test('CONTROL: tierRequirementsNote returns null for T0 and for an undeclared tier', () => {
  const fn = loadTierRequirementsNote();
  assert.equal(fn('T0'), null);
  assert.equal(fn(null), null);
  assert.equal(fn(undefined), null);
});
