// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { POV_META, type PovMetaKey } from '@lib/electron-shared/povMeta';
import { useState, useEffect } from 'react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import type { GraphAttributes } from '../../types/taxonomy';
import { resolveDescription, DescriptionToggle } from './DescriptionToggle';
import './LinkedNodePreview.css';

const POV_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(POV_META).map(([k, v]) => [k, v.label]),
);

const CONFLICT_STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  resolved: 'Resolved',
  'wont-fix': "Won't Fix",
};

interface EnrichedAttrs {
  interpretation?: string | { summary?: string };
  key_points?: string[];
}

function renderConflictPreview(conflict: any, nodeId: string) {
  return (
    <div className="linked-node-preview">
      <div className="linked-node-preview-header">
        <span className="linked-node-preview-pov">Conflict</span>
        <span className="linked-node-preview-category">{CONFLICT_STATUS_LABELS[conflict.status] ?? conflict.status}</span>
        <span className="linked-node-preview-id">{nodeId}</span>
      </div>
      <div className="linked-node-preview-label">{conflict.claim_label}</div>
      <div className="linked-node-preview-description">{conflict.description}</div>
      {conflict.instances.length > 0 && (
        <div className="linked-node-preview-attrs">
          <span className="linked-node-preview-attr-label">Instances:</span>
          <span>{conflict.instances.length}</span>
        </div>
      )}
    </div>
  );
}

function renderPolicyPreview(policy: any, referencingNodes: any[], nodeId: string) {
  return (
    <div className="linked-node-preview">
      <div className="linked-node-preview-header">
        <span className="linked-node-preview-pov">Policy</span>
        <span className="linked-node-preview-id">{nodeId}</span>
      </div>
      <div className="linked-node-preview-label">{policy.action}</div>
      {policy.description && <div className="linked-node-preview-description">{policy.description}</div>}
      <div className="linked-node-preview-attrs">
        <span className="linked-node-preview-attr-label">Referenced by:</span>
        <span>{referencingNodes.length} node{referencingNodes.length === 1 ? '' : 's'}</span>
      </div>
    </div>
  );
}

function renderNodePreview(
  node: any,
  nodeId: string,
  povLabel: string,
  category: string | null,
  descMode: 'plain' | 'formal',
  setDescMode: (mode: 'plain' | 'formal') => void,
) {
  const enriched = node.graph_attributes as (GraphAttributes & EnrichedAttrs) | undefined;
  const interpretation = enriched?.interpretation;
  const keyPoints = enriched?.key_points ?? [];
  const hasPlain = Boolean(node.plain_description);

  const descResult = resolveDescription(node, descMode);
  if (descResult.isGenerating && !node.plain_description) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'LinkedNodePreview',
      level: 'warn',
      message: `Node ${nodeId} has no plain_description, falling back to formal`,
    });
  }

  return (
    <div className="linked-node-preview">
      <div className="linked-node-preview-header">
        <span className="linked-node-preview-pov">{povLabel}</span>
        {category && <span className="linked-node-preview-category">{category}</span>}
        <span className="linked-node-preview-id">{nodeId}</span>
        <DescriptionToggle mode={descMode} onToggle={setDescMode} hasPlainDescription={hasPlain} globalShortcut={false} />
      </div>
      <div className="linked-node-preview-label">{node.label}</div>
      <div className="linked-node-preview-description">{descResult.text}</div>
      {interpretation && (
        <div className="linked-node-preview-attrs">
          <span className="linked-node-preview-attr-label">Interpretation:</span>
          <span>{typeof interpretation === 'string' ? interpretation : interpretation.summary}</span>
        </div>
      )}
      {keyPoints.length > 0 && (
        <div className="linked-node-preview-attrs">
          <span className="linked-node-preview-attr-label">Key points:</span>
          <ul className="linked-node-preview-keypoints">
            {keyPoints.slice(0, 3).map((kp, i) => <li key={i}>{kp}</li>)}
            {keyPoints.length > 3 && <li className="linked-node-preview-more">+{keyPoints.length - 3} more</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Enriched fields that may live under `graph_attributes` at runtime but are not
 * part of the declared {@link GraphAttributes} shape (per the project data
 * convention — enriched fields vary per node). Accessed defensively.
 */

/**
 * Read-only inline preview of a linked taxonomy node, situation, or conflict,
 * resolved from the taxonomy store by id. Renders nothing for unknown ids.
 *
 * Shared by ConflictDetail (Conflicts tab) and CruxDetail (Cruxes tab) so both
 * present linked entities identically without navigating away.
 */
export function LinkedNodePreview({ nodeId }: { nodeId: string }) {
  const lookupPinnedData = useTaxonomyStore(s => s.lookupPinnedData);
  const [descMode, setDescMode] = useState<'plain' | 'formal'>('plain');

  const data = lookupPinnedData(nodeId);
  if (!data) return null;

  if (data.type === 'conflict') {
    return renderConflictPreview(data.conflict, nodeId);
  }

  if (data.type === 'policy') {
    return renderPolicyPreview(data.policy, data.referencingNodes, nodeId);
  }

  const node = data.node;
  const povLabel = data.type === 'pov' ? POV_LABELS[data.pov] ?? data.pov : 'Situation';
  const category = data.type === 'pov' ? data.node.category : null;

  return renderNodePreview(node, nodeId, povLabel, category, descMode, setDescMode);
}
