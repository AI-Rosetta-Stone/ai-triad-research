// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3518 Phase 2 seam test: proves that the opening phase composes
// DEFAULT_BRIEF_TIMEOUT_MS with the per-model floor via Math.max.
// t/3614: the floor is now read from the adapter's host-loaded `registry` via the imported
// getModelMinTimeout(model, adapter.registry) — the opening phase no longer calls an adapter
// method. A registry that floors the debate model to 300_000 must yield briefTimeoutMs = 300_000,
// not 120_000. If the Math.max wiring or the registry threading were deleted, this fails.

import { describe, it, expect, vi } from 'vitest';

// t/57: keep engine.run() off the real ai-triad-data calibration log.
vi.mock('./calibrationLogger.js', async (importOriginal) =>
  (await import('./__tests__/hermeticCalibration.js')).hermeticCalibrationLogger(importOriginal));
import { DebateEngine } from './debateEngine.js';
import type { ExtendedAIAdapter, GenerateOptions } from './aiAdapter.js';
import type { ModelRegistry } from '../ai-client/index.js';
import { createMinimalTaxonomy, createDefaultConfig } from './debateEngine.testHelpers.js';

describe('Opening brief timeout floor wiring (t/3518, t/3614)', () => {
  it('brief gets 300_000 when the registry floors the debate model to 300_000 (> DEFAULT_BRIEF_TIMEOUT_MS)', async () => {
    const capturedTimeouts: Array<number | undefined> = [];

    // The debate model (createDefaultConfig → 'gemini-2.0-flash') carries a 300_000 floor here.
    const registry: ModelRegistry = {
      backends: [],
      models: [
        { id: 'gemini-2.0-flash', apiModelId: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', backend: 'gemini', minTimeoutMs: 300_000 },
      ],
    };

    const adapter: ExtendedAIAdapter = {
      async generateText(_prompt: string, _model: string, opts?: GenerateOptions) {
        capturedTimeouts.push(opts?.timeoutMs);
        return '{"response":"mock"}';
      },
      registry,
    };

    const engine = new DebateEngine(
      createDefaultConfig({ rounds: 1 }),
      adapter,
      createMinimalTaxonomy(),
    );

    try { await engine.run(); } catch { /* engine may throw on mock responses — we only need the call log */ }

    // The brief for each debater gets briefTimeoutMs = Math.max(DEFAULT_BRIEF_TIMEOUT_MS,
    // getModelMinTimeout(model, engine.adapter.registry)) = Math.max(120_000, 300_000) = 300_000.
    // Other calls (init, synthesis, etc.) use DEFAULT_AI_TIMEOUT_MS = 120_000.
    // At least one call must have seen 300_000 — if the Math.max wiring is deleted or the
    // registry threading is broken, every call stays at 120_000 and this fails.
    expect(capturedTimeouts.length).toBeGreaterThan(0);
    expect(capturedTimeouts).toContain(300_000);
  });
});
