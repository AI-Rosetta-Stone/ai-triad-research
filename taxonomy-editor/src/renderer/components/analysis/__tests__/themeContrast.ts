// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Shared helpers for the analysis/ contrast tests (t/4964, t/145): resolve the tokens a rule
// actually uses against the live theme blocks in styles.css (frozen, read-only) and compute WCAG
// ratios, so a token swap in either file re-checks.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Read a CSS file with CRLF normalized, so selector openers match on a Windows checkout. */
export function readCss(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

const STYLES = readCss(join(import.meta.dirname, '..', '..', '..', 'styles.css'));

const THEME_SELECTORS: Record<string, string> = {
  light: ':root,\n[data-theme="light"] {',
  dark: '[data-theme="dark"] {',
  bkc: '[data-theme="bkc"] {',
  harvard: '[data-theme="harvard"] {',
};

export const THEMES = Object.keys(THEME_SELECTORS);

function block(css: string, opener: string): string {
  const start = css.indexOf(opener);
  if (start < 0) throw new Error(`selector not found: ${opener}`);
  return css.slice(start + opener.length, css.indexOf('}', start));
}

/** A token's hex value in one theme block of styles.css. */
export function token(theme: string, name: string): string {
  const m = block(STYLES, THEME_SELECTORS[theme]).match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})\\b`));
  if (!m) throw new Error(`${name} has no hex value in the ${theme} theme block`);
  return m[1];
}

/** A rule's CSS custom property value (extracts `<name>` from `prop: var(<name>)` or `prop: var(<name>, fallback)`). */
export function ruleVar(css: string, selector: string, prop: string): string {
  const m = block(css, `${selector} {`).match(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*(?:[0-9a-z]+ solid )?var\\((--[a-z-]+)(?:\\s*,[^)]*)?\\)`));
  if (!m) throw new Error(`${selector} has no ${prop}: var(<name>)`);
  return m[1];
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colours. */
export function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
