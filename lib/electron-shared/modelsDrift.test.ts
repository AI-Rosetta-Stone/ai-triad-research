// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4159 prevention (a): `npm run models:drift`. The real refreshAIModels runs against a temp ai-models.json and a
// stubbed fetch: catalog reads only, no paid probe, keys never printed, and the TL's exit-code contract
// (t/4159#10): WARN per skipped backend, non-zero when every backend was skipped, 1 on drift, 0 when clean.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runModelsDrift, assessDrift, envLoadApiKey, redactKeys } from './modelsDrift.js';
import type { RefreshResult } from './modelDiscovery.js';

const gm = (id: string) => ({ id, apiModelId: id, label: id, backend: 'gemini' });
// Groq registry ids are `groq-<api id>` (as discovery builds them).
const gq = (api: string) => ({ id: `groq-${api}`, apiModelId: api, label: api, backend: 'groq' });

/** A valid registry: a gemini default with a chain, two groq models (one unreferenced). */
function registry() {
  return {
    backends: [{ id: 'gemini', label: 'Gemini' }, { id: 'groq', label: 'Groq' }],
    models: [gm('gemini-3.1-pro'), gm('gemini-3.5-flash-lite'), gq('alpha-120b'), gq('beta-20b'), gq('gamma-8b')],
    defaults: { gemini: 'gemini-3.1-pro', groq: 'groq-alpha-120b' },
    debateTiers: {},
    fallbackChains: { 'gemini-3.1-pro': ['gemini-3.5-flash-lite'], 'gemini-3.5-flash-lite': ['gemini-3.1-pro'], 'groq-alpha-120b': ['groq-beta-20b'], 'groq-beta-20b': ['groq-alpha-120b'] },
    lastRefreshed: null,
  };
}

const GEMINI_KEY = 'gemini-secret-value-123';
const GROQ_KEY = 'groq-secret-value-4567';
const ANTHROPIC_KEY = 'anthropic-secret-value-89';
let repoRoot = '';
let original = '';
let geminiIds: string[] = [];
let groqIds: string[] = [];
let claudeCatalogStatus = 200;
const calls: string[] = [];

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('generativelanguage.googleapis.com')) {
      return new Response(JSON.stringify({ models: geminiIds.map(id => ({ name: `models/${id}`, displayName: id, supportedGenerationMethods: ['generateContent'] })) }), { status: 200 });
    }
    if (u.includes('api.groq.com')) return new Response(JSON.stringify({ data: groqIds.map(id => ({ id, owned_by: 'x', active: true })) }), { status: 200 });
    if (u.includes('api.anthropic.com/v1/models')) return new Response(`denied for key ${ANTHROPIC_KEY}`, { status: claudeCatalogStatus });
    throw new Error(`unexpected network call in test: ${u}`);
  }));
}

let out: string[] = [];
let warns: string[] = [];
const run = (env: Record<string, string | undefined>) =>
  runModelsDrift({ repoRoot, env, log: l => out.push(l), warn: l => warns.push(l) });

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'models-drift-'));
  original = JSON.stringify(registry(), null, 2) + '\n';
  fs.writeFileSync(path.join(repoRoot, 'ai-models.json'), original);
  geminiIds = ['gemini-3.1-pro', 'gemini-3.5-flash-lite'];
  groqIds = ['alpha-120b', 'beta-20b', 'gamma-8b'];
  claudeCatalogStatus = 200;
  calls.length = 0;
  out = []; warns = [];
  stubFetch();
});
afterEach(() => { vi.unstubAllGlobals(); fs.rmSync(repoRoot, { recursive: true, force: true }); });

describe('models:drift exit-code contract (TL t/4159#10)', () => {
  it('no keys at all: every backend skipped with a WARN, exit 2, no network call', async () => {
    expect(await run({})).toBe(2);
    expect(warns.map(w => /models:drift: (\w+) not checked/.exec(w)?.[1]).filter(Boolean).sort()).toEqual(['claude', 'deepseek', 'gemini', 'groq']);
    expect(warns.some(w => w.includes('no backend could be checked'))).toBe(true);
    expect(calls).toEqual([]);
  });

  it('catalogs match the registry: exit 0, skipped backends still WARN', async () => {
    expect(await run({ GEMINI_API_KEY: GEMINI_KEY, GROQ_API_KEY: GROQ_KEY })).toBe(0);
    expect(out.join('\n')).toContain('no drift (gemini, groq checked');
    expect(warns.some(w => w.includes('claude not checked'))).toBe(true);
    expect(warns.some(w => w.includes('deepseek not checked'))).toBe(true);
  });

  it('an unreferenced model the vendor dropped: drift, exit 1, the id named, the file untouched', async () => {
    groqIds = ['alpha-120b', 'beta-20b'];
    expect(await run({ GEMINI_API_KEY: GEMINI_KEY, GROQ_API_KEY: GROQ_KEY })).toBe(1);
    expect(out.join('\n')).toContain('the vendor no longer lists: groq-gamma-8b');
    expect(fs.readFileSync(path.join(repoRoot, 'ai-models.json'), 'utf-8')).toBe(original);
  });

  // t/4199: a refresh would drop these too, but the vendor still lists them, so they're info, not drift.
  const withExtra = (extra: object[]) => {
    const r = registry();
    r.models.push(...(extra as typeof r.models));
    fs.writeFileSync(path.join(repoRoot, 'ai-models.json'), JSON.stringify(r, null, 2) + '\n');
  };

  it('an unreferenced model superseded in its family (still listed): exit 0, reported as info', async () => {
    withExtra([gm('gemini-3.5-flash')]);
    geminiIds = [...geminiIds, 'gemini-3.5-flash', 'gemini-3.8-flash'];
    expect(await run({ GEMINI_API_KEY: GEMINI_KEY, GROQ_API_KEY: GROQ_KEY })).toBe(0);
    expect(out.join('\n')).toMatch(/info: a refresh would also curate away .*gemini-3\.5-flash/);
    expect(out.join('\n')).toContain('no drift');
  });

  it('a registered model discovery filters out by type (still listed): exit 0, reported as info', async () => {
    withExtra([gq('canopylabs/orpheus-v1-english')]);
    groqIds = [...groqIds, 'canopylabs/orpheus-v1-english'];
    expect(await run({ GEMINI_API_KEY: GEMINI_KEY, GROQ_API_KEY: GROQ_KEY })).toBe(0);
    expect(out.join('\n')).toMatch(/info: a refresh would also curate away .*orpheus/);
  });

  it('a dropped model behind a default and chains: drift reported from the refusal, file untouched', async () => {
    groqIds = ['beta-20b', 'gamma-8b'];
    expect(await run({ GEMINI_API_KEY: GEMINI_KEY, GROQ_API_KEY: GROQ_KEY })).toBe(1);
    expect(out.join('\n')).toMatch(/refresh refused \((needs-human|proposal-required|cross-family)\)/);
    expect(fs.readFileSync(path.join(repoRoot, 'ai-models.json'), 'utf-8')).toBe(original);
  });
});

describe('catalog-only: no spend, no keys in output', () => {
  it('a failed Claude catalog never falls back to the paid /v1/messages probe; claude is reported skipped', async () => {
    claudeCatalogStatus = 500;
    await run({ GEMINI_API_KEY: GEMINI_KEY, GROQ_API_KEY: GROQ_KEY, ANTHROPIC_API_KEY: ANTHROPIC_KEY });
    expect(calls.some(c => c.includes('/v1/models') && c.includes('anthropic'))).toBe(true);
    expect(calls.some(c => c.includes('/v1/messages'))).toBe(false);
    expect(warns.some(w => w.includes('claude not checked') && w.includes('catalog-only'))).toBe(true);
  });

  it('no key value appears in any output line, even when a provider error echoes it', async () => {
    claudeCatalogStatus = 500;
    groqIds = ['alpha-120b', 'beta-20b'];
    await run({ GEMINI_API_KEY: GEMINI_KEY, GROQ_API_KEY: GROQ_KEY, ANTHROPIC_API_KEY: ANTHROPIC_KEY });
    const all = [...out, ...warns].join('\n');
    for (const key of [GEMINI_KEY, GROQ_KEY, ANTHROPIC_KEY]) {
      expect(all).not.toContain(key);
      expect(all).not.toContain(key.slice(0, 8));
    }
  });

  it('redactKeys replaces every *_API_KEY value', () => {
    expect(redactKeys(`a ${GROQ_KEY} b`, { GROQ_API_KEY: GROQ_KEY })).toBe('a *** b');
  });
});

describe('key resolution matches the app', () => {
  it('own variable first; AI_API_KEY only for gemini', () => {
    expect(envLoadApiKey('groq', { GROQ_API_KEY: 'g' })).toBe('g');
    expect(envLoadApiKey('gemini', { AI_API_KEY: 'fallback' })).toBe('fallback');
    expect(envLoadApiKey('groq', {})).toBeNull();
    expect(() => envLoadApiKey('groq', { AI_API_KEY: 'fallback' })).toThrow(/gemini backend only/);
  });
});

describe('assessDrift', () => {
  const ok = { ok: true, count: 1 };
  const base = { gemini: ok, claude: ok, groq: ok, openai: { ok: false, count: 0 }, deepseek: ok, ollama: { ok: false, count: 0 }, totalModels: 1, written: false } as RefreshResult;
  it('clean: no drift, nothing skipped', () => {
    expect(assessDrift({ ...base, proposal: { catalogFingerprint: 'f', hash: 'h', changes: [] }, removedModels: [] })).toEqual({ skipped: [], allSkipped: false, drift: [], info: [] });
  });
  it('pinned candidates are info, not drift', () => {
    const r = assessDrift({ ...base, pinnedCandidates: [{ slots: ['defaults.gemini'], pinned: 'x', newerInFamily: 'y' }] });
    expect(r.drift).toEqual([]);
    expect(r.info).toEqual(['newer model in a pinned family: y (pinned x)']);
  });
});
