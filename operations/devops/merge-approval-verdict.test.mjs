// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/537: unit tests for the pure merge-approval verdict.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMENT_AUTHOR_ALLOWLIST, evaluateGroup, evaluatePullRequest, failureVerdict, inputProblems, isOwnerRole,
  pickGateApproval, predicateComments, predicateReviews, ruleGateFiles, ruleT1Approval, ruleTierHonesty,
} from './merge-approval-verdict.mjs';
import { REVIEWER_APP_REST_LOGIN } from './gate-file-change.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TIER_CONFIG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.github', 'ci', 'tier-paths.json'), 'utf8'));
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const APP = REVIEWER_APP_REST_LOGIN;
const SCOPE_OK = { ok: true, detail: 'installed on AI-Rosetta-Stone/ai-triad-research only' };

function review({ login = APP, state = 'APPROVED', body = 'Approved (Quality): fine', commit = HEAD, at = '2026-11-20T10:00:00Z', id = 1, assoc = 'NONE' } = {}) {
  return { id, user: { login }, state, body, commit_id: commit, submitted_at: at, author_association: assoc };
}
function comment({ login = APP, body, at = '2026-11-20T10:00:00Z' }) {
  return { user: { login }, body, created_at: at, updated_at: at };
}
function pr(over = {}) {
  return {
    number: 7, headSha: HEAD, body: 'Tier: T0\n\nchore', headRefName: 'devops/t537-x',
    files: [{ filename: 'docs/readme.md' }], filesTruncated: false, scriptsGatePaths: [], reviews: [], comments: [], lastPushAt: null, labels: [],
    ...over,
  };
}

test('a plain T0 docs PR passes every rule', () => {
  const r = evaluatePullRequest(pr(), { tierConfig: TIER_CONFIG });
  assert.equal(r.ok, true, r.lines.join('\n'));
  assert.equal(r.lines.length, 5, 'one header line and one line per rule');
});

test('missing input fails with the field named, never passes', () => {
  for (const field of ['number', 'headSha', 'body', 'headRefName', 'files', 'filesTruncated', 'reviews', 'comments', 'labels']) {
    const input = pr();
    delete input[field];
    const r = evaluatePullRequest(input, { tierConfig: TIER_CONFIG });
    assert.equal(r.ok, false, field);
    assert.match(r.lines.join('\n'), new RegExp(`missing or malformed: .*${field}`));
  }
  assert.deepEqual(inputProblems(null), ['the PR input is missing']);
  assert.deepEqual(inputProblems(pr({ headSha: 'abc' })), ['headSha']);
});

// ---- Rule A ---------------------------------------------------------------------------------

test('A: a gate file with no approval fails', () => {
  const r = ruleGateFiles(pr({ files: [{ filename: '.github/workflows/ci.yml' }] }));
  assert.equal(r.ok, false);
  assert.match(r.detail, /\.github\/workflows\/ci\.yml/);
});

test('A: a reviewer-App Tech Lead or Security approval at the head passes', () => {
  for (const role of ['Tech Lead', 'Security']) {
    const r = ruleGateFiles(pr({ files: [{ filename: 'operations/devops/enqueue-pr.mjs' }], reviews: [review({ body: `Approved (${role}): ok`, id: 9 })] }));
    assert.equal(r.ok, true, r.detail);
    assert.match(r.detail, new RegExp(`approved by ${role} \\(review 9\\)`));
  }
});

test('A: the approval must be the App, APPROVED, at the head, and Tech Lead or Security', () => {
  const files = [{ filename: '.github/ci/tier-paths.json' }];
  const bad = [
    review({ login: 'jpsnover', body: 'Approved (Tech Lead): ok' }),
    review({ state: 'COMMENTED', body: 'Approved (Tech Lead): ok' }),
    review({ commit: OLD, body: 'Approved (Tech Lead): ok' }),
    review({ body: 'Approved (Quality): ok' }),
    review({ body: 'LGTM. Approved (Tech Lead): ok' }),
  ];
  for (const b of bad) assert.equal(ruleGateFiles(pr({ files, reviews: [b] })).ok, false, JSON.stringify(b));
});

test('A: a rename away from a gate file counts (previous_filename)', () => {
  const r = ruleGateFiles(pr({ files: [{ filename: 'docs/x.yml', previous_filename: '.github/workflows/ci.yml' }] }));
  assert.equal(r.ok, false);
});

test('A: a truncated file list fails even with an approval', () => {
  const r = ruleGateFiles(pr({ filesTruncated: true, reviews: [review({ body: 'Approved (Security): ok' })] }));
  assert.equal(r.ok, false);
  assert.match(r.detail, /cut short/);
});

test('A: the branch owner\'s own role does not release its gate change', () => {
  const files = [{ filename: '.github/workflows/ci.yml' }];
  const r = ruleGateFiles(pr({ headRefName: 'security/t1-x', files, reviews: [review({ body: 'Approved (Security): mine' })] }));
  assert.equal(r.ok, false);
  const ok = ruleGateFiles(pr({ headRefName: 'security/t1-x', files, reviews: [review({ body: 'Approved (Tech Lead): theirs' })] }));
  assert.equal(ok.ok, true, ok.detail);
  assert.equal(isOwnerRole('Tech Lead', 'techlead/x'), true);
  assert.equal(isOwnerRole('Tech Lead', 'devops/x'), false);
});

test('A: an outstanding changes-request blocks a released gate change', () => {
  const files = [{ filename: '.github/workflows/ci.yml' }];
  const reviews = [
    review({ body: 'Approved (Tech Lead): ok', at: '2026-11-20T10:00:00Z', id: 1 }),
    review({ state: 'CHANGES_REQUESTED', body: 'Changes requested (Security): no', at: '2026-11-20T11:00:00Z', id: 2 }),
  ];
  const r = ruleGateFiles(pr({ files, reviews }));
  assert.equal(r.ok, false);
  assert.match(r.detail, /outstanding from Security/);
});

test('A: pickGateApproval takes the latest qualifying review', () => {
  const got = pickGateApproval([
    review({ id: 1, body: 'Approved (Tech Lead): a', at: '2026-11-20T10:00:00Z' }),
    review({ id: 2, body: 'Approved (Security): b', at: '2026-11-20T12:00:00Z' }),
  ], HEAD);
  assert.equal(got.id, 2);
});

// ---- Rule B ---------------------------------------------------------------------------------

const T1 = 'Tier: T1\n\nfeature';

test('B: a declared T0 passes and says so', () => {
  assert.deepEqual(ruleT1Approval(pr({ body: 'Tier: T0\n' })), { ok: true, detail: 'not T1 or T2 (declared T0)' });
});

test('B: T2 needs the same approval at the head as T1; declaring T2 never skips rule B', () => {
  assert.equal(ruleT1Approval(pr({ body: 'Tier: T2\n\nbig change' })).ok, false);
  assert.match(ruleT1Approval(pr({ body: 'Tier: T2\n' })).detail, /^T2, no reviewer-App approval/);
  assert.equal(ruleT1Approval(pr({ body: 'Tier: T2\n', reviews: [review({ commit: OLD })] })).ok, false);
  const ok = ruleT1Approval(pr({ body: 'Tier: T2\n', reviews: [review({ body: 'Approved (Tech Lead): T2 ok' })] }));
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /^T2, approved by/);
});

test('B: T1 with a reviewer-App approval review at the head passes', () => {
  const r = ruleT1Approval(pr({ body: T1, reviews: [review({ body: 'Approved (Quality): ok' })] }));
  assert.equal(r.ok, true, r.detail);
});

test('B: T1 with no approval, or an approval at an older head, fails', () => {
  assert.equal(ruleT1Approval(pr({ body: T1 })).ok, false);
  assert.equal(ruleT1Approval(pr({ body: T1, reviews: [review({ commit: OLD })] })).ok, false);
});

test('B: an approval COMMENT never satisfies, even from the reviewer App (comments are not head-bound)', () => {
  assert.equal(ruleT1Approval(pr({ body: T1, comments: [comment({ body: 'Approved (Quality): ok', at: '2099-01-01T00:00:00Z' })] })).ok, false);
});

test('B: the shared jpsnover login and other accounts are not on the comment allowlist', () => {
  assert.deepEqual(COMMENT_AUTHOR_ALLOWLIST, [APP]);
  assert.equal(predicateComments([comment({ login: 'jpsnover', body: 'Approved (Quality): ok' })]).length, 0);
  // A non-App approval comment does not approve...
  assert.equal(ruleT1Approval(pr({ body: T1, comments: [comment({ login: 'jpsnover', body: 'Approved (Quality): ok' })] })).ok, false);
});

test('B: a human approval review never counts', () => {
  const r = ruleT1Approval(pr({ body: T1, reviews: [review({ login: 'jpsnover', assoc: 'OWNER', body: 'Approved (Quality): ok' })] }));
  assert.equal(r.ok, false);
});

test('B: a changes-request at the head blocks, from the App (another role) or a write-level human', () => {
  const approve = review({ id: 1, body: 'Approved (Quality): ok', at: '2026-11-20T10:00:00Z' });
  const appCr = review({ id: 2, state: 'CHANGES_REQUESTED', body: 'Changes requested (Security): no', at: '2026-11-20T11:00:00Z' });
  const humanCr = review({ id: 3, login: 'jpsnover', assoc: 'OWNER', state: 'CHANGES_REQUESTED', body: 'no', at: '2026-11-20T11:00:00Z' });
  assert.match(ruleT1Approval(pr({ body: T1, reviews: [approve, appCr] })).detail, /changes-request outstanding from Security/);
  assert.match(ruleT1Approval(pr({ body: T1, reviews: [approve, humanCr] })).detail, /changes-request outstanding from @jpsnover/);
});

test('B: a changes-request from an account without write association does not block', () => {
  const approve = review({ id: 1, body: 'Approved (Quality): ok', at: '2026-11-20T10:00:00Z' });
  const drive = review({ id: 3, login: 'someone', assoc: 'NONE', state: 'CHANGES_REQUESTED', body: 'no', at: '2026-11-20T11:00:00Z' });
  assert.equal(ruleT1Approval(pr({ body: T1, reviews: [approve, drive] })).ok, true);
  assert.equal(predicateReviews([drive]).length, 0);
});

test('B: a reviewer-App changes-request COMMENT blocks (sticky), and the same role\'s later review clears it', () => {
  const cr = comment({ body: 'Changes requested (Quality): fix it', at: '2026-11-20T09:00:00Z' });
  assert.equal(ruleT1Approval(pr({ body: T1, comments: [cr], reviews: [review({ body: 'Approved (Security): ok' })] })).ok, false);
  assert.equal(ruleT1Approval(pr({ body: T1, comments: [cr], reviews: [review({ body: 'Approved (Quality): ok' })] })).ok, true);
});

test('B: self-approval by the branch owner\'s role fails', () => {
  assert.equal(ruleT1Approval(pr({ body: T1, headRefName: 'quality/t1', reviews: [review({ body: 'Approved (Quality): mine' })] })).ok, false);
});

// ---- Rule C ---------------------------------------------------------------------------------

test('C: an R1 path declared below T2 fails; declared T2 passes', () => {
  const files = [{ filename: '.github/ci/required-contexts.json' }];
  assert.equal(ruleTierHonesty(pr({ files }), TIER_CONFIG).ok, false);
  assert.equal(ruleTierHonesty(pr({ files, body: 'Tier: T1\n' }), TIER_CONFIG).ok, false);
  assert.equal(ruleTierHonesty(pr({ files, body: 'Tier: T2\n' }), TIER_CONFIG).ok, true);
});

test('C: an R1 glob and a rename away from an R1 path count', () => {
  assert.equal(ruleTierHonesty(pr({ files: [{ filename: 'operations/devops/Move-PiCredentialToKeePass.ps1' }] }), TIER_CONFIG).ok, false);
  assert.equal(ruleTierHonesty(pr({ files: [{ filename: 'x.json', previous_filename: 'deploy/azure/main.bicep' }] }), TIER_CONFIG).ok, false);
});

test('C: a breaking schema change below T2 fails', () => {
  const files = [{ filename: 'lib/schema/node.json' }];
  assert.equal(ruleTierHonesty(pr({ files, body: 'Tier: T1\nSchema-change: breaking' }), TIER_CONFIG).ok, false);
  assert.equal(ruleTierHonesty(pr({ files, body: 'Tier: T1\nSchema-change: additive' }), TIER_CONFIG).ok, true);
});

test('C: a missing or malformed tier config fails; a truncated list fails', () => {
  assert.equal(ruleTierHonesty(pr(), null).ok, false);
  assert.equal(ruleTierHonesty(pr(), { r1Paths: 'x' }).ok, false);
  assert.equal(ruleTierHonesty(pr({ filesTruncated: true }), TIER_CONFIG).ok, false);
});

// ---- group ----------------------------------------------------------------------------------

test('group: success only when every PR passes and the scope is OK', () => {
  const good = pr({ number: 1 });
  const bad = pr({ number: 2, files: [{ filename: '.github/workflows/ci.yml' }] });
  const ok = evaluateGroup({ prs: [good], tierConfig: TIER_CONFIG, scope: SCOPE_OK });
  assert.equal(ok.conclusion, 'success');
  assert.match(ok.title, /OK \(1 PR\)/);
  const mixed = evaluateGroup({ prs: [good, bad], tierConfig: TIER_CONFIG, scope: SCOPE_OK, context: ['Merge group x'] });
  assert.equal(mixed.conclusion, 'failure');
  assert.match(mixed.title, /BLOCKED #2 \(A\)/);
  assert.match(mixed.summary, /^Merge group x\nInstallation scope: OK/);
  assert.match(mixed.summary, /#1 at aaaaaaaaa: PASS/);
  assert.match(mixed.summary, /#2 at aaaaaaaaa: FAIL\n {2}A gate-files: FAIL/);
});

test('group: a bad or missing installation scope fails a clean PR', () => {
  assert.equal(evaluateGroup({ prs: [pr()], tierConfig: TIER_CONFIG, scope: { ok: false, detail: 'two repos' } }).conclusion, 'failure');
  assert.equal(evaluateGroup({ prs: [pr()], tierConfig: TIER_CONFIG }).conclusion, 'failure');
});

test('group: no PRs is a failure, and the verdict is never neutral', () => {
  const v = evaluateGroup({ prs: [], tierConfig: TIER_CONFIG, scope: SCOPE_OK });
  assert.equal(v.conclusion, 'failure');
  assert.equal(failureVerdict('x').conclusion, 'failure');
  for (const input of [pr(), pr({ body: T1 }), pr({ headSha: null })]) {
    assert.ok(['success', 'failure'].includes(evaluateGroup({ prs: [input], tierConfig: TIER_CONFIG, scope: SCOPE_OK }).conclusion));
  }
});

test('group: the summary is deterministic (the race check compares summaries)', () => {
  const a = evaluateGroup({ prs: [pr({ body: T1 })], tierConfig: TIER_CONFIG, scope: SCOPE_OK });
  const b = evaluateGroup({ prs: [pr({ body: T1 })], tierConfig: TIER_CONFIG, scope: SCOPE_OK });
  assert.deepEqual(a, b);
});
