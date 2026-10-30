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
import { useInquiryStore } from '../../hooks/useInquiryStore';
import { useCommunityStore, type CommunityInquiry } from '../../hooks/useCommunityStore';
import type { InquiryResultSummary } from '../../bridge/types';
import { mapErrorToUserMessage } from '../../utils/errorMessages';
import { InquiryAskPanel } from './InquiryAskPanel';
import { InquiryRunningPanel } from './InquiryRunningPanel';
import { InquiryAnswerPanel } from './InquiryAnswerPanel';
import { LibraryListPage } from '../shared/LibraryListPage';
import type { LibraryListPageConfig, LibraryVariant } from '../shared/LibraryListPage.types';
import { InquiryGettingStarted } from './InquiryGettingStarted';
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
  } = useInquiryStore(useShallow(s => ({
    history: s.history, historyLoading: s.historyLoading, stopPolling: s._stopPolling,
    openFromHistory: s.openFromHistory, openCommunityResult: s.openCommunityResult, reset: s.reset,
    setQuestion: s.setQuestion, fetchHistory: s.fetchHistory, openList: s.openList,
  })));
  const screen = useInquiryStore(s => s.screen());
  const { inquiries, communityLoading, fetchInquiries, copyItem } = useCommunityStore(useShallow(s => ({
    inquiries: s.inquiries, communityLoading: s.loading, fetchInquiries: s.fetchInquiries, copyItem: s.copyItem,
  })));

  const [status, setStatus] = useState<string | null>(null);
  const { show: showAskDialog, open: openAskDialog, close: closeAskDialog } = useNewQuestionDialog();

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
    reset();
    openAskDialog();
  }, [reset, openAskDialog]);

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

  const myLibRows = useMemo<InquiryMyLibRow[]>(() => history.map(h => ({ ...h, id: h.jobId })), [history]);

  const libConfig: LibraryListPageConfig<InquiryMyLibRow, InquiryCommunityLibRow> = useMemo(() => ({
    title: 'Ask a Question',
    newLabel: '+ New Question',
    onNew: handleOpenNew,
    showEdit: false,
    // No anonymous-session special-casing exists for inquiries today (unlike Debates) — My
    // content is per-session the same way it is for everyone else.
    anonymousHasMyContent: true,
    titleHeader: 'Question',
    columns: [
      {
        key: 'status', header: 'Status', width: '110px',
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
        key: 'date', header: 'Asked', width: '140px', sortable: true,
        compare: (a, b, variant) => new Date(inquiryLibDate(a, variant)).getTime() - new Date(inquiryLibDate(b, variant)).getTime(),
        render: (row, variant) => <span className="lib-date">{formatLibDate(inquiryLibDate(row, variant))}</span>,
      },
    ],
    getTitle: row => row.question || 'Untitled question',
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
  }), [handleOpenNew, handleExportMy, handleExportCommunity, handleShare, handleCopy]);

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
        />
        {showAskDialog && <InquiryAskPanel onClose={handleCloseAskDialog} onStarted={closeAskDialog} />}
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
