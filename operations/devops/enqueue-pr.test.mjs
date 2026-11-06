// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { classifyEnqueueOutcome, formatSilentMissWarning } from './enqueue-pr.mjs';

describe('classifyEnqueueOutcome', () => {
  it('is queued when both isInMergeQueue and mergeQueueEntry are present', () => {
    expect(classifyEnqueueOutcome({
      isInMergeQueue: true, mergeQueueEntry: { position: 1, state: 'QUEUED' }, autoMergeRequest: null,
    })).toEqual({ state: 'queued' });
  });

  it('is NOT queued when isInMergeQueue is true but mergeQueueEntry is null (t/4740#1 shape)', () => {
    expect(classifyEnqueueOutcome({ isInMergeQueue: true, mergeQueueEntry: null, autoMergeRequest: null }))
      .toEqual({ state: 'not_armed' });
  });

  it('is NOT queued when isInMergeQueue is false, even with a stale mergeQueueEntry', () => {
    expect(classifyEnqueueOutcome({
      isInMergeQueue: false, mergeQueueEntry: { position: 1, state: 'QUEUED' }, autoMergeRequest: null,
    })).toEqual({ state: 'not_armed' });
  });

  it('is not_armed when all fields are null (the #4298 shape, TL p/331#2548)', () => {
    expect(classifyEnqueueOutcome({ isInMergeQueue: false, mergeQueueEntry: null, autoMergeRequest: null }))
      .toEqual({ state: 'not_armed' });
  });

  it('is armed_waiting when autoMergeRequest is set but the PR has not entered the queue yet ' +
     '— required checks still pending (t/4768, PR #4351 incident shape)', () => {
    expect(classifyEnqueueOutcome({
      isInMergeQueue: false,
      mergeQueueEntry: null,
      autoMergeRequest: { mergeMethod: 'MERGE', enabledAt: '2026-11-02T21:50:17Z', enabledBy: { login: 'jpsnover' } },
    })).toEqual({ state: 'armed_waiting' });
  });

  // t/4889: data#79/#80. ai-triad-data has no merge queue and allow_auto_merge=false, so
  // `gh pr merge --auto` merges at once and every queue field reads null afterwards.
  const directMergeAfter = {
    state: 'MERGED', mergedAt: '2026-11-05T09:51:33Z', mergeCommit: { oid: 'f98b5f57' },
    isInMergeQueue: false, mergeQueueEntry: null, autoMergeRequest: null,
  };

  it('is merged when the PR became MERGED during this run (direct merge, no queue)', () => {
    expect(classifyEnqueueOutcome(directMergeAfter, { before: { state: 'OPEN' } })).toEqual({ state: 'merged' });
  });

  it('is already_merged when the PR was MERGED before this run (TL t/4889#3)', () => {
    expect(classifyEnqueueOutcome(directMergeAfter, { before: { state: 'MERGED' } })).toEqual({ state: 'already_merged' });
  });

  it('is already_merged, never merged, when the prior state is unknown (does not claim the merge)', () => {
    expect(classifyEnqueueOutcome(directMergeAfter)).toEqual({ state: 'already_merged' });
  });

  it('is still not_armed for an OPEN PR with null queue fields, so the fallback path is unchanged', () => {
    expect(classifyEnqueueOutcome(
      { state: 'OPEN', isInMergeQueue: false, mergeQueueEntry: null, autoMergeRequest: null },
      { before: { state: 'OPEN' } },
    )).toEqual({ state: 'not_armed' });
  });

  it('prefers queued over armed_waiting when the PR has genuinely entered the queue', () => {
    expect(classifyEnqueueOutcome({
      isInMergeQueue: true,
      mergeQueueEntry: { position: 1, state: 'QUEUED' },
      autoMergeRequest: { mergeMethod: 'SQUASH', enabledAt: '2026-11-02T21:50:17Z', enabledBy: { login: 'jpsnover' } },
    })).toEqual({ state: 'queued' });
  });
});

describe('formatSilentMissWarning', () => {
  it('names the PR, repo, CLI output and prior auto-merge state', () => {
    const msg = formatSilentMissWarning({
      repo: 'AI-Rosetta-Stone/ai-triad-research',
      prNumber: 4262,
      cliOutput: '! The merge strategy for main is set by the merge queue',
      priorAutoMergeRequest: { mergeMethod: 'MERGE', enabledAt: '2026-10-31T18:33:34Z', enabledBy: { login: 'app/github-actions' } },
    });

    expect(msg).toContain('WARN:');
    expect(msg).toContain('#4262');
    expect(msg).toContain('AI-Rosetta-Stone/ai-triad-research');
    expect(msg).toContain('merge strategy for main is set by the merge queue');
    expect(msg).toContain('MERGE');
    expect(msg).toContain('app/github-actions');
  });

  it('handles a null prior auto-merge state without throwing', () => {
    const msg = formatSilentMissWarning({ repo: 'o/r', prNumber: 1, cliOutput: '', priorAutoMergeRequest: null });
    expect(msg).toContain('null');
  });
});
