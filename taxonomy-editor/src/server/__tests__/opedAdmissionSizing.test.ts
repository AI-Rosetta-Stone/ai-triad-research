// @vitest-environment node
// t/616 (Security p/93#71, SO p/252#54): the op-ed run admission counts every provider call a run can make, so a run
// the pool can't finish is refused before it starts instead of being stopped mid-voice.
//   - per voice: 7 stages (generate.ts callStage sites), plus the reflection retry with source material (t/2919);
//   - per run: plus the source brief with source material;
//   - a drift guard: if generate.ts gains a stage or another reflection attempt, this fails until the constants move.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  opedAdmissionEstimate, OPED_MAX_CALLS_PER_VOICE, OPED_SOURCE_EXTRA_CALLS_PER_VOICE, OPED_SET_CALLS_WITH_SOURCE,
} from '../ai/opedPoolAdmission.js';

const generateTs = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'lib', 'oped', 'generate.ts'), 'utf8');
const count = (re: RegExp) => (generateTs.match(re) ?? []).length;

describe('t/616: op-ed admission sizing', () => {
  it('topic only: 7 calls per voice, no source brief, no reflection retry', () => {
    expect(opedAdmissionEstimate({ voices: 3, sourceBytes: 0, generationMaxTokens: 6000 }, undefined).calls).toBe(21);
  });

  it('with source: 8 calls per voice (the reflection retry, SO p/252#54) plus the source brief', () => {
    expect(OPED_SOURCE_EXTRA_CALLS_PER_VOICE).toBe(1);
    expect(opedAdmissionEstimate({ voices: 3, sourceBytes: 50_000, generationMaxTokens: 6000 }, undefined).calls).toBe(3 * 8 + 1);
  });

  it('tokens are capped at what $5 buys', () => {
    expect(opedAdmissionEstimate({ voices: 3, sourceBytes: 50_000, generationMaxTokens: 6000 }, 1000).tokens).toBe(1000);
  });

  it('drift guard: generate.ts has 6 per-voice callStage sites plus the source brief, and two reflection attempts', () => {
    // callStage sites: generation, coherence-judge, coherence-rewrite, coherence-rejudge, readability-edit (called
    // twice via attemptEdit: first try and one retry), grounding-reflection, source-brief (set level).
    expect(count(/callStage\('/g)).toBe(7);
    expect(count(/await attemptEdit\(/g)).toBe(2);
    expect(count(/await runReflection\(/g)).toBe(2);
    // per voice: 5 single-call stages + 2 edit attempts = 7; the second reflection is the source-only extra.
    expect(OPED_MAX_CALLS_PER_VOICE).toBe(5 + 2);
    expect(OPED_SET_CALLS_WITH_SOURCE).toBe(1);
  });
});
