// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Incremental debate_tested harvest triggered on debate session save.
 *
 * Tickets: t/3330
 *
 * CALLERS MUST:
 *   1. Gate behind a feature flag (default OFF) — harvest-on-save mutates
 *      version-controlled taxonomy files and shifts WELL_TESTED_EXCLUSION
 *      injection selection. Enable only after the coordinated corpus reconcile
 *      has landed (see t/3330 for sequencing).
 *   2. Run DEFERRED (setImmediate / after saveDebateSession returns) so the
 *      synchronous file I/O does not block the save-return latency path.
 *   3. Never propagate errors — wrap in try/catch; a harvest failure must
 *      never cause the debate save to fail.
 *
 * Scope: Electron-only. The web profile uses a different save path (server →
 * GitHub API) and requires a scheduled-sweep model instead (t/3331).
 */

import fs from 'fs';
import path from 'path';
import {
  harvestDebateTested,
  computeTierAndSortKey,
  setDescriptionHasher,
  categoryToBdiImpact,
} from './debateTested.js';
import { computeDescriptionHash } from './debateTestedHash.js';
import { resolveDataRoot } from './taxonomyLoader.js';
import { atomicWriteSync } from './persistence.js';
import type { PovNode, DebateTestedEntry, DebateTestedRecord } from './taxonomyTypes.js';
import type { ArgumentNetworkNode, ArgumentNetworkEdge } from './types.js';
import type { InjectionManifest } from './debateTested.js';

// debateTested.ts stays crypto-free for renderer bundling (t/1591).
setDescriptionHasher(computeDescriptionHash);

// In-process concurrency guard. atomicWriteSync is synchronous so this
// protects against re-entrant calls (e.g. two rapid saves queued via
// setImmediate). Does NOT protect cross-process races (e.g. a concurrent
// backfill --write run from the CLI).
let _harvesting = false;

// ── Public types ──────────────────────────────────────────────────────────

export interface HarvestableSession {
  id?: string;
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

export interface HarvestOnSaveResult {
  entriesCreated: number;
  nodesUpdated: string[];
  skipped: 'no-id' | 'concurrency-guard' | null;
}

export interface DebateTestedLagResult {
  total: number;
  harvested: number;
  lag: number;
  lagNodeIds: string[];
}

// ── Internal helpers ──────────────────────────────────────────────────────

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

function extractPovTaxonomyRefs(anNodes: ReadonlyArray<ArgumentNetworkNode>): string[] {
  const refs = new Set<string>();
  for (const node of anNodes) {
    for (const ref of node.taxonomy_refs ?? []) {
      const nodeId = typeof ref === 'string' ? ref : (ref as { node_id: string }).node_id;
      if (/^(acc|saf|skp)-/.test(nodeId)) refs.add(nodeId);
    }
  }
  return [...refs];
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Canonical "all refs" for a session — union of argument_network node refs and
 * transcript refs, deduped. Consumed by harvest (both backfill and harvestOnSave)
 * AND auditDebateTestedLag so the assertion and the harvest can never disagree on
 * what "all refs" means (t/3331).
 */
export function collectSessionTaxonomyRefs(session: HarvestableSession): string[] {
  const refs = new Set<string>();
  for (const anNode of session.argument_network?.nodes ?? []) {
    for (const ref of anNode.taxonomy_refs ?? []) {
      const nodeId = typeof ref === 'string' ? ref : (ref as { node_id: string }).node_id;
      if (/^(acc|saf|skp)-/.test(nodeId)) refs.add(nodeId);
    }
  }
  for (const entry of session.transcript ?? []) {
    for (const ref of entry.taxonomy_refs ?? []) {
      if (typeof ref === 'string' && /^(acc|saf|skp)-/.test(ref)) refs.add(ref);
    }
  }
  return [...refs];
}

/**
 * Incrementally update debate_tested records for the nodes engaged in a
 * single saved debate session. Idempotent: calling twice for the same
 * session yields entriesCreated=0 on the second call (nodeHasDebateEntry dedup).
 *
 * Only writes taxonomy files that actually changed (dirty-file optimization).
 */
export function harvestDebateTestedForSession(
  session: HarvestableSession,
  repoRoot: string,
): HarvestOnSaveResult {
  if (!session.id) return { entriesCreated: 0, nodesUpdated: [], skipped: 'no-id' };
  if (_harvesting) return { entriesCreated: 0, nodesUpdated: [], skipped: 'concurrency-guard' };

  _harvesting = true;
  try {
    const dataRoot = resolveDataRoot(repoRoot);
    const taxonomyDir = path.join(dataRoot, 'taxonomy', 'Origin');
    const POV_FILES = ['accelerationist.json', 'safetyist.json', 'skeptic.json'] as const;

    const povFiles = new Map<string, { pov: string; nodes: PovNode[]; [k: string]: unknown }>();
    const nodeMap = new Map<string, PovNode>();
    const nodeToFile = new Map<string, string>();

    for (const filename of POV_FILES) {
      const filePath = path.join(taxonomyDir, filename);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { pov: string; nodes: PovNode[] };
      povFiles.set(filename, data);
      for (const node of data.nodes) {
        nodeMap.set(node.id, node);
        nodeToFile.set(node.id, filename);
      }
    }

    const debateId = session.id;
    const date = session.created_at?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
    const pipelineVersion = session.app_version
      ? `harvest-on-save-v${session.app_version}-${date}`
      : 'harvest-on-save';

    const anNodes = session.argument_network?.nodes ?? [];
    const anEdges = session.argument_network?.edges ?? [];
    const nodesUpdated: string[] = [];
    let entriesCreated = 0;

    // All POV refs this session touches — union of AN + transcript, deduped.
    // Used for both the AN strength harvest and the cited-fallback below so
    // transcript-only refs in an AN session are never silently dropped (t/3331).
    const allRefs = collectSessionTaxonomyRefs(session);
    const harvestedByAN = new Set<string>();

    if (anNodes.length > 0) {
      // AN harvest: nodes in the argument network get full strength/verdict data.
      const povNodeIds = extractPovTaxonomyRefs(anNodes);
      const manifest: InjectionManifest = { povNodeIds };
      const results = harvestDebateTested({
        debateId,
        date,
        pipelineVersion,
        anNodes,
        anEdges: anEdges as ArgumentNetworkEdge[],
        injectionManifest: manifest,
        taxonomyNodes: nodeMap,
        concessions: [],
        refinedNodeIds: new Set(),
      });
      for (const result of results) {
        const node = nodeMap.get(result.nodeId);
        if (!node || nodeHasDebateEntry(node, debateId)) continue;
        if (!node.graph_attributes) node.graph_attributes = {};
        node.graph_attributes.debate_tested = result.updatedRecord;
        nodesUpdated.push(result.nodeId);
        entriesCreated++;
        harvestedByAN.add(result.nodeId);
      }
    }

    // Cited entries for refs not covered by AN harvest (includes transcript-only
    // refs in AN sessions and all refs in transcript-only sessions).
    for (const nodeId of allRefs) {
      if (harvestedByAN.has(nodeId)) continue;
      const node = nodeMap.get(nodeId);
      if (!node || !categoryToBdiImpact(node.category)) continue;
      if (nodeHasDebateEntry(node, debateId)) continue;
      const entry = createCitedEntry(debateId, date, pipelineVersion);
      const existing = node.graph_attributes?.debate_tested;
      if (!node.graph_attributes) node.graph_attributes = {};
      node.graph_attributes.debate_tested = mergeCitedEntry(entry, existing, node.description);
      nodesUpdated.push(nodeId);
      entriesCreated++;
    }

    if (entriesCreated > 0) {
      const dirtyFiles = new Set(
        nodesUpdated.map(id => nodeToFile.get(id)).filter((f): f is string => f != null),
      );
      for (const filename of dirtyFiles) {
        const data = povFiles.get(filename)!;
        atomicWriteSync(path.join(taxonomyDir, filename), JSON.stringify(data, null, 2) + '\n');
      }
    }

    return { entriesCreated, nodesUpdated, skipped: null };
  } finally {
    _harvesting = false;
  }
}

/**
 * The sweep's lag line. With 0 session files the audit read nothing, so "Lag: 0"
 * would be a green reading on no input; say so instead (t/709).
 */
export function formatLagLine(
  sessionFileCount: number,
  lag: { total: number; harvested: number; lag: number },
): string {
  if (sessionFileCount === 0) return '  Lag: not evaluated (no input)';
  return `  Cited nodes (BDI): ${lag.total}  |  Harvested: ${lag.harvested}  |  Lag: ${lag.lag}`;
}

/**
 * Audit nodes that appear in debate sessions but lack a debate_tested record.
 *
 * Use in backfill dry-run to surface the lag count. With harvest-on-save
 * enabled (flag on), a persistent non-zero lag indicates harvest is silently
 * failing — treat as an alertable condition.
 */
export function auditDebateTestedLag(
  nodeMap: Map<string, PovNode>,
  debatesDir: string,
): DebateTestedLagResult {
  const citedNodeIds = new Set<string>();

  if (fs.existsSync(debatesDir)) {
    const sessionFiles = fs.readdirSync(debatesDir)
      .filter(f => f.startsWith('debate-') && f.endsWith('.json'));

    for (const file of sessionFiles) {
      let session: HarvestableSession;
      try {
        session = JSON.parse(fs.readFileSync(path.join(debatesDir, file), 'utf-8')) as HarvestableSession;
      } catch {
        continue;
      }
      if (!session.id) continue;
      for (const nodeId of collectSessionTaxonomyRefs(session)) {
        citedNodeIds.add(nodeId);
      }
    }
  }

  let harvested = 0;
  const lagNodeIds: string[] = [];

  for (const nodeId of citedNodeIds) {
    const node = nodeMap.get(nodeId);
    if (!node || !categoryToBdiImpact(node.category)) continue;
    if (node.graph_attributes?.debate_tested) {
      harvested++;
    } else {
      lagNodeIds.push(nodeId);
    }
  }

  return { total: citedNodeIds.size, harvested, lag: lagNodeIds.length, lagNodeIds };
}
