// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useMemo, useEffect, useRef, useLayoutEffect } from 'react';
import type { TextareaHTMLAttributes, Dispatch, SetStateAction, ReactNode } from 'react';
import { useFocusTrap, useMediaQuery } from './NewDebateDialog.hooks';
import { useDebateStore } from '../../hooks/useDebateStore';
import { useShallow } from 'zustand/react/shallow';
import { useTaxonomyStore, AI_BACKENDS, MODELS_BY_BACKEND, DEBATE_TIERS, FALLBACK_CHAINS, backendForModelWithFallback, initAIModels, type AIBackend } from '../../hooks/useTaxonomyStore';
import { POVER_INFO, DEBATE_AUDIENCES } from '../../types/debate';
import type { SpeakerId, DebateSourceType, DebateAudience, SeatTag } from '../../types/debate';
import { DEBATE_PROTOCOLS } from '../../data/debateProtocols';
import { AI_POVERS } from '@lib/debate/types';
import { CampGlyph, povToCamp } from '../shared/CampGlyph';
import './NewDebateDialog.css';
import { generateDebateTitlePrompt } from '../../prompts/newDebateDialog';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { loadProvisionalWeights } from '@lib/debate/phaseTransitions';
import { resolveMultiProviderModels, eligibleDebateBackends } from '@lib/ai-client/modelRouter';
import { useTierInfo, isFreeTier, type TierInfo } from '../../hooks/useTierInfo';
import { useGeminiOnboarding } from '../../hooks/useGeminiOnboarding';
import { useAuthStatus, useUserProfile } from '../../hooks/useAuthStatus';
import { useSettingsDialog } from '../../hooks/useSettingsDialog';
import { GeminiOnboardingModal } from '../settings/GeminiOnboardingModal';
import { buildDebateOptions } from './newDebateOptions';
import { SettingsToggleRow } from './SettingsToggleRow';
import { SeatTagPicker, seatTagLabel, seatTagRefusal, seatTagIssueMessage, registryOrNull } from './SeatTagPicker';

const DEBATE_EXCLUDED_BACKENDS = new Set(['ollama']); // can't reliably produce structured JSON for debates — capability gap, not an oversight

const LS_LAST_AUDIENCE = 'taxonomy-editor-last-debate-audience';
const LS_TOPIC_QUEUE   = 'taxonomy-editor-topic-queue';
const LS_CUSTOM_PRESETS = 'taxonomy-editor-custom-presets';

export type DialecticalStyle = 'adversarial' | 'deliberative' | 'integrative';

const STYLE_PRESETS: { id: DialecticalStyle; label: string; desc: string }[] = [
  { id: 'adversarial', label: 'Adversarial', desc: 'Direct challenge. Western academic debate norms.' },
  { id: 'deliberative', label: 'Deliberative', desc: 'Consensus-oriented. Longer exploration, faster synthesis.' },
  { id: 'integrative', label: 'Integrative', desc: 'Harmony-seeking. Reframing over rebuttal.' },
];

interface NewDebateDialogProps {
  onClose: () => void; onAtCap?: () => void; initialTopic?: string; initialPovers?: readonly SpeakerId[]; // t/4563 starter-chip prefill (mirrors NewChatDialog); omitted ⇒ unprefilled
}


// ── Module-level helpers ──────────────────────────────────────────────────────

const RESOLVE_FAILED = Symbol('resolve-failed');

// t/4563: ?? defaults live here, not in NewDebateDialog's body (local/complexity-budget)
function seedTopicAndPovers(
  initialTopic: string | undefined,
  initialPovers: readonly SpeakerId[] | undefined,
): { topic: string; povers: Set<SpeakerId> } {
  return { topic: initialTopic ?? '', povers: new Set(initialPovers ?? AI_POVERS) };
}
async function fetchDebateUrlContent(sourceRef: string): Promise<string> {
  try {
    const result = await api.fetchUrlContent(sourceRef.trim());
    if (result.error) return `[Failed to fetch URL content: ${result.error}]`;
    const content = result.content;
    return content.length > 100000 ? content.slice(0, 100000) + '\n\n[Content truncated at 100,000 characters]' : content;
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'new-debate-dialog', level: 'error', message: 'failed to fetch URL content for debate source', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    return `[Failed to fetch URL content: ${err}]`;
  }
}

// t/4046: eligibleBackends is the same (tier, availableBackends, registry) triple resolveMultiProviderModels draws from — computed from the one registry built here so the two never disagree (SO e/267#3); threaded into CreateDebateOptions for sessionSlice's model_pool fingerprint.
function resolveDebateSpeakerModels(
  modelTier: 'basic' | 'advanced',
  activeBackends: string[],
  povers: SpeakerId[],
): { speakerModels: Record<string, string>; eligibleBackends: string[] } | typeof RESOLVE_FAILED {
  try {
    const aiSpeakers = povers.filter(p => p !== 'user');
    const registry = { backends: AI_BACKENDS.map(b => ({ id: b.value, label: b.label })), models: [], debateTiers: DEBATE_TIERS };
    const speakerModels = resolveMultiProviderModels(modelTier, activeBackends, aiSpeakers, registry);
    return { speakerModels, eligibleBackends: eligibleDebateBackends(modelTier, activeBackends, registry) };
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'new-debate-dialog', level: 'error', message: 'Failed to resolve multi-provider models', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    return RESOLVE_FAILED;
  }
}

function buildCreationWeights(confrontationRounds: number, argumentationRounds: number, concludingRounds: number) {
  try {
    const w = loadProvisionalWeights();
    const p = w.pacing_presets?.moderate;
    return {
      pacing: 'moderate',
      maxTotalRounds: p?.maxTotalRounds,
      argumentationExit: p?.argumentationExit,
      concludingExit: p?.concludingExit,
      phase_bounds: w.phase_bounds,
      overrides: { confrontation: confrontationRounds, argumentation: argumentationRounds, concluding: concludingRounds },
    };
  } catch { /* telemetry — silent by design */ return null; }
}
// t/3958: extracted out of NewDebateDialog/DebateSettingsDialog so their own branch count (ESLint complexity-budget, t/3821) doesn't absorb the seat-tag refusal logic.
function computeCanStart(
  hasSource: boolean,
  selectedSize: number,
  multiProvider: boolean,
  activeBackendsLen: number,
  activeModelHasKey: boolean,
  seatTagIssue: unknown,
): boolean {
  return hasSource && selectedSize >= 1 && (multiProvider ? activeBackendsLen >= 2 : activeModelHasKey) && !seatTagIssue;
}

function renderSeatTagIssueBanner(
  startError: string | null,
  seatTagIssue: ReturnType<typeof seatTagRefusal>,
  className: string,
) {
  return !startError && seatTagIssue
    ? <div className={className} role="alert">{seatTagIssueMessage(seatTagIssue)} — change the tag or mode for that seat.</div>
    : null;
}

function buildDebateSourceArgs(sourceType: DebateSourceType, sourceRef: string, finalContent: string): { sourceTypeArg: DebateSourceType; sourceRefArg: string; contentArg: string } {
  return {
    sourceTypeArg: sourceType === 'other' ? 'topic' : sourceType,
    sourceRefArg: sourceType === 'topic' || sourceType === 'other' ? '' : sourceRef.trim(),
    contentArg: sourceType === 'topic' || sourceType === 'other' ? '' : finalContent,
  };
}

function computeDebateModelOverride(multiProvider: boolean, useCustomModel: boolean, customModel: string): string | undefined {
  return multiProvider ? undefined : (useCustomModel ? customModel : undefined);
}

function buildDebateCreatedData(p: {
  id: string; sourceType: DebateSourceType; povers: SpeakerId[]; userIsPover: boolean;
  effectiveModel: string; protocolId: string; temperature: number; audience: DebateAudience;
  stepMode: boolean; multiProvider: boolean; modelTier: 'basic' | 'advanced';
  speakerModels: Record<string, string> | undefined;
  stageModels: { brief: string; plan: string; cite: string };
  creationWeights: ReturnType<typeof buildCreationWeights>;
}): Record<string, unknown> {
  return { debate_id: p.id, source_type: p.sourceType, povers: p.povers, user_is_pover: p.userIsPover, model: p.effectiveModel, protocol: p.protocolId, temperature: p.temperature, audience: p.audience || null, adaptive_staging: true, step_mode: p.stepMode || undefined, multi_provider: p.multiProvider || undefined, model_tier: p.multiProvider ? p.modelTier : undefined, speaker_models: p.speakerModels || undefined, stage_models: (p.stageModels.brief || p.stageModels.plan || p.stageModels.cite) ? p.stageModels : undefined, ...p.creationWeights && { adaptive_config: p.creationWeights } };
}

function computeActiveModel(freeTier: boolean, tierInfo: TierInfo | null, useCustomModel: boolean, customModel: string, globalModel: string): string {
  return freeTier && tierInfo?.pinnedModel ? tierInfo.pinnedModel : (useCustomModel ? customModel : globalModel);
}

function computeActiveModelHasKey(activeModelExcluded: boolean, hasApiKey: Record<string, boolean>, activeModelBackend: string, freeTier: boolean, tierInfo: TierInfo | null): boolean {
  return !activeModelExcluded && (hasApiKey[activeModelBackend] !== false || (freeTier && tierInfo!.allowedBackends.includes(activeModelBackend)));
}

// ── Preset system (Screen A — t/2199) ────────────────────────────────────────

type BuiltInPresetId = 'quick' | 'deep' | 'socratic';
type PresetId = BuiltInPresetId | 'custom';

// Exported so other debate-creation surfaces (e.g. SituationDebatePanel, t/3928) can reuse
// the same per-phase round bounds instead of maintaining a second copy of the numbers —
// the PI's "mirror the normal path" decision (t/3882#4) only holds if there's one source.
export const PRESET_DEFAULTS: Record<BuiltInPresetId, {
  protocolId: string; dialecticalStyle: DialecticalStyle;
  confrontationRounds: number; argumentationRounds: number; concludingRounds: number;
  stepMode: boolean; modelTier: 'basic' | 'advanced';
}> = {
  quick:    { protocolId: 'structured',   dialecticalStyle: 'adversarial',  confrontationRounds: 1, argumentationRounds: 1, concludingRounds: 1, stepMode: false, modelTier: 'basic'    },
  deep:     { protocolId: 'deliberation', dialecticalStyle: 'deliberative', confrontationRounds: 1, argumentationRounds: 3, concludingRounds: 1, stepMode: false, modelTier: 'advanced' },
  socratic: { protocolId: 'socratic',     dialecticalStyle: 'integrative',  confrontationRounds: 2, argumentationRounds: 4, concludingRounds: 2, stepMode: true,  modelTier: 'basic'    },
};

const SCREEN_A_PRESETS: { id: BuiltInPresetId; label: string; summary: string; estimatedMinutes?: number }[] = [
  { id: 'quick',    label: 'Quick take', summary: '1+1 rounds · basic model',                 estimatedMinutes: 4  },
  { id: 'deep',     label: 'Deep dive',  summary: '1+3 rounds · frontier model',               estimatedMinutes: 12 },
  { id: 'socratic', label: 'Socratic',   summary: '2+4 rounds · step-by-step · basic model',   estimatedMinutes: 20 },
];

function countSettingsDiff(
  preset: BuiltInPresetId,
  protocolId: string, dialecticalStyle: DialecticalStyle,
  confrontationRounds: number, argumentationRounds: number, concludingRounds: number,
  stepMode: boolean, modelTier: 'basic' | 'advanced',
): number {
  const p = PRESET_DEFAULTS[preset];
  let diff = 0;
  if (protocolId !== p.protocolId) diff++;
  if (dialecticalStyle !== p.dialecticalStyle) diff++;
  if (confrontationRounds !== p.confrontationRounds) diff++;
  if (argumentationRounds !== p.argumentationRounds) diff++;
  if (concludingRounds !== p.concludingRounds) diff++;
  if (stepMode !== p.stepMode) diff++;
  if (modelTier !== p.modelTier) diff++;
  return diff;
}


function AutoGrowTextarea({
  value,
  maxHeight = 320,
  ...props
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

function PresetCards({ basePreset, isCustom, onSelect }: {
  basePreset: BuiltInPresetId; isCustom: boolean; onSelect: (id: BuiltInPresetId) => void;
}) {
  const activeId: PresetId = isCustom ? 'custom' : basePreset;
  const handleKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      onSelect(SCREEN_A_PRESETS[(idx + 1) % SCREEN_A_PRESETS.length].id);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      onSelect(SCREEN_A_PRESETS[(idx - 1 + SCREEN_A_PRESETS.length) % SCREEN_A_PRESETS.length].id);
    }
  };
  return (
    <div className="ndd-preset-group" role="radiogroup" aria-label="Debate preset">
      {SCREEN_A_PRESETS.map((p, idx) => {
        const isSelected = activeId === p.id;
        return (
          <div
            key={p.id}
            className={`ndd-preset-card${isSelected && !isCustom ? ' ndd-preset-card--selected' : ''}`}
            role="radio"
            aria-checked={isSelected && !isCustom}
            tabIndex={isSelected && !isCustom ? 0 : -1}
            onClick={() => onSelect(p.id)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
          >
            <div className="ndd-preset-card-header">
              {isSelected && !isCustom && <span className="ndd-preset-check" aria-hidden="true">✓</span>}
              <span className="ndd-preset-label">{p.label}</span>
            </div>
            <span className="ndd-preset-summary">{p.summary}</span>
            {p.estimatedMinutes !== undefined && (
              <span className="ndd-preset-time">~{p.estimatedMinutes} min</span>
            )}
          </div>
        );
      })}
      {isCustom && (
        <div
          className="ndd-preset-card ndd-preset-card--selected ndd-preset-card--custom"
          role="radio"
          aria-checked={true}
          tabIndex={0}
        >
          <div className="ndd-preset-card-header">
            <span className="ndd-preset-check" aria-hidden="true">✓</span>
            <span className="ndd-preset-label">Custom</span>
          </div>
          <span className="ndd-preset-summary">
            Based on {SCREEN_A_PRESETS.find(p => p.id === basePreset)?.label ?? 'Quick take'}
          </span>
        </div>
      )}
    </div>
  );
}

async function generateDebateTitle(topic: string): Promise<string> {
  const { text } = await api.generateText(generateDebateTitlePrompt(topic));
  return text.trim().slice(0, 120);
}

// ── Screen B — DebateSettingsDialog (t/2201) ─────────────────────────────────

type SettingsSection = 'format' | 'voices' | 'model' | 'sourcing' | 'material';

// t/4717 (PI): "Model & providers" moved to last, below "Source material" — panels are
// selected by id (openSettings('model'), the activeSection switch below), so this reorder
// changes only the sidebar's display/tab order, nothing else.
const SETTINGS_SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'format',   label: 'Format & pacing' },
  { id: 'voices',   label: 'Voices & audience' },
  { id: 'sourcing', label: 'Argument sourcing' },
  { id: 'material', label: 'Source material' },
  { id: 'model',    label: 'Model & providers' },
];

interface SettingsApply {
  selected: Set<SpeakerId>;
  userIsPover: boolean;
  audience: DebateAudience;
  protocolId: string;
  dialecticalStyle: DialecticalStyle;
  confrontationRounds: number;
  argumentationRounds: number;
  concludingRounds: number;
  stepMode: boolean;
  modelTier: 'basic' | 'advanced';
  multiProvider: boolean;
  excludedBackends: Set<string>;
  excludeGreatestHits: boolean;
  narrativeVoicing: boolean;
  useCustomModel: boolean;
  customModel: string;
  titleOverride: string;
  background: string; seatTags: Partial<Record<SpeakerId, SeatTag>>;
}

interface DebateSettingsProps {
  initialSection?: SettingsSection;
  basePreset: BuiltInPresetId;
  // Voices & audience
  selected: Set<SpeakerId>;
  userIsPover: boolean;
  audience: DebateAudience;
  // Format & pacing
  protocolId: string;
  dialecticalStyle: DialecticalStyle;
  confrontationRounds: number;
  argumentationRounds: number;
  concludingRounds: number;
  stepMode: boolean;
  narrativeVoicing: boolean;
  // Model & providers
  modelTier: 'basic' | 'advanced';
  multiProvider: boolean;
  excludedBackends: Set<string>;
  useCustomModel: boolean;
  customModel: string;
  globalModel: string;
  backendsWithKeys: string[];
  hasApiKey: Record<string, boolean>;
  // Argument sourcing
  excludeGreatestHits: boolean;
  // Source material
  titleOverride: string;
  background: string; seatTags: Partial<Record<SpeakerId, SeatTag>>; // POV tags (t/3958)
  // Callbacks
  onApply: (changes: SettingsApply) => void;
  onClose: () => void;
  onSaveAsPreset: (name: string, settings: SettingsApply) => void;
}

type PresetDef = typeof PRESET_DEFAULTS[BuiltInPresetId];
type SectionDiffState = {
  protocolId: string; dialecticalStyle: DialecticalStyle;
  confrontationRounds: number; argumentationRounds: number; concludingRounds: number;
  stepMode: boolean; narrativeVoicing: boolean; modelTier: 'basic' | 'advanced';
  multiProvider: boolean; useCustomModel: boolean;
  selected: Set<SpeakerId>; userIsPover: boolean; audience: DebateAudience;
  excludeGreatestHits: boolean; titleOverride: string; background: string;
};

function fmtDiff(p: PresetDef, s: SectionDiffState): boolean {
  return s.protocolId !== p.protocolId || s.dialecticalStyle !== p.dialecticalStyle ||
    s.confrontationRounds !== p.confrontationRounds || s.argumentationRounds !== p.argumentationRounds ||
    s.concludingRounds !== p.concludingRounds || s.stepMode !== p.stepMode || s.narrativeVoicing;
}
function voicesDiff(s: SectionDiffState): boolean {
  return s.selected.size !== AI_POVERS.length || AI_POVERS.some(id => !s.selected.has(id)) ||
    s.userIsPover || s.audience !== 'policymakers';
}
function modelDiff(p: PresetDef, s: SectionDiffState): boolean {
  return s.modelTier !== p.modelTier || s.multiProvider || s.useCustomModel;
}
function materialDiff(s: SectionDiffState): boolean {
  return s.titleOverride !== '' || s.background !== '';
}

function sectionHasDiff(
  section: SettingsSection,
  preset: BuiltInPresetId,
  s: SectionDiffState,
): boolean {
  const p = PRESET_DEFAULTS[preset];
  switch (section) {
    case 'format':   return fmtDiff(p, s);
    case 'voices':   return voicesDiff(s);
    case 'model':    return modelDiff(p, s);
    case 'sourcing': return s.excludeGreatestHits;
    case 'material': return materialDiff(s);
  }
}

function SaveAsPresetModal({
  onSave,
  onCancel,
}: { onSave: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  return (
    <div className="ndd-save-preset-overlay" onClick={onCancel}>
      <div className="ndd-save-preset-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal aria-label="Save preset">
        <h3 className="ndd-save-preset-title">Save as preset</h3>
        <input
          className="ndd-input"
          type="text"
          placeholder="Preset name"
          value={name}
          onChange={e => setName(e.target.value)}
          autoFocus
          onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onSave(name.trim()); if (e.key === 'Escape') onCancel(); }}
          maxLength={60}
        />
        <div className="ndd-save-preset-actions">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!name.trim()} onClick={() => onSave(name.trim())}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ── Section panel sub-components for DebateSettingsDialog (local/complexity-budget t/3821) ──

interface FormatPacingProps {
  localProtocolId: string; setLocalProtocolId: (v: string) => void;
  localStyle: DialecticalStyle; setLocalStyle: (v: DialecticalStyle) => void;
  localConfrontation: number; setLocalConfrontation: (v: number) => void;
  localArgumentation: number; setLocalArgumentation: (v: number) => void;
  localConcluding: number; setLocalConcluding: (v: number) => void;
  localStepMode: boolean; setLocalStepMode: (v: boolean) => void;
  localNarrativeVoicing: boolean; setLocalNarrativeVoicing: (v: boolean) => void;
}
function FormatPacingSection({ localProtocolId, setLocalProtocolId, localStyle, setLocalStyle, localConfrontation, setLocalConfrontation, localArgumentation, setLocalArgumentation, localConcluding, setLocalConcluding, localStepMode, setLocalStepMode, localNarrativeVoicing, setLocalNarrativeVoicing }: FormatPacingProps) {
  return (
    <>
      <h3 className="ndd-settings-section-title">Format &amp; pacing</h3>
      <div className="ndd-settings-field">
        <label className="ndd-field-label" htmlFor="ndd-s-protocol">Protocol</label>
        <select id="ndd-s-protocol" className="ndd-input" value={localProtocolId} onChange={e => setLocalProtocolId(e.target.value)}>
          {DEBATE_PROTOCOLS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <p className="ndd-settings-field-hint">{DEBATE_PROTOCOLS.find(p => p.id === localProtocolId)?.description}</p>
      </div>
      <div className="ndd-settings-field">
        <label className="ndd-field-label">Dialectical style</label>
        <div className="ndd-style-options">
          {STYLE_PRESETS.map(s => (
            <label key={s.id} className={`ndd-style-option${localStyle === s.id ? ' active' : ''}`}>
              <input type="radio" name="ndd-style" value={s.id} checked={localStyle === s.id} onChange={() => setLocalStyle(s.id)} className="sr-only" />
              <span className="ndd-style-label">{s.label}</span>
              <span className="ndd-style-desc">{s.desc}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="ndd-settings-field">
        <label className="ndd-field-label">Max rounds per phase</label>
        <div className="ndd-rounds-grid">
          {([
            { label: 'Confrontation', value: localConfrontation, set: setLocalConfrontation, min: 1, max: 6 },
            { label: 'Argumentation', value: localArgumentation, set: setLocalArgumentation, min: 1, max: 10 },
            { label: 'Concluding',    value: localConcluding,    set: setLocalConcluding,    min: 1, max: 4 },
          ] as const).map(r => (
            <div key={r.label} className="ndd-rounds-field">
              <label className="ndd-rounds-label">{r.label}</label>
              <input type="number" className="ndd-input ndd-rounds-input" min={r.min} max={r.max} value={r.value}
                onChange={e => r.set(Math.min(r.max, Math.max(r.min, parseInt(e.target.value, 10) || r.min)))} />
            </div>
          ))}
        </div>
      </div>
      <SettingsToggleRow checked={localStepMode} onChange={setLocalStepMode}
        name="Pause between phases" help="Wait for your input before each new debate phase" />
      <SettingsToggleRow checked={localNarrativeVoicing} onChange={setLocalNarrativeVoicing}
        name="Moderator voices each camp's story"
        help="Before the openings, the moderator retells what each camp fears losing and what history it carries. Experimental." />
    </>
  );
}

interface VoicesAudienceProps {
  isSocratic: boolean;
  localSelected: Set<SpeakerId>; setLocalSelected: Dispatch<SetStateAction<Set<SpeakerId>>>;
  toggleDebater: (id: SpeakerId) => void;
  localSeatTags: Partial<Record<SpeakerId, SeatTag>>; setLocalSeatTags: Dispatch<SetStateAction<Partial<Record<SpeakerId, SeatTag>>>>;
  povTagRegistry: ReturnType<typeof registryOrNull>;
  localUserIsPover: boolean; setLocalUserIsPover: Dispatch<SetStateAction<boolean>>;
  localAudience: DebateAudience; setLocalAudience: (v: DebateAudience) => void;
  localSeatTagIssue: ReturnType<typeof seatTagRefusal>;
}
function VoicesAudienceSection({ isSocratic, localSelected, setLocalSelected, toggleDebater, localSeatTags, setLocalSeatTags, povTagRegistry, localUserIsPover, setLocalUserIsPover, localAudience, setLocalAudience, localSeatTagIssue }: VoicesAudienceProps) {
  return (
    <>
      <h3 className="ndd-settings-section-title">Voices &amp; audience</h3>
      <label className="ndd-field-label">Debaters</label>
      {isSocratic && <p className="ndd-settings-field-hint">Socratic elenchus examines one interlocutor. Select one perspective.</p>}
      <div className="ndd-settings-debaters">
        {AI_POVERS.map(id => {
          const info = POVER_INFO[id];
          const camp = povToCamp(id);
          const sel = localSelected.has(id);
          const tagLabel = seatTagLabel(id, localSeatTags[id], povTagRegistry);
          return (
            <div key={id} className="ndd-settings-debater-group">
              <label className={`ndd-settings-debater-row${isSocratic && !sel ? ' ndd-settings-debater-row--dim' : ''}`}>
                <input type="checkbox" checked={sel} onChange={() => isSocratic ? setLocalSelected(new Set([id])) : toggleDebater(id)} />
                <span className="ndd-debater-chip" data-camp={camp}>
                  <span className="ndd-debater-chip-icon" aria-hidden="true"><CampGlyph camp={camp!} size={12} /></span>
                  {info.label}{tagLabel && ` · ${tagLabel}`}
                </span>
                <span className="ndd-step-help" style={{ margin: 0 }}>{info.personality}</span>
              </label>
              {sel && (
                <SeatTagPicker pov={id} povNodes={useTaxonomyStore.getState()[id]?.nodes ?? []} registry={povTagRegistry}
                  seatTag={localSeatTags[id]}
                  onChange={t => setLocalSeatTags(p => { const n = { ...p }; if (t) n[id] = t; else delete n[id]; return n; })} />
              )}
            </div>
          );
        })}
        <label className="ndd-settings-debater-row">
          <input type="checkbox" checked={localUserIsPover} disabled={isSocratic} onChange={() => setLocalUserIsPover(v => !v)} />
          <span className="ndd-debater-chip ndd-debater-chip--user">👤 You</span>
          <span className="ndd-step-help" style={{ margin: 0 }}>Argue a position yourself</span>
        </label>
      </div>
      {localSelected.size < 1 && <div className="ndd-hint-error">Select at least 1 perspective</div>}
      {renderSeatTagIssueBanner(null, localSeatTagIssue, 'ndd-hint-error')}
      <div className="ndd-settings-audience-select">
        <label className="ndd-field-label" htmlFor="ndd-settings-audience">Written for</label>
        <select id="ndd-settings-audience" className="ndd-input" value={localAudience} onChange={e => setLocalAudience(e.target.value as DebateAudience)}>
          {DEBATE_AUDIENCES.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
      </div>
    </>
  );
}

interface ModelProvidersProps {
  localModelTier: 'basic' | 'advanced'; setLocalModelTier: (v: 'basic' | 'advanced') => void;
  localMultiProvider: boolean; setLocalMultiProvider: (v: boolean) => void;
  backendsWithKeys: string[];
  localExcludedBackends: Set<string>; toggleBackend: (id: string) => void;
  hasApiKey: Record<string, boolean>;
  localUseCustomModel: boolean; setLocalUseCustomModel: (v: boolean) => void;
  localCustomModel: string; setLocalCustomModel: (v: string) => void;
  localCustomFamily: AIBackend; setLocalCustomFamily: (v: AIBackend) => void;
  globalModel: string;
  refreshing: boolean; setRefreshing: (v: boolean) => void;
}
function ModelProvidersSection({ localModelTier, setLocalModelTier, localMultiProvider, setLocalMultiProvider, backendsWithKeys, localExcludedBackends, toggleBackend, hasApiKey, localUseCustomModel, setLocalUseCustomModel, localCustomModel, setLocalCustomModel, localCustomFamily, setLocalCustomFamily, globalModel, refreshing, setRefreshing }: ModelProvidersProps) {
  return (
    <>
      <h3 className="ndd-settings-section-title">Model &amp; providers</h3>
      <div className="ndd-settings-field">
        <label className="ndd-field-label">Model tier</label>
        <div className="ndd-tier-chips">
          {(['basic', 'advanced'] as const).map(tier => (
            <button key={tier} type="button" className={`ndd-tier-chip${localModelTier === tier ? ' active' : ''}`} onClick={() => setLocalModelTier(tier)}>
              {tier === 'basic' ? 'Basic' : 'Frontier'}
            </button>
          ))}
        </div>
        <p className="ndd-settings-field-hint">
          {localModelTier === 'basic' ? 'Faster and lower-cost. Good for quick topics.' : 'Most capable model tier. Better for nuanced, complex topics.'}
        </p>
      </div>
      <label className="ndd-settings-toggle-row">
        <input type="checkbox" checked={localMultiProvider} onChange={e => setLocalMultiProvider(e.target.checked)} />
        <div>
          <span className="ndd-toggle-name">Multi-provider mode</span>
          <span className="ndd-step-help">Assign different AI backends to each debater</span>
        </div>
      </label>
      {localMultiProvider ? (
        <div className="ndd-settings-field">
          <label className="ndd-field-label">Active backends</label>
          <div className="ndd-backend-chips">
            {backendsWithKeys.map(id => {
              const info = AI_BACKENDS.find(b => b.value === id);
              const active = !localExcludedBackends.has(id);
              return (
                <button key={id} type="button" className={`ndd-backend-chip${active ? ' active' : ''}`} onClick={() => toggleBackend(id)}>
                  {info?.label ?? id}
                  {hasApiKey[id] === false && <span className="ndd-backend-nokey" title="No API key"> !</span>}
                </button>
              );
            })}
          </div>
          {backendsWithKeys.length < 2 && <p className="ndd-warning-text">Multi-provider needs at least 2 backends with API keys.</p>}
        </div>
      ) : (
        <>
          <label className="ndd-settings-toggle-row" style={{ marginTop: 'var(--sp-4)' }}>
            <input type="checkbox" checked={localUseCustomModel} onChange={e => setLocalUseCustomModel(e.target.checked)} />
            <div>
              <span className="ndd-toggle-name">Custom model</span>
              <span className="ndd-step-help">Override the default model for this debate</span>
            </div>
          </label>
          {localUseCustomModel && (
            <div style={{ marginTop: 'var(--sp-2)' }}>
              <div className="ndd-custom-model-row">
                <div className="ndd-custom-model-field">
                  <label className="ndd-settings-field-hint">Model family</label>
                  <select className="ndd-input" value={localCustomFamily} onChange={e => { const fam = e.target.value as AIBackend; setLocalCustomFamily(fam); setLocalCustomModel(MODELS_BY_BACKEND[fam]?.[0]?.value ?? localCustomModel); }}>
                    {AI_BACKENDS.map(b => <option key={b.value} value={b.value}>{b.label}</option>)}
                  </select>
                </div>
                <button type="button" className="ndd-refresh-btn" disabled={refreshing} onClick={async () => { setRefreshing(true); try { await api.refreshAIModels({ dryRun: true }); await initAIModels(); } catch { /* telemetry — silent by design */ } setRefreshing(false); }}>
                  {refreshing ? 'Refreshing…' : 'Refresh models'}
                </button>
              </div>
              <div className="ndd-custom-model-field" style={{ marginTop: 'var(--sp-2)' }}>
                <label className="ndd-settings-field-hint">Model</label>
                <select className="ndd-input" value={localCustomModel} onChange={e => setLocalCustomModel(e.target.value)}>
                  {(MODELS_BY_BACKEND[localCustomFamily] ?? []).map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
            </div>
          )}
          {!localUseCustomModel && (
            <p className="ndd-settings-field-hint" style={{ marginTop: 'var(--sp-2)' }}>
              Using default model: <code>{globalModel}</code>
            </p>
          )}
        </>
      )}
    </>
  );
}

function ArgumentSourcingSection({ localExcludeGreatestHits, setLocalExcludeGreatestHits }: { localExcludeGreatestHits: boolean; setLocalExcludeGreatestHits: (v: boolean) => void }) {
  return (
    <>
      <h3 className="ndd-settings-section-title">Argument sourcing</h3>
      <SettingsToggleRow checked={localExcludeGreatestHits} onChange={setLocalExcludeGreatestHits}
        name="Exclude well-tested nodes"
        help="Skip well-tested taxonomy nodes and the curated greatest-hits list, and favor untested or only-cited nodes, so the debate stress-tests under-examined arguments" />
    </>
  );
}

function SourceMaterialSection({ localTitleOverride, setLocalTitleOverride, localBackground, setLocalBackground }: { localTitleOverride: string; setLocalTitleOverride: (v: string) => void; localBackground: string; setLocalBackground: (v: string) => void }) {
  return (
    <>
      <h3 className="ndd-settings-section-title">Source material</h3>
      <div className="ndd-settings-field">
        <label className="ndd-field-label" htmlFor="ndd-s-title-override">Title override</label>
        <input id="ndd-s-title-override" className="ndd-input" type="text" placeholder="Leave blank to auto-generate from topic" value={localTitleOverride} onChange={e => setLocalTitleOverride(e.target.value)} maxLength={120} />
        <p className="ndd-settings-field-hint">Overrides the generated title if set.</p>
      </div>
      <div className="ndd-settings-field">
        <label className="ndd-field-label" htmlFor="ndd-s-background">Background context</label>
        <AutoGrowTextarea id="ndd-s-background" className="ndd-adder-textarea" value={localBackground} onChange={e => setLocalBackground(e.target.value)} rows={4} placeholder="Additional context for the debaters…" />
      </div>
    </>
  );
}

interface RenderSectionArgs {
  activeSection: SettingsSection;
  formatProps: FormatPacingProps;
  voicesProps: VoicesAudienceProps;
  modelProps: ModelProvidersProps;
  sourcingProps: { localExcludeGreatestHits: boolean; setLocalExcludeGreatestHits: (v: boolean) => void };
  materialProps: { localTitleOverride: string; setLocalTitleOverride: (v: string) => void; localBackground: string; setLocalBackground: (v: string) => void };
}
function renderSettingsSection({ activeSection, formatProps, voicesProps, modelProps, sourcingProps, materialProps }: RenderSectionArgs): ReactNode {
  switch (activeSection) {
    case 'format':   return <FormatPacingSection {...formatProps} />;
    case 'voices':   return <VoicesAudienceSection {...voicesProps} />;
    case 'model':    return <ModelProvidersSection {...modelProps} />;
    case 'sourcing': return <ArgumentSourcingSection {...sourcingProps} />;
    case 'material': return <SourceMaterialSection {...materialProps} />;
  }
}

function DebateSettingsDialog({
  initialSection = 'format',
  basePreset,
  selected: initSelected,
  userIsPover: initUserIsPover,
  audience: initAudience,
  protocolId: initProtocolId,
  dialecticalStyle: initDialecticalStyle,
  confrontationRounds: initConfrontationRounds,
  argumentationRounds: initArgumentationRounds,
  concludingRounds: initConcludingRounds,
  stepMode: initStepMode,
  narrativeVoicing: initNarrativeVoicing,
  modelTier: initModelTier,
  multiProvider: initMultiProvider,
  excludedBackends: initExcludedBackends,
  useCustomModel: initUseCustomModel,
  customModel: initCustomModel,
  globalModel,
  backendsWithKeys,
  hasApiKey,
  excludeGreatestHits: initExcludeGreatestHits,
  titleOverride: initTitleOverride,
  background: initBackground, seatTags: initSeatTags,
  onApply,
  onClose,
  onSaveAsPreset,
}: DebateSettingsProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection);
  // Voices
  const [localSelected, setLocalSelected] = useState(() => new Set(initSelected));
  const [localSeatTags, setLocalSeatTags] = useState(initSeatTags);
  const povTagRegistry = registryOrNull();
  const [localUserIsPover, setLocalUserIsPover] = useState(initUserIsPover);
  const [localAudience, setLocalAudience] = useState(initAudience);
  // Format
  const [localProtocolId, setLocalProtocolId] = useState(initProtocolId);
  const [localStyle, setLocalStyle] = useState(initDialecticalStyle);
  const [localConfrontation, setLocalConfrontation] = useState(initConfrontationRounds);
  const [localArgumentation, setLocalArgumentation] = useState(initArgumentationRounds);
  const [localConcluding, setLocalConcluding] = useState(initConcludingRounds);
  const [localStepMode, setLocalStepMode] = useState(initStepMode);
  const [localNarrativeVoicing, setLocalNarrativeVoicing] = useState(initNarrativeVoicing);
  // Model
  const [localModelTier, setLocalModelTier] = useState(initModelTier);
  const [localMultiProvider, setLocalMultiProvider] = useState(initMultiProvider);
  const [localExcludedBackends, setLocalExcludedBackends] = useState(() => new Set(initExcludedBackends));
  const [localUseCustomModel, setLocalUseCustomModel] = useState(initUseCustomModel);
  const [localCustomModel, setLocalCustomModel] = useState(initCustomModel);
  const [localCustomFamily, setLocalCustomFamily] = useState<AIBackend>(() => backendForModelWithFallback(initCustomModel));
  const [refreshing, setRefreshing] = useState(false);
  // Sourcing
  const [localExcludeGreatestHits, setLocalExcludeGreatestHits] = useState(initExcludeGreatestHits);
  // Material
  const [localTitleOverride, setLocalTitleOverride] = useState(initTitleOverride);
  const [localBackground, setLocalBackground] = useState(initBackground);
  // Save as preset modal
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [mobileSubView, setMobileSubView] = useState<SettingsSection | null>(null);
  const isMobile = useMediaQuery('(max-width: 640px)');

  // Restore focus to the triggering element when Screen B closes
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => { prev?.focus(); };
  }, []);

  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true);

  // Escape → close without applying
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const currentSettings = useMemo<Parameters<typeof sectionHasDiff>[2]>(() => ({
    protocolId: localProtocolId, dialecticalStyle: localStyle,
    confrontationRounds: localConfrontation, argumentationRounds: localArgumentation,
    concludingRounds: localConcluding, stepMode: localStepMode, narrativeVoicing: localNarrativeVoicing,
    modelTier: localModelTier, multiProvider: localMultiProvider,
    useCustomModel: localUseCustomModel, selected: localSelected,
    userIsPover: localUserIsPover, audience: localAudience,
    excludeGreatestHits: localExcludeGreatestHits,
    titleOverride: localTitleOverride, background: localBackground,
  }), [
    localProtocolId, localStyle, localConfrontation, localArgumentation, localConcluding,
    localStepMode, localNarrativeVoicing, localModelTier, localMultiProvider, localUseCustomModel, localSelected,
    localUserIsPover, localAudience, localExcludeGreatestHits, localTitleOverride, localBackground,
  ]);

  const toggleDebater = (id: SpeakerId) => {
    setLocalSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleBackend = (id: string) => {
    setLocalExcludedBackends(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const buildApply = (): SettingsApply => ({
    selected: localSelected, userIsPover: localUserIsPover, audience: localAudience,
    protocolId: localProtocolId, dialecticalStyle: localStyle,
    confrontationRounds: localConfrontation, argumentationRounds: localArgumentation,
    concludingRounds: localConcluding, stepMode: localStepMode, narrativeVoicing: localNarrativeVoicing,
    modelTier: localModelTier, multiProvider: localMultiProvider,
    excludedBackends: localExcludedBackends,
    useCustomModel: localUseCustomModel, customModel: localCustomModel,
    excludeGreatestHits: localExcludeGreatestHits,
    titleOverride: localTitleOverride, background: localBackground, seatTags: localSeatTags,
  });

  const handleReset = () => {
    const p = PRESET_DEFAULTS[basePreset];
    setLocalSelected(p.protocolId === 'socratic' ? new Set([AI_POVERS[0]]) : new Set(AI_POVERS));
    setLocalUserIsPover(false);
    setLocalAudience('policymakers');
    setLocalProtocolId(p.protocolId);
    setLocalStyle(p.dialecticalStyle);
    setLocalConfrontation(p.confrontationRounds);
    setLocalArgumentation(p.argumentationRounds);
    setLocalConcluding(p.concludingRounds);
    setLocalStepMode(p.stepMode);
    setLocalNarrativeVoicing(false);
    setLocalModelTier(p.modelTier);
    setLocalMultiProvider(false);
    setLocalExcludedBackends(new Set());
    setLocalUseCustomModel(false);
    setLocalCustomModel(globalModel);
    setLocalExcludeGreatestHits(false);
    setLocalTitleOverride('');
    setLocalBackground(''); setLocalSeatTags({});
  };

  const handleSaveAsPreset = (name: string) => {
    onSaveAsPreset(name, buildApply());
    setShowSaveModal(false);
  };

  const localSeatTagIssue = [...localSelected]
    .map(id => seatTagRefusal(useTaxonomyStore.getState()[id as 'accelerationist' | 'safetyist' | 'skeptic']?.nodes ?? [], localSeatTags[id]))
    .find(Boolean);
  const canApply = localSelected.size >= 1 && !localSeatTagIssue;
  const isSocratic = localProtocolId === 'socratic';
  return (
    <div className="ndd-settings-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="ndd-settings-dialog"
        role="dialog"
        aria-modal
        aria-labelledby="ndd-settings-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="ndd-settings-header">
          <h2 className="ndd-settings-title" id="ndd-settings-title">Debate settings</h2>
          <button type="button" className="ndd-close-btn" onClick={onClose} aria-label="Close settings">&times;</button>
        </div>

        <div className="ndd-settings-layout">
          <nav className={`ndd-settings-nav${isMobile && mobileSubView !== null ? ' ndd-hidden' : ''}`} aria-label="Settings sections">
            {SETTINGS_SECTIONS.map(s => (
              <button
                key={s.id}
                type="button"
                className={`ndd-settings-nav-item${activeSection === s.id && !isMobile ? ' active' : ''}`}
                onClick={() => { setActiveSection(s.id); if (isMobile) setMobileSubView(s.id); }}
              >
                {s.label}
                {sectionHasDiff(s.id, basePreset, currentSettings) && (
                  <span className="ndd-nav-dot" aria-label="modified" />
                )}
              </button>
            ))}
          </nav>

          <div className={`ndd-settings-body${isMobile && mobileSubView === null ? ' ndd-hidden' : ''}`}>
            {isMobile && mobileSubView !== null && (
              <button type="button" className="ndd-mobile-back-btn" onClick={() => setMobileSubView(null)} aria-label="Back to sections">
                ← Back
              </button>
            )}
            {renderSettingsSection({
              activeSection,
              formatProps: { localProtocolId, setLocalProtocolId, localStyle, setLocalStyle, localConfrontation, setLocalConfrontation, localArgumentation, setLocalArgumentation, localConcluding, setLocalConcluding, localStepMode, setLocalStepMode, localNarrativeVoicing, setLocalNarrativeVoicing },
              voicesProps: { isSocratic, localSelected, setLocalSelected, toggleDebater, localSeatTags, setLocalSeatTags, povTagRegistry, localUserIsPover, setLocalUserIsPover, localAudience, setLocalAudience, localSeatTagIssue },
              modelProps: { localModelTier, setLocalModelTier, localMultiProvider, setLocalMultiProvider, backendsWithKeys, localExcludedBackends, toggleBackend, hasApiKey, localUseCustomModel, setLocalUseCustomModel, localCustomModel, setLocalCustomModel, localCustomFamily, setLocalCustomFamily, globalModel, refreshing, setRefreshing },
              sourcingProps: { localExcludeGreatestHits, setLocalExcludeGreatestHits },
              materialProps: { localTitleOverride, setLocalTitleOverride, localBackground, setLocalBackground },
            })}
          </div>
        </div>

        <div className="ndd-settings-footer">
          <button type="button" className="btn ndd-reset-btn" onClick={handleReset}>Reset to preset</button>
          <button type="button" className="btn ndd-save-preset-btn" onClick={() => setShowSaveModal(true)}>Save as preset…</button>
          <div className="ndd-settings-footer-right">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canApply}
              onClick={() => onApply(buildApply())}
            >
              Apply
            </button>
          </div>
        </div>
      </div>

      {showSaveModal && (
        <SaveAsPresetModal onSave={handleSaveAsPreset} onCancel={() => setShowSaveModal(false)} />
      )}
    </div>
  );
}

// ── handleStart helpers (local/complexity-budget t/3821) ─────────────────────

function validateDebateStart(
  canStart: boolean,
  creating: boolean,
  isAnonymous: boolean,
  activeAdder: 'none' | 'background' | 'source',
  sourceType: DebateSourceType,
): 'blocked' | 'sign-in' | null {
  if (!canStart || creating) return 'blocked';
  if (isAnonymous && activeAdder === 'source' && sourceType === 'url') return 'sign-in';
  return null;
}

async function resolveFinalTopic(
  activeAdder: 'none' | 'background' | 'source',
  sourceType: DebateSourceType,
  sourceRef: string,
  fileName: string,
  sourceContent: string,
  topic: string,
): Promise<{ finalTopic: string; finalContent: string }> {
  let finalTopic = topic.trim();
  let finalContent = sourceContent;
  if (activeAdder === 'source' && sourceType === 'url') {
    if (!finalTopic) finalTopic = `Discuss: ${sourceRef.trim()}`;
    finalContent = await fetchDebateUrlContent(sourceRef);
  }
  if (activeAdder === 'source' && sourceType === 'document' && !finalTopic) {
    finalTopic = `Discuss: ${fileName}`;
  }
  return { finalTopic, finalContent };
}

function resolvePoversAndModels(
  selected: Set<SpeakerId>,
  userIsPover: boolean,
  multiProvider: boolean,
  modelTier: 'basic' | 'advanced',
  activeBackends: string[],
): { povers: SpeakerId[]; speakerModels?: Record<string, string>; eligibleBackends?: string[] } | typeof RESOLVE_FAILED {
  const povers = Array.from(selected);
  if (userIsPover && !povers.includes('user')) povers.push('user');
  if (!multiProvider) return { povers };
  const resolved = resolveDebateSpeakerModels(modelTier, activeBackends, povers);
  if (resolved === RESOLVE_FAILED) return RESOLVE_FAILED;
  return { povers, speakerModels: resolved.speakerModels, eligibleBackends: resolved.eligibleBackends };
}

// ── DebateBodyContent — body of Screen A (local/complexity-budget t/3821) ────

interface DebateBodyContentProps {
  topic: string; setTopic: (v: string) => void;
  activeAdder: 'none' | 'background' | 'source'; setActiveAdder: (v: 'none' | 'background' | 'source') => void;
  sourceType: DebateSourceType; setSourceType: (v: DebateSourceType) => void;
  sourceRef: string; setSourceRef: (v: string) => void;
  fileName: string;
  isAnonymous: boolean;
  background: string; setBackground: (v: string) => void;
  selected: Set<SpeakerId>; userIsPover: boolean;
  seatTags: Partial<Record<SpeakerId, SeatTag>>; povTagRegistry: ReturnType<typeof registryOrNull>;
  audience: DebateAudience; handleAudienceChange: (v: DebateAudience) => void;
  basePreset: BuiltInPresetId; isCustom: boolean; handlePresetSelect: (id: BuiltInPresetId) => void;
  openSettings: (section: SettingsSection) => void;
  handlePickFile: () => void; handleRevertToTopic: () => void;
}
function DebateBodyContent({ topic, setTopic, activeAdder, setActiveAdder, sourceType, setSourceType, sourceRef, setSourceRef, fileName, isAnonymous, background, setBackground, selected, userIsPover, seatTags, povTagRegistry, audience, handleAudienceChange, basePreset, isCustom, handlePresetSelect, openSettings, handlePickFile, handleRevertToTopic }: DebateBodyContentProps) {
  return (
    <div className="ndd-dialog-body">
      {activeAdder !== 'source' ? (
        <>
          <label className="ndd-field-label" htmlFor="ndd-topic">
            Topic <span className="ndd-required-mark" aria-hidden="true">*</span>
          </label>
          <AutoGrowTextarea id="ndd-topic" className="ndd-topic-primary" value={topic} onChange={e => setTopic(e.target.value)} rows={3} maxHeight={144} placeholder="What should the AI debate?" autoFocus aria-required="true" />
          <div className="ndd-source-links" role="group" aria-labelledby="ndd-source-links-hint">
            <span id="ndd-source-links-hint" className="ndd-source-links-hint">Or debate a source instead of a topic:</span>
            <button type="button" className="ndd-source-link" onClick={() => { setSourceType('document'); setActiveAdder('source'); }}>Attach a document</button>
            <button type="button" className="ndd-source-link"
              aria-disabled={isAnonymous || undefined}
              aria-describedby={isAnonymous ? 'ndd-url-signin-note' : undefined}
              onClick={() => { if (isAnonymous) return; setSourceType('url'); setActiveAdder('source'); }}>Use a URL</button>
            {isAnonymous && <span id="ndd-url-signin-note" className="ndd-source-links-note">(sign in to use URLs)</span>}
          </div>
        </>
      ) : (
        <>
          <label className="ndd-field-label">Source (replaces the topic)</label>
          <div className="ndd-adder-content">
            <div className="ndd-source-type-tabs">
              <button type="button" className={`ndd-source-tab${sourceType === 'document' ? ' active' : ''}`} onClick={() => setSourceType('document')}>Document</button>
              <button type="button" className={`ndd-source-tab${sourceType === 'url' ? ' active' : ''}`} onClick={() => !isAnonymous && setSourceType('url')} disabled={isAnonymous} title={isAnonymous ? 'Sign in to use URL sources' : undefined}>URL</button>
            </div>
            <p className="ndd-settings-field-hint">{sourceType === 'document' ? 'The debaters will argue over what this document claims.' : 'The debaters will argue over what this page claims.'}</p>
            {isAnonymous && (
              <p className="ndd-warning-text">
                URL fetching requires sign-in.{' '}
                <a href="/api/auth/fresh-login/github">Sign in with GitHub</a>{' or '}<a href="/api/auth/fresh-login/google">Google</a>.
              </p>
            )}
            {sourceType === 'document' && (
              <div className="ndd-file-pick-row">
                <button type="button" className="btn btn-sm" onClick={handlePickFile}>Pick file…</button>
                {fileName && <span className="ndd-file-name">{fileName}</span>}
              </div>
            )}
            {sourceType === 'url' && (
              <input type="url" className="ndd-input" value={sourceRef}
                onChange={e => { setSourceRef(e.target.value); if (!e.target.value) handleRevertToTopic(); }}
                onBlur={() => { if (!sourceRef.trim()) handleRevertToTopic(); }}
                placeholder="https://…" autoFocus />
            )}
            <button type="button" className="ndd-adder-collapse" onClick={handleRevertToTopic}>← Use topic instead</button>
          </div>
        </>
      )}

      <PresetCards basePreset={basePreset} isCustom={isCustom} onSelect={handlePresetSelect} />

      <div className="ndd-field-row">
        <label className="ndd-field-label ndd-audience-label" htmlFor="ndd-audience">Written for</label>
        <select id="ndd-audience" className="ndd-input ndd-audience-select" value={audience} onChange={e => handleAudienceChange(e.target.value as DebateAudience)}>
          {DEBATE_AUDIENCES.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
      </div>

      <div className="ndd-voices-row">
        <div className="ndd-debater-chips" role="list" aria-label="Selected debaters">
          {AI_POVERS.filter(id => selected.has(id)).map(id => {
            const camp = povToCamp(id);
            const tagLabel = seatTagLabel(id, seatTags[id], povTagRegistry);
            return (
              <span key={id} className="ndd-debater-chip" data-camp={camp} role="listitem">
                <span className="ndd-debater-chip-icon" aria-hidden="true"><CampGlyph camp={camp!} size={12} /></span>
                {POVER_INFO[id].label}{tagLabel && ` · ${tagLabel}`}
              </span>
            );
          })}
          {userIsPover && <span className="ndd-debater-chip ndd-debater-chip--user" role="listitem">👤 You</span>}
        </div>
        <button type="button" className="ndd-change-voices-btn" onClick={() => openSettings('voices')}>Change voices</button>
      </div>

      <div className="ndd-adders">
        {activeAdder !== 'background' ? (
          <button type="button" className="ndd-adder-btn" onClick={() => setActiveAdder('background')}>+ Add background context</button>
        ) : (
          <div className="ndd-adder-content">
            <label className="ndd-field-label" htmlFor="ndd-background">Background context</label>
            <AutoGrowTextarea id="ndd-background" className="ndd-adder-textarea" value={background}
              onChange={e => setBackground(e.target.value)}
              onBlur={() => { if (!background.trim()) setActiveAdder('none'); }}
              rows={3} placeholder="Additional context for the debaters…" autoFocus />
            {background && (
              <button type="button" className="ndd-adder-collapse" onClick={() => { setBackground(''); setActiveAdder('none'); }}>Remove</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface DebateStartHintProps {
  multiProvider: boolean;
  activeModelExcluded: boolean;
}
function DebateStartHint({ multiProvider, activeModelExcluded }: DebateStartHintProps) {
  if (multiProvider) {
    return <p className="ndd-start-hint" role="status">Select at least 2 active backends with an API key for multi-provider mode.</p>;
  }
  if (activeModelExcluded) {
    return <p className="ndd-start-hint" role="status">This model is not supported for debates — pick a different model.</p>;
  }
  return <p className="ndd-start-hint" role="status">No API key for this model — <button type="button" className="ndd-start-hint-link" onClick={() => useSettingsDialog.getState().open('apiKeys')}>add one in Settings</button></p>;
}

// ── Main dialog ───────────────────────────────────────────────────────────────

export function NewDebateDialog({ onClose, onAtCap, initialTopic, initialPovers }: NewDebateDialogProps) {
  const { createDebate, loadDebate } = useDebateStore(
    useShallow(s => ({ createDebate: s.createDebate, loadDebate: s.loadDebate }))
  );
  const seed = seedTopicAndPovers(initialTopic, initialPovers);

  // Topic / source
  const [topic, setTopic] = useState(seed.topic);
  const [background, setBackground] = useState('');
  const [sourceType, setSourceType] = useState<DebateSourceType>('topic');
  const [sourceRef, setSourceRef] = useState('');
  const [sourceContent, setSourceContent] = useState('');
  const [fileName, setFileName] = useState('');
  const [activeAdder, setActiveAdder] = useState<'none' | 'background' | 'source'>('none');

  // Debaters
  const [selected, setSelected] = useState<Set<SpeakerId>>(seed.povers);
  const [userIsPover, setUserIsPover] = useState(false);
  const [seatTags, setSeatTags] = useState<Partial<Record<SpeakerId, SeatTag>>>({});
  const povTagRegistry = registryOrNull();

  // Audience — persisted to localStorage
  const [audience, setAudience] = useState<DebateAudience>(() =>
    (localStorage.getItem(LS_LAST_AUDIENCE) as DebateAudience | null) ?? 'policymakers'
  );

  // Preset system
  const [basePreset, setBasePreset] = useState<BuiltInPresetId>('quick');
  const [protocolId, setProtocolId] = useState(PRESET_DEFAULTS.quick.protocolId);
  const [dialecticalStyle, setDialecticalStyle] = useState<DialecticalStyle>(PRESET_DEFAULTS.quick.dialecticalStyle);
  const [confrontationRounds, setConfrontationRounds] = useState(PRESET_DEFAULTS.quick.confrontationRounds);
  const [argumentationRounds, setArgumentationRounds] = useState(PRESET_DEFAULTS.quick.argumentationRounds);
  const [concludingRounds, setConcludingRounds] = useState(PRESET_DEFAULTS.quick.concludingRounds);
  const [stepMode, setStepMode] = useState(PRESET_DEFAULTS.quick.stepMode);
  const [modelTier, setModelTier] = useState<'basic' | 'advanced'>(PRESET_DEFAULTS.quick.modelTier);

  // Settings managed via Screen B
  const temperature = 0.7;
  const evaluatorModel = '';
  const [multiProvider, setMultiProvider] = useState(false);
  const [excludedBackends, setExcludedBackends] = useState<Set<string>>(new Set());
  const [excludeGreatestHits, setExcludeGreatestHits] = useState(false);
  const [narrativeVoicing, setNarrativeVoicing] = useState(false);
  const stageModels: { brief: string; plan: string; cite: string } = { brief: '', plan: '', cite: '' };
  const [titleOverride, setTitleOverride] = useState('');

  // Model (global default; override via Screen B)
  const { geminiModel } = useTaxonomyStore();
  const globalModel = geminiModel;
  const [useCustomModel, setUseCustomModel] = useState(false);
  const [customModel, setCustomModel] = useState<string>(globalModel);

  // API key / tier (needed for canStart)
  const [hasApiKey, setHasApiKey] = useState<Record<string, boolean>>({});
  const [availableBackends, setAvailableBackends] = useState<Set<string>>(new Set());
  const { tier: tierInfo } = useTierInfo();
  const freeTier = isFreeTier(tierInfo);
  const auth = useAuthStatus();
  const isAnonymous = auth?.anonymous === true;
  const userProfile = useUserProfile();
  const { modalProps: geminiModalProps, checkAndShow: checkGeminiOnboarding } = useGeminiOnboarding();

  // Queue (overflow menu)
  const [queuedTopics, setQueuedTopics] = useState<{ text: string; sourceType: DebateSourceType; sourceRef: string; timestamp: string }[]>(() => {
    try { const raw = localStorage.getItem(LS_TOPIC_QUEUE); return raw ? JSON.parse(raw) : []; } catch { /* telemetry — silent by design */ return []; }
  });

  // UI state
  const [creating, setCreating] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [titleAnnouncement, setTitleAnnouncement] = useState('');
  const [showOverflow, setShowOverflow] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('voices');

  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, !showSettings);

  // Restore focus to triggering element on close
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => { prev?.focus(); };
  }, []);

  useEffect(() => {
    void Promise.all(
      AI_BACKENDS.map(async (b) => {
        const has = await api.hasApiKey(b.value);
        return [b.value, has] as [string, boolean];
      }),
    ).then(results => setHasApiKey(Object.fromEntries(results)))
      .catch((err) => { getGlobalRecorder()?.record({ type: 'system.error', component: 'new-debate-dialog', level: 'warn', message: 'hasApiKey check failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); });

    void api.getAvailableBackends()
      .then(backends => setAvailableBackends(new Set(backends.filter(b => b.available).map(b => b.id))))
      .catch((err) => { getGlobalRecorder()?.record({ type: 'system.error', component: 'new-debate-dialog', level: 'error', message: 'Failed to load available AI backends', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); });
  }, []);

  const backendsWithKeys = useMemo(
    () => [...availableBackends].filter(b => !DEBATE_EXCLUDED_BACKENDS.has(b)),
    [availableBackends],
  );
  const activeBackends = useMemo(
    () => backendsWithKeys.filter(b => !excludedBackends.has(b)),
    [backendsWithKeys, excludedBackends],
  );

  const activeModel = computeActiveModel(freeTier, tierInfo, useCustomModel, customModel, globalModel);
  const activeModelBackend = backendForModelWithFallback(activeModel);
  const activeModelExcluded = DEBATE_EXCLUDED_BACKENDS.has(activeModelBackend);
  const activeModelHasKey = computeActiveModelHasKey(activeModelExcluded, hasApiKey, activeModelBackend, freeTier, tierInfo);

  // fallbackWarnings — computed but consumed by Screen B (t/2201); suppress lint
  const fallbackWarnings = useMemo(() => {
    const chain = FALLBACK_CHAINS[activeModel] ?? [];
    return chain.map(m => ({ model: m, backend: backendForModelWithFallback(m) })).filter(({ backend }) => hasApiKey[backend] === false).map(({ model, backend }) => `${model} (${backend})`);
  }, [activeModel, hasApiKey]);
  void fallbackWarnings;

  const settingsDiff = countSettingsDiff(basePreset, protocolId, dialecticalStyle, confrontationRounds, argumentationRounds, concludingRounds, stepMode, modelTier);
  const isCustom = settingsDiff > 0;
  const diffCount = settingsDiff;

  const hasSource = useMemo(() => {
    if (activeAdder === 'source') {
      return sourceType === 'document' ? sourceContent.length > 0 : sourceRef.trim().length > 0;
    }
    return topic.trim().length > 0;
  }, [activeAdder, sourceType, sourceContent, sourceRef, topic]);

  const seatTagIssue = AI_POVERS.map(id => seatTagRefusal(useTaxonomyStore.getState()[id]?.nodes ?? [], seatTags[id])).find(Boolean);
  const canStart = computeCanStart(hasSource, selected.size, multiProvider, activeBackends.length, activeModelHasKey, seatTagIssue);

  const handlePresetSelect = (id: BuiltInPresetId) => {
    setBasePreset(id);
    const p = PRESET_DEFAULTS[id];
    setProtocolId(p.protocolId);
    setDialecticalStyle(p.dialecticalStyle);
    setConfrontationRounds(p.confrontationRounds);
    setArgumentationRounds(p.argumentationRounds);
    setConcludingRounds(p.concludingRounds);
    setStepMode(p.stepMode);
    setModelTier(p.modelTier);
    if (id === 'socratic') { setSelected(new Set([AI_POVERS[0]])); setUserIsPover(false); }
  };

  const handleAudienceChange = (val: DebateAudience) => {
    setAudience(val);
    localStorage.setItem(LS_LAST_AUDIENCE, val);
  };

  const handlePickFile = async () => {
    const result = await api.pickDocumentFile();
    if (result.cancelled || !result.filePath || !result.content) return;
    setSourceRef(result.filePath);
    setSourceContent(result.content);
    setFileName(result.filePath.split('/').pop() || result.filePath);
    if (!topic) setTopic(`Discuss: ${result.filePath.split('/').pop()?.replace(/\.[^.]+$/, '') || ''}`);
  };

  const handleRevertToTopic = () => {
    setSourceType('topic');
    setSourceRef('');
    setSourceContent('');
    setFileName('');
    setActiveAdder('none');
  };

  const persistQueue = (next: typeof queuedTopics) => {
    setQueuedTopics(next);
    localStorage.setItem(LS_TOPIC_QUEUE, JSON.stringify(next));
  };

  const handleQueueTopic = () => {
    const text = activeAdder === 'source' ? (sourceRef.trim() || sourceContent.slice(0, 200)) : topic.trim();
    if (!text) return;
    persistQueue([...queuedTopics, { text, sourceType: activeAdder === 'source' ? sourceType : 'topic', sourceRef: activeAdder === 'source' ? sourceRef.trim() : '', timestamp: new Date().toISOString() }]);
    setShowOverflow(false);
    onClose();
  };

  const openSettings = (section: SettingsSection = 'format') => {
    setSettingsSection(section);
    setShowSettings(true);
  };

  const handleSettingsApply = (changes: SettingsApply) => {
    setSelected(changes.selected);
    setUserIsPover(changes.userIsPover);
    handleAudienceChange(changes.audience);
    setProtocolId(changes.protocolId);
    setDialecticalStyle(changes.dialecticalStyle);
    setConfrontationRounds(changes.confrontationRounds);
    setArgumentationRounds(changes.argumentationRounds);
    setConcludingRounds(changes.concludingRounds);
    setStepMode(changes.stepMode);
    setNarrativeVoicing(changes.narrativeVoicing);
    setModelTier(changes.modelTier);
    setMultiProvider(changes.multiProvider);
    setExcludedBackends(changes.excludedBackends);
    setExcludeGreatestHits(changes.excludeGreatestHits);
    setUseCustomModel(changes.useCustomModel);
    setCustomModel(changes.customModel);
    setTitleOverride(changes.titleOverride);
    setBackground(changes.background); setSeatTags(changes.seatTags);
    setShowSettings(false);
  };

  const handleSaveAsPreset = (name: string, settings: SettingsApply) => {
    try {
      const raw = localStorage.getItem(LS_CUSTOM_PRESETS);
      const existing: { name: string; settings: Record<string, unknown>; basePreset: string }[] = raw ? JSON.parse(raw) : [];
      const entry = {
        name,
        basePreset,
        settings: {
          ...settings,
          selected: [...settings.selected],
          excludedBackends: [...settings.excludedBackends],
        },
      };
      const idx = existing.findIndex(p => p.name === name);
      if (idx >= 0) existing[idx] = entry; else existing.push(entry);
      localStorage.setItem(LS_CUSTOM_PRESETS, JSON.stringify(existing));
    } catch { /* telemetry — silent by design */ }
    setShowSettings(false);
  };

  const handleStart = async () => {
    const guard = validateDebateStart(canStart, creating, isAnonymous, activeAdder, sourceType);
    if (guard === 'blocked') return;
    if (guard === 'sign-in') { setStartError('Sign in to use URL sources.'); return; }
    await checkGeminiOnboarding({ freeTier, geminiAllowlisted: userProfile?.geminiAllowlisted });
    setCreating(true);
    setStartError(null);

    try {
      const { finalTopic, finalContent } = await resolveFinalTopic(activeAdder, sourceType, sourceRef, fileName, sourceContent, topic);
      const resolved = resolvePoversAndModels(selected, userIsPover, multiProvider, modelTier, activeBackends);
      if (resolved === RESOLVE_FAILED) { setCreating(false); return; }
      const { povers, speakerModels, eligibleBackends } = resolved;
      const effectiveModel = useCustomModel ? customModel : globalModel;
      const debateModelOverride = computeDebateModelOverride(multiProvider, useCustomModel, customModel);
      const { sourceTypeArg, sourceRefArg, contentArg } = buildDebateSourceArgs(activeAdder === 'source' ? sourceType : 'topic', sourceRef, finalContent);

      const id = await createDebate(
        finalTopic, povers, userIsPover, sourceTypeArg, sourceRefArg, contentArg,
        debateModelOverride, protocolId, temperature, audience,
        buildDebateOptions({ debateTitle: titleOverride, background, evaluatorModel, confrontationRounds, argumentationRounds, concludingRounds, speakerModels, eligibleBackends, multiProvider, modelTier, stepMode, excludeGreatestHits, narrativeVoicing, stageModels, seatTags }),
      );
      await loadDebate(id);
      const creationWeights = buildCreationWeights(confrontationRounds, argumentationRounds, concludingRounds);
      getGlobalRecorder()?.record({ type: 'user.action', component: 'new-debate', level: 'info', message: 'debate.created', data: buildDebateCreatedData({ id, sourceType: sourceTypeArg, povers, userIsPover, effectiveModel, protocolId, temperature, audience, stepMode, multiProvider, modelTier, speakerModels, stageModels, creationWeights }) });
      const store = useDebateStore.getState();
      store.updatePhase('clarification');
      await store.saveDebate('NewDebateDialog:create');
      const popoutResult = await api.openDebateWindow(id).catch((err: Error) => {
        getGlobalRecorder()?.record({ type: 'system.error', component: 'new-debate-dialog', level: 'warn', message: 'Failed to open debate popout window', error: { name: err.name ?? 'Error', message: String(err), stack: err.stack } });
        return undefined;
      });
      if (popoutResult?.atCap) onAtCap?.();

      // Generate title via model call (Q5 resolved); announce for screen readers
      try {
        const generatedTitle = await generateDebateTitle(finalTopic);
        setTitleAnnouncement(`Debate titled: ${generatedTitle}`);
      } catch { /* telemetry — silent by design */ }

      onClose();
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'new-debate-dialog', level: 'error', message: 'Failed to create debate', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      setStartError(err instanceof Error ? err.message : 'Failed to start debate. Please try again.');
      setCreating(false);
    }
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      {/* Screen A — 560 px single-column dialog (t/2199) */}
      <div
        ref={dialogRef}
        className="ndd-dialog"
        role="dialog"
        aria-modal
        aria-labelledby="ndd-dialog-title"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="ndd-dialog-header">
          <h2 className="ndd-dialog-title" id="ndd-dialog-title">New debate</h2>
          <button type="button" className="ndd-close-btn" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        {/* Body — t/2199, t/2200 */}
        <DebateBodyContent
          topic={topic} setTopic={setTopic}
          activeAdder={activeAdder} setActiveAdder={setActiveAdder}
          sourceType={sourceType} setSourceType={setSourceType}
          sourceRef={sourceRef} setSourceRef={setSourceRef}
          fileName={fileName} isAnonymous={isAnonymous}
          background={background} setBackground={setBackground}
          selected={selected} userIsPover={userIsPover}
          seatTags={seatTags} povTagRegistry={povTagRegistry}
          audience={audience} handleAudienceChange={handleAudienceChange}
          basePreset={basePreset} isCustom={isCustom} handlePresetSelect={handlePresetSelect}
          openSettings={openSettings}
          handlePickFile={handlePickFile} handleRevertToTopic={handleRevertToTopic}
        />

        {/* Footer */}
        <div className="ndd-dialog-footer">
          {startError && (
            <div className="ndd-start-error" role="alert">
              {startError}
              <button type="button" className="ndd-retry-link" onClick={handleStart}>Retry</button>
            </div>
          )}{renderSeatTagIssueBanner(startError, seatTagIssue, 'ndd-start-error')}
          <div className="ndd-footer-actions">
            <button
              type="button"
              className="ndd-advanced-link"
              onClick={() => openSettings('format')}
            >
              Advanced settings
              {diffCount > 0 && (
                <span className="ndd-change-badge" aria-label={`${diffCount} setting${diffCount > 1 ? 's' : ''} changed`}>
                  {diffCount}
                </span>
              )}
            </button>

            <div className="ndd-footer-right">
              <button type="button" className="btn ndd-cancel-btn" onClick={onClose}>Cancel</button>

              <div className="ndd-start-group">
                <button
                  type="button"
                  className="btn btn-primary ndd-start-btn"
                  onClick={handleStart}
                  disabled={!canStart || creating}
                  title={!hasSource ? 'Enter a topic to start' : activeModelExcluded ? 'This model is not supported for debates' : !activeModelHasKey ? 'No API key configured' : undefined}
                >
                  {creating ? 'Starting…' : 'Start debate'}
                </button>
                <button
                  type="button"
                  className="btn btn-primary ndd-start-overflow-btn"
                  aria-label="More options"
                  aria-expanded={showOverflow}
                  onClick={() => setShowOverflow(v => !v)}
                  disabled={creating}
                >
                  ▾
                </button>
                {showOverflow && (
                  <div className="ndd-overflow-menu" role="menu">
                    <button
                      type="button"
                      className="ndd-overflow-item"
                      role="menuitem"
                      onClick={handleQueueTopic}
                      disabled={!hasSource}
                    >
                      Queue topic
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
          {!canStart && !creating && hasSource && selected.size >= 1 && (
            <DebateStartHint multiProvider={multiProvider} activeModelExcluded={activeModelExcluded} />
          )}
        </div>
      </div>

      {/* Screen B — full settings dialog */}
      {showSettings && (
        <DebateSettingsDialog
          initialSection={settingsSection}
          basePreset={basePreset}
          selected={selected} seatTags={seatTags}
          userIsPover={userIsPover}
          audience={audience}
          protocolId={protocolId}
          dialecticalStyle={dialecticalStyle}
          confrontationRounds={confrontationRounds}
          argumentationRounds={argumentationRounds}
          concludingRounds={concludingRounds}
          stepMode={stepMode}
          modelTier={modelTier}
          multiProvider={multiProvider}
          excludedBackends={excludedBackends}
          useCustomModel={useCustomModel}
          customModel={customModel}
          globalModel={globalModel}
          backendsWithKeys={backendsWithKeys}
          hasApiKey={hasApiKey}
          excludeGreatestHits={excludeGreatestHits}
          narrativeVoicing={narrativeVoicing}
          titleOverride={titleOverride}
          background={background}
          onApply={handleSettingsApply}
          onClose={() => setShowSettings(false)}
          onSaveAsPreset={handleSaveAsPreset}
        />
      )}

      <GeminiOnboardingModal {...geminiModalProps} />

      {/* Announced for screen readers after title generation */}
      <div aria-live="polite" className="sr-only">{titleAnnouncement}</div>
    </div>
  );
}
