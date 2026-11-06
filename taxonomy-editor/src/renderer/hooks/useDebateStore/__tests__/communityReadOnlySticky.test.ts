// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4907: communityReadOnly must not outlive the community debate it was set for. Opening a
// Community debate in place (t/4899) sets it; nothing cleared it, so the user's own debate opened
// or created next stayed read-only and its saves were silently dropped.
import { describe, it, expect } from 'vitest';
import { mockApi, makeSession } from './storeTestHarness';
import { useDebateStore } from '../../useDebateStore';

describe('communityReadOnly does not stick to the next debate', () => {
  it('opening an own debate after a read-only community debate clears it, and saves persist', async () => {
    useDebateStore.getState().loadDebateFromData(makeSession({ id: 'community-1' }), { readOnly: true });
    expect(useDebateStore.getState().communityReadOnly).toBe(true);

    mockApi.loadDebateSession.mockResolvedValue(makeSession({ id: 'own-1' }));
    await useDebateStore.getState().loadDebate('own-1');

    expect(useDebateStore.getState().activeDebateId).toBe('own-1');
    expect(useDebateStore.getState().communityReadOnly).toBe(false);

    await useDebateStore.getState().saveDebate('test-mutation');
    expect(mockApi.saveDebateSession).toHaveBeenCalledTimes(1);
  });

  it('creating a debate after a read-only community debate clears it, and saves persist', async () => {
    useDebateStore.getState().loadDebateFromData(makeSession({ id: 'community-c' }), { readOnly: true });

    await useDebateStore.getState().createDebate('Topic', ['accelerationist', 'safetyist'], false);

    expect(useDebateStore.getState().communityReadOnly).toBe(false);
    mockApi.saveDebateSession.mockClear();
    await useDebateStore.getState().saveDebate('test-mutation');
    expect(mockApi.saveDebateSession).toHaveBeenCalledTimes(1);
  });

  it('close, then create: the new debate saves', async () => {
    useDebateStore.getState().loadDebateFromData(makeSession({ id: 'community-cc' }), { readOnly: true });
    useDebateStore.getState().closeDebate();

    await useDebateStore.getState().createDebate('Topic', ['accelerationist', 'safetyist'], false);

    expect(useDebateStore.getState().communityReadOnly).toBe(false);
    mockApi.saveDebateSession.mockClear();
    await useDebateStore.getState().saveDebate('test-mutation');
    expect(mockApi.saveDebateSession).toHaveBeenCalledTimes(1);
  });

  it('closeDebate clears it', () => {
    useDebateStore.getState().loadDebateFromData(makeSession({ id: 'community-2' }), { readOnly: true });
    useDebateStore.getState().closeDebate();
    expect(useDebateStore.getState().communityReadOnly).toBe(false);
  });

  it('stays set while the own debate is still loading, so the shown community debate stays unsaveable', async () => {
    useDebateStore.getState().loadDebateFromData(makeSession({ id: 'community-3' }), { readOnly: true });
    let resolveLoad: (v: unknown) => void = () => {};
    mockApi.loadDebateSession.mockImplementation(() => new Promise((r) => { resolveLoad = r; }));

    const pending = useDebateStore.getState().loadDebate('own-3');
    expect(useDebateStore.getState().communityReadOnly).toBe(true);

    resolveLoad(makeSession({ id: 'own-3' }));
    await pending;
    expect(useDebateStore.getState().communityReadOnly).toBe(false);
  });
});
