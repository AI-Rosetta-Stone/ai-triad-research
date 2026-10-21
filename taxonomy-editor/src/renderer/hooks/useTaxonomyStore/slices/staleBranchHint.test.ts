// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4325: stale-session-branch hint for failed saves.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getSyncStatus = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/syncApi', () => ({ getSyncStatus }));
const record = vi.hoisted(() => vi.fn());
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record }) }));

const m = await import('./staleBranchHint');

const node = (id: string) => ({ id, label: id });
const status = (over: Record<string, unknown>) => ({ enabled: true, session_branch: 'session/abc', behind_by: 4, ...over });

beforeEach(() => {
  getSyncStatus.mockReset();
  record.mockClear();
  m.__resetBaselineNodesForTests();
});
afterEach(() => { vi.useRealTimers(); });

describe('untouched-node detection (by reference)', () => {
  it('a loaded node is untouched; an edited replacement is not; an unknown id is not', () => {
    const a = node('acc-1'), b = node('acc-2');
    m.markNodesAsBaseline([a, b]);
    const edited = { ...b, label: 'changed' };
    const current = m.nodesById([{ nodes: [a, edited] }]);
    expect(m.untouchedNodeIds(['acc-1', 'acc-2', 'acc-9'], current)).toEqual(['acc-1']);
  });

  it('errorKeyNodeId reads node error keys only', () => {
    expect(m.errorKeyNodeId('nodes.acc-beliefs-001.operationality')).toBe('acc-beliefs-001');
    expect(m.errorKeyNodeId('conflict-x.instances.0')).toBeNull();
  });
});

describe('readBranchContext', () => {
  it('returns the branch and behind_by from sync status', async () => {
    getSyncStatus.mockResolvedValue(status({}));
    expect(await m.readBranchContext()).toEqual({ session_branch: 'session/abc', behind_by: 4 });
  });

  it('sync off / filesystem mode (no behind_by) gives null behind_by', async () => {
    getSyncStatus.mockResolvedValue({ enabled: false, session_branch: null });
    expect(await m.readBranchContext()).toEqual({ session_branch: null, behind_by: null });
  });

  it('fault arm: a status call that never answers times out with a WARN, never blocking the save message', async () => {
    vi.useFakeTimers();
    getSyncStatus.mockReturnValue(new Promise(() => {}));
    const p = m.readBranchContext(3000);
    await vi.advanceTimersByTimeAsync(3000);
    const ctx = await p;
    expect(ctx).toEqual({ session_branch: null, behind_by: null });
    expect(Object.isFrozen(ctx)).toBe(true); // the shared fallback can't be mutated by one caller for the next
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', message: expect.stringContaining('timed out') }));
  });
});

describe('assessValidationFailure + messages', () => {
  const files = () => {
    const stale = node('acc-stale'), mine = node('acc-mine');
    m.markNodesAsBaseline([stale, mine]);
    return [{ nodes: [stale, { ...mine, label: 'edited' }] }];
  };

  it('errors on an untouched node while the branch is behind: hint naming the branch', async () => {
    getSyncStatus.mockResolvedValue(status({}));
    const v = await m.assessValidationFailure(['acc-stale', 'acc-mine', null], files());
    expect(v.hint).toEqual({ sessionBranch: 'session/abc', behindBy: 4, untouchedNodeIds: ['acc-stale'] });
    expect(v.touchedErrorCount).toBe(2);
    const msg = m.schemaFailureMessage(v, { errors: {}, message: '' }, 3);
    expect(msg).toContain('session/abc');
    expect(msg).toContain('4 commits behind main');
    expect(msg).toContain('acc-stale');
    expect(msg).toContain('Also fix the 2 highlighted fields');
    expect(m.branchEventData(v)).toEqual({ session_branch: 'session/abc', behind_by: 4, untouched_error_node_count: 1, stale_branch_hint: true });
  });

  it('branch up to date: no hint, the usual message, branch context still recorded', async () => {
    getSyncStatus.mockResolvedValue(status({ behind_by: 0 }));
    const v = await m.assessValidationFailure(['acc-stale'], files());
    expect(v.hint).toBeNull();
    expect(m.schemaFailureMessage(v, { errors: {}, message: '' }, 1)).toBe('Validation failed. Fix errors before saving.');
    expect(m.branchEventData(v)).toMatchObject({ session_branch: 'session/abc', behind_by: 0, stale_branch_hint: false });
  });

  it('behind, but every error is on an edited node: no hint', async () => {
    getSyncStatus.mockResolvedValue(status({}));
    const v = await m.assessValidationFailure(['acc-mine'], files());
    expect(v.hint).toBeNull();
  });

  it('integrity stage: the stale-branch lines come before the integrity summary', async () => {
    getSyncStatus.mockResolvedValue(status({ behind_by: 1 }));
    const v = await m.assessValidationFailure(['acc-stale'], files());
    const msg = m.integrityFailureMessage(v, 'Integrity check failed (1 error):\nX: acc-stale');
    expect(msg.split('\n')[1]).toContain('1 commit behind main');
    expect(msg.endsWith('Integrity check failed (1 error):\nX: acc-stale')).toBe(true);
  });

  it('more than three untouched nodes are summarised', () => {
    const msg = m.staleBranchMessage({ sessionBranch: 'b', behindBy: 2, untouchedNodeIds: ['a', 'b', 'c', 'd', 'e'] }, 0);
    expect(msg).toContain('(a, b, c + 2 more)');
    expect(msg).not.toContain('Also fix');
  });
});
