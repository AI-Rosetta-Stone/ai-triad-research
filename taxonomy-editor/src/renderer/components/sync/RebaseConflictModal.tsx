// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Phase 4 — UI for resolving conflicts when `resync('rebase')` pauses.
 *
 * The server leaves the working tree in git's paused-rebase state (merge
 * markers in conflicted files). This modal lets the user pick a file,
 * edit it (or apply an "accept ours / theirs" preset), stage it via
 * POST /api/sync/rebase/resolve, and then continue or abort the rebase.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { useFocusTrap } from '../shared/useDialog'; // t/4909
import {
  getRebaseState,
  getRebaseFile,
  resolveRebaseFile,
  continueRebase,
  abortRebase,
  type RebaseState,
} from '../../utils/syncApi';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import './RebaseConflictModal.css';

interface Props {
  open: boolean;
  onClose: () => void;
  onCompleted: (message: string) => void;
  onAborted: (message: string) => void;
  onError: (message: string) => void;
}

/**
 * Strip git merge markers keeping one side. Tolerates nested/multiple conflict
 * hunks. Used for the "Accept ours" and "Accept theirs" quick-resolve buttons.
 */
function applyPreset(content: string, side: 'ours' | 'theirs'): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let state: 'normal' | 'ours' | 'theirs' = 'normal';
  for (const line of lines) {
    if (line.startsWith('<<<<<<<')) { state = 'ours'; continue; }
    if (line.startsWith('=======') && state === 'ours') { state = 'theirs'; continue; }
    if (line.startsWith('>>>>>>>')) { state = 'normal'; continue; }
    if (state === 'normal') out.push(line);
    else if (state === 'ours' && side === 'ours') out.push(line);
    else if (state === 'theirs' && side === 'theirs') out.push(line);
  }
  return out.join('\n');
}

function hasMarkers(s: string): boolean {
  return /^<{7} |^={7}$|^>{7} /m.test(s);
}

export function RebaseConflictModal({ open, onClose, onCompleted, onAborted, onError }: Props) {
  const [state, setState] = useState<RebaseState>({ in_progress: false, conflict_files: [], onto_branch: null });
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [dirty, setDirty] = useState(false);
  const [staged, setStaged] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'load' | 'resolve' | 'continue' | 'abort' | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const reloadState = useCallback(async () => {
    setBusy('load');
    try {
      const next = await getRebaseState();
      setState(next);
      if (next.conflict_files.length === 0 && !next.in_progress) {
        // The rebase finished out-of-band; nothing more to do here.
        setSelected(null);
      } else if (!selected || !next.conflict_files.includes(selected)) {
        setSelected(next.conflict_files[0] ?? null);
      }
    } finally {
      setBusy(null);
    }
  }, [selected]);

  useEffect(() => {
    if (open) void reloadState();
  }, [open]);

  useEffect(() => {
    if (!selected) { setContent(''); setDirty(false); return; }
    let cancelled = false;
    void (async () => {
      const text = await getRebaseFile(selected);
      if (cancelled) return;
      setContent(text);
      setDirty(false);
    })();
    return () => { cancelled = true; };
  }, [selected]);

  // t/4909: mounted once by UnsyncedChangesDrawer (`open` toggles as a prop, not a conditional
  // render), so useDialog's own mount-bookended focus management doesn't fit — only the shared
  // Tab trap plus a matching open-keyed Esc + restore-focus effect (same shape as
  // GeminiOnboardingModal/ConflictsTab's NewConflictDialog). No existing overlay-click guard to
  // mirror, so Esc stays unguarded too, consistent either way.
  useFocusTrap(dialogRef, open);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  const onSaveAndStage = async () => {
    if (!selected) return;
    setBusy('resolve');
    try {
      const res = await resolveRebaseFile(selected, content);
      setStaged(prev => new Set(prev).add(selected));
      setDirty(false);
      // Refresh the remaining conflict list from the server's response so
      // we don't need a second round-trip.
      setState(s => ({ ...s, conflict_files: res.remaining_files }));
      // Move to the next unresolved file if any.
      const next = res.remaining_files[0] ?? null;
      if (next !== selected) setSelected(next);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'rebase-conflict-modal',
        level: 'error',
        message: 'Failed to resolve rebase file',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const onAcceptPreset = (side: 'ours' | 'theirs') => {
    setContent(prev => applyPreset(prev, side));
    setDirty(true);
  };

  const onContinue = async () => {
    setBusy('continue');
    try {
      const res = await continueRebase();
      if (res.completed) {
        onCompleted(res.message);
        onClose();
        return;
      }
      // Next commit conflicted. Reload the list.
      setStaged(new Set());
      setSelected(res.conflict_files[0] ?? null);
      setState(s => ({ ...s, conflict_files: res.conflict_files }));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'rebase-conflict-modal',
        level: 'error',
        message: 'Continue rebase failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const onAbort = async () => {
    if (!confirm('Abort the rebase? Your session branch will return to its pre-rebase state.')) return;
    setBusy('abort');
    try {
      const res = await abortRebase();
      onAborted(res.message);
      onClose();
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'rebase-conflict-modal',
        level: 'error',
        message: 'Abort rebase failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const remaining = state.conflict_files.length;
  const canContinue = remaining === 0 && !busy;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div ref={dialogRef} className="dialog rebase-modal" role="dialog" aria-modal aria-labelledby="rebase-modal-title" onClick={e => e.stopPropagation()}>
        <div className="rebase-modal-header">
          <div>
            <h3 className="dialog-title" id="rebase-modal-title">Resolve rebase conflicts</h3>
            <div className="dialog-description">
              {state.onto_branch
                ? <>Rebasing <code>{state.onto_branch}</code> onto <code>origin/main</code>. {remaining} file{remaining === 1 ? '' : 's'} unresolved.</>
                : <>{remaining} file{remaining === 1 ? '' : 's'} unresolved.</>}
            </div>
          </div>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="rebase-modal-body">
          <div className="rebase-modal-file-list">
            {state.conflict_files.length === 0 && (
              <div className="rebase-modal-empty">
                All conflicts resolved. Click <b>Continue rebase</b> to finish.
              </div>
            )}
            {state.conflict_files.map(f => (
              <div
                key={f}
                className={`rebase-modal-file ${selected === f ? 'selected' : ''} ${staged.has(f) ? 'staged' : ''}`}
                onClick={() => setSelected(f)}
              >
                <span className="rebase-modal-file-glyph">{staged.has(f) ? '✓' : '!'}</span>
                <span className="rebase-modal-file-path" title={f}>{f}</span>
              </div>
            ))}
          </div>

          <RebaseEditor
            selected={selected}
            remaining={remaining}
            content={content}
            setContent={setContent}
            setDirty={setDirty}
            dirty={dirty}
            busy={busy}
            onAcceptPreset={onAcceptPreset}
            onSaveAndStage={onSaveAndStage}
          />
        </div>

        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={() => void onAbort()} disabled={busy !== null}>
            {busy === 'abort' ? 'Aborting…' : 'Abort rebase'}
          </button>
          <button className="btn btn-primary" onClick={() => void onContinue()} disabled={!canContinue}>
            {busy === 'continue' ? 'Continuing…' : 'Continue rebase'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Editor pane (extracted for complexity, t/1918) ──

function RebaseEditor({ selected, remaining, content, setContent, setDirty, dirty, busy, onAcceptPreset, onSaveAndStage }: {
  selected: string | null; remaining: number; content: string;
  setContent: (v: string) => void; setDirty: (v: boolean) => void; dirty: boolean;
  busy: 'load' | 'resolve' | 'continue' | 'abort' | null;
  onAcceptPreset: (side: 'ours' | 'theirs') => void; onSaveAndStage: () => void | Promise<void>;
}) {
  return (
    <div className="rebase-modal-editor">
      {!selected ? (
        <div className="rebase-modal-empty">
          {remaining === 0
            ? 'Nothing to edit.'
            : 'Select a file on the left to resolve.'}
        </div>
      ) : (
        <>
          <div className="rebase-modal-toolbar">
            <button className="btn btn-sm" onClick={() => onAcceptPreset('ours')} disabled={busy !== null || !hasMarkers(content)}>
              Accept ours
            </button>
            <button className="btn btn-sm" onClick={() => onAcceptPreset('theirs')} disabled={busy !== null || !hasMarkers(content)}>
              Accept theirs
            </button>
            <span className="rebase-modal-marker-hint">
              {hasMarkers(content) ? 'Markers present — edit or pick a side.' : 'No markers — ready to stage.'}
            </span>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => void onSaveAndStage()}
              disabled={busy !== null || hasMarkers(content)}
              title={hasMarkers(content) ? 'Resolve all markers first' : 'Write the file and stage it'}
            >
              {busy === 'resolve' ? 'Staging…' : 'Save & stage'}
            </button>
          </div>
          <textarea
            className="rebase-modal-textarea"
            value={content}
            onChange={e => { setContent(e.target.value); setDirty(true); }}
            spellCheck={false}
          />
          {dirty && <div className="rebase-modal-dirty-hint">Unsaved edits — click <b>Save & stage</b> to commit this file to the resolution.</div>}
        </>
      )}
    </div>
  );
}
