// @vitest-environment node

// t/4962: internal-tester analytics flag. GET /api/analytics/internal sets/clears the
// aitriad_internal cookie; POST /api/analytics/event stamps internal:true only when the
// request carries that cookie, and never copies a client-supplied `internal`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

vi.mock('../community/community.js', () => ({ isAdmin: () => false }));
vi.mock('../community/admin/reviewRegistry.js', () => ({ requireAdmin: () => false }));
const appendEvents = vi.fn(async () => {});
vi.mock('../community/analytics.js', () => ({ appendEvents: (...a: unknown[]) => appendEvents(...a) }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { registerSessionRoutes } from '../routes/session.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void> | void;
function handler(method: string, path: string): Handler {
  const handlers: Record<string, Handler> = {};
  const reg = (m: string) => (p: string, h: Handler) => { handlers[`${m} ${p}`] = h; };
  const router = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), del: reg('DELETE') };
  registerSessionRoutes(router as never, { broadcastEvent: () => {} } as never);
  return handlers[`${method} ${path}`];
}

type Res = ServerResponse & { _status?: number; _body?: string; _headers: Record<string, string> };
function fakeRes(): Res {
  const res = {
    _headers: {} as Record<string, string>,
    writeHead: vi.fn((s: number, h?: Record<string, string>) => { res._status = s; Object.assign(res._headers, h ?? {}); }),
    end: vi.fn((b?: string) => { res._body = b; }),
    setHeader: vi.fn((k: string, v: string) => { res._headers[k] = v; }),
  } as unknown as Res;
  return res;
}
function fakeReq(url: string, method: string, cookie?: string): IncomingMessage {
  return { url, method, headers: cookie ? { cookie } : {}, socket: { remoteAddress: '10.0.0.1' } } as unknown as IncomingMessage;
}

async function setFlag(on: string, headers: Record<string, string> = {}): Promise<Res> {
  const res = fakeRes();
  const req = { url: `/api/analytics/internal?on=${on}`, method: 'GET', headers, socket: { remoteAddress: '10.0.0.1' } } as unknown as IncomingMessage;
  await handler('GET', '/api/analytics/internal')(req, res, undefined);
  return res;
}

const EVENT = { user: 'u1', session_id: 's1', timestamp: '2026-11-09T12:00:00Z', event_type: 'click', category: 'nav', detail: {} };
async function post(events: unknown[], cookie?: string): Promise<Res> {
  const res = fakeRes();
  await handler('POST', '/api/analytics/event')(fakeReq('/api/analytics/event', 'POST', cookie), res, { events });
  return res;
}
function stored(): Record<string, unknown>[] {
  return appendEvents.mock.calls[0][0] as Record<string, unknown>[];
}

const savedEnv = { ...process.env };
beforeEach(() => {
  appendEvents.mockClear();
  delete process.env.NODE_ENV;
  delete process.env.ALLOWED_ORIGINS;
});
afterEach(() => { process.env = { ...savedEnv }; });

describe('GET /api/analytics/internal', () => {
  it('on=1 sets an HttpOnly, SameSite=Lax, 1-year aitriad_internal=1 cookie and a confirmation page', async () => {
    const res = await setFlag('1');
    expect(res._status).toBe(200);
    const cookie = res._headers['Set-Cookie'];
    expect(cookie).toMatch(/^aitriad_internal=1;/);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=31536000');
    expect(res._headers['Content-Type']).toMatch(/^text\/html/);
    expect(res._headers['Cache-Control']).toBe('no-store');
    expect(res._body).toContain('This browser is now marked as an internal tester');
  });

  it('on=0 clears the cookie (empty value, Max-Age=0)', async () => {
    const res = await setFlag('0');
    expect(res._status).toBe(200);
    expect(res._headers['Set-Cookie']).toMatch(/^aitriad_internal=;/);
    expect(res._headers['Set-Cookie']).toContain('Max-Age=0');
    expect(res._body).toContain('no longer marked as an internal tester');
  });

  it('adds Secure in production', async () => {
    process.env.NODE_ENV = 'production';
    expect((await setFlag('1'))._headers['Set-Cookie']).toContain('; Secure');
  });

  it('adds Secure when ALLOWED_ORIGINS is set (hosted deployments)', async () => {
    process.env.ALLOWED_ORIGINS = 'https://example.test';
    expect((await setFlag('1'))._headers['Set-Cookie']).toContain('; Secure');
  });

  it('omits Secure for local http dev', async () => {
    expect((await setFlag('1'))._headers['Set-Cookie']).not.toContain('Secure');
  });

  it.each(['', 'true', '2', 'yes'])('rejects on=%j with 400 and sets no cookie', async (on) => {
    const res = await setFlag(on);
    expect(res._status).toBe(400);
    expect(res._headers['Set-Cookie']).toBeUndefined();
  });
});

describe('GET /api/analytics/internal: refuses toggles the user did not navigate to (t/4968)', () => {
  it.each([
    ['cross-site link', { 'sec-fetch-site': 'cross-site' }],
    ['Sec-Purpose prefetch', { 'sec-purpose': 'prefetch' }],
    ['Sec-Purpose prefetch;prerender', { 'sec-purpose': 'prefetch;prerender' }],
    ['legacy Purpose: prefetch', { purpose: 'prefetch' }],
  ])('%s → 403 and no cookie change', async (_label, headers) => {
    for (const on of ['1', '0']) {
      const res = await setFlag(on, headers);
      expect(res._status).toBe(403);
      expect(res._headers['Set-Cookie']).toBeUndefined();
    }
  });

  it.each([
    ['direct navigation', { 'sec-fetch-site': 'none' }],
    ['same-origin', { 'sec-fetch-site': 'same-origin' }],
    ['same-site', { 'sec-fetch-site': 'same-site' }],
    ['no fetch metadata (curl, older browsers)', {}],
  ])('%s → still sets the cookie', async (_label, headers) => {
    const res = await setFlag('1', headers);
    expect(res._status).toBe(200);
    expect(res._headers['Set-Cookie']).toMatch(/^aitriad_internal=1;/);
  });
});

describe('POST /api/analytics/event: internal stamping', () => {
  it('stamps internal:true on every event when the request carries the tester cookie', async () => {
    await post([EVENT, { ...EVENT, session_id: 's2' }], 'anon_session_id=abc; aitriad_internal=1');
    expect(stored()).toHaveLength(2);
    expect(stored().every(e => e.internal === true)).toBe(true);
  });

  it('leaves the field absent without the cookie', async () => {
    await post([EVENT]);
    expect(stored()[0]).not.toHaveProperty('internal');
    expect(JSON.stringify(stored()[0])).not.toContain('internal');
  });

  it('ignores a client-supplied internal:true when there is no cookie', async () => {
    await post([{ ...EVENT, internal: true }]);
    expect(stored()[0]).not.toHaveProperty('internal');
  });

  it('ignores a client-supplied internal:false when the cookie is present', async () => {
    await post([{ ...EVENT, internal: false }], 'aitriad_internal=1');
    expect(stored()[0].internal).toBe(true);
  });

  it('does not treat a cleared or other-valued cookie as internal', async () => {
    await post([EVENT], 'aitriad_internal=');
    await post([EVENT], 'aitriad_internal=0');
    for (const call of appendEvents.mock.calls) {
      expect((call[0] as Record<string, unknown>[])[0]).not.toHaveProperty('internal');
    }
  });
});
