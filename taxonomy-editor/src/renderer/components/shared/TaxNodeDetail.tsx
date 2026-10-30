// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Extracted unchanged from debate-workspace/TaxonomyRefs.tsx (t/4627) — Chat needs it inline
// too, so it lives here in shared/ rather than duplicated.

import { useEffect, useRef } from 'react';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { TaxonomyRefDetail } from '../taxonomy/TaxonomyRefDetail';
import { NodeDetail } from '../taxonomy/NodeDetail';
import { SituationDetail } from '../debate/SituationDetail';
import './TaxNodeDetail.css';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Inline POV detail for a clicked taxonomy anchor/ref (t/1724). Resolved entirely
// from the client-side taxonomy store — no fetch. Shared by the PLAN and BDI views.
//
// t/4654: pov/situations render the Taxonomy tool's own NodeDetail/SituationDetail
// (read-only) — the same view Op-Ed Why uses (OpEdReader.tsx:51-58) — so Debate Why and Chat
// replies match the Taxonomy tool instead of the legacy TaxonomyRefDetail card. Policy
// (pol-*) and unresolved ids have no NodeDetail/SituationDetail equivalent, so they keep
// TaxonomyRefDetail unchanged. Diagnostics renders TaxonomyRefDetail directly and is
// untouched by this.
export function TaxNodeDetail({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const lookupPinnedData = useTaxonomyStore(s => s.lookupPinnedData);
  const data = lookupPinnedData(nodeId);

  // t/4651: clicking a ref opens this below the ref list, often off-screen — scroll it into
  // view and move focus to it on open, then return focus to whatever opened it on close. The
  // container (not TaxonomyRefDetail's internal title span) is the focus target, so this stays
  // self-contained in the shared wrapper rather than threading a heading ref through
  // TaxonomyRefDetail, which Diagnostics also renders directly and shouldn't gain this behavior.
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  // Capture the ref element once on open and restore it once on close — a separate effect
  // from the one below so switching between refs while the panel stays open doesn't bounce
  // focus back to the original trigger on every nodeId change.
  useEffect(() => {
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => triggerRef.current?.focus();
  }, []);
  useEffect(() => {
    containerRef.current?.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    containerRef.current?.focus();
  }, [nodeId]);

  // t/4651#3 (Design AC5 fix): name the landing region for screen readers, since focus moves
  // here programmatically rather than via a visible heading the user just activated.
  const detailLabel = data?.type === 'pov' || data?.type === 'situations' ? data.node.label
    : data?.type === 'policy' ? data.policy.action
    : nodeId;

  if (data?.type === 'pov' || data?.type === 'situations') {
    return (
      <div ref={containerRef} tabIndex={-1} className="tax-node-detail-wrapper" role="region" aria-label={detailLabel}>
        <div className="tax-node-detail-close-row">
          <button type="button" className="tax-node-detail-close-btn" onClick={onClose} title="Close detail panel">Close</button>
        </div>
        {data.type === 'pov'
          ? <NodeDetail pov={data.pov} node={data.node} readOnly chipDepth={0} />
          : <SituationDetail node={data.node} readOnly chipDepth={0} />}
      </div>
    );
  }

  // Policy (pol-*) and unresolved ids: no NodeDetail/SituationDetail equivalent.
  return (
    <div ref={containerRef} tabIndex={-1} className="tax-node-detail-wrapper" role="region" aria-label={detailLabel}>
      <TaxonomyRefDetail
        nodeId={nodeId}
        node={undefined}
        pov=""
        onClose={onClose}
        policy={data?.type === 'policy' ? data.policy : undefined}
        policyReferencingNodes={data?.type === 'policy' ? data.referencingNodes : undefined}
      />
    </div>
  );
}
