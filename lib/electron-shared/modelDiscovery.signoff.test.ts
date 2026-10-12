// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4160 (TL t/4031#2, adjustments 1 and 3): an accepted refresh proposal is recorded durably, in ai-models.json
// `signoffs`, in the same write as the change, under a host-set principal; the accept is checked by proposal hash
// (TL decision on t/4160: hash only, both fingerprints recorded). Same harness as modelDiscovery.dropPolicy.test.ts:
// the real refreshAIModels against a stubbed Gemini catalog and an in-memory ai-models.json.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let fileContent = '';
let writes = 0;
vi.mock('fs', () => ({
  default: {
    readFileSync: () => fileContent,
    writeFileSync: (_path: string, data: string) => { fileContent = data; writes++; },
  },
}));

import { refreshAIModels, type RefreshAccept, type SignoffRecord } from './modelDiscovery.js';
import { proposalHash } from './refreshPolicy.js';

const gm = (id: string) => ({ id, apiModelId: id, label: id, backend: 'gemini' });

/** A pinned pro default with a chain, a pinned flash-lite tier, an unpinned older pro (as in the drop-policy suite). */
function baseConfig(extra: Record<string, unknown> = {}) {
  return {
    backends: [{ id: 'gemini', label: 'Gemini' }, { id: 'zai', label: 'Z.AI' }],
    models: [gm('gemini-3.1-pro'), gm('gemini-3.5-flash-lite'), gm('gemini-2.5-pro'),
      { id: 'zai-glm', apiModelId: 'glm', label: 'GLM', backend: 'zai' }],
    defaults: { gemini: 'gemini-3.1-pro', zai: 'zai-glm' },
    debateTiers: { basic: { gemini: 'gemini-3.5-flash-lite' } },
    fallbackChains: {
      'gemini-3.1-pro': ['gemini-3.5-flash-lite'],
      'zai-glm': ['gemini-3.1-pro'],
      'gemini-3.5-flash-lite': ['gemini-3.1-pro'],
    },
    lastRefreshed: null,
    ...extra,
  };
}

let geminiCatalog: string[] = [];
const fetchMock = vi.fn(async (url: string) => {
  if (String(url).includes('generativelanguage.googleapis.com')) {
    return new Response(JSON.stringify({
      models: geminiCatalog.map((id) => ({ name: `models/${id}`, displayName: id, supportedGenerationMethods: ['generateContent'] })),
    }), { status: 200 });
  }
  throw new Error(`no network in test: ${url}`);
});
const deps = { loadApiKey: (b: string) => (b === 'gemini' ? 'test-key' : null), repoRoot: '/fake', codeReferencedIds: [] as string[] };
const onDisk = () => JSON.parse(fileContent);
/** The vendor retired the pinned pro default; a newer pro replaces it (a proposal-required refresh). */
const RETIRED = ['gemini-3.6-pro', 'gemini-3.5-flash-lite', 'gemini-2.5-pro'];

async function proposalFor(catalog: string[]) {
  geminiCatalog = catalog;
  const dry = await refreshAIModels(deps, { dryRun: true });
  return dry.proposal!;
}
const accept = (over: Partial<RefreshAccept> & Pick<RefreshAccept, 'proposal'>): RefreshAccept =>
  ({ principal: 'user:ada@example.org', approvedBy: 'Ada', osUser: 'ada', reason: 'gemini-3.1-pro retired by vendor', ...over });

beforeEach(() => {
  fileContent = JSON.stringify(baseConfig());
  writes = 0;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('t/4160: a successful accept persists its sign-off in the same write', () => {
  it('records principal, typed name, OS user, reason, hash, both fingerprints, time and epoch, read back from disk', async () => {
    const proposal = await proposalFor(RETIRED);
    writes = 0;
    const r = await refreshAIModels(deps, { accept: accept({ proposal }) });
    expect(r.written).toBe(true);
    expect(writes).toBe(1); // one write carries both the change and its record
    const saved = onDisk();
    expect(saved.defaults.gemini).toBe('gemini-3.6-pro');
    expect(saved.signoffs).toHaveLength(1);
    const rec = saved.signoffs[0] as SignoffRecord;
    expect(rec).toMatchObject({
      principal: 'user:ada@example.org', approvedBy: 'Ada', osUser: 'ada', reason: 'gemini-3.1-pro retired by vendor',
      proposalHash: proposal.hash, catalogFingerprint: proposal.catalogFingerprint, reviewedCatalogFingerprint: proposal.catalogFingerprint,
      calibrationEpoch: true,
    });
    expect(rec.at).toBe(saved.lastRefreshed);
    expect(rec.slots).toContain('defaults.gemini: "gemini-3.1-pro" → "gemini-3.6-pro" (family gemini-pro, vendor-absent)');
    expect(r.signoff).toEqual(rec);
  });

  it('appends to existing sign-offs, and a later plain refresh keeps them', async () => {
    const earlier = { principal: 'user:old', approvedBy: 'Old', reason: 'earlier', proposalHash: 'sha256:old', catalogFingerprint: 'sha256:c', reviewedCatalogFingerprint: 'sha256:c', at: '2026-01-01T00:00:00.000Z', slots: [], calibrationEpoch: false };
    fileContent = JSON.stringify(baseConfig({ signoffs: [earlier] }));
    const proposal = await proposalFor(RETIRED);
    await refreshAIModels(deps, { accept: accept({ proposal }) });
    expect(onDisk().signoffs.map((s: SignoffRecord) => s.principal)).toEqual(['user:old', 'user:ada@example.org']);

    // Nothing left to propose now: a plain refresh writes, and the audit trail survives it.
    const plain = await refreshAIModels(deps);
    expect(plain.written).toBe(true);
    expect(plain.signoff).toBeUndefined();
    expect(onDisk().signoffs).toHaveLength(2);
  });

  it('omits osUser when the host gives none (the server path)', async () => {
    const proposal = await proposalFor(RETIRED);
    const { osUser: _drop, ...noOs } = accept({ proposal });
    await refreshAIModels(deps, { accept: noOs });
    expect(Object.keys(onDisk().signoffs[0])).not.toContain('osUser');
  });
});

describe('t/4160: an accept needs a host-set principal', () => {
  it.each([['empty', ''], ['whitespace', '   '], ['missing', undefined]])('%s principal: refused as no-principal, before any vendor call, nothing written', async (_n, principal) => {
    const proposal = await proposalFor(RETIRED);
    const original = fileContent;
    writes = 0;
    fetchMock.mockClear();
    const r = await refreshAIModels(deps, { accept: { ...accept({ proposal }), principal: principal as string } });
    expect(r.written).toBe(false);
    expect(r.refusal).toEqual({ reason: 'no-principal' });
    expect(r.configWarning).toContain('principal');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writes).toBe(0);
    expect(fileContent).toBe(original);
  });
});

describe('TL t/4031#2 adj. 1, as decided on t/4160: the accept is checked by proposal hash', () => {
  it('a hand-edited `to` with a hash recomputed to match the edit is still refused: the lib re-derives the proposal', async () => {
    const proposal = await proposalFor(RETIRED);
    const changes = proposal.changes.map((c) => (c.slot === 'defaults.gemini' ? { ...c, to: 'gemini-2.5-pro' } : c));
    const forged = { ...proposal, changes, hash: proposalHash(changes) }; // self-consistent, but not what the catalog proposes
    writes = 0;
    const r = await refreshAIModels(deps, { accept: accept({ proposal: forged }) });
    expect(r.refusal?.reason).toBe('proposal-changed');
    expect(writes).toBe(0);
    expect(onDisk().signoffs).toBeUndefined();
  });

  it('an unrelated catalog change after review still accepts (SO e/263#4), and the record shows both fingerprints', async () => {
    const proposal = await proposalFor(RETIRED);
    geminiCatalog = [...RETIRED, 'gemini-3.9-flash-lite']; // a newer model in an unrelated family appears
    const r = await refreshAIModels(deps, { accept: accept({ proposal }) });
    expect(r.written).toBe(true);
    const rec = onDisk().signoffs[0] as SignoffRecord;
    expect(rec.reviewedCatalogFingerprint).toBe(proposal.catalogFingerprint);
    expect(rec.catalogFingerprint).not.toBe(proposal.catalogFingerprint);
    expect(rec.catalogFingerprint).toBe(r.proposal!.catalogFingerprint);
  });
});
