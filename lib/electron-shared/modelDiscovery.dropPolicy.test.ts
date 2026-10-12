// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3553: the replace-mode drop policy end to end, through the real refreshAIModels against a stubbed vendor
// catalog and an in-memory ai-models.json. One describe per design condition (t/3553#6).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let fileContent = '';
let writes = 0;
vi.mock('fs', () => ({
  default: {
    readFileSync: () => fileContent,
    writeFileSync: (_path: string, data: string) => { fileContent = data; writes++; },
  },
}));

import { refreshAIModels, type RefreshResult } from './modelDiscovery.js';
import { FlightRecorder } from '../flight-recorder/flightRecorder.js';
import { setGlobalRecorder, clearGlobalRecorder } from '../flight-recorder/index.js';

const gm = (id: string) => ({ id, apiModelId: id, label: id, backend: 'gemini' });

/** A valid registry: a pinned pro default with a chain, a pinned flash-lite tier, and an unpinned older pro. */
function baseConfig() {
  return {
    backends: [{ id: 'gemini', label: 'Gemini' }, { id: 'zai', label: 'Z.AI' }],
    models: [gm('gemini-3.1-pro'), gm('gemini-3.5-flash-lite'), gm('gemini-2.5-pro'),
      { id: 'zai-glm', apiModelId: 'glm', label: 'GLM', backend: 'zai' }],
    defaults: { gemini: 'gemini-3.1-pro', zai: 'zai-glm' },
    debateTiers: { _comment: 'basic = cheap', basic: { gemini: 'gemini-3.5-flash-lite' } },
    fallbackChains: {
      'gemini-3.1-pro': ['gemini-3.5-flash-lite'],
      'zai-glm': ['gemini-3.1-pro'],
      'gemini-3.5-flash-lite': ['gemini-3.1-pro'],
    },
    lastRefreshed: null,
  };
}

let geminiCatalog: string[] = [];
// No code-referenced pins by default, so each describe below tests only its own rule. The code-literal describe
// at the end injects a list, and its last test pins the production default, the bundled JSON.
const deps = { loadApiKey: (b: string) => (b === 'gemini' ? 'test-key' : null), repoRoot: '/fake', codeReferencedIds: [] as string[] };
const saved = () => JSON.parse(fileContent);

function stubFetch(extra?: (url: string, init?: RequestInit) => Response | undefined) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const hit = extra?.(String(url), init);
    if (hit) return hit;
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return new Response(JSON.stringify({
        models: geminiCatalog.map((id) => ({ name: `models/${id}`, displayName: id, supportedGenerationMethods: ['generateContent'] })),
      }), { status: 200 });
    }
    throw new Error(`no network in test: ${url}`);
  }));
}

let recorder: FlightRecorder;
beforeEach(() => {
  fileContent = JSON.stringify(baseConfig());
  writes = 0;
  stubFetch();
  recorder = new FlightRecorder({ capacity: 256 });
  setGlobalRecorder(recorder);
});
afterEach(() => { vi.unstubAllGlobals(); clearGlobalRecorder(); });

describe('SO 1: pinned ids are exempt from family curation; TL e/263#3 pinned-candidate report', () => {
  it('a newer model in a pinned default\'s family: no refusal, both kept, the unpinned older one drops', async () => {
    geminiCatalog = ['gemini-3.1-pro', 'gemini-3.6-pro', 'gemini-3.5-flash-lite', 'gemini-2.5-pro'];
    const r = await refreshAIModels(deps);
    expect(r.refusal).toBeUndefined();
    expect(r.written).toBe(true);
    const ids = saved().models.filter((m: { backend: string }) => m.backend === 'gemini').map((m: { id: string }) => m.id);
    expect(ids.sort()).toEqual(['gemini-3.1-pro', 'gemini-3.5-flash-lite', 'gemini-3.6-pro']);
    expect(saved().defaults.gemini).toBe('gemini-3.1-pro');
    expect(r.pinnedCandidates).toEqual([{
      slots: ['defaults.gemini', 'fallbackChains[zai-glm]', 'fallbackChains[gemini-3.5-flash-lite]'],
      pinned: 'gemini-3.1-pro', newerInFamily: 'gemini-3.6-pro',
    }]);
    expect(r.proposal?.changes).toEqual([]);
  });
});

describe('CL e/263#5: a pinned-candidate report on a debate-tier pin writes nothing to the slot and starts no epoch', () => {
  it('a newer flash-lite beside the pinned basic tier: tier unchanged, no sign-off, no epoch event', async () => {
    geminiCatalog = ['gemini-3.1-pro', 'gemini-3.5-flash-lite', 'gemini-3.9-flash-lite', 'gemini-2.5-pro'];
    const r = await refreshAIModels(deps);
    expect(r.refusal).toBeUndefined();
    expect(r.pinnedCandidates).toContainEqual({ slots: ['debateTiers.basic.gemini', 'fallbackChains[gemini-3.1-pro]'], pinned: 'gemini-3.5-flash-lite', newerInFamily: 'gemini-3.9-flash-lite' });
    expect(saved().debateTiers.basic.gemini).toBe('gemini-3.5-flash-lite');
    expect(r.proposal!.changes).toEqual([]);
    expect(r.signoff).toBeUndefined();
    expect(recorder.buffer.drain().some((e) => String(e.message).includes('calibration epoch'))).toBe(false);
  });
});

describe('refuse and propose; accept the exact proposal (CL p/742#3 sign-off)', () => {
  beforeEach(() => { geminiCatalog = ['gemini-3.6-pro', 'gemini-3.5-flash-lite', 'gemini-2.5-pro']; });

  it('the vendor dropping a pinned default refuses with a proposal; nothing is written', async () => {
    const original = fileContent;
    const r = await refreshAIModels(deps);
    expect(r.written).toBe(false);
    expect(r.refusal?.reason).toBe('proposal-required');
    expect(r.proposal!.changes.map((c) => c.slot)).toEqual([
      'defaults.gemini', 'fallbackChains[zai-glm]', 'fallbackChains[gemini-3.5-flash-lite]', 'fallbackChains{gemini-3.1-pro→gemini-3.6-pro}',
    ]);
    expect(r.proposal!.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.proposal!.catalogFingerprint).toMatch(/^sha256:/);
    expect(fileContent).toBe(original);
    expect(writes).toBe(0);
  });

  it('accepting that exact proposal writes it, records who/why/hash/old→new, and flags a calibration epoch', async () => {
    const dry = await refreshAIModels(deps, { dryRun: true });
    const r = await refreshAIModels(deps, { accept: { principal: 'host:test', proposal: dry.proposal!, approvedBy: 'CL', reason: 'gemini-3.1-pro retired by vendor' } });
    expect(r.written).toBe(true);
    expect(saved().defaults.gemini).toBe('gemini-3.6-pro');
    expect(saved().fallbackChains['gemini-3.6-pro']).toEqual(['gemini-3.5-flash-lite']);
    expect(saved().fallbackChains['zai-glm']).toEqual(['gemini-3.6-pro']);
    expect(r.signoff).toMatchObject({ approvedBy: 'CL', reason: 'gemini-3.1-pro retired by vendor', proposalHash: dry.proposal!.hash, calibrationEpoch: true });
    expect(r.signoff!.slots).toContain('defaults.gemini: "gemini-3.1-pro" → "gemini-3.6-pro" (family gemini-pro, vendor-absent)');
    expect(Date.parse(r.signoff!.at)).not.toBeNaN(); // CL e/263#5: the accept record carries the date
    const info = recorder.buffer.drain().filter((e) => e.type === 'system.info' && e.component === 'model-discovery-refresh');
    expect(info).toHaveLength(1);
    expect(info[0].message).toContain('starts a calibration epoch');
  });

  it('a dry run never writes, even with nothing to propose', async () => {
    geminiCatalog = ['gemini-3.1-pro', 'gemini-3.5-flash-lite', 'gemini-2.5-pro'];
    const r = await refreshAIModels(deps, { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.written).toBe(false);
    expect(writes).toBe(0);
  });
});

describe('TL 2: an accept whose recomputed proposal differs is refused as proposal-changed, with a diff', () => {
  it('a newer pro ships between the dry run and the accept: refused, delta named, nothing written', async () => {
    geminiCatalog = ['gemini-3.6-pro', 'gemini-3.5-flash-lite', 'gemini-2.5-pro'];
    const dry = await refreshAIModels(deps, { dryRun: true });
    geminiCatalog = ['gemini-3.6-pro', 'gemini-3.7-pro', 'gemini-3.5-flash-lite', 'gemini-2.5-pro'];
    const r = await refreshAIModels(deps, { accept: { principal: 'host:test', proposal: dry.proposal!, approvedBy: 'CL', reason: 'r' } });
    expect(r.written).toBe(false);
    expect(r.refusal?.reason).toBe('proposal-changed');
    const refusal = r.refusal as Extract<RefreshResult['refusal'], { reason: 'proposal-changed' }>;
    expect(refusal.diff.changed.map((c) => c.slot)).toContain('defaults.gemini');
    expect(refusal.recomputed.catalogFingerprint).not.toBe(refusal.accepted.catalogFingerprint);
    expect(writes).toBe(0);
  });

  it('a tampered proposal (changes edited, hash kept) is refused the same way', async () => {
    geminiCatalog = ['gemini-3.6-pro', 'gemini-3.5-flash-lite', 'gemini-2.5-pro'];
    const dry = await refreshAIModels(deps, { dryRun: true });
    const tampered = { ...dry.proposal!, changes: dry.proposal!.changes.map((c) => c.slot === 'defaults.gemini' ? { ...c, to: 'gemini-2.5-pro' } : c) };
    const r = await refreshAIModels(deps, { accept: { principal: 'host:test', proposal: tampered, approvedBy: 'x', reason: 'y' } });
    expect(r.refusal?.reason).toBe('proposal-changed');
    expect(writes).toBe(0);
  });
});

describe('SO e/263#4: pinned candidates are never compared, so they can\'t fail an accept', () => {
  it('a newer flash-lite appears between the dry run and the accept: the accept still succeeds', async () => {
    geminiCatalog = ['gemini-3.6-pro', 'gemini-3.5-flash-lite', 'gemini-2.5-pro'];
    const dry = await refreshAIModels(deps, { dryRun: true });
    geminiCatalog = ['gemini-3.6-pro', 'gemini-3.5-flash-lite', 'gemini-3.9-flash-lite', 'gemini-2.5-pro'];
    const r = await refreshAIModels(deps, { accept: { principal: 'host:test', proposal: dry.proposal!, approvedBy: 'CL', reason: 'r' } });
    expect(r.written).toBe(true);
    expect(r.pinnedCandidates?.map((c) => c.newerInFamily)).toContain('gemini-3.9-flash-lite');
    expect(r.proposal!.changes.some((c) => JSON.stringify(c).includes('3.9'))).toBe(false);
  });
});

describe('TL 1: suspected-partial-catalog (never a proposal), measured before curation', () => {
  it('an empty catalog refuses with the counts and no proposal', async () => {
    geminiCatalog = [];
    const r = await refreshAIModels(deps);
    expect(r.refusal).toEqual({ reason: 'suspected-partial-catalog', backends: [{ backend: 'gemini', registered: 3, vendorListed: 0, wouldDrop: 3 }] });
    expect(r.proposal).toBeUndefined();
    expect(writes).toBe(0);
  });

  it('more than half of the registered models missing refuses', async () => {
    geminiCatalog = ['gemini-3.6-pro'];
    const r = await refreshAIModels(deps);
    expect(r.refusal?.reason).toBe('suspected-partial-catalog');
    expect(r.proposal).toBeUndefined();
  });

  it('curation alone never trips it: a healthy catalog with many newer models writes', async () => {
    geminiCatalog = ['gemini-3.1-pro', 'gemini-3.5-flash-lite', 'gemini-2.5-pro', 'gemini-3.2-pro', 'gemini-3.3-pro', 'gemini-3.4-pro', 'gemini-3.6-flash-lite'];
    const r = await refreshAIModels(deps);
    expect(r.refusal).toBeUndefined();
    expect(r.written).toBe(true);
  });
});

describe('TL 3: an accepted proposal still goes through validate-before-write', () => {
  it('an accept that would leave a default chain-less is refused as invalid', async () => {
    // gemini-3.6-pro is already registered with NO chain of its own; the old default's chain points only at it,
    // so the re-key leaves the new default with an empty chain.
    const cfg = baseConfig();
    cfg.models.push(gm('gemini-3.6-pro'));
    cfg.fallbackChains['gemini-3.1-pro'] = ['gemini-3.6-pro'];
    fileContent = JSON.stringify(cfg);
    geminiCatalog = ['gemini-3.6-pro', 'gemini-3.5-flash-lite', 'gemini-2.5-pro'];
    const dry = await refreshAIModels(deps, { dryRun: true });
    expect(dry.refusal?.reason).toBe('proposal-required');
    const r = await refreshAIModels(deps, { accept: { principal: 'host:test', proposal: dry.proposal!, approvedBy: 'CL', reason: 'r' } });
    expect(r.written).toBe(false);
    expect(r.refusal).toMatchObject({ reason: 'invalid', chainless: ['gemini default "gemini-3.6-pro" has no fallbackChain'] });
    expect(writes).toBe(0);
  });
});

describe('CL: a default or tier never changes family through refresh', () => {
  it('the pinned flash-lite tier dropped with only other families surviving: needs-human, no successor', async () => {
    geminiCatalog = ['gemini-3.1-pro', 'gemini-2.5-pro', 'gemini-3.8-flash'];
    const r = await refreshAIModels(deps);
    expect(r.refusal?.reason).toBe('needs-human');
    expect(r.proposal!.changes).toContainEqual({ slot: 'debateTiers.basic.gemini', from: 'gemini-3.5-flash-lite', to: null, family: 'gemini-flash-lite', reason: 'vendor-absent' });
    expect(writes).toBe(0);
  });
});

describe('SO 2: a probe-sourced backend is additive only', () => {
  it('the Claude catalog is down and the probe misses the pinned default: no drop, no proposal, WARN names the fallback', async () => {
    const cfg = baseConfig();
    cfg.models.push({ id: 'claude-sonnet-4-6', apiModelId: 'claude-sonnet-4-6', label: 'Sonnet 4.6', backend: 'claude' });
    cfg.defaults = { ...cfg.defaults, claude: 'claude-sonnet-4-6' } as typeof cfg.defaults;
    (cfg.fallbackChains as Record<string, string[]>)['claude-sonnet-4-6'] = ['gemini-3.1-pro'];
    fileContent = JSON.stringify(cfg);
    geminiCatalog = ['gemini-3.1-pro', 'gemini-3.5-flash-lite', 'gemini-2.5-pro'];
    stubFetch((url, init) => {
      if (url.endsWith('/v1/models')) return new Response('down', { status: 503 });
      if (url.endsWith('/v1/messages')) {
        const model = JSON.parse(String(init?.body)).model;
        return new Response('{}', { status: model === 'claude-opus-5' ? 200 : 404 });
      }
      return undefined;
    });
    const r = await refreshAIModels({ ...deps, loadApiKey: (b: string) => (b === 'gemini' || b === 'claude' ? 'test-key' : null) });
    expect(r.catalogSources?.claude).toBe('probe');
    expect(r.refusal).toBeUndefined();
    expect(r.written).toBe(true);
    const claudeIds = saved().models.filter((m: { backend: string }) => m.backend === 'claude').map((m: { id: string }) => m.id);
    expect(claudeIds).toEqual(['claude-sonnet-4-6', 'claude-opus-5']);
    expect(saved().defaults.claude).toBe('claude-sonnet-4-6');
    const warns = recorder.buffer.drain().filter((e) => e.level === 'warn' && String(e.message).includes('candidate probe'));
    expect(warns).toHaveLength(1);
  });
});

// TL checklist e/271#12, items 1, 2 and 9 (SO e/271). `gemini-2.5-pro` is in no default, tier or chain. Only the
// code-referenced list names it, and gemini-3.1-pro is a newer member of its family, so plain curation would drop it.
describe('e/271#12: models named in code are pinned (1, 9) and their vendor absence refuses (2)', () => {
  const codeDeps = { ...deps, codeReferencedIds: ['gemini-2.5-pro'] };

  it('item 9: a model named only in the code list is never dropped, and is reported under slot code-literal', async () => {
    geminiCatalog = ['gemini-3.1-pro', 'gemini-3.5-flash-lite', 'gemini-2.5-pro'];
    const r = await refreshAIModels(codeDeps);
    expect(r.refusal).toBeUndefined();
    expect(r.written).toBe(true);
    expect(saved().models.map((m: { id: string }) => m.id)).toContain('gemini-2.5-pro');
    expect(r.pinnedCandidates).toContainEqual({ slots: ['code-literal'], pinned: 'gemini-2.5-pro', newerInFamily: 'gemini-3.1-pro' });
  });

  it('item 9 (arm): without the code pin, the same catalog drops it', async () => {
    geminiCatalog = ['gemini-3.1-pro', 'gemini-3.5-flash-lite', 'gemini-2.5-pro'];
    await refreshAIModels(deps);
    expect(saved().models.map((m: { id: string }) => m.id)).not.toContain('gemini-2.5-pro');
  });

  it('item 2: the vendor no longer lists it, so the refresh refuses: no proposal, file unchanged, the id named', async () => {
    const original = fileContent;
    geminiCatalog = ['gemini-3.1-pro', 'gemini-3.5-flash-lite'];
    const r = await refreshAIModels(codeDeps);
    expect(r.refusal).toEqual({ reason: 'code-referenced-absent', absent: [{ id: 'gemini-2.5-pro', backend: 'gemini' }] });
    expect(r.proposal).toBeUndefined();
    expect(r.configWarning).toContain('gemini-2.5-pro');
    expect(fileContent).toBe(original);
    expect(writes).toBe(0);
  });

  it('item 2: an accept cannot get past it either', async () => {
    // A fourth registered model keeps the accept-time catalog under the "more than half missing" partial threshold.
    const cfg = baseConfig();
    cfg.models.push(gm('gemini-3.8-flash'));
    fileContent = JSON.stringify(cfg);
    geminiCatalog = ['gemini-3.6-pro', 'gemini-3.5-flash-lite', 'gemini-2.5-pro', 'gemini-3.8-flash'];
    const dry = await refreshAIModels(codeDeps, { dryRun: true });
    expect(dry.refusal?.reason).toBe('proposal-required');
    geminiCatalog = ['gemini-3.6-pro', 'gemini-3.5-flash-lite', 'gemini-3.8-flash'];
    const r = await refreshAIModels(codeDeps, { accept: { principal: 'host:test', proposal: dry.proposal!, approvedBy: 'CL', reason: 'r' } });
    expect(r.refusal?.reason).toBe('code-referenced-absent');
    expect(writes).toBe(0);
  });

  it('item 2: a mass absence still reads as suspected-partial-catalog, not code-referenced-absent', async () => {
    geminiCatalog = [];
    const r = await refreshAIModels(codeDeps);
    expect(r.refusal?.reason).toBe('suspected-partial-catalog');
  });

  it('a probe-sourced backend drops nothing, so a code-referenced id missing from the probe does not refuse', async () => {
    const cfg = baseConfig();
    cfg.models.push({ id: 'claude-sonnet-4-5', apiModelId: 'claude-sonnet-4-5', label: 'Sonnet 4.5', backend: 'claude' });
    fileContent = JSON.stringify(cfg);
    geminiCatalog = ['gemini-3.1-pro', 'gemini-3.5-flash-lite', 'gemini-2.5-pro'];
    stubFetch((url, init) => {
      if (url.endsWith('/v1/models')) return new Response('down', { status: 503 });
      if (url.endsWith('/v1/messages')) return new Response('{}', { status: JSON.parse(String(init?.body)).model === 'claude-opus-5' ? 200 : 404 });
      return undefined;
    });
    const r = await refreshAIModels({ ...deps, codeReferencedIds: ['claude-sonnet-4-5'], loadApiKey: (b: string) => (b === 'gemini' || b === 'claude' ? 'test-key' : null) });
    expect(r.catalogSources?.claude).toBe('probe');
    expect(r.refusal).toBeUndefined();
    expect(saved().models.map((m: { id: string }) => m.id)).toContain('claude-sonnet-4-5');
  });

  it('item 1: production pins the bundled codeReferencedModels.json when deps give no list', async () => {
    // gemini-3.5-flash-lite is in the real list (scripts and lib name it). With no injected list, its absence refuses.
    const { default: real } = await import('../ai-config/codeReferencedModels.json', { with: { type: 'json' } });
    expect(real.ids).toContain('gemini-3.5-flash-lite');
    geminiCatalog = ['gemini-3.1-pro', 'gemini-2.5-pro', 'gemini-3.6-flash-lite'];
    const { codeReferencedIds: _omit, ...prodDeps } = deps;
    const r = await refreshAIModels(prodDeps);
    expect(r.refusal).toMatchObject({ reason: 'code-referenced-absent' });
    const refusal = r.refusal as Extract<RefreshResult['refusal'], { reason: 'code-referenced-absent' }>;
    expect(refusal.absent.map((a) => a.id)).toContain('gemini-3.5-flash-lite');
  });

  it('TL #2984 review: a successful accept says verify:config must pass before the commit', async () => {
    geminiCatalog = ['gemini-3.6-pro', 'gemini-3.5-flash-lite', 'gemini-2.5-pro'];
    const dry = await refreshAIModels(deps, { dryRun: true });
    const r = await refreshAIModels(deps, { accept: { principal: 'host:test', proposal: dry.proposal!, approvedBy: 'CL', reason: 'r' } });
    expect(r.written).toBe(true);
    expect(r.configWarning).toContain('`npm run verify:config` must pass before you commit it');
  });
});
