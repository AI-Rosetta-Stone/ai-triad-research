// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Per-link key resolution for generateText's fallback chain, split out of aiBackends.ts (complexity and
// max-lines budgets, TL e/284#30). A t/4105 condition file: the refusal handling here is SO cond 6.

import { getApiKeys, type AIBackend } from '../config.js';
import { isKeyRoutingRefusal, LISTING_WARN } from '../../../../lib/ai-client/apiKeyFallback.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { log } from '../logger.js';

const BACKEND_NAMES: Record<string, string> = { gemini: 'Gemini', claude: 'Claude', groq: 'Groq', openai: 'OpenAI', tavily: 'Tavily', deepseek: 'DeepSeek', moonshot: 'Moonshot (Kimi)', xai: 'xAI (Grok)' };
const backendName = (b: string): string => BACKEND_NAMES[b] ?? b;

/** No key for any model in the chain: throw an ActionableError that names the CHOSEN model's backend in its goal and
 *  first fix step, with the fallbacks as a secondary line (t/520, TL p/16#437: the PI chose Gemini and was told to set
 *  a Groq key, because the message named the chain's last link). `backends[i]` is the backend of `modelsToTry[i]`. */
export function throwNoApiKeyError(modelsToTry: string[], backends: string[]): never {
  const primary = modelsToTry[0];
  const name = backendName(backends[0]);
  const fallbacks = modelsToTry.slice(1).map((m, i) => `${m} (${backendName(backends[i + 1])})`);
  const otherBackends = [...new Set(backends.slice(1).filter(b => b !== backends[0]).map(backendName))];
  throw new ActionableError({
    goal: `Generate text with ${primary} via ${name}`,
    problem: `No ${name} API key is configured for ${primary}.`
      + (fallbacks.length > 0 ? ` Its fallbacks have no key either: ${fallbacks.join(', ')}.` : ''),
    location: 'aiBackends.generateText',
    nextSteps: [
      `Set your ${name} API key in Settings`,
      ...(otherBackends.length > 0 ? [`Or add a key for a fallback: ${otherBackends.join(', ')}`] : []),
      'Or choose a model whose backend has a key configured',
    ],
  });
}

/**
 * The keys for chain link `mi`, or null to skip it. SO e/284#12 cond 6: the PRIMARY's key refusal throws to the
 * caller, never served by a later link; a SECONDARY link with only AI_API_KEY is skipped like a keyless one, and a
 * foreign-credential refusal always surfaces. t/3176: a skipped keyless link WARNs, so a key gap is greppable.
 */
export async function chainLinkKeys(modelsToTry: string[], mi: number, backends: AIBackend[], explicitKeys: string[] | undefined): Promise<string[] | null> {
  const model = modelsToTry[mi];
  const backend = backends[mi];
  let keys: string[];
  try {
    keys = explicitKeys ?? await getApiKeys(backend);
  } catch (err) {
    if (mi === 0 || !isKeyRoutingRefusal(err, 'AIApiKeyGeminiOnlyRefused')) throw err;
    log.api.warn({ model, backend, fallbackIndex: mi }, `generateText: ${LISTING_WARN} — skipping fallback chain entry`);
    return null;
  }
  if (keys.length > 0) return keys;
  if (mi === modelsToTry.length - 1) throwNoApiKeyError(modelsToTry, backends);
  getGlobalRecorder()?.record({
    type: 'ai.fallback', component: 'ai-adapter', level: 'info',
    message: `Skipping ${model}: no ${backend} API key — trying next fallback`,
    data: { model, backend, fallbackIndex: mi, chain: modelsToTry },
  });
  log.api.warn({ model, backend, fallbackIndex: mi }, 'generateText: no API key for backend — skipping to next fallback chain entry');
  return null;
}
