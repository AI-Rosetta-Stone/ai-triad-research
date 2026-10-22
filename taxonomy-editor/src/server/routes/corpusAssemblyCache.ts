// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3297: shared, version-free corpus-assembly memo for the two debate-scoring endpoints
// (/api/taxonomy/relevant-nodes + /api/argument-network/attribution). Both score AN claims against
// the SAME ~4144-node corpus, in different phases of a turn (relevance pre-turn, attribution
// post-turn extraction) — so re-assembling it per request is pure waste.
//
// WHY a plain process-lifetime Map (no gen key, no invalidation, no scale-out marker) — TL t/3297#8:
//   • The corpus is a PRECOMPUTED DEPLOY ASSET (embeddings.json base vectors + synthetic .npy). A PUT
//     doesn't re-embed; the vectors are boot-loaded and fixed for the process's life.
//   • Reads are pinned to `ref:'main'` (below), and PUTs only ever write per-user SESSION BRANCHES,
//     never main (writeTaxonomyFile → session ref). So the main-branch corpus is IMMUTABLE at runtime.
//   • Immutable + identical across replicas ⇒ zero cross-replica staleness ⇒ no invalidation, no
//     in-memory job-store marker needed (conditions 1+3 dissolved, t/3297#8/#11).
//
// COHERENCE (the fix TL confirmed, t/3297#9/#10): base node embeddings are derived from node
// label/description via computeEmbeddings (cache-backed by the precomputed embeddings.json). Reading
// base nodes from a user's session branch would score edited text against main-branch synthetic
// vectors — an incoherent corpus ("illusory fidelity"). Pinning ref:'main' makes base + synthetic
// coherent AND makes the corpus immutable (enabling this memo). Blast-radius (t/3297#11): a session
// branch is created off main only on first edit, so non-editing users read main anyway — the pin is a
// no-op for them and a strict coherence improvement for the rare in-session node-editor.

import * as fileIO from '../storage/fileIO.js';
import * as ai from '../ai/aiBackends.js';
import {
  assembleNodeEmbeddings,
  type NodeEmbeddingMap,
  type SelectRelevantTaxonomyInput,
} from '../../../../lib/debate/relevanceSelection.js';
import { buildSupersessionIndex } from '../../../../lib/debate/supersession.js';

type PovNode = SelectRelevantTaxonomyInput['povNodes'][number];
type SituationNode = SelectRelevantTaxonomyInput['situationNodes'][number];

export interface AssembledCorpus {
  nodeEmbeddings: NodeEmbeddingMap;
  allNodeIds: string[];
  povNodes: PovNode[];
  situationNodes: SituationNode[];
}

/** Corpus embed cb — BATCH ai.computeEmbeddings, the same server ONNX the client's api.computeEmbeddings
 *  bridge routes to → vector-identical by construction (t/3257#22). Shared by both endpoints. */
export const corpusEmbed = (texts: string[], ids?: string[]): Promise<number[][]> =>
  ai.computeEmbeddings(texts, ids, undefined, { requester: 'corpus-assembly' }).then(r => r.vectors);

/** Map loadSyntheticEmbeddings() ({pov,vectors}) → the {nodeId: vectors[][]} shape assembleNodeEmbeddings wants. */
function synthVectorsForAssembly(
  synth: Record<string, { pov: string; vectors: number[][] }> | null,
): Record<string, number[][]> | null {
  if (!synth) return null;
  const out: Record<string, number[][]> = {};
  for (const [nodeId, entry] of Object.entries(synth)) out[nodeId] = entry.vectors;
  return out;
}

// Per-pov process-lifetime memo (≤3 entries: accelerationist/safetyist/skeptic). The main corpus is
// immutable at runtime, so an entry is never invalidated. In-flight de-dup: a second concurrent caller
// for the same pov awaits the same promise instead of assembling twice.
const cache = new Map<string, Promise<AssembledCorpus>>();

/** Assemble (or return the memoized) main-branch corpus for `pov`. The base node text (povNodes +
 *  situations) is read pinned to `ref:'main'` so it's coherent with the precomputed embeddings and
 *  immutable — see the module header. */
export function getAssembledCorpus(pov: string): Promise<AssembledCorpus> {
  const cached = cache.get(pov);
  if (cached) return cached;
  const built = assemble(pov).catch((err) => {
    // Don't memoize a failed assembly — a transient read/embed error must not poison the cache for the
    // process's life; the next request retries.
    cache.delete(pov);
    throw err;
  });
  cache.set(pov, built);
  return built;
}

async function assemble(pov: string): Promise<AssembledCorpus> {
  const povFile = await fileIO.readTaxonomyFile(pov, { ref: 'main' }) as { nodes?: PovNode[] };
  // t/4433: score only the selectable set, as loadTaxonomy does. Superseded nodes stay in the file
  // for history but must never be relevance candidates, attribution targets or grounding nodes.
  const allPovNodes = povFile?.nodes ?? [];
  const { isSuperseded } = buildSupersessionIndex(allPovNodes);
  const povNodes = allPovNodes.filter(n => !isSuperseded(n.id));
  const sitFile = await fileIO.readTaxonomyFile('situations', { ref: 'main' }) as { nodes?: SituationNode[] };
  const situationNodes = sitFile?.nodes ?? [];
  // loadSyntheticEmbeddings already reads with { ref: 'main' } internally (fileIO).
  const synth = synthVectorsForAssembly(await fileIO.loadSyntheticEmbeddings());
  const { nodeEmbeddings, allNodeIds } = await assembleNodeEmbeddings(pov, povNodes, situationNodes, corpusEmbed, synth);
  return { nodeEmbeddings, allNodeIds, povNodes, situationNodes };
}

/** Test-only: drop the memo so a test can re-assemble with fresh mocks. */
export function __resetCorpusCacheForTest(): void {
  cache.clear();
}
