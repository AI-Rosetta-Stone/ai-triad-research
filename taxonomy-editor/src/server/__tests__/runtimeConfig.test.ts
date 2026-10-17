// @vitest-environment node

/**
 * t/926 — runtimeConfig core module: validateAndMerge, getDefaults, getConfig,
 * forceReload. The file is optional and does not exist in the test data root,
 * so getConfig()/forceReload() exercise the ENOENT → defaults fail-safe.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  validateAndMerge, getDefaults, getConfig, forceReload,
  getConfigState, writeConfig, diffFromDefaults, getClientConfig,
  type RuntimeConfig,
} from '../runtimeConfig.js';
import { log } from '../logger.js';

const defaults = (): RuntimeConfig => getDefaults();

describe('getDefaults (t/926)', () => {
  it('returns the documented defaults', () => {
    const d = getDefaults();
    expect(d.resilience.circuitThreshold).toBe(5);
    expect(d.resilience.throttleEnterFactor).toBe(2.0);
    expect(d.tiers.free.pinnedModel).toBe('gemini-3.5-flash-lite'); // = DEFAULT_MODEL (t/2687)
    // t/1513: platform/byok expose every system backend; key-presence gates real availability.
    expect(d.tiers.platform.allowedBackends).toEqual(['gemini', 'claude', 'groq', 'openai', 'deepseek', 'azure', 'zai', 'moonshot', 'xai', 'ollama']);
    expect(d.tiers.byok.allowedBackends).toEqual(['gemini', 'claude', 'groq', 'openai', 'deepseek', 'azure', 'zai', 'moonshot', 'xai', 'ollama']);
    expect(d.tiers.anonymous.allowedBackends).toEqual(['gemini', 'claude', 'groq']); // intentionally limited (no user keys)
    expect(d.flightRecorder.maxTotalDumpSizeBytes).toBe(52_428_800);
    expect(d.server.gitFetchTimeoutMs).toBe(600_000);
  });

  it('returns a deep copy — mutating the result does not leak into the next call', () => {
    const a = getDefaults();
    a.resilience.circuitThreshold = 999;
    a.tiers.free.allowedBackends.push('groq');
    const b = getDefaults();
    expect(b.resilience.circuitThreshold).toBe(5);
    expect(b.tiers.free.allowedBackends).toEqual(['gemini']);
  });
});

describe('validateAndMerge — happy paths (t/926 AC#4)', () => {
  it('a valid full config passes through unchanged with no errors', () => {
    const { config, errors } = validateAndMerge(getDefaults(), defaults());
    expect(errors).toEqual([]);
    expect(config).toEqual(getDefaults());
  });

  it('a partial config deep-merges over defaults', () => {
    const { config, errors } = validateAndMerge(
      { resilience: { circuitThreshold: 8 }, quotas: { defaultMaxChats: 40 } },
      defaults(),
    );
    expect(errors).toEqual([]);
    expect(config.resilience.circuitThreshold).toBe(8);
    expect(config.resilience.circuitCooldownMs).toBe(60_000); // untouched default
    expect(config.quotas.defaultMaxChats).toBe(40);
    expect(config.quotas.defaultMaxDebates).toBe(15); // untouched default
    expect(config.tiers.platform.requestsPerMinute).toBe(60); // untouched section
  });

  it('accepts a config tagged with _meta.version 1', () => {
    const { config, errors } = validateAndMerge(
      { _meta: { version: 1, updatedBy: 'jpsnover' }, feedback: { defaultPageLimit: 75 } },
      defaults(),
    );
    expect(errors).toEqual([]);
    expect(config.feedback.defaultPageLimit).toBe(75);
  });
});

describe('validateAndMerge — type & range handling', () => {
  it('falls back to default on wrong type and records an error', () => {
    const { config, errors } = validateAndMerge({ resilience: { circuitThreshold: 'five' } }, defaults());
    expect(config.resilience.circuitThreshold).toBe(5);
    expect(errors.some(e => e.includes('circuitThreshold') && e.includes('expected number'))).toBe(true);
  });

  it('clamps above-max values', () => {
    const { config, errors } = validateAndMerge({ resilience: { circuitThreshold: 99_999 } }, defaults());
    expect(config.resilience.circuitThreshold).toBe(1_000);
    expect(errors.some(e => e.includes('above max'))).toBe(true);
  });

  it('clamps below-min values', () => {
    const { config, errors } = validateAndMerge({ rateLimiting: { windowMs: -5 } }, defaults());
    expect(config.rateLimiting.windowMs).toBe(0);
    expect(errors.some(e => e.includes('below min'))).toBe(true);
  });

  it('rounds non-integer values for integer fields', () => {
    const { config } = validateAndMerge({ resilience: { circuitThreshold: 5.7 } }, defaults());
    expect(config.resilience.circuitThreshold).toBe(6);
  });

  it('caps git timeouts at 1h while general durations allow up to 24h', () => {
    const { config, errors } = validateAndMerge(
      { server: { gitFetchTimeoutMs: 7_200_000 }, sessions: { anonymousTtlMs: 7_200_000 } },
      defaults(),
    );
    expect(config.server.gitFetchTimeoutMs).toBe(3_600_000); // clamped to 1h
    expect(config.sessions.anonymousTtlMs).toBe(7_200_000);   // within 24h, untouched
    expect(errors.some(e => e.includes('gitFetchTimeoutMs') && e.includes('above max'))).toBe(true);
  });
});

describe('validateAndMerge — throttle factors & cross-field rule', () => {
  it('rejects a factor <= 1.0, using the default', () => {
    const { config, errors } = validateAndMerge({ resilience: { throttleEnterFactor: 0.5 } }, defaults());
    expect(config.resilience.throttleEnterFactor).toBe(2.0);
    expect(errors.some(e => e.includes('throttleEnterFactor') && e.includes('> 1.0'))).toBe(true);
  });

  it('reverts the whole resilience section when exitFactor >= enterFactor (AC#4)', () => {
    const { config, errors } = validateAndMerge(
      { resilience: { circuitThreshold: 9, throttleEnterFactor: 2.0, throttleExitFactor: 3.0 } },
      defaults(),
    );
    // Cross-field violation → resilience reverts entirely to defaults (incl. the valid circuitThreshold edit).
    expect(config.resilience).toEqual(getDefaults().resilience);
    expect(config.resilience.circuitThreshold).toBe(5);
    expect(errors.some(e => e.includes('throttleExitFactor') && e.includes('throttleEnterFactor'))).toBe(true);
  });

  it('accepts a valid factor pair (exit < enter)', () => {
    const { config, errors } = validateAndMerge(
      { resilience: { throttleEnterFactor: 4.0, throttleExitFactor: 2.5 } },
      defaults(),
    );
    expect(errors).toEqual([]);
    expect(config.resilience.throttleEnterFactor).toBe(4.0);
    expect(config.resilience.throttleExitFactor).toBe(2.5);
  });
});

describe('validateAndMerge — allowedBackends', () => {
  it('drops unknown backends and records an error', () => {
    const { config, errors } = validateAndMerge(
      { tiers: { platform: { allowedBackends: ['gemini', 'bogus', 'groq'] } } },
      defaults(),
    );
    expect(config.tiers.platform.allowedBackends).toEqual(['gemini', 'groq']);
    expect(errors.some(e => e.includes('dropped') && e.includes('platform'))).toBe(true);
  });

  it('t/1995: emits a runtime warn naming the dropped backend', () => {
    const warnSpy = vi.spyOn(log.server, 'warn').mockImplementation(() => {});
    try {
      validateAndMerge({ tiers: { platform: { allowedBackends: ['gemini', 'bogus', 'groq'] } } }, defaults());
      const call = warnSpy.mock.calls.find(c => typeof c[1] === 'string' && c[1].includes('vBackends'));
      expect(call).toBeDefined();
      expect(String(call?.[1])).toContain("'bogus'");
      expect(String(call?.[1])).toContain('platform');
      expect((call?.[0] as { dropped?: unknown }).dropped).toEqual(['bogus']);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('falls back to default when no known backends remain', () => {
    const { config, errors } = validateAndMerge({ tiers: { free: { allowedBackends: ['bogus'] } } }, defaults());
    expect(config.tiers.free.allowedBackends).toEqual(['gemini']);
    expect(errors.some(e => e.includes('no known backends'))).toBe(true);
  });

  it('falls back to default on an empty array', () => {
    const { config, errors } = validateAndMerge({ tiers: { byok: { allowedBackends: [] } } }, defaults());
    expect(config.tiers.byok.allowedBackends).toEqual(['gemini', 'claude', 'groq', 'openai', 'deepseek', 'azure', 'zai', 'moonshot', 'xai', 'ollama']);
    expect(errors.some(e => e.includes('non-empty array'))).toBe(true);
  });

  it('t/1513: keeps the newer backends (openai/deepseek/zai) on an admin override — no longer dropped as unknown', () => {
    const override = { tiers: { byok: { allowedBackends: ['gemini', 'openai', 'deepseek', 'zai'] } } };
    const { config, errors } = validateAndMerge(override, defaults());
    expect(config.tiers.byok.allowedBackends).toEqual(['gemini', 'openai', 'deepseek', 'zai']);
    expect(errors.some(e => e.includes('dropped') && e.includes('byok'))).toBe(false);
  });
});

describe('validateAndMerge — malformed / forward-compat (AC#4, AC#6)', () => {
  it('returns defaults for a non-object root', () => {
    for (const bad of [null, 42, 'nope', [1, 2, 3]]) {
      const { config, errors } = validateAndMerge(bad, defaults());
      expect(config).toEqual(getDefaults());
      expect(errors.length).toBeGreaterThan(0);
    }
  });

  it('refuses to merge a non-v1 config and uses defaults', () => {
    const { config, errors } = validateAndMerge(
      { _meta: { version: 2 }, quotas: { defaultMaxChats: 99 } },
      defaults(),
    );
    expect(config).toEqual(getDefaults());
    expect(config.quotas.defaultMaxChats).toBe(25); // the v2 edit is ignored
    expect(errors.some(e => e.includes('_meta.version'))).toBe(true);
  });

  it('ignores a wrong-typed section and uses its defaults', () => {
    const { config, errors } = validateAndMerge({ resilience: 'not-an-object' }, defaults());
    expect(config.resilience).toEqual(getDefaults().resilience);
    expect(errors.some(e => e.includes('resilience') && e.includes('expected object'))).toBe(true);
  });

  it('falls back to default for a wrong-typed pinnedModel', () => {
    const { config, errors } = validateAndMerge({ tiers: { free: { pinnedModel: 123 } } }, defaults());
    expect(config.tiers.free.pinnedModel).toBe('gemini-3.5-flash-lite'); // = DEFAULT_MODEL (t/2687)
    expect(errors.some(e => e.includes('pinnedModel'))).toBe(true);
  });
});

describe('getConfig / forceReload — ENOENT fail-safe (t/926 AC#3, AC#6)', () => {
  it('getConfig returns the hardcoded defaults when no config file exists', () => {
    expect(getConfig()).toEqual(getDefaults());
  });

  it('forceReload reports ok:false when falling back to defaults (no file)', () => {
    const result = forceReload();
    expect(result.ok).toBe(false);
  });
});

describe('REST-endpoint support — file round-trip (t/927)', () => {
  let root: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env.AI_TRIAD_DATA_ROOT;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rtcfg-'));
    process.env.AI_TRIAD_DATA_ROOT = root;
    forceReload(); // point the cache at the (empty) temp data root
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.AI_TRIAD_DATA_ROOT;
    else process.env.AI_TRIAD_DATA_ROOT = prevEnv;
    fs.rmSync(root, { recursive: true, force: true });
    forceReload();
  });

  const configFile = () => path.join(root, 'admin', 'runtime-config.json');

  it('getConfigState reports fileExists:false before any write', () => {
    const state = getConfigState();
    expect(state.fileExists).toBe(false);
    expect(state.lastModified).toBeNull();
    expect(state.errors).toEqual([]);
    expect(state.config).toEqual(getDefaults());
    expect(state.defaults).toEqual(getDefaults());
  });

  it('writeConfig persists a valid partial config with refreshed _meta (AC#3)', () => {
    expect(writeConfig({ resilience: { circuitThreshold: 8 } }, 'tester')).toEqual({ ok: true, errors: [] });

    const written = JSON.parse(fs.readFileSync(configFile(), 'utf-8'));
    expect(written._meta.version).toBe(1);
    expect(written._meta.updatedBy).toBe('tester');
    expect(typeof written._meta.updatedAt).toBe('string');
    expect(written.resilience.circuitThreshold).toBe(8);

    const state = getConfigState();
    expect(state.fileExists).toBe(true);
    expect(state.lastModified).not.toBeNull();
    expect(state.config.resilience.circuitThreshold).toBe(8);
    expect(state.config.quotas.defaultMaxChats).toBe(25); // untouched default
  });

  it('writeConfig rejects an out-of-range config, leaving the file untouched (AC#2)', () => {
    const result = writeConfig({ quotas: { defaultMaxChats: 99_999 } }, 'tester');
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('defaultMaxChats'))).toBe(true);
    expect(fs.existsSync(configFile())).toBe(false);
  });

  it('writeConfig rejects a cross-field violation without writing', () => {
    const result = writeConfig({ resilience: { throttleEnterFactor: 2.0, throttleExitFactor: 5.0 } }, 'tester');
    expect(result.ok).toBe(false);
    expect(fs.existsSync(configFile())).toBe(false);
  });

  it('a partial PUT merges over the live config, not defaults', () => {
    expect(writeConfig({ resilience: { circuitThreshold: 8 } }, 'a').ok).toBe(true);
    expect(writeConfig({ quotas: { defaultMaxChats: 40 } }, 'b').ok).toBe(true);
    const state = getConfigState();
    expect(state.config.resilience.circuitThreshold).toBe(8); // preserved from first write
    expect(state.config.quotas.defaultMaxChats).toBe(40);
  });

  it('diffFromDefaults returns only changed leaves', () => {
    expect(diffFromDefaults()).toEqual([]); // no file → nothing differs
    writeConfig({ resilience: { circuitThreshold: 9 } }, 'tester');
    expect(diffFromDefaults()).toEqual([{ path: 'resilience.circuitThreshold', current: 9, default: 5 }]);
  });

  it('getClientConfig exposes only resilience + flightRecorder subset + analytics + debate + pollGate (AC#5)', () => {
    const client = getClientConfig();
    expect(Object.keys(client).sort()).toEqual(['analytics', 'debate', 'flightRecorder', 'pollGate', 'resilience']);
    expect(Object.keys(client.flightRecorder).sort()).toEqual(['dumpWindowMs', 'maxDumpsPerWindow', 'minDumpIntervalMs']);
    expect(Object.keys(client.analytics)).toEqual(['bufferRequeueLimit', 'IDLE_TIMEOUT_MS', 'MAX_ENGAGED_MS', 'ENGAGED_MIN_MS', 'MIN_VISIT_MS', 'PULSE_THROTTLE_MS', 'IDLE_GRACE_MS', 'CREDIT_WINDOW_MS']);
    expect(client.resilience.circuitThreshold).toBe(5);
    expect(client.debate).toEqual({
      defaultConfrontationRounds: 1, defaultArgumentationRounds: 2, defaultConcludingRounds: 1,
      defaultTemperature: 0.7, briefStageTemperature: 0.15, planStageTemperature: 0.4,
      draftStageTemperature: 0.7, citeStageTemperature: 0.15, evaluatorTemperature: 0.2,
      summarizationTemperature: 0.3, summarizationMaxTokens: 500, evaluatorMaxTokens: 8192,
      defaultTimeoutMs: 120_000, maxRegenAttempts: 3,
    });
  });

  it('pollGate.enabled defaults to false in GET /api/config/client output (t/4262)', () => {
    expect(getClientConfig().pollGate).toEqual({ enabled: false });
  });

  it('setting pollGate.enabled true in runtime config is reflected in getClientConfig (t/4262)', () => {
    writeConfig({ pollGate: { enabled: true } }, 'tester');
    expect(getClientConfig().pollGate).toEqual({ enabled: true });
  });
});
