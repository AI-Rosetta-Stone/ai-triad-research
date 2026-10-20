import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBudgets, countLinesAndWords } from './check-agents-md-budget.mjs';

test('countLinesAndWords matches `wc -l` semantics (trailing newline not an extra line)', () => {
  const { lines, words } = countLinesAndWords('one two\nthree\n');
  assert.equal(lines, 2);
  assert.equal(words, 3);
});

test('countLinesAndWords counts a final line with no trailing newline', () => {
  const { lines, words } = countLinesAndWords('one two\nthree');
  assert.equal(lines, 2);
  assert.equal(words, 3);
});

test('countLinesAndWords handles an empty file', () => {
  const { lines, words } = countLinesAndWords('');
  assert.equal(lines, 0);
  assert.equal(words, 0);
});

test('file exactly at budget produces no violation', () => {
  const text = Array(179).fill('word').join('\n');
  const budgets = [{ path: 'AGENTS.md', max_lines: 179, max_words: 2012 }];
  const { violations, missing } = checkBudgets(budgets, () => text, () => true);
  assert.equal(violations.length, 0);
  assert.equal(missing.length, 0);
});

test('file one line over budget warns with delta=1', () => {
  const text = Array(180).fill('word').join('\n'); // 180 lines, 180 words — over the 179-line budget
  const budgets = [{ path: 'AGENTS.md', max_lines: 179, max_words: 2012 }];
  const { violations } = checkBudgets(budgets, () => text, () => true);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].path, 'AGENTS.md');
  assert.equal(violations[0].deltaLines, 1);
  assert.equal(violations[0].deltaWords, 0);
});

test('file over on words only is still flagged', () => {
  const text = Array(2013).fill('w').join(' '); // 1 line, 2013 words — over the 2012-word budget
  const budgets = [{ path: 'AGENTS.md', max_lines: 179, max_words: 2012 }];
  const { violations } = checkBudgets(budgets, () => text, () => true);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].deltaLines, 0);
  assert.equal(violations[0].deltaWords, 1);
});

test('missing budget-listed file is reported, not a crash, and is NOT a violation (C2)', () => {
  const budgets = [{ path: 'nonexistent/AGENTS.md', max_lines: 10, max_words: 10 }];
  const { violations, missing } = checkBudgets(budgets, () => { throw new Error('should not be called'); }, () => false);
  assert.equal(violations.length, 0); // a missing file does not fail the check (exit 0)
  assert.equal(missing.length, 1);
  assert.equal(missing[0].path, 'nonexistent/AGENTS.md');
});

test('one present-and-over-budget file plus one missing file: both surfaced independently', () => {
  const budgets = [
    { path: 'present.md', max_lines: 1, max_words: 1 },
    { path: 'missing.md', max_lines: 1, max_words: 1 },
  ];
  const readFile = (p) => (p.endsWith('present.md') ? 'one\ntwo\n' : (() => { throw new Error('unreachable'); })());
  const fileExists = (p) => p.endsWith('present.md');
  const { violations, missing } = checkBudgets(budgets, readFile, fileExists);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].path, 'present.md');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].path, 'missing.md');
});
