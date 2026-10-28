// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment jsdom

// t/3280 Phase 2b: the renderer model picker (MODELS_BY_BACKEND) is DERIVED from ai-models.json's
// per-model `picker:{label,order}` field — the single source of truth — not maintained by hand.
// These gates prove the derive is faithful and lock the SSOT invariant:
//   1. PARITY — deriveModelsByBackend(ai-models.json) matches MODELS_BY_BACKEND. (t/3517: MODELS_BY_BACKEND
//      is now ITSELF `deriveModelsByBackend(<the bundled JSON import>)`, not a hand-copied literal, so this
//      no longer catches a hand-copy drifting — that failure mode is gone by construction. It still guards
//      the two loading paths (settingsSlice's static import vs this test's readFileSync) agreeing, i.e. a
//      caught regression if the import path/mechanism ever diverges from the on-disk file.)
//   2. DEFAULT_MODEL is present as a selectable picker entry (the global default must be pickable).
//   3. (t/3286) The graceful-empty invariant — a ZERO-picker backend derives to [], is filtered from the
//      selector, and getStoredModel never yields a non-model id — held against a SYNTHETIC subject (since
//      t/3286 restored deepseek's picker, no real backend is empty; the invariant is nonetheless permanent).
//      Plus a general real-config no-strand guard: every OFFERED backend has ≥1 picker entry.
//   4. (t/3329) AI_BACKENDS is SSOT-derived — deriveBackends(config) byte-identical to the pre-load list.
//   5. (t/3328) derive keyspace = config.backends ∪ known backend keys — a config-only backend still surfaces.
// Wired into `npm run verify:config`.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
import {
  deriveModelsByBackend,
  deriveBackends,
  resolveStoredModel,
  MODELS_BY_BACKEND,
  AI_BACKENDS,
  getStoredModel,
  type AIBackend,
  type AIModel,
} from '../settingsSlice';
import { DEFAULT_MODEL } from '@lib/ai-client/defaults';

const here = dirname(fileURLToPath(import.meta.url));
// __tests__ → slices → useTaxonomyStore → hooks → renderer → src → taxonomy-editor → repo root
const aiModels = JSON.parse(
  readFileSync(resolve(here, '../../../../../../../ai-models.json'), 'utf8'),
) as {
  backends: { id: string; label: string }[];
  models: { id: string; label: string; backend: string; picker?: { label: string; order: number } }[];
  defaults: Record<string, string>;
};

// t/3286: synthetic config for the permanent graceful-empty invariant — a fabricated zero-picker
// backend ('emptybackend': has a model, but NONE carry `picker`) alongside a normal one. Keeps the
// empty-backend coverage decoupled from whichever real backend happens to be curated-out.
const ZERO_PICKER_CONFIG = {
  backends: [
    { id: 'gemini', label: 'Google Gemini' },
    { id: 'emptybackend', label: 'Empty Backend' },
  ],
  models: [
    { id: 'gemini-3.1-pro-preview', label: 'x', backend: 'gemini', picker: { label: 'x', order: 10 } },
    { id: 'emptybackend-hidden', label: 'Hidden', backend: 'emptybackend' },
  ],
  defaults: {},
};

describe('deriveModelsByBackend (t/3280 SSOT derive)', () => {
  const derived = deriveModelsByBackend(aiModels);

  it('has a non-empty picker to derive from (guards against a false-green empty read)', () => {
    const withPicker = aiModels.models.filter(m => m.picker);
    expect(withPicker.length).toBeGreaterThan(0);
  });

  it('PARITY: derived picker is byte-identical to the curated MODELS_BY_BACKEND', () => {
    // Deep-equal per backend for a legible diff on failure, then the whole object.
    for (const backend of Object.keys(MODELS_BY_BACKEND) as AIBackend[]) {
      expect(derived[backend], `backend '${backend}' derive != curated`).toEqual(MODELS_BY_BACKEND[backend]);
    }
    expect(derived).toEqual(MODELS_BY_BACKEND);
  });

  it('every derived entry has a real ai-models.json model id (no phantoms)', () => {
    const configIds = new Set(aiModels.models.map(m => m.id));
    const phantoms: string[] = [];
    for (const entries of Object.values(derived)) {
      for (const e of entries) if (!configIds.has(e.value)) phantoms.push(e.value);
    }
    expect(phantoms, `derived picker entries with no config model:\n${phantoms.join('\n')}`).toEqual([]);
  });

  it('entries within a backend are sorted by picker.order', () => {
    for (const backend of Object.keys(derived) as AIBackend[]) {
      const orders = derived[backend].map(
        e => aiModels.models.find(m => m.id === e.value)?.picker?.order ?? Number.NaN,
      );
      const sorted = [...orders].sort((a, b) => a - b);
      expect(orders, `backend '${backend}' not order-sorted`).toEqual(sorted);
    }
  });

  it('DEFAULT_MODEL is a selectable picker entry (the global default must be pickable)', () => {
    const allValues = new Set(Object.values(derived).flat().map(e => e.value));
    expect(allValues.has(DEFAULT_MODEL), `DEFAULT_MODEL '${DEFAULT_MODEL}' absent from the derived picker`).toBe(true);
  });

  it('a zero-picker backend derives to [] without crashing (synthetic subject, t/3286)', () => {
    // Post-t/3286 no real backend is empty (deepseek restored); the graceful-empty invariant is
    // permanent, so exercise it on a synthetic config with a fabricated zero-picker backend.
    const d = deriveModelsByBackend(ZERO_PICKER_CONFIG as never);
    expect(d['emptybackend' as AIBackend]).toEqual([]);
  });

  it('GENERAL no-strand guard: every offered backend has ≥1 picker entry (t/3286)', () => {
    // Durable real-config invariant (TL t/3286#3) — strictly stronger than a deepseek-specific ===[]:
    // any backend surfaced in the selector must have at least one selectable model or the dropdown
    // strands. Covers ALL current + future offered backends, not one hard-coded subject.
    for (const b of AI_BACKENDS) {
      expect(MODELS_BY_BACKEND[b.value].length, `offered backend '${b.value}' has no picker models`).toBeGreaterThan(0);
    }
  });

  it('BACKEND PARITY (t/3329): deriveBackends(config) is byte-identical to pre-load AI_BACKENDS', () => {
    // AI_BACKENDS is now SSOT-derived (membership + order + label from config.backends); the in-source
    // constant is only a pre-load fallback. Full ordered deep-equal (not just set equality) so pre-load
    // and post-load never disagree on order or label.
    expect(deriveBackends(aiModels)).toEqual(AI_BACKENDS);
  });

  it('deriveBackends excludes a zero-picker backend (synthetic subject, t/3286)', () => {
    // deepseek is now offered (t/3286 restored its picker); prove the exclusion mechanism on a
    // synthetic zero-picker backend, while a sibling WITH picker models in the same config IS offered.
    const b = deriveBackends(ZERO_PICKER_CONFIG as never);
    expect(b.some(x => x.value === 'emptybackend')).toBe(false);
    expect(b.some(x => x.value === 'gemini')).toBe(true);
  });

  it('deepseek is now an offered backend with its restored v4 picker (t/3286; t/4613: flash model renamed to v4.1-flash)', () => {
    // Positive assertion that the restore actually took effect (guards against a silent re-emptying).
    expect(derived.deepseek).toEqual([
      { value: 'deepseek-deepseek-v4.1-flash', label: 'V4.1 Flash (default)' },
      { value: 'deepseek-deepseek-v4-pro', label: 'V4 Pro (reasoning)' },
    ]);
    expect(deriveBackends(aiModels).some(b => b.value === 'deepseek')).toBe(true);
  });

  it('getStoredModel never returns a non-model id (guard property)', () => {
    // The guard rejects a stored/default id that is not a real model and falls back to DEFAULT_MODEL.
    // getStoredModel reads module singletons (ALL_MODEL_IDS/DEFAULT_MODELS), so the empty-backend →
    // DEFAULT_MODEL leg is covered by the pure-fn derive/exclude tests above; here we prove the
    // "never a non-model id" property directly across clean + poisoned localStorage.
    // NOTE (t/3286): the stored-backend key is 'taxonomy-editor-ai-backend' — the #1971 test used
    // 'taxonomy-editor-backend' (wrong key), so getStoredBackend never saw it and the test was vacuous.
    const allValues = new Set(Object.values(MODELS_BY_BACKEND).flat().map(e => e.value));
    localStorage.clear();
    // (a) clean storage → a real model (the global default).
    expect(allValues.has(getStoredModel())).toBe(true);
    // (b) a bogus stored model id is rejected → still a real model, never the bogus id.
    localStorage.setItem('taxonomy-editor-gemini-model', 'not-a-real-model-xyz');
    const m = getStoredModel();
    expect(m).not.toBe('not-a-real-model-xyz');
    expect(allValues.has(m)).toBe(true);
    localStorage.clear();
  });

  it('every config backend with ≥1 picker model has a non-empty derived entry (keyspace coverage)', () => {
    const withPicker = new Set(aiModels.models.filter(m => m.picker).map(m => m.backend));
    for (const backend of withPicker) {
      expect(derived[backend as AIBackend]?.length ?? 0, `config backend '${backend}' has picker models but derived empty`).toBeGreaterThan(0);
    }
  });
});

describe('t/3328: derive keyspace = config.backends ∪ constant keys', () => {
  // A backend added to ai-models.json (with picker models) but ABSENT from the in-source
  // MODELS_BY_BACKEND keys must still surface — the former constant-only keyspace silently dropped it.
  const synthConfig = {
    backends: [
      { id: 'gemini', label: 'Google Gemini' },
      { id: 'newbackend', label: 'New Backend' },
    ],
    models: [
      { id: 'newbackend-model-a', label: 'Model A', backend: 'newbackend', picker: { label: 'Model A', order: 10 } },
      { id: 'newbackend-model-b', label: 'Model B', backend: 'newbackend', picker: { label: 'Model B', order: 20 } },
      // A curated-out model (no picker) on the new backend must NOT appear.
      { id: 'newbackend-hidden', label: 'Hidden', backend: 'newbackend' },
    ],
    defaults: {},
  };

  it('surfaces picker models for a backend not present in the constant keyspace', () => {
    const d = deriveModelsByBackend(synthConfig as never);
    expect(d['newbackend' as AIBackend]).toEqual([
      { value: 'newbackend-model-a', label: 'Model A' },
      { value: 'newbackend-model-b', label: 'Model B' },
    ]);
  });

  it('deriveBackends includes the new config-only backend (membership follows config)', () => {
    const b = deriveBackends(synthConfig as never);
    expect(b).toContainEqual({ value: 'newbackend', label: 'New Backend' });
  });
});

describe('resolveStoredModel — graceful-empty guard, both arms (t/3286, TL t/3286#11)', () => {
  // Pure extraction of getStoredModel's resolution, so BOTH branches of the empty-backend guard are
  // exercised directly — including the FALSE branch (backend default is not a real model → globalDefault)
  // that the real-config integration test can't reach (it lands on a valid default).
  const ALL = new Set<string>(['real-model', 'other-model', 'global-default']);
  const GLOBAL = 'global-default' as AIModel;
  const DEFAULTS = { good: 'real-model', empty: 'not-a-model' } as unknown as Record<AIBackend, AIModel>;

  it('ARM (a): a valid backend default is returned as-is', () => {
    expect(resolveStoredModel(null, 'good' as AIBackend, DEFAULTS, ALL, GLOBAL)).toBe('real-model');
  });

  it('ARM (b): a NON-model backend default falls back to the global default (no strand)', () => {
    // The empty/misconfigured-backend leg: DEFAULT_MODELS[backend] is not a real id → globalDefault.
    expect(resolveStoredModel(null, 'empty' as AIBackend, DEFAULTS, ALL, GLOBAL)).toBe('global-default');
  });

  it('a valid stored id wins over the backend default', () => {
    expect(resolveStoredModel('other-model', 'good' as AIBackend, DEFAULTS, ALL, GLOBAL)).toBe('other-model');
  });

  it('a bogus stored id is rejected, then the backend default resolves', () => {
    expect(resolveStoredModel('bogus-id', 'good' as AIBackend, DEFAULTS, ALL, GLOBAL)).toBe('real-model');
  });
});

// t/3517: the `AIModel` union is the one piece of the registry that genuinely cannot be
// derived at runtime (TS types are erased before this code ever executes) — a direct
// `typeof import('ai-models.json')` type derivation was tried and rejected because TS
// widens JSON-module string fields to `string`, silently deleting typo protection while
// LOOKING like it worked. generatedAIModelIds.ts is codegen'd instead (scripts/
// generate-ai-model-union.cjs) and committed — this is the staleness check that replaces
// the "new blocking CI gate" TL's alternative would have required a Second Opinion for
// (t/3517#2): it's one more assertion inside the already-blocking `vitest run` step, not a
// new required check. A person who edits ai-models.json and forgets to regenerate fails
// this test locally and in CI, same loudness as any other test failure.
describe('generatedAIModelIds.ts staleness (t/3517)', () => {
  it('the committed generated file matches what generate-ai-model-union.cjs produces right now', () => {
    const { generateAIModelUnionSource } = require('../../../../../../scripts/generate-ai-model-union.cjs') as {
      generateAIModelUnionSource: (config: unknown) => string;
    };
    const generatedPath = resolve(here, '../generatedAIModelIds.ts');
    const committed = readFileSync(generatedPath, 'utf8');
    const fresh = generateAIModelUnionSource(aiModels);
    expect(
      committed,
      'generatedAIModelIds.ts is stale — run: node scripts/generate-ai-model-union.cjs',
    ).toBe(fresh);
  });
});
