// @vitest-environment node
// t/616 item 5 (TL p/16#374; Security p/93#69): GET /api/oped-runs/:runId returns only the caller's own run, never by a
// guessed id, through the real route handler. The run store is faked with the real store's directory rule
// (opedRunStore.getOpedRunsDir: '_local' -> oped-runs/, anyone else -> users/<id>/oped-runs/).
//   - signed-in A reads A's run; signed-in B gets 404 for A's runId; a guessed id is 404;
//   - an anonymous session gets 404 and the store is never read (anonymous runs are never stored);
//   - an anonymous caller with auth_anonymous=1 but no anon_session_id (storage id '_local') gets 404, never the
//     local owner's runs in oped-runs/, even with a matching runId.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type http from 'http';

const h = vi.hoisted(() => ({ dirs: new Map<string, Map<string, unknown>>(), reads: [] as string[] }));
const dirFor = (userId: string) => (userId === '_local' ? 'oped-runs' : `users/${userId}/oped-runs`);

vi.mock('../logger.js', () => {
  const l = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { log: { server: l(), api: l(), ai: l(), security: l() }, getRequestId: () => 'req-t616' };
});
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('../storage/fileIO.js', async () => {
  const { getStorageUserId } = await import('../security/userContext.js');
  return {
    isSafeId: (v: string) => !!v && /^[a-zA-Z0-9_-]+$/.test(v),
    fetchUrlContent: vi.fn(), upsertOpedRun: vi.fn(), countRunningOpedRuns: vi.fn(async () => 0),
    getOpedRun: vi.fn(async (runId: string) => {
      const dir = dirFor(getStorageUserId());
      h.reads.push(dir);
      return (h.dirs.get(dir)?.get(runId) as object | undefined) ?? null;
    }),
  };
});

import { runWithUser } from '../security/userContext.js';
import { registerOpedRoutes } from '../routes/oped.js';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body?: unknown) => Promise<void> | void;
const handlers: Record<string, Handler> = {};
const reg = (m: string) => (p: string, fn: Handler) => { handlers[`${m} ${p}`] = fn; };
registerOpedRoutes({ get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), del: reg('DELETE') } as never, {} as never);

const user = (id: string) => ({ principalName: id, idp: 'github', storageUserId: id, stableId: id, isAnonymous: false });
const ANON_A = { principalName: '_local', idp: '', storageUserId: 'anon-aaaa', stableId: undefined, isAnonymous: true, anonymousSessionId: 'aaaa' };
const ANON_NO_SESSION = { principalName: '_local', idp: '', storageUserId: '_local', stableId: undefined, isAnonymous: true };
const RUN_A = 'run-a-1111';
const OWNER_RUN = 'run-owner-2222';

function put(userId: string, runId: string): void {
  const d = dirFor(userId);
  if (!h.dirs.has(d)) h.dirs.set(d, new Map());
  h.dirs.get(d)!.set(runId, { runId, userId, setId: 's', status: 'complete', perVoice: { accelerationist: 'done' }, startedAt: 1 });
}

async function getRun(ctx: object, runId: string): Promise<{ status: number; body: unknown }> {
  let status = 0; let raw = '';
  const res = {
    headersSent: false,
    writeHead(s: number) { status = s; this.headersSent = true; return this; },
    setHeader() { /* not asserted */ }, getHeader() { return undefined; },
    end(b?: string) { raw = b ?? ''; },
  } as unknown as http.ServerResponse;
  const req = { url: `/api/oped-runs/${runId}`, method: 'GET', headers: {}, params: { runId } } as unknown as http.IncomingMessage;
  await runWithUser(ctx as never, () => handlers['GET /api/oped-runs/:runId'](req, res));
  return { status, body: raw ? JSON.parse(raw) : null };
}

beforeEach(() => {
  h.dirs.clear(); h.reads.length = 0;
  put('alice', RUN_A);
  put('_local', OWNER_RUN); // the local owner's run directory
});

describe('t/616: GET /api/oped-runs/:runId, own runs only', () => {
  it('signed-in A reads its own run (status only, no content)', async () => {
    const r = await getRun(user('alice'), RUN_A);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ runId: RUN_A, setId: 's', status: 'complete', perVoice: { accelerationist: 'done' } });
  });

  it('signed-in B gets 404 for A\'s runId, and a guessed id is 404', async () => {
    expect((await getRun(user('bob'), RUN_A)).status).toBe(404);
    expect((await getRun(user('alice'), 'run-guessed-0000')).status).toBe(404);
  });

  it('an anonymous session gets 404 and the store is never read', async () => {
    expect((await getRun(ANON_A, RUN_A)).status).toBe(404);
    expect(h.reads).toEqual([]);
  });

  it('auth_anonymous=1 with no anon_session_id (storage _local) gets 404, never the owner\'s run, even with its id', async () => {
    const r = await getRun(ANON_NO_SESSION, OWNER_RUN);
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toContain(OWNER_RUN);
    expect(h.reads).toEqual([]);
  });
});
