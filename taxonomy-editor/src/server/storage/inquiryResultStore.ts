// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Inquiry result store (t/3578, t/3571 arc). Durable persistence of the "Ask a question"
// answer artifact (`InquiryResult`, contract in lib/inquiry, t/3574).
//
// OWN COLLECTION (ADR-0002 §7 / decisions 4-5, via TL p/522#331): an inquiry result lives in
// its own `inquiry-results` collection, NOT alongside the source debate. A result must be
// readable without resolving anything against live data, so it cannot be tied to the (much
// larger) debate session on a different deletion schedule. The result holds a DANGLE-TOLERANT
// reference to its debate (the debate may be deleted first); reads never chase that reference.
//
// Keyed by JOB ID: the persisted result's id IS the job id, so a GET /api/inquiry/:jobId whose
// in-memory job has been swept (or lost to a replica restart) falls back to loadInquiryResult(jobId)
// — the cross-replica durability path (mirrors briefExportStore's record-is-truth model).
//
// Mirrors briefExportStore.ts: user-content blobs keyed by storageUserId, an _index.json listing,
// per-result files. Persistence goes through the StorageBackend interface (getUserContentBackend),
// never raw fs. Authenticated-only (ADR-0002 §8) — anonymous callers cannot store or read results.

import path from 'path';
import { resolveDataPath } from '../config.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { log } from '../logger.js';
import { getStorageUserId, isAnonymousUser } from '../security/userContext.js';
import { getUserContentBackend, assertSafeId } from './fileIO.js';
import { parseInquiryResult, type InquiryResult } from '../../../../lib/inquiry/index.js';
import { unpublishInquiryShare } from './inquiryShareStore.js';
import { deleteDebateSession } from './debateStore.js';
import { deleteInquiryJobRecord } from './inquiryJobStore.js';

/** Cheap listing row — enough to render an inquiry history without loading each full result. */
export interface InquiryResultSummary {
  jobId: string;
  question: string;
  /** Dangle-tolerant reference to the source debate (may point at a deleted session). */
  debateId: string | null;
  truncated: boolean;
  terminationReason?: string;
  createdAt: string;
  title?: string;
}

function getResultsDir(): string {
  const userId = getStorageUserId();
  if (userId === '_local') return resolveDataPath('inquiry-results');
  return resolveDataPath(`users/${userId}/inquiry-results`);
}
function getResultFile(jobId: string): string {
  return path.join(getResultsDir(), `inquiry-${jobId}.json`);
}
const INDEX_FILE = '_index.json';

// ── Index helpers (mirror briefExportStore) ──

async function readIndex(): Promise<InquiryResultSummary[]> {
  const raw = await getUserContentBackend().readFile(path.join(getResultsDir(), INDEX_FILE));
  if (raw === null) return [];
  try { return JSON.parse(raw) as InquiryResultSummary[]; } catch { /* telemetry — silent by design */ return []; }
}
async function writeIndex(entries: InquiryResultSummary[]): Promise<void> {
  await getUserContentBackend().writeFile(path.join(getResultsDir(), INDEX_FILE), JSON.stringify(entries, null, 2));
}
async function upsertIndex(row: InquiryResultSummary): Promise<void> {
  const entries = await readIndex();
  const i = entries.findIndex(e => e.jobId === row.jobId);
  if (i >= 0) entries[i] = row; else entries.push(row);
  await writeIndex(entries);
}

// ── Public API ──

/** Persist an inquiry result under its job id, then upsert the listing row. Authenticated-only.
 *  `summary` carries the truncation state so the history list shows it without loading each result. */
export async function saveInquiryResult(jobId: string, result: InquiryResult, summary: InquiryResultSummary): Promise<void> {
  assertSafeId(jobId, 'inquiry job id');
  if (isAnonymousUser()) {
    throw new ActionableError({
      goal: 'Store an inquiry result',
      problem: 'Anonymous users cannot store inquiry results',
      location: 'server/storage/inquiryResultStore.ts → saveInquiryResult',
      nextSteps: ['Sign in to run and save an inquiry'],
    });
  }
  const backend = getUserContentBackend();
  await backend.writeFile(getResultFile(jobId), JSON.stringify(result, null, 2));
  await upsertIndex(summary).catch((err) => {
    log.server.warn({ err, jobId }, 'Inquiry-result index upsert failed (best-effort)');
  });
}

/** Load a persisted inquiry result by job id; null if absent or not owned by the caller.
 *  Runs the shared `parseInquiryResult` — enforcing the contract's version policy (newer-major
 *  refusal, tolerant same-major read, older-version migration) on the durable read path. */
export async function loadInquiryResult(jobId: string): Promise<InquiryResult | null> {
  assertSafeId(jobId, 'inquiry job id');
  if (isAnonymousUser()) return null;
  const raw = await getUserContentBackend().readFile(getResultFile(jobId));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Present-but-corrupt file (not valid JSON). Fail-CLOSED to null (a missing result), but WARN —
    // a silently-dropped stored answer is invisible degradation (root AGENTS.md fallback-logging).
    log.server.warn({ err, jobId, cause: 'inquiry-result-unparseable' },
      'Stored inquiry result is not valid JSON — treating as absent (t/3578)');
    return null;
  }
  // parseInquiryResult throws (ActionableError) on a newer-major schema — that MUST surface, not be
  // swallowed, so a stale build refuses loudly rather than best-effort rendering an unknown shape.
  return parseInquiryResult(parsed);
}

/** List inquiry-result summaries for the current user (cheap — reads the index only). */
export async function listInquiryResults(): Promise<InquiryResultSummary[]> {
  if (isAnonymousUser()) return [];
  return readIndex();
}

/** Rename an inquiry result (set its display title). Scope-checked to the caller's store.
 *  Updates both the result file and the _index.json row. */
export async function renameInquiryResult(jobId: string, title: string): Promise<void> {
  assertSafeId(jobId, 'inquiry job id');
  if (isAnonymousUser()) {
    throw new ActionableError({
      goal: 'Rename an inquiry result',
      problem: 'Anonymous users cannot rename inquiry results',
      location: 'server/storage/inquiryResultStore.ts → renameInquiryResult',
      nextSteps: ['Sign in to manage your inquiries'],
    });
  }
  // Validate and normalize title
  const normalizedTitle = title.trim();
  if (!normalizedTitle) {
    throw new ActionableError({
      goal: 'Rename an inquiry result',
      problem: 'Title cannot be empty',
      location: 'server/storage/inquiryResultStore.ts → renameInquiryResult',
      nextSteps: ['Provide a non-empty title'],
    });
  }
  if (normalizedTitle.length > 200) {
    throw new ActionableError({
      goal: 'Rename an inquiry result',
      problem: 'Title is too long (max 200 characters)',
      location: 'server/storage/inquiryResultStore.ts → renameInquiryResult',
      nextSteps: ['Use a shorter title'],
    });
  }

  const backend = getUserContentBackend();
  const resultFile = getResultFile(jobId);

  // Read and validate both file and index BEFORE any writes
  const raw = await backend.readFile(resultFile);
  if (raw === null) {
    throw new ActionableError({
      goal: 'Rename an inquiry result',
      problem: `Inquiry result not found: ${jobId}`,
      location: 'server/storage/inquiryResultStore.ts → renameInquiryResult',
      nextSteps: ['Verify the inquiry result exists'],
    });
  }
  const result = parseInquiryResult(JSON.parse(raw));
  const entries = await readIndex();
  const i = entries.findIndex(e => e.jobId === jobId);
  if (i < 0) {
    throw new ActionableError({
      goal: 'Rename an inquiry result',
      problem: `Inquiry result index row not found: ${jobId}`,
      location: 'server/storage/inquiryResultStore.ts → renameInquiryResult',
      nextSteps: ['Verify the inquiry result index is consistent'],
    });
  }

  // Both exist; now perform the write
  result.title = normalizedTitle;
  await backend.writeFile(resultFile, JSON.stringify(result, null, 2));
  entries[i].title = normalizedTitle;
  await writeIndex(entries);
}

/** Delete an inquiry result and all linked records (share, debate session, job record).
 *  Each step is idempotent and best-effort; failures are logged but do not prevent deletion.
 *  Scope-checked to the caller's store. */
export async function deleteInquiryResult(jobId: string): Promise<void> {
  assertSafeId(jobId, 'inquiry job id');
  if (isAnonymousUser()) {
    throw new ActionableError({
      goal: 'Delete an inquiry result',
      problem: 'Anonymous users cannot delete inquiry results',
      location: 'server/storage/inquiryResultStore.ts → deleteInquiryResult',
      nextSteps: ['Sign in to manage your inquiries'],
    });
  }
  const backend = getUserContentBackend();
  const resultFile = getResultFile(jobId);
  const raw = await backend.readFile(resultFile);
  if (raw === null) {
    const err = new ActionableError({
      goal: 'Delete an inquiry result',
      problem: `Inquiry result not found: ${jobId}`,
      location: 'server/storage/inquiryResultStore.ts → deleteInquiryResult',
      nextSteps: ['Verify the inquiry result exists'],
    });
    (err as any).statusCode = 404;
    throw err;
  }
  const result = parseInquiryResult(JSON.parse(raw));

  // (1) Revoke public share (idempotent, best-effort)
  await unpublishInquiryShare(jobId).catch((err) => {
    log.server.warn({ err, jobId }, 'Inquiry share revocation failed (best-effort); continuing with delete');
  });

  // (2) Delete linked debate session (idempotent, best-effort)
  if (result.debateId) {
    await deleteDebateSession(result.debateId).catch((err) => {
      log.server.warn({ err, jobId, debateId: result.debateId }, 'Inquiry debate session delete failed (best-effort); continuing with delete');
    });
  }

  // (3) Delete job record (idempotent, best-effort)
  await deleteInquiryJobRecord(jobId).catch((err) => {
    log.server.warn({ err, jobId }, 'Inquiry job record delete failed (best-effort); continuing with delete');
  });

  // (4) Delete result file and remove from index
  await backend.deleteFile(resultFile);
  const entries = await readIndex();
  const i = entries.findIndex(e => e.jobId === jobId);
  if (i >= 0) {
    entries.splice(i, 1);
    await writeIndex(entries).catch((err) => {
      log.server.warn({ err, jobId }, 'Inquiry-result index removal failed (best-effort)');
    });
  }
}
