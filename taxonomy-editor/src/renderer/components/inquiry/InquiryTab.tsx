// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Ask a Question tab (t/3583; library-page adoption t/4562). The persistent Ask/My/Community
// strip (t/3678) is gone — the My/Community list is now the tab's default landing view via
// LibraryListPage, matching Op-Eds/Chats/Debates (t/4536/t/4561). "+ New Question" (or a
// getting-started chip) now opens the New question dialog (t/4666) over the list, matching
// New Chat / New Op-Ed, instead of the retired full-page Ask screen. Running/Answer each carry
// their own way back to the list (openList) since the persistent strip no longer provides one.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { inquiryDisplayTitle } from '@lib/inquiry';
import { useInquiryStore } from '../../hooks/useInquiryStore';
import { useCommunityStore, type CommunityInquiry } from '../../hooks/useCommunityStore';
import type { InquiryResultSummary, InquiryResult } from '../../bridge/types';
import { mapErrorToUserMessage } from '../../utils/errorMessages';
import { useDialog } from '../shared/useDialog'; // t/4901
import { InquiryAskPanel } from './InquiryAskPanel';
import { InquiryRunningPanel } from './InquiryRunningPanel';
import { InquiryAnswerPanel } from './InquiryAnswerPanel';
import { LibraryListPage } from '../shared/LibraryListPage';
import type {
  LibraryListPageConfig, LibraryVariant, LibraryEditModeAction, LibraryRowEditAction,
} from '../shared/LibraryListPage.types';
import { InquiryGettingStarted } from './InquiryGettingStarted';
import './inquiryShareProvider'; // t/4786: side-effect registration for the location-bar ⧉ button
import './InquiryTab.css';

// LibraryListPage requires `{ id: string }`; InquiryResultSummary's own key is `jobId`.
type InquiryMyLibRow = InquiryResultSummary & { id: string };
type InquiryCommunityLibRow = CommunityInquiry;

// Exported for unit testing (t/4562 LibraryListPage adoption).
export function inquiryLibDate(row: InquiryMyLibRow | InquiryCommunityLibRow, variant: LibraryVariant): string {
  return variant === 'my' ? (row as InquiryMyLibRow).createdAt : ((row as InquiryCommunityLibRow).updated_at ?? (row as InquiryCommunityLibRow).created_at);
}

export function formatLibDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

export function inquiryCommunityAuthor(entry: CommunityInquiry): string | undefined {
  return entry.community_metadata?.submitted_by_display;
}

/** t/4898 (TL note, t/4898#2): always display via lib's `inquiryDisplayTitle()`, never an
 *  inline fallback — covers both the My row (`InquiryResultSummary`, flat `title`/`question`)
 *  and the Community row (`CommunityInquiry`, same two fields, now that admin rename writes
 *  `title`). Neither row carries a full `request`, so `request` is a minimal stand-in cast —
 *  the function only ever reads `request.title`/`request.question` off it. */
function inquiryRowDisplayTitle(row: InquiryMyLibRow | InquiryCommunityLibRow): string {
  return inquiryDisplayTitle({
    title: row.title,
    request: { question: row.question } as InquiryResult['request'],
  }) || 'Untitled question';
}

function recordError(component: string, message: string, err: unknown): void {
  getGlobalRecorder()?.record({
    type: 'system.error',
    component,
    level: 'error',
    message,
    error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
  });
}

// t/4666 — mirrors Chat's useNewChatDialog: local open state for the New question dialog, kept
// separate from the InquiryTab's own complexity (local/complexity-budget). Inquiry's draft
// question already lives in the store (unlike Chat's topic), so there's no local prefill field —
// a starter chip just writes straight to the store before opening, as it always has.
function useNewQuestionDialog() {
  const [show, setShow] = useState(false);
  const open = useCallback(() => setShow(true), []);
  const close = useCallback(() => setShow(false), []);
  return { show, open, close };
}

export function InquiryTab() {
  const {
    history, historyLoading, stopPolling, openFromHistory, openCommunityResult, reset, setQuestion, fetchHistory, openList,
    renameHistoryItem, deleteHistoryItem,
  } = useInquiryStore(useShallow(s => ({
    history: s.history, historyLoading: s.historyLoading, stopPolling: s._stopPolling,
    openFromHistory: s.openFromHistory, openCommunityResult: s.openCommunityResult, reset: s.reset,
    setQuestion: s.setQuestion, fetchHistory: s.fetchHistory, openList: s.openList,
    renameHistoryItem: s.renameHistoryItem, deleteHistoryItem: s.deleteHistoryItem,
  })));
  const screen = useInquiryStore(s => s.screen());
  const { inquiries, communityLoading, fetchInquiries, copyItem } = useCommunityStore(useShallow(s => ({
    inquiries: s.inquiries, communityLoading: s.loading, fetchInquiries: s.fetchInquiries, copyItem: s.copyItem,
  })));

  const [status, setStatus] = useState<string | null>(null);
  const { show: showAskDialog, open: openAskDialog, close: closeAskDialog } = useNewQuestionDialog();

  // Edit mode (t/4898): rename via the shared TitleCell, single/bulk delete with a confirm
  // step — mirrors DebateTab's edit mode, minus reorder (questions aren't reorderable).
  const [editMode, setEditMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);

  const exitEditMode = useCallback(() => {
    setEditMode(false);
    setSelectedIds(new Set());
    setRenamingId(null);
  }, []);

  // Poll-loop bounds (TL t/3583#4 point 3): unmount cleanup so navigating away from this tab
  // doesn't leave a dangling setTimeout chain polling forever.
  useEffect(() => stopPolling, [stopPolling]);

  // Eager-load both lists regardless of which screen is showing, mirroring OpEdTab/ChatTab —
  // the list screen is the default landing, not something reached only via an explicit action.
  useEffect(() => {
    void fetchHistory();
    void fetchInquiries();
  }, [fetchHistory, fetchInquiries]);

  const flash = useCallback((msg: string) => {
    setStatus(msg);
    setTimeout(() => setStatus(null), 4000);
  }, []);

  const handleOpenNew = useCallback(() => {
    setQuestion('');
    reset();
    openAskDialog();
  }, [setQuestion, reset, openAskDialog]);

  const handlePickStarter = useCallback((question: string) => {
    setQuestion(question);
    reset();
    openAskDialog();
  }, [setQuestion, reset, openAskDialog]);

  // Cancel / Esc / overlay click: back to the list, same destination the removed "← My
  // Questions" button went to.
  const handleCloseAskDialog = useCallback(() => {
    openList();
    closeAskDialog();
  }, [openList, closeAskDialog]);

  const handleExportMy = useCallback((row: InquiryMyLibRow, format: string) => {
    api.getInquiry(row.jobId).then(view => {
      if (!view.result) throw new Error('This question has no exportable result.');
      return api.exportInquiryToFile(view.result, row.question, format as 'json' | 'markdown' | 'pdf');
    }).catch(err => {
      recordError('inquiry-tab', 'Failed to export inquiry', err);
      flash(`Export failed: ${mapErrorToUserMessage(err)}`);
    });
  }, [flash]);

  const handleExportCommunity = useCallback((row: InquiryCommunityLibRow, format: string) => {
    api.loadCommunityInquiry(row.id).then(result => api.exportInquiryToFile(result, row.question, format as 'json' | 'markdown' | 'pdf')).catch(err => {
      recordError('inquiry-tab', 'Failed to export community inquiry', err);
      flash(`Export failed: ${mapErrorToUserMessage(err)}`);
    });
  }, [flash]);

  const handleShare = useCallback((row: InquiryMyLibRow) => {
    api.submitToCommunity('inquiry', { id: row.jobId })
      .then(() => flash('Shared to community.'))
      .catch(err => {
        recordError('inquiry-tab', 'Failed to share inquiry to community', err);
        flash(`Share failed: ${mapErrorToUserMessage(err)}`);
      });
  }, [flash]);

  const handleCopy = useCallback((row: InquiryCommunityLibRow) => {
    copyItem('inquiries', row.id).then(() => { void fetchHistory(); flash('Copied to My questions.'); }).catch(err => {
      recordError('inquiry-tab', 'Failed to copy community inquiry', err);
      flash(`Copy failed: ${mapErrorToUserMessage(err)}`);
    });
  }, [copyItem, fetchHistory, flash]);

  const handleRename = useCallback((jobId: string, title: string) => {
    renameHistoryItem(jobId, title).catch(err => {
      recordError('inquiry-tab', 'Failed to rename inquiry', err);
      flash(`Rename failed: ${mapErrorToUserMessage(err)}`);
    });
  }, [renameHistoryItem, flash]);

  // t/4898 (Quality, t/4898#3/p/356#166): a still-running delete is a plain HTTP 409 on web
  // (desktop never hits this — no persisted file exists until the run finishes). Mapped here
  // rather than in the store or bridge, which both just rethrow whatever the API call throws.
  const deleteFailureMessage = useCallback((err: unknown): string =>
    (err as { httpStatus?: number }).httpStatus === 409
      ? 'This question is still running — try deleting it again once it finishes.'
      : mapErrorToUserMessage(err), []);

  const handleDeleteOne = useCallback((jobId: string) => {
    deleteHistoryItem(jobId).catch(err => {
      recordError('inquiry-tab', 'Failed to delete inquiry', err);
      flash(`Delete failed: ${deleteFailureMessage(err)}`);
    });
  }, [deleteHistoryItem, deleteFailureMessage, flash]);

  const myLibRows = useMemo<InquiryMyLibRow[]>(() => history.map(h => ({ ...h, id: h.jobId })), [history]);

  const rowActions = useCallback((row: InquiryMyLibRow): LibraryRowEditAction[] => [
    { icon: 'rename', label: `Rename "${inquiryRowDisplayTitle(row)}"`, onClick: () => setRenamingId(row.id) },
  ], []);

  const editModeActions: LibraryEditModeAction[] = [
    { label: 'All', onClick: () => setSelectedIds(new Set(myLibRows.map(r => r.id))) },
    { label: 'None', onClick: () => setSelectedIds(new Set()) },
    ...(selectedIds.size > 0 ? [{ label: `Delete ${selectedIds.size}`, variant: 'danger' as const, onClick: () => setShowBulkDeleteConfirm(true) }] : []),
    { label: 'Done', onClick: exitEditMode },
  ];

  const libConfig: LibraryListPageConfig<InquiryMyLibRow, InquiryCommunityLibRow> = useMemo(() => ({
    title: 'Ask a Question',
    newLabel: '+ New Question',
    onNew: handleOpenNew,
    showEdit: true,
    // No anonymous-session special-casing exists for inquiries today (unlike Debates) — My
    // content is per-session the same way it is for everyone else.
    anonymousHasMyContent: true,
    editMode: {
      active: editMode,
      onEnter: () => setEditMode(true),
      onExit: exitEditMode,
      actions: editModeActions,
      selectedIds,
      onToggleSelect: (id) => setSelectedIds(prev => {
        if (!myLibRows.some(r => r.id === id)) return prev; // guard: edit mode is My-only
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      }),
      rowActions,
    },
    titleHeader: 'Question',
    columns: [
      {
        key: 'status', header: 'Status', width: '110px', phone: 'meta',
        render: (row, variant) => variant === 'my' && (row as InquiryMyLibRow).truncated
          ? (
            <span className="inquiry-lib-status inquiry-lib-status--partial">
              <span className="inquiry-lib-status-dot" aria-hidden="true" />
              Partial
            </span>
          )
          : <span className="lib-empty-value">—</span>,
      },
      {
        key: 'date', header: 'Asked', width: '140px', phone: 'meta', sortable: true,
        compare: (a, b, variant) => new Date(inquiryLibDate(a, variant)).getTime() - new Date(inquiryLibDate(b, variant)).getTime(),
        render: (row, variant) => <span className="lib-date">{formatLibDate(inquiryLibDate(row, variant))}</span>,
      },
    ],
    getTitle: row => inquiryRowDisplayTitle(row),
    onRename: handleRename,
    renamingId,
    setRenamingId,
    secondaryLine: (row, variant) => {
      if (variant !== 'community') return null;
      const entry = row as InquiryCommunityLibRow;
      const parts: string[] = [];
      if (entry.verdict_count > 0) parts.push(`${entry.verdict_count} verdicts`);
      const author = inquiryCommunityAuthor(entry);
      if (author) parts.push(`by ${author}`);
      return parts.length > 0 ? parts.join(' · ') : null;
    },
    searchPlaceholderMy: 'Search my questions…',
    searchPlaceholderCommunity: 'Search questions from the community…',
    filter: (rows, q) => rows.filter(r => !q || (r.question?.toLowerCase().includes(q.toLowerCase()) ?? false)),
    exportFormats: [{ key: 'markdown', label: 'Markdown' }, { key: 'json', label: 'JSON' }, { key: 'pdf', label: 'PDF' }],
    onExportMy: handleExportMy,
    onExportCommunity: handleExportCommunity,
    onShare: handleShare,
    onCopy: handleCopy,
    // t/4689: ⧉ / Ctrl-Cmd/middle-click open-in-new-window. Web-only per the ticket
    // (canOpenInNewWindow already gates Electron, which has no inquiry popout window type).
    itemPlace: row => ({ tool: 'inquiry', id: row.id, path: `/inquiry/${row.id}` }),
  }), [
    handleOpenNew, handleExportMy, handleExportCommunity, handleShare, handleCopy, handleRename,
    editMode, exitEditMode, editModeActions, selectedIds, myLibRows, rowActions, renamingId,
  ]);

  // t/4666: the New question dialog opens OVER the list rather than replacing it — the list
  // page stays rendered behind it (Design spec), so it shows whenever the store says 'list' OR
  // the dialog is open. The dialog's own open-time reset() flips viewingList false (so
  // screen() no longer reads 'list'); showAskDialog keeps the list rendered through that window
  // regardless, since there is no 'ask' case in the branch below anymore.
  if (screen === 'list' || showAskDialog) {
    return (
      <>
        {status && <div className="inquiry-status-inline" role="status">{status}</div>}
        <LibraryListPage
          config={libConfig}
          myRows={myLibRows}
          myLoading={historyLoading}
          communityRows={inquiries}
          communityLoading={communityLoading}
          onOpenMy={id => void openFromHistory(id)}
          onOpenCommunity={id => void openCommunityResult(id)}
          intro={<InquiryGettingStarted hasNoQuestions={myLibRows.length === 0} onPickStarter={handlePickStarter} />}
          defaultCommunityOnWeb
          restoreKey="inquiry"
        />
        {showAskDialog && <InquiryAskPanel onClose={handleCloseAskDialog} onStarted={closeAskDialog} />}
        {showBulkDeleteConfirm && (
          <BulkDeleteInquiryDialog
            rows={myLibRows}
            selectedIds={selectedIds}
            onCancel={() => setShowBulkDeleteConfirm(false)}
            onConfirm={async () => {
              for (const id of selectedIds) {
                try {
                  await deleteHistoryItem(id);
                } catch (err) {
                  recordError('inquiry-tab', 'Failed to delete inquiry (bulk)', err);
                  flash(`Delete failed: ${deleteFailureMessage(err)}`);
                }
              }
              setShowBulkDeleteConfirm(false);
              exitEditMode();
            }}
          />
        )}
      </>
    );
  }

  return (
    <div className="inquiry-tab">
      {screen === 'running' && <InquiryRunningPanel />}
      {screen === 'answer' && <InquiryAnswerPanel />}
    </div>
  );
}

// ── Bulk delete confirmation dialog (t/4898, mirrors DebateTab's BulkDeleteDialog) ──

function BulkDeleteInquiryDialog({ rows, selectedIds, onCancel, onConfirm }: {
  rows: InquiryMyLibRow[];
  selectedIds: Set<string>;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { dialogRef, titleId } = useDialog({ onCancel }); // t/4901
  const [deleting, setDeleting] = useState(false);
  return (
    <div className="dialog-overlay" onClick={() => { if (!deleting) onCancel(); }}>
      <div ref={dialogRef} className="dialog bulk-delete-dialog" role="dialog" aria-modal aria-labelledby={titleId} onClick={e => e.stopPropagation()}>
        <h3 id={titleId}>Delete {selectedIds.size} question{selectedIds.size !== 1 ? 's' : ''}?</h3>
        <div className="bulk-delete-list">
          {rows.filter(r => selectedIds.has(r.id)).map(r => (
            <div key={r.id} className="bulk-delete-item">
              <span className="bulk-delete-item-title">{inquiryRowDisplayTitle(r)}</span>
            </div>
          ))}
        </div>
        <div className="dialog-actions">
          <button className="btn" disabled={deleting} onClick={onCancel}>Cancel</button>
          <button
            className="btn btn-danger"
            disabled={deleting}
            onClick={async () => { setDeleting(true); await onConfirm(); }}
          >
            Delete {selectedIds.size} Question{selectedIds.size !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
