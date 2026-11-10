// Self-test for the token-contrast checker (t/2264).
//
// The checker exists because contrast defects are invisible to the rest of our
// suite. That makes its own detection the thing most worth guarding: a silent
// regression here would restore the blind spot while still reporting green.
//
// Each case mirrors one shape from the real t/2234 defect corpus.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check-contrast.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'contrast');

const result = check({
  rendererDir: FIXTURES,
  stylesFile: join(FIXTURES, 'theme-tokens.css'),
});

const contrastOn = (selector) =>
  result.findings.filter((f) => f.kind === 'contrast' && f.selector === selector);

describe('token-contrast checker — detection', () => {
  it('flags white over a light fill in the same block', () => {
    const hits = contrastOn('.fx-fail-same-block');
    assert.ok(hits.length > 0, 'expected at least one finding');
    assert.ok(hits.every((f) => f.ratio < 4.5), 'all findings should be below AA');
  });

  it('flags a fill on the ancestor with the text on a descendant', () => {
    // The badge defects had this shape; same-block-only matching misses them.
    assert.ok(contrastOn('.fx-ancestor .fx-child').length > 0);
  });

  it('flags a runtime fill declared via a contrast-fill annotation', () => {
    // The filled-badge defect: the fill arrives as an inline style, so CSS-only
    // analysis cannot see it without the annotation.
    assert.ok(contrastOn('.fx-annotated .fx-label').length > 0);
  });

  it('reports an undefined fill token instead of silently skipping it', () => {
    const hits = result.findings.filter(
      (f) => f.kind === 'undefined-fill' && f.selector === '.fx-undefined-fill',
    );
    assert.ok(hits.length > 0, 'expected at least one finding');
    assert.ok([...result.undefinedTokens.keys()].includes('--fx-does-not-exist'));
  });

  it('evaluates a transparent-fill non-text control against the page surface at 3:1 (t/2359)', () => {
    // Gap 1: a `background: transparent` control was silently skipped (resolveColor
    // → null → continue), hiding it from the gate. It must fall through to the page
    // surface and be scored at the 3:1 non-text floor (Gap 2).
    const hits = contrastOn('.fx-nontext-fail');
    assert.ok(hits.length > 0, 'a transparent-fill control must be evaluated, not skipped');
    assert.ok(hits.every((f) => f.required === 3.0), 'non-text controls score at the 3:1 floor');
    assert.ok(hits.every((f) => f.ratio < 3.0), 'flagged only below 3:1');
  });
});

describe('token-contrast checker — no false positives', () => {
  it('passes white over a dark fill', () => {
    assert.equal(contrastOn('.fx-ok-same-block').length, 0);
  });

  it('passes a theme-scoped override that inverts the glyph', () => {
    // The shape of both shipped fixes: [data-theme=…] overriding the base rule.
    assert.equal(contrastOn('.fx-scoped').length, 0);
  });

  it('composites a translucent fill rather than comparing it raw', () => {
    // Without alpha compositing, a 12% tint of C under `color: C` resolves to
    // the same two colors and reads as an impossible 1:1 — the shape of ~70
    // false positives on the real tree. The tint may still legitimately fail on
    // a dark surface, so the assertion is that compositing HAPPENED, not that
    // the pair passes.
    const hits = contrastOn('.fx-alpha');
    assert.ok(
      hits.every((f) => f.ratio !== 1),
      'a translucent fill must be flattened onto the surface before comparison',
    );
  });

  it('passes a non-text control at 3.68:1 that would fail the 4.5 text threshold (t/2359)', () => {
    // Proves the 3:1 non-text floor is applied, not the 4.5 text threshold.
    assert.equal(contrastOn('.fx-nontext-pass').length, 0);
  });

  it('does not audit an un-annotated transparent TEXT control against the page surface (t/2359)', () => {
    // Flood guard: without the marker, a transparent control stays part of the
    // opt-in --include-page-bg audit (its 3.68:1 < 4.5 would otherwise flag it).
    assert.equal(contrastOn('.fx-transparent-text').length, 0);
  });

  it("applies the non-text floor to a control's :hover via pseudo-strip (t/2359)", () => {
    // Same control, not a broadened selector. Opaque fill → always evaluated;
    // 3.68:1 fails 4.5 in every theme, so 0 findings proves the 3:1 floor was used.
    assert.equal(contrastOn('.fx-nontext-pass:hover').length, 0);
  });
});

describe('token-contrast checker — detection gaps closed in t/143', () => {
  it('measures a color-mix(…, transparent) tint instead of dropping it', () => {
    const hits = contrastOn('.fx-mix-tint');
    assert.ok(hits.length > 0, 'a transparent color-mix tint must be evaluated');
    assert.ok(hits.every((f) => f.ratio > 1 && f.ratio < 4.5), 'composited like rgba(), not raw');
  });

  it('reports a color-mix it cannot resolve as unmeasured', () => {
    assert.ok(
      [...result.unmeasured].some((v) => v.includes('currentColor')),
      'an unresolvable color-mix must be listed, not silently skipped',
    );
  });

  it('composites a translucent chip over its filled ancestor, not the page', () => {
    assert.equal(contrastOn('.fx-row .fx-chip').length, 0);
  });

  it('resolves a token from another root token sheet before the var() fallback', () => {
    assert.ok(contrastOn('.fx-lib').length > 0, '--fx-lib-fill (light) must win over the dark fallback');
  });

  it('does not read a theme-scoped component rule as a token sheet', () => {
    // lib-tokens.css sets --fill-light under `[data-theme="dark"] .fx-lib-scope`; if that leaked
    // into the dark tokens, white over --fill-light would pass in dark.
    assert.ok(contrastOn('.fx-fail-same-block').some((f) => f.theme === 'dark'));
  });

  it('treats a non-normalised stylesFile path as the stylesFile', () => {
    const run = check({ rendererDir: FIXTURES, stylesFile: `${FIXTURES}/./theme-tokens.css` });
    assert.equal(run.findings.length, result.findings.length);
    assert.equal(
      run.findings.filter((f) => f.selector === '.fx-styles-unannotated').length,
      0,
      'the stylesFile must still be excluded in default mode',
    );
  });
});

describe('token-contrast checker — annotated selectors in the stylesFile (t/2372)', () => {
  // CI runs the gate without --all, which excludes the stylesFile. An annotated
  // selector there (e.g. .field-help-btn) must still be evaluated; an unannotated
  // one must stay opt-in. `result` above is a default (no --all) run.
  it('evaluates an ANNOTATED selector defined in the stylesFile in default mode', () => {
    assert.ok(contrastOn('.fx-styles-annotated').length > 0, 'annotated stylesFile selector must be checked in default mode');
    assert.ok(contrastOn('.fx-styles-annotated').every((f) => f.required === 3.0), 'scored at its non-text floor');
  });

  it('still EXCLUDES an unannotated stylesFile selector in default mode', () => {
    assert.equal(contrastOn('.fx-styles-unannotated').length, 0, 'unannotated stylesFile rules stay opt-in (--all)');
  });

  it('includes the unannotated stylesFile selector only under --all', () => {
    const allRun = check({
      rendererDir: FIXTURES,
      stylesFile: join(FIXTURES, 'theme-tokens.css'),
      all: true,
    });
    assert.ok(
      allRun.findings.some((f) => f.kind === 'contrast' && f.selector === '.fx-styles-unannotated'),
      '--all must scan every stylesFile rule',
    );
  });
});
