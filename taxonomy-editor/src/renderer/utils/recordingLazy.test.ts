// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const recordSpy = vi.fn();
vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: recordSpy }),
}));

import { probeModule, recordModuleFetchFailure, recordingLazy, recordingLoader } from './recordingLazy';
import { probeLazyGraph, shouldReloadOnce } from './lazyModuleProbe';

const URL = 'http://127.0.0.1:5173/src/renderer/components/debate/DebateTab.tsx';

function mockFetchOnce(impl: () => Promise<Response> | Response) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(impl())));
}

beforeEach(() => {
  recordSpy.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeModule — t/2314 disambiguation', () => {
  it('maps a 200 response to a clean status (stale-chunk cold-cache reload signal)', async () => {
    mockFetchOnce(() => ({ ok: true, status: 200, text: async () => '' }) as unknown as Response);
    const probe = await probeModule(URL);
    expect(probe).toEqual({ status: 200, body: null, error: null });
  });

  it('captures the body of a 500 response (Vite compile-error signal)', async () => {
    const compileError = 'Transform failed with 1 error: Unexpected token';
    mockFetchOnce(() => ({ ok: false, status: 500, text: async () => compileError }) as unknown as Response);
    const probe = await probeModule(URL);
    expect(probe.status).toBe(500);
    expect(probe.body).toBe(compileError);
    expect(probe.error).toBeNull();
  });

  it('truncates a large error body to 500 chars', async () => {
    mockFetchOnce(() => ({ ok: false, status: 500, text: async () => 'x'.repeat(2000) }) as unknown as Response);
    const probe = await probeModule(URL);
    expect(probe.body).toHaveLength(500);
  });

  it('maps a fetch rejection to error (crashed / unreachable server signal)', async () => {
    mockFetchOnce(() => Promise.reject(new Error('Failed to fetch')));
    const probe = await probeModule(URL);
    expect(probe).toEqual({ status: null, body: null, error: 'Failed to fetch' });
  });
});

describe('recordModuleFetchFailure', () => {
  it('records a system.error with the module URL parsed from the rejection message', async () => {
    await recordModuleFetchFailure(new TypeError(`Failed to fetch dynamically imported module: ${URL}`));
    expect(recordSpy).toHaveBeenCalledTimes(1);
    const event = recordSpy.mock.calls[0][0];
    expect(event).toMatchObject({
      type: 'system.error',
      component: 'module-loader',
      level: 'error',
      message: `Dynamic import failed: ${URL}`,
    });
    expect(event.data.module_url).toBe(URL);
    expect(event.error).toMatchObject({ name: 'TypeError' });
  });

  it('records a null module_url when the message carries no URL', async () => {
    await recordModuleFetchFailure(new Error('some unrelated failure'));
    const event = recordSpy.mock.calls[0][0];
    expect(event.message).toBe('Dynamic import failed');
    expect(event.data.module_url).toBeNull();
  });

  it('handles a non-Error rejection value', async () => {
    await recordModuleFetchFailure('boom');
    const event = recordSpy.mock.calls[0][0];
    expect(event.error).toMatchObject({ name: 'Error', message: 'boom' });
  });
});

// t/417: the top module URL can answer 200 while one of its own imports fails. The graph probe
// re-imports the lazy module under a fresh query, so the child failure is what gets recorded.
describe('probeLazyGraph — t/417 child-import failure', () => {
  it('reports ok when the module re-imports cleanly', async () => {
    const importer = vi.fn(async () => ({}));
    const probe = await probeLazyGraph(URL, importer);
    expect(probe).toEqual({ graph_ok: true, graph_error: null, child_url: null });
    expect(importer.mock.calls[0][0]).toMatch(/DebateTab\.tsx\?fr-probe=\d+$/);
  });

  it('names the failing child import when the top module answers 200 but a dep fails', async () => {
    const childError = 'Failed to fetch dynamically imported module: http://127.0.0.1:5173/node_modules/.vite/deps/react-markdown.js?v=abc';
    const probe = await probeLazyGraph(URL, async () => { throw new TypeError(childError); });
    expect(probe.graph_ok).toBe(false);
    expect(probe.child_url).toBe('http://127.0.0.1:5173/node_modules/.vite/deps/react-markdown.js?v=abc');
  });

  it('reports an outdated optimized dep as a failure with no child URL', async () => {
    const probe = await probeLazyGraph(URL, async () => { throw new Error('Outdated Optimize Dep'); });
    expect(probe.graph_ok).toBe(false);
    expect(probe.graph_error).toBe('Outdated Optimize Dep');
    expect(probe.child_url).toBeNull();
  });
});

describe('shouldReloadOnce — t/417 reload-once guard', () => {
  function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } };
  }

  it('allows one reload per module URL, then stops', () => {
    const storage = memoryStorage();
    expect(shouldReloadOnce(URL, storage)).toBe(true);
    expect(shouldReloadOnce(URL, storage)).toBe(false);
    expect(shouldReloadOnce(URL + '?x=1', storage)).toBe(true);
  });

  it('does not reload when storage is unavailable, so a broken module cannot loop', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(shouldReloadOnce(URL, broken)).toBe(false);
  });
});

describe('recordingLazy — t/417 reload once on a failed lazy import', () => {
  it('drives the real loader: reloads the window once for a dynamic-import failure, not again on the next', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    sessionStorage.clear();
    const failing = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: ' + URL));
    // recordingLoader is the exact function recordingLazy passes to React.lazy.
    const wrapped = recordingLoader(failing as never);
    await expect(wrapped()).rejects.toThrow();
    await expect(wrapped()).rejects.toThrow();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(shouldReloadOnce(URL, window.sessionStorage)).toBe(false);
    vi.unstubAllGlobals();
  });
});
