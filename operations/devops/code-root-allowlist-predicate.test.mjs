// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateRootAllowlist, formatRootAllowlistComment,
  evaluateVitestIncludeCoverage, extractIncludeGlobs, extractRootOption, resolveIncludeGlobs,
} from './code-root-allowlist-predicate.mjs';

const MAIN_ROOTS = ['taxonomy-editor', 'poviewer', 'summary-viewer', 'workflow-app', 'lib', 'scripts', 'operations', 'tests', 'docs'];

// ── Arm 1: root allowlist ──

test('REAL SHAPE (#4167): a code file under a stray top-level root not on main is flagged', () => {
  const { violations } = evaluateRootAllowlist(MAIN_ROOTS, ['src/renderer/navigation/navHistory.ts']);
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0], { path: 'src/renderer/navigation/navHistory.ts', root: 'src' });
});

test('REAL SHAPE (#4167): the matching .test.ts sibling is flagged too', () => {
  const { violations } = evaluateRootAllowlist(MAIN_ROOTS, ['src/renderer/navigation/navHistory.test.ts']);
  assert.equal(violations.length, 1);
});

test('NOT flagged: a file under an existing main root', () => {
  const { violations } = evaluateRootAllowlist(MAIN_ROOTS, ['taxonomy-editor/src/renderer/navigation/navHistory.ts']);
  assert.equal(violations.length, 0);
});

test('NOT flagged: a bare repo-root file (no top-level directory) is out of scope for this check', () => {
  const { violations } = evaluateRootAllowlist(MAIN_ROOTS, ['vite.config.ts', 'package.json']);
  assert.equal(violations.length, 0);
});

test('NOT flagged: a non-code file under a stray root (e.g. a stray docs asset) is not this check\'s concern', () => {
  const { violations } = evaluateRootAllowlist(MAIN_ROOTS, ['stray/notes.md', 'stray/image.png']);
  assert.equal(violations.length, 0);
});

test('multiple violations are all reported, not just the first', () => {
  const { violations } = evaluateRootAllowlist(MAIN_ROOTS, [
    'src/a.ts', 'src/b.test.ts', 'taxonomy-editor/src/ok.ts', 'newroot/c.py',
  ]);
  assert.equal(violations.length, 3);
  assert.deepEqual(violations.map((v) => v.path).sort(), ['newroot/c.py', 'src/a.ts', 'src/b.test.ts']);
});

test('clean PR (no violations) returns an empty array, not null/undefined', () => {
  const { violations } = evaluateRootAllowlist(MAIN_ROOTS, ['taxonomy-editor/src/a.ts', 'docs/readme.md']);
  assert.deepEqual(violations, []);
});

test('formatRootAllowlistComment: null on a clean result (no comment to post)', () => {
  assert.equal(formatRootAllowlistComment([]), null);
  assert.equal(formatRootAllowlistComment(null), null);
});

test('formatRootAllowlistComment: names the path and the stray root, never "arm it"-style wrong remedy', () => {
  const body = formatRootAllowlistComment([{ path: 'src/a.ts', root: 'src' }]);
  assert.match(body, /src\/a\.ts/);
  assert.match(body, /src\//);
  assert.match(body, /advisory/i);
});

// ── Arm 2 (optional): vitest include coverage ──

test('extractIncludeGlobs: pulls string-literal globs from a simple include array', () => {
  const configText = `export default { test: { include: ['src/**/*.test.ts'] } }`;
  assert.deepEqual(extractIncludeGlobs(configText), ['src/**/*.test.ts']);
});

test('extractIncludeGlobs: multiple entries, mixed quote styles', () => {
  const configText = `include: ["src/**/*.test.ts", 'src/**/*.test.tsx']`;
  assert.deepEqual(extractIncludeGlobs(configText), ['src/**/*.test.ts', 'src/**/*.test.tsx']);
});

test('extractIncludeGlobs: no include array present -> null (not an empty array -- "can\'t evaluate", not "covers nothing")', () => {
  assert.equal(extractIncludeGlobs('export default { test: {} }'), null);
  assert.equal(extractIncludeGlobs(''), null);
  assert.equal(extractIncludeGlobs(null), null);
});

test('evaluateVitestIncludeCoverage: a test file matching a resolved include glob is covered', () => {
  const { uncovered } = evaluateVitestIncludeCoverage(
    ['poviewer/src/foo/bar.test.ts'],
    ['poviewer/src/**/*.test.ts'],
  );
  assert.deepEqual(uncovered, []);
});

test('REAL SHAPE: a test file under a recognized root but matching no resolved include glob is uncovered', () => {
  const { uncovered } = evaluateVitestIncludeCoverage(
    ['lib/orphan/weird.test.ts'],
    ['poviewer/src/**/*.test.ts', 'summary-viewer/src/**/*.test.ts'],
  );
  assert.deepEqual(uncovered, ['lib/orphan/weird.test.ts']);
});

test('evaluateVitestIncludeCoverage: multiple apps, each only matches its own resolved glob', () => {
  const { uncovered } = evaluateVitestIncludeCoverage(
    ['poviewer/src/foo/a.test.ts', 'summary-viewer/src/foo/b.test.ts'],
    ['poviewer/src/**/*.test.ts', 'summary-viewer/src/**/*.test.ts'],
  );
  assert.deepEqual(uncovered, []);
});

test('evaluateVitestIncludeCoverage: zero-intermediate-directory ** match (standard semantics, unlike the shared matchGlob)', () => {
  const { uncovered } = evaluateVitestIncludeCoverage(['poviewer/src/bar.test.ts'], ['poviewer/src/**/*.test.ts']);
  assert.deepEqual(uncovered, []);
});

// ── resolveIncludeGlobs / extractRootOption: the taxonomy-editor `../../../lib/X/**` real shape ──

test('REAL SHAPE: taxonomy-editor\'s root:"src/renderer" + "../../../lib/debate/**" resolves to "lib/debate/**", not a false positive', () => {
  const resolved = resolveIncludeGlobs('taxonomy-editor', 'src/renderer', ['../../../lib/debate/**/*.test.ts']);
  assert.deepEqual(resolved, ['lib/debate/**/*.test.ts']);
  const { uncovered } = evaluateVitestIncludeCoverage(['lib/debate/adaptiveThreshold.test.ts'], resolved);
  assert.deepEqual(uncovered, [], 'an already-covered lib/debate test must NOT be flagged');
});

test('resolveIncludeGlobs: no root option -> base is the config\'s own directory', () => {
  const resolved = resolveIncludeGlobs('poviewer', null, ['src/**/*.test.ts']);
  assert.deepEqual(resolved, ['poviewer/src/**/*.test.ts']);
});

test('extractRootOption: pulls a simple root: option', () => {
  assert.equal(extractRootOption(`export default { root: 'src/renderer', test: {} }`), 'src/renderer');
});

test('extractRootOption: absent -> null, never an empty string (caller must use configDir as base)', () => {
  assert.equal(extractRootOption('export default { test: {} }'), null);
  assert.equal(extractRootOption(''), null);
  assert.equal(extractRootOption(null), null);
});
