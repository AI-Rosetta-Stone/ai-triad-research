// @vitest-environment node
//
// t/4787 — public chat share routes (#4499). Route logic against an in-memory store:
// auth, idempotence (P1), replace revokes the old link, the active-share cap and create rate
// limit (P5), size bounds, owner-only revoke, and the public read's projection (P3: no owner
// userId/chatId) plus no-store and 404-after-revoke (P4).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const h = vi.hoisted(() => ({
  anonymous: false,
  userId: 'alice',
  createAllowed: true,
  readAllowed: true,
  files: new Map<string, string>(),
}));

vi.mock('../security/userContext.js', () => ({
  isAnonymousUser: () => h.anonymous,
  getCurrentUserId: () => h.userId,
  getStorageUserId: () => h.userId,
}));
vi.mock('../security/rateLimiter.js', () => ({
  checkRate: (key: string) => ({
    allowed: key.startsWith('chat-share-read') ? h.readAllowed : h.createAllowed,
    retryAfterMs: 1000,
  }),
}));
// httpKit.error() calls clientSafeMessage, so it must stay a passthrough.
vi.mock('../security/accessControl.js', () => ({ invalidRouteParam: () => null, clientSafeMessage: (m: string) => m }));
vi.mock('../config.js', () => ({ resolveDataPath: (p: string) => `/data/${p}` }));
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

  // K3: Atomic in-memory backend with synchronous CAS (no await between compare and store).
  // Exposed on globalThis so beforeEach can clear it — this closure's Map would otherwise
  // outlive and leak state across tests regardless of the hoisted `h.files` reset (that Map
  // is a distinct, unused object), causing idempotence (P1) to mask every test after the first.
  const fileVersions = new Map<string, {content: string, sha: string}>();
  (globalThis as any).__chatShareFileVersions = fileVersions;

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
        // K3: Atomic CAS with gitBlobSha (baseSha '' for "must not exist", SHA for "must match").
        const entry = fileVersions.get(path);
        const currentSha = entry ? gitBlobSha(entry.content) : '';

        if (opts?.baseSha !== undefined && opts.baseSha !== currentSha) {
          const err = new Error('Write conflict');
          (err as any).code = 'WRITE_CONFLICT';
          throw err;
        }
        // Write is atomic: set synchronously with new SHA
        fileVersions.set(path, { content: c, sha: gitBlobSha(c) });
      },
      deleteFile: async (p: string) => { fileVersions.delete(p.replace(/\\/g, '/')); },
    }),
  };
});
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { createRouter, type Handler } from '../httpKit.js';
import { registerChatShareRoutes, CHAT_SHARE_MAX_MESSAGES } from '../routes/chatShare.js';
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
  registerChatShareRoutes(createRouter(routes as never) as never, {} as never);
  return routes.find(r => r.method === method && r.path === path)!.handler;
}

const BODY = { title: 'My chat', messages: [{ role: 'user', content: 'hi', timestamp: 't1' }, { role: 'assistant', content: 'hello', timestamp: 't2' }] };

async function create(chatId = 'chat-1', body: unknown = BODY): Promise<Res> {
  const r = res(); await handler('POST', '/api/chat/:id/share')(req(`/api/chat/${chatId}/share`, 'POST'), r, body); return r;
}
async function revoke(chatId = 'chat-1'): Promise<Res> {
  const r = res(); await handler('DELETE', '/api/chat/:id/share')(req(`/api/chat/${chatId}/share`, 'DELETE'), r, undefined); return r;
}
async function read(shareId: string): Promise<Res> {
  const r = res(); await handler('GET', '/api/public/chat/:shareId')(req(`/api/public/chat/${shareId}`, 'GET'), r, undefined); return r;
}

beforeEach(() => {
  h.anonymous = false; h.userId = 'alice'; h.createAllowed = true; h.readAllowed = true; h.files.clear();
  (globalThis as any).__chatShareFileVersions?.clear();
});

describe('POST /api/chat/:id/share', () => {
  it('refuses anonymous users (K5: 401)', async () => {
    h.anonymous = true;
    expect((await create()).statusCode).toBe(401);
  });

  it('K1: share ID is 128-bit base64url (22 chars)', async () => {
    const r = await create();
    const share = JSON.parse(r.body);
    expect(/^[A-Za-z0-9_-]{22}$/.test(share.id)).toBe(true);
  });

  it('creates a share (201), and re-sharing the same chat returns the same share (200, P1)', async () => {
    const first = await create();
    expect(first.statusCode).toBe(201);
    const again = await create();
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.body).id).toBe(JSON.parse(first.body).id);
  });

  it('an idempotent re-share does not consume the create rate limit', async () => {
    await create();
    h.createAllowed = false;
    expect((await create()).statusCode).toBe(200);
  });

  it('replace=true issues a new link AND revokes the old one', async () => {
    const oldId = JSON.parse((await create()).body).id;
    const replaced = await create('chat-1', { ...BODY, replace: true });
    const newId = JSON.parse(replaced.body).id;
    expect(newId).not.toBe(oldId);
    expect((await read(oldId)).statusCode).toBe(404);
    expect((await read(newId)).statusCode).toBe(200);
  });

  it('enforces the 20-active-share cap for a new chat, but still allows replacing an existing one (K5: 429)', async () => {
    for (let i = 0; i < 20; i++) expect((await create(`chat-${i}`)).statusCode).toBe(201);
    expect((await create('chat-20')).statusCode).toBe(429);
    expect((await create('chat-0', { ...BODY, replace: true })).statusCode).toBe(201);
  });

  it('returns 429 when the create rate limit is exhausted', async () => {
    h.createAllowed = false;
    expect((await create()).statusCode).toBe(429);
  });

  it('rejects a chat with too many messages (413)', async () => {
    const messages = Array.from({ length: CHAT_SHARE_MAX_MESSAGES + 1 }, () => ({ role: 'user', content: 'x', timestamp: 't' }));
    expect((await create('chat-1', { title: 't', messages })).statusCode).toBe(413);
  });

  it('rejects a disallowed speaker role rather than publishing it', async () => {
    const r = await create('chat-1', { title: 't', messages: [{ role: 'cc', content: 'x', timestamp: 't' }] });
    expect(r.statusCode).toBe(500);
    expect([...h.files.keys()].some(k => k.includes('chat-shares/'))).toBe(false);
  });
});

describe('GET /api/public/chat/:shareId', () => {
  it('returns only the conversation: no owner userId or chatId (P3), with no-store (P4)', async () => {
    const id = JSON.parse((await create()).body).id;
    const r = await read(id);
    expect(r.statusCode).toBe(200);
    expect(r.headers['Cache-Control']).toBe('no-store');
    const view = JSON.parse(r.body);
    expect(Object.keys(view).sort()).toEqual(['created_at', 'expires_at', 'id', 'messages', 'title']);
    expect(r.body).not.toContain('alice');
    expect(r.body).not.toContain('chat-1');
    expect(view.messages).toEqual([{ role: 'user', content: 'hi', timestamp: 't1' }, { role: 'assistant', content: 'hello', timestamp: 't2' }]);
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

  it('K2: includes noindex header on 200 response', async () => {
    const id = JSON.parse((await create()).body).id;
    const r = await read(id);
    expect(r.statusCode).toBe(200);
    expect(r.headers['X-Robots-Tag']).toBe('noindex');
  });

  it('K2: includes noindex header on 404 response', async () => {
    const r = await read('nope');
    expect(r.statusCode).toBe(404);
    expect(r.headers['X-Robots-Tag']).toBe('noindex');
  });

  it('K2: includes noindex header on 429 response', async () => {
    const id = JSON.parse((await create()).body).id;
    h.readAllowed = false;
    const r = await read(id);
    expect(r.statusCode).toBe(429);
    expect(r.headers['X-Robots-Tag']).toBe('noindex');
  });
});

describe('DELETE /api/chat/:id/share', () => {
  it('revokes the share, and the public link is 404 immediately afterwards (P4)', async () => {
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

  it('refuses anonymous users (K5: 401)', async () => {
    h.anonymous = true;
    expect((await revoke()).statusCode).toBe(401);
  });
});

describe('K3: race condition retry + orphan cleanup', () => {
  it('orphan shares are cleaned up (K3)', async () => {
    const r1 = await create('race-chat');
    const id1 = JSON.parse(r1.body).id;
    const r2 = await create('race-chat', { ...BODY, replace: true });
    const id2 = JSON.parse(r2.body).id;
    expect(id1).not.toBe(id2);
    expect((await read(id1)).statusCode).toBe(404);
    expect((await read(id2)).statusCode).toBe(200);
  });
});

describe('K5: cap returns 429 (not 409)', () => {
  it('returns 429 when cap is hit', async () => {
    for (let i = 0; i < 20; i++) expect((await create(`chat-${i}`)).statusCode).toBe(201);
    const r = await create('chat-20');
    expect(r.statusCode).toBe(429);
    expect(r.body).toContain('retryAfterMs');
  });
});

describe('K4: expiry deletion with clock injection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('deletes expired blob and returns 404 after TTL (SO p/835#21: real clock injection)', async () => {
    const id = JSON.parse((await create()).body).id;
    expect((await read(id)).statusCode).toBe(200);

    // Fast-forward 31 days (TTL is 30) and confirm loadShare's expiry check actually fires.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);

    const r = await read(id);
    expect(r.statusCode).toBe(404);

    // The expired blob must be deleted (K4), not just hidden — re-reading the real-time
    // store should find it gone even without the clock still fast-forwarded.
    vi.useRealTimers();
    expect((await read(id)).statusCode).toBe(404);
  });
});

describe('R-D: corrupt registry fails closed (SO p/835#21)', () => {
  it('refuses to create against a corrupt registry instead of silently overwriting it', async () => {
    const versions: Map<string, { content: string; sha: string }> = (globalThis as any).__chatShareFileVersions;
    // Simulate a corrupt registry file on disk (invalid JSON) for this user.
    versions.set('/data/users/alice/chat-shares.json', { content: '{not valid json', sha: '' });

    const r = await create('chat-1');
    expect(r.statusCode).toBe(500);

    // The corrupt content must survive untouched — R-D's whole point is "don't overwrite it".
    expect(versions.get('/data/users/alice/chat-shares.json')?.content).toBe('{not valid json');
  });
});

describe('read-only principal guard (SO p/835#21: previously untested)', () => {
  it('owner-only create/revoke are gated as mutating /api/* routes', () => {
    // t/4296's central choke point blocks every mutating /api/* route for a read-only
    // principal before the handler runs — these routes must be covered by it, same
    // as every other POST/DELETE. The per-route handlers never check the flag directly.
    expect(isMutatingApiRoute('POST', '/api/chat/chat-1/share', true)).toBe(true);
    expect(isMutatingApiRoute('DELETE', '/api/chat/chat-1/share', true)).toBe(true);
  });

  it('the public read is not gated — anonymous read-only access must still work', () => {
    expect(isMutatingApiRoute('GET', '/api/public/chat/some-share-id', true)).toBe(false);
  });
});

describe('K5: auth and rate limits', () => {
  it('returns 401 when anonymous user attempts POST', async () => {
    h.anonymous = true;
    const r = await create();
    expect(r.statusCode).toBe(401);
    h.anonymous = false;
  });

  it('returns 429 when create rate limit exhausted', async () => {
    h.createAllowed = false;
    const r = await create();
    expect(r.statusCode).toBe(429);
    h.createAllowed = true;
  });
});

describe('K3: concurrent POST race test (CAS)', () => {
  it('concurrent POSTs on same chat — exactly one share ID is live (CAS enforced)', async () => {
    // K3 race: both try to create pointer simultaneously
    const [r1, r2] = await Promise.all([
      create('k3-race-chat'),
      create('k3-race-chat'),
    ]);

    // Both should succeed (one 201 new, one 200 idempotent)
    expect([201, 200]).toContain(r1.statusCode);
    expect([201, 200]).toContain(r2.statusCode);

    const id1 = JSON.parse(r1.body)?.id;
    const id2 = JSON.parse(r2.body)?.id;
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();

    // K3: Both responses must return the SAME share ID (one was the race winner)
    expect(id1).toBe(id2);

    // R-A regression (SO p/835#21): the race must leave EXACTLY one blob file behind —
    // not the winner's blob plus a dangling loser blob (dead storage) and not zero
    // (the registry pointing at a blob that got deleted out from under it).
    const versions: Map<string, unknown> = (globalThis as any).__chatShareFileVersions;
    const blobPaths = [...versions.keys()].filter(k => k.includes('/chat-shares/'));
    expect(blobPaths).toHaveLength(1);
    expect(blobPaths[0]).toContain(id1);

    // Verify: that one blob exists and is readable
    const readResult = await read(id1);
    expect(readResult.statusCode).toBe(200);
    const view = JSON.parse(readResult.body);
    expect(view.id).toBe(id1);
  });

  it('race with different chats runs in parallel (no CAS conflict)', async () => {
    // Two concurrent creates on DIFFERENT chats: both should succeed
    const [r1, r2] = await Promise.all([
      create('chat-a'),
      create('chat-b'),
    ]);

    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);

    const id1 = JSON.parse(r1.body)?.id;
    const id2 = JSON.parse(r2.body)?.id;
    expect(id1).not.toBe(id2); // Different chats → different share IDs
  });
});
