// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3543 seam test: proves that the opening brief stage passes maxTokens = 32_000
// to generateText for opus/fable models.
// If the cap is lowered below 32_000 or the fallback removed, this fails.

import { describe, it, expect, vi } from 'vitest';

// t/57: keep engine.run() off the real ai-triad-data calibration log.
vi.mock('./calibrationLogger.js', async (importOriginal) =>
  (await import('./__tests__/hermeticCalibration.js')).hermeticCalibrationLogger(importOriginal));
import { DebateEngine } from './debateEngine.js';
import type { ExtendedAIAdapter, GenerateOptions } from './aiAdapter.js';
import { createMinimalTaxonomy, createDefaultConfig } from './debateEngine.testHelpers.js';

describe('Opening brief maxTokens cap (t/3543)', () => {
  it('brief gets maxTokens = 32_000 for an opus model', async () => {
    const capturedMaxTokens: Array<number | undefined> = [];

    const adapter: ExtendedAIAdapter = {
      async generateText(_prompt: string, _model: string, opts?: GenerateOptions) {
        capturedMaxTokens.push(opts?.maxTokens);
        return '{"response":"mock"}';
      },
      registry: { backends: [], models: [] },
    };

    // Use claude-opus-5 (contains 'opus') so the 32_000 briefMaxTokens cap applies.
    const engine = new DebateEngine(
      createDefaultConfig({ rounds: 1, model: 'claude-opus-5' }),
      adapter,
      createMinimalTaxonomy(),
    );

    try { await engine.run(); } catch { /* engine may throw on mock responses — we only need the call log */ }

    // At least one call must have seen 32_000 (the brief).
    // Non-brief calls (init, synthesis, neutral eval) pass undefined.
    // If the cap is deleted or reduced below 32_000 on opus, this fails.
    expect(capturedMaxTokens.length).toBeGreaterThan(0);
    expect(capturedMaxTokens).toContain(32_000);
  });
});
