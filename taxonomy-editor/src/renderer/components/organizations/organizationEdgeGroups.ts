// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/298: an organization's relationships, grouped by edge type, honouring the edge's review status
// (Design ruling, p/25#140):
//   - rejected: never shown; it is left out of the group count, and a group with only rejected edges is dropped.
//   - proposed: shown and counted, marked `unreviewed` so the row can say so in text.
//   - approved, or no status (older data): shown as before.
// t/584 stopgap: a rationale that is pipeline diagnostics ("match_basis=…", written by Invoke-OrgClaimMatching)
// is not shown. It is removed at the source once t/584's data fix lands.
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import type { OrganizationEdge, OrganizationEdgeType } from '../../bridge/types';

export interface EdgePeer { id: string; rationale?: string; unreviewed: boolean }

const DIAGNOSTIC_RATIONALE = /^\s*match_basis=/;

export function groupVisibleEdges(edges: OrganizationEdge[], orgId: string): Map<OrganizationEdgeType, EdgePeer[]> {
  const grouped = new Map<OrganizationEdgeType, EdgePeer[]>();
  let hiddenRationales = 0;
  for (const edge of edges) {
    const status = edge.status?.trim().toLowerCase();
    if (status === 'rejected') continue;
    const peer = edge.source === orgId ? edge.target : edge.source;
    const diagnostic = edge.rationale !== undefined && DIAGNOSTIC_RATIONALE.test(edge.rationale);
    if (diagnostic) hiddenRationales++;
    const list = grouped.get(edge.type) ?? [];
    list.push({ id: peer, rationale: diagnostic ? undefined : edge.rationale, unreviewed: status === 'proposed' });
    grouped.set(edge.type, list);
  }
  if (hiddenRationales > 0) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'organization-detail', level: 'warn',
      message: `WARN: hid ${hiddenRationales} pipeline-diagnostic edge rationale(s) for ${orgId} (t/584 stopgap until the data is fixed)`,
    });
  }
  return grouped;
}
