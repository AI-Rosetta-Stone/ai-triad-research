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

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { generateKeyPairSync } from 'node:crypto';
import { getCredentials } from '../security/githubAppAuth.js';

// One real key for every test: githubAppAuth caches the first private key it loads.
const TEST_PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const ENV_KEYS = ['GITHUB_REPO', 'GITHUB_TOKEN', 'GITHUB_APP_ID', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_APP_PRIVATE_KEY', 'CONTAINER_APP_NAME'];
const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; }
  frRecord.mockClear();
  mockFetch.mockReset();
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
});
