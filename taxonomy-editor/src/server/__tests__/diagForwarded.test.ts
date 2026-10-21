// @vitest-environment node
//
// t/4410 (TEMPORARY) — GET /api/diag/forwarded-headers. Proves the TL's two guards (p/806#30):
// staging-only (404 elsewhere), and an allowlist that never echoes cookies, Authorization or
// x-ms-* principal/token headers.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const { stagingMock } = vi.hoisted(() => ({ stagingMock: vi.fn(() => true) }));
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  isStagingIdentity: stagingMock,
}));

import type { ServerCtx } from '../routes/context.js';
import { createRouter, type Handler } from '../httpKit.js';
import { registerDiagForwardedRoutes, DIAG_FORWARDED_PATH } from '../routes/diagForwarded.js';

const SENSITIVE = {
  cookie: 'AppServiceAuthSession=SECRET-COOKIE',
  authorization: 'Bearer SECRET-TOKEN',
  'x-ms-client-principal': 'SECRET-PRINCIPAL-BLOB',
  'x-ms-client-principal-name': 'someone@example.com',
  'x-ms-token-github-access-token': 'SECRET-GH-TOKEN',
};
const FORWARDING = {
  'x-forwarded-for': '203.0.113.7, 198.51.100.4',
  'x-forwarded-proto': 'https',
  'x-forwarded-host': 'taxonomy-editor-staging.example',
  'x-real-ip': '198.51.100.4',
  forwarded: 'for=198.51.100.4;proto=https',
};

async function call(headers: Record<string, string>): Promise<{ status: number; body: any }> {
  const routes: { method: string; path: string; handler: Handler }[] = [];
  registerDiagForwardedRoutes(createRouter(routes), {} as ServerCtx);
  const route = routes.find(r => r.method === 'GET' && r.path === DIAG_FORWARDED_PATH)!;
  const req = { url: DIAG_FORWARDED_PATH, method: 'GET', headers, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage;
  const out = { status: 200, body: undefined as any };
  const res = {
    writableEnded: false, headersSent: false, setHeader() {}, getHeader() { return undefined; },
    writeHead(s: number) { out.status = s; this.headersSent = true; return this; },
    end(b?: string) { out.body = b ? JSON.parse(b) : undefined; this.writableEnded = true; },
  } as unknown as ServerResponse;
  await route.handler(req, res, undefined);
  return out;
}

beforeEach(() => { stagingMock.mockReset().mockReturnValue(true); });

describe('t/4410 — GET /api/diag/forwarded-headers', () => {
  it('guard 1: 404 when not staging (prod), echoing nothing', async () => {
    stagingMock.mockReturnValue(false);
    const { status, body } = await call({ ...FORWARDING, ...SENSITIVE });
    expect(status).toBe(404);
    expect(JSON.stringify(body)).not.toContain('203.0.113.7');
  });

  it('on staging: echoes every forwarding header verbatim plus the socket peer', async () => {
    const { status, body } = await call({ ...FORWARDING, ...SENSITIVE });
    expect(status).toBe(200);
    expect(body.headers).toEqual(FORWARDING);
    expect(body.socketRemoteAddress).toBe('127.0.0.1');
  });

  it('guard 2: never echoes cookies, Authorization or x-ms-* headers', async () => {
    const { body } = await call({ ...FORWARDING, ...SENSITIVE });
    const serialized = JSON.stringify(body);
    for (const v of Object.values(SENSITIVE)) expect(serialized).not.toContain(v);
    for (const k of Object.keys(SENSITIVE)) expect(Object.keys(body.headers)).not.toContain(k);
  });
});
