// @vitest-environment node

/**
 * t/1362 — the centralized error() helper must log every 5xx at error level via
 * Pino, so server 500s are visible in `az containerapp logs show` without a
 * browser-triggered flight-recorder dump.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ServerResponse } from 'http';
import { error, json, withEndpointTimeout, statusForError, codeForError } from '../httpKit.js';
import { log } from '../logger.js';
import { setGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import type { FlightRecorder, RecordInput } from '../../../../lib/flight-recorder/flightRecorder.js';
import { ActionableError } from '../../../../lib/debate/errors.js';

function fakeRes(method = 'GET', routePath = '/api/test'): ServerResponse {
  return {
    writeHead: vi.fn(), end: vi.fn(), setHeader: vi.fn(),
    req: { method }, __routePath: routePath,
  } as unknown as ServerResponse;
}

/** fakeRes with controllable already-sent flags (t/1515 idempotency + timeout guard). */
function stateRes(opts: { writableEnded?: boolean; headersSent?: boolean } = {}): ServerResponse {
  return {
    writeHead: vi.fn(), end: vi.fn(), setHeader: vi.fn(),
    req: { method: 'POST' }, __routePath: '/api/test',
    writableEnded: opts.writableEnded ?? false,
    headersSent: opts.headersSent ?? false,
  } as unknown as ServerResponse;
}
const wroteStatus = (res: ServerResponse, status: number) =>
  (res.writeHead as unknown as ReturnType<typeof vi.fn>).mock.calls.some(c => c[0] === status);

describe('httpKit error() Pino safety net (t/1362)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs at error level for a 5xx so the 500 is visible in container logs', () => {
    const spy = vi.spyOn(log.server, 'error').mockImplementation(() => {});
    error(fakeRes(), 'kaboom', 500, new Error('kaboom'));
    expect(spy).toHaveBeenCalledTimes(1);
    const [ctx, msg] = spy.mock.calls[0] as [Record<string, unknown>, string];
    expect(ctx.status).toBe(500);
    expect(String(msg)).toContain('kaboom');
  });

  it('does NOT error-log for a <500 response (client errors are not server faults)', () => {
    const spy = vi.spyOn(log.server, 'error').mockImplementation(() => {});
    error(fakeRes(), 'not found', 404);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('httpKit error() 4xx flight-recorder correlation (t/1379)', () => {
  afterEach(() => { setGlobalRecorder(null as unknown as FlightRecorder); vi.restoreAllMocks(); });

  it('records a 4xx to the FR at warn with method/path/status/requestId/errorMessage', () => {
    const records: RecordInput[] = [];
    setGlobalRecorder({ record: (e: RecordInput) => records.push(e) } as unknown as FlightRecorder);
    error(fakeRes('POST', '/api/debates/:id/news-report'), 'A synthesis must exist', 400);
    const evt = records.find(r => r.type === 'lifecycle' && (r.data as Record<string, unknown>)?.status === 400);
    expect(evt).toBeDefined();
    expect(evt!.level).toBe('warn');
    const data = evt!.data as Record<string, unknown>;
    expect(data.method).toBe('POST');
    expect(data.path).toBe('/api/debates/:id/news-report');
    expect(data.errorMessage).toBe('A synthesis must exist');
    expect('requestId' in data).toBe(true);
  });

  it('does NOT emit the lifecycle 4xx event for a 5xx (that uses the system.error path)', () => {
    const records: RecordInput[] = [];
    setGlobalRecorder({ record: (e: RecordInput) => records.push(e) } as unknown as FlightRecorder);
    error(fakeRes('GET', '/api/x'), 'boom', 500, new Error('boom'));
    expect(records.find(r => r.type === 'lifecycle')).toBeUndefined();
  });
});

describe('httpKit idempotent writes (t/1515)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('json() no-ops when the response already ended — no write-after-end', () => {
    const res = stateRes({ writableEnded: true });
    const warn = vi.spyOn(log.server, 'warn').mockImplementation(() => {});
    json(res, { ok: true });
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('error() no-ops (and does not re-log the 5xx) when headers already sent', () => {
    const res = stateRes({ headersSent: true });
    const errSpy = vi.spyOn(log.server, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(log.server, 'warn').mockImplementation(() => {});
    error(res, 'boom', 500, new Error('boom'));
    expect(errSpy).not.toHaveBeenCalled();      // bailed before the t/1362 5xx log
    expect(warnSpy).toHaveBeenCalled();          // logged the skip instead
    expect(res.writeHead).not.toHaveBeenCalled();
  });
});

// ── t/4185: write-conflict ActionableError → HTTP 409 + machine-readable code ──
function bodyOf(res: ServerResponse): Record<string, unknown> {
  const call = (res.end as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
  return JSON.parse(call[0] as string) as Record<string, unknown>;
}

describe('statusForError (t/4185)', () => {
  it('ActionableError with httpStatus set → that status', () => {
    const err = new ActionableError({ goal: 'g', problem: 'p', location: 'l', nextSteps: [] });
    err.httpStatus = 409;
    expect(statusForError(err)).toBe(409);
  });

  it('ActionableError without httpStatus → the fallback (default 500)', () => {
    const err = new ActionableError({ goal: 'g', problem: 'p', location: 'l', nextSteps: [] });
    expect(statusForError(err)).toBe(500);
  });

  it('a plain Error (not ActionableError) → the fallback, never guesses a status from message text', () => {
    expect(statusForError(new Error('conflict'))).toBe(500);
  });

  it('a custom fallback is honored when no httpStatus is set', () => {
    expect(statusForError(new Error('x'), 400)).toBe(400);
  });
});

describe('codeForError (t/4185)', () => {
  it('ActionableError with code set → { code }', () => {
    const err = new ActionableError({ goal: 'g', problem: 'p', location: 'l', nextSteps: [] });
    (err as unknown as { code: string }).code = 'WRITE_CONFLICT';
    expect(codeForError(err)).toEqual({ code: 'WRITE_CONFLICT' });
  });

  it('ActionableError without code → undefined (no stray code:undefined key)', () => {
    const err = new ActionableError({ goal: 'g', problem: 'p', location: 'l', nextSteps: [] });
    expect(codeForError(err)).toBeUndefined();
  });

  it('a plain Error → undefined', () => {
    expect(codeForError(new Error('x'))).toBeUndefined();
  });
});

describe('error() end-to-end: write-conflict maps to 409 + code, including in production (t/4185)', () => {
  const ORIG_ENV = process.env.NODE_ENV;
  afterEach(() => { vi.restoreAllMocks(); process.env.NODE_ENV = ORIG_ENV; });

  it('409 + code survive the <500 branch in development', () => {
    process.env.NODE_ENV = 'development';
    const res = fakeRes('PUT', '/api/taxonomy/:pov');
    const err = new ActionableError({ goal: 'Save the taxonomy write', problem: 'SHA conflict', location: 'x', nextSteps: ['retry'] });
    err.httpStatus = 409;
    (err as unknown as { code: string }).code = 'WRITE_CONFLICT';
    error(res, String(err), statusForError(err), err, codeForError(err));
    expect(wroteStatus(res, 409)).toBe(true);
    expect(bodyOf(res).code).toBe('WRITE_CONFLICT');
  });

  it('409 + code survive the <500 branch in production too (t/853 only strips internals, not code)', () => {
    process.env.NODE_ENV = 'production';
    const res = fakeRes('PUT', '/api/taxonomy/:pov');
    const err = new ActionableError({ goal: 'Save the taxonomy write', problem: 'SHA conflict', location: 'x', nextSteps: ['retry'] });
    err.httpStatus = 409;
    (err as unknown as { code: string }).code = 'WRITE_CONFLICT';
    error(res, String(err), statusForError(err), err, codeForError(err));
    expect(wroteStatus(res, 409)).toBe(true);
    expect(bodyOf(res).code).toBe('WRITE_CONFLICT');
  });

  it('an ordinary unexpected error (no httpStatus) still gets 500 — no regression', () => {
    const res = fakeRes('PUT', '/api/taxonomy/:pov');
    const err = new Error('disk full');
    error(res, String(err), statusForError(err), err, codeForError(err));
    expect(wroteStatus(res, 500)).toBe(true);
    expect(bodyOf(res).code).toBeUndefined();
  });
});

describe('withEndpointTimeout (t/1515/t/1516)', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('clears the guard when fn resolves first — no 504, only the handler response', async () => {
    vi.useFakeTimers();
    const res = stateRes();
    await withEndpointTimeout(res, 1000, 'test', async () => { json(res, { ok: true }); });
    vi.advanceTimersByTime(5000);
    expect(wroteStatus(res, 200)).toBe(true);
    expect(wroteStatus(res, 504)).toBe(false);
  });

  it('fires a structured 504 when fn hangs past the timeout', async () => {
    vi.useFakeTimers();
    vi.spyOn(log.server, 'error').mockImplementation(() => {});
    const res = stateRes();
    let release: () => void = () => {};
    const p = withEndpointTimeout(res, 1000, 'nli-classify', () => new Promise<void>((r) => { release = r; }));
    vi.advanceTimersByTime(1000);
    expect(wroteStatus(res, 504)).toBe(true);
    release(); await p;
  });

  it('does not respond if the socket already closed at timeout (client abort)', async () => {
    vi.useFakeTimers();
    const res = stateRes({ writableEnded: true });
    let release: () => void = () => {};
    const p = withEndpointTimeout(res, 1000, 'test', () => new Promise<void>((r) => { release = r; }));
    vi.advanceTimersByTime(1000);
    expect(res.writeHead).not.toHaveBeenCalled();
    release(); await p;
  });
});
