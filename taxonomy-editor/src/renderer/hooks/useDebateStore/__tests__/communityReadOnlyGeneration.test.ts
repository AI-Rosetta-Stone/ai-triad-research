// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4905: store-level guard. A read-only community debate is someone else's; saves are already
// blocked (t/2401), so any AI run would bill the viewer and then be discarded. Every action that
// starts generation must refuse while communityReadOnly is set, whatever UI path calls it.
import { describe, it, expect } from 'vitest';
import { mockApi, makeSession } from './storeTestHarness';
import { useDebateStore } from '../../useDebateStore';
import { COMMUNITY_READ_ONLY_BLOCKED_ACTIONS } from '../store';

const povResponse = JSON.stringify({
  statement: 'A short response from the speaker for testing.',
  taxonomy_refs: [], policy_refs: [], my_claims: [],
});

function load(readOnly: boolean) {
  useDebateStore.getState().loadDebateFromData(
    makeSession({ phase: 'debate', active_povers: ['accelerationist', 'safetyist', 'skeptic'] }),
    { readOnly },
  );
  mockApi.generateText.mockResolvedValue({ text: povResponse });
}

function transcriptLength(): number {
  return useDebateStore.getState().activeDebate?.transcript.length ?? 0;
}

describe('communityReadOnly generation guard (t/4905)', () => {
  it('askQuestion on a read-only community debate makes no AI call and adds nothing', async () => {
    load(true);
    const before = transcriptLength();

    await useDebateStore.getState().askQuestion('What about X?');

    expect(mockApi.generateText).not.toHaveBeenCalled();
    expect(useDebateStore.getState().debateGenerating).toBeNull();
    expect(transcriptLength()).toBe(before);
  });

  it.each(COMMUNITY_READ_ONLY_BLOCKED_ACTIONS)('%s makes no AI call while read-only', async (name) => {
    load(true);
    const action = useDebateStore.getState()[name] as unknown as (...args: unknown[]) => Promise<unknown>;

    await action();

    expect(mockApi.generateText).not.toHaveBeenCalled();
    expect(mockApi.generateTextWithSearch).not.toHaveBeenCalled();
    expect(useDebateStore.getState().debateGenerating).toBeNull();
  });

  it('askQuestion on an editable debate still generates (control: the guard is the cause)', async () => {
    load(false);
    const before = transcriptLength();

    await useDebateStore.getState().askQuestion('What about X?');

    expect(mockApi.generateText).toHaveBeenCalled();
    expect(transcriptLength()).toBeGreaterThan(before);
  });
});
