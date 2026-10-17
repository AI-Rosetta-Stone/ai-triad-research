// .github/scripts/check-filter-coverage.test.mjs
// Author-run: `node --test .github/scripts/check-filter-coverage.test.mjs`
//
// t/4140 (third occurrence of the class: t/2025, t/3189, t/4029). See t/4140#1 for the design
// note on why t/2025 is NOT replayed here (different filter mechanism and failure mode --
// codeql.yml's native on:pull_request:paths trigger, strand rather than false-green).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFiltersBlock, checkCoverage, deriveePythonRoots } from './check-filter-coverage.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const realCiYml = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
const realReadSets = JSON.parse(fs.readFileSync(path.join(repoRoot, '.github', 'ci', 'test-read-sets.json'), 'utf8'));

test('parseFiltersBlock extracts every job the real ci.yml declares, including python', () => {
  const filters = parseFiltersBlock(realCiYml);
  assert.ok(Array.isArray(filters.python), 'python filter must parse as an array');
  assert.ok(filters.python.includes('lib/debate/soul-docs/**'));
  assert.ok(filters.python.includes('research/comp-linguist/scripts/**'));
  assert.ok(Array.isArray(filters.container));
  assert.ok(Array.isArray(filters.electron));
});

test('CLEAN: the real ci.yml + real test-read-sets.json has zero violations', () => {
  const filters = parseFiltersBlock(realCiYml);
  const { exitCode, violations } = checkCoverage(filters, realReadSets);
  assert.equal(exitCode, 0, `unexpected violations: ${violations.join(' | ')}`);
  assert.deepEqual(violations, []);
});

test('RED ARM (both-arms acceptance): removing lib/debate/soul-docs/** from the python filter fails', () => {
  const filters = parseFiltersBlock(realCiYml);
  const brokenFilters = {
    ...filters,
    python: filters.python.filter((g) => g !== 'lib/debate/soul-docs/**'),
  };
  const { exitCode, violations } = checkCoverage(brokenFilters, realReadSets);
  assert.equal(exitCode, 1);
  assert.ok(violations.some((v) => v.includes("reads 'lib/debate/soul-docs/**'")));
});

test('a job with a declared read-set but no filter entry at all is flagged', () => {
  const filters = { python: ['scripts/**'] };
  const readSets = { 'nonexistent-job': ['some/path/**'] };
  const { exitCode, violations } = checkCoverage(filters, readSets);
  assert.equal(exitCode, 1);
  assert.ok(violations[0].includes('no paths-filter entry at all'));
});

test('the _comment key in test-read-sets.json is ignored, not treated as a job', () => {
  const filters = {};
  const readSets = { _comment: 'not a job' };
  const { exitCode, violations } = checkCoverage(filters, readSets);
  assert.equal(exitCode, 0);
  assert.deepEqual(violations, []);
});

// ── REPLAY: t/3189 and t/4029 (t/2025 does not fit this mechanism, see header) ──────────────
test('REPLAY (t/3189, commit c58842e3 parent state): python filter missing research/comp-linguist/scripts/** fails against today\'s read-set', () => {
  // Reconstructs the pre-fix python filter from c58842e3's diff: the entry simply did not exist.
  const preFixFilters = {
    python: [
      'scripts/**',
      '.github/ci/**',
      // research/comp-linguist/scripts/** NOT YET ADDED (t/3189 fix)
      'lib/debate/soul-docs/**',
      '.github/workflows/ci.yml',
    ],
  };
  const readSets = { python: realReadSets.python };
  const { exitCode, violations } = checkCoverage(preFixFilters, readSets);
  assert.equal(exitCode, 1, 'the pre-t/3189 filter must fail today\'s read-set check');
  assert.ok(violations.some((v) => v.includes("reads 'research/comp-linguist/scripts/**'")));
});

test('REPLAY (t/4029, commit 2b254516 parent state): python filter missing lib/debate/soul-docs/** fails against today\'s read-set', () => {
  // Reconstructs the pre-fix python filter from 2b254516's diff: the entry simply did not exist.
  const preFixFilters = {
    python: [
      'scripts/**',
      '.github/ci/**',
      'research/comp-linguist/scripts/**',
      'research/comp-linguist/tools/**',
      // lib/debate/soul-docs/** NOT YET ADDED (t/4029 fix)
      '.github/workflows/ci.yml',
    ],
  };
  const readSets = { python: realReadSets.python };
  const { exitCode, violations } = checkCoverage(preFixFilters, readSets);
  assert.equal(exitCode, 1, 'the pre-t/4029 filter must fail today\'s read-set check');
  assert.ok(violations.some((v) => v.includes("reads 'lib/debate/soul-docs/**'")));
});

// ── Derivation (best-effort, python) ─────────────────────────────────────────────────────────
test('deriveePythonRoots recovers the soul-docs path from an os.path.join literal chain', () => {
  const fixture = `
_HERE = os.path.dirname(os.path.abspath(__file__))
_SOUL_DIR = os.path.normpath(os.path.join(_HERE, "..", "..", "..", "lib", "debate", "soul-docs"))
`;
  const roots = deriveePythonRoots([fixture]);
  assert.ok(roots.includes('lib/debate/soul-docs'), `expected lib/debate/soul-docs, got: ${roots.join(', ')}`);
});

test('deriveePythonRoots drops a join where only one literal segment survives (not an actionable root)', () => {
  const fixture = `x = os.path.join(_HERE, some_var, "fixtures")`;
  const roots = deriveePythonRoots([fixture]);
  // _HERE and some_var are unresolved variables; "fixtures" alone is a filename/glob fragment
  // relative to an unresolved base, not a meaningful directory root -- must not be flagged.
  assert.deepEqual(roots, []);
});

test('deriveePythonRoots keeps a join when at least two literal segments survive', () => {
  const fixture = `x = os.path.join(_HERE, "fixtures", "golden")`;
  const roots = deriveePythonRoots([fixture]);
  assert.deepEqual(roots, ['fixtures/golden']);
});

test('the real test_render_soul_md.py derives a root covered by the declared python read-set', () => {
  const soulTestPath = path.join(repoRoot, 'research', 'comp-linguist', 'tools', 'test_render_soul_md.py');
  const content = fs.readFileSync(soulTestPath, 'utf8');
  const roots = deriveePythonRoots([content]);
  assert.ok(roots.includes('lib/debate/soul-docs'), `expected to derive lib/debate/soul-docs from the real file, got: ${roots.join(', ')}`);
  assert.ok(realReadSets.python.includes('lib/debate/soul-docs/**'), 'and it must already be declared');
});

// ── FAULT-ARM: prove the suite catches a hypothetical regression in checkCoverage itself ────
test('FAULT-ARM: a checkCoverage that ignores job filters entirely (always passes) is distinguishable', () => {
  function brokenCheckCoverage(_filtersByJob, _readSets) {
    return { exitCode: 0, violations: [] }; // t/3897#6-shaped: never actually checks anything
  }
  const filters = parseFiltersBlock(realCiYml);
  const brokenFilters = { ...filters, python: filters.python.filter((g) => g !== 'lib/debate/soul-docs/**') };

  const real = checkCoverage(brokenFilters, realReadSets);
  assert.equal(real.exitCode, 1, 'the real implementation correctly fails on the broken filter');

  const broken = brokenCheckCoverage(brokenFilters, realReadSets);
  assert.equal(broken.exitCode, 0, 'a stubbed-out implementation would have silently passed -- exactly what this suite exists to catch');
});
