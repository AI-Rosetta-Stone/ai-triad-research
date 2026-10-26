// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// LibraryListPage (t/3703, parent t/3702) — shared list-page shell for Op-Ed Studies / Chats /
// Debates. Spec: C:\tmp\HANDOFF-library-pages.md. Shared/per-page split per TL ruling (t/3702#1,
// t/3703#3): header, tabs, search+empty-state, grid mechanics, row interaction, the ENTIRE
// actions column, and sort mechanics all live here. Pages supply config only — see
// LibraryListPage.types.ts for the contract and its rationale comments.

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { useAuthStatus } from '../../hooks/useAuthStatus';
import type {
  LibraryVariant, LibraryListPageProps, LibraryColumn, LibraryRowEditAction,
} from './LibraryListPage.types';
import './LibraryListPage.css';

const ACTIONS_COL_WIDTH = '150px'; // every page's spec table uses 150 for the actions column
const CHECKBOX_COL_WIDTH = '28px';

type SortDir = 'asc' | 'desc' | 'none';
interface SortState { key: string | null; dir: SortDir; }
const TITLE_SORT_KEY = '__title__';

function nextDir(dir: SortDir): SortDir {
  if (dir === 'none') return 'asc';
  if (dir === 'asc') return 'desc';
  return 'none';
}

function ariaSortFor(state: SortState, key: string): 'ascending' | 'descending' | 'none' {
  if (state.key !== key || state.dir === 'none') return 'none';
  return state.dir === 'asc' ? 'ascending' : 'descending';
}

function warnMissingComparator(columnKey: string): void {
  getGlobalRecorder()?.record({
    type: 'system.error',
    component: 'LibraryListPage',
    level: 'warn',
    message: `Column "${columnKey}" is sortable but has no comparator — sort click is a no-op for it`,
    error: { name: 'MissingComparator', message: columnKey },
  });
}

function stripWebAddress(url: string): { site: string; rest: string } {
  const noProto = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  const slashIdx = noProto.indexOf('/');
  if (slashIdx === -1) return { site: noProto, rest: '' };
  return { site: noProto.slice(0, slashIdx), rest: noProto.slice(slashIdx) };
}

// ── Title cell (shared: clamping + web-address rendering + inline rename) ──

function TitleCell<TMy extends { id: string }, TCommunity extends { id: string }>({
  row, variant, config,
}: {
  row: TMy | TCommunity;
  variant: LibraryVariant;
  config: LibraryListPageProps<TMy, TCommunity>['config'];
}) {
  const [renameDraft, setRenameDraft] = useState('');
  const title = config.getTitle(row, variant);
  const isRenaming = config.renamingId === row.id;
  const isWebAddress = (config.isWebAddressTitle ?? ((r: TMy | TCommunity) => /^https?:\/\//i.test(config.getTitle(r, variant))))(row, variant);
  const secondary = config.secondaryLine(row, variant);

  // Seed the draft from the current title whenever renaming starts — not just from the
  // double-click handler below, since a page can also enter rename via its own affordance
  // (e.g. Debates' edit-mode rename icon calling setRenamingId directly, t/3705#2) without ever
  // going through startRename.
  useEffect(() => {
    if (isRenaming) setRenameDraft(title);
  }, [isRenaming, title]);

  const startRename = useCallback((e: React.MouseEvent) => {
    if (!config.onRename || !config.setRenamingId) return;
    e.stopPropagation();
    config.setRenamingId(row.id);
  }, [config, row.id]);

  const commitRename = useCallback(() => {
    const v = renameDraft.trim();
    if (v && v !== title && config.onRename) config.onRename(row.id, v);
    config.setRenamingId?.(null);
  }, [renameDraft, title, config, row.id]);

  if (isRenaming) {
    return (
      <input
        className="lib-rename-input"
        value={renameDraft}
        autoFocus
        onClick={e => e.stopPropagation()}
        onChange={e => setRenameDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.stopPropagation(); commitRename(); }
          else if (e.key === 'Escape') config.setRenamingId?.(null);
        }}
        onBlur={commitRename}
      />
    );
  }

  return (
    <>
      {isWebAddress ? (
        <span className="lib-title-webaddr" title={title} onDoubleClick={config.onRename ? startRename : undefined}>
          <span className="lib-title-site">{stripWebAddress(title).site}</span>
          <span className="lib-title-rest">{stripWebAddress(title).rest}</span>
        </span>
      ) : (
        <div className="lib-title-text" title={title} onDoubleClick={config.onRename ? startRename : undefined}>
          {title}
        </div>
      )}
      {secondary && <div className="lib-title-secondary">{secondary}</div>}
    </>
  );
}

// ── Export menu (shared) ──

function ExportMenu({ formats, onExport, onOpenChange, extraItems = [] }: {
  formats: { key: string; label: string }[];
  onExport: (format: string) => void;
  onOpenChange: (open: boolean) => void;
  /** Non-format items appended after the format list — e.g. Debates' "Brief…" (t/3705#6). */
  extraItems?: Array<{ label: string; onClick: () => void; disabled?: boolean }>;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  const close = useCallback(() => { setOpen(false); onOpenChange(false); }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDocClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDocClick);
    };
  }, [open, close]);

  return (
    <span className="lib-export-menu-wrap" ref={wrapRef} onClick={e => e.stopPropagation()}>
      <button
        type="button"
        className="lib-action-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => { const next = !open; setOpen(next); onOpenChange(next); }}
      >
        Export &#9662;
      </button>
      {open && (
        <span role="menu" className="lib-export-menu">
          {formats.map(f => (
            <button
              key={f.key}
              type="button"
              role="menuitem"
              className="lib-export-menu-item"
              onClick={() => { close(); onExport(f.key); }}
            >
              {f.label}
            </button>
          ))}
          {extraItems.map(item => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="lib-export-menu-item"
              disabled={item.disabled}
              onClick={() => { close(); item.onClick(); }}
            >
              {item.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

// ── Row-edit icon affordances (rename ✎ / move ▲ / move ▼) ──

const ROW_ICON_GLYPH: Record<LibraryRowEditAction['icon'], string> = {
  rename: '\u270E',
  moveUp: '\u25B2',
  moveDown: '\u25BC',
};

function RowEditActions({ actions }: { actions: LibraryRowEditAction[] }) {
  return (
    <span className="lib-actions" onClick={e => e.stopPropagation()}>
      {actions.map(a => (
        <button
          key={a.icon}
          type="button"
          className="lib-row-icon-btn"
          title={a.label}
          aria-label={a.label}
          disabled={a.disabled}
          onClick={a.onClick}
        >
          {ROW_ICON_GLYPH[a.icon]}
        </button>
      ))}
    </span>
  );
}

// ── Actions cell (shared, non-negotiable per t/3703 ruling) ──

function ActionsCell<TMy extends { id: string }, TCommunity extends { id: string }>({
  row, variant, config, toast, editModeActive,
}: {
  row: TMy | TCommunity;
  variant: LibraryVariant;
  config: LibraryListPageProps<TMy, TCommunity>['config'];
  toast: (msg: string) => void;
  editModeActive: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  if (editModeActive) {
    const rowActions = variant === 'my' ? config.editMode?.rowActions?.(row as TMy) ?? [] : [];
    return rowActions.length > 0 ? <RowEditActions actions={rowActions} /> : null;
  }

  const showCopy = variant === 'community' ? (config.showCopy ? config.showCopy(row as TCommunity) : true) : false;

  return (
    <div className={`lib-actions${menuOpen ? ' lib-menu-open' : ''}`} onClick={e => e.stopPropagation()}>
      <ExportMenu
        formats={config.exportFormats}
        onOpenChange={setMenuOpen}
        onExport={fmt => {
          if (variant === 'my') config.onExportMy(row as TMy, fmt);
          else config.onExportCommunity(row as TCommunity, fmt);
          toast(`Exporting as ${config.exportFormats.find(f => f.key === fmt)?.label ?? fmt}`);
        }}
        extraItems={config.extraExportMenuItems?.(row, variant) ?? []}
      />
      {variant === 'my' && (
        <button type="button" className="lib-action-btn" onClick={() => { config.onShare(row as TMy); toast('Share link copied'); }}>
          Share
        </button>
      )}
      {variant === 'community' && showCopy && (
        <button type="button" className="lib-action-btn" onClick={() => { config.onCopy(row as TCommunity); toast(`Copied to My ${config.title}`); }}>
          Copy
        </button>
      )}
    </div>
  );
}

// ── Sortable header cell ──

function HeaderCell({
  label, sortKey, sortable, sort, onSort, width, align,
}: {
  label: string;
  sortKey: string;
  sortable: boolean;
  sort: SortState;
  onSort: (key: string) => void;
  width: string;
  align?: 'left' | 'right';
}) {
  const isSorted = sort.key === sortKey && sort.dir !== 'none';
  const dirGlyph = sort.dir === 'asc' ? '\u25B4' : '\u25BE';
  return (
    <div
      role="columnheader"
      aria-sort={ariaSortFor(sort, sortKey)}
      className={`lib-cell lib-header-cell${align === 'right' ? ' lib-align-right' : ''}${isSorted ? ' sorted' : ''}`}
      // eslint-disable-next-line local/no-inline-style -- per-column width from page config, not a static class
      style={{ width }}
    >
      {label && (
        <button
          type="button"
          className={`lib-header-sort-btn${sortable ? ' sortable' : ''}${isSorted ? ' sorted' : ''}`}
          onClick={sortable ? () => onSort(sortKey) : undefined}
          disabled={!sortable}
        >
          {label}
          {sortable && <span className="lib-sort-caret" aria-hidden="true">{isSorted ? dirGlyph : '\u25BE'}</span>}
        </button>
      )}
    </div>
  );
}

// ── Header row 1: title + Edit/bulk-actions + New (extracted to keep the shell's complexity down) ──

function HeaderRow1<TMy extends { id: string }, TCommunity extends { id: string }>({
  config, editModeActive,
}: {
  config: LibraryListPageProps<TMy, TCommunity>['config'];
  editModeActive: boolean;
}) {
  return (
    <div className="lib-header-row1">
      <h2 className="lib-title">{config.title}</h2>
      <div className="lib-header-actions">
        {config.showEdit && !editModeActive && (
          <button type="button" className="lib-btn-secondary" onClick={config.editMode?.onEnter}>Edit</button>
        )}
        {config.showEdit && editModeActive && config.editMode && (
          <div className="lib-editmode-actions">
            {config.editMode.actions.map(a => (
              <button
                key={a.label}
                type="button"
                className={`lib-btn-secondary${a.variant === 'danger' ? ' lib-btn-danger' : ''}`}
                onClick={a.onClick}
                disabled={a.disabled}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
        {config.onNew && (
          <button type="button" className="lib-btn-primary" onClick={config.onNew}>{config.newLabel}</button>
        )}
      </div>
    </div>
  );
}

// ── Header row 2: tabs + search ──

function HeaderRow2({
  listView, myCount, communityCount, onSwitch, searchQuery, onSearchChange, placeholderMy, placeholderCommunity, hideMyTab,
}: {
  listView: LibraryVariant;
  myCount: number;
  communityCount: number;
  onSwitch: (v: LibraryVariant) => void;
  searchQuery: string;
  onSearchChange: (v: string) => void;
  placeholderMy: string;
  placeholderCommunity: string;
  hideMyTab: boolean;
}) {
  return (
    <div className="lib-header-row2">
      <div className="lib-tabs" role="tablist">
        {!hideMyTab && (
          <button role="tab" aria-selected={listView === 'my'} className={`lib-tab${listView === 'my' ? ' active' : ''}`} onClick={() => onSwitch('my')}>
            My <span className="lib-tab-badge">{myCount}</span>
          </button>
        )}
        <button role="tab" aria-selected={listView === 'community'} className={`lib-tab${listView === 'community' ? ' active' : ''}`} onClick={() => onSwitch('community')}>
          Community <span className="lib-tab-badge">{communityCount}</span>
        </button>
      </div>
      <input
        type="text"
        className="lib-search"
        placeholder={listView === 'my' ? placeholderMy : placeholderCommunity}
        value={searchQuery}
        onChange={e => onSearchChange(e.target.value)}
      />
    </div>
  );
}

// ── Grid column-header row ──

function GridHeaderRow<TMy extends { id: string }, TCommunity extends { id: string }>({
  config, sort, onSort, editModeActive,
}: {
  config: LibraryListPageProps<TMy, TCommunity>['config'];
  sort: SortState;
  onSort: (key: string) => void;
  editModeActive: boolean;
}) {
  return (
    <div className="lib-row" role="row">
      {editModeActive && <div className="lib-cell lib-header-cell lib-col-cb" role="columnheader" aria-label="Select row" />}
      <HeaderCell label={config.titleHeader} sortKey={TITLE_SORT_KEY} sortable={!!config.titleSortable} sort={sort} onSort={onSort} width="1fr" />
      {config.columns.map((col: LibraryColumn<TMy, TCommunity>) => (
        <HeaderCell key={col.key} label={col.header} sortKey={col.key} sortable={!!col.sortable} sort={sort} onSort={onSort} width={col.width} align={col.align} />
      ))}
      {/* eslint-disable-next-line local/no-inline-style -- fixed actions-column width, same value as every page's spec table */}
      <div className="lib-cell lib-header-cell lib-align-right" role="columnheader" style={{ width: ACTIONS_COL_WIDTH } as React.CSSProperties} />
    </div>
  );
}

// ── Body row (extracted to keep the shell's complexity down) ──

function BodyRow<TMy extends { id: string }, TCommunity extends { id: string }>({
  row, listView, config, editModeActive, openRow, showToast,
}: {
  row: TMy | TCommunity;
  listView: LibraryVariant;
  config: LibraryListPageProps<TMy, TCommunity>['config'];
  editModeActive: boolean;
  openRow: (id: string) => void;
  showToast: (msg: string) => void;
}) {
  return (
    <div
      className="lib-row lib-body-row"
      role="row"
      tabIndex={0}
      onClick={() => { if (!editModeActive) openRow(row.id); else config.editMode?.onToggleSelect(row.id); }}
      onKeyDown={e => {
        if (e.key !== 'Enter' || editModeActive) return;
        e.preventDefault();
        openRow(row.id);
      }}
    >
      {editModeActive && (
        <div className="lib-cell lib-col-cb" role="cell" onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            aria-label={`Select ${config.getTitle(row, listView)}`}
            checked={config.editMode!.selectedIds.has(row.id)}
            onChange={() => config.editMode!.onToggleSelect(row.id)}
          />
        </div>
      )}
      <div className="lib-cell lib-col-title" role="cell">
        <TitleCell row={row} variant={listView} config={config} />
      </div>
      {config.columns.map(col => (
        <div key={col.key} className={`lib-cell${col.align === 'right' ? ' lib-align-right' : ''}`} role="cell">
          {col.render(row, listView)}
        </div>
      ))}
      <div className="lib-cell lib-actions-cell" role="cell">
        <ActionsCell row={row} variant={listView} config={config} toast={showToast} editModeActive={editModeActive} />
      </div>
    </div>
  );
}

// ── Empty/loading state row ──

function EmptyStateRow({
  loading, hasSortedRows, hasRows, hasQuery, query, emptyLabel,
}: {
  loading: boolean;
  hasSortedRows: boolean;
  hasRows: boolean;
  hasQuery: boolean;
  query: string;
  emptyLabel: string;
}) {
  if (loading && !hasSortedRows) return <div className="lib-empty-row">Loading…</div>;
  if (!loading && !hasRows) return <div className="lib-empty-row">No {emptyLabel} yet.</div>;
  if (!loading && hasRows && hasQuery && !hasSortedRows) return <div className="lib-empty-row">No results for &quot;{query}&quot;</div>;
  return null;
}

// ── Component ──

export function LibraryListPage<TMy extends { id: string }, TCommunity extends { id: string }>(
  props: LibraryListPageProps<TMy, TCommunity>,
) {
  const {
    config, myRows, myLoading, communityRows, communityLoading, onOpenMy, onOpenCommunity,
    actionVisibility = 'hover', intro,
  } = props;

  // t/3703#8: My-tab visibility is auth-driven, read here rather than taken as a prop — the
  // value (does THIS session have My content) is the same wherever it's computed, but making it
  // a prop would be three chances for a page to forget to pass it, producing a dead My tab on
  // whichever page slips. `config.anonymousHasMyContent` is the one thing that genuinely differs
  // per page (Op-Eds' temp anon session vs. Debates having nothing for anon) and is required, not
  // optional, so a page can't silently inherit a wrong default either.
  const auth = useAuthStatus();
  const hideMyTab = !!auth?.anonymous && !config.anonymousHasMyContent;

  const [listView, setListView] = useState<LibraryVariant>(hideMyTab ? 'community' : 'my');
  const [searchQuery, setSearchQuery] = useState('');
  const [sort, setSort] = useState<SortState>({ key: null, dir: 'none' });
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const switchTab = useCallback((v: LibraryVariant) => {
    setListView(v);
    setSearchQuery('');
  }, []);

  // hideMyTab can flip true after mount (e.g. auth resolves anonymous after an optimistic 'my'
  // default) — force off 'my' rather than leave the view stuck on a tab whose button just
  // disappeared from the strip.
  useEffect(() => {
    if (hideMyTab && listView === 'my') setListView('community');
  }, [hideMyTab, listView]);

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 1800);
  }, []);

  const rows = listView === 'my' ? myRows : communityRows;
  const loading = listView === 'my' ? myLoading : communityLoading;
  const q = searchQuery.trim().toLowerCase();
  const filtered = useMemo(() => config.filter(rows, q, listView), [config, rows, q, listView]);

  const sortedRows = useMemo(() => {
    if (!sort.key || sort.dir === 'none') return filtered;
    const mul = sort.dir === 'asc' ? 1 : -1;
    if (sort.key === TITLE_SORT_KEY) {
      return [...filtered].sort((a, b) => mul * config.getTitle(a, listView).localeCompare(config.getTitle(b, listView)));
    }
    const col = config.columns.find(c => c.key === sort.key);
    if (!col?.compare) return filtered;
    return [...filtered].sort((a, b) => mul * col.compare!(a, b, listView));
  }, [filtered, sort, config, listView]);

  const onSort = useCallback((key: string) => {
    const col = key === TITLE_SORT_KEY ? null : config.columns.find(c => c.key === key);
    if (key !== TITLE_SORT_KEY && !col?.compare) { warnMissingComparator(key); return; }
    setSort(prev => (prev.key === key ? { key, dir: nextDir(prev.dir) } : { key, dir: 'asc' }));
  }, [config.columns]);

  const editModeActive = !!config.editMode?.active;
  const gridCols = [
    editModeActive ? CHECKBOX_COL_WIDTH : null,
    '1fr',
    ...config.columns.map(c => c.width),
    ACTIONS_COL_WIDTH,
  ].filter(Boolean).join(' ');

  const openRow = listView === 'my' ? onOpenMy : onOpenCommunity;
  const emptyLabel = listView === 'my' ? config.searchPlaceholderMy.replace(/^Search /, '').replace(/…$/, '') : config.title.toLowerCase();

  return (
    <div className="library-list-page" data-action-visibility={actionVisibility}>
      <HeaderRow1 config={config} editModeActive={editModeActive} />

      {intro}

      <HeaderRow2
        listView={listView}
        myCount={myRows.length}
        communityCount={communityRows.length}
        onSwitch={switchTab}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        placeholderMy={config.searchPlaceholderMy}
        placeholderCommunity={config.searchPlaceholderCommunity}
        hideMyTab={hideMyTab}
      />

      <div className="lib-table-wrap">
        {/* eslint-disable-next-line local/no-inline-style -- per-page grid-template-columns, not a static class */}
        <div className="lib-grid" role="table" aria-label={`${config.title} ${listView === 'my' ? 'My' : 'Community'} table`} style={{ '--lib-cols': gridCols } as React.CSSProperties}>
          <GridHeaderRow config={config} sort={sort} onSort={onSort} editModeActive={editModeActive} />

          <EmptyStateRow loading={loading} hasSortedRows={sortedRows.length > 0} hasRows={rows.length > 0} hasQuery={!!q} query={searchQuery} emptyLabel={emptyLabel} />

          {sortedRows.map(row => (
            <BodyRow key={row.id} row={row} listView={listView} config={config} editModeActive={editModeActive} openRow={openRow} showToast={showToast} />
          ))}
        </div>
      </div>

      {toastMsg && <div className="lib-toast" role="status">{toastMsg}</div>}
    </div>
  );
}
