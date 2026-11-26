// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/777 (t/774, t/775): the app path. `requestSynthesis` runs the real `runSynthesisPhases` and
// `buildSynthesisContent` with only the model stubbed, so these lock in that the card's markdown shows
// the answering agreement first (the engine and the app can't diverge again) and that a list the model
// returned unreadable shows Design's reader line instead of vanishing.

import { describe, it, expect } from 'vitest';
import { makeSession, mockApi } from './storeTestHarness';
import { useDebateStore } from '../../useDebateStore';

function setup() {
  const session = makeSession({
    phase: 'debate',
    transcript: [
      { id: 'e1', timestamp: 't', type: 'statement', speaker: 'accelerationist', content: 'Test', taxonomy_refs: [] },
    ],
  });
  useDebateStore.setState({ activeDebate: session as never, debateModel: 'gemini-2.0-flash' });
}

function concludingContent(): string {
  const entry = useDebateStore.getState().activeDebate?.transcript.find(e => e.type === 'concluding');
  return entry?.content ?? '';
}

describe('requestSynthesis card markdown (t/777)', () => {
  it('lists the agreement that answers the question first, whatever order the model returned', async () => {
    setup();
    mockApi.generateText.mockResolvedValue({
      text: JSON.stringify({
        areas_of_agreement: [
          { point: 'Background point everyone shares', povers: ['accelerationist'], answers_question: false },
          { point: 'The answering agreement', povers: ['accelerationist', 'safetyist'], answers_question: true },
        ],
        areas_of_disagreement: [
          { point: 'Minor dispute', positions: [{ pover: 'accelerationist', stance: 'a' }], decisive: false },
          { point: 'Decisive dispute', positions: [{ pover: 'safetyist', stance: 'b' }], decisive: true },
        ],
        cruxes: [
          { question: 'Minor crux?', decisive: false },
          { question: 'Decisive crux?', decisive: true },
        ],
        unresolved_questions: [],
      }),
    });
    await useDebateStore.getState().requestSynthesis();
    const md = concludingContent();
    expect(md.indexOf('The answering agreement')).toBeGreaterThan(-1);
    expect(md.indexOf('The answering agreement')).toBeLessThan(md.indexOf('Background point everyone shares'));
    expect(md.indexOf('Decisive dispute')).toBeLessThan(md.indexOf('Minor dispute'));
    expect(md.indexOf('Decisive crux?')).toBeLessThan(md.indexOf('Minor crux?'));
  });

  it('shows the reader line for an unreadable list instead of omitting the section', async () => {
    setup();
    // Not valid JSON as a whole (the agreements are missing commas), so the engine salvages each list
    // element by element and marks the agreements unreadable (t/774).
    mockApi.generateText.mockResolvedValue({
      text: `{"areas_of_agreement": [{"point": "a" "povers": []}, {"point": "b" "povers": []}],
        "areas_of_disagreement": [{"point": "A readable dispute", "positions": []}],
        "cruxes": [{"question": "A readable crux?"}],
        "unresolved_questions": []}`,
    });
    await useDebateStore.getState().requestSynthesis();
    const md = concludingContent();
    expect(md).toContain('## Areas of Agreement');
    expect(md).toContain("Agreements couldn't be read for this synthesis.");
    expect(md).toContain('A readable dispute');
    expect(md).not.toContain("Disagreements couldn't be read");
  });
});
