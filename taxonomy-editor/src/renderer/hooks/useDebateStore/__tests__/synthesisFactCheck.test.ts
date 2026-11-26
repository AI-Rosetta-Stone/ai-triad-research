// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/1828 — the structural anti-escape-hatch gate (t/1701 AC#3) must be LIVE at the
// production parse site, not just in the lib unit test. These drive the real
// `factCheckSelection` slice action (harness mocks the AI calls) and assert the
// gate + normalization + discrepancy emission on the fact-check transcript entry.

import { describe, it, expect } from 'vitest';
import { makeSession, mockApi } from './storeTestHarness';
import { useDebateStore } from '../../useDebateStore';
import { performFactCheckVerdict } from '../shared/argumentNetwork';
import { vi } from 'vitest';
import { factCheckPrompt } from '../../../prompts/debate';

function setupDebate(content = 'The measure passed in 12 states across the country last year.') {
  const entry = {
    id: 'entry-1', timestamp: '2026-05-01T00:00:00.000Z', type: 'statement',
    speaker: 'accelerationist', content, taxonomy_refs: [] as string[], metadata: {},
  };
  useDebateStore.setState({
    activeDebate: makeSession({ phase: 'debate', transcript: [entry] }) as never,
    activeDebateId: 'session-1',
  });
  return content;
}

type FcMeta = {
  verdict: string; finding?: string; finding_points?: string[]; limit?: string; explanation?: string;
};

const FINDING = {
  finding: 'Accurate. Ten states passed the measure last year, as the claim says.',
  finding_points: ['The state legislative record lists ten enactments.'],
  limit: 'Only the legislative record was checked.',
};

function factCheckMeta() {
  const fc = useDebateStore.getState().activeDebate?.transcript.find(e => e.type === 'fact-check');
  return fc?.metadata?.fact_check as (FcMeta & { discrepancy?: Record<string, unknown> }) | undefined;
}

describe('factCheckSelection — live FactVerdict gate (t/1828)', () => {
  it('downgrades an unsourced partially_accurate to unverifiable in the slice (AC#1)', async () => {
    const claim = setupDebate();
    mockApi.generateText.mockResolvedValue({
      text: JSON.stringify({ verdict: 'partially_accurate', explanation: 'roughly right', sources: [] }),
    });
    await useDebateStore.getState().factCheckSelection(claim, 'entry-1');
    const meta = factCheckMeta();
    expect(meta?.verdict).toBe('unverifiable');
    expect(meta?.discrepancy).toBeUndefined();
  });

  it('keeps partially_accurate and persists the discrepancy when it is sourced (AC#2)', async () => {
    const claim = setupDebate();
    mockApi.generateText.mockResolvedValue({
      text: JSON.stringify({
        verdict: 'partially_accurate', explanation: 'core right, count off', sources: [],
        discrepancy: { dimension: 'magnitude', claimed: '12 states', actual: '10 states', source: 'sit-001', severity: 'minor' },
      }),
    });
    await useDebateStore.getState().factCheckSelection(claim, 'entry-1');
    const meta = factCheckMeta();
    expect(meta?.verdict).toBe('partially_accurate');
    expect(meta?.discrepancy).toMatchObject({ dimension: 'magnitude', claimed: '12 states', actual: '10 states', severity: 'minor' });
  });

  it('normalizes a legacy verified verdict to supported at the parse site', async () => {
    const claim = setupDebate();
    mockApi.generateText.mockResolvedValue({
      text: JSON.stringify({ verdict: 'verified', explanation: 'confirmed', sources: [] }),
    });
    await useDebateStore.getState().factCheckSelection(claim, 'entry-1');
    expect(factCheckMeta()?.verdict).toBe('supported');
  });
});

describe('fact-check card fields (t/766)', () => {
  it('manual path stores finding, finding_points and limit; content has no title line or web note', async () => {
    const claim = setupDebate();
    mockApi.generateText.mockResolvedValue({
      text: JSON.stringify({ verdict: 'supported', explanation: 'confirmed', sources: [], ...FINDING }),
    });
    await useDebateStore.getState().factCheckSelection(claim, 'entry-1');
    const meta = factCheckMeta();
    expect(meta).toMatchObject(FINDING);
    const entry = useDebateStore.getState().activeDebate?.transcript.find(e => e.type === 'fact-check');
    expect(entry?.content).not.toContain('Fact Check:');
    expect(entry?.content).not.toContain('Web sources');
    expect(entry?.content.endsWith('confirmed')).toBe(true);
  });

  it('manual path: an old-shape response stores no card fields and still has verdict + explanation', async () => {
    const claim = setupDebate();
    mockApi.generateText.mockResolvedValue({
      text: JSON.stringify({ verdict: 'supported', explanation: 'confirmed', sources: [] }),
    });
    await useDebateStore.getState().factCheckSelection(claim, 'entry-1');
    const meta = factCheckMeta();
    expect(meta?.verdict).toBe('supported');
    expect(meta?.explanation).toBe('confirmed');
    expect(meta).not.toHaveProperty('finding');
    expect(meta).not.toHaveProperty('finding_points');
    expect(meta).not.toHaveProperty('limit');
  });

  it('manual path: a failed web search is not reported to the model as a search that ran', async () => {
    const claim = setupDebate();
    vi.mocked(factCheckPrompt).mockClear();
    mockApi.generateTextWithSearch.mockRejectedValueOnce(new Error('search down'));
    mockApi.generateText.mockResolvedValue({
      text: JSON.stringify({ verdict: 'supported', explanation: 'confirmed', sources: [] }),
    });
    await useDebateStore.getState().factCheckSelection(claim, 'entry-1');
    const args = vi.mocked(factCheckPrompt).mock.calls.at(-1) as unknown[];
    expect(args[3]).not.toContain('=== WEB SEARCH RESULTS ===');
    expect(args[3]).not.toContain('Web search unavailable');
    expect(args[5]).toBe(false);
  });

  it('manual path: a successful web search is passed through as ran, with its results block', async () => {
    const claim = setupDebate();
    vi.mocked(factCheckPrompt).mockClear();
    mockApi.generateTextWithSearch.mockResolvedValueOnce({ text: 'Ten states enacted it.', searchQueries: ['q'], citations: [] });
    mockApi.generateText.mockResolvedValue({
      text: JSON.stringify({ verdict: 'supported', explanation: 'confirmed', sources: [] }),
    });
    await useDebateStore.getState().factCheckSelection(claim, 'entry-1');
    const args = vi.mocked(factCheckPrompt).mock.calls.at(-1) as unknown[];
    expect(args[3]).toContain('=== WEB SEARCH RESULTS ===\nTen states enacted it.');
    expect(args[5]).toBe(true);
  });

  function runInline(extra: Record<string, unknown>) {
    const addTranscriptEntry = vi.fn(() => 'e');
    const get = () => ({ addTranscriptEntry, activeDebate: null });
    const set = vi.fn();
    const pNode = { id: 'p1', text: 'Ten states passed the measure.' } as never;
    performFactCheckVerdict(
      pNode, { verdict: 'supported', explanation: 'confirmed', ...extra }, '', [], [], get, set, 'entry-1', 'session-1',
    );
    return (addTranscriptEntry.mock.calls[0] as unknown as [{ content: string; metadata: { fact_check: FcMeta } }])[0];
  }

  it('inline path stores finding, finding_points and limit; content has no title line or web note', () => {
    const entry = runInline(FINDING);
    expect(entry.metadata.fact_check).toMatchObject(FINDING);
    expect(entry.content).not.toContain('Fact Check:');
    expect(entry.content.endsWith('confirmed')).toBe(true);
  });

  it('inline path: an old-shape response stores no card fields', () => {
    const fc = runInline({}).metadata.fact_check;
    expect(fc.verdict).toBe('supported');
    expect(fc).not.toHaveProperty('finding');
    expect(fc).not.toHaveProperty('finding_points');
  });

  it('inline path: a finding whose opener contradicts the verdict is dropped', () => {
    const fc = runInline({ ...FINDING, finding: 'Disputed. Ten states passed the measure last year.' }).metadata.fact_check;
    expect(fc).not.toHaveProperty('finding');
  });
});
