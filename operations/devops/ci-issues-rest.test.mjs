// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/675 (child of t/563): complexity-tickets and contrast-check's alert and auto-close steps talk to
// GitHub over REST (`gh api repos/...`) only. The `gh issue` / `gh pr` subcommands are GraphQL-backed
// and spent the shared GITHUB_TOKEN GraphQL pool on every CI run (t/563#16).
//   1. complexity-tickets.mjs: both modes run against a recording fake of gh; every call must be
//      `gh api` on a repos/ path, never a subcommand and never graphql. Its behaviour is pinned too.
//   2. ci.yml: the contrast-check job and the complexity-tickets job carry no `gh issue` / `gh pr`.
// Run: node --test operations/devops/ci-issues-rest.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileViolations, report, makeGh, issueTitle, REFACTOR_LABEL, REPORT_LABEL } from '../../.github/scripts/complexity-tickets.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const SCRIPT = readFileSync(path.join(root, '.github', 'scripts', 'complexity-tickets.mjs'), 'utf8');
const CI = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');

/** A fake gh: records each argv (and the --input payload, read before the script deletes it). */
function fakeGh(respond) {
  const calls = [];
  const run = (args) => {
    const i = args.indexOf('--input');
    const payload = i >= 0 ? JSON.parse(readFileSync(args[i + 1], 'utf8')) : undefined;
    const call = { args, method: args[args.indexOf('-X') + 1], path: args.find((a) => a.startsWith('repos/')), payload };
    calls.push(call);
    return respond(call) ?? '';
  };
  return { calls, run };
}
function assertRestOnly(calls) {
  assert.ok(calls.length > 0, 'the fake recorded no call, so this arm proves nothing');
  for (const c of calls) {
    assert.equal(c.args[0], 'api', `not a gh api call: gh ${c.args.join(' ')}`);
    assert.ok(c.path && c.path.startsWith('repos/{owner}/{repo}/'), `not a repos/ REST path: gh ${c.args.join(' ')}`);
    assert.ok(!c.args.includes('graphql'), `a graphql call: gh ${c.args.join(' ')}`);
  }
}
const quiet = (fn) => {
  const { log, warn } = console;
  const out = [];
  console.log = (...a) => out.push(a.join(' '));
  console.warn = (...a) => out.push(a.join(' '));
  try { fn(); } finally { console.log = log; console.warn = warn; }
  return out.join('\n');
};
function reportsDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 't675-'));
  writeFileSync(path.join(dir, 'ps-scripts.json'), JSON.stringify({ root: 'scripts', violations: [
    { File: 'known.ps1', Reason: 'regression', Observed: { max: 20, countOver: 2 } },
    { File: 'recorded.ps1', Reason: 'regression', Observed: { max: 20, countOver: 2 } },
    { File: 'fresh.ps1', Reason: 'new-offender', Observed: { max: 16, countOver: 1 } }] }));
  return dir;
}
const line = (v) => `${JSON.stringify(v)}\n`;

test('file-violations: REST only; comments on an open issue, skips a PR already recorded, opens a new one', () => {
  const dir = reportsDir();
  const saved = { ...process.env };
  Object.assign(process.env, { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/4242/merge', GITHUB_REF_NAME: '4242/merge', PR_NUMBER: '4242' });
  try {
    const gh = fakeGh((c) => {
      if (c.method === 'GET' && c.path.endsWith('/issues')) {
        return line({ number: 11, title: issueTitle('scripts/known.ps1') }) + line({ number: 12, title: issueTitle('scripts/recorded.ps1') });
      }
      if (c.method === 'GET' && c.path.endsWith('/issues/11')) return line('first body');
      if (c.method === 'GET' && c.path.endsWith('/issues/12')) return line(null);
      if (c.method === 'GET' && c.path.endsWith('/issues/12/comments')) return line('Hit the budget again in PR #4242:') + line('multi\nline');
      if (c.method === 'POST' && c.path.endsWith('/issues')) return 'https://example.invalid/issues/13\n';
      return '';
    });
    const out = quiet(() => fileViolations({ dir, repoRoot: root, dryRun: false, run: gh.run }));
    assertRestOnly(gh.calls);
    const did = gh.calls.map((c) => `${c.method} ${c.path.replace('repos/{owner}/{repo}/', '')}`);
    // The context's PR number decides whether #12 counts as recorded; either way #11 is commented and fresh.ps1 opened.
    assert.ok(did.includes('POST labels'), 'the label is ensured first');
    assert.ok(did.includes('POST issues/11/comments'), 'an open issue without this PR gets a comment');
    const created = gh.calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues'));
    assert.equal(created.payload.title, issueTitle('scripts/fresh.ps1'));
    assert.deepEqual(created.payload.labels, [REFACTOR_LABEL]);
    assert.equal(typeof created.payload.body, 'string');
    assert.match(out, /scripts\/fresh\.ps1: opened https:\/\/example\.invalid\/issues\/13/);
    // The list is paged and filters PRs out.
    const list = gh.calls.find((c) => c.method === 'GET' && c.path.endsWith('/issues'));
    assert.ok(list.args.includes('--paginate'));
    assert.ok(list.args.includes(`labels=${REFACTOR_LABEL}`) && list.args.includes('state=open') && list.args.includes('per_page=100'));
    assert.match(list.args[list.args.indexOf('--jq') + 1], /select\(\.pull_request == null\)/);
    // No body text travels in argv.
    for (const c of gh.calls) if (c.payload) assert.ok(!c.args.some((a) => a.includes('budget')), 'a body leaked into argv');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('report: REST only; closes a refactor issue whose file left every baseline (comment, then state=closed), updates the report issue', () => {
  const gh = fakeGh((c) => {
    if (c.method === 'GET' && c.path.endsWith('/issues') && c.args.includes(`labels=${REFACTOR_LABEL}`)) return line({ number: 21, title: issueTitle('scripts/no-longer-over-t675.ps1') });
    if (c.method === 'GET' && c.path.endsWith('/issues') && c.args.includes(`labels=${REPORT_LABEL}`)) return line({ number: 30, title: 'Complexity budget: worst offenders' });
    return '';
  });
  quiet(() => report({ repoRoot: root, top: 5, dryRun: false, run: gh.run }));
  assertRestOnly(gh.calls);
  const did = gh.calls.map((c) => `${c.method} ${c.path.replace('repos/{owner}/{repo}/', '')}`);
  const comment = did.indexOf('POST issues/21/comments');
  const close = gh.calls.findIndex((c) => c.method === 'PATCH' && c.path.endsWith('/issues/21'));
  assert.ok(comment >= 0 && close > comment, `expected the comment before the close, got: ${did.join(', ')}`);
  assert.deepEqual(gh.calls[close].payload, { state: 'closed', state_reason: 'completed' });
  const edit = gh.calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/issues/30'));
  assert.deepEqual(Object.keys(edit.payload), ['body']);
});

test('failure handling is unchanged: a failed list throws outside dry-run, a failed read of one issue only WARNs, an existing label is quiet', () => {
  const boom = () => { throw Object.assign(new Error('gh: HTTP 403'), { stdout: '', stderr: 'rate limited' }); };
  assert.throws(() => makeGh(false, boom).list(REFACTOR_LABEL), /HTTP 403/);
  let texts;
  const warned = quiet(() => { texts = makeGh(false, boom).texts(7); });
  assert.deepEqual(texts, []);
  assert.match(warned, /WARN complexity-tickets: could not read #7; commenting without the duplicate check/);
  const exists = () => { throw Object.assign(new Error('gh: Validation Failed (HTTP 422)'), { stdout: '{"errors":[{"resource":"Label","code":"already_exists","field":"name"}]}', stderr: '' }); };
  assert.equal(quiet(() => makeGh(false, exists).ensureLabel('x', 'D93F0B', 'd')), '');
  assert.match(quiet(() => makeGh(false, boom).ensureLabel('x', 'D93F0B', 'd')), /WARN complexity-tickets: could not create label x/);
});

test('dry-run output is what it was: the `gh issue ...` lines, and no write call', () => {
  const gh = fakeGh(() => '');
  const g = makeGh(true, gh.run);
  const out = quiet(() => { g.ensureLabel('l', 'c', 'd'); g.create('T', 'L', 'B'); g.comment(5, 'C'); g.edit(6, 'E'); g.close(7, 'bye'); });
  assert.equal(out, ['[dry-run] gh issue create --title T --label L\nB\n', '[dry-run] gh issue comment 5\nC\n', '[dry-run] gh issue edit 6\nE\n', '[dry-run] gh issue close 7: bye'].join('\n'));
  assert.deepEqual(gh.calls, []);
});

test('source: complexity-tickets.mjs passes gh no subcommand argv (only `api`)', () => {
  const firstArgs = [...SCRIPT.matchAll(/run\(\[\s*'([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(firstArgs.length >= 3, `expected the run([...]) call sites, found ${firstArgs.length}`);
  assert.deepEqual([...new Set(firstArgs)], ['api']);
  assert.equal([...SCRIPT.matchAll(/execFileSync\(/g)].length, 1, 'one gh entry point (ghCli), so the fake sees every call');
});

// ── 2. ci.yml ──
function jobText(job) {
  const L = CI.split('\n');
  const s = L.indexOf(`  ${job}:`);
  assert.ok(s >= 0, `ci.yml has no job ${job}`);
  let e = s + 1;
  while (e < L.length && !/^ {2}[A-Za-z0-9_-]+:$/.test(L[e])) e++;
  return L.slice(s, e).filter((l) => !/^\s*#/.test(l)).join('\n');
}
const GRAPHQL_CLI = /\bgh\s+(issue|pr)\b|\bgh\s+api\s+graphql\b/;

test('ci.yml: contrast-check and complexity-tickets carry no gh issue / gh pr / graphql call', () => {
  for (const job of ['contrast-check', 'complexity-tickets']) {
    const m = jobText(job).match(GRAPHQL_CLI);
    assert.equal(m, null, `${job}: found "${m?.[0]}"`);
  }
  assert.match('  gh issue list --state open', GRAPHQL_CLI, 'arm: the pattern must catch the old call');
  assert.match('  gh pr view 1', GRAPHQL_CLI);
});

test('ci.yml: the contrast steps keep their failure behaviour (alert fails closed; auto-close can never red the check)', () => {
  const t = jobText('contrast-check');
  const alert = t.slice(t.indexOf('- name: Alert — contrast-check RED on main'), t.indexOf('- name: Auto-close contrast-alert issue'));
  const close = t.slice(t.indexOf('- name: Auto-close contrast-alert issue'));
  assert.ok(alert.length > 0 && close.length > 0);
  assert.match(alert, /if: failure\(\) && github\.event_name == 'push'/);
  assert.doesNotMatch(alert, /continue-on-error/);
  assert.match(close, /if: success\(\) && github\.event_name == 'push'\n\s+continue-on-error: true/);
  // The list and the writes are not swallowed; only the two label edits are (as `gh issue edit ... || true` was).
  assert.equal((alert.match(/\|\| true/g) ?? []).length, 3);
  assert.doesNotMatch(close, /\|\| true/);
  for (const step of [alert, close]) assert.match(step, /EXISTING=\$\(gh api -X GET "repos\/\$GH_REPO\/issues" -f state=open -f labels="\$LABEL" -f per_page=100 --jq '\[\.\[\] \| select\(\.pull_request == null\)\]\[0\]\.number \/\/ empty'\)/);
  assert.match(close, /gh api -X PATCH "repos\/\$GH_REPO\/issues\/\$EXISTING" -f state=closed/);
  assert.ok(existsSync(path.join(root, '.github', 'scripts', 'complexity-tickets.mjs')));
});
