// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { nodePovFromId, SITUATION_PREFIX } from '@lib/debate/nodeIdUtils';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { allNodesById, isSuperseded } from '../../hooks/useTaxonomyStore/superseded';
import { useLongPressContextMenu, type ContextMenuLikeEvent } from '../../hooks/useLongPressContextMenu';
import { ApiKeyErrorMessage } from '../settings/ApiKeyErrorMessage';
import { useDescriptionMode, resolveDescription } from '../shared/DescriptionToggle';
import './SimilarSearchPanel.css';

type SortKey = 'match' | 'id' | 'label' | 'description';
type SortDir = 'asc' | 'desc';

interface ResolvedRow {
  id: string;
  score: number;
  label: string;
  description: string;
  category: string;
}

interface SimilarSearchPanelProps {
  width?: number;
  onAnalyze?: (elementB: { label: string; description: string; category: string }) => void;
}

// t/3382 follow-up: extracted so useLongPressContextMenu can be called once per row
// instance (can't call a hook inside .map()).
function SimilarSearchRow({ row, showIds, onRowClick, onContextMenu }: {
  row: ResolvedRow;
  showIds: boolean;
  onRowClick: (id: string) => void;
  onContextMenu: (e: ContextMenuLikeEvent, row: ResolvedRow) => void;
}) {
  const longPress = useLongPressContextMenu(useCallback((e) => onContextMenu(e, row), [onContextMenu, row]));
  return (
    <tr
      className="similar-table-row"
      onClick={() => onRowClick(row.id)}
      onContextMenu={longPress.onContextMenu}
      onTouchStart={longPress.onTouchStart}
      onTouchMove={longPress.onTouchMove}
      onTouchEnd={longPress.onTouchEnd}
      onTouchCancel={longPress.onTouchCancel}
    >
      <td className="similar-table-match">
        {Math.round(row.score * 100)}%
      </td>
      {showIds && (
        <td className="similar-table-id">{row.id}</td>
      )}
      <td className="similar-table-label">{row.label}</td>
      <td className="similar-table-desc">{row.description}</td>
    </tr>
  );
}

export function SimilarSearchPanel({ width, onAnalyze }: SimilarSearchPanelProps) {
  const [descMode] = useDescriptionMode();
  const {
    similarResults,
    similarLoading,
    similarError,
    similarThreshold,
    setSimilarThreshold,
    clearSimilarSearch,
    getLabelForId,
    navigateToNode,
  } = useTaxonomyStore();

  const [collapsed, setCollapsed] = useState(false);
  const [showIds, setShowIds] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('match');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; row: ResolvedRow } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close context menu on click outside or Escape
  useEffect(() => {
    if (!contextMenu) return;
    const onClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEsc);
    };
  }, [contextMenu]);

  // Column widths (resizable)
  const [colWidths, setColWidths] = useState({ match: 60, id: 150, label: 160 });
  const dragCol = useRef<'match' | 'id' | 'label' | null>(null);
  const dragStartX = useRef(0);
  const dragStartW = useRef(0);

  const onColResizeStart = useCallback((col: 'match' | 'id' | 'label', e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCol.current = col;
    dragStartX.current = e.clientX;
    dragStartW.current = colWidths[col];
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      if (!dragCol.current) return;
      const delta = ev.clientX - dragStartX.current;
      const newW = Math.max(40, dragStartW.current + delta);
      setColWidths(prev => ({ ...prev, [dragCol.current!]: newW }));
    };

    const onUp = () => {
      dragCol.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [colWidths]);

  const getDescription = (id: string): string => {
    const state = useTaxonomyStore.getState();
    if (id.startsWith(SITUATION_PREFIX)) {
      const node = state.situations?.nodes.find(n => n.id === id);
      return resolveDescription(node, descMode).text;
    }
    if (id.startsWith('conflict-')) {
      const conflict = state.conflicts.find(c => c.claim_id === id);
      return conflict?.description || '';
    }
    const node = allNodesById(state).get(id);
    return node ? resolveDescription(node, descMode).text : '';
  };

  const getCategory = (id: string): string => {
    const state = useTaxonomyStore.getState();
    if (id.startsWith(SITUATION_PREFIX)) return 'situations';
    if (id.startsWith('conflict-')) return 'conflict';
    return allNodesById(state).get(id)?.category ?? '';
  };

  // Build resolved rows once, then filter & sort
  const resolvedRows = useMemo((): ResolvedRow[] => {
    if (!similarResults) return [];
    const state = useTaxonomyStore.getState();
    return similarResults
      .filter(r => !isSuperseded(state, r.id))
      .map(r => ({
        id: r.id,
        score: r.score,
        label: getLabelForId(r.id) || r.id,
        description: getDescription(r.id),
        category: getCategory(r.id),
      }));
  }, [similarResults]);

  const filteredAndSorted = useMemo(() => {
    const threshold = similarThreshold / 100;
    const filtered = resolvedRows.filter(r => r.score >= threshold);

    filtered.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'match':
          cmp = a.score - b.score;
          break;
        case 'id':
          cmp = a.id.localeCompare(b.id);
          break;
        case 'label':
          cmp = a.label.localeCompare(b.label);
          break;
        case 'description':
          cmp = a.description.localeCompare(b.description);
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return filtered;
  }, [resolvedRows, similarThreshold, sortKey, sortDir]);

  if (similarResults === null && !similarLoading && !similarError) return null;

  if (collapsed) {
    return (
      <div className="pane-collapsed" onClick={() => setCollapsed(false)} title="Expand Similar Search">
        <span className="pane-collapsed-label">Similar Search</span>
      </div>
    );
  }

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'match' ? 'desc' : 'asc');
    }
  };

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return '';
    return sortDir === 'asc' ? ' \u25B2' : ' \u25BC';
  };

  const resolveTab = (id: string) => {
    const pov = nodePovFromId(id);
    if (pov) return pov as 'accelerationist' | 'safetyist' | 'skeptic' | 'situations';
    if (id.startsWith('conflict-')) return 'conflicts' as const;
    return null;
  };

  const handleRowClick = (id: string) => {
    const tab = resolveTab(id);
    if (tab) navigateToNode(tab, id);
  };

  const handleContextMenu = (e: ContextMenuLikeEvent, row: ResolvedRow) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, row });
  };

  const handleAnalyze = () => {
    if (contextMenu && onAnalyze) {
      onAnalyze({ label: contextMenu.row.label, description: contextMenu.row.description, category: contextMenu.row.category });
    }
    setContextMenu(null);
  };

  const colCount = showIds ? 4 : 3;

  const resizeHandle = (col: 'match' | 'id' | 'label') => (
    <span
      className="col-resize-handle"
      onMouseDown={(e) => onColResizeStart(col, e)}
    />
  );

  return (
    <div className="similar-search-panel" style={width ? { width, minWidth: 320 } : undefined}>
      <div className="similar-search-header">
        <div className="similar-search-title">Similar Search</div>
        <div className="similar-search-actions">
          <label className="similar-id-toggle">
            <input
              type="checkbox"
              checked={showIds}
              onChange={(e) => setShowIds(e.target.checked)}
            />
            IDs
          </label>
          <button className="pane-collapse-btn" onClick={() => setCollapsed(true)} title="Collapse">&lsaquo;</button>
          <button className="btn btn-ghost btn-sm" onClick={clearSimilarSearch}>
            Close
          </button>
        </div>
      </div>

      {similarLoading && (
        <div className="similar-search-loading">
          <span className="search-spinner" /> Computing similarity...
        </div>
      )}

      {similarError && (
        <ApiKeyErrorMessage error={similarError} />
      )}

      {similarResults !== null && !similarLoading && (
        <>
          <div className="similar-threshold-row">
            <label>Min Match:</label>
            <input
              type="range"
              min={40}
              max={100}
              value={similarThreshold}
              onChange={(e) => setSimilarThreshold(Number(e.target.value))}
            />
            <span className="similar-threshold-value">{similarThreshold}%</span>
          </div>

          <div className="similar-table-wrap">
            <table className="similar-table">
              <thead>
                <tr>
                  <th
                    style={{ width: colWidths.match }}
                    className="similar-th-sortable"
                    onClick={() => handleSort('match')}
                  >
                    Match{sortIndicator('match')}
                    {resizeHandle('match')}
                  </th>
                  {showIds && (
                    <th
                      style={{ width: colWidths.id }}
                      className="similar-th-sortable"
                      onClick={() => handleSort('id')}
                    >
                      ID{sortIndicator('id')}
                      {resizeHandle('id')}
                    </th>
                  )}
                  <th
                    style={{ width: colWidths.label }}
                    className="similar-th-sortable"
                    onClick={() => handleSort('label')}
                  >
                    Label{sortIndicator('label')}
                    {resizeHandle('label')}
                  </th>
                  <th
                    className="similar-th-sortable"
                    onClick={() => handleSort('description')}
                  >
                    Description{sortIndicator('description')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredAndSorted.length === 0 ? (
                  <tr>
                    <td colSpan={colCount} className="similar-table-empty">
                      No results above {similarThreshold}% threshold
                    </td>
                  </tr>
                ) : (
                  filteredAndSorted.map((r) => (
                    <SimilarSearchRow
                      key={r.id}
                      row={r}
                      showIds={showIds}
                      onRowClick={handleRowClick}
                      onContextMenu={handleContextMenu}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {contextMenu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button className="context-menu-item" onClick={handleAnalyze}>
            Analyze Distinction
          </button>
        </div>
      )}
    </div>
  );
}
