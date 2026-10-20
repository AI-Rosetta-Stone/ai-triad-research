// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/1295 (route extraction, repo-review B-209): the /api/sync route cluster (17
// routes), moved verbatim out of server.ts behind the registration seam. Server-
// local state (githubBackend, sessionManager, broadcastTaxonomyUpdate) is threaded
// via ServerCtx. The ctx bag is READ-ONLY here (TL read-mostly condition): live
// getters are aliased to request-time locals and methods are called on the live
// objects — no ctx member is reassigned. Relative imports gain one `../` for the
// deeper dir. Catches are left as-moved (verbatim) per TL t/1323#9; their flight-
// recorder annotation is a per-cluster follow-up commit.

import crypto from 'crypto';
import type { IncomingMessage } from 'http';
import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error, query } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { log } from '../logger.js';
import { STORAGE_MODE, CACHE_DIR } from '../config.js';
import * as community from '../community/community.js';
import { requireAdmin } from '../community/admin/reviewRegistry.js';
import { getCurrentUserId, isAnonymousUser } from '../security/userContext.js';
import { setRuntimeCredentials, clearRuntimeCredentials, getCredentials } from '../security/githubAppAuth.js';
import { diffNodes, changedFields } from '../storage/editMeta.js';
import { computeNodeConflicts } from '../community/nodeConflicts.js';
import type { TaxNode, NodeConflict } from '../community/nodeConflicts.js';
import { getOverlayCommitStatus } from '../storage/overlayCommitScheduler.js';

type RawBodyReq = IncomingMessage & { __rawBody?: string };

// Pure path→POV-key helper used by node-conflicts. server.ts keeps its own copy
// (broadcastTaxonomyUpdate depends on it); trivially duplicated here rather than
// threaded through ctx or touching the broadcast path. Dedup candidate. (t/1295)
const TAXONOMY_POV_FILES = new Set(['accelerationist', 'safetyist', 'skeptic', 'cross-cutting', 'situations']);
function povKeyForPath(p: string): string | null {
  const base = p.split('/').pop() ?? p;
  if (!base.endsWith('.json')) return null;
  const key = base.slice(0, -'.json'.length);
  return TAXONOMY_POV_FILES.has(key) ? key : null;
}

/** Verify the GitHub webhook HMAC (X-Hub-Signature-256) against the shared secret.
 *  Constant-time compare; unequal buffer lengths fail fast (timingSafeEqual requires
 *  equal-length inputs). Preserves the original inline check exactly — valid iff the
 *  lengths match AND timingSafeEqual passes. */
function isValidWebhookSignature(raw: string, sigHeader: string, secret: string): boolean {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const sigBuf = Buffer.from(sigHeader);
  const expBuf = Buffer.from(expected);
  return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
}

/** On a PR merged into main, delete the matching `api-session/*` branch (best-effort;
 *  a failed delete is logged, never thrown). No-op for other actions/branches. */
function handleMergedPrBranchCleanup(
  parsed: Record<string, unknown>,
  sessionManager: ReturnType<ServerCtx['getSessionManager']>,
): void {
  const action = parsed.action;
  const pr = parsed.pull_request as { merged?: boolean; base?: { ref?: string }; head?: { ref?: string } } | undefined;
  if (action === 'closed' && pr?.merged === true && pr.base?.ref === 'main') {
    log.github.info('Webhook: PR merged into main');
    // Post-merge cleanup: delete the session branch if it was an api-session branch
    const headRef = pr.head?.ref ?? '';
    if (headRef.startsWith('api-session/') && sessionManager) {
      const branchUserId = headRef.slice('api-session/'.length);
      void branchUserId;
      // Find the user whose sanitized branch name matches
      const activeBranches = sessionManager.getActiveBranches();
      for (const entry of activeBranches) {
        if (entry.branch === headRef) {
          sessionManager.deleteBranch(entry.userId, 'pr-merged').catch(err => {
            log.github.error({ err, userId: entry.userId, branch: headRef }, 'Post-merge branch cleanup failed');
          });
          log.github.info({ userId: entry.userId, branch: headRef }, 'Post-merge: session branch cleanup triggered');
          break;
        }
      }
    }
  }
}

export function registerSyncRoutes(r: Router, ctx: ServerCtx): void {
  const { get, post } = r;

  post('/api/sync/credentials', async (_req, res, body) => {
    // t/847: runtime credentials are now per-user (scoped in githubAppAuth). In a
    // multi-user deployment, anonymous callers must not set them at all — only
    // single-user/filesystem mode (no auth front door) keeps the open behavior.
    if (STORAGE_MODE !== 'filesystem' && isAnonymousUser()) {
      error(res, 'Authentication required to set sync credentials', 401); return;
    }
    // t/2895: runtime per-user credential override is deprecated in hosted mode.
    // Clear is a no-op (success); set is rejected 409.
    if (STORAGE_MODE !== 'filesystem') {
      const data = body as { clear?: boolean };
      if (data.clear) { json(res, { ok: true, configured: false }); return; }
      error(res, 'Runtime per-user credential override is not supported in hosted mode. Repository access uses the GitHub App installation token configured at deployment time.', 409);
      return;
    }
    try {
      const data = body as { repo?: string; token?: string; clear?: boolean };
      if (data.clear) {
        clearRuntimeCredentials();
        json(res, { ok: true, configured: false });
        return;
      }
      const repo = typeof data.repo === 'string' ? data.repo.trim() : '';
      const token = typeof data.token === 'string' ? data.token.trim() : '';
      if (!repo || !repo.includes('/')) {
        error(res, 'repo must be in "owner/repo" format', 400);
        return;
      }
      if (!token) {
        error(res, 'token is required', 400);
        return;
      }
      setRuntimeCredentials(repo, token);
      // Validate by checking if credentials resolve
      const creds = await getCredentials();
      json(res, { ok: true, configured: !!creds });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'sync', level: 'error', message: 'sync request failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), 500, err);
    }
  });

  get('/api/sync/status', async (_req, res) => {
    const githubBackend = ctx.getGithubBackend();
    const sessionManager = ctx.getSessionManager();
    try {
      if (!githubBackend || !sessionManager) {
        json(res, { enabled: false, unsynced_count: 0, session_branch: null, pr_number: null, pr_url: null, push_pending: false, github_configured: false, main_updated_available: false, rebase_in_progress: false, overlay_commit: null });
        return;
      }
      const userId = getCurrentUserId();
      const branch = sessionManager.getActiveBranch(userId) ?? null;
      const state = sessionManager.getSessionState(userId);

      let unsyncedCount = 0;
      let behindBy = 0;
      let hasConflicts = false;
      if (branch) {
        const cmp = await githubBackend.compareBranches('main', branch);
        unsyncedCount = cmp.files.length;
        behindBy = cmp.behind_by;
        hasConflicts = cmp.status === 'diverged' && cmp.behind_by > 0;

        // t/4324: a session branch with no unique commits of its own (ahead_by === 0)
        // that's fallen behind main just carries stale data forever — nothing else
        // ever moves it. Lossless fast-forward: ahead_by === 0 means there's nothing
        // of the user's to lose, and cmp.merge_base_sha is exactly the branch's own
        // current head in that case (it has no commits main doesn't already have).
        if (cmp.ahead_by === 0 && behindBy > 0) {
          const oldSha = cmp.merge_base_sha;
          try {
            const mergeResult = await githubBackend.mergeBranch(branch);
            if (mergeResult.ok) {
              const newSha = mergeResult.sha || githubBackend.getMainSha();
              log.server.warn(
                { branch, oldSha, newSha, behindBy },
                'Auto-fast-forwarded stale session branch to main (t/4324)',
              );
              behindBy = 0;
              hasConflicts = false;
              unsyncedCount = 0;
            }
          } catch (ffErr) {
            getGlobalRecorder()?.record({
              type: 'system.error', component: 'sync', level: 'warn',
              message: `Auto-fast-forward of stale session branch ${branch} failed`,
              error: { name: (ffErr as Error).name ?? 'Error', message: String(ffErr), stack: (ffErr as Error).stack },
            });
          }
        }
      }

      // t/4258/t/4276 (C3 wiring): a write outside taxonomyDataSlice.save() (edges status/
      // swap/bulk, conflicts, cruxes evidence, policy-registry recount) schedules a debounced
      // overlay commit rather than awaiting one inline — surface its state here so the UI can
      // show "not yet saved to GitHub" instead of implying the write is already durable.
      const overlayCommit = getOverlayCommitStatus(userId) ?? null;

      const full = {
        enabled: true,
        mode: 'github-api' as const,
        unsynced_count: unsyncedCount,
        session_branch: branch,
        pr_number: state?.prNumber ?? null,
        pr_url: state?.prUrl ?? null,
        push_pending: false,
        github_configured: true,
        main_updated_available: behindBy > 0,
        rebase_in_progress: false,
        overlay_commit: overlayCommit,
        main_sha: githubBackend.getMainSha(),
        behind_by: behindBy,
        has_conflicts: hasConflicts,
        cache: {
          hit_rate: githubBackend.getCacheHitRate(),
          last_poll: new Date(Date.now() - githubBackend.getLastPollAge() * 1000).toISOString(),
          age_seconds: githubBackend.getLastPollAge(),
        },
      };
      // t/855: non-admins don't see the repo SHA or cache internals — the UI-
      // functional fields (counts, branch, PR, conflicts) are retained.
      if (community.isAdmin()) { json(res, full); return; }
      const { main_sha, cache, ...safe } = full;
      void main_sha; void cache;
      json(res, safe);
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'sync', level: 'error', message: 'sync request failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), 500, err);
    }
  });

  get('/api/sync/diagnostics', async (_req, res) => {
    const githubBackend = ctx.getGithubBackend();
    const sessionManager = ctx.getSessionManager();
    if (!requireAdmin(res)) return; // t/855: paths, repo SHAs, and credential status are admin-only
    try {
      if (!githubBackend || !sessionManager) {
        json(res, { git_sync_enabled: false, data_root: '', data_root_has_git: false, github_repo: null, github_credentials_valid: false, current_branch: null, head_sha: null, origin_main_sha: null, ahead_of_main: 0, behind_main: 0, active_taxonomy_dir: '', files: [], recent_commits: [] });
        return;
      }
      const userId = getCurrentUserId();
      const branch = sessionManager.getActiveBranch(userId);
      const divergence = branch ? await sessionManager.getDivergence(userId) : null;

      json(res, {
        git_sync_enabled: true,
        mode: 'github-api',
        data_root: CACHE_DIR,
        data_root_has_git: false,
        github_repo: null,
        github_credentials_valid: true,
        current_branch: branch ?? 'main',
        head_sha: githubBackend.getMainSha(),
        origin_main_sha: githubBackend.getMainSha(),
        ahead_of_main: divergence?.ahead_by ?? 0,
        behind_main: divergence?.behind_by ?? 0,
        active_taxonomy_dir: '',
        files: [],
        recent_commits: [],
        cache_hit_rate: githubBackend.getCacheHitRate(),
        cache_file_count: githubBackend.getCachedFileCount(),
        circuit_state: githubBackend.getCircuitState(),
        rate_limit_remaining: githubBackend.getRateLimitRemaining(),
        active_sessions: sessionManager.getActiveBranches(),
      });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'sync', level: 'error', message: 'sync request failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), 500, err);
    }
  });

  get('/api/sync/unsynced', async (_req, res) => {
    const githubBackend = ctx.getGithubBackend();
    const sessionManager = ctx.getSessionManager();
    try {
      if (!githubBackend || !sessionManager) { json(res, []); return; }
      const userId = getCurrentUserId();
      const branch = sessionManager.getActiveBranch(userId);
      if (!branch) { json(res, []); return; }

      const cmp = await githubBackend.compareBranches('main', branch);
      const statusMap: Record<string, string> = {
        added: 'A', removed: 'D', modified: 'M', renamed: 'R', changed: 'M',
      };
      json(res, cmp.files.map(f => ({
        path: f.filename,
        status: statusMap[f.status] || 'M',
      })));
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'sync', level: 'error', message: 'sync request failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), 500, err);
    }
  });

  get('/api/sync/diff', async (req, res) => {
    const githubBackend = ctx.getGithubBackend();
    const sessionManager = ctx.getSessionManager();
    const p = query(req, 'path');
    if (!p) { error(res, 'path query parameter is required', 400); return; }
    try {
      if (!githubBackend || !sessionManager) { json(res, { path: p, diff: '' }); return; }
      const userId = getCurrentUserId();
      const branch = sessionManager.getActiveBranch(userId);
      if (!branch) { json(res, { path: p, diff: '' }); return; }

      const cmp = await githubBackend.compareBranches('main', branch);
      const file = cmp.files.find(f => f.filename === p);
      json(res, { path: p, diff: file?.patch ?? '' });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'sync', level: 'warn', message: 'sync request rejected', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), 400, err);
    }
  });

  get('/api/sync/node-diff', async (_req, res) => {
    const githubBackend = ctx.getGithubBackend();
    const sessionManager = ctx.getSessionManager();
    const disabled = { enabled: false, session_branch: null, files: [], totals: { added: 0, modified: 0, removed: 0 } };
    try {
      if (!githubBackend || !sessionManager) { json(res, disabled); return; }
      const userId = getCurrentUserId();
      const branch = sessionManager.getActiveBranch(userId);
      if (!branch) { json(res, disabled); return; }

      const cmp = await githubBackend.compareBranches('main', branch);
      const nodeFiles = cmp.files.filter(f => f.filename.endsWith('.json') && /\/(accelerationist|safetyist|skeptic|situations|cross-cutting)\.json$/.test(f.filename));

      const totals = { added: 0, modified: 0, removed: 0 };
      const files: Array<{ path: string; added: Array<{ id: string; label?: string }>; removed: Array<{ id: string; label?: string }>; modified: Array<{ id: string; label?: string; fields?: Array<{ field: string; old: unknown; new: unknown }> }> }> = [];

      for (const nf of nodeFiles) {
        const [mainRaw, branchRaw] = await Promise.all([
          githubBackend.readFileAtRef(nf.filename, 'main'),
          githubBackend.readFileAtRef(nf.filename, branch),
        ]);

        const mainNodes: Array<{ id: string; label?: string; [k: string]: unknown }> = mainRaw ? (JSON.parse(mainRaw.replace(/^﻿/, '')).nodes ?? []) : [];
        const branchNodes: Array<{ id: string; label?: string; [k: string]: unknown }> = branchRaw ? (JSON.parse(branchRaw.replace(/^﻿/, '')).nodes ?? []) : [];

        const diff = diffNodes(mainNodes, branchNodes);
        if (diff.added.length === 0 && diff.modified.length === 0 && diff.deleted.length === 0) continue;

        const mainMap = new Map(mainNodes.map(n => [n.id, n]));
        const branchMap = new Map(branchNodes.map(n => [n.id, n]));

        const added = diff.added.map(id => ({ id, label: branchMap.get(id)?.label }));
        const removed = diff.deleted.map(id => ({ id, label: mainMap.get(id)?.label }));
        const modified = diff.modified.map(id => {
          const oldNode = mainMap.get(id)!;
          const newNode = branchMap.get(id)!;
          const fields = changedFields(oldNode, newNode).map(field => ({
            field,
            old: oldNode[field],
            new: newNode[field],
          }));
          return { id, label: newNode.label ?? oldNode.label, fields };
        });

        totals.added += added.length;
        totals.modified += modified.length;
        totals.removed += removed.length;
        files.push({ path: nf.filename, added, removed, modified });
      }

      json(res, { enabled: true, session_branch: branch, files, totals });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'sync', level: 'error', message: 'sync request failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), 500, err);
    }
  });

  // Phase 5D (t/654): nodes edited on the user's session branch that were ALSO
  // changed on main since the branch diverged — the "both-edited" conflict set.
  // Three-way: merge-base→branch (your changes) ∩ merge-base→main (their changes).
  // Informational only; never throws into the save path (returns a disabled shape).
  get('/api/sync/node-conflicts', async (_req, res) => {
    const githubBackend = ctx.getGithubBackend();
    const sessionManager = ctx.getSessionManager();
    const disabled = { enabled: false, session_branch: null, behind_by: 0, conflicts: [] };
    try {
      if (!githubBackend || !sessionManager) { json(res, disabled); return; }
      const userId = getCurrentUserId();
      const branch = sessionManager.getActiveBranch(userId);
      if (!branch) { json(res, disabled); return; }

      // base...head with three dots diffs head against merge-base(base, head):
      //  - compare('main', branch) → files changed on branch since merge-base (yours)
      //  - compare(branch, 'main') → files changed on main since merge-base (theirs)
      const [yourCmp, theirCmp] = await Promise.all([
        githubBackend.compareBranches('main', branch),
        githubBackend.compareBranches(branch, 'main'),
      ]);
      const baseSha = yourCmp.merge_base_sha;
      const behindBy = yourCmp.behind_by;

      const POV_RE = /\/(accelerationist|safetyist|skeptic|situations|cross-cutting)\.json$/;
      const candidateFiles = new Set<string>();
      for (const f of [...yourCmp.files, ...theirCmp.files]) {
        if (f.filename.endsWith('.json') && POV_RE.test(f.filename)) candidateFiles.add(f.filename);
      }

      const parseNodes = (raw: string | null): TaxNode[] =>
        raw ? ((JSON.parse(raw.replace(/^﻿/, '')) as { nodes?: TaxNode[] }).nodes ?? []) : [];

      const conflicts: NodeConflict[] = [];
      for (const filename of candidateFiles) {
        const [baseRaw, mainRaw, branchRaw] = await Promise.all([
          baseSha ? githubBackend.readFileAtRef(filename, baseSha) : Promise.resolve(null),
          githubBackend.readFileAtRef(filename, 'main'),
          githubBackend.readFileAtRef(filename, branch),
        ]);
        conflicts.push(...computeNodeConflicts(
          parseNodes(baseRaw),
          parseNodes(mainRaw),
          parseNodes(branchRaw),
          povKeyForPath(filename) ?? '',
        ));
      }

      json(res, { enabled: true, session_branch: branch, behind_by: behindBy, conflicts });
    } catch (err) {
      // Record but degrade gracefully — this is informational and must never break the UI.
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'warn',
        message: 'node-conflicts detection failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      json(res, disabled);
    }
  });

  post('/api/sync/discard', async (_req, res, body) => {
    const githubBackend = ctx.getGithubBackend();
    const sessionManager = ctx.getSessionManager();
    const { all } = (body || {}) as { path?: string; all?: boolean };
    try {
      if (!githubBackend || !sessionManager) { error(res, 'Storage backend not initialized', 503); return; }
      const userId = getCurrentUserId();
      if (all) {
        await sessionManager.deleteBranch(userId, 'manual');
        // ALS context for this request still has the old branch, but the branch
        // is now deleted. Future requests will get branchName=undefined from
        // sessionManager.getActiveBranch() → reads fall back to main.
        json(res, { ok: true, scope: 'all' });
        return;
      }
      error(res, 'Per-file discard is not supported. Use "Discard All" to reset.', 400);
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'sync', level: 'warn', message: 'sync request rejected', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), 400, err);
    }
  });

  post('/api/sync/commit', async (_req, res, body) => {
    const githubBackend = ctx.getGithubBackend();
    try {
      if (!githubBackend) {
        // Filesystem mode — writes go directly to disk, commit is a no-op
        json(res, { ok: true, commitSha: null, filesCommitted: 0, mode: 'filesystem' });
        return;
      }
      const userId = getCurrentUserId();
      const { message } = (body || {}) as { message?: string };
      // Capture pending entries before commitOverlay() clears them — needed for the
      // taxonomy-updated broadcast below (t/652).
      const pending = githubBackend.getOverlayEntries(userId);
      const result = await githubBackend.commitOverlay(userId, message);
      if (!result) {
        json(res, { ok: true, commitSha: null, filesCommitted: 0, message: 'No pending changes' });
        return;
      }
      // t/4312 (SO condition F5, e/333#4): a conflict is a normal return, not
      // a throw — filesCommitted is 0 and the edit is still staged, never
      // committed. Reporting ok:true here would show the user a successful
      // save while nothing actually landed; unlike the pre-t/4312 silent
      // overwrite (at least recoverable from git history), a restart then
      // loses the edit unrecoverably. This 409 applies regardless of
      // OVERLAY_CONFLICT_STATE_ENABLED — it's not gated on the resolution
      // UI being ready, only on never reporting a false success.
      if (result.conflictedPaths?.length) {
        error(res, 'Save conflicted — see conflictedPaths', 409, undefined, { code: 'OVERLAY_CONFLICT', conflictedPaths: result.conflictedPaths });
        return;
      }
      json(res, { ok: true, commitSha: result.commitSha, filesCommitted: result.filesCommitted });
      // Phase 5F: best-effort notify other web clients. Response is already sent;
      // broadcastTaxonomyUpdate never throws, so the save result is unaffected (t/652).
      await ctx.broadcastTaxonomyUpdate(githubBackend, pending, userId);
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'sync', level: 'error', message: 'sync request failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), 500, err);
    }
  });

  post('/api/sync/create-pr', async (_req, res, body) => {
    const githubBackend = ctx.getGithubBackend();
    const sessionManager = ctx.getSessionManager();
    const { title, body: prBody } = (body || {}) as { title?: string; body?: string };
    try {
      if (!githubBackend || !sessionManager) {
        error(res, 'GitHub API backend not configured', 503);
        return;
      }
      const userId = getCurrentUserId();
      const branch = sessionManager.getActiveBranch(userId);
      if (!branch) {
        error(res, 'No session branch — make edits first', 400);
        return;
      }
      const pr = await sessionManager.createPR(userId, title, prBody);
      json(res, {
        ok: true,
        number: pr.number,
        url: pr.url,
        branch,
        created: true,
      });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'sync', level: 'error', message: 'sync request failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), 500, err);
    }
  });

  post('/api/sync/resync', async (_req, res, body) => {
    const githubBackend = ctx.getGithubBackend();
    const sessionManager = ctx.getSessionManager();
    const { mode } = (body || {}) as { mode?: 'rebase' | 'fetch-only' | 'reset-main' };
    if (mode !== 'rebase' && mode !== 'fetch-only' && mode !== 'reset-main') {
      error(res, 'mode must be "rebase", "fetch-only", or "reset-main"', 400);
      return;
    }
    try {
      if (!githubBackend || !sessionManager) {
        error(res, 'GitHub API backend not configured', 503);
        return;
      }
      const userId = getCurrentUserId();
      const branch = sessionManager.getActiveBranch(userId);

      if (mode === 'reset-main') {
        // Delete session branch → fresh start from main
        if (branch) await sessionManager.deleteBranch(userId, 'manual');
        json(res, {
          ok: true, mode: 'reset-main', session_ahead: 0,
          main_sha: githubBackend.getMainSha(),
          conflicts: false, message: 'Session reset to main',
        });
        return;
      }

      if (!branch) {
        // No session branch — nothing to resync
        json(res, {
          ok: true, mode, session_ahead: 0,
          main_sha: githubBackend.getMainSha(),
          conflicts: false, message: 'No session branch to resync',
        });
        return;
      }

      // 'rebase' and 'fetch-only' both merge main into session branch in API mode
      const mergeResult = await githubBackend.mergeBranch(branch);
      const cmp = mergeResult.ok
        ? await githubBackend.compareBranches('main', branch)
        : { ahead_by: 0 };

      json(res, {
        ok: true, mode,
        session_ahead: cmp.ahead_by,
        main_sha: githubBackend.getMainSha(),
        conflicts: mergeResult.conflicts,
        conflict_files: mergeResult.conflicts ? [] : undefined,
        message: mergeResult.message,
      });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'sync', level: 'error', message: 'sync request failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), 500, err);
    }
  });

  // ── Phase 4: interactive rebase conflict resolution ──
  //
  // When resync('rebase') hits merge conflicts we leave the rebase paused. These
  // endpoints let the UI walk the user through resolving each conflicted file
  // and then continue (or abort) the rebase.

  get('/api/sync/rebase-state', async (_req, res) => {
    // Interactive rebase is not available in API mode — conflicts resolve on GitHub
    json(res, { in_progress: false, conflict_files: [], onto_branch: null });
  });

  get('/api/sync/rebase-file', async (_req, res) => {
    error(res, 'Interactive rebase is not available in API mode — resolve conflicts on GitHub', 400);
  });

  post('/api/sync/rebase/resolve', async (_req, res) => {
    error(res, 'Interactive rebase is not available in API mode — resolve conflicts on GitHub', 400);
  });

  post('/api/sync/rebase/continue', async (_req, res) => {
    error(res, 'Interactive rebase is not available in API mode — resolve conflicts on GitHub', 400);
  });

  post('/api/sync/rebase/abort', async (_req, res) => {
    error(res, 'Interactive rebase is not available in API mode — resolve conflicts on GitHub', 400);
  });

  // Phase-3 webhook: GitHub posts pull_request / ping events here. We verify the
  // X-Hub-Signature-256 HMAC against GITHUB_WEBHOOK_SECRET, then — for a merged
  // PR — flip the "upstream moved" flag so the UI banners a Resync prompt.
  // All responses are 2xx once the signature is valid: GitHub interprets 4xx/5xx
  // as delivery failures and retries, which would spam the logs.
  post('/api/sync/webhook/github', async (req, res, _body) => {
    const sessionManager = ctx.getSessionManager();
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      // The endpoint is dormant when no secret is configured. Respond 404 so a
      // probing attacker can't distinguish "disabled" from "route missing".
      error(res, 'Not found', 404);
      return;
    }

    const raw = (req as RawBodyReq).__rawBody ?? '';
    const sigHeader = (req.headers['x-hub-signature-256'] as string | undefined) ?? '';
    if (!isValidWebhookSignature(raw, sigHeader, secret)) {
      error(res, 'Invalid signature', 401);
      return;
    }

    const event = (req.headers['x-github-event'] as string | undefined) ?? '';
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'github-webhook', level: 'warn',
        message: 'GitHub webhook payload is not valid JSON', data: { event },
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }

    if (event === 'ping') {
      json(res, { ok: true, pong: true });
      return;
    }

    if (event === 'pull_request') handleMergedPrBranchCleanup(parsed, sessionManager);

    // Acknowledge everything else so GitHub doesn't retry.
    json(res, { ok: true });
  });
}
