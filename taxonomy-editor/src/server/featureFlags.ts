// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Feature-flag evaluation engine (t/899, design: feature-flags-proposal.md §D).
 *
 * Reads admin/feature-flags.json with an mtime cache (30s TTL) — same pattern as
 * quotas.ts / proxyTiers.ts. Resolution is fail-closed: unknown, disabled, or
 * expired flags return false, as does any scope the current user doesn't match.
 *
 * Scope grammar (compound parts joined by '+', ALL must match):
 *   global                 — everyone
 *   role:admin             — admin users (ADMIN_USERS)
 *   user:jpsnover,alice    — listed principals / storage ids
 *   env:web | env:electron — the running environment
 *   role:admin+env:web     — admin AND web
 *
 * Persistence caveat (flagged on the ticket): writes land in <dataRoot>/admin,
 * which in the Azure deployment is ephemeral /tmp — admin edits reset on restart
 * unless that path is backed by durable storage. The committed seed file is the
 * durable baseline.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getStateRoot } from './config.js';
import { log } from './logger.js';
import { getCurrentUser } from './security/userContext.js';
import { isAdmin } from './community/community.js';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';

// ── Types ──

export interface FlagDef {
  name: string;
  enabled: boolean;
  /** Scope expression (default 'global'). */
  scope: string;
  description?: string;
  created_at: string;
  updated_at: string;
  created_by?: string;
  /** ISO timestamp after which the flag evaluates false, or null/undefined. */
  expires_at?: string | null;
}

interface FlagsConfig { flags: Record<string, FlagDef> }

export interface FlagAuditEntry {
  timestamp: string;
  action: 'set' | 'delete';
  flag: string;
  by: string;
  before?: FlagDef | null;
  after?: FlagDef | null;
}

/** Evaluation context — extracted so scope logic is pure + testable. */
export interface FlagUserContext {
  storageUserId: string;
  principalName: string;
  isAdmin: boolean;
  env: 'web' | 'electron';
}

// Seeded baseline (t/899): release-qbaf-analysis on, global. Used when the
// config file is absent/unreadable so flags resolve even before a file exists.
const SEED_FLAGS: Record<string, FlagDef> = {
  'release-qbaf-analysis': {
    name: 'release-qbaf-analysis', enabled: true, scope: 'global',
    description: 'Release gate for QBAF analysis feature',
    created_at: '2026-06-23T00:00:00.000Z', updated_at: '2026-06-23T00:00:00.000Z',
    created_by: 'seed',
  },
  'env-web-analytics-dashboard': {
    name: 'env-web-analytics-dashboard', enabled: true, scope: 'env:web',
    description: 'Show analytics dashboard route and nav shortcuts (web only)',
    created_at: '2026-06-24T00:00:00.000Z', updated_at: '2026-06-24T00:00:00.000Z',
    created_by: 'seed',
  },
  'env-web-community-library': {
    name: 'env-web-community-library', enabled: true, scope: 'env:web',
    description: 'Show community library route (web only)',
    created_at: '2026-06-24T00:00:00.000Z', updated_at: '2026-06-24T00:00:00.000Z',
    created_by: 'seed',
  },
  'env-web-admin-legacy': {
    name: 'env-web-admin-legacy', enabled: true, scope: 'env:web',
    description: 'Show legacy admin panel route (web only)',
    created_at: '2026-06-24T00:00:00.000Z', updated_at: '2026-06-24T00:00:00.000Z',
    created_by: 'seed',
  },
  'env-web-opeds': {
    // t/2632: default OFF (deliberate deviation from the other enabled:true env-web-* seeds) —
    // web Op-Eds is unverified until the t/2614 web-create smoke. Reveal = an admin flip to true
    // (admin data.flags merges over SEED, no redeploy); pairs with the renderer nav gate (t/2633).
    name: 'env-web-opeds', enabled: false, scope: 'env:web',
    description: 'Show Op-Eds tab/route (web only) — OFF until the t/2614 web-create smoke verifies',
    created_at: '2026-08-14T00:00:00.000Z', updated_at: '2026-08-14T00:00:00.000Z',
    created_by: 'seed',
  },
  'env-electron-summaries': {
    name: 'env-electron-summaries', enabled: true, scope: 'env:electron',
    description: 'Show summaries tab and menu items (electron only)',
    created_at: '2026-06-24T00:00:00.000Z', updated_at: '2026-06-24T00:00:00.000Z',
    created_by: 'seed',
  },
  'permission-admin-features': {
    name: 'permission-admin-features', enabled: true, scope: 'role:admin',
    description: 'Unlock admin UI features (community moderation, resilience details, share banner controls)',
    created_at: '2026-06-25T00:00:00.000Z', updated_at: '2026-06-25T00:00:00.000Z',
    created_by: 'seed',
  },
  'debate-detail-dropdown': {
    name: 'debate-detail-dropdown', enabled: false, scope: 'global',
    description: 'Replace Brief/Med/Detail tabs in StatementCard with a dropdown (t/1030)',
    created_at: '2026-06-26T00:00:00.000Z', updated_at: '2026-06-26T00:00:00.000Z',
    created_by: 'seed',
  },
  'DEBATE_CHAT_REDESIGN': {
    name: 'DEBATE_CHAT_REDESIGN', enabled: true, scope: 'global',
    description: 'Gate new debate chat UX — ON by default (t/2258 rollout)',
    created_at: '2026-08-07T00:00:00.000Z', updated_at: '2026-08-07T00:00:00.000Z',
    created_by: 'seed',
  },
  'anon-debates': {
    // t/3230: default OFF — a single anonymous debate exhausts the shared free Gemini key pool
    // (K=4) → 429 storm → ~485s retry → user-facing 500 (prod incident, owner-approved disable).
    // While OFF, free-tier debate generation is 403'd (generationContext.enforceAnonDebateGate).
    // Re-enable = an admin flip to true (data.flags merges over SEED, no redeploy) once a
    // throttled anon mode (fewer rounds / no fact-check search / per-IP cap) lands.
    name: 'anon-debates', enabled: false, scope: 'global',
    description: 'Allow anonymous/free-tier users to run debates — OFF (t/3230: anon debates drain the free-key pool)',
    created_at: '2026-09-02T00:00:00.000Z', updated_at: '2026-09-02T00:00:00.000Z',
    created_by: 'seed',
  },
  'free-pool-budget-enforced': {
    // t/4485: default OFF — decouples this PR's merge from Server Storage's blob-backed
    // FreePoolBudget implementation (t/4484) landing. While OFF, ai/freePoolBudgetGate.ts never
    // calls getFreePoolBudget(), so free-pool generate calls behave exactly as before this
    // ticket. Flip to true (admin, no redeploy) once the implementation is live and verified in
    // staging — prod after that.
    name: 'free-pool-budget-enforced', enabled: false, scope: 'global',
    description: 'Enforce the persistent daily free-pool budget (reserve/commit/release) — OFF until t/4484\'s blob-backed implementation lands',
    created_at: '2026-10-25T00:00:00.000Z', updated_at: '2026-10-25T00:00:00.000Z',
    created_by: 'seed',
  },
};

// ── Config loading (mtime cache, quotas.ts pattern) ──

let _cache: FlagsConfig | null = null;
let _cacheMtime = -1;
let _lastLoadTime = 0;
const CACHE_TTL = 30_000;

// t/2643: feature flags are class-A WRITABLE state (read + runtime-written by the server) →
// the writable state root, so a staging flag flip can't mutate prod's shared feature-flags.json.
function flagsPath(): string { return path.join(getStateRoot(), 'admin', 'feature-flags.json'); }
function auditPath(): string { return path.join(getStateRoot(), 'admin', 'feature-flags-audit.ndjson'); }

function loadConfig(): FlagsConfig {
  const p = flagsPath();
  try {
    // t/2019 (js/file-system-race): fstat + read the SAME fd, not the path twice —
    // no swap/unlink can slip between the mtime check and the read. openSync throws
    // ENOENT (no flags file) → the catch below degrades to the committed seed baseline.
    const fd = fs.openSync(p, 'r');
    try {
      const stat = fs.fstatSync(fd);
      if (_cache && stat.mtimeMs === _cacheMtime) return _cache;
      const data = JSON.parse(fs.readFileSync(fd, 'utf-8')) as Partial<FlagsConfig>;
      // Seed flags are the baseline — file overrides take precedence, but new
      // seeds appear automatically without requiring a file rewrite.
      _cache = { flags: { ...SEED_FLAGS, ...(data.flags ?? {}) } };
      _cacheMtime = stat.mtimeMs;
      log.server.debug({ path: p, count: Object.keys(_cache.flags).length }, 'Loaded feature flags');
      return _cache;
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'feature-flags', level: 'warn',
        message: 'Failed to load feature flags — using seed defaults',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }
    // Missing/unreadable → seed baseline (fail-open only to the committed seed).
    _cache = { flags: { ...SEED_FLAGS } };
    _cacheMtime = -1;
    return _cache;
  }
}

function getConfig(): FlagsConfig {
  const now = Date.now();
  if (now - _lastLoadTime > CACHE_TTL) { _lastLoadTime = now; return loadConfig(); }
  return _cache ?? loadConfig();
}

// ── Writes: read-modify-write with a content-hash precondition (t/2644) ──
//
// Prod runs multiple replicas, each with its own 30s `_cache`. The old write path serialized
// that (possibly stale) whole cache back to the file, so a stale-cache replica's write silently
// clobbered another replica's committed change at FILE granularity (the env-web-opeds revert
// bounced back to true). Fix: every write re-reads the file FRESH, merges ONLY the target flag,
// and commits atomically — retrying if a concurrent writer changed the file since our read. A
// content hash (not mtime) is the precondition, so it's independent of Azure Files mtime
// resolution and detects a same-tick concurrent commit. This makes the file-granularity clobber
// (the incident) vanishingly unlikely — a stale replica writing flag Y re-reads and preserves
// flag X's committed change. TWO residuals remain (both negligible at the human admin-flip rate):
//   (1) DOMINANT: two writers hitting the SAME flag in the same instant → last-writer-wins on
//       that one flag (acceptable; NOT the cross-flag file-granularity data-loss the incident was);
//   (2) a sub-µs check-then-rename TOCTOU: two writers (even on different flags) can both pass the
//       hash check before either renames → the earlier rename is dropped. The commit stages the
//       temp file BEFORE the precondition check (below) so this window is only the rename itself.
// Reads stay 30s-cached, so cross-replica propagation of a committed change is bounded at ≤30s.
const MAX_RMW_ATTEMPTS = 5;

/** sha256 of the current on-disk flags file, or '' if absent. Single-fd (t/2019 race-safe). */
function currentFlagsHash(): string {
  try {
    const fd = fs.openSync(flagsPath(), 'r');
    try { return crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex'); }
    finally { fs.closeSync(fd); }
  } catch (err) {
    /* telemetry — silent by design: only ENOENT returns the '' baseline (expected, not an error); every other error re-throws to the recording caller */
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/** Read the current on-disk flags FRESH (bypassing the 30s cache) + its content hash. */
function readFreshFlags(): { config: FlagsConfig; hash: string } {
  try {
    const fd = fs.openSync(flagsPath(), 'r');
    try {
      const buf = fs.readFileSync(fd);
      const data = JSON.parse(buf.toString('utf-8')) as Partial<FlagsConfig>;
      return { config: { flags: { ...SEED_FLAGS, ...(data.flags ?? {}) } }, hash: crypto.createHash('sha256').update(buf).digest('hex') };
    } finally { fs.closeSync(fd); }
  } catch (err) {
    /* telemetry — silent by design: only ENOENT returns the seed baseline (expected, not an error); every other error re-throws to the recording caller */
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { config: { flags: { ...SEED_FLAGS } }, hash: '' };
    throw err;
  }
}

type RmwApply<T> =
  | { config: FlagsConfig; audit: FlagAuditEntry; result: T }  // commit + audit
  | { config: null; result: T };                                // no-op (e.g. delete of an absent flag)

/** Apply a single-flag mutation against fresh file state, retrying on a concurrent write. */
function rmwFlags<T>(apply: (fresh: FlagsConfig) => RmwApply<T>): T {
  const p = flagsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  for (let attempt = 0; attempt < MAX_RMW_ATTEMPTS; attempt++) {
    const { config: fresh, hash } = readFreshFlags();
    const applied = apply(fresh);
    if (applied.config === null) return applied.result; // no write needed
    // Stage the new file FIRST (the expensive step: write to a temp in the SAME directory — same
    // fs, no EXDEV), THEN re-check the precondition immediately before the rename, so the
    // check→commit TOCTOU window is only the rename call (t/2644 TL GV). If the file changed since
    // our fresh read, a concurrent writer committed → drop the temp and retry the full read-merge.
    const tmp = `${p}.tmp-${process.pid}-${attempt}`;
    fs.writeFileSync(tmp, JSON.stringify(applied.config, null, 2));
    if (currentFlagsHash() !== hash) { fs.rmSync(tmp, { force: true }); continue; }
    fs.renameSync(tmp, p);
    _cache = applied.config;
    _cacheMtime = -1; // force a fresh stat on next read (mtime changed)
    appendAudit(applied.audit);
    return applied.result;
  }
  throw new Error(
    `feature-flags: could not commit a flag change to ${p} after ${MAX_RMW_ATTEMPTS} retries — ` +
    'another replica is writing concurrently. Retry the change.',
  );
}

function appendAudit(entry: FlagAuditEntry): void {
  try {
    const p = auditPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(entry) + '\n');
  } catch (err) {
    log.server.warn({ err }, 'Failed to append feature-flag audit entry');
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'feature-flags', level: 'warn',
      message: 'Failed to append feature-flag audit entry',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
}

// ── Scope evaluation (pure) ──

function matchScopePart(part: string, ctx: FlagUserContext): boolean {
  if (part === 'global' || part === '') return true;
  const i = part.indexOf(':');
  const type = i < 0 ? part : part.slice(0, i);
  const value = i < 0 ? '' : part.slice(i + 1);
  switch (type) {
    case 'role':
      return value === 'admin' && ctx.isAdmin;
    case 'user':
      return value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
        .some(id => id === ctx.principalName.toLowerCase() || id === ctx.storageUserId.toLowerCase());
    case 'env':
      return value === ctx.env;
    default:
      return false; // unknown scope type → fail-closed
  }
}

/** Pure scope evaluator (t/899). Compound parts ('+') must ALL match. */
export function evaluateScope(scope: string, ctx: FlagUserContext): boolean {
  const parts = (scope || 'global').split('+').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return true;
  return parts.every(p => matchScopePart(p, ctx));
}

function currentEnv(): 'web' | 'electron' {
  return process.env.FEATURE_FLAG_ENV === 'electron' ? 'electron' : 'web';
}

function currentContext(): FlagUserContext {
  const user = getCurrentUser();
  return {
    storageUserId: user?.storageUserId ?? '_local',
    principalName: user?.principalName ?? '',
    isAdmin: isAdmin(user?.storageUserId),
    env: currentEnv(),
  };
}

/** Whether a flag def resolves true for the given context. Fail-closed. */
function resolve(def: FlagDef | undefined, ctx: FlagUserContext): boolean {
  if (!def || !def.enabled) return false;
  if (def.expires_at && Date.parse(def.expires_at) <= Date.now()) return false;
  return evaluateScope(def.scope || 'global', ctx);
}

// ── Public API ──

/** Resolve a single flag for the current user. Unknown → false (AC#1). */
export function getFlag(name: string): boolean {
  return resolve(getConfig().flags[name], currentContext());
}

/** t/3230: are anonymous/free-tier debates allowed? Default false (the `anon-debates` seed is OFF)
 *  — gates free-tier debate generation in generationContext.enforceAnonDebateGate. An admin flip
 *  to true re-enables without a redeploy. Single swap-point for the mechanism. */
export function isAnonDebatesEnabled(): boolean {
  return getFlag('anon-debates');
}

/** t/4485: is the persistent daily free-pool budget (reserve/commit/release) enforced? Default
 *  false — decouples this gate's merge from t/4484's blob-backed FreePoolBudget implementation
 *  landing (ai/freePoolBudgetGate.ts never touches the store while this is off). An admin flip
 *  to true re-enables without a redeploy, once the implementation is live and verified. */
export function isFreePoolBudgetEnforced(): boolean {
  return getFlag('free-pool-budget-enforced');
}

/** All flags resolved for the current user. */
export function getAllFlags(): Record<string, boolean> {
  const ctx = currentContext();
  const out: Record<string, boolean> = {};
  for (const [name, def] of Object.entries(getConfig().flags)) out[name] = resolve(def, ctx);
  return out;
}

/** Full definition for a flag (admin). */
export function getFlagMetadata(name: string): FlagDef | null {
  return getConfig().flags[name] ?? null;
}

/** All flag definitions (admin). */
export function listFlags(): FlagDef[] {
  return Object.values(getConfig().flags);
}

/** Merge a patch over the existing flag def (or defaults), producing the new def.
 *  Field precedence: patch → existing → default; timestamps/creator preserved. */
function mergeFlagDef(name: string, patch: Partial<FlagDef>, before: FlagDef | null, now: string, by: string): FlagDef {
  return {
    name,
    enabled: patch.enabled ?? before?.enabled ?? false,
    scope: patch.scope ?? before?.scope ?? 'global',
    description: patch.description ?? before?.description,
    created_at: before?.created_at ?? now,
    updated_at: now,
    created_by: before?.created_by ?? by,
    expires_at: patch.expires_at !== undefined ? patch.expires_at : before?.expires_at,
  };
}

/** Create or update a flag (admin). Persists + appends audit. Returns the def. */
export function setFlag(name: string, patch: Partial<FlagDef>, by = '_local'): FlagDef {
  // t/2644: merge onto FRESH file state (not the stale in-process cache) so a concurrent
  // change to a DIFFERENT flag on another replica survives; the RMW retries on a race.
  return rmwFlags((fresh) => {
    const config = { flags: { ...fresh.flags } };
    const before = config.flags[name] ?? null;
    const now = new Date().toISOString();
    const def = mergeFlagDef(name, patch, before, now, by);
    config.flags[name] = def;
    return { config, audit: { timestamp: now, action: 'set', flag: name, by, before, after: def }, result: def };
  });
}

/** Delete a flag (admin). No-op if absent. Persists + appends audit. */
export function deleteFlag(name: string, by = '_local'): boolean {
  // t/2644: existence is checked against FRESH state; absent → no-op (no write, no clobber).
  return rmwFlags<boolean>((fresh) => {
    const before = fresh.flags[name];
    if (!before) return { config: null, result: false };
    const config = { flags: { ...fresh.flags } };
    delete config.flags[name];
    return { config, audit: { timestamp: new Date().toISOString(), action: 'delete', flag: name, by, before, after: null }, result: true };
  });
}

/** Flags whose updated_at is older than `daysOld` and have no expiry set. */
export function getStaleFlags(daysOld: number): FlagDef[] {
  const cutoff = Date.now() - daysOld * 86_400_000;
  return listFlags().filter(f => !f.expires_at && Date.parse(f.updated_at) < cutoff);
}

/** Test-only: reset the in-memory cache. */
export function _resetFlagCache(): void { _cache = null; _cacheMtime = -1; _lastLoadTime = 0; }
