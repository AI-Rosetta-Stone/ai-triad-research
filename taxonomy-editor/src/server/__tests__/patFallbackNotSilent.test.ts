// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/653 (TL p/102#327): in hosted mode the GitHub App → GITHUB_TOKEN fallback changes the write identity,
 * so it is never silent. A staging container refuses it (null, flight-recorder error); any other hosted
 * container takes it with a WARN and a flight-recorder event. The App path itself is unchanged and quiet.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config.js', () => ({ STORAGE_MODE: 'blob', CACHE_DIR: '/tmp/test-cache' }));

const frRecord = vi.fn();
vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: () => ({ record: frRecord }),
}));

// t/750: spy on the auth log so the suite pins the log line as well as the flight-recorder event.
const { authWarn, authError } = vi.hoisted(() => ({ authWarn: vi.fn(), authError: vi.fn() }));
vi.mock('../logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logger.js')>();
  return { ...actual, log: { ...actual.log, auth: { ...actual.log.auth, warn: authWarn, error: authError } } };
});

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { generateKeyPairSync } from 'node:crypto';
import { getCredentials, resetPatFallbackWarnState, PAT_FALLBACK_WARN_INTERVAL_MS } from '../security/githubAppAuth.js';

// One real key for every test: githubAppAuth caches the first private key it loads.
const TEST_PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const ENV_KEYS = ['GITHUB_REPO', 'GITHUB_TOKEN', 'GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_APP_PRIVATE_KEY', 'CONTAINER_APP_NAME'];
const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; }
  frRecord.mockClear();
  authWarn.mockClear();
  authError.mockClear();
  mockFetch.mockReset();
  resetPatFallbackWarnState();
  process.env.GITHUB_REPO = 'owner/repo';
  process.env.GITHUB_TOKEN = 'pat-env-token';
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
});

const frCalls = () => frRecord.mock.calls.map((c) => c[0] as { level: string; message: string; error: { name: string; message: string } });

describe('t/653: the hosted PAT fallback is never silent', () => {
  it('prod (non-staging hosted): takes the fallback with a flight-recorder WARN naming the reason', async () => {
    process.env.CONTAINER_APP_NAME = 'taxonomy-editor';
    const creds = await getCredentials();
    expect(creds).toEqual({ repo: 'owner/repo', token: 'pat-env-token', mode: 'pat' });
    const calls = frCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe('warn');
    expect(calls[0].error.name).toBe('PatFallbackTaken');
    expect(calls[0].message).toMatch(/fell back from the GitHub App to GITHUB_TOKEN \(GitHub App not configured\)/);
  });

  it('prod: a failed App mint is named as the reason', async () => {
    process.env.CONTAINER_APP_NAME = 'taxonomy-editor';
    process.env.GITHUB_APP_ID = '1';
    process.env.GITHUB_APP_INSTALLATION_ID = '2';
    process.env.GITHUB_APP_PRIVATE_KEY = TEST_PEM;
    mockFetch.mockRejectedValue(new Error('network down'));
    const creds = await getCredentials();
    expect(creds?.mode).toBe('pat');
    expect(frCalls().some((c) => c.error.name === 'PatFallbackTaken' && /mint failed/.test(c.message))).toBe(true);
  });

  it('staging: refuses the fallback and returns null (fail closed), with a flight-recorder error', async () => {
    process.env.CONTAINER_APP_NAME = 'taxonomy-editor-staging';
    const creds = await getCredentials();
    expect(creds).toBeNull();
    const calls = frCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe('error');
    expect(calls[0].error.name).toBe('StagingPatFallbackRefused');
  });

  it('the token value never appears in a flight-recorder event', async () => {
    for (const name of ['taxonomy-editor', 'taxonomy-editor-staging']) {
      frRecord.mockClear();
      process.env.CONTAINER_APP_NAME = name;
      await getCredentials();
      expect(JSON.stringify(frRecord.mock.calls)).not.toContain('pat-env-token');
    }
  });

  it('the App path is unchanged and records nothing', async () => {
    process.env.CONTAINER_APP_NAME = 'taxonomy-editor-staging';
    process.env.GITHUB_APP_ID = '1';
    process.env.GITHUB_APP_INSTALLATION_ID = '2';
    process.env.GITHUB_APP_PRIVATE_KEY = TEST_PEM;
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ token: 'app-install-token', expires_at: new Date(Date.now() + 3600_000).toISOString() }) });
    const creds = await getCredentials();
    expect(creds).toEqual({ repo: 'owner/repo', token: 'app-install-token', mode: 'app' });
    expect(frRecord).not.toHaveBeenCalled();
  });

  it('t/679: 100 fallbacks with the same reason give one report, then one summary with the suppressed count after the interval', async () => {
    process.env.CONTAINER_APP_NAME = 'taxonomy-editor';
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-26T00:00:00Z'));
      for (let i = 0; i < 100; i++) expect((await getCredentials())?.mode).toBe('pat');
      expect(frCalls()).toHaveLength(1);
      vi.setSystemTime(new Date(Date.now() + PAT_FALLBACK_WARN_INTERVAL_MS));
      await getCredentials();
      const calls = frCalls();
      expect(calls).toHaveLength(2);
      expect(calls[1].message).toContain('99 more fallback(s) since the last report');
    } finally {
      vi.useRealTimers();
    }
  });

  it('t/679: a change of reason is reported at once, inside the interval', async () => {
    process.env.CONTAINER_APP_NAME = 'taxonomy-editor';
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 2 * 3600_000); // past any install token an earlier test cached; all 3 calls share this instant
      await getCredentials(); // App not configured: reported
      await getCredentials(); // same reason, same instant: suppressed
      process.env.GITHUB_APP_ID = '1';
      process.env.GITHUB_APP_INSTALLATION_ID = '2';
      process.env.GITHUB_APP_PRIVATE_KEY = TEST_PEM;
      mockFetch.mockRejectedValue(new Error('network down'));
      await getCredentials(); // mint failed: a new reason, same instant
    } finally {
      vi.useRealTimers();
    }
    const calls = frCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1].message).toMatch(/mint failed/);
    // t/750 item 1: one fallback was suppressed under the OLD reason; its count must not ride into the new reason's report.
    expect(calls[1].message).not.toMatch(/more fallback/);
    const warnCalls = authWarn.mock.calls.filter((c) => /FALLBACK taken/.test(String(c[1])));
    expect(warnCalls).toHaveLength(2);
    expect((warnCalls[1][0] as { suppressedSinceLast: number }).suppressedSinceLast).toBe(0);
  });

  it('t/750 item 2: each reported fallback also writes the log.auth.warn line, with the reason and no token', async () => {
    process.env.CONTAINER_APP_NAME = 'taxonomy-editor';
    await getCredentials();
    const lines = authWarn.mock.calls.filter((c) => /FALLBACK taken/.test(String(c[1])));
    expect(lines).toHaveLength(1);
    expect(lines[0][0]).toMatchObject({ reason: 'GitHub App not configured', repo: 'owner/repo', suppressedSinceLast: 0 });
    expect(JSON.stringify(authWarn.mock.calls)).not.toContain('pat-env-token');
  });

  it('t/750 item 2: a suppressed fallback writes no log line, and the staging refusal writes log.auth.error every time', async () => {
    process.env.CONTAINER_APP_NAME = 'taxonomy-editor';
    await getCredentials();
    await getCredentials();
    expect(authWarn.mock.calls.filter((c) => /FALLBACK taken/.test(String(c[1])))).toHaveLength(1);
    process.env.CONTAINER_APP_NAME = 'taxonomy-editor-staging';
    await getCredentials();
    await getCredentials();
    expect(authError.mock.calls.filter((c) => /staging refuses/.test(String(c[1])))).toHaveLength(2);
  });

  it('t/750 item 3: the report interval is pinned at 60 seconds', () => {
    expect(PAT_FALLBACK_WARN_INTERVAL_MS).toBe(60_000);
  });

  it('t/679: the staging refusal is unchanged (every call records an error)', async () => {
    process.env.CONTAINER_APP_NAME = 'taxonomy-editor-staging';
    for (let i = 0; i < 3; i++) expect(await getCredentials()).toBeNull();
    expect(frCalls().filter((c) => c.error.name === 'StagingPatFallbackRefused')).toHaveLength(3);
  });
});
