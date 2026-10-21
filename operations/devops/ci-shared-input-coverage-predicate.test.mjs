// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCoverage, formatCoverageComment, formatCoverageSummary } from './ci-shared-input-coverage-predicate.mjs';

const REGISTRY = {
  entries: [
    { path: 'tests/fixtures/**', consumerJobs: ['powershell', 'electron', 'lib'] },
    { path: 'ai-models.json', consumerJobs: ['powershell', 'electron', 'debate'] },
  ],
};

test('evaluateCoverage: a registered path with all groups true is fully covered (clean)', () => {
  const r = evaluateCoverage(
    REGISTRY,
    ['tests/fixtures/source-identity-cases.json'],
    { powershell: 'true', electron: 'true', lib: 'true' },
  );
  assert.deepEqual(r.underCovered, []);
});

test('evaluateCoverage: #3546 shape -- electron and lib both missing is flagged', () => {
  const r = evaluateCoverage(
    REGISTRY,
    ['tests/fixtures/source-identity-cases.json'],
    { powershell: 'true', electron: 'false', lib: 'false' },
  );
  assert.equal(r.underCovered.length, 1);
  assert.equal(r.underCovered[0].path, 'tests/fixtures/**');
  assert.equal(r.underCovered[0].matchedFile, 'tests/fixtures/source-identity-cases.json');
  assert.deepEqual(r.underCovered[0].missingGroups, ['electron', 'lib']);
});

test('evaluateCoverage: partial coverage -- only the missing group is listed, not the covered one', () => {
  const r = evaluateCoverage(
    REGISTRY,
    ['tests/fixtures/source-identity-cases.json'],
    { powershell: 'true', electron: 'true', lib: 'false' },
  );
  assert.deepEqual(r.underCovered[0].missingGroups, ['lib']);
});

test('evaluateCoverage: an unregistered changed path produces no findings', () => {
  const r = evaluateCoverage(REGISTRY, ['README.md'], { powershell: 'false', electron: 'false' });
  assert.deepEqual(r.underCovered, []);
});

test('evaluateCoverage: a missing filter-output key is treated as not-true (under-covered)', () => {
  const r = evaluateCoverage(
    REGISTRY,
    ['ai-models.json'],
    { powershell: 'true' }, // electron/debate keys absent entirely
  );
  assert.deepEqual(r.underCovered[0].missingGroups, ['electron', 'debate']);
});

test('evaluateCoverage: multiple registered paths changed in one PR each report independently', () => {
  const r = evaluateCoverage(
    REGISTRY,
    ['tests/fixtures/source-identity-cases.json', 'ai-models.json'],
    { powershell: 'true', electron: 'false', lib: 'true', debate: 'false' },
  );
  assert.equal(r.underCovered.length, 2);
  const paths = r.underCovered.map((h) => h.path).sort();
  assert.deepEqual(paths, ['ai-models.json', 'tests/fixtures/**']);
});

test('evaluateCoverage: empty registry or empty changed-paths never throws, always clean', () => {
  assert.deepEqual(evaluateCoverage({ entries: [] }, ['tests/fixtures/x.json'], {}).underCovered, []);
  assert.deepEqual(evaluateCoverage(REGISTRY, [], {}).underCovered, []);
  assert.deepEqual(evaluateCoverage(null, null, null).underCovered, []);
});

test('formatCoverageComment: null when clean, non-null naming the file and missing groups otherwise', () => {
  assert.equal(formatCoverageComment([]), null);
  assert.equal(formatCoverageComment(null), null);
  const body = formatCoverageComment([{ path: 'tests/fixtures/**', matchedFile: 'tests/fixtures/x.json', missingGroups: ['electron', 'lib'] }]);
  assert.match(body, /tests\/fixtures\/x\.json/);
  assert.match(body, /electron/);
  assert.match(body, /lib/);
  assert.match(body, /advisory and never blocks a merge/);
});

test('formatCoverageSummary: always produces a table, clean or not', () => {
  const clean = formatCoverageSummary([]);
  assert.match(clean, /All registered shared inputs are covered/);
  const dirty = formatCoverageSummary([{ path: 'tests/fixtures/**', matchedFile: 'tests/fixtures/x.json', missingGroups: ['electron'] }]);
  assert.match(dirty, /tests\/fixtures\/x\.json/);
  assert.match(dirty, /electron/);
});
