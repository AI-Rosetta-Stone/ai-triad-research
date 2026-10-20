// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { inquiryTagScopeLines, type ResolvedTag, type ResolvedAppliedTag } from './inquiryTagScopeText';

// t/3983: the share must say when an answer reflects one wing of a camp (SO e/252 cond 2).
const skpCritical = (mode: 'scope' | 'prioritize' = 'scope'): ResolvedTag =>
  ({ pov: 'skeptic', tag: 'critical', mode, campLabel: 'Skeptic', tagLabel: 'Critical' });
const ran = (t: ResolvedTag, included = 12, excludedUntagged = 31): ResolvedAppliedTag => ({ ...t, included, excludedUntagged });

describe('inquiryTagScopeLines (t/3983)', () => {
  it('untagged: null, so the share renders exactly as before', () => {
    expect(inquiryTagScopeLines(undefined, undefined)).toBeNull();
  });

  it('Scope: names the camp and tag, and reports both counts', () => {
    expect(inquiryTagScopeLines(skpCritical(), ran(skpCritical()))).toEqual({
      label: 'Scoped to Skeptic · Critical (Scope mode)',
      detail: 'Grounded on 12 Skeptic nodes tagged Critical; 31 Skeptic nodes not tagged Critical excluded.',
    });
  });

  it('Prioritize: says "Prioritizing", never "Scoped", and reports no exclusion', () => {
    const lines = inquiryTagScopeLines(skpCritical('prioritize'), ran(skpCritical('prioritize'), 12, 0))!;
    expect(lines.label).toBe('Prioritizing Skeptic · Critical');
    expect(lines.label).not.toMatch(/Scoped/);
    expect(lines.detail).toMatch(/ranked first; the camp's other nodes still included/);
    expect(lines.detail).not.toMatch(/excluded/);
  });

  it('requested but not applied: shows the request and warns that the whole camp was used', () => {
    const lines = inquiryTagScopeLines(skpCritical(), undefined)!;
    expect(lines.label).toBe('Scoped to Skeptic · Critical (Scope mode)');
    expect(lines.detail).toBeUndefined();
    expect(lines.warn).toMatch(/not applied; this answer reflects the whole camp/);
  });

  it('mismatch: the label shows what RAN and notes what was requested', () => {
    const lines = inquiryTagScopeLines(skpCritical('scope'), ran(skpCritical('prioritize'), 12, 0))!;
    expect(lines.label).toBe('Prioritizing Skeptic · Critical (requested: Skeptic · Critical, scope mode)');
    expect(lines.detail).toMatch(/ranked first/);
  });

  it('retired tag: shows whatever label the caller resolved (the raw id), never blank', () => {
    const retired: ResolvedTag = { pov: 'skeptic', tag: 'old-wing', mode: 'scope', campLabel: 'Skeptic', tagLabel: 'old-wing' };
    expect(inquiryTagScopeLines(retired, ran(retired)).label).toBe('Scoped to Skeptic · old-wing (Scope mode)');
  });

  it('singular counts read naturally', () => {
    expect(inquiryTagScopeLines(skpCritical(), ran(skpCritical(), 1, 1))!.detail).toBe('Grounded on 1 Skeptic node tagged Critical; 1 Skeptic node not tagged Critical excluded.');
  });

  it('t/4275: never calls the excluded count "untagged" (prod: 94 of the 100 carried Institutional)', () => {
    const lines = inquiryTagScopeLines(skpCritical(), ran(skpCritical(), 277, 100))!;
    expect(lines.detail).toBe('Grounded on 277 Skeptic nodes tagged Critical; 100 Skeptic nodes not tagged Critical excluded.');
    expect(lines.detail).not.toMatch(/untagged/);
    expect(inquiryTagScopeLines(skpCritical('prioritize'), ran(skpCritical('prioritize'), 277, 0))!.detail).not.toMatch(/untagged/);
  });
});
