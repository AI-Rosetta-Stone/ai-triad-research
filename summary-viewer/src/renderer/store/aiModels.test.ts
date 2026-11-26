// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/785: gemini-2.5-flash shuts down Dec 1, 2026. A saved model the registry no longer lists must fall
// back to the default with a WARN, never reach the API. Runs the real initAIModels -> getStoredModel path
// against ai-models.json with the 2.5 entries removed (what t/781 / #5605 ships).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => null }));

interface Registry { backends: { id: string; label: string }[]; models: { id: string; label: string; backend: string }[]; defaults: Record<string, string> }

const registryPath = path.resolve(__dirname, '../../../../ai-models.json');
const realRegistry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as Registry;
const RETIRED = new Set(['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']);
const postShutdownRegistry: Registry = { ...realRegistry, models: realRegistry.models.filter(m => !RETIRED.has(m.id)) };

let storage: Map<string, string>;
let warnSpy: ReturnType<typeof vi.spyOn>;

async function loadModule(saved: { backend?: string; model?: string }, registry: Registry | null = postShutdownRegistry) {
  storage = new Map();
  if (saved.backend) storage.set('summaryviewer-ai-backend', saved.backend);
  if (saved.model) storage.set('summaryviewer-ai-model', saved.model);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => { storage.set(k, v); },
  });
  vi.stubGlobal('window', { electronAPI: { loadAIModels: async () => registry } });
  vi.resetModules();
  const mod = await import('./aiModels');
  await mod.initAIModels();
  return mod;
}

const warned = (id: string) => warnSpy.mock.calls.some((args: unknown[]) => String(args[0]).includes('WARN') && String(args[0]).includes(id));

beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('t/785 saved model validated against ai-models.json', () => {
  it('a saved gemini-2.5-flash falls back to the registry default with a WARN', async () => {
    const mod = await loadModule({ backend: 'gemini', model: 'gemini-2.5-flash' });
    expect(mod.getStoredModel()).toBe(realRegistry.defaults.gemini);
    expect(warned('gemini-2.5-flash'), 'no WARN for the retired saved model').toBe(true);
  });

  it('an unknown saved id is not silently used', async () => {
    const mod = await loadModule({ backend: 'gemini', model: 'made-up-model-x' });
    expect(mod.getStoredModel()).not.toBe('made-up-model-x');
    expect(warned('made-up-model-x')).toBe(true);
  });

  it('a saved id the registry lists is used as-is, with no WARN', async () => {
    const mod = await loadModule({ backend: 'gemini', model: 'gemini-3.5-flash' });
    expect(mod.getStoredModel()).toBe('gemini-3.5-flash');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns once per session per retired id, and keeps the saved choice', async () => {
    const mod = await loadModule({ backend: 'gemini', model: 'gemini-2.5-flash' });
    mod.getStoredModel();
    mod.getStoredModel();
    expect(warnSpy.mock.calls.filter((a: unknown[]) => String(a[0]).includes('gemini-2.5-flash'))).toHaveLength(1);
    expect(storage.get('summaryviewer-ai-model')).toBe('gemini-2.5-flash');
  });

  it('with no registry, the built-ins validate and no longer name gemini-2.5-flash', async () => {
    const mod = await loadModule({ backend: 'gemini', model: 'gemini-2.5-flash' }, null);
    expect(mod.DEFAULT_MODELS.gemini).toBe('gemini-3.5-flash-lite');
    expect(mod.MODELS_BY_BACKEND.gemini.map(e => e.value)).not.toContain('gemini-2.5-flash');
    expect(mod.getStoredModel()).toBe('gemini-3.5-flash-lite');
    expect(warned('gemini-2.5-flash')).toBe(true);
  });

  it('every built-in picker id and default is a model ai-models.json lists (t/781)', async () => {
    vi.resetModules();
    const mod = await import('./aiModels');
    const ids = new Set(realRegistry.models.map(m => m.id));
    const builtIns = [...Object.values(mod.MODELS_BY_BACKEND).flatMap(e => e.map(x => x.value)), ...Object.values(mod.DEFAULT_MODELS)];
    expect(builtIns.filter(id => !ids.has(id))).toEqual([]);
    expect(builtIns).not.toContain('claude-sonnet-4-5');
  });

  it('resolveStoredModel falls to the global default when the backend default is unknown', async () => {
    const mod = await loadModule({});
    const ids = new Set(['g']);
    expect(mod.resolveStoredModel('x', 'claude', { gemini: 'g', claude: 'c', groq: 'q', openai: 'o' }, ids, 'g')).toBe('g');
  });
});
