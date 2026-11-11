// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { randomBytes } from 'crypto';
import type { InquiryPayload, InquiryResult } from '../../../../lib/inquiry/index.js';
import { inquiryPayloadSchema, deriveTruncation } from '../../../../lib/inquiry/index.js';
import type { StorageBackend } from '../storage/storageBackend.js';
import { getUserContentBackend, writeFileIfAbsentStrict } from '../storage/fileIO.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { log } from '../logger.js';
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
  storageUserId: string; // getStorageUserId() of the authenticated caller; anonymous ids are refused
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
  private async countClientPendingDrafts(clientId: string | undefined): Promise<number> {
    if (!clientId) return 0; // no client id → can't track per-client (allow through)
    let count = 0;
    try {
      const files = await this.backend.listDirectory('community/_drafts');
      for (const file of files) {
        if (!file.endsWith('.json') || file === 'claims') continue;
        const data = await this.backend.readFile(`community/_drafts/${file}`);
        if (data !== null) {
          const rec = JSON.parse(data);
          // Match based on some client identifier stored in draft (for now, we'll track by IP via route context)
          // This is a simplified version; in production you'd store clientId in the draft record
          if (rec.clientId === clientId) count++;
        }
      }
    } catch (err) {
      log.server.error(`countClientPendingDrafts: list/read failed: ${(err as any)?.message}`);
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
        message: `createDraft sanitization failed: ${(err as any)?.message}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
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

    // Check per-client rate limit (B6)
    if (clientId) {
      const clientCount = await this.countClientPendingDrafts(clientId);
      if (clientCount >= DRAFT_PER_CLIENT_CAP) {
        return 'cap_reached';
      }
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
    const data = deep as Record<string, unknown>;

    // Separate bridging from contract fields
    const { id, created_at, ...contractFields } = data;

    // Project onto community surface
    const p = projectInquiryFields(contractFields, 'community', '') as Record<string, unknown>;

    // Track dropped auth fields (from the matrix diff)
    const authPaths = ['calibration', 'derivation', 'synthesizedHeadline', 'grounding.campCoverage', 'singleRunCaveat', 'debateId'];
    for (const ap of authPaths) {
      if (hasPath(contractFields, ap) && !hasPath(p, ap)) {
        droppedAuthFields.push(ap);
      }
    }

    // Suppress synthesizedHeadline on degraded runs (t/3742)
    if (p.synthesizedHeadline !== undefined) {
      const { truncated } = deriveTruncation(payload as unknown as InquiryResult);
      if (truncated) {
        delete p.synthesizedHeadline;
        log.server.warn('DraftStore: synthesizedHeadline suppressed on degraded-trust inquiry');
      }
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
        message: `createDraft write failed: ${(err as any)?.message}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw err;
    }

    return { ok: true, draftId, expiresAt };
  }

  async getDraft(draftId: string): Promise<GetDraftResult> {
    if (!isDraftId(draftId)) {
      return { ok: false, reason: 'not_found' };
    }

    // Check claim marker first
    try {
      const claimPath = `community/_drafts/claims/${draftId}.json`;
      const claim = await this.backend.readFile(claimPath);
      if (claim !== null) {
        return { ok: false, reason: 'already_claimed' };
      }
    } catch (err) {
      log.server.warn(`getDraft: failed to check claim: ${(err as any)?.message}`);
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
        message: `getDraft failed: ${(err as any)?.message}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw err;
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
    } catch {
      /* telemetry — silent by design (best-effort check) */
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
        message: `Failed to read draft: ${(err as any)?.message}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
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

  private async writeSubmissionAndMarker(draftId: string, record: any, principal: DraftPrincipal): Promise<void> {
    const submissionPath = `community/_submissions/sub-${draftId}.json`;
    const submission = {
      id: `sub-${draftId}`,
      draftId,
      submittedBy: { id: principal.storageUserId, name: principal.displayName },
      payload: record.projection,
      note: record.note,
      status: 'pending',
      createdAt: new Date(this.now()).toISOString(),
    };

    try {
      const result = await writeFileIfAbsentStrict(this.backend, submissionPath, JSON.stringify(submission));
      if (result === 'exists') {
        throw new ActionableError({
          goal: 'Write finalized submission',
          problem: 'Submission already claimed (race condition)',
          location: 'draftStore.writeSubmissionAndMarker',
          nextSteps: ['Retry if idempotent'],
        });
      }
    } catch (err) {
      if (err instanceof ActionableError) throw err;
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'draftStore',
        level: 'error',
        message: `Failed to write submission: ${(err as any)?.message}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
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
      log.server.warn(`finalizeDraft: claim marker write failed: ${(err as any)?.message}`);
    }

    // Delete draft body (best-effort)
    try {
      await this.backend.deleteFile(`community/_drafts/${draftId}.json`);
    } catch (err) {
      log.server.warn(`finalizeDraft: draft delete failed: ${(err as any)?.message}`);
    }
  }

  async finalizeDraft(draftId: string, principal: DraftPrincipal): Promise<FinalizeDraftResult> {
    if (!isDraftId(draftId)) {
      return { ok: false, reason: 'not_found' };
    }

    if (!principal.storageUserId || principal.storageUserId === '_local') {
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

    // Check caps
    const userCount = await this.countUserPendingSubmissions(principal.storageUserId);
    if (userCount >= 50) return { ok: false, reason: 'user_cap_reached' };

    const globalCount = await this.countGlobalPendingSubmissions();
    if (globalCount >= 1000) return { ok: false, reason: 'queue_full' };

    // Write submission and markers
    await this.writeSubmissionAndMarker(draftId, record, principal);
    return { ok: true, submissionId: draftId };
  }

  async sweepExpiredDrafts(): Promise<{ deleted: number }> {
    let deleted = 0;
    try {
      const files = await this.backend.listDirectory('community/_drafts');
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const draftPath = `community/_drafts/${file}`;
        try {
          const data = await this.backend.readFile(draftPath);
          if (data !== null) {
            const rec = JSON.parse(data);
            if (new Date(rec.expiresAt).getTime() < this.now()) {
              try {
                await this.backend.deleteFile(draftPath);
                deleted++;
              } catch {
                /* telemetry — silent by design (best-effort sweep) */
              }
            }
          }
        } catch {
          /* telemetry — silent by design (continue with next draft) */
        }
      }
    } catch (err) {
      log.server.error(`sweepExpiredDrafts failed: ${(err as any)?.message}`);
      throw new ActionableError({
        goal: 'Sweep expired draft submissions',
        problem: 'Failed to sweep expired drafts',
        location: 'draftStore.sweepExpiredDrafts',
        nextSteps: ['Check storage backend health', 'Retry the operation'],
      });
    }
    return { deleted };
  }

  private async countPendingDrafts(): Promise<number> {
    let count = 0;
    try {
      const files = await this.backend.listDirectory('community/_drafts');
      for (const file of files) {
        if (!file.endsWith('.json') || file.startsWith('claims/')) continue;
        const data = await this.backend.readFile(`community/_drafts/${file}`);
        if (data !== null) {
          const rec = JSON.parse(data);
          if (new Date(rec.expiresAt).getTime() >= this.now()) count++;
        }
      }
    } catch {
      /* telemetry — silent by design (best-effort count, continue with 0) */
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
          if (rec.submittedBy?.id === userId && rec.status === 'pending') count++;
        }
      }
    } catch (err) {
      log.server.error(`countUserPendingSubmissions: list/read failed: ${(err as any)?.message} (failing closed)`);
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
      log.server.error(`countGlobalPendingSubmissions: list/read failed: ${(err as any)?.message} (failing closed)`);
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
      log.server.error(`Draft sweep error: ${(err as any)?.message}`);
    });
  }, interval);

  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}
