// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// AI backend, model types, and dynamic model catalog — mirrors taxonomy-editor pattern.
import { getGlobalRecorder } from '@lib/flight-recorder/index';

export type AIBackend = 'gemini' | 'claude' | 'groq' | 'openai';
export type AIModel = string;

export interface AIModelEntry { value: AIModel; label: string }

export const AI_BACKENDS: { value: AIBackend; label: string }[] = [
  { value: 'gemini', label: 'Google Gemini' },
  { value: 'claude', label: 'Anthropic Claude' },
  { value: 'groq', label: 'Groq' },
  { value: 'openai', label: 'OpenAI' },
];

export const MODELS_BY_BACKEND: Record<AIBackend, AIModelEntry[]> = {
  gemini: [
    // t/785: gemini-2.5-flash is shut down Dec 1, 2026; the registry's successor is the default.
    { value: 'gemini-3.5-flash-lite', label: '3.5 Flash Lite' },
    { value: 'gemini-3.5-flash', label: '3.5 Flash' },
  ],
  claude: [
    // t/781: claude-sonnet-4-5 retires Nov 30, 2026; ids follow the registry (aiModels.test.ts guards it).
    { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { value: 'claude-haiku-4-5', label: 'Haiku 4.5 (fastest)' },
  ],
  groq: [
    { value: 'groq-openai-gpt-oss-120b', label: 'GPT-OSS 120B' },
  ],
  openai: [
    { value: 'openai-gpt-5.5', label: 'GPT-5.5' },
    { value: 'openai-gpt-5.5-pro', label: 'GPT-5.5 Pro' },
  ],
};

export const DEFAULT_MODELS: Record<AIBackend, AIModel> = {
  gemini: 'gemini-3.5-flash-lite',
  claude: 'claude-sonnet-4-6',
  groq: 'groq-openai-gpt-oss-120b',
  openai: 'openai-gpt-5.5',
};

const STORAGE_KEY_BACKEND = 'summaryviewer-ai-backend';
const STORAGE_KEY_MODEL = 'summaryviewer-ai-model';

export function getStoredBackend(): AIBackend {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_BACKEND);
    if (stored === 'gemini' || stored === 'claude' || stored === 'groq' || stored === 'openai') return stored;
  } catch { /* telemetry — silent by design */ }
  return 'gemini';
}

export function storeBackend(backend: AIBackend): void {
  try { localStorage.setItem(STORAGE_KEY_BACKEND, backend); } catch { /* telemetry — silent by design */ }
}

/**
 * t/785: every model id the catalog knows. Seeded from the built-ins above, replaced by ai-models.json
 * in initAIModels(). A saved id outside it is retired or unknown and must not reach the API.
 */
export const KNOWN_MODEL_IDS = new Set<string>(
  Object.values(MODELS_BY_BACKEND).flatMap(entries => entries.map(e => e.value)),
);

/** True once initAIModels() has settled (loaded, empty or failed): the catalog is final. */
let catalogSettled = false;

const GLOBAL_DEFAULT_MODEL: AIModel = 'gemini-3.5-flash-lite';

/**
 * t/785: pure model resolution, same order as taxonomy-editor's resolveStoredModel (t/3286): a known
 * stored id wins; else the backend's default if it is known; else the global default.
 */
export function resolveStoredModel(
  storedId: string | null,
  backend: AIBackend,
  defaultModels: Record<AIBackend, AIModel>,
  knownIds: ReadonlySet<string>,
  globalDefault: AIModel,
): AIModel {
  if (storedId && knownIds.has(storedId)) return storedId;
  const fallback = defaultModels[backend];
  return knownIds.has(fallback) ? fallback : globalDefault;
}

const reportedThisSession = new Set<string>();

/**
 * t/785: Fallback-Path Logging for a saved id the registry no longer lists, once per session per id
 * (as taxonomy-editor's reportRetiredModel, t/4030). The saved choice is not rewritten: if the model
 * returns in a later registry refresh, it is used again.
 */
function reportRetiredModel(stored: string, fallback: AIModel): void {
  if (reportedThisSession.has(stored)) return;
  reportedThisSession.add(stored);
  const message = `Saved AI model "${stored}" is not in ai-models.json (retired or unknown); using "${fallback}" instead`;
  getGlobalRecorder()?.record({ type: 'system.error', component: 'ai-models', level: 'warn', message });
  console.warn(`[AI Models] WARN ${message}`);
}

export function getStoredModel(): AIModel {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY_MODEL);
  } catch { /* telemetry — silent by design */ }
  // Before the catalog settles, the built-in list can't judge a registry-only id: return the saved
  // choice provisionally. App re-resolves through here once initAIModels() settles.
  if (!catalogSettled) return stored || DEFAULT_MODELS[getStoredBackend()];
  const model = resolveStoredModel(stored, getStoredBackend(), DEFAULT_MODELS, KNOWN_MODEL_IDS, GLOBAL_DEFAULT_MODEL);
  if (stored && model !== stored) reportRetiredModel(stored, model);
  return model;
}

export function storeModel(model: AIModel): void {
  try { localStorage.setItem(STORAGE_KEY_MODEL, model); } catch { /* telemetry — silent by design */ }
}

interface AIModelsConfig {
  backends: { id: string; label: string }[];
  models: { id: string; apiModelId?: string; label: string; backend: string }[];
  defaults: Record<string, string>;
}

export async function initAIModels(): Promise<void> {
  try {
    await loadAIModelsCatalog();
  } finally {
    catalogSettled = true;
  }
}

async function loadAIModelsCatalog(): Promise<void> {
  try {
    const config = await window.electronAPI.loadAIModels() as AIModelsConfig | null;
    if (!config?.models?.length) return;

    // Rebuild backends
    AI_BACKENDS.length = 0;
    for (const b of config.backends) {
      AI_BACKENDS.push({ value: b.id as AIBackend, label: b.label });
    }

    // Rebuild models by backend
    for (const key of Object.keys(MODELS_BY_BACKEND) as AIBackend[]) {
      MODELS_BY_BACKEND[key] = [];
    }
    for (const m of config.models) {
      const backend = m.backend as AIBackend;
      if (!MODELS_BY_BACKEND[backend]) MODELS_BY_BACKEND[backend] = [];
      MODELS_BY_BACKEND[backend].push({ value: m.id as AIModel, label: m.label });
    }

    // t/785: the registry's full id list is what a saved choice is validated against.
    KNOWN_MODEL_IDS.clear();
    for (const m of config.models) KNOWN_MODEL_IDS.add(m.id);

    // Update defaults
    for (const [backend, defaultId] of Object.entries(config.defaults)) {
      if (defaultId) DEFAULT_MODELS[backend as AIBackend] = defaultId;
    }

    console.log(`[AI Models] Loaded ${config.models.length} models from ai-models.json`);
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'ai-models',
      level: 'warn',
      message: 'Failed to load ai-models.json, using built-in defaults',
      error: { name: (err as Error).name ?? 'Error', message: String(err) },
    });
    console.warn('[AI Models] Failed to load ai-models.json, using built-in defaults:', err);
  }
}
