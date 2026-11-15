// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4964: the dashboard chip buttons (preset / compare / exclusion) must pass WCAG AA in all
// four themes. Resolves the tokens the .adash-chip rules actually use against the live theme
// blocks in styles.css (frozen, read-only), so a token swap in either file re-checks here.

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readCss, THEMES, token, ruleVar as ruleVarIn, ratio } from './__tests__/themeContrast';

const DASH = readCss(join(import.meta.dirname, 'AnalyticsDashboard.css'));
const ruleVar = (selector: string, prop: string) => ruleVarIn(DASH, selector, prop);

describe('AnalyticsDashboard chip contrast (t/4964)', () => {
  describe.each(THEMES)('%s theme', (theme) => {
    it('inactive chip label passes 4.5:1 on its fill', () => {
      const fg = token(theme, ruleVar('.adash-chip', 'color'));
      const bg = token(theme, ruleVar('.adash-chip', 'background'));
      expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    });

    it('selected chip label passes 4.5:1 on its fill', () => {
      const fg = token(theme, ruleVar('.adash-chip[aria-pressed="true"]', 'color'));
      const bg = token(theme, ruleVar('.adash-chip[aria-pressed="true"]', 'background'));
      expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    });

    it('selected chip fill passes 3:1 against the page and inactive-chip surfaces', () => {
      const fill = token(theme, ruleVar('.adash-chip[aria-pressed="true"]', 'background'));
      expect(ratio(fill, token(theme, '--bg-primary'))).toBeGreaterThanOrEqual(3);
      expect(ratio(fill, token(theme, '--bg-secondary'))).toBeGreaterThanOrEqual(3);
    });

    it('selected fill is not a camp color', () => {
      expect(ruleVar('.adash-chip[aria-pressed="true"]', 'background')).not.toMatch(/^--color-(acc|saf|skp|cc)$/);
    });
  });

  // The other arm: the same calculator flags the pre-t/4964 pairings in the themes that failed,
  // so a passing run above isn't a calculator that passes everything. Pinned to the token values
  // as of t/4964 (not live tokens): t/123 (#4826) later fixed --text-muted itself, and this arm
  // documents the old failure, not the current theme.
  it('flags the old pairings (--text-muted label; white on --color-acc)', () => {
    expect(ratio('#8A8278', '#F3F0EB')).toBeLessThan(4.5); // harvard --text-muted on --bg-secondary
    expect(ratio('#7a6a82', '#281f29')).toBeLessThan(4.5); // bkc --text-muted on --bg-secondary
    expect(ratio('#ffffff', '#e89450')).toBeLessThan(3); // white on dark --color-acc
    expect(ratio('#ffffff', '#cc7e45')).toBeLessThan(4.5); // white on bkc --color-acc
  });
});

describe('AnalyticsDashboard user pill contrast (t/112)', () => {
  describe.each(THEMES)('%s theme', (theme) => {
    it('user-pill label with --text-secondary passes 4.5:1 on bg-primary', () => {
      const fg = token(theme, ruleVar('.adash-session-user-pill', 'color'));
      const bg = token(theme, ruleVar('.adash-session-user-pill', 'background'));
      expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    });
  });

  // Validation: show that --text-secondary strengthens the ratio across all themes
  // (--text-muted was already passing, so this is a strengthening, not a bug fix).
  describe.each(THEMES)('%s theme: --text-secondary stronger than --text-muted', (theme) => {
    it('--text-secondary > --text-muted on bg-primary', () => {
      const bgPrimary = token(theme, '--bg-primary');
      const textMuted = token(theme, '--text-muted');
      const textSecondary = token(theme, '--text-secondary');
      const ratioMuted = ratio(textMuted, bgPrimary);
      const ratioSecondary = ratio(textSecondary, bgPrimary);
      expect(ratioSecondary).toBeGreaterThan(ratioMuted);
    });
  });
});
