// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Runtime validation layer for taxonomy and debate data.
 * Checks referential integrity, edge domain/range constraints,
 * and BDI consistency. Returns actionable diagnostics.
 */

import type { PovNode, SituationNode, Edge } from './taxonomyTypes.js';
import { nodePovFromId } from './nodeIdUtils.js';
import { POV_KEYS } from './types.js';
import { hasCcToSitMapping } from './ccSitMapping.js';

// ── Validation result ─────────────────────────────────────

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
  /** Node/edge ID that triggered the issue */
  entityId: string;
  /** Suggested fix */
  fix: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

function issue(
  severity: ValidationSeverity,
  code: string,
  entityId: string,
  message: string,
  fix: string,
): ValidationIssue {
  return { severity, code, entityId, message, fix };
}

// ── 1. Referential integrity ──────────────────────────────

export interface TaxonomyData {
  accelerationist: { nodes: PovNode[] };
  safetyist: { nodes: PovNode[] };
  skeptic: { nodes: PovNode[] };
  situations: { nodes: SituationNode[] };
  edges: Edge[];
}

/**
 * Check referential integrity across the taxonomy.
 * Validates that all references point to existing nodes.
 */
export function checkReferentialIntegrity(data: TaxonomyData): ValidationResult {
  const issues: ValidationIssue[] = [];

  // Build node ID sets
  const allPovNodes = new Map<string, PovNode>();
  const allPovIds = new Set<string>();
  const sitIds = new Set<string>();
  for (const pov of POV_KEYS) {
    for (const n of data[pov].nodes) {
      allPovNodes.set(n.id, n);
      allPovIds.add(n.id);
    }
  }
  for (const n of data.situations.nodes) sitIds.add(n.id);
  const allIds = new Set([...allPovIds, ...sitIds]);

  // Check edges reference valid nodes
  for (const e of data.edges) {
    if (!allIds.has(e.source)) {
      issues.push(issue('error', 'EDGE_DANGLING_SOURCE', e.source,
        `Edge source '${e.source}' does not exist in taxonomy`,
        `Remove the edge or add the missing node '${e.source}'`));
    }
    if (!allIds.has(e.target)) {
      issues.push(issue('error', 'EDGE_DANGLING_TARGET', e.target,
        `Edge target '${e.target}' does not exist in taxonomy`,
        `Remove the edge or add the missing node '${e.target}'`));
    }
  }

  // Check POV node references
  for (const [id, node] of allPovNodes) {
    // parent_id must reference a valid POV node
    if (node.parent_id && !allPovIds.has(node.parent_id)) {
      issues.push(issue('error', 'DANGLING_PARENT', id,
        `parent_id '${node.parent_id}' does not exist`,
        `Fix parent_id or set to null`));
    }

    // children must reference valid POV nodes
    for (const childId of node.children) {
      if (!allPovIds.has(childId)) {
        issues.push(issue('error', 'DANGLING_CHILD', id,
          `Child '${childId}' does not exist`,
          `Remove '${childId}' from children array`));
      }
    }

    // children/parent_id bidirectionality
    if (node.parent_id) {
      const parent = allPovNodes.get(node.parent_id);
      if (parent && !parent.children.includes(id)) {
        issues.push(issue('warning', 'PARENT_CHILD_MISMATCH', id,
          `Node lists parent '${node.parent_id}' but parent's children array does not include '${id}'`,
          `Add '${id}' to parent's children array`));
      }
    }

    // situation_refs must reference valid situation nodes or legacy cc- IDs
    for (const ref of node.situation_refs) {
      const isCcId = ref.startsWith('cc-');
      const isSitId = sitIds.has(ref);
      if (!isSitId && !isCcId) {
        issues.push(issue('error', 'DANGLING_SITUATION_REF', id,
          `situation_refs entry '${ref}' does not exist (not a sit- ID and not a mappable cc- ID)`,
          `Remove '${ref}' from situation_refs, or add the missing situation node`));
      } else if (isCcId && !hasCcToSitMapping()) {
        issues.push(issue('warning', 'UNMAPPED_CC_REFERENCE', id,
          `situation_refs entry '${ref}' is a legacy cc- ID but cc-to-sit mapping has not been loaded`,
          `Load the cc-to-sit mapping at startup before processing debates with legacy cc- references`));
      }
    }
  }

  // Check situation node linked_nodes
  for (const sit of data.situations.nodes) {
    for (const linked of sit.linked_nodes ?? []) {
      if (!allIds.has(linked)) {
        issues.push(issue('warning', 'DANGLING_LINKED_NODE', sit.id,
          `linked_nodes entry '${linked}' does not exist`,
          `Remove '${linked}' from linked_nodes`));
      }
    }
  }

  return { valid: issues.filter(i => i.severity === 'error').length === 0, issues };
}

// ── 2. Edge domain/range validator ────────────────────────

/**
 * Validate edge domain/range constraints per AIF conventions.
 */
export function checkEdgeDomainRange(
  edges: Edge[],
  allNodeIds: Set<string>,
  situationIds: Set<string>,
): ValidationResult {
  const issues: ValidationIssue[] = [];

  for (const e of edges) {
    // Skip edges with dangling refs — caught by referential integrity
    if (!allNodeIds.has(e.source) || !allNodeIds.has(e.target)) continue;

    const srcPov = nodePovFromId(e.source);
    const tgtPov = nodePovFromId(e.target);
    const isSitSource = situationIds.has(e.source);
    const isSitTarget = situationIds.has(e.target);

    switch (e.type) {
      case 'INTERPRETS':
        // INTERPRETS should target a situation node
        if (!isSitTarget) {
          issues.push(issue('warning', 'INTERPRETS_NON_SITUATION', `${e.source}->${e.target}`,
            `INTERPRETS edge targets '${e.target}' which is not a situation node`,
            `Change edge type or retarget to a situation node`));
        }
        break;

      case 'SUPPORTS':
      case 'CONTRADICTS':
        // Cross-POV SUPPORTS/CONTRADICTS is unusual (but not forbidden)
        if (srcPov && tgtPov && srcPov !== tgtPov && !isSitSource && !isSitTarget) {
          issues.push(issue('warning', 'CROSS_POV_SUPPORT_CONTRADICT', `${e.source}->${e.target}`,
            `${e.type} edge crosses POVs (${srcPov} → ${tgtPov}) — typically intra-POV`,
            `Verify this is intentional; consider TENSION_WITH for cross-POV relationships`));
        }
        break;

      case 'TENSION_WITH':
        // TENSION_WITH should be cross-POV or involve situation nodes
        if (srcPov && tgtPov && srcPov === tgtPov && !isSitSource && !isSitTarget) {
          issues.push(issue('warning', 'SAME_POV_TENSION', `${e.source}->${e.target}`,
            `TENSION_WITH between same-POV nodes (${srcPov}) — typically cross-POV`,
            `Verify this is intentional; consider CONTRADICTS for intra-POV conflicts`));
        }
        break;

      case 'CONVERGES_WITH':
        // CONVERGES_WITH should target a situation node (consensus point)
        if (!isSitTarget) {
          issues.push(issue('warning', 'CONVERGES_NON_SITUATION', `${e.source}->${e.target}`,
            `CONVERGES_WITH edge targets '${e.target}' which is not a situation node`,
            `CONVERGES_WITH indicates a POV node aligns with a consensus situation node`));
        }
        break;

      case 'WEAKENS':
      case 'RESPONDS_TO':
      case 'ASSUMES':
        break;

      default:
        issues.push(issue('warning', 'UNKNOWN_EDGE_TYPE', `${e.source}->${e.target}`,
          `Edge type '${e.type}' is not in the canonical 8-type vocabulary`,
          `Reclassify to a canonical type or remove`));
    }
  }

  return { valid: issues.filter(i => i.severity === 'error').length === 0, issues };
}

// ── 3. BDI consistency checker ────────────────────────────

/** Expected bdi_layer/resolvability alignment */
const BDI_RESOLVABILITY: Record<string, string> = {
  belief: 'resolvable_by_evidence',
  desire: 'negotiable_via_tradeoffs',
  intention: 'requires_term_clarification',
};

/**
 * Check BDI consistency: bdi_layer/resolvability alignment.
 */
export function checkBdiConsistency(
  disagreements: { point: string; bdi_layer?: string; resolvability?: string }[],
): ValidationResult {
  const issues: ValidationIssue[] = [];

  for (const d of disagreements) {
    if (!d.bdi_layer || !d.resolvability) continue;

    const expected = BDI_RESOLVABILITY[d.bdi_layer];
    if (expected && d.resolvability !== expected) {
      issues.push(issue('warning', 'BDI_RESOLVABILITY_MISMATCH', d.point,
        `bdi_layer '${d.bdi_layer}' typically pairs with '${expected}' but got '${d.resolvability}'`,
        `Verify classification — ${d.bdi_layer} disagreements are usually ${expected}`));
    }
  }

  return { valid: true, issues }; // Mismatches are warnings, not errors
}

// ── Combined validator ────────────────────────────────────

/**
 * Run all validators and return combined results.
 */
export function validateTaxonomy(data: TaxonomyData): ValidationResult {
  const allPovIds = new Set<string>();
  const sitIds = new Set<string>();
  for (const pov of POV_KEYS) {
    for (const n of data[pov].nodes) allPovIds.add(n.id);
  }
  for (const n of data.situations.nodes) sitIds.add(n.id);
  const allIds = new Set([...allPovIds, ...sitIds]);

  const refResult = checkReferentialIntegrity(data);
  const edgeResult = checkEdgeDomainRange(data.edges, allIds, sitIds);

  const allIssues = [...refResult.issues, ...edgeResult.issues];
  const hasErrors = allIssues.some(i => i.severity === 'error');

  return { valid: !hasErrors, issues: allIssues };
}
