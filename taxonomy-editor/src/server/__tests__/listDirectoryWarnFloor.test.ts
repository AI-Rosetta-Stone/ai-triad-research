// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3300 — listDirectory WARN floor: each of the 3 swallow sites in
// GitHubAPIBackend.listDirectory emits log.server.warn (stdout → Log_s) so
// false-empties are diagnosable in production logs.
//
// TL t/3300#2 non-negotiable: test MUST assert log.server.warn (the real
// stdout sink), NOT getGlobalRecorder().record() (ring buffer / t/3110 trap).
//
// Swallow sites covered:
//   (1) Circuit breaker tripped → WARN cause='circuit-breaker-open'
//   (2) No GitHub credentials → WARN cause='no-credentials'
//   (3) GitHub API non-ok response → WARN cause='api-non-ok'
//   (4) Happy path → no WARN for any of the three causes

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (hoisted before imports) ──

const { serverWarn, mockIsTripped, mockRequest, mockGetCredentials } = vi.hoisted(() => ({
  serverWarn: vi.fn(),
  mockIsTripped: vi.fn().mockReturnValue(false),
  mockRequest: vi.fn(),
  mockGetCredentials: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  log: {
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    server: { info: vi.fn(), warn: serverWarn, error: vi.fn(), debug: vi.fn() },
  },
  getRequestId: () => 'req-test',
  LOG_MAX_LINE_BYTES: 65536,
  writeFramedNdjson: vi.fn(),
}));

vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: vi.fn().mockReturnValue(null),
}));

vi.mock('fs/promises', () => ({
  default: {
    realpath: vi.fn(async (p: string) => p), // t/432: confineToDir resolves real paths
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const src = (actual.default ?? actual) as Record<string, unknown>;
  const patched = {
    ...src,
    promises: { ...(src.promises as object), rename: vi.fn().mockResolvedValue(undefined) },
  };
  return { ...patched, default: patched };
});

vi.mock('../security/githubAppAuth.js', () => ({
  getCredentials: mockGetCredentials,
  getRepoSlug: vi.fn().mockReturnValue('testowner/testrepo'),
  getTokenExpiryMs: vi.fn().mockReturnValue(0),
}));

vi.mock('../storage/githubRestClient.js', () => ({
  GitHubRestClient: class {
    isTripped = mockIsTripped;
    request = mockRequest;
  },
  normalizeErrorForEvent: vi.fn(),
}));

import { GitHubAPIBackend } from '../storage/githubAPIBackend.js';

// ── Helpers ──

const TEST_CREDS = { repo: 'testowner/testrepo', token: 'test-tok', mode: 'pat' as const };

function makeBackend(): GitHubAPIBackend {
  return new GitHubAPIBackend({ cacheDir: '/fake/cache' });
}

function warnCauses(): string[] {
  return serverWarn.mock.calls
    .map(([ctx]: [{ cause?: string }]) => ctx?.cause)
    .filter(Boolean) as string[];
}

// ── Tests ──

describe('listDirectory WARN floor (t/3300)', () => {
  beforeEach(() => {
    serverWarn.mockClear();
    mockIsTripped.mockReturnValue(false);
    mockRequest.mockReset();
    mockGetCredentials.mockReset();
  });

  it('(1) emits log.server.warn with cause=circuit-breaker-open when breaker is tripped', async () => {
    mockIsTripped.mockReturnValue(true);
    const backend = makeBackend();

    const result = await backend.listDirectory('taxonomy');

    expect(result).toEqual([]);
    expect(warnCauses()).toContain('circuit-breaker-open');
    const call = serverWarn.mock.calls.find(([ctx]: [{ cause?: string }]) => ctx?.cause === 'circuit-breaker-open');
    expect(call).toBeDefined();
    expect(call?.[1]).toMatch(/false-empty/);
  });

  it('(2) emits log.server.warn with cause=no-credentials when credentials unavailable', async () => {
    mockIsTripped.mockReturnValue(false);
    mockGetCredentials.mockResolvedValue(null);
    const backend = makeBackend();

    const result = await backend.listDirectory('taxonomy');

    expect(result).toEqual([]);
    expect(warnCauses()).toContain('no-credentials');
    const call = serverWarn.mock.calls.find(([ctx]: [{ cause?: string }]) => ctx?.cause === 'no-credentials');
    expect(call).toBeDefined();
    expect(call?.[1]).toMatch(/false-empty/);
  });

  it('(3) emits log.server.warn with cause=api-non-ok on GitHub API non-ok response', async () => {
    mockIsTripped.mockReturnValue(false);
    mockGetCredentials.mockResolvedValue(TEST_CREDS);
    mockRequest.mockResolvedValue({ ok: false, status: 503, error: 'Service Unavailable' });
    const backend = makeBackend();

    const result = await backend.listDirectory('taxonomy');

    expect(result).toEqual([]);
    expect(warnCauses()).toContain('api-non-ok');
    const call = serverWarn.mock.calls.find(([ctx]: [{ cause?: string }]) => ctx?.cause === 'api-non-ok');
    expect(call).toBeDefined();
    expect(call?.[0]?.status).toBe(503);
    expect(call?.[1]).toMatch(/false-empty/);
  });

  it('(4) happy path — no WARN when listing returns entries', async () => {
    mockIsTripped.mockReturnValue(false);
    mockGetCredentials.mockResolvedValue(TEST_CREDS);
    mockRequest.mockResolvedValue({ ok: true, data: [{ name: 'file1.json' }, { name: 'file2.json' }] });
    const backend = makeBackend();

    const result = await backend.listDirectory('taxonomy');

    expect(result).toContain('file1.json');
    expect(warnCauses().filter(c =>
      c === 'circuit-breaker-open' || c === 'no-credentials' || c === 'api-non-ok',
    )).toHaveLength(0);
  });
});
