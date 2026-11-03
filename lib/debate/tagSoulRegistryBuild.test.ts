// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4534 root cause / t/4539 follow-up: `tagSoulRegistry.ts`'s import.meta.glob
// option { eager: true, as: 'raw' } loaded tag souls as parsed JSON MODULE
// OBJECTS under Vite 8's Rolldown production bundler, instead of raw text —
// but vitest's own transform handled `as: 'raw'` correctly, so the ordinary
// resolver tests (tagSoulRegistry.test.ts) never caught the regression.
// This test runs the SAME production bundler (vite build, write: false) that
// exposed the bug, and asserts the glob output stays a raw string. If a
// future Vite/Rolldown bump reintroduces the module-object behaviour for this
// option shape, this test fails instead of shipping silently.

import { describe, it, expect } from 'vitest';
import { build } from 'vite';
import path from 'node:path';
import type { OutputChunk, RollupOutput } from 'rollup';

describe('tagSoulRegistry import.meta.glob — production build regression (t/4534, t/4539)', () => {
  it('bundles tag soul files as raw text, not JSON module objects, under vite build', async () => {
    const entry = path.resolve(import.meta.dirname, 'tagSoulRegistry.ts');
    const result = await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        lib: { entry, formats: ['es'], fileName: () => 'tag-soul-registry-probe.mjs' },
        rollupOptions: {
          // Bundle the entry's full module graph for real — the bug only
          // reproduces when the glob's generated sub-imports actually get
          // transformed and inlined, which is what happens in the real
          // renderer build. Only Node builtins (pulled in transitively by
          // flight-recorder) are left external; nothing else is.
          external: /^(node:|fs|path|crypto|url)($|\/)/,
        },
      },
    });
    const output = (Array.isArray(result) ? result[0] : result) as RollupOutput;
    const chunk = output.output.find((o): o is OutputChunk => o.type === 'chunk');
    expect(chunk).toBeTruthy();
    const code = chunk!.code;

    expect(code).toContain('skeptic.critical.soul.json');
    expect(code).toContain('skeptic.institutional.soul.json');

    // A JSON module object (the broken shape under Rolldown) exposes each
    // top-level JSON key as a named getter, including `personality` and the
    // bundler-synthesized `default`. Raw text has neither — it's a string
    // literal containing the file's own JSON content.
    expect(code).not.toMatch(/personality:\s*\(\s*\)\s*=>/);
    expect(code).not.toMatch(/\bdefault:\s*\(\s*\)\s*=>/);
  });
});
