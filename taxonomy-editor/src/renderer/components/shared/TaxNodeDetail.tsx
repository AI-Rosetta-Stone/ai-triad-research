// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Extracted unchanged from debate-workspace/TaxonomyRefs.tsx (t/4627) — Chat needs it inline
// too, so it lives here in shared/ rather than duplicated.

import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { TaxonomyRefDetail, type TaxRefNode } from '../taxonomy/TaxonomyRefDetail';

// Inline POV detail for a clicked taxonomy anchor/ref (t/1724). Resolved entirely
// from the client-side taxonomy store — no fetch. Shared by the PLAN and BDI views.
export function TaxNodeDetail({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const lookupPinnedData = useTaxonomyStore(s => s.lookupPinnedData);
  const data = lookupPinnedData(nodeId);
  // t/3401: pol-* ids resolve to a 'policy' PinnedData variant, not a POV/situations node.
  const node = data && data.type !== 'conflict' && data.type !== 'policy'
    ? (data.node as unknown as TaxRefNode)
    : undefined;
  const pov = data?.type === 'pov' ? data.pov
    : data?.type === 'situations' ? 'situations' : '';
  return (
    <TaxonomyRefDetail
      nodeId={nodeId}
      node={node}
      pov={pov}
      onClose={onClose}
      policy={data?.type === 'policy' ? data.policy : undefined}
      policyReferencingNodes={data?.type === 'policy' ? data.referencingNodes : undefined}
    />
  );
}
