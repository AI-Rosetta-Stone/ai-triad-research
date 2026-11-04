// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Related tab (extracted from NodeDetail.tsx for complexity AND to stay under its line budget,
// t/4827).

import { useState, useEffect, type RefObject, type MouseEvent, type CSSProperties } from 'react';
import { RelatedEdgesPanel } from '../edge-browser/RelatedEdgesPanel';
import { EdgeDetailPanel } from '../edge-browser/EdgeDetailPanel';
import { EmptyState } from '../shared/EmptyState';

interface NodeDetailRelatedTabProps {
  selectedEdge: unknown;
  relatedSplitPct: number;
  handleSplitMouseDown: (e: MouseEvent) => void;
  splitContainerRef: RefObject<HTMLDivElement | null>;
}

// t/4827: below this container width, side-by-side squeezes the list to an unusable sliver and
// most of the detail pane is empty "No edge selected" space. Driven by the SPLIT CONTAINER's own
// width (ResizeObserver), not viewport orientation or width — the node-detail pane can be narrow
// in landscape too (e.g. a split main view), and a portrait monitor's pane can still be wide.
const RELATED_STACK_BREAKPOINT_PX = 600;

export function NodeDetailRelatedTab({ selectedEdge, relatedSplitPct, handleSplitMouseDown, splitContainerRef }: NodeDetailRelatedTabProps) {
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const container = splitContainerRef.current;
    if (!container) return;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width === undefined) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => setContainerWidth(width), 50);
    });
    observer.observe(container);
    return () => { observer.disconnect(); if (debounceTimer) clearTimeout(debounceTimer); };
  }, [splitContainerRef]);

  // 0 means "not measured yet" (first paint) — treat as unstacked so SSR/first-render matches
  // the common (wide) case rather than flashing stacked-then-wide.
  const stacked = containerWidth > 0 && containerWidth < RELATED_STACK_BREAKPOINT_PX;

  return (
    <div className={`node-detail-related-split${stacked ? ' node-detail-related-split-stacked' : ''}`} ref={splitContainerRef}>
      <div
        className={`node-detail-related-list${stacked ? '' : ' nd-split-width'}`}
        /* eslint-disable-next-line local/no-inline-style -- width is a user-dragged split percentage, passed as a CSS custom property; omitted in stacked mode so the stacked CSS rule (100% width) isn't fighting a stale inline value */
        style={stacked ? undefined : ({ '--nd-split-width': `${relatedSplitPct}%` } as CSSProperties)}
      >
        <RelatedEdgesPanel />
      </div>
      {!stacked && <div className="resize-handle" onMouseDown={handleSplitMouseDown} />}
      {(!stacked || !!selectedEdge) && (
        <div
          className={`node-detail-related-detail${stacked ? '' : ' nd-split-width'}`}
          /* eslint-disable-next-line local/no-inline-style -- width is a user-dragged split percentage, passed as a CSS custom property; omitted in stacked mode so the stacked CSS rule (100% width) isn't fighting a stale inline value */
          style={stacked ? undefined : ({ '--nd-split-width': `${100 - relatedSplitPct}%` } as CSSProperties)}
        >
          {selectedEdge ? (
            <EdgeDetailPanel width={0} />
          ) : (
            <EmptyState headline="No edge selected" direction="Select an edge to view details" />
          )}
        </div>
      )}
    </div>
  );
}
