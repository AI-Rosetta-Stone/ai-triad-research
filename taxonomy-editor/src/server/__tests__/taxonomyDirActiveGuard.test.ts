// @vitest-environment node
// t/640 (Security p/93#85; found by ServerStorage, p/52#32): PUT /api/taxonomy-dir/active sets a process-global that
// redirects every taxonomy read and write. Through the real route: a non-admin is refused 403; a dirName that isn't one
// safe segment, or that names no existing taxonomy directory, is refused 400; in every refusal the active dir is unchanged.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const h = vi.hoisted(() => ({ isAdmin: vi.fn(() => true), active: 'Origin', setActive: vi.fn() }));
vi.mock('../community/community.js', () => ({ isAdmin: h.isAdmin, getAdminUsers: vi.fn(() => []) }));
vi.mock('../eventLoopMonitor.js', () => ({ getLastEventLoopSample: vi.fn(() => null) }));
vi.mock('../storage/fileIO.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../storage/fileIO.js')>()),
  getTaxonomyDirs: vi.fn(async () => ['Origin', 'Experimental_2']),
  getActiveTaxonomyDirName: vi.fn(() => h.active),
  setActiveTaxonomyDir: h.setActive,
}));

import { registerMetaRoutes } from '../routes/meta.js';
import type { ServerCtx } from '../routes/context.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void> | void;
const handlers: Record<string, Handler> = {};
const reg = (m: string) => (p: string, fn: Handler) => { handlers[`${m} ${p}`] = fn; };
registerMetaRoutes({ get: reg('GET'), put: reg('PUT'), post: reg('POST'), patch: reg('PATCH'), del: reg('DELETE') } as never, { getGithubBackend: () => null } as unknown as ServerCtx);

async function put(body: unknown): Promise<number> {
  let status = 200;
  const res = {
    writableEnded: false, headersSent: false,
    writeHead: vi.fn((c: number) => { status = c; }), end: vi.fn(), setHeader: vi.fn(), getHeader: vi.fn(),
  } as unknown as ServerResponse;
  await handlers['PUT /api/taxonomy-dir/active']({ url: '/api/taxonomy-dir/active', method: 'PUT', headers: {} } as IncomingMessage, res, body);
  return status;
}

const ENV = ['AUTH_DISABLED', 'NODE_ENV'];
beforeEach(() => {
  for (const n of ENV) delete process.env[n];
  h.isAdmin.mockReturnValue(true);
  h.setActive.mockClear();
});

describe('t/640: PUT /api/taxonomy-dir/active', () => {
  it('an admin switches to an existing directory', async () => {
    expect(await put({ dirName: 'Experimental_2' })).toBe(200);
    expect(h.setActive).toHaveBeenCalledWith('Experimental_2');
  });

  it('a signed-in non-admin is refused 403 and nothing changes', async () => {
    h.isAdmin.mockReturnValue(false);
    expect(await put({ dirName: 'Experimental_2' })).toBe(403);
    expect(h.setActive).not.toHaveBeenCalled();
  });

  it('a traversal, a separator, an empty or non-string value is refused 400 and nothing changes', async () => {
    for (const dirName of ['../admin', 'a/b', 'a\\b', '', '..', 'x'.repeat(65), 42, null, undefined]) {
      expect(`${String(dirName)} ${await put({ dirName })}`).toBe(`${String(dirName)} 400`);
    }
    expect(await put(null)).toBe(400);
    expect(h.setActive).not.toHaveBeenCalled();
  });

  it('a safe name that is not an existing taxonomy directory is refused 400', async () => {
    expect(await put({ dirName: 'NoSuchDir' })).toBe(400);
    expect(h.setActive).not.toHaveBeenCalled();
  });
});
