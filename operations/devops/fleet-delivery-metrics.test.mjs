// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distribution,
  attributePRsToDeploys,
  leadTimeLegs,
  mainRedRate,
  deploymentFailureRate,
  mainRecoveryMinutes,
  deployRecoveryMinutes,
  reworkRate,
  approvalWaitByTier,
  splitT2ApprovalWait,
  findSoClearedAt,
  soRepliedAtHead,
  prSizeDistribution,
  openPRAgeDays,
  parsePILoadLines,
} from './fleet-delivery-metrics.mjs';

test('distribution: empty input returns nulls, never NaN', () => {
  const d = distribution([]);
  assert.equal(d.n, 0);
  assert.equal(d.median, null);
  assert.equal(d.mean, null);
});

test('distribution: basic median/p90/mean/max', () => {
  const d = distribution([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(d.n, 10);
  assert.equal(d.median, 6); // floor(0.5*10)=5 -> v[5]=6
  assert.equal(d.max, 10);
  assert.equal(d.mean, 5.5);
});

test('distribution: filters non-finite values', () => {
  const d = distribution([1, NaN, 3, Infinity]);
  assert.equal(d.n, 2);
});

test('attributePRsToDeploys: merge before a deploy attributes to it', () => {
  const prs = [{ mergedAt: '2026-01-01T00:00:00Z', firstCommitAt: '2025-12-31T22:00:00Z' }];
  const deploys = [{ deployedAt: '2026-01-01T02:00:00Z' }];
  const [r] = attributePRsToDeploys(prs, deploys);
  assert.equal(r.mergeToDeployMs, 2 * 3_600_000);
  assert.equal(r.firstCommitToDeployMs, 4 * 3_600_000);
});

test('attributePRsToDeploys: no later deploy is unattributed (null), not a crash', () => {
  const prs = [{ mergedAt: '2026-02-01T00:00:00Z' }];
  const deploys = [{ deployedAt: '2026-01-01T00:00:00Z' }];
  const [r] = attributePRsToDeploys(prs, deploys);
  assert.equal(r.mergeToDeployMs, null);
});

test('leadTimeLegs: computes all four legs and counts unattributed', () => {
  const prs = [
    { createdAt: '2026-01-01T00:00:00Z', firstCommitAt: '2026-01-01T00:00:00Z', mergedAt: '2026-01-01T01:00:00Z' },
  ];
  const attributed = attributePRsToDeploys(prs, [{ deployedAt: '2026-01-01T03:00:00Z' }]);
  const legs = leadTimeLegs(prs, attributed);
  assert.equal(legs.firstCommitToMergeHours.n, 1);
  assert.equal(legs.mergeToDeployedHours.median, 2);
  assert.equal(legs.unattributed, 0);
});

test('mainRedRate: counts failures over total', () => {
  const pushes = [{ conclusion: 'success' }, { conclusion: 'failure' }, { conclusion: 'success' }];
  const r = mainRedRate(pushes);
  assert.equal(r.total, 3);
  assert.equal(r.red, 1);
  assert.ok(Math.abs(r.pct - 33.333) < 0.01);
});

test('deploymentFailureRate: separates real deploy-job rollbacks from preflight blocks', () => {
  const deploys = [
    { conclusion: 'success', jobName: 'deploy' },
    { conclusion: 'failure', jobName: 'deploy' },
    { conclusion: 'failure', jobName: 'preflight' },
  ];
  const r = deploymentFailureRate(deploys);
  assert.equal(r.total, 3);
  assert.equal(r.dispatchFailures.count, 2);
  assert.equal(r.realRollbacks.count, 1);
  assert.equal(r.preflightBlocks.count, 1);
});

test('mainRecoveryMinutes: matches each failure to the next success', () => {
  const pushes = [
    { conclusion: 'failure', pushedAt: '2026-01-01T00:00:00Z' },
    { conclusion: 'success', pushedAt: '2026-01-01T00:30:00Z' },
  ];
  const d = mainRecoveryMinutes(pushes);
  assert.equal(d.n, 1);
  assert.equal(d.median, 30);
});

test('deployRecoveryMinutes: small n reported individually, no aggregate', () => {
  const r = deployRecoveryMinutes([
    { failedAt: '2026-01-01T00:00:00Z', recoveredAt: '2026-01-01T00:45:00Z' },
    { failedAt: '2026-02-01T00:00:00Z', recoveredAt: '2026-02-01T00:41:00Z' },
  ]);
  assert.equal(r.n, 2);
  assert.equal(r.aggregate, null); // below the n>=5 floor for aggregation
  assert.deepEqual(r.minutes, [45, 41]);
});

test('reworkRate: revert-titled PR always counts', () => {
  const prs = [{ title: 'Revert "feat: x"', mergedAt: '2026-01-01T00:00:00Z', changedFiles: ['a.ts'] }];
  const r = reworkRate(prs);
  assert.equal(r.reverts.count, 1);
  assert.equal(r.combined.count, 1);
});

test('reworkRate: fix-typed PR touching a file from a <72h-prior merge counts; batching outside window does not', () => {
  const prs = [
    { title: 'feat(x): add thing', mergedAt: '2026-01-01T00:00:00Z', changedFiles: ['a.ts'] },
    { title: 'fix(x): correct thing', mergedAt: '2026-01-01T10:00:00Z', changedFiles: ['a.ts'] }, // 10h later, overlaps
    { title: 'fix(x): unrelated', mergedAt: '2026-01-10T00:00:00Z', changedFiles: ['b.ts'] }, // no file overlap at all
  ];
  const r = reworkRate(prs);
  assert.equal(r.fixOverlaps.count, 1);
  assert.equal(r.combined.count, 1);
});

test('reworkRate: same-ticket batching with no file overlap is NOT counted (old-proxy false positive avoided)', () => {
  const prs = [
    { title: 'feat(t/100): part 1', mergedAt: '2026-01-01T00:00:00Z', changedFiles: ['a.ts'] },
    { title: 'feat(t/100): part 2', mergedAt: '2026-01-01T01:00:00Z', changedFiles: ['b.ts'] },
  ];
  const r = reworkRate(prs);
  assert.equal(r.combined.count, 0);
});

test('approvalWaitByTier: buckets by extractTier, defaults to none', () => {
  const prs = [
    { body: 'Tier: T0\n...', ciGreenAt: '2026-01-01T00:00:00Z', mergedAt: '2026-01-01T00:01:00Z' },
    { body: 'Tier: T2\n...', ciGreenAt: '2026-01-01T00:00:00Z', mergedAt: '2026-01-01T07:00:00Z' },
    { body: 'no tier line here', ciGreenAt: '2026-01-01T00:00:00Z', mergedAt: '2026-01-01T00:02:00Z' },
  ];
  const r = approvalWaitByTier(prs);
  assert.equal(r.T0.n, 1);
  assert.equal(r.T2.n, 1);
  assert.equal(r.none.n, 1);
});

test('findSoClearedAt: matches a comment whose OWN HEADER opens with "SO cleared"/"SO clearing comment", takes the FIRST such match', () => {
  const comments = [
    { body: 'Some unrelated discussion', createdAt: '2026-10-19T08:00:00Z' },
    { body: '**The SO cleared it at head `abc123`.**', createdAt: '2026-10-19T09:00:00Z' },
    { body: '**SO clearing comment (T2, head `def456`).**', createdAt: '2026-10-20T01:00:00Z' },
  ];
  assert.equal(findSoClearedAt(comments), '2026-10-19T09:00:00.000Z');
});

test('findSoClearedAt: does NOT match "SO re-confirmation ... Not cleared yet" (not a cleared/clearing/did-not-review header)', () => {
  const comments = [{ body: '**SO re-confirmation** at the new head. Not cleared yet; one gap remains.', createdAt: '2026-10-19T08:00:00Z' }];
  assert.equal(findSoClearedAt(comments), null);
});

test('findSoClearedAt: "SO did not review" also matches, when it opens the comment\'s own header', () => {
  const comments = [{ body: '**SO did not review.**\nGoing to the PI marked accordingly, per the time-box.', createdAt: '2026-10-19T10:00:00Z' }];
  assert.equal(findSoClearedAt(comments), '2026-10-19T10:00:00.000Z');
});

// t/4537 (TL, p/702#87): the original "latest text match anywhere in body" logic mis-picked a
// LATER comment that merely quotes an earlier clearance. Regression test using PR #3423's own
// real comment shape (t/4091#45): a genuine SO clearing comment, followed by a PI-approval
// comment that references the phrase in prose but is not itself an SO artifact.
test('findSoClearedAt: REGRESSION (#3423) -- a later PI-approval comment that merely QUOTES "SO clearing comment" in its body does NOT override the genuine earlier clearance', () => {
  const comments = [
    { body: '**SO review of #3423 at `77f541da`**\n\n**Recommendation:** proceed with conditions.', createdAt: '2026-10-19T15:12:46Z' },
    { body: '**SO clearing comment (T2, head `c24088d4`).** Delta from `716ccefa`: operational-commands.md', createdAt: '2026-10-20T00:28:09Z' },
    { body: '**PI approval (T2, head `c24088d4`).**\n\nSO conditions R1-R5 are met per the SO clearing comment. Approved to merge.', createdAt: '2026-10-20T18:18:52Z' },
  ];
  // The genuine clearance is 00:28:09Z, NOT the 18:18:52Z PI-approval comment that quotes it.
  assert.equal(findSoClearedAt(comments), '2026-10-20T00:28:09.000Z');
});

test('findSoClearedAt: afterISO excludes a clearing comment that predates the latest push (stale round, #3386 multi-rebase shape)', () => {
  const comments = [
    { body: '**SO clearing comment** at the OLD head (stale -- predates the rebase).', createdAt: '2026-10-19T09:00:00Z' },
    { body: '**SO clearing comment** at the NEW head, after the rebase.', createdAt: '2026-10-20T01:00:00Z' },
  ];
  // A push landed at 09:30Z, after the stale clearance but before the real one.
  assert.equal(findSoClearedAt(comments, '2026-10-19T09:30:00Z'), '2026-10-20T01:00:00.000Z');
});

test('findSoClearedAt: no matching comment returns null, not a guess', () => {
  assert.equal(findSoClearedAt([{ body: 'Looks good to me', createdAt: '2026-10-19T10:00:00Z' }]), null);
  assert.equal(findSoClearedAt([]), null);
  assert.equal(findSoClearedAt(undefined), null);
});

// ── t/4972 (PR #5199 real shape): a conditional/send-back SO verdict still counts as a reply ──
test('soRepliedAtHead: a "proceed with conditions" verdict at the current head counts as a reply (#5199 live shape)', () => {
  const comments = [{
    body: '**Second Opinion verdict, mirrored for the PI (round of 2026-11-15, six-PR consult): proceed with conditions at `5a14dae7f`.** The clearance from `9abc7e018` carries...',
  }];
  assert.equal(soRepliedAtHead(comments, '5a14dae7f9a34c062dbe2975f8f1e974284631ee'), true);
});

test('soRepliedAtHead: a "send back" verdict at the head does NOT suppress -- the PR went back to its author and must keep alerting (#4967 live shape; Quality, #5286 review)', () => {
  const comments = [{
    body: '**Second Opinion verdict, mirrored for the PI (round of 2026-11-15, six-PR consult): send back at `60f432ab8`.** Rebase and cut scope before a re-consult.',
  }];
  assert.equal(soRepliedAtHead(comments, '60f432ab8d3a850003cb42509ec3a7bd3d04d1ed'), false);
  const sent = [{ body: '**Second Opinion verdict: sent back at `60f432ab8`.**' }];
  assert.equal(soRepliedAtHead(sent, '60f432ab8d3a850003cb42509ec3a7bd3d04d1ed'), false, '"sent back" spelling too');
});

test('soRepliedAtHead: a clearance verdict at the head suppresses', () => {
  const comments = [{ body: '**Second Opinion verdict: cleared at `60f432ab8`.** No conditions.' }];
  assert.equal(soRepliedAtHead(comments, '60f432ab8d3a850003cb42509ec3a7bd3d04d1ed'), true);
});

test('soRepliedAtHead: the LATEST verdict at the head decides (proceed then send-back alerts; send-back then proceed does not)', () => {
  const head = '60f432ab8d3a850003cb42509ec3a7bd3d04d1ed';
  const proceed = { body: '**Second Opinion verdict: proceed with conditions at `60f432ab8`.**' };
  const back = { body: '**Second Opinion verdict: send back at `60f432ab8`.**' };
  assert.equal(soRepliedAtHead([proceed, back], head), false);
  assert.equal(soRepliedAtHead([back, proceed], head), true);
  assert.equal(soRepliedAtHead([back, { body: '**Second Opinion verdict: proceed at `0ff1ce000`.**' }], head), false, 'a verdict at another head does not replace the send-back');
});

test('soRepliedAtHead: "send back" mentioned only AFTER the cited head (in the reasoning) does not make a proceed a send-back', () => {
  const c = [{ body: '**Second Opinion verdict: proceed with conditions at `60f432ab8`.** If the conditions slip, send back.' }];
  assert.equal(soRepliedAtHead(c, '60f432ab8d3a850003cb42509ec3a7bd3d04d1ed'), true);
});

test('soRepliedAtHead: a verdict comment citing a DIFFERENT (superseded) head does not count -- an answer to an old push is not an answer to this one', () => {
  const comments = [{
    body: '**Second Opinion verdict: proceed with conditions at `aaaaaaa`.**',
  }];
  assert.equal(soRepliedAtHead(comments, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), false);
});

test('soRepliedAtHead: a verdict comment with no cited SHA at all does not count -- nothing to pin against', () => {
  const comments = [{ body: '**Second Opinion verdict: proceed with conditions.** No head cited.' }];
  assert.equal(soRepliedAtHead(comments, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), false);
});

test('soRepliedAtHead: a comment that only MENTIONS "Second Opinion" mid-body does not match -- must be the comment\'s own header', () => {
  const comments = [{ body: 'Per the Second Opinion verdict from before at `bbbbbbb`, this is fine.' }];
  assert.equal(soRepliedAtHead(comments, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), false);
});

test('soRepliedAtHead: no headSha provided never matches -- missing evidence is not evidence of a reply', () => {
  const comments = [{ body: '**Second Opinion verdict: proceed with conditions at `bbbbbbb`.**' }];
  assert.equal(soRepliedAtHead(comments, null), false);
  assert.equal(soRepliedAtHead(comments, undefined), false);
});

test('soRepliedAtHead: empty/no comments never matches', () => {
  assert.equal(soRepliedAtHead([], 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), false);
  assert.equal(soRepliedAtHead(undefined, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), false);
});

test('splitT2ApprovalWait: fast SO-clear + slow PI sign-off (this week\'s dominant real shape, t/4091#40) splits correctly', () => {
  // Modeled on this week's #3423 shape: SO cleared ~1h after CI-green, PI approved ~27h later.
  const prs = [{
    body: 'Tier: T2\n...',
    ciGreenAt: '2026-10-19T00:00:00Z',
    soClearedAt: '2026-10-19T01:00:00Z',
    mergedAt: '2026-10-20T04:00:00Z',
  }];
  const r = splitT2ApprovalWait(prs);
  assert.equal(r.agentControllable.n, 1);
  assert.equal(r.agentControllable.median, 60); // 1h
  assert.equal(r.humanApproval.n, 1);
  assert.equal(r.humanApproval.median, 27 * 60); // 27h
  assert.equal(r.unclassified.n, 0);
});

test('splitT2ApprovalWait: no SO-cleared comment detected goes to unclassified, not guessed', () => {
  const prs = [{ body: 'Tier: T2\n...', ciGreenAt: '2026-10-19T00:00:00Z', mergedAt: '2026-10-19T02:00:00Z', soClearedAt: null }];
  const r = splitT2ApprovalWait(prs);
  assert.equal(r.unclassified.n, 1);
  assert.equal(r.unclassified.median, 120); // 2h
  assert.equal(r.agentControllable.n, 0);
  assert.equal(r.humanApproval.n, 0);
});

test('splitT2ApprovalWait: a re-confirmation comment that postdates mergedAt is clamped to 0, never negative', () => {
  // Pathological but possible if an SO posts a late "still cleared" note after merge already happened.
  const prs = [{
    body: 'Tier: T2\n...',
    ciGreenAt: '2026-10-19T00:00:00Z',
    soClearedAt: '2026-10-19T05:00:00Z',
    mergedAt: '2026-10-19T03:00:00Z',
  }];
  const r = splitT2ApprovalWait(prs);
  assert.equal(r.humanApproval.median, 0);
});

test('splitT2ApprovalWait: non-T2 PRs are ignored (same bucketing convention as approvalWaitByTier)', () => {
  const prs = [{ body: 'Tier: T0\n...', ciGreenAt: '2026-10-19T00:00:00Z', mergedAt: '2026-10-19T02:00:00Z', soClearedAt: '2026-10-19T01:00:00Z' }];
  const r = splitT2ApprovalWait(prs);
  assert.equal(r.agentControllable.n, 0);
  assert.equal(r.humanApproval.n, 0);
  assert.equal(r.unclassified.n, 0);
});

test('prSizeDistribution: lines and files, both numeric and array changedFiles forms', () => {
  const prs = [
    { additions: 10, deletions: 5, changedFiles: ['a.ts', 'b.ts'] },
    { additions: 1, deletions: 1, changedFiles: 3 },
  ];
  const r = prSizeDistribution(prs);
  assert.equal(r.lines.n, 2);
  assert.equal(r.files.n, 2);
});

test('openPRAgeDays: computed against an injectable "now"', () => {
  const now = new Date('2026-01-10T00:00:00Z');
  const r = openPRAgeDays([{ createdAt: '2026-01-01T00:00:00Z' }], now);
  assert.equal(r.n, 1);
  assert.equal(r.median, 9);
});

test('parsePILoadLines: parses the TL digest line format, skips non-matching comments', () => {
  const comments = [
    { body: 'some unrelated discussion' },
    { body: 'PI-load 2026-10-08: asks=6 new=6 carried=0 oldest_open_days=0 answered_since_last=7 other_tl_pings_to_pi=0' },
    { body: 'PI-load 2026-10-12: asks=9 new=6 carried=3 oldest_open_days=4 answered_since_last=3 other_tl_pings_to_pi=2' },
  ];
  const rows = parsePILoadLines(comments);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].date, '2026-10-08');
  assert.equal(rows[1].carried, 3);
});

test('parsePILoadLines: respects since/until window', () => {
  const comments = [
    { body: 'PI-load 2026-10-08: asks=6 new=6 carried=0 oldest_open_days=0 answered_since_last=7 other_tl_pings_to_pi=0' },
    { body: 'PI-load 2026-10-19: asks=8 new=2 carried=6 oldest_open_days=11 answered_since_last=3 other_tl_pings_to_pi=0' },
  ];
  const rows = parsePILoadLines(comments, '2026-10-13', '2026-10-20');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '2026-10-19');
});
