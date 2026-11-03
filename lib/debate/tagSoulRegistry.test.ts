// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { resolvePoverInfo } from './tagSoulRegistry.js';
import { POVER_INFO } from './poverInfo.js';

describe('resolvePoverInfo (no tagSelection)', () => {
  it('returns POVER_INFO soul for each base speaker', () => {
    for (const speaker of ['accelerationist', 'safetyist', 'skeptic'] as const) {
      const { soul } = resolvePoverInfo(speaker);
      expect(soul).toBe(POVER_INFO[speaker]);
    }
  });

  it('returns soulProvenance with expected file path', () => {
    const { soulProvenance } = resolvePoverInfo('safetyist');
    expect(soulProvenance.file).toBe('safetyist.soul.json');
  });

  it('returns soulProvenance hash as fnv1a64 prefixed hex', () => {
    const { soulProvenance } = resolvePoverInfo('skeptic');
    expect(soulProvenance.hash).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
  });

  it('hash is deterministic across calls', () => {
    const { soulProvenance: p1 } = resolvePoverInfo('accelerationist');
    const { soulProvenance: p2 } = resolvePoverInfo('accelerationist');
    expect(p1.hash).toBe(p2.hash);
  });
});

describe('resolvePoverInfo (tagSelection — tag present in registry)', () => {
  // t/4534: the glob option { eager: true, as: 'raw' } loads as a parsed JSON
  // module (not raw text) under Rolldown's production bundler, so JSON.parse
  // throws for every tag soul. Resolve real tag souls end-to-end so a future
  // bundler/glob-option regression fails a test instead of shipping silently.
  it('resolves skeptic:critical with personality text and provenance', () => {
    const { soul, soulProvenance } = resolvePoverInfo('skeptic', { tag: 'critical', mode: 'scope' });
    expect(typeof soul.personality).toBe('string');
    expect(soul.personality.length).toBeGreaterThan(0);
    expect(soulProvenance?.file).toBe('skeptic.critical.soul.json');
    expect(soulProvenance?.hash).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
  });

  it('resolves skeptic:institutional with personality text and provenance', () => {
    const { soul, soulProvenance } = resolvePoverInfo('skeptic', { tag: 'institutional', mode: 'scope' });
    expect(typeof soul.personality).toBe('string');
    expect(soul.personality.length).toBeGreaterThan(0);
    expect(soulProvenance?.file).toBe('skeptic.institutional.soul.json');
    expect(soulProvenance?.hash).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
  });

  it('base identity fields (label, pov) win over the tag soul, per t/3988', () => {
    const { soul } = resolvePoverInfo('skeptic', { tag: 'critical', mode: 'scope' });
    expect(soul.label).toBe(POVER_INFO.skeptic.label);
    expect(soul.pov).toBe(POVER_INFO.skeptic.pov);
  });
});

describe('resolvePoverInfo (tagSelection — tag absent from registry)', () => {
  it('throws ActionableError when tag soul is not in the bundle', () => {
    expect(() =>
      resolvePoverInfo('accelerationist', { tag: 'nonexistent-tag', mode: 'scope' }),
    ).toThrow(/nonexistent-tag/i);
  });

  it('throws for prioritize mode too', () => {
    expect(() =>
      resolvePoverInfo('skeptic', { tag: 'missing', mode: 'prioritize' }),
    ).toThrow(/missing/i);
  });
});
