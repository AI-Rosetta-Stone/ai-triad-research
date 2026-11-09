// @vitest-environment node

// t/4962: analytics exclusion query params (t/4960 AnalyticsExclusionOptions). The parser contract
// (t/4962#4, agreed with Analysis) and that both analytics GET routes pass the options through.
// includeSystem is what the staging smoke test needs to read back its own smoke-* events (t/4967).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

let adminState = false;
vi.mock('../community/community.js', () => ({ isAdmin: () => adminState }));
vi.mock('../community/admin/reviewRegistry.js', () => ({
  requireAdmin: (res: ServerResponse) => {
    if (adminState) return true;
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return false;
  },
}));
const queryAggregated = vi.fn(async () => ({ ok: true }));
const queryRawEvents = vi.fn(async () => []);
const queryEngagement = vi.fn(async () => ({ aggregate: {}, daily: [], users: [], sessions: undefined }));
const querySubjectBreakdown = vi.fn(async () => ({ rows: [] }));
vi.mock('../community/analytics.js', () => ({
  queryAggregated: (...a: unknown[]) => queryAggregated(...a),
  queryRawEvents: (...a: unknown[]) => queryRawEvents(...a),
  queryEngagement: (...a: unknown[]) => queryEngagement(...a),
  querySubjectBreakdown: (...a: unknown[]) => querySubjectBreakdown(...a),
}));

import { parseExclusionParams } from '../routes/analyticsExclusionParams.js';
import { registerSessionRoutes } from '../routes/session.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void> | void;
function handler(path: string): Handler {
  const handlers: Record<string, Handler> = {};
  const reg = (m: string) => (p: string, h: Handler) => { handlers[`${m} ${p}`] = h; };
  registerSessionRoutes({ get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), del: reg('DELETE') } as never, { broadcastEvent: () => {} } as never);
  return handlers[`GET ${path}`];
}
type Res = ServerResponse & { _status?: number; _body?: string };
function fakeRes(): Res {
  const res = {
    writeHead: vi.fn((s: number) => { res._status = s; }),
    end: vi.fn((b?: string) => { res._body = b; }),
    setHeader: vi.fn(),
  } as unknown as Res;
  return res;
}
async function get(path: string, qs: string): Promise<Res> {
  const res = fakeRes();
  await handler(path)({ url: `${path}?from=2026-11-01&to=2026-11-09${qs}`, method: 'GET', headers: {} } as unknown as IncomingMessage, res, undefined);
  return res;
}

beforeEach(() => {
  adminState = false;
  queryAggregated.mockClear(); queryRawEvents.mockClear(); queryEngagement.mockClear(); querySubjectBreakdown.mockClear();
});

describe('parseExclusionParams (t/4962#4 contract)', () => {
  const p = (qs: string) => parseExclusionParams(new URLSearchParams(qs));

  it('absent params mean every option is off', () => {
    expect(p('')).toEqual({});
  });

  it.each(['true', '1'])('%s turns an option on', (v) => {
    expect(p(`includeSystem=${v}&includeInternal=${v}&includeListed=${v}&excludeAmbiguous=${v}`))
      .toEqual({ includeSystem: true, includeInternal: true, includeListed: true, excludeAmbiguous: true });
  });

  it.each(['false', '0'])('%s leaves an option off', (v) => {
    expect(p(`includeSystem=${v}`)).toEqual({});
  });

  it.each(['yes', 'TRUE', '', '2', 'on'])('rejects %j and names the param', (v) => {
    const r = p(`includeInternal=${v}`);
    expect(r).toEqual({ invalid: expect.stringContaining('includeInternal') });
  });

  it('uses the first value when a param repeats', () => {
    expect(p('includeSystem=true&includeSystem=false')).toEqual({ includeSystem: true });
  });
});

describe('GET /api/analytics/query passes exclusion options through', () => {
  it('includeSystem=true reaches queryAggregated (the staging smoke read-back, t/4967)', async () => {
    const res = await get('/api/analytics/query', '&includeSystem=true');
    expect(res._status).toBe(200);
    expect(queryAggregated).toHaveBeenCalledWith('2026-11-01', '2026-11-09', { includeSystem: true });
  });

  it('defaults to no inclusions', async () => {
    await get('/api/analytics/query', '');
    expect(queryAggregated).toHaveBeenCalledWith('2026-11-01', '2026-11-09', {});
  });

  it('passes options to the admin raw-events branch', async () => {
    adminState = true;
    await get('/api/analytics/query', '&user=u1&includeInternal=1');
    expect(queryRawEvents).toHaveBeenCalledWith('2026-11-01', '2026-11-09', 'u1', undefined, { includeInternal: true });
  });

  it('400s on an invalid value and runs no query', async () => {
    const res = await get('/api/analytics/query', '&includeSystem=yes');
    expect(res._status).toBe(400);
    expect(queryAggregated).not.toHaveBeenCalled();
  });
});

describe('GET /api/analytics/engagement passes exclusion options through', () => {
  it('merges options into queryEngagement opts', async () => {
    await get('/api/analytics/engagement', '&includeListed=true&excludeAmbiguous=1');
    expect(queryEngagement).toHaveBeenCalledWith('2026-11-01', '2026-11-09', expect.objectContaining({ includeListed: true, excludeAmbiguous: true }));
  });

  it('passes options to the admin subject breakdown', async () => {
    adminState = true;
    await get('/api/analytics/engagement', '&subject=acc-beliefs-001&groupBy=user&includeSystem=true');
    expect(querySubjectBreakdown).toHaveBeenCalledWith('2026-11-01', '2026-11-09', 'acc-beliefs-001', 'user', undefined, { includeSystem: true });
  });

  it('400s on an invalid value and runs no query', async () => {
    const res = await get('/api/analytics/engagement', '&includeInternal=maybe');
    expect(res._status).toBe(400);
    expect(queryEngagement).not.toHaveBeenCalled();
  });
});
