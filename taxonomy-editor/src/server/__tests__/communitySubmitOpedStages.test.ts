// @vitest-environment node
//
// t/172: an op-ed's `stages` (raw per-call prompts and outputs, t/171) is owner-only. Community
// items are readable by every signed-in user, so POST /api/community/submit drops it before
// community.submitToCommunity ever sees the data. Both arms: stripped for op-eds, untouched otherwise.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const { submitToCommunity, infoMock } = vi.hoisted(() => ({ submitToCommunity: vi.fn(), infoMock: vi.fn() }));
vi.mock('../community/community.js', () => ({ submitToCommunity, isAdmin: () => false }));
vi.mock('../logger.js', () => ({ log: { server: { info: infoMock, warn: vi.fn(), error: vi.fn() } } }));
vi.mock('../security/userContext.js', () => ({ getStorageUserId: () => 'user-1', isAnonymousUser: () => false, getStableId: () => 'github:1' }));
vi.mock('../security/rateLimiter.js', () => ({ checkRate: () => ({ allowed: true }) }));
vi.mock('../security/rateLimitResponse.js', () => ({ rateLimitResponseBody: () => ({}) }));
vi.mock('../storage/fileIO.js', () => ({ getUserContentBackend: vi.fn() }));
vi.mock('../community/communityOpedShares.js', () => ({ revokeCommunityOpedShare: vi.fn(), getCommunityOpedShareEntry: vi.fn() }));
vi.mock('../storage/communityOpedShareStore.js', () => ({ deletePublicCommunityOpEd: vi.fn() }));

import { registerCommunityRoutes, withoutOpEdStages } from '../routes/community.js';

const STAGES = [
  { stage: 'generation', attempt: 1, model: 'gemini-2.5-flash', prompt: 'PRIVATE-SYSTEM\n\n---\n\nPRIVATE-USER', output: 'RAW-MODEL-OUTPUT' },
];
const opedSet = (withStages: boolean) => ({
  set_id: 's1', topic: 'T',
  opeds: [
    { pov: 'accelerationist', status: 'complete', headline: 'H', body: 'B', ...(withStages ? { stages: STAGES } : {}) },
    { pov: 'safetyist', status: 'complete', headline: 'H2', body: 'B2' },
  ],
});

type Handler = (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void> | void;
function submitHandler(): Handler {
  const handlers: Record<string, Handler> = {};
  const reg = (m: string) => (p: string, h: Handler) => { handlers[`${m} ${p}`] = h; };
  registerCommunityRoutes({ get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), del: reg('DELETE') } as never,
    { getGithubBackend: () => null } as never);
  return handlers['POST /api/community/submit'];
}
function fakeRes(): ServerResponse & { _status?: number } {
  const res = { writeHead: vi.fn((s: number) => { res._status = s; }), end: vi.fn(), setHeader: vi.fn() } as unknown as ServerResponse & { _status?: number };
  return res;
}

beforeEach(() => { submitToCommunity.mockReset().mockResolvedValue({ submissionId: 'sub-1' }); infoMock.mockClear(); });

describe('POST /api/community/submit drops op-ed stages (t/172)', () => {
  it('an op-ed submission reaches submitToCommunity with no stages and no raw prompt/output text', async () => {
    await submitHandler()({} as IncomingMessage, fakeRes(), { type: 'oped', data: opedSet(true) });
    expect(submitToCommunity).toHaveBeenCalledTimes(1);
    const submitted = submitToCommunity.mock.calls[0][1] as ReturnType<typeof opedSet>;
    const serialized = JSON.stringify(submitted);
    expect(serialized).not.toContain('stages');
    expect(serialized).not.toContain('PRIVATE-SYSTEM');
    expect(serialized).not.toContain('RAW-MODEL-OUTPUT');
    // Everything else on the members survives.
    expect(submitted.opeds[0]).toEqual({ pov: 'accelerationist', status: 'complete', headline: 'H', body: 'B' });
    expect(submitted.opeds[1]).toEqual(opedSet(false).opeds[1]);
    expect(infoMock).toHaveBeenCalledWith(expect.objectContaining({ stripped: 1 }), expect.any(String));
  });

  it('an op-ed without stages (pre-t/171) is submitted unchanged, with nothing logged', async () => {
    await submitHandler()({} as IncomingMessage, fakeRes(), { type: 'oped', data: opedSet(false) });
    expect(submitToCommunity.mock.calls[0][1]).toEqual(opedSet(false));
    expect(infoMock).not.toHaveBeenCalled();
  });
});

describe('withoutOpEdStages leaves non-op-ed submissions alone (t/172)', () => {
  it('a chat or debate carrying a `stages`-named field passes through by identity', () => {
    const chat = { opeds: [{ stages: ['x'] }], messages: [] };
    expect(withoutOpEdStages('chat', chat)).toBe(chat);
    expect(withoutOpEdStages('debate', chat)).toBe(chat);
  });

  it('malformed op-ed data (no opeds array) passes through untouched', () => {
    const odd = { topic: 'T' };
    expect(withoutOpEdStages('oped', odd)).toBe(odd);
    expect(withoutOpEdStages('oped', null)).toBe(null);
  });
});
