// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { getConfig } from '../runtimeConfig.js';
import { log } from '../logger.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';

// ── Cross-replica correctness (t/4178, t/4176: ACA scales to N replicas, Multiple
// revision mode — no sticky sessions, so a client's requests are spread across every
// live replica). Every limiter below keeps its counters in per-PROCESS memory
// (requestWindows/genericWindows/dailyTokens), so an unadjusted limit is actually N
// independent limits — the effective cap is limit × replica-count.
//
// Decision (per t/4178, Server Auth): option (a) — divide the configured limit by
// MAX_REPLICAS, same convention as ServerAPI's rpmLimiter (t/4177). Rejected (b)
// (shared counters on /mnt/shared or Table storage): these limiters are abuse/cost
// guards, not correctness-critical exact counts — ACA's load balancer spreads a
// client's requests roughly evenly across replicas with no sticky sessions, so
// dividing by N converges to the intended aggregate bound without a new shared-state
// dependency. MAX_REPLICAS defaults to 1, so behavior is UNCHANGED until t/4181 sets it.
const MAX_REPLICAS = Math.max(1, Math.trunc(Number(process.env.MAX_REPLICAS)) || 1);

/** The per-process share of a fleet-wide `limit` at the current MAX_REPLICAS. Floors
 *  at 1 so a limit is never divided down to zero (a limit of 1 stays enforceable even
 *  at high replica counts, rather than silently blocking every request). */
function perReplicaLimit(limit: number): number {
  return Math.max(1, Math.floor(limit / MAX_REPLICAS));
}

// ── Sliding-window requests-per-minute ──

const requestWindows = new Map<string, number[]>();

export interface RateCheckResult {
  allowed: boolean;
  current: number;
  limit: number;
  retryAfterMs?: number;
}

export function checkRequestRate(userId: string, limit: number): RateCheckResult {
  const now = Date.now();
  const windowMs = getConfig().rateLimiting.windowMs; // t/929: runtime-configurable (default 60_000)
  const effectiveLimit = perReplicaLimit(limit); // t/4178: this process's share of the fleet-wide limit
  let timestamps = requestWindows.get(userId);
  if (!timestamps) { timestamps = []; requestWindows.set(userId, timestamps); }

  const cutoff = now - windowMs;
  while (timestamps.length > 0 && timestamps[0] < cutoff) timestamps.shift();

  if (timestamps.length >= effectiveLimit) {
    return { allowed: false, current: timestamps.length, limit: effectiveLimit, retryAfterMs: timestamps[0] + windowMs - now };
  }

  timestamps.push(now);
  return { allowed: true, current: timestamps.length, limit: effectiveLimit };
}

// ── Generic sliding-window limiter (arbitrary key + window) ──
// Separate from checkRequestRate's fixed 60s window so callers can use other
// windows (e.g. per-user community submits per hour, per-IP writes per minute).

const genericWindows = new Map<string, { ts: number[]; windowMs: number }>();

export function checkRate(key: string, limit: number, windowMs: number): RateCheckResult {
  const now = Date.now();
  const effectiveLimit = perReplicaLimit(limit); // t/4178: this process's share of the fleet-wide limit
  let entry = genericWindows.get(key);
  if (!entry) { entry = { ts: [], windowMs }; genericWindows.set(key, entry); }
  entry.windowMs = windowMs;

  const cutoff = now - windowMs;
  while (entry.ts.length > 0 && entry.ts[0] < cutoff) entry.ts.shift();

  if (entry.ts.length >= effectiveLimit) {
    return { allowed: false, current: entry.ts.length, limit: effectiveLimit, retryAfterMs: entry.ts[0] + windowMs - now };
  }
  entry.ts.push(now);
  return { allowed: true, current: entry.ts.length, limit: effectiveLimit };
}

// ── Daily token accumulator ──

interface DailyTokenBucket {
  date: string;
  inputTokens: number;
  outputTokens: number;
  total: number;
  milestonesLogged: Set<number>; // t/967: daily-budget thresholds already logged today
}

const dailyTokens = new Map<string, DailyTokenBucket>();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function getBucket(userId: string): DailyTokenBucket {
  const d = today();
  let bucket = dailyTokens.get(userId);
  if (!bucket || bucket.date !== d) {
    bucket = { date: d, inputTokens: 0, outputTokens: 0, total: 0, milestonesLogged: new Set() };
    dailyTokens.set(userId, bucket);
  }
  return bucket;
}

// t/967: warn when a user crosses 50/80/95% of their daily token budget — once per
// threshold per user per day — so the consumption rate is visible before the hard
// limit (not just at the rejection point). 80% and 95% also emit flight-recorder
// events so they surface in dumps.
export const TOKEN_MILESTONES = [50, 80, 95] as const;

function checkTokenMilestones(limitKey: string, bucket: DailyTokenBucket, limit: number): number | null {
  const pct = (bucket.total / limit) * 100; // `limit` here is already this process's share (t/4178) — callers pass the effective limit
  let crossed: number | null = null;
  for (const m of TOKEN_MILESTONES) {
    if (pct >= m && !bucket.milestonesLogged.has(m)) {
      bucket.milestonesLogged.add(m);
      crossed = m;
      log.server.warn({ component: 'rate-limiter', type: 'token_milestone', limitKey, milestone: `${m}%`, current: bucket.total, limit }, `Daily token usage at ${m}%`);
      if (m >= 80) {
        getGlobalRecorder()?.record({
          type: 'ai.error', component: 'rate-limiter', level: 'warn',
          message: `Daily token usage at ${m}% (${bucket.total}/${limit})`,
          data: { type: 'token_milestone', limitKey, milestone: `${m}%`, current: bucket.total, limit },
        });
      }
    }
  }
  return crossed;
}

export function recordTokenUsage(userId: string, inputTokens: number, outputTokens: number, limit?: number): number | null {
  const bucket = getBucket(userId);
  bucket.inputTokens += inputTokens;
  bucket.outputTokens += outputTokens;
  bucket.total += inputTokens + outputTokens;
  // t/4178: divide the fleet-wide daily budget by MAX_REPLICAS before milestone-checking
  // against this process's bucket — each replica accumulates only its own slice of a
  // user's day, so comparing against the undivided limit would under-fire milestones.
  if (limit && limit > 0) return checkTokenMilestones(userId, bucket, perReplicaLimit(limit));
  return null;
}

export function checkTokenLimit(userId: string, limit: number): RateCheckResult {
  const bucket = getBucket(userId);
  const effectiveLimit = perReplicaLimit(limit); // t/4178: this process's share of the fleet-wide daily budget
  return { allowed: bucket.total < effectiveLimit, current: bucket.total, limit: effectiveLimit };
}

// t/964: daily token buckets key on the UTC date (today()), so the budget resets
// at 00:00 UTC. Exposed so the budget UI can show "resets in Xh" without
// re-deriving the boundary client-side.
export function nextDailyResetUtc(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

export function getUsage(userId: string): { requestsInWindow: number; tokensToday: number; resetsAt: string } {
  const now = Date.now();
  const cutoff = now - getConfig().rateLimiting.windowMs;
  const timestamps = requestWindows.get(userId) ?? [];
  const active = timestamps.filter(t => t >= cutoff).length;
  const bucket = getBucket(userId);
  return { requestsInWindow: active, tokensToday: bucket.total, resetsAt: nextDailyResetUtc() };
}

// ── Periodic cleanup ──

setInterval(() => {
  const now = Date.now();
  const cutoff = now - getConfig().rateLimiting.cleanupCutoffMs; // hot-reloadable (default 120_000)
  for (const [key, timestamps] of requestWindows) {
    while (timestamps.length > 0 && timestamps[0] < cutoff) timestamps.shift();
    if (timestamps.length === 0) requestWindows.delete(key);
  }
  const d = today();
  for (const [key, bucket] of dailyTokens) {
    if (bucket.date !== d) dailyTokens.delete(key);
  }
  for (const [key, entry] of genericWindows) {
    const c = now - entry.windowMs;
    while (entry.ts.length > 0 && entry.ts[0] < c) entry.ts.shift();
    if (entry.ts.length === 0) genericWindows.delete(key);
  }
}, 600_000).unref();
