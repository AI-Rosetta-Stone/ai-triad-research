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
import { useIsAdmin } from '../../hooks/useIsAdmin';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { canOpenInNewWindow, openPlaceInNewWindow, type ItemPlace } from '../../navigation/openInWindow';
import { getLastVariant, setLastVariant } from '../../navigation/lastVariant';
import { useResizableColumns, type ResizableSpec, type ResizeHandleProps } from './useResizableColumns';
import { RemoveConfirmPopover } from '../community/CommunityLibrary'; // t/4898: admin delete confirm, reused
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

/** t/4830: gathers every opt-in resizable column on this page into the id->spec map
 *  `useResizableColumns` wants — 'title' for `titleResizable`, `col.key` for each column's own
 *  `resizable`. Extracted so a page with neither (every page before this ticket) contributes no
 *  complexity to the main component. */
function collectResizableSpecs<TMy extends { id: string }, TCommunity extends { id: string }>(
  titleResizable: { min: number; max: number } | undefined,
  columns: LibraryColumn<TMy, TCommunity>[],
): Record<string, ResizableSpec> {
  const specs: Record<string, ResizableSpec> = {};
  if (titleResizable) specs.title = titleResizable;
  for (const col of columns) if (col.resizable) specs[col.key] = col.resizable;
  return specs;
}

/** t/4830: resolved px width for a resizable column, falling back to its declared default
 *  (unresized, or not resizable at all) — same extraction reason as `collectResizableSpecs`. */
function resolvedColWidth(px: number | null | undefined, fallback: string): string {
  return px != null ? `${px}px` : fallback;
}

/** t/4561 (t/4689: + remembered): extracted so the branching lives in its own function, not
 *  LibraryListPage's — kept the main component's complexity unchanged rather than bumping it
 *  over threshold. `hideMyTab` still wins over a remembered 'my' — an anonymous session with no
 *  My content can't honor a memory of a tab it no longer has. */
function initialListView(hideMyTab: boolean, defaultCommunityOnWeb: boolean, isWeb: boolean, remembered?: LibraryVariant): LibraryVariant {
  if (hideMyTab) return 'community';
  if (remembered) return remembered;
  if (defaultCommunityOnWeb && isWeb) return 'community';
  return 'my';
}

// t/4643: Edit is admin-only on the Community tab. Pulled out of LibraryListPage's body (rather
// than inlined as a boolean expression) to keep that function's cyclomatic complexity under the
// repo's per-file budget — see eslint.config.mjs's local/complexity-budget rule.
function canShowEditFor(showEdit: boolean, listView: LibraryVariant, isAdmin: boolean): boolean {
  return showEdit && (listView !== 'community' || isAdmin);
}

// t/4689: the row's ⧉ place, or null when the page has no window-opening story for this row
// (no `config.itemPlace`) or the current build/tool combination can't open one
// (`canOpenInNewWindow`, e.g. Electron + opeds/inquiry). One check, reused by the ⧉ button and
// the row's Ctrl/Cmd/middle-click handling, so they can never disagree about availability.
function openablePlace<TMy extends { id: string }, TCommunity extends { id: string }>(
  config: LibraryListPageProps<TMy, TCommunity>['config'], row: TMy | TCommunity, variant: LibraryVariant,
): ItemPlace | null {
  const place = config.itemPlace?.(row, variant) ?? null;
  return place && canOpenInNewWindow(place) ? place : null;
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

  // t/4885: onRename renames the reader's OWN item, so a Community row never enters inline
  // rename (it used to call the My rename with a community id). Admin rename of Community
  // items is a separate, admin-gated action.
  const canRename = variant === 'my' && !!config.onRename;

  const startRename = useCallback((e: React.MouseEvent) => {
    if (!canRename || !config.setRenamingId) return;
    e.stopPropagation();
    config.setRenamingId(row.id);
  }, [canRename, config, row.id]);

  // t/4898: the same inline-input mechanism now also drives admin rename on a Community row —
  // triggered externally via setRenamingId (the admin ✎ button in ActionsCellButtons), never via
  // startRename/double-click above, which stays My-only per the t/4885 fix. Commit routes to
  // whichever handler actually owns this row's variant.
  const commitRename = useCallback(() => {
    const v = renameDraft.trim();
    if (v && v !== title) {
      if (variant === 'my') config.onRename?.(row.id, v);
      else config.adminRename?.(row as TCommunity, v);
    }
    config.setRenamingId?.(null);
  }, [renameDraft, title, config, row, variant]);

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

  const badge = config.titleBadge?.(row, variant);

  return (
    <>
      <div className="lib-title-line">
        {isWebAddress ? (
          <span className="lib-title-webaddr" title={title} onDoubleClick={canRename ? startRename : undefined}>
            <span className="lib-title-site">{stripWebAddress(title).site}</span>
            <span className="lib-title-rest">{stripWebAddress(title).rest}</span>
          </span>
        ) : (
          <div className="lib-title-text" title={title} onDoubleClick={canRename ? startRename : undefined}>
            {title}
          </div>
        )}
        {badge && <span className="lib-title-badge-slot">{badge}</span>}
      </div>
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

// ── ⧉ open-in-new-window button (t/4689) — extracted to keep ActionsCell under budget ──

function OpenInWindowButton({ place, title }: { place: ItemPlace; title: string }) {
  return (
    <button
      type="button"
      className="lib-action-btn lib-action-open-window"
      title="Open in new window"
      aria-label={`Open ${title} in a new window`}
      onClick={() => openPlaceInNewWindow(place)}
    >
      ⧉
    </button>
  );
}

// ── Actions cell: the non-edit-mode button row (t/4689: extracted from ActionsCell to keep
//    it under the per-file complexity budget — adding the ⧉ button's branch pushed the
//    combined function over threshold) ──

// t/4898 (Design, t/4898#4/p/29#272): admin rename/delete on a Community row — ✎ reuses the
// existing row-icon affordance/look (triggers TitleCell's inline rename via setRenamingId, same
// as My-row edit mode); ✕ reuses CommunityLibrary's RemoveConfirmPopover rather than a bare
// delete icon with no confirm. Both no-ops unless the page supplies the callback AND the viewer
// is an admin.
function AdminRowActions<TMy extends { id: string }, TCommunity extends { id: string }>({
  row, variant, config,
}: {
  row: TMy | TCommunity;
  variant: LibraryVariant;
  config: LibraryListPageProps<TMy, TCommunity>['config'];
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  if (variant !== 'community') return null;
  const canRename = !!config.adminRename && !!config.setRenamingId;
  const canDelete = !!config.adminDelete;
  if (!canRename && !canDelete) return null;
  const title = config.getTitle(row, variant);

  return (
    <span className="lib-actions lib-admin-actions" onClick={e => e.stopPropagation()}>
      {canRename && (
        <button
          type="button"
          className="lib-row-icon-btn"
          title={`Rename "${title}" (admin)`}
          aria-label={`Rename "${title}" (admin)`}
          onClick={() => config.setRenamingId?.(row.id)}
        >
          {ROW_ICON_GLYPH.rename}
        </button>
      )}
      {canDelete && (
        <>
          <button
            type="button"
            className="lib-row-icon-btn"
            title={`Remove "${title}" from Community (admin)`}
            aria-label={`Remove "${title}" from Community (admin)`}
            onClick={() => setConfirmingDelete(true)}
          >
            &#x2715;
          </button>
          {confirmingDelete && (
            <RemoveConfirmPopover
              title={title}
              onCancel={() => setConfirmingDelete(false)}
              onConfirm={(reason) => {
                setConfirmingDelete(false);
                config.adminDelete?.(row as TCommunity, reason || undefined);
              }}
            />
          )}
        </>
      )}
    </span>
  );
}

function ActionsCellButtons<TMy extends { id: string }, TCommunity extends { id: string }>({
  row, variant, config, toast, menuOpen, setMenuOpen, isAdmin,
}: {
  row: TMy | TCommunity;
  variant: LibraryVariant;
  config: LibraryListPageProps<TMy, TCommunity>['config'];
  toast: (msg: string) => void;
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
  isAdmin: boolean;
}) {
  const showCopy = variant === 'community' ? (config.showCopy ? config.showCopy(row as TCommunity) : true) : false;
  const place = openablePlace(config, row, variant);

  return (
    <div className={`lib-actions${menuOpen ? ' lib-menu-open' : ''}`} onClick={e => e.stopPropagation()}>
      {place && <OpenInWindowButton place={place} title={config.getTitle(row, variant)} />}
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
      {isAdmin && <AdminRowActions row={row} variant={variant} config={config} />}
    </div>
  );
}

// ── Actions cell (shared, non-negotiable per t/3703 ruling) ──

function ActionsCell<TMy extends { id: string }, TCommunity extends { id: string }>({
  row, variant, config, toast, editModeActive, isAdmin,
}: {
  row: TMy | TCommunity;
  variant: LibraryVariant;
  config: LibraryListPageProps<TMy, TCommunity>['config'];
  toast: (msg: string) => void;
  editModeActive: boolean;
  isAdmin: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  if (editModeActive) {
    const rowActions = variant === 'my' ? config.editMode?.rowActions?.(row as TMy) ?? [] : [];
    return rowActions.length > 0 ? <RowEditActions actions={rowActions} /> : null;
  }

  return <ActionsCellButtons row={row} variant={variant} config={config} toast={toast} menuOpen={menuOpen} setMenuOpen={setMenuOpen} isAdmin={isAdmin} />;
}

// ── Sortable header cell ──

function HeaderCell({
  label, sortKey, sortable, sort, onSort, width, align, cellRef, resizeHandle,
}: {
  label: string;
  sortKey: string;
  sortable: boolean;
  sort: SortState;
  onSort: (key: string) => void;
  width: string;
  align?: 'left' | 'right';
  /** t/4830: only set for a resizable column \u2014 measures its rendered width on first drag/keypress. */
  cellRef?: (el: HTMLDivElement | null) => void;
  /** t/4830: only set for a resizable column \u2014 renders the drag/keyboard resize handle. */
  resizeHandle?: ResizeHandleProps;
}) {
  const isSorted = sort.key === sortKey && sort.dir !== 'none';
  const dirGlyph = sort.dir === 'asc' ? '\u25B4' : '\u25BE';
  return (
    <div
      ref={cellRef}
      role="columnheader"
      aria-sort={ariaSortFor(sort, sortKey)}
      className={`lib-cell lib-header-cell${align === 'right' ? ' lib-align-right' : ''}${isSorted ? ' sorted' : ''}${resizeHandle ? ' lib-header-cell-resizable' : ''}`}
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
      {resizeHandle && <div className="lib-col-resize-handle" {...resizeHandle} />}
    </div>
  );
}

// ── Header row 1: title + Edit/bulk-actions + New (extracted to keep the shell's complexity down) ──

function HeaderRow1<TMy extends { id: string }, TCommunity extends { id: string }>({
  config, editModeActive, canShowEdit,
}: {
  config: LibraryListPageProps<TMy, TCommunity>['config'];
  editModeActive: boolean;
  /** t/4643: config.showEdit narrowed by (listView !== 'community' || isAdmin) — computed by
   *  the parent, since this component doesn't know the active tab or admin status itself. */
  canShowEdit: boolean;
}) {
  return (
    <div className="lib-header-row1">
      <h2 className="lib-title">{config.title}</h2>
      <div className="lib-header-actions">
        {canShowEdit && !editModeActive && (
          <button type="button" className="lib-btn-secondary" onClick={config.editMode?.onEnter}>Edit</button>
        )}
        {canShowEdit && editModeActive && config.editMode && (
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

// ── Header row 1.5: sort select (phone only, t/4571) ──

function PhoneSortBar({
  sort, onSort, config,
}: {
  sort: SortState;
  onSort: (key: string) => void;
  config: LibraryListPageProps<any, any>['config'];
}) {
  return (
    <div className="lib-phone-sort-bar">
      <label htmlFor="lib-phone-sort-select" className="lib-phone-sort-label">Sort:</label>
      <SortSelect
        sortKey={sort.key}
        sortDir={sort.dir}
        onSort={onSort}
        columns={config.columns}
        titleSortable={config.titleSortable}
      />
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
  config, sort, onSort, editModeActive, columnWidths, registerCell, getHandleProps,
}: {
  config: LibraryListPageProps<TMy, TCommunity>['config'];
  sort: SortState;
  onSort: (key: string) => void;
  editModeActive: boolean;
  /** t/4830: resolved px per resizable column id ('title' or col.key); absent = use the
   *  column's own declared width (unresized, or not resizable at all). */
  columnWidths: Record<string, number | null>;
  registerCell: (id: string) => (el: HTMLElement | null) => void;
  getHandleProps: (id: string, label: string) => ResizeHandleProps;
}) {
  const titleWidth = resolvedColWidth(columnWidths.title, '1fr');
  return (
    <div className="lib-row" role="row">
      {editModeActive && <div className="lib-cell lib-header-cell lib-col-cb" role="columnheader" aria-label="Select row" />}
      <HeaderCell
        label={config.titleHeader}
        sortKey={TITLE_SORT_KEY}
        sortable={!!config.titleSortable}
        sort={sort}
        onSort={onSort}
        width={titleWidth}
        cellRef={config.titleResizable ? registerCell('title') : undefined}
        resizeHandle={config.titleResizable ? getHandleProps('title', `Resize ${config.titleHeader} column`) : undefined}
      />
      {config.columns.map((col: LibraryColumn<TMy, TCommunity>) => {
        const resolvedWidth = resolvedColWidth(columnWidths[col.key], col.width);
        return (
          <HeaderCell
            key={col.key}
            label={col.header}
            sortKey={col.key}
            sortable={!!col.sortable}
            sort={sort}
            onSort={onSort}
            width={resolvedWidth}
            align={col.align}
            cellRef={col.resizable ? registerCell(col.key) : undefined}
            resizeHandle={col.resizable ? getHandleProps(col.key, `Resize ${col.header || col.key} column`) : undefined}
          />
        );
      })}
      {/* eslint-disable-next-line local/no-inline-style -- fixed actions-column width, same value as every page's spec table */}
      <div className="lib-cell lib-header-cell lib-align-right" role="columnheader" style={{ width: ACTIONS_COL_WIDTH } as React.CSSProperties} />
    </div>
  );
}

// ── Body row (extracted to keep the shell's complexity down) ──

function BodyRow<TMy extends { id: string }, TCommunity extends { id: string }>({
  row, listView, config, editModeActive, openRow, showToast, isAdmin,
}: {
  row: TMy | TCommunity;
  listView: LibraryVariant;
  config: LibraryListPageProps<TMy, TCommunity>['config'];
  editModeActive: boolean;
  openRow: (id: string) => void;
  showToast: (msg: string) => void;
  isAdmin: boolean;
}) {
  // t/4689: Ctrl/Cmd-click or middle-click opens the row in a new window/tab instead of
  // navigating in place — same gate (`openablePlace`) as the ⧉ button, so the two never
  // disagree. Middle-click fires onAuxClick (button 1), never onClick, in every browser.
  const openInWindowIfModified = (e: { ctrlKey: boolean; metaKey: boolean }): boolean => {
    if (editModeActive || !(e.ctrlKey || e.metaKey)) return false;
    const place = openablePlace(config, row, listView);
    if (!place) return false;
    openPlaceInNewWindow(place);
    return true;
  };

  return (
    <div
      className="lib-row lib-body-row"
      role="row"
      tabIndex={0}
      onClick={e => {
        if (openInWindowIfModified(e)) return;
        if (!editModeActive) openRow(row.id); else config.editMode?.onToggleSelect(row.id);
      }}
      onAuxClick={e => {
        if (e.button !== 1 || editModeActive) return;
        const place = openablePlace(config, row, listView);
        if (place) { e.preventDefault(); openPlaceInNewWindow(place); }
      }}
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
        <ActionsCell row={row} variant={listView} config={config} toast={showToast} editModeActive={editModeActive} isAdmin={isAdmin} />
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

// ── Phone layout: sort select (t/4571) ──

function SortSelect({
  sortKey, sortDir, onSort, columns, titleSortable,
}: {
  sortKey: string | null;
  sortDir: SortDir;
  onSort: (key: string) => void;
  columns: LibraryColumn<any, any>[];
  titleSortable?: boolean;
}) {
  const options = [
    { key: TITLE_SORT_KEY, label: 'Title' },
    ...columns.map(c => ({ key: c.key, label: c.header })),
  ].filter(o => (o.key === TITLE_SORT_KEY ? titleSortable : columns.find(c => c.key === o.key)?.sortable));

  if (options.length === 0) return null;

  // Unsorted shows a "Default order" placeholder instead of pretending Title is selected —
  // otherwise choosing Title first fires no change event, so Title could never be picked.
  const value = sortKey && sortDir !== 'none' ? sortKey : '';
  const dirGlyph = sortDir === 'asc' ? '▴' : '▾';

  return (
    <div className="lib-phone-sort-controls">
      <select
        id="lib-phone-sort-select"
        className="lib-phone-sort"
        value={value}
        onChange={e => { if (e.target.value) onSort(e.target.value); }}
      >
        <option value="" disabled>Default order</option>
        {options.map(opt => (
          <option key={opt.key} value={opt.key}>{opt.label}</option>
        ))}
      </select>
      {sortKey && sortDir !== 'none' && (
        <button
          type="button"
          className="lib-phone-sort-direction"
          title={sortDir === 'asc' ? 'Switch to descending' : 'Switch to ascending'}
          aria-label={sortDir === 'asc' ? 'Switch to descending' : 'Switch to ascending'}
          onClick={() => { if (sortKey) onSort(sortKey); }}
        >
          {dirGlyph}
        </button>
      )}
    </div>
  );
}

// ── Phone layout: trailing actions menu (t/4571, spec item 2) ──

function PhoneActionsMenu<TMy extends { id: string }, TCommunity extends { id: string }>({
  row, listView, config, editModeActive, showToast,
}: {
  row: TMy | TCommunity;
  listView: LibraryVariant;
  config: LibraryListPageProps<TMy, TCommunity>['config'];
  editModeActive: boolean;
  showToast: (msg: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setMenuOpen(false), []);

  useEffect(() => {
    if (!menuOpen) return;
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
  }, [menuOpen, close]);

  const title = config.getTitle(row, listView);

  if (editModeActive) {
    const rowActions = listView === 'my' ? config.editMode?.rowActions?.(row as TMy) ?? [] : [];
    return rowActions.length > 0 ? <RowEditActions actions={rowActions} /> : null;
  }

  const showCopy = listView === 'community' ? (config.showCopy ? config.showCopy(row as TCommunity) : true) : false;
  const place = openablePlace(config, row, listView);

  return (
    <div className="lib-phone-actions-menu-wrap" ref={wrapRef} onClick={e => e.stopPropagation()}>
      <button
        type="button"
        className="lib-phone-actions-btn"
        aria-label={`Actions for ${title}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen(!menuOpen)}
      >
        ⋯
      </button>
      {menuOpen && (
        <div role="menu" className="lib-phone-actions-menu">
          {place && (
            <button
              type="button"
              role="menuitem"
              className="lib-phone-menu-item"
              onClick={() => { close(); openPlaceInNewWindow(place); }}
            >
              Open in new window
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="lib-phone-menu-item"
            onClick={() => {
              close();
              const fmt = config.exportFormats[0]?.key;
              if (fmt) {
                if (listView === 'my') config.onExportMy(row as TMy, fmt);
                else config.onExportCommunity(row as TCommunity, fmt);
                showToast(`Exporting as ${config.exportFormats[0]?.label}`);
              }
            }}
          >
            Export
          </button>
          {listView === 'my' && (
            <button
              type="button"
              role="menuitem"
              className="lib-phone-menu-item"
              onClick={() => {
                close();
                config.onShare(row as TMy);
                showToast('Share link copied');
              }}
            >
              Share
            </button>
          )}
          {listView === 'community' && showCopy && (
            <button
              type="button"
              role="menuitem"
              className="lib-phone-menu-item"
              onClick={() => {
                close();
                config.onCopy(row as TCommunity);
                showToast(`Copied to My ${config.title}`);
              }}
            >
              Copy
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Phone layout: list item (t/4571) ──

function PhoneListRow<TMy extends { id: string }, TCommunity extends { id: string }>({
  row, listView, config, editModeActive, openRow, showToast,
}: {
  row: TMy | TCommunity;
  listView: LibraryVariant;
  config: LibraryListPageProps<TMy, TCommunity>['config'];
  editModeActive: boolean;
  openRow: (id: string) => void;
  showToast: (msg: string) => void;
}) {
  const metaColumns = config.columns.filter(c => c.phone === 'meta');
  const metaParts = metaColumns.map(c => c.render(row, listView));

  return (
    <div
      className="lib-phone-item"
      role="listitem"
      tabIndex={0}
      onClick={() => { if (!editModeActive) openRow(row.id); else config.editMode?.onToggleSelect(row.id); }}
      onKeyDown={e => {
        if (e.key !== 'Enter' || editModeActive) return;
        e.preventDefault();
        openRow(row.id);
      }}
    >
      {editModeActive && (
        <input
          type="checkbox"
          className="lib-phone-checkbox"
          aria-label={`Select ${config.getTitle(row, listView)}`}
          checked={config.editMode!.selectedIds.has(row.id)}
          onChange={() => config.editMode!.onToggleSelect(row.id)}
          onClick={e => e.stopPropagation()}
        />
      )}
      <div className="lib-phone-title-row">
        <span className="lib-phone-title">
          <TitleCell row={row} variant={listView} config={config} />
        </span>
      </div>
      {metaParts.length > 0 && (
        <div className="lib-phone-meta-row">
          {metaParts.map((part, i) => (
            <span key={i} className={`lib-phone-meta-part${i < metaParts.length - 1 ? ' lib-phone-meta-sep' : ''}`}>
              {part}
            </span>
          ))}
        </div>
      )}
      <div className="lib-phone-actions">
        <PhoneActionsMenu row={row} listView={listView} config={config} editModeActive={editModeActive} showToast={showToast} />
      </div>
    </div>
  );
}

// ── Phone layout: list wrapper (t/4571) ──

function PhoneListView<TMy extends { id: string }, TCommunity extends { id: string }>({
  sortedRows, listView, config, editModeActive, openRow, showToast, loading, hasRows, hasQuery,
}: {
  sortedRows: (TMy | TCommunity)[];
  listView: LibraryVariant;
  config: LibraryListPageProps<TMy, TCommunity>['config'];
  editModeActive: boolean;
  openRow: (id: string) => void;
  showToast: (msg: string) => void;
  loading: boolean;
  hasRows: boolean;
  hasQuery: boolean;
}) {
  const emptyLabel = listView === 'my' ? config.searchPlaceholderMy.replace(/^Search /, '').replace(/…$/, '') : config.title.toLowerCase();
  const hasSortedRows = sortedRows.length > 0;

  return (
    <div className="lib-phone-list" role="list">
      <EmptyStateRow
        loading={loading}
        hasSortedRows={hasSortedRows}
        hasRows={hasRows}
        hasQuery={!!hasQuery}
        query=""
        emptyLabel={emptyLabel}
      />
      {sortedRows.map(row => (
        <PhoneListRow
          key={row.id}
          row={row}
          listView={listView}
          config={config}
          editModeActive={editModeActive}
          openRow={openRow}
          showToast={showToast}
        />
      ))}
    </div>
  );
}

/** Phone layout at ≤767px — the same cut-off as LibraryListPage.css's phone media query. */
function useIsPhoneLayout(): boolean {
  const bp = useBreakpoint();
  return bp === 'phone' || bp === 'phone-lg';
}

// ── Component ──

export function LibraryListPage<TMy extends { id: string }, TCommunity extends { id: string }>(
  props: LibraryListPageProps<TMy, TCommunity>,
) {
  const {
    config, myRows, myLoading, communityRows, communityLoading, onOpenMy, onOpenCommunity,
    actionVisibility = 'hover', intro, defaultCommunityOnWeb = false, restoreKey,
  } = props;

  // t/3703#8: My-tab visibility is auth-driven, read here rather than taken as a prop — the
  // value (does THIS session have My content) is the same wherever it's computed, but making it
  // a prop would be three chances for a page to forget to pass it, producing a dead My tab on
  // whichever page slips. `config.anonymousHasMyContent` is the one thing that genuinely differs
  // per page (Op-Eds' temp anon session vs. Debates having nothing for anon) and is required, not
  // optional, so a page can't silently inherit a wrong default either.
  const auth = useAuthStatus();
  const hideMyTab = !!auth?.anonymous && !config.anonymousHasMyContent;
  // t/4643: Edit is admin-only on the Community tab (UX, not security — the server-side guard
  // is the actual enforcement). useIsAdmin() already fails closed to false while admin status
  // is loading and is unconditionally true in Electron, so there's no separate "loading" state
  // to plumb through here (AC4).
  const isAdmin = useIsAdmin();

  // t/4561: web-only initial-view default, opt-in per page via defaultCommunityOnWeb.
  // VITE_TARGET is a build-time constant (same convention as HelpDialog.tsx/App.tsx), so this
  // never changes after mount — no re-render risk from reading it in useState's initializer.
  const isWeb = import.meta.env.VITE_TARGET === 'web';
  const [listView, setListView] = useState<LibraryVariant>(
    () => initialListView(hideMyTab, defaultCommunityOnWeb, isWeb, restoreKey ? getLastVariant(restoreKey) : undefined),
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [sort, setSort] = useState<SortState>({ key: null, dir: 'none' });
  // t/4571: exactly one layout is in the DOM — rendering both and hiding one with CSS doubled
  // every row (duplicate text and controls for tests and assistive tech).
  const isPhone = useIsPhoneLayout();
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // t/4689: remember the tab across this page's unmount/remount (rail tab switch, or the
  // up-crumb). Only writes when restoreKey is set — omitting it keeps a page's behavior
  // byte-for-byte unchanged from before this feature existed.
  const switchTab = useCallback((v: LibraryVariant) => {
    setListView(v);
    setSearchQuery('');
    if (restoreKey) setLastVariant(restoreKey, v);
  }, [restoreKey]);

  // hideMyTab can flip true after mount (e.g. auth resolves anonymous after an optimistic 'my'
  // default) — force off 'my' rather than leave the view stuck on a tab whose button just
  // disappeared from the strip.
  useEffect(() => {
    if (hideMyTab && listView === 'my') setListView('community');
  }, [hideMyTab, listView]);

  // t/4643 AC3: a non-admin who switches to Community while in edit mode must not be left with
  // a stranded bulk-action bar — exit edit mode. Guarded on .active so it never fires onExit()
  // spuriously (e.g. on every admin-status refresh while already on Community, not editing).
  useEffect(() => {
    if (listView === 'community' && !isAdmin && config.editMode?.active) {
      config.editMode.onExit();
    }
  }, [listView, isAdmin, config.editMode?.active]);

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
  // t/4643: Edit is admin-only on Community. "The shell gates this once" per the ticket — any
  // tool that turns on config.showEdit later inherits the rule automatically.
  const canShowEdit = canShowEditFor(!!config.showEdit, listView, isAdmin);

  // t/4830: opt-in resizable columns — 'title' for config.titleResizable, col.key for each
  // LibraryColumn.resizable. A page with neither (every page before this ticket) gets an empty
  // `specs` map, so `widths` is always `{}` and gridCols below is byte-for-byte unchanged.
  const resizableSpecs = useMemo(
    () => collectResizableSpecs(config.titleResizable, config.columns),
    [config.titleResizable, config.columns],
  );
  const { widths: columnWidths, registerCell, getHandleProps } = useResizableColumns(restoreKey, resizableSpecs);

  const gridCols = [
    editModeActive ? CHECKBOX_COL_WIDTH : null,
    resolvedColWidth(columnWidths.title, '1fr'),
    ...config.columns.map(c => resolvedColWidth(columnWidths[c.key], c.width)),
    ACTIONS_COL_WIDTH,
  ].filter(Boolean).join(' ');

  const openRow = listView === 'my' ? onOpenMy : onOpenCommunity;
  const emptyLabel = listView === 'my' ? config.searchPlaceholderMy.replace(/^Search /, '').replace(/…$/, '') : config.title.toLowerCase();

  return (
    <div className="library-list-page" data-action-visibility={actionVisibility}>
      <HeaderRow1 config={config} editModeActive={editModeActive} canShowEdit={canShowEdit} />

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

      {isPhone ? (
        <>
          <PhoneSortBar sort={sort} onSort={onSort} config={config} />
          <PhoneListView
            sortedRows={sortedRows}
            listView={listView}
            config={config}
            editModeActive={editModeActive}
            openRow={openRow}
            showToast={showToast}
            loading={loading}
            hasRows={rows.length > 0}
            hasQuery={!!q}
          />
        </>
      ) : (
      <div className="lib-table-wrap">
        {/* eslint-disable-next-line local/no-inline-style -- per-page grid-template-columns, not a static class */}
        <div className="lib-grid" role="table" aria-label={`${config.title} ${listView === 'my' ? 'My' : 'Community'} table`} style={{ '--lib-cols': gridCols } as React.CSSProperties}>
          <GridHeaderRow
            config={config}
            sort={sort}
            onSort={onSort}
            editModeActive={editModeActive}
            columnWidths={columnWidths}
            registerCell={registerCell}
            getHandleProps={getHandleProps}
          />

          <EmptyStateRow loading={loading} hasSortedRows={sortedRows.length > 0} hasRows={rows.length > 0} hasQuery={!!q} query={searchQuery} emptyLabel={emptyLabel} />

          {sortedRows.map(row => (
            <BodyRow key={row.id} row={row} listView={listView} config={config} editModeActive={editModeActive} openRow={openRow} showToast={showToast} isAdmin={isAdmin} />
          ))}
        </div>
      </div>
      )}

      {toastMsg && <div className="lib-toast" role="status">{toastMsg}</div>}
    </div>
  );
}
