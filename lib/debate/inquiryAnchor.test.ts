// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  assertTopicAnchored,
  extractQuestionEntities,
  entityCoveragePerTurn,
  checkEntityAlignment,
} from './inquiryAnchor.js';
import { ActionableError } from './errors.js';
import { setGlobalRecorder, clearGlobalRecorder } from '../flight-recorder/index.js';
import type { DebateSession, TranscriptEntry } from './types/session.js';

const turn = (type: TranscriptEntry['type'], content: string) => ({ type, content }) as TranscriptEntry;

function session(final: string, transcript: TranscriptEntry[] = []): DebateSession {
  return { id: 'sess-1', topic: { original: final, refined: null, final }, transcript } as unknown as DebateSession;
}

describe('assertTopicAnchored (t/284)', () => {
  it('passes when topic.final equals the question', () => {
    expect(() => assertTopicAnchored(session('Should China regulate AI?'), 'Should China regulate AI?')).not.toThrow();
  });

  it('throws an ActionableError when topic.final was reframed', () => {
    expect(() => assertTopicAnchored(session('A different topic'), 'Should China regulate AI?')).toThrow(ActionableError);
  });
});

describe('extractQuestionEntities', () => {
  it('keeps capitalised non-initial words and quoted phrases, not the sentence-initial word', () => {
    expect(extractQuestionEntities('Should China and the EU follow the "Bletchley Declaration"?'))
      .toEqual(['Bletchley Declaration', 'China', 'EU']);
  });

  it('returns nothing for an all-lowercase question', () => {
    expect(extractQuestionEntities('what are the risks of automation?')).toEqual([]);
  });
});

describe('entityCoveragePerTurn', () => {
  it('scores debater turns only, using whole-word matches', () => {
    const t = [
      turn('system', 'China'),
      turn('opening', 'China and the EU agree.'),
      turn('statement', 'Chinatown is irrelevant.'),
    ];
    expect(entityCoveragePerTurn(t, ['China', 'EU'])).toEqual([1, 0]);
  });
});

describe('checkEntityAlignment', () => {
  const record = vi.fn();
  beforeEach(() => {
    record.mockReset();
    setGlobalRecorder({ record } as never);
  });
  afterEach(() => clearGlobalRecorder());

  it('records an inquiry.alignment-gate WARN when turns ignore the question entities', () => {
    checkEntityAlignment(session('Should China regulate AI?', [turn('opening', 'Regulation is hard.')]), 'Should China regulate AI?');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ type: 'inquiry.alignment-gate', level: 'warn', debate_id: 'sess-1' }));
  });

  it('stays quiet when turns mention the entities', () => {
    checkEntityAlignment(session('Should China regulate AI?', [turn('opening', 'China should act.')]), 'Should China regulate AI?');
    expect(record).not.toHaveBeenCalled();
  });
});
