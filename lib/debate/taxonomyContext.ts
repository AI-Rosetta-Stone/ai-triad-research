// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Pure functions for formatting taxonomy data into BDI-structured context
 * for debate agent prompts. Extracted from useDebateStore for testability.
 */

import type { PovNode, SituationNode, GraphAttributes } from './taxonomyTypes.js';
import { interpretationText, isBdiInterpretation } from './taxonomyTypes.js';
import { POV_KEYS } from './types.js';
import { stripExcludes } from './helpers.js';
import { buildSituationRootLookup } from './taxonomyRelevance.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';

export interface PolicyRef {
  id: string;
  action: string;
  source_povs?: string[];
}

/** Per-POV situation "register" statements (belief/desire/intention) from the
 *  comp-linguist sidecar. Keyed by POV long-form (accelerationist/safetyist/skeptic). */
export interface SituationPovStatement {
  belief_statement?: string;
  desire_statement?: string;
  intention_statement?: string;
}

/** One situation entry in the sidecar. `ok: false` (or absent statements) = skip. */
export interface SituationStatementEntry {
  ok: boolean;
  statements?: Partial<Record<string, SituationPovStatement>>;
}

/** Sidecar shape: situation-id → entry. Extra top-level keys (e.g. `_provenance`)
 *  are ignored — lookups are only ever by situation node ID. */
export type SituationStatements = Record<string, SituationStatementEntry>;

export interface TaxonomyContext {
  povNodes: PovNode[];
  situationNodes: SituationNode[];
  policyRegistry?: PolicyRef[];
  /** Positional vulnerability entries extracted from steelman_vulnerability attributes. */
  vulnerabilities?: { nodeId: string; label: string; text: string; score: number }[];
  /** Relevance scores by node ID. When present, enables primary/supporting tiering. */
  nodeScores?: Map<string, number>;
}

/** Map taxonomy categories to BDI sections */
export const CATEGORY_TO_BDI: Record<string, { header: string; framing: string }> = {
  'Beliefs': {
    header: '=== YOUR EMPIRICAL GROUNDING (what you take as true) ===',
    framing: 'These are the factual claims and empirical observations that ground your worldview.',
  },
  'Desires': {
    header: '=== YOUR NORMATIVE COMMITMENTS (what you argue should happen) ===',
    framing: 'These are the goals and principles you argue from. They are normative commitments, not empirical claims.',
  },
  'Intentions': {
    header: '=== YOUR REASONING APPROACH (how you construct arguments) ===',
    framing: 'These are the methods, frameworks, and argumentative strategies you use to connect beliefs to desires.',
  },
};

/** Format a single node's graph attributes as compact context lines */
export function formatNodeAttributes(attrs: GraphAttributes | undefined): string[] {
  if (!attrs) return [];
  const lines: string[] = [];
  if (attrs.assumes && attrs.assumes.length > 0) {
    lines.push(`  Assumes: ${attrs.assumes.join('; ')}`);
  }
  if (attrs.steelman_vulnerability) {
    const sv = attrs.steelman_vulnerability;
    lines.push(`  Key vulnerability: ${typeof sv === 'string' ? sv : Object.values(sv).filter(Boolean).join(' | ')}`);
  }
  if (attrs.possible_fallacies && attrs.possible_fallacies.length > 0) {
    const fallacyList = attrs.possible_fallacies
      .filter(f => f.confidence !== 'borderline')
      .map(f => `${f.fallacy.replace(/_/g, ' ')} (${f.confidence})`)
      .join(', ');
    if (fallacyList) lines.push(`  Watch for: ${fallacyList}`);
  }
  if (attrs.epistemic_type) {
    lines.push(`  Epistemic type: ${attrs.epistemic_type}`);
  }
  return lines;
}

/** Configurable limits for formatTaxonomyContext. All optional — defaults match prior hardcoded values. */
export interface FormatContextConfig {
  maxNodes?: number;
  primaryCount?: number;
  /** Max Desires per turn. Desires show 1-15% utilization — capping reduces token waste. Default: 5. */
  maxDesires?: number;
  vulnMax?: number;
  vulnEnabled?: boolean;
  fallacyConfidence?: 'likely' | 'all';
  fallacyEnabled?: boolean;
  policyMax?: number;
  policyEnabled?: boolean;
  sitPrimary?: number;
  /**
   * CHESS: IDs of branch root nodes to inject deeply. When set, only nodes
   * within these branches get full injection; other branches inject top-level
   * nodes only (safety margin). When absent, all nodes injected (existing behavior).
   */
  relevantBranches?: Set<string>;
  /**
   * Per-POV situation register statements (comp-linguist sidecar, t/1450).
   * When present, own-POV belief/desire/intention statements are injected under
   * each matching situation node. Loaded engine-side (Node-only); renderer callers
   * omit it (keeps this browser-safe module free of `fs`). Absent/null = feature off.
   */
  situationStatements?: SituationStatements | null;
  /**
   * Enable the RETRIEVED CONTEXT block for ai-retrieved/unverified nodes (t/3264).
   * Default: true. Set false for CLI/legacy paths that do not want the structural split.
   * No-op today (no nodes have verification_status set); safe to land inert.
   */
  retrievedContextEnabled?: boolean;
  /**
   * debate_grounding register text per node ID (t/3366, useDebateGrounding).
   * When present for a node, replaces description as grounding text.
   * Computed engine-side; absent = feature off.
   */
  debateGroundingOverrides?: Map<string, string>;
  /**
   * Per-node statement text (t/348 chat cap). When it returns a string for a node, that text replaces
   * the node's description in the prompt line. Absent or undefined = unchanged default. Takes precedence over
   * debateGroundingOverrides for that node. Never description or plain_description (TL p/140#24).
   */
  statementFor?: (nodeId: string) => string | undefined;
  /**
   * Tagged node IDs with their selection mode (t/3996, chat Prioritize path).
   * When mode is 'prioritize': tagged nodes sort first within each BDI category
   * (secondary to nodeScores when both are present) and receive a ▲ prefix —
   * distinct from ★ (relevance-primary) so the two signals read as independent dimensions.
   * Scope mode needs no change here — callers pre-filter ctx.povNodes to tagged-only.
   */
  tagSelection?: { taggedIds: Set<string>; mode: 'prioritize' };
}

/** Generate per-node inline guidance lines from metadata.
 *  Maps epistemic_type → ARGUE, falsifiability → ATTACK VIA, assumes → PREMISES,
 *  steelman_vulnerability → VULNERABLE, doctrinally_anchored → DO NOT CONCEDE. */
export function generateNodeGuidance(node: PovNode, category: string): string[] {
  const lines: string[] = [];
  const ga = node.graph_attributes;

  // ARGUE line — derived from epistemic_type
  if (ga?.epistemic_type === 'empirical_claim') {
    lines.push('  ARGUE: cite specific data, peer-reviewed evidence, documented cases');
  } else if (ga?.epistemic_type === 'normative_prescription') {
    lines.push('  ARGUE: coherence with stated principles, precedent, tradeoff acknowledgment');
  } else if (ga?.epistemic_type === 'strategic_recommendation') {
    lines.push('  ARGUE: feasibility evidence, implementation precedent, cost-benefit');
  } else if (ga?.epistemic_type === 'interpretive_lens') {
    lines.push('  ARGUE: analytical framework coherence, explanatory power, counter-interpretations');
  }

  // ATTACK VIA — derived from falsifiability
  if (ga?.falsifiability === 'high') {
    lines.push('  ATTACK VIA: counter-evidence, methodological critique, replication failure');
  } else if (ga?.falsifiability === 'medium') {
    lines.push('  ATTACK VIA: scope limits, competing frameworks, edge cases');
  } else if (ga?.falsifiability === 'low') {
    lines.push('  ATTACK VIA: coherence challenge, analogical breakdown, generalization failure');
  }

  // PREMISES — from assumes (top 2, marked as attackable)
  if (ga?.assumes?.length) {
    const top2 = ga.assumes.slice(0, 2).map(a => `"${a}" — attackable`);
    lines.push('  PREMISES: ' + top2.join('; '));
  }

  // VULNERABLE — from steelman_vulnerability (merged inline)
  if (ga?.steelman_vulnerability) {
    const sv = ga.steelman_vulnerability;
    const svText = typeof sv === 'string' ? sv : Object.values(sv).filter(Boolean).join(' | ');
    if (svText) lines.push('  VULNERABLE: ' + svText);
  }

  // DO NOT CONCEDE — for doctrinally anchored nodes
  if (node.doctrinally_anchored) {
    lines.push('  DO NOT CONCEDE — doctrinal boundary');
  }

  return lines;
}

/** Compute weighted sort score: Beliefs use relevance×confidence, Desires use relevance×(priority/5), Intentions use relevance×(operationality/5). */
function weightedScore(node: PovNode, relevance: number, category: string): number {
  if (category === 'Beliefs' && node.confidence != null) {
    return relevance * node.confidence;
  }
  if (category === 'Desires' && node.priority != null) {
    return relevance * (node.priority / 5);
  }
  if (category === 'Intentions' && node.operationality != null) {
    return relevance * (node.operationality / 5);
  }
  return relevance;
}

/** Build inline weight label for a node: confidence for Beliefs, priority for Desires, operationality for Intentions. */
function nodeWeightLabel(node: PovNode, category: string): string {
  if (category === 'Beliefs' && node.confidence != null) {
    const conf = node.confidence;
    const anchor = node.doctrinally_anchored ? ', doctrinally anchored' : '';
    if (conf < 0.50) return ` [Speculative, confidence: ${conf.toFixed(2)}${anchor}]`;
    return ` (confidence: ${conf.toFixed(2)}${anchor})`;
  }
  if (category === 'Desires' && node.priority != null) {
    return ` (priority: ${node.priority}/5)`;
  }
  if (category === 'Intentions' && node.operationality != null) {
    return ` (operationality: ${node.operationality}/5)`;
  }
  return '';
}

/** Format taxonomy nodes into a BDI-structured context block for the LLM prompt */
/**
 * t/348: when statementFor is set, a node is rendered with its statement or not at all. An unresolved
 * node is omitted and WARNed, so description and debate_grounding never leak through the hook.
 */
function statementOrOmit(n: PovNode, cfg: FormatContextConfig): string | undefined {
  const text = cfg.statementFor?.(n.id);
  if (text === undefined) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', message: `statementFor returned no statement for ${n.id}; node omitted from the prompt (t/348)` });
  }
  return text;
}

/** RETRIEVED line text (t/348): with statementFor set, the same statement-or-omit rule; otherwise description, unchanged. */
function retrievedLineText(n: PovNode, cfg: FormatContextConfig): string | undefined {
  return cfg.statementFor ? statementOrOmit(n, cfg) : n.description;
}

/** POV line text (t/348, t/3366). Without statementFor: debate_grounding, else description (unchanged default). */
function nodePromptText(n: PovNode, cfg: FormatContextConfig): string | undefined {
  if (cfg.statementFor) return statementOrOmit(n, cfg);
  return cfg.debateGroundingOverrides?.get(n.id) ?? n.description;
}

export function formatTaxonomyContext(ctx: TaxonomyContext, pov: string, maxNodes?: number, config?: FormatContextConfig): string {
  const cfg = config ?? {};
  const limit = cfg.maxNodes ?? maxNodes ?? 50;

  // CHESS: filter to relevant branches + top-level safety margin
  let filteredNodes = ctx.povNodes;
  if (cfg.relevantBranches && cfg.relevantBranches.size > 0) {
    // Build parent→root lookup for branch membership
    const nodeMap = new Map(ctx.povNodes.map(n => [n.id, n]));
    const rootCache = new Map<string, string>();

    function findRoot(id: string): string {
      if (rootCache.has(id)) return rootCache.get(id)!;
      const node = nodeMap.get(id);
      if (!node || !node.parent_id) { rootCache.set(id, id); return id; }
      const root = findRoot(node.parent_id);
      rootCache.set(id, root);
      return root;
    }

    filteredNodes = ctx.povNodes.filter(n => {
      const root = findRoot(n.id);
      // Include if: in a relevant branch, or is a top-level node (safety margin)
      return cfg.relevantBranches!.has(root) || n.parent_id === null;
    });
  }

  // t/3264: Split by provenance — curated/absent → grounding block; ai-retrieved/unverified → RETRIEVED CONTEXT block
  const retrievedEnabled = cfg.retrievedContextEnabled !== false;
  const groundingNodes = retrievedEnabled
    ? filteredNodes.filter(n => !n.graph_attributes?.verification_status || n.graph_attributes.verification_status === 'curated')
    : filteredNodes;
  const retrievedNodes = retrievedEnabled
    ? filteredNodes.filter(n => n.graph_attributes?.verification_status === 'ai-retrieved' || n.graph_attributes?.verification_status === 'unverified')
    : [];

  const povSlice = groundingNodes.slice(0, limit);

  // Group POV nodes by category → BDI section
  const groups: Record<string, PovNode[]> = {
    'Beliefs': [],
    'Desires': [],
    'Intentions': [],
  };
  for (const n of povSlice) {
    const cat = n.category || 'Intentions';
    (groups[cat] ?? groups['Intentions']).push(n);
  }

  const lines: string[] = [];

  const hasScores = ctx.nodeScores && ctx.nodeScores.size > 0;
  const PRIMARY_COUNT = cfg.primaryCount ?? 3;
  const taggedIds = cfg.tagSelection?.taggedIds;
  const hasTagSelection = !!(taggedIds && taggedIds.size > 0);

  if (hasTagSelection || hasScores) {
    const legend = [
      ...(hasTagSelection ? ['▲ = tagged for this seat'] : []),
      ...(hasScores ? ['★ = most relevant to current topic'] : []),
    ].join(' · ');
    lines.push(`(${legend})`);
    lines.push('');
  }

  // Emit BDI sections in Beliefs → Desires → Intentions order
  for (const cat of ['Beliefs', 'Desires', 'Intentions'] as const) {
    const nodes = groups[cat];
    if (nodes.length === 0) continue;
    const bdi = CATEGORY_TO_BDI[cat];
    lines.push(bdi.header);
    lines.push(bdi.framing);

    // Add weighting instruction when confidence/priority data is present
    if (cat === 'Beliefs' && nodes.some(n => n.confidence != null)) {
      lines.push('Ordered by evidential confidence. Lead with well-supported claims. When you cite a low-confidence Belief, acknowledge the uncertainty explicitly.');
    } else if (cat === 'Desires' && nodes.some(n => n.priority != null)) {
      lines.push('Ordered by priority. Lead with non-negotiable values. Lower-priority desires may be traded off in argument.');
    } else if (cat === 'Intentions' && nodes.some(n => n.operationality != null)) {
      lines.push('Ordered by operationality. Lead with concrete, actionable strategies. Lower-operationality intentions provide framing context but should not anchor your primary argument.');
    }

    // Sort: tagged-first (primary key, when tagSelection present), then weighted score (secondary)
    let sorted = nodes;
    if (hasTagSelection || hasScores) {
      sorted = [...nodes].sort((a, b) => {
        if (hasTagSelection) {
          const aTag = taggedIds!.has(a.id) ? 0 : 1;
          const bTag = taggedIds!.has(b.id) ? 0 : 1;
          if (aTag !== bTag) return aTag - bTag;
        }
        if (hasScores) {
          const relA = ctx.nodeScores!.get(a.id) ?? 0;
          const relB = ctx.nodeScores!.get(b.id) ?? 0;
          return weightedScore(b, relB, cat) - weightedScore(a, relA, cat) || a.id.localeCompare(b.id);
        }
        return a.id.localeCompare(b.id);
      });
    }

    // Cap Desires — lowest BDI utilization (1-15%), capped to reduce token waste
    if (cat === 'Desires') {
      const maxDesires = cfg.maxDesires ?? 5;
      sorted = sorted.slice(0, maxDesires);
    }

    for (let i = 0; i < sorted.length; i++) {
      const n = sorted[i];
      const isTagged = hasTagSelection && taggedIds!.has(n.id);
      const isPrimary = isTagged || !hasScores || i < PRIMARY_COUNT;
      const prefix = isTagged ? '▲ ' : (hasScores && i < PRIMARY_COUNT ? '★ ' : '  ');

      if (isPrimary) {
        const text = nodePromptText(n, cfg);
        if (text === undefined) continue;
        const weightLabel = nodeWeightLabel(n, cat);
        lines.push(`${prefix}[${n.id}]${weightLabel}`);
        lines.push(`  "${n.label}" — ${stripExcludes(text)}`);
        const sv = n.graph_attributes?.steelman_vulnerability;
        if (sv) {
          const svText = typeof sv === 'string' ? sv : Object.values(sv).filter(Boolean).join(' | ');
          if (svText) lines.push(`  Vulnerability: ${svText}`);
        }
        // t/3269: classifications are always AI-generated — drop by default until
        // a classification-level verified signal exists.
      } else {
        lines.push(`${prefix}[${n.id}] "${n.label}"`);
      }
    }
    lines.push('');
  }

  // Reasoning watchlist — configurable confidence filter
  // t/3273 gate co-location: NOT dropped by t/3269 blanket-drop because the opponent-dismissal
  // ceiling-adoption mechanism is absent here — injection is self-directed (own povSlice only),
  // tail-positioned (after all BDI grounding), and confidence-gated ('likely' filter). Worst case
  // is mild self-hedging, a different/lower threat class than the 25% unfair-dismissal validated
  // in t/3262. Residual chill risk from systematic bias deferred to future classification_source axis.
  const fallacyLines: string[] = [];
  const fallacyEnabled = cfg.fallacyEnabled ?? true;
  const fallacyFilter = cfg.fallacyConfidence ?? 'likely';
  if (fallacyEnabled) for (const n of povSlice) {
    if (n.graph_attributes?.possible_fallacies && n.graph_attributes.possible_fallacies.length > 0) {
      const likely = n.graph_attributes.possible_fallacies.filter(f => fallacyFilter === 'all' || f.confidence === 'likely');
      for (const f of likely) {
        fallacyLines.push(`- [${n.id}] ${n.label}: ${f.fallacy.replace(/_/g, ' ')} — ${f.explanation}`);
      }
    }
  }
  if (fallacyLines.length > 0) {
    lines.push('=== REASONING WATCHLIST (errors to self-monitor) ===');
    lines.push('These are reasoning patterns you tend toward. Self-monitor — if you catch yourself using one, flag it explicitly rather than letting it pass.');
    lines.push(...fallacyLines.slice(0, 10));
    lines.push('');
  }

  // t/3264: RETRIEVED CONTEXT block — structurally separate from grounding block to prevent false-claim laundering
  if (retrievedNodes.length > 0) {
    lines.push('=== RETRIEVED CONTEXT (external reference — not your established beliefs) ===');
    lines.push('The following claims were retrieved from external sources or generated by AI enrichment.');
    lines.push('They are candidate evidence — evaluate them critically; do not treat as personal grounding.');
    lines.push('');
    for (const n of retrievedNodes) {
      const text = retrievedLineText(n, cfg);
      if (text === undefined) continue;
      const vs = n.graph_attributes?.verification_status ?? 'unverified';
      const weightLabel = nodeWeightLabel(n, n.category || 'Beliefs');
      lines.push(`  [${n.id}]${weightLabel} (${vs})`);
      lines.push(`  "${n.label}" — ${stripExcludes(text)}`);
    }
    lines.push('');
  }

  // Situations section — hierarchy-grouped with Lost-in-the-Middle ordering
  if (ctx.situationNodes.length > 0) {
    const SIT_PRIMARY = cfg.sitPrimary ?? 5;
    const otherPovs = POV_KEYS.filter(p => p !== pov);
    // t/1450: own-POV register statements from the comp-linguist sidecar (engine-side only).
    const sitStatements = cfg.situationStatements ?? null;
    const injectedStatementIds: string[] = [];

    lines.push('=== SITUATIONS (contested concepts — cite sit- IDs in taxonomy_refs) ===');
    lines.push("These are contested concepts where perspectives diverge. When your argument engages a concept listed here, CITE its sit- ID in your taxonomy_refs — this tracks which contested concepts the debate actually addressed. Your interpretation differs from others'; understanding their full position helps you identify genuine disagreements.");

    // Build hierarchy grouping when parent_id data is available
    const hasHierarchy = ctx.situationNodes.some(n => n.parent_id != null);
    let orderedNodes: SituationNode[];
    let primaryCounter = 0;

    if (hasHierarchy) {
      const rootLookup = buildSituationRootLookup(ctx.situationNodes);
      const nodeMap = new Map(ctx.situationNodes.map(n => [n.id, n]));

      // Group by root category
      const groups = new Map<string, SituationNode[]>();
      for (const n of ctx.situationNodes) {
        const rootId = rootLookup.get(n.id) ?? n.id;
        const members = groups.get(rootId) ?? [];
        members.push(n);
        groups.set(rootId, members);
      }

      // Sort nodes within each group by relevance
      for (const [, members] of groups) {
        if (hasScores) {
          members.sort((a, b) => (ctx.nodeScores!.get(b.id) ?? 0) - (ctx.nodeScores!.get(a.id) ?? 0) || a.id.localeCompare(b.id));
        }
      }

      // Score each group: max node score within the group
      const groupScores: { rootId: string; label: string; score: number; members: SituationNode[] }[] = [];
      for (const [rootId, members] of groups) {
        const rootNode = nodeMap.get(rootId);
        const label = rootNode?.label ?? rootId;
        const maxScore = hasScores
          ? Math.max(...members.map(n => ctx.nodeScores!.get(n.id) ?? 0))
          : 0;
        groupScores.push({ rootId, label, score: maxScore, members });
      }
      groupScores.sort((a, b) => b.score - a.score);

      // Lost-in-the-Middle ordering: #1 first, #2 last, #3 second, #4 second-to-last...
      const litm: typeof groupScores = [];
      let lo = 0, hi = groupScores.length;
      for (let i = 0; i < groupScores.length; i++) {
        if (i % 2 === 0) {
          litm[lo++] = groupScores[i];
        } else {
          litm[--hi] = groupScores[i];
        }
      }

      // Emit grouped nodes with category headers
      orderedNodes = [];
      for (const group of litm) {
        if (group.members.length === 0) continue;

        lines.push('');
        lines.push(`## ${group.label}`);
        for (const n of group.members) {
          const isPrimary = primaryCounter < SIT_PRIMARY;
          _renderSituationNode(lines, n, isPrimary, pov, otherPovs, sitStatements, injectedStatementIds);
          primaryCounter++;
        }
      }
    } else {
      // Flat fallback — no hierarchy data
      let sortedSit: SituationNode[] = hasScores
        ? [...ctx.situationNodes].sort((a, b) => (ctx.nodeScores!.get(b.id) ?? 0) - (ctx.nodeScores!.get(a.id) ?? 0) || a.id.localeCompare(b.id))
        : [...ctx.situationNodes];
      // Lost-in-the-Middle ordering: #1 first, #2 last, #3 second, #4 second-to-last…
      const litm: SituationNode[] = new Array(sortedSit.length);
      let lo = 0, hi = sortedSit.length;
      for (let i = 0; i < sortedSit.length; i++) {
        if (i % 2 === 0) litm[lo++] = sortedSit[i];
        else litm[--hi] = sortedSit[i];
      }
      sortedSit = litm;
      for (let i = 0; i < sortedSit.length; i++) {
        _renderSituationNode(lines, sortedSit[i], i < SIT_PRIMARY, pov, otherPovs, sitStatements, injectedStatementIds);
      }
    }

    // t/1450 (AC3): telemetry proving the flag-gated injection actually fired. Reuse the
    // existing `turn.situation_inject` EventType; disambiguate from the engine's
    // situation-SELECTION event via component: 'taxonomy-context'. Browser-safe: the
    // recorder is a no-op when unset, and renderer callers never pass situationStatements.
    if (sitStatements && injectedStatementIds.length > 0) {
      getGlobalRecorder()?.record({
        type: 'turn.situation_inject',
        component: 'taxonomy-context',
        level: 'info',
        message: `Injected own-POV register statements for ${injectedStatementIds.length} situation(s)`,
        data: { situation_ids: injectedStatementIds, count: injectedStatementIds.length, pov },
      });
    }
  }

  // Policy registry section — configurable limit, with top 3 marked as primary
  if (ctx.policyRegistry && ctx.policyRegistry.length > 0 && (cfg.policyEnabled ?? true)) {
    const POLICY_LIMIT = cfg.policyMax ?? 10;
    const POLICY_PRIMARY = 3;
    const policies = ctx.policyRegistry.slice(0, POLICY_LIMIT);

    lines.push('');
    lines.push('=== POLICY ACTIONS (reference by pol-NNN ID when relevant) ===');
    lines.push('These are concrete policy actions identified in the research. When your argument supports or opposes a specific policy, reference its ID in your policy_refs.');
    if (policies.length > POLICY_PRIMARY) {
      lines.push('(★ = most relevant to current topic)');
    }
    for (let i = 0; i < policies.length; i++) {
      const pol = policies[i];
      const povTag = pol.source_povs && pol.source_povs.length > 0
        ? ` (${pol.source_povs.join(', ')})`
        : '';
      const prefix = i < POLICY_PRIMARY ? '★ ' : '  ';
      lines.push(`${prefix}[${pol.id}] ${pol.action}${povTag}`);
    }
  }

  return lines.join('\n');
}

function _renderSituationNode(
  lines: string[],
  n: SituationNode,
  isPrimary: boolean,
  pov: string,
  otherPovs: string[],
  situationStatements: SituationStatements | null,
  injected: string[],
): void {
  lines.push(`${isPrimary ? '★ ' : '  '}[${n.id}] ${n.label}: ${stripExcludes(n.description)}`);

  // t/1450: flag-gated injection of the comp-linguist per-POV, per-BDI debate-register
  // statements for THIS node — own-POV only (never opponents', to avoid parroting).
  const entry = situationStatements?.[n.id];
  if (entry?.ok === true) {
    const own = entry.statements?.[pov];
    if (own && (own.belief_statement || own.desire_statement || own.intention_statement)) {
      lines.push(`  Register statements (your voice):`);
      if (own.belief_statement) lines.push(`    Belief: ${own.belief_statement}`);
      if (own.desire_statement) lines.push(`    Desire: ${own.desire_statement}`);
      if (own.intention_statement) lines.push(`    Intention: ${own.intention_statement}`);
      injected.push(n.id);
    }
  }

  const interp = n.interpretations?.[pov as keyof typeof n.interpretations];
  if (interp) {
    const myInterp = typeof interp === 'object' ? interp : undefined;
    if (isPrimary && myInterp && isBdiInterpretation(interp)) {
      lines.push(`  Your interpretation (BDI breakdown):`);
      lines.push(`    Belief: ${myInterp.belief}`);
      lines.push(`    Desire: ${myInterp.desire}`);
      lines.push(`    Intention: ${myInterp.intention}`);
    } else {
      lines.push(`  Your interpretation: ${interpretationText(interp)}`);
    }
  }

  if (isPrimary) {
    for (const p of otherPovs) {
      const val = n.interpretations?.[p as keyof typeof n.interpretations];
      if (val) {
        if (isBdiInterpretation(val)) {
          lines.push(`  ${p.charAt(0).toUpperCase() + p.slice(1)}:`);
          lines.push(`    Belief: ${val.belief}`);
          lines.push(`    Desire: ${val.desire}`);
          lines.push(`    Intention: ${val.intention}`);
        } else {
          lines.push(`  ${p.charAt(0).toUpperCase() + p.slice(1)}: ${interpretationText(val)}`);
        }
      }
    }
  } else {
    const otherInterps = otherPovs
      .map(p => ({ pov: p, text: interpretationText(n.interpretations?.[p as keyof typeof n.interpretations]) }))
      .filter(o => o.text.length > 0)
      .sort((a, b) => b.text.length - a.text.length || a.pov.localeCompare(b.pov));

    if (otherInterps.length > 0) {
      const most = otherInterps[0];
      lines.push(`  ${most.pov.charAt(0).toUpperCase() + most.pov.slice(1)}: ${most.text}`);
      for (const other of otherInterps.slice(1)) {
        const truncated = other.text.length > 120 ? other.text.slice(0, 117) + '...' : other.text;
        lines.push(`  ${other.pov.charAt(0).toUpperCase() + other.pov.slice(1)}: ${truncated}`);
      }
    }
  }
}

/** Instrumentation data for tracking what was injected vs what was used. */
export interface ContextInjectionManifest {
  [key: string]: unknown;
  povNodeIds: string[];
  povPrimaryIds: string[];
  situationNodeIds: string[];
  vulnerabilityCount: number;
  policyCount: number;
  totalTokenEstimate: number;
  /** Relevance scores for injected POV nodes (for calibration variance analysis). */
  nodeScores?: number[];
  /** Whether embedding or lexical fallback scoring was used. */
  scoring_mode?: 'embedding' | 'lexical';
}

/**
 * Compute the injection manifest — what node IDs would be injected for this context.
 * Call alongside formatTaxonomyContext and store on the transcript entry for usage analysis.
 */
export function computeInjectionManifest(
  ctx: TaxonomyContext,
  pov: string,
  maxNodes?: number,
  config?: FormatContextConfig,
): ContextInjectionManifest {
  const cfg = config ?? {};
  const limit = cfg.maxNodes ?? maxNodes ?? 50;
  const PRIMARY_COUNT = cfg.primaryCount ?? 3;
  const SIT_PRIMARY = cfg.sitPrimary ?? 5;

  // Replicate the same filtering/slicing logic as formatTaxonomyContext
  let filteredNodes = ctx.povNodes;
  if (cfg.relevantBranches && cfg.relevantBranches.size > 0) {
    const nodeMap = new Map(ctx.povNodes.map(n => [n.id, n]));
    const rootCache = new Map<string, string>();
    function findRoot(id: string): string {
      if (rootCache.has(id)) return rootCache.get(id)!;
      const node = nodeMap.get(id);
      if (!node || !node.parent_id) { rootCache.set(id, id); return id; }
      const root = findRoot(node.parent_id);
      rootCache.set(id, root);
      return root;
    }
    filteredNodes = ctx.povNodes.filter(n => {
      const root = findRoot(n.id);
      return cfg.relevantBranches!.has(root) || n.parent_id === null;
    });
  }

  const povSlice = filteredNodes.slice(0, limit);

  // Group by BDI to find primaries (same logic as formatTaxonomyContext)
  const groups: Record<string, typeof povSlice> = { 'Beliefs': [], 'Desires': [], 'Intentions': [] };
  for (const n of povSlice) {
    const cat = n.category || 'Intentions';
    (groups[cat] ?? groups['Intentions']).push(n);
  }

  const primaryIds: string[] = [];
  for (const cat of ['Beliefs', 'Desires', 'Intentions']) {
    const sorted = ctx.nodeScores
      ? groups[cat].sort((a, b) => {
          const relA = ctx.nodeScores!.get(a.id) ?? 0;
          const relB = ctx.nodeScores!.get(b.id) ?? 0;
          return weightedScore(b, relB, cat) - weightedScore(a, relA, cat) || a.id.localeCompare(b.id);
        })
      : groups[cat];
    for (let i = 0; i < Math.min(PRIMARY_COUNT, sorted.length); i++) {
      primaryIds.push(sorted[i].id);
    }
  }

  const sitSlice = (ctx.situationNodes ?? []).slice(0, 8);
  const sitIds = sitSlice.map(n => n.id);

  // Token estimate calibrated from real debate data (~200-300 chars/node ≈ 50-75 tokens)
  const tokenEst = povSlice.length * 125
    + Math.min(sitSlice.length, SIT_PRIMARY) * 250
    + Math.max(0, sitSlice.length - SIT_PRIMARY) * 50
    + (ctx.policyRegistry?.length ?? 0) * 40;
    // Note: vulnerability tokens now included in per-node inline guidance estimate

  // Collect relevance scores for injected nodes (for calibration parameter #9 variance analysis)
  const nodeScores = ctx.nodeScores
    ? povSlice.map(n => ctx.nodeScores!.get(n.id) ?? 0)
    : undefined;

  return {
    povNodeIds: povSlice.map(n => n.id),
    povPrimaryIds: primaryIds,
    situationNodeIds: sitIds,
    vulnerabilityCount: Math.min((ctx.vulnerabilities ?? []).length, cfg.vulnMax ?? 10),
    policyCount: Math.min((ctx.policyRegistry ?? []).length, cfg.policyMax ?? 10),
    totalTokenEstimate: tokenEst,
    nodeScores,
  };
}
