// @vitest-environment node
//
// t/1821 — PUT /api/edges: the whole-file atomic edge save (saveEdges bridge path,
// t/1816). Drives the real handler through a captured Router + a minimal req/res so
// the real httpKit json()/error() path runs. fileIO.writeEdgesFile is mocked (spy)
// so the test asserts the atomic write is invoked with the body on a valid save and
// that malformed input is rejected 400 with NO write (AC#3: safe on malformed input).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const { writeEdgesFileMock, readBaselineMock } = vi.hoisted(() => ({
  writeEdgesFileMock: vi.fn(async () => ({ version: 'new-sha' })),
  // The write-baseline read (t/2957): default to a genuinely-empty baseline (nothing to restore).
  // 'absent' is ABSENT_BASELINE; a rejecting impl models a read/parse failure (must refuse, no write).
  readBaselineMock: vi.fn(async (): Promise<unknown> => ({ edges: [] })),
}));

const TEST_BASE_SHA = 'test-base-sha';

// Partial mock: override the two edge fileIO calls, keep everything else real.
vi.mock('../storage/fileIO.js', async (importActual) => {
  const actual = await importActual<typeof import('../storage/fileIO.js')>();
  return { ...actual, writeEdgesFile: writeEdgesFileMock, readEdgesForSaveBaseline: readBaselineMock };
});

import type { ServerCtx } from '../routes/context.js';
import { createRouter, type Handler } from '../httpKit.js';
import { registerEdgesRoutes } from '../routes/edges.js';

interface InvokeResult { status: number; body: unknown }

async function putEdges(body: unknown, headers: Record<string, string> = { 'if-match': `"${TEST_BASE_SHA}"` }): Promise<InvokeResult> {
  const routes: { method: string; path: string; handler: Handler }[] = [];
  registerEdgesRoutes(createRouter(routes), {} as ServerCtx);
  const route = routes.find(r => r.path === '/api/edges' && r.method === 'PUT');
  if (!route) throw new Error('PUT /api/edges route not registered');

  const req = { url: '/api/edges', method: 'PUT', headers, socket: {} } as unknown as IncomingMessage;
  const result: InvokeResult = { status: 200, body: undefined };
  const res = {
    writableEnded: false, headersSent: false,
    setHeader() {}, getHeader() { return undefined; },
    writeHead(s: number) { result.status = s; this.headersSent = true; return this; },
    end(b?: string) { result.body = b ? JSON.parse(b) : undefined; this.writableEnded = true; },
  } as unknown as ServerResponse;

  await route.handler(req, res, body);
  return result;
}

describe('PUT /api/edges — whole-file edge save (t/1821)', () => {
  beforeEach(() => {
    writeEdgesFileMock.mockClear();
    readBaselineMock.mockReset();
    readBaselineMock.mockResolvedValue({ edges: [] }); // default: empty baseline, nothing to restore
  });

  it('persists a valid EdgesFile body via the atomic writeEdgesFile', async () => {
    const file = { edges: [{ source: 'a', target: 'b', type: 'supports', status: 'proposed' }] };
    const res = await putEdges(file);
    expect(res.status).toBe(200);
    expect(writeEdgesFileMock).toHaveBeenCalledTimes(1);
    expect(writeEdgesFileMock).toHaveBeenCalledWith(file, { baseSha: TEST_BASE_SHA });
  });

  it('accepts an empty edges array (valid whole-file save)', async () => {
    const res = await putEdges({ edges: [] });
    expect(res.status).toBe(200);
    expect(writeEdgesFileMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a null body with 400 and does NOT write', async () => {
    const res = await putEdges(null);
    expect(res.status).toBe(400);
    expect(writeEdgesFileMock).not.toHaveBeenCalled();
  });

  it('rejects a body with no edges array with 400 and does NOT write', async () => {
    const res = await putEdges({ notEdges: true });
    expect(res.status).toBe(400);
    expect(writeEdgesFileMock).not.toHaveBeenCalled();
  });

  it('rejects a body whose edges is not an array with 400 and does NOT write', async () => {
    const res = await putEdges({ edges: 'nope' });
    expect(res.status).toBe(400);
    expect(writeEdgesFileMock).not.toHaveBeenCalled();
  });

  // t/4189: the If-Match precondition — a missing header means the client never loaded
  // a version to protect, so the route refuses (428) rather than writing unguarded.
  it('rejects a save with no If-Match header with 428 BASE_VERSION_REQUIRED and does NOT write', async () => {
    const res = await putEdges({ edges: [] }, {});
    expect(res.status).toBe(428);
    expect((res.body as { error?: string } | undefined)?.error).toMatch(/If-Match/);
    expect(writeEdgesFileMock).not.toHaveBeenCalled();
  });
});

describe('PUT /api/edges — rationale re-merge on save (t/2957)', () => {
  const key = { source: 'a', type: 'SUPPORTS', target: 'b' };
  beforeEach(() => {
    writeEdgesFileMock.mockClear();
    readBaselineMock.mockReset();
  });

  it('REPRO: a stripped whole-file save restores rationale from the on-disk baseline before writing', async () => {
    // The editor loaded the list rationale-stripped; the save payload has no rationale.
    readBaselineMock.mockResolvedValue({ edges: [{ ...key, confidence: 0.9, rationale: 'ON-DISK rationale', model: 'm', discovered_at: 't1' }] });
    const strippedBody = { edges: [{ ...key, confidence: 0.9, model: 'm', discovered_at: 't1' }] };
    const res = await putEdges(strippedBody);
    expect(res.status).toBe(200);
    expect(writeEdgesFileMock).toHaveBeenCalledTimes(1);
    const written = writeEdgesFileMock.mock.calls[0][0] as { edges: Record<string, unknown>[] };
    expect(written.edges[0].rationale).toBe('ON-DISK rationale'); // NOT wiped
  });

  it('BLOCKER arm 1 — genuine absence (ABSENT_BASELINE): first write persists the payload as-is', async () => {
    readBaselineMock.mockResolvedValue('absent'); // ABSENT_BASELINE — no edges.json yet
    const body = { edges: [{ ...key, rationale: 'fresh', model: 'm', discovered_at: 't1' }] };
    const res = await putEdges(body);
    expect(res.status).toBe(200);
    expect(writeEdgesFileMock).toHaveBeenCalledTimes(1);
    expect(writeEdgesFileMock).toHaveBeenCalledWith(body, { baseSha: TEST_BASE_SHA });
  });

  it('BLOCKER arm 2 — a read/parse FAILURE refuses the save with 500 and writes NOTHING (never a stripped write)', async () => {
    readBaselineMock.mockRejectedValue(new Error('EACCES: permission denied')); // transient read error, NOT absence
    const res = await putEdges({ edges: [{ ...key, model: 'm', discovered_at: 't1' }] });
    expect(res.status).toBe(500);
    expect(writeEdgesFileMock).not.toHaveBeenCalled();
  });

  it('BLOCKER arm 2b — a malformed baseline object refuses with 500 and writes NOTHING', async () => {
    readBaselineMock.mockResolvedValue({ edges: 'not-an-array' }); // corrupt parse result reaching the util
    const res = await putEdges({ edges: [{ ...key, model: 'm', discovered_at: 't1' }] });
    expect(res.status).toBe(500);
    expect(writeEdgesFileMock).not.toHaveBeenCalled();
  });
});
