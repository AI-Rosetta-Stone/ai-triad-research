// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Adjacency test (t/3734, SO condition via t/3667#6) for the shared public-surface renderer.
// This component backs BOTH PublicInquiryView.tsx (the live /inquiries/:shareId page) and
// InquiryShareDialog.tsx's mint-time preview (t/3654) — one structural fix here covers both.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { PublicInquiryShare } from '@lib/inquiry';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PublicInquiryShareContent } from './PublicInquiryShareContent';
import { UNTAGGED_SHARE } from './__fixtures__/publicInquiryShareDoc';

const BASE_DOC = {
  version: 1 as const,
  request: { question: 'What counts as an AI harm?', fidelity: 'standard' as const },
  campVerdicts: [],
  convergences: [],
  evidenceLayers: [],
  unresolvedGaps: [],
  calibration: [],
  derivation: { fidelity: 'standard' as const, models: { debaters: 'claude-sonnet-5', evaluator: 'claude-opus-5' }, rounds: 4 },
  grounding: { nodesByCamp: {} },
  singleRunCaveat: 'This is one run of a stochastic process, not a repeated-measures finding.',
} as unknown as PublicInquiryShare;

describe('PublicInquiryShareContent headline/caveat adjacency (t/3734)', () => {
  it('renders synthesizedHeadline immediately adjacent to singleRunCaveat, inside one wrapper', () => {
    const doc = { ...BASE_DOC, synthesizedHeadline: 'Camps converge on outcome, diverge on intent.' } as PublicInquiryShare;
    render(<PublicInquiryShareContent doc={doc} />);

    const headline = screen.getByText('Camps converge on outcome, diverge on intent.');
    const caveat = screen.getByText(BASE_DOC.singleRunCaveat, { exact: false });

    expect(headline.parentElement).toBe(caveat.parentElement);
    expect(caveat.previousElementSibling).toBe(headline);
  });

  it('suppresses the headline slot when synthesizedHeadline is absent (Condition A: absent by construction), caveat still renders', () => {
    render(<PublicInquiryShareContent doc={BASE_DOC} />);

    const caveat = screen.getByText(BASE_DOC.singleRunCaveat, { exact: false });
    expect(caveat.previousElementSibling).toBeNull();
  });
});

// t/3983 (SO e/252 cond 2): a reader must be able to tell a single-wing answer from the whole camp's.
describe('PublicInquiryShareContent POV-tag scope (t/3983)', () => {
  afterEach(() => cleanup());
  const SKP_CRITICAL = { pov: 'skeptic' as const, tag: 'critical', mode: 'scope' as const };
  const tagged = (sel: typeof SKP_CRITICAL | { pov: 'skeptic'; tag: string; mode: 'prioritize' }, counts?: { included: number; excludedUntagged: number }) => ({
    ...UNTAGGED_SHARE,
    request: { ...UNTAGGED_SHARE.request, tagSelection: sel },
    derivation: { ...UNTAGGED_SHARE.derivation, ...(counts ? { tag: { ...sel, ...counts } } : {}) },
  }) as unknown as PublicInquiryShare;

  it('(a) a tagged Scope share renders the scope label and both counts', () => {
    render(<PublicInquiryShareContent doc={tagged(SKP_CRITICAL, { included: 12, excludedUntagged: 31 })} />);
    const scope = screen.getByLabelText('Tag scope');
    // 'critical' is registered (t/3956), so its registry label renders; the raw-id fallback is the retired-tag arm below.
    expect(scope.textContent).toContain('Scoped to Skeptic · Critical (Scope mode)');
    expect(scope.textContent).toContain('Grounded on 12 Skeptic nodes tagged Critical; 31 Skeptic nodes not tagged Critical excluded.');
  });

  it('(b) an untagged share renders byte-identical to origin/main before this change', () => {
    const baseline = readFileSync(resolve(process.cwd(), 'src/renderer/components/__fixtures__/publicInquiryShare.untagged.html'), 'utf8');
    const { container } = render(<PublicInquiryShareContent doc={UNTAGGED_SHARE} />);
    expect(container.innerHTML).toBe(baseline);
    expect(screen.queryByLabelText('Tag scope')).toBeNull();
  });

  it('(c) a Prioritize share says "Prioritizing", not "Scoped", and reports no exclusion', () => {
    render(<PublicInquiryShareContent doc={tagged({ pov: 'skeptic', tag: 'critical', mode: 'prioritize' }, { included: 12, excludedUntagged: 0 })} />);
    const text = screen.getByLabelText('Tag scope').textContent ?? '';
    expect(text).toContain('Prioritizing Skeptic · Critical');
    expect(text).not.toMatch(/Scoped|excluded/);
  });

  it('a requested tag the run did not apply shows the request AND warns that the whole camp was used', () => {
    render(<PublicInquiryShareContent doc={tagged(SKP_CRITICAL)} />);
    expect(screen.getByRole('note').textContent).toMatch(/not applied; this answer reflects the whole camp/);
  });

  it('a retired tag (no longer in the registry) still renders, by its raw id', () => {
    render(<PublicInquiryShareContent doc={tagged({ ...SKP_CRITICAL, tag: 'retired-wing' }, { included: 3, excludedUntagged: 5 })} />);
    expect(screen.getByLabelText('Tag scope').textContent).toContain('Skeptic · retired-wing');
  });

  it('a mismatch labels what ran and notes what was requested', () => {
    const doc = tagged(SKP_CRITICAL, { included: 12, excludedUntagged: 0 }) as unknown as { derivation: { tag: { mode: string } } };
    doc.derivation.tag.mode = 'prioritize';
    render(<PublicInquiryShareContent doc={doc as unknown as PublicInquiryShare} />);
    expect(screen.getByLabelText('Tag scope').textContent).toContain('Prioritizing Skeptic · Critical (requested: Skeptic · Critical, scope mode)');
  });
});
