// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Checks the ai-triad-data git repo for available updates.
 * Only runs if connected to the internet and the data repo is a git repo.
 */

import { execFile } from 'child_process';
import { resolveDataPath } from './fileIO.js';
import fs from 'fs';
import path from 'path';
import { net } from 'electron';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';

export interface DataUpdateStatus {
  available: boolean;
  behindCount: number;
  aheadCount: number;
  diverged: boolean;
  currentCommit: string;
  remoteCommit: string;
  error?: string;
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

/** Like runGit but also returns stderr (git reports some non-fatal failures there while exiting 0). */
function runGitWithStderr(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function isOnline(): Promise<boolean> {
  try {
    const resp = await net.fetch('https://github.com', { method: 'HEAD' });
    return resp.ok || resp.status === 301 || resp.status === 302;
  } catch {
    /* telemetry — silent by design; returning false is the correct offline signal — caller surfaces { error: 'offline' } to the UI */
    return false;
  }
}

/**
 * In-flight check, shared by concurrent callers (t/576). Two overlapping
 * `git fetch origin` runs in the same repo race for the same ref lock
 * ("cannot lock ref 'refs/remotes/origin/...'"), so a call that arrives
 * while a check is running joins it instead of starting a second fetch.
 * Cleared once it settles, so the next call checks afresh.
 */
let inFlight: Promise<DataUpdateStatus> | null = null;

export function checkForDataUpdates(): Promise<DataUpdateStatus> {
  if (inFlight) return inFlight;
  const run = runDataUpdateCheck().finally(() => {
    if (inFlight === run) inFlight = null;
  });
  inFlight = run;
  return run;
}

async function runDataUpdateCheck(): Promise<DataUpdateStatus> {
  const dataRoot = resolveDataPath('.');
  const gitDir = path.join(dataRoot, '.git');

  const empty: DataUpdateStatus = { available: false, behindCount: 0, aheadCount: 0, diverged: false, currentCommit: '', remoteCommit: '' };

  // Not a git repo — nothing to check
  if (!fs.existsSync(gitDir)) {
    return { ...empty, error: 'Data directory is not a git repo' };
  }

  // Check connectivity
  const online = await isOnline();
  if (!online) {
    return { ...empty, error: 'offline' };
  }

  try {
    // Fetch latest from remote without merging
    await runGit(['fetch', 'origin', '--quiet'], dataRoot);

    // Get current and remote HEAD
    const currentCommit = await runGit(['rev-parse', 'HEAD'], dataRoot);
    const remoteCommit = await runGit(['rev-parse', 'origin/main'], dataRoot);

    if (currentCommit === remoteCommit) {
      return { ...empty, currentCommit, remoteCommit };
    }

    // Count commits ahead and behind using left-right rev-list
    const lrOutput = await runGit(['rev-list', '--left-right', '--count', 'HEAD...origin/main'], dataRoot);
    const [aheadStr, behindStr] = lrOutput.split(/\s+/);
    const aheadCount = parseInt(aheadStr, 10) || 0;
    const behindCount = parseInt(behindStr, 10) || 0;
    const diverged = aheadCount > 0 && behindCount > 0;

    return { available: behindCount > 0, behindCount, aheadCount, diverged, currentCommit, remoteCommit };
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'data-update-checker',
      level: 'error',
      message: 'Operation failed',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[DataUpdateChecker] Error:', msg);
    return { ...empty, error: msg };
  }
}

export interface ChangedFileInfo {
  path: string;
  status: string; // 'M' | 'A' | 'D' | 'R' etc.
}

const IGNORED_PATH_PREFIXES = ['flight-recorder/', 'server-flight-recorder-'];

export async function getChangedFiles(): Promise<ChangedFileInfo[]> {
  const dataRoot = resolveDataPath('.');
  try {
    // Use merge-base for accurate diff when repos have diverged
    const mergeBase = await runGit(['merge-base', 'HEAD', 'origin/main'], dataRoot);
    const output = await runGit(['diff', '--name-status', `${mergeBase}..origin/main`], dataRoot);
    if (!output) return [];
    return output.split('\n').filter(Boolean).map(line => {
      const [status, ...pathParts] = line.split('\t');
      return { path: pathParts.join('\t'), status: status.charAt(0) };
    }).filter(f => !IGNORED_PATH_PREFIXES.some(p => f.path.startsWith(p)));
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'data-update-checker',
      level: 'warn',
      message: 'getChangedFiles: git diff failed — returning empty file list (UI will show no pending changes)',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return [];
  }
}

export async function getFileDiff(filePath: string): Promise<string> {
  const dataRoot = resolveDataPath('.');
  const safePath = filePath.replace(/[^\w./ -]/g, '');
  return runGit(['diff', 'HEAD..origin/main', '--', safePath], dataRoot);
}

export async function pullDataUpdates(): Promise<{ success: boolean; message: string }> {
  const dataRoot = resolveDataPath('.');
  try {
    // Clear stale lock file left by a crashed git process
    const lockPath = path.join(dataRoot, '.git', 'index.lock');
    try {
      const st = fs.statSync(lockPath);
      if (Date.now() - st.mtimeMs > 5 * 60 * 1000) {
        fs.unlinkSync(lockPath);
        console.log('[DataUpdateChecker] Removed stale index.lock');
      }
    } catch { /* telemetry — silent by design;  doesn't exist — normal */ }

    // t/682 (t/651): never commit local changes. The old `git add -A` + electron-auto commit
    // swept user content (debates, chats, op-eds, feedback, analytics) into the public data
    // repo's history. Now tracked edits are stashed around the pull (--autostash) and put back,
    // and untracked files are never staged at all; git leaves them in place. If an incoming
    // file would overwrite an untracked one, the pull refuses and we report that, losing nothing.
    const status = await runGit(['status', '--porcelain'], dataRoot);
    const lines = status ? status.split('\n').filter(Boolean) : [];
    const untracked = lines.filter(l => l.startsWith('??')).length;
    const trackedChanged = lines.length - untracked;
    if (lines.length > 0) {
      console.warn(`[DataUpdateChecker] WARN pull with a dirty data root: ${untracked} untracked file(s) left unstaged and uncommitted; ${trackedChanged} tracked change(s) stashed around the pull and restored (t/682)`);
    }

    const { stdout: output, stderr } = await runGitWithStderr(['pull', '--rebase', '--autostash', 'origin', 'main'], dataRoot);

    // `git pull --rebase --autostash` exits 0 when the pull works but restoring the stash
    // conflicts; the only signal is a stderr line and unmerged paths. Report failure so the
    // renderer does not reload a data root with conflict markers (t/682, SO risk on #5581).
    const unmerged = (await runGit(['diff', '--name-only', '--diff-filter=U'], dataRoot)).split('\n').filter(Boolean);
    if (unmerged.length > 0 || /Applying autostash resulted in conflicts/i.test(stderr)) {
      console.warn(`[DataUpdateChecker] WARN autostash restore conflicted after pull: ${unmerged.length} unmerged file(s); local edits kept in stash@{0} (t/682)`);
      const files = unmerged.length > 0 ? ` Conflicted: ${unmerged.join(', ')}.` : '';
      return {
        success: false,
        message: `Update downloaded, but your local edits conflict with it.${files} Your edits are saved in the git stash (stash@{0}, see \`git stash list\`). Resolve the conflicts before reloading.`,
      };
    }
    return { success: true, message: output || 'Up to date' };
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'data-update-checker',
      level: 'error',
      message: 'Operation failed',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: msg };
  }
}
