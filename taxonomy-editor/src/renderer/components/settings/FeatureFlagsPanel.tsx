// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useCallback, useEffect, useRef, useState } from 'react';
import { bridgeGet, bridgePut, bridgeDel } from '../../bridge/web-bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { useFeatureFlagStore } from '../../hooks/useFeatureFlags';
import { useDialog } from '../shared/useDialog'; // t/4909

interface FlagDef {
  name: string;
  enabled: boolean;
  scope: string;
  description?: string;
  created_at: string;
  updated_at: string;
  created_by?: string;
  expires_at?: string | null;
}

interface FlagFormData {
  name: string;
  enabled: boolean;
  scope: string;
  description: string;
  expires_at: string;
}

const SCOPE_COLORS: Record<string, string> = {
  global: '#22c55e',
  'role:admin': '#3b82f6',
  'env:web': '#f97316',
  'env:electron': '#f97316',
};

const SCOPE_LABELS: Record<string, string> = {
  global: 'Global',
  'role:admin': 'Admin only',
  'env:web': 'Web only',
  'env:electron': 'Electron only',
};

function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope;
}

function scopeColor(scope: string): string {
  for (const [prefix, color] of Object.entries(SCOPE_COLORS)) {
    if (scope.startsWith(prefix)) return color;
  }
  if (scope.startsWith('user:')) return '#8b5cf6';
  return '#6b7280';
}

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

const EMPTY_FORM: FlagFormData = { name: '', enabled: true, scope: 'global', description: '', expires_at: '' };

function FlagCard({ flag, onToggle, onEdit, onDelete }: {
  flag: FlagDef;
  onToggle: (name: string, enabled: boolean) => void;
  onEdit: (flag: FlagDef) => void;
  onDelete: (name: string) => void;
}) {
  const expiryDays = flag.expires_at ? daysUntil(flag.expires_at) : null;
  const expiryWarn = expiryDays !== null && expiryDays <= 30 && expiryDays > 0;
  const expired = expiryDays !== null && expiryDays <= 0;

  return (
    <div className={`ff-card${expiryWarn ? ' ff-card--expiry-warn' : ''}${expired ? ' ff-card--expired' : ''}`}>
      <div className="ff-card-header">
        <span className="ff-card-name">{flag.name}</span>
        <label className="ff-toggle">
          <input type="checkbox" checked={flag.enabled} onChange={() => onToggle(flag.name, !flag.enabled)} />
          <span className="ff-toggle-slider" />
        </label>
      </div>
      {flag.description && <div className="ff-card-desc">{flag.description}</div>}
      <div className="ff-card-meta">
        <span
          className="ff-scope-badge"
          // eslint-disable-next-line local/no-inline-style -- badge colors derived from flag scope
          style={{
            background: `color-mix(in srgb, ${scopeColor(flag.scope)} 15%, transparent)`,
            color: scopeColor(flag.scope),
          }}
        >
          {scopeLabel(flag.scope)}
        </span>
        {flag.created_by && <span className="ff-card-owner">Owner: {flag.created_by}</span>}
        <span className="ff-card-date">Created: {relativeAge(flag.created_at)}</span>
        {flag.expires_at && (
          <span className={`ff-card-date${expiryWarn ? ' ff-expiry-warn-text' : ''}${expired ? ' ff-expired-text' : ''}`}>
            {expired ? `Expired ${Math.abs(expiryDays!)}d ago` : `Expires: ${expiryDays}d`}
          </span>
        )}
      </div>
      <div className="ff-card-actions">
        <button className="btn btn-ghost btn-sm" onClick={() => onEdit(flag)}>Edit</button>
        <button className="btn btn-ghost btn-sm ff-btn-danger" onClick={() => onDelete(flag.name)}>Delete</button>
      </div>
    </div>
  );
}

function FlagDialog({ initial, editing, onSave, onCancel }: {
  initial: FlagFormData;
  editing: boolean;
  onSave: (data: FlagFormData) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const { dialogRef, titleId } = useDialog({ onCancel }); // t/4909

  const validate = (): string | null => {
    if (!form.name.trim()) return 'Name is required';
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(form.name)) return 'Name must be kebab-case (e.g., release-my-feature)';
    if (form.name.length < 3 || form.name.length > 50) return 'Name must be 3-50 characters';
    return null;
  };

  const handleSave = () => {
    const err = validate();
    if (err) { setError(err); return; }
    setError(null);
    onSave(form);
  };

  return (
    <div className="ff-dialog-overlay" onClick={onCancel}>
      <div ref={dialogRef} className="ff-dialog" role="dialog" aria-modal aria-labelledby={titleId} onClick={e => e.stopPropagation()}>
        <h3 id={titleId}>{editing ? 'Edit Flag' : 'New Feature Flag'}</h3>

        <label className="ff-field">
          <span>Name</span>
          <input
            type="text"
            value={form.name}
            disabled={editing}
            placeholder="release-my-feature"
            onChange={e => setForm({ ...form, name: e.target.value })}
          />
        </label>

        <label className="ff-field">
          <span>Description</span>
          <input
            type="text"
            value={form.description}
            placeholder="What this flag controls"
            onChange={e => setForm({ ...form, description: e.target.value })}
          />
        </label>

        <label className="ff-field">
          <span>Enabled</span>
          <select value={form.enabled ? 'on' : 'off'} onChange={e => setForm({ ...form, enabled: e.target.value === 'on' })}>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </label>

        <label className="ff-field">
          <span>Scope</span>
          <select value={form.scope} onChange={e => setForm({ ...form, scope: e.target.value })}>
            <option value="global">Global</option>
            <option value="role:admin">Admin only</option>
            <option value="env:web">Web only</option>
            <option value="env:electron">Electron only</option>
          </select>
        </label>

        <label className="ff-field">
          <span>Expires</span>
          <input
            type="date"
            value={form.expires_at}
            onChange={e => setForm({ ...form, expires_at: e.target.value })}
          />
        </label>

        {error && <div className="ff-dialog-error">{error}</div>}

        <div className="ff-dialog-buttons">
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  );
}

function DeleteConfirmDialog({ name, onConfirm, onCancel }: {
  name: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { dialogRef, titleId } = useDialog({ onCancel, initialFocusRef: cancelRef }); // t/4909
  return (
    <div className="ff-dialog-overlay" onClick={onCancel}>
      <div ref={dialogRef} className="ff-dialog ff-dialog--sm" role="dialog" aria-modal aria-labelledby={titleId} onClick={e => e.stopPropagation()}>
        <h3 id={titleId}>Delete Flag</h3>
        <p>Delete flag <strong>{name}</strong>? Code that checks this flag will see it as disabled (fail-closed).</p>
        <div className="ff-dialog-buttons">
          <button ref={cancelRef} className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn ff-btn-danger" onClick={onConfirm}>Delete</button>
        </div>
      </div>
    </div>
  );
}

export function FeatureFlagsPanel() {
  const [flags, setFlags] = useState<FlagDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogState, setDialogState] = useState<{ mode: 'create' | 'edit'; initial: FlagFormData } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await bridgeGet<{ flags: FlagDef[] }>('/api/admin/flags');
      setFlags(data.flags);
      setError(null);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'FeatureFlagsPanel', level: 'error',
        message: 'Failed to load feature flags',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleToggle = async (name: string, enabled: boolean) => {
    const prev = flags.find(f => f.name === name);
    if (!prev) return;
    setFlags(fs => fs.map(f => f.name === name ? { ...f, enabled } : f));
    try {
      await bridgePut(`/api/admin/flags/${encodeURIComponent(name)}`, { enabled });
      void useFeatureFlagStore.getState().refresh();
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'FeatureFlagsPanel', level: 'error',
        message: `Failed to toggle flag ${name}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setFlags(fs => fs.map(f => f.name === name ? prev : f));
    }
  };

  const handleSave = async (data: FlagFormData) => {
    try {
      await bridgePut(`/api/admin/flags/${encodeURIComponent(data.name)}`, {
        enabled: data.enabled,
        scope: data.scope,
        description: data.description || undefined,
        expires_at: data.expires_at || null,
      });
      setDialogState(null);
      void useFeatureFlagStore.getState().refresh();
      void load();
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'FeatureFlagsPanel', level: 'error',
        message: `Failed to save flag ${data.name}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await bridgeDel(`/api/admin/flags/${encodeURIComponent(deleteTarget)}`);
      setDeleteTarget(null);
      void useFeatureFlagStore.getState().refresh();
      void load();
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'FeatureFlagsPanel', level: 'error',
        message: `Failed to delete flag ${deleteTarget}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }
  };

  const openCreate = () => setDialogState({ mode: 'create', initial: EMPTY_FORM });

  const openEdit = (flag: FlagDef) => setDialogState({
    mode: 'edit',
    initial: {
      name: flag.name,
      enabled: flag.enabled,
      scope: flag.scope,
      description: flag.description ?? '',
      expires_at: flag.expires_at?.split('T')[0] ?? '',
    },
  });

  const staleFlags = flags.filter(f => {
    if (f.expires_at) return false;
    const age = (Date.now() - new Date(f.created_at).getTime()) / 86_400_000;
    return age > 90;
  });

  const activeFlags = flags.filter(f => !staleFlags.includes(f));

  if (loading) return <div className="admin-review-loading">Loading flags…</div>;
  if (error) return <div className="admin-review-error">{error}</div>;

  return (
    <div className="ff-panel">
      <div className="ff-toolbar">
        <span className="ff-count">{flags.length} flag{flags.length !== 1 ? 's' : ''}</span>
        <button className="btn btn-primary btn-sm" onClick={openCreate}>+ New Flag</button>
        <button className="btn btn-ghost btn-sm" onClick={() => { setLoading(true); void load(); }} title="Refresh">⟳</button>
      </div>

      {activeFlags.length === 0 && staleFlags.length === 0 && (
        <div className="admin-review-empty">No feature flags defined. Create one to get started.</div>
      )}

      <div className="ff-list">
        {activeFlags.map(f => (
          <FlagCard key={f.name} flag={f} onToggle={handleToggle} onEdit={openEdit} onDelete={setDeleteTarget} />
        ))}
      </div>

      {staleFlags.length > 0 && (
        <div className="ff-stale-section">
          <div className="ff-stale-header">Stale Flags (&gt; 90 days, no expiry)</div>
          <div className="ff-list">
            {staleFlags.map(f => (
              <FlagCard key={f.name} flag={f} onToggle={handleToggle} onEdit={openEdit} onDelete={setDeleteTarget} />
            ))}
          </div>
        </div>
      )}

      {dialogState && (
        <FlagDialog
          initial={dialogState.initial}
          editing={dialogState.mode === 'edit'}
          onSave={handleSave}
          onCancel={() => setDialogState(null)}
        />
      )}

      {deleteTarget && (
        <DeleteConfirmDialog
          name={deleteTarget}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
