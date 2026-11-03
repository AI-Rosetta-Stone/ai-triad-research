// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Calibration + lineage-enrichment curation store — extracted from fileIO.ts (ADR-007).
 *
 * The staging→core curation workflow (t/621 / t/644 / t/647): per-user JSONL
 * calibration logs and topic-keyed lineage-enrichment maps are listed, promoted,
 * or rejected into the shared `calibration/core/*` files, with every promote/reject
 * appended to `calibration/integration-log.jsonl` as an audit record. All reads/writes
 * target `main` (shared calibration data, not a session branch). Re-exported from
 * fileIO.ts, so the public surface and `server/fileIO.ts → …` locations are unchanged.
 */

import path from 'path';
import { resolveDataPath } from '../config.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { getBackend, assertSafeId, isSafeId } from './fileIO.js';

/** A calibration log entry. Only `debate_id` is required for curation; the rest is opaque. */
export interface CalibrationLogEntry {
  debate_id: string;
  [key: string]: unknown;
}

/** Audit record written to calibration/integration-log.jsonl on promote/reject. */
export interface CalibrationIntegrationRecord {
  action: 'promote' | 'reject';
  /** "users/{origin}" — the source user log the entries came from. */
  source: string;
  /** debate_ids that were promoted/rejected. */
  entries: string[];
  /** Admin userId who performed the action. */
  by: string;
  /** ISO 8601 timestamp. */
  at: string;
  /** Promotion notes (promote only). */
  notes?: string;
  /** Rejection reason (reject only). */
  reason?: string;
  /** debate_ids that had admin edit-on-promote corrections applied (promote only). */
  edited?: string[];
  /** Which curated file the entries belong to. Absent on legacy records → 'calibration-log'. */
  kind?: CalibrationKind | 'lineage-enrichments';
}

/** Calibration entries for one user that have not yet been promoted or rejected. */
export interface PendingCalibrationGroup {
  /** User directory name under calibration/users/. */
  origin: string;
  /** Canonical source identifier ("users/{origin}"). */
  source: string;
  /** Unresolved calibration entries for this user. */
  entries: CalibrationLogEntry[];
}

/** JSONL calibration file types curated through the staging→core workflow.
 *  Both are append-only and keyed by `debate_id` (t/621#2). */
export type CalibrationKind = 'calibration-log' | 'extraction-metrics';
const CALIBRATION_JSONL_FILE: Record<CalibrationKind, string> = {
  'calibration-log': 'calibration-log.jsonl',
  'extraction-metrics': 'extraction-metrics.jsonl',
};

function calibrationUsersDir(): string { return resolveDataPath(path.join('calibration', 'users')); }
function calibrationCoreLogPath(kind: CalibrationKind = 'calibration-log'): string {
  return resolveDataPath(path.join('calibration', 'core', CALIBRATION_JSONL_FILE[kind]));
}
function calibrationUserLogPath(origin: string, kind: CalibrationKind = 'calibration-log'): string {
  return path.join(calibrationUsersDir(), origin, CALIBRATION_JSONL_FILE[kind]);
}
function calibrationIntegrationLogPath(): string { return resolveDataPath(path.join('calibration', 'integration-log.jsonl')); }

/** Parse JSONL text into objects, skipping blank and malformed lines. */
function parseJsonlEntries<T = CalibrationLogEntry>(raw: string | null): T[] {
  if (!raw) return [];
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed) as T); }
    catch { /* telemetry — silent by design; skip malformed JSONL line */ }
  }
  return out;
}

/** Read the promote/reject audit log. Returns [] when absent. */
export async function readCalibrationIntegrationLog(): Promise<CalibrationIntegrationRecord[]> {
  // t/4510: consultOverlayOnPin — this log can be appended to earlier in the
  // same request (appendIntegrationRecord), and the append lands in the
  // session overlay even though the write has no ref override.
  return parseJsonlEntries<CalibrationIntegrationRecord>(await getBackend().readFile(calibrationIntegrationLogPath(), { ref: 'main', optional: true, consultOverlayOnPin: true }));
}

/** Resolution is per-kind: a debate can have both a calibration-log and an
 *  extraction-metrics entry sharing a debate_id, so an entry counts as resolved
 *  only when an integration record of the SAME kind lists it. Legacy records with
 *  no `kind` are treated as 'calibration-log'. */
async function resolvedCalibrationDebateIds(kind: CalibrationKind = 'calibration-log'): Promise<Set<string>> {
  const resolved = new Set<string>();
  for (const rec of await readCalibrationIntegrationLog()) {
    if ((rec.kind ?? 'calibration-log') !== kind) continue;
    for (const id of rec.entries ?? []) resolved.add(id);
  }
  return resolved;
}

/** Read one user's JSONL calibration entries for a given kind. */
async function readUserCalibrationLog(origin: string, kind: CalibrationKind = 'calibration-log'): Promise<CalibrationLogEntry[]> {
  // t/4510: consultOverlayOnPin — the promote/reject flow rewrites this same
  // user log (removing promoted/rejected entries) and may re-read it within
  // one request; the rewrite lands in the session overlay.
  return parseJsonlEntries(await getBackend().readFile(calibrationUserLogPath(origin, kind), { ref: 'main', optional: true, consultOverlayOnPin: true }));
}

/**
 * List JSONL calibration entries across all users that have not been promoted or
 * rejected, grouped by user. Entries whose debate_id appears in a same-kind
 * integration record are excluded (AC #1). Defaults to the calibration-log kind.
 */
export async function listPendingCalibration(kind: CalibrationKind = 'calibration-log'): Promise<PendingCalibrationGroup[]> {
  const userDirs = await getBackend().listDirectory(calibrationUsersDir());
  const resolved = await resolvedCalibrationDebateIds(kind);

  const groups: PendingCalibrationGroup[] = [];
  for (const origin of userDirs) {
    if (!isSafeId(origin)) continue; // skip stray non-id directory names
    const entries = (await readUserCalibrationLog(origin, kind))
      .filter(e => typeof e.debate_id === 'string' && !resolved.has(e.debate_id));
    if (entries.length > 0) groups.push({ origin, source: `users/${origin}`, entries });
  }
  groups.sort((a, b) => a.origin.localeCompare(b.origin));
  return groups;
}

/** Parse and validate a "users/{origin}" source string. Returns the origin. */
function parseCalibrationSource(source: string): string {
  const match = /^users\/(.+)$/.exec(source ?? '');
  if (!match) {
    throw new ActionableError({
      goal: 'Resolve calibration source',
      problem: `Invalid source "${source}": expected "users/{origin}"`,
      location: 'server/fileIO.ts → parseCalibrationSource',
      nextSteps: ['Pass source in the form "users/{origin}" (e.g. "users/local")'],
    });
  }
  const origin = match[1];
  assertSafeId(origin, 'calibration origin');
  return origin;
}

/** Append a record to the integration audit log (read-modify-write via backend). */
async function appendIntegrationRecord(record: CalibrationIntegrationRecord): Promise<void> {
  const logPath = calibrationIntegrationLogPath();
  // t/4510: consultOverlayOnPin — a second append in the same request must
  // see the first append's write, which lands in the session overlay.
  const existing = (await getBackend().readFile(logPath, { ref: 'main', optional: true, consultOverlayOnPin: true })) ?? '';
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? existing + '\n' : existing;
  await getBackend().writeFile(logPath, prefix + JSON.stringify(record) + '\n');
}

/**
 * Promote selected user entries into the core calibration log and record an
 * audit entry (AC #2). Only entries that actually exist in the user log are
 * promoted; returns the promoted debate_ids.
 *
 * Edit-on-promote (t/644 AC #6): `edits` maps a debate_id to a partial object
 * shallow-merged onto the matched entry before it is appended to core — lets an
 * admin correct e.g. lineage category/description without mutating the user's
 * source log. `debate_id` is always preserved from the original entry so an edit
 * can never re-key or detach an entry. Edited ids are noted in the audit record.
 */
export async function promoteCalibrationEntries(
  source: string,
  entryIds: string[],
  by: string,
  notes?: string,
  edits?: Record<string, Record<string, unknown>>,
  kind: CalibrationKind = 'calibration-log',
): Promise<{ promoted: number; entries: string[]; edited: string[] }> {
  const origin = parseCalibrationSource(source);
  const wanted = new Set(entryIds);
  const matched = (await readUserCalibrationLog(origin, kind))
    .filter(e => typeof e.debate_id === 'string' && wanted.has(e.debate_id));

  const editedIds: string[] = [];
  const toPromote = matched.map(e => {
    const patch = edits?.[e.debate_id];
    if (!patch || typeof patch !== 'object') return e;
    editedIds.push(e.debate_id);
    // Shallow-merge admin corrections, then pin debate_id back to the original.
    return { ...e, ...patch, debate_id: e.debate_id } as CalibrationLogEntry;
  });

  if (toPromote.length > 0) {
    const corePath = calibrationCoreLogPath(kind);
    // t/4510: consultOverlayOnPin — a prior promote in the same request
    // already appended here; the append lands in the session overlay.
    const existing = (await getBackend().readFile(corePath, { ref: 'main', optional: true, consultOverlayOnPin: true })) ?? '';
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? existing + '\n' : existing;
    const appended = toPromote.map(e => JSON.stringify(e)).join('\n') + '\n';
    await getBackend().writeFile(corePath, prefix + appended);
  }

  const promotedIds = toPromote.map(e => e.debate_id);
  await appendIntegrationRecord({
    action: 'promote',
    source: `users/${origin}`,
    entries: promotedIds,
    by,
    at: new Date().toISOString(),
    ...(notes ? { notes } : {}),
    ...(editedIds.length > 0 ? { edited: editedIds } : {}),
    ...(kind !== 'calibration-log' ? { kind } : {}),
  });
  return { promoted: promotedIds.length, entries: promotedIds, edited: editedIds };
}

/**
 * Record a rejection of selected user entries (AC #3). User files are never
 * modified — the rejection lives only in the integration audit log. Only ids
 * present in the user log are recorded.
 */
export async function rejectCalibrationEntries(
  source: string,
  entryIds: string[],
  by: string,
  reason: string,
  kind: CalibrationKind = 'calibration-log',
): Promise<{ rejected: number; entries: string[] }> {
  const origin = parseCalibrationSource(source);
  const wanted = new Set(entryIds);
  const rejectedIds = (await readUserCalibrationLog(origin, kind))
    .filter(e => typeof e.debate_id === 'string' && wanted.has(e.debate_id))
    .map(e => e.debate_id);

  await appendIntegrationRecord({
    action: 'reject',
    source: `users/${origin}`,
    entries: rejectedIds,
    by,
    at: new Date().toISOString(),
    reason,
    ...(kind !== 'calibration-log' ? { kind } : {}),
  });
  return { rejected: rejectedIds.length, entries: rejectedIds };
}

/** Read the curated core JSONL entries for a kind (for averages / comparison). */
export async function readCoreCalibrationEntries(kind: CalibrationKind = 'calibration-log'): Promise<CalibrationLogEntry[]> {
  // t/4510: consultOverlayOnPin — a promote in the same request may have just
  // appended here; the append lands in the session overlay.
  return parseJsonlEntries(await getBackend().readFile(calibrationCoreLogPath(kind), { ref: 'main', optional: true, consultOverlayOnPin: true }));
}

// ── Lineage enrichments curation (keyed-map variant, t/621#2 / t/647) ──

function lineageCoreMapPath(): string {
  return resolveDataPath(path.join('calibration', 'core', 'lineage-enrichments.json'));
}
function lineageUserMapPath(origin: string): string {
  return path.join(calibrationUsersDir(), origin, 'lineage-enrichments.json');
}

/** Read the curated core lineage-enrichments map (raw topic→value form). */
export async function readCoreLineageEnrichmentsMap(): Promise<Record<string, unknown>> {
  return readLineageMap(lineageCoreMapPath());
}

/** Read one user's raw lineage-enrichments map (topic→value). */
export async function readUserLineageEnrichmentsMap(origin: string): Promise<Record<string, unknown>> {
  assertSafeId(origin, 'calibration origin');
  return readLineageMap(lineageUserMapPath(origin));
}

/** Parse a topic-keyed enrichment map; tolerant of a missing/garbled file. */
async function readLineageMap(filePath: string): Promise<Record<string, unknown>> {
  // Lineage maps are shared calibration data on main, not on a session branch.
  // t/4510: consultOverlayOnPin — promoteLineageEnrichments reads the core map
  // here, then writes it later in the same request; the write lands in the
  // session overlay.
  const raw = await getBackend().readFile(filePath, { ref: 'main', optional: true, consultOverlayOnPin: true });
  if (!raw) return {};
  try {
    const data = JSON.parse(raw.replace(/^﻿/, ''));
    return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
  } catch { /* telemetry — silent by design; treat unreadable map as empty */ return {}; }
}

/** Topic keys already promoted/rejected for lineage-enrichments (per-kind audit). */
async function resolvedLineageKeys(): Promise<Set<string>> {
  const resolved = new Set<string>();
  for (const rec of await readCalibrationIntegrationLog()) {
    if (rec.kind !== 'lineage-enrichments') continue;
    for (const k of rec.entries ?? []) resolved.add(k);
  }
  return resolved;
}

/** One user's lineage-enrichment keys not yet promoted/rejected, grouped by user. */
export async function listPendingLineageEnrichments(): Promise<Array<{ origin: string; source: string; keys: string[] }>> {
  const userDirs = await getBackend().listDirectory(calibrationUsersDir());
  const resolved = await resolvedLineageKeys();

  const groups: Array<{ origin: string; source: string; keys: string[] }> = [];
  for (const origin of userDirs) {
    if (!isSafeId(origin)) continue;
    const keys = Object.keys(await readLineageMap(lineageUserMapPath(origin)))
      .filter(k => !resolved.has(k));
    if (keys.length > 0) groups.push({ origin, source: `users/${origin}`, keys });
  }
  groups.sort((a, b) => a.origin.localeCompare(b.origin));
  return groups;
}

/**
 * Promote selected topic keys from a user's lineage map into the core map.
 * Keys are case-normalized (lowercased) in core per t/621#2. `edits` may override
 * a key's value before the merge (edit-on-promote). Audit record kind =
 * 'lineage-enrichments', entries = the original (pre-normalization) user keys.
 */
export async function promoteLineageEnrichments(
  source: string,
  keys: string[],
  by: string,
  notes?: string,
  edits?: Record<string, Record<string, unknown>>,
): Promise<{ promoted: number; entries: string[]; edited: string[] }> {
  const origin = parseCalibrationSource(source);
  const userMap = await readLineageMap(lineageUserMapPath(origin));
  const wanted = keys.filter(k => Object.prototype.hasOwnProperty.call(userMap, k));

  if (wanted.length > 0) {
    const corePath = lineageCoreMapPath();
    const coreMap = await readLineageMap(corePath);
    const editedKeys: string[] = [];
    for (const k of wanted) {
      const patch = edits?.[k];
      const base = userMap[k];
      let value: unknown = base;
      if (patch && typeof patch === 'object') {
        editedKeys.push(k);
        value = (base && typeof base === 'object' && !Array.isArray(base))
          ? { ...(base as Record<string, unknown>), ...patch }
          : patch;
      }
      coreMap[k.toLowerCase()] = value; // case-normalized key in core
    }
    await getBackend().writeFile(corePath, JSON.stringify(coreMap, null, 2) + '\n');

    await appendIntegrationRecord({
      action: 'promote', source: `users/${origin}`, entries: wanted, by,
      at: new Date().toISOString(), kind: 'lineage-enrichments',
      ...(notes ? { notes } : {}),
      ...(editedKeys.length > 0 ? { edited: editedKeys } : {}),
    });
    return { promoted: wanted.length, entries: wanted, edited: editedKeys };
  }

  await appendIntegrationRecord({
    action: 'promote', source: `users/${origin}`, entries: [], by,
    at: new Date().toISOString(), kind: 'lineage-enrichments',
    ...(notes ? { notes } : {}),
  });
  return { promoted: 0, entries: [], edited: [] };
}

/** Reject selected lineage keys — audit only; the user map is never modified. */
export async function rejectLineageEnrichments(
  source: string,
  keys: string[],
  by: string,
  reason: string,
): Promise<{ rejected: number; entries: string[] }> {
  const origin = parseCalibrationSource(source);
  const userMap = await readLineageMap(lineageUserMapPath(origin));
  const rejected = keys.filter(k => Object.prototype.hasOwnProperty.call(userMap, k));

  await appendIntegrationRecord({
    action: 'reject', source: `users/${origin}`, entries: rejected, by,
    at: new Date().toISOString(), reason, kind: 'lineage-enrichments',
  });
  return { rejected: rejected.length, entries: rejected };
}
