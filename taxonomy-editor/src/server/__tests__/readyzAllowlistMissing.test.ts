// @vitest-environment node
// t/625 (Security p/93#100): /readyz reports 503 'allowlist-missing' while a hosted, required-auth deployment has no
// readable allowlist, so the deploy warm gate blocks promoting a misprovisioned revision. Through the real route.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const h = vi.hoisted(() => ({ missing: true }));
vi.mock('../authorizedUsers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../authorizedUsers.js')>()),
  allowlistRequiredButMissing: () => h.missing,
}));
vi.mock('../storage/dataRootReadiness.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../storage/dataRootReadiness.js')>()),
  getDataRootReadyState: () => ({ state: 'ready' }),
}));
vi.mock('../community/community.js', () => ({ isAdmin: vi.fn(() => false), getAdminUsers: vi.fn(() => []) }));
vi.mock('../eventLoopMonitor.js', () => ({ getLastEventLoopSample: vi.fn(() => null) }));

import { registerMetaRoutes } from '../routes/meta.js';
import type { ServerCtx } from '../routes/context.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void> | void;
const handlers: Record<string, Handler> = {};
const reg = (m: string) => (p: string, fn: Handler) => { handlers[`${m} ${p}`] = fn; };
registerMetaRoutes({ get: reg('GET'), put: reg('PUT'), post: reg('POST'), patch: reg('PATCH'), del: reg('DELETE') } as never, { getGithubBackend: () => null } as unknown as ServerCtx);

async function readyz(): Promise<{ status: number; body: Record<string, unknown> }> {
  const out = { status: 200, body: {} as Record<string, unknown> };
  const res = {
    writableEnded: false, headersSent: false, setHeader: vi.fn(), getHeader: vi.fn(),
    writeHead: vi.fn((c: number) => { out.status = c; }), end: vi.fn((b?: string) => { out.body = b ? JSON.parse(b) : {}; }),
  } as unknown as ServerResponse;
  await handlers['GET /readyz']({ url: '/readyz', method: 'GET', headers: {} } as IncomingMessage, res);
  return out;
}

beforeEach(() => { h.missing = true; });

describe('t/625: /readyz and a missing required allowlist', () => {
  it('reports 503 allowlist-missing while the allowlist is required but missing', async () => {
    expect(await readyz()).toEqual({ status: 503, body: { status: 'failed', reason: 'allowlist-missing' } });
  });

  it('with the allowlist present (or not required), readiness falls through to the later checks', async () => {
    h.missing = false;
    expect((await readyz()).body.reason).not.toBe('allowlist-missing');
  });
});
