// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Extracted unchanged from debate-workspace/TaxonomyRefs.tsx (t/4627) — Chat needs it inline
// too, so it lives here in shared/ rather than duplicated.

import { useEffect, useRef } from 'react';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { TaxonomyRefDetail, type TaxRefNode } from '../taxonomy/TaxonomyRefDetail';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

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

  return (
    <div ref={containerRef} tabIndex={-1}>
      <TaxonomyRefDetail
        nodeId={nodeId}
        node={node}
        pov={pov}
        onClose={onClose}
        policy={data?.type === 'policy' ? data.policy : undefined}
        policyReferencingNodes={data?.type === 'policy' ? data.referencingNodes : undefined}
      />
    </div>
  );
}
