// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Analytics storage and query layer.
 *
 * Two backends — filesystem (Electron / local dev) and Azure Append Blob
 * (container deployments). The backend is chosen at init time based on
 * whether blob config is provided.
 *
 * Events are stored as daily NDJSON files: `YYYY-MM-DD.ndjson`.
 */

import fs from 'fs';
import path from 'path';
import { getConfig } from '../runtimeConfig.js';
import { log } from '../logger.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { ANALYTICS_EXCLUDED_SESSIONS, ANALYTICS_AMBIGUOUS_SESSIONS } from './analyticsExclusions.js';

// ── Types ──

export interface AnalyticsEvent {
  user: string;
  session_id: string;
  timestamp: string;
  event_type: string;
  category: string;
  detail: Record<string, unknown>;
  duration_ms?: number;
  /** t/4960/t/4962: stamped ONLY by ServerAPI's event-POST handler, from the tester cookie —
   *  never set anywhere in this file, and a client-supplied value in the body is ignored on
   *  that side. Absent for normal traffic. */
  internal?: boolean;
}

/**
 * t/4960: opt-in flags to INCLUDE a class this file excludes from analysis by default.
 * All four classes are read independently — `excludeAmbiguous` is the one exception where
 * the default direction is reversed (ambiguous sessions count unless this is set).
 */
export interface AnalyticsExclusionOptions {
  /** Include sessions in `ANALYTICS_EXCLUDED_SESSIONS` (staging-leak, pi-test). Default: excluded. */
  includeListed?: boolean;
  /** Include events with `internal === true`. Default: excluded. */
  includeInternal?: boolean;
  /** Include system identities (`smoke-probe`, any `smoke-*` user or session). Default: excluded. */
  includeSystem?: boolean;
  /** ALSO exclude the 2 ambiguous staging-leak sessions. Default: they count. */
  excludeAmbiguous?: boolean;
}

/** `smoke-probe` and any `smoke-*` user or session (TL t/4960#1) — CI/synthetic traffic,
 *  distinct from the frozen staging-leak smoke sessions (those are listed, not pattern-matched). */
function isSystemIdentity(evt: AnalyticsEvent): boolean {
  // Quality p/634#11: stored lines are JSON.parse-cast without validation (readEvents), so a
  // malformed/legacy event missing `user` or `session_id` must not throw here — one bad line
  // would otherwise fail every analytics query, not just skip that one event.
  const user = typeof evt.user === 'string' ? evt.user : '';
  const sessionId = typeof evt.session_id === 'string' ? evt.session_id : '';
  return user === 'smoke-probe' || user.startsWith('smoke-') || sessionId.startsWith('smoke-');
}

/**
 * Apply the three default-exclude classes (t/4960) to a batch of events, returning the
 * survivors and how many were dropped — callers log the count at debug level per TL's
 * "log, at debug level, how many events were excluded per query" requirement.
 *
 * `ANALYTICS_EXCLUSION_WINDOW` is NEVER consulted here (TL t/4960#3 condition 1) — exclusion
 * is by session id alone, since `pi-test` sessions fall outside the staging-leak window.
 */
function applyExclusions(events: AnalyticsEvent[], opts?: AnalyticsExclusionOptions): { kept: AnalyticsEvent[]; excludedCount: number } {
  let excludedCount = 0;
  const kept = events.filter((evt) => {
    if (!opts?.includeListed && ANALYTICS_EXCLUDED_SESSIONS.has(evt.session_id)) { excludedCount++; return false; }
    if (opts?.excludeAmbiguous && ANALYTICS_AMBIGUOUS_SESSIONS.has(evt.session_id)) { excludedCount++; return false; }
    if (!opts?.includeInternal && evt.internal === true) { excludedCount++; return false; }
    if (!opts?.includeSystem && isSystemIdentity(evt)) { excludedCount++; return false; }
    return true;
  });
  return { kept, excludedCount };
}

interface UserSummary {
  user: string;
  lastActive: string;
  sessions: number;
  events: number;
  topCategory: string;
}

interface DailySummary {
  date: string;
  events: number;
  users: number;
  sessions: number;
}

/** Summed AI usage/cost for one model (t/892). */
export interface AiCostBucket {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

/** Summed AI usage/cost across all `ai.call` events, with a per-model breakdown. */
export interface AiCostSummary extends AiCostBucket {
  byModel: Record<string, AiCostBucket>;
}

export interface QueryResult {
  summary: {
    activeUsers: number;
    sessions: number;
    totalEvents: number;
    avgSessionDurationMs: number;
  };
  daily: DailySummary[];
  featureUsage: Record<string, number>;
  users: UserSummary[];
  /** Counts keyed by event_type (t/891 debate.complete/abandon, t/893 funnel). */
  eventTypes: Record<string, number>;
  /** Summed AI usage/cost from `ai.call` detail (t/892). */
  aiCost: AiCostSummary;
}

// ── Backend abstraction ──

export interface AnalyticsBackend {
  append(date: string, lines: string[]): Promise<void>;
  readLines(date: string): Promise<string[]>;
  listDates(): Promise<string[]>;
  prune(cutoffDate: string): Promise<void>;
  /**
   * t/2704: startup health probe. Surfaces backend inaccessibility by THROWING —
   * unlike listDates()/readLines(), which swallow errors and return [] (so they can't
   * distinguish "broken" from "empty"). Resolves when the store is reachable.
   */
  probe(): Promise<void>;
}

export interface AnalyticsBlobConfig {
  accountUrl: string;
  container: string;
  /** Test seam: inject a pre-built BlobServiceClient. */
  serviceClient?: unknown;
}

// ── Filesystem backend ──

class FsAnalyticsBackend implements AnalyticsBackend {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  async append(date: string, lines: string[]): Promise<void> {
    const filePath = path.join(this.dir, `${date}.ndjson`);
    fs.appendFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
  }

  async readLines(date: string): Promise<string[]> {
    const filePath = path.join(this.dir, `${date}.ndjson`);
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
  }

  async listDates(): Promise<string[]> {
    try {
      return fs.readdirSync(this.dir)
        .filter(f => f.endsWith('.ndjson'))
        .map(f => f.replace('.ndjson', ''));
    } catch (err) {
      log.analytics.warn({ err, dir: this.dir }, 'analytics: listDates readdir failed — treated as no dates');
      return [];
    }
  }

  async prune(cutoffDate: string): Promise<void> {
    try {
      const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.ndjson'));
      for (const f of files) {
        const date = f.replace('.ndjson', '');
        if (date < cutoffDate) {
          fs.unlinkSync(path.join(this.dir, f));
        }
      }
    } catch { /* telemetry — silent by design;  best-effort cleanup */ }
  }

  async probe(): Promise<void> {
    // The constructor already mkdir -p'd the dir; a readdir confirms it is accessible.
    // Unlike listDates() this does NOT swallow — an inaccessible dir throws.
    await fs.promises.readdir(this.dir);
  }
}

// ── Module state ──

let backend: AnalyticsBackend | null = null;

function cutoffStr(): string {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - getConfig().analytics.retentionDays);
  return cutoff.toISOString().slice(0, 10);
}

// ── Public API ──

export async function initAnalytics(dataRoot: string, blobConfig?: AnalyticsBlobConfig): Promise<void> {
  if (blobConfig?.accountUrl) {
    const { BlobAnalyticsBackend } = await import('../storage/analyticsBlob.js');
    backend = new BlobAnalyticsBackend({
      accountUrl: blobConfig.accountUrl,
      container: blobConfig.container,
      serviceClient: blobConfig.serviceClient as import('@azure/storage-blob').BlobServiceClient | undefined,
    });
  } else {
    backend = new FsAnalyticsBackend(path.join(dataRoot, 'analytics'));
  }
  await backend.prune(cutoffStr());
}

/**
 * Startup health report (t/2704). Exercises the analytics backend so a broken or empty
 * pipeline is observable at startup instead of surfacing later as a silently empty
 * dashboard (t/2699). `backend.probe()` throws on inaccessibility (auth/network/missing
 * container) → logged at error + a flight-recorder `system.error`. A reachable store then
 * reports its partition count, so "reachable but empty" — the state that masquerades as
 * broken — is a distinct warn, not an error. Called once, right after initAnalytics.
 */
export async function reportStartupProbe(backendKind: string, container: string): Promise<void> {
  log.analytics.info({ backend: backendKind }, 'Analytics initialized');
  if (!backend) {
    log.analytics.error({ backend: backendKind, container }, 'Analytics store startup probe: backend not initialized');
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'analytics', level: 'error',
      message: 'Analytics store not initialized at startup probe',
      data: { backend: backendKind, container },
    });
    return;
  }
  try {
    await backend.probe();
  } catch (err) {
    log.analytics.error({ backend: backendKind, container, err }, 'Analytics store startup probe failed — pipeline may be broken');
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'analytics', level: 'error',
      message: 'Analytics store startup probe failed',
      data: { backend: backendKind, container },
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return;
  }
  const dates = await backend.listDates();
  if (dates.length === 0) {
    log.analytics.warn({ backend: backendKind, dateCount: 0 }, 'Analytics store reachable but contains no data');
  } else {
    log.analytics.info({ backend: backendKind, dateCount: dates.length }, 'Analytics store probe OK');
  }
}

/** Append a batch of events. Fire-and-forget safe — errors are recorded, not thrown. */
export async function appendEvents(events: AnalyticsEvent[]): Promise<void> {
  if (!backend || events.length === 0) return;

  const byDate = new Map<string, string[]>();
  for (const evt of events) {
    const date = evt.timestamp.slice(0, 10);
    const lines = byDate.get(date) || [];
    lines.push(JSON.stringify(evt));
    byDate.set(date, lines);
  }

  for (const [date, lines] of byDate) {
    try {
      await backend.append(date, lines);
    } catch (err) {
      log.analytics.error({ err, date, count: lines.length }, 'analytics: append failed, events dropped');
    }
  }
}

/**
 * Read all events in a date range (inclusive), with the t/4960 default-exclude filter applied.
 * Single chokepoint: every public query function funnels through here, so the filter (and its
 * debug-level excluded-count log) applies exactly once, never duplicated per query.
 */
async function readEvents(from: string, to: string, exclusionOpts?: AnalyticsExclusionOptions): Promise<AnalyticsEvent[]> {
  if (!backend) return [];

  const events: AnalyticsEvent[] = [];
  const start = new Date(from);
  const end = new Date(to);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const lines = await backend.readLines(date);
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as AnalyticsEvent);
      } catch { /* telemetry — silent by design;  skip malformed lines */ }
    }
  }

  const { kept, excludedCount } = applyExclusions(events, exclusionOpts);
  if (excludedCount > 0) {
    log.analytics.debug({ from, to, excludedCount, totalRead: events.length }, 'analytics: excluded events for this query (t/4960)');
  }
  return kept;
}

// ── Aggregation accumulators ──

type DailyEntry = { events: number; users: Set<string>; sessions: Set<string> };
type UserEntry = { lastActive: string; sessions: Set<string>; events: number; categories: Record<string, number> };
type SessionEntry = { first: number; last: number };

/** t/892: sum AI usage/cost from an `ai.call` event's detail (additive, one pass). */
function accumulateAiCost(aiCost: AiCostSummary, evt: AnalyticsEvent): void {
  if (evt.event_type !== 'ai.call') return;
  const d = evt.detail || {};
  const tokensIn = Number(d.tokens_in) || 0;
  const tokensOut = Number(d.tokens_out) || 0;
  const costUsd = Number(d.estimated_cost_usd) || 0;
  const model = typeof d.model === 'string' && d.model ? d.model : 'unknown';
  aiCost.calls++; aiCost.tokensIn += tokensIn; aiCost.tokensOut += tokensOut; aiCost.costUsd += costUsd;
  let m = aiCost.byModel[model];
  if (!m) { m = { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 }; aiCost.byModel[model] = m; }
  m.calls++; m.tokensIn += tokensIn; m.tokensOut += tokensOut; m.costUsd += costUsd;
}

/** Roll one event into the per-day totals (events + distinct users/sessions). */
function accumulateDaily(dailyMap: Map<string, DailyEntry>, evt: AnalyticsEvent): void {
  const date = evt.timestamp.slice(0, 10);
  let daily = dailyMap.get(date);
  if (!daily) { daily = { events: 0, users: new Set(), sessions: new Set() }; dailyMap.set(date, daily); }
  daily.events++;
  daily.users.add(evt.user);
  daily.sessions.add(evt.session_id);
}

/** Roll one event into the per-user summary (last-active, sessions, categories). */
function accumulateUser(userMap: Map<string, UserEntry>, evt: AnalyticsEvent): void {
  let u = userMap.get(evt.user);
  if (!u) { u = { lastActive: evt.timestamp, sessions: new Set(), events: 0, categories: {} }; userMap.set(evt.user, u); }
  if (evt.timestamp > u.lastActive) u.lastActive = evt.timestamp;
  u.sessions.add(evt.session_id);
  u.events++;
  u.categories[evt.category] = (u.categories[evt.category] || 0) + 1;
}

/** Track first/last event timestamps for one session (for duration averaging). */
function accumulateSession(sessionTimes: Map<string, SessionEntry>, evt: AnalyticsEvent): void {
  const ts = new Date(evt.timestamp).getTime();
  let sess = sessionTimes.get(evt.session_id);
  if (!sess) { sess = { first: ts, last: ts }; sessionTimes.set(evt.session_id, sess); }
  if (ts < sess.first) sess.first = ts;
  if (ts > sess.last) sess.last = ts;
}

/** Mean session duration in ms across sessions with a positive span (0 if none). */
function meanSessionDurationMs(sessionTimes: Map<string, SessionEntry>): number {
  let totalDuration = 0;
  let sessionCount = 0;
  for (const sess of sessionTimes.values()) {
    const dur = sess.last - sess.first;
    if (dur > 0) { totalDuration += dur; sessionCount++; }
  }
  return sessionCount > 0 ? Math.round(totalDuration / sessionCount) : 0;
}

/** Query aggregated analytics for a date range. */
export async function queryAggregated(from: string, to: string, exclusionOpts?: AnalyticsExclusionOptions): Promise<QueryResult> {
  const events = await readEvents(from, to, exclusionOpts);

  const userSet = new Set<string>();
  const sessionSet = new Set<string>();
  const featureUsage: Record<string, number> = {};
  const eventTypes: Record<string, number> = {};
  const aiCost: AiCostSummary = { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, byModel: {} };
  const dailyMap = new Map<string, DailyEntry>();
  const userMap = new Map<string, UserEntry>();
  const sessionTimes = new Map<string, SessionEntry>();

  for (const evt of events) {
    userSet.add(evt.user);
    sessionSet.add(evt.session_id);

    featureUsage[evt.category] = (featureUsage[evt.category] || 0) + 1;
    eventTypes[evt.event_type] = (eventTypes[evt.event_type] || 0) + 1;

    accumulateAiCost(aiCost, evt);
    accumulateDaily(dailyMap, evt);
    accumulateUser(userMap, evt);
    accumulateSession(sessionTimes, evt);
  }

  const avgSessionDurationMs = meanSessionDurationMs(sessionTimes);

  const daily: DailySummary[] = Array.from(dailyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({ date, events: d.events, users: d.users.size, sessions: d.sessions.size }));

  const users: UserSummary[] = Array.from(userMap.entries())
    .map(([user, u]) => {
      const topCategory = Object.entries(u.categories).sort(([, a], [, b]) => b - a)[0]?.[0] || '';
      return { user, lastActive: u.lastActive, sessions: u.sessions.size, events: u.events, topCategory };
    })
    .sort((a, b) => b.lastActive.localeCompare(a.lastActive));

  // Round summed costs to 6 dp to avoid floating-point accumulation noise.
  const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
  aiCost.costUsd = round6(aiCost.costUsd);
  for (const m of Object.values(aiCost.byModel)) m.costUsd = round6(m.costUsd);

  return {
    summary: {
      activeUsers: userSet.size,
      sessions: sessionSet.size,
      totalEvents: events.length,
      avgSessionDurationMs,
    },
    daily,
    featureUsage,
    users,
    eventTypes,
    aiCost,
  };
}

/** Query raw events for a specific user and/or session. */
export async function queryRawEvents(from: string, to: string, user?: string, sessionId?: string, exclusionOpts?: AnalyticsExclusionOptions): Promise<AnalyticsEvent[]> {
  const events = await readEvents(from, to, exclusionOpts);
  return events.filter(e =>
    (!user || e.user === user) && (!sessionId || e.session_id === sessionId)
  );
}

// ── Engagement aggregation (t/2467) ──

const KNOWN_CAMPS = new Set(['acc', 'saf', 'skp', 'cc']);

// t/3420/t/3421: client-side idle-inflation (renewable per-visit cap + idle tail counted as
// engaged) let a single visit's engaged_ms grow unbounded. Winsorize at aggregation so the
// CURRENT dashboard view is robust immediately, independent of the client-side dwellTracker
// fixes landing separately.
const ENGAGED_MS_WINSORIZE_CAP = 10 * 60 * 1000; // 10min per visit

/** Cap a single visit's engaged_ms contribution before summing into any aggregate. */
function winsorizedEngagedMs(evt: AnalyticsEvent): number {
  const raw = typeof evt.duration_ms === 'number' ? evt.duration_ms : 0;
  return Math.min(raw, ENGAGED_MS_WINSORIZE_CAP);
}

// t/3423: per-subject daily ceiling — caps total engaged_ms creditable to one subject_id per
// (user, UTC calendar day) at SUBJECT_DAILY_CEILING_MS, the cap the PI believed already existed.
// Composes with the per-visit winsorize above: winsorize bounds one visit, this bounds the day
// (a visit is winsorized FIRST, then the winsorized amount is clipped against the remaining
// daily budget — bounds compose, they don't cancel).
//
// Keying uses the UTC calendar day (evt.timestamp is always a UTC ISO string, sliced to
// YYYY-MM-DD) — NOT server-local time — so the boundary is the same regardless of deployment
// timezone. Anonymous events (empty evt.user) fall back to session_id for the user component of
// the key: without this, every anonymous visitor would pool into ONE shared daily budget instead
// of each anonymous session getting its own.
//
// Events must be processed in timestamp order for the cumulative clip to be deterministic —
// readEvents()'s day-file-append order is not guaranteed chronological across concurrent writers.

/** Precompute each event's billable engaged_ms (winsorized, then clipped to the subject's remaining daily budget). Must be called once per query over the full relevant event set; event identity (object reference) is the map key. */
function computeBillableEngagedMs(events: AnalyticsEvent[]): Map<AnalyticsEvent, number> {
  const ceilingMs = getConfig().analytics.SUBJECT_DAILY_CEILING_MS;
  const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const remainingBudget = new Map<string, number>();
  const billable = new Map<AnalyticsEvent, number>();
  for (const evt of sorted) {
    const winsorized = winsorizedEngagedMs(evt);
    const subjectId = typeof evt.detail.subject_id === 'string' ? evt.detail.subject_id.slice(0, 100) : '';
    if (!subjectId || winsorized === 0) { billable.set(evt, winsorized); continue; }
    const userKey = evt.user || evt.session_id;
    const day = evt.timestamp.slice(0, 10); // UTC calendar day
    const key = `${userKey}|${subjectId}|${day}`;
    const remaining = remainingBudget.has(key) ? remainingBudget.get(key)! : ceilingMs;
    const billableMs = Math.min(winsorized, remaining);
    remainingBudget.set(key, remaining - billableMs);
    billable.set(evt, billableMs);
  }
  return billable;
}

/** Per-node engagement stats. `uniqueUsers` is present on aggregate rollups only. */
export interface EngagementNodeResult {
  visits: number;
  engagedVisits: number;
  engagedMs: number;
  cappedRate: number;
  uniqueUsers?: number;
}

export interface EngagementCategoryResult extends EngagementNodeResult {
  nodes: Record<string, EngagementNodeResult>;
}

export interface EngagementCampResult extends EngagementNodeResult {
  categories: Record<string, EngagementCategoryResult>;
}

/** Engagement tree: tool root → camps (taxonomy nodes) + tabs (non-taxonomy). */
export interface EngagementTree {
  tool: EngagementNodeResult;
  camps: Record<string, EngagementCampResult>;
  tabs: Record<string, EngagementNodeResult>;
}

/** One entry per calendar day in the query range that received view.dwell events. */
export interface EngagementDailyEntry {
  date: string;
  visits: number;
  engagedVisits: number;
  engagedMs: number;
}

/** Per-user engagement rollup (admin-gated; strip before sending to non-admins). */
export interface EngagementUserEntry {
  user: string;
  visits: number;
  engagedVisits: number;
  engagedMs: number;
  topCamp: string;
  lastActive: string;
}

/** Per-session rollup (admin-gated; present only when opts.includeSessions is requested). */
export interface EngagementSessionEntry {
  session: string;
  startTime: string;    // ISO — first view.dwell timestamp for this session within [from, to]
  engagedMs: number;
  nodeCount: number;    // distinct visited subject_ids (100-char cap, matches node accumulator)
}

export interface EngagementQueryResult {
  aggregate: EngagementTree;
  /** Per-day engaged totals for section 1 of the dashboard. */
  daily: EngagementDailyEntry[];
  /** Per-user rollup for section 5; caller must strip for non-admins before sending. */
  users: EngagementUserEntry[];
  /** Present when opts.user was requested. */
  user?: EngagementTree;
  /** Present only when opts.includeSessions; admin-gated by the route layer. */
  sessions?: EngagementSessionEntry[];
}

interface EngAccum {
  visits: number;
  engagedVisits: number;
  engagedMs: number;
  cappedCount: number;
  users: Set<string>;
}

function mkAccum(): EngAccum {
  return { visits: 0, engagedVisits: 0, engagedMs: 0, cappedCount: 0, users: new Set() };
}

function addToAccum(acc: EngAccum, evt: AnalyticsEvent, billableMs: number): void {
  acc.visits++;
  if (evt.detail.engaged === true) acc.engagedVisits++;
  acc.engagedMs += billableMs;
  if (evt.detail.capped === true) acc.cappedCount++;
  acc.users.add(evt.user);
}

function sealAccum(acc: EngAccum, withUsers: boolean): EngagementNodeResult {
  const cappedRate = acc.visits > 0 ? acc.cappedCount / acc.visits : 0;
  return {
    visits: acc.visits,
    engagedVisits: acc.engagedVisits,
    engagedMs: acc.engagedMs,
    cappedRate: Math.round(cappedRate * 1e4) / 1e4,
    ...(withUsers ? { uniqueUsers: acc.users.size } : {}),
  };
}

interface DailyEngAccum { visits: number; engagedVisits: number; engagedMs: number }
interface UserEngAccum { visits: number; engagedVisits: number; engagedMs: number; lastActive: string; campCounts: Map<string, number> }
interface SessionEngEntry { startTime: string; engagedMs: number; nodes: Set<string>; user: string }

interface EngState {
  tool: EngAccum;
  camps: Map<string, EngAccum>;
  categories: Map<string, EngAccum>;
  nodes: Map<string, EngAccum>;
  tabs: Map<string, EngAccum>;
  daily: Map<string, DailyEngAccum>;
  userSummaries: Map<string, UserEngAccum>;
  /** null when not tracking sessions (ordinary queries pay no allocation cost). */
  sessionEntries: Map<string, SessionEngEntry> | null;
}

function mkState(includeSessions = false): EngState {
  return { tool: mkAccum(), camps: new Map(), categories: new Map(), nodes: new Map(), tabs: new Map(), daily: new Map(), userSummaries: new Map(), sessionEntries: includeSessions ? new Map() : null };
}

function getOrMake(m: Map<string, EngAccum>, key: string): EngAccum {
  let a = m.get(key);
  if (!a) { a = mkAccum(); m.set(key, a); }
  return a;
}

/** Place one view.dwell event into all accumulators (tree + daily + userSummaries). Malformed ids go to tabs['other']. billableMs is the pre-winsorized, pre-ceiling-clipped engaged_ms for this event (t/3421 + t/3423). */
function placeEvent(state: EngState, evt: AnalyticsEvent, billableMs: number): void {
  const d = evt.detail;
  const subjectType = typeof d.subject_type === 'string' ? d.subject_type : '';
  if (subjectType !== 'node' && subjectType !== 'tab' && subjectType !== 'panel') return;

  addToAccum(state.tool, evt, billableMs);

  // Daily roll-up
  const date = evt.timestamp.slice(0, 10);
  let day = state.daily.get(date);
  if (!day) { day = { visits: 0, engagedVisits: 0, engagedMs: 0 }; state.daily.set(date, day); }
  day.visits++;
  if (d.engaged === true) day.engagedVisits++;
  day.engagedMs += billableMs;

  // Per-user summary roll-up
  let u = state.userSummaries.get(evt.user);
  if (!u) { u = { visits: 0, engagedVisits: 0, engagedMs: 0, lastActive: evt.timestamp, campCounts: new Map() }; state.userSummaries.set(evt.user, u); }
  u.visits++;
  if (d.engaged === true) u.engagedVisits++;
  u.engagedMs += billableMs;
  if (evt.timestamp > u.lastActive) u.lastActive = evt.timestamp;

  // Tree placement
  if (subjectType === 'node') {
    const pov = typeof d.pov === 'string' ? d.pov : '';
    const cat = typeof d.cat === 'string' ? d.cat : '';
    const subjectId = typeof d.subject_id === 'string' ? d.subject_id.slice(0, 100) : '';
    if (pov && KNOWN_CAMPS.has(pov)) {
      addToAccum(getOrMake(state.camps, pov), evt, billableMs);
      if (u) u.campCounts.set(pov, (u.campCounts.get(pov) ?? 0) + 1);
      if (cat) {
        addToAccum(getOrMake(state.categories, `${pov}-${cat}`), evt, billableMs);
        if (subjectId) addToAccum(getOrMake(state.nodes, subjectId), evt, billableMs);
      }
    } else {
      addToAccum(getOrMake(state.tabs, 'other'), evt, billableMs);
    }
  } else {
    const tabKey = (typeof d.subject_id === 'string' && d.subject_id) ? d.subject_id.slice(0, 100) : 'unknown';
    addToAccum(getOrMake(state.tabs, tabKey), evt, billableMs);
  }

  // Session entry tracking — gated on sessionEntries != null (only allocated when includeSessions)
  if (state.sessionEntries !== null) {
    const sessId = evt.session_id;
    let se = state.sessionEntries.get(sessId);
    if (!se) { se = { startTime: evt.timestamp, engagedMs: 0, nodes: new Set(), user: evt.user }; state.sessionEntries.set(sessId, se); }
    if (evt.timestamp < se.startTime) se.startTime = evt.timestamp;
    se.engagedMs += billableMs;
    // nodeCount: cap subject_id at 100 chars to match the node accumulator bound above
    const subId = typeof d.subject_id === 'string' && d.subject_id ? d.subject_id.slice(0, 100) : '';
    if (subId) se.nodes.add(subId);
  }
}

function buildTree(state: EngState, withUsers: boolean): EngagementTree {
  const camps: Record<string, EngagementCampResult> = {};
  for (const [campId, campAcc] of state.camps) {
    const categories: Record<string, EngagementCategoryResult> = {};
    for (const [catKey, catAcc] of state.categories) {
      if (!catKey.startsWith(`${campId}-`)) continue;
      const nodes: Record<string, EngagementNodeResult> = {};
      for (const [nodeId, nodeAcc] of state.nodes) {
        if (nodeId.startsWith(`${catKey}-`)) nodes[nodeId] = sealAccum(nodeAcc, withUsers);
      }
      categories[catKey] = { ...sealAccum(catAcc, withUsers), nodes };
    }
    camps[campId] = { ...sealAccum(campAcc, withUsers), categories };
  }
  const tabs: Record<string, EngagementNodeResult> = {};
  for (const [tabId, tabAcc] of state.tabs) tabs[tabId] = sealAccum(tabAcc, withUsers);
  return { tool: sealAccum(state.tool, withUsers), camps, tabs };
}

/**
 * Aggregate view.dwell events into a tool→camp→category→node engagement tree,
 * a daily series, and a per-user rollup — all in one pass.
 * opts.user    → also returns that user's subtree (without uniqueUsers).
 * opts.session → aggregate + daily recomputed for that session only (§7.1).
 * opts.includeSessions → adds sessions list (scoped to opts.user if set; admin-gated by caller).
 * No opts → output is byte-identical to the pre-extension t/2463 result.
 * Callers are responsible for stripping users/sessions before sending to non-admin clients.
 */
export async function queryEngagement(
  from: string,
  to: string,
  opts?: { user?: string; session?: string; includeSessions?: boolean } & AnalyticsExclusionOptions,
): Promise<EngagementQueryResult> {
  const events = await readEvents(from, to, opts);
  const dwellEvents = events.filter(e => e.event_type === 'view.dwell');
  const billable = computeBillableEngagedMs(dwellEvents);
  const aggState = mkState(!!opts?.includeSessions);
  const userState = opts?.user ? mkState(false) : null;
  const sessionState = opts?.session ? mkState(false) : null;

  for (const evt of dwellEvents) {
    const billableMs = billable.get(evt) ?? 0;
    placeEvent(aggState, evt, billableMs);
    if (userState && evt.user === opts!.user) placeEvent(userState, evt, billableMs);
    if (sessionState && evt.session_id === opts!.session) placeEvent(sessionState, evt, billableMs);
  }

  const sourceState = sessionState ?? aggState;

  const daily: EngagementDailyEntry[] = Array.from(sourceState.daily.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({ date, visits: d.visits, engagedVisits: d.engagedVisits, engagedMs: d.engagedMs }));

  const users: EngagementUserEntry[] = Array.from(aggState.userSummaries.entries())
    .map(([userId, u]) => {
      const topCamp = [...u.campCounts.entries()].sort(([, a], [, b]) => b - a)[0]?.[0] ?? '';
      return { user: userId, visits: u.visits, engagedVisits: u.engagedVisits, engagedMs: u.engagedMs, topCamp, lastActive: u.lastActive };
    })
    .sort((a, b) => b.lastActive.localeCompare(a.lastActive));

  let sessions: EngagementSessionEntry[] | undefined;
  if (opts?.includeSessions && aggState.sessionEntries) {
    const filterUser = opts.user;
    sessions = Array.from(aggState.sessionEntries.entries())
      .filter(([, se]) => !filterUser || se.user === filterUser)
      .map(([session, se]) => ({ session, startTime: se.startTime, engagedMs: se.engagedMs, nodeCount: se.nodes.size }))
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
  }

  return {
    aggregate: buildTree(sourceState, true),
    daily,
    users,
    ...(userState ? { user: buildTree(userState, false) } : {}),
    ...(sessions !== undefined ? { sessions } : {}),
  };
}

/** Subject-scoped WHO breakdown for the leaf panel (spec §7.3).
 *  One row per distinct user or session that viewed this subject, summing engagedMs + visits.
 *  If user is provided, only that user's events are included (for the user-scoped leaf panel). */
export type SubjectBreakdownRow =
  | { user: string; engagedMs: number; visits: number }
  | { session: string; engagedMs: number; visits: number };

export interface SubjectBreakdownResult { rows: SubjectBreakdownRow[]; }

export async function querySubjectBreakdown(
  from: string,
  to: string,
  subjectId: string,
  groupBy: 'user' | 'session',
  user?: string,
  exclusionOpts?: AnalyticsExclusionOptions,
): Promise<SubjectBreakdownResult> {
  const events = await readEvents(from, to, exclusionOpts);
  const matching = events.filter(e =>
    e.event_type === 'view.dwell' &&
    typeof e.detail.subject_id === 'string' && e.detail.subject_id === subjectId &&
    (user === undefined || e.user === user),
  );
  // Billable per-event ceiling must be computed over this subject's full matching set — a
  // single user's daily budget for this subject depends only on their own events for it, so
  // restricting to `matching` before computing is equivalent to computing over all events.
  const billable = computeBillableEngagedMs(matching);
  const acc = new Map<string, { engagedMs: number; visits: number }>();
  for (const evt of matching) {
    const key = groupBy === 'user' ? evt.user : evt.session_id;
    let entry = acc.get(key);
    if (!entry) { entry = { engagedMs: 0, visits: 0 }; acc.set(key, entry); }
    entry.visits++;
    entry.engagedMs += billable.get(evt) ?? 0;
  }
  const rows: SubjectBreakdownRow[] = Array.from(acc.entries())
    .sort(([, a], [, b]) => b.engagedMs - a.engagedMs)
    .map(([key, e]) =>
      groupBy === 'user'
        ? { user: key, engagedMs: e.engagedMs, visits: e.visits }
        : { session: key, engagedMs: e.engagedMs, visits: e.visits },
    );
  return { rows };
}
