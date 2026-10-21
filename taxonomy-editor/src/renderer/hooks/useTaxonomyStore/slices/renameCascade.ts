// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4355: one rename cascade for both POV-node moves (movePovNodeCategory and movePovNode), moved out of
// taxonomyDataSlice.ts. When a node's id changes, rewrite every reference to the old id:
//   - situations' linked_nodes;
//   - conflicts' linked_taxonomy_nodes;
//   - edge endpoints (previously only movePovNode did this, so a category move left edges dangling);
//   - references held inside superseded nodes (parent_id, children, superseded_by). That is the one write
//     that changes a superseded node (TL p/336#635); otherwise its references would dangle.
// Each touched file is added to `dirty`.

import type { SituationsFile, ConflictFile, EdgesFile } from '../../../types/taxonomy';
import { todayISO } from '../../../utils/idGenerator';
import { rewriteHeldRefs, type HeldByPov } from '../superseded';

interface CascadeInput {
  situations: SituationsFile | null;
  conflicts: ConflictFile[];
  edgesFile: EdgesFile | null;
  supersededNodes: HeldByPov;
}

export function cascadeRename(state: CascadeInput, oldId: string, newId: string, dirty: Set<string>): CascadeInput {
  const swap = (id: string) => (id === oldId ? newId : id);

  let situations = state.situations;
  if (situations?.nodes.some(n => (n.linked_nodes ?? []).includes(oldId))) {
    situations = {
      ...situations, last_modified: todayISO(),
      nodes: situations.nodes.map(n => ((n.linked_nodes ?? []).includes(oldId) ? { ...n, linked_nodes: n.linked_nodes.map(swap) } : n)),
    };
    dirty.add('situations');
  }

  let conflictsChanged = false;
  const conflicts = state.conflicts.map(c => {
    if (!(c.linked_taxonomy_nodes ?? []).includes(oldId)) return c;
    conflictsChanged = true;
    dirty.add(c.claim_id);
    return { ...c, linked_taxonomy_nodes: c.linked_taxonomy_nodes.map(swap) };
  });

  let edgesFile = state.edgesFile;
  if (edgesFile?.edges.some(e => e.source === oldId || e.target === oldId)) {
    edgesFile = { ...edgesFile, edges: edgesFile.edges.map(e => (e.source === oldId || e.target === oldId ? { ...e, source: swap(e.source), target: swap(e.target) } : e)) };
    dirty.add('edges');
  }

  const held = rewriteHeldRefs(state.supersededNodes, oldId, newId);
  for (const pov of held.changed) dirty.add(pov);

  return { situations, conflicts: conflictsChanged ? conflicts : state.conflicts, edgesFile, supersededNodes: held.held };
}
