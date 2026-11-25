// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Run: node --test operations/devops/dependabot-enqueue-sweep.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkVerdict, classifyEnqueueFailure, selectSweepCandidates, normalizePR, pendingCheckNames, sweep } from './dependabot-enqueue-sweep.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const green = [
  { name: 'ci-gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { name: 'CodeQL Analysis', status: 'COMPLETED', conclusion: 'SUCCESS' },
];
const pr = (over = {}) => ({
  number: 1, headRefOid: 'abc', isDraft: false, isInMergeQueue: false, isCrossRepository: false,
  author: { typename: 'Bot', login: 'dependabot' },
  mergeStateStatus: 'BLOCKED', autoMergeRequest: { enabledAt: 't' }, contexts: green, ...over,
});

test('checkVerdict: success, failed, pending, missing', () => {
  assert.equal(checkVerdict(green, 'ci-gate'), 'success');
  assert.equal(checkVerdict([{ name: 'ci-gate', status: 'COMPLETED', conclusion: 'FAILURE' }], 'ci-gate'), 'failed');
  assert.equal(checkVerdict([{ name: 'ci-gate', status: 'IN_PROGRESS', conclusion: null }], 'ci-gate'), 'pending');
  assert.equal(checkVerdict([], 'ci-gate'), 'missing');
});

test('checkVerdict: a successful rerun after a failure counts as success', () => {
  const runs = [
    { name: 'ci-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
    { name: 'ci-gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
  ];
  assert.equal(checkVerdict(runs, 'ci-gate'), 'success');
});

test('checkVerdict: a rerun still in progress is pending even if an earlier run passed', () => {
  const runs = [
    { name: 'ci-gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'ci-gate', status: 'QUEUED', conclusion: null },
  ];
  assert.equal(checkVerdict(runs, 'ci-gate'), 'pending');
});

test('checkVerdict: reads commit-status contexts (context/state) too', () => {
  assert.equal(checkVerdict([{ context: 'ci-gate', state: 'SUCCESS' }], 'ci-gate'), 'success');
  assert.equal(checkVerdict([{ context: 'ci-gate', state: 'PENDING' }], 'ci-gate'), 'pending');
});

test('selectSweepCandidates: armed, green, unqueued PR is enqueued at its head', () => {
  const { enqueue, skip } = selectSweepCandidates([pr()]);
  assert.deepEqual(enqueue, [{ number: 1, headRefOid: 'abc' }]);
  assert.deepEqual(skip, []);
});

test('selectSweepCandidates: skips each disqualifying state with a reason', () => {
  const { enqueue, skip } = selectSweepCandidates([
    pr({ number: 2, isCrossRepository: true }),
    pr({ number: 3, author: { typename: 'Bot', login: 'dependabot-helper' } }),
    pr({ number: 4, author: { typename: 'User', login: 'dependabot' } }),
    pr({ number: 5, isInMergeQueue: true }),
    pr({ number: 6, isDraft: true }),
    pr({ number: 7, autoMergeRequest: null }),
    pr({ number: 8, mergeStateStatus: 'DIRTY' }),
    pr({ number: 9, contexts: [green[0]] }),
    pr({ number: 10, contexts: [{ name: 'ci-gate', status: 'COMPLETED', conclusion: 'FAILURE' }, green[1]] }),
  ]);
  assert.deepEqual(enqueue, []);
  assert.deepEqual(skip.map((s) => s.number), [2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.match(skip.find((s) => s.number === 2).reason, /fork PR/);
  assert.match(skip.find((s) => s.number === 3).reason, /author is not Bot\/dependabot/);
  assert.match(skip.find((s) => s.number === 4).reason, /author is not Bot\/dependabot/);
  assert.match(skip.find((s) => s.number === 7).reason, /minor\/patch policy/);
  assert.match(skip.find((s) => s.number === 9).reason, /CodeQL Analysis is missing/);
  assert.match(skip.find((s) => s.number === 10).reason, /ci-gate is failed/);
});

test('selectSweepCandidates: fork PR is never enqueued, even if otherwise fully green and armed', () => {
  const { enqueue, skip } = selectSweepCandidates([pr({ number: 1, isCrossRepository: true })]);
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /fork PR/);
});

test('selectSweepCandidates: unknown (missing) isCrossRepository fails closed as a fork', () => {
  const { enqueue, skip } = selectSweepCandidates([pr({ number: 1, isCrossRepository: undefined })]);
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /fork PR/);
});

test('selectSweepCandidates: lookalike author (not exactly Bot/dependabot) is never enqueued', () => {
  const { enqueue, skip } = selectSweepCandidates([pr({ number: 1, author: { typename: 'Bot', login: 'dependabot-helper' } })]);
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /author is not Bot\/dependabot/);
});

test('selectSweepCandidates: wrong typename (not Bot) is never enqueued', () => {
  const { enqueue, skip } = selectSweepCandidates([pr({ number: 1, author: { typename: 'User', login: 'dependabot' } })]);
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /author is not Bot\/dependabot/);
});

test('normalizePR: converts GraphQL __typename to typename and enqueues valid Dependabot PR', () => {
  // Verbatim GraphQL shape from #4282 (TL reference)
  const graphqlNode = {
    number: 4282,
    headRefOid: 'abc123',
    isDraft: false,
    isInMergeQueue: false,
    isCrossRepository: false,
    mergeStateStatus: 'BLOCKED',
    autoMergeRequest: { enabledAt: '2026-11-02T00:00:00Z' },
    author: { __typename: 'Bot', login: 'dependabot' },
    commits: {
      nodes: [{
        commit: {
          statusCheckRollup: {
            contexts: {
              nodes: [
                { name: 'ci-gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
                { name: 'CodeQL Analysis', status: 'COMPLETED', conclusion: 'SUCCESS' },
              ],
            },
          },
        },
      }],
    },
  };
  const normalized = normalizePR(graphqlNode);
  const { enqueue, skip } = selectSweepCandidates([normalized]);
  assert.deepEqual(enqueue, [{ number: 4282, headRefOid: 'abc123' }]);
  assert.deepEqual(skip, []);
});

test('pendingCheckNames: lists every run not yet finished, required or not (t/403)', () => {
  assert.deepEqual(pendingCheckNames(green), []);
  assert.deepEqual(pendingCheckNames([...green, { name: 'Stray File Guard', status: 'IN_PROGRESS', conclusion: null }]), ['Stray File Guard']);
  assert.deepEqual(pendingCheckNames([{ context: 'docs-lint', state: 'PENDING' }]), ['docs-lint']);
  assert.deepEqual(pendingCheckNames([{ name: 'x', status: 'QUEUED', conclusion: null }]), ['x']);
});

test('selectSweepCandidates: a green PR with a non-required check still running is not armed (t/403)', () => {
  const contexts = [...green, { name: 'Stray File Guard', status: 'IN_PROGRESS', conclusion: null }];
  const { enqueue, skip } = selectSweepCandidates([pr({ contexts })]);
  assert.deepEqual(enqueue, []);
  assert.match(skip[0].reason, /^1 check\(s\) still running \(Stray File Guard\)/);
});

// ── t/600 (incident #5509): a refused Dependabot PR is never re-armed; only a transient failure retries ──

const GREEN_PR = {
  number: 77, headRefOid: 'a'.repeat(40), isDraft: false, isInMergeQueue: false, mergeStateStatus: 'CLEAN',
  autoMergeRequest: { enabledAt: 'x' }, isCrossRepository: false, author: { typename: 'Bot', login: 'dependabot' },
  contexts: [{ name: 'ci-gate', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'CodeQL Analysis', status: 'COMPLETED', conclusion: 'SUCCESS' }],
};
function harness(enqueueImpl) {
  const calls = { gh: [], enqueue: 0, sleeps: [] };
  const deps = {
    list: () => [GREEN_PR],
    readLive: () => ({ state: 'OPEN', isInMergeQueue: false, isDraft: false, headRefOid: GREEN_PR.headRefOid }),
    gh: (args) => {
      calls.gh.push(args);
      if (args.join(' ').includes('pullRequest(number')) return JSON.stringify({ data: { repository: { pullRequest: { id: 'PR_1', autoMergeRequest: { enabledAt: 'x' } } } } });
      return '{}';
    },
    enqueue: async (...a) => { calls.enqueue++; return enqueueImpl(calls.enqueue, ...a); },
    sleep: async (ms) => { calls.sleeps.push(ms); },
  };
  return { calls, deps };
}
const refusal = (reason) => new Error(`enqueue-pr: refusing to arm/enqueue #77 on o/r (${reason}).\n  Goal: …`);
const quietly = async (fn) => {
  const o = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, o); }
};

test('t/600: classifyEnqueueFailure: every enqueue-pr refusal is policy; anything else is transient', () => {
  for (const r of ['gate_files_no_override', 'over_budget_today', 'no_approval', 'no_auto_enqueue', 'differs']) {
    assert.deepEqual(classifyEnqueueFailure(refusal(r)), { kind: 'policy', reason: r });
  }
  assert.equal(classifyEnqueueFailure(new Error('gh: HTTP 502')).kind, 'transient');
  assert.equal(classifyEnqueueFailure(new Error('still not enqueued after the GraphQL fallback')).kind, 'transient');
});

test('t/600: a POLICY refusal leaves the PR unarmed: no retry, no re-arm, no `gh pr merge` of any kind', async () => {
  for (const reason of ['gate_files_no_override', 'over_budget_today', 'no_approval']) {
    const { calls, deps } = harness(() => { throw refusal(reason); });
    await assert.rejects(() => quietly(() => sweep('o/r', { deps })), /did not enqueue #77/);
    assert.equal(calls.enqueue, 1, `${reason}: enqueue is tried once and never retried`);
    assert.deepEqual(calls.sleeps, [], reason);
    assert.ok(calls.gh.every((a) => !(a[0] === 'pr' && a[1] === 'merge')), `${reason}: no gh pr merge (re-arm or otherwise)`);
    assert.ok(calls.gh.some((a) => a.join(' ').includes('disablePullRequestAutoMerge')), `${reason}: the policy arm was removed through GraphQL`);
  }
});

test('t/600: a TRANSIENT failure retries once through enqueue-pr; a second failure leaves it unarmed too', async () => {
  const ok = harness((n) => { if (n === 1) throw new Error('gh: HTTP 502'); return { usedFallback: false, state: 'queued' }; });
  const r = await quietly(() => sweep('o/r', { deps: ok.deps }));
  assert.equal(r.enqueued, 1); assert.equal(ok.calls.enqueue, 2); assert.deepEqual(ok.calls.sleeps, [10000]);
  const bad = harness(() => { throw new Error('gh: HTTP 502'); });
  await assert.rejects(() => quietly(() => sweep('o/r', { deps: bad.deps })), /did not enqueue #77/);
  assert.equal(bad.calls.enqueue, 2);
  assert.ok(bad.calls.gh.every((a) => !(a[0] === 'pr' && a[1] === 'merge')));
  const refusedOnRetry = harness((n) => { if (n === 1) throw new Error('gh: HTTP 502'); throw refusal('gate_files_no_override'); });
  await assert.rejects(() => quietly(() => sweep('o/r', { deps: refusedOnRetry.deps })), /did not enqueue #77/);
  assert.equal(refusedOnRetry.calls.enqueue, 2);
});

// ---- t/600 pin, narrowed by t/601 (Security p/131#68) ----
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const AUTO_MERGE_YML = '.github/workflows/dependabot-auto-merge.yml';
const ARM_STEP_NAME = 'Arm auto-merge for minor/patch bumps';
const DEFAULT_TOKEN = /^\$\{\{\s*(secrets\.GITHUB_TOKEN|github\.token)\s*\}\}$/;
// The exempt line, exactly: anything chained onto it, or any other form, is not exempt.
const ARM_RUN = 'run: gh pr merge --auto --squash "$PR_URL"';

/** PURE. Every `gh pr merge` invocation in `text` (file `f`), as 'f:line', except the lines in `allowedLines`. */
function ghPrMergeOffenders(f, text, allowedLines = new Set()) {
  const offenders = [];
  text.split('\n').forEach((line, i) => {
    const code = line.replace(/^\s*(#|\/\/|\*).*$/, '');
    const at = `${f}:${i + 1}`;
    if (allowedLines.has(at)) return;
    if (/['"]pr['"]\s*,\s*['"]merge['"]/.test(code)) offenders.push(at); // execFile-style argv
    if (/^\s*(run:\s*)?gh\s+pr\s+merge\b/.test(code) || /[;&|]\s*gh\s+pr\s+merge\b/.test(code)) offenders.push(at); // shell invocation
  });
  return offenders;
}

/**
 * PURE. The arm step's block in dependabot-auto-merge.yml: from its `- name:` line to the next line at
 * the same or a shallower indent. `runLine` is the 1-based line that is exactly ARM_RUN, the only line
 * the pin exempts. Null when the step or that line is missing.
 */
function autoMergeArmStep(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^\s*-\s+name:\s*/.test(l) && l.replace(/^\s*-\s+name:\s*/, '').trim().replace(/^['"]|['"]$/g, '') === ARM_STEP_NAME);
  if (start < 0) return null;
  const indent = lines[start].search(/\S/);
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === '' || lines[end].search(/\S/) > indent)) end++;
  const block = lines.slice(start, end);
  const runIdx = block.findIndex((l) => l.trim() === ARM_RUN);
  return runIdx < 0 ? null : { runLine: start + 1 + runIdx, block };
}

/**
 * PURE (t/601). What would let the exempt arm run as anything but the workflow's own token:
 * (a) a GH_TOKEN or GITHUB_TOKEN anywhere in the file (step, job or workflow env) that is not
 * secrets.GITHUB_TOKEN / github.token; (b) any create-github-app-token use. [] when clean.
 */
function autoMergeTokenViolations(text) {
  const out = [];
  if (!autoMergeArmStep(text)) out.push(`no '${ARM_STEP_NAME}' step whose run line is exactly \`${ARM_RUN}\` (renamed or changed? update this pin)`);
  // t/601 residual (Security): EVERY token-valued key (GH_TOKEN, GITHUB_TOKEN, an action's `github-token:`,
  // `token:`, `repo-token:`, any key containing 'token') must be the default token, wherever it sits.
  for (const l of text.split('\n').filter((x) => /^\s*-?\s*[\w-]*token[\w-]*\s*:/i.test(x))) {
    if (!DEFAULT_TOKEN.test(l.replace(/^\s*-?\s*[\w-]*token[\w-]*\s*:\s*/i, '').trim().replace(/^['"]|['"]$/g, ''))) out.push(`non-default token: ${l.trim()}`);
  }
  // ...and no other secret is read at all, so an App key can't come in under a key not named '*token*'.
  for (const m of text.matchAll(/\bsecrets\.([A-Za-z0-9_]+)/g)) {
    if (m[1] !== 'GITHUB_TOKEN') out.push(`reads a secret other than GITHUB_TOKEN: secrets.${m[1]}`);
  }
  if (/create-github-app-token/.test(text)) out.push('uses create-github-app-token');
  return out;
}

function allowedArmLines(text) {
  const step = autoMergeArmStep(text);
  return new Set(step ? [`${AUTO_MERGE_YML}:${step.runLine}`] : []);
}

test('t/600 pin (Security p/131#66): no `gh pr merge` is INVOKED outside enqueue-pr.mjs in operations/devops or .github', () => {
  const files = execFileSync('git', ['ls-files', 'operations/devops', '.github'], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n')
    .filter((f) => /\.(mjs|js|cjs|sh|ps1|ya?ml)$/.test(f) && !/\.test\.mjs$|\.Tests\.ps1$|test-[^/]*\.sh$/.test(f));
  // Allowed: the wrapper itself, and ONE line elsewhere (t/601, Security p/131#68): the `run:` line of
  // dependabot-auto-merge.yml's 'Arm auto-merge for minor/patch bumps' step, the GITHUB_TOKEN
  // policy-marker arm, which never enters the queue (t/600: GitHub doesn't start queue entry for a
  // GITHUB_TOKEN arm; the sweep removes it with GraphQL before enqueue-pr.mjs arms as the App). Any
  // other `gh pr merge` in that file is an offender.
  const offenders = [];
  for (const f of files) {
    if (f === 'operations/devops/enqueue-pr.mjs') continue;
    const text = fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
    offenders.push(...ghPrMergeOffenders(f, text, f === AUTO_MERGE_YML ? allowedArmLines(text) : undefined));
  }
  assert.deepEqual(offenders, []);
});

test('t/601: the exempt arm step runs on GITHUB_TOKEN; the file sets no other token and mints no App token', () => {
  assert.deepEqual(autoMergeTokenViolations(fs.readFileSync(path.join(REPO_ROOT, AUTO_MERGE_YML), 'utf8')), []);
});

test('t/601: mutations of dependabot-auto-merge.yml that the narrowed pin must catch', () => {
  const real = fs.readFileSync(path.join(REPO_ROOT, AUTO_MERGE_YML), 'utf8');
  const offenders = (text) => ghPrMergeOffenders(AUTO_MERGE_YML, text, allowedArmLines(text));
  assert.deepEqual(offenders(real), [], 'the real file is clean');
  const mutate = (re, to) => { const t = real.replace(re, to); assert.notEqual(t, real, `mutation applied: ${re}`); return t; };

  // A second step that also arms: outside the one exempt line -> an offender.
  const extra = `${real.replace(/\n*$/, '\n')}      - name: Sneaky\n        run: gh pr merge --auto --squash "$PR_URL"\n`;
  assert.equal(offenders(extra).length, 1, 'an added arming step is caught');
  // Anything chained onto the exempt line, or a multi-line run block, is not the exempt line.
  const chained = mutate(ARM_RUN, `${ARM_RUN} && gh pr merge --admin 5509`);
  assert.equal(offenders(chained).length, 1, 'a command chained onto the arm line is caught');
  const multi = mutate(/run: gh pr merge --auto --squash "\$PR_URL"/, 'run: |\n          gh pr merge --auto --squash "$PR_URL"');
  assert.equal(offenders(multi).length, 1, 'a multi-line run block is not the exempt single line');
  // (a) An App token in the arm step's env, or at job level.
  assert.ok(autoMergeTokenViolations(mutate(/(GH_TOKEN:\s*)\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/, '$1${{ steps.app.outputs.token }}')).some((v) => v.startsWith('non-default token')));
  assert.ok(autoMergeTokenViolations(mutate(/(GH_TOKEN:\s*)\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/, '$1${{ secrets.AGENT_APP_KEY }}')).length > 0);
  // t/601 residual: any other token-valued input (fetch-metadata's `github-token:`, a checkout `token:`),
  // and any non-GITHUB_TOKEN secret under any key name.
  assert.ok(autoMergeTokenViolations(mutate(/(github-token:\s*)\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/, '$1${{ steps.app.outputs.token }}')).some((v) => v.includes('github-token:')));
  assert.ok(autoMergeTokenViolations(`${real}\n      - uses: actions/checkout@v4\n        with:\n          token: "\${{ steps.app.outputs.token }}"\n`).some((v) => v.includes('token: "')));
  assert.ok(autoMergeTokenViolations(`${real}\n      - uses: some/action@v1\n        with:\n          private-key: \${{ secrets.AGENT_APP_KEY }}\n`).includes('reads a secret other than GITHUB_TOKEN: secrets.AGENT_APP_KEY'));
  // The default token in any of its forms (quoted, github.token) is accepted.
  assert.deepEqual(autoMergeTokenViolations(mutate(/(github-token:\s*)\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/, "$1'${{ github.token }}'")), []);
  // (b) Minting an App token anywhere in the file.
  assert.ok(autoMergeTokenViolations(`${real}\n      - uses: actions/create-github-app-token@v1\n`).includes('uses create-github-app-token'));
  // The step renamed: the exemption disappears (its run line becomes an offender) and the token test says why.
  const renamed = mutate(`name: ${ARM_STEP_NAME}`, 'name: Arm it');
  assert.equal(offenders(renamed).length, 1);
  assert.ok(autoMergeTokenViolations(renamed)[0].startsWith(`no '${ARM_STEP_NAME}' step`));
});
