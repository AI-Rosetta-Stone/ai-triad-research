// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/298: an organization's relationships, grouped by edge type, honouring the edge's review status
// (Design ruling, p/25#140):
//   - rejected: never shown; it is left out of the group count, and a group with only rejected edges is dropped.
//   - proposed: shown and counted, marked `unreviewed` so the row can say so in text.
//   - approved, or no status (older data): shown as before.
import type { OrganizationEdge, OrganizationEdgeType } from '../../bridge/types';

export interface EdgePeer { id: string; rationale?: string; unreviewed: boolean }

export function groupVisibleEdges(edges: OrganizationEdge[], orgId: string): Map<OrganizationEdgeType, EdgePeer[]> {
  const grouped = new Map<OrganizationEdgeType, EdgePeer[]>();
  for (const edge of edges) {
    const status = edge.status?.trim().toLowerCase();
    if (status === 'rejected') continue;
    const peer = edge.source === orgId ? edge.target : edge.source;
    const list = grouped.get(edge.type) ?? [];
    list.push({ id: peer, rationale: edge.rationale, unreviewed: status === 'proposed' });
    grouped.set(edge.type, list);
  }
  return grouped;
}
