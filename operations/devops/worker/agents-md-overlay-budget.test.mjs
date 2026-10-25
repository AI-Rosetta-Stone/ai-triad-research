// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOverlayBudgets } from './agents-md-overlay-budget.mjs';

test('within budget — silent (no violations, no unlisted)', () => {
  const live = ['role/AGENTS.md'];
  const budgets = [{ path: 'role/AGENTS.md', max_lines: 10, max_words: 50 }];
  const text = Array(10).fill('one two three four five').join('\n');
  const { violations, missing, unlisted } = checkOverlayBudgets(live, budgets, () => text);
  assert.equal(violations.length, 0);
  assert.equal(missing.length, 0);
  assert.equal(unlisted.length, 0);
});

test('over budget — violation named with path and delta (t/4329 AC2 arm 1)', () => {
  const live = ['role/AGENTS.md'];
  const budgets = [{ path: 'role/AGENTS.md', max_lines: 5, max_words: 50 }];
  const text = Array(7).fill('one').join('\n'); // 7 lines, over the 5-line budget
  const { violations } = checkOverlayBudgets(live, budgets, () => text);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].path, 'role/AGENTS.md');
  assert.equal(violations[0].deltaLines, 2);
});

test('unlisted — a live overlay file absent from the budget JSON is its own warning, not silently skipped (Quality review note 2)', () => {
  const live = ['role/AGENTS.md', 'new-role/AGENTS.md'];
  const budgets = [{ path: 'role/AGENTS.md', max_lines: 10, max_words: 50 }];
  const text = 'one\ntwo\n';
  const { violations, missing, unlisted } = checkOverlayBudgets(live, budgets, () => text);
  assert.equal(violations.length, 0);
  assert.equal(missing.length, 0);
  assert.deepEqual(unlisted, ['new-role/AGENTS.md']);
});

test('a budget entry for a file no longer live is reported as missing, not a phantom violation', () => {
  const live = ['role/AGENTS.md'];
  const budgets = [
    { path: 'role/AGENTS.md', max_lines: 10, max_words: 50 },
    { path: 'removed-role/AGENTS.md', max_lines: 10, max_words: 50 },
  ];
  const text = 'one\ntwo\n';
  const { violations, unlisted } = checkOverlayBudgets(live, budgets, () => text);
  assert.equal(violations.length, 0);
  assert.equal(unlisted.length, 0);
});

test('over budget AND unlisted at the same time — both surfaced independently', () => {
  const live = ['role/AGENTS.md', 'new-role/AGENTS.md'];
  const budgets = [{ path: 'role/AGENTS.md', max_lines: 1, max_words: 50 }];
  const text = 'one\ntwo\nthree\n';
  const { violations, unlisted } = checkOverlayBudgets(live, budgets, () => text);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].path, 'role/AGENTS.md');
  assert.deepEqual(unlisted, ['new-role/AGENTS.md']);
});
