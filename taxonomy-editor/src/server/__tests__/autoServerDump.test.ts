// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3049 — POST /api/flight-recorder/dump with a dumpId auto-writes the
// paired server FR dump and returns serverDumpWritten in the response.
// Verifies: (1) both writeDump calls fire (client + server), (2) server-dump
// failure is non-fatal — client dump still returns 200 with serverDumpWritten: false.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

// ── Mocks ──

let recordedEvents: unknown[] = [];
vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: () => ({ record: (ev: unknown) => { recordedEvents.push(ev); } }),
}));

const writeDump = vi.fn();
const isValidDumpId = vi.fn(() => true);
vi.mock('../flightRecorderDumps.js', () => ({
  writeDump: (...a: unknown[]) => writeDump(...a),
  isValidDumpId: (id: unknown) => isValidDumpId(id),
  readMergedDump: vi.fn(),
}));

vi.mock('../config.js', () => ({
  getDataRoot: () => '/fake/data',
  getStateRoot: () => '/fake/state',
  getProjectRoot: () => '/fake/project',
  STORAGE_MODE: 'local',
}));

vi.mock('../community/community.js', () => ({ isAdmin: () => false }));
vi.mock('../storage/fileIO.js', () => ({
  loadDictionary: vi.fn(),
  getTaxonomyDir: () => '/fake/taxonomy',
  resolveDataPath: () => '/fake/taxonomy',
  buildNodeSourceIndex: vi.fn(),
  isSafeId: vi.fn(() => true),
}));
vi.mock('../../../../lib/embeddings/onnxEmbedding.js', () => ({
  getWarmupStatus: vi.fn(() => ({ ready: false })),
  computeEmbedding: vi.fn(),
}));
vi.mock('../flightRecorderViewer.js', () => ({ escapeForInlineScript: (s: string) => s }));
vi.mock('../security/accessControl.js', () => ({ clientSafeMessage: (s: string) => s }));
vi.mock('../security/userContext.js', () => ({ getSessionBranchName: () => 'test-branch' }));
vi.mock('../routes/sessionScopedDump.js', () => ({ filterSessionEvents: (ndjson: string) => ndjson }));
vi.mock('../logger.js', () => ({
  getRequestId: () => 'req-test',
  log: { fr: { info: vi.fn() } },
  writeFramedNdjson: vi.fn(),
  LOG_MAX_LINE_BYTES: 65536,
}));

import { registerDiagnosticsRoutes } from '../routes/diagnostics.js';

// ── Helpers ──

type Handler = (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void> | void;

function makeRouter() {
  const handlers: Record<string, Handler> = {};
  const reg = (m: string) => (p: string, h: Handler) => { handlers[`${m} ${p}`] = h; };
  return {
    router: { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), del: reg('DELETE') },
    handlers,
  };
}

function fakeRes() {
  const res: Record<string, unknown> = {
    writableEnded: false,
    headersSent: false,
    _body: undefined as unknown,
    writeHead: vi.fn(),
    end: vi.fn((b?: string) => {
      res._body = b !== undefined ? JSON.parse(b) : undefined;
      res.writableEnded = true;
      res.headersSent = true;
    }),
    setHeader: vi.fn(),
  };
  return res as unknown as ServerResponse & { _body: Record<string, unknown> };
}

const DUMP_ID = 'test-dump-id-123';
const CLIENT_NDJSON = '{"seq":1}\n';
const SERVER_NDJSON = '{"seq":2}\n';

function makeCtx() {
  return {
    serverRecorder: { buildDump: vi.fn(() => ({ ndjson: SERVER_NDJSON })) },
    appendServerLogs: vi.fn((s: string) => s),
  } as unknown as Parameters<typeof registerDiagnosticsRoutes>[1];
}

// ── Tests ──

describe('POST /api/flight-recorder/dump — auto-server-dump (t/3049)', () => {
  let dumpHandler: Handler;
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    recordedEvents = [];
    writeDump.mockResolvedValue('/fake/data/dumps/client-test-dump-id-123.jsonl');
    isValidDumpId.mockReturnValue(true);
    ctx = makeCtx();
    const { router, handlers } = makeRouter();
    registerDiagnosticsRoutes(router as never, ctx);
    dumpHandler = handlers['POST /api/flight-recorder/dump'];
  });

  it('writes client + server dumps and returns serverDumpWritten: true', async () => {
    const res = fakeRes();
    await dumpHandler({} as IncomingMessage, res, { ndjson: CLIENT_NDJSON, dumpId: DUMP_ID });

    expect(writeDump).toHaveBeenCalledTimes(2);
    // t/4372 (t/4264): flight-recorder dumps are class-A writable state — getStateRoot(), never
    // getDataRoot() (a staging deployment sharing /mnt/shared must not write dumps onto prod's share).
    expect(writeDump).toHaveBeenCalledWith('/fake/state', 'client', DUMP_ID, CLIENT_NDJSON);
    expect(writeDump).toHaveBeenCalledWith('/fake/state', 'server', DUMP_ID, SERVER_NDJSON);
    expect(res._body).toMatchObject({ dumpId: DUMP_ID, serverDumpWritten: true });
  });

  it('returns serverDumpWritten: false and emits FR event when server dump write fails', async () => {
    writeDump
      .mockResolvedValueOnce('/fake/data/dumps/client-test-dump-id-123.jsonl') // client ok
      .mockRejectedValueOnce(new Error('backend write failed'));                // server fails

    const res = fakeRes();
    await dumpHandler({} as IncomingMessage, res, { ndjson: CLIENT_NDJSON, dumpId: DUMP_ID });

    expect(res._body).toMatchObject({ dumpId: DUMP_ID, serverDumpWritten: false });
    expect(recordedEvents).toHaveLength(1);
    expect(recordedEvents[0]).toMatchObject({ message: 'fr.auto_server_dump.failed', data: { dumpId: DUMP_ID } });
  });
});
