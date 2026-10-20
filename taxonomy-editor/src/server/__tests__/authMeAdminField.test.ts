// @vitest-environment node
//
// t/4326 ask 3 (t/4327) — GET /api/auth/me reports `admin` + `storageUserId` (mirroring
// /api/user/profile's existing pattern), and logs one INFO line per process per user
// when a signed-in (non-anonymous) principal resolves non-admin, to make "GitHub
// sign-in isn't admin" diagnosable from logs without a manual query.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';

const { warnMock, infoMock } = vi.hoisted(() => ({ warnMock: vi.fn(), infoMock: vi.fn() }));
vi.mock('../logger.js', () => ({ log: { server: { warn: warnMock, info: infoMock, error: vi.fn(), debug: vi.fn() } } }));

import { createRouter } from '../httpKit.js';
import { registerSessionRoutes } from '../routes/session.js';

let prevAuth: string | undefined;
let prevAdmin: string | undefined;

function mockReq(headers: Record<string, string> = {}): http.IncomingMessage {
  return { headers, url: '/api/auth/me' } as unknown as http.IncomingMessage;
}
function mockRes(): http.ServerResponse & { statusCode: number; body: string } {
  const r = {
    statusCode: 0, body: '', writableEnded: false, headersSent: false,
    writeHead(code: number) { r.statusCode = code; return r; },
    setHeader() {}, write() { return true; },
    end(b?: string) { r.body = b ?? ''; r.writableEnded = true; return r; },
    on() { return r; },
  };
  return r as unknown as http.ServerResponse & { statusCode: number; body: string };
}
function handlerFor(method: string, path: string) {
  const routes: Array<{ method: string; path: string; handler: (req: unknown, res: unknown, body: unknown) => unknown }> = [];
  registerSessionRoutes(createRouter(routes as never) as never, { broadcastEvent: () => {} } as never);
  return routes.find(r => r.method === method && r.path === path)!.handler;
}

beforeEach(() => {
  prevAuth = process.env.WEBSITE_AUTH_ENABLED; process.env.WEBSITE_AUTH_ENABLED = 'true';
  prevAdmin = process.env.ADMIN_USERS; process.env.ADMIN_USERS = 'jpsnover';
  warnMock.mockReset();
  infoMock.mockReset();
});
afterEach(() => {
  if (prevAuth === undefined) delete process.env.WEBSITE_AUTH_ENABLED; else process.env.WEBSITE_AUTH_ENABLED = prevAuth;
  if (prevAdmin === undefined) delete process.env.ADMIN_USERS; else process.env.ADMIN_USERS = prevAdmin;
});

describe('t/4327 — GET /api/auth/me admin + storageUserId', () => {
  it('admin principal (jpsnover) → admin:true, storageUserId present, no non-admin log', async () => {
    const res = mockRes();
    await handlerFor('GET', '/api/auth/me')(
      mockReq({ 'x-ms-client-principal-name': 'jpsnover', 'x-ms-client-principal-idp': 'github' }), res, undefined,
    );
    const body = JSON.parse(res.body);
    expect(body.admin).toBe(true);
    expect(typeof body.storageUserId).toBe('string');
    expect(infoMock).not.toHaveBeenCalled();
  });

  it('non-admin signed-in principal → admin:false, logs one INFO with derived id only (never raw principal)', async () => {
    const res = mockRes();
    await handlerFor('GET', '/api/auth/me')(
      mockReq({ 'x-ms-client-principal-name': 'jsnover15@hotmail.com', 'x-ms-client-principal-idp': 'github' }), res, undefined,
    );
    const body = JSON.parse(res.body);
    expect(body.admin).toBe(false);
    expect(infoMock).toHaveBeenCalledTimes(1);
    const [fields, message] = infoMock.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.storageUserId).toBe(body.storageUserId);
    expect(fields.reason).toBe('non_admin_signed_in');
    // Only the derived id is logged, via the same field the handler puts in the
    // response — the raw principalName header value itself is never passed to the
    // logger as a separate field. (storageUserId can still equal the raw email for
    // GitHub today — that pass-through is the root-cause bug t/4326 itself is fixing
    // in a separate phase; this ticket logs whatever deriveStorageUserId produces,
    // it doesn't re-derive or additionally log the raw header.)
    expect(Object.keys(fields).sort()).toEqual(['idp', 'reason', 'storageUserId']);
    expect(message).not.toContain('jsnover15@hotmail.com');
  });

  it('anonymous caller → admin:false, no log (not signed in)', async () => {
    const res = mockRes();
    await handlerFor('GET', '/api/auth/me')(mockReq(), res, undefined);
    const body = JSON.parse(res.body);
    expect(body.admin).toBe(false);
    expect(infoMock).not.toHaveBeenCalled();
  });

  it('logs once per process per user, not once per request', async () => {
    const req = () => mockReq({ 'x-ms-client-principal-name': 'someone@example.com', 'x-ms-client-principal-idp': 'github' });
    await handlerFor('GET', '/api/auth/me')(req(), mockRes(), undefined);
    await handlerFor('GET', '/api/auth/me')(req(), mockRes(), undefined);
    await handlerFor('GET', '/api/auth/me')(req(), mockRes(), undefined);
    expect(infoMock).toHaveBeenCalledTimes(1);
  });
});
