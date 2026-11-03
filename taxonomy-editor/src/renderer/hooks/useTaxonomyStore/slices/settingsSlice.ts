// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { StateCreator } from 'zustand';
import { setLiveModelRegistry } from '../../useDebateStore/shared/sessionFingerprint';
import type { TaxonomyStore } from '../types';
import { api } from '@bridge';
import { DEFAULT_MODEL } from '@lib/ai-client/defaults';
import type { ModelRegistry } from '@lib/ai-client/registry';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { reportRetiredModel } from '../../../utils/retiredModelNotice';
import { applyThemeToRoot, getStoredTheme, THEME_STORAGE_KEY } from '../../../utils/theme';
// t/3517: real (not type-only) import — the bundled snapshot becomes MODELS_BY_BACKEND/
// AI_BACKENDS/DEFAULT_MODELS' pre-load fallback via deriveModelsByBackend/deriveBackends
// below, instead of hand-duplicating ai-models.json's content as source literals.
import aiModelsRegistry from '../../../../../../ai-models.json';
import type { AIModel } from './generatedAIModelIds';
export type { AIModel };

/**
 * Default Community Library server — the Azure Container Apps production deployment.
 * Used as the fallback when no URL is stored, so "Share to Community" works out of
 * the box in the desktop build. Still overridable via Settings → Community Server URL.
 * Only affects Electron; the web build posts same-origin (see getCommunityBaseUrl).
 */
const DEFAULT_COMMUNITY_SERVER_URL = 'https://taxonomy-editor.yellowbush-aeda037d.eastus.azurecontainerapps.io';

// -- Exported types --

export type ColorScheme = 'light' | 'dark' | 'bkc' | 'harvard' | 'system';

export type AIBackend = 'gemini' | 'claude' | 'groq' | 'openai' | 'deepseek' | 'azure' | 'ollama' | 'zai' | 'moonshot' | 'xai';

// t/3517: moved above MODELS_BY_BACKEND/AI_BACKENDS — deriveModelsByBackend's keyspace union
// (below) now reads this instead of Object.keys(MODELS_BY_BACKEND), since MODELS_BY_BACKEND
// is itself computed by calling deriveModelsByBackend (a self-reference/TDZ error otherwise).
const KNOWN_BACKENDS: ReadonlySet<AIBackend> = new Set(['gemini', 'claude', 'groq', 'openai', 'deepseek', 'azure', 'ollama', 'zai', 'moonshot', 'xai']);

// t/3517: the per-backend unions (GeminiModel/ClaudeModel/...) and their AIModel composition
// used to live here, hand-maintained. AIModel is now generated from ai-models.json's actual
// model ids (see generatedAIModelIds.ts + scripts/generate-ai-model-union.cjs) — a direct
// `typeof import('ai-models.json')` type derivation was tried first and rejected: TS widens
// JSON-module string fields to `string`, which silently deletes typo protection while
// appearing to work (verified empirically, t/3517#3). None of the per-backend union names
// were consumed outside this file (confirmed via repo-wide grep before deletion).
// (Merge note: origin/main independently hand-patched ClaudeModel with the same opus-5/
// sonnet-5/fable-5 ids this ticket exists to stop needing — superseded by the generated
// union, which already includes them since they're in ai-models.json's models[].)

export interface AIModelEntry { value: AIModel; label: string }

// -- Exported constants --

// t/3517: pre-load fallback, now SOURCED from the bundled ai-models.json snapshot (via
// deriveBackends) instead of hand-duplicated as a literal — at runtime initAIModels()
// still replaces this with deriveBackends(the LIVE config from api.loadAIModels()), so
// an on-disk edit ops make post-build is picked up exactly as before. Membership, order,
// and labels all follow config.backends (SSOT).
// The bundled JSON has fields (apiModelId, local, debateTiers._comment, ...) the minimal
// AIModelsConfig shape below doesn't declare — that's fine, the derive functions only read
// backends/models/defaults, but it means the structural cast needs the `unknown` bridge.
const preloadConfig = aiModelsRegistry as unknown as AIModelsConfig;

export const AI_BACKENDS: { value: AIBackend; label: string }[] =
  deriveBackends(preloadConfig);

// t/3517: SOURCED from the bundled ai-models.json snapshot via deriveModelsByBackend —
// was a ~70-line hand-maintained literal kept in sync by a byte-identical parity test;
// now the two are the same computation over the same data by construction. (Merge note:
// origin/main independently hand-curated claude-opus-5/sonnet-5/fable-5 picker labels here
// — superseded; the same labels come from ai-models.json's picker.label field now.)
export const MODELS_BY_BACKEND: Record<AIBackend, AIModelEntry[]> =
  deriveModelsByBackend(preloadConfig);

/** @deprecated Use MODELS_BY_BACKEND.gemini instead */
export const GEMINI_MODELS = MODELS_BY_BACKEND.gemini;

const ALL_MODEL_IDS: Set<string> = new Set(
  Object.values(MODELS_BY_BACKEND).flat().map(m => m.value),
);

// t/3517: SOURCED from ai-models.json's `defaults` map instead of hand-listed per backend —
// same drift class as AI_BACKENDS/MODELS_BY_BACKEND, just without a prior parity test.
// initAIModels() still overwrites per-key from the LIVE config at runtime (unchanged).
const DEFAULT_MODELS: Record<AIBackend, AIModel> =
  preloadConfig.defaults as Record<AIBackend, AIModel>;

export let DEBATE_TIERS: Record<string, Record<string, string>> = {};
export let FALLBACK_CHAINS: Record<string, string[]> = {};

// -- Module-level helpers --

export function isKnownBackend(id: string): id is AIBackend {
  return (KNOWN_BACKENDS as ReadonlySet<string>).has(id);
}

// t/4628: set once per session by the anonymous-session check (App.tsx's bootstrapAfterModelsLoaded
// → applyAnonymousSessionDefaults), never read until then (initial state is unaffected — see
// resolveStoredModel/resolveStoredBackend's isAnonymousWeb default below). Suppresses setGeminiModel/
// setAIBackend's localStorage writes for the rest of an anonymous session (ticket's "wanted" #2:
// an in-visit change still works, but doesn't persist across visits) without deleting what's
// already stored (condition t/4628#2 item 3). Resets to false on reload, which sign-in always
// triggers — every sign-in entry point (AnonymousBanner, HamburgerMenu, Toolbar, NewDebateDialog,
// PovTab) is a plain `<a href="/api/auth/fresh-login/...">`, a full browser navigation, never an
// SPA-internal route (confirmed by repo-wide grep before relying on this).
let sessionIsAnonymousWeb = false;

/**
 * t/3286: PURE backend-resolution guard, mirroring resolveStoredModel's shape (same extract-don't-
 * seam discipline, t/2971). t/4628 added the isAnonymousWeb arm as an explicit input — never a
 * hidden global read inside this function — so both arms stay unit-testable without mocking
 * module state.
 */
export function resolveStoredBackend(
  storedBackend: string | null,
  knownBackends: ReadonlySet<AIBackend>,
  isAnonymousWeb = false,
): AIBackend {
  if (!isAnonymousWeb && storedBackend && (knownBackends as ReadonlySet<string>).has(storedBackend)) {
    return storedBackend as AIBackend;
  }
  return 'gemini';
}

/** t/4628: both raw localStorage reads needed by applyAnonymousSessionDefaults, extracted so
 *  that function's own complexity stays under the per-file budget (same extract-don't-seam
 *  discipline as resolveStoredBackend/resolveStoredModel above). */
function readStoredAISelectionRaw(): { storedModel: string | null; storedBackend: string | null } {
  let storedModel: string | null = null;
  let storedBackend: string | null = null;
  try { storedModel = localStorage.getItem('taxonomy-editor-gemini-model'); } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Failed to read stored AI model while applying anonymous-session defaults', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
  }
  try { storedBackend = localStorage.getItem('taxonomy-editor-ai-backend'); } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Failed to read stored AI backend while applying anonymous-session defaults', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
  }
  return { storedModel, storedBackend };
}

/** t/4628 condition 4: WARN only when a stored value is actually being overridden, not on every
 *  anonymous load (a first-ever visit with nothing stored fires nothing here). Extracted
 *  alongside readStoredAISelectionRaw for the same reason. */
function logIgnoredAnonymousSelection(
  storedModel: string | null, targetModel: string,
  storedBackend: string | null, targetBackend: string,
): void {
  const ignoredModel = storedModel && storedModel !== targetModel ? storedModel : null;
  const ignoredBackend = storedBackend && storedBackend !== targetBackend ? storedBackend : null;
  if (!ignoredModel && !ignoredBackend) return;
  getGlobalRecorder()?.record({
    type: 'system.error', component: 'taxonomy-store', level: 'warn',
    message: `Anonymous session: ignoring stored AI selection (model='${ignoredModel ?? 'unchanged'}', backend='${ignoredBackend ?? 'unchanged'}') — using session default`,
    error: { name: 'AnonymousModelOverride', message: 'stored AI selection overridden for an anonymous session', stack: '' },
  });
}

function getStoredBackend(): AIBackend {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem('taxonomy-editor-ai-backend');
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Failed to read stored AI backend from localStorage', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
  }
  return resolveStoredBackend(stored, KNOWN_BACKENDS);
}

/**
 * t/3286: PURE model-resolution guard, extracted from getStoredModel for both-arms testability (TL
 * t/3286#11 — the t/2971 extract-don't-seam discipline). Resolution order: a valid stored id wins;
 * else the backend's default IF it is a real model; else the always-present global default. The final
 * branch is the graceful-empty guard — an empty/misconfigured backend whose default isn't a real id
 * must never strand the UI on a non-model string.
 *
 * t/4628: isAnonymousWeb is an explicit input, defaulting to false so every EXISTING call site
 * (getStoredModel's own synchronous initial read, which can't know anonymity yet) is unaffected.
 * When true, the stored-id branch is skipped entirely — anonymous hosted sessions always resolve
 * to the backend's default (gemini-3.5-flash-lite per #4103), never a stored id.
 */
export function resolveStoredModel(
  storedId: string | null,
  backend: AIBackend,
  defaultModels: Record<AIBackend, AIModel>,
  allModelIds: ReadonlySet<string>,
  globalDefault: AIModel,
  isAnonymousWeb = false,
): AIModel {
  if (!isAnonymousWeb && storedId && allModelIds.has(storedId)) return storedId as AIModel;
  const fallback = defaultModels[backend];
  return allModelIds.has(fallback) ? fallback : globalDefault;
}

export function getStoredModel(): AIModel {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem('taxonomy-editor-gemini-model');
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Failed to read stored AI model from localStorage', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
  }
  const model = resolveStoredModel(stored, getStoredBackend(), DEFAULT_MODELS, ALL_MODEL_IDS, DEFAULT_MODEL);
  // t/4030: a saved id the registry no longer lists falls back silently otherwise (Fallback-Path Logging).
  if (stored && !ALL_MODEL_IDS.has(stored)) reportRetiredModel(stored, model);
  return model;
}

interface AIModelsConfig {
  backends: { id: string; label: string }[];
  models: { id: string; label: string; backend: string; picker?: { label: string; order: number } }[];
  defaults: Record<string, string>;
  debateTiers?: Record<string, Record<string, string>>;
  fallbackChains?: Record<string, string[]>;
}

/**
 * t/3280: DERIVE the renderer model picker from ai-models.json's per-model `picker` field — the single
 * source of truth. A model is selectable iff it carries `picker:{label,order}`; the picker is that
 * curated subset per backend, sorted by `picker.order`, labelled with `picker.label` verbatim (the
 * "(default)" suffix is baked into the config label). Curated-out models (no `picker`) never appear, so
 * phantoms (picker ids with no config entry) are impossible by construction, and a backend with zero
 * selectable models (e.g. deepseek) derives to [] — rendered gracefully; getStoredModel guards the default.
 */
export function deriveModelsByBackend(config: AIModelsConfig): Record<AIBackend, AIModelEntry[]> {
  const buckets: Record<string, { value: AIModel; label: string; order: number }[]> = {};
  for (const m of config.models) {
    if (!m.picker) continue;
    (buckets[m.backend] ??= []).push({ value: m.id as AIModel, label: m.picker.label, order: m.picker.order });
  }
  // t/3328: keyspace = config.backends ∪ known backend keys. Iterating only the known keys would
  // silently drop a backend added to ai-models.json (with picker models) whose key the renderer's
  // KNOWN_BACKENDS allowlist lacks. (t/3517: was Object.keys(MODELS_BY_BACKEND) — now a TDZ hazard,
  // since MODELS_BY_BACKEND's own initializer calls this function.)
  const backends = new Set<AIBackend>([
    ...config.backends.map(b => b.id as AIBackend),
    ...KNOWN_BACKENDS,
  ]);
  const out = {} as Record<AIBackend, AIModelEntry[]>;
  for (const backend of backends) {
    out[backend] = (buckets[backend] ?? []).sort((a, b) => a.order - b.order).map(({ value, label }) => ({ value, label }));
  }
  return out;
}

/**
 * t/3329: DERIVE the selectable-backend list (AI_BACKENDS) from ai-models.json — a backend is offered
 * iff it has ≥1 picker model. Membership, order, and label all come from config.backends (SSOT); the
 * in-source AI_BACKENDS constant is only a pre-load fallback, kept byte-identical by a parity gate.
 * Subsumes the t/3280 deepseek exclusion structurally — a zero-picker backend is simply not emitted.
 */
export function deriveBackends(config: AIModelsConfig): { value: AIBackend; label: string }[] {
  const derived = deriveModelsByBackend(config);
  return config.backends
    .filter(b => (derived[b.id as AIBackend]?.length ?? 0) > 0)
    .map(b => ({ value: b.id as AIBackend, label: b.label }));
}

export async function initAIModels(): Promise<void> {
  try {
    const config = await api.loadAIModels() as AIModelsConfig | null;
    if (!config?.models?.length) return;

    // t/3280/t/3328: derive the picker from the curated `picker` entries (SSOT) — not every config
    // model. Assign over the DERIVED keyspace (config.backends ∪ constant keys) so a new config
    // backend's picker models are applied, not just the constant's keys.
    const derived = deriveModelsByBackend(config);
    for (const key of Object.keys(derived) as AIBackend[]) {
      MODELS_BY_BACKEND[key] = derived[key] ?? [];
    }

    // t/3280/t/3329: a backend is selectable iff it has ≥1 picker model. deriveBackends filters the
    // zero-picker ones (e.g. deepseek) so no dead-end backend strands the model dropdown; membership,
    // order, and label all come from config.backends (SSOT — no hardcoded exclusion).
    AI_BACKENDS.length = 0;
    AI_BACKENDS.push(...deriveBackends(config));

    for (const [k, v] of Object.entries(config.defaults)) {
      DEFAULT_MODELS[k as AIBackend] = v as AIModel;
    }

    ALL_MODEL_IDS.clear();
    for (const m of config.models) ALL_MODEL_IDS.add(m.id);

    if (config.debateTiers) {
      DEBATE_TIERS = config.debateTiers;
    }
    setLiveModelRegistry(config as unknown as ModelRegistry); // t/4044: debate fingerprints use the live registry

    if (config.fallbackChains) {
      FALLBACK_CHAINS = config.fallbackChains;
    }

    console.log(`[AI Models] Loaded ${config.models.length} models from ai-models.json`);
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Failed to load ai-models.json config', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    console.warn('[AI Models] Failed to load ai-models.json, using built-in defaults:', err);
  }
}

export function backendForModel(model: string): AIBackend | undefined {
  if (model.startsWith('gemini')) return 'gemini';
  if (model.startsWith('claude')) return 'claude';
  if (model.startsWith('groq')) return 'groq';
  if (model.startsWith('openai')) return 'openai';
  if (model.startsWith('deepseek')) return 'deepseek';
  if (model.startsWith('azure')) return 'azure';
  if (model.startsWith('ollama')) return 'ollama';
  if (model.startsWith('zai')) return 'zai';
  if (model.startsWith('moonshot')) return 'moonshot';
  if (model.startsWith('xai')) return 'xai';
  return undefined;
}

/** Backend for a model, falling back to the stored backend for unknown ids (debate-dialog family picker).
 *  Records a debug FR event when the fallback fires (t/2486). Do NOT use for the urlContext gate — that must
 *  use backendForModel() directly so unknown models never resolve to 'gemini'. */
export function backendForModelWithFallback(model: string): AIBackend {
  const b = backendForModel(model);
  if (b) return b;
  const fallback = getStoredBackend();
  getGlobalRecorder()?.record({ type: 'ai.fallback', component: 'taxonomy-store', level: 'debug', message: `backendForModel: unknown model '${model}' → fallback backend '${fallback}'`, data: { model, fallbackBackend: fallback } });
  return fallback;
}

// Theme resolution core moved to utils/theme.ts (t/2338) so the popout path
// (usePopoutTheme) and this main-window path share one resolver and can't fork.
// applyTheme here = shared applyThemeToRoot + the main-window-only localStorage persist.
function applyTheme(scheme: ColorScheme) {
  applyThemeToRoot(scheme);
  try { localStorage.setItem(THEME_STORAGE_KEY, scheme); } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Failed to persist theme to localStorage', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
  }
}

// -- Slice interface --

export interface SettingsSlice {
  aiBackend: AIBackend;
  setAIBackend: (backend: AIBackend) => void;
  geminiModel: AIModel;
  setGeminiModel: (model: AIModel) => void;
  /** t/4628: called once after initAIModels() + the anonymous-session check resolve. Pass the
   *  resolved anonymity; the action stays synchronous so it's trivially testable without mocking
   *  the bridge. No-op (and no WARN) when `isAnonymous` is false. */
  applyAnonymousSessionDefaults: (isAnonymous: boolean) => void;

  colorScheme: ColorScheme;
  setColorScheme: (scheme: ColorScheme) => void;

  paneSpacing: 'normal' | 'concise';
  setPaneSpacing: (spacing: 'normal' | 'concise') => void;

  communityServerUrl: string;
  setCommunityServerUrl: (url: string) => void;

  zoomLevel: number;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
}

// -- Slice creator --

export const createSettingsSlice: StateCreator<TaxonomyStore, [], [], SettingsSlice> = (set, get) => ({
  aiBackend: getStoredBackend(),
  setAIBackend: (backend) => {
    const newModel = DEFAULT_MODELS[backend];
    // t/4628: an anonymous session's in-visit switch still works (the set() below always runs)
    // but must not persist across visits — skip the writes, don't touch what's already stored.
    if (!sessionIsAnonymousWeb) {
      try { localStorage.setItem('taxonomy-editor-ai-backend', backend); } catch (err) {
        getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Failed to persist AI backend to localStorage', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      }
      try { localStorage.setItem('taxonomy-editor-gemini-model', newModel); } catch (err) {
        getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Failed to persist AI model to localStorage', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      }
    }
    set({ aiBackend: backend, geminiModel: newModel });
  },
  geminiModel: getStoredModel(),
  setGeminiModel: (model) => {
    if (!sessionIsAnonymousWeb) {
      try { localStorage.setItem('taxonomy-editor-gemini-model', model); } catch (err) {
        getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Failed to persist AI model selection to localStorage', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      }
    }
    set({ geminiModel: model });
  },
  applyAnonymousSessionDefaults: (isAnonymous) => {
    sessionIsAnonymousWeb = isAnonymous;
    if (!isAnonymous) return;

    // t/4628: condition 3 — don't delete what's stored, just ignore it for this session.
    const { storedModel, storedBackend } = readStoredAISelectionRaw();
    const targetBackend = resolveStoredBackend(storedBackend, KNOWN_BACKENDS, true);
    const targetModel = resolveStoredModel(storedModel, targetBackend, DEFAULT_MODELS, ALL_MODEL_IDS, DEFAULT_MODEL, true);
    logIgnoredAnonymousSelection(storedModel, targetModel, storedBackend, targetBackend);
    set({ geminiModel: targetModel, aiBackend: targetBackend });
  },

  colorScheme: getStoredTheme(),
  setColorScheme: (scheme) => {
    applyTheme(scheme);
    set({ colorScheme: scheme });
  },

  paneSpacing: (() => {
    try { return (localStorage.getItem('taxonomy-editor-pane-spacing') as 'normal' | 'concise') || 'normal'; } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Failed to read pane spacing from localStorage', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      return 'normal' as const;
    }
  })(),
  setPaneSpacing: (spacing) => {
    try { localStorage.setItem('taxonomy-editor-pane-spacing', spacing); } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Failed to persist pane spacing to localStorage', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    }
    document.documentElement.setAttribute('data-pane-spacing', spacing);
    set({ paneSpacing: spacing });
  },

  communityServerUrl: (() => {
    try { return localStorage.getItem('taxonomy-editor-community-url') || DEFAULT_COMMUNITY_SERVER_URL; } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Failed to read community server URL from localStorage', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      return DEFAULT_COMMUNITY_SERVER_URL;
    }
  })(),
  setCommunityServerUrl: (url) => {
    try { localStorage.setItem('taxonomy-editor-community-url', url); } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Failed to persist community server URL to localStorage', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    }
    set({ communityServerUrl: url });
  },

  zoomLevel: (() => {
    try {
      const stored = localStorage.getItem('taxonomy-editor-zoom');
      if (stored) {
        const n = parseInt(stored, 10);
        if (n >= 60 && n <= 200) return n;
      }
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Failed to read zoom level from localStorage', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    }
    return 100;
  })(),

  zoomIn: () => {
    const next = Math.min(200, get().zoomLevel + 10);
    try { localStorage.setItem('taxonomy-editor-zoom', String(next)); } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Failed to persist zoom level to localStorage', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    }
    set({ zoomLevel: next });
  },

  zoomOut: () => {
    const next = Math.max(60, get().zoomLevel - 10);
    try { localStorage.setItem('taxonomy-editor-zoom', String(next)); } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Failed to persist zoom level to localStorage', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    }
    set({ zoomLevel: next });
  },

  zoomReset: () => {
    try { localStorage.setItem('taxonomy-editor-zoom', '100'); } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-store', level: 'warn', message: 'Failed to persist zoom reset to localStorage', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    }
    set({ zoomLevel: 100 });
  },
});
