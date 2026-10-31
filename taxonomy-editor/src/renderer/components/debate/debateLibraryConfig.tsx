// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Debates' config object for the shared LibraryListPage (t/3705, parent t/3702). Pure config +
// pure helper functions only — DebateTab.tsx wires this into <LibraryListPage>.
//
// Status-token mapping and column set are per TL/Design rulings on t/3705 (#2, #3, #4):
// the old DebateTable's 7 phases collapse to 5 status tokens; `cancelled` is a distinct token
// (hollow ring + literal "CANCELLED" label text, not a struck-through "CLOSED" — strikethrough
// decoration alone isn't reliably announced by screen readers, so the accessible name must carry it).

import type {
  LibraryColumn,
  LibraryEditModeAction,
  LibraryListPageConfig,
  LibraryRowEditAction,
  LibraryVariant,
} from '../shared/LibraryListPage.types';
import type { SessionRowData } from './debateSessionTypes';
import type { CommunityDebate } from '../../hooks/useCommunityStore';
import { filterCommunityDebates } from './communityFilter';
import './debateLibraryConfig.css';

type DebateRow = SessionRowData | CommunityDebate;

// ──────────────────────────────────────────────
// Status tokens (t/3705#3, t/3705#4 — authoritative, no placeholder)
// ──────────────────────────────────────────────

export type DebateStatusToken = 'setup' | 'opening' | 'active' | 'closed' | 'cancelled';

const PHASE_TO_STATUS_TOKEN: Record<string, DebateStatusToken> = {
  setup: 'setup',
  clarification: 'setup',
  'edit-claims': 'setup',
  opening: 'opening',
  debate: 'active',
  closed: 'closed',
  cancelled: 'cancelled',
};

/** Exported for testing — the 7-phase → 5-token collapse is the one piece of business logic
 *  in this file that isn't a straight pass-through, so it gets its own coverage. */
export function debatePhaseToStatusToken(phase: string | undefined): DebateStatusToken | null {
  if (!phase) return null;
  return PHASE_TO_STATUS_TOKEN[phase] ?? null;
}

const STATUS_LABEL: Record<DebateStatusToken, string> = {
  setup: 'Setup',
  opening: 'Opening',
  active: 'Active',
  closed: 'Closed',
  cancelled: 'Cancelled', // accessible name — the word carries the meaning, strikethrough is CSS-only decoration
};

/** t/4678/t/4683: true for a My-tab row that came from Ask a Question. Community debates don't
 *  carry `origin_mode` (not in scope, t/4678), so this is also the row-shape guard. */
function isInquiryRow(row: DebateRow): boolean {
  return 'origin_mode' in row && row.origin_mode === 'inquiry';
}

/** Status-label cell renderer. Returns `—` for an unmapped/missing phase rather than throwing —
 *  matches the shared component's empty-value convention. A "Question" pill (t/4683, TL ruling
 *  p/501#62: Debates-local, no shared titleBadge hook) sits before the status pill for rows from
 *  Ask a Question — real text, not colour alone, built from the existing `--lib-*` chip tokens. */
export function renderDebateStatus(row: DebateRow): import('react').ReactNode {
  const token = debatePhaseToStatusToken(row.phase);
  const badge = isInquiryRow(row) && <span className="debate-lib-question-badge">Question</span>;
  if (!token) return <>{badge}<span className="lib-empty-value">—</span></>;
  return (
    <>
      {badge}
      <span className={`debate-lib-status debate-lib-status--${token}`}>
        <span className="debate-lib-status-dot" aria-hidden="true" />
        {STATUS_LABEL[token]}
      </span>
    </>
  );
}

// ──────────────────────────────────────────────
// Date formatting — MMM DD, HH:mm, tabular numerals, nowrap (spec "Details easy to miss")
// ──────────────────────────────────────────────

export function formatDebateDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function renderDebateDate(iso: string | undefined): import('react').ReactNode {
  if (!iso) return <span className="lib-empty-value">—</span>;
  return <span className="debate-lib-date" title={iso}>{formatDebateDate(iso)}</span>;
}

// ──────────────────────────────────────────────
// Title — defensive against the t/2334 object-shape title corruption (see DebateTable.tsx)
// ──────────────────────────────────────────────

export function debateSafeTitle(row: DebateRow): string {
  const raw: unknown = row.title;
  if (typeof raw === 'string') return raw;
  return (raw as { final?: string; original?: string } | undefined)?.final
    ?? (raw as { final?: string; original?: string } | undefined)?.original
    ?? 'Untitled';
}

// ──────────────────────────────────────────────
// Filter — title + topic_text (My), delegates to the existing community filter (Community)
// ──────────────────────────────────────────────

export function filterDebateRows(
  rows: DebateRow[],
  query: string,
  variant: LibraryVariant,
): DebateRow[] {
  if (variant === 'community') {
    return filterCommunityDebates(rows as CommunityDebate[], query);
  }
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return (rows as SessionRowData[]).filter(s =>
    debateSafeTitle(s).toLowerCase().includes(q)
    || (s.topic_text && s.topic_text.toLowerCase().includes(q))
  );
}

// ──────────────────────────────────────────────
// Second line — Community: "by <author>"; My: "From Ask a Question" for inquiry rows (t/4678/
// t/4683), otherwise none
// ──────────────────────────────────────────────

export function debateSecondaryLine(row: DebateRow, variant: LibraryVariant): string | null {
  if (variant === 'community') {
    const author = (row as CommunityDebate).community_metadata?.submitted_by_display;
    return author ? `by ${author}` : null;
  }
  return isInquiryRow(row) ? 'From Ask a Question' : null;
}

// ──────────────────────────────────────────────
// Columns — Status · Turns (right-aligned) · Model · Date, all sortable (t/3705#2: none dropped)
// ──────────────────────────────────────────────

function localeCompare(a: string, b: string): number {
  return (a ?? '').localeCompare(b ?? '');
}

export const DEBATE_COLUMNS: LibraryColumn<SessionRowData, CommunityDebate>[] = [
  {
    key: 'status',
    header: 'Status',
    width: '100px',
    sortable: true,
    compare: (a, b) => localeCompare(a.phase ?? '', b.phase ?? ''),
    render: (row) => renderDebateStatus(row),
  },
  {
    key: 'turns',
    header: 'Turns',
    width: '50px',
    align: 'right',
    sortable: true,
    compare: (a, b) => (a.turn_count ?? 0) - (b.turn_count ?? 0),
    render: (row) => (row.turn_count != null ? row.turn_count : <span className="lib-empty-value">—</span>),
  },
  {
    key: 'model',
    header: 'Model',
    width: '170px',
    sortable: true,
    compare: (a, b) => localeCompare(a.model ?? '', b.model ?? ''),
    render: (row) => (
      <span className="lib-model" title={row.model}>
        {row.model || <span className="lib-empty-value">—</span>}
      </span>
    ),
  },
  {
    key: 'date',
    header: 'Date',
    width: '110px',
    sortable: true,
    compare: (a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime(),
    render: (row) => renderDebateDate(row.updated_at),
  },
];

// ──────────────────────────────────────────────
// Config builder — DebateTab supplies live handlers/state; everything above is pure
// ──────────────────────────────────────────────

export interface DebateLibraryConfigDeps {
  onNew?: () => void;
  editModeActive: boolean;
  onEditModeEnter: () => void;
  onEditModeExit: () => void;
  editModeActions: LibraryEditModeAction[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  /** Per-row edit affordances — rename + reorder, preserved per t/3705#2 ruling. */
  rowActions: (row: SessionRowData) => LibraryRowEditAction[];
  onRename: (id: string, newTitle: string) => void;
  renamingId: string | null;
  setRenamingId: (id: string | null) => void;
  onExportMy: (row: SessionRowData, format: string) => void;
  onExportCommunity: (row: CommunityDebate, format: string) => void;
  onShare: (row: SessionRowData) => void;
  onCopy: (row: CommunityDebate) => void;
  showCopy: (row: CommunityDebate) => boolean;
  /** Brief export (t/2805) — not a file format, so it rides `extraExportMenuItems` (t/3705#6,
   *  landed 11a51d02) rather than `exportFormats`. `briefWebOnly` mirrors today's desktop-disabled
   *  treatment: item stays visible with a web-app-only label instead of disappearing. */
  onBrief: (row: SessionRowData | CommunityDebate) => void;
  briefWebOnly: boolean;
}

export function buildDebateLibraryConfig(deps: DebateLibraryConfigDeps): LibraryListPageConfig<SessionRowData, CommunityDebate> {
  return {
    title: 'Debates',
    newLabel: '+ New Debate',
    onNew: deps.onNew,
    showEdit: true,
    // Confirmed via debateStore.ts (listDebateSessions/loadDebateSession/saveDebateSession/
    // deleteDebateSession all branch on isAnonymousUser() and route to anonymousSessionStore) —
    // anon sessions get full CRUD on their own debates, not an empty read path. My tab stays
    // visible for anon users (t/3705#7 gap 1, t/3703#8, p/501#22-23).
    anonymousHasMyContent: true,
    editMode: {
      active: deps.editModeActive,
      onEnter: deps.onEditModeEnter,
      onExit: deps.onEditModeExit,
      actions: deps.editModeActions,
      selectedIds: deps.selectedIds,
      onToggleSelect: deps.onToggleSelect,
      rowActions: deps.rowActions,
    },
    columns: DEBATE_COLUMNS,
    titleHeader: 'Motion',
    titleSortable: true,
    getTitle: (row) => debateSafeTitle(row as DebateRow),
    onRename: deps.onRename,
    renamingId: deps.renamingId,
    setRenamingId: deps.setRenamingId,
    secondaryLine: (row, variant) => debateSecondaryLine(row as DebateRow, variant),
    searchPlaceholderMy: 'Search debates…',
    searchPlaceholderCommunity: 'Search debates from the community…',
    filter: (rows, query, variant) => filterDebateRows(rows as DebateRow[], query, variant),
    exportFormats: [
      { key: 'pdf', label: 'PDF' },
      { key: 'json', label: 'JSON' },
      { key: 'markdown', label: 'Markdown' },
    ],
    onExportMy: deps.onExportMy,
    onExportCommunity: deps.onExportCommunity,
    extraExportMenuItems: (row) => [{
      label: deps.briefWebOnly ? 'Brief… (web app)' : 'Brief…',
      onClick: () => deps.onBrief(row),
      disabled: deps.briefWebOnly,
    }],
    onShare: deps.onShare,
    onCopy: deps.onCopy,
    showCopy: deps.showCopy,
  };
}
