#!/usr/bin/env npx tsx
/**
 * Phase 0b: Backfill debate-tested records over historical debate corpus.
 *
 * Usage:
 *   npx tsx lib/debate/backfillDebateTested.ts                # dry-run (report only)
 *   npx tsx lib/debate/backfillDebateTested.ts --write         # write updated taxonomy files
 *
 * Reads all debate-*.json sessions from <data>/debates/, calls harvestDebateTested
 * for sessions with argument_network data, and creates "cited" entries for sessions
 * that reference taxonomy nodes without AN analysis. Results are merged into
 * graph_attributes.debate_tested on each POV node.
 *
 * Tickets: t/1576, t/1578
 */

import fs from 'fs';
import path from 'path';
import { harvestDebateTested, computeTierAndSortKey, setDescriptionHasher, categoryToBdiImpact } from './debateTested.js';
import { computeDescriptionHash } from './debateTestedHash.js';
import { auditDebateTestedLag, collectSessionTaxonomyRefs, formatLagLine } from './harvestOnSave.js';
import type { HarvestResult } from './debateTested.js';
import type {
  PovNode,
  DebateTestedEntry,
  DebateTestedRecord,
} from './taxonomyTypes.js';
import type { ArgumentNetworkNode, ArgumentNetworkEdge } from './types.js';
import { resolveDataRoot } from './taxonomyLoader.js';

// Node entry point: configure the description hasher for the harvest writer.
// debateTested.ts stays crypto-free so it can be bundled into the renderer (t/1591).
setDescriptionHasher(computeDescriptionHash);

// ── Types ─────────────────────────────────────────────────────────────────

interface DebateSession {
  id: string;
  created_at?: string;
  app_version?: string;
  argument_network?: {
    nodes?: ArgumentNetworkNode[];
    edges?: ArgumentNetworkEdge[];
  };
  transcript?: Array<{
    speaker?: string;
    taxonomy_refs?: string[];
  }>;
}

interface PovFile {
  pov: string;
  nodes: PovNode[];
  [key: string]: unknown;
}

interface BackfillStats {
  sessionsProcessed: number;
  sessionsSkipped: number;
  sessionsWithAN: number;
  sessionsWithoutAN: number;
  entriesCreated: number;
  entriesDeduplicated: number;
  nodesUpdated: Set<string>;
  verdictCounts: Record<string, number>;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function derivePipelineVersion(session: DebateSession): string {
  if (session.app_version) {
    const date = session.created_at?.slice(0, 10) ?? 'unknown';
    return `backfill-v${session.app_version}-${date}`;
  }
  return 'pre-instrumentation';
}

function extractDateFromSession(session: DebateSession): string {
  if (session.created_at) {
    return session.created_at.slice(0, 10);
  }
  return '1970-01-01';
}

function extractPovTaxonomyRefs(anNodes: ArgumentNetworkNode[]): string[] {
  const refs = new Set<string>();
  for (const node of anNodes) {
    for (const ref of node.taxonomy_refs ?? []) {
      const nodeId = typeof ref === 'string' ? ref : (ref as { node_id: string }).node_id;
      if (nodeId.match(/^(acc|saf|skp)-/)) {
        refs.add(nodeId);
      }
    }
  }
  return [...refs];
}


function nodeHasDebateEntry(node: PovNode, debateId: string): boolean {
  const record = node.graph_attributes?.debate_tested?.record;
  if (!record?.length) return false;
  return record.some((e: DebateTestedEntry) => e.debate_id === debateId);
}

function createCitedEntry(
  debateId: string,
  date: string,
  pipelineVersion: string,
): DebateTestedEntry {
  return {
    debate_id: debateId,
    date,
    pipeline_version: pipelineVersion,
    verdict: 'cited',
    strongest_attack_encountered: null,
    claim_outcomes: { thrived: 0, survived: 0, died: 0 },
    concession: null,
  };
}

function mergeCitedEntry(
  entry: DebateTestedEntry,
  existing: DebateTestedRecord | undefined,
  description: string,
): DebateTestedRecord {
  const record = [...(existing?.record ?? []), entry];
  const revisions = [...(existing?.revisions ?? [])];
  const engagements = (existing?.engagements ?? 0) + 1;
  const { tier, sort_key } = computeTierAndSortKey(record, revisions);

  return {
    tier,
    sort_key,
    engagements,
    challenges: existing?.challenges ?? 0,
    held: existing?.held ?? 0,
    weakened: existing?.weakened ?? 0,
    revisions,
    last_tested: entry.date,
    description_hash: existing?.description_hash ?? computeDescriptionHash(description),
    record,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────

export function runBackfill(repoRoot: string, writeMode: boolean): BackfillStats {
  const dataRoot = resolveDataRoot(repoRoot);
  const taxonomyDir = path.join(dataRoot, 'taxonomy', 'Origin');
  const debatesDir = path.join(dataRoot, 'debates');

  // Load taxonomy POV files
  const povFiles: Map<string, PovFile> = new Map();
  const nodeMap: Map<string, PovNode> = new Map();
  const nodeToFile: Map<string, string> = new Map();

  for (const filename of ['accelerationist.json', 'safetyist.json', 'skeptic.json']) {
    const filePath = path.join(taxonomyDir, filename);
    const data: PovFile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    povFiles.set(filename, data);
    for (const node of data.nodes) {
      nodeMap.set(node.id, node);
      nodeToFile.set(node.id, filename);
    }
  }

  console.log(`Loaded ${nodeMap.size} taxonomy nodes from ${povFiles.size} POV files`);

  // Collect tier distribution before backfill (all three BDI categories; situation
  // nodes coerce to undefined via categoryToBdiImpact and are excluded — t/1660).
  const tiersBefore: Record<string, number> = { untested: 0, cited: 0, contested: 0, well_tested: 0 };
  for (const node of nodeMap.values()) {
    if (!categoryToBdiImpact(node.category)) continue;
    const tier = node.graph_attributes?.debate_tested?.tier ?? 'untested';
    tiersBefore[tier] = (tiersBefore[tier] ?? 0) + 1;
  }

  // Find debate session files
  const sessionFiles = fs.readdirSync(debatesDir)
    .filter(f => f.startsWith('debate-') && f.endsWith('.json'))
    .sort();

  console.log(`Found ${sessionFiles.length} debate session files\n`);

  const stats: BackfillStats = {
    sessionsProcessed: 0,
    sessionsSkipped: 0,
    sessionsWithAN: 0,
    sessionsWithoutAN: 0,
    entriesCreated: 0,
    entriesDeduplicated: 0,
    nodesUpdated: new Set(),
    verdictCounts: {},
  };

  for (const file of sessionFiles) {
    let session: DebateSession;
    try {
      session = JSON.parse(fs.readFileSync(path.join(debatesDir, file), 'utf-8'));
    } catch {
      console.log(`  SKIP ${file}: invalid JSON`);
      stats.sessionsSkipped++;
      continue;
    }

    if (!session.id) {
      console.log(`  SKIP ${file}: no session id`);
      stats.sessionsSkipped++;
      continue;
    }

    const debateId = session.id;
    const date = extractDateFromSession(session);
    const pipelineVersion = derivePipelineVersion(session);
    const anNodes = session.argument_network?.nodes ?? [];
    const anEdges = session.argument_network?.edges ?? [];
    const hasAN = anNodes.length > 0;

    // All POV refs this session touches — union of AN + transcript, deduped.
    // The shared helper ensures backfill and auditDebateTestedLag agree on coverage (t/3331).
    const allRefs = collectSessionTaxonomyRefs(session);

    if (hasAN) {
      stats.sessionsWithAN++;

      // AN harvest: nodes in the argument network get full strength/verdict data.
      const povNodeIds = extractPovTaxonomyRefs(anNodes);
      const results = harvestDebateTested({
        debateId,
        date,
        pipelineVersion,
        anNodes,
        anEdges: anEdges as ArgumentNetworkEdge[],
        injectionManifest: { povNodeIds },
        taxonomyNodes: nodeMap,
        concessions: [],
        refinedNodeIds: new Set(),
      });

      let created = 0;
      let deduped = 0;
      const harvestedByAN = new Set<string>();
      for (const result of results) {
        if (nodeHasDebateEntry(nodeMap.get(result.nodeId)!, debateId)) {
          deduped++;
          continue;
        }
        const node = nodeMap.get(result.nodeId)!;
        if (!node.graph_attributes) node.graph_attributes = {};
        node.graph_attributes.debate_tested = result.updatedRecord;
        stats.nodesUpdated.add(result.nodeId);
        stats.verdictCounts[result.entry.verdict] = (stats.verdictCounts[result.entry.verdict] ?? 0) + 1;
        created++;
        harvestedByAN.add(result.nodeId);
      }

      // Cited entries for transcript refs not covered by AN harvest (t/3331).
      for (const nodeId of allRefs) {
        if (harvestedByAN.has(nodeId)) continue;
        const node = nodeMap.get(nodeId);
        if (!node || !categoryToBdiImpact(node.category)) continue;
        if (nodeHasDebateEntry(node, debateId)) { deduped++; continue; }
        const entry = createCitedEntry(debateId, date, pipelineVersion);
        const existing = node.graph_attributes?.debate_tested;
        const updatedRecord = mergeCitedEntry(entry, existing, node.description);
        if (!node.graph_attributes) node.graph_attributes = {};
        node.graph_attributes.debate_tested = updatedRecord;
        stats.nodesUpdated.add(nodeId);
        stats.verdictCounts['cited'] = (stats.verdictCounts['cited'] ?? 0) + 1;
        created++;
      }

      stats.entriesCreated += created;
      stats.entriesDeduplicated += deduped;
      if (created > 0 || deduped > 0) {
        console.log(`  ${file}: AN harvest — ${created} entries created, ${deduped} deduped`);
      }
    } else {
      // No argument_network — cited entries for all BDI refs (transcript or AN union = transcript here).
      // Situation nodes (sit-*/cc-*) coerce to undefined via categoryToBdiImpact, excluded (t/1660).
      const bdiRefs = allRefs.filter(ref => {
        const node = nodeMap.get(ref);
        return node ? !!categoryToBdiImpact(node.category) : false;
      });

      if (bdiRefs.length === 0) {
        stats.sessionsWithoutAN++;
        stats.sessionsSkipped++;
        continue;
      }

      stats.sessionsWithoutAN++;
      let created = 0;
      let deduped = 0;

      for (const nodeId of bdiRefs) {
        const node = nodeMap.get(nodeId)!;
        if (nodeHasDebateEntry(node, debateId)) { deduped++; continue; }
        const entry = createCitedEntry(debateId, date, pipelineVersion);
        const existing = node.graph_attributes?.debate_tested;
        const updatedRecord = mergeCitedEntry(entry, existing, node.description);
        if (!node.graph_attributes) node.graph_attributes = {};
        node.graph_attributes.debate_tested = updatedRecord;
        stats.nodesUpdated.add(nodeId);
        stats.verdictCounts['cited'] = (stats.verdictCounts['cited'] ?? 0) + 1;
        created++;
      }
      stats.entriesCreated += created;
      stats.entriesDeduplicated += deduped;
      if (created > 0 || deduped > 0) {
        console.log(`  ${file}: transcript-only — ${created} cited entries, ${deduped} deduped`);
      }
    }

    stats.sessionsProcessed++;
  }

  // Compute tier distribution after backfill
  const tiersAfter: Record<string, number> = { untested: 0, cited: 0, contested: 0, well_tested: 0 };
  for (const node of nodeMap.values()) {
    if (!categoryToBdiImpact(node.category)) continue;
    const tier = node.graph_attributes?.debate_tested?.tier ?? 'untested';
    tiersAfter[tier] = (tiersAfter[tier] ?? 0) + 1;
  }

  // Summary report
  console.log('\n' + '='.repeat(60));
  console.log('BACKFILL SUMMARY');
  console.log('='.repeat(60));
  console.log(`Sessions processed: ${stats.sessionsProcessed}`);
  console.log(`  With argument_network: ${stats.sessionsWithAN}`);
  console.log(`  Without (transcript-only): ${stats.sessionsWithoutAN}`);
  console.log(`  Skipped: ${stats.sessionsSkipped}`);
  console.log(`Entries created: ${stats.entriesCreated}`);
  console.log(`Entries deduplicated: ${stats.entriesDeduplicated}`);
  console.log(`Nodes updated: ${stats.nodesUpdated.size}`);
  console.log(`\nVerdict distribution:`);
  for (const [verdict, count] of Object.entries(stats.verdictCounts).sort()) {
    console.log(`  ${verdict}: ${count}`);
  }
  console.log(`\nTier distribution (all BDI categories):`);
  console.log(`  ${'Tier'.padEnd(14)} ${'Before'.padEnd(8)} ${'After'.padEnd(8)} Delta`);
  for (const tier of ['untested', 'cited', 'contested', 'well_tested'] as const) {
    const before = tiersBefore[tier] ?? 0;
    const after = tiersAfter[tier] ?? 0;
    const delta = after - before;
    console.log(`  ${tier.padEnd(14)} ${String(before).padEnd(8)} ${String(after).padEnd(8)} ${delta >= 0 ? '+' : ''}${delta}`);
  }

  // Lag audit: nodes cited in debates but lacking a debate_tested record.
  // A persistent non-zero lag with harvest-on-save enabled (t/3330) signals
  // the harvest is silently failing — treat as an alertable condition.
  const lag = auditDebateTestedLag(nodeMap, debatesDir);
  console.log(`\nDebate-tested lag check (cited in debates, no record):`);
  console.log(formatLagLine(sessionFiles.length, lag));
  if (lag.lag > 0) {
    console.log(`  Lagging node IDs (first 10): ${lag.lagNodeIds.slice(0, 10).join(', ')}`);
  }

  if (writeMode) {
    console.log('\nWriting updated taxonomy files...');
    for (const [filename, data] of povFiles) {
      const filePath = path.join(taxonomyDir, filename);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
      console.log(`  Wrote ${filename}`);
    }
    console.log('Done.');
  } else {
    console.log('\n[DRY RUN] No files written. Use --write to apply changes.');
  }

  return stats;
}

// ── CLI entry point ───────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('backfillDebateTested.ts') ||
    process.argv[1]?.endsWith('backfillDebateTested.js')) {
  const writeMode = process.argv.includes('--write');
  const repoRoot = path.resolve(import.meta.dirname ?? '.', '..', '..');
  console.log(`Repo root: ${repoRoot}`);
  console.log(`Mode: ${writeMode ? 'WRITE' : 'DRY RUN'}\n`);
  runBackfill(repoRoot, writeMode);
}
