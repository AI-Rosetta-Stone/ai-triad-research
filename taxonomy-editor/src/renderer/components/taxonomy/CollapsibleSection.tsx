// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4532: a shared, accessible collapse header for NodeDetail's Steelman Vulnerability and
// Intellectual Lineage sections. Extracted rather than inlined so NodeDetail.tsx (already at
// 1434/1500 lines, ADR-007) doesn't grow further.
//
// The header is a real <button> with aria-expanded/aria-controls, matching the existing
// accessible-toggle idiom in StatementCollapseToggle (components/debate-workspace/StatementCard.tsx) —
// not the older plain-div `related-cruxes-header` pattern elsewhere in this file, which has no
// aria-expanded and relies on a bare onClick div (no keyboard support).

import type { ReactNode } from 'react';
import './CollapsibleSection.css';

interface CollapsibleSectionProps {
  title: string;
  /** Used for both the section's DOM id (aria-controls) and this instance's React key upstream. */
  sectionId: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}

export function CollapsibleSection({ title, sectionId, expanded, onToggle, children }: CollapsibleSectionProps) {
  const contentId = `collapsible-section-body-${sectionId}`;
  return (
    <div className="form-group collapsible-section">
      <button
        type="button"
        className="collapsible-section-header"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={contentId}
      >
        <span className="collapsible-section-chevron">{expanded ? '▾' : '▸'}</span>
        {title}
      </button>
      {expanded && (
        <div id={contentId} className="collapsible-section-body">
          {children}
        </div>
      )}
    </div>
  );
}
