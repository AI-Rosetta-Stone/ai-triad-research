#!/usr/bin/env node

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Chat batch regeneration CLI.
 * Replays old chats through current pipeline, archives originals, replaces atomically.
 *
 * **Phase 5 Status:** Replay logic wired; dry-run works. Live replay requires app integration.
 *
 * Usage:
 *   npm run regen:batch -- --dry-run                    # Analyze all chats without changes
 *   npm run regen:batch -- --apply --single <chat-id>   # Regenerate one chat (requires app wiring)
 *   npm run regen:batch -- --restore <chat-id>          # Restore chat from archive
 *
 * Replay one chat through the app's pipeline and write the result to a local candidate file.
 * It reads the store and writes no store (t/287):
 *   npx tsx scripts/chat-regeneration/cli.ts --replay --single <chat-id> --server http://127.0.0.1:7862 --out <file> [--model <id>] [--override-model <id>] [--store community]
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { fileURLToPath } from 'url';

import { generateDryRunReport, formatDryRunReport } from './dryRun.js';
import { replayChatSession, processChatBatch } from './batchRunner.js';
import { archiveChat, listArchivedVersions, restoreChat, replaceChat, updateIndex } from './archive.js';
import { createBackendAdapter } from './backendAdapter.js';
import type { StorageBackendAdapter } from './backendAdapter.js';
import type { ChatSession, DryRunReport } from './types.js';
import { FilesystemBackend } from '../../src/server/storage/filesystemBackend.js';
import type { StorageBackend } from '../../src/server/storage/storageBackend.js';
import { resolveCommunityBackend, COMMUNITY_CHATS_DIR } from './hostedBackend.js';
import { startReplayRuntime } from './replayRuntime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Which store to read: the personal chats on local disk, or the hosted community store (t/287). */
export type StoreName = 'personal' | 'community';

interface CliOptions {
  dryRun: boolean;
  apply: boolean;
  single?: string;
  batch: boolean;
  restore?: string;
  force: boolean;
  limit?: number;
  store: StoreName;
  replay: boolean;
  server?: string;
  out?: string;
  model?: string;
  overrideModel?: string;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);

  const getSingleValue = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx < args.length - 1 ? args[idx + 1] : undefined;
  };

  const storeArg = getSingleValue('--store') ?? 'personal';
  if (storeArg !== 'personal' && storeArg !== 'community') {
    throw new Error(`--store must be "personal" or "community", got "${storeArg}"`);
  }

  return {
    dryRun: args.includes('--dry-run'),
    apply: args.includes('--apply'),
    single: getSingleValue('--single'),
    batch: args.includes('--batch'),
    restore: getSingleValue('--restore'),
    force: args.includes('--force'),
    limit: getSingleValue('--limit') ? parseInt(getSingleValue('--limit')!, 10) : undefined,
    store: storeArg,
    replay: args.includes('--replay'),
    server: getSingleValue('--server'),
    out: getSingleValue('--out'),
    model: getSingleValue('--model'),
    overrideModel: getSingleValue('--override-model'),
  };
}

/**
 * Load every chat in `dir` through the storage backend, so the same code reads the local
 * personal chats and the hosted community store. Chat files are `chat-<id>.json`.
 */
async function loadChatsFromPath(backend: StorageBackend, dir: string): Promise<ChatSession[]> {
  const chats: ChatSession[] = [];

  try {
    const files = await backend.listDirectory(dir);
    for (const file of files) {
      if (file.endsWith('.json') && !file.startsWith('_')) {
        const content = await backend.readFile(path.join(dir, file));
        if (content === null) continue;
        chats.push(JSON.parse(content) as ChatSession);
      }
    }
  } catch (err) {
    console.error(`Failed to load chats from ${dir}:`, err);
  }

  return chats;
}

/** Format an ActionableError for CLI output */
function formatActionableError(err: Error & { goal?: string; problem?: string; location?: string; nextSteps?: string }): string {
  const lines = [];
  if (err.goal) lines.push(`Goal: ${err.goal}`);
  if (err.problem) lines.push(`Problem: ${err.problem}`);
  if (err.location) lines.push(`Location: ${err.location}`);
  if (err.nextSteps) lines.push(`Next Steps: ${err.nextSteps}`);
  if (lines.length === 0) lines.push(err.message);
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs();

  // Validate mode
  if (!opts.dryRun && !opts.apply && !opts.restore && !opts.replay) {
    console.error('Usage: --dry-run, --replay --single <id> --server <url> --out <file>, --apply [--single <id> | --batch], or --restore <id>');
    process.exit(1);
  }

  // Personal chats: the local ai-triad-data chats directory (or AI_TRIAD_DATA_ROOT).
  // Community store: the hosted store, read through the server's configured backend. The
  // community path is logical (community/chats); the backend maps it to the container.
  const localChatsDir = process.env.AI_TRIAD_DATA_ROOT
    ? path.join(process.env.AI_TRIAD_DATA_ROOT, 'chats')
    : path.resolve(__dirname, '../../../../ai-triad-data/chats');

  console.log(`📊 Chat Batch Regeneration Tool`);
  console.log(`Store: ${opts.store}`);

  let storageBackend: StorageBackend;
  let baseDataPath: string;
  if (opts.store === 'community') {
    storageBackend = await resolveCommunityBackend();
    baseDataPath = COMMUNITY_CHATS_DIR;
  } else {
    // t/223: the backend is confined to a root; the personal chats directory is the only one this tool needs.
    storageBackend = new FilesystemBackend({ root: localChatsDir });
    baseDataPath = localChatsDir;
  }
  console.log(`Base path: ${baseDataPath}`);
  console.log('');

  const backend = createBackendAdapter(storageBackend);

  // DRY RUN MODE
  if (opts.dryRun) {
    console.log('🔍 Running dry-run analysis...\n');

    const chats = await loadChatsFromPath(storageBackend, baseDataPath);
    if (chats.length === 0) {
      console.log('No chats found. Check path and permissions.');
      process.exit(1);
    }

    const report = generateDryRunReport(chats, opts.store, { force: opts.force });
    console.log(formatDryRunReport(report));

    if (report.errors.length > 0) {
      console.log('\n⚠️  Some chats could not be analyzed. Fix errors before proceeding.');
    }

    process.exit(0);
  }

  // RESTORE MODE
  if (opts.restore) {
    console.log(`♻️  Restoring chat ${opts.restore} from archive...\n`);

    try {
      const archived = await listArchivedVersions(opts.restore, baseDataPath, backend);
      if (archived.length === 0) {
        console.error(`No archived versions found for ${opts.restore}`);
        process.exit(1);
      }

      console.log('Available versions:');
      for (const ver of archived) {
        console.log(`  ${ver.timestamp}`);
      }

      const restored = await restoreChat(opts.restore, baseDataPath, backend, { dryRun: true });
      console.log(`\nWould restore from: ${archived[0].timestamp}`);
      console.log(`Title: ${restored.title}`);
      console.log(`Turns: ${(restored.transcript as unknown[])?.length ?? 0}`);
    } catch (err) {
      console.error('Restore failed:', err);
      process.exit(1);
    }

    process.exit(0);
  }

  // REPLAY MODE: read one chat, regenerate it through the app's pipeline, write a local candidate file.
  if (opts.replay) {
    if (!opts.single || !opts.server || !opts.out) {
      console.error('--replay requires --single <id>, --server <url> and --out <file>');
      process.exit(1);
    }
    const chats = await loadChatsFromPath(storageBackend, baseDataPath);
    const chat = chats.find(c => c.id === opts.single);
    if (!chat) {
      console.error(`Chat ${opts.single} not found in the ${opts.store} store`);
      process.exit(1);
    }
    console.log(`Replaying chat ${chat.id} ("${chat.title}", ${chat.transcript.length} entries) through ${opts.server}`);
    const runtime = await startReplayRuntime(opts.server);
    let exitCode = 0;
    try {
      const regenerated = await runtime.replay(chat, { fallbackModel: opts.model, overrideModel: opts.overrideModel });
      await fs.writeFile(opts.out, JSON.stringify({ original: chat, regenerated }, null, 2), 'utf8');
      const answers = regenerated.transcript.filter(e => e.speaker === regenerated.pover);
      console.log(`Regenerated ${answers.length} answer(s); ${answers.filter(e => e.raw_prompt && e.raw_response).length} carry raw_prompt and raw_response.`);
      console.log(`Candidate written to ${opts.out}. No store was written.`);
      if (runtime.guard.blocked.length > 0) console.log(`Refused requests: ${runtime.guard.blocked.join(', ')}`);
    } catch (err) {
      console.error('Chat replay failed');
      console.error(formatActionableError(err as Error));
      exitCode = 1;
    } finally {
      await runtime.close();
    }
    process.exit(exitCode);
  }

  // APPLY MODE
  if (opts.apply) {
    if (opts.single) {
      console.log(`🎬 Attempting to regenerate single chat: ${opts.single}\n`);

      const chats = await loadChatsFromPath(storageBackend, baseDataPath);
      const chat = chats.find(c => c.id === opts.single);

      if (!chat) {
        console.error(`Chat ${opts.single} not found`);
        process.exit(1);
      }

      try {
        // Replay with backend and dry-run (no actual regeneration yet for first test)
        const regenerated = await replayChatSession(chat, {
          dryRun: true, // Start with dry-run for safety
          // Phase 5: app provides replayTurnFn via wrapper when ready
        });
        console.log(`✅ Regenerated chat (dry-run mode)`);
        console.log(`   Updated at: ${regenerated.regenerated_at}`);
        console.log(`   Turns: ${regenerated.transcript.length}`);
      } catch (err) {
        // Catch phase 5 errors and format as ActionableError
        const error = err as Error & { goal?: string; problem?: string; location?: string; nextSteps?: string };
        console.error('\n❌ Chat replay failed\n');
        console.error(formatActionableError(error));
        console.error('\n');
        process.exit(1);
      }

      process.exit(0);
    }

    if (opts.batch) {
      console.error('\n❌ Batch regeneration not yet authorized.\n');
      console.error('Safety constraint: single-chat result shown to PI first, then batch.');
      console.error('Once --apply --single works and is reviewed, batch mode will be available.');
      process.exit(1);
    }

    console.error('--apply requires --single <id> or --batch');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
