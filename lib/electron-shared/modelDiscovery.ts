import fs from 'fs';
import path from 'path';
import { ActionableError } from '../debate/errors.js';
import { assertKeyForBackend, isKeyRoutingRefusal, listingNotConfiguredHint, LISTING_WARN } from '../ai-client/apiKeyFallback.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';
import { findDanglingRefs, findChainlessDefaults, KNOWN_VERBATIM } from '../ai-config/validate.js';
import codeReferencedModels from '../ai-config/codeReferencedModels.json' with { type: 'json' };
import {
  referenceSlots, curateByFamily, partialCatalog, codeReferencedAbsent, computeProposal, applyProposal, proposalHash, catalogFingerprint, diffProposals, crossFamilyChanges,
  type CodeReferencedAbsence, type PartialCatalog, type PinnedCandidate, type Proposal,
} from './refreshPolicy.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ModelEntry {
  id: string;
  apiModelId: string;
  label: string;
  backend: string;
}

export interface AIModelsConfig {
  backends: { id: string; label: string }[];
  models: ModelEntry[];
  defaults: Record<string, string>;
  // Runtime-affecting model-id reference surfaces. Previously omitted from this
  // type — they survived only by JSON round-trip through load/saveModelConfig.
  // Made type-visible (t/2039) so the refresh repair pass + guard can operate on
  // them. `debateTiers` carries a leading "_comment" string key alongside the
  // per-tier backend maps.
  debateTiers?: Record<string, string | Record<string, string>>;
  fallbackChains?: Record<string, string[]>;
  lastRefreshed: string | null;
  /** Append-only audit of accepted refresh proposals (t/4160). Written in the same write as the change it approves. */
  signoffs?: SignoffRecord[];
}

export interface BackendResult {
  ok: boolean;
  count: number;
  error?: string;
}

export interface RefreshResult {
  gemini:   BackendResult;
  claude:   BackendResult;
  groq:     BackendResult;
  openai:   BackendResult;
  deepseek: BackendResult;
  ollama:   BackendResult;
  totalModels: number;
  // t/2039 validate-before-write guard outcome (consumed by the Settings panel,
  // t/2041). `written` is false iff the guard REFUSED to persist because the
  // repaired registry would still be invalid — in that case ai-models.json is
  // left byte-untouched. `configWarning` is present iff there is something to
  // report: the refusal reason when !written, or a non-fatal note when repairs
  // were applied on the successful-write path.
  written: boolean;
  configWarning?: string;
  // t/3553 drop policy. `refusal` names why nothing was written; `proposal` is what an explicit accept would
  // apply; `pinnedCandidates` is informational and never part of the proposal (SO e/263#4).
  refusal?: RefreshRefusal;
  proposal?: Proposal;
  pinnedCandidates?: PinnedCandidate[];
  catalogSources?: Record<string, CatalogSource>;
  dryRun?: boolean;
  signoff?: SignoffRecord;
}

export interface ModelDiscoveryDeps {
  loadApiKey: (backend: string) => string | null;
  repoRoot: string;
  /**
   * Registered ids that code names as literals, which the refresh pins (t/3553 item 1). Omit it in production: the
   * default is the bundled `lib/ai-config/codeReferencedModels.json`, because the refresh runs where there's no
   * source tree to scan. Tests inject a list.
   */
  codeReferencedIds?: readonly string[];
}

// ── Config I/O ─────────────────────────────────────────────────────────────────

function configPath(repoRoot: string): string {
  return path.join(repoRoot, 'ai-models.json');
}

export function loadModelConfig(repoRoot: string): AIModelsConfig {
  const raw = fs.readFileSync(configPath(repoRoot), 'utf-8');
  return JSON.parse(raw) as AIModelsConfig;
}

export function saveModelConfig(repoRoot: string, config: AIModelsConfig): void {
  fs.writeFileSync(configPath(repoRoot), JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

// ── Gemini: GET /v1beta/models ─────────────────────────────────────────────────

interface GeminiModelInfo {
  name: string;
  displayName: string;
  supportedGenerationMethods: string[];
}

type GeminiTier = 'pro' | 'flash' | 'flash-lite';

function classifyGeminiTier(id: string): GeminiTier | null {
  if (id.includes('-flash-lite')) return 'flash-lite';
  if (id.includes('-flash')) return 'flash';
  if (id.includes('-pro')) return 'pro';
  return null;
}

function extractGeminiVersion(id: string): number {
  const match = id.match(/^gemini-(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : 0;
}

const GEMINI_EXCLUDE_RE = /tts|robotics|agent|image|audio|embed|aqa|lyria/i;

/**
 * Every Gemini text model the catalog lists, in a tier, BEFORE family curation (t/3553). The refresh curates these
 * with the pinned set (refreshPolicy.curateByFamily), and measures a partial catalog against them.
 */
export function geminiCandidates(rawModels: GeminiModelInfo[]): ModelEntry[] {
  return rawModels
    .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
    .map(m => ({ ...m, id: m.name.replace('models/', '') }))
    .filter(m => /^gemini-\d/.test(m.id))
    .filter(m => !GEMINI_EXCLUDE_RE.test(m.id))
    .filter(m => classifyGeminiTier(m.id) !== null)
    .map(m => ({ id: m.id, apiModelId: m.id, label: m.displayName || m.id, backend: 'gemini' }));
}

/** Latest model per tier, with no pinned set: the unpinned view of the curation (kept for its callers and tests). */
export function curateGeminiModels(rawModels: GeminiModelInfo[]): ModelEntry[] {
  const candidates = rawModels
    .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
    .map(m => ({ ...m, id: m.name.replace('models/', '') }))
    .filter(m => /^gemini-\d/.test(m.id))
    .filter(m => !GEMINI_EXCLUDE_RE.test(m.id));

  const byTier = new Map<GeminiTier, { info: (typeof candidates)[0]; version: number }>();

  for (const m of candidates) {
    const tier = classifyGeminiTier(m.id);
    if (!tier) continue;
    const version = extractGeminiVersion(m.id);
    const existing = byTier.get(tier);
    if (!existing || version > existing.version ||
        (version === existing.version && m.id.length < existing.info.id.length)) {
      byTier.set(tier, { info: m, version });
    }
  }

  return [...byTier.values()].map(({ info }) => ({
    id: info.id,
    apiModelId: info.id,
    label: info.displayName || info.id,
    backend: 'gemini',
  }));
}

export async function discoverGeminiModels(apiKey: string): Promise<ModelEntry[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=100`;
  const resp = await fetch(url, { headers: { 'x-goog-api-key': apiKey } });
  if (!resp.ok) {
    const body = await resp.text();
    throw new ActionableError({
      goal: 'Discover available Gemini models',
      problem: `Gemini models API returned HTTP ${resp.status}: ${body.slice(0, 200)}`,
      location: 'modelDiscovery.discoverGeminiModels',
      nextSteps: ['Check your API key is valid', 'Verify network connectivity', 'The API may be temporarily unavailable'],
    });
  }
  const json = await resp.json() as { models: GeminiModelInfo[] };
  return geminiCandidates(json.models);
}

// ── Groq: GET /openai/v1/models ────────────────────────────────────────────────

interface GroqModelInfo {
  id: string;
  owned_by: string;
  active: boolean;
}

export async function discoverGroqModels(apiKey: string): Promise<ModelEntry[]> {
  const resp = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new ActionableError({
      goal: 'Discover available Groq models',
      problem: `Groq models API returned HTTP ${resp.status}: ${body.slice(0, 200)}`,
      location: 'modelDiscovery.discoverGroqModels',
      nextSteps: ['Check your API key is valid', 'Verify network connectivity', 'The API may be temporarily unavailable'],
    });
  }
  const json = await resp.json() as { data: GroqModelInfo[] };

  return json.data
    .filter(m => m.active !== false)
    .filter(m => {
      const id = m.id.toLowerCase();
      // orpheus / tts: text-to-speech, not a text model (CL p/742#3).
      return !id.includes('whisper') && !id.includes('embed') && !id.includes('guard') && !id.includes('orpheus') && !id.includes('tts');
    })
    .map(m => {
      const friendlyId = 'groq-' + m.id
        .replace(/^meta-llama\//, '')
        .replace(/^mistralai\//, '')
        .replace(/-instruct$/, '')
        .replace(/[^a-z0-9.-]/gi, '-')
        .toLowerCase();
      const label = m.id
        .replace(/^meta-llama\//, '')
        .replace(/^mistralai\//, '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
      return { id: friendlyId, apiModelId: m.id, label, backend: 'groq' };
    });
}

// ── Anthropic: live /v1/models catalog + candidate-probe fallback ──────────────

interface AnthropicModelInfo {
  id: string;
  display_name: string;
  type: string;
}

const CLAUDE_EXCLUDE_RE = /image|embed|tts|audio/i;

function claudeFriendlyId(apiModelId: string): string {
  return apiModelId
    .replace(/-\d{8}$/, '')
    .replace(/^claude-3-5-/, 'claude-3.5-');
}

export function curateClaudeModels(rawModels: AnthropicModelInfo[]): ModelEntry[] {
  const entries = rawModels
    .filter(m => m.id.startsWith('claude-'))
    .filter(m => !CLAUDE_EXCLUDE_RE.test(m.id))
    .map(m => ({
      id: claudeFriendlyId(m.id),
      apiModelId: m.id,
      label: m.display_name || m.id,
      backend: 'claude',
    }));

  // Dedup: two IDs that share a friendlyId (e.g. alias + dated version) → keep
  // the longer apiModelId (dated/specific wins over the alias).
  const seen = new Map<string, ModelEntry>();
  for (const m of entries) {
    const existing = seen.get(m.id);
    if (!existing || m.apiModelId.length > existing.apiModelId.length) {
      seen.set(m.id, m);
    }
  }
  return [...seen.values()];
}

// Probe list: fallback when the live catalog is unreachable.
const CLAUDE_CANDIDATES: { apiModelId: string; label: string }[] = [
  { apiModelId: 'claude-opus-5',                  label: 'Opus 5 (alias)' },
  { apiModelId: 'claude-opus-5-5',                label: 'Opus 5.5 (alias)' },
  { apiModelId: 'claude-sonnet-5',                label: 'Sonnet 5 (alias)' },
  { apiModelId: 'claude-sonnet-5-5',              label: 'Sonnet 5.5 (alias)' },
  { apiModelId: 'claude-opus-4-8',                label: 'Opus 4.8 (alias)' },
  { apiModelId: 'claude-fable-5',                 label: 'Fable 5 (alias)' },
  { apiModelId: 'claude-fable-5-1',               label: 'Fable 5.1 (alias)' },
  { apiModelId: 'claude-opus-4-6-20250514',       label: 'Opus 4.6' },
  { apiModelId: 'claude-sonnet-4-6-20250514',     label: 'Sonnet 4.6' },
  { apiModelId: 'claude-sonnet-4-5-20241022',     label: 'Sonnet 4.5 (Oct 2024)' },
  { apiModelId: 'claude-sonnet-4-5-20250514',     label: 'Sonnet 4.5 (May 2025)' },
  { apiModelId: 'claude-opus-4-20250514',         label: 'Opus 4' },
  { apiModelId: 'claude-sonnet-4-20250514',       label: 'Sonnet 4' },
  { apiModelId: 'claude-haiku-5-5',               label: 'Haiku 5.5 (alias)' },
  { apiModelId: 'claude-haiku-4-5-20251001',      label: 'Haiku 4.5' },
  { apiModelId: 'claude-3-5-haiku-20241022',      label: 'Haiku 3.5' },
  { apiModelId: 'claude-3-5-sonnet-20241022',     label: 'Sonnet 3.5 v2 (Oct 2024)' },
  { apiModelId: 'claude-3-5-sonnet-20240620',     label: 'Sonnet 3.5 (Jun 2024)' },
  { apiModelId: 'claude-sonnet-4-5',              label: 'Sonnet 4.5 (alias)' },
  { apiModelId: 'claude-sonnet-4-6',              label: 'Sonnet 4.6 (alias)' },
  { apiModelId: 'claude-opus-4-6',                label: 'Opus 4.6 (alias)' },
];

async function probeClaudeCandidates(apiKey: string): Promise<ModelEntry[]> {
  console.log(`[ModelDiscovery] Claude catalog unavailable — probing ${CLAUDE_CANDIDATES.length} candidates...`);
  const results: ModelEntry[] = [];

  const probeModel = async (candidate: typeof CLAUDE_CANDIDATES[0]): Promise<boolean> => {
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: candidate.apiModelId,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      const valid = resp.status !== 404;
      const bodySnippet = await resp.text().then(t => t.slice(0, 100));
      console.log(`[ModelDiscovery] Claude probe ${candidate.apiModelId}: ${resp.status} ${valid ? 'VALID' : 'NOT FOUND'} ${bodySnippet}`);
      return valid;
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'model-discovery',
        level: 'error',
        message: 'Claude model probe failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      console.warn(`[ModelDiscovery] Claude probe ${candidate.apiModelId} failed:`, err);
      return false;
    }
  };

  for (let i = 0; i < CLAUDE_CANDIDATES.length; i += 3) {
    const batch = CLAUDE_CANDIDATES.slice(i, i + 3);
    const probes = await Promise.all(batch.map(c => probeModel(c).then(valid => ({ ...c, valid }))));
    for (const p of probes) {
      if (p.valid) {
        results.push({ id: claudeFriendlyId(p.apiModelId), apiModelId: p.apiModelId, label: p.label, backend: 'claude' });
      }
    }
  }

  const seen = new Map<string, ModelEntry>();
  for (const m of results) {
    const existing = seen.get(m.id);
    if (!existing || m.apiModelId.length > existing.apiModelId.length) {
      seen.set(m.id, m);
    }
  }
  return [...seen.values()];
}

export async function discoverClaudeModels(apiKey: string): Promise<ModelEntry[]> {
  return (await discoverClaudeCatalog(apiKey)).models;
}

/**
 * Claude discovery, with WHERE the list came from (t/3553, SO e/263#2 cond 2). `catalog` = the authoritative
 * /v1/models listing. `probe` = the hand-picked candidate fallback: never authoritative, so the refresh treats a
 * probe-sourced backend as additive only and never lets it drive a drop.
 */
export async function discoverClaudeCatalog(apiKey: string): Promise<{ models: ModelEntry[]; source: 'catalog' | 'probe' }> {
  try {
    const resp = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    });
    if (resp.ok) {
      const json = await resp.json() as { data: AnthropicModelInfo[] };
      const models = curateClaudeModels(json.data ?? []);
      if (models.length > 0) {
        console.log(`[ModelDiscovery] Claude: ${models.length} models via /v1/models catalog`);
        return { models, source: 'catalog' };
      }
      console.warn('[ModelDiscovery] Claude /v1/models returned empty list; falling back to probe');
    } else {
      const body = await resp.text();
      console.warn(`[ModelDiscovery] Claude /v1/models HTTP ${resp.status}: ${body.slice(0, 100)}; falling back to probe`);
    }
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'model-discovery',
      level: 'error',
      message: 'Claude /v1/models catalog fetch failed',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    console.warn('[ModelDiscovery] Claude /v1/models failed; falling back to probe:', err);
  }

  return { models: await probeClaudeCandidates(apiKey), source: 'probe' };
}

// Claude's offline fallback (when live discovery fails) is DERIVED from ai-models.json, not a hardcoded
// catalog (t/3661): the call sites below use `config.models.filter(m => m.backend === 'claude')`, the
// same filter every other backend already uses for its fallback. No hand-maintained copy to drift from
// the registry — a Claude model added to ai-models.json appears here automatically, and a retired one
// can't linger in a user-facing menu. (Removed getKnownClaudeModels(); t/3657 had refreshed its stale
// entries, but a resolution-checked duplicate is still a duplicate — the registry is the single source.)

// ── OpenAI: MANUALLY CURATED (t/3552 decision b) ───────────────────────────────
// OpenAI is NOT auto-discovered. GET /v1/models returns the whole catalog (~93 ids: dated snapshots,
// undated aliases, legacy non-chat) — and unlike gemini, OpenAI has no clean tier/version scheme to
// curate latest-per-family without a fragile heuristic that drifts every release (t/3551 decision 3).
// So openai joins the hand-picked set (zai/azure/moonshot/xai): its ai-models.json entries are
// maintained by hand and survive every refresh untouched — it is absent from ALL_BACKENDS, so it is
// never probed and is preserved as a non-probed backend by mergeDiscoveredModels. (The former
// `discoverOpenAIModels`, which dumped the whole catalog, was removed with this ticket.)

// ── DeepSeek: OpenAI-compatible GET /models ────────────────────────────────────

export async function discoverDeepSeekModels(apiKey: string): Promise<ModelEntry[]> {
  const resp = await fetch('https://api.deepseek.com/models', {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new ActionableError({
      goal: 'Discover available DeepSeek models',
      problem: `DeepSeek models API returned HTTP ${resp.status}: ${body.slice(0, 200)}`,
      location: 'modelDiscovery.discoverDeepSeekModels',
      nextSteps: ['Check your API key is valid', 'Verify network connectivity', 'The API may be temporarily unavailable'],
    });
  }
  const json = await resp.json() as { data: { id: string; owned_by: string }[] };

  return (json.data ?? [])
    .filter(m => {
      const id = m.id.toLowerCase();
      return !id.includes('embed') && !id.includes('whisper');
    })
    .map(m => {
      const friendlyId = 'deepseek-' + m.id.replace(/[^a-z0-9.-]/gi, '-').toLowerCase();
      const label = m.id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      return { id: friendlyId, apiModelId: m.id, label, backend: 'deepseek' };
    });
}

// ── Ollama: GET /api/tags ──────────────────────────────────────────────────────

interface OllamaModelInfo {
  name: string;
  model: string;
  size: number;
  details: {
    family: string;
    parameter_size: string;
    quantization_level: string;
  };
}

export async function discoverOllamaModels(): Promise<ModelEntry[]> {
  const resp = await fetch('http://localhost:11434/api/tags', {
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) {
    throw new ActionableError({
      goal: 'Discover available Ollama models',
      problem: `Ollama /api/tags returned HTTP ${resp.status}`,
      location: 'modelDiscovery.discoverOllamaModels',
      nextSteps: ['Verify Ollama is running: ollama serve', 'Check Ollama version'],
    });
  }
  const json = await resp.json() as { models: OllamaModelInfo[] };

  return (json.models ?? []).map(m => {
    const friendlyId = 'ollama-' + m.name
      .replace(/:/g, '-')
      .replace(/[^a-z0-9.-]/gi, '-')
      .toLowerCase();
    const sizeInfo = m.details?.parameter_size ? ` (${m.details.parameter_size})` : '';
    const quantInfo = m.details?.quantization_level ? ` ${m.details.quantization_level}` : '';
    return {
      id: friendlyId,
      apiModelId: m.name,
      label: `${m.name}${sizeInfo}${quantInfo}`,
      backend: 'ollama',
    };
  });
}

// ── Main refresh orchestrator ──────────────────────────────────────────────────

function recordError(err: unknown): void {
  getGlobalRecorder()?.record({
    type: 'system.error',
    component: 'model-discovery',
    level: 'error',
    message: 'Operation failed',
    error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
  });
}

/**
 * Where a backend's model list came from this run (t/3553, SO e/263#2 cond 2):
 *   - `catalog`: the vendor's authoritative listing, the only source that may drive a drop;
 *   - `probe`: a non-authoritative fallback (Claude's candidate probe), additive only;
 *   - `existing`: discovery failed or had no key, so the registry's own entries were returned unchanged.
 */
export type CatalogSource = 'catalog' | 'probe' | 'existing';

async function discoverBackend(
  backendId: string,
  config: AIModelsConfig,
  deps: ModelDiscoveryDeps,
): Promise<{ models: ModelEntry[]; result: BackendResult; source: CatalogSource }> {
  const existing = () => config.models.filter(m => m.backend === backendId);
  if (backendId === 'ollama') {
    try {
      const models = await discoverOllamaModels();
      console.log(`[ModelDiscovery] Ollama: discovered ${models.length} local models`);
      return { models, result: { ok: true, count: models.length }, source: 'catalog' };
    } catch (err) {
      recordError(err);
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[ModelDiscovery] Ollama not available: ${msg}`);
      return { models: existing(), result: { ok: false, count: 0, error: msg }, source: 'existing' };
    }
  }

  // A LISTING loop (SO e/284#20, C1): only AI_API_KEY set must read "not configured" for a non-gemini backend,
  // never abort discovery. Soften ONLY the gemini-only refusal, by kind; a foreign-credential refusal propagates.
  let apiKey: string | null;
  try {
    apiKey = deps.loadApiKey(backendId);
  } catch (err) {
    if (!isKeyRoutingRefusal(err, 'AIApiKeyGeminiOnlyRefused')) throw err;
    console.warn(`[ModelDiscovery] ${backendId}: ${LISTING_WARN}; reporting it as not configured`);
    return { models: existing(), result: { ok: false, count: 0, error: listingNotConfiguredHint(backendId) ?? LISTING_WARN }, source: 'existing' };
  }
  if (!apiKey) {
    return { models: existing(), result: { ok: false, count: 0, error: 'No API key configured' }, source: 'existing' };
  }

  const discoverers: Record<string, (key: string) => Promise<{ models: ModelEntry[]; source: 'catalog' | 'probe' }>> = {
    gemini: async (k) => ({ models: await discoverGeminiModels(k), source: 'catalog' }),
    claude: discoverClaudeCatalog,
    groq: async (k) => ({ models: await discoverGroqModels(k), source: 'catalog' }),
    deepseek: async (k) => ({ models: await discoverDeepSeekModels(k), source: 'catalog' }),
  };

  const discover = discoverers[backendId];
  if (!discover) {
    return { models: existing(), result: { ok: false, count: 0, error: `Unknown backend: ${backendId}` }, source: 'existing' };
  }
  assertKeyForBackend(apiKey, backendId, 'discovery'); // t/4105 C5: a direct send that bypasses callProvider, so the foreign-key guard runs here

  try {
    const { models, source } = await discover(apiKey);
    if (backendId === 'claude' && models.length === 0) {
      return { models: existing(), result: { ok: false, count: 0, error: 'No valid models found via probing — kept existing' }, source: 'existing' };
    }
    console.log(`[ModelDiscovery] ${backendId}: discovered ${models.length} models (${source})`);
    return { models, result: { ok: true, count: models.length }, source };
  } catch (err) {
    recordError(err);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ModelDiscovery] ${backendId} error:`, msg);
    return { models: existing(), result: { ok: false, count: 0, error: msg }, source: 'existing' };
  }
}

// The DISCOVERABLE backends. openai is deliberately NOT here — it is manually curated (t/3552 decision
// b), like zai/azure/moonshot/xai; a backend absent from this set is never probed and its config entries
// survive untouched (preserved as non-probed by mergeDiscoveredModels).
const ALL_BACKENDS = ['gemini', 'claude', 'groq', 'deepseek', 'ollama'] as const;

/**
 * Merge a refresh's discovered models into the registry. TWO modes with DIFFERENT de-listing policy —
 * the mode is a deliberate choice, not an implementation detail (TL p/342#306).
 *
 * REPLACE (default): probed backends are regenerated from the live catalog (which only knows
 * `{id,apiModelId,label,backend}`); non-probed backends survive untouched (t/1711 — the Z.AI-outage
 * fix). For a discovered model whose `id` still exists, SPREAD-preserve the prior entry's curated
 * fields — `{ ...prior, ...discovered }` — so the live catalog wins on id/apiModelId/label/backend but
 * curated extras (`picker`, `minTimeoutMs` [t/3518 floors], `fixedTemperature`, and any FUTURE one)
 * carry over. Spread, NOT a field allowlist (TL p/342#300): a curated field added later is safe by
 * construction — an allowlist would silently drop the next one with `verify:config` fully green (the
 * extras are unreferenced). **De-listing policy:** a model absent from `discovered` DROPS — this is the
 * mode's automatic de-listing path, and it demands an explicit-removal review, since a partial/rate-
 * limited catalog would otherwise delete a chunk of the registry while every gate stays green (t/3551
 * guardrail 1). #2300 protects the surviving models' FIELDS; this mode still governs their EXISTENCE.
 *
 * ADDITIVE (`additive=true`, t/3551 decision 2): keep EVERY existing entry as-is and append only
 * discovered ids not already present. Surfaces newly-released models (the user-facing goal) while
 * making it structurally impossible to drop a model, break a fallbackChain, or dangle a default.
 * **De-listing policy:** NOTHING is ever removed — additive-only DELIBERATELY REMOVES the automatic
 * de-listing path above. So in this mode de-listing is a MANUAL, explicit-review decision (there is no
 * automatic path); the drop policy for a full replace-and-prune refresh is tracked separately in t/3553.
 */
export function mergeDiscoveredModels(
  existing: ModelEntry[],
  discovered: ModelEntry[],
  probed: ReadonlySet<string>,
  additive = false,
): ModelEntry[] {
  if (additive) {
    const existingIds = new Set(existing.map(m => m.id));
    return [...existing, ...discovered.filter(m => !existingIds.has(m.id))];
  }
  const preserved = existing.filter(m => !probed.has(m.backend));
  const priorById = new Map(existing.map(m => [m.id, m]));
  const merged = discovered.map(m => {
    const prior = priorById.get(m.id);
    return prior ? { ...prior, ...m } : m;
  });
  return [...preserved, ...merged];
}

/** An explicit sign-off for one proposal (t/3553; CL p/742#3: who, why, the exact proposal, old→new per slot). */
export interface RefreshAccept {
  /** The exact `proposal` a dry run (or a refused refresh) returned. */
  proposal: Proposal;
  /** The display name the person typed. */
  approvedBy: string;
  reason: string;
  /**
   * HOST-SET (t/4160): the authenticated identity, filled in by the host from its own session (the server's signed-in
   * user, the desktop app's identity), never taken from the client. The bridge contract (`RefreshModelsRequest`) picks
   * only `proposal`, `approvedBy` and `reason`. An accept without it is refused as `no-principal`.
   */
  principal: string;
  /** HOST-SET, desktop only (t/4160): the OS account the app runs as, recorded beside the typed name. */
  osUser?: string;
}

/**
 * The durable record of one accepted proposal (t/4160; TL t/4031#2 adjustment 3). Appended to `ai-models.json`
 * `signoffs` in the same write as the change, so a change never lands without its record.
 */
export interface SignoffRecord {
  principal: string;
  approvedBy: string;
  osUser?: string;
  reason: string;
  proposalHash: string;
  /** The catalog the accept re-derived the proposal against (the one written). */
  catalogFingerprint: string;
  /**
   * The catalog the person reviewed. It can differ from `catalogFingerprint`: an accept is checked by proposal hash
   * only, so an unrelated catalog change between review and accept doesn't fail it (SO e/263#4; TL t/4160, option b).
   */
  reviewedCatalogFingerprint: string;
  at: string;
  slots: string[];
  calibrationEpoch: boolean;
}

export interface RefreshOptions {
  /** Additive-only: add newly-discovered ids, drop nothing (t/3551 decision 2). */
  additive?: boolean;
  /** Backends to NOT probe this run — a transient skip; their existing models are preserved untouched.
   *  Distinct from the always-manually-curated set. (openai is no longer an example here: it moved to
   *  the permanently-manual set — absent from ALL_BACKENDS — per t/3552 decision b.) */
  skipBackends?: readonly string[];
  /** Compute and report the outcome (proposal, pinned candidates, refusals) but never write (t/3553). */
  dryRun?: boolean;
  /** Apply exactly this proposal. Refused as `proposal-changed` if the recomputed one differs (t/3553). */
  accept?: RefreshAccept;
}

/** Why a refresh did not write (t/3553). `invalid` is the t/2039 guard; the rest are the drop policy's. */
export type RefreshRefusal =
  | { reason: 'suspected-partial-catalog'; backends: PartialCatalog[] }
  | { reason: 'code-referenced-absent'; absent: CodeReferencedAbsence[] }
  | { reason: 'proposal-required'; proposal: Proposal }
  | { reason: 'needs-human'; proposal: Proposal; unresolved: string[] }
  | { reason: 'cross-family'; proposal: Proposal; slots: string[] }
  | { reason: 'proposal-changed'; accepted: Proposal; recomputed: Proposal; diff: ReturnType<typeof diffProposals> }
  | { reason: 'no-principal' }
  | { reason: 'invalid'; dangling: string[]; chainless: string[] };

const refusalText = (r: RefreshRefusal): string => {
  switch (r.reason) {
    case 'suspected-partial-catalog':
      return `suspected partial catalog: ${r.backends.map(b => `${b.backend} lists ${b.vendorListed} of ${b.registered} registered (would drop ${b.wouldDrop})`).join('; ')}. Nothing was proposed; retry later.`;
    case 'code-referenced-absent':
      return `the vendor no longer lists ${r.absent.length} model(s) that code still names: ${r.absent.map(a => `${a.id} (${a.backend})`).join(', ')}. No proposal can fix this. Update the code that names them, regenerate with \`npm run gen:code-referenced-models\`, then refresh again.`;
    case 'proposal-required':
      return `this refresh would change ${r.proposal.changes.length} selection slot(s): ${r.proposal.changes.map(c => c.slot).join(', ')}. Review the proposal and accept it explicitly.`;
    case 'cross-family':
      return `the proposal would move ${r.slots.join(', ')} to a different model family, which a refresh never does (CL p/742#3). A human must choose.`;
    case 'needs-human': {
      const from = new Map(r.proposal.changes.map(c => [c.slot, c.from]));
      const listed = r.unresolved.map(s => `${s} (${JSON.stringify(from.get(s))})`).join(', ');
      return `${r.unresolved.length} slot(s) have no same-family successor and need a manual choice: ${listed}.`;
    }
    case 'proposal-changed':
      return `the catalog moved since the proposal was made (${r.diff.added.length} added, ${r.diff.removed.length} removed, ${r.diff.changed.length} changed slot(s)). Review the new proposal.`;
    case 'no-principal':
      return 'an accept must carry the authenticated principal, set by the host (t/4160). Nothing was refreshed.';
    case 'invalid':
      return `the refreshed registry is invalid (${[...(r.dangling.length ? [`dangling refs: ${r.dangling.join(', ')}`] : []), ...r.chainless].join(' | ')}).`;
  }
};

function refuse(result: RefreshResult, refusal: RefreshRefusal): RefreshResult {
  result.written = false;
  result.refusal = refusal;
  result.configWarning = `Refused to write ai-models.json — ${refusalText(refusal)} The existing file is unchanged.`;
  console.warn(`[ModelDiscovery] REFUSED write: ${result.configWarning}`);
  // t/2039#3: a refused write is surfaced in the flight recorder too, ids/backends only, no secrets.
  getGlobalRecorder()?.record({
    type: 'system.error',
    component: 'model-discovery-refresh',
    level: 'warn',
    message: result.configWarning,
    data: {
      refusal: refusal.reason,
      ...(refusal.reason === 'invalid' ? { dangling: refusal.dangling, chainless: refusal.chainless } : {}),
      ...(refusal.reason === 'code-referenced-absent' ? { absent: refusal.absent } : {}),
    },
  });
  return result;
}

/** An accept is recorded under a host-set identity (t/4160); without one, it is refused before any vendor call. */
const lacksPrincipal = (opts: RefreshOptions): boolean => opts.accept !== undefined && !opts.accept.principal?.trim();

/** Fallback-Path Logging: a probe-sourced backend's catalog wasn't authoritative, so it can only gain models. */
function warnProbeSourced(discovered: readonly { backend: string; models: ModelEntry[]; source: CatalogSource }[]): void {
  for (const d of discovered.filter(x => x.source === 'probe')) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'model-discovery-refresh', level: 'warn',
      message: `${d.backend}: model list came from the candidate probe, not the vendor catalog — additive only this run (no drops, no proposal).`,
      data: { backend: d.backend, listed: d.models.length },
    });
  }
}

/**
 * Refresh the model registry from the vendor catalogs. Replace mode (the default) curates each authoritative
 * catalog to the latest model per family, keeps every pinned (referenced) model the vendor still lists, and never
 * moves a selection surface on its own: anything that would change a default or debate tier, or re-point or empty a
 * chain, is returned as a proposal and written only through `opts.accept`. Design and conditions: t/3553#6.
 */
export async function refreshAIModels(deps: ModelDiscoveryDeps, opts: RefreshOptions = {}): Promise<RefreshResult> {
  const skip = new Set(opts.skipBackends ?? []);
  const config = loadModelConfig(deps.repoRoot);
  const result: RefreshResult = {
    gemini:   { ok: false, count: 0 },
    claude:   { ok: false, count: 0 },
    groq:     { ok: false, count: 0 },
    openai:   { ok: false, count: 0 },
    deepseek: { ok: false, count: 0 },
    ollama:   { ok: false, count: 0 },
    totalModels: 0,
    written: false,
  };

  if (lacksPrincipal(opts)) return refuse(result, { reason: 'no-principal' });

  const discovered: { backend: string; models: ModelEntry[]; source: CatalogSource }[] = [];
  for (const backendId of ALL_BACKENDS) {
    if (skip.has(backendId)) {
      // Not probed this run → treated as non-probed so its existing models survive untouched.
      result[backendId] = { ok: false, count: 0, error: 'skipped this run' };
      continue;
    }
    const discovery = await discoverBackend(backendId, config, deps);
    discovered.push({ backend: backendId, models: discovery.models, source: discovery.source });
    result[backendId] = discovery.result;
  }
  result.catalogSources = Object.fromEntries(discovered.map(d => [d.backend, d.source]));

  // openai is manually curated (t/3552 decision b) — absent from ALL_BACKENDS, so the loop never touches
  // it. Report it as such for the Settings panel and count its preserved hand-maintained entries (mirrors
  // how a skipped backend is reported: ok:false + a status note).
  result.openai = {
    ok: false,
    count: config.models.filter(m => m.backend === 'openai').length,
    error: 'manually curated — excluded from auto-discovery (t/3552)',
  };

  if (opts.additive) {
    // Additive (t/3551 decision 2): keep every entry, append new ids. Nothing can dangle or move.
    const probed = new Set(discovered.map(d => d.backend));
    config.models = mergeDiscoveredModels(config.models, discovered.flatMap(d => d.models), probed, true);
    return guardAndWrite(deps, config, result, opts, [], undefined);
  }

  // ── 1. Partial-catalog check, BEFORE curation (TL t/3553#5 cond 1; SO e/263#2 baseline) ─────────────
  const authoritative = discovered.filter(d => d.source === 'catalog');
  const partial = authoritative
    .map(d => partialCatalog(d.backend, config.models.filter(m => m.backend === d.backend).map(m => m.id), new Set(d.models.map(m => m.id))))
    .filter((p): p is PartialCatalog => p !== null);
  if (partial.length > 0) return refuse(result, { reason: 'suspected-partial-catalog', backends: partial });

  // ── 1b. A model code still names is gone from its vendor: refuse, no proposal (e/271#12 item 2) ──────
  // After the partial check, so a mass absence still reads as an outage (SO e/271 cond 1).
  const codeReferenced = deps.codeReferencedIds ?? codeReferencedModels.ids;
  const absent = codeReferencedAbsent(codeReferenced, config.models, new Map(authoritative.map(d => [d.backend, new Set(d.models.map(m => m.id))])));
  if (absent.length > 0) return refuse(result, { reason: 'code-referenced-absent', absent });

  // ── 2. Curate authoritative catalogs; a probe is additive only (SO e/263#2 cond 2) ─────────────────
  const pinned = referenceSlots(config, codeReferenced);
  const curated: ModelEntry[] = [];
  const pinnedCandidates: PinnedCandidate[] = [];
  for (const d of authoritative) {
    const { kept, pinnedCandidates: pc } = curateByFamily(d.models, pinned);
    curated.push(...kept);
    pinnedCandidates.push(...pc);
  }
  warnProbeSourced(discovered);
  result.pinnedCandidates = pinnedCandidates;

  // `existing` and probe-sourced backends are non-probed for the replace merge, so they survive untouched;
  // probe-sourced ids are then appended additively.
  const replaced = mergeDiscoveredModels(config.models, curated, new Set(authoritative.map(d => d.backend)), false);
  const merged = mergeDiscoveredModels(replaced, discovered.filter(d => d.source === 'probe').flatMap(d => d.models), new Set(), true);
  const mergedIds = new Set(merged.map(m => m.id));
  const removed = config.models.filter(m => !mergedIds.has(m.id));
  config.models = merged;

  // ── 3. Proposal: every selection-surface change, never applied on its own (TL t/3553#1, CL #2) ───────
  const { changes, autoPrunes } = computeProposal(config, removed);
  const proposal: Proposal = {
    catalogFingerprint: catalogFingerprint(Object.fromEntries(authoritative.map(d => [d.backend, d.models.map(m => m.id)]))),
    hash: proposalHash(changes),
    changes,
  };
  result.proposal = proposal;

  // A dead target in a chain that stays non-empty is already a no-op: pruning it stays automatic, and logged.
  const changedSlots = new Set(changes.map(c => c.slot));
  const resolves = (id: string) => mergedIds.has(id) || KNOWN_VERBATIM.has(id);
  for (const [key, chain] of Object.entries(config.fallbackChains ?? {})) {
    if (!changedSlots.has(`fallbackChains[${key}]`)) config.fallbackChains![key] = chain.filter(resolves);
  }

  if (changes.length === 0) return guardAndWrite(deps, config, result, opts, autoPrunes, undefined);

  // CL p/742#3 enforced, not assumed: a default or tier never changes family through refresh (TL review of #2984).
  const crossFamily = crossFamilyChanges(changes, removed, merged);
  if (crossFamily.length > 0) return refuse(result, { reason: 'cross-family', proposal, slots: crossFamily });

  const unresolved = changes.filter(c => c.to === null).map(c => c.slot);
  if (!opts.accept) {
    return refuse(result, unresolved.length > 0
      ? { reason: 'needs-human', proposal, unresolved }
      : { reason: 'proposal-required', proposal });
  }
  // ── 4. Accept: only the exact proposal, recomputed now (TL t/3553#5 cond 2; SO e/263#4) ─────────────
  // Compared by hash only, not catalogFingerprint: identical changes are exactly what today's catalog proposes, and
  // an unrelated catalog change must not fail an accept (SO e/263#4). Both fingerprints go in the sign-off (TL t/4160).
  const accepted = opts.accept.proposal;
  if (accepted.hash !== proposal.hash || proposalHash(accepted.changes) !== accepted.hash) {
    return refuse(result, { reason: 'proposal-changed', accepted, recomputed: proposal, diff: diffProposals(accepted.changes, changes) });
  }
  if (unresolved.length > 0) return refuse(result, { reason: 'needs-human', proposal, unresolved });
  applyProposal(config, changes);
  return guardAndWrite(deps, config, result, opts, autoPrunes, opts.accept);
}

/** Build the durable sign-off for an accepted proposal (t/4160). */
function signoffRecord(accept: RefreshAccept, proposal: Proposal, at: string): SignoffRecord {
  const slots = proposal.changes.map(c => `${c.slot}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)} (family ${c.family ?? 'none'}, ${c.reason ?? 'vendor-absent'})`);
  // A changed default or debate tier starts a calibration epoch (CL p/742#3).
  const calibrationEpoch = proposal.changes.some(c => c.slot.startsWith('defaults.') || c.slot.startsWith('debateTiers.'));
  return {
    principal: accept.principal,
    approvedBy: accept.approvedBy,
    ...(accept.osUser ? { osUser: accept.osUser } : {}),
    reason: accept.reason,
    proposalHash: proposal.hash,
    catalogFingerprint: proposal.catalogFingerprint,
    reviewedCatalogFingerprint: accept.proposal.catalogFingerprint,
    at,
    slots,
    calibrationEpoch,
  };
}

/**
 * The t/2039 validate-before-write guard, then the write. Every path goes through here, an accepted proposal
 * included (TL t/3553#5 cond 3): accepting can never persist a registry the invariants reject.
 */
function guardAndWrite(
  deps: ModelDiscoveryDeps,
  config: AIModelsConfig,
  result: RefreshResult,
  opts: RefreshOptions,
  autoPrunes: string[],
  accept: RefreshAccept | undefined,
): RefreshResult {
  result.totalModels = config.models.length;
  // Run the invariants IN-PROCESS on the final registry (TL t/2038#1: the pure invariant fns, NOT a shell-out
  // to the verify:config runner, which gates the committed file in CI). If anything dangles or a live
  // non-exempt default is chain-less, REFUSE: ai-models.json stays byte-untouched (the t/2038 corruption class).
  const dangling = findDanglingRefs(config);
  const chainless = findChainlessDefaults(config);
  if (dangling.length > 0 || chainless.length > 0) return refuse(result, { reason: 'invalid', dangling, chainless });

  if (opts.dryRun) {
    result.dryRun = true;
    if (autoPrunes.length > 0) result.configWarning = `Dry run, nothing written. Would apply: ${autoPrunes.join('; ')}.`;
    return result;
  }

  // Clean: persist. Bump lastRefreshed only on the write path, so a refused refresh leaves the timestamp alone.
  config.lastRefreshed = new Date().toISOString();
  const signoff = accept ? signoffRecord(accept, result.proposal!, config.lastRefreshed) : undefined;
  // The record goes in the SAME write as the change it approves (t/4160): never a change without its record.
  if (signoff) config.signoffs = [...(config.signoffs ?? []), signoff];
  saveModelConfig(deps.repoRoot, config);
  result.written = true;
  const notes = [...autoPrunes];
  if (accept && signoff) {
    const { slots, calibrationEpoch } = signoff;
    result.signoff = signoff;
    getGlobalRecorder()?.record({
      type: 'system.info', component: 'model-discovery-refresh', level: 'info',
      message: `ai-models.json: accepted proposal ${result.proposal!.hash} by ${accept.approvedBy} [${accept.principal}] (${accept.reason})${calibrationEpoch ? ' — starts a calibration epoch' : ''}`,
      data: { ...result.signoff },
    });
    notes.push(`applied accepted proposal ${result.proposal!.hash} (${slots.length} slot(s))`);
    // TL #2984 review, cond 3 reading: the in-process guard is only half the gate. The other half runs at commit
    // time, so tell whoever ran the refresh.
    notes.push('ai-models.json was written; `npm run verify:config` must pass before you commit it');
  }
  if (notes.length > 0) result.configWarning = `Refresh repaired config before writing: ${notes.join('; ')}.`;
  console.log(`[ModelDiscovery] Saved ${config.models.length} models to ai-models.json`);
  return result;
}
