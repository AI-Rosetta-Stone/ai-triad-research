// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import fs from 'fs';
import path from 'path';
import { renameSyncWithRetry } from './persistence.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';
import { normalizeDebateOrigin } from './types/session.js';

export interface DebateSessionSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  phase: string;
  topic_text?: string;
  model?: string;
  turn_count?: number;
  app_version?: string;
  crux_addressed_ratio?: number | null;
  process_reward_mean?: number | null;
  claims_forgotten_rate?: number | null;
  taxonomy_mapped_ratio?: number | null;
  repetition_rate?: number | null;
  /** Set only for Ask a Question debates (t/4678) — drives the "Question" badge in My Debates. */
  origin_mode?: 'inquiry';
  /** inquiry-only: the inquiry job/result id, for the back-link to the question. */
  inquiry_id?: string;
}

interface IndexEntry extends DebateSessionSummary {
  file_mtime: number;
}

interface DebateIndex {
  version: 1;
  entries: Record<string, IndexEntry>;
}

const INDEX_FILE = 'debates-index.json';

/** t/4679: only Ask a Question debates get origin_mode/inquiry_id — every other summary's shape
 *  stays byte-identical to today. Extracted out of extractSummary to keep its complexity flat. */
function extractInquiryFields(data: Record<string, unknown>): Pick<DebateSessionSummary, 'origin_mode' | 'inquiry_id'> {
  const normalizedOrigin = normalizeDebateOrigin(data.origin, data.inquiryJobId);
  if (normalizedOrigin?.mode !== 'inquiry') return {};
  return normalizedOrigin.inquiry_id
    ? { origin_mode: 'inquiry', inquiry_id: normalizedOrigin.inquiry_id }
    : { origin_mode: 'inquiry' };
}

export function extractSummary(data: Record<string, unknown>): DebateSessionSummary {
  const transcript = Array.isArray(data.transcript) ? data.transcript : [];
  const topic = data.topic as { final?: string; original?: string } | undefined;
  const turnEntries = transcript.filter((t: { type?: string }) => t.type === 'statement' || t.type === 'opening');

  const neutralEvals = data.neutral_evaluations as { checkpoint?: string; cruxes?: { status: string }[] }[] | undefined;
  const finalEval = (neutralEvals ?? []).find(e => e.checkpoint === 'final');
  let cruxAddressedRatio: number | null = null;
  if (finalEval?.cruxes && finalEval.cruxes.length > 0) {
    cruxAddressedRatio = finalEval.cruxes.filter(c => c.status === 'addressed').length / finalEval.cruxes.length;
  }

  const processRewards = data.process_rewards as { score: number }[] | undefined;
  let processRewardMean: number | null = null;
  if (processRewards && processRewards.length > 0) {
    processRewardMean = processRewards.reduce((s, pr) => s + pr.score, 0) / processRewards.length;
  }

  const an = data.argument_network as { nodes: { source_entry_id?: string }[] } | undefined;
  const ledger = data.unanswered_claims_ledger as { addressed_round?: number }[] | undefined;
  const totalClaims = an?.nodes.length ?? 0;
  const forgottenClaims = (ledger ?? []).filter(c => !c.addressed_round).length;
  const claimsForgottenRate = totalClaims > 0 ? forgottenClaims / totalClaims : null;

  let taxonomyMappedRatio: number | null = null;
  if (an && an.nodes.length > 0) {
    const mapped = an.nodes.filter(n => {
      const entryRefs = transcript
        .filter((e: { id?: string }) => e.id === n.source_entry_id)
        .flatMap((e: { taxonomy_refs?: { node_id: string }[] }) => e.taxonomy_refs ?? []);
      return entryRefs.length > 0;
    }).length;
    taxonomyMappedRatio = mapped / an.nodes.length;
  }

  const validations = (data.turn_validations ?? {}) as Record<string, unknown>;
  const totalTurns = turnEntries.length;
  let repetitionWarnings = 0;
  for (const v of Object.values(validations)) {
    const issues = (v as any)?.final?.issues ?? (v as any)?.attempts?.flatMap((a: any) => a.issues ?? []) ?? [];
    for (const issue of issues) {
      const text = typeof issue === 'string' ? issue : (issue as any)?.message ?? '';
      if (/repeat|repetition|same moves/i.test(text)) repetitionWarnings++;
    }
  }

  return {
    id: data.id as string,
    title: typeof data.title === 'string' && data.title
      ? data.title
      : typeof data.topic === 'string'
        ? data.topic
        : topic?.final ?? topic?.original ?? 'Untitled',
    created_at: data.created_at as string,
    updated_at: data.updated_at as string,
    phase: data.phase as string,
    topic_text: topic?.final ?? topic?.original ?? '',
    model: data.debate_model as string | undefined,
    turn_count: turnEntries.length,
    app_version: typeof data.app_version === 'string' ? data.app_version : undefined,
    crux_addressed_ratio: cruxAddressedRatio,
    process_reward_mean: processRewardMean,
    claims_forgotten_rate: claimsForgottenRate,
    taxonomy_mapped_ratio: taxonomyMappedRatio,
    repetition_rate: totalTurns > 0 ? repetitionWarnings / totalTurns : null,
    ...extractInquiryFields(data),
  };
}

function readIndex(debatesDir: string): DebateIndex | null {
  const indexPath = path.join(debatesDir, INDEX_FILE);
  try {
    if (!fs.existsSync(indexPath)) return null;
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as DebateIndex;
    if (raw.version !== 1) return null;
    return raw;
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-index', level: 'warn', message: 'debate index unreadable or invalid — returning null. err=' + String(err) });
    return null;
  }
}

function writeIndex(debatesDir: string, index: DebateIndex): void {
  const indexPath = path.join(debatesDir, INDEX_FILE);
  try {
    fs.writeFileSync(indexPath, JSON.stringify(index) + '\n', 'utf-8');
  } catch {
    // Non-fatal — listing still works, just won't be cached
  }
}

/**
 * List debate sessions using a mtime-based summary index.
 * On first call or after new/changed files, reads only the changed files
 * and updates the index. Subsequent calls with no file changes read only
 * the small index file.
 */
export function listDebateSessionsIndexed(debatesDir: string): DebateSessionSummary[] {
  if (!fs.existsSync(debatesDir)) return [];

  const scanDirs = [debatesDir];
  const cliRunsDir = path.join(debatesDir, 'cli-runs');
  if (fs.existsSync(cliRunsDir)) scanDirs.push(cliRunsDir);

  // Collect all debate files with their mtimes (cheap — no file reading)
  const fileEntries: { filePath: string; fileName: string; mtime: number }[] = [];
  for (const dir of scanDirs) {
    const files = fs.readdirSync(dir).filter((f: string) =>
      f.endsWith('.json') && f !== INDEX_FILE && (f.startsWith('debate-') || f.endsWith('-debate.json'))
    );
    for (const f of files) {
      const filePath = path.join(dir, f);
      try {
        const stat = fs.statSync(filePath);
        fileEntries.push({ filePath, fileName: f, mtime: stat.mtimeMs });
      } catch { /* skip inaccessible files */ }
    }
  }

  const existingIndex = readIndex(debatesDir);
  const indexEntries = existingIndex?.entries ?? {};
  const newEntries: Record<string, IndexEntry> = {};
  let indexDirty = false;

  for (const { filePath, mtime } of fileEntries) {
    // Check if we have a cached entry with matching mtime
    const cached = Object.values(indexEntries).find(e => {
      const expectedPath = path.join(debatesDir, `debate-${e.id}.json`);
      return expectedPath === filePath && e.file_mtime === mtime;
    });

    if (cached && typeof cached.title === 'string') {
      newEntries[cached.id] = cached;
      continue;
    }

    // Read and parse only this file
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;

      // Migrate cli-runs files to canonical location
      const canonical = `debate-${data.id}.json`;
      const canonicalPath = path.join(debatesDir, canonical);
      if (filePath !== canonicalPath) {
        renameSyncWithRetry(filePath, canonicalPath);
      }

      const summary = extractSummary(data);
      const finalMtime = filePath !== canonicalPath
        ? fs.statSync(canonicalPath).mtimeMs
        : mtime;
      newEntries[summary.id] = { ...summary, file_mtime: finalMtime };
      indexDirty = true;
    } catch {
      // Skip corrupt files
    }
  }

  // Detect removed files
  if (Object.keys(indexEntries).length !== Object.keys(newEntries).length) {
    indexDirty = true;
  }

  if (indexDirty || !existingIndex) {
    writeIndex(debatesDir, { version: 1, entries: newEntries });
  }

  const summaries: DebateSessionSummary[] = Object.values(newEntries).map(
    ({ file_mtime: _, ...summary }) => summary,
  );
  summaries.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  return summaries;
}

/**
 * Update the index for a single session after save.
 * Avoids a full rescan when we already have the session data.
 */
export function updateDebateIndexEntry(debatesDir: string, session: Record<string, unknown>): void {
  const id = session.id as string;
  if (!id) return;

  const filePath = path.join(debatesDir, `debate-${id}.json`);
  let mtime: number;
  try {
    mtime = fs.statSync(filePath).mtimeMs;
  } catch {
    return;
  }

  const index = readIndex(debatesDir) ?? { version: 1 as const, entries: {} };
  const summary = extractSummary(session);
  index.entries[id] = { ...summary, file_mtime: mtime };
  writeIndex(debatesDir, index);
}
