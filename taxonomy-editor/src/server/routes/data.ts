// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/1687 (Phase 2 server.ts split, ADR-007): the data-management / AI-models
// route run, moved verbatim out of server.ts behind the registration seam. This
// run sits between registerAdminRoutes and registerKeysRoutes, so registration
// order — and the routeTable snapshot — is preserved by placing
// registerDataRoutes() at its former position. serverRecorder is threaded
// through ctx (data-pull lifecycle events); handlers otherwise depend on imports.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { getDataRoot, STORAGE_MODE, isStagingIdentity, isLocalDeployment } from '../config.js';
import { getConfig } from '../runtimeConfig.js';
import { isPathWithinDir } from '../security/accessControl.js';
import { requireAdmin } from '../community/admin/reviewRegistry.js';
import { log } from '../logger.js';
import * as fileIO from '../storage/fileIO.js';
import * as ai from '../ai/aiBackends.js';
import { refreshModelsRequestSchema } from '../ai/refreshModelsRequestSchema.js';

/** Converts a git SSH remote URL to HTTPS. Non-SSH URLs are returned unchanged. */
export function convertSshToHttps(remoteUrl: string): string {
  if (!remoteUrl.startsWith('git@github.com:')) return remoteUrl;
  return remoteUrl.replace('git@github.com:', 'https://github.com/');
}

export function registerDataRoutes(r: Router, ctx: ServerCtx): void {
  const { get, post } = r;
  const { serverRecorder } = ctx;

  get('/api/data/root', (_req, res) => {
    if (!requireAdmin(res)) return; // t/855: the data-root filesystem path is admin-only
    json(res, fileIO.getDataRootPath());
  });

  post('/api/data/set-root', (_req, res, body) => {
    if (!requireAdmin(res)) return; // L2 (t/720): mutating the data root is admin-only
    const { newRoot } = body as { newRoot: string };
    try {
      if (!fs.existsSync(newRoot)) {
        json(res, { success: false, message: `Directory does not exist: ${newRoot}` }, 400);
        return;
      }
      process.env.AI_TRIAD_DATA_ROOT = path.resolve(newRoot);
      json(res, { success: true });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      json(res, { success: false, message: String(err) }, 500);
    }
  });


  post('/api/data/clone', async (_req, res, body) => {
    if (!requireAdmin(res)) return; // L3 (t/720): cloning is admin-only
    const { targetPath } = body as { targetPath: string };
    try {
      // L3 (t/720): confine the clone target to the configured data directory.
      // Without this an (admin) caller could write the repo to any filesystem path.
      if (!isPathWithinDir(targetPath, getDataRoot())) {
        json(res, { success: false, message: 'targetPath must be within the configured data directory.' }, 400);
        return;
      }
      // Clone to temp dir first, then copy contents — avoids permission issues
      // when targetPath is root-owned (e.g. /data in Azure containers).
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-clone-'));
      await new Promise<void>((resolve, reject) => {
        execFile('git', ['clone', 'https://github.com/AI-Rosetta-Stone/ai-triad-data.git', tmpDir], { timeout: getConfig().server.gitCloneTimeoutMs, windowsHide: true }, (err) => {
          if (err) reject(err); else resolve();
        });
      });
      const entries = fs.readdirSync(tmpDir).filter(f => f !== '.git');
      fs.mkdirSync(targetPath, { recursive: true });
      await new Promise<void>((resolve, reject) => {
        execFile('cp', ['-a', ...entries.map(f => path.join(tmpDir, f)), targetPath], { windowsHide: true }, (err) => {
          if (err) reject(err); else resolve();
        });
      });
      fs.rmSync(tmpDir, { recursive: true, force: true });
      json(res, { success: true, message: 'Data repository cloned successfully.' });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      json(res, { success: false, message: String(err) });
    }
  });

  post('/api/data/check-updates', async (_req, res) => {
    if (!requireAdmin(res)) return; // t/2645: git fetch mutates the shared data root's .git — admin-only, mirroring set-root/clone
    if (STORAGE_MODE === 'github-api') {
      // t/2649: on github-api the GitHub API is authoritative and the /mnt/shared git cache is
      // vestigial. Running git here only trips dubious-ownership on the Azure Files mount, whose
      // swallowed error returned a false-healthy 200 (~every 30s). Skip with an honest response.
      json(res, { available: false, reason: 'github-api mode: git sync disabled (GitHub API is the source of truth)' });
      return;
    }
    try {
      const dataRoot = getDataRoot();
      const gitDir = path.join(dataRoot, '.git');
      if (!fs.existsSync(gitDir)) { json(res, { available: false, error: 'Not a git repo' }); return; }

      const runGit = (args: string[]): Promise<string> => new Promise((resolve, reject) => {
        execFile('git', args, { cwd: dataRoot, timeout: 15_000, windowsHide: true }, (err, stdout) => {
          if (err) reject(err); else resolve(stdout.trim());
        });
      });

      await runGit(['fetch', 'origin', '--quiet']);
      const local = await runGit(['rev-parse', 'HEAD']);
      const remote = await runGit(['rev-parse', 'origin/main']);

      if (local === remote) {
        json(res, { available: false, behindCount: 0, aheadCount: 0, diverged: false, currentCommit: local, remoteCommit: remote });
        return;
      }

      const lrOutput = await runGit(['rev-list', '--left-right', '--count', 'HEAD...origin/main']);
      const [aheadStr, behindStr] = lrOutput.split(/\s+/);
      const aheadCount = parseInt(aheadStr, 10) || 0;
      const behindCount = parseInt(behindStr, 10) || 0;
      const diverged = aheadCount > 0 && behindCount > 0;

      json(res, { available: behindCount > 0, behindCount, aheadCount, diverged, currentCommit: local, remoteCommit: remote });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Operation failed',
        // t/2653: name the endpoint + git command + data root so the FR event is self-diagnosable
        // without grepping the source (this only fires in filesystem mode — github-api skips git).
        data: { endpoint: '/api/data/check-updates', command: 'git fetch', dataRoot: getDataRoot() },
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      json(res, { available: false, error: String(err) });
    }
  });

  post('/api/data/pull', async (_req, res) => {
    // t/2645: a data-pull runs `git reset --hard` + `clean -fd` on the shared data worktree —
    // a destructive admin operation. Gate it like its siblings set-root (:43)/clone (:66); it was
    // the one data route left ungated. requireAdmin limits WHO; the data-repo .gitignore covering
    // admin/ is the actual data-loss fix (an admin pull still clean -fd's untracked class-A files).
    if (!requireAdmin(res)) return;
    if (STORAGE_MODE === 'github-api') {
      // t/2649: git pull is vestigial AND destructive (reset --hard + clean -fd on the shared
      // /mnt/shared worktree) in github-api mode — the GitHub API is the persistence layer. Skip
      // it entirely: this removes the worktree-mutation hazard in prod and moots dubious-ownership.
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Data pull skipped: github-api mode uses the GitHub API as the source of truth (no local git sync).\n');
      return;
    }
    // t/2643: even in filesystem mode, refuse a data-pull on staging — reset --hard + clean -fd on
    // the worktree at getDataRoot() (= /mnt/shared, prod's SHARED tree) would mutate prod's data.
    // Closes the git-worktree staging→prod hazard before DevOps flips the mount RO (the backstop).
    if (isStagingIdentity()) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Data pull is disabled on staging: the shared data worktree is read-only there (t/2643).\n');
      return;
    }

    // Stream heartbeats to prevent Azure Container Apps' Envoy proxy from
    // returning 504 "stream timeout" during long-running git operations.
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });

    const heartbeat = setInterval(() => { res.write('\n'); }, 15_000);
    const progress = (msg: string) => { res.write(`progress: ${msg}\n`); };
    const pullStart = Date.now();

    try {
      const dataRoot = getDataRoot();
      const runGit = (args: string[], timeoutMs = getConfig().server.gitDefaultTimeoutMs): Promise<string> => new Promise((resolve, reject) => {
        execFile('git', args, { cwd: dataRoot, timeout: timeoutMs, maxBuffer: getConfig().server.gitBufferLimitBytes, windowsHide: true }, (err, stdout, stderr) => {
          if (err) {
            log.dataPull.error({ cmd: `git ${args.join(' ')}`, stderr: stderr?.trim() }, err.message);
            reject(new Error(`git ${args[0]}: ${err.message}${stderr ? ' — ' + stderr.trim() : ''}`));
          } else {
            if (stderr) log.dataPull.debug({ cmd: `git ${args[0]}`, stderr: stderr.trim() }, 'git stderr');
            resolve(stdout.trim());
          }
        });
      });

      serverRecorder.record({ type: 'lifecycle', component: 'data-pull', level: 'info', message: 'pull.start', data: { dataRoot } });
      log.dataPull.info({ dataRoot }, 'Starting pull');
      progress('Starting data update...');

      // Fix: Strip stale tokens from origin URL to avoid 401 on expired GitHub App tokens.
      // Public repos work fine with plain HTTPS; embedded tokens cause auth failures when expired.
      let remoteUrl = await runGit(['remote', 'get-url', 'origin']);
      log.dataPull.info({ remoteUrl: remoteUrl.replace(/:\/\/[^@]+@/, '://<redacted>@') }, 'Remote URL');

      if (remoteUrl.includes('x-access-token:')) {
        const cleanUrl = remoteUrl.replace(/:\/\/x-access-token:[^@]+@/, '://');
        log.dataPull.info('Stripping stale token from origin URL');
        await runGit(['remote', 'set-url', 'origin', cleanUrl]);
        remoteUrl = cleanUrl;
      }

      // If remote is SSH, convert to HTTPS for public repo access without keys
      if (remoteUrl.startsWith('git@github.com:')) {
        const httpsUrl = convertSshToHttps(remoteUrl);
        log.dataPull.info({ httpsUrl }, 'Converting SSH remote to HTTPS');
        await runGit(['remote', 'set-url', 'origin', httpsUrl]);
      }

      // Ensure we're on main before resetting — avoid clobbering a session branch
      const currentBranch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'unknown');
      if (currentBranch !== 'main') {
        log.dataPull.info({ branch: currentBranch }, 'Switching to main before pull');
        await runGit(['checkout', 'main']);
      }

      // Discard any local changes — web deployment treats data as read-only
      await runGit(['checkout', '--', '.']).catch(() => { /* no tracked changes */ });
      await runGit(['clean', '-fd']).catch(() => { /* no untracked files */ });

      progress('Fetching updates from GitHub...');
      serverRecorder.record({ type: 'lifecycle', component: 'data-pull', level: 'info', message: 'pull.fetch_start' });
      log.dataPull.info('Fetching origin');
      const fetchStart = Date.now();
      await runGit(['fetch', 'origin'], getConfig().server.gitFetchTimeoutMs);
      serverRecorder.record({ type: 'lifecycle', component: 'data-pull', level: 'info', message: 'pull.fetch_ok', duration_ms: Date.now() - fetchStart });

      progress('Applying updates...');
      serverRecorder.record({ type: 'lifecycle', component: 'data-pull', level: 'info', message: 'pull.reset_start' });
      log.dataPull.info('Resetting to origin/main');
      const resetStart = Date.now();
      await runGit(['reset', '--hard', 'origin/main'], getConfig().server.gitFetchTimeoutMs);
      serverRecorder.record({ type: 'lifecycle', component: 'data-pull', level: 'info', message: 'pull.reset_ok', duration_ms: Date.now() - resetStart });

      log.dataPull.info('Pull completed successfully');
      serverRecorder.record({ type: 'lifecycle', component: 'data-pull', level: 'info', message: 'pull.ok', duration_ms: Date.now() - pullStart });
      res.write(JSON.stringify({ success: true, message: 'Data updated.' }) + '\n');
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      const msg = err instanceof Error ? err.message : String(err);
      log.dataPull.error({ err: msg }, 'Pull failed');
      serverRecorder.record({ type: 'system.error', component: 'data-pull', level: 'error', message: 'pull.failed', error: { name: 'Error', message: msg, stack: (err as Error).stack }, duration_ms: Date.now() - pullStart });
      res.write(JSON.stringify({ success: false, message: msg }) + '\n');
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  });

  // ── AI models & keys ──

  get('/api/models', async (_req, res) => {
    json(res, await fileIO.loadAIModels());
  });

  // t/4162 Part 1 (T1; TL p/522#398): anon-blocked globally (accessControl.ts `isAnonBlockedRoute`).
  // A plain/dryRun call runs for any signed-in caller (read-only — ai.refreshAIModels coerces a
  // non-dryRun call without `accept` to dryRun for every principal, same shape as #3329).
  // Part 2 (T2/SO, this ticket): `accept` (the actual write path) requires admin. `principal` is
  // always host-set from getCurrentUserId() inside ai.refreshAIModels (t/4162#1/#3 C3) — never
  // client text — so gating here is sufficient; nothing downstream trusts a client-supplied identity.
  //
  // SO finding (e/334#2), TL ruling (A1, p/522#430): on hosted, `refreshAIModels` writes
  // `getProjectRoot()`'s container-local `ai-models.json` — that copy and its t/4160 sign-off
  // vanish on the next restart/deploy/scale-to-zero, and the repo's actual source of truth
  // (read by PowerShell, Electron, gated by `verify:config`) never changes. Refuse `accept` on
  // hosted before it ever reaches ai.refreshAIModels; dry-run/proposal viewing stays unaffected.
  // SO follow-up (e/334#4): STORAGE_MODE alone fails OPEN during the prod rollback runbook
  // (STORAGE_MODE=filesystem on hosted prod, t/4229's exact trap) — isLocalDeployment() pins
  // "accept allowed" to genuine desktop/local-server use via NODE_ENV, not just the mode.
  post('/api/models/refresh', async (_req, res, body) => {
    const parsed = refreshModelsRequestSchema.safeParse(body ?? {});
    if (!parsed.success) { error(res, 'Invalid refresh request: ' + parsed.error.message, 400); return; }
    if (parsed.data.accept) {
      if (!requireAdmin(res)) return;
      if (!isLocalDeployment()) {
        const notDurable = new ActionableError({
          goal: 'Apply a reviewed AI model-catalog change',
          problem: 'Hosted accept would write a container-local copy of ai-models.json — the change and its sign-off vanish on the next restart, deploy or scale-to-zero, and the repo\'s source of truth (PowerShell, Electron, verify:config) never changes.',
          location: 'server/routes/data.ts → POST /api/models/refresh (accept)',
          nextSteps: ['Apply this change from the desktop app instead', 'Or open a PR updating ai-models.json directly'],
        });
        log.server.warn({ component: 'models-refresh' }, 'accept refused on hosted — not durable (t/4234 A1)');
        getGlobalRecorder()?.record({ type: 'system.error', component: 'models-refresh', level: 'warn', message: notDurable.message, error: { name: notDurable.name, message: notDurable.message, stack: notDurable.stack } });
        error(res, String(notDurable), 409, notDurable, { code: 'ACCEPT_NOT_DURABLE_ON_HOSTED' });
        return;
      }
    }
    try {
      json(res, await ai.refreshAIModels(parsed.data));
    } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to refresh AI models', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), 500, err); }
  });
}
