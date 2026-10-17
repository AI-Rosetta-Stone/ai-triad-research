// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Grounding envelope builder for the inquiry pipeline (t/3577).
// Anchors an inquiry to the most relevant situation node and attaches the top-N
// POV nodes per camp by embedding similarity.

import type { GroundingEnvelope, NodeRef, Camp, AppliedTag, TagSelection } from '../inquiry/index.js';
import type { PovNode, SituationNode } from './taxonomyTypes.js';
import type { NodeEmbeddingMap } from './relevanceSelection.js';
import { applyTagSelection, checkTagScope } from './relevanceSelection.js';
import { TAG_BOOST_INCREMENT, TAG_SCOPE_MINIMUM_NODES } from './debateConfig.js';
import { cosineSimilarity } from '../embeddings/similarity.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';
import { ActionableError } from './errors.js';

function warn(message: string): void {
  getGlobalRecorder()?.record({ type: 'system.error', component: 'inquiryGrounding', level: 'warn', message });
}

export interface GroundingTaxonomy {
  povNodes: PovNode[];
  situationNodes: SituationNode[];
  nodeEmbeddings: NodeEmbeddingMap;
}

export interface GroundingOptions {
  /** Pin a specific situation as the anchor instead of deriving one by embedding. */
  situationId?: string;
  /** Maximum POV nodes to include per camp. Default: 3. */
  topNodesPerCamp?: number;
  /** Optional POV-scoped tag selection (t/3965). Filter/boost applies ONLY to the named POV's camp. */
  tagSelection?: TagSelection;
}

const DEFAULT_TOP_PER_CAMP = 3;

// Maps both file-name stamps (what embedding producers write, e.g. "skeptic") and
// camp codes (pass-through, e.g. "skp") to the canonical Camp type (t/4255).
const POV_NAME_TO_CAMP: Readonly<Record<string, Camp>> = {
  acc: 'acc', saf: 'saf', skp: 'skp', cc: 'cc',
  accelerationist: 'acc', safetyist: 'saf', skeptic: 'skp', 'cross-cutting': 'cc',
};

/**
 * Build a GroundingEnvelope for an inquiry question.
 *
 * 1. Embeds the question (and situation descriptions if no situationId is pinned).
 * 2. Selects the anchor situation by cosine similarity (or uses the pinned id).
 * 3. Scores every POV node with a precomputed embedding against the question vector.
 * 4. Returns the top-N nodes per camp as NodeRef arrays.
 *
 * ADR-001: returns an empty-but-valid envelope on zero-hit / empty-corpus inputs.
 * Each fallback path logs a WARN via the flight recorder.
 */
export async function buildGroundingEnvelope(
  question: string,
  taxonomy: GroundingTaxonomy,
  embed: (texts: string[]) => Promise<number[][]>,
  opts: GroundingOptions = {},
): Promise<{ envelope: GroundingEnvelope; appliedTag?: AppliedTag }> {
  const topN = opts.topNodesPerCamp ?? DEFAULT_TOP_PER_CAMP;

  if (taxonomy.povNodes.length === 0) {
    warn('buildGroundingEnvelope: empty povNodes corpus — returning empty envelope');
    return { envelope: { nodesByCamp: {} } };
  }

  // ── Embed question ────────────────────────────────────────────────────────
  let questionVectors: number[][];
  try {
    questionVectors = await embed([question]);
  } catch (err) {
    warn(`buildGroundingEnvelope: embed call failed (${String(err)}) — returning empty envelope`);
    return { envelope: { nodesByCamp: {} } };
  }

  const questionVec = questionVectors[0];
  if (!questionVec || questionVec.length === 0) {
    warn('buildGroundingEnvelope: embed returned empty vector for question — returning empty envelope');
    return { envelope: { nodesByCamp: {} } };
  }

  // ── Anchor situation ──────────────────────────────────────────────────────
  let anchorSituationId: string | undefined;
  let anchorSummary: string | undefined;

  if (opts.situationId !== undefined) {
    const pinned = taxonomy.situationNodes.find(s => s.id === opts.situationId);
    if (pinned) {
      anchorSituationId = pinned.id;
      anchorSummary = pinned.description;
    } else {
      warn(`buildGroundingEnvelope: pinned situationId '${opts.situationId}' not found — deriving anchor from embeddings`);
    }
  }

  if (anchorSituationId === undefined && taxonomy.situationNodes.length > 0) {
    // Embed all situation descriptions in one call alongside the question.
    const situationTexts = taxonomy.situationNodes.map(s => s.description || s.label);
    let situationVectors: number[][];
    try {
      situationVectors = await embed(situationTexts);
    } catch (err) {
      warn(`buildGroundingEnvelope: situation embed failed (${String(err)}) — anchor omitted`);
      situationVectors = [];
    }

    let bestScore = -Infinity;
    for (let i = 0; i < taxonomy.situationNodes.length; i++) {
      const vec = situationVectors[i];
      if (!vec || vec.length === 0) continue;
      const score = cosineSimilarity(questionVec, vec);
      if (score > bestScore) {
        bestScore = score;
        anchorSituationId = taxonomy.situationNodes[i].id;
        anchorSummary = taxonomy.situationNodes[i].description || taxonomy.situationNodes[i].label;
      }
    }
  } else if (taxonomy.situationNodes.length === 0) {
    warn('buildGroundingEnvelope: no situationNodes in corpus — anchor omitted');
  }

  // ── Score POV nodes by camp ────────────────────────────────────────────────
  const nodeById = new Map(taxonomy.povNodes.map(n => [n.id, n]));
  const byCamp = new Map<Camp, { score: number; node: PovNode }[]>();

  const warnedPovs = new Set<string>();
  for (const [nodeId, embedding] of Object.entries(taxonomy.nodeEmbeddings)) {
    const camp = POV_NAME_TO_CAMP[embedding.pov];
    if (!camp) {
      if (!warnedPovs.has(embedding.pov)) {
        warnedPovs.add(embedding.pov);
        warn(`buildGroundingEnvelope: unknown embedding.pov "${embedding.pov}" — node "${nodeId}" skipped`);
      }
      continue;
    }
    const node = nodeById.get(nodeId);
    if (!node) continue;

    const vec = embedding.vector;
    if (!vec || vec.length === 0) continue;

    const score = cosineSimilarity(questionVec, vec);
    if (!byCamp.has(camp)) byCamp.set(camp, []);
    byCamp.get(camp)!.push({ score, node });
  }

  const nodesByCamp: Partial<Record<Camp, NodeRef[]>> = {};

  // Tag scoping uses the same normalization table (t/3965 / t/4255).
  const tagCamp = opts.tagSelection ? POV_NAME_TO_CAMP[opts.tagSelection.pov] : undefined;
  let appliedTag: AppliedTag | undefined;

  // Pre-flight: refuse before the embedding loop so a tagged camp with no embeddings still refuses
  // (t/3965#13, t/4009). Floor counts only groundable nodes (tagged AND embedded).
  // Unembedded tagged nodes get a WARN — they exist but cannot be retrieved.
  if (opts.tagSelection && tagCamp) {
    const sel = opts.tagSelection;
    const taggedCampNodes = taxonomy.povNodes.filter(n => n.id.startsWith(`${tagCamp}-`));
    const embeddedIds = new Set(Object.keys(taxonomy.nodeEmbeddings));
    const scopeCheck = checkTagScope(taggedCampNodes, sel, embeddedIds);
    if (scopeCheck.unembeddedTaggedCount > 0) {
      warn(
        `buildGroundingEnvelope: ${scopeCheck.unembeddedTaggedCount} tagged node(s) for "${sel.tag}" in the ${sel.pov} camp have no embedding and cannot be grounded — run Update-TaxEmbeddings`,
      );
    }
    if (!scopeCheck.sufficient) {
      const taggedCount = taggedCampNodes.filter(n => (n.pov_tags ?? []).includes(sel.tag)).length;
      const groundableCount = scopeCheck.inScope.length;
      if (scopeCheck.reason === 'none-tagged') {
        throw new ActionableError({
          goal: `Ground Inquiry on ${sel.pov}/${sel.tag} in ${sel.mode} mode`,
          problem: taggedCount > 0
            ? `No groundable nodes for tag "${sel.tag}" in the ${sel.pov} camp: ${taggedCount} tagged but none have embeddings (${taggedCampNodes.length} camp nodes checked)`
            : `No nodes carry tag "${sel.tag}" in the ${sel.pov} camp (${taggedCampNodes.length} camp nodes checked)`,
          location: 'inquiryGrounding.ts › buildGroundingEnvelope',
          nextSteps: taggedCount > 0
            ? ['Run Update-TaxEmbeddings to add embeddings for the tagged nodes.']
            : [`Add pov_tags: ["${sel.tag}"] to at least one node under the ${sel.pov} POV.`],
        });
      } else {
        // reason === 'below-floor' (Scope only)
        throw new ActionableError({
          goal: `Ground Inquiry on ${sel.pov}/${sel.tag} in Scope mode`,
          problem: `Scope is too thin: ${groundableCount} groundable tagged nodes of ${taggedCampNodes.length} in the ${sel.pov} camp (${taggedCount} tagged, ${scopeCheck.unembeddedTaggedCount} without embeddings; minimum groundable: ${TAG_SCOPE_MINIMUM_NODES})`,
          location: 'inquiryGrounding.ts › buildGroundingEnvelope',
          nextSteps: [
            `Add pov_tags: ["${sel.tag}"] to at least ${TAG_SCOPE_MINIMUM_NODES} nodes under the ${sel.pov} POV, then run Update-TaxEmbeddings.`,
            'Or switch to Prioritize mode to boost tagged nodes without filtering the rest.',
          ],
        });
      }
    }
  }

  for (const [camp, scored] of byCamp.entries()) {
    let activeScoredEntries = scored;

    if (opts.tagSelection && camp === tagCamp) {
      const sel = opts.tagSelection;
      const { filteredNodes, excludedCount, boostIds } = applyTagSelection(scored.map(s => s.node), sel);

      if (sel.mode === 'scope') {
        const filteredIds = new Set(filteredNodes.map(n => n.id));
        activeScoredEntries = scored.filter(s => filteredIds.has(s.node.id));
        if (excludedCount > 0) {
          warn(`buildGroundingEnvelope: scope tag '${sel.tag}' on '${sel.pov}' excluded ${excludedCount} untagged nodes from grounding`);
        }
        appliedTag = { pov: sel.pov, tag: sel.tag, mode: sel.mode, included: filteredNodes.length, excludedUntagged: excludedCount };
      } else {
        const boostSet = new Set(boostIds);
        activeScoredEntries = scored.map(s =>
          boostSet.has(s.node.id) ? { ...s, score: s.score + TAG_BOOST_INCREMENT } : s,
        );
        appliedTag = { pov: sel.pov, tag: sel.tag, mode: sel.mode, included: boostIds.length, excludedUntagged: 0 };
      }
    }

    activeScoredEntries.sort((a, b) => b.score - a.score);
    nodesByCamp[camp] = activeScoredEntries.slice(0, topN).map(({ node }) => ({
      nodeId: node.id,
      label: node.label,
      camp,
    }));
  }

  // ADR-001: warn when a camp returns zero nodes (embedding corpus gap)
  for (const camp of ['acc', 'saf', 'skp', 'cc'] as Camp[]) {
    const refs = nodesByCamp[camp];
    if (!refs || refs.length === 0) {
      warn(`buildGroundingEnvelope: zero nodes selected for camp '${camp}' — embedding corpus may be incomplete`);
    }
  }

  const envelope: GroundingEnvelope = { nodesByCamp };
  if (anchorSituationId !== undefined) envelope.anchorSituationId = anchorSituationId;
  if (anchorSummary !== undefined) envelope.anchorSummary = anchorSummary;

  return { envelope, appliedTag };
}
