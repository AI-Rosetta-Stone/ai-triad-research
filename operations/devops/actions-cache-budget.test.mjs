// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4931: both arms of the Actions cache budget verdict (boundary at 8 GB), the GATE-UNREADABLE
// arm (an API error is never clean), the alert body contents, and the workflow's wiring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GB,
  DEFAULT_THRESHOLD_BYTES,
  ALERT_LABEL,
  keyPrefix,
  evaluateCacheBudget,
  formatAlertBody,
  fetchCacheData,
  cell,
} from './actions-cache-budget.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const cache = (key, gb, ref = 'refs/heads/main') => ({ key, ref, size_in_bytes: Math.round(gb * GB) });
const usageOf = (caches) => ({
  active_caches_size_in_bytes: caches.reduce((s, c) => s + c.size_in_bytes, 0),
  active_caches_count: caches.length,
});

// Shaped like the live repo on 2026-11-10 (10.64 GB): data cache pair, hf-embed rotation pair, etc.
const LIVE_LIKE = [
  cache('ai-triad-data-v2-2026-11-10', 1.53),
  cache('ai-triad-data-v2-2026-11-09', 1.53),
  cache('buildkit-blob-1-sha256:eb7aa0e4e4e1c412cbfad709db861b783677856cb1f30b39edebc26f5cba8096', 0.78),
  cache('hf-embed-Linux-fa76badd7b007ade6e2337f849c502d5e70215b3ad889c30b3bf13f27e8c4474', 0.6),
  cache('hf-embed-Linux-e2ab21a60f825aa48f1f3f44bb8b9746d094cc3ae40e78c31684e2e2d90ccfb9', 0.6),
  cache('node-cache-Linux-x64-pnpm-fc22914849cb8ed8fb0451d56427bb8563b2bd5e4b18d083da803b6d1646386e', 0.41),
  cache('node-cache-Linux-x64-pnpm-8730e060ef87175a8de23c0570b4e81ed8788733c7ecd62965eb7af4e4fdf159', 0.41, 'refs/pull/4800/merge'),
  cache('onnx-model-all-MiniLM-L6-v2-fp32-0123456789abcdef0123456789abcdef01234567', 0.09),
  cache('feature-blob-deadbeefdeadbeef', 1.2, 'refs/heads/feature/big'),
  cache('pr-blob-cafebabecafebabe', 0.9, 'refs/pull/4801/merge'),
  cache('cache-trivy-2026-11-10', 0.1),
];

test('keyPrefix strips hex digests and dates, keeps the stable stem', () => {
  assert.equal(keyPrefix('ai-triad-data-v2-2026-11-10'), 'ai-triad-data-v2');
  assert.equal(keyPrefix('buildkit-blob-1-sha256:eb7aa0e4e4e1c412cbfad709db861b783677856cb1f30b39edebc26f5cba8096'), 'buildkit-blob-1');
  assert.equal(keyPrefix('hf-embed-Linux-fa76badd7b007ade6e2337f849c502d5e70215b3ad889c30b3bf13f27e8c4474'), 'hf-embed-Linux');
  assert.equal(keyPrefix('onnx-model-all-MiniLM-L6-v2-fp32-0123456789abcdef0123456789abcdef01234567'), 'onnx-model-all-MiniLM-L6-v2-fp32');
  assert.equal(keyPrefix('setup-python-Linux-x64-26.04-Ubuntu-python-3.12.16-pip-8c232950f40e5ca6815d0c48'), 'setup-python-Linux-x64-26.04-Ubuntu-python-3.12.16-pip');
  assert.equal(keyPrefix('plain-key'), 'plain-key');
  assert.equal(keyPrefix('0123456789abcdef0123'), '0123456789abcdef0123', 'an all-hex key is kept, not emptied');
});

test('quiet arm: exactly 8 GB is PASS, no alert, auto-close allowed', () => {
  const r = evaluateCacheBudget({ usage: { active_caches_size_in_bytes: DEFAULT_THRESHOLD_BYTES, active_caches_count: 3 }, caches: [] });
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.shouldAlert, false);
  assert.equal(r.canAutoClose, true);
});

test('quiet arm: well under budget is PASS', () => {
  const caches = [cache('a-2026-11-10', 1), cache('b-2026-11-10', 2)];
  const r = evaluateCacheBudget({ usage: usageOf(caches), caches });
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.shouldAlert, false);
});

test('fire arm: one byte over 8 GB is FAIL, alert, no auto-close', () => {
  const r = evaluateCacheBudget({ usage: { active_caches_size_in_bytes: DEFAULT_THRESHOLD_BYTES + 1, active_caches_count: 3 }, caches: [] });
  assert.equal(r.verdict, 'FAIL');
  assert.equal(r.shouldAlert, true);
  assert.equal(r.canAutoClose, false);
});

test('fire arm: live-shaped repo lists top keys with refs, prefixes, refs and non-main >1 GB candidates', () => {
  const r = evaluateCacheBudget({ usage: usageOf(LIVE_LIKE), caches: LIVE_LIKE });
  assert.equal(r.verdict, 'FAIL');
  assert.equal(r.topKeys[0].key, 'ai-triad-data-v2-2026-11-09', 'ties sort by key for a stable order');
  assert.equal(r.topKeys[0].ref, 'refs/heads/main');
  const hf = r.topPrefixes.find((p) => p.name === 'hf-embed-Linux');
  assert.deepEqual([hf.count, Math.round(hf.bytes / 1e8)], [2, 12], 'hf-embed rotation shows as 2 entries, ~1.2 GB');
  assert.equal(r.topPrefixes[0].name, 'ai-triad-data-v2');
  assert.equal(r.topRefs[0].name, 'refs/heads/main');
  assert.deepEqual(r.cleanupCandidates.map((c) => c.name), ['refs/heads/feature/big'],
    'only the non-main ref over 1 GB; refs/pull/4801 (0.9 GB) and refs/pull/4800 (0.41 GB) are under');
  assert.ok(!r.cleanupCandidates.some((c) => c.name === 'refs/heads/main'), 'main is never a cleanup candidate');

  const body = formatAlertBody(r, { runUrl: 'https://example/run/1', now: '2026-11-10T00:00:00Z' });
  assert.match(body, /Actions cache over budget/);
  assert.match(body, /\| 1\.53 GB \| `refs\/heads\/main` \| `ai-triad-data-v2-2026-11-09` \|/);
  assert.match(body, /\| 1\.20 GB \| 2 \| `hf-embed-Linux` \|/);
  assert.match(body, /`refs\/heads\/feature\/big`: 1\.20 GB in 1 caches/);
  assert.match(body, /Rotation, not a leak/);
  assert.match(body, /never deletes caches/);
  assert.match(body, /https:\/\/example\/run\/1/);
});

test('fire arm body says None when no non-main ref is over 1 GB', () => {
  const caches = [cache('a-2026-11-10', 5), cache('b-2026-11-10', 4)];
  const body = formatAlertBody(evaluateCacheBudget({ usage: usageOf(caches), caches }));
  assert.match(body, /Cleanup candidates \(non-main refs over 1 GB\)\n\nNone\./);
});

test('unreadable arm: an API error is GATE-UNREADABLE with a reason, never PASS, never auto-close', () => {
  const r = evaluateCacheBudget({ readError: Object.assign(new Error('Resource not accessible by integration'), { status: 403 }) });
  assert.equal(r.verdict, 'GATE-UNREADABLE');
  assert.match(r.reason, /access denied \(403\)/);
  assert.equal(r.shouldAlert, false);
  assert.equal(r.canAutoClose, false);
});

test('unreadable arm: a missing or malformed usage/list response is GATE-UNREADABLE, not clean', () => {
  for (const input of [
    {},
    { usage: {}, caches: [] },
    { usage: { active_caches_size_in_bytes: '10641390948' }, caches: [] },
    { usage: { active_caches_size_in_bytes: 1 } },
    { usage: { active_caches_size_in_bytes: 1 }, caches: [{ key: 'k' }] },
  ]) {
    const r = evaluateCacheBudget(input);
    assert.equal(r.verdict, 'GATE-UNREADABLE', JSON.stringify(input));
    assert.equal(r.canAutoClose, false);
    assert.ok(r.reason.length > 0);
  }
});

test('a list/usage mismatch is surfaced as a WARN detail; the verdict follows the usage total', () => {
  const caches = [cache('a-2026-11-10', 1)];
  const r = evaluateCacheBudget({ usage: { active_caches_size_in_bytes: 9 * GB, active_caches_count: 1 }, caches });
  assert.equal(r.verdict, 'FAIL');
  assert.ok(r.details.some((d) => d.startsWith('WARN: the cache list sums to 1.00 GB')));
});

test('fetchCacheData reads usage and flattens every page of the cache list', async () => {
  const calls = [];
  const github = {
    rest: { actions: {
      getActionsCacheUsage: async (p) => { calls.push(['usage', p]); return { data: { active_caches_size_in_bytes: 5 } }; },
      getActionsCacheList: 'LIST',
    } },
    paginate: async (endpoint, params, map) => {
      calls.push(['paginate', endpoint, params]);
      // Unnormalized and normalized page shapes are both handled by the map fn.
      return [...map({ data: { total_count: 2, actions_caches: [{ key: 'a' }] } }), ...map({ data: [{ key: 'b' }] })];
    },
  };
  const { usage, caches } = await fetchCacheData(github, 'o', 'r');
  assert.equal(usage.active_caches_size_in_bytes, 5);
  assert.deepEqual(caches.map((c) => c.key), ['a', 'b']);
  assert.deepEqual(calls[1], ['paginate', 'LIST', { owner: 'o', repo: 'r', per_page: 100 }]);
});

test('cell escapes backslash first, then EVERY pipe, plus backticks and newlines (CodeQL js/incomplete-sanitization)', () => {
  // Input: a\|b|c`d<CR><LF>e\\|f  (multiple pipes, backslashes before pipes, a backtick, a newline)
  const input = 'a\\|b|c`d\r\ne\\\\|f';
  // Expected: a\\\|b\|c'd e\\\\\|f  (each \ doubled, each | escaped, ` -> ', newline -> space)
  assert.equal(cell(input), "a\\\\\\|b\\|c'd e\\\\\\\\\\|f");
  // After escaping, every pipe is preceded by an ODD number of backslashes: none is a live separator.
  for (const m of cell(input).matchAll(/(\\*)\|/g)) assert.equal(m[1].length % 2, 1, `live pipe in ${cell(input)}`);
  assert.equal(cell('x|y|z'), 'x\\|y\\|z', 'all occurrences, not just the first');
});

test('a key with pipes and backslashes stays inside its own table row and cell', () => {
  const caches = [cache('evil\\|key|with|pipes`x', 9)];
  const body = formatAlertBody(evaluateCacheBudget({ usage: usageOf(caches), caches }));
  const row = body.split('\n').find((l) => l.includes('evil'));
  // Count live (unescaped) pipes: a row of 3 cells has exactly 4.
  const live = [...row.matchAll(/(\\*)\|/g)].filter((m) => m[1].length % 2 === 0).length;
  assert.equal(live, 4, row);
});

// Pull the github-script `script: |` body of a named step out of the workflow, so the real issue
// logic runs against a fake Octokit (t/133: a labelled PR must never be touched).
function stepScript(wf, stepName) {
  const lines = wf.split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  assert.ok(start >= 0, `step ${stepName} exists`);
  const s = lines.findIndex((l, i) => i > start && /^\s+script: \|$/.test(l));
  const indent = lines[s].match(/^\s*/)[0].length;
  const body = [];
  for (let i = s + 1; i < lines.length; i++) {
    if (lines[i].trim() && lines[i].match(/^\s*/)[0].length <= indent) break;
    body.push(lines[i]);
  }
  return body.join('\n');
}

function fakeGithub(openItems) {
  const calls = [];
  return {
    calls,
    rest: { issues: {
      listForRepo: async (p) => { calls.push(['list', p]); return { data: openItems }; },
      createComment: async (p) => { calls.push(['comment', p.issue_number]); return { data: {} }; },
      update: async (p) => { calls.push(['update', p.issue_number, p.state]); return { data: {} }; },
      create: async (p) => { calls.push(['create', p.labels]); return { data: { number: 999 } }; },
    } },
  };
}

async function runStep(wf, stepName, github, env = {}) {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const context = { repo: { owner: 'o', repo: 'r' }, serverUrl: 'https://github.com', runId: 1 };
  const core = { info() {}, warning() {} };
  const fn = new AsyncFunction('github', 'context', 'core', 'process', stepScript(wf, stepName));
  await fn(github, context, core, { env });
}

const LABELLED_PR = { number: 4823, pull_request: { url: 'x' }, labels: [{ name: ALERT_LABEL }] };
const ALERT_ISSUE = { number: 77, labels: [{ name: ALERT_LABEL }] };

test('t/133: the alert step never comments on a labelled PR; with only a PR open it files a new issue', async () => {
  const wf = readFileSync(join(repoRoot, '.github', 'workflows', 'actions-cache-budget.yml'), 'utf8');
  const onlyPr = fakeGithub([LABELLED_PR]);
  await runStep(wf, 'Open or update the cache-budget alert issue', onlyPr, { BODY: 'b' });
  assert.ok(!onlyPr.calls.some((c) => c[1] === 4823), JSON.stringify(onlyPr.calls));
  assert.deepEqual(onlyPr.calls.at(-1), ['create', [ALERT_LABEL, 'alert-escalated']]);

  const prFirst = fakeGithub([LABELLED_PR, ALERT_ISSUE]);
  await runStep(wf, 'Open or update the cache-budget alert issue', prFirst, { BODY: 'b' });
  assert.deepEqual(prFirst.calls.slice(1), [['comment', 77]], 'comments on the issue behind the PR, not the PR');
});

test('t/133: auto-close never comments on or closes a labelled PR, only the alert issue', async () => {
  const wf = readFileSync(join(repoRoot, '.github', 'workflows', 'actions-cache-budget.yml'), 'utf8');
  const gh = fakeGithub([LABELLED_PR, ALERT_ISSUE]);
  await runStep(wf, 'Auto-close the alert once back under budget', gh);
  assert.deepEqual(gh.calls.slice(1), [['comment', 77], ['update', 77, 'closed']]);
});

test('both issue steps are guarded to the main ref (as #4774)', () => {
  const wf = readFileSync(join(repoRoot, '.github', 'workflows', 'actions-cache-budget.yml'), 'utf8');
  for (const name of ['Open or update the cache-budget alert issue', 'Auto-close the alert once back under budget']) {
    const lines = wf.split('\n');
    const i = lines.findIndex((l) => l.trim() === `- name: ${name}`);
    const ifLine = lines.slice(i + 1, i + 6).find((l) => /^\s+if:/.test(l));
    assert.ok(ifLine && ifLine.includes("github.ref == 'refs/heads/main'"), `${name}: ${ifLine}`);
  }
});

test('workflow wiring: alert-only permissions, off-round-minute cron, registered, labelled, no deletes', () => {
  const wf = readFileSync(join(repoRoot, '.github', 'workflows', 'actions-cache-budget.yml'), 'utf8');
  const perms = wf.match(/^permissions:\n((?:[ \t]+.*\n)+)/m);
  assert.ok(perms, 'top-level permissions block present');
  const keys = [...perms[1].matchAll(/^\s+([a-z-]+):\s*(\w+)/gm)].map((m) => `${m[1]}: ${m[2]}`).sort();
  assert.deepEqual(keys, ['actions: read', 'contents: read', 'issues: write']);
  assert.doesNotMatch(wf, /permissions:\s*write-all|actions:\s*write/);
  assert.doesNotMatch(wf, /deleteActionsCache|gh cache delete|actions\/caches\/\d|-X DELETE/i, 'alert only: never deletes caches');
  const cron = wf.match(/cron:\s*'([^']+)'/);
  assert.ok(cron, 'has a cron');
  const minute = cron[1].split(/\s+/)[0];
  assert.match(minute, /^\d+$/);
  assert.ok(Number(minute) % 5 !== 0, `cron minute ${minute} is off round-minute marks (t/4501)`);
  assert.ok(wf.includes(`'${ALERT_LABEL}'`), 'uses the dedicated alert label');
  assert.ok(wf.includes("'alert-escalated'"), 'carries alert-escalated for the r/23 bridge (alert-label lint)');
  const reg = JSON.parse(readFileSync(join(here, 'scheduled-workflows.json'), 'utf8'));
  assert.ok(reg.workflows.some((w) => w.file === 'actions-cache-budget.yml'), 'registered in scheduled-workflows.json');
});
