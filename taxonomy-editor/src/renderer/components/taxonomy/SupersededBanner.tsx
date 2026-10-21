// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4355 (t/4278): shown above a superseded node opened by id (a citation, a debate transcript, a URL). The node
// is history: shown as stored, read-only, with a link to the node that replaced it. No un-supersede action
// (TL p/336#633); supersession is changed only by the data tooling.

import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { allNodesById, povOfNode } from '../../hooks/useTaxonomyStore/superseded';
import type { PovNode } from '../../types/taxonomy';
import './SupersededBanner.css';

export function SupersededBanner({ node }: { node: PovNode }) {
  const setActiveTab = useTaxonomyStore(s => s.setActiveTab);
  const setSelectedNodeId = useTaxonomyStore(s => s.setSelectedNodeId);
  const state = useTaxonomyStore.getState();
  const targetId = node.superseded_by;
  if (!targetId) return null;
  const target = allNodesById(state).get(targetId);
  const targetPov = povOfNode(state, targetId);

  const openTarget = () => {
    if (!targetPov) return;
    setActiveTab(targetPov);
    setSelectedNodeId(targetId);
  };

  return (
    <div className="superseded-banner" role="note">
      <span className="superseded-banner-label">Superseded by</span>{' '}
      {target && targetPov ? (
        <button type="button" className="superseded-banner-link" onClick={openTarget}>
          {targetId}{target.label ? `: ${target.label}` : ''}
        </button>
      ) : (
        <span className="superseded-banner-missing">{targetId} (not found)</span>
      )}
      <span className="superseded-banner-note"> This node is kept as history and can't be edited.</span>
    </div>
  );
}
