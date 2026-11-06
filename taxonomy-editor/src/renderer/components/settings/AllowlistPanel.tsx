// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3499 (t/3495 epic — admin-managed shared Gemini key): admin UI for the
// Gemini-key allowlist. `userId` is the authoritative membership key (SO
// condition 4, t/3495#2) — the server accepts it directly from the caller,
// it is never derived server-side (TL t/3498#2/#4: derivation from email is
// wrong for GitHub principals). The admin must therefore know a user's
// `userId` to add them, so every entry surfaces it as a copyable value.

import { useCallback, useEffect, useRef, useState } from 'react';
import { bridgeGet, bridgePost, bridgeDel } from '../../bridge/web-bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import type { AllowlistEntry, AdminAllowlistResponse } from '../../../../../lib/allowlist/types';
import { useDialog } from '../shared/useDialog'; // t/4909

function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

function CopyableId({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(value).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 2000); },
      () => setCopied(false),
    );
  }, [value]);

  return (
    <button
      type="button"
      className="allowlist-copy-id"
      onClick={handleCopy}
      title="Copy userId"
    >
      <code>{value}</code>
      <span className="allowlist-copy-feedback">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

function EntryRow({ entry, onRemove }: { entry: AllowlistEntry; onRemove: (userId: string) => void }) {
  return (
    <tr className="allowlist-row">
      <td>{entry.email}</td>
      <td><CopyableId value={entry.userId} /></td>
      <td className="allowlist-added-at" title={entry.addedAt}>{relativeAge(entry.addedAt)}</td>
      <td className="allowlist-actions">
        <button className="btn btn-ghost btn-sm allowlist-btn-danger" onClick={() => onRemove(entry.userId)}>
          Remove
        </button>
      </td>
    </tr>
  );
}

function RemoveConfirmDialog({ entry, onConfirm, onCancel }: {
  entry: AllowlistEntry;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { dialogRef, titleId } = useDialog({ onCancel, initialFocusRef: cancelRef });
  return (
    <div className="ff-dialog-overlay" onClick={onCancel}>
      <div ref={dialogRef} className="ff-dialog ff-dialog--sm" role="dialog" aria-modal aria-labelledby={titleId} onClick={e => e.stopPropagation()}>
        <h3 id={titleId}>Remove Allowlist Entry</h3>
        <p>
          Remove <strong>{entry.email}</strong> (<code>{entry.userId}</code>) from the Gemini-key
          allowlist? They will need to supply their own Gemini key to run debates.
        </p>
        <div className="ff-dialog-buttons">
          <button ref={cancelRef} className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn allowlist-btn-danger" onClick={onConfirm}>Remove</button>
        </div>
      </div>
    </div>
  );
}

export function AllowlistPanel() {
  const [entries, setEntries] = useState<AllowlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userIdInput, setUserIdInput] = useState('');
  const [emailInput, setEmailInput] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<AllowlistEntry | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await bridgeGet<AdminAllowlistResponse>('/api/admin/allowlist');
      setEntries(data.entries);
      setError(null);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'AllowlistPanel', level: 'error',
        message: 'Failed to load Gemini-key allowlist',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleAdd = async () => {
    const userId = userIdInput.trim();
    const email = emailInput.trim();
    if (!userId) { setAddError('userId is required'); return; }
    if (!email) { setAddError('email is required'); return; }
    setAddError(null);
    setAdding(true);
    try {
      await bridgePost<AllowlistEntry>('/api/admin/allowlist', { userId, email });
      setUserIdInput('');
      setEmailInput('');
      void load();
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'AllowlistPanel', level: 'error',
        message: `Failed to add allowlist entry for userId ${userId}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setAddError(String(err));
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async () => {
    if (!removeTarget) return;
    const { userId } = removeTarget;
    try {
      await bridgeDel(`/api/admin/allowlist/${encodeURIComponent(userId)}`);
      setRemoveTarget(null);
      void load();
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'AllowlistPanel', level: 'error',
        message: `Failed to remove allowlist entry for userId ${userId}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setError(String(err));
      setRemoveTarget(null);
    }
  };

  if (loading) return <div className="admin-review-loading">Loading allowlist…</div>;

  return (
    <div className="allowlist-panel">
      <p className="allowlist-desc">
        Accounts listed here can run debates with Gemini models using the admin&apos;s registered
        key, without entering their own. The Gemini key itself is never shown or transmitted here.
      </p>

      {error && <div className="admin-review-error">{error}</div>}

      <div className="allowlist-add-form">
        <label className="ff-field">
          <span>userId</span>
          <input
            type="text"
            value={userIdInput}
            placeholder="e.g. github:12345678"
            onChange={e => setUserIdInput(e.target.value)}
          />
        </label>
        <label className="ff-field">
          <span>email</span>
          <input
            type="email"
            value={emailInput}
            placeholder="user@example.com"
            onChange={e => setEmailInput(e.target.value)}
          />
        </label>
        <button className="btn btn-primary btn-sm allowlist-add-btn" disabled={adding} onClick={() => void handleAdd()}>
          {adding ? 'Adding…' : '+ Add'}
        </button>
      </div>
      {addError && <div className="ff-dialog-error">{addError}</div>}

      {entries.length === 0 ? (
        <div className="admin-review-empty">No accounts allowlisted yet.</div>
      ) : (
        <table className="admin-table allowlist-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>userId</th>
              <th>Added</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(entry => (
              <EntryRow key={entry.userId} entry={entry} onRemove={() => setRemoveTarget(entry)} />
            ))}
          </tbody>
        </table>
      )}

      {removeTarget && (
        <RemoveConfirmDialog
          entry={removeTarget}
          onConfirm={() => void handleRemove()}
          onCancel={() => setRemoveTarget(null)}
        />
      )}
    </div>
  );
}
