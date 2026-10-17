// .github/scripts/test-electron-matrix-membership.test.mjs
// Author-run: `node --test .github/scripts/test-electron-matrix-membership.test.mjs`
// (matches the operations/devops/*.test.mjs predicate-test convention.)
//
// t/4236 (t/3897 GV follow-up): the first draft of
// test-electron-matrix-membership.mjs read a hard-coded duplicate matrix list instead of the
// real one, so it always passed (t/3897#6) -- nothing committed would have caught that
// regression. These fixtures exercise checkMatrixMembership() directly, one case per
// decision site, against synthetic ci.yml text -- no real checkout needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMatrixMembership } from './test-electron-matrix-membership.mjs';

const CLEAN_FILTER = `
jobs:
  changes:
    steps:
      - id: filter
        with:
          filters: |
            electron:
              - 'taxonomy-editor/**'
              - 'poviewer/**'
              - 'summary-viewer/**'
`;

const CLEAN_JOB = `
  test-electron:
    needs: [changes]
    strategy:
      matrix:
        app: [taxonomy-editor, poviewer, summary-viewer]
    steps:
      - uses: actions/checkout

  next-job:
    runs-on: ubuntu-latest
`;

const CLEAN_YML = CLEAN_FILTER + CLEAN_JOB;
const CLEAN_DIRS = ['taxonomy-editor', 'poviewer', 'summary-viewer'];

test('clean: matrix matches build-script dirs and the electron filter -> exit 0', () => {
  const { exitCode, messages } = checkMatrixMembership(CLEAN_YML, CLEAN_DIRS);
  assert.equal(exitCode, 0);
  assert.deepEqual(messages, []);
});

test('1. a build-script app missing from the matrix -> exit 1', () => {
  const dirsWithExtra = [...CLEAN_DIRS, 'workflow-app'];
  const { exitCode, messages } = checkMatrixMembership(CLEAN_YML, dirsWithExtra);
  assert.equal(exitCode, 1);
  assert.ok(messages.some((m) => m.includes('workflow-app') && m.includes('NOT in the test-electron matrix')));
});

test('2. a matrix app with no build script -> exit 1', () => {
  const ymlWithExtraApp = CLEAN_FILTER + `
  test-electron:
    needs: [changes]
    strategy:
      matrix:
        app: [taxonomy-editor, poviewer, summary-viewer, not-a-real-app]
    steps:
      - uses: actions/checkout
`;
  const { exitCode, messages } = checkMatrixMembership(ymlWithExtraApp, CLEAN_DIRS);
  assert.equal(exitCode, 1);
  assert.ok(messages.some((m) => m.includes('not-a-real-app') && m.includes('has no build script')));
});

test('3. a matrix app missing from the electron: filter -> exit 1', () => {
  const filterMissingOne = `
jobs:
  changes:
    steps:
      - id: filter
        with:
          filters: |
            electron:
              - 'taxonomy-editor/**'
              - 'poviewer/**'
`;
  const yml = filterMissingOne + CLEAN_JOB;
  const { exitCode, messages } = checkMatrixMembership(yml, CLEAN_DIRS);
  assert.equal(exitCode, 1);
  assert.ok(messages.some((m) => m.includes('summary-viewer') && m.includes('electron: path filter')));
});

test('4. a decoy app: [...] before test-electron is ignored -- the real matrix is still read', () => {
  const decoyJob = `
  decoy-earlier-job:
    strategy:
      matrix:
        app: [decoy-wrong-app]
    steps:
      - run: echo hi
`;
  const yml = CLEAN_FILTER + decoyJob + CLEAN_JOB;
  const { exitCode, messages, matrix } = checkMatrixMembership(yml, CLEAN_DIRS);
  assert.equal(exitCode, 0);
  assert.deepEqual(messages, []);
  assert.deepEqual(matrix, [...CLEAN_DIRS].sort());
  assert.ok(!matrix.includes('decoy-wrong-app'));
});

test('5a. zero app: arrays inside test-electron -> exit 1', () => {
  const noMatrixJob = `
  test-electron:
    needs: [changes]
    strategy:
      matrix:
        os: [ubuntu-latest]
    steps:
      - uses: actions/checkout

  next-job:
    runs-on: ubuntu-latest
`;
  const yml = CLEAN_FILTER + noMatrixJob;
  const { exitCode, messages } = checkMatrixMembership(yml, CLEAN_DIRS);
  assert.equal(exitCode, 1);
  assert.ok(messages.some((m) => m.includes('found 0')));
});

test('5b. two app: arrays inside test-electron -> exit 1', () => {
  const twoMatrixJob = `
  test-electron:
    needs: [changes]
    strategy:
      matrix:
        app: [taxonomy-editor, poviewer, summary-viewer]
        app: [taxonomy-editor, poviewer, summary-viewer]
    steps:
      - uses: actions/checkout

  next-job:
    runs-on: ubuntu-latest
`;
  const yml = CLEAN_FILTER + twoMatrixJob;
  const { exitCode, messages } = checkMatrixMembership(yml, CLEAN_DIRS);
  assert.equal(exitCode, 1);
  assert.ok(messages.some((m) => m.includes('found 2')));
});

test('6a. a missing electron: filter -> exit 1', () => {
  const noFilter = `
jobs:
  changes:
    steps:
      - id: filter
        with:
          filters: |
            debate:
              - 'lib/debate/**'
`;
  const yml = noFilter + CLEAN_JOB;
  const { exitCode, messages } = checkMatrixMembership(yml, CLEAN_DIRS);
  assert.equal(exitCode, 1);
  assert.ok(messages.some((m) => m.includes('could not find the "electron:"')));
});

test('6b. an empty electron: filter -> exit 1', () => {
  const emptyFilter = `
jobs:
  changes:
    steps:
      - id: filter
        with:
          filters: |
            electron:
            debate:
              - 'lib/debate/**'
`;
  const yml = emptyFilter + CLEAN_JOB;
  const { exitCode, messages } = checkMatrixMembership(yml, CLEAN_DIRS);
  assert.equal(exitCode, 1);
  assert.ok(messages.some((m) => m.includes('parsed as empty')));
});

// ── Fault-arm (t/4236's explicit ask): prove these tests actually catch a regression ──
// Reproduces the t/3897#6 shape: the first draft read a hard-coded duplicate matrix list
// instead of parsing ci.yml, so it ALWAYS reported the same matrix regardless of what
// ci.yml actually said -- the exact "nothing committed would catch that regression" gap
// t/4236 exists to close. The tell: a correct implementation's matrix output MUST vary
// with ciYmlContent; a hard-coded one's never does. Case 4 (the decoy-array test above)
// is the one this would actually break -- a hard-coded list can't be "fooled" by a decoy
// (it never reads the file at all), so it would report success anywhere the real
// implementation requires real parsing, hiding exactly the regression this file guards.
test('fault-arm: a hard-coded matrix list is distinguishable from the real parse by matrix drift', () => {
  function brokenCheckMatrixMembership(_ciYmlContent, buildScriptDirs) {
    const matrix = ['taxonomy-editor', 'poviewer', 'summary-viewer'].sort(); // t/3897#6: hard-coded, ciYmlContent unused
    const missing = buildScriptDirs.filter((d) => !matrix.includes(d));
    return { exitCode: missing.length ? 1 : 0, messages: missing.length ? [`${missing.join(', ')} NOT in the test-electron matrix`] : [], matrix };
  }

  // Change ONLY ci.yml's matrix (add workflow-app to both it and buildScriptDirs, so a
  // CORRECT parse reads the new app and passes clean).
  const dirsWithExtra = [...CLEAN_DIRS, 'workflow-app'];
  const ymlWithExtraAppAndFilter = CLEAN_FILTER.replace(
    "- 'summary-viewer/**'",
    "- 'summary-viewer/**'\n              - 'workflow-app/**'",
  ) + `
  test-electron:
    needs: [changes]
    strategy:
      matrix:
        app: [taxonomy-editor, poviewer, summary-viewer, workflow-app]
    steps:
      - uses: actions/checkout
`;

  const real = checkMatrixMembership(ymlWithExtraAppAndFilter, dirsWithExtra);
  assert.equal(real.exitCode, 0, 'the real parse correctly reads workflow-app from ci.yml -- clean');

  const broken = brokenCheckMatrixMembership(ymlWithExtraAppAndFilter, dirsWithExtra);
  assert.equal(broken.exitCode, 1, 'the hard-coded version never read ci.yml, so it still reports workflow-app missing -- exactly the false positive t/3897#6 could never self-correct from');
});
