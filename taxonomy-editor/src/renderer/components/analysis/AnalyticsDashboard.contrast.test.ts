// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4964: the dashboard chip buttons (preset / compare / exclusion) must pass WCAG AA in all
// four themes. Resolves the tokens the .adash-chip rules actually use against the live theme
// blocks in styles.css (frozen, read-only), so a token swap in either file re-checks here.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Normalize CRLF so the selector openers below match on a Windows checkout.
const STYLES = readFileSync(join(import.meta.dirname, '..', '..', 'styles.css'), 'utf8').replace(/\r\n/g, '\n');
const DASH = readFileSync(join(import.meta.dirname, 'AnalyticsDashboard.css'), 'utf8').replace(/\r\n/g, '\n');

const THEME_SELECTORS: Record<string, string> = {
  light: ':root,\n[data-theme="light"] {',
  dark: '[data-theme="dark"] {',
  bkc: '[data-theme="bkc"] {',
  harvard: '[data-theme="harvard"] {',
};

function block(css: string, opener: string): string {
  const start = css.indexOf(opener);
  if (start < 0) throw new Error(`selector not found: ${opener}`);
  return css.slice(start + opener.length, css.indexOf('}', start));
}

function token(theme: string, name: string): string {
  const m = block(STYLES, THEME_SELECTORS[theme]).match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})\\b`));
  if (!m) throw new Error(`${name} has no hex value in the ${theme} theme block`);
  return m[1];
}

/** `prop: var(--x)` from a rule in AnalyticsDashboard.css → `--x`. */
function ruleVar(selector: string, prop: string): string {
  const m = block(DASH, `${selector} {`).match(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*var\\((--[a-z-]+)\\)`));
  if (!m) throw new Error(`${selector} has no ${prop}: var(--…)`);
  return m[1];
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES = Object.keys(THEME_SELECTORS);

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
