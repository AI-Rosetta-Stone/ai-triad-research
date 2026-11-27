// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/725 (TaxonomyServer p/74#49): the web bridge's debate saves must go through the anonymous strip. Drives the real
// `api` from web-bridge.ts with only the network mocked, so it fails if saveDebateSession or saveDebateDelta
// reverts to sending the whole session. anonUpload.test.ts covers the strip itself; this covers the wiring.

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
const records: Array<{ level?: string; message?: string }> = [];
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: (r: { level?: string; message?: string }) => { records.push(r); } }) }));
vi.mock('../instrumentBridge', () => ({ instrumentBridge: (raw: unknown) => raw }));
vi.mock('../../utils/keyShareCrypto', () => ({ encryptKeysForSharing: vi.fn(), decryptKeysFromSharing: vi.fn() }));
vi.mock('../../hooks/useQuotaWarning', () => ({ onQuotaMilestone: vi.fn() }));

const { api } = await import('../web-bridge');
const { resetAnonymousUploadCache } = await import('../anonUpload');

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const STAGE = [{ stage: 'draft', prompt: 'p'.repeat(500) }];
const session = () => ({
  id: 'deb-1', title: 'T', transcript: [],
  diagnostics: { enabled: true, entries: {}, overview: {} },
  dialectical_diagnostics: [{ round: 1 }],
  turn_validations: { e1: { final: {}, attempts: [{ attempt: 1, stage_diagnostics: STAGE }] } },
});
const delta = () => ({
  debateId: 'deb-1', baseVersion: 2, newTranscriptEntries: [], changedNodes: [], changedEdges: [], newMutations: [],
  changedFields: { diagnostics: { enabled: true }, turn_validations: { e1: { final: {}, attempts: [{ attempt: 1, stage_diagnostics: STAGE }] } } },
});

function serve(auth: () => Response | Promise<Response>): { sent: Array<{ method: string; path: string; body: Record<string, unknown> }> } {
  const sent: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  mockResilientFetch.mockImplementation(async (path, init) => {
    if (path === '/api/auth/me') return auth();
    sent.push({ method: init.method ?? 'GET', path, body: JSON.parse(String(init.body ?? '{}')) });
    return json(200, { newVersion: 3 });
  });
  return { sent };
}

beforeEach(() => { mockResilientFetch.mockReset(); resetAnonymousUploadCache(); records.length = 0; });

describe('web-bridge debate saves and the anonymous strip (t/725)', () => {
  it('an anonymous full save carries no diagnostics, dialectical_diagnostics or stage_diagnostics', async () => {
    const { sent } = serve(() => json(200, { user: 'a', anonymous: true }));
    await api.saveDebateSession(session() as never, 'test');
    const put = sent.find(s => s.method === 'PUT')!;
    expect(put.path).toBe('/api/debates');
    expect(put.body.diagnostics).toBeUndefined();
    expect(put.body.dialectical_diagnostics).toBeUndefined();
    expect(JSON.stringify(put.body)).not.toContain('stage_diagnostics');
    expect(put.body.id).toBe('deb-1');
    expect(put.body.turn_validations).toBeDefined();
  });

  it('an anonymous delta save carries none of them in its overlay', async () => {
    const { sent } = serve(() => json(200, { user: 'a', anonymous: true }));
    await api.saveDebateDelta(delta() as never);
    const patch = sent.find(s => s.method === 'PATCH')!;
    expect(JSON.stringify(patch.body)).not.toContain('stage_diagnostics');
    expect((patch.body.changedFields as Record<string, unknown>).diagnostics).toBeUndefined();
    expect(patch.body.baseVersion).toBe(2);
  });

  it('a signed-in save is sent whole', async () => {
    const { sent } = serve(() => json(200, { user: 'u', anonymous: false }));
    await api.saveDebateSession(session() as never, 'test');
    const put = sent.find(s => s.method === 'PUT')!;
    expect(put.body.diagnostics).toBeDefined();
    expect(JSON.stringify(put.body)).toContain('stage_diagnostics');
  });

  it('when the auth check fails nothing is stripped (fail open: the server strips anyway), with a WARN, and the next save asks again', async () => {
    let calls = 0;
    const { sent } = serve(() => { calls++; if (calls === 1) throw new Error('network down'); return json(200, { anonymous: true }); });
    await api.saveDebateSession(session() as never, 'test');
    expect(sent.find(s => s.method === 'PUT')!.body.diagnostics).toBeDefined();
    expect(records.some(r => r.level === 'warn' && /auth check for the anonymous upload strip failed/.test(r.message ?? ''))).toBe(true);
    sent.length = 0;
    await api.saveDebateSession(session() as never, 'test');
    expect(sent.find(s => s.method === 'PUT')!.body.diagnostics).toBeUndefined();
  });

  it('a non-OK auth answer strips nothing', async () => {
    const { sent } = serve(() => json(500, { error: 'x' }));
    await api.saveDebateSession(session() as never, 'test');
    expect(sent.find(s => s.method === 'PUT')!.body.diagnostics).toBeDefined();
  });
});
