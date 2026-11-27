// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/718 step 1: the report-only remote-branch pass. Real git in a temp origin + clone, so the three merge states are the ones git
// computes (a fast-forward, a cherry-pick/squash equivalent, a branch with work main lacks). Nothing is ever deleted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildReport, mergeStateOf, parseRemoteBranches, protectedReason, remoteBranchPass, repoSlugOf, ticketOf,
} from './remote-branch-report.mjs';

const SLUG = 'o/r';

function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  return env;
}
function mkGit(cwd) {
  const env = cleanEnv();
  return (args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args], { cwd, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** An origin (bare) and a clone whose remote-tracking refs mirror it. Returns { g, origin, clone, cleanup }. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rbr-'));
  const origin = join(root, 'origin.git');
  const clone = join(root, 'clone');
  const go = mkGit(root);
  go(['init', '-q', '--bare', '-b', 'main', origin]);
  go(['clone', '-q', origin, clone]);
  const g = mkGit(clone);
  g(['checkout', '-q', '-b', 'main']);
  writeFileSync(join(clone, 'a.txt'), 'base\n');
  g(['add', 'a.txt']); g(['commit', '-q', '-m', 'base']);
  g(['push', '-q', 'origin', 'main']);
  const commitOn = (branch, file, text, from = 'main') => {
    g(['checkout', '-q', '-B', branch, from]);
    writeFileSync(join(clone, file), text);
    g(['add', file]); g(['commit', '-q', '-m', `${branch}: ${file}`]);
    g(['push', '-q', 'origin', `${branch}:${branch}`]);
    return g(['rev-parse', 'HEAD']).trim();
  };
  return { g, origin, clone, commitOn, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const ghOk = (prs) => () => prs.map((p) => JSON.stringify(p)).join('\n');

test('t/718 pure: protected names and prefixes are never considered; an open PR protects its branch', () => {
  const open = new Set(['feat/t1-x']);
  assert.equal(protectedReason('main', open), 'main');
  for (const n of ['backup/old', 'tags/incident/t579', 'incident/t5-x', 'gh-readonly-queue/main/pr-5-abc']) assert.ok(protectedReason(n, open), n);
  assert.equal(protectedReason('feat/t1-x', open), 'open PR');
  assert.equal(protectedReason('feat/t2-y', open), null);
  assert.equal(protectedReason('backups/x', open), null, 'a lookalike prefix is not protected');
});

test('t/718 pure: branch-line parsing, ticket ids, repo slug and merge states', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(parseRemoteBranches(`refs/remotes/origin/HEAD\t${sha}\t2026-11-26T00:00:00+00:00\nrefs/remotes/origin/feat/t731-x\t${sha}\t2026-11-26T00:00:00+00:00\n`), [{ name: 'feat/t731-x', sha, date: '2026-11-26T00:00:00+00:00' }]);
  assert.throws(() => parseRemoteBranches('garbage line'), /unreadable branch line/);
  assert.throws(() => parseRemoteBranches('refs/remotes/origin/x\tnot-a-sha\td'), /unreadable/);
  assert.equal(ticketOf('feat/t731-x'), 't/731');
  assert.equal(ticketOf('t631-packed-parser-resolve'), 't/631');
  assert.equal(ticketOf('wip/t/660-job'), 't/660');
  assert.equal(ticketOf('train/devops-20261128'), null);
  assert.equal(ticketOf('docs/weekly-2026-49'), null);
  assert.equal(repoSlugOf('https://github.com/AI-Rosetta-Stone/ai-triad-research.git'), 'AI-Rosetta-Stone/ai-triad-research');
  assert.equal(repoSlugOf('git@github.com:o/r.git'), 'o/r');
  assert.equal(repoSlugOf('https://example.com/o/r'), null);
  assert.deepEqual(mergeStateOf({ isAncestor: true, cherryLines: [] }), { state: 'ancestor', unmerged: 0 });
  assert.deepEqual(mergeStateOf({ isAncestor: false, cherryLines: ['- abc', '- def'] }), { state: 'patch-equivalent', unmerged: 0 });
  assert.deepEqual(mergeStateOf({ isAncestor: false, cherryLines: ['- abc', '+ def', '+ ghi'] }), { state: 'unmerged', unmerged: 2 });
});

test('t/718 pure: the report counts and the summary line; protected branches are counted, never listed', () => {
  const b = (name) => ({ name, sha: 'b'.repeat(40), date: '2026-11-26T01:02:03+00:00' });
  const r = buildReport({
    branches: [b('main'), b('backup/x'), b('feat/t1-a'), b('feat/t2-b'), b('feat/t3-c'), b('feat/t4-open')],
    open: new Set(['feat/t4-open']),
    merge: (br) => ({ 'feat/t1-a': { state: 'ancestor' }, 'feat/t2-b': { state: 'patch-equivalent' }, 'feat/t3-c': { state: 'unmerged', unmerged: 1 } })[br.name],
  });
  assert.equal(r.summary, 'remote branches: 3 without a PR; 1 ancestor, 1 patch-equivalent, 1 unmerged; 3 protected (report only, nothing deleted)');
  assert.equal(r.lines.length, 3);
  assert.match(r.lines[0], /^remote-branch: ancestor feat\/t1-a tip=bbbbbbbbb pushed=2026-11-26 ticket=t\/1$/);
  assert.match(r.lines[2], /^remote-branch: unmerged: 1 commit feat\/t3-c /);
  assert.ok(!r.lines.some((l) => /backup\/x|feat\/t4-open|main/.test(l)), 'protected and open-PR branches are not listed');
  assert.ok(!r.lines.concat(r.summary).some((l) => /^WARN/.test(l)), 'no WARN line: the wrapper must not ping daily');
});

test('t/718 real git: one branch of each kind, the protected prefixes, and a branch with an open PR', () => {
  const fx = fixture();
  try {
    // ancestor: merged by fast-forward
    fx.commitOn('feat/t10-ancestor', 'f10.txt', 'ten\n');
    fx.g(['checkout', '-q', 'main']); fx.g(['merge', '-q', '--ff-only', 'feat/t10-ancestor']); fx.g(['push', '-q', 'origin', 'main']);
    // patch-equivalent: the same change landed on main as a different commit (a squash or cherry-pick)
    const sha11 = fx.commitOn('feat/t11-equiv', 'f11.txt', 'eleven\n');
    fx.g(['checkout', '-q', 'main']); fx.g(['cherry-pick', '-x', sha11]); fx.g(['push', '-q', 'origin', 'main']);
    // unmerged: two commits main lacks
    fx.commitOn('feat/t12-unmerged', 'f12.txt', 'twelve\n');
    writeFileSync(join(fx.clone, 'f12b.txt'), 'twelve b\n'); fx.g(['add', 'f12b.txt']); fx.g(['commit', '-q', '-m', 'second']); fx.g(['push', '-q', 'origin', 'feat/t12-unmerged']);
    // protected prefixes and an open-PR branch, all unmerged
    for (const n of ['backup/t13', 'tags/incident/t14', 'incident/t15-x', 'gh-readonly-queue/main/pr-9-abc', 'feat/t16-open']) fx.commitOn(n, `${n.replace(/\//g, '_')}.txt`, `${n}\n`);
    fx.g(['checkout', '-q', 'main']);
    const r = remoteBranchPass({ gitFn: fx.g, ghFn: ghOk([{ ref: 'x' }].map(() => ['feat/t16-open', SLUG])), repoSlug: SLUG });
    assert.equal(r.evaluated, true, r.summary);
    assert.equal(r.summary, 'remote branches: 3 without a PR; 1 ancestor, 1 patch-equivalent, 1 unmerged; 6 protected (report only, nothing deleted)');
    const text = r.lines.join('\n');
    assert.match(text, /ancestor feat\/t10-ancestor /);
    assert.match(text, /patch-equivalent feat\/t11-equiv /);
    assert.match(text, /unmerged: 2 commits feat\/t12-unmerged /);
    assert.doesNotMatch(text, /backup|tags|incident|gh-readonly|t16-open/, 'protected branches and the open-PR branch are never listed');
    // nothing was deleted on origin
    const heads = fx.g(['ls-remote', '--heads', 'origin']).split('\n').filter(Boolean).length;
    assert.equal(heads, 9, 'main plus the eight pushed branches are all still on origin');
  } finally { fx.cleanup(); }
});

test('t/718 real git: a fork PR of the same branch name does not hide this repository\'s branch', () => {
  const fx = fixture();
  try {
    fx.commitOn('feat/t20-x', 'f20.txt', 'x\n');
    fx.g(['checkout', '-q', 'main']);
    const r = remoteBranchPass({ gitFn: fx.g, ghFn: ghOk([['feat/t20-x', 'someone/r']]), repoSlug: SLUG });
    assert.equal(r.evaluated, true);
    assert.match(r.lines.join('\n'), /unmerged: 1 commit feat\/t20-x /);
  } finally { fx.cleanup(); }
});

test('t/718 fail closed: an unreadable PR list lists NOTHING as merged and says could not evaluate', () => {
  const fx = fixture();
  try {
    fx.commitOn('feat/t30-x', 'f30.txt', 'x\n');
    fx.g(['checkout', '-q', 'main']); fx.g(['merge', '-q', '--ff-only', 'feat/t30-x']); fx.g(['push', '-q', 'origin', 'main']);
    const r = remoteBranchPass({ gitFn: fx.g, ghFn: () => { throw new Error('HTTP 403: API rate limit exceeded'); }, repoSlug: SLUG });
    assert.equal(r.evaluated, false);
    assert.deepEqual(r.lines, []);
    assert.match(r.summary, /could not evaluate \(open PR list: .*rate limit/);
    assert.doesNotMatch(r.summary, /ancestor|patch-equivalent/);
    // a PR line that does not parse is also unreadable
    const bad = remoteBranchPass({ gitFn: fx.g, ghFn: () => 'not json', repoSlug: SLUG });
    assert.equal(bad.evaluated, false);
    const noRef = remoteBranchPass({ gitFn: fx.g, ghFn: () => JSON.stringify(['', SLUG]), repoSlug: SLUG });
    assert.equal(noRef.evaluated, false);
  } finally { fx.cleanup(); }
});

test('t/718 fail closed: a failed fetch, no origin/main, an unknown repository, or a failed merge-state read each report could not evaluate', () => {
  const fx = fixture();
  try {
    fx.commitOn('feat/t40-x', 'f40.txt', 'x\n');
    const failing = (match) => (args) => { if (match(args)) throw new Error(`git ${args[0]} failed`); return fx.g(args); };
    const f1 = remoteBranchPass({ gitFn: failing((a) => a[0] === 'fetch'), ghFn: ghOk([]), repoSlug: SLUG });
    assert.equal(f1.evaluated, false); assert.match(f1.summary, /could not evaluate \(git: git fetch failed\)/);
    const f2 = remoteBranchPass({ gitFn: failing((a) => a[0] === 'rev-parse'), ghFn: ghOk([]), repoSlug: SLUG, fetch: false });
    assert.equal(f2.evaluated, false);
    const f3 = remoteBranchPass({ gitFn: (a) => (a[0] === 'remote' ? 'https://example.com/x/y' : fx.g(a)), ghFn: ghOk([]) });
    assert.equal(f3.evaluated, false); assert.match(f3.summary, /not a GitHub repository/);
    const f4 = remoteBranchPass({ gitFn: failing((a) => a[0] === 'cherry'), ghFn: ghOk([]), repoSlug: SLUG, fetch: false });
    assert.equal(f4.evaluated, false); assert.match(f4.summary, /merge state/);
    assert.deepEqual(f4.lines, []);
    const f5 = remoteBranchPass({ gitFn: failing((a) => a[0] === 'for-each-ref'), ghFn: ghOk([]), repoSlug: SLUG, fetch: false });
    assert.equal(f5.evaluated, false);
  } finally { fx.cleanup(); }
});

test('t/718: the pass never issues a destructive git or gh call (report only)', () => {
  const fx = fixture();
  try {
    fx.commitOn('feat/t50-x', 'f50.txt', 'x\n');
    fx.g(['checkout', '-q', 'main']);
    const seen = [];
    const spyGit = (a) => { seen.push(['git', ...a].join(' ')); return fx.g(a); };
    const spyGh = (a) => { seen.push(['gh', ...a].join(' ')); return ''; };
    remoteBranchPass({ gitFn: spyGit, ghFn: spyGh, repoSlug: SLUG });
    assert.ok(seen.length > 3);
    for (const call of seen) {
      assert.doesNotMatch(call, /\b(push|branch -[dD]|--delete|update-ref -d|reset|checkout|clean|rm|DELETE|-X|--method)\b/, call);
    }
    assert.ok(seen.some((c) => c.startsWith('git fetch --prune')), 'it prunes remote-tracking refs (local only)');
  } finally { fx.cleanup(); }
});
