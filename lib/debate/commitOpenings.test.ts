// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/784: concluding-phase COMMITs must not repeat one shared debate recap.

import { describe, it, expect } from 'vitest';
import { priorCommitOpenings } from './commitOpenings.js';
import { moderatorInterventionPrompt } from './prompts.js';

const RECAP = 'This debate has focused on how artificial intelligence safety rules affect market fairness and public safety.';

describe('priorCommitOpenings', () => {
  it('returns the first sentence of each earlier COMMIT intervention, in order', () => {
    const t = [
      { type: 'statement', content: 'A statement.' },
      { type: 'intervention', content: `${RECAP} The Safetyist conceded X.`, intervention_metadata: { move: 'COMMIT' } },
      { type: 'intervention', content: 'Skeptic, please probe this. More.', intervention_metadata: { move: 'PROBE' } },
      { type: 'intervention', content: 'Accelerationist, commit now! Then more.', intervention_metadata: { move: 'COMMIT' } },
    ];
    expect(priorCommitOpenings(t)).toEqual([RECAP, 'Accelerationist, commit now!']);
  });

  it('is empty when no COMMIT has been given yet', () => {
    expect(priorCommitOpenings([{ type: 'intervention', content: 'x', intervention_metadata: { move: 'PIN' } }])).toEqual([]);
  });
});

describe('COMMIT prompt (Design rules, t/784)', () => {
  const commit = (prior?: string[]) => moderatorInterventionPrompt('COMMIT', 'synthesis', 'Safetyist', 'Automatic synthesis-phase COMMIT', undefined, 'transcript', undefined, undefined, undefined, undefined, prior);

  it('opens with the target name, asks for the commitment, caps at 2 sentences, forbids a recap', () => {
    const p = commit();
    expect(p).toContain('Your FIRST sentence must begin with "Safetyist,"');
    expect(p).toContain('Write at most 2 sentences in total');
    expect(p).toContain('Do NOT recap or summarise the debate');
    expect(p).toContain('This debate has focused on');
  });

  it('drops the base instruction to describe what happened in the debate (it invited the recap)', () => {
    expect(commit()).not.toContain('Describe what happened in the debate');
    const pin = moderatorInterventionPrompt('PIN', 'elicitation', 'Safetyist', 'r', undefined, 't');
    expect(pin).toContain('Describe what happened in the debate');
  });

  it('lists earlier COMMIT openings as not to be reused, only when there are any', () => {
    expect(commit()).not.toContain('Do NOT reuse or paraphrase them');
    const p = commit([RECAP]);
    expect(p).toContain('Do NOT reuse or paraphrase them');
    expect(p).toContain(`- "${RECAP}"`);
  });

  it('never adds the do-not-repeat block to other moves', () => {
    const p = moderatorInterventionPrompt('PIN', 'elicitation', 'Safetyist', 'r', undefined, 't', undefined, undefined, undefined, undefined, [RECAP]);
    expect(p).not.toContain('Do NOT reuse or paraphrase them');
  });
});
