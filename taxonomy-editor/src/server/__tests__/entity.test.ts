// @vitest-environment node
//
// t/1786 — GET /api/entity/:ref resolver + the merged_into tombstone helper.
// Drives the route handler through a captured Router with a minimal req/res so the
// real httpKit json()/error() path is exercised, against mocked fileIO / org reads.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const { readPolicyRegistryMock, readTaxonomyFileMock, loadDictionaryMock, readEntityRegistryMock, getEntityRegistryStatusMock, getOrganizationByIdMock, recordMock, loadSourcesIndexMock } =
  vi.hoisted(() => ({
    readPolicyRegistryMock: vi.fn(),
    readTaxonomyFileMock: vi.fn(),
    loadDictionaryMock: vi.fn(),
    readEntityRegistryMock: vi.fn(),
    // t/4584/t/4586: defaults to "not degraded" so every pre-existing test
    // (which never set up this mock) keeps its original 200 [] behavior.
    getEntityRegistryStatusMock: vi.fn(() => ({ degraded: false, reason: null })),
    getOrganizationByIdMock: vi.fn(),
    recordMock: vi.fn(),
    loadSourcesIndexMock: vi.fn(),
  }));

vi.mock('../storage/fileIO.js', () => ({
  readPolicyRegistry: readPolicyRegistryMock,
  readTaxonomyFile: readTaxonomyFileMock,
  loadDictionary: loadDictionaryMock,
  readEntityRegistry: readEntityRegistryMock,
  getEntityRegistryStatus: getEntityRegistryStatusMock,
}));
vi.mock('../organizations.js', () => ({ getOrganizationById: getOrganizationByIdMock }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: recordMock }) }));
// t/4527: loadSourcesIndex is the only new dependency resolveEntityRegistryRef pulls in.
vi.mock('../storage/sourcesIndexReader.js', () => ({ loadSourcesIndex: loadSourcesIndexMock }));

import type { Entity } from '../../../../lib/entities/types.js';
import type { ServerCtx } from '../routes/context.js';
import { createRouter, type Handler } from '../httpKit.js';
import { registerEntityRoutes } from '../routes/entity.js';
// t/1974: resolveMergedInto now lives in the shared lib (server + electron import it);
// test the canonical copy directly.
import { resolveMergedInto } from '../../../../lib/entities/entityResolve.js';

// ── route harness ──
async function invoke(rawRef: string): Promise<{ status: number; body: unknown }> {
  const routes: { method: string; path: string; handler: Handler }[] = [];
  registerEntityRoutes(createRouter(routes), {} as ServerCtx);
  const route = routes.find(r => r.path === '/api/entity/:ref');
  if (!route) throw new Error('entity route not registered');

  const req = { url: `/api/entity/${encodeURIComponent(rawRef)}`, method: 'GET', headers: {} } as unknown as IncomingMessage;
  let status = 200;
  let body: unknown;
  const res = {
    writableEnded: false,
    headersSent: false,
    req,
    writeHead(s: number) { status = s; this.headersSent = true; },
    end(b?: string) { body = b ? JSON.parse(b) : undefined; this.writableEnded = true; },
  } as unknown as ServerResponse;

  await route.handler(req, res, undefined);
  return { status, body };
}

describe('GET /api/entity/:ref (t/1786)', () => {
  beforeEach(() => {
    readPolicyRegistryMock.mockReset();
    readTaxonomyFileMock.mockReset();
    loadDictionaryMock.mockReset();
    readEntityRegistryMock.mockReset();
    getOrganizationByIdMock.mockReset();
    recordMock.mockReset();
    loadSourcesIndexMock.mockReset();

    getOrganizationByIdMock.mockImplementation(async (id: string) =>
      id === 'org-001' ? { id: 'org-001', name: 'Electronic Frontier Foundation' } : null);
    readPolicyRegistryMock.mockResolvedValue({ policies: [{ id: 'pol-001', action: 'Fund reskilling.' }] });
    readTaxonomyFileMock.mockImplementation(async (pov: string) => {
      if (pov === 'accelerationist') return { nodes: [{ id: 'acc-desires-001', label: 'Accelerate' }] };
      if (pov === 'situations') return { nodes: [{ id: 'sit-001', label: 'Job displacement' }] };
      return { nodes: [] };
    });
    loadDictionaryMock.mockResolvedValue({
      standardized: [],
      lintViolations: [],
      colloquial: [{ colloquial_term: 'labor displacement', status: 'do_not_use_bare' }],
    });
    // Default: entities.json absent (null) → ent-* resolves to not_found. Tests that
    // exercise a populated registry override this with a Map (t/1829 / t/1807).
    readEntityRegistryMock.mockResolvedValue(null);
  });

  it('resolves an organization ref (200, kind=organization)', async () => {
    const { status, body } = await invoke('org-001');
    expect(status).toBe(200);
    expect(body).toMatchObject({ kind: 'organization', ref: { kind: 'organization', id: 'org-001' }, record: { id: 'org-001' } });
  });

  it('resolves a policy ref by id (200, kind=policy)', async () => {
    const { status, body } = await invoke('pol-001');
    expect(status).toBe(200);
    expect(body).toMatchObject({ kind: 'policy', record: { id: 'pol-001' } });
  });

  it('resolves a POV node via its prefix (acc → accelerationist file)', async () => {
    const { status, body } = await invoke('acc-desires-001');
    expect(status).toBe(200);
    expect(readTaxonomyFileMock).toHaveBeenCalledWith('accelerationist');
    expect(body).toMatchObject({ kind: 'node', record: { id: 'acc-desires-001' } });
  });

  it('resolves a situation ref from the situations file', async () => {
    const { status, body } = await invoke('sit-001');
    expect(status).toBe(200);
    expect(readTaxonomyFileMock).toHaveBeenCalledWith('situations');
    expect(body).toMatchObject({ kind: 'situation', record: { id: 'sit-001' } });
  });

  it('resolves a term ref by slugifying colloquial_term (labor-displacement)', async () => {
    const { status, body } = await invoke('term:labor-displacement');
    expect(status).toBe(200);
    expect(body).toMatchObject({ kind: 'term', record: { colloquial_term: 'labor displacement' } });
  });

  it('returns not_found (no record) for an ambiguous term slug', async () => {
    // Two colloquial terms slugify onto the same slug → refusal, not a guess.
    loadDictionaryMock.mockResolvedValue({
      standardized: [], lintViolations: [],
      colloquial: [{ colloquial_term: 'foo bar' }, { colloquial_term: 'foo-bar' }],
    });
    const { status, body } = await invoke('term:foo-bar');
    expect(status).toBe(200);
    expect(body).toEqual({ kind: 'not_found', ref: { kind: 'term', id: 'term:foo-bar' } });
    expect(body).not.toHaveProperty('record');
  });

  it('returns not_found for ent-* when the registry is absent (null store)', async () => {
    // Server Storage returns null when entities.json is unpopulated (t/1807) — the
    // not_found semantic is held stable until the store lands.
    readEntityRegistryMock.mockResolvedValue(null);
    const { status, body } = await invoke('ent-001');
    expect(status).toBe(200);
    expect(body).toEqual({ kind: 'not_found', ref: { kind: 'entity', id: 'ent-001' } });
    expect(body).not.toHaveProperty('record');
  });

  it('resolves an ent-* ref to its Entity record (200, kind=entity)', async () => {
    readEntityRegistryMock.mockResolvedValue(new Map([
      ['ent-001', { id: 'ent-001', name: 'OpenAI' } as unknown as Entity],
    ]));
    const { status, body } = await invoke('ent-001');
    expect(status).toBe(200);
    expect(body).toMatchObject({ kind: 'entity', ref: { kind: 'entity', id: 'ent-001' }, record: { id: 'ent-001', name: 'OpenAI' } });
    expect(body).not.toHaveProperty('redirected_from');
  });

  it('normalizes polymorphic aliases on the entity record: null → [], bare string → [string] (t/1964)', async () => {
    // ent-034 "Claude" (the t/1898 mention target) has aliases: null; a bare-string alias
    // ("GDPR") also occurs. The detail/mention flow reads .some/.length/[0] → must be arrays.
    readEntityRegistryMock.mockResolvedValue(new Map([
      ['ent-034', { id: 'ent-034', name: 'Claude', aliases: null } as unknown as Entity],
      ['ent-071', { id: 'ent-071', name: 'GDPR', aliases: 'GDPR' } as unknown as Entity],
    ]));
    const nullCase = await invoke('ent-034');
    expect(nullCase.status).toBe(200);
    expect((nullCase.body as { record: Entity }).record.aliases).toEqual([]);
    const stringCase = await invoke('ent-071');
    expect(stringCase.status).toBe(200);
    expect((stringCase.body as { record: Entity }).record.aliases).toEqual(['GDPR']);
  });

  it('normalizes polymorphic source_refs on the entity record: null → [], bare string → [string] (t/1964#3)', async () => {
    // source_refs is array | bare string in the store; EntityDetail does `.length > 0 && .map`
    // → a bare string passes .length then crashes on .map. Coerce at the read boundary.
    readEntityRegistryMock.mockResolvedValue(new Map([
      ['ent-040', { id: 'ent-040', name: 'IBM-HashiCorp', source_refs: 'doc-1' } as unknown as Entity],
      ['ent-050', { id: 'ent-050', name: 'NoRefs', source_refs: null } as unknown as Entity],
    ]));
    const stringCase = await invoke('ent-040');
    expect(stringCase.status).toBe(200);
    expect((stringCase.body as { record: Entity }).record.source_refs).toEqual(['doc-1']);
    const nullCase = await invoke('ent-050');
    expect(nullCase.status).toBe(200);
    expect((nullCase.body as { record: Entity }).record.source_refs).toEqual([]);
  });

  // ── t/4527: fold source_refs through duplicate_of before returning ──

  it('a source_ref marked duplicate_of resolves to its canonical target', async () => {
    readEntityRegistryMock.mockResolvedValue(new Map([
      ['ent-060', { id: 'ent-060', name: 'Dup refs', source_refs: ['doc-copy'] } as unknown as Entity],
    ]));
    loadSourcesIndexMock.mockResolvedValue({
      schema_version: 1, source_commit: 'abc', doc_count: 2,
      docs: [
        { id: 'doc-copy', duplicate_of: 'doc-canonical' },
        { id: 'doc-canonical' },
      ],
    });
    const { status, body } = await invoke('ent-060');
    expect(status).toBe(200);
    expect((body as { record: Entity }).record.source_refs).toEqual(['doc-canonical']);
  });

  it('an invalid duplicate_of mark (self/missing-target/chain) is left as-is', async () => {
    readEntityRegistryMock.mockResolvedValue(new Map([
      ['ent-061', { id: 'ent-061', name: 'Invalid marks', source_refs: ['doc-self', 'doc-missing', 'doc-chain-a'] } as unknown as Entity],
    ]));
    loadSourcesIndexMock.mockResolvedValue({
      schema_version: 1, source_commit: 'abc', doc_count: 3,
      docs: [
        { id: 'doc-self', duplicate_of: 'doc-self' }, // self: invalid
        // 'doc-missing' marks a target absent from the index entirely — missing_target: invalid.
        { id: 'doc-chain-a', duplicate_of: 'doc-chain-b' },
        { id: 'doc-chain-b', duplicate_of: 'doc-chain-c' }, // one-hop only — chain: invalid
        { id: 'doc-chain-c' },
      ],
    });
    const { status, body } = await invoke('ent-061');
    expect(status).toBe(200);
    expect((body as { record: Entity }).record.source_refs).toEqual(['doc-self', 'doc-missing', 'doc-chain-a']);
  });

  it('a canonical doc and its copy in the same list collapse to one entry', async () => {
    readEntityRegistryMock.mockResolvedValue(new Map([
      ['ent-062', { id: 'ent-062', name: 'Sibling collapse', source_refs: ['doc-canonical', 'doc-copy'] } as unknown as Entity],
    ]));
    loadSourcesIndexMock.mockResolvedValue({
      schema_version: 1, source_commit: 'abc', doc_count: 2,
      docs: [
        { id: 'doc-canonical' },
        { id: 'doc-copy', duplicate_of: 'doc-canonical' },
      ],
    });
    const { status, body } = await invoke('ent-062');
    expect(status).toBe(200);
    expect((body as { record: Entity }).record.source_refs).toEqual(['doc-canonical']);
  });

  it('a target outside the entity\'s own ref list still resolves (not misclassified as missing_target)', async () => {
    readEntityRegistryMock.mockResolvedValue(new Map([
      ['ent-063', { id: 'ent-063', name: 'Target not cited by this entity', source_refs: ['doc-copy'] } as unknown as Entity],
    ]));
    // 'doc-canonical' is a real corpus doc but never appears in ent-063's own source_refs —
    // the lookup must still find it (t/4357's pitfall).
    loadSourcesIndexMock.mockResolvedValue({
      schema_version: 1, source_commit: 'abc', doc_count: 2,
      docs: [
        { id: 'doc-copy', duplicate_of: 'doc-canonical' },
        { id: 'doc-canonical' },
      ],
    });
    const { body } = await invoke('ent-063');
    expect((body as { record: Entity }).record.source_refs).toEqual(['doc-canonical']);
  });

  it('degrades safely when sources-index.json is unavailable: source_refs unchanged, no throw', async () => {
    readEntityRegistryMock.mockResolvedValue(new Map([
      ['ent-064', { id: 'ent-064', name: 'No index', source_refs: ['doc-copy'] } as unknown as Entity],
    ]));
    loadSourcesIndexMock.mockResolvedValue(null);
    const { status, body } = await invoke('ent-064');
    expect(status).toBe(200);
    expect((body as { record: Entity }).record.source_refs).toEqual(['doc-copy']);
  });

  it('follows a merged_into tombstone to the canonical Entity + stamps redirected_from', async () => {
    readEntityRegistryMock.mockResolvedValue(new Map([
      ['ent-001', { id: 'ent-001', merged_into: 'ent-002' } as unknown as Entity],
      ['ent-002', { id: 'ent-002', name: 'Canonical' } as unknown as Entity],
    ]));
    const { status, body } = await invoke('ent-001');
    expect(status).toBe(200);
    expect(body).toMatchObject({ kind: 'entity', record: { id: 'ent-002', name: 'Canonical' }, redirected_from: 'ent-001' });
  });

  it('returns 400 for a malformed / unrecognized ref', async () => {
    const { status, body } = await invoke('not-a-real-ref');
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: expect.stringContaining('not-a-real-ref') });
  });

  it('returns 200 not_found (no record) for a well-formed but unresolved ref', async () => {
    const { status, body } = await invoke('org-999');
    expect(status).toBe(200);
    expect(body).toEqual({ kind: 'not_found', ref: { kind: 'organization', id: 'org-999' } });
    expect(body).not.toHaveProperty('record');
  });

  it('records to the flight recorder and returns 500 when a read throws', async () => {
    readPolicyRegistryMock.mockRejectedValue(new Error('blob unreachable'));
    const { status } = await invoke('pol-001');
    expect(status).toBe(500);
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ level: 'error', type: 'system.error' }));
  });
});

// ── list-route harness (GET /api/entities, t/1883) ──
async function invokeList(): Promise<{ status: number; body: unknown }> {
  const routes: { method: string; path: string; handler: Handler }[] = [];
  registerEntityRoutes(createRouter(routes), {} as ServerCtx);
  const route = routes.find(r => r.path === '/api/entities');
  if (!route) throw new Error('entities list route not registered');

  const req = { url: '/api/entities', method: 'GET', headers: {} } as unknown as IncomingMessage;
  let status = 200;
  let body: unknown;
  const res = {
    writableEnded: false,
    headersSent: false,
    req,
    writeHead(s: number) { status = s; this.headersSent = true; },
    end(b?: string) { body = b ? JSON.parse(b) : undefined; this.writableEnded = true; },
  } as unknown as ServerResponse;

  await route.handler(req, res, undefined);
  return { status, body };
}

describe('GET /api/entities (t/1883)', () => {
  beforeEach(() => {
    readEntityRegistryMock.mockReset();
    recordMock.mockReset();
    getEntityRegistryStatusMock.mockReset().mockReturnValue({ degraded: false, reason: null });
  });

  it('returns summary rows from a populated registry — exactly the 7 summary keys, no Entity leak', async () => {
    // Fuller Entity records (extra fields dolce_category/description/created_at/etc.)
    // must NOT appear in the summary rows — the handler picks 7 fields explicitly.
    readEntityRegistryMock.mockResolvedValue(new Map([
      ['ent-001', {
        id: 'ent-001', name: 'OpenAI', aliases: ['OAI'], entity_type: 'institution',
        dolce_category: 'agentive-physical-object', description: 'A company that...',
        status: 'approved', confidence: 0.9, created_at: '2026-01-01', last_modified: '2026-02-02',
        source_refs: ['doc-1'], discovered_by: { model: 'x' },
      } as unknown as Entity],
    ]));
    const { status, body } = await invokeList();
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    const rows = body as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['aliases', 'confidence', 'entity_type', 'id', 'last_modified', 'name', 'status'],
    );
    expect(rows[0]).toEqual({
      id: 'ent-001', name: 'OpenAI', aliases: ['OAI'], entity_type: 'institution',
      status: 'approved', confidence: 0.9, last_modified: '2026-02-02',
    });
  });

  it('coerces polymorphic aliases at the summary boundary: null → [], bare string → [string] (t/1964)', async () => {
    // entities.json stores aliases as array | null | bare string. EntityBrowserPanel reads
    // `e.aliases.some(...)`/`e.aliases[0]` off the SUMMARY row → null crashes, a bare string
    // renders its first char. The list endpoint must hand back a real array either way.
    readEntityRegistryMock.mockResolvedValue(new Map([
      ['ent-034', { id: 'ent-034', name: 'Claude', aliases: null, entity_type: 'artifact', status: 'approved', last_modified: '2026-02-02' } as unknown as Entity],
      ['ent-071', { id: 'ent-071', name: 'GDPR', aliases: 'GDPR', entity_type: 'legislation', status: 'approved', last_modified: '2026-02-02' } as unknown as Entity],
    ]));
    const { status, body } = await invokeList();
    expect(status).toBe(200);
    const rows = body as Record<string, unknown>[];
    expect(rows.find(r => r.id === 'ent-034')!.aliases).toEqual([]);
    expect(rows.find(r => r.id === 'ent-071')!.aliases).toEqual(['GDPR']);
  });

  it('returns [] when the entity store is absent (readEntityRegistry → null, a clean/not-degraded absence)', async () => {
    readEntityRegistryMock.mockResolvedValue(null);
    const { status, body } = await invokeList();
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  // t/4584/t/4586 (incident): a null registry from a DEGRADED read (GitHub
  // rate-limit exhaustion, circuit-open, no creds) must return 503, never the
  // same 200 [] a genuine absence gets — that silent collapse was the
  // incident's actual symptom.
  it('returns 503 when the entity registry read is degraded, not a genuine absence', async () => {
    readEntityRegistryMock.mockResolvedValue(null);
    getEntityRegistryStatusMock.mockReturnValue({ degraded: true, reason: 'rate_limited' });
    const { status, body } = await invokeList();
    expect(status).toBe(503);
    expect(body).toMatchObject({ error: expect.stringContaining('rate_limited') });
  });

  it('returns [] for an empty registry', async () => {
    readEntityRegistryMock.mockResolvedValue(new Map());
    const { status, body } = await invokeList();
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('records to the flight recorder and returns 500 when the read throws', async () => {
    readEntityRegistryMock.mockRejectedValue(new Error('blob unreachable'));
    const { status } = await invokeList();
    expect(status).toBe(500);
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ level: 'error', type: 'system.error' }));
  });
});

describe('resolveMergedInto (merged_into tombstone chase, t/1786)', () => {
  const ent = (id: string, mergedInto?: string): Entity =>
    ({ id, merged_into: mergedInto } as unknown as Entity);

  it('follows a 2-hop chain to the terminal record, stamping redirectedFrom', () => {
    const map = new Map<string, Entity>([
      ['ent-001', ent('ent-001', 'ent-002')],
      ['ent-002', ent('ent-002', 'ent-003')],
      ['ent-003', ent('ent-003')],
    ]);
    const res = resolveMergedInto('ent-001', id => map.get(id) ?? null, { maxDepth: 16 });
    expect(res).toEqual({ record: map.get('ent-003'), redirectedFrom: 'ent-001' });
  });

  it('returns the record with no redirectedFrom when it is already canonical', () => {
    const map = new Map<string, Entity>([['ent-003', ent('ent-003')]]);
    const res = resolveMergedInto('ent-003', id => map.get(id) ?? null, { maxDepth: 16 });
    expect(res).toEqual({ record: map.get('ent-003'), redirectedFrom: undefined });
  });

  it('returns null when a hop points at a missing id', () => {
    const map = new Map<string, Entity>([['ent-001', ent('ent-001', 'ent-gone')]]);
    expect(resolveMergedInto('ent-001', id => map.get(id) ?? null, { maxDepth: 16 })).toBeNull();
  });

  it('throws ActionableError on a merged_into cycle', () => {
    const map = new Map<string, Entity>([
      ['ent-A', ent('ent-A', 'ent-B')],
      ['ent-B', ent('ent-B', 'ent-A')],
    ]);
    expect(() => resolveMergedInto('ent-A', id => map.get(id) ?? null, { maxDepth: 16 })).toThrow(/cycle/i);
  });

  it('throws ActionableError when the chain exceeds maxDepth', () => {
    const map = new Map<string, Entity>([
      ['ent-001', ent('ent-001', 'ent-002')],
      ['ent-002', ent('ent-002', 'ent-003')],
      ['ent-003', ent('ent-003')],
    ]);
    expect(() => resolveMergedInto('ent-001', id => map.get(id) ?? null, { maxDepth: 1 })).toThrow(/depth cap/i);
  });
});
