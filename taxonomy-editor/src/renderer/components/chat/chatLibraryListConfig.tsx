// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Chats' config for the shared LibraryListPage (t/3704, parent t/3702; contract from t/3703).
// Per the ticket: Chat supplies config only — title, "+ New Chat", no Edit button, the column
// set, and the data source/handlers. Header, tabs, search, row interaction, and the entire
// actions column (Export ▾ / Share / Copy / toast) come from LibraryListPage itself.

import type { LibraryListPageConfig, LibraryVariant } from '../shared/LibraryListPage.types';
import type { ChatSessionSummary, ChatMode } from '../../types/chat';
import type { CommunityChat } from '../../hooks/useCommunityStore';
import { CampGlyph, povToCamp } from '../shared/CampGlyph';
import type { CampKey } from '../shared/CampGlyph';
import './chatLibraryListConfig.css';

const MODE_LABELS: Record<ChatMode, string> = {
  brainstorm: 'Brainstorm',
  inform: 'Inform',
  decide: 'Decide',
};

const CAMP_LABEL: Record<CampKey, string> = {
  acc: 'Accelerationist',
  saf: 'Safetyist',
  skp: 'Skeptic',
};

/** t/4718: a colored camp chip beside the title, both tabs. `pover` lives on
 *  `ChatSessionSummary` (My) and, since t/4721, on `CommunityChat` too — both optional, so a
 *  missing/unresolvable value (old rows) renders no chip rather than an empty one. */
export function rowCampChip(row: ChatSessionSummary | CommunityChat, variant: LibraryVariant) {
  const pover = variant === 'my' ? (row as ChatSessionSummary).pover : (row as CommunityChat).pover;
  const camp = pover ? povToCamp(pover) : undefined;
  if (!camp) return null;
  return (
    <span className="chat-lib-camp-chip" data-camp={camp}>
      <CampGlyph camp={camp} size={12} className="chat-lib-camp-chip-icon" />
      {CAMP_LABEL[camp]}
    </span>
  );
}

/** Spec: "MMM DD, HH:mm" (e.g. "Aug 16, 10:48") — exact format, not locale-dependent. */
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatUpdated(iso: string): string {
  const d = new Date(iso);
  const month = MONTH_ABBR[d.getMonth()];
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${month} ${day}, ${hh}:${mm}`;
}

function rowMode(row: ChatSessionSummary | CommunityChat, variant: LibraryVariant): string {
  const mode = variant === 'my' ? (row as ChatSessionSummary).mode : (row as CommunityChat).mode;
  return mode ? (MODE_LABELS[mode as ChatMode] ?? mode) : '—';
}

function rowModel(row: ChatSessionSummary | CommunityChat, variant: LibraryVariant) {
  const model = variant === 'my' ? (row as ChatSessionSummary).chat_model : (row as CommunityChat).model;
  if (!model) return <span className="lib-empty-value">—</span>;
  // .lib-model: one line, ellipsis only on overflow (spec §2) — shared class, t/3702#11 F2.
  return <span className="lib-model" title={model}>{model}</span>;
}

export interface ChatLibraryListDeps {
  onRename: (id: string, newTitle: string) => void;
  renamingId: string | null;
  setRenamingId: (id: string | null) => void;
  onNew: () => void;
  onExportMy: (id: string, format: string) => void;
  onExportCommunity: (id: string, format: string) => void;
  onShare: (session: ChatSessionSummary) => void;
  onCopy: (chat: CommunityChat) => void;
}

export function buildChatLibraryListConfig(
  deps: ChatLibraryListDeps,
): LibraryListPageConfig<ChatSessionSummary, CommunityChat> {
  return {
    title: 'Chats',
    newLabel: '+ New Chat',
    onNew: deps.onNew,
    showEdit: false,

    // t/3703#8: anon sessions can save/delete their own ephemeral chats (accessControl.ts
    // isAnonUserContentRoute allows anon POST/PUT/DELETE on /api/chats*) — same shape as Op-Eds,
    // so the My tab isn't a dead tab for anonymous users.
    anonymousHasMyContent: true,

    columns: [
      {
        key: 'mode',
        header: 'Mode',
        width: '100px',
        render: rowMode,
      },
      {
        key: 'model',
        header: 'Model',
        width: '150px',
        render: rowModel,
      },
      {
        key: 'updated',
        header: 'Updated',
        width: '110px',
        sortable: true,
        // .lib-date: tabular numerals + nowrap, matching Op-Eds' date column (never truncated).
        render: (row) => <span className="lib-date">{formatUpdated(row.updated_at)}</span>,
        compare: (a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime(),
      },
    ],

    titleHeader: 'Title',
    titleSortable: true,
    getTitle: (row) => row.title,
    titleBadge: rowCampChip,

    onRename: deps.onRename,
    renamingId: deps.renamingId,
    setRenamingId: deps.setRenamingId,

    // Chats has no Op-Eds-style "N voices" line; only the Community authorship line applies.
    secondaryLine: (row, variant) =>
      variant === 'community' && (row as CommunityChat).community_metadata
        ? `by ${(row as CommunityChat).community_metadata!.submitted_by_display}`
        : null,

    searchPlaceholderMy: 'Search chats…',
    searchPlaceholderCommunity: 'Search chats from the community…',
    filter: (rows, query, _variant) => {
      const q = query.trim().toLowerCase();
      if (!q) return rows;
      return rows.filter((r) => (r.title ?? '').toLowerCase().includes(q));
    },

    // Chat export already supports pdf/json/markdown/text (ChatExportDropdown) — spec says
    // "keep whatever formats the backend already supports," not force Markdown/PDF/Word.
    exportFormats: [
      { key: 'markdown', label: 'Markdown' },
      { key: 'pdf', label: 'PDF' },
      { key: 'json', label: 'JSON' },
      { key: 'text', label: 'Text' },
    ],
    onExportMy: (row, format) => deps.onExportMy(row.id, format),
    onExportCommunity: (row, format) => deps.onExportCommunity(row.id, format),
    onShare: deps.onShare,
    onCopy: deps.onCopy,

    // t/4689: ⧉ / Ctrl-Cmd/middle-click open-in-new-window. Path matches placeOf.ts's chat route.
    itemPlace: (row) => ({ tool: 'chat', id: row.id, path: `/chat/${row.id}` }),
  };
}
