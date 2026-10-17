// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Runtime configuration reader (t/926, spec: docs/design/runtime-config-spec.md).
 *
 * Externalizes ~52 previously-hardcoded server/client parameters into an optional
 * `{dataRoot}/admin/runtime-config.json` file with hot-reload. Follows the
 * established mtime-cache pattern (quotas.ts, proxyTiers.ts, providerBinding.ts)
 * with a tighter 5s TTL because this config backs everything.
 *
 * Fail-safe by design: a missing file, malformed JSON, or out-of-range values all
 * degrade to the hardcoded DEFAULTS (the app behaves exactly as it does today).
 * Partial configs deep-merge over defaults; bad individual fields fall back to
 * their default and are reported in `errors[]` for the admin UI.
 */

import fs from 'fs';
import path from 'path';
import { getStateRoot } from './config.js';
import { log } from './logger.js';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';
import { DEFAULT_MODEL } from '../../../lib/ai-client/index.js';

// ── Types (mirror runtime-config-spec.md §3) ──

export interface TierConfig {
  requestsPerMinute: number;
  tokensPerDay: number;
  allowedBackends: string[];
}

export interface FreeTierConfig extends TierConfig {
  pinnedModel: string;
}

export interface RuntimeConfig {
  resilience: {
    circuitThreshold: number;
    circuitCooldownMs: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
    retryJitterMaxMs: number;
    maxRetryAfterMs: number;
    throttleWindowSize: number;
    throttleBaselineCount: number;
    throttleEnterFactor: number;
    throttleExitFactor: number;
    throttleDelayMs: number;
  };
  rateLimiting: {
    windowMs: number;
    cleanupCutoffMs: number;
  };
  tiers: {
    platform: TierConfig;
    byok: TierConfig;
    anonymous: TierConfig;
    free: FreeTierConfig;
  };
  quotas: {
    defaultMaxChats: number;
    defaultMaxDebates: number;
    defaultMaxOpEds: number;
    defaultMaxBriefExports: number;
  };
  sessions: {
    anonymousTtlMs: number;
    anonymousMaxSessions: number;
    anonymousMaxSizeBytes: number;
    tokenFreshnessThresholdMs: number;
    lockAcquireTimeoutMs: number;
    lockHoldTtlMs: number;
  };
  analytics: {
    retentionDays: number;
    bufferRequeueLimit: number;
    /** t/2472: dwell engagement thresholds (docs/ux/usage-analytics-instrumentation.md §3.3) */
    IDLE_TIMEOUT_MS: number;
    MAX_ENGAGED_MS: number;
    ENGAGED_MIN_MS: number;
    MIN_VISIT_MS: number;
    PULSE_THROTTLE_MS: number;
    /** t/3420: grace window after the last pulse that still counts as engaged on an idle-close —
     *  caps the idle-tail bleed into engaged_ms (the idle timer itself fires IDLE_TIMEOUT_MS later). */
    IDLE_GRACE_MS: number;
    /** t/3422: each pulse grants engagement credit valid through t + CREDIT_WINDOW_MS. */
    CREDIT_WINDOW_MS: number;
    /** t/3423: server-side aggregation only (not shipped to the client) — caps total engaged_ms
     *  creditable to one subject_id per (user, UTC calendar day). Composes with the per-visit
     *  ENGAGED_MS_WINSORIZE_CAP in analytics.ts: winsorize bounds one visit, this bounds the day. */
    SUBJECT_DAILY_CEILING_MS: number;
  };
  flightRecorder: {
    minDumpIntervalMs: number;
    maxDumpsPerWindow: number;
    dumpWindowMs: number;
    maxRetainedDumps: number;
    maxTotalDumpSizeBytes: number;
  };
  community: {
    maxPendingPerUser: number;
    globalPendingCap: number;
  };
  feedback: {
    defaultPageLimit: number;
    maxPageLimit: number;
  };
  server: {
    conflictsCacheTtlMs: number;
    gitCloneTimeoutMs: number;
    gitFetchTimeoutMs: number;
    gitDefaultTimeoutMs: number;
    gitBufferLimitBytes: number;
    apiKeyMaskLength: number;
  };
  cache: {
    defaultTtlMs: number;
  };
  debate: {
    defaultConfrontationRounds: number;
    defaultArgumentationRounds: number;
    defaultConcludingRounds: number;
    defaultTemperature: number;
    briefStageTemperature: number;
    planStageTemperature: number;
    draftStageTemperature: number;
    citeStageTemperature: number;
    evaluatorTemperature: number;
    summarizationTemperature: number;
    summarizationMaxTokens: number;
    evaluatorMaxTokens: number;
    defaultTimeoutMs: number;
    maxRegenAttempts: number;
  };
  generation: {
    opedVoiceTimeoutMs: number;
  };
  /** t/4262: the t/4251 renderer poll gate's live switch, read from GET /api/config/client.
   *  Read by the renderer poll gate (`pollGate.isPollAllowed`, #3388). T0 per TL p/336#614.
   *  Default false until t/4258 AC2 lands. Flipping the default to true is a TL/PI decision —
   *  not part of this ticket. */
  pollGate: {
    enabled: boolean;
  };
}

// Mirror of the backend ids in ai-models.json (t/1513). Used to validate admin
// overrides of tier allowedBackends — must include every backend the system can
// route to, or valid overrides get silently dropped by vBackends().
export const KNOWN_BACKENDS = ['gemini', 'claude', 'groq', 'openai', 'deepseek', 'azure', 'zai', 'moonshot', 'xai', 'ollama'] as const;

// Range bounds (spec §3.2).
const DURATION_MAX = 86_400_000; // 24h
const GIT_TIMEOUT_MAX = 3_600_000; // 1h
const SIZE_MAX = 1_073_741_824; // 1 GB
const TOKENS_MAX = 100_000_000;
const RPM_MAX = 1_000;
const QUOTA_MAX = 10_000;

const DEFAULTS: RuntimeConfig = {
  resilience: {
    circuitThreshold: 5,
    circuitCooldownMs: 60_000,
    retryBaseDelayMs: 1_000,
    retryMaxDelayMs: 30_000,
    retryJitterMaxMs: 500,
    maxRetryAfterMs: 30_000,
    throttleWindowSize: 20,
    throttleBaselineCount: 10,
    throttleEnterFactor: 2.0,
    throttleExitFactor: 1.5,
    throttleDelayMs: 2_000,
  },
  rateLimiting: {
    windowMs: 60_000,
    cleanupCutoffMs: 120_000,
  },
  tiers: {
    platform: { requestsPerMinute: 60, tokensPerDay: 2_000_000, allowedBackends: [...KNOWN_BACKENDS] }, // t/1513: all system backends — key-presence gates actual availability
    byok: { requestsPerMinute: 30, tokensPerDay: 2_000_000, allowedBackends: [...KNOWN_BACKENDS] }, // t/965: 500K → 2M (a single 10-round debate uses 300–500K; BYOK users pay their own API). t/1513: BYOK users bring their own keys — no reason to cap the backend set
    anonymous: { requestsPerMinute: 10, tokensPerDay: 100_000, allowedBackends: ['gemini', 'claude', 'groq'] }, // t/1513: intentionally limited — anonymous users bring no keys, so they use platform-provided keys (same rationale as free tier); do NOT widen without a cost/abuse review
    free: { requestsPerMinute: 6, tokensPerDay: 500_000, allowedBackends: ['gemini'], pinnedModel: DEFAULT_MODEL }, // t/1061: 50K → 500K (single debate round ≈ 54K; 50K budget made debates non-functional)
  },
  quotas: {
    defaultMaxChats: 25,
    defaultMaxDebates: 15,
    defaultMaxOpEds: 15,
    defaultMaxBriefExports: 25, // t/2831: product-confirmed (25/user) — billable-spend cap for any signed-in identity incl. headless AAD principals (entitlement: t/2862); matches maxChats
  },
  sessions: {
    anonymousTtlMs: 14_400_000,
    anonymousMaxSessions: 100,
    anonymousMaxSizeBytes: 10_485_760,
    tokenFreshnessThresholdMs: 60_000,
    lockAcquireTimeoutMs: 10_000,
    lockHoldTtlMs: 30_000,
  },
  analytics: {
    retentionDays: 90,
    bufferRequeueLimit: 500,
    IDLE_TIMEOUT_MS: 60_000,
    MAX_ENGAGED_MS: 1_800_000,
    ENGAGED_MIN_MS: 8_000,
    MIN_VISIT_MS: 1_000,
    PULSE_THROTTLE_MS: 5_000,
    IDLE_GRACE_MS: 10_000,
    CREDIT_WINDOW_MS: 15_000,
    SUBJECT_DAILY_CEILING_MS: 1_800_000,
  },
  flightRecorder: {
    minDumpIntervalMs: 10_000,
    maxDumpsPerWindow: 5,
    dumpWindowMs: 60_000,
    maxRetainedDumps: 20,
    maxTotalDumpSizeBytes: 52_428_800,
  },
  community: {
    maxPendingPerUser: 20,
    globalPendingCap: 500,
  },
  feedback: {
    defaultPageLimit: 50,
    maxPageLimit: 200,
  },
  server: {
    conflictsCacheTtlMs: 300_000,
    gitCloneTimeoutMs: 300_000,
    gitFetchTimeoutMs: 600_000,
    gitDefaultTimeoutMs: 120_000,
    gitBufferLimitBytes: 10_485_760,
    apiKeyMaskLength: 4,
  },
  cache: {
    defaultTtlMs: 30_000,
  },
  debate: {
    defaultConfrontationRounds: 1,
    defaultArgumentationRounds: 2,
    defaultConcludingRounds: 1,
    defaultTemperature: 0.7,
    briefStageTemperature: 0.15,
    planStageTemperature: 0.4,
    draftStageTemperature: 0.7,
    citeStageTemperature: 0.15,
    evaluatorTemperature: 0.2,
    summarizationTemperature: 0.3,
    summarizationMaxTokens: 500,
    evaluatorMaxTokens: 8192,
    defaultTimeoutMs: 120_000,
    maxRegenAttempts: 3,
  },
  generation: {
    opedVoiceTimeoutMs: 360_000, // 6 min; New-OpEd = grounding + full-essay LLM (debate briefs use 330s)
  },
  pollGate: {
    enabled: false, // t/4262: off until t/4258 AC2 lands (TL/PI decision, not this ticket)
  },
};

// ── Field validation helpers ──

interface NumOpts { min: number; max: number; integer?: boolean }

/** Validate a numeric field: type-check, round integers, clamp to [min,max]. */
function vNum(val: unknown, def: number, opts: NumOpts, field: string, errors: string[]): number {
  if (val === undefined) return def;
  if (typeof val !== 'number' || Number.isNaN(val) || !Number.isFinite(val)) {
    errors.push(`${field}: expected number, got ${typeof val} — using default ${def}`);
    return def;
  }
  let v = val;
  if (opts.integer && !Number.isInteger(v)) v = Math.round(v);
  if (v < opts.min) { errors.push(`${field}: ${val} below min ${opts.min} — clamped`); v = opts.min; }
  if (v > opts.max) { errors.push(`${field}: ${val} above max ${opts.max} — clamped`); v = opts.max; }
  return v;
}

/** Throttle factor: must be > 1.0 (spec §3.2). Invalid → default; too large → clamped. */
function vFactor(val: unknown, def: number, field: string, errors: string[]): number {
  if (val === undefined) return def;
  if (typeof val !== 'number' || Number.isNaN(val) || !Number.isFinite(val)) {
    errors.push(`${field}: expected number, got ${typeof val} — using default ${def}`);
    return def;
  }
  if (val <= 1.0) { errors.push(`${field}: ${val} must be > 1.0 — using default ${def}`); return def; }
  if (val > 100) { errors.push(`${field}: ${val} above max 100 — clamped`); return 100; }
  return val;
}

function vStr(val: unknown, def: string, field: string, errors: string[]): string {
  if (val === undefined) return def;
  if (typeof val !== 'string' || val.length === 0) {
    errors.push(`${field}: expected non-empty string — using default "${def}"`);
    return def;
  }
  return val;
}

function vBool(val: unknown, def: boolean, field: string, errors: string[]): boolean {
  if (val === undefined) return def;
  if (typeof val !== 'boolean') {
    errors.push(`${field}: expected boolean, got ${typeof val} — using default ${def}`);
    return def;
  }
  return val;
}

/** allowedBackends: non-empty array of known backends; unknown items dropped (spec §3.2). */
function vBackends(val: unknown, def: string[], field: string, errors: string[]): string[] {
  if (val === undefined) return [...def];
  if (!Array.isArray(val) || val.length === 0) {
    errors.push(`${field}: expected non-empty array — using default`);
    return [...def];
  }
  const filtered = val.filter((b): b is string => typeof b === 'string' && (KNOWN_BACKENDS as readonly string[]).includes(b));
  if (filtered.length === 0) {
    errors.push(`${field}: no known backends (allowed: ${KNOWN_BACKENDS.join(', ')}) — using default`);
    return [...def];
  }
  if (filtered.length !== val.length) {
    const dropped = val.filter(b => !(typeof b === 'string' && (KNOWN_BACKENDS as readonly string[]).includes(b)));
    errors.push(`${field}: dropped ${val.length - filtered.length} unknown/invalid backend(s)`);
    // t/1995: a silently-dropped backend (e.g. a newly-added one still missing from
    // KNOWN_BACKENDS) previously surfaced only as a UI "(not on your tier)" with no
    // server-side evidence. Emit a runtime warn naming the dropped backend(s) so it's a
    // one-line log read, not a config-diff hunt. (errors[] above is aggregated post-load.)
    log.server.warn(
      { component: 'runtime-config', field, dropped, allowed: [...KNOWN_BACKENDS] },
      `vBackends: dropped unknown backend(s) ${dropped.map(d => `'${String(d)}'`).join(', ')} from ${field} — add to KNOWN_BACKENDS to register`,
    );
  }
  return filtered;
}

/** Return raw[key] if it's a plain object, else {} (so absent/wrong-type sections fall to defaults). */
function section(raw: Record<string, unknown>, key: string, errors: string[]): Record<string, unknown> {
  const v = raw[key];
  if (v === undefined) return {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    errors.push(`${key}: expected object — section ignored, using defaults`);
    return {};
  }
  return v as Record<string, unknown>;
}

function mergeTier(raw: Record<string, unknown>, def: TierConfig, name: string, errors: string[]): TierConfig {
  return {
    requestsPerMinute: vNum(raw.requestsPerMinute, def.requestsPerMinute, { min: 1, max: RPM_MAX, integer: true }, `tiers.${name}.requestsPerMinute`, errors),
    tokensPerDay: vNum(raw.tokensPerDay, def.tokensPerDay, { min: 0, max: TOKENS_MAX, integer: true }, `tiers.${name}.tokensPerDay`, errors),
    allowedBackends: vBackends(raw.allowedBackends, def.allowedBackends, `tiers.${name}.allowedBackends`, errors),
  };
}

/**
 * Deep-merge `raw` over `defaults`, validating each field. Returns the merged
 * config plus an `errors[]` array (empty when clean). Out-of-range values clamp;
 * wrong-typed fields fall back to their default; a non-v1 file or a cross-field
 * violation reverts the affected scope to defaults (spec §4.2, §7.1).
 */
export function validateAndMerge(raw: unknown, defaults: RuntimeConfig): { config: RuntimeConfig; errors: string[] } {
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('root: config is not an object — using defaults');
    return { config: structuredClone(defaults), errors };
  }
  const r = raw as Record<string, unknown>;

  // Forward-compat guard: refuse to merge a config authored against a newer schema.
  const meta = r._meta;
  if (meta && typeof meta === 'object' && !Array.isArray(meta) && 'version' in meta) {
    const ver = (meta as Record<string, unknown>).version;
    if (ver !== 1) {
      errors.push(`_meta.version: expected 1, got ${JSON.stringify(ver)} — refusing to merge a non-v1 config, using defaults`);
      return { config: structuredClone(defaults), errors };
    }
  }

  const res = section(r, 'resilience', errors);
  const rl = section(r, 'rateLimiting', errors);
  const tiers = section(r, 'tiers', errors);
  const q = section(r, 'quotas', errors);
  const sess = section(r, 'sessions', errors);
  const an = section(r, 'analytics', errors);
  const fr = section(r, 'flightRecorder', errors);
  const comm = section(r, 'community', errors);
  const fb = section(r, 'feedback', errors);
  const srv = section(r, 'server', errors);
  const cache = section(r, 'cache', errors);
  const deb = section(r, 'debate', errors);
  const gen = section(r, 'generation', errors);
  const pg = section(r, 'pollGate', errors);

  let resilience: RuntimeConfig['resilience'] = {
    circuitThreshold: vNum(res.circuitThreshold, defaults.resilience.circuitThreshold, { min: 1, max: 1_000, integer: true }, 'resilience.circuitThreshold', errors),
    circuitCooldownMs: vNum(res.circuitCooldownMs, defaults.resilience.circuitCooldownMs, { min: 0, max: DURATION_MAX }, 'resilience.circuitCooldownMs', errors),
    retryBaseDelayMs: vNum(res.retryBaseDelayMs, defaults.resilience.retryBaseDelayMs, { min: 0, max: DURATION_MAX }, 'resilience.retryBaseDelayMs', errors),
    retryMaxDelayMs: vNum(res.retryMaxDelayMs, defaults.resilience.retryMaxDelayMs, { min: 0, max: DURATION_MAX }, 'resilience.retryMaxDelayMs', errors),
    retryJitterMaxMs: vNum(res.retryJitterMaxMs, defaults.resilience.retryJitterMaxMs, { min: 0, max: DURATION_MAX }, 'resilience.retryJitterMaxMs', errors),
    maxRetryAfterMs: vNum(res.maxRetryAfterMs, defaults.resilience.maxRetryAfterMs, { min: 0, max: DURATION_MAX }, 'resilience.maxRetryAfterMs', errors),
    throttleWindowSize: vNum(res.throttleWindowSize, defaults.resilience.throttleWindowSize, { min: 1, max: 10_000, integer: true }, 'resilience.throttleWindowSize', errors),
    throttleBaselineCount: vNum(res.throttleBaselineCount, defaults.resilience.throttleBaselineCount, { min: 1, max: 10_000, integer: true }, 'resilience.throttleBaselineCount', errors),
    throttleEnterFactor: vFactor(res.throttleEnterFactor, defaults.resilience.throttleEnterFactor, 'resilience.throttleEnterFactor', errors),
    throttleExitFactor: vFactor(res.throttleExitFactor, defaults.resilience.throttleExitFactor, 'resilience.throttleExitFactor', errors),
    throttleDelayMs: vNum(res.throttleDelayMs, defaults.resilience.throttleDelayMs, { min: 0, max: DURATION_MAX }, 'resilience.throttleDelayMs', errors),
  };
  // Cross-field: exit factor must stay below enter factor (spec §3.2). On violation
  // the whole resilience section reverts to defaults (spec §7.1).
  if (resilience.throttleExitFactor >= resilience.throttleEnterFactor) {
    errors.push(`resilience: throttleExitFactor (${resilience.throttleExitFactor}) must be < throttleEnterFactor (${resilience.throttleEnterFactor}) — reverting resilience section to defaults`);
    resilience = structuredClone(defaults.resilience);
  }

  const config: RuntimeConfig = {
    resilience,
    rateLimiting: {
      windowMs: vNum(rl.windowMs, defaults.rateLimiting.windowMs, { min: 0, max: DURATION_MAX }, 'rateLimiting.windowMs', errors),
      cleanupCutoffMs: vNum(rl.cleanupCutoffMs, defaults.rateLimiting.cleanupCutoffMs, { min: 0, max: DURATION_MAX }, 'rateLimiting.cleanupCutoffMs', errors),
    },
    tiers: {
      platform: mergeTier(section(tiers, 'platform', errors), defaults.tiers.platform, 'platform', errors),
      byok: mergeTier(section(tiers, 'byok', errors), defaults.tiers.byok, 'byok', errors),
      anonymous: mergeTier(section(tiers, 'anonymous', errors), defaults.tiers.anonymous, 'anonymous', errors),
      free: {
        ...mergeTier(section(tiers, 'free', errors), defaults.tiers.free, 'free', errors),
        pinnedModel: vStr(section(tiers, 'free', errors).pinnedModel, defaults.tiers.free.pinnedModel, 'tiers.free.pinnedModel', errors),
      },
    },
    quotas: {
      defaultMaxChats: vNum(q.defaultMaxChats, defaults.quotas.defaultMaxChats, { min: 1, max: QUOTA_MAX, integer: true }, 'quotas.defaultMaxChats', errors),
      defaultMaxDebates: vNum(q.defaultMaxDebates, defaults.quotas.defaultMaxDebates, { min: 1, max: QUOTA_MAX, integer: true }, 'quotas.defaultMaxDebates', errors),
      defaultMaxOpEds: vNum(q.defaultMaxOpEds, defaults.quotas.defaultMaxOpEds, { min: 1, max: QUOTA_MAX, integer: true }, 'quotas.defaultMaxOpEds', errors),
      defaultMaxBriefExports: vNum(q.defaultMaxBriefExports, defaults.quotas.defaultMaxBriefExports, { min: 1, max: QUOTA_MAX, integer: true }, 'quotas.defaultMaxBriefExports', errors),
    },
    sessions: {
      anonymousTtlMs: vNum(sess.anonymousTtlMs, defaults.sessions.anonymousTtlMs, { min: 0, max: DURATION_MAX }, 'sessions.anonymousTtlMs', errors),
      anonymousMaxSessions: vNum(sess.anonymousMaxSessions, defaults.sessions.anonymousMaxSessions, { min: 1, max: 1_000_000, integer: true }, 'sessions.anonymousMaxSessions', errors),
      anonymousMaxSizeBytes: vNum(sess.anonymousMaxSizeBytes, defaults.sessions.anonymousMaxSizeBytes, { min: 0, max: SIZE_MAX, integer: true }, 'sessions.anonymousMaxSizeBytes', errors),
      tokenFreshnessThresholdMs: vNum(sess.tokenFreshnessThresholdMs, defaults.sessions.tokenFreshnessThresholdMs, { min: 0, max: DURATION_MAX }, 'sessions.tokenFreshnessThresholdMs', errors),
      lockAcquireTimeoutMs: vNum(sess.lockAcquireTimeoutMs, defaults.sessions.lockAcquireTimeoutMs, { min: 0, max: DURATION_MAX }, 'sessions.lockAcquireTimeoutMs', errors),
      lockHoldTtlMs: vNum(sess.lockHoldTtlMs, defaults.sessions.lockHoldTtlMs, { min: 0, max: DURATION_MAX }, 'sessions.lockHoldTtlMs', errors),
    },
    analytics: {
      retentionDays: vNum(an.retentionDays, defaults.analytics.retentionDays, { min: 1, max: 3_650, integer: true }, 'analytics.retentionDays', errors),
      bufferRequeueLimit: vNum(an.bufferRequeueLimit, defaults.analytics.bufferRequeueLimit, { min: 0, max: 1_000_000, integer: true }, 'analytics.bufferRequeueLimit', errors),
      IDLE_TIMEOUT_MS: vNum(an.IDLE_TIMEOUT_MS, defaults.analytics.IDLE_TIMEOUT_MS, { min: 0, max: DURATION_MAX }, 'analytics.IDLE_TIMEOUT_MS', errors),
      MAX_ENGAGED_MS: vNum(an.MAX_ENGAGED_MS, defaults.analytics.MAX_ENGAGED_MS, { min: 0, max: DURATION_MAX }, 'analytics.MAX_ENGAGED_MS', errors),
      ENGAGED_MIN_MS: vNum(an.ENGAGED_MIN_MS, defaults.analytics.ENGAGED_MIN_MS, { min: 0, max: DURATION_MAX }, 'analytics.ENGAGED_MIN_MS', errors),
      MIN_VISIT_MS: vNum(an.MIN_VISIT_MS, defaults.analytics.MIN_VISIT_MS, { min: 0, max: DURATION_MAX }, 'analytics.MIN_VISIT_MS', errors),
      PULSE_THROTTLE_MS: vNum(an.PULSE_THROTTLE_MS, defaults.analytics.PULSE_THROTTLE_MS, { min: 0, max: DURATION_MAX }, 'analytics.PULSE_THROTTLE_MS', errors),
      IDLE_GRACE_MS: vNum(an.IDLE_GRACE_MS, defaults.analytics.IDLE_GRACE_MS, { min: 0, max: DURATION_MAX }, 'analytics.IDLE_GRACE_MS', errors),
      CREDIT_WINDOW_MS: vNum(an.CREDIT_WINDOW_MS, defaults.analytics.CREDIT_WINDOW_MS, { min: 0, max: DURATION_MAX }, 'analytics.CREDIT_WINDOW_MS', errors),
      SUBJECT_DAILY_CEILING_MS: vNum(an.SUBJECT_DAILY_CEILING_MS, defaults.analytics.SUBJECT_DAILY_CEILING_MS, { min: 0, max: DURATION_MAX }, 'analytics.SUBJECT_DAILY_CEILING_MS', errors),
    },
    flightRecorder: {
      minDumpIntervalMs: vNum(fr.minDumpIntervalMs, defaults.flightRecorder.minDumpIntervalMs, { min: 0, max: DURATION_MAX }, 'flightRecorder.minDumpIntervalMs', errors),
      maxDumpsPerWindow: vNum(fr.maxDumpsPerWindow, defaults.flightRecorder.maxDumpsPerWindow, { min: 1, max: 1_000, integer: true }, 'flightRecorder.maxDumpsPerWindow', errors),
      dumpWindowMs: vNum(fr.dumpWindowMs, defaults.flightRecorder.dumpWindowMs, { min: 0, max: DURATION_MAX }, 'flightRecorder.dumpWindowMs', errors),
      maxRetainedDumps: vNum(fr.maxRetainedDumps, defaults.flightRecorder.maxRetainedDumps, { min: 1, max: 10_000, integer: true }, 'flightRecorder.maxRetainedDumps', errors),
      maxTotalDumpSizeBytes: vNum(fr.maxTotalDumpSizeBytes, defaults.flightRecorder.maxTotalDumpSizeBytes, { min: 0, max: SIZE_MAX, integer: true }, 'flightRecorder.maxTotalDumpSizeBytes', errors),
    },
    community: {
      maxPendingPerUser: vNum(comm.maxPendingPerUser, defaults.community.maxPendingPerUser, { min: 1, max: 10_000, integer: true }, 'community.maxPendingPerUser', errors),
      globalPendingCap: vNum(comm.globalPendingCap, defaults.community.globalPendingCap, { min: 1, max: 1_000_000, integer: true }, 'community.globalPendingCap', errors),
    },
    feedback: {
      defaultPageLimit: vNum(fb.defaultPageLimit, defaults.feedback.defaultPageLimit, { min: 1, max: 10_000, integer: true }, 'feedback.defaultPageLimit', errors),
      maxPageLimit: vNum(fb.maxPageLimit, defaults.feedback.maxPageLimit, { min: 1, max: 10_000, integer: true }, 'feedback.maxPageLimit', errors),
    },
    server: {
      conflictsCacheTtlMs: vNum(srv.conflictsCacheTtlMs, defaults.server.conflictsCacheTtlMs, { min: 0, max: DURATION_MAX }, 'server.conflictsCacheTtlMs', errors),
      gitCloneTimeoutMs: vNum(srv.gitCloneTimeoutMs, defaults.server.gitCloneTimeoutMs, { min: 0, max: GIT_TIMEOUT_MAX }, 'server.gitCloneTimeoutMs', errors),
      gitFetchTimeoutMs: vNum(srv.gitFetchTimeoutMs, defaults.server.gitFetchTimeoutMs, { min: 0, max: GIT_TIMEOUT_MAX }, 'server.gitFetchTimeoutMs', errors),
      gitDefaultTimeoutMs: vNum(srv.gitDefaultTimeoutMs, defaults.server.gitDefaultTimeoutMs, { min: 0, max: GIT_TIMEOUT_MAX }, 'server.gitDefaultTimeoutMs', errors),
      gitBufferLimitBytes: vNum(srv.gitBufferLimitBytes, defaults.server.gitBufferLimitBytes, { min: 0, max: SIZE_MAX, integer: true }, 'server.gitBufferLimitBytes', errors),
      apiKeyMaskLength: vNum(srv.apiKeyMaskLength, defaults.server.apiKeyMaskLength, { min: 0, max: 64, integer: true }, 'server.apiKeyMaskLength', errors),
    },
    cache: {
      defaultTtlMs: vNum(cache.defaultTtlMs, defaults.cache.defaultTtlMs, { min: 0, max: DURATION_MAX }, 'cache.defaultTtlMs', errors),
    },
    debate: {
      defaultConfrontationRounds: vNum(deb.defaultConfrontationRounds, defaults.debate.defaultConfrontationRounds, { min: 1, max: 20, integer: true }, 'debate.defaultConfrontationRounds', errors),
      defaultArgumentationRounds: vNum(deb.defaultArgumentationRounds, defaults.debate.defaultArgumentationRounds, { min: 1, max: 20, integer: true }, 'debate.defaultArgumentationRounds', errors),
      defaultConcludingRounds: vNum(deb.defaultConcludingRounds, defaults.debate.defaultConcludingRounds, { min: 1, max: 20, integer: true }, 'debate.defaultConcludingRounds', errors),
      defaultTemperature: vNum(deb.defaultTemperature, defaults.debate.defaultTemperature, { min: 0, max: 2 }, 'debate.defaultTemperature', errors),
      briefStageTemperature: vNum(deb.briefStageTemperature, defaults.debate.briefStageTemperature, { min: 0, max: 2 }, 'debate.briefStageTemperature', errors),
      planStageTemperature: vNum(deb.planStageTemperature, defaults.debate.planStageTemperature, { min: 0, max: 2 }, 'debate.planStageTemperature', errors),
      draftStageTemperature: vNum(deb.draftStageTemperature, defaults.debate.draftStageTemperature, { min: 0, max: 2 }, 'debate.draftStageTemperature', errors),
      citeStageTemperature: vNum(deb.citeStageTemperature, defaults.debate.citeStageTemperature, { min: 0, max: 2 }, 'debate.citeStageTemperature', errors),
      evaluatorTemperature: vNum(deb.evaluatorTemperature, defaults.debate.evaluatorTemperature, { min: 0, max: 2 }, 'debate.evaluatorTemperature', errors),
      summarizationTemperature: vNum(deb.summarizationTemperature, defaults.debate.summarizationTemperature, { min: 0, max: 2 }, 'debate.summarizationTemperature', errors),
      summarizationMaxTokens: vNum(deb.summarizationMaxTokens, defaults.debate.summarizationMaxTokens, { min: 100, max: 32_768, integer: true }, 'debate.summarizationMaxTokens', errors),
      evaluatorMaxTokens: vNum(deb.evaluatorMaxTokens, defaults.debate.evaluatorMaxTokens, { min: 100, max: 32_768, integer: true }, 'debate.evaluatorMaxTokens', errors),
      defaultTimeoutMs: vNum(deb.defaultTimeoutMs, defaults.debate.defaultTimeoutMs, { min: 5_000, max: DURATION_MAX }, 'debate.defaultTimeoutMs', errors),
      maxRegenAttempts: vNum(deb.maxRegenAttempts, defaults.debate.maxRegenAttempts, { min: 0, max: 10, integer: true }, 'debate.maxRegenAttempts', errors),
    },
    generation: {
      opedVoiceTimeoutMs: vNum(gen.opedVoiceTimeoutMs, defaults.generation.opedVoiceTimeoutMs, { min: 60_000, max: 3_600_000 }, 'generation.opedVoiceTimeoutMs', errors),
    },
    pollGate: {
      enabled: vBool(pg.enabled, defaults.pollGate.enabled, 'pollGate.enabled', errors),
    },
  };

  return { config, errors };
}

// ── Config loading with mtime cache (5s TTL — tighter than quotas.ts) ──

let _cache: RuntimeConfig | null = null;
let _cacheMtime = 0;
let _lastLoadTime = 0;
const CACHE_TTL = 5_000;

function configPath(): string {
  // t/2643: runtime config is class-A writable state → the writable state root.
  return path.join(getStateRoot(), 'admin', 'runtime-config.json');
}

function loadConfig(): RuntimeConfig {
  const p = configPath();
  try {
    // t/2019 (js/file-system-race): stat and read the SAME fd, not the path twice —
    // fstat(fd)+read(fd) can't race a swap/unlink between a path stat and a path read.
    // openSync throws ENOENT (no override file) → the catch below degrades to defaults.
    const fd = fs.openSync(p, 'r');
    try {
      const stat = fs.fstatSync(fd);
      if (_cache && stat.mtimeMs === _cacheMtime) return _cache;
      const raw = JSON.parse(fs.readFileSync(fd, 'utf-8'));
      const { config, errors } = validateAndMerge(raw, DEFAULTS);
      if (errors.length > 0) {
        log.server.warn({ component: 'runtime-config', path: p, errorCount: errors.length, errors: errors.slice(0, 20) }, 'Runtime config loaded with validation issues');
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'runtime-config', level: 'warn',
          message: `Runtime config loaded with ${errors.length} validation issue(s)`,
          data: { errors: errors.slice(0, 20) },
        });
      }
      _cache = config;
      _cacheMtime = stat.mtimeMs;
      return _cache;
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    // ENOENT is the common, expected case (no override file → defaults). Anything
    // else (malformed JSON, permissions) is surfaced before degrading to defaults.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.server.warn({ component: 'runtime-config', path: p, err: (err as Error).message }, 'Invalid runtime config — using defaults');
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'runtime-config', level: 'warn',
        message: 'Failed to load runtime config — using defaults',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }
    return DEFAULTS;
  }
}

/** Current runtime config (merged over defaults), re-read at most once per 5s. */
export function getConfig(): RuntimeConfig {
  const now = Date.now();
  if (now - _lastLoadTime > CACHE_TTL) {
    _lastLoadTime = now;
    return loadConfig();
  }
  return _cache ?? loadConfig();
}

/**
 * Force an immediate cache invalidation + re-read (backs POST /api/admin/config/reload).
 * `ok` is true when a config file was actually loaded, false when it fell back to
 * hardcoded defaults (missing/unreadable file).
 */
export function forceReload(): { ok: boolean; errors?: string[] } {
  _cache = null;
  _cacheMtime = 0;
  _lastLoadTime = Date.now();
  try {
    const config = loadConfig();
    return { ok: config !== DEFAULTS };
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'runtime-config', level: 'warn',
      message: 'Runtime config force-reload failed',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return { ok: false, errors: [String(err)] };
  }
}

/** A deep copy of the hardcoded defaults (safe for callers to mutate). */
export function getDefaults(): RuntimeConfig {
  return structuredClone(DEFAULTS);
}

// ── REST-endpoint support (t/927) ──

export interface ConfigState {
  config: RuntimeConfig;
  defaults: RuntimeConfig;
  errors: string[];
  fileExists: boolean;
  lastModified: string | null;
}

/**
 * Fresh, un-cached snapshot for `GET /api/admin/config`: the merged config, the
 * hardcoded defaults, any validation errors, whether the file exists, and its
 * mtime. Admin reads are infrequent, so this bypasses the 5s cache for accuracy.
 */
export function getConfigState(): ConfigState {
  const p = configPath();
  try {
    // t/2019 (js/file-system-race): fstat + read one fd, not two path operations.
    const fd = fs.openSync(p, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const raw = JSON.parse(fs.readFileSync(fd, 'utf-8'));
      const { config, errors } = validateAndMerge(raw, DEFAULTS);
      return { config, defaults: getDefaults(), errors, fileExists: true, lastModified: new Date(stat.mtimeMs).toISOString() };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'runtime-config', level: 'warn',
        message: 'Failed to read runtime config for admin view',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return { config: getDefaults(), defaults: getDefaults(), errors: [String(err)], fileExists: true, lastModified: null };
    }
    return { config: getDefaults(), defaults: getDefaults(), errors: [], fileExists: false, lastModified: null };
  }
}

/**
 * Validate `incoming` (deep-merged over the *current* config) and, only if it is
 * clean, persist the full validated config with refreshed `_meta`. Backs
 * `PUT /api/admin/config`: any validation error means the file is left untouched
 * and the errors are returned for the admin UI (spec §4.4). On success the cache
 * is force-reloaded so the new values take effect immediately.
 */
export function writeConfig(incoming: unknown, updatedBy: string): { ok: boolean; errors: string[] } {
  const base = getConfig(); // partial PUT bodies merge over the live config, not defaults
  const { config, errors } = validateAndMerge(incoming, base);
  if (errors.length > 0) return { ok: false, errors };
  const p = configPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const out = {
      $schema: './runtime-config.schema.json',
      _meta: { version: 1, updatedAt: new Date().toISOString(), updatedBy },
      ...config,
    };
    fs.writeFileSync(p, JSON.stringify(out, null, 2), 'utf-8');
    forceReload();
    return { ok: true, errors: [] };
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'runtime-config', level: 'error',
      message: 'Failed to write runtime config',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return { ok: false, errors: [`write failed: ${String(err)}`] };
  }
}

export interface ConfigDiffEntry { path: string; current: unknown; default: unknown }

function collectDiff(cur: unknown, def: unknown, prefix: string, out: ConfigDiffEntry[]): void {
  if (cur !== null && typeof cur === 'object' && !Array.isArray(cur) &&
      def !== null && typeof def === 'object' && !Array.isArray(def)) {
    const c = cur as Record<string, unknown>;
    const d = def as Record<string, unknown>;
    for (const key of Object.keys(d)) {
      collectDiff(c[key], d[key], prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  // Leaf (number, string, or array) — compare by value.
  if (JSON.stringify(cur) !== JSON.stringify(def)) {
    out.push({ path: prefix, current: cur, default: def });
  }
}

/** Leaves of the live config that differ from defaults (backs GET /api/admin/config/diff). */
export function diffFromDefaults(): ConfigDiffEntry[] {
  const out: ConfigDiffEntry[] = [];
  collectDiff(getConfig(), DEFAULTS, '', out);
  return out;
}

export interface ClientConfig {
  resilience: RuntimeConfig['resilience'];
  flightRecorder: Pick<RuntimeConfig['flightRecorder'], 'minDumpIntervalMs' | 'maxDumpsPerWindow' | 'dumpWindowMs'>;
  analytics: Pick<RuntimeConfig['analytics'], 'bufferRequeueLimit' | 'IDLE_TIMEOUT_MS' | 'MAX_ENGAGED_MS' | 'ENGAGED_MIN_MS' | 'MIN_VISIT_MS' | 'PULSE_THROTTLE_MS' | 'IDLE_GRACE_MS' | 'CREDIT_WINDOW_MS'>;
  debate: RuntimeConfig['debate'];
  pollGate: RuntimeConfig['pollGate'];
}

/**
 * The client-relevant config subset for the (public) `GET /api/config/client`.
 * Contains no secrets — these are the same values currently hardcoded in the
 * shipped renderer bundle (spec §8.2).
 */
export function getClientConfig(): ClientConfig {
  const c = getConfig();
  return {
    resilience: c.resilience,
    flightRecorder: {
      minDumpIntervalMs: c.flightRecorder.minDumpIntervalMs,
      maxDumpsPerWindow: c.flightRecorder.maxDumpsPerWindow,
      dumpWindowMs: c.flightRecorder.dumpWindowMs,
    },
    analytics: {
      bufferRequeueLimit: c.analytics.bufferRequeueLimit,
      IDLE_TIMEOUT_MS: c.analytics.IDLE_TIMEOUT_MS,
      MAX_ENGAGED_MS: c.analytics.MAX_ENGAGED_MS,
      ENGAGED_MIN_MS: c.analytics.ENGAGED_MIN_MS,
      MIN_VISIT_MS: c.analytics.MIN_VISIT_MS,
      PULSE_THROTTLE_MS: c.analytics.PULSE_THROTTLE_MS,
      IDLE_GRACE_MS: c.analytics.IDLE_GRACE_MS,
      CREDIT_WINDOW_MS: c.analytics.CREDIT_WINDOW_MS,
    },
    debate: c.debate,
    pollGate: c.pollGate,
  };
}
