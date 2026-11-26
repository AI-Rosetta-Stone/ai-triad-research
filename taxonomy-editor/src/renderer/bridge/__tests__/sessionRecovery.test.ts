import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockResilientFetch = vi.fn<(path: string, init: RequestInit, opts: unknown) => Promise<Response>>();

vi.mock('../resilience', () => ({
  resilientFetch: (...args: unknown[]) => mockResilientFetch(args[0] as string, args[1] as RequestInit, args[2]),
  categorizeEndpoint: () => 'data',
  registerConnectionPoolProvider: vi.fn(),
  getResilienceState: vi.fn(),
  subscribeResilience: vi.fn(),
  resetResilience: vi.fn(),
}));

vi.mock('@lib/debate/errors', () => ({
  ActionableError: class ActionableError extends Error {
    goal: string;
    problem: string;
    location: string;
    nextSteps: string[];
    httpStatus?: number;
    constructor(opts: { goal: string; problem: string; location: string; nextSteps: string[] }) {
      super(opts.problem);
      this.name = 'ActionableError';
      this.goal = opts.goal;
      this.problem = opts.problem;
      this.location = opts.location;
      this.nextSteps = opts.nextSteps;
    }
  },
}));

const mockRecord = vi.fn();
vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: mockRecord }),
}));

vi.mock('../instrumentBridge', () => ({
  instrumentBridge: (raw: unknown) => raw,
}));

vi.mock('../../utils/keyShareCrypto', () => ({
  encryptKeysForSharing: vi.fn(),
  decryptKeysFromSharing: vi.fn(),
}));

vi.mock('../../hooks/useQuotaWarning', () => ({
  onQuotaMilestone: vi.fn(),
}));

const mockGlobalFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', mockGlobalFetch);

function mockResponse(status: number, body: unknown = {}, headers?: Record<string, string>): Response {
  const h = new Headers(headers);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: h,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    clone() { return mockResponse(status, body, headers); },
  } as unknown as Response;
}

describe('session recovery (t/1476)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGlobalFetch.mockResolvedValue(mockResponse(200));
  });

  it('detects 401 no_session, recovers, and retries once (AC#1)', async () => {
    const noSessionResponse = mockResponse(401, { error: 'Anonymous session required', reason: 'no_session' });
    const okResponse = mockResponse(200, { status: 'ok' });
    mockResilientFetch
      .mockResolvedValueOnce(noSessionResponse)
      .mockResolvedValueOnce(okResponse);

    const { bridgeGet } = await import('../web-bridge');
    const result = await bridgeGet('/api/health');

    expect(result).toEqual({ status: 'ok' });
    expect(mockResilientFetch).toHaveBeenCalledTimes(2);
    expect(mockGlobalFetch).toHaveBeenCalledWith(
      '/api/auth/anonymous',
      expect.objectContaining({ method: 'POST', credentials: 'include', cache: 'no-store' }),
    );
  });

  it('surfaces error when retry also fails — no loop (AC#2)', async () => {
    const noSessionResponse = mockResponse(401, { error: 'Anonymous session required', reason: 'no_session' });
    mockResilientFetch.mockResolvedValue(noSessionResponse);

    const { bridgeGet } = await import('../web-bridge');
    await expect(bridgeGet('/api/taxonomy/accelerationist')).rejects.toThrow();
    expect(mockResilientFetch).toHaveBeenCalledTimes(2);
    expect(mockGlobalFetch).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent recovery attempts (AC concurrency)', async () => {
    const noSession = mockResponse(401, { error: 'Anonymous session required', reason: 'no_session' });
    const ok = mockResponse(200, { data: 'ok' });

    let callCount = 0;
    mockResilientFetch.mockImplementation(async () => {
      callCount++;
      if (callCount <= 3) return noSession;
      return ok;
    });

    let resolveRecovery!: (v: Response) => void;
    mockGlobalFetch.mockImplementation(() => new Promise<Response>(r => { resolveRecovery = r; }));

    const { bridgeGet } = await import('../web-bridge');
    const p1 = bridgeGet('/api/health').catch(() => 'failed');
    const p2 = bridgeGet('/api/taxonomy/accelerationist').catch(() => 'failed');

    await vi.waitFor(() => expect(mockGlobalFetch).toHaveBeenCalledTimes(1));
    resolveRecovery(mockResponse(200));
    await Promise.all([p1, p2]);

    expect(mockGlobalFetch).toHaveBeenCalledTimes(1);
  });

  it('t/467: when the server cannot start a session (503 anon_session_unavailable), the caller gets that refusal, not the 401, and there is no retry', async () => {
    mockResilientFetch.mockResolvedValue(mockResponse(401, { error: 'Anonymous session required', reason: 'no_session' }));
    mockGlobalFetch.mockResolvedValue(mockResponse(503, { error: 'anon_session_unavailable', message: 'Anonymous sessions are temporarily unavailable.' }));

    const { fetchWithSessionRecovery } = await import('../web-bridge');
    const res = await fetchWithSessionRecovery('/api/oped-sets', { method: 'POST' }, { timeoutMs: 1000, maxRetries: 0, critical: true, category: 'data' } as never);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'anon_session_unavailable' });
    expect(mockResilientFetch).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', message: expect.stringContaining('anon_session_unavailable') }));
  });

  it('t/467: any other failed mint still returns the original 401', async () => {
    mockResilientFetch.mockResolvedValue(mockResponse(401, { error: 'Anonymous session required', reason: 'no_session' }));
    mockGlobalFetch.mockResolvedValue(mockResponse(503, { error: 'something_else' }));

    const { fetchWithSessionRecovery } = await import('../web-bridge');
    const res = await fetchWithSessionRecovery('/api/health', {}, { timeoutMs: 1000, maxRetries: 0, critical: true, category: 'data' } as never);
    expect(res.status).toBe(401);
  });

  it('t/678: loadSnapshot turns a 403 anon_route_blocked into the sign-in result, not null (Quality t/467#84)', async () => {
    mockResilientFetch.mockResolvedValue(mockResponse(403, { error: 'Sign in required', reason: 'anon_route_blocked' }));

    const { api } = await import('../web-bridge');
    await expect(api.loadSnapshot('src-1')).resolves.toEqual({ content: '', signInRequired: true });
  });

  it('t/678: any other loadSnapshot failure is still null with a WARN, never the sign-in prompt', async () => {
    mockResilientFetch.mockResolvedValue(mockResponse(500, { error: 'Internal server error' }));

    const { api } = await import('../web-bridge');
    await expect(api.loadSnapshot('src-1')).resolves.toBeNull();
  });

  it('does not attempt recovery for non-401 errors', async () => {
    mockResilientFetch.mockResolvedValue(mockResponse(500, { error: 'Internal server error' }));

    const { bridgeGet } = await import('../web-bridge');
    await expect(bridgeGet('/api/health')).rejects.toThrow();
    expect(mockGlobalFetch).not.toHaveBeenCalled();
  });

  it('does not attempt recovery for 401 without no_session reason', async () => {
    mockResilientFetch.mockResolvedValue(mockResponse(401, { error: 'Unauthorized' }));

    const { bridgeGet } = await import('../web-bridge');
    await expect(bridgeGet('/api/health')).rejects.toThrow();
    expect(mockGlobalFetch).not.toHaveBeenCalled();
  });

  it("t/719: the route's 401 for an anonymous visitor means no questions of their own: listInquiries answers []", async () => {
    vi.resetModules();
    mockGlobalFetch.mockResolvedValue(mockResponse(200, { user: 'anon:1', anonymous: true }));
    mockResilientFetch.mockResolvedValue(mockResponse(401, { error: 'Sign in required' }));

    const { api } = await import('../web-bridge');
    await expect(api.listInquiries()).resolves.toEqual([]);
  });

  it('t/719: a signed-in user whose auth check failed still gets their questions, not an empty list (Quality p/57#103)', async () => {
    vi.resetModules();
    mockGlobalFetch.mockRejectedValue(new Error('auth check down')); // isAnonymous() then answers true
    mockResilientFetch.mockResolvedValue(mockResponse(200, [{ jobId: 'j1' }]));

    const { api } = await import('../web-bridge');
    await expect(api.listInquiries()).resolves.toEqual([{ jobId: 'j1' }]);
  });

  it('t/719: a 401 for a signed-in user, and any other failure, still reject', async () => {
    vi.resetModules();
    mockGlobalFetch.mockResolvedValue(mockResponse(200, { user: 'u', anonymous: false }));
    mockResilientFetch.mockResolvedValue(mockResponse(401, { error: 'Unauthorized' }));
    const signedIn = await import('../web-bridge');
    await expect(signedIn.api.listInquiries()).rejects.toThrow();

    vi.resetModules();
    mockGlobalFetch.mockResolvedValue(mockResponse(200, { user: 'anon:1', anonymous: true }));
    mockResilientFetch.mockResolvedValue(mockResponse(500, { error: 'Internal server error' }));
    const anonymous = await import('../web-bridge');
    await expect(anonymous.api.listInquiries()).rejects.toThrow();
  });

  it('t/719: a signed-in user still gets their questions from the server', async () => {
    vi.resetModules();
    mockGlobalFetch.mockResolvedValue(mockResponse(200, { user: 'u', anonymous: false }));
    mockResilientFetch.mockResolvedValue(mockResponse(200, [{ jobId: 'j1' }]));

    const { api } = await import('../web-bridge');
    await expect(api.listInquiries()).resolves.toEqual([{ jobId: 'j1' }]);
    expect(mockResilientFetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces error when recovery fetch itself fails (condition #2)', async () => {
    const noSession = mockResponse(401, { error: 'Anonymous session required', reason: 'no_session' });
    mockResilientFetch.mockResolvedValue(noSession);
    mockGlobalFetch.mockRejectedValue(new Error('Network error'));

    const { bridgeGet } = await import('../web-bridge');
    await expect(bridgeGet('/api/health')).rejects.toThrow();
    expect(mockResilientFetch).toHaveBeenCalledTimes(1);
  });
});

describe('auth-wall recovery — HTTP 200 + text/html login page (t/1840)', () => {
  const htmlLoginPage = () =>
    mockResponse(200, '<!doctype html><html><body>Login</body></html>', { 'content-type': 'text/html; charset=utf-8' });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGlobalFetch.mockResolvedValue(mockResponse(200));
  });

  it('detects 200+text/html login page, recovers, and retries once (AC#1)', async () => {
    const okResponse = mockResponse(200, { status: 'ok' }, { 'content-type': 'application/json' });
    mockResilientFetch
      .mockResolvedValueOnce(htmlLoginPage())
      .mockResolvedValueOnce(okResponse);

    const { bridgeGet } = await import('../web-bridge');
    const result = await bridgeGet('/api/health');

    expect(result).toEqual({ status: 'ok' });
    expect(mockResilientFetch).toHaveBeenCalledTimes(2);
    expect(mockGlobalFetch).toHaveBeenCalledWith(
      '/api/auth/anonymous',
      expect.objectContaining({ method: 'POST', credentials: 'include', cache: 'no-store' }),
    );
  });

  it('surfaces ActionableError when retry is still HTML — no loop (AC#2)', async () => {
    mockResilientFetch.mockResolvedValue(htmlLoginPage());

    const { bridgeGet } = await import('../web-bridge');
    await expect(bridgeGet('/api/taxonomy/accelerationist')).rejects.toThrow();
    expect(mockResilientFetch).toHaveBeenCalledTimes(2);
    expect(mockGlobalFetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces ActionableError when recovery itself fails (HTML, no retry)', async () => {
    mockResilientFetch.mockResolvedValue(htmlLoginPage());
    mockGlobalFetch.mockResolvedValue(mockResponse(500, { error: 'recovery unavailable' }));

    const { bridgeGet } = await import('../web-bridge');
    await expect(bridgeGet('/api/health')).rejects.toThrow();
    // recovery returned !ok, so no retry — only the initial resilientFetch call
    expect(mockResilientFetch).toHaveBeenCalledTimes(1);
    expect(mockGlobalFetch).toHaveBeenCalledTimes(1);
  });
});

describe('403 anon_route_blocked error message (t/2232)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGlobalFetch.mockResolvedValue(mockResponse(200));
  });

  it('surfaces the server detail string when reason is anon_route_blocked', async () => {
    mockResilientFetch.mockResolvedValue(
      mockResponse(403, { reason: 'anon_route_blocked', detail: 'Sign in at /.auth/login/github to unlock full access.' }),
    );

    const { bridgeGet } = await import('../web-bridge');
    const err = await bridgeGet('/api/debates').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const nextSteps = (err as { nextSteps?: string[] }).nextSteps ?? [];
    expect(nextSteps).toContain('Sign in at /.auth/login/github to unlock full access.');
    expect(nextSteps.join(' ')).not.toContain('API key');
  });

  it('falls back to generic auth message when reason is absent', async () => {
    mockResilientFetch.mockResolvedValue(
      mockResponse(403, { error: 'Forbidden' }),
    );

    const { bridgeGet } = await import('../web-bridge');
    const err = await bridgeGet('/api/debates').catch((e: unknown) => e);
    const nextSteps = (err as { nextSteps?: string[] }).nextSteps ?? [];
    expect(nextSteps.join(' ')).toContain('API key');
  });
});
