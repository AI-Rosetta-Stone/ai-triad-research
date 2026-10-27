// @vitest-environment node
//
// t/4487 — signed-in free-tier callers must be rate-limited per IDENTITY (the stable
// principal id), not per IP: one user can't multiply their limit by changing networks, and
// users sharing a NAT don't share one bucket. Anonymous callers (no stable identity) keep
// the existing per-IP key. Non-free tiers are keyed by principal already and must be
// unaffected by this change.

import { describe, it, expect, vi } from 'vitest';

const { mockCallerIdentity, mockGetClientIp, mockResolveTier, mockResolveBackend } = vi.hoisted(() => ({
  mockCallerIdentity: vi.fn(() => ({ principalName: '', idp: '' })),
  mockGetClientIp: vi.fn(() => '1.2.3.4'),
  mockResolveTier: vi.fn(() => ({ level: 'free', allowedBackends: ['gemini'], pinnedModel: 'gemini-2.5-flash' })),
  mockResolveBackend: vi.fn(() => 'gemini'),
}));

vi.mock('../security/accessControl.js', () => ({ callerTierIdentity: mockCallerIdentity }));
vi.mock('../security/userContext.js', () => ({ getCurrentUser: vi.fn(() => null) }));
vi.mock('../httpKit.js', () => ({ getClientIp: mockGetClientIp }));
vi.mock('../ai/proxyTiers.js', () => ({ resolveTier: mockResolveTier, isBackendAllowed: vi.fn(() => true) }));
vi.mock('../ai/aiBackends.js', () => ({ resolveBackend: mockResolveBackend }));
vi.mock('../../../../lib/ai-client/index.js', () => ({ DEFAULT_MODEL: 'test-model' }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('../featureFlags.js', () => ({ isAnonDebatesEnabled: vi.fn(() => true) }));
vi.mock('../logger.js', () => ({ log: { api: { warn: vi.fn() } } }));

import { resolveGenerationContext } from '../routes/generationContext.js';

function fakeReq(): import('http').IncomingMessage {
  return {} as unknown as import('http').IncomingMessage;
}

describe('resolveGenerationContext: free-tier limitKey (t/4487)', () => {
  it('two signed-in free-tier users behind the same IP get independent buckets (AC1)', () => {
    mockGetClientIp.mockReturnValue('5.5.5.5');
    mockCallerIdentity.mockReturnValue({ principalName: 'github-111', idp: 'github' });
    const a = resolveGenerationContext(fakeReq(), undefined);
    mockCallerIdentity.mockReturnValue({ principalName: 'github-222', idp: 'github' });
    const b = resolveGenerationContext(fakeReq(), undefined);
    expect(a.limitKey).toBe('free:user:github-111');
    expect(b.limitKey).toBe('free:user:github-222');
    expect(a.limitKey).not.toBe(b.limitKey);
  });

  it('one signed-in free-tier user from two different IPs shares one bucket (AC2)', () => {
    mockCallerIdentity.mockReturnValue({ principalName: 'github-111', idp: 'github' });
    mockGetClientIp.mockReturnValue('5.5.5.5');
    const a = resolveGenerationContext(fakeReq(), undefined);
    mockGetClientIp.mockReturnValue('9.9.9.9');
    const b = resolveGenerationContext(fakeReq(), undefined);
    expect(a.limitKey).toBe('free:user:github-111');
    expect(b.limitKey).toBe('free:user:github-111');
  });

  it('anonymous free-tier traffic stays keyed on the corrected client IP (AC3, regression guard)', () => {
    mockCallerIdentity.mockReturnValue({ principalName: '', idp: '' });
    mockGetClientIp.mockReturnValue('5.5.5.5');
    const result = resolveGenerationContext(fakeReq(), undefined);
    expect(result.limitKey).toBe('free:5.5.5.5');
  });

  it('BYOK (non-free) is unaffected: signed-in users key by principal, as before (AC4)', () => {
    mockResolveTier.mockReturnValue({ level: 'byok', allowedBackends: ['gemini'] });
    mockCallerIdentity.mockReturnValue({ principalName: 'github-111', idp: 'github' });
    const result = resolveGenerationContext(fakeReq(), undefined);
    expect(result.isFree).toBe(false);
    expect(result.limitKey).toBe('github-111');
  });

  it('BYOK (non-free), anonymous caller: unaffected, falls to _anonymous (AC4)', () => {
    mockResolveTier.mockReturnValue({ level: 'byok', allowedBackends: ['gemini'] });
    mockCallerIdentity.mockReturnValue({ principalName: '', idp: '' });
    const result = resolveGenerationContext(fakeReq(), undefined);
    expect(result.limitKey).toBe('_anonymous');
  });
});
