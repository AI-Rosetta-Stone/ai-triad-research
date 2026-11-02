// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { decideEnqueueOutcome, formatSilentMissWarning } from './enqueue-pr.mjs';

describe('decideEnqueueOutcome', () => {
  it('is enqueued when both isInMergeQueue and mergeQueueEntry are present', () => {
    expect(decideEnqueueOutcome({ isInMergeQueue: true, mergeQueueEntry: { position: 1, state: 'QUEUED' } }))
      .toEqual({ enqueued: true });
  });

  it('is NOT enqueued when isInMergeQueue is true but mergeQueueEntry is null (t/4740#1 shape)', () => {
    expect(decideEnqueueOutcome({ isInMergeQueue: true, mergeQueueEntry: null })).toEqual({ enqueued: false });
  });

  it('is NOT enqueued when isInMergeQueue is false, even with a stale mergeQueueEntry', () => {
    expect(decideEnqueueOutcome({ isInMergeQueue: false, mergeQueueEntry: { position: 1, state: 'QUEUED' } }))
      .toEqual({ enqueued: false });
  });

  it('is NOT enqueued when both fields are null (the #4298 shape, TL p/331#2548)', () => {
    expect(decideEnqueueOutcome({ isInMergeQueue: false, mergeQueueEntry: null })).toEqual({ enqueued: false });
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
