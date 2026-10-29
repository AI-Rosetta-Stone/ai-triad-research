// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4647: a global [hidden] { display: none !important; } so a component's own display
// rule can't silently defeat the hidden attribute (the class of bug Design caught in
// t/4639#4). jsdom never loads CSS, so this reads the source text directly rather than
// asserting on rendered DOM — a rendered-DOM test would pass even if this rule were
// deleted entirely.

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

describe('BaseReset.css — global [hidden] reset (t/4647)', () => {
  it('declares [hidden] { display: none !important; }', () => {
    const css = readFileSync(join(__dirname, 'BaseReset.css'), 'utf-8');
    expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
  });

  it('is imported in index.tsx, before styles.css', () => {
    const index = readFileSync(join(__dirname, 'index.tsx'), 'utf-8');
    const resetIdx = index.indexOf("'./BaseReset.css'");
    const stylesIdx = index.indexOf("'./styles.css'");
    expect(resetIdx).toBeGreaterThan(-1);
    expect(stylesIdx).toBeGreaterThan(-1);
    expect(resetIdx).toBeLessThan(stylesIdx);
  });
});
