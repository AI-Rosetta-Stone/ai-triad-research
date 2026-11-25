// @vitest-environment node
// t/553 (t/503 PR 4, ServerStorage p/52#50): the server.ts wiring for shared overlay state.
//   - The backend config (store + commit lock in one container) only when both env vars are set.
//   - The DRAINING timer only when OVERLAY_SHARED_STATE_DRAINING=1, and its stop is returned.
//   - /health's drain field: counts only (never user ids), null when not draining, bounded and never throwing.
//   - A save refused with OVERLAY_DRAINING / OVERLAY_STAGE_FAILED reaches the caller as 503 with its code, even when
//     the route's catch passed 500, and the stage-failed storage detail is never echoed.

import { describe, it, expect, vi } from 'vitest';
import type { ServerResponse } from 'http';

const h = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../logger.js', () => ({
  log: { server: { info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() }, security: { warn: vi.fn() } },
  getRequestId: () => 'req-1',
}));
vi.mock('../storage/overlayCommitScheduler.js', () => ({ startSharedOverlayDrain: vi.fn(() => vi.fn()) }));
vi.mock('../storage/sharedOverlayStore.js', () => ({ SharedOverlayStore: class { constructor(public opts: unknown) {} } }));

import { sharedOverlayStateFromEnv, startSharedOverlayDrainFromEnv, sharedOverlayDrainHealth, sharedOverlayBootState } from '../sharedOverlayWiring.js';
import { error } from '../httpKit.js';
import { ActionableError } from '../../../../lib/debate/errors.js';

const BOTH = { AZURE_STORAGE_ACCOUNT_URL: 'https://acct.blob.core.windows.net', AZURE_OVERLAY_STATE_CONTAINER: 'overlay-state-stg' };

describe('sharedOverlayStateFromEnv', () => {
  it('both set: store and commit lock on the same account and container', () => {
    const makeStore = vi.fn(() => ({ fake: true }) as never);
    const cfg = sharedOverlayStateFromEnv(BOTH, makeStore);
    expect(makeStore).toHaveBeenCalledWith({ accountUrl: BOTH.AZURE_STORAGE_ACCOUNT_URL, container: 'overlay-state-stg' });
    expect(cfg).toEqual({ store: { fake: true }, commitLock: { accountUrl: BOTH.AZURE_STORAGE_ACCOUNT_URL, container: 'overlay-state-stg' } });
  });

  it.each([
    [{ AZURE_STORAGE_ACCOUNT_URL: BOTH.AZURE_STORAGE_ACCOUNT_URL }],
    [{ AZURE_OVERLAY_STATE_CONTAINER: 'c' }],
    [{ AZURE_STORAGE_ACCOUNT_URL: ' ', AZURE_OVERLAY_STATE_CONTAINER: 'c' }],
    [{}],
  ])('either missing: undefined, no store built (%j)', (env) => {
    const makeStore = vi.fn();
    expect(sharedOverlayStateFromEnv(env, makeStore as never)).toBeUndefined();
    expect(makeStore).not.toHaveBeenCalled();
  });

  it('enabled but unconfigured: WARNs that it fell back', () => {
    h.warn.mockClear();
    sharedOverlayStateFromEnv({ OVERLAY_SHARED_STATE_ENABLED: '1' }, vi.fn() as never);
    expect(h.warn).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/falling back/));
  });
});

describe('startSharedOverlayDrainFromEnv', () => {
  it('DRAINING=1: starts the timer and returns its stop', () => {
    const stop = vi.fn();
    const start = vi.fn(() => stop);
    expect(startSharedOverlayDrainFromEnv({ OVERLAY_SHARED_STATE_DRAINING: '1' }, start)).toBe(stop);
    expect(start).toHaveBeenCalledTimes(1);
  });
  it('otherwise: no timer, null', () => {
    const start = vi.fn();
    expect(startSharedOverlayDrainFromEnv({ OVERLAY_SHARED_STATE_DRAINING: '0' }, start)).toBeNull();
    expect(startSharedOverlayDrainFromEnv({}, start)).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });
});

describe('sharedOverlayDrainHealth', () => {
  const DRAINING = { OVERLAY_SHARED_STATE_DRAINING: '1' };
  const backend = (impl: () => Promise<unknown>) => ({ getSharedOverlayDrainStatus: vi.fn(impl) }) as never;

  it('not draining: null without touching storage', async () => {
    const b = backend(async () => { throw new Error('should not be called'); });
    expect(await sharedOverlayDrainHealth(b, {})).toBeNull();
    expect((b as { getSharedOverlayDrainStatus: ReturnType<typeof vi.fn> }).getSharedOverlayDrainStatus).not.toHaveBeenCalled();
    expect(await sharedOverlayDrainHealth(null, DRAINING)).toBeNull();
  });

  it('draining: counts only, never user ids', async () => {
    const r = await sharedOverlayDrainHealth(backend(async () => ({ draining: true, usersWithEntries: ['alice@example.com', 'anon-1'], stagedEntries: 5 })), DRAINING);
    expect(r).toEqual({ draining: true, stagedEntries: 5, usersWithEntries: 2 });
    expect(JSON.stringify(r)).not.toMatch(/alice|anon-1/);
  });

  it('a storage error or a hang: unavailable, never throws', async () => {
    expect(await sharedOverlayDrainHealth(backend(async () => { throw new Error('blob down'); }), DRAINING)).toEqual({ draining: true, unavailable: 'error' });
    expect(await sharedOverlayDrainHealth(backend(() => new Promise(() => {})), DRAINING, 20)).toEqual({ draining: true, unavailable: 'timeout' });
  });
});

describe('error(): a retryable save refusal passes through as 503 with its code', () => {
  function fakeRes() {
    const out: { status: number; headers: Record<string, string>; body: Record<string, unknown> | null } = { status: 0, headers: {}, body: null };
    const res = {
      writableEnded: false, headersSent: false,
      setHeader(n: string, v: string) { out.headers[n.toLowerCase()] = v; },
      writeHead(s: number, hd?: Record<string, string>) { out.status = s; for (const [k, v] of Object.entries(hd ?? {})) out.headers[k.toLowerCase()] = v; this.headersSent = true; },
      end(b?: string) { out.body = b ? JSON.parse(b) : null; this.writableEnded = true; },
    } as unknown as ServerResponse;
    return { res, out };
  }
  const refusal = (code: string, problem: string) => new ActionableError({ goal: 'Save x.json', problem, location: 'GitHubAPIBackend.stageSharedOverlaySave', nextSteps: ['Retry'], httpStatus: 503, code });

  for (const env of ['development', 'production']) {
    it(`OVERLAY_DRAINING with the route's default 500 (${env}): 503, code, Retry-After`, () => {
      vi.stubEnv('NODE_ENV', env);
      const { res, out } = fakeRes();
      error(res, 'Error: whatever', 500, refusal('OVERLAY_DRAINING', 'Saving is paused'));
      expect(out.status).toBe(503);
      expect(out.body).toMatchObject({ code: 'OVERLAY_DRAINING', error: expect.stringMatching(/paused/) });
      expect(out.headers['retry-after']).toBe('120');
      vi.unstubAllEnvs();
    });
  }

  it('OVERLAY_STAGE_FAILED: 503 with its code, and the storage detail is not echoed', () => {
    const { res, out } = fakeRes();
    error(res, 'x', 500, refusal('OVERLAY_STAGE_FAILED', 'could not be saved: SECRET-STORAGE-DETAIL'));
    expect(out.status).toBe(503);
    expect(out.body?.code).toBe('OVERLAY_STAGE_FAILED');
    expect(JSON.stringify(out.body)).not.toContain('SECRET-STORAGE-DETAIL');
  });

  it('any other error is unchanged', () => {
    const { res, out } = fakeRes();
    error(res, 'boom', 500, new ActionableError({ goal: 'g', problem: 'p', location: 'l', nextSteps: [], httpStatus: 503, code: 'OTHER' }));
    expect(out.status).toBe(500);
    expect(out.body?.code).toBeUndefined();
  });
});

// t/688#3 (Quality p/58#79): configured (store built) and active (configured + ENABLED=1) are logged separately.
describe('sharedOverlayBootState', () => {
  it('configured with the flag off: configured, not active', () => {
    expect(sharedOverlayBootState({}, true)).toEqual({ configured: true, enabled: false, active: false, draining: false });
  });
  it('configured with ENABLED=1: active', () => {
    expect(sharedOverlayBootState({ OVERLAY_SHARED_STATE_ENABLED: '1' }, true)).toMatchObject({ configured: true, enabled: true, active: true });
  });
  it('ENABLED=1 but not configured: not active', () => {
    expect(sharedOverlayBootState({ OVERLAY_SHARED_STATE_ENABLED: '1', OVERLAY_SHARED_STATE_DRAINING: '1' }, false)).toEqual({ configured: false, enabled: true, active: false, draining: true });
  });
});
