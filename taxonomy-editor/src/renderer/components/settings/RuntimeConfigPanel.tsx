// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  useRuntimeConfigStore, getNestedValue, countLeafDiffs,
  type RuntimeConfig, type ConfigState,
} from '../../hooks/useRuntimeConfigStore';
import { isElectronMode } from '@bridge';
import { TOAST_DURATION_INFO } from '../../constants';
import './RuntimeConfigPanel.css';

// ── Field metadata ──

const KNOWN_BACKENDS = ['gemini', 'claude', 'groq'];

interface FieldDef {
  key: string;
  label: string;
  type: 'number' | 'factor' | 'string' | 'backends' | 'bool';
  unit?: string;
}

interface SectionDef {
  key: string;
  label: string;
  fields: FieldDef[];
  /** Short explanatory line shown under the section title (t/4371). */
  description?: string;
}

const SECTIONS: SectionDef[] = [
  {
    key: 'resilience', label: 'Resilience',
    fields: [
      { key: 'circuitThreshold', label: 'Circuit Breaker Threshold', type: 'number' },
      { key: 'circuitCooldownMs', label: 'Circuit Cooldown', type: 'number', unit: 'ms' },
      { key: 'retryBaseDelayMs', label: 'Retry Base Delay', type: 'number', unit: 'ms' },
      { key: 'retryMaxDelayMs', label: 'Retry Max Delay', type: 'number', unit: 'ms' },
      { key: 'retryJitterMaxMs', label: 'Retry Jitter Max', type: 'number', unit: 'ms' },
      { key: 'maxRetryAfterMs', label: 'Max Retry-After', type: 'number', unit: 'ms' },
      { key: 'throttleWindowSize', label: 'Throttle Window Size', type: 'number' },
      { key: 'throttleBaselineCount', label: 'Throttle Baseline Count', type: 'number' },
      { key: 'throttleEnterFactor', label: 'Throttle Enter Factor', type: 'factor' },
      { key: 'throttleExitFactor', label: 'Throttle Exit Factor', type: 'factor' },
      { key: 'throttleDelayMs', label: 'Throttle Delay', type: 'number', unit: 'ms' },
    ],
  },
  {
    key: 'rateLimiting', label: 'Rate Limiting',
    fields: [
      { key: 'windowMs', label: 'Window', type: 'number', unit: 'ms' },
      { key: 'cleanupCutoffMs', label: 'Cleanup Cutoff', type: 'number', unit: 'ms' },
    ],
  },
  {
    key: 'quotas', label: 'Quotas',
    fields: [
      { key: 'defaultMaxChats', label: 'Max Chats per User', type: 'number' },
      { key: 'defaultMaxDebates', label: 'Max Debates per User', type: 'number' },
    ],
  },
  {
    key: 'sessions', label: 'Sessions',
    fields: [
      { key: 'anonymousTtlMs', label: 'Anonymous TTL', type: 'number', unit: 'ms' },
      { key: 'anonymousMaxSessions', label: 'Max Anonymous Sessions', type: 'number' },
      { key: 'anonymousMaxSizeBytes', label: 'Max Anonymous Size', type: 'number', unit: 'bytes' },
      { key: 'tokenFreshnessThresholdMs', label: 'Token Freshness Threshold', type: 'number', unit: 'ms' },
      { key: 'lockAcquireTimeoutMs', label: 'Lock Acquire Timeout', type: 'number', unit: 'ms' },
      { key: 'lockHoldTtlMs', label: 'Lock Hold TTL', type: 'number', unit: 'ms' },
    ],
  },
  {
    key: 'analytics', label: 'Analytics',
    fields: [
      { key: 'retentionDays', label: 'Retention', type: 'number', unit: 'days' },
      { key: 'bufferRequeueLimit', label: 'Buffer Requeue Limit', type: 'number' },
    ],
  },
  {
    key: 'flightRecorder', label: 'Flight Recorder',
    fields: [
      { key: 'minDumpIntervalMs', label: 'Min Dump Interval', type: 'number', unit: 'ms' },
      { key: 'maxDumpsPerWindow', label: 'Max Dumps / Window', type: 'number' },
      { key: 'dumpWindowMs', label: 'Dump Window', type: 'number', unit: 'ms' },
      { key: 'maxRetainedDumps', label: 'Max Retained Dumps', type: 'number' },
      { key: 'maxTotalDumpSizeBytes', label: 'Max Total Dump Size', type: 'number', unit: 'bytes' },
    ],
  },
  {
    key: 'community', label: 'Community',
    fields: [
      { key: 'maxPendingPerUser', label: 'Max Pending / User', type: 'number' },
      { key: 'globalPendingCap', label: 'Global Pending Cap', type: 'number' },
    ],
  },
  {
    key: 'feedback', label: 'Feedback',
    fields: [
      { key: 'defaultPageLimit', label: 'Default Page Limit', type: 'number' },
      { key: 'maxPageLimit', label: 'Max Page Limit', type: 'number' },
    ],
  },
  {
    key: 'server', label: 'Server',
    fields: [
      { key: 'conflictsCacheTtlMs', label: 'Conflicts Cache TTL', type: 'number', unit: 'ms' },
      { key: 'gitCloneTimeoutMs', label: 'Git Clone Timeout', type: 'number', unit: 'ms' },
      { key: 'gitFetchTimeoutMs', label: 'Git Fetch Timeout', type: 'number', unit: 'ms' },
      { key: 'gitDefaultTimeoutMs', label: 'Git Default Timeout', type: 'number', unit: 'ms' },
      { key: 'gitBufferLimitBytes', label: 'Git Buffer Limit', type: 'number', unit: 'bytes' },
      { key: 'apiKeyMaskLength', label: 'API Key Mask Length', type: 'number' },
    ],
  },
  {
    key: 'cache', label: 'Cache',
    fields: [
      { key: 'defaultTtlMs', label: 'Default TTL', type: 'number', unit: 'ms' },
    ],
  },
  {
    key: 'generation', label: 'Generation',
    fields: [
      { key: 'opedVoiceTimeoutMs', label: 'Op-Ed Voice Timeout', type: 'number', unit: 'ms' },
    ],
  },
  {
    key: 'pollGate', label: 'Poll Gate',
    description: 'Stop background polling in hidden or idle tabs (t/4251). Off = poll as before.',
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'bool' },
    ],
  },
];

const TIER_KEYS = ['platform', 'byok', 'anonymous', 'free'] as const;
const TIER_LABELS: Record<string, string> = {
  platform: 'Platform', byok: 'BYOK', anonymous: 'Anonymous', free: 'Free',
};
const TIER_FIELDS: FieldDef[] = [
  { key: 'requestsPerMinute', label: 'Requests / Minute', type: 'number' },
  { key: 'tokensPerDay', label: 'Tokens / Day', type: 'number' },
  { key: 'allowedBackends', label: 'Allowed Backends', type: 'backends' },
];

// ── Helpers ──

function formatUnit(value: number, unit?: string): string {
  if (!unit) return '';
  if (unit === 'ms') {
    if (value >= 86_400_000) return `${(value / 86_400_000).toFixed(1)}d`;
    if (value >= 3_600_000) return `${(value / 3_600_000).toFixed(1)}h`;
    if (value >= 60_000) return `${(value / 60_000).toFixed(1)}m`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}s`;
    return `${value}ms`;
  }
  if (unit === 'bytes') {
    if (value >= 1_073_741_824) return `${(value / 1_073_741_824).toFixed(1)} GB`;
    if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`;
    if (value >= 1_024) return `${(value / 1_024).toFixed(1)} KB`;
    return `${value} B`;
  }
  return `${value} ${unit}`;
}

// ── FieldRow input renderers ──

function FieldIndicators({ field, path, isDirty, isModified, defaultValue, onReset }: {
  field: FieldDef;
  path: string;
  isDirty: boolean;
  isModified: boolean;
  defaultValue: unknown;
  onReset: (path: string) => void;
}) {
  return (
    <div className="rc-field-indicators">
      {isModified && <span className="rc-dot rc-dot--modified" title="Modified from default" />}
      {isDirty && <span className="rc-dot rc-dot--dirty" title="Unsaved change" />}
      {isModified && field.type !== 'backends' && (
        <span className="rc-field-default" title={`Default: ${String(defaultValue)}`}>
          (default: {field.unit && typeof defaultValue === 'number' ? formatUnit(defaultValue, field.unit) : String(defaultValue)})
        </span>
      )}
      {isModified && (
        <button className="rc-reset-btn" onClick={() => onReset(path)} title="Reset to default">&#8634;</button>
      )}
    </div>
  );
}

function BackendsInput({ path, draftValue, onSet }: {
  path: string;
  draftValue: unknown;
  onSet: (path: string, value: unknown) => void;
}) {
  const backends = (Array.isArray(draftValue) ? draftValue : []) as string[];
  return (
    <div className="rc-field-backends">
      {KNOWN_BACKENDS.map(b => (
        <label key={b} className="rc-backend-check">
          <input type="checkbox" checked={backends.includes(b)}
            onChange={e => {
              const next = e.target.checked ? [...backends, b] : backends.filter(x => x !== b);
              onSet(path, next);
            }} />
          {b}
        </label>
      ))}
    </div>
  );
}

function BoolInput({ path, draftValue, onSet }: {
  path: string;
  draftValue: unknown;
  onSet: (path: string, value: unknown) => void;
}) {
  return (
    <input type="checkbox" className="rc-field-checkbox" checked={Boolean(draftValue)}
      onChange={e => onSet(path, e.target.checked)} />
  );
}

function StringInput({ path, draftValue, onSet }: {
  path: string;
  draftValue: unknown;
  onSet: (path: string, value: unknown) => void;
}) {
  return (
    <input type="text" className="rc-field-input" value={String(draftValue ?? '')}
      onChange={e => onSet(path, e.target.value)} />
  );
}

function NumberInput({ path, field, draftValue, onSet }: {
  path: string;
  field: FieldDef;
  draftValue: unknown;
  onSet: (path: string, value: unknown) => void;
}) {
  const numValue = Number(draftValue) || 0;
  const hint = field.unit ? formatUnit(numValue, field.unit) : '';
  return (
    <div className="rc-field-input-group">
      <input type="number" className="rc-field-input" value={numValue}
        step={field.type === 'factor' ? '0.1' : '1'}
        onChange={e => {
          const v = e.target.valueAsNumber;
          if (!isNaN(v)) onSet(path, v);
        }} />
      {hint && <span className="rc-field-hint">{hint}</span>}
    </div>
  );
}

function FieldInput({ path, field, draftValue, onSet }: {
  path: string;
  field: FieldDef;
  draftValue: unknown;
  onSet: (path: string, value: unknown) => void;
}) {
  if (field.type === 'backends') return <BackendsInput path={path} draftValue={draftValue} onSet={onSet} />;
  if (field.type === 'string') return <StringInput path={path} draftValue={draftValue} onSet={onSet} />;
  if (field.type === 'bool') return <BoolInput path={path} draftValue={draftValue} onSet={onSet} />;
  return <NumberInput path={path} field={field} draftValue={draftValue} onSet={onSet} />;
}

// ── FieldRow ──

function FieldRow({ path, field, draft, serverState, onSet, onReset }: {
  path: string;
  field: FieldDef;
  draft: RuntimeConfig;
  serverState: ConfigState;
  onSet: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}) {
  const draftValue = getNestedValue(draft, path);
  const serverValue = getNestedValue(serverState.config, path);
  const defaultValue = getNestedValue(serverState.defaults, path);
  const isDirty = JSON.stringify(draftValue) !== JSON.stringify(serverValue);
  const isModified = JSON.stringify(draftValue) !== JSON.stringify(defaultValue);

  return (
    <div className={`rc-field${isDirty ? ' rc-field--dirty' : ''}`}>
      <label className="rc-field-label">{field.label}</label>
      <FieldInput path={path} field={field} draftValue={draftValue} onSet={onSet} />
      <FieldIndicators field={field} path={path} isDirty={isDirty} isModified={isModified}
        defaultValue={defaultValue} onReset={onReset} />
    </div>
  );
}

// ── ConfigSection ──

function ConfigSection({ section, draft, serverState, modifiedOnly, onSet, onReset }: {
  section: SectionDef;
  draft: RuntimeConfig;
  serverState: ConfigState;
  modifiedOnly: boolean;
  onSet: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const modCount = section.fields.filter(f =>
    JSON.stringify(getNestedValue(draft, `${section.key}.${f.key}`)) !==
    JSON.stringify(getNestedValue(serverState.defaults, `${section.key}.${f.key}`)),
  ).length;

  const visibleFields = modifiedOnly
    ? section.fields.filter(f =>
        JSON.stringify(getNestedValue(draft, `${section.key}.${f.key}`)) !==
        JSON.stringify(getNestedValue(serverState.defaults, `${section.key}.${f.key}`)))
    : section.fields;

  if (modifiedOnly && visibleFields.length === 0) return null;

  return (
    <div className="rc-section">
      <div className="rc-section-header" onClick={() => setCollapsed(!collapsed)}
        role="button" tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setCollapsed(!collapsed); }}>
        <span className="rc-section-toggle">{collapsed ? '▶' : '▼'}</span>
        <span className="rc-section-title">{section.label}</span>
        {modCount > 0 && <span className="rc-section-badge">{modCount}</span>}
      </div>
      {!collapsed && (
        <div className="rc-section-body">
          {section.description && <div className="rc-section-description">{section.description}</div>}
          {visibleFields.map(f => (
            <FieldRow key={f.key} path={`${section.key}.${f.key}`} field={f}
              draft={draft} serverState={serverState} onSet={onSet} onReset={onReset} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── TierSection ──

function TierSection({ draft, serverState, modifiedOnly, onSet, onReset }: {
  draft: RuntimeConfig;
  serverState: ConfigState;
  modifiedOnly: boolean;
  onSet: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [activeTier, setActiveTier] = useState<typeof TIER_KEYS[number]>('platform');

  const modCount = TIER_KEYS.reduce((acc, tier) => {
    const fields: FieldDef[] = tier === 'free'
      ? [...TIER_FIELDS, { key: 'pinnedModel', label: 'Pinned Model', type: 'string' }]
      : TIER_FIELDS;
    return acc + fields.filter(f =>
      JSON.stringify(getNestedValue(draft, `tiers.${tier}.${f.key}`)) !==
      JSON.stringify(getNestedValue(serverState.defaults, `tiers.${tier}.${f.key}`)),
    ).length;
  }, 0);

  const currentFields: FieldDef[] = activeTier === 'free'
    ? [...TIER_FIELDS, { key: 'pinnedModel', label: 'Pinned Model', type: 'string' }]
    : TIER_FIELDS;

  const visibleFields = modifiedOnly
    ? currentFields.filter(f =>
        JSON.stringify(getNestedValue(draft, `tiers.${activeTier}.${f.key}`)) !==
        JSON.stringify(getNestedValue(serverState.defaults, `tiers.${activeTier}.${f.key}`)))
    : currentFields;

  if (modifiedOnly && modCount === 0) return null;

  return (
    <div className="rc-section">
      <div className="rc-section-header" onClick={() => setCollapsed(!collapsed)}
        role="button" tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setCollapsed(!collapsed); }}>
        <span className="rc-section-toggle">{collapsed ? '▶' : '▼'}</span>
        <span className="rc-section-title">Tiers</span>
        {modCount > 0 && <span className="rc-section-badge">{modCount}</span>}
      </div>
      {!collapsed && (
        <div className="rc-section-body">
          <div className="rc-tier-tabs">
            {TIER_KEYS.map(t => (
              <button key={t} className={`rc-tier-tab${activeTier === t ? ' active' : ''}`}
                onClick={() => setActiveTier(t)}>
                {TIER_LABELS[t]}
              </button>
            ))}
          </div>
          {visibleFields.map(f => (
            <FieldRow key={`${activeTier}-${f.key}`} path={`tiers.${activeTier}.${f.key}`}
              field={f} draft={draft} serverState={serverState} onSet={onSet} onReset={onReset} />
          ))}
          {modifiedOnly && visibleFields.length === 0 && (
            <div className="rc-empty rc-empty-padded">No modified fields in this tier.</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── RuntimeConfigToolbar ──

function RuntimeConfigToolbar({
  isDirty, saving, saveSuccess, loading, modifiedOnly, modifiedCount, dirtyCount,
  onSave, onReload, onResetAll, onToggleModifiedOnly,
}: {
  isDirty: boolean;
  saving: boolean;
  saveSuccess: boolean;
  loading: boolean;
  modifiedOnly: boolean;
  modifiedCount: number;
  dirtyCount: number;
  onSave: () => Promise<void>;
  onReload: () => Promise<void>;
  onResetAll: () => void;
  onToggleModifiedOnly: (value: boolean) => void;
}) {
  return (
    <div className="rc-toolbar">
      <button className="btn btn-sm" disabled={!isDirty || saving} onClick={() => void onSave()}>
        {saving ? 'Saving…' : saveSuccess ? 'Saved!' : 'Save'}
      </button>
      <button className="btn btn-ghost btn-sm" disabled={loading} onClick={() => void onReload()} title="Reload from disk">
        &#10227; Reload
      </button>
      <button className="btn btn-ghost btn-sm" disabled={!isDirty} onClick={onResetAll} title="Discard unsaved changes">
        Reset
      </button>
      <div className="rc-toolbar-spacer" />
      <label className="rc-filter-toggle">
        <input type="checkbox" checked={modifiedOnly} onChange={e => onToggleModifiedOnly(e.target.checked)} />
        Modified only
        {modifiedCount > 0 && <span className="rc-count-badge">{modifiedCount}</span>}
      </label>
      {dirtyCount > 0 && <span className="rc-dirty-badge">{dirtyCount} unsaved</span>}
    </div>
  );
}

// ── RuntimeConfigPanel ──

export function RuntimeConfigPanel() {
  const {
    serverState, draft, loading, saving, saveErrors, fetchError,
    fetch, setField, resetField, resetAll, save, reload,
  } = useRuntimeConfigStore();
  const [modifiedOnly, setModifiedOnly] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => { void fetch(); }, [fetch]);

  useEffect(() => {
    if (!saveSuccess) return;
    const t = setTimeout(() => setSaveSuccess(false), TOAST_DURATION_INFO);
    return () => clearTimeout(t);
  }, [saveSuccess]);

  const handleSave = useCallback(async () => {
    const ok = await save();
    if (ok) setSaveSuccess(true);
  }, [save]);

  const isDirty = useMemo(
    () => !!serverState && !!draft && JSON.stringify(draft) !== JSON.stringify(serverState.config),
    [serverState, draft],
  );
  const modifiedCount = useMemo(
    () => serverState && draft ? countLeafDiffs(draft, serverState.defaults) : 0,
    [serverState, draft],
  );
  const dirtyCount = useMemo(
    () => serverState && draft ? countLeafDiffs(draft, serverState.config) : 0,
    [serverState, draft],
  );

  if (isElectronMode()) {
    return <div className="rc-panel"><div className="rc-empty">Runtime configuration is only available in web mode.</div></div>;
  }

  if (loading && !serverState) {
    return <div className="rc-panel"><div className="rc-loading">Loading configuration&#8230;</div></div>;
  }

  if (fetchError && !serverState) {
    return <div className="rc-panel"><div className="rc-error">{fetchError}</div></div>;
  }

  if (!serverState || !draft) return null;

  return (
    <div className="rc-panel">
      <RuntimeConfigToolbar
        isDirty={isDirty} saving={saving} saveSuccess={saveSuccess} loading={loading}
        modifiedOnly={modifiedOnly} modifiedCount={modifiedCount} dirtyCount={dirtyCount}
        onSave={handleSave} onReload={reload} onResetAll={resetAll}
        onToggleModifiedOnly={setModifiedOnly} />

      {serverState.errors.length > 0 && (
        <div className="rc-validation-errors">
          <strong>Config validation warnings:</strong>
          <ul>{serverState.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}

      {saveErrors.length > 0 && (
        <div className="rc-save-errors">
          <strong>Save failed:</strong>
          <ul>{saveErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}

      <div className="rc-file-info">
        {serverState.fileExists
          ? <>Last modified: {serverState.lastModified ? new Date(serverState.lastModified).toLocaleString() : 'unknown'}</>
          : <>No config file on disk (using defaults)</>}
      </div>

      <div className="rc-sections">
        {SECTIONS.map(s => (
          <ConfigSection key={s.key} section={s} draft={draft} serverState={serverState}
            modifiedOnly={modifiedOnly} onSet={setField} onReset={resetField} />
        ))}
        <TierSection draft={draft} serverState={serverState}
          modifiedOnly={modifiedOnly} onSet={setField} onReset={resetField} />
      </div>
    </div>
  );
}
