// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Run: node --test operations/devops/pr-contexts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectAllContexts } from './pr-contexts.mjs';
import { checkVerdict } from './dependabot-enqueue-sweep.mjs';

const run = (name) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' });
const page = (names, next) => ({
  nodes: names.map(run),
  pageInfo: next ? { hasNextPage: true, endCursor: next } : { hasNextPage: false, endCursor: null },
});
const quiet = () => { const w = console.warn; console.warn = () => {}; return () => { console.warn = w; }; };

test('single page: returned as-is, complete, no fetch', () => {
  const r = collectAllContexts(page(['a', 'b']), () => assert.fail('must not fetch'));
  assert.deepEqual(r.nodes.map((n) => n.name), ['a', 'b']);
  assert.equal(r.complete, true);
});

test('#4475 regression: ci-gate on page 2 is found, so the verdict is success, not missing', () => {
  const first = page(Array.from({ length: 100 }, (_, i) => `job-${i}`), 'c1');
  const pages = { c1: page(['CodeQL Analysis', 'ci-gate']) };
  assert.equal(checkVerdict(first.nodes, 'ci-gate'), 'missing'); // the old, first-page-only read
  const r = collectAllContexts(first, (cursor) => pages[cursor]);
  assert.equal(r.complete, true);
  assert.equal(r.nodes.length, 102);
  assert.equal(checkVerdict(r.nodes, 'ci-gate'), 'success');
});

test('follows several pages in cursor order', () => {
  const seen = [];
  const pages = { c1: page(['b'], 'c2'), c2: page(['c']) };
  const r = collectAllContexts(page(['a'], 'c1'), (c) => { seen.push(c); return pages[c]; });
  assert.deepEqual(seen, ['c1', 'c2']);
  assert.deepEqual(r.nodes.map((n) => n.name), ['a', 'b', 'c']);
});

test('page fetch failure: keeps what was read, marks incomplete (fails closed)', () => {
  const restore = quiet();
  try {
    const r = collectAllContexts(page(['a'], 'c1'), () => { throw new Error('boom'); });
    assert.equal(r.complete, false);
    assert.deepEqual(r.nodes.map((n) => n.name), ['a']);
    assert.equal(checkVerdict(r.nodes, 'ci-gate'), 'missing');
  } finally { restore(); }
});

test('page cap: stops at maxPages and marks incomplete', () => {
  const restore = quiet();
  try {
    let calls = 0;
    const r = collectAllContexts(page(['p0'], 'c'), () => { calls++; return page([`p${calls}`], 'c'); }, { maxPages: 3 });
    assert.equal(calls, 2);
    assert.equal(r.complete, false);
    assert.equal(r.nodes.length, 3);
  } finally { restore(); }
});

test('missing or empty connection: no nodes, complete', () => {
  assert.deepEqual(collectAllContexts(undefined, () => assert.fail()), { nodes: [], complete: true });
});
