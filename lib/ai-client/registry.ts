// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ActionableError } from '../debate/errors.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';
import type { BackendId, ModelCapabilities, TokenUsage } from './types.js';

export interface ModelEntry {
  id: string;
  apiModelId: string;
  label: string;
  backend: string;
  /** Reasoning models that reject arbitrary temperature (e.g. moonshot kimi-k3, which
   *  only accepts 1) — when set, the provider MUST send exactly this value (t/2068). */
  fixedTemperature?: number;
  /** Per-model minimum timeout FLOOR in ms — a MODEL property: "how slow is this model?" It can
   *  only RAISE an effective timeout, never shorten one (floor semantics — SO e/184#2 condition 1;
   *  getDefaultTimeout / getModelMinTimeout apply Math.max). This is DISTINCT from a STAGE timeout
   *  such as the debate opening-brief's DEFAULT_BRIEF_TIMEOUT_MS ("how large is this stage's
   *  prompt?"): the two compose via Math.max (a slow model on a big stage gets the larger) and must
   *  NOT be merged — folding a stage default (e.g. the 120s brief floor) into this field would
   *  over-broaden it to EVERY call of that model (t/3518 Phase 2, TL e/185#8). Replaces the
   *  'opus'/'fable' substring checks that lived outside the registry (t/3518). */
  minTimeoutMs?: number;
  /** Present iff the model is user-selectable in the UI picker (t/3555 reachability signal). */
  picker?: { label: string; order: number };
  /** True for models that think by default (extended reasoning, t/4117). These produce verbose
   *  structured JSON and require a larger output budget for debate openings.
   *  Absent = not a thinking model (registry-authoritative; no substring fallback when present). */
  thinks_by_default?: boolean;
}

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M?: number;
}

export interface ModelRegistry {
  backends: { id: string; label: string }[];
  models: ModelEntry[];
  fallbackChains?: Record<string, string[]>;
  defaults?: Record<string, string>;
  contextWindows?: Record<string, number>;
  debateTiers?: Record<string, Record<string, string>>;
  capabilityDefaults?: Record<string, Partial<ModelCapabilities>>;
  modelCapabilities?: Record<string, Partial<ModelCapabilities>>;
  pricing?: Record<string, ModelPricing>;
}

/** Id prefix -> backend. Every ai-models.json id carries its backend's prefix (checked by registry.test.ts). */
const PREFIX_BACKENDS: readonly (readonly [string, BackendId])[] = [
  ['claude', 'claude'], ['groq', 'groq'], ['openai', 'openai'], ['azure', 'azure'], ['ollama', 'ollama'],
  ['deepseek', 'deepseek'], ['zai', 'zai'], ['moonshot', 'moonshot'], ['xai', 'xai'], ['gemini', 'gemini'],
];

/**
 * The backend an id's prefix names, or `undefined` when no prefix matches. NEVER guesses (t/4101): the old
 * gemini default made any unknown id a gemini call, and that default could flow into key resolution. Use this
 * for estimates (timeouts, capability defaults) that can degrade to "unknown"; use {@link resolveBackend} where
 * the backend routes a request or chooses a key.
 */
export function inferBackend(model: string): BackendId | undefined {
  return PREFIX_BACKENDS.find(([prefix]) => model.startsWith(prefix))?.[1];
}

/**
 * The backend that serves `model`. REGISTRY FIRST (SO e/284#2 cond 3, matching PowerShell's Get-AIModelBackend):
 * when `registry` is given and lists `model`, its entry's backend wins. The prefix is used only for ids the
 * registry doesn't list: the synthesized `*-latest` aliases (buildModelEntryMap) and the vendor-alias passthrough
 * (t/3675). The prefix table's agreement with every registry entry is pinned by a parity test (registry.test.ts).
 * FAILS CLOSED (t/4101): an id that is neither registered nor prefixed throws instead of defaulting to gemini, so
 * an unknown id can't route a request or a key to a provider by accident.
 *
 * `registry` is REQUIRED (t/4196): pass the loaded ai-models.json, or `null` to say "prefix-only, acknowledged"
 * with a one-line reason at the call site. Omitting it used to fall through to the prefix guess silently; making it
 * required lets tsc find every call site that bypasses the registry (the t/4099 / t/4141 class).
 */
export function resolveBackend(model: string, registry: Pick<ModelRegistry, 'models'> | null): BackendId {
  const entry = registry?.models.find((m) => m.id === model);
  if (entry?.backend) return entry.backend as BackendId;
  const backend = inferBackend(model);
  if (backend) return backend;
  throw new ActionableError({
    goal: `Choose the AI backend for model '${model}'`,
    problem: `'${model}' is not in ai-models.json and its prefix names no backend; refusing to guess (t/4101)`,
    location: 'lib/ai-client/registry.ts resolveBackend',
    nextSteps: [
      'Use a model id registered in ai-models.json',
      `Or prefix the id with its backend (${PREFIX_BACKENDS.map(([p]) => p).join(', ')})`,
    ],
  });
}

export function resolveModel(registry: ModelRegistry, friendlyId: string): { apiModelId: string; backend: string; fixedTemperature?: number } {
  const entry = registry.models.find(m => m.id === friendlyId);
  if (entry) return { apiModelId: entry.apiModelId, backend: entry.backend, fixedTemperature: entry.fixedTemperature };

  // Fallback (t/3675): no exact ai-models.json entry. resolveBackend infers the backend from the id
  // prefix and THROWS for an unrecognized prefix (t/4101; it used to default to gemini). A prefixed id is
  // then passed to the provider VERBATIM as the wire model id, so a typo'd, retired, or vendor-alias id
  // (e.g. `gemini-flash-lite-latest`) becomes a real provider call, and the model actually SERVED is not
  // verified here (that is t/3677's job, at the response boundary). Surface that the fallback was taken, per
  // the Fallback-Path Logging rule (root AGENTS.md), mirroring getModelMinTimeout's registry-miss WARN.
  const backend = resolveBackend(friendlyId, null); // null: prefix-only by design, the registry lookup above already missed
  const branch = 'prefix';
  getGlobalRecorder()?.record({
    type: 'system.error',
    component: 'ai-client',
    level: 'warn',
    message: `resolveModel: "${friendlyId}" has no exact ai-models.json entry — resolved by ${branch} to backend '${backend}' and passed through verbatim as the wire model id. The served model is unverified on this path (t/3675; response-boundary identity is t/3677).`,
    data: { friendlyId, branch, backend },
  });
  return { apiModelId: friendlyId, backend };
}

function baseTimeout(backend: string): number {
  switch (backend) {
    case 'ollama':    return 300_000;
    case 'deepseek':  return 180_000;
    case 'openai':    return 180_000;
    case 'azure':     return 180_000;
    case 'claude':    return 180_000;
    case 'groq':      return 120_000;
    case 'zai':       return 300_000;
    case 'moonshot':  return 240_000;
    case 'xai':       return 240_000;
    case 'gemini':    return 120_000;
    default:          return 120_000;
  }
}

/**
 * Returns the default timeout for a model in milliseconds.
 *
 * When a registry is provided, frontier-tier models (those in
 * debateTiers.advanced but NOT in debateTiers.basic for their backend)
 * receive 2× the backend base. Same-model tiers (ollama) are
 * intentionally held at 1× — they have no frontier/basic distinction (t/2495).
 */
/**
 * The per-model minimum-timeout FLOOR (ms) declared in the registry — the concrete entry's
 * `minTimeoutMs`, or 0 if none / no registry (t/3518 Phase 2).
 *
 * Resolves via {@link buildModelEntryMap} (NOT `models.find`): the map also carries the synthesized
 * `*-latest` aliases (highest-versioned entry per family) that `models[]` lacks, so an alias caller
 * (e.g. `claude-opus-latest`) still inherits its concrete entry's floor. A plain `.find()` would miss
 * the alias, silently drop the floor, and re-open t/3518. Rebuild-per-call is deliberate and NOT
 * cached (SO e/184#4): O(n log n) over ~40 models is noise beside the multi-hundred-second call this
 * guards, and caching a map derived from a mutable registry would risk staleness.
 *
 * **Exposed as a primitive** so call sites that pass an EXPLICIT timeout can still enforce the floor.
 * `getDefaultTimeout` applies it for the no-explicit path, but a `?? explicitTimeout` short-circuits
 * `getDefaultTimeout` entirely — the opening-brief stage does exactly this (the t/3518 trigger path).
 * Such sites must floor themselves: `Math.max(explicitTimeout, getModelMinTimeout(model, registry))`.
 */
export function getModelMinTimeout(model: string, registry: ModelRegistry): number {
  // `registry` is REQUIRED (t/3614) — a call site can no longer silently omit it and disable the floor.
  // The guard below is a runtime backstop for any untyped/JS caller that still passes null/undefined.
  if (!registry) {
    // Fallback-path logging (root AGENTS.md): the caller omitted the registry, so NO minTimeoutMs
    // floor can be applied to ANY model on this path — strictly WORSE than the not-found branch below
    // (which affects one model, and already WARNed). This branch was silent until t/3612: the desktop
    // draft path resolved its timeout via `getDefaultTimeout(model)` with no registry, dropped every
    // floor, and left no trace (four dumps to find). The structural fix — removing this optional
    // param so a caller *cannot* omit it — is t/3614; until then, surface that the floor was skipped.
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'ai-client.getModelMinTimeout',
      level: 'warn',
      message: `getModelMinTimeout: no registry provided for model "${model}" — minTimeoutMs floor not applied (0) on this path`,
    });
    return 0;
  }
  const entry = buildModelEntryMap(registry)[model];
  if (!entry) {
    // Fallback-path logging (root AGENTS.md): a registry WAS provided but this model isn't in the
    // map — a dated variant (e.g. `claude-opus-5-20260115`) or an unregistered id. The floor can't
    // be read; surface that rather than silently using 0.
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'ai-client.getModelMinTimeout',
      level: 'warn',
      message: `getModelMinTimeout: no registry entry for model "${model}" — minTimeoutMs floor not applied (0)`,
    });
  }
  return entry?.minTimeoutMs ?? 0;
}

export function getDefaultTimeout(model: string, registry: ModelRegistry): number {
  // An estimate, so an unknown id degrades to the neutral base timeout instead of throwing (t/4101).
  const backend: string = inferBackend(model) ?? 'unknown';
  const base = baseTimeout(backend);
  // Tiered default: 2× base for the advanced-tier model of its backend (advanced ≠ basic); base
  // otherwise, and base when there is no registry / no debateTiers. Line below always runs (no early
  // return), so WITHIN this function the tiered value and the floor compose. But the floor is only
  // EFFECTIVE when a registry is passed: `getDefaultTimeout(model)` with no registry yields
  // Math.max(base, 0) = base — the floor is silently disabled. That is exactly how t/3612 shipped the
  // draft-timeout regression, so this is a caller-breakable invariant, NOT a guaranteed one. The
  // structural fix (required `registry`) is t/3614; `getModelMinTimeout` now WARNs on the no-registry path.
  // NOTE: `registry?.` is load-bearing, NOT dead-defensive (t/3644): getModelMinTimeout keeps a runtime
  // backstop for untyped/JS callers passing null/undefined, and getDefaultTimeout is reached on those same
  // paths — dropping the `?.` here makes it THROW instead of degrading to base. (SO e/194#3 cond.4 suggested
  // tidying this to a plain access; a registry.test backstop case proved that regresses the fail-safe.)
  const advanced = registry?.debateTiers?.['advanced']?.[backend];
  const basic    = registry?.debateTiers?.['basic']?.[backend];
  const tiered = (advanced === model && advanced !== basic) ? base * 2 : base;
  // Apply the per-model floor via the shared primitive (single source of truth). Explicit-timeout sites
  // bypass this function entirely — they must floor via resolveTimeout below (t/3644).
  return Math.max(tiered, getModelMinTimeout(model, registry));
}

/**
 * Resolve the effective request timeout for a call, applying the per-model floor as a HARD minimum.
 *
 * `minTimeoutMs` is a *minimum* — a caller may raise the timeout but must never undercut it. The naive
 * `explicitMs ?? getDefaultTimeout(model, registry)` pattern silently bypassed the floor: an explicit
 * value short-circuited `getDefaultTimeout` (the only place the floor was applied), so a floored model
 * could run below its floor with no signal — the same failure shape as t/3612, one layer up (t/3644).
 * Route every explicit-timeout site through this.
 *
 * Semantics (t/3644 option A): `Math.max(explicit ?? default, floor)`.
 * - No explicit timeout → the (already-floored) tiered default.
 * - Explicit timeout → honoured, so a caller can still tune DOWN toward the default for a fast op — but
 *   never below the model's `minTimeoutMs` floor. Flooring against `getModelMinTimeout` (the true
 *   minimum) rather than `getDefaultTimeout` deliberately preserves legitimate sub-default explicit
 *   timeouts on fast/unfloored paths, while making the floor unbypassable on slow ones (grok-4.7,
 *   claude-*-5, …). No path is shortened below its floor; `Math.max` can only raise.
 */
export function resolveTimeout(explicitMs: number | undefined, model: string, registry: ModelRegistry): number {
  const base = explicitMs ?? getDefaultTimeout(model, registry);
  return Math.max(base, getModelMinTimeout(model, registry));
}

export function parseVersionedModelId(id: string): { family: string; version: number } | null {
  const gemini = id.match(/^(gemini)-(\d+\.\d+)-(.+?)(?:-preview)?$/);
  if (gemini) return { family: `${gemini[1]}-${gemini[3]}`, version: parseFloat(gemini[2]) };
  const claude = id.match(/^(claude-(?:opus|sonnet|haiku|fable))-(\d+(?:-\d+)?)$/);
  if (claude) return { family: claude[1], version: parseFloat(claude[2].replace('-', '.')) };
  return null;
}

/**
 * Non-lossy alternative to {@link buildModelIdMap}.
 *
 * Returns the full `ModelEntry` for every friendly model id the registry
 * exposes, including per-model attributes (fixedTemperature, backend, label, …).
 * Keyed identically to `buildModelIdMap`: explicit model ids from models[],
 * plus synthesized `*-latest` aliases pointing at the highest-versioned entry
 * in each family (so the alias entry carries that entry's fixedTemperature,
 * not a synthetic undefined).
 *
 * No internal caching — call contract is identical to buildModelIdMap.
 * Callers are responsible for caching (cache the map, not the registry).
 *
 * **Mutation hazard**: returned entries are shared references into the registry — treat them as
 * read-only; do not mutate. A synthesized `*-latest` alias and its source id share the same
 * object, so mutating through one mutates the other.
 *
 * **Alias `.id` field**: for a synthesized `*-latest` alias, `entry.id` is the *concrete* model id
 * (e.g. `gemini-flash-latest` → `.id === 'gemini-2.5-flash'`), not the alias key.
 *
 * Migration: `buildModelIdMap(r)[id]` → `buildModelEntryMap(r)[id]?.apiModelId`
 */
export function buildModelEntryMap(registry: ModelRegistry): Record<string, ModelEntry> {
  const map: Record<string, ModelEntry> = {};
  for (const m of registry.models) {
    map[m.id] = m;
  }

  const families = new Map<string, { entry: ModelEntry; version: number }[]>();
  for (const m of registry.models) {
    const parsed = parseVersionedModelId(m.id);
    if (!parsed) continue;
    const latestKey = `${parsed.family}-latest`;
    if (map[latestKey]) continue;
    if (!families.has(latestKey)) families.set(latestKey, []);
    families.get(latestKey)!.push({ entry: m, version: parsed.version });
  }
  for (const [alias, members] of families) {
    if (map[alias]) continue;
    members.sort((a, b) => b.version - a.version);
    map[alias] = members[0].entry;
  }

  return map;
}

/**
 * @deprecated Use {@link buildModelEntryMap} instead — this projection discards
 * per-model attributes (fixedTemperature, …) and cannot carry them to callers.
 * Three breakages traced to this lossy shape: t/2083, t/2068, t/2104.
 */
export function buildModelIdMap(registry: ModelRegistry): Record<string, string> {
  const map: Record<string, string> = {};
  for (const m of registry.models) {
    map[m.id] = m.apiModelId;
  }

  const families = new Map<string, { apiModelId: string; version: number }[]>();
  for (const m of registry.models) {
    const parsed = parseVersionedModelId(m.id);
    if (!parsed) continue;
    const latestKey = `${parsed.family}-latest`;
    if (map[latestKey]) continue;
    if (!families.has(latestKey)) families.set(latestKey, []);
    families.get(latestKey)!.push({ apiModelId: m.apiModelId, version: parsed.version });
  }
  for (const [alias, members] of families) {
    if (map[alias]) continue;
    members.sort((a, b) => b.version - a.version);
    map[alias] = members[0].apiModelId;
  }

  return map;
}

export function getApiModelId(map: Record<string, string>, friendlyId: string): string {
  if (map[friendlyId]) return map[friendlyId];

  if (friendlyId.endsWith('-latest')) {
    const family = friendlyId.slice(0, -'-latest'.length);
    let best: { apiModelId: string; version: number } | null = null;
    for (const key of Object.keys(map)) {
      const parsed = parseVersionedModelId(key);
      if (parsed && parsed.family === family) {
        if (!best || parsed.version > best.version) {
          best = { apiModelId: map[key], version: parsed.version };
        }
      }
    }
    if (best) return best.apiModelId;
  }

  return friendlyId;
}

const SYSTEM_DEFAULTS: ModelCapabilities = {
  supportsTools: true,
  supportsVision: false,
  supportsStreaming: true,
  maxContextTokens: 131072,
};

/**
 * Resolve capabilities for a model. Merges: system defaults < backend defaults < model overrides.
 */
export function getModelCapabilities(registry: ModelRegistry, modelId: string): ModelCapabilities {
  const entry = registry.models.find(m => m.id === modelId);
  // An unknown id gets the plain system defaults, not gemini's (t/4101): claiming vision or a 1M context for a
  // model we can't identify is the guess this ticket removes.
  const backend = entry?.backend ?? inferBackend(modelId);

  const backendDefaults = (backend && registry.capabilityDefaults?.[backend]) || {};
  const modelOverrides = registry.modelCapabilities?.[modelId] ?? {};

  return { ...SYSTEM_DEFAULTS, ...backendDefaults, ...modelOverrides };
}

/**
 * Filter a list of model IDs to those satisfying required capabilities.
 * Only checks boolean capabilities that are explicitly set in `required`.
 */
export function filterByCapabilities(
  registry: ModelRegistry,
  modelIds: string[],
  required: Partial<Pick<ModelCapabilities, 'supportsTools' | 'supportsVision' | 'supportsStreaming'>>,
): string[] {
  return modelIds.filter(id => {
    const caps = getModelCapabilities(registry, id);
    if (required.supportsTools && !caps.supportsTools) return false;
    if (required.supportsVision && !caps.supportsVision) return false;
    if (required.supportsStreaming && !caps.supportsStreaming) return false;
    return true;
  });
}

export type ConfigIssueSeverity = 'warning' | 'info';

export interface ConfigIssue {
  severity: ConfigIssueSeverity;
  /** The offending model id as written in the config. */
  modelId: string;
  /** Dotted path to the config site referencing it (e.g. "debateTiers.advanced.gemini"). */
  referenceSite: string;
  message: string;
}

/**
 * Diagnose model-id references in a registry that do not resolve to a real model.
 *
 * Pure and non-throwing — returns a list of issues rather than failing, because
 * `resolveModel` verbatim passthrough is intentional (un-curated-but-valid provider
 * models such as azure-* BYOK ids legitimately are absent from the curated `models[]`
 * array) and `pricing` is a deliberate superset keyed by apiModelId.
 *
 * - `defaults` / `debateTiers` values that resolve to neither a real model nor a known
 *   `*-latest` alias are flagged `warning` (likely typo or a model that no longer exists).
 * - `pricing` keys with no matching `models[].apiModelId` are flagged `info` (superset,
 *   harmless until a matching model is discovered).
 *
 * Config keys beginning with `_` (e.g. `_comment`) are skipped.
 */
export function validateModelConfig(registry: ModelRegistry): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const idMap = buildModelIdMap(registry);

  const isResolvable = (id: string): boolean => {
    // Known model id, or a synthesized `*-latest` alias present in the map.
    if (idMap[id]) return true;
    // A live `-latest` that getApiModelId can resolve to a real apiModelId.
    return getApiModelId(idMap, id) !== id;
  };

  const checkReference = (id: unknown, site: string): void => {
    if (typeof id !== 'string' || id.length === 0) return;
    if (isResolvable(id)) return;
    issues.push({
      severity: 'warning',
      modelId: id,
      referenceSite: site,
      message: `Model id "${id}" referenced at ${site} does not map to any entry in models[] or a known -latest alias. It would be passed verbatim to the provider API by resolveModel and only fail as a 400 at request time.`,
    });
  };

  if (registry.defaults) {
    for (const [backend, id] of Object.entries(registry.defaults)) {
      if (backend.startsWith('_')) continue;
      checkReference(id, `defaults.${backend}`);
    }
  }

  if (registry.debateTiers) {
    for (const [tier, tierMap] of Object.entries(registry.debateTiers)) {
      if (tier.startsWith('_') || typeof tierMap !== 'object' || tierMap === null) continue;
      for (const [backend, id] of Object.entries(tierMap)) {
        if (backend.startsWith('_')) continue;
        checkReference(id, `debateTiers.${tier}.${backend}`);
      }
    }
  }

  if (registry.pricing) {
    // Pricing is keyed by models[].id (t/3946, SO e/248). Readers resolve to an id first — TS from the
    // model it called, PS from the usage record's modelId or its (backend, apiModelId) pair — so a key
    // that isn't an id is never found. findPricingKeyIssues reports these as warnings in verify:config.
    const knownIds = new Set(registry.models.map(m => m.id));
    for (const key of Object.keys(registry.pricing)) {
      if (key.startsWith('_')) continue;
      if (knownIds.has(key)) continue;
      issues.push({
        severity: 'info',
        modelId: key,
        referenceSite: `pricing.${key}`,
        message: `Pricing entry "${key}" has no matching models[].id. Pricing is keyed by models[].id (t/3946), so no reader resolves this entry.`,
      });
    }
  }

  return issues;
}

/**
 * Opt-in strict gate: throw an {@link ActionableError} if the registry has any
 * `warning`-severity config issue. `info` issues (pricing superset) are ignored.
 *
 * Not wired into the default `loadModelRegistry` path — verbatim passthrough is
 * load-bearing and the current committed config has legitimate warning-free-but-
 * unmapped references. Call this from CI or a `Test-AIModelConfig` cmdlet to fail
 * loud on drift before it reaches production.
 */
export function assertModelConfigValid(registry: ModelRegistry): void {
  const warnings = validateModelConfig(registry).filter(i => i.severity === 'warning');
  if (warnings.length === 0) return;
  const detail = warnings.map(w => `  - ${w.referenceSite} -> "${w.modelId}"`).join('\n');
  throw new ActionableError({
    goal: 'Validate AI model registry configuration',
    problem: `${warnings.length} model id reference(s) do not resolve to a real model or known alias:\n${detail}`,
    location: 'registry.assertModelConfigValid',
    nextSteps: [
      'Fix the typo in ai-models.json, or add the model to the models[] array',
      'If the id is an intentional provider passthrough, confirm the provider accepts it',
      'Run validateModelConfig(registry) to see the full issue list including info-level notes',
    ],
  });
}

/**
 * t/3555 (prevention from t/3551 #24/#28) — every REACHABLE model must declare an EXPLICIT `minTimeoutMs`.
 *
 * A registry refresh imports newly-discovered models with no curated attributes, `minTimeoutMs` among
 * them. For a slow flagship that floor is load-bearing (t/3518): without it `getModelMinTimeout` returns
 * 0, `Math.max(120_000, 0)` yields the short default, and the opening brief times out in a way that reads
 * as a flaky API rather than a config gap. The existing FR WARN at getModelMinTimeout only fires for an
 * UNKNOWN model — a KNOWN model missing the floor is silent (invisible degradation, docs/CodeReview).
 *
 * PRESENCE, not `value > 0` (TL ruling, t/3555#3): an explicit `0` legitimately means "no floor needed"
 * for a fast model and is inert everywhere — `minTimeoutMs` can only RAISE a timeout (Math.max), so `0`
 * never lengthens a deliberate fast-fail (e.g. the crux stage's explicit 15s at extract.ts:510), whereas
 * a bogus 120000 would. The gate checks the KEY is present, so `0` PASSES and the decision is explicit.
 *
 * REACHABILITY, not a family-name list (TL design note): a model is reachable — i.e. a user can actually
 * select it — iff it carries a `picker` field, or is referenced from `defaults` / `debateTiers` /
 * `fallbackChains`. This targets exactly what is selectable, needs no per-family maintenance (the
 * brittleness that produced the Claude-5 picker/union drift), and extends to any future slow model.
 * The exact section list is pinned by a tripwire test (registry.reachableFloor.test.ts) that fails if
 * ai-models.json gains a new top-level section, so "reachable" cannot silently narrow (SO e/207#2 cond 4).
 *
 * PREMISE — "reachable == user-selectable" (SO e/207#2 cond 7): true while the inquiry `models` override
 * (ModelOverrideSchema, lib/inquiry/schema.ts:42-46 — a `z.string()` validated "at the boundary", not yet
 * wired) is unwired. If that boundary ever validates a user override against the FULL registry, then
 * user-selectable becomes all ~130 models, not the ~34 reachable here, and this gate under-covers by the
 * difference. Whoever wires it MUST either restrict the accepted set to reachable models, or extend this
 * predicate to cover whatever the boundary accepts.
 *
 * Pure and non-throwing; unresolved references are {@link validateModelConfig}'s concern, not this gate's.
 */
export function findReachableModelsMissingTimeoutFloor(registry: ModelRegistry): ConfigIssue[] {
  const byId = new Map(registry.models.map((m) => [m.id, m]));
  const issues: ConfigIssue[] = [];
  const seen = new Set<string>();
  const check = (id: unknown, site: string): void => {
    if (typeof id !== 'string' || id.length === 0 || id.startsWith('_')) return;
    const entry = byId.get(id);
    if (!entry) return; // unresolved refs are validateModelConfig's concern, not this gate's
    if (seen.has(id)) return; // report each reachable model once, at its first site
    seen.add(id);
    if (!('minTimeoutMs' in entry)) {
      issues.push({
        severity: 'warning',
        modelId: id,
        referenceSite: site,
        message:
          `Reachable model "${id}" (${site}) has no minTimeoutMs. A user-selectable model must declare an ` +
          `EXPLICIT floor: 0 if the 120s default suffices (a fast model), or the required floor (e.g. 300000 ` +
          `for a slow flagship — t/3518) if its opening brief exceeds 120s. Absent, getModelMinTimeout returns ` +
          `0 silently and the brief times out as a phantom flaky API rather than a visible config gap (t/3551).`,
      });
    }
  };
  forEachReachableReference(registry, check);
  return issues;
}

/**
 * The single definition of "reachable" (user-selectable): every model id referenced from
 * `models[].picker`, `defaults`, `debateTiers` or `fallbackChains`, visited with its reference site.
 * Shared by the timeout-floor gate and the pricing gate (t/3946) so the two can't disagree on what
 * reachable means. The section list is pinned by the tripwire in registry.reachableFloor.test.ts.
 * Values are passed through unvalidated; callers filter non-strings and `_` keys.
 */
export function forEachReachableReference(registry: ModelRegistry, visit: (id: unknown, site: string) => void): void {
  // A model carrying a `picker` field is user-selectable in the UI.
  for (const m of registry.models) if (m.picker) visit(m.id, `models[].picker (${m.id})`);
  if (registry.defaults) {
    for (const [backend, id] of Object.entries(registry.defaults)) {
      if (!backend.startsWith('_')) visit(id, `defaults.${backend}`);
    }
  }
  if (registry.debateTiers) {
    for (const [tier, tierMap] of Object.entries(registry.debateTiers)) {
      if (tier.startsWith('_') || typeof tierMap !== 'object' || tierMap === null) continue;
      for (const [backend, id] of Object.entries(tierMap)) {
        if (!backend.startsWith('_')) visit(id, `debateTiers.${tier}.${backend}`);
      }
    }
  }
  if (registry.fallbackChains) {
    for (const [primary, chain] of Object.entries(registry.fallbackChains)) {
      if (primary.startsWith('_')) continue;
      visit(primary, `fallbackChains.${primary}`);
      if (Array.isArray(chain)) chain.forEach((id, i) => visit(id, `fallbackChains.${primary}[${i}]`));
    }
  }
}

/**
 * Blocking wrapper over {@link findReachableModelsMissingTimeoutFloor} — throws an {@link ActionableError}
 * if any reachable model lacks the floor. Wire from the verify:config family / a test so a registry edit
 * that adds a selectable model without an explicit floor fails loudly at CI, not silently at debate time.
 */
export function assertReachableModelsHaveTimeoutFloor(registry: ModelRegistry): void {
  const missing = findReachableModelsMissingTimeoutFloor(registry);
  if (missing.length === 0) return;
  const detail = missing.map((m) => `  - ${m.referenceSite} -> "${m.modelId}"`).join('\n');
  throw new ActionableError({
    goal: 'Validate that every user-selectable model declares a timeout floor',
    problem: `${missing.length} reachable model(s) in ai-models.json have no minTimeoutMs:\n${detail}`,
    location: 'registry.assertReachableModelsHaveTimeoutFloor',
    nextSteps: [
      'Add "minTimeoutMs": 0 to the model in ai-models.json if the 120s default is enough (a fast model)',
      'Or set the required floor (e.g. 300000 for a slow flagship — see t/3518) if its opening brief exceeds 120s',
      'The value is a MINIMUM applied via Math.max, so 0 is inert and simply records "no floor needed" explicitly',
    ],
  });
}

/**
 * Backends whose provider adapter reports `cachedTokens` (t/3945). Pinned against the provider source
 * by a tripwire test (registry.cachePricing.test.ts): a provider that starts reporting cached tokens
 * must be added here, or the test fails. groq and zai report none, so they're exempt.
 */
export const CACHE_REPORTING_BACKENDS: ReadonlySet<string> = new Set([
  'claude', 'gemini', 'openai', 'deepseek', 'xai', 'moonshot',
]);

/**
 * Pricing entries that need a cache-read price but don't declare one (t/3945). If `cachedInputPer1M`
 * is missing, cost code silently charges cached tokens at the full input rate, which overstates the
 * cost 10× for an ordinary model and 20–40× for Opus 5.5 / Fable 5.1. The convention (t/3945#1) is
 * that every entry on a cache-reporting backend declares a finite NUMBER; "no discount" is written as
 * `cachedInputPer1M === inputPer1M`. Never `null`: the PS cost path tests property presence, so a
 * null would price cached tokens at $0.
 *
 * Keys are `models[].id` (t/3946). A key that is not an id is skipped here; {@link findPricingKeyIssues}
 * reports it. Pure and non-throwing. Reported WARN-only by verify:config (t/3945#3); a blocking flip
 * needs a warn cycle, TL Gate Verification and the mandatory Second Opinion.
 */
export function findPricingMissingCacheRate(registry: ModelRegistry): ConfigIssue[] {
  const byId = new Map(registry.models.map((m) => [m.id, m]));
  const issues: ConfigIssue[] = [];
  for (const [key, p] of Object.entries(registry.pricing ?? {})) {
    if (key.startsWith('_') || typeof p !== 'object' || p === null) continue;
    const model = byId.get(key);
    if (!model || !CACHE_REPORTING_BACKENDS.has(model.backend)) continue;
    if (typeof p.cachedInputPer1M === 'number' && Number.isFinite(p.cachedInputPer1M)) continue;
    issues.push({
      severity: 'warning',
      modelId: key,
      referenceSite: `pricing.${key}`,
      message:
        `Pricing "${key}" (backend ${model.backend}, which reports cached tokens) has no numeric cachedInputPer1M, ` +
        `so cached tokens are costed at the full input rate. Set the provider's cache-read price, or ` +
        `cachedInputPer1M = inputPer1M if it offers no discount. Never null (t/3945#1).`,
    });
  }
  return issues;
}

/**
 * Pricing-key contract gate (t/3946, binding design t/3946#5 after SO e/248). `pricing` is keyed by
 * `models[].id`. Warnings:
 *   - a non-`_` pricing key that is not a `models[].id` (no reader can resolve it);
 *   - a reachable model with no pricing entry (it costs nothing in every report);
 *   - two models sharing a `(backend, apiModelId)` pair (the PS legacy-record map would no longer be a function).
 * Info only: an `apiModelId` shared across backends (azure and openai serve the same GPT wire ids). Neither reader
 * resolves by bare apiModelId any more, so it's not a hazard, but it is why they mustn't.
 * Pure and non-throwing. WARN-only in verify:config.
 */
export function findPricingKeyIssues(registry: ModelRegistry): ConfigIssue[] {
  const ids = new Map(registry.models.map((m) => [m.id, m]));
  const pricing = registry.pricing ?? {};
  const isKey = (k: string) => !k.startsWith('_') && typeof pricing[k] === 'object' && pricing[k] !== null;
  const issues: ConfigIssue[] = [];

  for (const key of Object.keys(pricing)) {
    if (!isKey(key) || ids.has(key)) continue;
    const byApi = registry.models.filter((m) => m.apiModelId === key);
    const hint = byApi.length === 1
      ? ` It matches the apiModelId of "${byApi[0].id}"; re-key it to that id.`
      : byApi.length > 1 ? ` It matches the apiModelId of ${byApi.length} models (${byApi.map((m) => m.id).join(', ')}); price each by its id.` : '';
    issues.push({ severity: 'warning', modelId: key, referenceSite: `pricing.${key}`,
      message: `Pricing key "${key}" is not a models[].id, so no reader resolves it (t/3946).${hint}` });
  }

  const seen = new Set<string>();
  forEachReachableReference(registry, (id, site) => {
    if (typeof id !== 'string' || id.startsWith('_') || !ids.has(id) || seen.has(id)) return;
    seen.add(id);
    if (!isKey(id)) {
      issues.push({ severity: 'warning', modelId: id, referenceSite: site,
        message: `Reachable model "${id}" (${site}) has no pricing entry, so every report costs it at $0 or leaves it out (t/3946). Add pricing.${id} from the provider's live pricing page (explicit 0s for a local model).` });
    }
  });

  // Keyed by JSON.stringify([backend, apiModelId]) so no field value can collide two different pairs,
  // with the fields kept separately for display (no string splitting or replacing).
  const byPair = new Map<string, { backend: string; apiModelId: string; owners: string[] }>();
  const byApiId = new Map<string, Set<string>>();
  for (const m of registry.models) {
    const key = JSON.stringify([m.backend, m.apiModelId]);
    const entry = byPair.get(key) ?? { backend: m.backend, apiModelId: m.apiModelId, owners: [] };
    entry.owners.push(m.id);
    byPair.set(key, entry);
    byApiId.set(m.apiModelId, (byApiId.get(m.apiModelId) ?? new Set()).add(m.backend));
  }
  for (const { backend, apiModelId, owners } of byPair.values()) {
    if (owners.length < 2) continue;
    const pair = `${backend}, ${apiModelId}`;
    issues.push({ severity: 'warning', modelId: owners.join(', '), referenceSite: `models[] (${pair})`,
      message: `Models ${owners.join(', ')} share (backend, apiModelId) = (${pair}). The PS cost report's legacy-record map can't tell them apart (t/3946).` });
  }
  for (const [apiModelId, backends] of byApiId) {
    if (backends.size < 2) continue;
    issues.push({ severity: 'info', modelId: apiModelId, referenceSite: `models[].apiModelId (${apiModelId})`,
      message: `apiModelId "${apiModelId}" is served by ${[...backends].sort().join(' and ')}. Fine while readers resolve by id or (backend, apiModelId), never by bare apiModelId (t/3946).` });
  }
  return issues;
}

/**
 * The pricing key for a model the caller invoked by friendly id (t/3946). Aliases such as
 * `claude-opus-latest` resolve to their concrete entry through {@link buildModelEntryMap}. Returns
 * `undefined` when the model is unknown or has no pricing entry. Never looks up by apiModelId.
 */
export function resolvePricingKey(registry: ModelRegistry, modelId: string): string | undefined {
  const id = buildModelEntryMap(registry)[modelId]?.id ?? modelId;
  const p = registry.pricing?.[id];
  return !id.startsWith('_') && typeof p === 'object' && p !== null ? id : undefined;
}

// Once-per-model WARN for the full-rate fallback in estimateCost (t/3945, Fallback-Path Logging).
const warnedFullRateCacheModels = new Set<string>();

/** Test-only: clear the once-per-model full-rate WARN memo. */
export function _resetCacheRateWarnMemoForTests(): void {
  warnedFullRateCacheModels.clear();
}

function warnFullRateCachedTokens(apiModelId: string, cachedTokens: number): void {
  if (warnedFullRateCacheModels.has(apiModelId)) return;
  warnedFullRateCacheModels.add(apiModelId);
  getGlobalRecorder()?.record({
    type: 'system.error',
    component: 'ai-client.estimateCost',
    level: 'warn',
    message: `estimateCost: pricing for "${apiModelId}" has no cachedInputPer1M — ${cachedTokens} cached tokens costed at the full input rate (overstated). Further occurrences for this model are not logged (t/3945).`,
  });
}

/**
 * Estimated USD cost of one call. `modelId` is the friendly `models[].id` (or alias) the caller
 * invoked, NOT the apiModelId: pricing is keyed by id (t/3946), and an apiModelId can be shared by
 * two backends at different prices (azure and openai GPT models). Returns `undefined` when the model has
 * no pricing entry; callers must count that rather than treat it as $0 (see createAIClient).
 */
export function estimateCost(
  registry: ModelRegistry,
  modelId: string,
  usage: TokenUsage,
): number | undefined {
  const key = resolvePricingKey(registry, modelId);
  if (!key) return undefined;
  const p = registry.pricing![key];
  const inputTokens = usage.promptTokens ?? 0;
  const outputTokens = usage.completionTokens ?? 0;
  const cachedTokens = usage.cachedTokens ?? 0;
  const nonCachedInput = Math.max(0, inputTokens - cachedTokens);
  if (p.cachedInputPer1M == null && cachedTokens > 0) warnFullRateCachedTokens(key, cachedTokens);
  const cachedCost = p.cachedInputPer1M != null
    ? (cachedTokens / 1_000_000) * p.cachedInputPer1M
    : (cachedTokens / 1_000_000) * p.inputPer1M;
  const inputCost = (nonCachedInput / 1_000_000) * p.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * p.outputPer1M;
  return inputCost + cachedCost + outputCost;
}

export function loadModelRegistry(repoRoot: string): ModelRegistry {
  const configPath = path.join(repoRoot, 'ai-models.json');
  if (!fs.existsSync(configPath)) {
    throw new ActionableError({
      goal: 'Load AI model registry',
      problem: `Model registry not found at: ${configPath}`,
      location: 'registry.loadModelRegistry',
      nextSteps: ['Run from the ai-triad-research repo root', 'Check ai-models.json exists'],
    });
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as ModelRegistry;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new ActionableError({
      goal: 'Parse AI model registry',
      problem: `Failed to parse model registry at ${configPath}: ${errMsg}`,
      location: 'registry.loadModelRegistry',
      nextSteps: ['Check ai-models.json for JSON syntax errors'],
      innerError: err,
    });
  }
}
