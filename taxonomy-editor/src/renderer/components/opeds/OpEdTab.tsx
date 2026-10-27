// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// OpEdTab — Op-Ed Studio shell (t/2576 PR#1). Mirrors DebateTab's two-column →
// table-mode information architecture: a My / Community split, a full-width table,
// and per-row Open / Export / Share (My) or Open / Export / Copy (Community). An
// op-ed is static text, so "Open" reads it inline (no popout) — selecting a set
// swaps the workspace to OpEdReader with a back control.
//
// Create is PR#2 — the "+ New Op-Ed" button is present but DISABLED here (t/2570#3).

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { api, isElectronMode } from '@bridge';
import { useAuthStatus } from '../../hooks/useAuthStatus';
import { useOpEdStore } from '../../hooks/useOpEdStore';
import { useCommunityStore } from '../../hooks/useCommunityStore';
import type { OpEdSet, OpEdSetSummary, OpEdCommunityEntry } from '../../../../../lib/oped/types';
import { mapErrorToUserMessage } from '../../utils/errorMessages';
import { LibraryListPage } from '../shared/LibraryListPage';
import type { LibraryListPageConfig, LibraryVariant } from '../shared/LibraryListPage.types';
import { OpEdCampTags } from './OpEdCampTags';
import { OpEdReader } from './OpEdReader';
import { NewOpEdDialog } from './NewOpEdDialog';
import { OpEdGettingStarted } from './OpEdGettingStarted';
import { opedRoutePath, navigateTo, replaceRoute } from '../../routing/appRoutes';
import './OpEdTab.css';

// LibraryListPage requires `{ id: string }`; OpEdSetSummary's own key is `set_id`. Adapter, not
// a new domain type — every field beyond `id` is still the real OpEdSetSummary.
type OpEdMyLibRow = OpEdSetSummary & { id: string };
type OpEdCommunityLibRow = OpEdCommunityEntry;

// Exported for unit testing (t/3703 LibraryListPage adoption).
export function opEdLibDate(row: OpEdMyLibRow | OpEdCommunityLibRow, variant: LibraryVariant): string {
  return variant === 'my' ? row.created_at : ((row as OpEdCommunityLibRow).updated_at ?? row.created_at);
}

export function formatLibDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

export function opEdCommunityAuthor(entry: OpEdCommunityEntry): string | undefined {
  return (entry.community_metadata as { submitted_by_display?: string } | undefined)?.submitted_by_display;
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

// ── Client-side export (PR#1 has no export bridge — assemble the set as text) ──

function buildOpEdMarkdown(set: OpEdSet): string {
  const lines: string[] = [];
  set.opeds.forEach((m, i) => {
    if (i > 0) lines.push('\n---\n');
    lines.push(`# ${m.headline}`);
    if (m.subtitle) lines.push(`\n*${m.subtitle}*`);
    if (m.byline) lines.push(`\n_${m.byline}_`);
    if (m.disclosure) lines.push(`\n> ${m.disclosure}`);
    lines.push('');
    if (m.status !== 'complete') {
      lines.push(`_(This voice ${m.status === 'failed' ? 'failed to generate' : 'was cancelled'}.)_`);
      return;
    }
    if (m.byline) lines.push(`\n*${m.byline}*`);
    if (m.disclosure) lines.push(`\n> ${m.disclosure}`);
    lines.push('');
    lines.push(m.body);
    if (m.grounding.length > 0) {
      lines.push('\n---\n\n## Taxonomy grounding\n');
      lines.push('| Element | Node ID | Type | Relevance | Reflected in the op-ed |');
      lines.push('|---|---|---|---|---|');
      for (const g of m.grounding) {
        const type = g.node_id.startsWith('sit-') ? 'Situation' : 'BDI';
        lines.push(`| ${g.label || g.node_id} | ${g.node_id} | ${type} | ${g.relevance || '—'} | ${g.how_reflected || '(not reported)'} |`);
      }
    }
    if (m.rhetorical_meta) {
      lines.push('\n---\n\n## What this op-ed did\n');
      lines.push(m.rhetorical_meta);
    }
  });
  return lines.join('\n');
}

function buildOpEdText(set: OpEdSet): string {
  // Strip the lightest Markdown syntax for a plain-text rendering.
  return buildOpEdMarkdown(set).replace(/^#+\s*/gm, '').replace(/[*_`]/g, '');
}

function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function slugify(s: string): string {
  return (s || 'op-ed').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'op-ed';
}

// Exported for unit testing (t/2797 JSON regression).
export function exportOpEdSet(set: OpEdSet, format: string): void {
  if (format === 'json') downloadFile(`${slugify(set.topic)}.json`, JSON.stringify(set, null, 2), 'application/json');
  else if (format === 'text') downloadFile(`${slugify(set.topic)}.txt`, buildOpEdText(set), 'text/plain');
  else downloadFile(`${slugify(set.topic)}.md`, buildOpEdMarkdown(set), 'text/markdown');
}

// ── Share control (web-only; electron-bridge rejects share — t/2728) ──────────
//
// Publishes a durable, no-login public link for a set and copies it to the
// clipboard. The link is built from the returned shareId against the current
// origin — canonical `/share/oped/:shareId`, independent of the server's `url`
// field format. Un-share revokes the public copy (delete + re-share mints a
// fresh shareId, so a leaked link dies for good).

type ShareState =
  | { status: 'idle' }
  | { status: 'working' }
  | { status: 'shared'; url: string; copied: boolean }
  | { status: 'error'; message: string };

// t/3482: web-bridge's generic HTTP-error path leaks the raw request/response text into
// `err.problem` (fine for logs, not for a user-facing alert) — give the share control its own
// short, actionable copy for the failure modes that actually happen here instead of surfacing
// that raw string. Falls back to the shared mapper for anything else (network, unexpected).
function classifyShareError(err: unknown): string {
  const httpStatus = (err as { httpStatus?: number } | null)?.httpStatus;
  if (httpStatus === 401 || httpStatus === 403) {
    return 'Sign in to get a public link for this op-ed.';
  }
  if (httpStatus === 429) {
    const retryAfterS = (err as { retryAfterS?: number } | null)?.retryAfterS;
    return retryAfterS
      ? `Rate limited — try again in ${retryAfterS}s.`
      : 'Rate limited — try again shortly.';
  }
  if (!httpStatus && err instanceof TypeError) {
    // fetch() rejects with a bare TypeError on network failure (no response, no httpStatus).
    return 'Network error — check your connection and try again.';
  }
  return mapErrorToUserMessage(err);
}

function ShareOpEdControl({ setId, source = 'my' }: { setId: string; source?: 'my' | 'community' }) {
  const [state, setState] = useState<ShareState>({ status: 'idle' });
  // t/3315: community op-eds are public → linkable via the community-share endpoint. Get-link-only
  // (no Un-share — revoke is an admin/submitter capability, not exposed to a general viewer).
  const isCommunity = source === 'community';

  const copy = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setState({ status: 'shared', url, copied: true });
    } catch {
      /* clipboard denied — silent by design; link shown for manual copy */
      setState({ status: 'shared', url, copied: false });
    }
  }, []);

  const onShare = useCallback(async () => {
    setState({ status: 'working' });
    try {
      const { shareId } = isCommunity ? await api.shareCommunityOpEd(setId) : await api.shareOpEdSet(setId);
      const url = new URL(`/share/oped/${encodeURIComponent(shareId)}`, window.location.origin).href;
      await copy(url);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'ShareOpEdControl', level: 'error',
        message: 'Failed to publish an op-ed share link',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setState({ status: 'error', message: classifyShareError(err) });
    }
  }, [setId, copy, isCommunity]);

  const onUnshare = useCallback(async () => {
    setState({ status: 'working' });
    try {
      await api.unshareOpEdSet(setId);
      setState({ status: 'idle' });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'ShareOpEdControl', level: 'error',
        message: 'Failed to revoke an op-ed share link',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setState({ status: 'error', message: classifyShareError(err) });
    }
  }, [setId]);

  if (state.status === 'shared') {
    return (
      <span className="oped-share oped-share-active">
        <span className="oped-share-status" role="status">{state.copied ? 'Link copied' : 'Public link ready'}</span>
        <input className="oped-share-url" type="text" readOnly value={state.url} aria-label="Public share link"
          onFocus={e => e.currentTarget.select()} />
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void copy(state.url)}>Copy</button>
        {!isCommunity && <button type="button" className="btn btn-sm btn-ghost" onClick={() => void onUnshare()}>Un-share</button>}
      </span>
    );
  }

  return (
    <span className="oped-share">
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => void onShare()}
        disabled={state.status === 'working'} aria-label={isCommunity ? 'Get a public share link for this community op-ed' : 'Create a public share link'}
        // t/3486: the address bar now reflects the in-app view too (auth-gated) — this
        // button mints a DIFFERENT, no-login link, so the tooltip disambiguates the two.
        title="Creates a public, no-login link — different from this page's address bar URL">
        {state.status === 'working' ? 'Sharing…' : (isCommunity ? '🔗 Get public link' : '🔗 Share')}
      </button>
      {state.status === 'error' && <span className="oped-share-error" role="alert">{state.message}</span>}
    </span>
  );
}

// ── Reader view (back bar + article/loading/error) ────────────────────────────

export function OpEdReaderView({
  readerSet, readerLoading, readerError, status, onBack, shareSource, communityId, initialPov, onPovChange,
}: {
  readerSet: OpEdSet | null;
  readerLoading: boolean;
  readerError: string | null;
  status: string | null;
  onBack: () => void;
  /** t/2987/t/3315: which store the op-ed came from — 'my' (own share) or 'community' (public community
   *  share); null = not shareable. Both mint a public /share/oped link via their respective endpoint. */
  shareSource: 'my' | 'community' | null;
  /**
   * t/3426: the community op-ed's own addressing id (the community list entry's `.id`, what the
   * community-share endpoint keys on — `oped-{id}.json`). Required when shareSource is 'community':
   * the loaded document's OWN `.set_id` is the submitter's ORIGINAL op-ed-set id, which differs from
   * the community id once a community submission is addressed distinctly from its source (t/856) —
   * passing set_id there 404s (getCommunityOpEd finds no record under the wrong id). Unused for 'my'.
   */
  communityId: string | null;
  /** t/3486: camp tab a deep link asked to open on — seeds OpEdReader's initial tab. */
  initialPov?: string;
  /** t/3486: fires whenever the active camp tab changes, so the URL can track it. */
  onPovChange?: (pov: string) => void;
}) {
  const shareId = shareSource === 'community' ? communityId : (readerSet?.set_id ?? null);
  return (
    <div className="two-column oped-tab-table-mode">
      <div className="oped-reader-shell">
        <div className="oped-reader-bar">
          <button type="button" className="oped-reader-back" onClick={onBack}>‹ Op-Ed Studies</button>
          {status && <span className="oped-status">{status}</span>}
          {/* Share is web-only (electron-bridge rejects, t/2728). Own op-eds use the own-share endpoint;
              community op-eds use the community-share endpoint (t/3315 — community is public). Both mint
              a public /share/oped link. shareId (not readerSet.set_id) is what's sent — see communityId
              doc above for why those two ids can differ for community op-eds (t/3426). */}
          {readerSet && shareSource && shareId && !isElectronMode() && <ShareOpEdControl setId={shareId} source={shareSource} />}
        </div>
        {readerLoading && <p className="oped-reader-loading">Loading op-ed…</p>}
        {readerError && <p className="oped-reader-error">{readerError}</p>}
        {readerSet && !readerLoading && <OpEdReader set={readerSet} initialPov={initialPov} onPovChange={onPovChange} />}
      </div>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function OpEdTab() {
  const {
    sets, loading, editMode, selectedIds, selectedSetId, pendingOpen,
    loadSets, selectSet, renameSet, setEditMode, toggleSelected, clearSelected, deleteSelected, clearPendingOpen,
  } = useOpEdStore(useShallow(s => ({
    sets: s.sets, loading: s.loading, editMode: s.editMode, selectedIds: s.selectedIds, selectedSetId: s.selectedSetId,
    pendingOpen: s.pendingOpen,
    loadSets: s.loadSets, selectSet: s.selectSet, renameSet: s.renameSet, setEditMode: s.setEditMode,
    toggleSelected: s.toggleSelected, clearSelected: s.clearSelected, deleteSelected: s.deleteSelected,
    clearPendingOpen: s.clearPendingOpen,
  })));
  const { opeds: communityOpeds, communityLoading, fetchOpeds, submitItem, copyItem } = useCommunityStore(useShallow(s => ({
    opeds: s.opeds, communityLoading: s.loading, fetchOpeds: s.fetchOpeds, submitItem: s.submitItem, copyItem: s.copyItem,
  })));

  const auth = useAuthStatus();
  const isElectron = isElectronMode();

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [showNewDialog, setShowNewDialog] = useState(false);
  // t/4562: a getting-started chip seeds this before opening the dialog; "+ New Op-Ed" leaves
  // it undefined, so the dialog keeps whatever topic (if any) the user last typed.
  const [newDialogTopic, setNewDialogTopic] = useState<string | undefined>(undefined);

  // The set currently open in the reader — may come from the personal store (My)
  // or a community load (Community). null = table view.
  const [readerSet, setReaderSet] = useState<OpEdSet | null>(null);
  // t/2987/t/3315: which store the open op-ed came from — 'my' shares via the own-set endpoint,
  // 'community' shares via the community endpoint (both mint a public /share/oped link).
  const [readerSource, setReaderSource] = useState<'my' | 'community' | null>(null);
  // t/3426: the community entry's own addressing id, captured at open time — the loaded
  // document's `.set_id` is the submitter's ORIGINAL id, which the community-share endpoint does
  // NOT key on once it differs from the community id (t/856). null unless readerSource is
  // 'community'. See OpEdReaderView's communityId prop doc for the full explanation.
  const [readerCommunityId, setReaderCommunityId] = useState<string | null>(null);
  const [readerLoading, setReaderLoading] = useState(false);
  const [readerError, setReaderError] = useState<string | null>(null);
  // t/3486: which camp tab a deep link asked to open on — seeds OpEdReader's initial
  // tab, then OpEdReader owns tab state normally from there.
  const [initialPov, setInitialPov] = useState<string | undefined>(undefined);

  useEffect(() => {
    void loadSets();
    void fetchOpeds();
  }, [loadSets, fetchOpeds]);

  const flash = useCallback((msg: string) => {
    setStatus(msg);
    setTimeout(() => setStatus(null), 4000);
  }, []);

  const exitEditMode = useCallback(() => { setEditMode(false); setRenamingId(null); }, [setEditMode]);

  // ── Custom sort order (persisted to localStorage) — mirrors DebateTab (t/2796). ──
  const [customOrder, setCustomOrder] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('oped-custom-order');
      return saved ? JSON.parse(saved) : [];
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'oped-tab', level: 'warn',
        message: 'Failed to load custom op-ed order from localStorage',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return [];
    }
  });

  const saveCustomOrder = useCallback((order: string[]) => {
    setCustomOrder(order);
    localStorage.setItem('oped-custom-order', JSON.stringify(order));
  }, []);

  // Apply custom ordering: sets not yet in the custom order (e.g. newly created)
  // float to the top in server order (newest-first), followed by manually-ordered
  // sets in their saved order. Mirrors DebateTab.orderedSessions.
  const orderedSets = useMemo(() => {
    if (customOrder.length === 0) return sets;
    const orderMap = new Map(customOrder.map((id, i) => [id, i]));
    return [...sets].sort((a, b) => {
      const ai = orderMap.get(a.set_id);
      const bi = orderMap.get(b.set_id);
      if (ai !== undefined && bi !== undefined) return ai - bi;
      if (ai !== undefined) return 1;  // a pinned, b new — new (b) first
      if (bi !== undefined) return -1; // b pinned, a new — new (a) first
      return 0;                        // both unordered — keep server order
    });
  }, [sets, customOrder]);

  const moveSet = useCallback((id: string, direction: 'up' | 'down') => {
    const ids = orderedSets.map(s => s.set_id);
    const idx = ids.indexOf(id);
    if (idx < 0) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= ids.length) return;
    [ids[idx], ids[targetIdx]] = [ids[targetIdx], ids[idx]];
    saveCustomOrder(ids);
  }, [orderedSets, saveCustomOrder]);

  // ── Reader open/close ──

  const openMy = useCallback((id: string, pov?: string) => {
    // The My list holds index summaries (no body) — load the full doc for the reader.
    selectSet(id);
    setReaderSource('my'); // t/2987: My sets are shareable.
    setReaderCommunityId(null); // t/3426: only set for the community branch.
    setReaderError(null);
    setReaderSet(null);
    setReaderLoading(true);
    setInitialPov(pov);
    navigateTo(opedRoutePath(id, pov)); // t/3486: reflect the open set in the address bar.
    api.loadOpEdSet(id).then(set => {
      setReaderSet(set);
    }).catch(err => {
      recordError('oped-tab', 'Failed to load op-ed', err);
      setReaderError('Could not load this op-ed — it may have been removed.');
    }).finally(() => setReaderLoading(false));
  }, [selectSet]);

  // t/3486: a deep-link route restore requests opening a set — bridges appRoutes.ts's pure
  // store action (`useOpEdStore.requestOpen`) to this component's local reader-open logic.
  // "my" sets only for now (t/3486#4) — a community deep link isn't distinguishable from
  // the URL shape yet, so it 404s into "not found" rather than silently guessing wrong.
  useEffect(() => {
    if (!pendingOpen) return;
    openMy(pendingOpen.setId, pendingOpen.pov);
    clearPendingOpen();
  }, [pendingOpen, openMy, clearPendingOpen]);

  const openCommunity = useCallback((id: string) => {
    selectSet(id);
    setReaderSource('community');
    setReaderCommunityId(id); // t/3426: capture the community addressing id at open time.
    setReaderError(null);
    setReaderSet(null);
    setReaderLoading(true);
    api.loadCommunityOpEd(id).then(set => {
      setReaderSet(set);
    }).catch(err => {
      recordError('oped-tab', 'Failed to load community op-ed', err);
      setReaderError('Could not load this op-ed — it may have been removed.');
    }).finally(() => setReaderLoading(false));
  }, [selectSet]);

  const closeReader = useCallback(() => {
    selectSet(null);
    setReaderSet(null);
    setReaderSource(null);
    setReaderCommunityId(null);
    setReaderError(null);
    setInitialPov(undefined);
    navigateTo('/'); // t/3486: back to the table view — the address bar should match.
  }, [selectSet]);

  // A fresh create (PR#2) — reload the library, then open the new set in the reader. LibraryListPage
  // owns tab state internally now (t/3703) — a create from the Community tab opens straight into
  // the reader same as before; closing the reader returns to whichever tab was active, not forced
  // back to My. Minor UX simplification, not covered by the redesign's own ACs.
  const handleCreated = useCallback(async (setId: string) => {
    await loadSets();
    // loadSets returns index summaries (no body) — load the full doc for the reader.
    selectSet(setId);
    setReaderSource('my'); // t/2987: a freshly-created set is the user's own → shareable.
    setReaderCommunityId(null); // t/3426: only set for the community branch.
    navigateTo(opedRoutePath(setId)); // t/3486: reflect the newly-created set in the address bar.
    setReaderError(null);
    setReaderSet(null);
    setReaderLoading(true);
    return api.loadOpEdSet(setId).then(set => {
      setReaderSet(set);
    }).catch(err => {
      recordError('oped-tab', 'Failed to load new op-ed', err);
      setReaderError('Could not load this op-ed.');
    }).finally(() => setReaderLoading(false));
  }, [loadSets, selectSet]);

  // ── Row actions ──

  const handleRename = useCallback((id: string, topic: string) => {
    renameSet(id, topic).catch(err => {
      recordError('oped-tab', 'Failed to rename op-ed', err);
      flash(`Rename failed: ${err}`);
    });
  }, [renameSet, flash]);

  const handleShare = useCallback((summary: OpEdSetSummary) => {
    // The My row is an index summary — load the full doc before submitting.
    api.loadOpEdSet(summary.set_id)
      .then(set => submitItem('oped', set))
      .then(() => flash('Shared to community.'))
      .catch(err => {
        recordError('oped-tab', 'Failed to share op-ed to community', err);
        flash(`Share failed: ${err}`);
      });
  }, [submitItem, flash]);

  const handleExportMy = useCallback((summary: OpEdSetSummary, format: string) => {
    // buildOpEd* iterate set.opeds — the index row has none, so load the full doc.
    api.loadOpEdSet(summary.set_id)
      .then(set => exportOpEdSet(set, format))
      .catch(err => {
        recordError('oped-tab', 'Failed to export op-ed', err);
        flash(`Export failed: ${err}`);
      });
  }, [flash]);

  const handleExportCommunity = useCallback((entry: OpEdCommunityEntry, format: string) => {
    // The community index entry lacks the full body — load, then export.
    api.loadCommunityOpEd(entry.id).then(set => exportOpEdSet(set, format)).catch(err => {
      recordError('oped-tab', 'Failed to export community op-ed', err);
      flash(`Export failed: ${err}`);
    });
  }, [flash]);

  const handleCopy = useCallback((entry: OpEdCommunityEntry) => {
    copyItem('opeds', entry.id).then(() => { void loadSets(); flash('Copied to My op-eds.'); }).catch(err => {
      recordError('oped-tab', 'Failed to copy community op-ed', err);
      flash(`Copy failed: ${err}`);
    });
  }, [copyItem, loadSets, flash]);

  const handleBulkDelete = useCallback(() => {
    deleteSelected().catch(err => {
      recordError('oped-tab', 'Failed to delete selected op-eds', err);
      flash(`Delete failed: ${err}`);
    });
  }, [deleteSelected, flash]);

  // t/4562: a getting-started chip seeds the topic, then opens the same dialog "+ New Op-Ed" uses.
  const handlePickStarter = useCallback((topic: string) => {
    setNewDialogTopic(topic);
    setShowNewDialog(true);
  }, []);

  const handleNewClick = useCallback(() => {
    setNewDialogTopic(undefined);
    setShowNewDialog(true);
  }, []);

  // ── LibraryListPage adoption (t/3703) — id adapter + config ──

  const myLibRows = useMemo<OpEdMyLibRow[]>(() => orderedSets.map(s => ({ ...s, id: s.set_id })), [orderedSets]);

  const libConfig: LibraryListPageConfig<OpEdMyLibRow, OpEdCommunityLibRow> = useMemo(() => ({
    title: 'Op-Ed Studies',
    newLabel: '+ New Op-Ed',
    onNew: handleNewClick,
    showEdit: true,
    // t/3703#8: unlike Debates, an anonymous session has real (temporary) op-eds — NewOpEdDialog
    // only gates URL-source creation for anonymous, not topic-only creation, and the temp anon
    // session backs My here. So the My tab must stay visible for anonymous users on this page.
    anonymousHasMyContent: true,
    editMode: {
      active: editMode,
      onEnter: () => setEditMode(true),
      onExit: exitEditMode,
      actions: [
        ...(selectedIds.size > 0 ? [{ label: `Delete ${selectedIds.size}`, onClick: handleBulkDelete, variant: 'danger' as const }] : []),
        { label: 'None', onClick: clearSelected },
        ...(customOrder.length > 0 ? [{ label: 'Reset Order', onClick: () => saveCustomOrder([]) }] : []),
        { label: 'Done', onClick: exitEditMode },
      ],
      selectedIds,
      onToggleSelect: toggleSelected,
      rowActions: (row: OpEdMyLibRow) => {
        const idx = myLibRows.findIndex(r => r.id === row.id);
        return [
          { icon: 'moveUp' as const, label: `Move "${row.topic || 'Untitled op-ed'}" up`, onClick: () => moveSet(row.set_id, 'up'), disabled: idx <= 0 },
          { icon: 'moveDown' as const, label: `Move "${row.topic || 'Untitled op-ed'}" down`, onClick: () => moveSet(row.set_id, 'down'), disabled: idx === -1 || idx === myLibRows.length - 1 },
        ];
      },
    },
    titleHeader: 'Headline',
    titleSortable: true,
    columns: [
      { key: 'camps', header: 'Camps', width: '150px', render: row => <OpEdCampTags camps={row.camps} /> },
      { key: 'outlet', header: 'Outlet', width: '90px', sortable: true, compare: (a, b) => (a.outlet ?? '').localeCompare(b.outlet ?? ''), render: row => row.outlet ?? <span className="lib-empty-value">—</span> },
      {
        key: 'date', header: 'Date', width: '110px', sortable: true,
        compare: (a, b, variant) => new Date(opEdLibDate(a, variant)).getTime() - new Date(opEdLibDate(b, variant)).getTime(),
        render: (row, variant) => <span className="lib-date">{formatLibDate(opEdLibDate(row, variant))}</span>,
      },
    ],
    getTitle: row => row.topic || 'Untitled op-ed',
    onRename: handleRename,
    renamingId,
    setRenamingId,
    secondaryLine: (row, variant) => {
      const parts: string[] = [];
      if (row.voice_count > 0) parts.push(`${row.voice_count} voices`);
      if (variant === 'community') {
        const author = opEdCommunityAuthor(row as OpEdCommunityLibRow);
        if (author) parts.push(`by ${author}`);
      }
      return parts.length > 0 ? parts.join(' · ') : null;
    },
    searchPlaceholderMy: 'Search op-eds…',
    searchPlaceholderCommunity: 'Search op-eds from the community…',
    filter: (rows, q) => rows.filter(r => !q || (r.topic?.toLowerCase().includes(q) ?? false)),
    exportFormats: [{ key: 'markdown', label: 'Markdown' }, { key: 'text', label: 'Plain text' }, { key: 'json', label: 'JSON' }],
    onExportMy: handleExportMy,
    onExportCommunity: handleExportCommunity,
    onShare: handleShare,
    onCopy: handleCopy,
    showCopy: () => !auth?.anonymous,
  }), [
    editMode, selectedIds, customOrder, exitEditMode, handleBulkDelete, clearSelected, saveCustomOrder,
    toggleSelected, myLibRows, moveSet, handleRename, renamingId, handleExportMy, handleExportCommunity,
    handleShare, handleCopy, auth?.anonymous, handleNewClick,
  ]);

  // ── Reader view ──

  if (selectedSetId && (readerSet || readerLoading || readerError)) {
    return (
      <OpEdReaderView
        readerSet={readerSet}
        readerLoading={readerLoading}
        readerError={readerError}
        status={status}
        onBack={closeReader}
        shareSource={readerSource}
        communityId={readerCommunityId}
        initialPov={initialPov}
        // t/3486: only "my" sets are URL-tracked for now (t/3486#4) — a community set's
        // reader still works, its tab switches just don't update the address bar.
        onPovChange={readerSource === 'my' && readerSet
          ? (pov: string) => replaceRoute(opedRoutePath(readerSet.set_id, pov))
          : undefined}
      />
    );
  }

  // ── Table view (t/3703) ──

  return (
    <>
      {/* flash()'d failure messages (rename/share/export/copy/delete) — LibraryListPage's own
          toast only covers its own triggered actions' happy path, not page-level async errors. */}
      {status && <div className="oped-status oped-status-inline" role="status">{status}</div>}
      <LibraryListPage
        config={libConfig}
        myRows={myLibRows}
        myLoading={loading}
        communityRows={communityOpeds}
        communityLoading={communityLoading}
        onOpenMy={openMy}
        onOpenCommunity={openCommunity}
        intro={<OpEdGettingStarted hasNoOpEds={myLibRows.length === 0} onPickStarter={handlePickStarter} />}
        defaultCommunityOnWeb
      />

      {/* Create dialog — both builds (t/2614). URL/source create is desktop-only in v1
          (server rejects it), so the web build hides the URL toggle → topic-only. */}
      <NewOpEdDialog
        open={showNewDialog}
        onClose={() => setShowNewDialog(false)}
        onCreated={setId => { void handleCreated(setId); }}
        allowUrlSource={isElectron}
        initialTopic={newDialogTopic}
      />
    </>
  );
}
