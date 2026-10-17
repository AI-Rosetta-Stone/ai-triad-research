// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4217 — harvestStore.ts's read-modify-write writers must read with
 * readFileWithVersion (always-live, t/4203) and write with the returned
 * version as baseSha, so a stale read surfaces as WRITE_CONFLICT instead of
 * silently losing another writer's change. Covers harvestAddVerdict (the
 * simplest RMW shape) for the conflict-then-retry scenario, plus a
 * no-baseSha-regression check across all three RMW writers for the
 * uncontended case (AC 3).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActionableError } from '../../../../lib/debate/errors.js';

vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

const writeFileSpy = vi.fn();
const readFileWithVersionOrFallbackSpy = vi.fn();

vi.mock('../storage/fileIO.js', () => ({
  getBackend: () => ({ writeFile: writeFileSpy }),
  assertSafeId: vi.fn(),
  resolveTaxonomyFilePath: vi.fn(async (pov: string) => `/taxonomy/${pov}.json`),
  getConflictsDir: () => '/conflicts',
  readFileWithVersionOrFallback: readFileWithVersionOrFallbackSpy,
}));

function writeConflict(): ActionableError {
  return new ActionableError({
    goal: 'Save', problem: 'stale base version', location: 'test',
    nextSteps: [], httpStatus: 409, code: 'WRITE_CONFLICT',
  });
}

beforeEach(() => {
  writeFileSpy.mockReset();
  readFileWithVersionOrFallbackSpy.mockReset();
});

describe('harvestStore RMW writers — readFileWithVersion + baseSha (t/4217)', () => {
  it('harvestAddVerdict: a stale read conflicts, retries against the live content, and never loses the other writer\'s field', async () => {
    const { harvestAddVerdict } = await import('../storage/harvestStore.js');

    // First read: the content harvest loaded, at version v1.
    readFileWithVersionOrFallbackSpy.mockResolvedValueOnce({
      content: JSON.stringify({ claim_id: 'c1' }), version: 'v1',
    });
    // First write (baseSha v1) conflicts — another writer committed first.
    writeFileSpy.mockRejectedValueOnce(writeConflict());
    // Retry's re-read sees the OTHER writer's change already landed, at v2.
    readFileWithVersionOrFallbackSpy.mockResolvedValueOnce({
      content: JSON.stringify({ claim_id: 'c1', other_writer_field: 'from-other-writer' }), version: 'v2',
    });
    // Second write (baseSha v2) succeeds.
    writeFileSpy.mockResolvedValueOnce({ version: 'v3' });

    const ok = await harvestAddVerdict('c1', { outcome: 'upheld' });

    expect(ok).toBe(true);
    expect(writeFileSpy).toHaveBeenCalledTimes(2);

    // First write used the version from the first read.
    expect(writeFileSpy.mock.calls[0][2]).toEqual({ baseSha: 'v1' });
    // Second (successful) write used the RE-READ version, not the stale one.
    expect(writeFileSpy.mock.calls[1][2]).toEqual({ baseSha: 'v2' });

    // The actually-persisted content carries BOTH the other writer's field
    // (preserved, because we re-read before re-applying) AND harvest's own
    // verdict (applied on top) — proving no lost update either direction.
    const persisted = JSON.parse(writeFileSpy.mock.calls[1][1] as string);
    expect(persisted.other_writer_field).toBe('from-other-writer');
    expect(persisted.verdict).toEqual({ outcome: 'upheld' });
  });

  it('harvestAddVerdict: exhausting retries on repeated conflicts throws, never collapses to false', async () => {
    const { harvestAddVerdict } = await import('../storage/harvestStore.js');

    readFileWithVersionOrFallbackSpy.mockResolvedValue({ content: JSON.stringify({ claim_id: 'c1' }), version: 'v1' });
    writeFileSpy.mockRejectedValue(writeConflict());

    await expect(harvestAddVerdict('c1', { outcome: 'upheld' })).rejects.toThrow();
    // Initial attempt + MAX_HARVEST_CONFLICT_RETRIES (2) = 3 total.
    expect(writeFileSpy).toHaveBeenCalledTimes(3);
  });

  it('harvestAddVerdict: the uncontended case is unchanged (AC 3) — one read, one write, baseSha from that read', async () => {
    const { harvestAddVerdict } = await import('../storage/harvestStore.js');

    readFileWithVersionOrFallbackSpy.mockResolvedValueOnce({ content: JSON.stringify({ claim_id: 'c1' }), version: 'only-version' });
    writeFileSpy.mockResolvedValueOnce({ version: 'v2' });

    const ok = await harvestAddVerdict('c1', { outcome: 'upheld' });

    expect(ok).toBe(true);
    expect(readFileWithVersionOrFallbackSpy).toHaveBeenCalledTimes(1);
    expect(writeFileSpy).toHaveBeenCalledTimes(1);
    expect(writeFileSpy.mock.calls[0][2]).toEqual({ baseSha: 'only-version' });
  });

  it('harvestAddDebateRef: uses readFileWithVersion and passes baseSha on write (no behavior change for the uncontended case)', async () => {
    const { harvestAddDebateRef } = await import('../storage/harvestStore.js');

    readFileWithVersionOrFallbackSpy.mockResolvedValueOnce({
      content: JSON.stringify({ nodes: [{ id: 'node-1', debate_refs: [] }] }), version: 'pov-version',
    });
    writeFileSpy.mockResolvedValueOnce({ version: 'pov-version-2' });

    const ok = await harvestAddDebateRef('node-1', 'debate-42');

    expect(ok).toBe(true);
    expect(writeFileSpy).toHaveBeenCalledTimes(1);
    expect(writeFileSpy.mock.calls[0][2]).toEqual({ baseSha: 'pov-version' });
  });

  it('harvestUpdateSteelman: uses readFileWithVersion and passes baseSha on write (no behavior change for the uncontended case)', async () => {
    const { harvestUpdateSteelman } = await import('../storage/harvestStore.js');

    readFileWithVersionOrFallbackSpy.mockResolvedValueOnce({
      content: JSON.stringify({ nodes: [{ id: 'node-1' }] }), version: 'pov-version',
    });
    writeFileSpy.mockResolvedValueOnce({ version: 'pov-version-2' });

    const ok = await harvestUpdateSteelman('node-1', 'skeptic', 'the attack text');

    expect(ok).toBe(true);
    expect(writeFileSpy).toHaveBeenCalledTimes(1);
    expect(writeFileSpy.mock.calls[0][2]).toEqual({ baseSha: 'pov-version' });
  });
});
