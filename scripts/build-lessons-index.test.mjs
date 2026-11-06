import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEntries, renderIndex } from './build-lessons-index.mjs';

const FIXTURE = [
  '# Lessons Learned',          // 1
  '',                           // 2
  '## [Build] Old Unnumbered',  // 3
  'body',                       // 4
  '',                           // 5
  '## #12 [Process] Numbered | pipe', // 6
  '```',                        // 7
  '## not a heading',           // 8
  '```',                        // 9
  '## No Category Here',        // 10
  'last line',                  // 11
  '',
].join('\n');

test('parses numbered, unnumbered and category-less entries', () => {
  const e = parseEntries(FIXTURE);
  assert.equal(e.length, 3);
  assert.deepEqual([e[0].number, e[0].category, e[0].title], [null, 'Build', 'Old Unnumbered']);
  assert.deepEqual([e[1].number, e[1].category], ['12', 'Process']);
  assert.deepEqual([e[2].number, e[2].category, e[2].title], [null, null, 'No Category Here']);
});

test('line ranges run to the line before the next heading, last to EOF', () => {
  const e = parseEntries(FIXTURE);
  assert.deepEqual([e[0].start, e[0].end], [3, 5]);
  assert.deepEqual([e[1].start, e[1].end], [6, 9]);
  assert.deepEqual([e[2].start, e[2].end], [10, 11]);
});

test('render is deterministic, escapes pipes and shows em dash for missing fields', () => {
  const a = renderIndex(parseEntries(FIXTURE));
  assert.equal(a, renderIndex(parseEntries(FIXTURE)));
  assert.ok(a.includes('| #12 | [Process] | Numbered \| pipe | lines 6-9 |'));
  assert.ok(a.includes('| — | — | No Category Here | lines 10-11 |'));
  assert.ok(a.trimEnd().endsWith('3 entries indexed.'));
});

test('CRLF input yields the same ranges', () => {
  const e = parseEntries(FIXTURE.replace(/\n/g, '\r\n'));
  assert.deepEqual(e.map((x) => [x.start, x.end]), [[3, 5], [6, 9], [10, 11]]);
});
