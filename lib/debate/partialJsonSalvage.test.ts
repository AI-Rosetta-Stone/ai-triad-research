// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/774: one malformed list item must not lose the whole list.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { salvageJsonArray } from './partialJsonSalvage.js';
import { runSynthesisPhases } from './synthesisPhases.js';
import { SynthesisPipeline, type SynthesisContext } from './synthesisPipeline.js';
import { setGlobalRecorder, clearGlobalRecorder, type FlightRecorder, type RecordInput } from '../flight-recorder/index.js';

// The real glitch from the t/770 re-run: a field name lost its opening quote ('Noriginal_disagreement":').
const GLITCHED = `{
  "areas_of_agreement": [
    { "point": "AI agents should not be granted legal personhood.", "povers": ["skeptic"], "answers_question": true,
      Noriginal_disagreement": "Whether AI agents require legal personhood." },
    { "point": "Personhood creates no new source of money, [even] for victims, sadly.", "povers": ["skeptic", "safetyist"] },
    { "point": "A public body decides when an agent is new.", "povers": ["accelerationist"] }
  ],
  "areas_of_disagreement": [ { "point": "d1", "positions": [] } ],
  "cruxes": [ { "question": "c1" } ],
  "unresolved_questions": []
}`;

describe('salvageJsonArray', () => {
  it('repairs the real glitch (a property name missing its opening quote) and keeps every item', () => {
    const s = salvageJsonArray(GLITCHED, 'areas_of_agreement');
    expect(s.found).toBe(true);
    expect(s.items.map(i => (i as { point: string }).point)).toEqual([
      'AI agents should not be granted legal personhood.',
      'Personhood creates no new source of money, [even] for victims, sadly.',
      'A public body decides when an agent is new.',
    ]);
    expect((s.items[0] as { answers_question: boolean }).answers_question).toBe(true);
    expect(s.repaired).toEqual([0]);
    expect(s.dropped).toEqual([]);
  });

  it('drops an item it cannot repair, keeps the rest, and reports it by index', () => {
    const s = salvageJsonArray('{"xs": [\n {"a": 1},\n {"a" "b"},\n {"a": 3}\n]}', 'xs');
    expect(s.items).toEqual([{ a: 1 }, { a: 3 }]);
    expect(s.dropped).toHaveLength(1);
    expect(s.dropped[0].index).toBe(1);
    expect(s.repaired).toEqual([]);
  });

  it('handles commas and brackets inside strings, and escaped quotes', () => {
    const s = salvageJsonArray('{"xs": ["a, [b]", "c \\"d\\" e", {"k": "}"}]}', 'xs');
    expect(s.items).toEqual(['a, [b]', 'c "d" e', { k: '}' }]);
    expect(s.dropped).toEqual([]);
  });

  it('keeps complete items of a truncated array and marks the tail truncated', () => {
    const s = salvageJsonArray('{"xs": [{"a": 1}, {"a": 2}, {"a": 3, "b": "cut', 'xs');
    expect(s.items).toEqual([{ a: 1 }, { a: 2 }]);
    expect(s.dropped).toEqual([{ index: 2, reason: 'truncated' }]);
    expect(s.repaired).toEqual([]);
  });

  it('reports not-found for a missing key', () => {
    expect(salvageJsonArray('{"ys": []}', 'xs')).toEqual({ found: false, items: [], dropped: [], repaired: [] });
  });
});

const ALL_BAD = `{ "areas_of_agreement": [ { "point": "x" "y" }, { "point": } ], "areas_of_disagreement": [ { "point": "d", "positions": [] } ], "cruxes": [], "unresolved_questions": [] }`;

describe('synthesis phases salvage (t/774)', () => {
  afterEach(() => clearGlobalRecorder());

  it('runSynthesisPhases keeps every agreement, answering one first, and WARNs naming the repaired index', async () => {
    const warn = vi.fn();
    const { data } = await runSynthesisPhases({ topic: 'Q?', transcript: 't' }, async (_p, label) => (/Extract/.test(label) ? GLITCHED : '{}'), undefined, warn, undefined, 1);
    const points = (data.areas_of_agreement as { point: string }[]).map(a => a.point);
    expect(points).toHaveLength(3);
    expect(points[0]).toBe('AI agents should not be granted legal personhood.');
    expect(data.unreadable_lists).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Synthesis Phase 1 parse', expect.stringMatching(/areas_of_agreement: repaired malformed item\(s\) #0/), 'The items are kept');
  });

  it('runSynthesisPhases WARNs naming a dropped index when an item cannot be repaired', async () => {
    const warn = vi.fn();
    const oneBad = '{ "areas_of_agreement": [\n { "point": "good", "povers": [] },\n { "point" "bad" }\n], "areas_of_disagreement": [], "cruxes": [], "unresolved_questions": [] }';
    const { data } = await runSynthesisPhases({ topic: 'Q?', transcript: 't' }, async (_p, label) => (/Extract/.test(label) ? oneBad : '{}'), undefined, warn, undefined, 1);
    expect((data.areas_of_agreement as unknown[]).length).toBe(1);
    expect(warn).toHaveBeenCalledWith('Synthesis Phase 1 parse', expect.stringMatching(/areas_of_agreement: dropped malformed item\(s\) #1 .*kept 1/), 'The remaining items are kept');
  });

  it('records the raw head and tail for inspection', async () => {
    const record = vi.fn<(e: RecordInput) => void>();
    setGlobalRecorder({ record } as unknown as FlightRecorder);
    await runSynthesisPhases({ topic: 'Q?', transcript: 't' }, async (_p, label) => (/Extract/.test(label) ? GLITCHED : '{}'), undefined, undefined, undefined, 1);
    const ev = record.mock.calls.map(c => c[0]).find(e => /salvaged lists element by element/.test(e.message ?? ''));
    expect(ev?.data).toMatchObject({ phase: 'Phase 1', raw_head: expect.stringContaining('areas_of_agreement'), raw_tail: expect.any(String) });
  });

  it('marks a list with every item malformed as unreadable, and the card says so instead of omitting it', async () => {
    const { data } = await runSynthesisPhases({ topic: 'Q?', transcript: 't' }, async (_p, label) => (/Extract/.test(label) ? ALL_BAD : '{}'), undefined, undefined, undefined, 1);
    expect(data.unreadable_lists).toEqual(['areas_of_agreement']);

    const added: { content: string }[] = [];
    const ctx = {
      session: { id: 'd1', topic: { final: 'Q?' }, transcript: [] }, config: { model: 'm' }, taxonomy: { policyRegistry: [] },
      generate: async (_p: string, label: string) => (/Extract/.test(label) ? ALL_BAD : '{}'), generateWithEvaluator: vi.fn(),
      addEntry: vi.fn((e) => { added.push(e as never); return { ...e, id: 'c1', timestamp: 't' }; }),
      recordDiagnostic: vi.fn(), progress: vi.fn(), warn: vi.fn(), checkAborted: vi.fn(),
    } as unknown as SynthesisContext;
    await new SynthesisPipeline(ctx).runSynthesis();
    expect(added[0].content).toContain("**Areas of Agreement:**\n\nAgreements couldn't be read for this synthesis.");
    expect(added[0].content).toContain('**Areas of Disagreement:**\n\n- d');
  });

  it.each([
    ['areas_of_disagreement', '**Areas of Disagreement:**', "Disagreements couldn't be read for this synthesis."],
    ['cruxes', '**Cruxes:**', "Cruxes couldn't be read for this synthesis."],
  ])('an all-malformed %s list says so on the card (Quality, #5603)', async (key, heading, text) => {
    const lists: Record<string, string> = {
      areas_of_agreement: '[ { "point": "a", "povers": [] } ]',
      areas_of_disagreement: '[ { "point": "d", "positions": [] } ]',
      cruxes: '[ { "question": "c" } ]',
    };
    lists[key] = '[ { "x" "y" }, { "x": } ]';
    const allBadOne = `{ "areas_of_agreement": ${lists.areas_of_agreement}, "areas_of_disagreement": ${lists.areas_of_disagreement}, "cruxes": ${lists.cruxes}, "unresolved_questions": [] }`;
    const added: { content: string }[] = [];
    const ctx = {
      session: { id: 'd1', topic: { final: 'Q?' }, transcript: [] }, config: { model: 'm' }, taxonomy: { policyRegistry: [] },
      generate: async (_p: string, label: string) => (/Extract/.test(label) ? allBadOne : '{}'), generateWithEvaluator: vi.fn(),
      addEntry: vi.fn((e) => { added.push(e as never); return { ...e, id: 'c1', timestamp: 't' }; }),
      recordDiagnostic: vi.fn(), progress: vi.fn(), warn: vi.fn(), checkAborted: vi.fn(),
    } as unknown as SynthesisContext;
    await new SynthesisPipeline(ctx).runSynthesis();
    expect(added[0].content).toContain(`${heading}\n\n${text}`);
  });
});

describe('salvageJsonArray: repair of a closed array\'s last item (Quality, #5603)', () => {
  it('keeps a last item with a missing opening quote when the array is closed, and lists it as repaired', () => {
    const s = salvageJsonArray('{"xs": [\n {"a": 1},\n {"a": 2,\n  Nb": 3}\n]}', 'xs');
    expect(s.items).toEqual([{ a: 1 }, { a: 2, Nb: 3 }]);
    expect(s.repaired).toEqual([1]);
    expect(s.dropped).toEqual([]);
  });
});
