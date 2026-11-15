// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/49 (PI option A on t/44, TL design t/44#2 + t/44#3): admin multi-select + bulk admin-delete
// on the Community tab. Lives beside LibraryListPage (not inside it) to keep that file under its
// per-file complexity budget. Every tab already supplies a per-row `adminDelete` (t/4898); this
// module only sequences those calls and reports what happened.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { mapErrorToUserMessage } from '../../utils/errorMessages';
import { useDialog } from './useDialog';
import type { LibraryEditModeAction, LibraryEditModeConfig, LibraryListPageProps, LibraryVariant } from './LibraryListPage.types';
import './LibraryCommunityBulkDelete.css';

export type AdminDeleteFn<T> = (row: T, reason?: string) => void | Promise<unknown>;

/** Per-row outcome buckets. `requested` is a tab whose adminDelete returned a non-thenable
 *  (fire-and-forget), so success is unknown: TL t/44#3 says those are never reported as deleted. */
export interface BulkAdminDeleteOutcome {
  confirmedIds: string[];
  requestedIds: string[];
  failedIds: string[];
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return v != null && typeof (v as { then?: unknown }).then === 'function';
}

function errorFields(err: unknown): { name: string; message: string; stack?: string } {
  return { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack };
}

/** Sequential on purpose (TL t/44#3): a batch of N must not burst N concurrent deletes at the
 *  server, and one failure must not stop the rest. */
export async function runBulkAdminDelete<T extends { id: string }>(
  rows: T[], adminDelete: AdminDeleteFn<T>, reason: string | undefined,
): Promise<BulkAdminDeleteOutcome> {
  const outcome: BulkAdminDeleteOutcome = { confirmedIds: [], requestedIds: [], failedIds: [] };
  for (const row of rows) {
    try {
      const result = adminDelete(row, reason);
      if (isThenable(result)) {
        await result;
        outcome.confirmedIds.push(row.id);
      } else {
        outcome.requestedIds.push(row.id);
      }
    } catch (err) {
      outcome.failedIds.push(row.id);
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'library-list-page', level: 'warn',
        message: `Failed to admin-delete community item ${row.id} during bulk delete (WARN: continuing with the remaining selected items)`,
        error: errorFields(err),
      });
    }
  }
  return outcome;
}

/** "Removed 7 of 8; 1 failed" for rows whose result was observable; "Removal requested for N" for
 *  fire-and-forget rows, never "Removed N of N" (TL t/44#3). "Remove", not "Delete", throughout
 *  on Community, matching the per-row popover (Design, p/25#2). */
export function summarizeBulkAdminDelete({ confirmedIds, requestedIds, failedIds }: BulkAdminDeleteOutcome): string {
  const parts: string[] = [];
  const observed = confirmedIds.length + failedIds.length;
  if (observed > 0) {
    parts.push(failedIds.length > 0
      ? `Removed ${confirmedIds.length} of ${observed}; ${failedIds.length} failed`
      : `Removed ${confirmedIds.length} from Community`);
  }
  if (requestedIds.length > 0) parts.push(`Removal requested for ${requestedIds.length}`);
  return parts.join('. ');
}

/** Per-row admin delete (t/4898 popover path). Tabs record and rethrow (t/50, t/51, TL p/10#15),
 *  so the rejection is handled here: never left unhandled, and the one user-facing message comes
 *  from LibraryListPage, not the tab. */
export async function runRowAdminDelete<T extends { id: string }>(
  row: T, adminDelete: AdminDeleteFn<T>, reason: string | undefined, title: string, showError: (msg: string) => void,
): Promise<void> {
  try {
    await adminDelete(row, reason);
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'library-list-page', level: 'warn',
      message: `Failed to admin-delete community item ${row.id}`,
      error: errorFields(err),
    });
    showError(`Couldn't remove "${title}": ${mapErrorToUserMessage(err, { kind: 'operation' })}`);
  }
}

/** Header actions while an admin is in edit mode on Community. Descriptors, like every other
 *  edit-mode action (t/3703#3), so HeaderRow1 renders them with the same tokens. */
export function communityEditActions({ bulkEnabled, visibleIds, selectedCount, setSelected, onDelete, onDone }: {
  bulkEnabled: boolean;
  visibleIds: string[];
  selectedCount: number;
  setSelected: (ids: Set<string>) => void;
  onDelete: () => void;
  onDone: () => void;
}): LibraryEditModeAction[] {
  const done: LibraryEditModeAction = { label: 'Done', onClick: onDone };
  if (!bulkEnabled) return [done];
  // Design p/25#2: Remove N is hidden at 0 selected, as My hides its Delete.
  const remove: LibraryEditModeAction[] = selectedCount > 0
    ? [{ label: `Remove ${selectedCount}`, onClick: onDelete, variant: 'danger' }]
    : [];
  return [
    { label: 'All', onClick: () => setSelected(new Set(visibleIds)), disabled: visibleIds.length === 0 },
    { label: 'None', onClick: () => setSelected(new Set()), disabled: selectedCount === 0 },
    ...remove,
    done,
  ];
}

/** LibraryListPage's own Community selection (TL t/44#2): kept apart from the page's My-only
 *  editMode selection, and cleared whenever the tab or edit mode changes, so it never carries a
 *  selection across a tab switch or a Done. */
export function useCommunityBulkSelection<T extends { id: string }>(rows: T[], resetKeys: { listView: string; editModeActive: boolean }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const { listView, editModeActive } = resetKeys;

  useEffect(() => {
    setSelected(prev => (prev.size > 0 ? new Set() : prev));
    setDialogOpen(false);
  }, [listView, editModeActive]);

  const toggle = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // Ids of rows that disappeared some other way (another admin's delete, a refresh) drop out
  // here, so "Remove N" never counts a row that is no longer listed.
  const selectedRows = useMemo(() => rows.filter(r => selected.has(r.id)), [rows, selected]);

  /** After a run: keep only the failed rows selected; close the dialog when nothing failed. */
  const applyOutcome = useCallback((outcome: BulkAdminDeleteOutcome) => {
    setSelected(new Set(outcome.failedIds));
    if (outcome.failedIds.length === 0) setDialogOpen(false);
  }, []);

  return { selected, setSelected, toggle, selectedRows, dialogOpen, setDialogOpen, applyOutcome };
}

/** Which selection set a row's checkbox reads/toggles. My rows use the page's own editMode
 *  selection (unchanged); Community rows in admin edit mode use LibraryListPage's own set, so the
 *  page's My-only onToggleSelect guards stay as they are. */
export interface RowSelection {
  ids: Set<string>;
  toggle: (id: string) => void;
}

function rowSelectionFor<TMy>(
  selecting: boolean, listView: LibraryVariant, editMode: LibraryEditModeConfig<TMy> | undefined,
  community: { selected: Set<string>; toggle: (id: string) => void },
): RowSelection | null {
  if (!selecting || !editMode) return null;
  if (listView === 'my') return { ids: editMode.selectedIds, toggle: editMode.onToggleSelect };
  return { ids: community.selected, toggle: community.toggle };
}

/** The whole Community bulk-mode decision for LibraryListPage: whether rows are selectable, which
 *  set they toggle, the header actions, and the confirm dialog. A page with no adminDelete gets
 *  no checkboxes on Community (nothing they could do), only Done. */
export function useCommunityBulkMode<TMy extends { id: string }, TCommunity extends { id: string }>({
  config, listView, isAdmin, editModeActive, communityRows, visibleRows, showSummary,
}: {
  config: LibraryListPageProps<TMy, TCommunity>['config'];
  listView: LibraryVariant;
  isAdmin: boolean;
  editModeActive: boolean;
  communityRows: TCommunity[];
  /** The rows currently shown (search-filtered, sorted): what All selects. */
  visibleRows: (TMy | TCommunity)[];
  showSummary: (msg: string) => void;
}) {
  const bulk = useCommunityBulkSelection(communityRows, { listView, editModeActive });
  const { adminDelete, editMode } = config;
  const available = listView === 'community' && isAdmin && !!adminDelete;
  const selecting = editModeActive && (listView === 'my' || available);
  const selection = rowSelectionFor(selecting, listView, editMode, bulk);
  const editActions = listView === 'community'
    ? communityEditActions({
      bulkEnabled: available,
      visibleIds: visibleRows.map(r => r.id),
      selectedCount: bulk.selectedRows.length,
      setSelected: bulk.setSelected,
      onDelete: () => bulk.setDialogOpen(true),
      onDone: () => editMode?.onExit(),
    })
    : editMode?.actions ?? [];
  const onFinished = (outcome: BulkAdminDeleteOutcome, summary: string) => {
    bulk.applyOutcome(outcome);
    if (outcome.failedIds.length === 0) showSummary(summary);
  };
  const bulkDialog = available && adminDelete !== undefined && bulk.dialogOpen ? (
    <BulkAdminDeleteDialog
      rows={bulk.selectedRows}
      getTitle={r => config.getTitle(r, 'community')}
      adminDelete={adminDelete}
      onClose={() => bulk.setDialogOpen(false)}
      onFinished={onFinished}
    />
  ) : null;
  return { selecting, selection, editActions, bulkDialog };
}

/** One confirm for the whole batch: the N titles plus a single optional reason (TL t/44#2). On
 *  any failure the dialog stays open with the summary and the parent keeps only the failed rows
 *  selected, so the admin can see what happened and retry just those (same shape as Chat's
 *  t/4896 bulk delete). */
export function BulkAdminDeleteDialog<T extends { id: string }>({
  rows, getTitle, adminDelete, onClose, onFinished,
}: {
  rows: T[];
  getTitle: (row: T) => string;
  adminDelete: AdminDeleteFn<T>;
  onClose: () => void;
  /** Called after every run; the parent updates the selection and decides whether to close. */
  onFinished: (outcome: BulkAdminDeleteOutcome, summary: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [failureSummary, setFailureSummary] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { dialogRef, titleId } = useDialog({ onCancel: onClose, closeOnEscape: !deleting, initialFocusRef: cancelRef });
  const n = rows.length;

  const handleConfirm = async () => {
    setDeleting(true);
    setFailureSummary(null);
    const outcome = await runBulkAdminDelete(rows, adminDelete, reason.trim() || undefined);
    const summary = summarizeBulkAdminDelete(outcome);
    setDeleting(false);
    if (outcome.failedIds.length > 0) setFailureSummary(summary);
    onFinished(outcome, summary);
  };

  return (
    <div className="dialog-overlay" onClick={() => !deleting && onClose()}>
      <div ref={dialogRef} className="dialog lib-bulk-delete-dialog" role="dialog" aria-modal aria-labelledby={titleId} onClick={e => e.stopPropagation()}>
        <h3 id={titleId}>Remove {n} item{n !== 1 ? 's' : ''} from Community?</h3>
        <ul className="lib-bulk-delete-list" aria-label="Items to remove">
          {rows.map(r => <li key={r.id} className="lib-bulk-delete-item">{getTitle(r)}</li>)}
        </ul>
        <textarea
          className="lib-bulk-delete-reason"
          rows={2}
          maxLength={200}
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="Reason (optional, applies to all)"
          aria-label="Reason (optional, applies to all)"
          disabled={deleting}
        />
        {failureSummary && (
          <p className="dialog-warning lib-bulk-delete-result" role="alert">
            {failureSummary}. The failed item{n !== 1 ? 's are' : ' is'} still selected: choose Remove {n} to retry, or Close.
          </p>
        )}
        <div className="dialog-actions">
          <button ref={cancelRef} type="button" className="btn" onClick={onClose} disabled={deleting}>
            {failureSummary ? 'Close' : 'Cancel'}
          </button>
          <button type="button" className="btn btn-danger" onClick={() => { void handleConfirm(); }} disabled={deleting || n === 0}>
            {deleting ? 'Removing…' : `Remove ${n}`}
          </button>
        </div>
      </div>
    </div>
  );
}
