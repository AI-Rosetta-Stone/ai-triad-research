// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/808: runSynthesisPhases ends with ids on the disagreements, a disagreement_id on each preference,
// and themes split off the unresolved questions, with the plain-string shape still readable.

import { describe, it, expect, vi } from 'vitest';
import { runSynthesisPhases } from './synthesisPhases.js';

const extract = (questions: unknown[]) => JSON.stringify({
  areas_of_agreement: [],
  areas_of_disagreement: [
    { point: 'Whether the risk of open weights outweighs the benefit', decisive: false, positions: [{ pover: 'skeptic' }] },
    { point: 'Who is liable when a model causes harm', decisive: true, positions: [{ pover: 'safetyist' }] },
  ],
  cruxes: [],
  unresolved_questions: questions,
});
const evaluate = (prefs: unknown[]) => JSON.stringify({ preferences: prefs, policy_implications: [], topic_resolution: {} });

async function run(questions: unknown[], prefs: unknown[]) {
  const prompts: Record<string, string> = {};
  const warn = vi.fn();
  const generate = vi.fn(async (prompt: string, label: string) => {
    prompts[label] = prompt;
    if (/Extract/.test(label)) return extract(questions);
    if (/Evaluate/.test(label)) return evaluate(prefs);
    return JSON.stringify({ argument_map: [{ claim_id: 'C1', claim: 'x', claimant: 'skeptic' }] });
  });
  const { data } = await runSynthesisPhases({ topic: 'Q?', transcript: 't' }, generate, undefined, warn);
  return { data, prompts, warn };
}

describe('runSynthesisPhases: synthesis v2 links (t/808)', () => {
  it('shows Phase 3 the disagreement ids and joins each preference to its disagreement', async () => {
    const { data, prompts, warn } = await run(['plain question'], [
      { conflict: 'x', disagreement_id: 'd1', prevails: 'C1', criterion: 'specificity', rationale: 'r' },
      { conflict: 'Who is liable when a model causes harm', prevails: 'undecidable', criterion: 'scope', rationale: 'r' },
    ]);
    expect(prompts['Synthesis Phase 3: Evaluate']).toContain('"id":"d1"');
    const ds = data.areas_of_disagreement as { id: string; point: string }[];
    // decisive disagreement is ordered first but keeps its id
    expect(ds.map(d => d.id)).toEqual(['d2', 'd1']);
    const prefs = data.preferences as { disagreement_id?: string }[];
    expect(prefs.map(p => p.disagreement_id)).toEqual(['d1', 'd2']);
    expect(warn.mock.calls.filter(c => c[0] === 'Synthesis preferences link')).toHaveLength(1);
  });

  it('splits themes off the questions; the stored questions stay a string[]', async () => {
    const { data } = await run([{ question: 'Who pays?', theme: 'Funding' }, { question: 'When?' }], []);
    expect(data.unresolved_questions).toEqual(['Who pays?', 'When?']);
    expect(data.unresolved_question_themes).toEqual(['Funding', '']);
  });

  it('an old-shape model answer (strings, no disagreement_id) is unchanged apart from the ids and a WARN', async () => {
    const { data, warn } = await run(['a', 'b'], [{ conflict: 'unrelated words only', prevails: 'undecidable', criterion: 'scope', rationale: 'r' }]);
    expect(data.unresolved_questions).toEqual(['a', 'b']);
    expect('unresolved_question_themes' in data).toBe(false);
    expect((data.preferences as Record<string, unknown>[])[0].disagreement_id).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Synthesis preferences link', expect.stringContaining('left unlinked'), expect.any(String));
  });
});
