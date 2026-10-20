import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBudgets, countLinesAndWords } from './check-agents-md-budget.mjs';

const fileAt = (lines, words) => ({
  lines: '\n'.repeat(Math.max(lines - 1, 0)),
  words: Array(words).fill('w').join(' '),
});

function fakeFs(contents) {
  return {
    read: (path) => contents[path],
    exists: (path) => path in contents,
  };
}

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
  const fs = fakeFs({ '/abs/AGENTS.md': text });
  const budgets = [{ path: 'AGENTS.md', max_lines: 179, max_words: 2012 }];
  const violations = checkBudgets(budgets, (p) => fs.read('/abs/AGENTS.md'), () => true);
  assert.equal(violations.length, 0);
});

test('file one line over budget warns with delta=1', () => {
  const text = Array(180).fill('word').join('\n'); // 180 lines, 180 words — over the 179-line budget
  const budgets = [{ path: 'AGENTS.md', max_lines: 179, max_words: 2012 }];
  const violations = checkBudgets(budgets, () => text, () => true);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].path, 'AGENTS.md');
  assert.equal(violations[0].deltaLines, 1);
  assert.equal(violations[0].deltaWords, 0);
});

test('file over on words only is still flagged', () => {
  const text = Array(2013).fill('w').join(' '); // 1 line, 2013 words — over the 2012-word budget
  const budgets = [{ path: 'AGENTS.md', max_lines: 179, max_words: 2012 }];
  const violations = checkBudgets(budgets, () => text, () => true);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].deltaLines, 0);
  assert.equal(violations[0].deltaWords, 1);
});

test('missing budget-listed file is a no-op, not a crash', () => {
  const budgets = [{ path: 'nonexistent/AGENTS.md', max_lines: 10, max_words: 10 }];
  const violations = checkBudgets(budgets, () => { throw new Error('should not be called'); }, () => false);
  assert.equal(violations.length, 0);
});
