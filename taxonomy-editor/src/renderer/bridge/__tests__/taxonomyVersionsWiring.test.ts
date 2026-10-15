// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4187 (TL GV of #3266): the web bridge's taxonomy methods must go through the version cell. Drives the real
// `api` from web-bridge.ts with only the network mocked, so it fails if saveTaxonomyFile reverts to a plain put
// (no If-Match, so every save is a 428 in production) or loadTaxonomyFileForEdit points at the plain load
// (the cell is never set, same result). taxonomyVersions.test.ts covers the cell's logic; this covers the wiring.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockResilientFetch = vi.fn<(path: string, init: RequestInit, opts: unknown) => Promise<Response>>();

vi.mock('../resilience', () => ({
  resilientFetch: (...args: unknown[]) => mockResilientFetch(args[0] as string, args[1] as RequestInit, args[2]),
  categorizeEndpoint: () => 'data',
  registerConnectionPoolProvider: vi.fn(),
  getResilienceState: vi.fn(),
  subscribeResilience: vi.fn(),
  resetResilience: vi.fn(),
}));

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('../instrumentBridge', () => ({ instrumentBridge: (raw: unknown) => raw }));
vi.mock('../../utils/keyShareCrypto', () => ({ encryptKeysForSharing: vi.fn(), decryptKeysFromSharing: vi.fn() }));
vi.mock('../../hooks/useQuotaWarning', () => ({ onQuotaMilestone: vi.fn() }));

const { api } = await import('../web-bridge');

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A server that versions the file: ETag on GET and on a successful PUT, 428 without If-Match, 409 on a stale one. */
function serve(): { puts: Array<Record<string, string>> } {
  let version = 1;
  const puts: Array<Record<string, string>> = [];
  mockResilientFetch.mockImplementation(async (_path, init) => {
    if ((init.method ?? 'GET') === 'GET') return json(200, { nodes: [] }, { ETag: `"v${version}"` });
    const headers = (init.headers ?? {}) as Record<string, string>;
    puts.push(headers);
    if (!headers['If-Match']) return json(428, { code: 'BASE_VERSION_REQUIRED' });
    if (headers['If-Match'] !== `"v${version}"`) return json(409, { code: 'WRITE_CONFLICT' });
    version += 1;
    return json(200, {}, { ETag: `"v${version}"` });
  });
  return { puts };
}

describe('web-bridge taxonomy wiring (t/4187)', () => {
  beforeEach(() => { mockResilientFetch.mockReset(); });

  it('loadTaxonomyFileForEdit then saveTaxonomyFile sends the loaded ETag as If-Match, and the save succeeds', async () => {
    const { puts } = serve();
    await api.loadTaxonomyFileForEdit('t4187-wiring-a');
    await expect(api.saveTaxonomyFile('t4187-wiring-a', { nodes: [1] })).resolves.toBeUndefined();
    expect(puts[0]['If-Match']).toBe('"v1"');
  });

  it('a second save from the same page sends the ETag the first save returned', async () => {
    const { puts } = serve();
    await api.loadTaxonomyFileForEdit('t4187-wiring-b');
    await api.saveTaxonomyFile('t4187-wiring-b', { nodes: [1] });
    await api.saveTaxonomyFile('t4187-wiring-b', { nodes: [1, 2] });
    expect(puts.map(h => h['If-Match'])).toEqual(['"v1"', '"v2"']);
  });

  it('the plain loadTaxonomyFile does not arm the save: the save goes out without If-Match and surfaces the 428', async () => {
    const { puts } = serve();
    await api.loadTaxonomyFile('t4187-wiring-c');
    await expect(api.saveTaxonomyFile('t4187-wiring-c', { nodes: [] })).rejects.toMatchObject({ code: 'BASE_VERSION_REQUIRED', httpStatus: 428 });
    expect(puts[0]['If-Match']).toBeUndefined();
  });

  it('the editor load and save hit the taxonomy route', async () => {
    serve();
    await api.loadTaxonomyFileForEdit('skeptic');
    await api.saveTaxonomyFile('skeptic', { nodes: [] });
    expect(mockResilientFetch.mock.calls.map(([path, init]) => `${init.method ?? 'GET'} ${path}`)).toEqual([
      'GET /api/taxonomy/skeptic',
      'PUT /api/taxonomy/skeptic',
    ]);
  });
});
