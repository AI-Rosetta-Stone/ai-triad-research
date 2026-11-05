// @vitest-environment node
//
// t/4787 — public chat share routes (#4499). Route logic against an in-memory store:
// auth, idempotence (P1), replace revokes the old link, the active-share cap and create rate
// limit (P5), size bounds, owner-only revoke, and the public read's projection (P3: no owner
// userId/chatId) plus no-store and 404-after-revoke (P4).

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
vi.mock('../storage/fileIO.js', () => ({
  assertSafeId: (id: string) => { if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`unsafe id ${id}`); },
  getUserContentBackend: () => ({
    readFile: async (p: string) => h.files.get(p.replace(/\\/g, '/')) ?? null,
    writeFile: async (p: string, c: string) => { h.files.set(p.replace(/\\/g, '/'), c); },
    deleteFile: async (p: string) => { h.files.delete(p.replace(/\\/g, '/')); },
  }),
}));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { createRouter, type Handler } from '../httpKit.js';
import { registerChatShareRoutes, CHAT_SHARE_MAX_MESSAGES } from '../routes/chatShare.js';

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
});

describe('POST /api/chat/:id/share', () => {
  it('refuses anonymous users', async () => {
    h.anonymous = true;
    expect((await create()).statusCode).toBe(403);
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

  it('enforces the 20-active-share cap for a new chat, but still allows replacing an existing one', async () => {
    for (let i = 0; i < 20; i++) expect((await create(`chat-${i}`)).statusCode).toBe(201);
    expect((await create('chat-20')).statusCode).toBe(409);
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

  it('refuses anonymous users', async () => {
    h.anonymous = true;
    expect((await revoke()).statusCode).toBe(403);
  });
});
