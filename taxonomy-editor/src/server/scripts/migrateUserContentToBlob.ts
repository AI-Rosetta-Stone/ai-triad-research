// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * One-time migration: copy user content from the GitHub data repo to Azure Blob
 * Storage (t/699, epic t/695).
 *
 * Migrates (relative paths preserved so the runtime AzureBlobBackend reads them
 * back unchanged — container routing is the only transform):
 *   - users/{userId}/chats/*.json     → user-content container
 *   - users/{userId}/debates/*.json   → user-content container
 *   - community/chats/*.json          → community container
 *   - community/debates/*.json        → community container
 *   - community/_submissions/*.json   → community container
 *
 * Reuses the existing GitHubAPIBackend (read, authed + rate-limited) and
 * AzureBlobBackend (write) rather than @octokit/rest, so blob names are
 * guaranteed identical to what the running server reads. Idempotent (upload
 * overwrites); re-run safe. Run after `npm run build:server`:
 *
 *   AZURE_STORAGE_ACCOUNT_URL=https://<acct>.blob.core.windows.net \
 *   node dist/server/taxonomy-editor/src/server/scripts/migrateUserContentToBlob.js
 */

import crypto from 'crypto';
import { pathToFileURL } from 'url';
import type { StorageBackend } from '../storage/storageBackend.js';
import { userContentContainer } from '../storage/userContentContainer.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';

export interface MigrationSummary {
  filesMigrated: number;
  bytesTransferred: number;
  verified: number;
  failures: { path: string; error: string }[];
  verifyFailures: { path: string; error: string }[];
}

export interface MigrateOptions {
  /** Progress/summary sink. Defaults to a no-op (tests stay quiet). */
  log?: (msg: string) => void;
  /** Read each blob back and SHA-compare after write. Default true. */
  verify?: boolean;
  /** Preview only: enumerate + read source (to confirm readability/size) but
   *  make NO writes to the destination. `filesMigrated`/`bytesTransferred`
   *  report what WOULD be copied. Default false. */
  dryRun?: boolean;
}

const COMMUNITY_DIRS = ['community/chats', 'community/debates', 'community/_submissions'];

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf-8').digest('hex');
}

async function listJsonFiles(backend: StorageBackend, dir: string): Promise<string[]> {
  return (await backend.listDirectory(dir)).filter(f => f.endsWith('.json'));
}

/** Enumerate every user-content file (data-root-relative path) to migrate. */
export async function collectUserContentPaths(source: StorageBackend): Promise<string[]> {
  const paths: string[] = [];

  // Per-user chats + debates under users/{userId}/
  const userIds = await source.listDirectory('users');
  for (const userId of userIds) {
    for (const kind of ['chats', 'debates']) {
      const dir = `users/${userId}/${kind}`;
      for (const f of await listJsonFiles(source, dir)) paths.push(`${dir}/${f}`);
    }
  }

  // Shared community content
  for (const dir of COMMUNITY_DIRS) {
    for (const f of await listJsonFiles(source, dir)) paths.push(`${dir}/${f}`);
  }

  return paths;
}

/**
 * Copy every user-content file from `source` to `dest`, optionally verifying
 * each with a read-back SHA compare. Per-file failures are recorded and do not
 * abort the run. Returns a summary report.
 */
/**
 * Migrate one user-content file, folding the result (or a recorded failure) into
 * `summary`. Never throws — per-file errors are captured so the run continues.
 * Mirrors the original loop body (the `continue`s become early `return`s).
 */
async function migrateOneFile(
  source: StorageBackend,
  dest: StorageBackend,
  p: string,
  summary: MigrationSummary,
  opts: { verify: boolean; dryRun: boolean; log: (m: string) => void },
): Promise<void> {
  const { verify, dryRun, log } = opts;
  try {
    const content = await source.readFile(p);
    if (content === null) { summary.failures.push({ path: p, error: 'source returned null' }); return; }

    // Dry run: confirm the source is readable + sized, but write nothing.
    if (dryRun) {
      summary.filesMigrated++; // would-migrate count
      summary.bytesTransferred += Buffer.byteLength(content, 'utf-8');
      return;
    }

    await dest.writeFile(p, content);
    summary.filesMigrated++;
    summary.bytesTransferred += Buffer.byteLength(content, 'utf-8');

    if (verify) {
      const readBack = await dest.readFile(p);
      if (readBack === null || sha256(readBack) !== sha256(content)) {
        summary.verifyFailures.push({ path: p, error: 'SHA mismatch or missing after write' });
      } else {
        summary.verified++;
      }
    }

    if (summary.filesMigrated % 50 === 0) log(`  …${summary.filesMigrated} migrated`);
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'migration',
      level: 'warn',
      message: 'Failed to migrate user-content file — continuing',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    const error = (err as Error)?.message ?? String(err);
    summary.failures.push({ path: p, error });
    log(`  ! failed: ${p} — ${error}`);
  }
}

export async function migrateUserContent(
  source: StorageBackend,
  dest: StorageBackend,
  opts: MigrateOptions = {},
): Promise<MigrationSummary> {
  const log = opts.log ?? (() => {});
  const verify = opts.verify ?? true;
  const dryRun = opts.dryRun ?? false;
  const summary: MigrationSummary = {
    filesMigrated: 0, bytesTransferred: 0, verified: 0, failures: [], verifyFailures: [],
  };

  const paths = await collectUserContentPaths(source);
  log(`${dryRun ? '[DRY RUN] ' : ''}Found ${paths.length} user-content files to migrate.`);

  for (const p of paths) await migrateOneFile(source, dest, p, summary, { verify, dryRun, log });

  log(
    `${dryRun ? '[DRY RUN] would migrate' : 'Migration complete:'} ${summary.filesMigrated} files, ` +
    `${summary.bytesTransferred} bytes, ${summary.verified} verified, ` +
    `${summary.failures.length} failures, ${summary.verifyFailures.length} verify failures.`,
  );
  return summary;
}

// ── CLI entry ──

async function main(): Promise<void> {
  const { log } = await import('../logger.js');
  const accountUrl = process.env.AZURE_STORAGE_ACCOUNT_URL;
  if (!accountUrl) {
    log.server.error('AZURE_STORAGE_ACCOUNT_URL is required');
    process.exit(2);
  }

  const { AzureBlobBackend } = await import('../storage/azureBlobBackend.js');

  // Source selection:
  //  - 'filesystem' (CI default): read a checked-out copy of the data repo from
  //    the current working directory (paths are cwd-relative). No GitHub App
  //    creds needed — the workflow just checks out ai-triad-data and runs here.
  //  - 'github': read live via the GitHub Contents/Trees API (needs GitHub App
  //    creds; matches the runtime backend).
  const sourceMode = process.env.MIGRATION_SOURCE ?? 'github';
  let source: import('../storage/storageBackend.js').StorageBackend;
  let shutdownSource: () => void = () => {};
  if (sourceMode === 'filesystem') {
    const { FilesystemBackend } = await import('../storage/filesystemBackend.js');
    // t/223: root is required; the script's filesystem source is cwd-relative by design.
    source = new FilesystemBackend({ root: process.cwd() });
    log.server.info({ cwd: process.cwd() }, 'Migration source: filesystem (cwd-relative)');
  } else {
    const { GitHubAPIBackend } = await import('../storage/githubAPIBackend.js');
    const { CACHE_DIR } = await import('../config.js');
    const gh = new GitHubAPIBackend({ cacheDir: CACHE_DIR, pollIntervalMs: 999_999_999, coherencyProbeRate: 0 });
    await gh.initialize();
    source = gh;
    shutdownSource = () => gh.shutdown();
    log.server.info('Migration source: github-api');
  }

  const dest = new AzureBlobBackend({
    accountUrl,
    userContentContainer: userContentContainer(), // t/4733: single env-resolved source
    communityContainer: process.env.AZURE_COMMUNITY_CONTAINER || 'community',
  });

  const dryRun = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');
  if (dryRun) log.server.info('DRY RUN — no writes will be made to Blob');

  const summary = await migrateUserContent(source, dest, { log: (m) => log.server.info(m), dryRun });
  log.server.info({ summary, dryRun }, 'User-content → Blob migration summary');
  shutdownSource();

  const hadErrors = summary.failures.length + summary.verifyFailures.length > 0;
  process.exit(hadErrors ? 1 : 0);
}

const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'migration',
      level: 'error',
      message: 'User-content → Blob migration failed',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    console.error(err);
    process.exit(1);
  });
}
