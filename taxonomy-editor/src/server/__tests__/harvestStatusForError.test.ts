// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4184 GV follow-up (TL, p/775#56): the /api/harvest routes hardcoded 500 on any thrown error,
// so a WRITE_CONFLICT from fileIO's write paths never surfaced as 409 the way routes/taxonomy.ts's
// does. All six handlers now route through statusForError/codeForError.

import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { ActionableError } from '../../../../lib/debate/errors.js';

vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

const { harvestCreateConflictSpy } = vi.hoisted(() => ({ harvestCreateConflictSpy: vi.fn() }));
vi.mock('../storage/fileIO.js', () => ({
  harvestCreateConflict: harvestCreateConflictSpy,
  harvestAddDebateRef: vi.fn(),
  harvestUpdateSteelman: vi.fn(),
  harvestAddVerdict: vi.fn(),
  harvestQueueConcept: vi.fn(),
  harvestSaveManifest: vi.fn(),
}));

import { registerHarvestRoutes } from '../routes/harvest.js';
import type { ServerCtx } from '../routes/context.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void> | void;

function makeRouter() {
  const handlers: Record<string, Handler> = {};
  const reg = (m: string) => (p: string, h: Handler) => { handlers[`${m} ${p}`] = h; };
  return { router: { get: reg('GET'), put: reg('PUT'), post: reg('POST'), patch: reg('PATCH'), del: reg('DELETE') }, handlers };
}

function fakeRes() {
  const res: Record<string, unknown> = {
    writableEnded: false, headersSent: false, _statusCode: 200, _body: undefined,
    writeHead: vi.fn((code: number) => { res._statusCode = code; res.headersSent = true; }),
    end: vi.fn((b?: string) => { res._body = b !== undefined ? JSON.parse(b) : undefined; res.writableEnded = true; }),
    setHeader: vi.fn(),
  };
  return res as unknown as ServerResponse & { _body: Record<string, unknown>; _statusCode: number };
}

function registerAndGetHandlers() {
  const r = makeRouter();
  registerHarvestRoutes(r.router as never, {
    ensureSessionBranch: vi.fn(async () => undefined),
    invalidateConflictsCache: vi.fn(),
  } as unknown as ServerCtx);
  return r.handlers;
}

describe('POST /api/harvest/conflict error mapping (t/4184 GV)', () => {
  it('a WRITE_CONFLICT ActionableError (httpStatus 409, code set) surfaces as 409 with the code', async () => {
    const handlers = registerAndGetHandlers();
    harvestCreateConflictSpy.mockRejectedValueOnce(
      new ActionableError({
        goal: 'Create harvested conflict', problem: 'stale base version', location: 'test',
        nextSteps: [], httpStatus: 409, code: 'WRITE_CONFLICT',
      }),
    );
    const res = fakeRes();
    await handlers['POST /api/harvest/conflict']({} as IncomingMessage, res, {});
    expect(res._statusCode).toBe(409);
    expect(res._body.code).toBe('WRITE_CONFLICT');
  });

  it('an ordinary error still surfaces as 500 (no regression)', async () => {
    const handlers = registerAndGetHandlers();
    harvestCreateConflictSpy.mockRejectedValueOnce(new Error('disk full'));
    const res = fakeRes();
    await handlers['POST /api/harvest/conflict']({} as IncomingMessage, res, {});
    expect(res._statusCode).toBe(500);
  });
});
