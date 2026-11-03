// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment jsdom

// t/2486 prevention gate: every backend/model id in the source-of-truth ai-models.json must be
// covered by the renderer accessor chain (backendForModel maps it to its declared backend; the
// stored-backend allowlist accepts it). This is what would have caught the moonshot half-integration
// that let chat run on an unknown model. Wired into `npm run verify:config`.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { backendForModel, isKnownBackend, getStoredModel } from '../settingsSlice';
import { DEFAULT_MODEL } from '@lib/ai-client/defaults';

const here = dirname(fileURLToPath(import.meta.url));
// __tests__ → slices → useTaxonomyStore → hooks → renderer → src → taxonomy-editor → repo root
const aiModels = JSON.parse(
  readFileSync(resolve(here, '../../../../../../../ai-models.json'), 'utf8'),
) as { backends: { id: string }[]; models: { id: string; backend: string }[]; defaults?: Record<string, string> };

describe('renderer registry completeness (t/2486 prevention gate)', () => {
  it('has a non-empty registry to check (guards against a false-green empty read)', () => {
    expect(aiModels.models.length).toBeGreaterThan(0);
    expect(aiModels.backends.length).toBeGreaterThan(0);
  });

  it('CLEAN ARM: every ai-models.json model maps through backendForModel to its declared backend', () => {
    const failures: string[] = [];
    for (const m of aiModels.models) {
      const b = backendForModel(m.id);
      if (b !== m.backend) failures.push(`${m.id}: backendForModel → ${String(b)}, expected '${m.backend}'`);
      if (!isKnownBackend(m.backend)) failures.push(`${m.id}: backend '${m.backend}' not in renderer allowlist`);
    }
    expect(failures, `renderer accessor chain does not cover:\n${failures.join('\n')}`).toEqual([]);
  });

  it('every ai-models.json backend id is accepted by the renderer stored-backend allowlist', () => {
    for (const b of aiModels.backends) {
      expect(isKnownBackend(b.id), `backend '${b.id}' must be a known renderer backend`).toBe(true);
    }
  });

  it('BROKEN ARM: a model whose prefix is not handled fails the completeness check', () => {
    const fake = { id: 'fakebackend-x9', backend: 'fakebackend' };
    expect(backendForModel(fake.id)).toBeUndefined();
    expect(isKnownBackend(fake.backend)).toBe(false);
    // The same clean-arm assertion applied to an uncovered entry must fail — proving the gate bites.
    expect(() => {
      const b = backendForModel(fake.id);
      if (b !== fake.backend) throw new Error('uncovered model id');
    }).toThrow();
  });

  // t/2687: DEFAULT_MODEL and every defaults.* must be a REGISTERED model id. An unregistered
  // default silently fails at generation — resolveModel sends the raw id to the provider, which
  // rejects it (this is exactly how DEFAULT_MODEL='gemini-flash-lite-latest' broke op-ed create).
  const registeredIds = new Set(aiModels.models.map(m => m.id));

  it('CLEAN ARM: DEFAULT_MODEL is a registered model id (t/2687)', () => {
    expect(
      registeredIds.has(DEFAULT_MODEL),
      `DEFAULT_MODEL '${DEFAULT_MODEL}' is not in ai-models.json models[].id`,
    ).toBe(true);
  });

  it('CLEAN ARM: every ai-models.json defaults.* value is a registered model id (t/2687)', () => {
    const failures: string[] = [];
    for (const [backend, id] of Object.entries(aiModels.defaults ?? {})) {
      if (!registeredIds.has(id)) failures.push(`defaults.${backend} = '${id}' is not a registered model id`);
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('BROKEN ARM: an unregistered default id is caught (t/2687)', () => {
    // The pre-fix value must read as unregistered — proving the membership check bites.
    expect(registeredIds.has('gemini-flash-lite-latest')).toBe(false);
  });
});

describe('backendForModel / getStoredModel regressions (t/2486)', () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* jsdom teardown */ } });

  it('maps moonshot models to the moonshot backend (was the bug: fell through to gemini)', () => {
    expect(backendForModel('moonshot-kimi-k3.1-pro')).toBe('moonshot');
  });

  it('returns undefined for a truly unknown model id — never a silent gemini', () => {
    expect(backendForModel('totally-unknown-model')).toBeUndefined();
  });

  it('getStoredModel does NOT pass through a stale/unknown stored id — falls back to a valid default', () => {
    localStorage.setItem('taxonomy-editor-gemini-model', 'some-removed-stale-model');
    const m = getStoredModel();
    expect(m).not.toBe('some-removed-stale-model');
    expect(typeof m).toBe('string');
    expect(m.length).toBeGreaterThan(0);
  });

  it('getStoredModel returns a stored id that IS in the registry unchanged', () => {
    localStorage.setItem('taxonomy-editor-gemini-model', 'moonshot-kimi-k3.1-pro');
    expect(getStoredModel()).toBe('moonshot-kimi-k3.1-pro');
  });
});
