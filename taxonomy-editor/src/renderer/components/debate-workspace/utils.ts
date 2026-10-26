// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { TranscriptEntry, TaxonomyRef } from '../../types/debate';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { allNodesById } from '../../hooks/useTaxonomyStore/superseded';
import { speakerLabel } from './speakerHelpers';
import { api } from '@bridge';
import { nodePovFromId } from '@lib/debate/nodeIdUtils';
import type { TabId } from '../../types/taxonomy';

// ── Speaker helpers ──────────────────────────────────────
// Defined in ./speakerHelpers (thin delegates to the shared resolveSpeaker, t/2256).
// Re-exported here so existing callers importing from './utils' are unaffected; the
// separate module keeps them out of reach of sibling test files that vi.mock('./utils').
// Use the direct `export ... from` form: an `import { speakerColor }` that is only
// re-exported (never called locally) gets elided under isolatedModules, which left
// utils.speakerColor undefined (t/2256). speakerLabel is imported above for local use.
export { speakerLabel, speakerColor } from './speakerHelpers';

// ── Policy action lookup ──────────────────────────────────

export function getPolicyAction(polId: string): string {
  const registry = useTaxonomyStore.getState().policyRegistry;
  if (!registry) return polId;
  const entry = registry.find(p => p.id === polId);
  return entry ? entry.action : polId;
}

// ── Grounding helpers ────────────────────────────────────

export function groundingLabel(baseStrength: number | undefined): string {
  if (baseStrength === undefined) return '';
  if (baseStrength >= 0.65) return 'Grounded';
  if (baseStrength >= 0.35) return 'Reasoned';
  return 'Asserted';
}

export const GROUNDING_COLORS: Record<string, string | undefined> = {
  Grounded: '#22c55e',
  Asserted: '#f59e0b',
};

// ── Strength band helper ─────────────────────────────────

export const STRENGTH_BAND = (v: number) =>
  v >= 0.8 ? { label: 'Strong', color: '#22c55e' }
  : v >= 0.5 ? { label: 'Moderate', color: '#3b82f6' }
  : v >= 0.3 ? { label: 'Weak', color: '#f59e0b' }
  : { label: 'Very Weak', color: '#ef4444' };

// ── Percentage formatter ─────────────────────────────────

export function pctFmt(v: number): string { return `${(v * 100).toFixed(0)}%`; }

// ── POV color map ────────────────────────────────────────

export const POV_COLOR_VAR: Record<string, string> = {
  accelerationist: 'var(--color-acc)',
  safetyist: 'var(--color-saf)',
  skeptic: 'var(--color-skp)',
  situations: 'var(--color-sit)',
};

// ── Taxonomy cross-navigation helpers ────────────────────

/** Map node_id prefix to the taxonomy tab and CSS color */
export function nodeIdToTab(nodeId: string): { tab: TabId; colorVar: string } {
  const pov = nodePovFromId(nodeId);
  if (pov) return { tab: pov as TabId, colorVar: POV_COLOR_VAR[pov] || 'var(--text-muted)' };
  return { tab: 'situations', colorVar: 'var(--text-muted)' };
}

/** Resolve a node_id to its label from the taxonomy store */
export function getNodeLabel(nodeId: string): string {
  const state = useTaxonomyStore.getState();
  const { tab } = nodeIdToTab(nodeId);

  if (tab === 'situations') {
    const node = state.situations?.nodes?.find((n: { id: string }) => n.id === nodeId);
    if (node) return node.label;
  } else {
    // t/4362: a transcript may cite a node now held out of state.<pov>.nodes as superseded.
    // allNodesById looks up the exact stored node across the full set (superseded included),
    // so a cited id still resolves to its as-cited label.
    const node = allNodesById(state).get(nodeId);
    if (node) return node.label;
  }
  return nodeId;
}

export function getNodeWeight(nodeId: string): { category?: string; confidence?: number; priority?: number; operationality?: number } | null {
  const state = useTaxonomyStore.getState();
  const { tab } = nodeIdToTab(nodeId);
  if (tab === 'situations') return null;
  const node = allNodesById(state).get(nodeId); // t/4362: exact stored node, superseded included
  if (!node) return null;
  return { category: node.category, confidence: node.confidence, priority: node.priority, operationality: node.operationality };
}

/** Navigate the main application window to a taxonomy node and focus it. */
export function focusMainWindowNode(nodeId: string): void {
  api.focusNodeInMainWindow(nodeId);
}

// ── Policy ref helpers ────────────────────────────────────

/** Combined taxonomy + policy refs entry type */
export type PolicyRefEntry = string | { policy_id: string; relevance: string };

export function resolvePolRef(ref: PolicyRefEntry): { id: string; relevance: string | null } {
  if (typeof ref === 'string') return { id: ref, relevance: null };
  return { id: ref.policy_id, relevance: ref.relevance };
}

// ── Explain prompt helpers ────────────────────────────────

export function buildExplainPrompt(entry: TranscriptEntry): string {
  const speaker = speakerLabel(entry.speaker);
  const refs = entry.taxonomy_refs || [];
  let prompt = `Explain this section of a debate between the Accelerationist, the Safetyist, and the Skeptic:\n\n`;
  prompt += `[${speaker} — ${entry.type}]\n${entry.content}\n`;
  if (refs.length > 0) {
    prompt += `\nTaxonomy references cited:\n`;
    for (const ref of refs) {
      const label = getNodeLabel(ref.node_id);
      prompt += `- ${ref.node_id} (${label}): ${ref.relevance}\n`;
    }
  }
  return prompt;
}

export function handleExplainEntry(entry: TranscriptEntry) {
  const prompt = buildExplainPrompt(entry);
  void api.clipboardWriteText(prompt);
  void api.openExternal('https://gemini.google.com/app');
}

/** t/4514: the right-click "Explain…" prompt for a selection, scoped to that excerpt only
 *  (not the whole entry) — kept separate from buildExplainPrompt's whole-entry scoping. */
export function buildSelectionExplainPrompt(selectedText: string): string {
  return `Explain this excerpt from a debate between the Accelerationist, the Safetyist, and the Skeptic:\n\n${selectedText}\n`;
}

/** t/4514: copy a prompt to the clipboard and open Gemini — the "Open in Gemini" escape hatch,
 *  now secondary to the inline in-app answer. Prompt-agnostic so it serves both the card's
 *  whole-entry prompt and the right-click selection prompt. */
export function openPromptInGemini(prompt: string): void {
  void api.clipboardWriteText(prompt);
  void api.openExternal('https://gemini.google.com/app');
}

// ── Markdown helpers ─────────────────────────────────────

/** Strip markdown headings the AI sometimes hallucinates at the top of a statement (e.g. "# Engine Thermometer Accelerator"). */
export function stripLeadingHeadings(text: string): string {
  return text.replace(/^(?:#{1,3}\s+.*\n*)+/, '').trimStart();
}

/** Fix markdown links broken by newlines inside `[text](url)` — AI models often wrap long URLs.
 *  Also repairs garbled DOI links: if the link text contains a (doi:...) parenthetical, extract
 *  the DOI and use it to reconstruct the correct URL, then clean up the display text. */
export function fixMarkdownLinks(text: string): string {
  return text.replace(/\[([^\]]*)\]\(\s*([\s\S]*?)\s*\)/g, (_match, linkText: string, url: string) => {
    let cleanUrl = url.replace(/\s+/g, '');
    let cleanText = linkText;

    // If the link text contains doi:..., extract the FIRST DOI and use it to fix the URL.
    // The AI often omits closing parens, so match flexibly: stop at whitespace, paren, or end.
    const doiMatch = linkText.match(/doi:\s*(10\.\d{4,9}\/\S+?)(?:\s|\)|$)/i);
    if (doiMatch) {
      cleanUrl = `https://doi.org/${doiMatch[1]}`;
      // Strip ALL doi parentheticals (with or without closing paren) and trailing junk
      cleanText = linkText
        .replace(/\s*\(?doi:[^)]*\)?/gi, '')
        .replace(/\s*\([A-Z]{1,5}\d{8,}\)/g, '')
        .replace(/\d+\)\]?$/, '')  // trailing "41)]" junk
        .trim();
    }

    return `[${cleanText || linkText}](${cleanUrl})`;
  });
}

/**
 * Rendered-text offset of a DOM point `(node, offset)` within `container` — the
 * length of the concatenated text-node content that precedes it. This lives in
 * the same rendered-text space CommentOverlay resolves against (its TreeWalker
 * concatenates text-node values), so a comment anchored with this offset round-
 * trips even when the selection spans inline markdown (**bold**, [links]) that
 * `selectedText.indexOf` on the raw markdown source would miss (t/1694).
 */
export function renderedOffsetOf(container: HTMLElement, node: Node, offset: number): number {
  const preRange = document.createRange();
  preRange.selectNodeContents(container);
  preRange.setEnd(node, offset);
  return preRange.toString().length;
}

// ── Tier metadata (shared across StatementCard + DebateWorkspace) ────────────

/** Tiers that render a structured analysis view (not prose text). Used to derive
 *  the active "mode" (Text vs Analysis) without a second store field. */
export const META_TIERS = new Set(['reasoning', 'terms', 'lineage', 'claims', 'convergence']);

/** Human-readable labels for every tier — single source of truth for both
 *  per-statement controls and the global toolbar (consolidates the previously
 *  duplicated maps; labels updated: Med→Medium, Detail→Detailed per t/2172). */
export const TIER_LABELS: Record<string, string> = {
  brief: 'Brief', medium: 'Medium', detailed: 'Detailed', reasoning: 'Plan',
  claims: 'Claims', terms: 'Terms', lineage: 'Lineage', convergence: 'Conv',
};

// ── Find-in-debate helpers ────────────────────────────────

export function countOccurrences(text: string, query: string): number {
  if (!query) return 0;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let count = 0, pos = 0;
  while ((pos = lower.indexOf(q, pos)) !== -1) { count++; pos += q.length; }
  return count;
}

// ── Adaptive phase types (shared by DebateActionBar + DebateWorkspace) ──

export type AdaptivePhase = 'confrontation' | 'argumentation' | 'concluding';

export const ADAPTIVE_PHASES: AdaptivePhase[] = ['confrontation', 'argumentation', 'concluding'];

export const ADAPTIVE_PHASE_LABELS: Record<AdaptivePhase, string> = {
  'confrontation': 'Confrontation',
  'argumentation': 'Argumentation',
  'concluding': 'Concluding',
};

export const ADAPTIVE_PHASE_COLORS: Record<AdaptivePhase, string> = {
  'confrontation': '#f59e0b',
  'argumentation': '#3b82f6',
  'concluding': '#10b981',
};
