// @vitest-environment node
//
// t/201 — one structured `ai-key-tier` log line per AI request, with the key tier that served it. The tier is
// one of free-pool | byok | platform, plus an anonymous flag. The line never carries a key or any part of one.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type http from 'http';

const h = vi.hoisted(() => ({
  level: 'platform' as 'platform' | 'byok' | 'anonymous' | 'free',
  info: vi.fn(),
}));

vi.mock('../ai/proxyTiers.js', async (orig) => ({
  ...(await orig<typeof import('../ai/proxyTiers.js')>()),
  resolveTier: () => ({ level: h.level, limits: { requestsPerMinute: 60 }, allowedBackends: ['gemini'] }),
}));
vi.mock('../ai/aiBackends.js', async (orig) => ({
  ...(await orig<typeof import('../ai/aiBackends.js')>()),
  resolveBackend: () => 'gemini',
}));
vi.mock('../logger.js', async (orig) => {
  const m = await orig<typeof import('../logger.js')>();
  return { ...m, log: { ...m.log, api: { ...m.log.api, info: h.info } } };
});

import { resolveGenerationContext, keyTierFields } from '../routes/generationContext.js';

const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as http.IncomingMessage;

beforeEach(() => { h.info.mockReset(); });

describe('AI request key tier (t/201)', () => {
  it('maps each tier level to its key tier and the anonymous flag', () => {
    expect(keyTierFields('platform')).toEqual({ keyTier: 'platform', anonymous: false });
    expect(keyTierFields('byok')).toEqual({ keyTier: 'byok', anonymous: false });
    expect(keyTierFields('free')).toEqual({ keyTier: 'free-pool', anonymous: false });
    expect(keyTierFields('anonymous')).toEqual({ keyTier: 'free-pool', anonymous: true });
  });

  it('a platform-tier request logs keyTier platform', () => {
    h.level = 'platform';
    resolveGenerationContext(req, 'gemini-2.5-flash');
    expect(h.info).toHaveBeenCalledWith(expect.objectContaining({ event: 'ai-key-tier', keyTier: 'platform', anonymous: false, backend: 'gemini' }), expect.any(String));
  });

  it('a BYOK request logs keyTier byok', () => {
    h.level = 'byok';
    resolveGenerationContext(req, 'gemini-2.5-flash');
    expect(h.info).toHaveBeenCalledWith(expect.objectContaining({ keyTier: 'byok', anonymous: false }), expect.any(String));
  });

  it('a signed-in free request logs keyTier free-pool, not anonymous', () => {
    h.level = 'free';
    resolveGenerationContext(req, 'gemini-2.5-flash');
    expect(h.info).toHaveBeenCalledWith(expect.objectContaining({ keyTier: 'free-pool', anonymous: false }), expect.any(String));
  });

  it('an anonymous request logs keyTier free-pool with anonymous true', () => {
    h.level = 'anonymous';
    resolveGenerationContext(req, 'gemini-2.5-flash');
    expect(h.info).toHaveBeenCalledWith(expect.objectContaining({ keyTier: 'free-pool', anonymous: true }), expect.any(String));
  });

  it('the line carries only the tier, the anonymous flag, the backend and the model: no key material', () => {
    h.level = 'byok';
    resolveGenerationContext(req, 'gemini-2.5-flash');
    expect(h.info).toHaveBeenCalledTimes(1);
    const [fields] = h.info.mock.calls[0];
    expect(Object.keys(fields).sort()).toEqual(['anonymous', 'backend', 'component', 'event', 'keyTier', 'model']);
    expect(JSON.stringify(fields)).not.toMatch(/api[_-]?key|secret|token|AIza/i);
  });
});
