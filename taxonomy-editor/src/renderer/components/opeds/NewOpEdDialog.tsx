// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// NewOpEdDialog — Op-Ed Studio create flow (t/2576 PR#2, §5). Two screens mirroring
// NewDebateDialog: Screen A is the essential form (topic/url, multi-select voices,
// outlet, news hook); Screen B is the "More options" settings drawer. On Draft
// the dialog shows a live progress panel (not a spinner) fed by api.onOpEdProgress and
// finalizes by opening the created set in the reader. The bridge trio (createOpEdSet /
// cancelOpEdSet / onOpEdProgress) is Electron-only; web keeps the disabled affordance.

import { useState, useMemo, useEffect, useRef, useLayoutEffect } from 'react';
import type { TextareaHTMLAttributes, RefObject } from 'react';
import { api } from '@bridge';
import type { CreateOpEdParams, CreateOpEdPayload, OpEdProgressEvent } from '../../bridge/types';
import type { PovKey } from '../../../../../lib/oped/types';
import outletsData from '@lib/oped/outlets.json';
import { POV_META } from '@lib/electron-shared/povMeta';
import { POV_KEYS } from '@lib/debate/types';
import { CampGlyph, povToCamp } from '../shared/CampGlyph';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import {
  AI_BACKENDS, MODELS_BY_BACKEND, backendForModelWithFallback, initAIModels, useTaxonomyStore, type AIBackend,
} from '../../hooks/useTaxonomyStore';
import { useTierInfo, isFreeTier, type TierInfo } from '../../hooks/useTierInfo';
import { useAuthStatus } from '../../hooks/useAuthStatus';
import { OpEdTagPicker, opEdTagBlocksStart, opEdTagSelection, type OpEdTagChoice } from './OpEdTagPicker';
import { registryOrNull } from '../debate/SeatTagPicker';
import type { PovNode } from '@lib/debate/taxonomyTypes';
import './NewOpEdDialog.css';

// ── Outlets (t/3864) ───────────────────────────────────────────────────────────
// The option SET and the default come from the SSOT (lib/oped/outlets.json, t/3861) — never
// a local array/literal. `label`/`band` are presentation-only (t/3864's design) and may stay
// local; a key missing from this map still renders (falling back to the key itself), so the
// dropdown can never silently offer a DIFFERENT set from the backend — the exact failure
// t/3796 caused.
const OUTLET_PRESENTATION: Record<string, { label: string; band: string }> = {
  WashingtonPost:    { label: 'The Washington Post',   band: '~800 words, strong news hook' },
  NYTimes:           { label: 'The New York Times',    band: '~800 words, sharp thesis' },
  WallStreetJournal: { label: 'The Wall Street Journal', band: '600–1200 words, business/policy framing' },
  USAToday:          { label: 'USA Today',             band: '550–750 words, plain and direct' },
  ForeignAffairs:    { label: 'Foreign Affairs',       band: '800–1500 words, structural analysis' },
  Politico:          { label: 'Politico',              band: '~1000 words, policy-mechanics focus' },
  TechPolicyPress:   { label: 'Tech Policy Press',     band: '1200–2000 words, analytical and evidence-grounded' },
  Regional:          { label: 'Regional / local daily', band: '500–800 words, local relevance' },
  Generic:           { label: 'Generic',               band: '~800 words, strong news hook' },
};

const OUTLETS: { value: string; label: string; band: string }[] = Object.keys(outletsData.outlets).map(value => ({
  value,
  label: OUTLET_PRESENTATION[value]?.label ?? value,
  band: OUTLET_PRESENTATION[value]?.band ?? '',
}));

// ── Screen-B defaults (must equal New-OpEd's parameter defaults) ──────────────

const DEFAULTS = {
  outlet: outletsData.defaultOutlet,
  wordCount: null as number | null, // null ⇒ use the outlet band (cmdlet default)
  thesis: '',
  authorBio: '',
  ground: true,                     // off ⇒ params.voiceOnly = true
  maxGroundingNodes: 12,
  maxSituations: 3,
  temperature: 0.8,
};

const OPED_EXCLUDED_BACKENDS = new Set(['ollama']);

// ── Focus trap (mirror of NewDebateDialog's local useFocusTrap) ───────────────

function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active || !ref.current) return;
    const el = ref.current;
    const getFocusable = () => Array.from(
      el.querySelectorAll<HTMLElement>(
        'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ),
    );
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusable = getFocusable();
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    el.addEventListener('keydown', onKeyDown);
    return () => el.removeEventListener('keydown', onKeyDown);
  }, [active, ref]);
}

function AutoGrowTextarea({
  value, maxHeight = 200, ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { maxHeight?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [value, maxHeight]);
  return <textarea ref={ref} value={value} {...props} />;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeActiveModel(freeTier: boolean, tierInfo: TierInfo | null, model: string): string {
  return freeTier && tierInfo?.pinnedModel ? tierInfo.pinnedModel : model;
}

function computeModelHasKey(hasApiKey: Record<string, boolean>, backend: string, freeTier: boolean, tierInfo: TierInfo | null): boolean {
  if (OPED_EXCLUDED_BACKENDS.has(backend)) return false;
  return hasApiKey[backend] !== false || (freeTier && !!tierInfo && tierInfo.allowedBackends.includes(backend));
}

function voiceLabels(voices: PovKey[]): string {
  return voices.map(v => POV_META[v].label).join(', ');
}

function voiceCountLine(voices: PovKey[]): string {
  if (voices.length === 0) return 'Select at least one voice.';
  if (voices.length === 1) return `Will create 1 op-ed — ${voiceLabels(voices)}.`;
  return `Will create ${voices.length} op-eds on the same topic — ${voiceLabels(voices)} — shown in tabs.`;
}

/** Normalize a thrown error to the ActionableError shape (Goal/Problem/Location/Next Steps). */
interface ActionableShape { goal?: string; problem: string; location?: string; nextSteps: string[]; }
function toActionable(err: unknown): ActionableShape {
  const e = err as { goal?: string; problem?: string; location?: string; nextSteps?: unknown; message?: string };
  if (e && Array.isArray(e.nextSteps)) {
    return { goal: e.goal, problem: e.problem ?? e.message ?? 'The op-ed could not be created.', location: e.location, nextSteps: e.nextSteps as string[] };
  }
  return { problem: err instanceof Error ? err.message : String(err), nextSteps: [] };
}

const STAGE_LABELS: Record<string, string> = {
  queued: 'Queued',
  fetching: 'Fetching the web page',
  grounding: 'Retrieving grounding',
  generating: 'Writing the op-ed',
  finalizing: 'Mapping grounding across drafts',
  complete: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function stageLabel(pov: PovKey, stage: string, error?: string): string {
  if (stage === 'generating') return `Writing the ${POV_META[pov]?.label ?? pov} op-ed`;
  if (stage === 'failed') return error ? `Failed — ${error}` : 'Failed';
  return STAGE_LABELS[stage] ?? stage;
}

// ── Screen B — settings drawer (mirror DebateSettingsDialog) ──────────────────

export interface OpEdSettingsValues {
  outlet: string;
  wordCount: number | null;
  thesis: string;
  authorBio: string;
  ground: boolean;
  maxGroundingNodes: number;
  maxSituations: number;
  model: string;
  temperature: number;
}

type SettingsSection = 'length' | 'angle' | 'grounding' | 'model';

const SETTINGS_SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'length',    label: 'Length & outlet' },
  { id: 'angle',     label: 'Angle' },
  { id: 'grounding', label: 'Grounding' },
  { id: 'model',     label: 'Model' },
];

function sectionHasDiff(section: SettingsSection, s: OpEdSettingsValues, globalModel: string): boolean {
  switch (section) {
    case 'length':    return s.outlet !== DEFAULTS.outlet || s.wordCount !== DEFAULTS.wordCount;
    case 'angle':     return s.thesis !== DEFAULTS.thesis || s.authorBio !== DEFAULTS.authorBio;
    case 'grounding': return s.ground !== DEFAULTS.ground || s.maxGroundingNodes !== DEFAULTS.maxGroundingNodes || s.maxSituations !== DEFAULTS.maxSituations;
    case 'model':     return s.model !== globalModel || s.temperature !== DEFAULTS.temperature;
  }
}

function OpEdSettingsDrawer({
  initial, globalModel, onApply, onClose,
}: {
  initial: OpEdSettingsValues;
  globalModel: string;
  onApply: (v: OpEdSettingsValues) => void;
  onClose: () => void;
}) {
  const [activeSection, setActiveSection] = useState<SettingsSection>('length');
  const [outlet, setOutlet] = useState(initial.outlet);
  const [wordCount, setWordCount] = useState<number | null>(initial.wordCount);
  const [thesis, setThesis] = useState(initial.thesis);
  const [authorBio, setAuthorBio] = useState(initial.authorBio);
  const [ground, setGround] = useState(initial.ground);
  const [maxGroundingNodes, setMaxGroundingNodes] = useState(initial.maxGroundingNodes);
  const [maxSituations, setMaxSituations] = useState(initial.maxSituations);
  const [model, setModel] = useState(initial.model);
  const [temperature, setTemperature] = useState(initial.temperature);
  const [family, setFamily] = useState<AIBackend>(() => backendForModelWithFallback(initial.model));
  const [refreshing, setRefreshing] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const current: OpEdSettingsValues = { outlet, wordCount, thesis, authorBio, ground, maxGroundingNodes, maxSituations, model, temperature };

  const handleReset = () => {
    setOutlet(DEFAULTS.outlet);
    setWordCount(DEFAULTS.wordCount);
    setThesis(DEFAULTS.thesis);
    setAuthorBio(DEFAULTS.authorBio);
    setGround(DEFAULTS.ground);
    setMaxGroundingNodes(DEFAULTS.maxGroundingNodes);
    setMaxSituations(DEFAULTS.maxSituations);
    setModel(globalModel);
    setTemperature(DEFAULTS.temperature);
    setFamily(backendForModelWithFallback(globalModel));
  };

  // While typing, keep the raw parsed value (no clamp) so intermediate digits — e.g. "80" on the
  // way to "800" — aren't collapsed to the 300 floor, which made only 300/2000 reachable (t/2685).
  // Clamp to [300,2000] on blur; empty ⇒ null ⇒ use the outlet band.
  const parseWordCount = (raw: string): number | null => {
    if (raw.trim() === '') return null;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? null : n;
  };
  const clampWordCountOnBlur = () => {
    setWordCount(prev => (prev == null ? null : Math.min(2000, Math.max(300, prev))));
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="oped-settings-dialog"
        role="dialog"
        aria-modal
        aria-labelledby="oped-settings-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="oped-settings-header">
          <h2 className="oped-settings-title" id="oped-settings-title">More options</h2>
          <button type="button" className="oped-close-btn" onClick={onClose} aria-label="Close settings">&times;</button>
        </div>

        <div className="oped-settings-layout">
          <nav className="oped-settings-nav" aria-label="Settings sections">
            {SETTINGS_SECTIONS.map(s => (
              <button
                key={s.id}
                type="button"
                className={`oped-settings-nav-item${activeSection === s.id ? ' active' : ''}`}
                onClick={() => setActiveSection(s.id)}
              >
                {s.label}
                {sectionHasDiff(s.id, current, globalModel) && <span className="oped-nav-dot" aria-label="modified" />}
              </button>
            ))}
          </nav>

          <div className="oped-settings-body">
            {activeSection === 'length' && (
              <>
                <h3 className="oped-settings-section-title">Length &amp; outlet</h3>
                <div className="oped-settings-field">
                  <label className="oped-field-label" htmlFor="oped-s-outlet">Outlet</label>
                  <select id="oped-s-outlet" className="oped-select" value={outlet} onChange={e => setOutlet(e.target.value)}>
                    {OUTLETS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <p className="oped-field-hint">{OUTLETS.find(o => o.value === outlet)?.band}</p>
                </div>
                <div className="oped-settings-field">
                  <label className="oped-field-label" htmlFor="oped-s-wordcount">Word count override</label>
                  <input
                    id="oped-s-wordcount"
                    type="number"
                    className="oped-input"
                    min={300}
                    max={2000}
                    placeholder="Use outlet band"
                    value={wordCount ?? ''}
                    onChange={e => setWordCount(parseWordCount(e.target.value))}
                    onBlur={clampWordCountOnBlur}
                  />
                  <p className="oped-field-hint">300–2000. Overrides the outlet's target length.</p>
                </div>
              </>
            )}

            {activeSection === 'angle' && (
              <>
                <h3 className="oped-settings-section-title">Angle</h3>
                <div className="oped-settings-field">
                  <label className="oped-field-label" htmlFor="oped-s-thesis">Thesis</label>
                  <AutoGrowTextarea
                    id="oped-s-thesis"
                    className="oped-textarea"
                    rows={3}
                    placeholder="Leave blank to let the camp's values derive one"
                    value={thesis}
                    onChange={e => setThesis(e.target.value)}
                  />
                </div>
                <div className="oped-settings-field">
                  <label className="oped-field-label" htmlFor="oped-s-bio">Author bio</label>
                  <input
                    id="oped-s-bio"
                    type="text"
                    className="oped-input"
                    placeholder="Credentials for the byline"
                    value={authorBio}
                    onChange={e => setAuthorBio(e.target.value)}
                  />
                </div>
              </>
            )}

            {activeSection === 'grounding' && (
              <>
                <h3 className="oped-settings-section-title">Grounding</h3>
                <label className="oped-settings-toggle-row">
                  <input type="checkbox" checked={ground} onChange={e => setGround(e.target.checked)} />
                  <span>
                    <span className="oped-toggle-name">Ground in taxonomy</span>
                    <span className="oped-toggle-help">
                      Injects this camp's most relevant registered beliefs/desires/intentions and situation stress-cases as the positions the essay must argue from. Off writes from voice alone.
                    </span>
                  </span>
                </label>
                <div className="oped-settings-field">
                  <label className="oped-field-label" htmlFor="oped-s-maxnodes">Max BDI nodes</label>
                  <input
                    id="oped-s-maxnodes"
                    type="number"
                    className="oped-input"
                    min={0}
                    max={40}
                    disabled={!ground}
                    value={maxGroundingNodes}
                    onChange={e => setMaxGroundingNodes(Math.min(40, Math.max(0, parseInt(e.target.value, 10) || 0)))}
                  />
                </div>
                <div className="oped-settings-field">
                  <label className="oped-field-label" htmlFor="oped-s-maxsit">Max situations</label>
                  <input
                    id="oped-s-maxsit"
                    type="number"
                    className="oped-input"
                    min={0}
                    max={15}
                    disabled={!ground}
                    value={maxSituations}
                    onChange={e => setMaxSituations(Math.min(15, Math.max(0, parseInt(e.target.value, 10) || 0)))}
                  />
                </div>
              </>
            )}

            {activeSection === 'model' && (
              <>
                <h3 className="oped-settings-section-title">Model</h3>
                <div className="oped-model-row">
                  <div className="oped-model-field">
                    <label className="oped-field-label" htmlFor="oped-s-family">Model family</label>
                    <select
                      id="oped-s-family"
                      className="oped-select"
                      value={family}
                      onChange={e => {
                        const fam = e.target.value as AIBackend;
                        setFamily(fam);
                        setModel(MODELS_BY_BACKEND[fam]?.[0]?.value ?? model);
                      }}
                    >
                      {AI_BACKENDS.map(b => <option key={b.value} value={b.value}>{b.label}</option>)}
                    </select>
                  </div>
                  <button
                    type="button"
                    className="oped-refresh-btn"
                    disabled={refreshing}
                    onClick={async () => {
                      setRefreshing(true);
                      try { await api.refreshAIModels({ dryRun: true }); await initAIModels(); } catch { /* telemetry — silent by design */ }
                      setRefreshing(false);
                    }}
                  >{refreshing ? 'Refreshing…' : 'Refresh models'}</button>
                </div>
                <div className="oped-settings-field">
                  <label className="oped-field-label" htmlFor="oped-s-model">Model</label>
                  <select id="oped-s-model" className="oped-select" value={model} onChange={e => setModel(e.target.value)}>
                    {(MODELS_BY_BACKEND[family] ?? []).map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </div>
                <div className="oped-settings-field">
                  <label className="oped-field-label" htmlFor="oped-s-temp">Temperature: {temperature.toFixed(1)}</label>
                  <input
                    id="oped-s-temp"
                    type="range"
                    min={0}
                    max={2}
                    step={0.1}
                    value={temperature}
                    onChange={e => setTemperature(parseFloat(e.target.value))}
                  />
                  <p className="oped-field-hint">0 = deterministic, 2 = most varied. Default 0.8.</p>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="oped-settings-footer">
          <button type="button" className="btn" onClick={handleReset}>Reset to defaults</button>
          <div className="oped-settings-footer-right">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={() => onApply(current)}>Apply</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Progress panel (§5.2) ──────────────────────────────────────────────────────

function OpEdProgressPanel({
  voices, progress, onCancel,
}: {
  voices: PovKey[];
  progress: Record<string, { stage: string; error?: string }>;
  onCancel: () => void;
}) {
  const heading = voices.length === 1 ? 'Drafting your op-ed…' : `Drafting ${voices.length} op-eds…`;
  const hasGraceful = Object.values(progress).some(p => p.stage === 'failed');

  return (
    <div className="oped-progress-panel">
      <h3 className="oped-progress-heading">{heading}</h3>
      <ul className="oped-progress-list" aria-live="polite">
        {voices.map(pov => {
          const p = progress[pov] ?? { stage: 'queued' };
          const camp = povToCamp(pov);
          const state = p.stage === 'failed' || p.stage === 'cancelled' ? 'failed' : (p.stage === 'complete' ? 'complete' : 'active');
          return (
            <li key={pov} className="oped-progress-item" data-state={state}>
              <span className="oped-progress-voice">
                {camp && <span className="oped-voice-chip-glyph" aria-hidden="true"><CampGlyph camp={camp} size={12} /></span>}
                {POV_META[pov].label}
              </span>
              <span className="oped-progress-stage">{stageLabel(pov, p.stage, p.error)}</span>
            </li>
          );
        })}
      </ul>
      {hasGraceful && (
        <p className="oped-progress-notice">
          Some voices could not finish — the drafts that succeeded will still open. Failed voices are marked in the reader.
        </p>
      )}
      <div className="oped-progress-actions">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ── Screen A form (extracted to keep the dialog's complexity in check) ────────

interface CreateFormProps {
  /** Whether the URL/source create path is offered. False on web (v1 topic-only) — the
   *  server rejects URL create, so we never present a submit path it can't run (t/2614). */
  allowUrlSource: boolean;
  fromWebPage: boolean;
  setFromWebPage: (v: boolean) => void;
  topic: string;
  setTopic: (v: string) => void;
  url: string;
  setUrl: (v: string) => void;
  /** Topic-box content looks like a web page URL (matches ^https?://) — only meaningful in topic mode. */
  topicLooksLikeUrl: boolean;
  /** Move the URL-shaped topic value into the URL field and switch to web-page mode. */
  onMigrateTopicToUrl: () => void;
  isAnonymous: boolean;
  voices: Set<PovKey>;
  toggleVoice: (pov: PovKey) => void;
  orderedVoices: PovKey[];
  outlet: string;
  setOutlet: (v: string) => void;
  newsHook: string;
  setNewsHook: (v: string) => void;
  settingsDiffCount: number;
  onOpenSettings: () => void;
  startError: ActionableShape | null;
  onClose: () => void;
  onDraft: () => void;
  canStart: boolean;
  /** The optional one-voice POV tag picker (t/3992), rendered by the dialog. */
  tagPicker: React.ReactNode;
  hasSource: boolean;
  modelHasKey: boolean;
  submitLabel: string;
}

function OpEdCreateForm(p: CreateFormProps) {
  return (
    <>
      <div className="oped-dialog-body">
        {/* Topic OR URL — mutually exclusive */}
        {!p.fromWebPage ? (
          <div>
            <label className="oped-field-label" htmlFor="oped-topic">
              Topic <span className="oped-required-mark" aria-hidden="true">*</span>
            </label>
            <AutoGrowTextarea
              id="oped-topic"
              className="oped-textarea"
              rows={2}
              value={p.topic}
              onChange={e => p.setTopic(e.target.value)}
              placeholder="e.g. Mandatory pre-deployment audits for frontier AI models"
              autoFocus
              aria-required="true"
            />
            {p.allowUrlSource && (
              <button type="button" className="oped-source-toggle" onClick={() => p.setFromWebPage(true)}>
                ⌥ From a web page instead →
              </button>
            )}
            {p.allowUrlSource && p.topicLooksLikeUrl && (
              <div className="oped-url-steer" role="status">
                <span className="oped-url-steer-text">
                  This looks like a web page. Switch to “From web page” to extract and link its claims.
                </span>
                <button type="button" className="oped-url-steer-action" onClick={p.onMigrateTopicToUrl}>
                  Use as web page →
                </button>
              </div>
            )}
          </div>
        ) : (
          <div>
            <label className="oped-field-label" htmlFor="oped-url">
              Web page URL <span className="oped-required-mark" aria-hidden="true">*</span>
            </label>
            <input
              id="oped-url"
              type="url"
              className="oped-input"
              value={p.url}
              onChange={e => p.setUrl(e.target.value)}
              placeholder="https://…"
              disabled={p.isAnonymous}
              autoFocus
            />
            {p.isAnonymous && <p className="oped-signin-note">Sign in to use URL sources.</p>}
            <button type="button" className="oped-source-toggle" onClick={() => { p.setFromWebPage(false); p.setUrl(''); }}>
              ← Use a topic instead
            </button>
          </div>
        )}

        {/* Voices — multi-select camp chips */}
        <div>
          <label className="oped-field-label" id="oped-voices-label">
            Voices — one op-ed each <span className="oped-required-mark" aria-hidden="true">*</span>
          </label>
          <div className="oped-voice-chips" role="group" aria-labelledby="oped-voices-label">
            {POV_KEYS.map(pov => {
              const camp = povToCamp(pov);
              const selected = p.voices.has(pov);
              return (
                <button
                  key={pov}
                  type="button"
                  className="oped-voice-chip"
                  aria-pressed={selected}
                  // eslint-disable-next-line local/no-inline-style -- dynamic: camp accent when selected (theme-aware)
                  style={selected ? { color: `var(${POV_META[pov].cssVar})` } : undefined}
                  onClick={() => p.toggleVoice(pov)}
                >
                  {camp && <span className="oped-voice-chip-glyph" aria-hidden="true"><CampGlyph camp={camp} size={13} /></span>}
                  {POV_META[pov].label}
                </button>
              );
            })}
          </div>
          <p className="oped-voice-count" aria-live="polite">{voiceCountLine(p.orderedVoices)}</p>
        </div>

        {p.tagPicker}

        {/* Outlet */}
        <div>
          <label className="oped-field-label" htmlFor="oped-outlet">Outlet</label>
          <select id="oped-outlet" className="oped-select" value={p.outlet} onChange={e => p.setOutlet(e.target.value)}>
            {OUTLETS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <p className="oped-field-hint">{OUTLETS.find(o => o.value === p.outlet)?.band}</p>
        </div>

        {/* News hook */}
        <div>
          <label className="oped-field-label" htmlFor="oped-newshook">News hook <span className="oped-inline-hint">(strongly recommended)</span></label>
          <input
            id="oped-newshook"
            type="text"
            className="oped-input"
            value={p.newsHook}
            onChange={e => p.setNewsHook(e.target.value)}
            placeholder="e.g. the Senate AI oversight bill up for a floor vote next week"
          />
          {!p.newsHook.trim() && (
            <p className="oped-field-hint">Without a hook the model will invent a plausible one — verify it before submitting.</p>
          )}
        </div>

        {/* More options */}
        <button type="button" className="oped-more-options-btn" onClick={p.onOpenSettings}>
          ▸ More options (thesis, author bio, word count, grounding, model)
          {p.settingsDiffCount > 0 && (
            <span className="oped-change-badge" aria-label={`${p.settingsDiffCount} setting${p.settingsDiffCount > 1 ? 's' : ''} changed`}>{p.settingsDiffCount}</span>
          )}
        </button>
      </div>

      <div className="oped-dialog-footer">
        {p.startError && (
          <div className="oped-start-error" role="alert">
            <div className="oped-start-error-problem">{p.startError.problem}</div>
            {p.startError.nextSteps.length > 0 && (
              <ul className="oped-start-error-steps">
                {p.startError.nextSteps.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            )}
          </div>
        )}
        <div className="oped-footer-actions">
          <div className="oped-footer-right">
            <button type="button" className="btn" onClick={p.onClose}>Cancel</button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={p.onDraft}
              disabled={!p.canStart}
              title={!p.hasSource ? 'Enter a topic or URL' : p.orderedVoices.length < 1 ? 'Select at least one voice' : !p.modelHasKey ? 'No API key configured for the selected model' : undefined}
            >
              {p.submitLabel}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Main dialog ────────────────────────────────────────────────────────────────

export function NewOpEdDialog({ open, onClose, onCreated, allowUrlSource = true, initialTopic }: {
  open: boolean;
  onClose: () => void;
  onCreated: (setId: string) => void;
  /** Offer the URL/source create path. Default true (desktop); false on web — v1 topic-only. */
  allowUrlSource?: boolean;
  /** t/4562: seeds the topic field when a getting-started chip opens this dialog. Only applied
   *  on open (not on every keystroke) — the dialog stays mounted across opens, so a plain
   *  `useState` initializer alone wouldn't re-seed on a second open with a different chip. */
  initialTopic?: string;
}) {
  // Screen A
  const [fromWebPage, setFromWebPage] = useState(false);
  const [topic, setTopic] = useState('');

  useEffect(() => {
    if (open && initialTopic) setTopic(initialTopic);
  }, [open, initialTopic]);

  const [url, setUrl] = useState('');
  // Default to all three camps selected (t/2849) — a study is normally the full triad.
  const [voices, setVoices] = useState<Set<PovKey>>(new Set(['accelerationist', 'safetyist', 'skeptic']));
  const [tagChoice, setTagChoice] = useState<OpEdTagChoice | undefined>(undefined);
  const tagRegistry = useMemo(() => registryOrNull(), []);
  const nodesFor = (pov: PovKey): PovNode[] => useTaxonomyStore.getState()[pov]?.nodes ?? [];
  const [outlet, setOutlet] = useState(DEFAULTS.outlet);
  const [newsHook, setNewsHook] = useState('');


  // Screen B–owned
  const [wordCount, setWordCount] = useState<number | null>(DEFAULTS.wordCount);
  const [thesis, setThesis] = useState(DEFAULTS.thesis);
  const [authorBio, setAuthorBio] = useState(DEFAULTS.authorBio);
  const [ground, setGround] = useState(DEFAULTS.ground);
  const [maxGroundingNodes, setMaxGroundingNodes] = useState(DEFAULTS.maxGroundingNodes);
  const [maxSituations, setMaxSituations] = useState(DEFAULTS.maxSituations);
  const [temperature, setTemperature] = useState(DEFAULTS.temperature);

  const { geminiModel } = useTaxonomyStore();
  const globalModel: string = geminiModel;
  const [model, setModel] = useState<string>(globalModel);

  // Key / tier
  const [hasApiKey, setHasApiKey] = useState<Record<string, boolean>>({});
  const { tier: tierInfo } = useTierInfo();
  const freeTier = isFreeTier(tierInfo);
  const auth = useAuthStatus();
  const isAnonymous = auth?.anonymous === true;

  // UI
  const [showSettings, setShowSettings] = useState(false);
  const [creating, setCreating] = useState(false);
  const [progress, setProgress] = useState<Record<string, { stage: string; error?: string }>>({});
  const [startError, setStartError] = useState<ActionableShape | null>(null);

  const runSetIdRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);
  const unsubRef = useRef<(() => void) | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open && !showSettings);

  // Restore focus to the triggering element on close
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    return () => { prev?.focus(); };
  }, [open]);

  // Escape closes (Screen A only; drawer handles its own)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !showSettings && !creating) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, showSettings, creating, onClose]);

  // Keep the model default tracking the global default until the user overrides it.
  useEffect(() => { setModel(m => (m === '' ? globalModel : m)); }, [globalModel]);

  // Load API-key availability for the key-check.
  useEffect(() => {
    if (!open) return;
    void Promise.all(
      AI_BACKENDS.map(async (b) => [b.value, await api.hasApiKey(b.value)] as [string, boolean]),
    ).then(results => setHasApiKey(Object.fromEntries(results)))
      .catch((err) => {
        getGlobalRecorder()?.record({ type: 'system.error', component: 'oped-new-dialog', level: 'warn', message: 'hasApiKey check failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      });
  }, [open]);

  // Cleanup the progress subscription on unmount.
  useEffect(() => () => { unsubRef.current?.(); unsubRef.current = null; }, []);

  const activeModel = computeActiveModel(freeTier, tierInfo, model);
  const activeModelBackend = backendForModelWithFallback(activeModel);
  const modelHasKey = computeModelHasKey(hasApiKey, activeModelBackend, freeTier, tierInfo);

  const orderedVoices = useMemo(() => POV_KEYS.filter(v => voices.has(v)), [voices]);

  const hasSource = fromWebPage ? url.trim().length > 0 : topic.trim().length > 0;
  // t/3992: a tag below its minimum refuses at setup (TL t/3957#7 B(a)), never mid-generation.
  const canStart = hasSource && orderedVoices.length >= 1 && modelHasKey && !opEdTagBlocksStart(tagChoice, orderedVoices, nodesFor);

  // A URL pasted into the topic box → FromTopic → no source brief → no claims, silently (t/2899).
  // Detect it so we can steer the user to the web-page path (desktop only; web has no URL path).
  const topicLooksLikeUrl = !fromWebPage && /^https?:\/\//i.test(topic.trim());
  const handleMigrateTopicToUrl = () => {
    setFromWebPage(true);
    setUrl(topic.trim());
    setTopic('');
  };

  const settingsDiffCount = SETTINGS_SECTIONS.filter(s =>
    sectionHasDiff(s.id, { outlet, wordCount, thesis, authorBio, ground, maxGroundingNodes, maxSituations, model, temperature }, globalModel),
  ).length;

  const toggleVoice = (pov: PovKey) => {
    setVoices(prev => {
      const next = new Set(prev);
      if (next.has(pov)) next.delete(pov); else next.add(pov);
      return next;
    });
  };

  const handleApplySettings = (v: OpEdSettingsValues) => {
    setOutlet(v.outlet);
    setWordCount(v.wordCount);
    setThesis(v.thesis);
    setAuthorBio(v.authorBio);
    setGround(v.ground);
    setMaxGroundingNodes(v.maxGroundingNodes);
    setMaxSituations(v.maxSituations);
    setModel(v.model);
    setTemperature(v.temperature);
    setShowSettings(false);
  };

  const buildPayload = (): CreateOpEdPayload => {
    const params: CreateOpEdParams = {
      outlet,
      newsHook: newsHook.trim() || undefined,
      thesis: thesis.trim() || undefined,
      authorBio: authorBio.trim() || undefined,
      model: activeModel,
      temperature,
    };
    if (fromWebPage && url.trim()) params.url = url.trim();
    if (wordCount != null) params.wordCount = wordCount;
    if (!ground) params.voiceOnly = true;
    else { params.maxGroundingNodes = maxGroundingNodes; params.maxSituations = maxSituations; }
    const sourceUrl = fromWebPage && url.trim() ? url.trim() : undefined;
    const tagSelection = opEdTagSelection(tagChoice, orderedVoices); // t/3992
    if (tagSelection) params.tagSelection = tagSelection;
    return { topic: topic.trim(), url: sourceUrl, params, voices: orderedVoices };
  };

  const handleCancel = () => {
    cancelledRef.current = true;
    const id = runSetIdRef.current;
    if (id) api.cancelOpEdSet(id);
  };

  const handleDraft = async () => {
    if (!canStart || creating) return;
    if (fromWebPage && isAnonymous) {
      setStartError({ problem: 'URL sources require sign-in.', nextSteps: ['Sign in with GitHub or Google', 'Or switch to a topic instead of a web page'] });
      return;
    }
    setCreating(true);
    setStartError(null);
    setProgress({});
    runSetIdRef.current = null;
    cancelledRef.current = false;

    // Subscribe BEFORE createOpEdSet — queued events carry the set_id so Cancel can
    // abort a run whose create promise has not yet resolved.
    const unsub = api.onOpEdProgress((e: OpEdProgressEvent) => {
      if (!runSetIdRef.current) runSetIdRef.current = e.set_id;
      setProgress(prev => ({ ...prev, [e.voice]: { stage: e.stage, error: e.error } }));
    });
    unsubRef.current = unsub;

    try {
      const { set_id } = await api.createOpEdSet(buildPayload());
      if (cancelledRef.current) { onClose(); return; }
      onCreated(set_id);
      onClose();
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'oped-new-dialog', level: 'error', message: 'Failed to create op-ed set', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      setStartError(toActionable(err));
      setCreating(false);
    } finally {
      unsub();
      unsubRef.current = null;
    }
  };

  if (!open) return null;

  const submitLabel = orderedVoices.length > 1 ? `Draft ${orderedVoices.length} op-eds` : 'Draft op-ed';

  return (
    <div className="dialog-overlay" onClick={() => { if (!creating) onClose(); }}>
      <div
        ref={dialogRef}
        className="oped-dialog"
        role="dialog"
        aria-modal
        aria-labelledby="oped-dialog-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="oped-dialog-header">
          <h2 className="oped-dialog-title" id="oped-dialog-title">New op-ed</h2>
          {!creating && (
            <button type="button" className="oped-close-btn" onClick={onClose} aria-label="Close">&times;</button>
          )}
        </div>

        {creating ? (
          <OpEdProgressPanel voices={orderedVoices} progress={progress} onCancel={handleCancel} />
        ) : (
          <OpEdCreateForm
            allowUrlSource={allowUrlSource}
            fromWebPage={fromWebPage}
            setFromWebPage={setFromWebPage}
            topic={topic}
            setTopic={setTopic}
            url={url}
            setUrl={setUrl}
            topicLooksLikeUrl={topicLooksLikeUrl}
            onMigrateTopicToUrl={handleMigrateTopicToUrl}
            isAnonymous={isAnonymous}
            voices={voices}
            toggleVoice={toggleVoice}
            orderedVoices={orderedVoices}
            outlet={outlet}
            setOutlet={setOutlet}
            newsHook={newsHook}
            setNewsHook={setNewsHook}
            settingsDiffCount={settingsDiffCount}
            onOpenSettings={() => setShowSettings(true)}
            startError={startError}
            onClose={onClose}
            onDraft={handleDraft}
            canStart={canStart}
            tagPicker={<OpEdTagPicker voices={orderedVoices} registry={tagRegistry} choice={tagChoice} onChange={setTagChoice} nodesFor={nodesFor} />}
            hasSource={hasSource}
            modelHasKey={modelHasKey}
            submitLabel={submitLabel}
          />
        )}
      </div>

      {showSettings && (
        <OpEdSettingsDrawer
          initial={{ outlet, wordCount, thesis, authorBio, ground, maxGroundingNodes, maxSituations, model, temperature }}
          globalModel={globalModel}
          onApply={handleApplySettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
