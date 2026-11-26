// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/782: the GUI summarizer must keep the structured Brief (brief_claim, brief_points) the t/700 prompt asks
// for, via the same parseEntrySummaries the engine path uses. These drive the real summarizeTranscriptEntry
// with only the model stubbed and read the stored entry.

import { describe, it, expect, vi } from 'vitest';
import { makeSession, mockApi } from './storeTestHarness';
import { useDebateStore } from '../../useDebateStore';
import { summarizeTranscriptEntry } from '../shared/generation';

function setup() {
  const session = makeSession({
    phase: 'debate',
    transcript: [{ id: 'e1', timestamp: 't', type: 'statement', speaker: 'accelerationist', content: 'A long statement.', taxonomy_refs: [] }],
  });
  useDebateStore.setState({ activeDebate: session as never });
}

async function run(response: Record<string, unknown>) {
  setup();
  mockApi.generateText.mockResolvedValue({ text: JSON.stringify(response) });
  await summarizeTranscriptEntry('e1', 'A long statement.', 'Accelerationist', 'm', () => useDebateStore.getState() as never, p => useDebateStore.setState(p as never));
  return useDebateStore.getState().activeDebate?.transcript.find(e => e.id === 'e1')?.summaries as Record<string, unknown> | undefined;
}

const STRINGS = { brief: 'The brief paragraph.', medium: 'The medium paragraph.' };

describe('summarizeTranscriptEntry structured Brief (t/782)', () => {
  it('stores a well-formed brief_claim and brief_points whole, with the strings', async () => {
    const s = await run({ ...STRINGS, brief_claim: 'Regulation slows the field.', brief_points: ['First point here.', 'Second point here.'] });
    expect(s).toEqual({ ...STRINGS, brief_claim: 'Regulation slows the field.', brief_points: ['First point here.', 'Second point here.'] });
  });

  it('keeps only the strings and WARNs when the structured fields are malformed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await run({ ...STRINGS, brief_claim: 'A claim.', brief_points: ['only one point'] });
    expect(s).toEqual(STRINGS);
    expect(warn.mock.calls.some(c => String(c[0]).includes('structured Brief dropped') && String(c[0]).includes('brief_points has 1 items'))).toBe(true);
    warn.mockRestore();
  });

  it('an old-shape response (strings only) still stores the strings', async () => {
    expect(await run(STRINGS)).toEqual(STRINGS);
  });
});
