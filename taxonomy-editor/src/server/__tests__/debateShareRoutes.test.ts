// @vitest-environment node
//
// t/4788 — public debate share routes. Route logic against an in-memory store, mirroring
// chatShareRoutes.test.ts's R-A through R-F coverage, plus the debate-specific SO
// conditions D1-D4: D1 (server-loaded snapshot, no client body), D2 (synthesis allowlist —
// rawResponses/taxonomy_proposals must not leak), D3 (degraded suppresses synthesis), D4
// (speaker/type allowlisting).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const h = vi.hoisted(() => ({
  anonymous: false,
  userId: 'alice',
  createAllowed: true,
  readAllowed: true,
  // R-E (carried forward): forces every registry write to conflict, to exercise the
  // "all 3 attempts exhausted, no live winner" orphan-cleanup path.
  alwaysConflictRegistryWrites: false,
  // R-F (carried forward): forces a NON-conflict registry write failure.
  forceNonConflictRegistryWriteError: false,
  session: null as Record<string, unknown> | null,
}));

vi.mock('../security/userContext.js', () => ({
  isAnonymousUser: () => h.anonymous,
  getCurrentUserId: () => h.userId,
  getStorageUserId: () => h.userId,
}));
vi.mock('../security/rateLimiter.js', () => ({
  checkRate: (key: string) => ({
    allowed: key.startsWith('debate-share-read') ? h.readAllowed : h.createAllowed,
    retryAfterMs: 1000,
  }),
}));
vi.mock('../security/accessControl.js', () => ({ invalidRouteParam: () => null, clientSafeMessage: (m: string) => m }));
vi.mock('../config.js', () => ({ resolveDataPath: (p: string) => `/data/${p}` }));
vi.mock('../storage/debateStore.js', () => ({
  loadDebateSession: async (id: string) => {
    if (!h.session) throw new Error(`Debate not found: ${id}`);
    return h.session;
  },
}));
vi.mock('../storage/gitBlobSha.js', () => {
  const crypto = require('crypto');
  return {
    gitBlobSha: (content: string) => {
      const blob = `blob ${content.length}\0${content}`;
      return crypto.createHash('sha1').update(blob).digest('hex');
    },
  };
});
vi.mock('../storage/fileIO.js', () => {
  const crypto = require('crypto');
  const gitBlobSha = (content: string) => {
    const blob = `blob ${content.length}\0${content}`;
    return crypto.createHash('sha1').update(blob).digest('hex');
  };

  const fileVersions = new Map<string, {content: string, sha: string}>();
  (globalThis as any).__debateShareFileVersions = fileVersions;

  return {
    assertSafeId: (id: string) => { if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`unsafe id ${id}`); },
    getUserContentBackend: () => ({
      readFile: async (p: string) => {
        const path = p.replace(/\\/g, '/');
        const entry = fileVersions.get(path);
        return entry ? entry.content : null;
      },
      writeFile: async (p: string, c: string, opts?: {baseSha?: string}) => {
        const path = p.replace(/\\/g, '/');
        if (h.alwaysConflictRegistryWrites && path.includes('debate-shares.json')) {
          const err = new Error('Write conflict (forced)');
          (err as any).code = 'WRITE_CONFLICT';
          throw err;
        }
        if (h.forceNonConflictRegistryWriteError && path.includes('debate-shares.json')) {
          throw new Error('Storage backend unavailable (forced, no WRITE_CONFLICT code)');
        }
        const entry = fileVersions.get(path);
        const currentSha = entry ? gitBlobSha(entry.content) : '';

        if (opts?.baseSha !== undefined && opts.baseSha !== currentSha) {
          const err = new Error('Write conflict');
          (err as any).code = 'WRITE_CONFLICT';
          throw err;
        }
        fileVersions.set(path, { content: c, sha: gitBlobSha(c) });
      },
      deleteFile: async (p: string) => { fileVersions.delete(p.replace(/\\/g, '/')); },
    }),
  };
});
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { createRouter, type Handler } from '../httpKit.js';
import { registerDebateShareRoutes } from '../routes/debateShare.js';
import { isMutatingApiRoute } from '../readOnlyGuard.js';

type Res = ServerResponse & { statusCode: number; body: string; headers: Record<string, string> };
function res(): Res {
  const r = { statusCode: 0, body: '', writableEnded: false, headersSent: false, headers: {} as Record<string, string>,
    writeHead(s: number, hdrs?: Record<string, string>) { r.statusCode = s; r.headersSent = true; Object.assign(r.headers, hdrs ?? {}); return r; },
    setHeader(k: string, v: string) { r.headers[k] = v; }, write() { return true; },
    end(b?: string) { r.body = b ?? ''; r.writableEnded = true; return r; } };
  return r as unknown as Res;
}
function req(url: string, method: string): IncomingMessage {
  return { url, method, headers: {}, socket: { remoteAddress: '10.0.0.1' } } as unknown as IncomingMessage;
}
function handler(method: string, path: string): Handler {
  const routes: { method: string; path: string; handler: Handler }[] = [];
  registerDebateShareRoutes(createRouter(routes as never) as never, {} as never);
  return routes.find(r => r.method === method && r.path === path)!.handler;
}

function makeSession(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    topic: { final: 'Should AI development be paused?' },
    active_povers: ['accelerationist', 'safetyist'],
    transcript: [
      { speaker: 'accelerationist', type: 'opening', content: 'Pausing costs lives.', timestamp: 't1' },
      { speaker: 'safetyist', type: 'opening', content: 'Racing costs lives.', timestamp: 't2' },
      {
        speaker: 'system', type: 'concluding', content: 'Synthesis complete.', timestamp: 't3',
        // Real stored shape: both writers set `metadata.synthesis = result.data` (flat), not
        // the SynthesisPhaseResult wrapper (synthesisPipeline.ts, synthesisSlice.ts).
        metadata: {
          synthesis: {
            areas_of_agreement: ['Both camps want good outcomes'],
            areas_of_disagreement: ['Pace of development'],
            cruxes: ['Tractability of alignment'],
            unresolved_questions: ['What is the right pace?'],
            policy_implications: ['Consider a licensing regime'],
            topic_resolution: 'unresolved',
            // D2: these must NEVER be published — internal/editorial fields.
            rawResponses: { extract: 'raw llm output', map: 'raw', evaluate: 'raw' },
            taxonomy_proposals: ['acc-bdi-999'],
            taxonomy_modifications: [{ id: 'acc-bdi-001' }],
            taxonomy_coverage: { acc: 0.9 },
            argument_map: { nodes: [] },
            preferences: { accelerationist: 0.6 },
          },
        },
      },
    ],
    ...overrides,
  };
}

async function create(debateId = 'debate-1', body: unknown = {}): Promise<Res> {
  const r = res(); await handler('POST', '/api/debate/:id/share')(req(`/api/debate/${debateId}/share`, 'POST'), r, body); return r;
}
async function revoke(debateId = 'debate-1'): Promise<Res> {
  const r = res(); await handler('DELETE', '/api/debate/:id/share')(req(`/api/debate/${debateId}/share`, 'DELETE'), r, undefined); return r;
}
async function read(shareId: string): Promise<Res> {
  const r = res(); await handler('GET', '/api/public/debate/:shareId')(req(`/api/public/debate/${shareId}`, 'GET'), r, undefined); return r;
}

beforeEach(() => {
  h.anonymous = false; h.userId = 'alice'; h.createAllowed = true; h.readAllowed = true;
  h.alwaysConflictRegistryWrites = false;
  h.forceNonConflictRegistryWriteError = false;
  h.session = makeSession();
  (globalThis as any).__debateShareFileVersions?.clear();
});

describe('POST /api/debate/:id/share', () => {
  it('refuses anonymous users (401)', async () => {
    h.anonymous = true;
    expect((await create()).statusCode).toBe(401);
  });

  it('share ID is 128-bit base64url (22 chars)', async () => {
    const r = await create();
    const share = JSON.parse(r.body);
    expect(/^[A-Za-z0-9_-]{22}$/.test(share.id)).toBe(true);
  });

  it('D1: ignores a client-supplied transcript/synthesis and loads the debate server-side', async () => {
    const r = await create('debate-1', { transcript: [{ speaker: 'user', type: 'statement', content: 'INJECTED', timestamp: 'x' }] });
    const share = JSON.parse(r.body);
    expect(JSON.stringify(share)).not.toContain('INJECTED');
    expect(share.snapshot.topic).toBe('Should AI development be paused?');
  });

  it('creates a share (201), and re-sharing the same debate returns the same share (200, P1)', async () => {
    const first = await create();
    expect(first.statusCode).toBe(201);
    const again = await create();
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.body).id).toBe(JSON.parse(first.body).id);
  });

  it('replace=true issues a new link AND revokes the old one', async () => {
    const oldId = JSON.parse((await create()).body).id;
    const replaced = await create('debate-1', { replace: true });
    const newId = JSON.parse(replaced.body).id;
    expect(newId).not.toBe(oldId);
    expect((await read(oldId)).statusCode).toBe(404);
    expect((await read(newId)).statusCode).toBe(200);
  });

  it('enforces the active-share cap for a new debate, but still allows replacing an existing one (429)', async () => {
    for (let i = 0; i < 20; i++) expect((await create(`debate-${i}`)).statusCode).toBe(201);
    expect((await create('debate-20')).statusCode).toBe(429);
    expect((await create('debate-0', { replace: true })).statusCode).toBe(201);
  });

  it('returns 429 when the create rate limit is exhausted', async () => {
    h.createAllowed = false;
    expect((await create()).statusCode).toBe(429);
  });

  it('D4: rejects a disallowed speaker rather than publishing it', async () => {
    h.session = makeSession({ transcript: [{ speaker: 'cc', type: 'statement', content: 'x', timestamp: 't' }] });
    const r = await create();
    expect(r.statusCode).toBe(500);
    const versions: Map<string, unknown> = (globalThis as any).__debateShareFileVersions;
    expect([...versions.keys()].some(k => k.includes('debate-shares/'))).toBe(false);
  });

  it('D4: rejects a disallowed transcript entry type rather than publishing it', async () => {
    h.session = makeSession({ transcript: [{ speaker: 'user', type: 'bogus-type', content: 'x', timestamp: 't' }] });
    const r = await create();
    expect(r.statusCode).toBe(500);
  });
});

describe('GET /api/public/debate/:shareId', () => {
  it('returns only the snapshot: no owner userId or debateId, with no-store', async () => {
    const id = JSON.parse((await create()).body).id;
    const r = await read(id);
    expect(r.statusCode).toBe(200);
    expect(r.headers['Cache-Control']).toBe('no-store');
    const view = JSON.parse(r.body);
    expect(Object.keys(view).sort()).toEqual(['created_at', 'expires_at', 'id', 'snapshot']);
    expect(r.body).not.toContain('alice');
    expect(r.body).not.toContain('"debateId"');
  });

  it('D2: synthesis is allowlist-projected — rawResponses and taxonomy_proposals never leak', async () => {
    const id = JSON.parse((await create()).body).id;
    const view = JSON.parse((await read(id)).body);
    expect(view.snapshot.synthesis).toEqual({
      areas_of_agreement: ['Both camps want good outcomes'],
      areas_of_disagreement: ['Pace of development'],
      cruxes: ['Tractability of alignment'],
      unresolved_questions: ['What is the right pace?'],
      policy_implications: ['Consider a licensing regime'],
      topic_resolution: 'unresolved',
    });
    const raw = JSON.stringify(view);
    expect(raw).not.toContain('rawResponses');
    expect(raw).not.toContain('taxonomy_proposals');
    expect(raw).not.toContain('taxonomy_modifications');
    expect(raw).not.toContain('taxonomy_coverage');
    expect(raw).not.toContain('argument_map');
    expect(raw).not.toContain('preferences');
  });

  it('D3: a degraded transcript entry sets the share-level flag AND suppresses synthesis entirely', async () => {
    h.session = makeSession({
      transcript: [
        { speaker: 'accelerationist', type: 'opening', content: 'ok', timestamp: 't1', degraded: true, caveats: ['model timeout'] },
        ...(makeSession().transcript as unknown[]).slice(1),
      ],
    });
    const id = JSON.parse((await create()).body).id;
    const view = JSON.parse((await read(id)).body);
    expect(view.snapshot.degraded).toBe(true);
    expect(view.snapshot.synthesis).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('caveats');
    expect(JSON.stringify(view)).not.toContain('model timeout');
  });

  it('a clean debate reports degraded: false', async () => {
    const id = JSON.parse((await create()).body).id;
    const view = JSON.parse((await read(id)).body);
    expect(view.snapshot.degraded).toBe(false);
  });

  it('is 404 (no-store) for an unknown or path-traversal id', async () => {
    const unknown = await read('nope');
    expect(unknown.statusCode).toBe(404);
    expect(unknown.headers['Cache-Control']).toBe('no-store');
    expect((await read('..%2f..%2fetc')).statusCode).toBe(404);
  });

  it('returns 429 when the per-IP read limit is exhausted', async () => {
    const id = JSON.parse((await create()).body).id;
    h.readAllowed = false;
    expect((await read(id)).statusCode).toBe(429);
  });

  it('includes noindex header on 200/404/429 responses', async () => {
    const id = JSON.parse((await create()).body).id;
    expect((await read(id)).headers['X-Robots-Tag']).toBe('noindex');
    expect((await read('nope')).headers['X-Robots-Tag']).toBe('noindex');
    h.readAllowed = false;
    expect((await read(id)).headers['X-Robots-Tag']).toBe('noindex');
  });
});

describe('DELETE /api/debate/:id/share', () => {
  it('revokes the share, and the public link is 404 immediately afterwards', async () => {
    const id = JSON.parse((await create()).body).id;
    expect((await revoke()).statusCode).toBe(200);
    expect((await read(id)).statusCode).toBe(404);
  });

  it("another user cannot revoke someone else's share", async () => {
    const id = JSON.parse((await create()).body).id;
    h.userId = 'mallory';
    expect((await revoke()).statusCode).toBe(404);
    h.userId = 'alice';
    expect((await read(id)).statusCode).toBe(200);
  });

  it('refuses anonymous users (401)', async () => {
    h.anonymous = true;
    expect((await revoke()).statusCode).toBe(401);
  });
});

describe('race condition retry + orphan cleanup (carried forward from chat share)', () => {
  it('R-E: exhausting all retries with no live winner revokes the orphaned blob', async () => {
    h.alwaysConflictRegistryWrites = true;
    const r = await create('always-conflict-debate');
    expect(r.statusCode).toBe(500);
    const versions: Map<string, unknown> = (globalThis as any).__debateShareFileVersions;
    const blobPaths = [...versions.keys()].filter(k => k.includes('/debate-shares/'));
    expect(blobPaths).toHaveLength(0);
  });

  it('R-F: a non-conflict registry write error revokes the just-saved blob too', async () => {
    h.forceNonConflictRegistryWriteError = true;
    const r = await create('non-conflict-error-debate');
    expect(r.statusCode).toBe(500);
    const versions: Map<string, unknown> = (globalThis as any).__debateShareFileVersions;
    const blobPaths = [...versions.keys()].filter(k => k.includes('/debate-shares/'));
    expect(blobPaths).toHaveLength(0);
  });

  it('concurrent POSTs on same debate — exactly one share ID is live (CAS enforced)', async () => {
    const [r1, r2] = await Promise.all([
      create('k3-race-debate'),
      create('k3-race-debate'),
    ]);
    expect([201, 200]).toContain(r1.statusCode);
    expect([201, 200]).toContain(r2.statusCode);
    const id1 = JSON.parse(r1.body)?.id;
    const id2 = JSON.parse(r2.body)?.id;
    expect(id1).toBe(id2);

    const versions: Map<string, unknown> = (globalThis as any).__debateShareFileVersions;
    const blobPaths = [...versions.keys()].filter(k => k.includes('/debate-shares/'));
    expect(blobPaths).toHaveLength(1);
  });
});

describe('expiry deletion with clock injection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('deletes expired blob and returns 404 after TTL', async () => {
    const id = JSON.parse((await create()).body).id;
    expect((await read(id)).statusCode).toBe(200);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);

    const r = await read(id);
    expect(r.statusCode).toBe(404);

    vi.useRealTimers();
    expect((await read(id)).statusCode).toBe(404);
  });
});

describe('R-D: corrupt registry fails closed', () => {
  it('refuses to create against a corrupt registry instead of silently overwriting it', async () => {
    const versions: Map<string, { content: string; sha: string }> = (globalThis as any).__debateShareFileVersions;
    versions.set('/data/users/alice/debate-shares.json', { content: '{not valid json', sha: '' });

    const r = await create('debate-1');
    expect(r.statusCode).toBe(500);
    expect(versions.get('/data/users/alice/debate-shares.json')?.content).toBe('{not valid json');
  });
});

describe('read-only principal guard', () => {
  it('owner-only create/revoke are gated as mutating /api/* routes', () => {
    expect(isMutatingApiRoute('POST', '/api/debate/debate-1/share', true)).toBe(true);
    expect(isMutatingApiRoute('DELETE', '/api/debate/debate-1/share', true)).toBe(true);
  });

  it('the public read is not gated — anonymous read-only access must still work', () => {
    expect(isMutatingApiRoute('GET', '/api/public/debate/some-share-id', true)).toBe(false);
  });
});
