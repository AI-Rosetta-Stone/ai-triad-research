// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/725 (TL p/16#466, TaxonomyServer p/74#45): the server keeps no `diagnostics` on an anonymous debate's save, so a
// reloaded anonymous debate has the field missing. The store paths that read or create it must cope: recording a
// diagnostic builds the field, turning diagnostics on adds it, and deleting entries from a debate without it works.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeSession, mockApi } from './storeTestHarness';
import { useDebateStore } from '../../useDebateStore';
import { recordDiagnostic } from '../shared/diagnostics';

function loadReloaded() {
  const session = makeSession({
    phase: 'debate',
    transcript: [
      { id: 'e1', timestamp: 't', type: 'opening', speaker: 'accelerationist', content: 'x', taxonomy_refs: [] },
      { id: 'e2', timestamp: 't', type: 'statement', speaker: 'safetyist', content: 'y', taxonomy_refs: [] },
    ],
  }) as unknown as Record<string, unknown>;
  delete session.diagnostics; // what the server hands back after an anonymous save
  useDebateStore.setState({ activeDebate: session as never, diagnosticsEnabled: false } as never);
  return session;
}

beforeEach(() => {
  mockApi.saveDebateSession.mockResolvedValue(undefined);
});

describe('a reloaded anonymous debate has no diagnostics field (t/725)', () => {
  it('the loaded debate really lacks it', () => {
    const s = loadReloaded();
    expect('diagnostics' in s).toBe(false);
  });

  it('recording a diagnostic creates the field instead of throwing', () => {
    loadReloaded();
    const get = () => useDebateStore.getState();
    const set = (p: unknown) => useDebateStore.setState(p as never);
    expect(() => recordDiagnostic(get, set, 'e2', { response_time_ms: 120 })).not.toThrow();
    const diag = useDebateStore.getState().activeDebate?.diagnostics;
    expect(diag?.entries.e2).toMatchObject({ response_time_ms: 120 });
    expect(diag?.overview.total_ai_calls).toBe(1);
  });

  it('turning diagnostics on adds an empty field (it will not persist across a reload for an anonymous visitor)', () => {
    loadReloaded();
    useDebateStore.getState().toggleDiagnostics();
    const diag = useDebateStore.getState().activeDebate?.diagnostics;
    expect(diag?.enabled).toBe(true);
    expect(diag?.entries).toEqual({});
  });

  it('deleting transcript entries from it works and leaves the field absent', async () => {
    loadReloaded();
    await useDebateStore.getState().deleteTranscriptEntries(['e2']);
    const d = useDebateStore.getState().activeDebate;
    expect(d?.transcript.map(e => e.id)).toEqual(['e1']);
    expect(d?.diagnostics).toBeUndefined();
  });
});
