// @vitest-environment node
//
// t/4039 — POST /api/policy-registry/recount.
// Tests HTTP behaviour (status codes, response shapes, auth rejection) against a mocked
// storage backend and fs. Lock-timeout correctness relies on the PS-verified protocol
// (t/4028, Enter-GroundingLock); the pure recount logic is covered in lib/policy/__tests__.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import path from 'path';
import { ActionableError } from '../../../../lib/debate/errors.js';

const FAKE_TAX_DIR = '/fake/taxonomy';
const REGISTRY_PATH = path.join(FAKE_TAX_DIR, 'policy_actions.json');

const {
  readFileWithVersionMock,
  writeFileMock,
  readTaxonomyFileMock,
  recordMock,
  isAnonymousMock,
  ensureSessionBranchMock,
  fsOpenMock,
  fsUnlinkMock,
  fsStatMock,
  scheduleOverlayCommitMock,
} = vi.hoisted(() => ({
  readFileWithVersionMock: vi.fn<[string], Promise<{ content: string; version: string } | null>>(),
  writeFileMock: vi.fn<[string, string, ({ baseSha?: string } | undefined)?], Promise<void>>(),
  readTaxonomyFileMock: vi.fn<[string], Promise<unknown>>(),
  recordMock: vi.fn(),
  isAnonymousMock: vi.fn<[], boolean>(),
  ensureSessionBranchMock: vi.fn<[], Promise<void>>(),
  fsOpenMock: vi.fn(),
  fsUnlinkMock: vi.fn<[string], Promise<void>>(),
  fsStatMock: vi.fn(),
  scheduleOverlayCommitMock: vi.fn<[string], void>(),
}));

vi.mock('../storage/fileIO.js', () => ({
  getTaxonomyDir: () => FAKE_TAX_DIR,
  getBackend: () => ({ writeFile: writeFileMock }),
  readTaxonomyFile: readTaxonomyFileMock,
  readFileWithVersionOrFallback: readFileWithVersionMock,
}));
// t/4372: the lock path is now built as path.join(getStateRoot(), path.relative(getDataRoot(),
// taxDir), 'policy_actions.lock') — FAKE_TAX_DIR must resolve as "under" these mocked roots
// (both unmocked would be the real, drive-qualified data root, which FAKE_TAX_DIR isn't under,
// breaking the relative computation) and with STATE===DATA root here (desktop/local-like), the
// lock path stays FAKE_TAX_DIR/policy_actions.lock exactly as before this change.
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, getDataRoot: () => '/fake', getStateRoot: () => '/fake' };
});
vi.mock('../storage/overlayCommitScheduler.js', () => ({ scheduleOverlayCommit: scheduleOverlayCommitMock }));
vi.mock('../security/userContext.js', () => ({ isAnonymousUser: isAnonymousMock, getCurrentUserId: () => 'tester' }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: recordMock }) }));
vi.mock('fs/promises', () => ({
  default: { open: fsOpenMock, stat: fsStatMock, unlink: fsUnlinkMock },
}));

import type { ServerCtx } from '../routes/context.js';
import { createRouter } from '../httpKit.js';
import { registerPolicyRegistryRoutes } from '../routes/policyRegistry.js';

// ── minimal registry fixture ────────────────────────────────────────────────

const POLICY_A = { id: 'pol-001', title: 'Policy A', member_count: 0, source_povs: [] };
const POLICY_B = { id: 'pol-002', title: 'Policy B', member_count: 1, source_povs: ['accelerationist'], status: 'active' };
const REGISTRY = { version: 1, policies: [POLICY_A, POLICY_B] };
const REGISTRY_RAW = JSON.stringify(REGISTRY, null, 2) + '\n';

// ── POV file fixture: pol-001 referenced once in accelerationist ─────────────

const ACC_FILE = {
  nodes: [
    { id: 'acc-001', graph_attributes: { policy_actions: [{ policy_id: 'pol-001' }] } },
  ],
};

// ── route harness ────────────────────────────────────────────────────────────

type InvokeOpts = { body?: unknown };

async function invoke(opts: InvokeOpts = {}): Promise<{ status: number; body: unknown }> {
  const routes: { method: string; path: string; handler: Function }[] = [];
  const router = createRouter(routes);
  const ctx = {
    ensureSessionBranch: ensureSessionBranchMock,
  } as unknown as ServerCtx;
  registerPolicyRegistryRoutes(router, ctx);

  const route = routes.find(r => r.method === 'POST' && r.path === '/api/policy-registry/recount');
  if (!route) throw new Error('route not found');

  const req = { url: '/api/policy-registry/recount', method: 'POST', headers: {} } as unknown as IncomingMessage;
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

// ── setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  readFileWithVersionMock.mockReset();
  writeFileMock.mockReset();
  readTaxonomyFileMock.mockReset();
  recordMock.mockReset();
  isAnonymousMock.mockReset();
  ensureSessionBranchMock.mockReset();
  fsOpenMock.mockReset();
  fsUnlinkMock.mockReset();
  fsStatMock.mockReset();
  scheduleOverlayCommitMock.mockReset();

  // Defaults: authenticated, session branch ok, lock acquires immediately
  isAnonymousMock.mockReturnValue(false);
  ensureSessionBranchMock.mockResolvedValue(undefined);
  fsOpenMock.mockResolvedValue({ close: vi.fn() });
  fsUnlinkMock.mockResolvedValue(undefined);
  // Filler node with no policy references — valid corpus, passes #3050's non-empty guard
  readTaxonomyFileMock.mockResolvedValue({ nodes: [{ id: 'fixture-filler' }] });
});

// ── tests ────────────────────────────────────────────────────────────────────

describe('POST /api/policy-registry/recount (t/4039)', () => {
  it('returns 403 for anonymous users', async () => {
    isAnonymousMock.mockReturnValue(true);
    const { status } = await invoke({ body: { ids: ['pol-001'] } });
    expect(status).toBe(403);
    expect(readFileWithVersionMock).not.toHaveBeenCalled();
  });

  it('returns 400 when ids is not an array', async () => {
    const { status } = await invoke({ body: { ids: 'pol-001' } });
    expect(status).toBe(400);
  });

  it('returns 400 when ids contains a non-string', async () => {
    const { status } = await invoke({ body: { ids: ['pol-001', 42] } });
    expect(status).toBe(400);
  });

  it('returns 400 when body is missing ids', async () => {
    const { status } = await invoke({ body: {} });
    expect(status).toBe(400);
  });

  it('returns 404 when policy_actions.json is absent', async () => {
    readFileWithVersionMock.mockResolvedValue(null);
    const { status } = await invoke({ body: { ids: ['pol-001'] } });
    expect(status).toBe(404);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('returns { status: unchanged } when recount changes nothing', async () => {
    // pol-002 has member_count:1, source_povs:['acc'] — feed it the same data
    const acc = { nodes: [{ id: 'acc-001', graph_attributes: { policy_actions: [{ policy_id: 'pol-002' }] } }] };
    readFileWithVersionMock.mockResolvedValue({ content: REGISTRY_RAW, version: 'v1' });
    readTaxonomyFileMock.mockImplementation(async (pov: string) => pov === 'accelerationist' ? acc : { nodes: [{ id: 'fixture-filler' }] });

    const { status, body } = await invoke({ body: { ids: ['pol-002'] } });

    expect(status).toBe(200);
    expect((body as { status: string }).status).toBe('unchanged');
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(scheduleOverlayCommitMock).not.toHaveBeenCalled();
  });

  it('returns { status: written, updated } and writes the file when counts change', async () => {
    readFileWithVersionMock.mockResolvedValue({ content: REGISTRY_RAW, version: 'v1' });
    readTaxonomyFileMock.mockImplementation(async (pov: string) =>
      pov === 'accelerationist' ? ACC_FILE : { nodes: [{ id: 'fixture-filler' }] },
    );
    writeFileMock.mockResolvedValue(undefined);

    const { status, body } = await invoke({ body: { ids: ['pol-001'] } });
    const b = body as { status: string; updated: { id: string; member_count: number; source_povs: string[] }[] };

    expect(status).toBe(200);
    expect(b.status).toBe('written');
    expect(b.updated).toHaveLength(1);
    expect(b.updated[0].id).toBe('pol-001');
    expect(b.updated[0].member_count).toBe(1);
    expect(b.updated[0].source_povs).toEqual(['accelerationist']);
    expect(writeFileMock).toHaveBeenCalledWith(REGISTRY_PATH, expect.stringMatching(/^\{/), { baseSha: 'v1' });
    // Written content must end with a trailing LF (serializePolicyRegistry contract)
    const written = writeFileMock.mock.calls[0][1] as string;
    expect(written.endsWith('\n')).toBe(true);
  });

  it('schedules an overlay commit after a successful write (t/4258/t/4276 C3: no commit otherwise)', async () => {
    readFileWithVersionMock.mockResolvedValue({ content: REGISTRY_RAW, version: 'v1' });
    readTaxonomyFileMock.mockImplementation(async (pov: string) =>
      pov === 'accelerationist' ? ACC_FILE : { nodes: [{ id: 'fixture-filler' }] },
    );
    writeFileMock.mockResolvedValue(undefined);

    await invoke({ body: { ids: ['pol-001'] } });

    expect(scheduleOverlayCommitMock).toHaveBeenCalledWith('tester');
    expect(scheduleOverlayCommitMock).toHaveBeenCalledTimes(1);
  });

  it('does not schedule an overlay commit when the write throws', async () => {
    readFileWithVersionMock.mockResolvedValue({ content: REGISTRY_RAW, version: 'v1' });
    readTaxonomyFileMock.mockImplementation(async (pov: string) =>
      pov === 'accelerationist' ? ACC_FILE : { nodes: [{ id: 'fixture-filler' }] },
    );
    writeFileMock.mockRejectedValue(new Error('disk full'));

    await invoke({ body: { ids: ['pol-001'] } });

    expect(scheduleOverlayCommitMock).not.toHaveBeenCalled();
  });

  it('releases the lock (unlinks the lock file) after a successful write', async () => {
    readFileWithVersionMock.mockResolvedValue({ content: REGISTRY_RAW, version: 'v1' });
    readTaxonomyFileMock.mockImplementation(async (pov: string) =>
      pov === 'accelerationist' ? ACC_FILE : { nodes: [{ id: 'fixture-filler' }] },
    );
    writeFileMock.mockResolvedValue(undefined);

    await invoke({ body: { ids: ['pol-001'] } });

    expect(fsUnlinkMock).toHaveBeenCalledWith(path.join(FAKE_TAX_DIR, 'policy_actions.lock'));
  });

  it('releases the lock even when the write throws', async () => {
    readFileWithVersionMock.mockResolvedValue({ content: REGISTRY_RAW, version: 'v1' });
    readTaxonomyFileMock.mockImplementation(async (pov: string) =>
      pov === 'accelerationist' ? ACC_FILE : { nodes: [{ id: 'fixture-filler' }] },
    );
    writeFileMock.mockRejectedValue(new Error('disk full'));

    const { status } = await invoke({ body: { ids: ['pol-001'] } });

    expect(status).toBe(500);
    expect(fsUnlinkMock).toHaveBeenCalled();
  });

  it('proceeds without a lock when the lock directory is not writable (ENOENT)', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    fsOpenMock.mockRejectedValue(enoent);
    readFileWithVersionMock.mockResolvedValue({ content: REGISTRY_RAW, version: 'v1' });
    readTaxonomyFileMock.mockImplementation(async (pov: string) =>
      pov === 'accelerationist' ? ACC_FILE : { nodes: [{ id: 'fixture-filler' }] },
    );
    writeFileMock.mockResolvedValue(undefined);

    const { status, body } = await invoke({ body: { ids: ['pol-001'] } });

    expect(status).toBe(200);
    expect((body as { status: string }).status).toBe('written');
    expect(fsUnlinkMock).not.toHaveBeenCalled(); // onDisk === false → no unlink
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', message: expect.stringContaining('lock unavailable') }));
  });

  it('returns 500 (fail closed) when a POV file read throws', async () => {
    // A transient error (GitHub 5xx, rate limit) must not silently produce zeroed counts (p/575#47)
    readFileWithVersionMock.mockResolvedValue({ content: REGISTRY_RAW, version: 'v1' });
    readTaxonomyFileMock.mockRejectedValue(new Error('GitHub 503'));
    writeFileMock.mockResolvedValue(undefined);

    const { status } = await invoke({ body: { ids: ['pol-001'] } });

    expect(status).toBe(500);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('returns 500 (fail closed) when a POV file reads successfully but is empty (#3050 guard)', async () => {
    // SO e/274#2, #7: a fallback that substitutes { nodes: [] } for a failed read must be refused
    // by the lib's completeness guard, never written as member_count: 0 (the #3048 defect).
    readFileWithVersionMock.mockResolvedValue({ content: REGISTRY_RAW, version: 'v1' });
    readTaxonomyFileMock.mockImplementation(async (pov: string) =>
      pov === 'safetyist' ? { nodes: [] } : pov === 'accelerationist' ? ACC_FILE : { nodes: [{ id: 'fixture-filler' }] });
    writeFileMock.mockResolvedValue(undefined);

    const { status } = await invoke({ body: { ids: ['pol-001', 'pol-002'] } });

    expect(status).toBe(500);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('returns { status: refused, reason: locked, updated: [] } when lock times out', async () => {
    // Simulate lock always held with a fresh mtime (not stale)
    const eexist = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    fsOpenMock.mockRejectedValue(eexist);
    fsStatMock.mockResolvedValue({ mtimeMs: Date.now() }); // fresh — not stale

    // LOCK_TIMEOUT_MS is 60 000 ms. Fake timers advance it.
    vi.useFakeTimers();
    const invokePromise = invoke({ body: { ids: ['pol-001'] } });
    // Advance past the 60 s timeout plus one poll interval
    await vi.advanceTimersByTimeAsync(61_000);
    const { status, body } = await invokePromise;
    vi.useRealTimers();

    expect(status).toBe(200);
    const b = body as { status: string; reason: string; updated: unknown[] };
    expect(b.status).toBe('refused');
    expect(b.reason).toBe('locked');
    expect(b.updated).toEqual([]);
    expect(readFileWithVersionMock).not.toHaveBeenCalled(); // no lock-free read
  });

  it('a storage WRITE_CONFLICT surfaces as 409 with its code, not a generic 500 (t/4332)', async () => {
    readFileWithVersionMock.mockResolvedValue({ content: REGISTRY_RAW, version: 'v1' });
    readTaxonomyFileMock.mockImplementation(async (pov: string) =>
      pov === 'accelerationist' ? ACC_FILE : { nodes: [{ id: 'fixture-filler' }] },
    );
    writeFileMock.mockRejectedValue(new ActionableError({
      goal: 'g', problem: 'p', location: 'l', nextSteps: [], httpStatus: 409, code: 'WRITE_CONFLICT',
    }));

    const { status, body } = await invoke({ body: { ids: ['pol-001'] } });

    expect(status).toBe(409);
    expect((body as { code?: string } | undefined)?.code).toBe('WRITE_CONFLICT');
  });
});
