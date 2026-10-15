// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Server configuration — resolves data paths and settings from environment
 * variables and .aitriad.json without any Electron dependency.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from './logger.js';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Data path resolution ──

interface AiTriadConfig {
  data_root: string;
  sources_root?: string;
  taxonomy_dir: string;
  sources_dir: string;
  summaries_dir: string;
  conflicts_dir: string;
  debates_dir: string;
  queue_file: string;
  version_file: string;
}

// In source: __dirname = .../taxonomy-editor/src/server (3 levels to monorepo root)
// Compiled:  __dirname = .../taxonomy-editor/dist/server (3 levels to monorepo root)
// Container: __dirname = /app/dist/server (2 levels to /app, which has .aitriad.json)
//
// t/2475: resolve by ancestor marker, but PREFER `.aitriad.json` over `scripts/`.
// `.aitriad.json` exists only at the monorepo root (and at /app in the container);
// `scripts/` is AMBIGUOUS because `taxonomy-editor/` has its own `scripts/` dir. A
// single-pass walk that accepted either marker stopped one level short at
// `taxonomy-editor/` in local compiled/dev runs, so getProjectRoot() pointed there
// and the root-only ai-models.json / ai-usages.json failed to load — breaking every
// registry-backed path (non-Gemini /api/ai/chat-stream fallback, /api/ai/generate)
// locally. Prod was unaffected: the container copies `.aitriad.json` + both
// registries to /app at the marker level (taxonomy-editor/Dockerfile). Two-pass
// fixes both: config-marker first; `scripts/` only as a fallback for any layout
// lacking `.aitriad.json`.
//
// Extracted as a pure function so a regression test can drive it with a simulated
// dist layout (PROJECT_ROOT itself is import-time-frozen from the real __dirname).
export function resolveProjectRoot(startDir: string): string {
  const candidates: string[] = [];
  for (let i = 2; i <= 6; i++) candidates.push(path.resolve(startDir, '../'.repeat(i)));
  const byConfig = candidates.find(d => fs.existsSync(path.join(d, '.aitriad.json')));
  if (byConfig) return byConfig;
  const byScripts = candidates.find(d => fs.existsSync(path.join(d, 'scripts')));
  if (byScripts) return byScripts;
  return path.resolve(startDir, '../../..');
}

const PROJECT_ROOT = resolveProjectRoot(__dirname);

const DEFAULT_CONFIG: AiTriadConfig = {
  data_root: '.',
  taxonomy_dir: 'taxonomy/Origin',
  sources_dir: 'sources',
  summaries_dir: 'summaries',
  conflicts_dir: 'conflicts',
  debates_dir: 'debates',
  queue_file: '.summarise-queue.json',
  version_file: 'TAXONOMY_VERSION',
};

let _configCache: AiTriadConfig | null = null;

export function loadDataConfig(): AiTriadConfig {
  if (_configCache) return _configCache;

  const configPath = path.join(PROJECT_ROOT, '.aitriad.json');
  try {
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const merged = { ...DEFAULT_CONFIG, ...raw };
      _configCache = merged;
      log.server.debug({ configPath }, 'Loaded config');
      return merged;
    }
  } catch { /* telemetry — silent by design;  use defaults */ }

  _configCache = DEFAULT_CONFIG;
  return _configCache;
}

export function getDataRoot(): string {
  const envRoot = process.env.AI_TRIAD_DATA_ROOT;
  if (envRoot) return path.resolve(envRoot);

  const config = loadDataConfig();
  return path.isAbsolute(config.data_root)
    ? config.data_root
    : path.resolve(PROJECT_ROOT, config.data_root);
}

export function resolveDataPath(subPath: string): string {
  const dataRoot = getDataRoot();
  return path.isAbsolute(subPath) ? subPath : path.resolve(dataRoot, subPath);
}

/**
 * Writable STATE root for class-A data — feature flags, runtime config, the key store,
 * telemetry, flight-recorder dirs, and calibration logs. Split from the read/grounding
 * data root so a staging deployment cannot mutate prod's shared Azure Files share (t/2643).
 *
 * - `AI_TRIAD_STATE_ROOT` (Bicep-declared on staging) → an isolated, staging-owned RW mount.
 * - Defaults to `getDataRoot()`, so filesystem/Electron and prod behave exactly as before
 *   (prod's state root IS its data root — the shared share, which prod legitimately owns).
 *
 * Grounding/taxonomy READS and read-only provisioned config keep using `getDataRoot()` /
 * `resolveDataPath()` (the shared, read-only mount) — only WRITABLE class-A paths route here.
 * The RO mount is the primary prod-immutability boundary; this split makes staging function
 * within it (t/2643#3).
 */
export function getStateRoot(): string {
  const envRoot = process.env.AI_TRIAD_STATE_ROOT;
  if (envRoot) return path.resolve(envRoot);
  return getDataRoot();
}

/** `resolveDataPath` for the writable state root (t/2643). Use for class-A WRITE paths. */
export function resolveStatePath(subPath: string): string {
  const stateRoot = getStateRoot();
  return path.isAbsolute(subPath) ? subPath : path.resolve(stateRoot, subPath);
}

/**
 * True when this process is the STAGING deployment. ACA auto-injects `CONTAINER_APP_NAME`
 * (drift-proof — set by the platform, not a Bicep env a drift could silently wipe); an
 * explicit `AI_TRIAD_ENV=staging` is accepted as a belt-and-suspenders backstop. Used only
 * by the state-root isolation fail-fast guard (t/2643) — never an auth/security decision.
 */
export function isStagingIdentity(): boolean {
  const appName = process.env.CONTAINER_APP_NAME ?? '';
  return /staging/i.test(appName) || process.env.AI_TRIAD_ENV === 'staging';
}

/**
 * Boot-time fail-fast guard (t/2643, Second Opinion cond. 4): if this is the STAGING
 * deployment but the isolated state root resolves back to the shared data root — i.e.
 * `AI_TRIAD_STATE_ROOT` was wiped by env-var drift (the project's documented incident class)
 * — refuse to start. This converts "staging silently resumes mutating prod's shared share"
 * into a visible boot failure. Called once at server startup. No-op on prod/local (where
 * stateRoot===dataRoot is legitimate — prod owns its share).
 */
export function assertStateRootIsolation(): void {
  if (isStagingIdentity() && getStateRoot() === getDataRoot()) {
    throw new Error(
      'State-root isolation guard failed — refusing to start (t/2643).\n' +
      '  Goal:       keep staging class-A writes off prod\'s shared Azure Files data root.\n' +
      '  Problem:    staging identity detected but AI_TRIAD_STATE_ROOT is unset/equal to the ' +
      'data root, so class-A writes (feature flags, runtime config, keys, calibration) would ' +
      'land on prod\'s shared share.\n' +
      `  Location:   getStateRoot()===getDataRoot()===${getDataRoot()} on ` +
      `${process.env.CONTAINER_APP_NAME ?? '(unknown app)'}.\n` +
      '  Next steps: set AI_TRIAD_STATE_ROOT to the staging-owned RW mount in main.bicep ' +
      '(never via --set-env-vars, which the next Bicep apply wipes — re-arming the hazard).',
    );
  }
}

/**
 * Resolve sources root independently from data root.
 * Priority: AI_TRIAD_SOURCES_ROOT env var > .aitriad.json sources_root > null.
 * Returns null when sources are unavailable (web/container mode, or repo not cloned).
 */
export function getSourcesRoot(): string | null {
  const envRoot = process.env.AI_TRIAD_SOURCES_ROOT;
  if (envRoot) {
    const resolved = path.resolve(envRoot);
    // In API mode the backend handles existence — skip local filesystem check
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- STORAGE_MODE is module-level const, safe at call-time
    return (STORAGE_MODE === 'github-api' || fs.existsSync(resolved)) ? resolved : null;
  }

  const config = loadDataConfig();
  if (config.sources_root) {
    const resolved = path.isAbsolute(config.sources_root)
      ? config.sources_root
      : path.resolve(PROJECT_ROOT, config.sources_root);
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    return (STORAGE_MODE === 'github-api' || fs.existsSync(resolved)) ? resolved : null;
  }

  return null;
}

export function getProjectRoot(): string {
  return PROJECT_ROOT;
}

// ── API key resolution ──

// t/958: derive the key-store backend union from the shared ApiKeyBackend
// (= BackendId | 'tavily') instead of duplicating the literals — so adding a
// backend to BackendId can't silently diverge the server type (the root cause of
// the t/945 build break). ENV_KEY_NAMES below stays Record<AIBackend, string>, so
// tsc flags a missing key-name entry for any newly added backend at compile time.
import type { ApiKeyBackend } from '../../../lib/ai-client/types.js';
export type AIBackend = ApiKeyBackend;

const ENV_KEY_NAMES: Record<AIBackend, string> = {
  gemini: 'GEMINI_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  groq: 'GROQ_API_KEY',
  openai: 'OPENAI_API_KEY',
  tavily: 'TAVILY_API_KEY',
  ollama: '', // local — no key needed
  deepseek: 'DEEPSEEK_API_KEY',
  azure: 'AZURE_OPENAI_API_KEY', // t/945 build-fix; actual Azure-backend wiring owned elsewhere
  zai: 'ZAI_API_KEY',
  moonshot: 'MOONSHOT_API_KEY', // t/1934 build-fix; matches lib/debate/aiAdapter.ts key map
  xai: 'XAI_API_KEY', // t/2583; xAI Grok — matches lib/debate/aiAdapter.ts key map
};

// Imported after AIBackend is defined (keyStore depends on the type).
import { getKeyStore, type KeyRotationResult } from './security/keyStore.js';
import { getCurrentUserId } from './security/userContext.js';
import { resolveGenericFallbackKey, assertKeyForBackend, isKeyRoutingRefusal, LISTING_WARN, GENERIC_FALLBACK_ENV, GENERIC_FALLBACK_BACKEND } from '../../../lib/ai-client/apiKeyFallback.js';

/** The backend's OWN key: its env var, then the keyStore. Never the AI_API_KEY fallback. */
async function ownApiKey(backend: AIBackend): Promise<string | null> {
  const envKey = process.env[ENV_KEY_NAMES[backend]];
  if (envKey) return envKey;

  try {
    // t/835: stored value may be a JSON array of keys — take the first.
    const stored = await getKeyStore(getStateRoot).getKeys(backend, getCurrentUserId());
    if (stored.length > 0) {
      assertKeyForBackend(stored[0], backend, 'stored'); // t/4105 C5: another backend's credential is refused
      return stored[0];
    }
  } catch (err) {
    if (isKeyRoutingRefusal(err)) throw err; // a refusal is not a key-store failure; never swallow it
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'server-config',
      level: 'error',
      message: 'Operation failed',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    log.server.warn({ backend, err }, 'getApiKey failed');
  }
  return null;
}

/**
 * Resolve an API key for the given backend, at CALL time.
 * Priority: backend-specific env var → keyStore (local file or Azure KV) → AI_API_KEY fallback, gemini ONLY (t/4105).
 * For any other backend a set AI_API_KEY throws an ActionableError naming that backend's own variable.
 * Listing contexts (key presence, discovery loops) use {@link getApiKeyForListing}, which softens only that refusal.
 *
 * In Azure (AZURE_KEYVAULT_URL set), keys are partitioned per authenticated
 * user via getCurrentUserId(). Locally, a single shared key is used per backend.
 */
export async function getApiKey(backend: AIBackend = 'gemini'): Promise<string | null> {
  return (await ownApiKey(backend)) ?? resolveGenericFallbackKey(backend) ?? null;
}

/**
 * The key for a LISTING context (status, key presence, discovery loops): same sources as getApiKey, but a
 * non-gemini backend with only AI_API_KEY set reports null ("not configured") instead of throwing
 * (SO e/284#2 cond 1). An operator with only AI_API_KEY then sees gemini configured and nothing fails.
 */
export async function getApiKeyForListing(backend: AIBackend = 'gemini'): Promise<string | null> {
  try {
    return await getApiKey(backend);
  } catch (err) {
    // Soften ONLY the gemini-only refusal, keyed on its kind (SO e/284#10). A foreign-credential refusal surfaces.
    if (!isKeyRoutingRefusal(err, 'AIApiKeyGeminiOnlyRefused')) throw err;
    log.server.warn({ backend }, `${LISTING_WARN}: reporting '${backend}' as not configured`);
    return null;
  }
}

/**
 * All API keys for a backend (t/835), in rotation order. Precedence mirrors
 * getApiKey: a configured env key (platform/free, single) wins; otherwise the
 * user's stored BYOK key list; otherwise the AI_API_KEY fallback (gemini only, t/4105). Returns [] if
 * none. Used by the key rotator for round-robin selection.
 */
export async function getApiKeys(backend: AIBackend = 'gemini'): Promise<string[]> {
  const envKey = process.env[ENV_KEY_NAMES[backend]];
  if (envKey) return [envKey];

  try {
    const stored = await getKeyStore(getStateRoot).getKeys(backend, getCurrentUserId());
    if (stored.length > 0) {
      for (const k of stored) assertKeyForBackend(k, backend, 'stored'); // t/4105 C5
      return stored;
    }
  } catch (err) {
    if (isKeyRoutingRefusal(err)) throw err; // a refusal is not a key-store failure; never swallow it
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'server-config',
      level: 'error',
      message: 'Operation failed',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    log.server.warn({ backend, err }, 'getApiKeys failed');
  }

  const fallback = resolveGenericFallbackKey(backend); // gemini only (t/4105); throws for any other backend
  return fallback ? [fallback] : [];
}

/**
 * Determine the KeySource string for a backend without returning key material (t/4088).
 * Uses the same priority as getApiKey: env var → key store → AI_API_KEY fallback.
 * Returns a value from the closed KeySource vocabulary (see tests/fixtures/ai-call-log/README.md).
 */
export async function getApiKeySource(backend: AIBackend): Promise<string> {
  // Keyless backends (ollama has ENV_KEY_NAMES[backend] === '' which is falsy)
  if (!ENV_KEY_NAMES[backend]) return 'none';
  // Own env var
  const envVarName = ENV_KEY_NAMES[backend];
  if (process.env[envVarName]) return `env:${envVarName}`;
  // Key store (local file or Azure Key Vault)
  try {
    const stored = await getKeyStore(getStateRoot).getKeys(backend, getCurrentUserId());
    if (stored.length > 0) {
      return process.env.AZURE_KEYVAULT_URL ? 'keyvault' : 'store';
    }
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'server-config', level: 'warn',
      message: 'getApiKeySource: key store unavailable — treating source as unknown',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
  // AI_API_KEY fallback (gemini only, t/4102)
  if (backend === GENERIC_FALLBACK_BACKEND && process.env[GENERIC_FALLBACK_ENV]) return `fallback:${GENERIC_FALLBACK_ENV}`;
  return '';
}

/** The user's stored BYOK keys for a backend (t/835) — excludes env/platform
 *  keys; for the Settings key-management list. */
export async function getStoredApiKeys(backend: AIBackend = 'gemini'): Promise<string[]> {
  return getKeyStore(getStateRoot).getKeys(backend, getCurrentUserId());
}

/** Append a BYOK key for a backend (t/835); returns the new key list. */
export async function addApiKey(key: string, backend: AIBackend = 'gemini'): Promise<string[]> {
  return getKeyStore(getStateRoot).addKey(backend, getCurrentUserId(), key);
}

/** Remove the BYOK key at `index` for a backend (t/835); returns the new key list. */
export async function removeApiKey(index: number, backend: AIBackend = 'gemini'): Promise<string[]> {
  return getKeyStore(getStateRoot).removeKey(backend, getCurrentUserId(), index);
}

/** Key PRESENCE (a listing context): never throws, so a non-gemini backend with only AI_API_KEY reads false. */
export async function hasApiKey(backend: AIBackend = 'gemini'): Promise<boolean> {
  return (await getApiKeyForListing(backend)) !== null;
}

export async function storeApiKey(key: string, backend: AIBackend = 'gemini'): Promise<void> {
  await getKeyStore(getStateRoot).set(backend, getCurrentUserId(), key);
}

// ── Paid Gemini fallback key (t/948) ──
// A last-resort Gemini key used ONLY when the entire free-tier pool is rate-
// limited. Stored in the encrypted key store under the reserved `_system`
// partition (admin-registered), or via the GEMINI_PAID_KEY env var. Deliberately
// kept OUT of the free-tier rotation pool — see docs/design/paid-gemini-fallback.md.
const PAID_FALLBACK_PARTITION = '_system';

/** The paid Gemini fallback key (key store `_system` partition first, then
 *  GEMINI_PAID_KEY env var), or null if neither is configured. */
export async function getPaidGeminiFallbackKey(): Promise<string | null> {
  try {
    const stored = await getKeyStore(getStateRoot).getKeys('gemini', PAID_FALLBACK_PARTITION);
    if (stored.length > 0) return stored[0];
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'server-config', level: 'warn',
      message: 'Paid Gemini fallback key store read failed — falling back to env var',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
  return process.env.GEMINI_PAID_KEY?.trim() || null;
}

/** Admin: store the paid Gemini fallback key in the `_system` key-store partition. */
export async function setPaidGeminiFallbackKey(key: string): Promise<void> {
  await getKeyStore(getStateRoot).set('gemini', PAID_FALLBACK_PARTITION, key);
}

/** Admin: remove the stored paid Gemini fallback key (the env-var path, if any, persists). */
export async function deletePaidGeminiFallbackKey(): Promise<void> {
  await getKeyStore(getStateRoot).delete('gemini', PAID_FALLBACK_PARTITION);
}

/** All user-configurable AI backends — iterated by deleteAllApiKeys().
 *  Derived from ENV_KEY_NAMES (the exhaustive Record<AIBackend, string> tsc
 *  enforces) rather than hand-maintained, so a newly added backend can never be
 *  silently missed by delete-all. A hardcoded literal had drifted — it excluded
 *  azure/zai/moonshot, leaving their stored keys behind (t/1954). */
const ALL_AI_BACKENDS = Object.keys(ENV_KEY_NAMES) as AIBackend[];

export async function deleteApiKey(backend: AIBackend = 'gemini'): Promise<void> {
  await getKeyStore(getStateRoot).delete(backend, getCurrentUserId());
}

export async function deleteAllApiKeys(): Promise<void> {
  const store = getKeyStore(getStateRoot);
  const userId = getCurrentUserId();
  await Promise.all(ALL_AI_BACKENDS.map(b => store.delete(b, userId)));
}

/**
 * Rotate the key store's encryption material and re-encrypt all stored keys
 * (t/809). No-op on Key Vault (platform-managed encryption). Admin-triggered.
 */
export async function rotateApiKeyMaterial(): Promise<KeyRotationResult> {
  return getKeyStore(getStateRoot).rotateKeyMaterial();
}

// ── Storage mode ──

export type StorageMode = 'github-api' | 'filesystem';

/** Select backend: explicit STORAGE_MODE env var, or auto-detect from NODE_ENV. */
export const STORAGE_MODE: StorageMode =
  (process.env.STORAGE_MODE === 'github-api' || process.env.STORAGE_MODE === 'filesystem')
    ? process.env.STORAGE_MODE
    : (process.env.NODE_ENV === 'production' ? 'github-api' : 'filesystem');

// t/2061: fall back to AI_TRIAD_DATA_ROOT (the same data root getDataRoot() uses)
// before the homedir default. The container sets AI_TRIAD_DATA_ROOT but not
// TAXONOMY_CACHE_DIR, so CACHE_DIR was defaulting to ~/.cache/taxonomy while the
// data lived at AI_TRIAD_DATA_ROOT — toRepoPath() then couldn't strip the prefix,
// listDirectory returned empty, and isDataAvailable was always false. Keying the
// cache off the data root keeps the two aligned even if the Dockerfile drifts.
// The final homedir default stays a user-private dir (not world-writable /tmp) to
// avoid symlink-race vulns (CodeQL js/insecure-temporary-file); AI_TRIAD_DATA_ROOT
// is an explicit operator-set env var (already resolved at line 80), not a
// hardcoded tmp default, so this fallback does not reintroduce that concern.
export const CACHE_DIR =
  process.env.TAXONOMY_CACHE_DIR || process.env.AI_TRIAD_DATA_ROOT || path.join(os.homedir(), '.cache', 'taxonomy');

// ── Server settings ──

export const PORT = parseInt(process.env.PORT || '7862', 10);

export const EMBED_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'embed_taxonomy.py');
export const SCRIPTS_DIR = path.join(PROJECT_ROOT, 'scripts');
export const BROKER_SCRIPT = path.join(PROJECT_ROOT, 'src', 'main', 'pty-broker.py');
// t/3171 (G8a): the CL-owned grounding reconciler (t/3160/#1736), invoked in scoped mode
// (`--nodes <ids> --apply`) by the inline write-hook after a PUT /api/taxonomy/:pov. Resolved off
// PROJECT_ROOT like EMBED_SCRIPT; the script is stdlib+numpy (present in the web container).
export const RECONCILE_SCRIPT = path.join(PROJECT_ROOT, 'research', 'comp-linguist', 'scripts', 'reconcile_grounding.py');

// t/3183 (t/2977 Item B): per-build capability switch that routes embedding miss-text compute
// off the main thread to the lib/embeddings worker (t/3181). DEFAULT OFF, web-first — when off,
// computeEmbeddings runs the ONNX fallback in-thread exactly as before (byte-identical). Read
// per-call (not a module-load const) so the both-arms liveness test can toggle it around a single
// compute. `EMBEDDING_WORKER_OFFLOAD=1` (or `true`) enables. This is a build/deploy capability, not
// the admin runtime feature-flag surface (feature-flags.json) — the worker's availability is a
// property of the build, and the canary flip is an ops action, not a per-user admin toggle.
export function isEmbeddingWorkerOffloadEnabled(): boolean {
  const v = process.env.EMBEDDING_WORKER_OFFLOAD?.trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** t/3211: desired embedding-worker POOL size (K). DEFAULT 1 → today's single-worker behavior exactly,
 *  so this lands inert until EMBEDDING_WORKER_POOL_SIZE>1 AND a container with spare cores is deployed.
 *  The RAW value is passed to configureEmbeddingWorkerPool, which SELF-CLAMPS to
 *  min(size, availableParallelism()-1) + WARNs (Shared Lib owns the safety) so a mis-set value can never
 *  oversubscribe the main event loop. A non-positive/NaN env → 1. */
export function getEmbeddingWorkerPoolSize(): number {
  const n = Number.parseInt(process.env.EMBEDDING_WORKER_POOL_SIZE ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** t/4177 (scale to N replicas): each replica runs its own in-process RpmLimiter, so the pool's
 *  Gemini RPM must be divided by replica count or N replicas collectively allow N×RPM. DEFAULT 1 —
 *  behavior is unchanged until DevOps sets this alongside the real replica count (t/4181).
 *  TRADE-OFF (TL t/4177#3): dividing at MAX_REPLICAS protects the pool at peak load, but under-uses
 *  it when fewer replicas are actually live — at MAX_REPLICAS=10 with one live replica, that replica
 *  gets RPM/10, so a single user's debate runs ~10× slower than today. Accepted for now (quota safety
 *  over speed; 429 retries soften it). A shared counter (Redis / Durable Object) is the real fix if
 *  this bites — a follow-up, not this ticket. A non-positive/NaN env → 1. */
export function getMaxReplicas(): number {
  const n = Number.parseInt(process.env.MAX_REPLICAS ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

// t/3206 (t/3165 storm-replay canary): per-revision capability switch for the canary loop-lag
// sampler + its two /internal/canary/loop-sampler routes. DEFAULT OFF — when off the routes 404 AND
// the anon-exemption for /internal/canary/* does not exist (double-closed; zero prod exposure).
// DevOps sets it on the isolated STAGING canary revision only (same mechanism as
// EMBEDDING_WORKER_OFFLOAD). Read per-call so route/auth checks see the live value.
export function isCanaryLoopSamplerEnabled(): boolean {
  const v = process.env.CANARY_LOOP_SAMPLER?.trim().toLowerCase();
  return v === '1' || v === 'true';
}

// t/3172 (G8b): per-deploy switch for the scheduled full-taxonomy grounding sweep. DEFAULT OFF —
// when off, startGroundingSweep() never arms its timer (zero behavior). Enable is sequenced behind
// the reconciler tool-lock (t/3194, landed) AND the PS cmdlet lock-honoring (t/3203) with TL
// lock-symmetry sign-off — the SAME lock-symmetry dependency as G8a's grounding_reconcile_inline
// flag (t/3163#1); an unlocked concurrent writer could otherwise lost-update the shared grounding
// file mid-sweep. Read per-call so the enable can be flipped via a revision env without a rebuild.
export function isGroundingSweepEnabled(): boolean {
  const v = process.env.GROUNDING_SWEEP_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true';
}
