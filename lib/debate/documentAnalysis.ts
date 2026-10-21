// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Document pre-analysis for debates grounded in a document or URL.
 * Extracts i-nodes (information nodes), maps them to taxonomy/policy items,
 * identifies cross-POV tension points, and produces a claims summary.
 */

import type { DocumentAnalysis, ContextRotStage } from './types.js';
import { POV_KEYS } from './types.js';
import { DOC_TRUNCATION_LIMIT } from './constants.js';
import type { PovNode, SituationNode } from './taxonomyTypes.js';
import type { PolicyRef } from './taxonomyContext.js';
import { stripDataUris } from './stripDataUris.js';

// ── Taxonomy sample builder ─────────────────────────────

interface TaxonomySampleInput {
  accelerationist: { nodes: PovNode[] };
  safetyist: { nodes: PovNode[] };
  skeptic: { nodes: PovNode[] };
  situations: { nodes: SituationNode[] };
  policyRegistry: PolicyRef[];
}

/**
 * Build a taxonomy sample for the analysis prompt.
 * When nodeScores are provided, nodes are ranked by relevance and capped per POV.
 * Without scores, includes all nodes (original behavior).
 */
export function buildTaxonomySample(
  taxonomy: TaxonomySampleInput,
  nodeScores?: Map<string, number>,
): string {
  const lines: string[] = [];
  const POV_LIMIT = 40;
  const SIT_LIMIT = 15;
  const POLICY_LIMIT = 15;

  for (const pov of POV_KEYS) {
    let nodes = taxonomy[pov].nodes;
    if (nodes.length === 0) continue;

    // Rank by score and cap when scores available
    if (nodeScores && nodeScores.size > 0) {
      nodes = [...nodes]
        .sort((a, b) => (nodeScores.get(b.id) ?? 0) - (nodeScores.get(a.id) ?? 0))
        .slice(0, POV_LIMIT);
    }

    lines.push(`${pov.toUpperCase()} NODES:`);
    for (const n of nodes) {
      lines.push(`  ${n.id}: ${n.label}`);
    }
    lines.push('');
  }

  let sitNodes = taxonomy.situations.nodes;
  if (sitNodes.length > 0) {
    if (nodeScores && nodeScores.size > 0) {
      sitNodes = [...sitNodes]
        .sort((a, b) => (nodeScores.get(b.id) ?? 0) - (nodeScores.get(a.id) ?? 0))
        .slice(0, SIT_LIMIT);
    }
    lines.push('SITUATION NODES:');
    for (const n of sitNodes) {
      lines.push(`  ${n.id}: ${n.label}`);
    }
    lines.push('');
  }

  let policies = taxonomy.policyRegistry;
  if (policies.length > 0) {
    policies = policies.slice(0, POLICY_LIMIT);
    lines.push('POLICY ITEMS:');
    for (const p of policies) {
      lines.push(`  ${p.id}: ${p.action}`);
    }
  }

  return lines.join('\n');
}

// ── Truncation (shared with sourceContext in prompts.ts) ─

function findLastHeading(text: string, limit: number): string | null {
  const slice = text.slice(0, limit);
  const re = /^#{1,4}\s+(.+)$/gm;
  let lastMatch: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) {
    lastMatch = m[1].trim();
  }
  return lastMatch;
}

interface TruncateResult {
  text: string;
  metrics: ContextRotStage;
}

function truncateDocument(text: string, limit: number = DOC_TRUNCATION_LIMIT): TruncateResult {
  if (text.length <= limit) {
    return {
      text,
      metrics: {
        stage: 'document_truncation',
        in_units: 'chars', in_count: text.length,
        out_units: 'chars', out_count: text.length,
        ratio: 1,
        flags: { chars_truncated: 0, sections_lost: 0, truncation_limit: limit },
      },
    };
  }
  const tailContent = text.slice(limit);
  const sectionsLost = (tailContent.match(/^#{1,4}\s/gm) || []).length;
  const lastHeading = findLastHeading(text, limit);
  const notice = lastHeading
    ? `\n\n[Document truncated at ~${Math.round(limit / 1000)}K characters. Content after '${lastHeading}' is not available.]`
    : `\n\n[Document truncated at ~${Math.round(limit / 1000)}K characters.]`;
  const truncated = text.slice(0, limit) + notice;
  return {
    text: truncated,
    metrics: {
      stage: 'document_truncation',
      in_units: 'chars', in_count: text.length,
      out_units: 'chars', out_count: truncated.length,
      ratio: Math.round((limit / text.length) * 10000) / 10000,
      flags: { chars_truncated: text.length - limit, sections_lost: sectionsLost, truncation_limit: limit },
    },
  };
}

// ── Analysis prompt ─────────────────────────────────────

export interface DocumentAnalysisPromptResult {
  prompt: string;
  truncationMetrics: ContextRotStage;
}

export function documentAnalysisPrompt(
  sourceContent: string,
  refinedTopic: string,
  activePovers: string[],
  taxonomySample: string,
): DocumentAnalysisPromptResult {
  const { text: stripped, strippedChars: _sc, uriCount: _uc } = stripDataUris(sourceContent);
  const { text: content, metrics: truncationMetrics } = truncateDocument(stripped);

  const prompt = `You are a neutral analyst preparing a structured breakdown of a document for a multi-perspective debate.

The debate topic is:
"${refinedTopic}"

The debate will involve these perspectives: ${activePovers.join(', ')}.

=== SOURCE DOCUMENT ===
${content}
=== END SOURCE DOCUMENT ===

=== AVAILABLE TAXONOMY NODES ===
${taxonomySample}
=== END TAXONOMY NODES ===

Analyze this document and extract its key claims as information nodes (i-nodes). For each i-node:
1. Extract the claim as a near-verbatim sentence or close paraphrase from the document
2. Classify its type: empirical (testable fact), normative (value judgment), definitional (how a term is defined or scoped), assumption (unstated premise), or evidence (data/example supporting a claim)
3. Rate extraction_confidence (0-1): how faithfully this i-node represents the source text
   - 0.9-1.0: near-verbatim quote, meaning fully preserved
   - 0.7-0.89: faithful paraphrase, core meaning intact
   - 0.5-0.69: inferred claim not explicitly stated but implied by the text
   - Below 0.5: do not include — you are editorializing beyond the source
   AMBIGUITY WARNING: If the source hedges, qualifies, or presents multiple interpretations of a claim, preserve that uncertainty in your extraction. Do NOT collapse "X may lead to Y" into "X leads to Y" or turn "some argue X while others argue Y" into just "X". Cap extraction_confidence at 0.6 for any claim where you resolved an ambiguity the source left open.
4. Write an "attribution_text" that rewrites the claim mirroring taxonomy node description format:
   "A [type] within [POV] discourse that [differentia]. Encompasses: [2-3 specific concepts from the claim]."
   Rules:
   a. Use BDI modal form — empirical claims as indicative assertions, normative claims as deontic statements
   b. Replace colloquial phrasing with domain vocabulary from the taxonomy nodes above
   c. Be specific — name concrete mechanisms, not broad categories
   d. Resolve pronouns/demonstratives to their referents from the document, decode metaphors into literal policy language, name the policy domain explicitly, expand acronyms
   e. 40-80 words. Do not add claims not in the original.
5. Map it to relevant taxonomy node IDs from the list above — only include IDs that actually appear in the taxonomy
6. Map it to relevant policy item IDs if applicable

Also identify tension points — places where the document's claims would provoke sharp disagreement between the debate perspectives.

Finally, write a claims summary paragraph: a readable prose summary (3-6 sentences) of what the document argues, suitable for display to users.

Rules:
- Extract ALL key claims. Do not limit the number of i-nodes.
- Each i-node ID must follow the pattern D-1, D-2, D-3, etc.
- taxonomy_refs and policy_refs arrays may be empty if no match exists
- Tension points should reference i-node IDs from the extracted claims
- The claims_summary should be neutral and descriptive, not argumentative

Return ONLY JSON (no markdown, no code fences):
{
  "claims_summary": "Prose paragraph summarizing the document's argument...",
  "i_nodes": [
    {
      "id": "D-1",
      "text": "near-verbatim claim from the document",
      "attribution_text": "A Belief within accelerationist discourse that recursive self-improvement in frontier models produces capability overhang exceeding current scalable oversight methods. Encompasses: recursive self-improvement dynamics, capability overhang measurement, oversight scaling limitations.",
      "type": "empirical",
      "extraction_confidence": 0.92,
      "taxonomy_refs": ["acc-goals-002"],
      "policy_refs": []
    }
  ],
  "tension_points": [
    {
      "description": "Brief description of the cross-POV friction",
      "i_node_ids": ["D-1", "D-3"],
      "pov_tensions": [
        { "pov": "accelerationist", "stance": "brief stance on this tension" },
        { "pov": "safetyist", "stance": "brief stance on this tension" }
      ]
    }
  ]
}`;

  return { prompt, truncationMetrics };
}

// ── Analysis context formatter (replaces sourceContext in debater prompts) ──

export function documentAnalysisContext(analysis: DocumentAnalysis): string {
  const lines: string[] = [
    '',
    '=== DOCUMENT ANALYSIS ===',
    `SUMMARY: ${analysis.claims_summary}`,
    '',
    'KEY CLAIMS (reference by D-ID in taxonomy_refs and my_claims targets, NOT in your prose text):',
  ];

  for (const node of analysis.i_nodes) {
    const refs = [
      ...node.taxonomy_refs,
      ...node.policy_refs,
    ].join(', ');
    const refStr = refs ? ` → ${refs}` : '';
    lines.push(`${node.id}: "${node.text}" [${node.type}]${refStr}`);
  }

  if (analysis.tension_points.length > 0) {
    lines.push('');
    lines.push('TENSION POINTS:');
    for (const tp of analysis.tension_points) {
      const nodeIds = tp.i_node_ids.join(' vs ');
      const stances = tp.pov_tensions.map(pt => `${pt.pov}: ${pt.stance}`).join('. ');
      lines.push(`- ${nodeIds}: ${tp.description}. ${stances}`);
    }
  }

  lines.push('=== END DOCUMENT ANALYSIS ===');

  return lines.join('\n');
}
