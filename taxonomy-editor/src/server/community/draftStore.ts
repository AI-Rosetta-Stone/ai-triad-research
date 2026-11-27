// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { randomBytes } from 'crypto';
import type { InquiryPayload } from '../../../../lib/inquiry/index.js';
import { inquiryPayloadSchema } from '../../../../lib/inquiry/index.js';
import type { StorageBackend } from '../storage/storageBackend.js';
import { getUserContentBackend, writeFileIfAbsentStrict } from '../storage/fileIO.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { log } from '../logger.js';
import { getConfig } from '../runtimeConfig.js';
import { isAnonymousUser } from '../security/userContext.js';
import { stripSensitiveKeys as stripSensitiveKeysCore } from '../../../../lib/sanitize/stripSensitiveKeys.js';
import { sanitizeUserText, withSanitizeBudget } from '../security/contentSanitizer.js';
import { CLASSIFICATION, dispositionFor, type Surface } from '../../../../lib/inquiry/fieldClassification.js';

export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
export const DRAFT_GLOBAL_PENDING_CAP = 50;
export const DRAFT_PER_CLIENT_CAP = 5; // max drafts per client in 24h (prevents exhaustion of global cap)
export const DRAFT_MAX_NOTE_BYTES = 2000; // max sanitized note size
export const DRAFT_MAX_PAYLOAD_BYTES = 1024 * 1024; // 1MB max payload size

/** 'drf_' + 32 lowercase hex (crypto.randomBytes(16)). An unguessable capability, never logged in full. */
export type DraftId = string;

export function isDraftId(s: unknown): s is DraftId {
  if (typeof s !== 'string') return false;
  return /^drf_[a-f0-9]{32}$/.test(s);
}

export interface CanonicalNodeRef {
  label: string;
  camp?: string; // absent for situation nodes
}

export interface DraftCreateContext {
  /** Taxonomy node id → canonical label/camp. */
  nodesById: ReadonlyMap<string, CanonicalNodeRef>;
  /** Client identifier (typically IP address or session ID) for per-client rate limiting (B6). */
  clientId?: string;
}

export interface DraftPrincipal {
  storageUserId: string; // getStorageUserId() of the authenticated caller
  displayName: string; // becomes Submission.submittedBy display
}

/** What GET returns (route adds provenance: 'client-supplied', degraded: 'unknown'). */
export interface CommunityDraftView {
  draftId: DraftId;
  projection: Record<string, unknown>; // community-surface projection (fieldClassification 'community'), never an InquiryResult
  note: string; // sanitized
  droppedRefs: string[]; // node ids pruned as unknown
  droppedAuthFields: string[]; // dotted paths removed as client-supplied authority claims
  expiresAt: string; // ISO
}

export type CreateDraftResult =
  | { ok: true; draftId: DraftId; expiresAt: string }
  | { ok: false; reason: 'cap_reached' } // → 429
  | { ok: false; reason: 'invalid'; detail: 'schema' | 'all_refs_unknown' | 'unprunable_ref' | 'note_too_large' }; // → 400, no input echoed

export type GetDraftResult =
  | { ok: true; draft: CommunityDraftView }
  | { ok: false; reason: 'not_found' } // → 404 (also: malformed id, or swept)  [getDraft checks the claim marker first]
  | { ok: false; reason: 'expired' } // → 410
  | { ok: false; reason: 'already_claimed' }; // → 409 (a finalized draft is no longer readable by link)

export type FinalizeDraftResult =
  | { ok: true; submissionId: string } // pending moderation submission, same queue as submitToCommunity
  | { ok: false; reason: 'not_found' } // → 404
  | { ok: false; reason: 'expired' } // → 410
  | { ok: false; reason: 'already_claimed' } // → 409
  | { ok: false; reason: 'user_cap_reached' } // → 429 (existing community.maxPendingPerUser)
  | { ok: false; reason: 'queue_full' } // → 503 (global submission cap)
  | { ok: false; reason: 'anonymous' }; // → 401 (defence in depth; the route should already have refused)

export interface DraftStore {
  createDraft(payload: InquiryPayload, ctx: DraftCreateContext): Promise<CreateDraftResult>;
  getDraft(draftId: string): Promise<GetDraftResult>;
  finalizeDraft(draftId: string, principal: DraftPrincipal): Promise<FinalizeDraftResult>;
  sweepExpiredDrafts(): Promise<{ deleted: number }>;
}

// ── Helpers ──

function generateDraftId(): DraftId {
  return `drf_${randomBytes(16).toString('hex')}` as DraftId;
}

function logDraftId(draftId: DraftId): string {
  return draftId.slice(0, 8);
}

// A record path contains the whole drf_<32hex> id, which is the capability to read and finalize that
// draft. Logs carry only the short form (t/756).
function logRecordPath(recordPath: string): string {
  return recordPath.replace(/drf_[0-9a-f]{8,}/g, (id) => logDraftId(id as DraftId));
}

// Any drf_<hex> in text (an fs or Blob error message names the path) is cut to the short form.
function redactDraftIds(text: string): string {
  return text.replace(/drf_[0-9a-f]{8,}/g, (id) => logDraftId(id as DraftId));
}

// What a log line may say about a caught error: its message with draft ids shortened (t/756, Security).
function logSafeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : 'non-Error thrown';
  return redactDraftIds(msg);
}

// A corrupt or bad-expiry record is deleted only after it has been seen, with identical content, by two
// sweeps at least this far apart. A torn write finishes in far less (t/756).
const CORRUPT_MIN_AGE_MS = 10 * 60 * 1000;

// Only an ISO-like string is a date. null, true, or a small number would otherwise become a valid Date
// (epoch, 1 ms) and classify the record as expired (t/756).
function parseExpiry(v: unknown): number {
  return typeof v === 'string' ? new Date(v).getTime() : NaN;
}

/**
 * Wrapper around stripSensitiveKeysCore that applies the server's sanitizeUserText
 */
function stripSensitiveKeys(obj: unknown): unknown {
  return stripSensitiveKeysCore(obj, sanitizeUserText);
}

/**
 * Project an InquiryResult-shaped value onto a surface using the field classification matrix
 */
function projectInquiryFields(value: unknown, surface: Surface, path: string): unknown {
  if (path in CLASSIFICATION) {
    return dispositionFor(path, surface).include ? value : undefined;
  }
  if (Array.isArray(value)) {
    return value.map((el) => projectInquiryFields(el, surface, path));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${k}` : k;
      const projected = projectInquiryFields(v, surface, childPath);
      if (projected !== undefined) out[k] = projected;
    }
    return out;
  }
  return undefined;
}

/**
 * Check if a path exists in an object
 */
function hasPath(obj: any, path: string): boolean {
  let current = obj;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object' || !(part in current)) return false;
    current = current[part];
  }
  return true;
}

/**
 * Rebuild node references with canonical label/camp values
 */
function rebuildNodeRefsCanonical(
  value: unknown,
  nodesById: ReadonlyMap<string, CanonicalNodeRef>,
  droppedRefs: string[],
): unknown {
  if (!value || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item && typeof item === 'object' && 'nodeId' in item && typeof item.nodeId === 'string') {
        const canonical = nodesById.get(item.nodeId);
        if (!canonical) {
          if (!droppedRefs.includes(item.nodeId)) {
            droppedRefs.push(item.nodeId);
          }
          return undefined;
        }
        return { nodeId: item.nodeId, label: canonical.label, camp: canonical.camp };
      }
      return rebuildNodeRefsCanonical(item, nodesById, droppedRefs);
    }).filter((item) => item !== undefined);
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    result[k] = rebuildNodeRefsCanonical(v, nodesById, droppedRefs);
  }
  return result;
}

/** Helper to detect if an object contains any node references */
function hasNodeRefs(obj: any): boolean {
  if (!obj || typeof obj !== 'object') return false;
  if ('nodeId' in obj) return true;
  for (const v of Array.isArray(obj) ? obj : Object.values(obj)) {
    if (hasNodeRefs(v)) return true;
  }
  return false;
}

/**
 * Implementation of DraftStore
 */
class DraftStoreImpl implements DraftStore {
  constructor(private backend: StorageBackend, private now: () => number = () => Date.now()) {}

  private async checkGlobalCap(): Promise<'ok' | 'cap_reached'> {
    const pendingCount = await this.countPendingDrafts();
    if (pendingCount >= DRAFT_GLOBAL_PENDING_CAP) {
      await this.sweepExpiredDrafts();
      const newCount = await this.countPendingDrafts();
      if (newCount >= DRAFT_GLOBAL_PENDING_CAP) {
        return 'cap_reached';
      }
    }
    return 'ok';
  }

  // B6: Check per-client rate limit (prevent one client from exhausting global cap)
  private async countClientPendingDrafts(clientId: string): Promise<number> {
    let count = 0;
    try {
      const files = await this.backend.listDirectory('community/_drafts');
      for (const file of files) {
        if (!file.endsWith('.json') || file === 'claims') continue;
        const path = `community/_drafts/${file}`;
        const data = await this.backend.readFile(path);
        if (data === null) continue;
        let rec: { clientId?: unknown; expiresAt?: unknown };
        try {
          rec = JSON.parse(data);
        } catch (err) {
          // A corrupt record has no readable client id, so it cannot be charged to this client (t/507 item 3).
          log.server.warn(`countClientPendingDrafts: unparseable draft record ${logRecordPath(path)} (parse error kind ${(err as Error)?.name ?? 'unknown'}; not attributable to a client)`);
          continue;
        }
        // Expired drafts do not count: they are dead content awaiting sweep (TL t/185#44, blocker 1).
        if (rec.clientId === clientId && new Date(rec.expiresAt as string).getTime() >= this.now()) count++;
      }
    } catch (err) {
      log.server.error(`countClientPendingDrafts: list/read failed: ${logSafeError(err)}`);
      // Fail closed: if we can't count, assume limit is reached
      return DRAFT_PER_CLIENT_CAP;
    }
    return count;
  }

  private async validatePayloadAndNote(
    payload: InquiryPayload,
    ctx: DraftCreateContext,
  ): Promise<{ ok: true; sanitizedNote: string; droppedRefs: string[]; droppedAuthFields: string[]; projected: Record<string, unknown> } | { ok: false; reason: 'invalid'; detail: Extract<CreateDraftResult, { reason: 'invalid' }>['detail'] }> {
    // Validate schema
    try {
      inquiryPayloadSchema.parse(payload);
    } catch {
      /* telemetry — silent by design (schema validation is user input validation) */
      return { ok: false, reason: 'invalid', detail: 'schema' };
    }

    // Check payload size
    const payloadSize = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    if (payloadSize > DRAFT_MAX_PAYLOAD_BYTES) {
      return { ok: false, reason: 'invalid', detail: 'unprunable_ref' };
    }

    const droppedRefs: string[] = [];
    const droppedAuthFields: string[] = [];

    // Sanitize and project
    let projected: Record<string, unknown>;
    try {
      projected = this.sanitizeAndProject(payload, ctx, droppedRefs, droppedAuthFields);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'draftStore',
        level: 'error',
        message: `createDraft sanitization failed: ${logSafeError(err)}`,
        error: { name: (err as Error).name ?? 'Error', message: logSafeError(err), stack: redactDraftIds((err as Error).stack ?? '') },
      });
      throw new ActionableError({
        goal: 'Sanitize draft payload',
        problem: 'Payload sanitization or validation failed',
        location: 'draftStore.createDraft',
        nextSteps: ['Verify payload schema', 'Check sanitization budget'],
      });
    }

    // Check if all refs were dropped
    if (hasNodeRefs(payload) && droppedRefs.length > 0 && !hasNodeRefs(projected)) {
      return { ok: false, reason: 'invalid', detail: 'all_refs_unknown' };
    }

    // Sanitize and cap the note field (B4)
    let sanitizedNote = '';
    if (typeof (payload as any).note === 'string') {
      sanitizedNote = sanitizeUserText((payload as any).note);
      const noteBytes = Buffer.byteLength(sanitizedNote, 'utf8');
      if (noteBytes > DRAFT_MAX_NOTE_BYTES) {
        return { ok: false, reason: 'invalid', detail: 'note_too_large' };
      }
    }

    return { ok: true, sanitizedNote, droppedRefs, droppedAuthFields, projected };
  }

  private async checkCapLimits(clientId?: string): Promise<'cap_reached' | 'ok'> {
    // Check global pending cap
    const capResult = await this.checkGlobalCap();
    if (capResult === 'cap_reached') {
      return 'cap_reached';
    }

    // B6: a draft with no client id cannot be counted against the per-client cap, so it is refused
    // (fail closed). The route must supply the id; see the t/185 child ticket for that route fix.
    if (!clientId) return 'cap_reached';

    // Check per-client rate limit (B6)
    const clientCount = await this.countClientPendingDrafts(clientId);
    if (clientCount >= DRAFT_PER_CLIENT_CAP) {
      return 'cap_reached';
    }

    return 'ok';
  }

  private sanitizeAndProject(
    payload: InquiryPayload,
    ctx: DraftCreateContext,
    droppedRefs: string[],
    droppedAuthFields: string[],
  ): Record<string, unknown> {
    const deep = withSanitizeBudget(() => stripSensitiveKeys(JSON.parse(JSON.stringify(payload))));
    // The community projection runs on the result itself. Classification paths are relative to the result
    // (request.question, not result.request.question), so projecting the { result, note } wrapper matched nothing.
    const result = (deep as { result: Record<string, unknown> }).result;

    // t/285 (TL p/77#72, Security t185#21): fail closed. The body is client-supplied on the anonymous draft path, and
    // the degraded-run gate reads client calibration, so it cannot protect answer substance. directAnswer and the
    // per-camp answer fields (answeredLiteralQuestion, answerNote) are dropped on every anonymous draft, whatever
    // the body claims, until the server can verify run state. Recorded on t/185.
    const droppedAnswerPaths: string[] = [];
    if (result.directAnswer !== undefined) {
      delete result.directAnswer;
      droppedAnswerPaths.push('directAnswer');
    }
    for (const verdict of (result.campVerdicts as Record<string, unknown>[] | undefined) ?? []) {
      if (verdict.answeredLiteralQuestion !== undefined) { delete verdict.answeredLiteralQuestion; droppedAnswerPaths.push('campVerdicts.answeredLiteralQuestion'); }
      if (verdict.answerNote !== undefined) { delete verdict.answerNote; droppedAnswerPaths.push('campVerdicts.answerNote'); }
    }
    droppedAuthFields.push(...new Set(droppedAnswerPaths));

    // TL p/77#74 (same rule): synthesizedHeadline and derivation are dropped too. Their trust rests on client data
    // on this path. The synthesizedHeadline degraded gate read the client body (deriveTruncation), so it protected
    // nothing; derivation (models, rounds, callsUsed, costUsd) is run metadata the server never verifies here.
    for (const field of ['synthesizedHeadline', 'derivation'] as const) {
      if (result[field] !== undefined) {
        delete result[field];
        droppedAuthFields.push(field);
      }
    }

    // TL p/77#76 and p/77#78: questionDrift.driftScore is a t285 pipeline score, the same unverified-client class as
    // calibration and derivation, so it is dropped on anonymous drafts. debatedTopic is topic text and is kept.
    const drift = result.questionDrift as Record<string, unknown> | undefined;
    if (drift?.driftScore !== undefined) {
      delete drift.driftScore;
      droppedAuthFields.push('questionDrift.driftScore');
    }

    // Project onto community surface. questionDrift.warning is excluded by the community column (t/285).
    const p = projectInquiryFields(result, 'community', '') as Record<string, unknown>;

    // Track dropped auth fields (from the matrix diff).
    const authPaths = ['grounding.campCoverage', 'singleRunCaveat', 'debateId'];
    for (const ap of authPaths) {
      if (hasPath(result, ap) && !hasPath(p, ap)) {
        droppedAuthFields.push(ap);
      }
    }

    // calibration is a platform trust badge (fieldClassification.ts:211-213). On the anonymous path the body supplies
    // it, so it is dropped from the stored projection (TL p/77#72, Security t185#21).
    if (p.calibration !== undefined) {
      delete p.calibration;
      droppedAuthFields.push('calibration');
    }

    // Rebuild node refs with canonical values
    for (const key of Object.keys(p)) {
      p[key] = rebuildNodeRefsCanonical(p[key], ctx.nodesById, droppedRefs);
    }

    return p;
  }

  async createDraft(payload: InquiryPayload, ctx: DraftCreateContext): Promise<CreateDraftResult> {
    // Validate and sanitize
    const validation = await this.validatePayloadAndNote(payload, ctx);
    if (!validation.ok) {
      return validation;
    }

    // Enforce the 24h TTL on the write path: sweep expired drafts before counting. Nothing else starts
    // startDraftSweeper in this PR (TL t/185#44). A sweep failure is logged; the counts still apply.
    try {
      await this.sweepExpiredDrafts();
    } catch (err) {
      log.server.warn(`createDraft: pre-count sweep failed: ${logSafeError(err)} (counts still enforce the caps)`);
    }

    // Check caps (global + per-client)
    const capCheck = await this.checkCapLimits(ctx.clientId);
    if (capCheck === 'cap_reached') {
      return { ok: false, reason: 'cap_reached' };
    }

    // Create and write draft
    const draftId = generateDraftId();
    const expiresAt = new Date(this.now() + DRAFT_TTL_MS).toISOString();

    const draftRecord = {
      draftId,
      projection: validation.projected,
      note: validation.sanitizedNote,
      clientId: ctx.clientId,
      droppedRefs: validation.droppedRefs,
      droppedAuthFields: validation.droppedAuthFields,
      expiresAt,
      createdAt: new Date(this.now()).toISOString(),
    };

    try {
      const draftPath = `community/_drafts/${draftId}.json`;
      await writeFileIfAbsentStrict(this.backend, draftPath, JSON.stringify(draftRecord));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'draftStore',
        level: 'error',
        message: `createDraft write failed: ${logSafeError(err)}`,
        error: { name: (err as Error).name ?? 'Error', message: logSafeError(err), stack: redactDraftIds((err as Error).stack ?? '') },
      });
      throw new ActionableError({
        goal: 'Write the draft submission',
        problem: 'Storage write failed while creating the draft',
        location: 'draftStore.createDraft',
        nextSteps: ['Verify storage backend health'],
        innerError: err,
      });
    }

    return { ok: true, draftId, expiresAt };
  }

  async getDraft(draftId: string): Promise<GetDraftResult> {
    if (!isDraftId(draftId)) {
      return { ok: false, reason: 'not_found' };
    }

    // Claimed means a claim marker or a finalized submission exists, the same check finalizeDraft uses.
    if (await this.checkAlreadyClaimed(draftId)) {
      return { ok: false, reason: 'already_claimed' };
    }

    // Read draft
    try {
      const draftPath = `community/_drafts/${draftId}.json`;
      const draftData = await this.backend.readFile(draftPath);
      if (draftData === null) {
        return { ok: false, reason: 'not_found' };
      }

      const record = JSON.parse(draftData);
      if (new Date(record.expiresAt).getTime() < this.now()) {
        return { ok: false, reason: 'expired' };
      }

      return {
        ok: true,
        draft: {
          draftId: record.draftId,
          projection: record.projection,
          note: record.note,
          droppedRefs: record.droppedRefs || [],
          droppedAuthFields: record.droppedAuthFields || [],
          expiresAt: record.expiresAt,
        },
      };
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'draftStore',
        level: 'error',
        message: `getDraft failed: ${logSafeError(err)}`,
        error: { name: (err as Error).name ?? 'Error', message: logSafeError(err), stack: redactDraftIds((err as Error).stack ?? '') },
      });
      throw new ActionableError({
        goal: 'Read the draft',
        problem: 'Storage read failed while loading the draft',
        location: 'draftStore.getDraft',
        nextSteps: ['Verify storage backend health'],
        innerError: err,
      });
    }
  }

  private async checkAlreadyClaimed(draftId: string): Promise<boolean> {
    try {
      const paths = [
        `community/_drafts/claims/${draftId}.json`,
        `community/_submissions/sub-${draftId}.json`,
      ];
      for (const p of paths) {
        const data = await this.backend.readFile(p);
        if (data !== null) return true;
      }
    } catch (err) {
      // Fail closed: when the claim state cannot be read, the draft is treated as claimed and refused.
      // Letting the guard pass would rely on the strict write alone (Security, t/185).
      log.server.warn(`checkAlreadyClaimed: read failed for draft ${logDraftId(draftId)}: ${logSafeError(err)} (treated as claimed; fail closed)`);
      return true;
    }
    return false;
  }

  private async loadDraft(draftId: string): Promise<{ ok: false; reason: 'not_found' | 'expired' } | { ok: true; record: any }> {
    let draftData: string | null;
    try {
      draftData = await this.backend.readFile(`community/_drafts/${draftId}.json`);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'draftStore',
        level: 'error',
        message: `Failed to read draft: ${logSafeError(err)}`,
        error: { name: (err as Error).name ?? 'Error', message: logSafeError(err), stack: redactDraftIds((err as Error).stack ?? '') },
      });
      throw new ActionableError({
        goal: 'Retrieve draft by ID',
        problem: 'Failed to read draft from storage',
        location: 'draftStore.loadDraft',
        nextSteps: ['Verify draft ID', 'Check storage backend health'],
      });
    }

    if (draftData === null) return { ok: false, reason: 'not_found' };

    let record: any;
    try {
      record = JSON.parse(draftData);
    } catch {
      /* telemetry — silent by design (corrupted draft data means not_found) */
      return { ok: false, reason: 'not_found' };
    }

    if (new Date(record.expiresAt).getTime() < this.now()) {
      return { ok: false, reason: 'expired' };
    }

    return { ok: true, record };
  }

  // Returns 'exists' when another finalize won the race: the loser reports already_claimed, not an error (t/185 follow-up).
  private async writeSubmissionAndMarker(draftId: string, record: any, principal: DraftPrincipal): Promise<'written' | 'exists'> {
    const submissionPath = `community/_submissions/sub-${draftId}.json`;
    // B5: the same Submission shape submitToCommunity writes (community.ts), so the per-user and
    // global caps on both paths count every pending submission, and the approval flow reads it.
    const projection = record.projection as Record<string, unknown>;
    const submission = {
      id: draftId,
      type: 'inquiry',
      originalId: typeof projection.id === 'string' ? projection.id : draftId,
      submittedBy: principal.storageUserId,
      submittedAt: new Date(this.now()).toISOString(),
      status: 'pending',
      note: record.note,
      data: projection,
    };

    try {
      const result = await writeFileIfAbsentStrict(this.backend, submissionPath, JSON.stringify(submission));
      if (result === 'exists') return 'exists';
    } catch (err) {
      if (err instanceof ActionableError) throw err;
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'draftStore',
        level: 'error',
        message: `Failed to write submission: ${logSafeError(err)}`,
        error: { name: (err as Error).name ?? 'Error', message: logSafeError(err), stack: redactDraftIds((err as Error).stack ?? '') },
      });
      throw new ActionableError({
        goal: 'Write finalized submission',
        problem: 'Failed to write submission to storage',
        location: 'draftStore.writeSubmissionAndMarker',
        nextSteps: ['Verify storage backend health', 'Check disk space'],
      });
    }

    // Write claim marker (best-effort)
    try {
      const claimPath = `community/_drafts/claims/${draftId}.json`;
      const claimMarker = { draftId, expiresAt: record.expiresAt, claimedAt: new Date(this.now()).toISOString() };
      await writeFileIfAbsentStrict(this.backend, claimPath, JSON.stringify(claimMarker));
    } catch (err) {
      log.server.warn(`finalizeDraft: claim marker write failed: ${logSafeError(err)}`);
    }

    // Delete draft body (best-effort)
    try {
      await this.backend.deleteFile(`community/_drafts/${draftId}.json`);
    } catch (err) {
      log.server.warn(`finalizeDraft: draft delete failed: ${logSafeError(err)}`);
    }
    return 'written';
  }

  async finalizeDraft(draftId: string, principal: DraftPrincipal): Promise<FinalizeDraftResult> {
    if (!isDraftId(draftId)) {
      return { ok: false, reason: 'not_found' };
    }

    // Refuse anonymous callers via the shared request-context check. A cookie-holding anonymous visitor has
    // storageUserId anon-<uuid> (since #5293), so the id is not the test. isAnonymousUser() is true outside a
    // request context, so a finalize with no context is refused. The id prefix is not matched: a signed-in
    // login can start with 'anon-' (Second-Opinion, t/185).
    if (isAnonymousUser() || !principal.storageUserId || principal.storageUserId === '_local') {
      return { ok: false, reason: 'anonymous' };
    }

    // Check if already claimed
    if (await this.checkAlreadyClaimed(draftId)) {
      return { ok: false, reason: 'already_claimed' };
    }

    // Load draft
    const draftResult = await this.loadDraft(draftId);
    if (!draftResult.ok) {
      return draftResult;
    }
    const record = draftResult.record;

    // Check caps against the community queue's own limits (B5), so both paths share one cap.
    const userCount = await this.countUserPendingSubmissions(principal.storageUserId);
    if (userCount >= getConfig().community.maxPendingPerUser) return { ok: false, reason: 'user_cap_reached' };

    const globalCount = await this.countGlobalPendingSubmissions();
    if (globalCount >= getConfig().community.globalPendingCap) return { ok: false, reason: 'queue_full' };

    // Write submission and markers
    const written = await this.writeSubmissionAndMarker(draftId, record, principal);
    if (written === 'exists') return { ok: false, reason: 'already_claimed' };
    return { ok: true, submissionId: draftId };
  }

  async sweepExpiredDrafts(): Promise<{ deleted: number }> {
    let deleted = 0;
    try {
      const files = await this.backend.listDirectory('community/_drafts');
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        if (await this.sweepRecord(`community/_drafts/${file}`, 'draft')) deleted++;
      }
      // Claim markers live in claims/ (listDirectory is not recursive). They carry expiresAt, so the same rule applies.
      await this.sweepExpiredClaimMarkers((n) => { deleted += n; });
    } catch (err) {
      log.server.error(`sweepExpiredDrafts failed: ${logSafeError(err)}`);
      throw new ActionableError({
        goal: 'Sweep expired draft submissions',
        problem: 'Failed to sweep expired drafts',
        location: 'draftStore.sweepExpiredDrafts',
        nextSteps: ['Check storage backend health', 'Retry the operation'],
      });
    }
    return { deleted };
  }

  // What one read of a record says about it. `empty` is never grounds for a delete: an empty or
  // whitespace-only read is how a failed or racing read looks, and the record may be live (t/738).
  private classifyRecord(data: string): 'live' | 'expired' | 'empty' | 'corrupt' | 'bad_expiry' {
    if (data.trim() === '') return 'empty';
    let rec: { expiresAt?: unknown } | null;
    try {
      rec = JSON.parse(data);
    } catch {
      /* telemetry — silent by design (the caller logs what it does with a corrupt record) */
      return 'corrupt';
    }
    const expiry = parseExpiry((rec as { expiresAt?: unknown } | null)?.expiresAt);
    if (Number.isNaN(expiry)) return 'bad_expiry';
    return expiry < this.now() ? 'expired' : 'live';
  }

  // Sweeps one draft or claim-marker record; true when it was deleted. Never throws.
  // - expired: deleted (the ordinary TTL path).
  // - empty read: kept, with a WARN.
  // - corrupt or bad expiresAt: such a record has no age on the StorageBackend interface, so it cannot be
  //   quarantined by age, and it can never be finalized or honoured. It is deleted on sight, but only after
  //   a second read returns the identical content (one truncated or torn read must not delete a live
  //   record), and every such delete is logged with its path and reason (t/507 SO follow-up; t/738, Security).
  private async sweepRecord(recordPath: string, kind: 'draft' | 'claim marker'): Promise<boolean> {
    const shown = logRecordPath(recordPath);
    try {
      const data = await this.backend.readFile(recordPath);
      if (data === null) {
        this.corruptSeen.delete(recordPath);
        return false;
      }
      const verdict = this.classifyRecord(data);
      if (verdict === 'live') {
        this.corruptSeen.delete(recordPath);
        return false;
      }
      if (verdict === 'empty') {
        log.server.warn(`sweepExpiredDrafts: ${kind} ${shown} read as empty (kept; an empty read is not proof the record is dead)`);
        return false;
      }
      if (verdict !== 'expired') {
        const again = await this.backend.readFile(recordPath);
        if (again !== data) {
          log.server.warn(`sweepExpiredDrafts: ${kind} ${shown} read as ${verdict}, but a second read differed (kept; retried on next sweep)`);
          return false;
        }
        // Minimum age: the backend gives no mtime, so the store remembers when it first saw this exact content.
        const seen = this.corruptSeen.get(recordPath);
        if (!seen || seen.content !== data) {
          this.corruptSeen.set(recordPath, { content: data, firstSeen: this.now() });
          log.server.warn(`sweepExpiredDrafts: ${kind} ${shown} read as ${verdict} (kept; first sighting, deleted only if unchanged after ${CORRUPT_MIN_AGE_MS / 60000} min)`);
          return false;
        }
        if (this.now() - seen.firstSeen < CORRUPT_MIN_AGE_MS) {
          log.server.warn(`sweepExpiredDrafts: ${kind} ${shown} read as ${verdict} (kept; below the minimum age)`);
          return false;
        }
        log.server.warn(`sweepExpiredDrafts: deleting ${kind} ${shown} on sight, reason ${verdict} (unchanged since first seen, ${data.length} chars)`);
      }
      await this.backend.deleteFile(recordPath);
      this.corruptSeen.delete(recordPath);
      return true;
    } catch (err) {
      log.server.warn(`sweepExpiredDrafts: could not sweep ${kind} ${shown}: ${logSafeError(err)} (skipped; retried on next sweep)`);
      return false;
    }
  }

  // path -> content first seen as corrupt and when; in memory, so a restart only delays a delete.
  private readonly corruptSeen = new Map<string, { content: string; firstSeen: number }>();

  private async sweepExpiredClaimMarkers(addDeleted: (n: number) => void): Promise<void> {
    let files: string[];
    try {
      files = await this.backend.listDirectory('community/_drafts/claims');
    } catch (err) {
      log.server.warn(`sweepExpiredDrafts: could not list claim markers: ${logSafeError(err)} (claim markers not swept this tick)`);
      return;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      if (await this.sweepRecord(`community/_drafts/claims/${file}`, 'claim marker')) addDeleted(1);
    }
  }

  private async countPendingDrafts(): Promise<number> {
    let count = 0;
    try {
      const files = await this.backend.listDirectory('community/_drafts');
      for (const file of files) {
        if (!file.endsWith('.json') || file.startsWith('claims/')) continue;
        const path = `community/_drafts/${file}`;
        const data = await this.backend.readFile(path);
        if (data === null) continue;
        let rec: { expiresAt?: unknown };
        try {
          rec = JSON.parse(data);
        } catch (err) {
          // One corrupt record must not block every create. Count it conservatively: it may still be live.
          log.server.warn(`countPendingDrafts: unparseable draft record ${logRecordPath(path)} (parse error kind ${(err as Error)?.name ?? 'unknown'}; counted as pending)`);
          count++;
          continue;
        }
        if (new Date(rec.expiresAt as string).getTime() >= this.now()) count++;
      }
    } catch (err) {
      // B2: a listing failure must refuse, never admit. A partial count would let a draft past the cap.
      log.server.error(`countPendingDrafts: list/read failed: ${logSafeError(err)} (failing closed)`);
      throw new ActionableError({
        goal: 'Count pending drafts',
        problem: 'Failed to list/read drafts directory (fail-closed for cap check)',
        location: 'draftStore.countPendingDrafts',
        nextSteps: ['Check storage backend health'],
        httpStatus: 503,
      });
    }
    return count;
  }

  private async countUserPendingSubmissions(userId: string): Promise<number> {
    let count = 0;
    try {
      const files = await this.backend.listDirectory('community/_submissions');
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const data = await this.backend.readFile(`community/_submissions/${file}`);
        if (data !== null) {
          const rec = JSON.parse(data);
          if (rec.submittedBy === userId && rec.status === 'pending') count++;
        }
      }
    } catch (err) {
      log.server.error(`countUserPendingSubmissions: list/read failed: ${logSafeError(err)} (failing closed)`);
      throw new ActionableError({
        goal: 'Count user pending submissions',
        problem: 'Failed to list/read submissions directory (fail-closed for cap check)',
        location: 'draftStore.countUserPendingSubmissions',
        nextSteps: ['Check storage backend health'],
        httpStatus: 503,
      });
    }
    return count;
  }

  private async countGlobalPendingSubmissions(): Promise<number> {
    let count = 0;
    try {
      const files = await this.backend.listDirectory('community/_submissions');
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const data = await this.backend.readFile(`community/_submissions/${file}`);
        if (data !== null) {
          const rec = JSON.parse(data);
          if (rec.status === 'pending') count++;
        }
      }
    } catch (err) {
      log.server.error(`countGlobalPendingSubmissions: list/read failed: ${logSafeError(err)} (failing closed)`);
      throw new ActionableError({
        goal: 'Count global pending submissions',
        problem: 'Failed to list/read submissions directory (fail-closed for cap check)',
        location: 'draftStore.countGlobalPendingSubmissions',
        nextSteps: ['Check storage backend health'],
        httpStatus: 503,
      });
    }
    return count;
  }
}

// ── Singleton ──

let singleton: DraftStore | null = null;

export function createDraftStore(opts?: { backend?: StorageBackend; now?: () => number }): DraftStore {
  return new DraftStoreImpl(opts?.backend ?? getUserContentBackend(), opts?.now);
}

export function getDraftStore(): DraftStore {
  if (!singleton) {
    singleton = createDraftStore();
  }
  return singleton;
}

export function startDraftSweeper(intervalMs?: number): () => void {
  const interval = intervalMs ?? 60 * 60 * 1000;
  const store = getDraftStore();

  const timer = setInterval(() => {
    store.sweepExpiredDrafts().catch(err => {
      log.server.error(`Draft sweep error: ${logSafeError(err)}`);
    });
  }, interval);

  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}
