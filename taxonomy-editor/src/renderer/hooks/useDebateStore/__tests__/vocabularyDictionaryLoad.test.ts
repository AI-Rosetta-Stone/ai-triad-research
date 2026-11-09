// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/37: the debate step's Vocabulary tab showed raw sense IDs because vocabularyTerms stayed null.
// applyLoadedSessionSetup dropped a dictionary that resolved after activeDebateId had moved on, dropped
// an empty result silently, and nothing retried. The dictionary is global, so any load that succeeds
// must land, and a failed or empty load must be retryable.
// The harness is imported FIRST so its hoisted mocks register before the store import resolves.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSession, mockApi } from './storeTestHarness';
import { useDebateStore } from '../../useDebateStore';

const { recorded } = vi.hoisted(() => ({ recorded: [] as { level?: string; message?: string }[] }));
vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: (ev: { level?: string; message?: string }) => { recorded.push(ev); }, setEventContext: () => {} }),
}));

const DICT = {
  standardized: [{ canonical_form: 'deployment_competitive', display_form: 'competitive deployment', definition: 'test definition' }],
  colloquial: [{ colloquial_term: 'deployment', resolves_to: [] }],
  lintViolations: [],
};
const EMPTY = { standardized: [], colloquial: [], lintViolations: [] };

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('vocabulary dictionary load (t/37)', () => {
  // clearAllMocks keeps unconsumed *Once values, and a shared fetch leaves some unconsumed.
  beforeEach(() => {
    mockApi.loadDictionary.mockReset().mockResolvedValue(EMPTY);
    recorded.length = 0;
  });

  it('read-only load: a dictionary that resolves after another debate became active still lands', async () => {
    const pending = deferred<typeof DICT>();
    mockApi.loadDictionary.mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error('second fetch fails'));
    useDebateStore.getState().loadDebateFromData(makeSession({ id: 'debate-a' }), { readOnly: true });
    useDebateStore.getState().loadDebateFromData(makeSession({ id: 'debate-b' }), { readOnly: true });
    expect(useDebateStore.getState().activeDebateId).toBe('debate-b');
    pending.resolve(DICT);
    await flush();
    expect(useDebateStore.getState().vocabularyTerms?.standardized).toHaveLength(1);
    expect(mockApi.loadDictionary).toHaveBeenCalledTimes(1);
  });

  it('an empty dictionary is logged as a WARN and is not cached, so ensureVocabulary retries', async () => {
    mockApi.loadDictionary.mockResolvedValueOnce(EMPTY).mockResolvedValueOnce(DICT);
    useDebateStore.getState().loadDebateFromData(makeSession(), { readOnly: true });
    await flush();
    expect(useDebateStore.getState().vocabularyTerms).toBeNull();
    expect(recorded.some(e => e.level === 'warn' && /Dictionary loaded empty/.test(e.message ?? ''))).toBe(true);

    await useDebateStore.getState().ensureVocabulary();
    expect(useDebateStore.getState().vocabularyTerms?.standardized).toHaveLength(1);
  });

  it('a failed load is retried by ensureVocabulary', async () => {
    mockApi.loadDictionary.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(DICT);
    useDebateStore.getState().loadDebateFromData(makeSession(), { readOnly: true });
    await flush();
    expect(useDebateStore.getState().vocabularyTerms).toBeNull();
    await useDebateStore.getState().ensureVocabulary();
    expect(useDebateStore.getState().vocabularyTerms?.standardized).toHaveLength(1);
  });

  it('ensureVocabulary does not refetch once the dictionary is loaded', async () => {
    mockApi.loadDictionary.mockResolvedValueOnce(DICT);
    await useDebateStore.getState().ensureVocabulary();
    await useDebateStore.getState().ensureVocabulary();
    expect(mockApi.loadDictionary).toHaveBeenCalledTimes(1);
  });

  it('loadDebate skipped by the load-guard still loads the dictionary for the in-memory session', async () => {
    const entry = { id: 'e1', type: 'statement', speaker: 'prometheus', content: 'x', taxonomy_refs: [] };
    const ahead = makeSession({ id: 'debate-g', transcript: [entry, { ...entry, id: 'e2' }] });
    useDebateStore.setState({ activeDebateId: 'debate-g', activeDebate: ahead as never });
    mockApi.loadDebateSession.mockResolvedValueOnce(makeSession({ id: 'debate-g', transcript: [] }));
    mockApi.loadDictionary.mockResolvedValueOnce(DICT);
    await useDebateStore.getState().loadDebate('debate-g');
    await flush();
    expect(useDebateStore.getState().activeDebate?.transcript).toHaveLength(2);
    expect(useDebateStore.getState().vocabularyTerms?.standardized).toHaveLength(1);
  });
});
