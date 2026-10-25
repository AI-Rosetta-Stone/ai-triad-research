// @vitest-environment node

/**
 * t/793 — free tier: keyless web users get limited Gemini access via a
 * server-provided key, gated on FREE_TIER_GEMINI_KEY. Covers tier resolution;
 * the per-IP limits / model pin / key injection live in the /api/ai/generate
 * handler (server.ts isn't import-testable) and are exercised by deploy
 * acceptance (t/795).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { resolveTier, freeTierEnabled, isBackendAllowed, parseFreeTierKeys, scaledFreeTierRpm, byokGeminiFallbackApplies, LOCAL_EMBED_RPM_PER_IP } from '../ai/proxyTiers.js';
import { checkRate } from '../security/rateLimiter.js';

describe('free-tier RPM scales with key-pool size (t/906)', () => {
  afterEach(() => { delete process.env.FREE_TIER_GEMINI_KEY; });

  // t/3111: FREE_TIER_RPM_PER_KEY reverted 24→12 (the t/3104 24 was sized against a paid
  // Tier-2 key; on a real free key P_free≈15, so 12=0.8·P is the safe per-key value). The
  // ~20/min debate burst is cleared by POOL SIZE (K=2 → min(12×2,30)=24), not one hot key.
  // 30 hard cap untouched → 3+ keys saturate at 30.
  it('scaledFreeTierRpm = 12 per key, capped at 30 (AC#1, #3; t/3111)', () => {
    expect(scaledFreeTierRpm(1)).toBe(12);
    expect(scaledFreeTierRpm(2)).toBe(24); // 12×2=24, under the 30 cap
    expect(scaledFreeTierRpm(3)).toBe(30); // 12×3=36 → capped at 30
    expect(scaledFreeTierRpm(5)).toBe(30);
    expect(scaledFreeTierRpm(6)).toBe(30); // capped
    expect(scaledFreeTierRpm(0)).toBe(0);
  });

  it('the locked K=2 free pool clears a debate opening burst (T≈20 ≤ 24 = scaledFreeTierRpm(2)) (t/3111)', () => {
    // One key (12) intentionally does NOT clear ~20/min — pool size is the lever; the
    // paid fallback (generateWithPaidFallback) catches rare bursts above 24.
    expect(scaledFreeTierRpm(2)).toBeGreaterThanOrEqual(24);
    expect(scaledFreeTierRpm(1)).toBeLessThan(20);
  });

  it('resolveTier applies the scaled RPM for keyless free-tier users', () => {
    process.env.FREE_TIER_GEMINI_KEY = 'k1,k2';
    expect(resolveTier('', 'github').limits.requestsPerMinute).toBe(24); // 12×2, under the cap
    process.env.FREE_TIER_GEMINI_KEY = 'k1';
    expect(resolveTier('', 'github').limits.requestsPerMinute).toBe(12);
    process.env.FREE_TIER_GEMINI_KEY = 'k1,k2,k3,k4,k5,k6,k7';
    expect(resolveTier('', 'github').limits.requestsPerMinute).toBe(30); // capped
  });
});

describe('parseFreeTierKeys (t/846)', () => {
  it('returns [] for unset/blank', () => {
    expect(parseFreeTierKeys(undefined)).toEqual([]);
    expect(parseFreeTierKeys('')).toEqual([]);
    expect(parseFreeTierKeys('  ,  ,')).toEqual([]);
  });
  it('parses a single key (no commas) — backward compatible (AC#2)', () => {
    expect(parseFreeTierKeys('only-key')).toEqual(['only-key']);
  });
  it('parses a comma-separated list, trimming blanks (AC#1)', () => {
    expect(parseFreeTierKeys('k1,k2,k3')).toEqual(['k1', 'k2', 'k3']);
    expect(parseFreeTierKeys(' k1 , ,k2 ')).toEqual(['k1', 'k2']);
  });
});

describe('freeTierEnabled with multi-key (t/846)', () => {
  afterEach(() => { delete process.env.FREE_TIER_GEMINI_KEY; });
  it('is true for a CSV value and false for a blank one', () => {
    process.env.FREE_TIER_GEMINI_KEY = 'k1,k2';
    expect(freeTierEnabled()).toBe(true);
    process.env.FREE_TIER_GEMINI_KEY = ' , ';
    expect(freeTierEnabled()).toBe(false);
  });
});

describe('free tier (t/793)', () => {
  afterEach(() => { delete process.env.FREE_TIER_GEMINI_KEY; });

  it('keyless users get the free tier when FREE_TIER_GEMINI_KEY is set', () => {
    process.env.FREE_TIER_GEMINI_KEY = 'server-key';
    const tier = resolveTier('', 'github');
    expect(tier.level).toBe('free');
    expect(tier.serverProvidedKey).toBe(true);
    expect(tier.pinnedModel).toBe('gemini-3.5-flash-lite'); // = DEFAULT_MODEL (t/2687)
    // t/812: no per-prompt char cap — cost is bounded by tokensPerDay + per-IP RPM.
    expect(tier.maxPromptChars).toBeUndefined();
    expect(tier.limits).toEqual({ requestsPerMinute: 12, tokensPerDay: 500_000 }); // t/3111: 24→12 (free-tier-safe per-key; pool size K=2 clears the burst)
    expect(tier.allowedBackends).toEqual(['gemini']);
  });

  it('keyless users stay anonymous (no AI) when the free key is absent', () => {
    expect(freeTierEnabled()).toBe(false);
    const tier = resolveTier('', 'github');
    expect(tier.level).toBe('anonymous');
    expect(tier.serverProvidedKey).toBeUndefined();
  });

  it('does not apply the free tier to local single-user (_local)', () => {
    process.env.FREE_TIER_GEMINI_KEY = 'server-key';
    expect(resolveTier('_local', '_local').level).toBe('anonymous');
  });

  it('signed-in users are unaffected by the free tier', () => {
    process.env.FREE_TIER_GEMINI_KEY = 'server-key';
    const tier = resolveTier('alice', 'github');
    expect(['byok', 'platform']).toContain(tier.level);
    expect(tier.serverProvidedKey).toBeUndefined();
  });

  it('restricts the free tier to gemini', () => {
    process.env.FREE_TIER_GEMINI_KEY = 'server-key';
    const tier = resolveTier('', 'github');
    expect(isBackendAllowed(tier, 'gemini')).toBe(true);
    expect(isBackendAllowed(tier, 'openai')).toBe(false);
    expect(isBackendAllowed(tier, 'groq')).toBe(false);
  });
});

// t/4486#4 (TL review): byokGeminiFallbackKey used to read process.env.FREE_TIER_GEMINI_KEY
// directly and return the actual key(s) — a fourth, ungated bypass of the free-pool geo
// restriction. It's now byokGeminiFallbackApplies: a PURE decision with NO env read. The actual
// key fetch moved to the caller (routes/ai.ts, routes/chat.ts), through the same geo-gated
// ai/freePoolKeyAccess.ts accessor the free tier itself uses — covered by
// freePoolGeoRouteIntegration.test.ts, not here (this file no longer touches the env var for
// this decision at all, by design).
describe('byokGeminiFallbackApplies (t/945, t/4486#4)', () => {
  it('applies to a Claude-only BYOK user on a Gemini-pinned stage (AC#1/#2)', () => {
    expect(byokGeminiFallbackApplies('byok', 'gemini', undefined)).toBe(true);
  });

  it('does NOT apply when the BYOK user already has a key', () => {
    expect(byokGeminiFallbackApplies('byok', 'gemini', 'user-gemini-key')).toBe(false);
    expect(byokGeminiFallbackApplies('byok', 'gemini', ['a', 'b'])).toBe(false);
  });

  it('only applies to BYOK + gemini (AC#5: platform/free/other backends unchanged)', () => {
    expect(byokGeminiFallbackApplies('byok', 'claude', undefined)).toBe(false); // non-gemini backend
    expect(byokGeminiFallbackApplies('platform', 'gemini', undefined)).toBe(false);
    expect(byokGeminiFallbackApplies('anonymous', 'gemini', undefined)).toBe(false);
    expect(byokGeminiFallbackApplies('free', 'gemini', undefined)).toBe(false);
  });
});

// t/3061 — separate embed bucket so generate rate-limits don't starve local ONNX ops.
// freeTierEmbeddingGate uses "embed:<ip>" (LOCAL_EMBED_RPM_PER_IP) while the generate
// gate uses "free:<ip>" (tier.limits.requestsPerMinute). These tests assert the buckets
// are fully independent at the rateLimiter layer — the source of truth for the fix.

let seq3061 = 0;
const embedIp = () => `10.0.3061.${++seq3061}`;

describe('t/3061 — embed:<ip> bucket is independent of free:<ip> (fix arm)', () => {
  it('embedding requests succeed even when the generate (free:<ip>) bucket is exhausted', () => {
    const ip = embedIp();
    const freeKey = `free:${ip}`;
    const embedKey = `embed:${ip}`;
    const apiRpm = 6; // arbitrary small bucket limit — this test asserts bucket independence, not the RPM value (scaledFreeTierRpm(1) is 24 since t/3104)

    // Exhaust the generate API bucket (free:<ip>).
    for (let i = 0; i < apiRpm; i++) {
      expect(checkRate(freeKey, apiRpm, 60_000).allowed).toBe(true);
    }
    expect(checkRate(freeKey, apiRpm, 60_000).allowed).toBe(false); // API bucket full

    // The embed bucket is untouched — ONNX ops should still be allowed.
    expect(checkRate(embedKey, LOCAL_EMBED_RPM_PER_IP, 60_000).allowed).toBe(true);
  });

  it('embed:<ip> and free:<ip> are distinct keys — exhausting one does not affect the other', () => {
    const ip = embedIp();
    const freeKey = `free:${ip}`;
    const embedKey = `embed:${ip}`;

    expect(checkRate(freeKey, 1, 60_000).allowed).toBe(true);
    expect(checkRate(freeKey, 1, 60_000).allowed).toBe(false); // free exhausted
    expect(checkRate(embedKey, 1, 60_000).allowed).toBe(true); // embed unaffected
  });
});

describe('t/3061 — NLI key threading: free-tier passes key pool to classifyNli (t/1650 regression guard)', () => {
  afterEach(() => { delete process.env.FREE_TIER_GEMINI_KEY; });

  it('when FREE_TIER_GEMINI_KEY is set, parseFreeTierKeys returns a non-empty array (the key the NLI route threads)', () => {
    process.env.FREE_TIER_GEMINI_KEY = 'k1,k2';
    expect(freeTierEnabled()).toBe(true);
    const keys = parseFreeTierKeys(process.env.FREE_TIER_GEMINI_KEY);
    expect(keys.length).toBeGreaterThan(0); // NLI hosted-LLM fallback gets a key, not []
  });

  it('when FREE_TIER_GEMINI_KEY is absent, freeTierEnabled() is false and NLI key would be undefined (no-regression)', () => {
    delete process.env.FREE_TIER_GEMINI_KEY;
    expect(freeTierEnabled()).toBe(false);
    // Production code: freeTierEnabled() ? parseFreeTierKeys(...) : undefined → undefined
    const nliKey = freeTierEnabled() ? parseFreeTierKeys(process.env.FREE_TIER_GEMINI_KEY) : undefined;
    expect(nliKey).toBeUndefined();
  });
});

describe('t/3061 — embed:<ip> bucket at LOCAL_EMBED_RPM_PER_IP (bound arm)', () => {
  it('allows up to LOCAL_EMBED_RPM_PER_IP (60) embed calls, blocks the 61st', () => {
    const key = `embed:${embedIp()}`;
    for (let i = 0; i < LOCAL_EMBED_RPM_PER_IP; i++) {
      expect(checkRate(key, LOCAL_EMBED_RPM_PER_IP, 60_000).allowed).toBe(true);
    }
    const blocked = checkRate(key, LOCAL_EMBED_RPM_PER_IP, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.current).toBe(LOCAL_EMBED_RPM_PER_IP);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });
});
