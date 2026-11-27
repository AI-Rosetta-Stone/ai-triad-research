// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/758: generateText resolves the backend of EVERY model in a call's fallback chain up front (ai/aiBackends.ts, to
// name the chosen model's backend in the no-key error). An id in a chain that resolveBackend can't resolve would
// therefore fail calls whose primary model has a key. This walks the real ai-models.json so a future unregistered
// id fails here and not in a user's call.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveBackend } from '../../../../lib/ai-client/registry.js';

interface Registry { backends: { id: string }[]; models: { id: string; backend: string }[]; fallbackChains?: Record<string, string[]> }
const registry = JSON.parse(readFileSync(join(__dirname, '../../../../ai-models.json'), 'utf-8')) as Registry;
const chains = registry.fallbackChains ?? {};

describe('t/758: every model id in ai-models.json fallbackChains is registered', () => {
  it('there are chains to check', () => {
    expect(Object.keys(chains).length).toBeGreaterThan(0);
  });

  const ids = [...new Set(Object.entries(chains).flatMap(([primary, links]) => [primary, ...links]))].sort();

  it.each(ids)('%s is a registered model with a registered backend and resolves', (id) => {
    const entry = registry.models.find(m => m.id === id);
    expect(entry, `${id} is in a fallback chain but not in models[]`).toBeDefined();
    expect(registry.backends.some(b => b.id === entry!.backend), `${id}'s backend '${entry!.backend}' is not in backends[]`).toBe(true);
    expect(() => resolveBackend(id, registry)).not.toThrow();
  });
});
