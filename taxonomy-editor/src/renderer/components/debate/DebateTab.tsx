// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect, useState, useCallback, useMemo } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { useDebateStore } from '../../hooks/useDebateStore';
import { useShallow } from 'zustand/react/shallow';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { useCommunityStore } from '../../hooks/useCommunityStore';
import type { CommunityDebate } from '../../hooks/useCommunityStore';
import { useResizablePanel } from '../../hooks/useResizablePanel';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useMobileNav } from '../../hooks/useMobileNav';
import { NewDebateDialog } from './NewDebateDialog';
import { DebateWorkspace } from '../debate-workspace';
import { ExportDropdown } from './ExportDropdown';
import { useDebateBriefExports, useRowBriefExport, type BriefTarget } from './DebateBriefExports';
import { useFlag } from '../../hooks/useFeatureFlags';
import { useAuthStatus } from '../../hooks/useAuthStatus';
import { SearchPreview } from '../edge-browser/SearchPreview';
import { PromptDetailPanel } from '../chat/PromptsPanel';
import type { PromptCatalogEntry } from '../../data/promptCatalog';
import { PROMPT_CATALOG } from '../../data/promptCatalog';
import { ToolbarPaneRenderer, isFullWidthPanel, PhoneToolClose } from '../shared/ToolbarPaneRenderer';
import { TheoryLink } from '../shared/TheoryLink';
import { LineageDetailView } from '../shared/LineageDetailView';
import type { DebateSession, SpeakerId } from '../../types/debate';
import { DebateGettingStarted } from './DebateGettingStarted';
import { POVER_INFO } from '@lib/debate/types';
import { ParameterHistoryPanel } from '../analysis/ParameterHistoryPanel';
import { usePreferencesStore } from '../../store/preferencesStore';
import { api, isElectronMode } from '@bridge';
import { trackExport } from '../../lib/analyticsEmitter';
// Condition 1 (t/2305): useBriefTimeoutEvents + toast/dialog removed from DebateTab.
// DebatePopoutWindow already mounts its own useBriefTimeoutEvents — the correct home.
// activeDebateId is never set in table mode (no loadDebate on row click) → events
// would match every debate (guard always falsy), producing orphan toasts here.
import type { SessionRowData } from './debateSessionTypes';
import { LibraryListPage } from '../shared/LibraryListPage';
import type { LibraryEditModeAction, LibraryRowEditAction } from '../shared/LibraryListPage.types';
import { buildDebateLibraryConfig, debateSafeTitle } from './debateLibraryConfig';
import './DebateTab.css';

// Prop-type aliases derived from the hooks/stores so the extracted presentational
// sub-components stay in lockstep with the source types (no cross-boundary imports).
type SessionSummary = ReturnType<typeof useDebateStore.getState>['sessions'][number];
type NavApi = ReturnType<typeof useMobileNav>;
type AuthStatus = ReturnType<typeof useAuthStatus>;
type ResizablePanel = ReturnType<typeof useResizablePanel>;
type CopyDebateFn = (type: 'chats' | 'debates', communityId: string) => Promise<string>;

// Props for the library-list left panel — thin now that header/tabs/search/table/actions all
// live inside <LibraryListPage> (t/3705). Just the resizable-panel chrome + the config it needs.
interface DebateLibraryPanelProps {
  width: number;
  fullWidth: boolean;
  setListCollapsed: Dispatch<SetStateAction<boolean>>;
  config: ReturnType<typeof buildDebateLibraryConfig>;
  myRows: SessionRowData[];
  myLoading: boolean;
  communityRows: CommunityDebate[];
  communityLoading: boolean;
  onOpenMy: (id: string) => void;
  onOpenCommunity: (id: string) => void;
  intro: ReactNode;
}

// Shared prop bag for the right (detail) pane subtree.
interface DebateRightPaneProps {
  toolbarPanel: string | null;
  promptInspectorActive: boolean;
  onMouseDown: ResizablePanel['onMouseDown'];
  onTouchStart: ResizablePanel['onTouchStart'];
  searchPreviewId: string | null;
  setSearchPreviewId: Dispatch<SetStateAction<string | null>>;
  selectedPromptEntry: PromptCatalogEntry | null;
  lineagePreviewValue: string | null;
  setLineagePreviewValue: Dispatch<SetStateAction<string | null>>;
  isPhone: boolean;
  activeDebate: DebateSession | null;
  selectedCommunityDebate: CommunityDebate | null;
  /** Which variant was last opened — drives the detail-pane branch on phone now that tab
   *  selection lives inside <LibraryListPage> and DebateTab has no visibility into it (t/3705#7,
   *  gap 1 still open with Rosetta re: anon-tab suppression; this is the "which item is showing"
   *  question, orthogonal to that). */
  lastOpenedVariant: 'my' | 'community';
  nav: NavApi;
  handleExport: (format?: string) => void;
  exportStatus: string | null;
  handleNewDebate: () => Promise<void>;
}

const PHASE_LABELS: Record<string, string> = {
  setup: 'Setup',
  clarification: 'Awaiting input',
  'edit-claims': 'Editing',
  opening: 'Opening',
  debate: 'Active',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

const SOURCE_TYPE_LABELS: Record<string, string> = {
  topic: 'Topic',
  document: 'Document',
  url: 'Web URL',
  situations: 'Cross-cutting',
};

const POVER_LABELS: Record<string, { label: string; color: string }> = {
  accelerationist: { label: POVER_INFO.accelerationist.label, color: POVER_INFO.accelerationist.color },
  safetyist: { label: POVER_INFO.safetyist.label, color: POVER_INFO.safetyist.color },
  skeptic: { label: POVER_INFO.skeptic.label, color: POVER_INFO.skeptic.color },
  user: { label: 'You', color: 'var(--text-muted)' },
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDateLong(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Picks the correct session loader for pdf/markdown export (t/2400).
 * Exported for unit testing — do not call from outside DebateTab.
 */
export function resolveExportLoader(
  rowSession: Pick<SessionRowData, 'id' | 'community'>,
  loadPersonal: (id: string) => Promise<unknown>,
  loadCommunity: (id: string) => Promise<unknown>,
): Promise<unknown> {
  return rowSession.community ? loadCommunity(rowSession.id) : loadPersonal(rowSession.id);
}

export function DebateTab() {
  const {
    sessions, sessionsLoading, loadSessions,
    activeDebateId, activeDebate, loadDebate, deleteDebate, renameDebate,
  } = useDebateStore(
    useShallow(s => ({
      sessions: s.sessions, sessionsLoading: s.sessionsLoading, loadSessions: s.loadSessions,
      activeDebateId: s.activeDebateId, activeDebate: s.activeDebate, loadDebate: s.loadDebate, deleteDebate: s.deleteDebate, renameDebate: s.renameDebate,
    }))
  );
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [pendingExportFormat, setPendingExportFormat] = useState<string | null>(null);
  // Condition 2 (t/2305): tracks which row session triggered a pdf/markdown export
  // (so ExportOptionsDialog can load + export the correct session, not activeDebate).
  const [pendingExportSession, setPendingExportSession] = useState<SessionRowData | null>(null);
  const [selectedPromptEntry, setSelectedPromptEntry] = useState<PromptCatalogEntry | null>(PROMPT_CATALOG[0]);
  const [promptInspectorActive, setPromptInspectorActive] = useState(false);
  const { toolbarPanel } = useTaxonomyStore();
  const { width, onMouseDown, onTouchStart } = useResizablePanel();
  const breakpoint = useBreakpoint();
  const isPhone = breakpoint === 'phone' || breakpoint === 'phone-lg';
  const isTablet = breakpoint === 'tablet' || breakpoint === 'tablet-lg';
  const nav = useMobileNav();
  const [showNewDialog, setShowNewDialog] = useState(false);
  // t/4563: starter-chip prefill for NewDebateDialog — null means today's unprefilled open.
  const [debatePrefill, setDebatePrefill] = useState<{ topic: string; povers?: readonly SpeakerId[] } | null>(null);
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [listCollapsed, setListCollapsed] = useState(false);
  const [searchPreviewId, setSearchPreviewId] = useState<string | null>(null);
  const [lineagePreviewValue, setLineagePreviewValue] = useState<string | null>(null);
  // Which variant was last opened — <LibraryListPage> owns tab selection internally now, so this
  // is DebateTab's own record of "which detail to show on phone" (t/3705#7).
  const [lastOpenedVariant, setLastOpenedVariant] = useState<'my' | 'community'>('my');
  const { debates: communityDebates, loading: communityLoading, fetchDebates: fetchCommunityDebates, copyItem } = useCommunityStore();
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [selectedCommunityDebate, setSelectedCommunityDebate] = useState<CommunityDebate | null>(null);
  const auth = useAuthStatus();

  // t/4563: shared by the unprefilled "+ New Debate" path and the getting-started chips, so the
  // quota pre-check lives once. Returns whether the caller may proceed to open the dialog.
  const checkDebateQuota = useCallback(async (): Promise<boolean> => {
    setQuotaError(null);
    try {
      const quota = await api.getDebateQuotaStatus();
      if (!quota.allowed) {
        setQuotaError(`Debate limit reached (${quota.current}/${quota.limit}). Delete existing debates to free up quota.`);
        return false;
      }
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-tab', level: 'warn', message: 'Quota pre-check failed — opening dialog anyway', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    }
    return true;
  }, []);

  const handleNewDebate = useCallback(async () => {
    if (!(await checkDebateQuota())) return;
    setDebatePrefill(null);
    setShowNewDialog(true);
  }, [checkDebateQuota]);

  const handlePickDebateStarter = useCallback(async (topic: string, povers?: readonly SpeakerId[]) => {
    if (!(await checkDebateQuota())) return;
    setDebatePrefill({ topic, povers });
    setShowNewDialog(true);
  }, [checkDebateQuota]);

  const closeNewDebateDialog = useCallback(() => {
    setShowNewDialog(false);
    setDebatePrefill(null);
  }, []);

  // Custom sort order (persisted to localStorage)
  const [customOrder, setCustomOrder] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('debate-custom-order');
      return saved ? JSON.parse(saved) : [];
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'debate-tab',
        level: 'warn',
        message: 'Failed to load custom debate order from localStorage',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return [];
    }
  });

  const saveCustomOrder = useCallback((order: string[]) => {
    setCustomOrder(order);
    localStorage.setItem('debate-custom-order', JSON.stringify(order));
  }, []);

  // Apply custom ordering: sessions not yet in the custom order (e.g. newly
  // created debates) float to the top in server order (newest-first), followed
  // by manually-ordered sessions in their saved order. This keeps a user's
  // drag-arrangement intact while ensuring new debates are immediately visible
  // instead of being buried below a long custom-ordered list.
  const orderedSessions = useMemo(() => {
    if (customOrder.length === 0) return sessions;
    const orderMap = new Map(customOrder.map((id, i) => [id, i]));
    const ordered = [...sessions].sort((a, b) => {
      const ai = orderMap.get(a.id);
      const bi = orderMap.get(b.id);
      if (ai !== undefined && bi !== undefined) return ai - bi;
      if (ai !== undefined) return 1;  // a is pinned, b is new — new (b) first
      if (bi !== undefined) return -1; // b is pinned, a is new — new (a) first
      return 0; // both unordered — keep server order (newest-first)
    });
    return ordered;
  }, [sessions, customOrder]);

  const moveSession = useCallback((id: string, direction: 'up' | 'down') => {
    // Build full order array from current display order
    const ids = orderedSessions.map(s => s.id);
    const idx = ids.indexOf(id);
    if (idx < 0) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= ids.length) return;
    [ids[idx], ids[targetIdx]] = [ids[targetIdx], ids[idx]];
    saveCustomOrder(ids);
  }, [orderedSessions, saveCustomOrder]);

  const exitEditMode = useCallback(() => {
    setEditMode(false);
    setSelectedIds(new Set());
    setRenamingId(null);
  }, []);

  useEffect(() => {
    void loadSessions();
    void fetchCommunityDebates();
  }, [loadSessions, fetchCommunityDebates]);

  // Condition 2 (t/2305): runExport accepts explicit `session` so table rows can pass
  // their own data directly — `activeDebate` from the store is not loaded on row click,
  // so falling back to it would produce a no-op for per-row Export/Share actions.
  const runExport = useCallback(async (
    format: string,
    exportOptions?: { includeTaxonomyRefs?: boolean; includeReasoning?: boolean },
    session?: unknown,
  ) => {
    const target = session ?? activeDebate;
    if (!target) return;
    const targetId = (target as { id?: string }).id ?? '';
    try {
      const result = await api.exportDebateToFile(
        target,
        format as 'json' | 'markdown' | 'text' | 'pdf' | 'package',
        exportOptions,
      );
      if (!result.cancelled && result.filePath) {
        setExportStatus(`Exported to ${result.filePath}`);
        trackExport(format, targetId);
        setTimeout(() => setExportStatus(null), 4000);
      }
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'debate-tab',
        level: 'error',
        message: 'Debate export failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setExportStatus(`Export failed: ${err}`);
      setTimeout(() => setExportStatus(null), 4000);
    }
  }, [activeDebate]);

  // Phone / DebateWorkspace inline export path (activeDebate is set via handleSelect).
  const handleExport = (format: string = 'json') => {
    if (!activeDebate) return;
    if (format === 'markdown' || format === 'pdf') {
      setPendingExportFormat(format);
      setPendingExportSession(null); // activeDebate path — no pendingExportSession
      return;
    }
    void runExport(format);
  };

  // ── Table row handlers (t/2305) ──────────────────────────────────────────────

  // Condition 3 (t/2305 web path): openDebateWindow already has a working web-bridge
  // impl (openAppWindow(`debate-window?id=…`)) — no stub to fix, confirmed in web-bridge.ts.
  const handleRowOpen = useCallback((id: string) => {
    api.openDebateWindow(id).then((result) => {
      if (result && result.atCap) {
        setQuotaError('Close a debate window — max 5 open');
      }
    }).catch((err: Error) => {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'debate-tab',
        level: 'warn',
        message: 'Failed to open debate popout window',
        error: { name: err.name ?? 'Error', message: String(err), stack: err.stack },
      });
    });
  }, []);

  // Community debates must propagate source=community so the popout's runLoad routes
  // to loadCommunityDebateSession instead of the personal endpoint (t/2399).
  const handleCommunityRowOpen = useCallback((id: string) => {
    api.openDebateWindow(id, 'community').then((result) => {
      if (result && result.atCap) {
        setQuotaError('Close a debate window — max 5 open');
      }
    }).catch((err: Error) => {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'debate-tab',
        level: 'warn',
        message: 'Failed to open community debate popout window',
        error: { name: err.name ?? 'Error', message: String(err), stack: err.stack },
      });
    });
  }, []);

  // Per-row export — loads full session on demand so the main process has transcript
  // data for markdown/pdf formatters (summary alone is insufficient for rich formats).
  const handleRowExport = useCallback(async (session: SessionRowData, format: string) => {
    if (format === 'markdown' || format === 'pdf') {
      // Need options dialog first; stash session so onConfirm can use it.
      setPendingExportFormat(format);
      setPendingExportSession(session);
      return;
    }
    try {
      const full = await api.loadDebateSession(session.id);
      await runExport(format, undefined, full);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'debate-tab',
        level: 'error',
        message: 'Row export: failed to load full session',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setExportStatus(`Export failed: ${err}`);
      setTimeout(() => setExportStatus(null), 4000);
    }
  }, [runExport]);

  // Per-row share (My tab) — loads full session, then submits to community.
  const handleRowShare = useCallback(async (session: SessionRowData): Promise<void> => {
    const full = await api.loadDebateSession(session.id);
    await api.submitToCommunity('debate', full);
  }, []);

  // Per-row export for community debates.
  const handleRowCommunityExport = useCallback(async (cd: CommunityDebate, format: string) => {
    if (format === 'markdown' || format === 'pdf') {
      setPendingExportFormat(format);
      setPendingExportSession({ id: cd.id, title: cd.title, updated_at: cd.updated_at, phase: cd.phase ?? '', created_at: cd.updated_at, community: true });
      return;
    }
    try {
      const full = await api.loadCommunityDebateSession(cd.id);
      await runExport(format, undefined, full);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'debate-tab',
        level: 'error',
        message: 'Community row export: failed to load session',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setExportStatus(`Export failed: ${err}`);
      setTimeout(() => setExportStatus(null), 4000);
    }
  }, [runExport]);

  const rowBrief = useRowBriefExport(isElectronMode());

  // Row-open — branches on phone vs desktop inside the handler DebateTab owns (t/3702#5 gap 2
  // ruling: no shared per-device contract needed, this is page-side logic behind one callback).
  const handleOpenMy = useCallback((id: string) => {
    if (isPhone) {
      if (id !== activeDebateId) void loadDebate(id);
      setLastOpenedVariant('my');
      nav.push({ view: 'debate', id });
      return;
    }
    handleRowOpen(id);
  }, [isPhone, activeDebateId, loadDebate, nav, handleRowOpen]);

  const handleOpenCommunity = useCallback((id: string) => {
    if (isPhone) {
      const cd = communityDebates.find(c => c.id === id) ?? null;
      setSelectedCommunityDebate(cd);
      setLastOpenedVariant('community');
      if (cd) nav.push({ view: 'detail', id });
      return;
    }
    handleCommunityRowOpen(id);
  }, [isPhone, communityDebates, nav, handleCommunityRowOpen]);

  const handleCopyCommunity = useCallback(async (cd: CommunityDebate): Promise<void> => {
    setCopyingId(cd.id);
    try {
      await copyItem('debates', cd.id);
      void loadSessions();
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'debate-tab',
        level: 'error',
        message: 'Failed to copy community debate',
        error: { name: (err as Error).name ?? 'Error', message: String(err) },
      });
    } finally {
      setCopyingId(null);
    }
  }, [copyItem, loadSessions]);

  // Per-row edit-mode affordances — rename + reorder, preserved as icon descriptors per the
  // shared contract (t/3705#2, LibraryRowEditAction). Position/boundary comes from customOrder,
  // matching moveSession's own semantics — independent of whatever sort LibraryListPage applies.
  const rowActions = useCallback((row: SessionRowData): LibraryRowEditAction[] => {
    const ids = orderedSessions.map(s => s.id);
    const idx = ids.indexOf(row.id);
    const title = debateSafeTitle(row);
    return [
      { icon: 'rename', label: `Rename "${title}"`, onClick: () => setRenamingId(row.id) },
      { icon: 'moveUp', label: `Move "${title}" up`, disabled: idx <= 0, onClick: () => moveSession(row.id, 'up') },
      { icon: 'moveDown', label: `Move "${title}" down`, disabled: idx === -1 || idx === ids.length - 1, onClick: () => moveSession(row.id, 'down') },
    ];
  }, [orderedSessions, moveSession]);

  // Bulk-action bar — same All/None/Delete/Reset-Order/Done set as today, as button descriptors
  // (t/3705#2). Community-row clicks can't reach onToggleSelect in normal use (edit mode only
  // ever activates from the My-tab header), but guard defensively anyway: LibraryListPage has no
  // tab-switch hook to auto-exit edit mode (t/3705#7), so a stray id can't reach bulk delete.
  const editModeActions: LibraryEditModeAction[] = [
    { label: 'All', onClick: () => setSelectedIds(new Set(sessions.map(s => s.id))) },
    { label: 'None', onClick: () => setSelectedIds(new Set()) },
    ...(selectedIds.size > 0 ? [{ label: `Delete ${selectedIds.size}`, variant: 'danger' as const, onClick: () => setShowBulkDeleteConfirm(true) }] : []),
    ...(customOrder.length > 0 ? [{ label: 'Reset Order', onClick: () => saveCustomOrder([]) }] : []),
    { label: 'Done', onClick: exitEditMode },
  ];

  const libraryConfig = buildDebateLibraryConfig({
    // Anon users can create/save/list their own debates — server persists them via
    // anonymousSessionStore and GET /api/debates returns them (debateStore.ts:135, confirmed
    // t/3705#7 gap 1 investigation, p/501#22). Gating +New on `!auth?.anonymous` (today's
    // behavior, inherited pre-t/3705) hid a real capability; not carrying that bug forward.
    onNew: () => { void handleNewDebate(); },
    editModeActive: editMode,
    onEditModeEnter: () => setEditMode(true),
    onEditModeExit: exitEditMode,
    editModeActions,
    selectedIds,
    onToggleSelect: (id) => setSelectedIds(prev => {
      if (!sessions.some(s => s.id === id)) return prev; // guard: see comment above
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    }),
    rowActions,
    onRename: (id, title) => { void renameDebate(id, title); },
    renamingId,
    setRenamingId,
    onExportMy: (row, fmt) => { void handleRowExport(row, fmt); },
    onExportCommunity: (row, fmt) => { void handleRowCommunityExport(row, fmt); },
    onShare: (row) => { void handleRowShare(row); },
    onCopy: (row) => { void handleCopyCommunity(row); },
    showCopy: () => !auth?.anonymous,
    onBrief: (row) => rowBrief.openRowBrief({ id: row.id, title: debateSafeTitle(row), phase: row.phase ?? '' }),
    briefWebOnly: isElectronMode(),
  });

  const rightPaneProps: DebateRightPaneProps = {
    toolbarPanel, promptInspectorActive, onMouseDown, onTouchStart, searchPreviewId,
    setSearchPreviewId, selectedPromptEntry, lineagePreviewValue, setLineagePreviewValue,
    isPhone, activeDebate, selectedCommunityDebate, lastOpenedVariant, nav, handleExport,
    exportStatus, handleNewDebate,
  };

  // Table mode: no toolbarPanel active and not phone — list is full-width, no inline detail.
  // Phone still gets the right pane for DebateWorkspace navigation (Condition 3).
  const isTableMode = !toolbarPanel && !isPhone;

  return (
    <div className={[
      'two-column',
      isPhone ? 'phone-mode' : '',
      isTablet ? 'tablet-mode' : '',
      (isPhone ? nav.current.view !== 'list' : false) && !toolbarPanel ? 'has-selection' : '',
      isTableMode ? 'debate-tab-table-mode' : '',
    ].filter(Boolean).join(' ')}>
      {/* Left pane: Session list OR toolbar panel (Search, Prompts, etc.) */}
      {toolbarPanel ? (
        <ToolbarLeftPanel
          toolbarPanel={toolbarPanel}
          promptInspectorActive={promptInspectorActive}
          width={width}
          isPhone={isPhone}
          setSearchPreviewId={setSearchPreviewId}
          setLineagePreviewValue={setLineagePreviewValue}
          setSelectedPromptEntry={setSelectedPromptEntry}
          setPromptInspectorActive={setPromptInspectorActive}
        />
      ) : (listCollapsed && !isPhone) ? (
        <div className="pane-collapsed pane-collapsed-list" onClick={() => setListCollapsed(false)} title="Expand list">
          <span className="pane-collapsed-label">Debates</span>
        </div>
      ) : (
        <DebateLibraryPanel
          width={width}
          fullWidth={isTableMode}
          setListCollapsed={setListCollapsed}
          config={libraryConfig}
          myRows={orderedSessions}
          myLoading={sessionsLoading}
          communityRows={communityDebates}
          communityLoading={communityLoading}
          onOpenMy={handleOpenMy}
          onOpenCommunity={handleOpenCommunity}
          intro={<DebateGettingStarted hasNoDebates={orderedSessions.length === 0} onPickStarter={handlePickDebateStarter} />}
        />
      )}

      {/* Right pane: toolbar detail or phone workspace — hidden in desktop table mode */}
      {!isTableMode && <DebateRightPane {...rightPaneProps} />}

      {quotaError && (
        <div className="debate-error debate-tab-quota-error">
          <span>{quotaError}</span>
          <button className="debate-tab-quota-dismiss" onClick={() => setQuotaError(null)}>&times;</button>
        </div>
      )}
      {showNewDialog && (
        <NewDebateDialogHost
          prefill={debatePrefill}
          onClose={closeNewDebateDialog}
          onAtCap={() => setQuotaError('Close a debate window — max 5 open')}
        />
      )}
      {pendingExportFormat && (
        <ExportOptionsDialog
          format={pendingExportFormat}
          onCancel={() => { setPendingExportFormat(null); setPendingExportSession(null); }}
          onConfirm={(opts) => {
            const fmt = pendingExportFormat;
            const rowSession = pendingExportSession;
            setPendingExportFormat(null);
            setPendingExportSession(null);
            if (rowSession) {
              // Table row export — load full session then export.
              // (activeDebate is not set in table mode; Condition 2)
              resolveExportLoader(rowSession, api.loadDebateSession, api.loadCommunityDebateSession).then(full => {
                void runExport(fmt, opts, full);
              }).catch((err: Error) => {
                getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-tab', level: 'error', message: 'Row pdf/md export: failed to load session', error: { name: err.name ?? 'Error', message: String(err), stack: err.stack } });
                setExportStatus(`Export failed: ${err}`);
                setTimeout(() => setExportStatus(null), 4000);
              });
            } else {
              // Phone / detail-pane path — activeDebate is already loaded.
              void runExport(fmt, opts);
            }
          }}
        />
      )}
      {rowBrief.rowBriefNode}
      {showBulkDeleteConfirm && (
        <BulkDeleteDialog
          sessions={sessions}
          selectedIds={selectedIds}
          setShowBulkDeleteConfirm={setShowBulkDeleteConfirm}
          setEditMode={setEditMode}
          setSelectedIds={setSelectedIds}
          deleteDebate={deleteDebate}
        />
      )}
      {/* BriefTimeoutToast + BriefTimeoutDialog removed (Condition 1, t/2305).
          DebatePopoutWindow already mounts its own copies — the correct home. */}
    </div>
  );
}

// ── Toolbar left panel (Search / Prompts / Lineage / etc.) ──

function ToolbarLeftPanel({
  toolbarPanel, promptInspectorActive, width, isPhone,
  setSearchPreviewId, setLineagePreviewValue, setSelectedPromptEntry, setPromptInspectorActive,
}: {
  toolbarPanel: string | null;
  promptInspectorActive: boolean;
  width: number;
  isPhone: boolean;
  setSearchPreviewId: Dispatch<SetStateAction<string | null>>;
  setLineagePreviewValue: Dispatch<SetStateAction<string | null>>;
  setSelectedPromptEntry: Dispatch<SetStateAction<PromptCatalogEntry | null>>;
  setPromptInspectorActive: Dispatch<SetStateAction<boolean>>;
}) {
  return (
    <div className={`list-panel${isFullWidthPanel(toolbarPanel, promptInspectorActive) ? ' list-panel-full' : ''}`}
         // eslint-disable-next-line local/no-inline-style -- dynamic: resizable panel width, conditional undefined
         style={isFullWidthPanel(toolbarPanel, promptInspectorActive) ? undefined : { width }}>
      {isPhone && <PhoneToolClose />}
      <ToolbarPaneRenderer
        panel={toolbarPanel}
        onSelectResult={(id) => setSearchPreviewId(id)}
        onSelectLineageValue={setLineagePreviewValue}
        onSelectPrompt={setSelectedPromptEntry}
        onInspectorToggle={setPromptInspectorActive}
      />
    </div>
  );
}

// ── Debate library panel — thin resizable-panel chrome + the shared list component (t/3705) ──
//
// Header row 1 (title/Edit/+New), tabs+search, grid, row interaction, and the entire actions
// column all live inside <LibraryListPage> now — this wrapper supplies only what has nowhere
// else to go: the resizable-width style, and the collapse-chevron + TheoryLink docs-link that
// the handoff doesn't describe and the shared header has no slot for (t/3705#7 gap 3, TL ruling
// p/501#20 — page-owned strip, no contract change).
//
// Known gap, not yet raised: in Electron, community debates aren't supported and today's
// DebateCommunityList short-circuits to an explanatory notice instead of an empty table. The
// shared component's EmptyStateRow has no per-variant custom-message hook, so Electron users see
// the generic "No community debates yet." here instead. Flagging for whoever reviews this file
// rather than working around it by suppressing the Community tab (a bigger behavior change).
// Thin host so the debatePrefill?.topic / debatePrefill?.povers optional-chains live in their
// own function scope, not DebateTab's own complexity count (local/complexity-budget) — mirrors
// ChatTab's NewChatDialogHost.
function NewDebateDialogHost({ prefill, onClose, onAtCap }: {
  prefill: { topic: string; povers?: readonly SpeakerId[] } | null;
  onClose: () => void;
  onAtCap: () => void;
}) {
  return <NewDebateDialog onClose={onClose} onAtCap={onAtCap} initialTopic={prefill?.topic} initialPovers={prefill?.povers} />;
}

function DebateLibraryPanel(props: DebateLibraryPanelProps) {
  const {
    width, fullWidth, setListCollapsed, config, myRows, myLoading, communityRows, communityLoading,
    onOpenMy, onOpenCommunity, intro,
  } = props;
  return (
    // eslint-disable-next-line local/no-inline-style -- dynamic: resizable panel width, omitted in fullWidth/table mode
    <div className="list-panel debate-session-list" style={fullWidth ? undefined : { width }}>
      <div className="debate-lib-accessory-strip">
        <TheoryLink docPath="docs/debate-system-overview.md" />
        {!fullWidth && (
          <button className="pane-collapse-btn" onClick={() => setListCollapsed(true)} title="Collapse" aria-label="Collapse panel">&lsaquo;</button>
        )}
      </div>
      <LibraryListPage
        config={config}
        myRows={myRows}
        myLoading={myLoading}
        communityRows={communityRows}
        communityLoading={communityLoading}
        onOpenMy={onOpenMy}
        onOpenCommunity={onOpenCommunity}
        intro={intro}
        defaultCommunityOnWeb
      />
    </div>
  );
}

// ── Right pane (context-dependent) ──

function DebateRightPane(props: DebateRightPaneProps) {
  const {
    toolbarPanel, promptInspectorActive, onMouseDown, onTouchStart, searchPreviewId,
    setSearchPreviewId, selectedPromptEntry, lineagePreviewValue, setLineagePreviewValue,
  } = props;
  return isFullWidthPanel(toolbarPanel, promptInspectorActive) ? null
    : toolbarPanel === 'search' ? (
    <>
      <div className="resize-handle" onMouseDown={onMouseDown} onTouchStart={onTouchStart} />
      <div className="detail-panel">
        <SearchPreview searchPreviewId={searchPreviewId} onClear={() => setSearchPreviewId(null)} />
      </div>
    </>
  ) : (toolbarPanel === 'prompts' && !promptInspectorActive) ? (
    <>
      <div className="resize-handle" onMouseDown={onMouseDown} onTouchStart={onTouchStart} />
      <div className="detail-panel">
        <PromptDetailPanel entry={selectedPromptEntry} />
      </div>
    </>
  ) : toolbarPanel === 'lineage' ? (
    <>
      <div className="resize-handle" onMouseDown={onMouseDown} onTouchStart={onTouchStart} />
      <div className="detail-panel">
        <LineageDetailView value={lineagePreviewValue} onSelectValue={setLineagePreviewValue} />
      </div>
    </>
  ) : toolbarPanel ? (
    <>
      <div className="resize-handle" onMouseDown={onMouseDown} onTouchStart={onTouchStart} />
      <div className="detail-panel">
        <div className="detail-panel-empty">Select an item in the {toolbarPanel} panel</div>
      </div>
    </>
  ) : (
    <DebateDetailPane {...props} />
  );
}

function DebateDetailPane(props: DebateRightPaneProps) {
  const {
    onMouseDown, onTouchStart, isPhone, activeDebate, selectedCommunityDebate,
    lastOpenedVariant, nav, handleExport, exportStatus, handleNewDebate,
  } = props;
  const debateAuth = useAuthStatus();
  return (
    <>
      <div className="resize-handle" onMouseDown={onMouseDown} onTouchStart={onTouchStart} />
      <div className="detail-panel">
        {isPhone && (activeDebate || selectedCommunityDebate) && (
          <div className="phone-detail-header">
            <button className="phone-detail-back" onClick={() => nav.pop()}>
              &larr; Debates
            </button>
          </div>
        )}
        {lastOpenedVariant === 'community' && selectedCommunityDebate ? (
          <CommunityDebateDetail debate={selectedCommunityDebate} />
        ) : activeDebate ? (
          isPhone ? (
            <DebateWorkspace onExport={handleExport} exportStatus={exportStatus} />
          ) : (
            <DebateDetailSummary
              debate={activeDebate}
              onOpenWindow={() => api.openDebateWindow(activeDebate.id).catch((err) => {
                getGlobalRecorder()?.record({
                  type: 'system.error',
                  component: 'debate-tab',
                  level: 'warn',
                  message: 'Failed to open debate popout window — debate stays inline',
                  error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
                });
              })}
              onExport={handleExport}
              exportStatus={exportStatus}
            />
          )
        ) : (
          <div className="debate-empty-state">
            <h2>Perspective Debater</h2>
            <p>Select a debate from the list or create a new one.</p>
            {!debateAuth?.anonymous && (
              <button className="btn" onClick={handleNewDebate}>
                + New Debate
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ── Bulk delete confirmation dialog ──

function BulkDeleteDialog({
  sessions, selectedIds, setShowBulkDeleteConfirm, setEditMode, setSelectedIds, deleteDebate,
}: {
  sessions: SessionSummary[];
  selectedIds: Set<string>;
  setShowBulkDeleteConfirm: Dispatch<SetStateAction<boolean>>;
  setEditMode: Dispatch<SetStateAction<boolean>>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  deleteDebate: (id: string) => Promise<void>;
}) {
  return (
    <div className="dialog-overlay" onClick={() => setShowBulkDeleteConfirm(false)}>
      <div className="dialog bulk-delete-dialog" onClick={e => e.stopPropagation()}>
        <h3>Delete {selectedIds.size} debate{selectedIds.size !== 1 ? 's' : ''}?</h3>
        <div className="bulk-delete-list">
          {sessions.filter(s => selectedIds.has(s.id)).map(s => (
            <div key={s.id} className="bulk-delete-item">
              <span className="bulk-delete-item-title">{typeof s.title === 'string' ? s.title : (s.title as any)?.final ?? (s.title as any)?.original ?? '(Untitled)'}</span>
              <span className="bulk-delete-item-meta">{s.phase} &middot; {formatDate(s.updated_at)}</span>
            </div>
          ))}
        </div>
        <div className="bulk-delete-note">
          Session files will be permanently deleted. Harvested items (conflicts, steelman refinements, debate refs) are preserved.
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={() => setShowBulkDeleteConfirm(false)}>Cancel</button>
          <button
            className="btn btn-danger"
            onClick={async () => {
              for (const id of selectedIds) {
                await deleteDebate(id);
              }
              setShowBulkDeleteConfirm(false);
              setEditMode(false);
              setSelectedIds(new Set());
            }}
          >
            Delete {selectedIds.size} Debate{selectedIds.size !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Debate Detail Summary ──

function DebateDetailSummary({
  debate,
  onOpenWindow,
  onExport,
  exportStatus,
}: {
  debate: DebateSession;
  onOpenWindow: () => void;
  onExport: (format: string) => void;
  exportStatus: string | null;
}) {
  const [showCalibration, setShowCalibration] = useState(false);
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  // Brief Export (t/2805, T7) — web-only v1; the menu item signals web-only on desktop.
  const brief = useDebateBriefExports(debate, isElectronMode());
  // Calibration is an admin/power-user tool — show only for admins (t/1036).
  // Desktop (Electron) owners are admin-equivalent; web requires the admin flag.
  // useFlag is a hook — call it unconditionally, never inside the `||` short-circuit
  // (rules-of-hooks, t/2299); a conditional call crashed the debate popup (t/2298).
  const adminFlag = useFlag('permission-admin-features');
  const showAdminControls = isElectronMode() || adminFlag;
  const viewMode = usePreferencesStore(s => s.viewMode);
  const topic = debate.topic.final || debate.topic.refined || debate.topic.original;

  const handleShare = useCallback(async () => {
    try {
      setShareStatus('Submitting...');
      const { submissionId } = await api.submitToCommunity('debate', debate);
      setShareStatus(`Shared! (${submissionId.slice(0, 8)})`);
      setTimeout(() => setShareStatus(null), 4000);
    } catch (err: unknown) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'debate-detail-summary',
        level: 'error',
        message: 'Failed to share debate to community',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      const msg = err instanceof Error ? err.message : String(err);
      setShareStatus(`Failed: ${msg}`);
      setTimeout(() => setShareStatus(null), 4000);
    }
  }, [debate]);

  return (
    <div className="debate-detail-summary">
      <div className="debate-detail-header">
        <div>
          <h2 className="debate-detail-title">{debate.title}</h2>
          <span className="debate-tab-detail-id">{debate.id}</span>
        </div>
        <span className={`debate-phase-badge phase-${debate.phase}`}>
          {PHASE_LABELS[debate.phase] || debate.phase}
        </span>
      </div>

      <div className="debate-detail-actions">
        <button className="btn btn-primary" onClick={onOpenWindow}>
          Open in Window
        </button>
        <div className="debate-detail-povers">
          {debate.active_povers.map(p => {
            const info = POVER_LABELS[p] ?? { label: p, color: 'var(--text-muted)' };
            return (
              // eslint-disable-next-line local/no-inline-style -- dynamic: pover accent border color
              <span key={p} className="debate-detail-pover" style={{ borderColor: info.color }}>
                {info.label}
              </span>
            );
          })}
        </div>
        <div className="debate-tab-spacer" />
        <ExportDropdown onExport={onExport} onBrief={brief.openBrief} briefWebOnly={isElectronMode()} />
        {showAdminControls && viewMode !== 'simple' && (
          <button className="btn" onClick={() => setShowCalibration(!showCalibration)}>
            Calibration
          </button>
        )}
        <button className="btn" onClick={handleShare} disabled={!!shareStatus}>
          {shareStatus || 'Share to Community'}
        </button>
        {exportStatus && <span className="debate-detail-export-status">{exportStatus}</span>}
      </div>

      {brief.node}

      {showCalibration && viewMode !== 'simple' && (
        <ParameterHistoryPanel onClose={() => setShowCalibration(false)} />
      )}

      {/* Topic — full width, scrollable */}
      <div className="debate-detail-topic-row">
        <h3>Topic</h3>
        <div className="debate-detail-topic-scroll">
          <p className="debate-detail-topic">{topic}</p>
          {debate.topic.refined && debate.topic.refined !== debate.topic.original && (
            <p className="debate-detail-topic-original">
              <span className="debate-detail-label">Original:</span> {debate.topic.original}
            </p>
          )}
        </div>
      </div>

      <div className="debate-detail-grid">
        {viewMode !== 'simple' && <DebateStatsSection debate={debate} />}

        {viewMode !== 'simple' && (
          <div className="debate-detail-section">
            <h3>Timestamps</h3>
            <div className="debate-detail-meta-row">
              <span className="debate-detail-label">Created:</span>
              <span>{formatDateLong(debate.created_at)}</span>
            </div>
            <div className="debate-detail-meta-row">
              <span className="debate-detail-label">Updated:</span>
              <span>{formatDateLong(debate.updated_at)}</span>
            </div>
          </div>
        )}

        {viewMode !== 'simple' && <DebateSourceSection debate={debate} />}

        {viewMode !== 'simple' && <DebateConfigSection debate={debate} />}
      </div>
    </div>
  );
}

function DebateStatsSection({ debate }: { debate: DebateSession }) {
  const turnCount = debate.transcript?.filter(t => t.type === 'statement' || t.type === 'opening').length ?? 0;
  const anNodeCount = debate.argument_network?.nodes?.length ?? 0;
  const anEdgeCount = debate.argument_network?.edges?.length ?? 0;

  return (
    <div className="debate-detail-section">
      <h3>Statistics</h3>
      <div className="debate-detail-stats">
        <div className="debate-detail-stat">
          <span className="debate-detail-stat-value">{turnCount}</span>
          <span className="debate-detail-stat-label">Turns</span>
        </div>
        {anNodeCount > 0 && (
          <div className="debate-detail-stat">
            <span className="debate-detail-stat-value">{anNodeCount}</span>
            <span className="debate-detail-stat-label">Arguments</span>
          </div>
        )}
        {anEdgeCount > 0 && (
          <div className="debate-detail-stat">
            <span className="debate-detail-stat-value">{anEdgeCount}</span>
            <span className="debate-detail-stat-label">Relations</span>
          </div>
        )}
        {debate.neutral_evaluations && debate.neutral_evaluations.length > 0 && (
          <div className="debate-detail-stat">
            <span className="debate-detail-stat-value">{debate.neutral_evaluations.length}</span>
            <span className="debate-detail-stat-label">Evaluations</span>
          </div>
        )}
      </div>
    </div>
  );
}

function DebateSourceSection({ debate }: { debate: DebateSession }) {
  return (
    <div className="debate-detail-section">
      <h3>Source</h3>
      <div className="debate-detail-meta-row">
        <span className="debate-detail-label">Type:</span>
        <span>{SOURCE_TYPE_LABELS[debate.source_type] ?? debate.source_type}</span>
      </div>
      {debate.source_ref && (
        <div className="debate-detail-meta-row">
          <span className="debate-detail-label">Reference:</span>
          <span className="debate-detail-source-ref" title={debate.source_ref}>
            {debate.source_type === 'document'
              ? debate.source_ref.split('/').pop()
              : debate.source_ref}
          </span>
        </div>
      )}
    </div>
  );
}

export function DebateConfigSection({ debate }: { debate: DebateSession }) {
  if (!(debate.audience || debate.debate_model || debate.protocol_id || debate.origin)) return null;
  return (
    <div className="debate-detail-section">
      <h3>Configuration</h3>
      {debate.origin && (
        <div className="debate-detail-meta-row">
          <span className="debate-detail-label">Created via:</span>
          <span>{debate.origin.mode === 'cli' ? 'CLI (headless runner)' : 'GUI (Electron app)'}</span>
        </div>
      )}
      {debate.origin?.command && (
        <div className="debate-detail-meta-row debate-tab-command-row">
          <span className="debate-detail-label">Command:</span>
          <code className="debate-tab-command-code">{debate.origin.command}</code>
        </div>
      )}
      {debate.audience && (
        <div className="debate-detail-meta-row">
          <span className="debate-detail-label">Audience:</span>
          <span>{debate.audience.replace(/_/g, ' ')}</span>
        </div>
      )}
      {debate.debate_model && (
        <div className="debate-detail-meta-row">
          <span className="debate-detail-label">Model:</span>
          <span>{debate.debate_model}</span>
        </div>
      )}
      {debate.protocol_id && (
        <div className="debate-detail-meta-row">
          <span className="debate-detail-label">Protocol:</span>
          <span>{debate.protocol_id}</span>
        </div>
      )}
      {debate.model_tier && (
        <div className="debate-detail-meta-row">
          <span className="debate-detail-label">Model Tier:</span>
          <span>{debate.model_tier}</span>
        </div>
      )}
      <div className="debate-detail-meta-row">
        <span className="debate-detail-label">Well-tested exclusion:</span>
        <span>{debate.exclude_greatest_hits ? 'On' : 'Off'}</span>
      </div>
      {debate.speaker_models && Object.keys(debate.speaker_models).length > 0 && (
        <div className="debate-tab-speaker-models">
          <span className="debate-detail-label debate-tab-speaker-models-label">Speaker Models:</span>
          <table className="debate-tab-speaker-table">
            <thead>
              <tr className="debate-tab-speaker-thead-row">
                <th className="debate-tab-speaker-th">Speaker</th>
                <th className="debate-tab-speaker-th">Model</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(debate.speaker_models).map(([speaker, model]) => (
                <tr key={speaker} className="debate-tab-speaker-tbody-row">
                  <td className="debate-tab-speaker-td">{speaker}</td>
                  <td className="debate-tab-speaker-td-model">{model}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Community Debate Detail ──

function CommunityDebateDetail({ debate }: { debate: CommunityDebate }) {
  const [full, setFull] = useState<DebateSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFull(null);
    setError(null);
    setLoading(true);
    api.loadCommunityDebateSession(debate.id).then(raw => {
      if (cancelled) return;
      if (raw && typeof raw === 'object' && 'found' in (raw as Record<string, unknown>) && !(raw as Record<string, unknown>).found) {
        setError('Debate not found — it may have been removed.');
        return;
      }
      setFull(raw as DebateSession);
    }).catch(err => {
      if (cancelled) return;
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'community-debate-detail',
        level: 'error',
        message: 'Failed to load community debate detail',
        error: { name: (err as Error).name ?? 'Error', message: String(err) },
      });
      setError('Could not load debate details.');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [debate.id]);

  const handleOpenWindow = useCallback(() => {
    // iPad/iOS Safari drops auth cookies when window.open'ing a new tab (t/1520),
    // so on mobile navigate in-place via the hash router instead of a new window.
    // Detection mirrors web-bridge.ts isMobilePlatform() — see dedup TODO in t/1520.
    const hash = `debate-window?id=${encodeURIComponent(debate.id)}&source=community`;
    const isMobile = /iPad|iPhone|iPod|Android/i.test(navigator.userAgent)
      || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent));
    if (isMobile) {
      window.location.hash = hash;
    } else {
      window.open(`${location.origin}/#${hash}`, '_blank');
    }
  }, [debate.id]);

  const topic = full?.topic ? (full.topic.final || full.topic.refined || full.topic.original) : null;

  return (
    <div className="debate-detail-summary">
      <div className="debate-detail-header">
        <div>
          <h2 className="debate-detail-title">{debate.title}</h2>
          <span className="debate-tab-detail-id">{debate.id}</span>
        </div>
        {debate.phase && (
          <span className={`debate-phase-badge phase-${debate.phase}`}>
            {PHASE_LABELS[debate.phase] || debate.phase}
          </span>
        )}
      </div>

      <div className="debate-detail-actions">
        <button className="btn btn-primary" onClick={handleOpenWindow} disabled={loading || !!error}>
          Open in Window
        </button>
        {full?.active_povers && full.active_povers.length > 0 && (
          <div className="debate-detail-povers">
            {full.active_povers.map(p => {
              const info = POVER_LABELS[p] ?? { label: p, color: 'var(--text-muted)' };
              return (
                // eslint-disable-next-line local/no-inline-style -- dynamic: pover accent border color
                <span key={p} className="debate-detail-pover" style={{ borderColor: info.color }}>
                  {info.label}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {loading && <p className="debate-tab-loading-text">Loading debate details...</p>}
      {error && <p className="debate-tab-error-text">{error}</p>}

      {/* Topic */}
      {topic && (
        <div className="debate-detail-topic-row">
          <h3>Topic</h3>
          <div className="debate-detail-topic-scroll">
            <p className="debate-detail-topic">{topic}</p>
          </div>
        </div>
      )}

      <div className="debate-detail-grid">
        {/* Statistics */}
        <CommunityStatsSection full={full} />

        <div className="debate-detail-section">
          <h3>Timestamps</h3>
          <div className="debate-detail-meta-row">
            <span className="debate-detail-label">Created:</span>
            <span>{formatDateLong(debate.created_at)}</span>
          </div>
          <div className="debate-detail-meta-row">
            <span className="debate-detail-label">Updated:</span>
            <span>{formatDateLong(debate.updated_at)}</span>
          </div>
        </div>

        {/* Source */}
        <CommunitySourceSection full={full} />

        {/* Configuration */}
        <CommunityConfigSection full={full} />

        {/* Community Info */}
        <CommunityInfoSection debate={debate} />
      </div>
    </div>
  );
}

function CommunityStatsSection({ full }: { full: DebateSession | null }) {
  if (!full) return null;
  const turnCount = full.transcript?.filter(t => t.type === 'statement' || t.type === 'opening').length ?? 0;
  const anNodeCount = full.argument_network?.nodes?.length ?? 0;
  const anEdgeCount = full.argument_network?.edges?.length ?? 0;
  return (
    <div className="debate-detail-section">
      <h3>Statistics</h3>
      <div className="debate-detail-stats">
        <div className="debate-detail-stat">
          <span className="debate-detail-stat-value">{turnCount}</span>
          <span className="debate-detail-stat-label">Turns</span>
        </div>
        {anNodeCount > 0 && (
          <div className="debate-detail-stat">
            <span className="debate-detail-stat-value">{anNodeCount}</span>
            <span className="debate-detail-stat-label">Arguments</span>
          </div>
        )}
        {anEdgeCount > 0 && (
          <div className="debate-detail-stat">
            <span className="debate-detail-stat-value">{anEdgeCount}</span>
            <span className="debate-detail-stat-label">Relations</span>
          </div>
        )}
      </div>
    </div>
  );
}

function CommunitySourceSection({ full }: { full: DebateSession | null }) {
  if (!full?.source_type) return null;
  return (
    <div className="debate-detail-section">
      <h3>Source</h3>
      <div className="debate-detail-meta-row">
        <span className="debate-detail-label">Type:</span>
        <span>{SOURCE_TYPE_LABELS[full.source_type] ?? full.source_type}</span>
      </div>
    </div>
  );
}

function CommunityConfigSection({ full }: { full: DebateSession | null }) {
  if (!(full && (full.audience || full.debate_model))) return null;
  return (
    <div className="debate-detail-section">
      <h3>Configuration</h3>
      {full.audience && (
        <div className="debate-detail-meta-row">
          <span className="debate-detail-label">Audience:</span>
          <span>{full.audience.replace(/_/g, ' ')}</span>
        </div>
      )}
      {full.debate_model && (
        <div className="debate-detail-meta-row">
          <span className="debate-detail-label">Model:</span>
          <span>{full.debate_model}</span>
        </div>
      )}
    </div>
  );
}

function CommunityInfoSection({ debate }: { debate: CommunityDebate }) {
  if (!debate.community_metadata) return null;
  return (
    <div className="debate-detail-section">
      <h3>Community Info</h3>
      <div className="debate-detail-meta-row">
        <span className="debate-detail-label">Submitted:</span>
        <span>{formatDateLong(debate.community_metadata.submitted_at)}</span>
      </div>
      <div className="debate-detail-meta-row">
        <span className="debate-detail-label">Approved:</span>
        <span>{formatDateLong(debate.community_metadata.approved_at)}</span>
      </div>
    </div>
  );
}

// ── Export Options Dialog ──

const EXPORT_OPTIONS_STORAGE_KEY = 'debate-export-options';

interface ExportOptions {
  includeTaxonomyRefs: boolean;
  includeReasoning: boolean;
}

function loadExportOptions(): ExportOptions {
  try {
    const raw = localStorage.getItem(EXPORT_OPTIONS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        includeTaxonomyRefs: parsed.includeTaxonomyRefs ?? true,
        includeReasoning: parsed.includeReasoning ?? true,
      };
    }
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'debate-tab',
      level: 'warn',
      message: 'Failed to load export options from localStorage',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
  return { includeTaxonomyRefs: true, includeReasoning: true };
}

function ExportOptionsDialog({
  format,
  onCancel,
  onConfirm,
}: {
  format: string;
  onCancel: () => void;
  onConfirm: (options: ExportOptions) => void;
}) {
  const [options, setOptions] = useState<ExportOptions>(loadExportOptions);
  const formatLabel = format === 'markdown' ? 'Markdown' : format === 'pdf' ? 'PDF' : format;

  const handleConfirm = () => {
    try {
      localStorage.setItem(EXPORT_OPTIONS_STORAGE_KEY, JSON.stringify(options));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'debate-tab',
        level: 'warn',
        message: 'Failed to save export options to localStorage',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }
    onConfirm(options);
  };

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Export {formatLabel} Options</h3>
        <div className="debate-tab-export-options">
          <label className="debate-tab-export-option-label">
            <input
              type="checkbox"
              checked={options.includeTaxonomyRefs}
              onChange={(e) => setOptions(o => ({ ...o, includeTaxonomyRefs: e.target.checked }))}
            />
            <span>Include taxonomy references</span>
          </label>
          {/* eslint-disable-next-line local/no-inline-style -- dynamic: disabled-state cursor/opacity */}
          <label style={{
            display: 'flex', alignItems: 'center', gap: 8,
            cursor: options.includeTaxonomyRefs ? 'pointer' : 'not-allowed',
            opacity: options.includeTaxonomyRefs ? 1 : 0.5,
            paddingLeft: 20,
          }}>
            <input
              type="checkbox"
              checked={options.includeReasoning}
              disabled={!options.includeTaxonomyRefs}
              onChange={(e) => setOptions(o => ({ ...o, includeReasoning: e.target.checked }))}
            />
            <span>Include reasoning (relevance text)</span>
          </label>
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" onClick={handleConfirm}>Export</button>
        </div>
      </div>
    </div>
  );
}
