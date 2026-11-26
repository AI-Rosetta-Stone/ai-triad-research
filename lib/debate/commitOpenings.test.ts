// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/784: concluding-phase COMMITs must not repeat one shared debate recap.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { priorCommitTexts, latestTurnOf, sharedWordRun, commitRepeat, warnOnCommitRepeat } from './commitOpenings.js';
import { moderatorInterventionPrompt } from './prompts.js';
import { setGlobalRecorder, clearGlobalRecorder, type FlightRecorder, type RecordInput } from '../flight-recorder/index.js';

const RECAP = 'This debate has focused on how artificial intelligence safety rules affect market fairness and public safety.';

describe('priorCommitTexts', () => {
  it('returns each earlier COMMIT intervention whole, in order, and nothing else', () => {
    const t = [
      { type: 'statement', content: 'A statement.' },
      { type: 'intervention', content: `${RECAP} The Safetyist conceded X.`, intervention_metadata: { move: 'COMMIT' } },
      { type: 'intervention', content: 'Skeptic, please probe this. More.', intervention_metadata: { move: 'PROBE' } },
      { type: 'intervention', content: '  Accelerationist, commit now! Then more.  ', intervention_metadata: { move: 'COMMIT' } },
    ];
    expect(priorCommitTexts(t)).toEqual([`${RECAP} The Safetyist conceded X.`, 'Accelerationist, commit now! Then more.']);
  });

  it('is empty when no COMMIT has been given yet (other moves do not count)', () => {
    expect(priorCommitTexts([{ type: 'intervention', content: 'x', intervention_metadata: { move: 'PIN' } }])).toEqual([]);
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
    expect(commit()).not.toContain('Do NOT reuse or paraphrase any sentence of them');
    const p = commit([RECAP]);
    expect(p).toContain('Do NOT reuse or paraphrase any sentence of them');
    expect(p).toContain(`- "${RECAP}"`);
  });

  it('never adds the do-not-repeat block to other moves', () => {
    const p = moderatorInterventionPrompt('PIN', 'elicitation', 'Safetyist', 'r', undefined, 't', undefined, undefined, undefined, undefined, [RECAP]);
    expect(p).not.toContain('Do NOT reuse or paraphrase any sentence of them');
  });
});

describe('latestTurnOf (t/784)', () => {
  it("returns the target's most recent statement or opening, skipping other speakers and interventions", () => {
    const t = [
      { type: 'opening', speaker: 'safetyist', content: 'S opening' },
      { type: 'statement', speaker: 'safetyist', content: 'S latest' },
      { type: 'statement', speaker: 'skeptic', content: 'K latest' },
      { type: 'intervention', speaker: 'moderator', content: 'M' },
    ];
    expect(latestTurnOf(t, 'safetyist')).toBe('S latest');
    expect(latestTurnOf(t, 'accelerationist')).toBeUndefined();
  });

  it("returns the opening when it is the speaker's only turn", () => {
    const t = [
      { type: 'opening', speaker: 'skeptic', content: 'K opening' },
      { type: 'statement', speaker: 'safetyist', content: 'S latest' },
    ];
    expect(latestTurnOf(t, 'skeptic')).toBe('K opening');
  });

  it('caps the turn at 1,500 characters by default', () => {
    const long = 'x'.repeat(2000);
    expect(latestTurnOf([{ type: 'statement', speaker: 'skeptic', content: long }], 'skeptic')).toBe('x'.repeat(1500));
  });
});

describe("Design's 6-word repetition check (t/784)", () => {
  const A = 'Safetyist, you must state your final position on the six-month pause by addressing three points.';
  const B = 'Accelerationist, you must state your final position on the six-month pause by addressing three points.';
  const C = 'Accelerationist, will you still hold that open compute beats registries if the audit data says otherwise?';

  it('finds a shared 6-word run, ignoring case and punctuation', () => {
    expect(sharedWordRun(A, B)).toBe('you must state your final position');
    expect(sharedWordRun(A, C)).toBeUndefined();
    expect(sharedWordRun('one two three four five', 'one two three four five')).toBeUndefined();
    expect(sharedWordRun('YOU MUST STATE YOUR FINAL POSITION now', 'so you must state your final position')).toBe('you must state your final position');
  });

  it('commitRepeat compares against every earlier COMMIT', () => {
    const t = [{ type: 'intervention', content: A, intervention_metadata: { move: 'COMMIT' } }];
    expect(commitRepeat(B, t)).toEqual({ run: 'you must state your final position' });
    expect(commitRepeat(C, t)).toBeUndefined();
  });

  describe('warnOnCommitRepeat', () => {
    afterEach(() => clearGlobalRecorder());
    it('WARNs with the shared run, and stays silent otherwise', () => {
      const record = vi.fn<(e: RecordInput) => void>();
      setGlobalRecorder({ record } as unknown as FlightRecorder);
      const t = [{ type: 'intervention', content: A, intervention_metadata: { move: 'COMMIT' } }];
      warnOnCommitRepeat(C, t, 15);
      expect(record).not.toHaveBeenCalled();
      warnOnCommitRepeat(B, t, 15);
      expect(record.mock.calls[0][0]).toMatchObject({ level: 'warn', message: expect.stringMatching(/round 15\) shares a 6-word run.*you must state your final position/) });
    });
  });
});

describe('COMMIT prompt presses a point that is the target\'s own (t/784 tweak)', () => {
  it("includes the target's latest turn and asks for one specific point, without a numbered list", () => {
    const p = moderatorInterventionPrompt('COMMIT', 'synthesis', 'Safetyist', 'r', undefined, 't', undefined, undefined, undefined, undefined, [], 'Registries cannot track open weights.');
    expect(p).toContain("=== SAFETYIST'S MOST RECENT TURN ===\nRegistries cannot track open weights.");
    expect(p).toContain('pressing ONE specific point that is recognisably theirs');
    expect(p).toContain('list numbered asks');
    expect(p).not.toContain('(1) what they conceded');
    // t/784 second replay: the model copied the stock 'hold, qualify or give it up' ask, so it is gone.
    expect(p).not.toMatch(/hold, qualify/i);
    expect(p).toContain('Do NOT use a stock phrase for this ask');
  });

  it('adds no target-turn block for other moves', () => {
    const p = moderatorInterventionPrompt('PIN', 'elicitation', 'Safetyist', 'r', undefined, 't', undefined, undefined, undefined, undefined, [], 'X');
    expect(p).not.toContain('MOST RECENT TURN');
  });
});
