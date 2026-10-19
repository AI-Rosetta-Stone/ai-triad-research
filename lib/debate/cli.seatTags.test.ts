// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4305: tests for CLIConfig.seatTags and CLIConfig.soulOverrides helpers.
// Tests the extracted helpers (validateSeatTagsConfig, loadSoulOverrides,
// buildSoulOverrideResolver) that cli.ts wires into DebateConfig.

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  validateSeatTagsConfig,
  loadSoulOverrides,
  buildSoulOverrideResolver,
  compareSoulProvenance,
  type CLISeatTags,
  type CLISoulOverrides,
} from './cli.helpers.js';
import { resolvePoverInfo, clearSoulDocCache } from './soulDocLoader.js';
import type { PovTagRegistry } from '../schema/povTags.js';
import { ActionableError } from './errors.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

/** Minimal valid SoulDocument JSON for a given POV. */
function minimalSoulDoc(pov: 'accelerationist' | 'safetyist' | 'skeptic') {
  return {
    pov,
    label: `Test ${pov}`,
    color: '#aabbcc',
    personality: 'A test persona.',
    voice: {
      disposition: 'test disposition',
      style: 'test style',
      reasoning: 'test reasoning',
      evidence: 'test evidence',
      signature: 'test signature',
      prose_style: 'test prose_style',
      voice_hygiene: 'test voice_hygiene',
      prose_style_short: 'test short',
      voice_hygiene_short: 'test short hygiene',
    },
    anti_patterns: ['anti-pattern-one'],
    value_hierarchy: ['value-one'],
    epistemic_stance: ['stance-one'],
    boundaries: {
      hardcoded: ['hard-one'],
      softcoded: ['soft-one'],
    },
  };
}

/** Minimal PovTagRegistry with one tag per POV. */
function testRegistry(): PovTagRegistry {
  return {
    version: 1,
    povs: {
      accelerationist: [{ id: 'techno-optimist', label: 'Techno-optimist', soul_doc: 'accelerationist.techno-optimist', description: 'Test tag' }],
      safetyist: [{ id: 'cautious', label: 'Cautious', soul_doc: 'safetyist.cautious', description: 'Test tag' }],
      skeptic: [{ id: 'empiricist', label: 'Empiricist', soul_doc: 'skeptic.empiricist', description: 'Test tag' }],
    },
  };
}

// Temp files written by the soul-override tests — cleaned up in afterAll.
const tmpFiles: string[] = [];

function writeTmpSoulFile(doc: unknown): string {
  const filePath = path.join(os.tmpdir(), `test-soul-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(filePath, JSON.stringify(doc), 'utf-8');
  tmpFiles.push(filePath);
  return filePath;
}

afterAll(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch { /* best-effort cleanup */ }
  }
  // Clear the soul-doc cache so other tests start fresh.
  clearSoulDocCache();
});

// ── validateSeatTagsConfig ────────────────────────────────────────────────────

describe('validateSeatTagsConfig', () => {
  it('round-trips valid seatTags into a seat_tags record', () => {
    const seatTags: CLISeatTags = {
      accelerationist: { pov_tag: 'techno-optimist', tag_mode: 'scope' },
      skeptic: { pov_tag: 'empiricist', tag_mode: 'prioritize' },
    };
    const result = validateSeatTagsConfig(seatTags, testRegistry());

    expect(result.accelerationist).toEqual({ pov_tag: 'techno-optimist', tag_mode: 'scope' });
    expect(result.skeptic).toEqual({ pov_tag: 'empiricist', tag_mode: 'prioritize' });
    // Safetyist not in input → not in result
    expect(result.safetyist).toBeUndefined();
  });

  it('rejects an unknown tag name with ActionableError', () => {
    const seatTags: CLISeatTags = {
      accelerationist: { pov_tag: 'no-such-tag', tag_mode: 'scope' },
    };
    expect(() => validateSeatTagsConfig(seatTags, testRegistry())).toThrow(ActionableError);

    try {
      validateSeatTagsConfig(seatTags, testRegistry());
    } catch (err) {
      expect(err).toBeInstanceOf(ActionableError);
      const ae = err as ActionableError;
      expect(ae.goal).toMatch(/accelerationist/);
      expect(ae.problem).toMatch(/no-such-tag/);
    }
  });

  it('returns an empty record when seatTags is empty', () => {
    const result = validateSeatTagsConfig({}, testRegistry());
    expect(result).toEqual({});
  });
});

// ── loadSoulOverrides ─────────────────────────────────────────────────────────

describe('loadSoulOverrides', () => {
  it('loads a valid soul file and provenance differs from the default base soul', () => {
    const doc = minimalSoulDoc('accelerationist');
    const filePath = writeTmpSoulFile(doc);
    const soulOverrides: CLISoulOverrides = { accelerationist: filePath };

    // Load the default soul for comparison.
    clearSoulDocCache();
    const { soulProvenance: defaultProvenance } = resolvePoverInfo('accelerationist');

    const overrides = loadSoulOverrides(soulOverrides, repoRoot);
    expect(overrides.accelerationist).toBeDefined();

    const { soul, soulProvenance } = overrides.accelerationist!;
    // Soul is present and typed correctly.
    expect(soul).toBeDefined();
    expect(soul.label).toBeTruthy();

    // Provenance is set and differs from the default (different file, different content).
    expect(soulProvenance).toBeDefined();
    expect(soulProvenance.hash).toMatch(/^fnv1a64:/);
    const comparison = compareSoulProvenance(soulProvenance, defaultProvenance);
    expect(comparison).toBe('different');
  });

  it('fails with ActionableError when the soul file does not exist', () => {
    const soulOverrides: CLISoulOverrides = { safetyist: '/nonexistent/path/to/soul.json' };
    expect(() => loadSoulOverrides(soulOverrides, repoRoot)).toThrow(ActionableError);

    try {
      loadSoulOverrides(soulOverrides, repoRoot);
    } catch (err) {
      expect(err).toBeInstanceOf(ActionableError);
      const ae = err as ActionableError;
      expect(ae.goal).toMatch(/safetyist/);
    }
  });

  it('fails with ActionableError when the soul file has an invalid schema', () => {
    // Missing required fields — omit voice, boundaries, etc.
    const badDoc = { pov: 'skeptic', label: 'Bad soul' };
    const filePath = writeTmpSoulFile(badDoc);
    const soulOverrides: CLISoulOverrides = { skeptic: filePath };

    expect(() => loadSoulOverrides(soulOverrides, repoRoot)).toThrow(ActionableError);

    try {
      loadSoulOverrides(soulOverrides, repoRoot);
    } catch (err) {
      expect(err).toBeInstanceOf(ActionableError);
      const ae = err as ActionableError;
      expect(ae.goal).toMatch(/skeptic/); // speaker in goal
      expect(ae.problem).toMatch(/Schema validation failed/i);
    }
  });

  it('resolves a relative path against the provided repoRoot', () => {
    const doc = minimalSoulDoc('safetyist');
    // Write to a temp file then reference it relative to its directory.
    const filePath = writeTmpSoulFile(doc);
    const dir = path.dirname(filePath);
    const basename = path.basename(filePath);
    // We pass dir as the "repoRoot" and the basename as the relative path.
    const soulOverrides: CLISoulOverrides = { safetyist: basename };
    const overrides = loadSoulOverrides(soulOverrides, dir);
    expect(overrides.safetyist).toBeDefined();
  });
});

// ── buildSoulOverrideResolver ─────────────────────────────────────────────────

describe('buildSoulOverrideResolver', () => {
  it('returns the override soul for an overridden seat', () => {
    const doc = minimalSoulDoc('accelerationist');
    const filePath = writeTmpSoulFile(doc);
    const overrides = loadSoulOverrides({ accelerationist: filePath }, repoRoot);
    const resolver = buildSoulOverrideResolver(overrides);

    const { soul, soulProvenance } = resolver('accelerationist');
    expect(soul).toBeDefined();
    expect(soulProvenance).toBeDefined();
    expect(soulProvenance!.hash).toMatch(/^fnv1a64:/);
  });

  it('falls through to the base resolver for non-overridden seats', () => {
    const doc = minimalSoulDoc('accelerationist');
    const filePath = writeTmpSoulFile(doc);
    const overrides = loadSoulOverrides({ accelerationist: filePath }, repoRoot);

    let baseCalled = false;
    const fakeBase = (speaker: Parameters<typeof resolvePoverInfo>[0], tagSelection?: Parameters<typeof resolvePoverInfo>[1]) => {
      baseCalled = true;
      return resolvePoverInfo(speaker, tagSelection);
    };
    const resolver = buildSoulOverrideResolver(overrides, fakeBase);

    // accelerationist has an override — base should NOT be called
    resolver('accelerationist');
    expect(baseCalled).toBe(false);

    // safetyist has no override — base SHOULD be called
    resolver('safetyist');
    expect(baseCalled).toBe(true);
  });
});
