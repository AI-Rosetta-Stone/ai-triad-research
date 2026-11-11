// t/348: chat synthetic-statement lookup (read-only). For each selected BDI node, returns the
// node's corpus statement closest to the chat query, or null so the renderer falls back to the
// node's description. Pure core: the IPC handler injects the embed and the corpus/vector loaders.

import { bestMatchingSyntheticStatement } from '../../../lib/debate/syntheticStatementLookup.js';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';

export type ChatSyntheticPov = 'accelerationist' | 'safetyist' | 'skeptic';

export interface ChatSyntheticStatementsInput {
  pov: ChatSyntheticPov;
  queryText: string;
  nodeIds: string[];
}

export interface ChatSyntheticStatementsDeps {
  /** Same embed as selectRelevantTaxonomy's queryEmbed (per-text query embedding). */
  embed: (texts: string[]) => Promise<number[][]>;
  /** Non-pruned corpus statement texts per node, in file order, for this POV. */
  nodeStatements: Record<string, string[]>;
  /** Node embedding vectors (row-aligned with nodeStatements), keyed by node id. */
  nodeVectors: Record<string, { vectors?: number[][] }>;
  /** Records a WARN. Callers route this to the flight recorder. */
  warn: (message: string) => void;
}

/** Corpus file prefix per POV (corpus_<prefix>.json / embeddings_<prefix>.npy). */
export const SYNTHETIC_POV_PREFIX: Record<ChatSyntheticPov, 'acc' | 'saf' | 'skp'> = {
  accelerationist: 'acc',
  safetyist: 'saf',
  skeptic: 'skp',
};

/** Group corpus entries per node: non-pruned, file order (same grouping as taxonomyLoader.ts). */
export function groupCorpusStatements(
  entries: { node_id: string; statement: string; pruned?: boolean }[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const entry of entries) {
    if (entry.pruned) continue;
    (out[entry.node_id] ??= []).push(entry.statement);
  }
  return out;
}

export async function chatSyntheticStatements(
  input: ChatSyntheticStatementsInput,
  deps: ChatSyntheticStatementsDeps,
): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  const nullAll = (): Record<string, string | null> => {
    for (const id of input.nodeIds) result[id] = null;
    return result;
  };

  // Embedding failure never throws: every node falls back to its description, one WARN per call.
  let queryVector: number[] | undefined;
  if (input.queryText.trim().length > 0) {
    try {
      const [vec] = await deps.embed([input.queryText]);
      if (Array.isArray(vec) && vec.length > 0) queryVector = vec;
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'taxonomy-handlers', level: 'warn',
        message: `chatSyntheticStatements: reason=embedding-unavailable pov=${input.pov} (${err instanceof Error ? err.message : String(err)})`,
      });
      return nullAll();
    }
  }
  if (!queryVector) {
    deps.warn(`chatSyntheticStatements: reason=embedding-unavailable pov=${input.pov} (empty query or no vector returned)`);
    return nullAll();
  }

  for (const nodeId of input.nodeIds) {
    const statements = deps.nodeStatements[nodeId];
    const vectors = deps.nodeVectors[nodeId]?.vectors;
    const usable = !!statements && statements.length > 0 && !!vectors && vectors.length === statements.length;
    if (!usable) {
      deps.warn(`chatSyntheticStatements: reason=no-usable-statements node=${nodeId} pov=${input.pov}`);
      result[nodeId] = null;
      continue;
    }
    result[nodeId] = bestMatchingSyntheticStatement(nodeId, queryVector, deps.nodeVectors, deps.nodeStatements) ?? null;
  }
  return result;
}
