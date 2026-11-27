// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/705: ci-make-room.mjs lists, and on the TL's go cancels, the queued pull_request CI runs that crowd out an incident fix. The default
// is list-only; cancel needs --incident and --by; merge_group, push and other workflows and incident/* branches are never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageOf, formatRun, makeRoom, parseArgs, readRuns, repoSlugFromOrigin, rerunCommand, selectRuns } from './ci-make-room.mjs';

const NOW = Date.parse('2026-11-27T06:00:00Z');
let nextId = 100;
const run = (over = {}) => ({
  id: nextId++, event: 'pull_request', path: '.github/workflows/ci.yml', status: 'queued', head_branch: 'feat/t1-x',
  created_at: '2026-11-27T05:00:00Z', pull_requests: [{ number: 5000 + nextId }], ...over,
});

/** A fake gh over a list of runs: records every call. */
function fakeGh(runs, { jobsFail = false, cancelFail = new Set(), listFail = false } = {}) {
  const calls = [];
  const fn = (args) => {
    const j = args.join(' ');
    calls.push(j);
    if (j.includes('/actions/workflows/ci.yml/runs')) {
      if (listFail) throw new Error('HTTP 403: API rate limit exceeded');
      const status = /status=(\w+)/.exec(j)[1];
      return runs.filter((r) => r.status === status).map((r) => JSON.stringify(r)).join('\n');
    }
    if (/\/jobs\?per_page=1/.test(j)) { if (jobsFail) throw new Error('boom'); return `${40 + (Number(/runs\/(\d+)\/jobs/.exec(j)[1]) % 5)}\n`; }
    if (/-X POST .*\/cancel$/.test(j)) {
      const id = Number(/runs\/(\d+)\/cancel/.exec(j)[1]);
      if (cancelFail.has(id)) throw new Error('HTTP 409: Cannot cancel a workflow run that is completed.');
      return '{}';
    }
    throw new Error(`unexpected gh call: ${j}`);
  };
  fn.calls = calls;
  return fn;
}

test('t/705 args: list-only is the default; --cancel needs --incident=t/N and --by; the flags mean nothing without --cancel', () => {
  assert.deepEqual(parseArgs([]), { cancel: false, incident: null, by: null, repo: null });
  assert.deepEqual(parseArgs(['--repo=o/r']).repo, 'o/r');
  const ok = parseArgs(['--cancel', '--incident=t/705', '--by=cad2074a-520d-414b-a665-d505a9d24de5']);
  assert.equal(ok.cancel, true);
  assert.equal(ok.incident, 't/705');
  for (const bad of [['--cancel'], ['--cancel', '--incident=t/5'], ['--cancel', '--by=cad2074a-520d-414b-a665-d505a9d24de5'], ['--incident=t/5'], ['--by=cad2074a-520d-414b-a665-d505a9d24de5'],
    ['--cancel', '--incident=705', '--by=cad2074a-520d-414b-a665-d505a9d24de5'], ['--cancel', '--incident=t/x', '--by=cad2074a-520d-414b-a665-d505a9d24de5'],
    ['--cancel', '--incident=t/5', '--by=short'], ['--force'], ['--repo=nope'], ['--cancel', '--incident=t/5', '--by=cad2074a-520d-414b-a665-d505a9d24de5', '--all']]) {
    assert.ok(parseArgs(bad).error, JSON.stringify(bad));
  }
});

test('t/705 select: only queued or in-progress pull_request ci.yml runs not on incident/*; merge_group, push, schedule, other workflows and completed runs are never selected', () => {
  const keep = [run(), run({ status: 'in_progress', head_branch: 'train/devops-1' })];
  const drop = [
    run({ head_branch: 'incident/t739-no-tier' }), run({ head_branch: 'incident/t5-x', status: 'in_progress' }),
    run({ event: 'merge_group', head_branch: 'gh-readonly-queue/main/pr-1-abc' }), run({ event: 'push', head_branch: 'main' }),
    run({ event: 'schedule', head_branch: 'main' }), run({ event: 'workflow_dispatch' }),
    run({ path: '.github/workflows/consult-hold-guard.yml' }), run({ path: '.github/workflows/merge-approval.yml' }), run({ path: '.github/workflows/xci.yml' }),
    run({ status: 'completed' }), run({ status: 'waiting' }), run({ head_branch: '' }), run({ head_branch: undefined }), run({ path: undefined }),
  ];
  assert.deepEqual(selectRuns([...drop, ...keep]).map((r) => r.id).sort(), keep.map((r) => r.id).sort());
  assert.deepEqual(selectRuns([]), []);
});

test('t/705 format: age, PR, branch and job count; the newest run comes first', () => {
  assert.equal(ageOf('2026-11-27T05:55:00Z', NOW), '5m');
  assert.equal(ageOf('2026-11-27T03:45:00Z', NOW), '2h15m');
  assert.equal(ageOf('garbage', NOW), '?');
  assert.equal(ageOf('2026-11-27T07:00:00Z', NOW), '?', 'a future time is unreadable');
  const r = run({ id: 7, head_branch: 'feat/t9-x', pull_requests: [{ number: 5611 }], created_at: '2026-11-27T05:00:00Z' });
  assert.equal(formatRun(r, 44, NOW), 'run 7  queued      PR #5611  feat/t9-x  age 1h00m  jobs 44');
  assert.match(formatRun({ ...r, pull_requests: [] }, null, NOW), /PR \(none\)  feat\/t9-x  age 1h00m  jobs \?$/);
  const older = run({ created_at: '2026-11-27T01:00:00Z' });
  const newer = run({ created_at: '2026-11-27T05:30:00Z' });
  assert.deepEqual(selectRuns([older, newer]).map((x) => x.id), [newer.id, older.id]);
  assert.equal(rerunCommand({ id: 77 }, 'o/r'), 'gh run rerun 77 --repo o/r');
  assert.equal(repoSlugFromOrigin('https://github.com/o/r.git'), 'o/r');
  assert.equal(repoSlugFromOrigin('https://example.com/o/r'), null);
});

test('t/705 list only (the default): lists runs with job counts, issues no cancel, and says so', () => {
  const runs = [run(), run({ status: 'in_progress' }), run({ head_branch: 'incident/t1-x' })];
  const gh = fakeGh(runs);
  const logs = [];
  const r = makeRoom({ repo: 'o/r', ghFn: gh, now: NOW, log: (l) => logs.push(l) });
  assert.equal(r.listed.length, 2);
  assert.deepEqual(r.cancelled, []);
  assert.ok(!gh.calls.some((c) => /-X POST|cancel/.test(c)), 'no cancel call in list mode');
  assert.match(logs.join('\n'), /2 queued or in-progress pull_request ci\.yml run\(s\) not on an incident\/\* branch/);
  assert.match(logs.join('\n'), /list only; nothing was cancelled/);
  assert.match(logs.join('\n'), /\d+ job\(s\) across them/);
});

test('t/705 cancel: cancels exactly the selected runs, prints each with its re-run command and the incident and TL id', () => {
  const a = run({ pull_requests: [{ number: 5611 }] });
  const b = run({ status: 'in_progress', pull_requests: [{ number: 5612 }] });
  const keepInc = run({ head_branch: 'incident/t739-x' });
  const mq = run({ event: 'merge_group', head_branch: 'gh-readonly-queue/main/pr-3-x' });
  const gh = fakeGh([a, b, keepInc, mq]);
  const logs = [];
  const r = makeRoom({ repo: 'o/r', cancel: true, incident: 't/739', by: 'cad2074a-520d-414b-a665-d505a9d24de5', ghFn: gh, now: NOW, log: (l) => logs.push(l) });
  assert.deepEqual(r.cancelled.sort(), [a.id, b.id].sort());
  const posts = gh.calls.filter((c) => /-X POST/.test(c));
  assert.equal(posts.length, 2);
  assert.ok(posts.every((c) => /\/actions\/runs\/\d+\/cancel$/.test(c)));
  assert.ok(!posts.some((c) => c.includes(`/runs/${keepInc.id}/`) || c.includes(`/runs/${mq.id}/`)), 'an incident/* run and a merge_group run are never cancelled');
  const text = logs.join('\n');
  assert.match(text, new RegExp(`CANCELLED run ${a.id} \\(PR #5611, feat/t1-x\\) for t/739 by cad2074a-520d-414b-a665-d505a9d24de5\\. Re-run it with: gh run rerun ${a.id} --repo o/r`));
  assert.match(text, /cancelled 2 of 2 for t\/739 by cad2074a/);
});

test('t/705 cancel: one run that cannot be cancelled is reported and the rest still are; the exit reflects it', () => {
  const a = run(); const b = run(); const c = run();
  const gh = fakeGh([a, b, c], { cancelFail: new Set([b.id]) });
  const logs = [];
  const r = makeRoom({ repo: 'o/r', cancel: true, incident: 't/9', by: 'cad2074a-520d-414b-a665-d505a9d24de5', ghFn: gh, now: NOW, log: (l) => logs.push(l) });
  assert.deepEqual(r.cancelled.sort(), [a.id, c.id].sort());
  assert.deepEqual(r.failed, [b.id]);
  assert.match(logs.join('\n'), new RegExp(`could not cancel run ${b.id}: HTTP 409`));
  assert.match(logs.join('\n'), /cancelled 2 of 3 .*; 1 could not be cancelled/);
});

test('t/705 fail closed: an unreadable run list throws and NOTHING is listed or cancelled; an unreadable job count only shows ?', () => {
  const gh = fakeGh([run()], { listFail: true });
  assert.throws(() => makeRoom({ repo: 'o/r', cancel: true, incident: 't/9', by: 'cad2074a-520d-414b-a665-d505a9d24de5', ghFn: gh, now: NOW, log: () => {} }), /rate limit/);
  assert.ok(!gh.calls.some((c) => /-X POST/.test(c)), 'no cancel after a failed read');
  assert.throws(() => readRuns('o/r', () => 'not json'));
  const logs = [];
  const ok = makeRoom({ repo: 'o/r', ghFn: fakeGh([run()], { jobsFail: true }), now: NOW, log: (l) => logs.push(l) });
  assert.equal(ok.listed.length, 1);
  assert.match(logs.join('\n'), /jobs \?/);
  assert.match(logs.join('\n'), /some counts unreadable/);
});

test('t/705: the script asks for pull_request ci.yml runs only, in both statuses, and never reads or touches another workflow', () => {
  const gh = fakeGh([run()]);
  makeRoom({ repo: 'o/r', ghFn: gh, now: NOW, log: () => {} });
  const lists = gh.calls.filter((c) => c.includes('/actions/workflows/'));
  assert.equal(lists.length, 2);
  assert.ok(lists.every((c) => c.includes('/actions/workflows/ci.yml/runs?') && c.includes('event=pull_request')));
  assert.deepEqual(lists.map((c) => /status=(\w+)/.exec(c)[1]).sort(), ['in_progress', 'queued']);
});

// ── t/806 (SO p/136#129): a ref suffix on a run's path, and a silent zero made visible ──

import { workflowPathOf } from './ci-make-room.mjs';

test('t/806: a run whose path carries an @ref suffix is still a ci.yml run (the suffix is stripped before the /ci.yml check)', () => {
  assert.equal(workflowPathOf('.github/workflows/ci.yml@refs/heads/main'), '.github/workflows/ci.yml');
  assert.equal(workflowPathOf('.github/workflows/ci.yml@refs/pull/5/merge'), '.github/workflows/ci.yml');
  assert.equal(workflowPathOf('.github/workflows/ci.yml'), '.github/workflows/ci.yml');
  assert.equal(workflowPathOf(undefined), '');
  assert.equal(workflowPathOf(null), '');
  const suffixed = run({ path: '.github/workflows/ci.yml@refs/heads/feat/t1-x' });
  const plain = run();
  assert.deepEqual(selectRuns([suffixed, plain]).map((r) => r.id).sort(), [suffixed.id, plain.id].sort());
  // and the suffix does not widen the match to another workflow or a lookalike
  for (const p of ['.github/workflows/xci.yml@refs/heads/main', '.github/workflows/consult-hold-guard.yml@refs/heads/main', '.github/workflows/ci.yml.bak@refs/heads/main', '@refs/heads/ci.yml', '.github/workflows/other@ci.yml']) {
    assert.deepEqual(selectRuns([run({ path: p })]), [], p);
  }
});

test('t/806: examined N runs, matched M is always printed: with matches, with none, and with runs examined but none matching (the silent zero)', () => {
  const lines = (runs) => { const out = []; makeRoom({ repo: 'o/r', ghFn: fakeGh(runs), now: NOW, log: (l) => out.push(l) }); return out; };
  // two matching runs plus a completed run and an incident run that are examined but not matched
  const a = lines([run(), run({ status: 'in_progress' }), run({ head_branch: 'incident/t1-x' })]);
  assert.ok(a.includes('ci-make-room: examined 3 runs, matched 2'), a.join('\n'));
  // nothing at all
  assert.ok(lines([]).includes('ci-make-room: examined 0 runs, matched 0'));
  // runs examined, none matched: a path the filter stopped matching must read 'examined 2, matched 0', not just an empty list
  const z = lines([run({ path: '.github/workflows/renamed-ci.yml' }), run({ event: 'push', head_branch: 'main' })]);
  assert.ok(z.includes('ci-make-room: examined 2 runs, matched 0'), z.join('\n'));
  // it is printed in cancel mode too, before anything is cancelled
  const out = [];
  makeRoom({ repo: 'o/r', cancel: true, incident: 't/9', by: 'cad2074a-520d-414b-a665-d505a9d24de5', ghFn: fakeGh([run()]), now: NOW, log: (l) => out.push(l) });
  assert.ok(out.indexOf('ci-make-room: examined 1 runs, matched 1') >= 0);
  assert.ok(out.indexOf('ci-make-room: examined 1 runs, matched 1') < out.findIndex((l) => l.includes('CANCELLED')));
});
