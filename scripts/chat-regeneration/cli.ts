#!/usr/bin/env node

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Chat batch regeneration CLI.
 * Replays old chats through current pipeline, archives originals, replaces atomically.
 *
 * Usage:
 *   npm run regen:batch -- --dry-run                    # Analyze all chats without changes
 *   npm run regen:batch -- --apply --single <chat-id>   # Regenerate one chat, show result
 *   npm run regen:batch -- --apply --batch              # Regenerate all (needs approval after single)
 *   npm run regen:batch -- --restore <chat-id>          # Restore chat from archive
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { generateDryRunReport, formatDryRunReport } from './dryRun.js';
import { replayChatSession, processChatBatch } from './batchRunner.js';
import { archiveChat, listArchivedVersions, restoreChat, replaceChat, updateIndex } from './archive.js';
import type { ChatSession, DryRunReport } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface CliOptions {
  dryRun: boolean;
  apply: boolean;
  single?: string;
  batch: boolean;
  restore?: string;
  force: boolean;
  limit?: number;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);

  const getSingleValue = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx < args.length - 1 ? args[idx + 1] : undefined;
  };

  return {
    dryRun: args.includes('--dry-run'),
    apply: args.includes('--apply'),
    single: getSingleValue('--single'),
    batch: args.includes('--batch'),
    restore: getSingleValue('--restore'),
    force: args.includes('--force'),
    limit: getSingleValue('--limit') ? parseInt(getSingleValue('--limit')!, 10) : undefined,
  };
}

async function loadChatsFromPath(basePath: string): Promise<ChatSession[]> {
  const chats: ChatSession[] = [];

  try {
    const files = await fs.readdir(basePath);
    for (const file of files) {
      if (file.endsWith('.json') && !file.startsWith('_')) {
        const content = await fs.readFile(path.join(basePath, file), 'utf-8');
        chats.push(JSON.parse(content) as ChatSession);
      }
    }
  } catch (err) {
    console.error(`Failed to load chats from ${basePath}:`, err);
  }

  return chats;
}

async function main() {
  const opts = parseArgs();

  // Validate mode
  if (!opts.dryRun && !opts.apply && !opts.restore) {
    console.error('Usage: --dry-run, --apply [--single <id> | --batch], or --restore <id>');
    process.exit(1);
  }

  // Get base path (default to ai-triad-data chats, up to parent repo or env var)
  let baseDataPath = process.env.AI_TRIAD_DATA_ROOT
    ? path.join(process.env.AI_TRIAD_DATA_ROOT, 'chats')
    : path.resolve(__dirname, '../../../../ai-triad-data/chats');

  console.log(`📊 Chat Batch Regeneration Tool`);
  console.log(`Base path: ${baseDataPath}`);
  console.log('');

  // DRY RUN MODE
  if (opts.dryRun) {
    console.log('🔍 Running dry-run analysis...\n');

    const chats = await loadChatsFromPath(baseDataPath);
    if (chats.length === 0) {
      console.log('No chats found. Check path and permissions.');
      process.exit(1);
    }

    const report = generateDryRunReport(chats, 'personal', { force: opts.force });
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
      const archived = await listArchivedVersions(opts.restore, baseDataPath);
      if (archived.length === 0) {
        console.error(`No archived versions found for ${opts.restore}`);
        process.exit(1);
      }

      console.log('Available versions:');
      for (const ver of archived) {
        console.log(`  ${ver.timestamp}`);
      }

      const restored = await restoreChat(opts.restore, baseDataPath, { dryRun: true });
      console.log(`\nWould restore from: ${archived[0].timestamp}`);
      console.log(`Title: ${restored.title}`);
      console.log(`Turns: ${restored.transcript.length}`);
    } catch (err) {
      console.error('Restore failed:', err);
      process.exit(1);
    }

    process.exit(0);
  }

  // APPLY MODE
  if (opts.apply) {
    if (opts.single) {
      console.log(`🎬 Regenerating single chat: ${opts.single}\n`);

      const chats = await loadChatsFromPath(baseDataPath);
      const chat = chats.find(c => c.id === opts.single);

      if (!chat) {
        console.error(`Chat ${opts.single} not found`);
        process.exit(1);
      }

      try {
        // Archive original
        const archivePath = await archiveChat(chat, baseDataPath);
        console.log(`✅ Archived original to: ${archivePath}`);

        // Replay chat
        const regenerated = await replayChatSession(chat);
        console.log(`✅ Regenerated chat in memory`);
        console.log(`   Updated at: ${regenerated.regenerated_at}`);
        console.log(`   Turns: ${regenerated.transcript.length}`);

        // Show result (not persisted)
        console.log(`\n📋 Result (dry-run; no files written):`);
        console.log(`   Title: ${regenerated.title}`);
        console.log(`   Mode: ${regenerated.mode}`);
        console.log(`   Transcript turns: ${regenerated.transcript.length}`);
      } catch (err) {
        console.error('Single-chat regeneration failed:', err);
        process.exit(1);
      }

      process.exit(0);
    }

    if (opts.batch) {
      console.log('⚠️  Full batch regeneration not yet authorized. Run single-chat first with --single <id>.');
      console.log('This protects prod data: single result is shown to PI, then batch can proceed.');
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
