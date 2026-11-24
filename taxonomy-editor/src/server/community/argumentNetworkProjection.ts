// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/196 (Security p/102#112): structural projection of argument_network and topic for the community
// copy. Used by the debate branch of projectAllowedValue in community.ts.

/** Argument-network node keys the community renderer reads. Excluded as owner-only: embedding and
 *  attribution_embedding (384-dim vectors, as Crux.embedding), verification_evidence (no community reader),
 *  and the item text and source_doc_id inside evidence_graph (projectArgumentNode keeps scores, ids,
 *  relation and similarity only). Security p/238#15. */
const COMMUNITY_AN_NODE_KEYS: ReadonlySet<string> = new Set([
  'id', 'text', 'attribution_text_genus', 'canonical_proposition', 'speaker', 'source_entry_id',
  'taxonomy_refs', 'turn_number', 'extraction_confidence', 'base_strength', 'computed_strength',
  'scoring_method', 'bdi_sub_scores', 'bdi_confidence', 'bdi_category', 'specificity', 'steelman_of',
  'steelman_check', 'verification_status', 'evidence_graph',
  'claim_taxonomy_attribution', 'vocabulary_tags', 'political_salience', 'topic_relevance',
]);

/** Argument-network edge keys the community renderer reads. `warrant` is free text the renderer reads
 *  only in owner-side diagnostics and the synthesis prompt, so it is excluded (Security p/102#118). */
const COMMUNITY_AN_EDGE_KEYS: ReadonlySet<string> = new Set([
  'id', 'source', 'target', 'type', 'attack_type', 'scheme', 'weight', 'argumentation_scheme',
  'critical_questions_addressed', 'strength',
]);

/** Structural projection of one argument-network edge. */
function projectArgumentEdge(edge: unknown): Record<string, unknown> | undefined {
  if (!edge || typeof edge !== 'object') return undefined;
  return Object.fromEntries(Object.entries(edge as Record<string, unknown>).filter(([k]) => COMMUNITY_AN_EDGE_KEYS.has(k)));
}

/** Structural projection of one argument-network node. */
function projectArgumentNode(node: unknown): Record<string, unknown> | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const out = Object.fromEntries(Object.entries(node as Record<string, unknown>).filter(([k]) => COMMUNITY_AN_NODE_KEYS.has(k)));
  const graph = out.evidence_graph;
  if (graph && typeof graph === 'object') {
    const g = graph as Record<string, unknown>;
    out.evidence_graph = {
      computed_strength: g.computed_strength,
      qbaf_iterations: g.qbaf_iterations,
      evidence_items: Array.isArray(g.evidence_items)
        ? g.evidence_items
            .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
            .map(i => ({ id: i.id, relation: i.relation, similarity: i.similarity }))
        : undefined,
    };
  }
  return out;
}

/** Structural projection of argument_network: nodes and edges are projected per item, and mutations
 *  are dropped. */
export function projectArgumentNetwork(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const an = value as Record<string, unknown>;
  return {
    nodes: Array.isArray(an.nodes)
      ? an.nodes.map(n => projectArgumentNode(n)).filter((n): n is Record<string, unknown> => n !== undefined)
      : [],
    edges: Array.isArray(an.edges)
      ? an.edges.map(e => projectArgumentEdge(e)).filter((e): e is Record<string, unknown> => e !== undefined)
      : [],
  };
}

/** topic.background is owner-only by default. topic is an object ({original, final, background}) or a
 *  plain string; only the object form carries background. */
export function projectTopic(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => k !== 'background'));
}
