// @vitest-environment node
//
// t/3627 — inquiry public-share storage. Pure persistence plumbing: the field-shape/sanitization
// work (SO e/201#2) already lives in toPublicInquiryShare (lib/inquiry/publicShare.ts, t/3648),
// which projectPublicInquiryShare is trusted to have gotten right (covered by its own tests). This
// suite covers the store's own concerns: owner-only publish (loadInquiryResult scoping),
// idempotent share/unshare, indistinguishable-404 semantics, and revoke correctness AT THE STORE
// LAYER (no cache exists at this layer — the cache-vs-revoke proof belongs to t/3653's route,
// once it lands; see t/3627#5-6).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLoadInquiryResult, serverWarn } = vi.hoisted(() => ({
  mockLoadInquiryResult: vi.fn(),
  serverWarn: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  log: {
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    server: { info: vi.fn(), warn: serverWarn, error: vi.fn(), debug: vi.fn() },
  },
  getRequestId: () => 'req-test',
  LOG_MAX_LINE_BYTES: 65536,
  writeFramedNdjson: vi.fn(),
}));
vi.mock('../storage/inquiryResultStore.js', () => ({ loadInquiryResult: mockLoadInquiryResult }));

// In-memory fake backend keyed by absolute path (t/3490 fixture pattern). `hooks` let a race
// test run code just before a write/delete lands (t/4937).
const files = new Map<string, string>();
const hooks: { beforeWrite?: (p: string) => Promise<void>; beforeDelete?: (p: string) => Promise<void> } = {};
const fakeBackend = {
  backendName: 'fake',
  async readFile(p: string) { return files.has(p) ? files.get(p)! : null; },
  async writeFile(p: string, content: string) { await hooks.beforeWrite?.(p); files.set(p, content); },
  async deleteFile(p: string) { await hooks.beforeDelete?.(p); files.delete(p); },
  async listDirectory() { return []; },
  async fileExists(p: string) { return files.has(p); },
  async readBinaryFile() { return null; },
  async writeBinaryFile() { /* unused */ },
};
vi.mock('../storage/fileIO.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getUserContentBackend: () => fakeBackend };
});

import path from 'path';
import { runWithUser, type UserContext } from '../security/userContext.js';
import { publishInquiryShare, unpublishInquiryShare, loadPublicInquiryShare, refreshInquiryShareIfShared } from '../storage/inquiryShareStore.js';
import { resolveDataPath } from '../config.js';
import type { InquiryResult, PublicInquiryShare } from '../../../../lib/inquiry/index.js';

function publicInquiryPath(shareId: string): string {
  return path.join(resolveDataPath('public/inquiries'), `${shareId}.json`);
}
function validShare(): PublicInquiryShare {
  return {
    version: 1,
    request: { question: 'Q', fidelity: 'standard' },
    campVerdicts: [], convergences: [], evidenceLayers: [], unresolvedGaps: [], calibration: [],
    derivation: { fidelity: 'standard', models: {}, rounds: 1 },
    grounding: { nodesByCamp: {} },
    singleRunCaveat: 'One run is not a finding.',
  };
}

const OWNER: UserContext = { principalName: 'owner-1', idp: 'github', storageUserId: 'owner-1', isAnonymous: false };
const ANON: UserContext = { principalName: '', idp: 'anon', storageUserId: '_local', isAnonymous: true };

function makeResult(question: string): InquiryResult {
  const node = { nodeId: 'skp-beliefs-029', label: 'Precaution', camp: 'skp' as const };
  return {
    schemaVersion: 1,
    request: { question, fidelity: 'standard', situationId: 'sit-42', models: { debaters: 'gemini-3.1-pro-preview', evaluator: 'claude-opus-5' } },
    campVerdicts: [{ camp: 'saf', verdict: 'A verdict', nodes: [node] }],
    convergences: [{ claim: 'A convergence', nodes: [node] }],
    evidenceLayers: [{ title: 'Ev', role: 'grounds', solves: 'scope', sources: ['https://example.org/paper'] }],
    unresolvedGaps: [{ description: 'a gap', confidence: 'low' }],
    calibration: [{ metric: 'claim_acceptance', value: 0.85, trust: { verdict: 'trust', reason: 'quorum' } }],
    derivation: { fidelity: 'standard', models: { debate: 'gemini-3.1-pro-preview' }, rounds: 6, callBudget: 200 },
    grounding: { anchorSituationId: 'sit-42', anchorSummary: 'ctx', nodesByCamp: { skp: [node] } },
    singleRunCaveat: 'One run is not a finding.',
    debateId: 'debate-abc',
  } as unknown as InquiryResult;
}

describe('inquiryShareStore (t/3627)', () => {
  beforeEach(() => {
    files.clear();
    delete hooks.beforeWrite;
    delete hooks.beforeDelete;
    mockLoadInquiryResult.mockReset();
    serverWarn.mockClear();
  });

  // ─── publishInquiryShare ────────────────────────────────────────────────────

  it('publishes a result to a fresh shareId, projecting via toPublicInquiryShare', async () => {
    mockLoadInquiryResult.mockResolvedValue(makeResult('Should X?'));
    const result = await runWithUser(OWNER, () => publishInquiryShare('job-1'));
    expect(result).not.toBeNull();
    const pub = await loadPublicInquiryShare(result!.shareId);
    expect(pub).not.toBeNull();
    expect(pub!.request.question).toBe('Should X?');
    // The public projection strips private fields — confirms toPublicInquiryShare actually ran,
    // not a raw passthrough of the InquiryResult.
    expect(JSON.stringify(pub)).not.toContain('debate-abc'); // debateId
    expect(JSON.stringify(pub)).not.toContain('skp-beliefs-029'); // nodeId
  });

  it('is idempotent — re-sharing an already-shared jobId reuses the SAME shareId, no dup copy', async () => {
    mockLoadInquiryResult.mockResolvedValue(makeResult('Q1'));
    const first = await runWithUser(OWNER, () => publishInquiryShare('job-1'));
    const second = await runWithUser(OWNER, () => publishInquiryShare('job-1'));
    expect(second!.shareId).toBe(first!.shareId);
  });

  it('returns null for anonymous callers (no durable owner scope to share from)', async () => {
    const result = await runWithUser(ANON, () => publishInquiryShare('job-1'));
    expect(result).toBeNull();
    expect(mockLoadInquiryResult).not.toHaveBeenCalled();
  });

  it('returns null (indistinguishable 404) when the job is absent or not owned by the caller', async () => {
    mockLoadInquiryResult.mockResolvedValue(null);
    const result = await runWithUser(OWNER, () => publishInquiryShare('not-mine'));
    expect(result).toBeNull();
  });

  // ─── unpublishInquiryShare / revoke correctness (store layer) ──────────────

  it('unpublish deletes the public copy — loadPublicInquiryShare returns null immediately (no cache at this layer)', async () => {
    mockLoadInquiryResult.mockResolvedValue(makeResult('Q1'));
    const { shareId } = (await runWithUser(OWNER, () => publishInquiryShare('job-1')))!;
    expect(await loadPublicInquiryShare(shareId)).not.toBeNull();

    const revoked = await runWithUser(OWNER, () => unpublishInquiryShare('job-1'));
    expect(revoked).toBe(true);
    expect(await loadPublicInquiryShare(shareId)).toBeNull();
  });

  it('unpublish is idempotent — a second revoke on an already-revoked jobId is a no-op returning false', async () => {
    mockLoadInquiryResult.mockResolvedValue(makeResult('Q1'));
    await runWithUser(OWNER, () => publishInquiryShare('job-1'));
    expect(await runWithUser(OWNER, () => unpublishInquiryShare('job-1'))).toBe(true);
    expect(await runWithUser(OWNER, () => unpublishInquiryShare('job-1'))).toBe(false);
  });

  it('unpublish on a never-shared jobId is a no-op returning false', async () => {
    const revoked = await runWithUser(OWNER, () => unpublishInquiryShare('never-shared'));
    expect(revoked).toBe(false);
  });

  it('re-sharing after revoke mints a FRESH shareId — the old link stays permanently dead', async () => {
    mockLoadInquiryResult.mockResolvedValue(makeResult('Q1'));
    const first = await runWithUser(OWNER, () => publishInquiryShare('job-1'));
    await runWithUser(OWNER, () => unpublishInquiryShare('job-1'));
    const second = await runWithUser(OWNER, () => publishInquiryShare('job-1'));

    expect(second!.shareId).not.toBe(first!.shareId);
    expect(await loadPublicInquiryShare(first!.shareId)).toBeNull(); // old link dead
    expect(await loadPublicInquiryShare(second!.shareId)).not.toBeNull(); // new link live
  });

  it('unpublish for anonymous callers is a no-op returning false', async () => {
    expect(await runWithUser(ANON, () => unpublishInquiryShare('job-1'))).toBe(false);
  });

  // ─── loadPublicInquiryShare (the unauthenticated read path) ────────────────

  it('returns null for a shareId that was never shared', async () => {
    expect(await loadPublicInquiryShare('never-shared-id')).toBeNull();
  });

  it('never touches users/** — reads exclusively from the public/inquiries/ prefix', async () => {
    mockLoadInquiryResult.mockResolvedValue(makeResult('Q1'));
    await runWithUser(OWNER, () => publishInquiryShare('job-1'));
    const paths = [...files.keys()];
    const publicPaths = paths.filter(p => p.includes('public') && p.includes('inquiries'));
    expect(publicPaths.length).toBeGreaterThan(0);
    // Every write went to public/inquiries/ or the owner-scoped registry — never a bare users/ result path.
    for (const p of paths) {
      const norm = p.replace(/\\/g, '/');
      expect(norm.includes('inquiry-results')).toBe(false);
    }
  });

  // ─── t/3730: tolerant read-side validation ─────────────────────────────────

  it('a structurally-invalid blob returns null and WARNs (never type-checks through to the caller)', async () => {
    files.set(publicInquiryPath('bad-share'), JSON.stringify({ version: 1, request: { question: 'Q' } })); // missing required fields
    expect(await loadPublicInquiryShare('bad-share')).toBeNull();
    expect(serverWarn).toHaveBeenCalledWith(
      expect.objectContaining({ shareId: 'bad-share', cause: 'inquiry-share-schema-invalid' }),
      expect.any(String),
    );
  });

  it('non-JSON content returns null and WARNs', async () => {
    files.set(publicInquiryPath('corrupt-share'), '{not valid json');
    expect(await loadPublicInquiryShare('corrupt-share')).toBeNull();
    expect(serverWarn).toHaveBeenCalledWith(
      expect.objectContaining({ shareId: 'corrupt-share', cause: 'inquiry-share-unparseable' }),
      expect.any(String),
    );
  });

  it('(deploy-overlap hazard) a valid blob carrying an UNKNOWN extra key still parses successfully', async () => {
    // Simulates a share written by a NEWER build (a field this build doesn't know about yet) —
    // the exact scenario a strict reader would 404 on during an ACA rolling-deploy overlap.
    const withExtraField = { ...validShare(), synthesizedHeadline: 'A headline from a future build' };
    files.set(publicInquiryPath('forward-compat-share'), JSON.stringify(withExtraField));
    const pub = await loadPublicInquiryShare('forward-compat-share');
    expect(pub).not.toBeNull();
    expect(pub!.request.question).toBe('Q');
    expect(serverWarn).not.toHaveBeenCalled();
  });

  it('a well-formed share (no extra fields) still round-trips cleanly through the tolerant schema', async () => {
    files.set(publicInquiryPath('clean-share'), JSON.stringify(validShare()));
    const pub = await loadPublicInquiryShare('clean-share');
    expect(pub).not.toBeNull();
    expect(pub!.singleRunCaveat).toContain('One run');
    expect(serverWarn).not.toHaveBeenCalled();
  });

  // ─── refreshInquiryShareIfShared (t/4927) ──────────────────────────────────

  it('refreshes an existing share in place — same shareId, new projection content', async () => {
    mockLoadInquiryResult.mockResolvedValue(makeResult('Original question?'));
    const { shareId } = (await runWithUser(OWNER, () => publishInquiryShare('job-1')))!;

    mockLoadInquiryResult.mockResolvedValue(makeResult('Renamed display title'));
    const refreshed = await runWithUser(OWNER, () => refreshInquiryShareIfShared('job-1'));
    expect(refreshed).toBe(true);

    const pub = await loadPublicInquiryShare(shareId);
    expect(pub!.request.question).toBe('Renamed display title');
  });

  it('never creates a share — returns false and writes nothing for an unshared jobId', async () => {
    const before = files.size;
    const refreshed = await runWithUser(OWNER, () => refreshInquiryShareIfShared('never-shared'));
    expect(refreshed).toBe(false);
    expect(mockLoadInquiryResult).not.toHaveBeenCalled();
    expect(files.size).toBe(before);
  });

  it('returns false for anonymous callers without touching the registry', async () => {
    expect(await runWithUser(ANON, () => refreshInquiryShareIfShared('job-1'))).toBe(false);
    expect(mockLoadInquiryResult).not.toHaveBeenCalled();
  });

  it('returns false if the result is gone despite a registry entry (defensive)', async () => {
    mockLoadInquiryResult.mockResolvedValue(makeResult('Q1'));
    await runWithUser(OWNER, () => publishInquiryShare('job-1'));
    mockLoadInquiryResult.mockResolvedValue(null);
    expect(await runWithUser(OWNER, () => refreshInquiryShareIfShared('job-1'))).toBe(false);
  });

  // ─── unpublish racing a publish/refresh write (t/4937) ─────────────────────

  const registryPath = path.join(resolveDataPath('users/owner-1'), 'inquiry-shares.json');
  const raceCause = (c: [{ cause?: string }]) => c[0]?.cause === 'share-revoked-during-write';

  /** Run unpublish once, just before the next write to `target` lands. */
  function unpublishBeforeWriteTo(target: string): void {
    hooks.beforeWrite = async (p) => {
      if (p !== target) return;
      delete hooks.beforeWrite;
      expect(await runWithUser(OWNER, () => unpublishInquiryShare('job-1'))).toBe(true);
    };
  }

  it('refresh racing an unpublish does not resurrect the revoked public copy', async () => {
    mockLoadInquiryResult.mockResolvedValue(makeResult('Q1'));
    const { shareId } = (await runWithUser(OWNER, () => publishInquiryShare('job-1')))!;

    unpublishBeforeWriteTo(publicInquiryPath(shareId));
    expect(await runWithUser(OWNER, () => refreshInquiryShareIfShared('job-1'))).toBe(false);

    expect(files.has(publicInquiryPath(shareId))).toBe(false);
    expect(await loadPublicInquiryShare(shareId)).toBeNull();
    expect(serverWarn.mock.calls.filter(raceCause)).toHaveLength(1);
  });

  it('re-publish racing an unpublish does not resurrect the revoked public copy', async () => {
    mockLoadInquiryResult.mockResolvedValue(makeResult('Q1'));
    const { shareId } = (await runWithUser(OWNER, () => publishInquiryShare('job-1')))!;

    unpublishBeforeWriteTo(publicInquiryPath(shareId));
    expect(await runWithUser(OWNER, () => publishInquiryShare('job-1'))).toBeNull();

    expect(files.has(publicInquiryPath(shareId))).toBe(false);
    expect(serverWarn.mock.calls.filter(raceCause)).toHaveLength(1);
  });

  it('no race: publish and refresh keep the public copy and stay quiet', async () => {
    mockLoadInquiryResult.mockResolvedValue(makeResult('Q1'));
    const { shareId } = (await runWithUser(OWNER, () => publishInquiryShare('job-1')))!;
    expect(await runWithUser(OWNER, () => publishInquiryShare('job-1'))).toEqual({ shareId });
    expect(await runWithUser(OWNER, () => refreshInquiryShareIfShared('job-1'))).toBe(true);

    expect(files.has(publicInquiryPath(shareId))).toBe(true);
    expect(serverWarn.mock.calls.filter(raceCause)).toHaveLength(0);
  });

  it('unpublish removes the registry entry before deleting the public copy', async () => {
    mockLoadInquiryResult.mockResolvedValue(makeResult('Q1'));
    const { shareId } = (await runWithUser(OWNER, () => publishInquiryShare('job-1')))!;

    let registryAtDelete: Record<string, string> | undefined;
    hooks.beforeDelete = async (p) => {
      if (p === publicInquiryPath(shareId)) registryAtDelete = JSON.parse(files.get(registryPath)!);
    };
    await runWithUser(OWNER, () => unpublishInquiryShare('job-1'));

    expect(registryAtDelete).toBeDefined();
    expect(registryAtDelete!['job-1']).toBeUndefined();
  });
});
