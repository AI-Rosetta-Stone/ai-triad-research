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
    { value: 'gemini-2.5-flash', label: '2.5 Flash' },
    { value: 'gemini-flash-lite-latest', label: '3.1 Flash Lite Preview' },
  ],
  claude: [
    { value: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
    { value: 'claude-haiku-3.5', label: 'Haiku 3.5 (fastest)' },
  ],
  groq: [
    { value: 'groq-llama-4-scout', label: 'Llama 4 Scout' },
    { value: 'groq-openai-gpt-oss-120b', label: 'GPT-OSS 120B' },
  ],
  openai: [
    { value: 'openai-gpt-5.5', label: 'GPT-5.5' },
    { value: 'openai-gpt-5.5-pro', label: 'GPT-5.5 Pro' },
  ],
};

export const DEFAULT_MODELS: Record<AIBackend, AIModel> = {
  gemini: 'gemini-2.5-flash',
  claude: 'claude-sonnet-4-5',
  groq: 'groq-llama-4-scout',
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

export function getStoredModel(): AIModel {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_MODEL);
    if (stored) return stored;
  } catch { /* telemetry — silent by design */ }
  return DEFAULT_MODELS[getStoredBackend()];
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
