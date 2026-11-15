// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3257 (T2, epic t/3248) — POST /api/taxonomy/relevant-nodes: server-side taxonomy relevance
// selection. The server becomes a SECOND caller of the exact pure fn the client uses
// (lib/debate/relevanceSelection.selectRelevantTaxonomy) — no reimplementation, parity by
// construction — so the debate client no longer fetches the ~400MB synthetic corpus to score
// client-side (the t/3165 architectural fast-follow). The corpus (nodeEmbeddings) is assembled
// server-side via the SHARED lib helper assembleNodeEmbeddings; only tiny per-session state crosses
// the wire up ({nodeId,score}[] + provenance down).
//
// PARITY CONTRACT (the load-bearing gate, → TL GV before the T3 client flip, t/3257#8): given the
// same corpus + session + params, this endpoint's selection === today's client
// getRelevantTaxonomyContext selection (taxonomyContext.ts:363-372), order-preserving. This handler
// mirrors that call site field-for-field. Two embed cbs, each mirroring its client counterpart so the
// vectors are identical BY CONSTRUCTION (t/3257#18/#22):
//   - corpus (assembleNodeEmbeddings)      → BATCH  ai.computeEmbeddings   (client: api.computeEmbeddings)
//   - selectRelevantTaxonomy.embed         → per-text ai.computeQueryEmbedding (client: api.computeQueryEmbedding)

import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { log } from '../logger.js';
import * as fileIO from '../storage/fileIO.js';
import * as ai from '../ai/aiBackends.js';
import { getPovDoctrinalBoundaries } from '../../../../lib/debate/poverInfo.js';
import { resolvePoverInfo } from '../../../../lib/debate/soulDocLoader.js';
import { getAssembledCorpus } from './corpusAssemblyCache.js';
import {
  selectRelevantTaxonomy,
  type ANClaimInput,
} from '../../../../lib/debate/relevanceSelection.js';
import type { TagSelection } from '../../../../lib/debate/types/session.js';
import type { SpeakerId } from '../../../../lib/debate/types.js';

// The debate speaker's camp — the request `pov` is the full POV file name (matches the client's
// state[pov] read + POVER_INFO.pov). Situations ('cc') nodes are always loaded alongside.
const POV_FILE_KEYS = new Set(['accelerationist', 'safetyist', 'skeptic']);

interface RelevantNodesBody {
  pov: string;
  topic: string;
  recentTranscript: string;
  threshold?: number;
  /** t/424: optional pool size. Absent = the selection defaults (3 per category, 35 total), so debate callers are unchanged. */
  minPerCategory?: number;
  maxTotal?: number;
  tagSelection?: TagSelection;
  session?: {
    anClaimEmbeddings?: ANClaimInput[];
    lineageFrame?: { cluster_id: string; label?: string }[];
    sourceType?: string;
    excludeGreatestHits?: boolean;
    greatestHitsList?: string[];
  };
}

/** Boundary + topic-query embed cb — per-text ai.computeQueryEmbedding, mirrors the client's
 *  api.computeQueryEmbedding (t/3257#22). The corpus (batch) embed lives in corpusAssemblyCache. */
const queryEmbed = (texts: string[]): Promise<number[][]> =>
  Promise.all(texts.map(t => ai.computeQueryEmbedding(t)));

/** t/424: an optional pool size must be an integer in range. Absent is fine (the defaults apply). */
function inRange(v: unknown, lo: number, hi: number): boolean {
  return v === undefined || (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi);
}

/** The request's own checks: the topic and transcript strings, then the pool size (t/424, out-of-range refused, not clamped). */
function requestError(b: { topic?: unknown; recentTranscript?: unknown; minPerCategory?: unknown; maxTotal?: unknown }): string | null {
  if (typeof b.topic !== 'string' || typeof b.recentTranscript !== 'string') return 'Missing topic/recentTranscript';
  if (!inRange(b.minPerCategory, 1, 10)) return 'minPerCategory must be a positive integer, at most 10';
  if (!inRange(b.maxTotal, 1, 500)) return 'maxTotal must be a positive integer, at most 500';
  return null;
}

export function registerRelevantNodesRoutes(r: Router, _ctx: ServerCtx): void {
  const { post } = r;

  post('/api/taxonomy/relevant-nodes', async (_req, res, body) => {
    try {
      const b = (body ?? {}) as RelevantNodesBody;
      const { pov, topic, recentTranscript } = b;
      if (!POV_FILE_KEYS.has(pov)) { error(res, `Invalid or missing pov (expected accelerationist|safetyist|skeptic)`, 400); return; }
      const requestErr = requestError(b);
      if (requestErr) { error(res, requestErr, 400); return; }

      // ── Corpus (main-pinned + process-memoized): povNodes + situations + synthetic → nodeEmbeddings.
      // Shared with /api/argument-network/attribution. ref:'main' makes base embeddings coherent with
      // the precomputed corpus AND immutable, enabling the memo (t/3297#8/#9). This is also the fix for
      // the shipped incoherence — base nodes previously read the session branch. ──
      const { nodeEmbeddings, povNodes, situationNodes } = await getAssembledCorpus(pov);

      // ── Other static selection inputs (per-request; NOT part of the embedded corpus) ──
      const policyRaw = await fileIO.readPolicyRegistry() as { policies?: { id: string; action: string; source_povs?: string[] }[] } | null;
      const policyRegistry = (policyRaw?.policies ?? []).map(p => ({ id: p.id, action: p.action, source_povs: p.source_povs }));

      const lineageRaw = await fileIO.readLineageCategories() as { mapping?: Record<string, { l2: string }> } | null;
      const lineageMapping = lineageRaw?.mapping; // verbatim passthrough (getLineageMapping equivalent, Rosetta p/528)

      const { soul } = resolvePoverInfo(pov as Exclude<SpeakerId, 'user'>, b.tagSelection);
      const doctrinalBoundaries = getPovDoctrinalBoundaries(soul);

      // ── Per-session (from the request body — the server cannot reconstruct these) ──
      const session = {
        anClaimEmbeddings: b.session?.anClaimEmbeddings ?? [],
        lineageFrame: b.session?.lineageFrame,
        sourceType: b.session?.sourceType,
        excludeGreatestHits: b.session?.excludeGreatestHits,
        greatestHitsList: b.session?.greatestHitsList,
      };

      const result = await selectRelevantTaxonomy({
        povNodes, situationNodes, policyRegistry, nodeEmbeddings, lineageMapping, doctrinalBoundaries,
        session,
        params: { pov, topic, recentTranscript, threshold: b.threshold, tagSelection: b.tagSelection, minPerCategory: b.minPerCategory, maxTotal: b.maxTotal },
        embed: queryEmbed,
      });

      log.api.info(
        { component: 'api', route: 'relevant-nodes', pov, selected: result.povNodes.length, situations: result.situationNodes.length },
        'relevant-nodes served',
      );
      json(res, result); // the full RelevantTaxonomyResult (W1) — client stops recomputing; passes through nodeSourceMap/injectionManifest/anchoring
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'server', level: 'error',
        message: 'Failed to compute relevant nodes',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      log.api.error({ component: 'api', route: 'relevant-nodes', err: String(err) }, 'relevant-nodes failed');
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });
}
