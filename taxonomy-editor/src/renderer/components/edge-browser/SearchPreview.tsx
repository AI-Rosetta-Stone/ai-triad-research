// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { allNodesById, povOfNode } from '../../hooks/useTaxonomyStore/superseded';
import { nodeTypeFromId } from '@lib/debate/nodeIdUtils';
import { NodeDetail } from '../taxonomy/NodeDetail';
import { SituationDetail } from '../debate/SituationDetail';
import { ConflictDetail } from '../conflict/ConflictDetail';

interface SearchPreviewProps {
  searchPreviewId: string | null;
  onClear?: () => void;
}

export function SearchPreview({ searchPreviewId, onClear }: SearchPreviewProps) {
  if (!searchPreviewId) return <div className="detail-panel-empty">Select a search result to preview</div>;

  const state = useTaxonomyStore.getState();
  const idType = nodeTypeFromId(searchPreviewId);

  const openInTree = (tab: string, id: string) => {
    useTaxonomyStore.getState().navigateToNode(tab as any, id);
    onClear?.();
  };

  if (idType === 'situation') {
    const node = state.situations?.nodes.find(n => n.id === searchPreviewId);
    if (node) return <SituationDetail node={node} readOnly chipDepth={0} />;
  } else if (idType === 'conflict') {
    const conflict = state.conflicts.find(c => c.claim_id === searchPreviewId);
    if (conflict) return <ConflictDetail conflict={conflict} readOnly chipDepth={0} />;
  } else {
    const node = allNodesById(state).get(searchPreviewId);
    const pov = node ? povOfNode(state, searchPreviewId) : undefined;
    if (node && pov) return (
      <>
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '4px 8px 0', gap: 6 }}>
          <button
            onClick={() => openInTree(pov, node.id)}
            title="Open this node in the tree view for full editing context"
            style={{ padding: '2px 10px', fontSize: '0.7rem', fontWeight: 600, borderRadius: 4, border: '1px solid var(--focus-ring)', background: 'none', color: 'var(--focus-ring)', cursor: 'pointer' }}
          >Open in Tree</button>
        </div>
        <NodeDetail pov={pov} node={node} chipDepth={0} />
      </>
    );
  }
  return <div className="detail-panel-empty">Node not found</div>;
}
