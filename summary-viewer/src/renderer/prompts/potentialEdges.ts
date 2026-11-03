// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Builds the system and user prompts for discovering potential edges between
 * an unmapped concept and existing taxonomy nodes.
 */

export function buildPotentialEdgesSystemPrompt(): string {
  return `You are a research analyst for the AI Triad project.

Your task is to discover potential typed, directed edges between an UNMAPPED CONCEPT
(a concept found in a source document that has not yet been added to the taxonomy) and
existing taxonomy nodes.

These edges help the researcher understand how the new concept relates to the existing
knowledge graph before deciding whether to add it.

EDGE TYPE VOCABULARY:

  SUPPORTS (directional: concept → target)
    The concept directly strengthens or provides evidence for the target.

  CONTRADICTS (bidirectional)
    The concept and target make incompatible claims.

  ASSUMES (directional: concept → target)
    The concept depends on the target being true.

  WEAKENS (directional: concept → target)
    The concept provides evidence or reasoning that undermines the target.

  RESPONDS_TO (directional: concept → target)
    The concept was formulated as a direct response to or rebuttal of the target.

  TENSION_WITH (bidirectional)
    The concept and target exist in structural tension — they pull in different
    directions without being directly contradictory.

  INTERPRETS (directional: concept → target)
    The concept provides a POV-specific reading or reframing of the target.

  SUPPORTED_BY (directional: concept → target)
    The concept is backed by evidence or authority found in the target.

  COMPLEMENTS (directional: concept → target)
    The concept enhances or completes the target without directly supporting it.

By default, edges go FROM the concept TO existing nodes (concept → target).
Set "inbound": true to propose edges in the reverse direction (target → concept).

EDGE ATTRIBUTES:

For each proposed edge, provide:
  confidence (required, number 0.5-1.0): Your confidence the edge genuinely exists.
  weight (required, number 0.1-1.0): How strong the relationship is (independent of
    confidence). 0.8-1.0 = central, 0.5-0.8 = significant, 0.1-0.5 = peripheral.
  rationale (required, string): 1-2 sentences explaining WHY this edge exists.
  strength (optional, "strong" | "moderate" | "weak"): Qualitative label matching weight.

RULES:
  - Be precise. Every edge must be justified by the actual content of both the concept and node.
  - Do not propose edges based on superficial keyword overlap.
  - Cross-POV edges are especially valuable.
  - Aim for 3-12 edges. Fewer is fine if relationships are sparse.
  - Return ONLY valid JSON. No markdown fences, no preamble, no commentary.`;
}

export function buildPotentialEdgesUserPrompt(
  concept: { label: string; description: string; pov: string; category: string },
  candidateNodes: Array<{ id: string; label: string; description: string; pov: string; category: string }>,
): string {
  const conceptBlock = `UNMAPPED CONCEPT:
  Label: ${concept.label}
  Description: ${concept.description}
  Suggested POV: ${concept.pov}
  Suggested Category: ${concept.category}`;

  const candidateBlock = candidateNodes
    .map(n => `  ${n.id} [${n.pov}/${n.category}] ${n.label}: ${n.description.slice(0, 120)}`)
    .join('\n');

  return `${conceptBlock}

CANDIDATE TAXONOMY NODES:
${candidateBlock}

OUTPUT SCHEMA:
{
  "edges": [
    {
      "type": "TENSION_WITH",
      "target": "saf-desires-001",
      "inbound": false,
      "bidirectional": true,
      "confidence": 0.85,
      "weight": 0.9,
      "rationale": "Explanation of why this edge exists.",
      "strength": "strong"
    }
  ]
}

CONSTRAINTS:
  - Each "target" MUST be a valid node ID from the candidate list above.
  - "inbound" true means the edge goes FROM the target TO the concept (target → concept).
  - "inbound" false (default) means concept → target.
  - "bidirectional" must be true for CONTRADICTS and TENSION_WITH.
  - "confidence" must be between 0.5 and 1.0.
  - Return ONLY the JSON object.`;
}
