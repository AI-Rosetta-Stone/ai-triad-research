// @vitest-environment node
//
// t/4055 — GET /api/pov-tag-proposals + POST /api/pov-tag-proposals/review.
// Tests HTTP behaviour (status codes, response shapes, 405 guard) against a mocked
// storage backend; lib correctness (applyProposalDecision, byte round-trip) is
// covered in lib/schema/__tests__.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import path from 'path';
import { ActionableError } from '../../../../lib/debate/errors.js';

const FAKE_TAX_DIR = '/fake/taxonomy';
const PROPOSALS_PATH = path.join(FAKE_TAX_DIR, 'pov-tag-proposals.json');

const { readFileMock, readFileWithVersionMock, writeFileMock, recordMock, getCurrentUserIdMock } = vi.hoisted(() => ({
  readFileMock: vi.fn<[string, ({ optional?: boolean } | undefined)?], Promise<string | null>>(),
  readFileWithVersionMock: vi.fn<[string], Promise<{ content: string; version: string } | null>>(),
  writeFileMock: vi.fn<[string, string, ({ baseSha?: string } | undefined)?], Promise<void>>(),
  recordMock: vi.fn(),
  getCurrentUserIdMock: vi.fn<[], string>(),
}));

vi.mock('../storage/fileIO.js', () => ({
  getTaxonomyDir: () => FAKE_TAX_DIR,
  getBackend: () => ({ readFile: readFileMock, writeFile: writeFileMock }),
  readFileWithVersionOrFallback: readFileWithVersionMock,
}));
vi.mock('../security/userContext.js', () => ({ getCurrentUserId: getCurrentUserIdMock }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: recordMock }) }));

import type { ServerCtx } from '../routes/context.js';
import { createRouter } from '../httpKit.js';
import { registerPovTagProposalsRoutes } from '../routes/povTagProposals.js';
import { serializePovTagProposals, type PovTagProposalsFile } from '../../../../lib/schema/povTagProposals.js';

// ── minimal file fixture ─────────────────────────────────────────────────────

const PROPOSAL_A = { node_id: 'acc-001', proposed: [], status: 'pending' as const, final: null, reviewed_by: null, reviewed_at: null };
const PROPOSAL_B = { node_id: 'acc-002', proposed: [], status: 'pending' as const, final: null, reviewed_by: null, reviewed_at: null };
const VALID_FILE: PovTagProposalsFile = { version: 1, proposals: [PROPOSAL_A, PROPOSAL_B] };
const VALID_RAW = serializePovTagProposals(VALID_FILE);

// ── route harness ────────────────────────────────────────────────────────────

type InvokeOpts = { method: 'GET' | 'POST'; body?: unknown; githubBackend?: object | null };

async function invoke(opts: InvokeOpts): Promise<{ status: number; body: unknown }> {
  const routes: Parameters<typeof registerPovTagProposalRoutes>[0] extends { get: infer _G } ? any[] : any[] = [];
  const router = createRouter(routes);
  const ctx = { getGithubBackend: () => opts.githubBackend ?? null } as unknown as ServerCtx;
  registerPovTagProposalsRoutes(router, ctx);

  const url = opts.method === 'POST' ? '/api/pov-tag-proposals/review' : '/api/pov-tag-proposals';
  const route = routes.find(r => r.method === opts.method && r.path === url);
  if (!route) throw new Error(`route not found: ${opts.method} ${url}`);

  const req = { url, method: opts.method, headers: {} } as unknown as IncomingMessage;
  let status = 200;
  let body: unknown;
  const res = {
    writableEnded: false,
    headersSent: false,
    req,
    writeHead(s: number) { status = s; this.headersSent = true; },
    end(b?: string) { body = b ? JSON.parse(b) : undefined; this.writableEnded = true; },
  } as unknown as ServerResponse;

  await route.handler(req, res, opts.body);
  return { status, body };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('GET /api/pov-tag-proposals (t/4055)', () => {
  beforeEach(() => { readFileMock.mockReset(); recordMock.mockReset(); });

  it('returns null when file is absent', async () => {
    readFileMock.mockResolvedValue(null);
    const { status, body } = await invoke({ method: 'GET' });
    expect(status).toBe(200);
    expect(body).toBeNull();
    expect(readFileMock).toHaveBeenCalledWith(PROPOSALS_PATH, { optional: true });
  });

  it('returns the file object when the file is valid', async () => {
    readFileMock.mockResolvedValue(VALID_RAW);
    const { status, body } = await invoke({ method: 'GET' });
    expect(status).toBe(200);
    expect((body as PovTagProposalsFile).version).toBe(1);
    expect((body as PovTagProposalsFile).proposals).toHaveLength(2);
  });

  it('returns 500 with problems on a malformed file', async () => {
    readFileMock.mockResolvedValue('{"version":1,"proposals":[{"node_id":"","proposed":"nope","status":"pending","final":null,"reviewed_by":null,"reviewed_at":null}]}');
    const { status, body } = await invoke({ method: 'GET' });
    expect(status).toBe(500);
    expect(JSON.stringify(body)).toContain('malformed');
  });
});

describe('POST /api/pov-tag-proposals/review (t/4055)', () => {
  beforeEach(() => {
    readFileWithVersionMock.mockReset();
    writeFileMock.mockReset();
    recordMock.mockReset();
    getCurrentUserIdMock.mockReturnValue('test-reviewer');
    writeFileMock.mockResolvedValue(undefined);
  });

  it('returns 405 when the GitHub backend is active (hosted profile)', async () => {
    const { status, body } = await invoke({ method: 'POST', githubBackend: {}, body: {} });
    expect(status).toBe(405);
    expect(JSON.stringify(body)).toContain('desktop app');
    expect(readFileWithVersionMock).not.toHaveBeenCalled();
  });

  it('returns 400 when nodeId is missing', async () => {
    const { status } = await invoke({ method: 'POST', body: { decision: { status: 'rejected' }, expectedStatus: 'pending' } });
    expect(status).toBe(400);
  });

  it('returns 400 when decision is missing', async () => {
    const { status } = await invoke({ method: 'POST', body: { nodeId: 'acc-001', expectedStatus: 'pending' } });
    expect(status).toBe(400);
  });

  it('returns 400 when expectedStatus is missing', async () => {
    const { status } = await invoke({ method: 'POST', body: { nodeId: 'acc-001', decision: { status: 'rejected' } } });
    expect(status).toBe(400);
  });

  it('returns 404 when file is absent', async () => {
    readFileWithVersionMock.mockResolvedValue(null);
    const { status } = await invoke({ method: 'POST', body: { nodeId: 'acc-001', decision: { status: 'rejected' }, expectedStatus: 'pending' } });
    expect(status).toBe(404);
  });

  it('returns 409 with refused:conflict on stale expectedStatus', async () => {
    readFileWithVersionMock.mockResolvedValue({ content: VALID_RAW, version: 'v1' });
    const { status, body } = await invoke({
      method: 'POST',
      body: { nodeId: 'acc-001', decision: { status: 'rejected' }, expectedStatus: 'accepted' }, // stale
    });
    expect(status).toBe(409);
    expect((body as { refused: string }).refused).toBe('conflict');
  });

  it('returns 409 with refused:invalid for unknown nodeId', async () => {
    readFileWithVersionMock.mockResolvedValue({ content: VALID_RAW, version: 'v1' });
    const { status, body } = await invoke({
      method: 'POST',
      body: { nodeId: 'does-not-exist', decision: { status: 'rejected' }, expectedStatus: 'pending' },
    });
    expect(status).toBe(409);
    expect((body as { refused: string }).refused).toBe('invalid');
  });

  it('returns 200 with { file, item } on a valid reject, and writes the file with the read baseSha (t/4332)', async () => {
    readFileWithVersionMock.mockResolvedValue({ content: VALID_RAW, version: 'v1' });
    const { status, body } = await invoke({
      method: 'POST',
      body: { nodeId: 'acc-001', decision: { status: 'rejected' }, expectedStatus: 'pending' },
    });
    expect(status).toBe(200);
    const b = body as { file: PovTagProposalsFile; item: { node_id: string; status: string; final: string[] } };
    expect(b.item.node_id).toBe('acc-001');
    expect(b.item.status).toBe('rejected');
    expect(b.item.final).toEqual([]);
    expect(b.item.reviewed_by).toBe('test-reviewer');
    expect(writeFileMock).toHaveBeenCalledWith(PROPOSALS_PATH, expect.any(String), { baseSha: 'v1' });
  });

  it('a storage WRITE_CONFLICT surfaces as 409 with its code, not a generic 500 (t/4332)', async () => {
    readFileWithVersionMock.mockResolvedValue({ content: VALID_RAW, version: 'v1' });
    writeFileMock.mockRejectedValue(new ActionableError({
      goal: 'g', problem: 'p', location: 'l', nextSteps: [], httpStatus: 409, code: 'WRITE_CONFLICT',
    }));

    const { status, body } = await invoke({
      method: 'POST',
      body: { nodeId: 'acc-001', decision: { status: 'rejected' }, expectedStatus: 'pending' },
    });

    expect(status).toBe(409);
    expect((body as { code?: string } | undefined)?.code).toBe('WRITE_CONFLICT');
  });

  it('un-reviewed item is structurally identical after a decision', async () => {
    readFileWithVersionMock.mockResolvedValue({ content: VALID_RAW, version: 'v1' });
    let writtenContent = '';
    writeFileMock.mockImplementation(async (_p, content) => { writtenContent = content; });

    await invoke({
      method: 'POST',
      body: { nodeId: 'acc-001', decision: { status: 'rejected' }, expectedStatus: 'pending' },
    });

    // acc-002 was not reviewed — its fields must be byte-for-byte unchanged.
    const written = JSON.parse(writtenContent) as PovTagProposalsFile;
    const b002 = written.proposals.find(p => p.node_id === 'acc-002');
    expect(b002).toEqual(PROPOSAL_B);
    // Confirm the written content also ends with the trailing LF (serializer contract).
    expect(writtenContent.endsWith('\n')).toBe(true);
  });
});
