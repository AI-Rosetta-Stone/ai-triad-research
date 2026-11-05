// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseActionPins } from './check-action-pin-resolution.mjs';

test('plain-key `uses:` form is parsed', () => {
  const pins = parseActionPins(new Map([['a.yml', '      uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n']]));
  assert.equal(pins.length, 1);
  assert.equal(pins[0].ownerRepo, 'actions/checkout');
  assert.equal(pins[0].sha, '3d3c42e5aac5ba805825da76410c181273ba90b1');
  assert.equal(pins[0].file, 'a.yml');
  assert.equal(pins[0].line, 1);
});

test('compact list-item `- uses:` form is parsed', () => {
  const pins = parseActionPins(new Map([['a.yml', '    - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n']]));
  assert.equal(pins.length, 1);
  assert.equal(pins[0].ownerRepo, 'actions/checkout');
});

test('a subpath ref (owner/repo/subpath@sha) reduces to owner/repo for resolution', () => {
  // The REAL INCIDENT SHAPE (t/4866): actions/cache/restore@<sha> and actions/cache/save@<sha>
  // both pinned the SAME wrong SHA -- an action/upload-artifact commit, not actions/cache's.
  const pins = parseActionPins(new Map([['a.yml', [
    '      - uses: actions/cache/restore@cf430e03c59eef1ebbf50be9fd9bb90e33e8bbdb',
    '      - uses: actions/cache/save@cf430e03c59eef1ebbf50be9fd9bb90e33e8bbdb',
  ].join('\n')]]));
  // Deduped: same (ownerRepo, sha) pair appears twice across two subpaths -- one entry.
  assert.equal(pins.length, 1);
  assert.equal(pins[0].ownerRepo, 'actions/cache');
  assert.equal(pins[0].sha, 'cf430e03c59eef1ebbf50be9fd9bb90e33e8bbdb');
});

test('a non-SHA ref (tag or branch) is ignored -- that is workflow-lint.py\'s job, not this one\'s', () => {
  const pins = parseActionPins(new Map([['a.yml', '      uses: actions/checkout@v4\n']]));
  assert.equal(pins.length, 0);
});

test('the same (ownerRepo, sha) pair across different files dedups to one entry, keeping the first occurrence', () => {
  const pins = parseActionPins(new Map([
    ['a.yml', '      uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n'],
    ['b.yml', '      uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n'],
  ]));
  assert.equal(pins.length, 1);
  assert.equal(pins[0].file, 'a.yml');
});

test('different SHAs for the same action are both reported (not deduped by ownerRepo alone)', () => {
  const pins = parseActionPins(new Map([['a.yml', [
    '      uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    '      uses: actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ].join('\n')]]));
  assert.equal(pins.length, 2);
});

test('a line with no uses: key produces nothing', () => {
  const pins = parseActionPins(new Map([['a.yml', 'run: echo hi\n']]));
  assert.equal(pins.length, 0);
});
