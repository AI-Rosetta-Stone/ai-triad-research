// @vitest-environment node
// t/475 (PI decision): the delete route's handler half. An unkeyed anonymous caller is refused (403) before any
// delete; a not-found set is 404; a delete from the caller's own key is ok.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  deleteOpedSet: vi.fn(async (_id: string) => true),
  isAnonymousUser: vi.fn(() => false),
  getStorageUserId: vi.fn(() => 'alice'),
  record: vi.fn(),
}));
vi.mock('../storage/opedStore.js', () => ({ deleteOpedSet: h.deleteOpedSet }));
vi.mock('../security/userContext.js', () => ({ isAnonymousUser: h.isAnonymousUser, getStorageUserId: h.getStorageUserId }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: h.record }) }));

import { deleteOpEdSetRoute } from '../routes/opedDelete.js';

function fakeRes() {
  const r = { _status: 0, _body: '' as string };
  return Object.assign(r, {
    writeHead: vi.fn((code: number) => { r._status = code; }),
    end: vi.fn((b?: string) => { r._body = b ?? ''; }),
    setHeader: vi.fn(),
    headersSent: false,
    writableEnded: false,
    on: vi.fn(),
    write: vi.fn(() => true),
  });
}

beforeEach(() => {
  h.deleteOpedSet.mockReset().mockResolvedValue(true);
  h.isAnonymousUser.mockReturnValue(false);
  h.getStorageUserId.mockReturnValue('alice');
});

describe('t/475 (PI): the delete route handler', () => {
  it('an unkeyed anonymous caller (storage _local, no session cookie) is refused 403 before any delete', async () => {
    h.isAnonymousUser.mockReturnValue(true);
    h.getStorageUserId.mockReturnValue('_local');
    const res = fakeRes();
    await deleteOpEdSetRoute(res as never, 'set-1');
    expect(res._status).toBe(403);
    expect(h.deleteOpedSet).not.toHaveBeenCalled();
  });

  it('a keyed anonymous caller deletes from their own key and gets ok', async () => {
    h.isAnonymousUser.mockReturnValue(true);
    h.getStorageUserId.mockReturnValue('anon-0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11');
    const res = fakeRes();
    await deleteOpEdSetRoute(res as never, 'set-1');
    expect(h.deleteOpedSet).toHaveBeenCalledWith('set-1');
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ ok: true });
  });

  it('a set not in the caller’s own store (another visitor’s id) is 404 Not Found', async () => {
    h.isAnonymousUser.mockReturnValue(true);
    h.getStorageUserId.mockReturnValue('anon-7b1d2c3e-4f50-4a61-8b72-9c83d4e5f601');
    h.deleteOpedSet.mockResolvedValue(false);
    const res = fakeRes();
    await deleteOpEdSetRoute(res as never, 'set-of-visitor-a');
    expect(res._status).toBe(404);
    expect(JSON.parse(res._body)).toMatchObject({ error: 'Op-ed set not found' });
  });

  it('a signed-in caller’s delete is ok, unchanged', async () => {
    const res = fakeRes();
    await deleteOpEdSetRoute(res as never, 'set-9');
    expect(res._status).toBe(200);
  });
});
