// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { create } from 'zustand';
import { bridgeGet, bridgePut, bridgePost } from '../bridge/web-bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { isElectronMode } from '@bridge';

// ── Types mirroring server/runtimeConfig.ts ──

export interface TierConfig {
  requestsPerMinute: number;
  tokensPerDay: number;
  allowedBackends: string[];
}

export interface FreeTierConfig extends TierConfig {
  pinnedModel: string;
}

export interface RuntimeConfig {
  resilience: {
    circuitThreshold: number;
    circuitCooldownMs: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
    retryJitterMaxMs: number;
    maxRetryAfterMs: number;
    throttleWindowSize: number;
    throttleBaselineCount: number;
    throttleEnterFactor: number;
    throttleExitFactor: number;
    throttleDelayMs: number;
  };
  rateLimiting: {
    windowMs: number;
    cleanupCutoffMs: number;
  };
  tiers: {
    platform: TierConfig;
    byok: TierConfig;
    anonymous: TierConfig;
    free: FreeTierConfig;
  };
  quotas: {
    defaultMaxChats: number;
    defaultMaxDebates: number;
  };
  sessions: {
    anonymousTtlMs: number;
    anonymousMaxSessions: number;
    anonymousMaxSizeBytes: number;
    tokenFreshnessThresholdMs: number;
    lockAcquireTimeoutMs: number;
    lockHoldTtlMs: number;
  };
  analytics: {
    retentionDays: number;
    bufferRequeueLimit: number;
  };
  flightRecorder: {
    minDumpIntervalMs: number;
    maxDumpsPerWindow: number;
    dumpWindowMs: number;
    maxRetainedDumps: number;
    maxTotalDumpSizeBytes: number;
  };
  community: {
    maxPendingPerUser: number;
    globalPendingCap: number;
  };
  feedback: {
    defaultPageLimit: number;
    maxPageLimit: number;
  };
  server: {
    conflictsCacheTtlMs: number;
    gitCloneTimeoutMs: number;
    gitFetchTimeoutMs: number;
    gitDefaultTimeoutMs: number;
    gitBufferLimitBytes: number;
    apiKeyMaskLength: number;
  };
  cache: {
    defaultTtlMs: number;
  };
  generation: {
    opedVoiceTimeoutMs: number;
  };
  pollGate: {
    enabled: boolean;
  };
}

export interface ConfigState {
  config: RuntimeConfig;
  defaults: RuntimeConfig;
  errors: string[];
  fileExists: boolean;
  lastModified: string | null;
}

// ── Utilities ──

// Paths come from UI components derived from the fixed RuntimeConfig schema, not from
// untrusted user input — these segments are therefore not currently reachable in practice.
// Guards are colocated with each property write (CodeQL #4927 — js/prototype-pollution-utility).
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  if (parts.some(p => DANGEROUS_KEYS.has(p))) return undefined;
  return parts.reduce<unknown>(
    (cur, key) => (cur != null && typeof cur === 'object') ? (cur as Record<string, unknown>)[key] : undefined,
    obj,
  );
}

export function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  if (parts.some(p => DANGEROUS_KEYS.has(p))) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (cur[key] == null || typeof cur[key] !== 'object') {
      // Object.defineProperty bypasses the [[Set]] protocol and does not invoke the
      // __proto__ setter, satisfying CodeQL js/prototype-pollution-utility (alert #4927).
      Object.defineProperty(cur, key, { value: {}, configurable: true, writable: true, enumerable: true });
    }
    cur = cur[key] as Record<string, unknown>;
  }
  const lastKey = parts[parts.length - 1];
  Object.defineProperty(cur, lastKey, { value, configurable: true, writable: true, enumerable: true });
}

export function countLeafDiffs(a: unknown, b: unknown): number {
  if (a != null && typeof a === 'object' && !Array.isArray(a) &&
      b != null && typeof b === 'object' && !Array.isArray(b)) {
    let count = 0;
    for (const key of Object.keys(a as Record<string, unknown>)) {
      count += countLeafDiffs((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]);
    }
    return count;
  }
  return JSON.stringify(a) !== JSON.stringify(b) ? 1 : 0;
}

function extractValidationErrors(err: unknown): string[] | null {
  if (!err || typeof err !== 'object' || !('problem' in err)) return null;
  const problem = String((err as { problem: unknown }).problem);
  const idx = problem.indexOf('{');
  if (idx < 0) return null;
  try {
    const data = JSON.parse(problem.slice(idx)) as { errors?: unknown };
    if (Array.isArray(data.errors) && data.errors.length > 0) return data.errors.map(String);
  } catch { /* telemetry — silent by design: JSON parse attempt, caller records the error */ }
  return null;
}

// ── Store ──

interface RuntimeConfigStoreState {
  serverState: ConfigState | null;
  draft: RuntimeConfig | null;
  loading: boolean;
  saving: boolean;
  saveErrors: string[];
  fetchError: string | null;

  fetch: () => Promise<void>;
  setField: (path: string, value: unknown) => void;
  resetField: (path: string) => void;
  resetAll: () => void;
  save: () => Promise<boolean>;
  reload: () => Promise<void>;
}

export const useRuntimeConfigStore = create<RuntimeConfigStoreState>((set, get) => ({
  serverState: null,
  draft: null,
  loading: false,
  saving: false,
  saveErrors: [],
  fetchError: null,

  fetch: async () => {
    if (isElectronMode()) return;
    set({ loading: true, fetchError: null });
    try {
      const state = await bridgeGet<ConfigState>('/api/admin/config');
      set({ serverState: state, draft: structuredClone(state.config), loading: false });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'RuntimeConfigPanel', level: 'error',
        message: 'Failed to fetch runtime config',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      set({ loading: false, fetchError: String(err) });
    }
  },

  setField: (path, value) => {
    const { draft } = get();
    if (!draft) return;
    const next = structuredClone(draft);
    setNestedValue(next as unknown as Record<string, unknown>, path, value);
    set({ draft: next });
  },

  resetField: (path) => {
    const { serverState, draft } = get();
    if (!serverState || !draft) return;
    const next = structuredClone(draft);
    setNestedValue(
      next as unknown as Record<string, unknown>,
      path,
      structuredClone(getNestedValue(serverState.defaults, path)),
    );
    set({ draft: next });
  },

  resetAll: () => {
    const { serverState } = get();
    if (!serverState) return;
    set({ draft: structuredClone(serverState.config), saveErrors: [] });
  },

  save: async () => {
    const { draft } = get();
    if (!draft) return false;
    set({ saving: true, saveErrors: [] });
    try {
      await bridgePut('/api/admin/config', draft);
      const state = await bridgeGet<ConfigState>('/api/admin/config');
      set({ serverState: state, draft: structuredClone(state.config), saving: false, saveErrors: [] });
      return true;
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'RuntimeConfigPanel', level: 'error',
        message: 'Failed to save runtime config',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      const errors = extractValidationErrors(err);
      set({ saving: false, saveErrors: errors ?? [String(err)] });
      return false;
    }
  },

  reload: async () => {
    if (isElectronMode()) return;
    set({ loading: true, fetchError: null });
    try {
      await bridgePost('/api/admin/config/reload');
      const state = await bridgeGet<ConfigState>('/api/admin/config');
      set({ serverState: state, draft: structuredClone(state.config), loading: false, saveErrors: [] });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'RuntimeConfigPanel', level: 'error',
        message: 'Failed to reload runtime config',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      set({ loading: false, fetchError: String(err) });
    }
  },
}));
