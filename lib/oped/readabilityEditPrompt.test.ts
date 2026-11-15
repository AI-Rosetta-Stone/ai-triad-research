// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/202: the readability-edit prompt's rules come from the SAME outlet targets that trigger the edit, so the
// rules and the violations line always agree. Rendered against the real prompt file and real outlets.json.

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { assembleReadabilityEditPrompt } from './promptLoader.js';
import { OUTLET_BANDS } from './outletBands.js';
import { loadOutletsData } from './loadOutlets.js';
import { DEFAULT_READABILITY_TARGETS } from './readabilityMeasure.js';

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), 'prompts');
const render = (outlet: string) => {
  const band = OUTLET_BANDS[outlet];
  return assembleReadabilityEditPrompt(PROMPTS, 'BODY', 'VIOLATIONS', band.readability ?? DEFAULT_READABILITY_TARGETS, band.style);
};

describe('readability-edit prompt follows the outlet (t/202)', () => {
  for (const outlet of Object.keys(OUTLET_BANDS)) {
    it(`${outlet}: its own targets and house style, no unfilled slot`, () => {
      const band = OUTLET_BANDS[outlet];
      const t = band.readability ?? DEFAULT_READABILITY_TARGETS;
      const style = band.style ?? loadOutletsData().styleDefaults;
      const p = render(outlet);
      expect(p).not.toContain('{{');
      expect(p).toContain(`Flesch-Kincaid grade no higher than ${t.fkMax}.`);
      expect(p).toContain(`no sentence over ${t.maxSentWords} words`);
      expect(p).toContain(`no paragraph over ~${t.maxParaWords} words`);
      expect(p).toContain(style.sentenceMechanics);
      expect(p).toContain(style.paragraphMechanics);
      expect(p).toContain(style.jargonGuidance);
      expect(p).toMatchSnapshot();
    });
  }

  it("Tech Policy Press gets TPP's numbers and none of the old grade-10 rules", () => {
    const p = render('TechPolicyPress');
    expect(p).toContain('no higher than 16');
    expect(p).toContain('no sentence over 40 words');
    expect(p).toContain('~120 words');
    expect(p).not.toMatch(/10th-grade|grade ~10|no higher than 11\b|over 30 words|~90 words/);
  });

  it('the default outlets keep the grade-10 rules in effect (11 / 30 / 90, average under 18, plain words)', () => {
    const p = render('Generic');
    expect(p).toContain('no higher than 11.');
    expect(p).toContain('no sentence over 30 words');
    expect(p).toContain('~90 words');
    expect(p).toContain('average under 18 words');
    expect(p).toContain('Eliminate jargon');
  });
});
