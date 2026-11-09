// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import crypto from 'crypto';
import os from 'os';
import { assertSafeId } from '../../../lib/electron-shared/safeId.js';
import { ActionableError } from '../../../lib/debate/errors.js';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';
import { sanitizeText, type SanitizeWarning } from '../../../lib/sanitize/contentSanitizerCore.js';
import { stripSensitiveKeys as stripSensitiveKeysShared, SENSITIVE_KEYS } from '../../../lib/sanitize/stripSensitiveKeys.js';

let _client: CommunityReviewClient | null = null;

/** t/4895: mirrors the server's CommunityType (community.ts) — admin remove/rename now cover
 *  all 4 published types, not just chats/debates. */
export type CommunityType = 'chats' | 'debates' | 'opeds' | 'inquiries';

/** t/4895: same anti-silent-misfile shape as the server's communityDirAndPrefix (t/3650) — an
 *  exhaustive switch with an assertNever default, so a future 5th type is a compile error here
 *  too, not a silent misfile into community/debates/. Desktop has one blob prefix per type
 *  under `community/{type}/`, unlike the server's separate dir-resolver functions. */
function communityPrefixFor(type: CommunityType): string {
  switch (type) {
    case 'chats': return 'chat-';
    case 'debates': return 'debate-';
    case 'opeds': return 'oped-';
    case 'inquiries': return 'inquiry-';
    default: return assertNeverCommunityType(type);
  }
}

/** t/4895/t/4894: the display field an admin rename writes, per type (mirrors the server's
 *  renameFieldFor exactly: chats/debates/inquiries use `title`, opeds use `topic`). */
function renameFieldFor(type: CommunityType): 'title' | 'topic' {
  switch (type) {
    case 'chats': return 'title';
    case 'debates': return 'title';
    case 'inquiries': return 'title';
    case 'opeds': return 'topic';
    default: return assertNeverCommunityType(type);
  }
}

function assertNeverCommunityType(type: never): never {
  throw new Error(`Unhandled community type: ${String(type)}`);
}

const COMMUNITY_TYPES = new Set<CommunityType>(['chats', 'debates', 'opeds', 'inquiries']);

/** t/4895 (Quality p/664#33): `type`'s TS type is erased at the Electron IPC boundary — a
 *  renderer-supplied value is `unknown` at runtime, so an unrecognized string must be rejected
 *  explicitly rather than trusted into `communityPrefixFor`'s exhaustive switch (whose `default`
 *  only guards a MISSING arm at compile time, not a bad runtime value). */
function assertCommunityType(type: unknown): CommunityType {
  if (typeof type !== 'string' || !COMMUNITY_TYPES.has(type as CommunityType)) {
    throw new ActionableError({
      goal: 'Validate the community item type',
      problem: `Invalid community type: ${String(type)}`,
      location: 'communityReviewIO.ts → assertCommunityType',
      nextSteps: [`Use one of: ${[...COMMUNITY_TYPES].join(', ')}`],
    });
  }
  return type as CommunityType;
}

/** t/4895 (TL p/577#78 / t/4895#4): getClient() writes to the SHARED community blob container
 *  via DefaultAzureCredential — that's service-level infra auth, not a per-user identity, so
 *  there is no signed-in Azure principal to record here. The OS username is the best available
 *  actor (mirrors nodeDeleteLog.ts / taxonomyHandlers.ts's local-identity fallback) — every
 *  desktop admin action on the shared container must be attributable, never '_local'. */
function desktopAdminActor(): string {
  return `desktop:${os.userInfo().username}`;
}

interface Submission {
  id: string;
  type: 'chat' | 'debate';
  originalId: string;
  submittedBy: string;
  submittedAt: string;
  status: 'pending' | 'approved' | 'rejected';
  note?: string;
  rejectionReason?: string;
  data: unknown;
}

interface ReviewItem {
  id: string;
  domain: string;
  submitter: string;
  submitterDisplay: string;
  submittedAt: string;
  summary: string;
  itemCount: number;
  status: 'pending' | 'viewed';
}

interface TranscriptEntry { speaker: string; content: string; type: string }

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function extractString(val: unknown): string {
  if (typeof val === 'string') return val;
  if (val && typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    for (const key of ['final', 'refined', 'original']) {
      if (typeof obj[key] === 'string') return obj[key];
    }
  }
  return '';
}

function titleOf(data: unknown): string {
  const d = asRecord(data);
  return extractString(d.title) || extractString(d.topic) || '(untitled)';
}

function turnsOf(d: Record<string, unknown>): unknown[] {
  const turns = d.transcript ?? d.messages ?? d.turns ?? d.rounds ?? [];
  return Array.isArray(turns) ? turns : [];
}

function buildPreview(data: unknown): { preview: string; turnCount: number } {
  const d = asRecord(data);
  const turns = turnsOf(d);
  const text = turns.length
    ? turns.map(t => {
        const r = asRecord(t);
        const speaker = String(r.speaker ?? r.role ?? '');
        const content = String(r.content ?? r.text ?? r.message ?? '');
        return speaker ? `${speaker}: ${content}` : content;
      }).filter(Boolean).join('\n')
    : JSON.stringify(d);
  return { preview: text.slice(0, 500), turnCount: turns.length };
}

function buildTranscriptPreview(data: unknown, limit = 50): TranscriptEntry[] {
  return turnsOf(asRecord(data)).slice(0, limit).map(t => {
    const r = asRecord(t);
    return {
      speaker: String(r.speaker ?? r.character ?? r.role ?? r.pov ?? r.author ?? ''),
      content: String(r.content ?? r.text ?? r.message ?? '').slice(0, 600),
      type: String(r.type ?? r.phase ?? r.kind ?? ''),
    };
  }).filter(e => e.content);
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map(x => typeof x === 'string' ? x : String(asRecord(x).pov ?? asRecord(x).id ?? asRecord(x).name ?? ''))
    .filter(Boolean);
}

function activePoversOf(d: Record<string, unknown>): string[] {
  const direct = toStringArray(d.activePovers ?? d.active_povers);
  return direct.length ? direct : toStringArray(d.characters);
}

function scanSensitive(obj: unknown, found = new Set<string>()): Set<string> {
  if (!obj || typeof obj !== 'object') return found;
  if (Array.isArray(obj)) { for (const v of obj) scanSensitive(v, found); return found; }
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k)) found.add(k);
    scanSensitive(v, found);
  }
  return found;
}

// Observability hook for the pure lib sanitizer (t/2033). The desktop promote path injects a
// flight-recorder onWarn rather than importing a logger (the lib core stays logger-agnostic;
// the server wraps it with pino). NEVER logs content (secrets rule) — only the oversize-input
// truncation fact. A throwing hook can't break sanitization (the core guards the call).
const onSanitizeWarn = (w: SanitizeWarning): void => {
  getGlobalRecorder()?.record({
    type: 'system.error', component: 'community-review-io', level: 'warn',
    message: `sanitizeText: input exceeded cap (${w.cap}) — truncated before sanitization`,
    data: { reason: w.reason, originalLength: w.originalLength, cap: w.cap },
  });
};

// Desktop binding of the shared community secret-strip traversal (t/2037): the lib helper — the
// single source of the SENSITIVE_KEYS drop + SECRET_PREFIX_RE screen + array/object recursion,
// shared byte-identically with the server copy — wired to the pure sanitizer + this module's
// flight-recorder onWarn. The desktop skips the server's ALS budget (server-HTTP-only, t/2033#6).
// Exported (1-arg) so the t/2033 regression test exercises the real desktop wiring end-to-end
// (sanitizeText actually applied), and so sanitizeForCommunity's call site is unchanged.
export function stripSensitiveKeys(obj: unknown): unknown {
  return stripSensitiveKeysShared(obj, (v) => sanitizeText(v, onSanitizeWarn));
}

function sanitizeForCommunity(data: unknown, submittedBy: string): Record<string, unknown> {
  const d = stripSensitiveKeys(JSON.parse(JSON.stringify(data))) as Record<string, unknown>;
  d.community_metadata = {
    submitted_by_display: submittedBy,
    submitted_at: new Date().toISOString(),
    approved_at: new Date().toISOString(),
    original_id: d.id,
  };
  d.id = crypto.randomUUID();
  return d;
}

// ── Azure Blob Client ──

class CommunityReviewClient {
  // Lazily-resolved Azure SDK imports (avoids startup cost when Azure isn't configured)
  private communityClient: import('@azure/storage-blob').ContainerClient | null = null;
  private readonly accountUrl: string;
  private readonly communityContainer: string;
  private initPromise: Promise<void> | null = null;

  constructor(accountUrl: string, communityContainer = 'community') {
    this.accountUrl = accountUrl;
    this.communityContainer = communityContainer;
  }

  private async init(): Promise<void> {
    if (this.communityClient) return;
    if (this.initPromise) { await this.initPromise; return; }
    this.initPromise = (async () => {
      const { BlobServiceClient } = await import('@azure/storage-blob');
      const { DefaultAzureCredential } = await import('@azure/identity');
      const service = new BlobServiceClient(this.accountUrl, new DefaultAzureCredential());
      this.communityClient = service.getContainerClient(this.communityContainer);
    })();
    await this.initPromise;
  }

  private async readBlob(blobName: string): Promise<string | null> {
    await this.init();
    try {
      const resp = await this.communityClient!.getBlobClient(blobName).download();
      const chunks: Buffer[] = [];
      if (resp.readableStreamBody) {
        for await (const chunk of resp.readableStreamBody) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : Buffer.from(chunk as Uint8Array));
        }
      }
      return Buffer.concat(chunks).toString('utf-8');
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode === 404) return null;
      // Filters 404 (expected → null) but rethrows other errors — record before rethrow so
      // the original blob-read context isn't lost at the terminal handler (t/1323 rule 1).
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'community-review-io', level: 'error',
        message: 'readBlob failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw err;
    }
  }

  private async writeBlob(blobName: string, content: string): Promise<void> {
    await this.init();
    const data = Buffer.from(content, 'utf-8');
    await this.communityClient!.getBlockBlobClient(blobName).upload(data, data.byteLength, {
      blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' },
    });
  }

  private async deleteBlob(blobName: string): Promise<boolean> {
    await this.init();
    try {
      await this.communityClient!.getBlobClient(blobName).delete();
      return true;
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode === 404) return false;
      // Filters 404 (expected → false) but rethrows other errors — record before rethrow (t/1323 rule 1).
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'community-review-io', level: 'error',
        message: 'deleteBlob failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw err;
    }
  }

  private async listBlobs(prefix: string): Promise<string[]> {
    await this.init();
    const names: string[] = [];
    const iter = this.communityClient!.listBlobsByHierarchy('/', { prefix });
    for await (const item of iter) {
      const seg = item.name.slice(prefix.length).replace(/\/$/, '');
      if (seg) names.push(seg);
    }
    return names;
  }

  // ── Public API ──

  async listPendingSubmissions(): Promise<Submission[]> {
    const prefix = 'community/_submissions/';
    const files = (await this.listBlobs(prefix)).filter(f => f.startsWith('sub-') && f.endsWith('.json'));
    const subs: Submission[] = [];
    let skipped = 0;
    const skippedIds: string[] = [];
    for (const f of files) {
      try {
        const raw = await this.readBlob(prefix + f);
        if (!raw) continue;
        const s = JSON.parse(raw) as Submission;
        if (s.status === 'pending') subs.push(s);
      } catch {
        skipped++;
        if (skippedIds.length < 5) skippedIds.push(f);
        /* telemetry — silent by design; per-item skip aggregated after the loop (t/1323 rule 2) */
      }
    }
    if (skipped > 0) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'community-review-io', level: 'warn',
        message: `Skipped ${skipped} malformed submission file(s)`,
        data: { skipped, total: files.length, first_skipped: skippedIds },
      });
    }
    return subs.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  }

  async getQueue(): Promise<{ items: ReviewItem[] }> {
    const pending = await this.listPendingSubmissions();
    return {
      items: pending.map(s => ({
        id: `community:${s.id}`,
        domain: 'community',
        submitter: s.submittedBy,
        submitterDisplay: s.submittedBy,
        submittedAt: s.submittedAt,
        summary: `1 ${s.type}: ${titleOf(s.data)}`,
        itemCount: 1,
        status: 'pending' as const,
      })),
    };
  }

  async getStats(): Promise<{ total: number; byDomain: Record<string, number> }> {
    const pending = await this.listPendingSubmissions();
    return { total: pending.length, byDomain: { community: pending.length } };
  }

  async getDetail(groupId: string): Promise<unknown> {
    const id = groupId.startsWith('community:') ? groupId.slice('community:'.length) : groupId;
    const raw = await this.readBlob(`community/_submissions/sub-${id}.json`);
    if (!raw) return { domain: 'community', submissionId: id, found: false };

    const sub = JSON.parse(raw) as Submission;
    const d = asRecord(sub.data);
    const { preview, turnCount } = buildPreview(sub.data);

    return {
      domain: 'community',
      submissionId: sub.id,
      itemId: sub.id,
      type: sub.type,
      submitter: sub.submittedBy,
      submittedAt: sub.submittedAt,
      note: sub.note ?? null,
      title: titleOf(sub.data),
      topic: extractString(d.topic) || null,
      preview,
      transcriptPreview: buildTranscriptPreview(sub.data),
      metadata: {
        model: (d.model as string) ?? (d.debate_model as string) ?? null,
        turnCount,
        phase: (d.phase as string) ?? null,
        audience: (d.audience as string) ?? null,
        activePovers: activePoversOf(d),
        taxonomyRefs: (d.taxonomy_refs ?? d.taxonomyRefs ?? []) as unknown,
      },
      sanitization: {
        willStrip: [...scanSensitive(sub.data)],
        willAdd: ['community_metadata (attribution)', 'regenerated id'],
      },
    };
  }

  async removePublishedItem(type: CommunityType, id: string, reason?: string): Promise<void> {
    const safeType = assertCommunityType(type);
    assertSafeId(id, 'community id'); // t/4895 (Quality p/664#33): block path traversal before any blob name is built
    const prefix = communityPrefixFor(safeType);
    const blobName = `community/${safeType}/${prefix}${id}.json`;

    const raw = await this.readBlob(blobName);
    if (!raw) throw new ActionableError({
      goal: 'Remove a community item',
      problem: `Community item not found: ${safeType}/${id}`,
      location: 'communityReviewIO.ts → removePublishedItem',
      nextSteps: ['Verify the community item exists'],
    });

    const itemData = JSON.parse(raw) as Record<string, unknown>;
    await this.deleteBlob(blobName);

    const auditRecord = {
      id,
      type: safeType,
      title: titleOf(itemData),
      submitted_by: (asRecord(itemData.community_metadata as unknown).submitted_by_display as string) ?? 'unknown',
      removed_by: desktopAdminActor(),
      removed_at: new Date().toISOString(),
      reason: reason ?? null,
    };
    await this.writeBlob(
      `community/_removals/rem-${crypto.randomUUID()}.json`,
      JSON.stringify(auditRecord, null, 2),
    );
  }

  /** t/4895/t/4894: admin rename of a published community item's display field, with an audit
   *  record written FIRST (TL t/4894#2 condition 2 — if the audit write throws, the rename
   *  never happens; file unchanged). No CAS/retry (unlike the server's t/4894 condition 3):
   *  this client has no blob-versioning primitive at all (writeBlob takes no baseSha), and
   *  desktop has one implicit local admin, so there is no concurrent-writer race to guard
   *  against. No listing-index invalidation either — getQueue()/getStats() list blobs live on
   *  every call, so there's no cache to go stale. */
  async renamePublishedItem(type: CommunityType, id: string, title: string, reason?: string): Promise<void> {
    const safeType = assertCommunityType(type);
    assertSafeId(id, 'community id'); // t/4895 (Quality p/664#33): block path traversal before any blob name is built
    const newTitle = title.trim();
    if (!newTitle || newTitle.length > 200) {
      throw new ActionableError({
        goal: 'Rename a community item',
        problem: `Title must be 1-200 characters after trimming (got ${newTitle.length} characters)`,
        location: 'communityReviewIO.ts → renamePublishedItem',
        nextSteps: ['Provide a non-empty title of at most 200 characters'],
      });
    }

    const prefix = communityPrefixFor(safeType);
    const blobName = `community/${safeType}/${prefix}${id}.json`;
    const field = renameFieldFor(safeType);

    const raw = await this.readBlob(blobName);
    if (!raw) throw new ActionableError({
      goal: 'Rename a community item',
      problem: `Community item not found: ${safeType}/${id}`,
      location: 'communityReviewIO.ts → renamePublishedItem',
      nextSteps: ['Verify the community item exists'],
    });
    const item = JSON.parse(raw) as Record<string, unknown>;
    const fromValue = typeof item[field] === 'string' ? item[field] as string : null;

    const auditRecord = {
      id, type: safeType, by: desktopAdminActor(), at: new Date().toISOString(), from: fromValue, to: newTitle, reason: reason ?? null,
    };
    // Audit FIRST — before any mutation of the published file (mirrors the server's ordering).
    await this.writeBlob(
      `community/_edits/edit-${crypto.randomUUID()}.json`,
      JSON.stringify(auditRecord, null, 2),
    );

    item[field] = newTitle;
    await this.writeBlob(blobName, JSON.stringify(item, null, 2));
  }

  async executeAction(action: {
    groupId: string;
    action: 'promote' | 'reject';
    itemIds: string[];
    reason?: string;
    edits?: Record<string, Record<string, unknown>>;
  }): Promise<void> {
    for (const rawId of action.itemIds) {
      const id = rawId.startsWith('community:') ? rawId.slice('community:'.length) : rawId;
      const subPath = `community/_submissions/sub-${id}.json`;
      const raw = await this.readBlob(subPath);
      if (!raw) throw new Error(`Submission not found: ${id}`);

      const submission = JSON.parse(raw) as Submission;
      if (submission.status !== 'pending') throw new Error(`Submission already ${submission.status}`);

      if (action.action === 'promote') {
        const edits = action.edits?.[rawId] ?? action.edits?.[id];
        await this.promoteSubmission(submission, subPath, edits);
      } else {
        submission.status = 'rejected';
        if (action.reason) submission.rejectionReason = action.reason;
        await this.writeBlob(subPath, JSON.stringify(submission, null, 2));
      }
    }
  }

  /** Promote one pending submission: merge admin edits, sanitize, publish to the public
   *  community blob, and mark the submission approved. Extracted from executeAction (t/1914). */
  private async promoteSubmission(submission: Submission, subPath: string, edits: Record<string, unknown> | undefined): Promise<void> {
    const dataToPublish = (edits && typeof edits === 'object' && submission.data && typeof submission.data === 'object')
      ? { ...(submission.data as Record<string, unknown>), ...edits }
      : submission.data;
    const sanitized = sanitizeForCommunity(dataToPublish, submission.submittedBy);
    const dir = submission.type === 'chat' ? 'community/chats' : 'community/debates';
    const prefix = submission.type === 'chat' ? 'chat-' : 'debate-';
    await this.writeBlob(`${dir}/${prefix}${sanitized.id}.json`, JSON.stringify(sanitized, null, 2));
    submission.status = 'approved';
    await this.writeBlob(subPath, JSON.stringify(submission, null, 2));
  }
}

// ── Module-level API ──

export function isAzureReviewConfigured(): boolean {
  return !!process.env.AZURE_STORAGE_ACCOUNT_URL;
}

function getClient(): CommunityReviewClient {
  if (!_client) {
    const url = process.env.AZURE_STORAGE_ACCOUNT_URL;
    if (!url) throw new Error('AZURE_STORAGE_ACCOUNT_URL not set — configure it to use community review from the desktop app.');
    _client = new CommunityReviewClient(url, process.env.AZURE_COMMUNITY_CONTAINER || 'community');
  }
  return _client;
}

export async function adminReviewQueue(): Promise<{ items: ReviewItem[] }> {
  return getClient().getQueue();
}

export async function adminReviewStats(): Promise<{ total: number; byDomain: Record<string, number> }> {
  return getClient().getStats();
}

export async function adminReviewDetail(groupId: string): Promise<unknown> {
  return getClient().getDetail(groupId);
}

export async function adminReviewAction(action: {
  groupId: string;
  action: 'promote' | 'reject';
  itemIds: string[];
  reason?: string;
  edits?: Record<string, Record<string, unknown>>;
}): Promise<void> {
  return getClient().executeAction(action);
}

export async function adminRemoveCommunityItem(
  type: CommunityType,
  id: string,
  reason?: string,
): Promise<void> {
  return getClient().removePublishedItem(type, id, reason);
}

export async function adminRenameCommunityItem(
  type: CommunityType,
  id: string,
  title: string,
  reason?: string,
): Promise<void> {
  return getClient().renamePublishedItem(type, id, title, reason);
}
