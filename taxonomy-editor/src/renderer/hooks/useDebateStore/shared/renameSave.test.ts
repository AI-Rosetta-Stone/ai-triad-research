// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/725: a rename of an anonymous visitor's non-Quick-take debate must go as a title-only delta (the one write the
// server accepts for it, t/724#4), not a full PUT. Quick takes and the desktop app keep the full save.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const bridge = vi.hoisted(() => ({
  saveDebateSession: vi.fn().mockResolvedValue(undefined),
  saveDebateDelta: vi.fn().mockResolvedValue({ newVersion: 8 }),
}));
vi.mock('@bridge', () => ({ api: bridge, isElectronMode: () => false }));

import { persistRename, titleOnlyDelta, usesTitleOnlySave } from './renameSave';
import type { DebateSession } from '../../../types/debate';

const staging = (rounds: [number, number, number]) => ({
  enabled: true, pacing: 'moderate',
  phase_bounds_override: { maxConfrontationRounds: rounds[0], maxArgumentationRounds: rounds[1], maxConcludingRounds: rounds[2] },
});
const session = (protocol: string, rounds: [number, number, number]) =>
  ({ id: 'deb-1', title: 'Old', protocol_id: protocol, _saveVersion: 7, transcript: [{ id: 't1' }], adaptive_staging: staging(rounds) }) as unknown as DebateSession;

beforeEach(() => { vi.clearAllMocks(); });

describe('usesTitleOnlySave', () => {
  it('web + non-Quick-take: yes', () => {
    expect(usesTitleOnlySave(session('deliberation', [1, 3, 1]), false)).toBe(true);
    expect(usesTitleOnlySave(session('structured', [1, 3, 1]), false)).toBe(true);
  });
  it('web + Quick take: no', () => {
    expect(usesTitleOnlySave(session('structured', [1, 1, 1]), false)).toBe(false);
  });
  it('desktop: never', () => {
    expect(usesTitleOnlySave(session('deliberation', [1, 3, 1]), true)).toBe(false);
  });
});

describe('titleOnlyDelta', () => {
  it('changes the title and nothing else', () => {
    const d = titleOnlyDelta(session('deliberation', [1, 3, 1]), 'New');
    expect(d).toEqual({
      debateId: 'deb-1', baseVersion: 7,
      newTranscriptEntries: [], changedNodes: [], changedEdges: [], newMutations: [],
      meta: { title: 'New' },
    });
    expect(d.changedFields).toBeUndefined();
  });
  it('a debate with no recorded version is based on version 0', () => {
    const s = session('deliberation', [1, 3, 1]);
    delete (s as { _saveVersion?: number })._saveVersion;
    expect(titleOnlyDelta(s, 'x').baseVersion).toBe(0);
  });
});

describe('persistRename', () => {
  it('a Deep dive on the web is renamed with a title-only delta, never a full PUT', async () => {
    const s = session('deliberation', [1, 3, 1]);
    await persistRename(s, 'Renamed', false);
    expect(bridge.saveDebateDelta).toHaveBeenCalledTimes(1);
    expect(bridge.saveDebateSession).not.toHaveBeenCalled();
    expect(s.title).toBe('Renamed');
    expect(s._saveVersion).toBe(8);
  });

  it('a Quick take on the web keeps the full save', async () => {
    const s = session('structured', [1, 1, 1]);
    await persistRename(s, 'Renamed', false);
    expect(bridge.saveDebateSession).toHaveBeenCalledWith(s, 'renameDebate');
    expect(bridge.saveDebateDelta).not.toHaveBeenCalled();
    expect(s.title).toBe('Renamed');
  });

  it('the desktop app keeps the full save for any debate', async () => {
    const s = session('deliberation', [1, 3, 1]);
    await persistRename(s, 'Renamed', true);
    expect(bridge.saveDebateSession).toHaveBeenCalledTimes(1);
    expect(bridge.saveDebateDelta).not.toHaveBeenCalled();
  });

  it('a failed delta leaves the title unchanged and rejects', async () => {
    bridge.saveDebateDelta.mockRejectedValueOnce(new Error('version_conflict'));
    const s = session('deliberation', [1, 3, 1]);
    await expect(persistRename(s, 'Renamed', false)).rejects.toThrow('version_conflict');
    expect(s.title).toBe('Old');
  });
});
