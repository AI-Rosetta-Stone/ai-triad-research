// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4826 (Design spec §3): Intellectual Lineage, promoted from a collapsible sub-section of the
// retired Analysis tab to its own top-level tab. Renders expanded (no disclosure header) and
// always shows, with an empty state when the node has none. Per-entry expand (expandedLineage)
// is unchanged. Extracted to its own file for the same NodeDetail.tsx line-budget reason as
// NodeDetailSteelmanTab.

import { useCallback } from 'react';
import { api } from '@bridge';
import type { PovNode } from '../../types/taxonomy';
import { useLongPressContextMenu } from '../../hooks/useLongPressContextMenu';
import { getLineageInfo } from '../../data/lineageLookup';
import { EmptyState } from '../shared/EmptyState';

/** t/4919 (TL review on #4648, p/356#162 should-fix): the tab's own sort order (alphabetical by
 *  label) — exported so NodeDetail's default-expanded-chip logic reads the SAME order instead of
 *  a second inline copy that could silently drift from this one. */
export function sortedLineageLabels(node: PovNode): string[] {
  const lineage = node.graph_attributes?.intellectual_lineage;
  return [...(lineage ?? [])]
    .map(v => (typeof v === 'string' ? v : (v as { name?: string })?.name))
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

interface NodeDetailLineageTabProps {
  node: PovNode;
  expandedLineage: string | null;
  setExpandedLineage: (v: string | null) => void;
  showAttributeInfo: (field: string, value: string) => void;
}

// t/3382: touch devices never fire `contextmenu` on a long-press — extracted so
// useLongPressContextMenu can be called once per chip instance (can't call a hook inside .map()).
function LineageChip({ label, selected, onSelect, onShowInfo }: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  onShowInfo: () => void;
}) {
  const longPress = useLongPressContextMenu(useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    onShowInfo();
  }, [onShowInfo]));
  return (
    <span
      className={`ga-promoted-chip ga-promoted-chip-interactive${selected ? ' ga-promoted-chip-selected' : ''}`}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      onContextMenu={longPress.onContextMenu}
      onTouchStart={longPress.onTouchStart}
      onTouchMove={longPress.onTouchMove}
      onTouchEnd={longPress.onTouchEnd}
      onTouchCancel={longPress.onTouchCancel}
      title={`Click to view lineage info: "${label}"`}
      aria-expanded={selected}
    >
      {label}
    </span>
  );
}

export function NodeDetailLineageTab({ node, expandedLineage, setExpandedLineage, showAttributeInfo }: NodeDetailLineageTabProps) {
  const lineage = node.graph_attributes?.intellectual_lineage;
  if (!lineage || lineage.length === 0) {
    return <EmptyState headline="No intellectual lineage recorded" direction="No sources of this idea have been linked to this node." />;
  }

  return (
    <div className="form-group">
      <div className="ga-promoted-list">
        {sortedLineageLabels(node).map((l, i) => (
          <LineageChip
            key={i}
            label={l}
            selected={expandedLineage === l}
            onSelect={() => setExpandedLineage(expandedLineage === l ? null : l)}
            onShowInfo={() => showAttributeInfo('intellectual_lineage', l)}
          />
        ))}
      </div>
      {expandedLineage && (() => {
        const info = getLineageInfo(expandedLineage);
        if (!info) return (
          <div className="lineage-inline-detail">
            <div className="lineage-inline-header">
              <span className="lineage-inline-label">{expandedLineage}</span>
              <button className="lineage-inline-close" onClick={() => setExpandedLineage(null)} title="Close">×</button>
            </div>
            <div className="lineage-inline-empty">No detailed information available for this lineage.</div>
          </div>
        );
        return (
          <div className="lineage-inline-detail">
            <div className="lineage-inline-header">
              <span className="lineage-inline-label">{info.label}</span>
              <button className="lineage-inline-close" onClick={() => setExpandedLineage(null)} title="Close">×</button>
            </div>
            <div className="lineage-inline-summary">{info.summary}</div>
            {info.example && (
              <div className="lineage-inline-example">
                <span className="lineage-inline-example-label">Example:</span> {info.example}
              </div>
            )}
            {info.links && info.links.length > 0 && (
              <div className="lineage-inline-links">
                {info.links.map((link, li) => (
                  <a
                    key={li}
                    className="lineage-inline-link"
                    href="#"
                    onClick={(e) => { e.preventDefault(); void api.openExternal(link.url); }}
                    title={link.url}
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}
