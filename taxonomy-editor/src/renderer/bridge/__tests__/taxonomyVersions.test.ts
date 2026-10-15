// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4187: the bridge's per-POV version cell, against a fake server that implements the agreed contract: ETag on
// GET and on a successful PUT, If-Match required (428 BASE_VERSION_REQUIRED) and checked (409 WRITE_CONFLICT).

import { describe, it, expect, vi } from 'vitest';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

const { createTaxonomyVersions } = await import('../taxonomyVersions');

interface FakeServer {
  version: number;
  body: unknown;
  /** Headers of every PUT, in arrival order. */
  puts: Array<Record<string, string>>;
  /** Fault switch: omit the ETag on a successful PUT (the "client never learns its new version" arm). */
  omitPutEtag?: boolean;
  /** Another writer lands a change. */
  externalWrite(): void;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function fakeServer(): { server: FakeServer; fetchFn: (path: string, init: RequestInit) => Promise<Response> } {
  const server: FakeServer = {
    version: 1,
    body: { nodes: [] },
    puts: [],
    externalWrite() { server.version += 1; },
  };
  const etag = () => `"v${server.version}"`;
  const fetchFn = async (_path: string, init: RequestInit): Promise<Response> => {
    if ((init.method ?? 'GET') === 'GET') return json(200, server.body, { ETag: etag() });
    const headers = init.headers as Record<string, string>;
    server.puts.push(headers);
    await Promise.resolve(); // let an overlapping save get queued while this one is "in flight"
    const ifMatch = headers['If-Match'];
    if (!ifMatch) return json(428, { code: 'BASE_VERSION_REQUIRED' });
    if (ifMatch !== etag()) return json(409, { code: 'WRITE_CONFLICT' });
    server.version += 1;
    server.body = JSON.parse(init.body as string);
    return json(200, {}, server.omitPutEtag ? {} : { ETag: etag() });
  };
  return { server, fetchFn };
}

describe('taxonomy version cell (t/4187)', () => {
  it('an editor load records the version and the save sends it as If-Match', async () => {
    const { server, fetchFn } = fakeServer();
    const v = createTaxonomyVersions(fetchFn);
    await v.loadForEdit('safetyist');
    await v.save('safetyist', { nodes: [1] });
    expect(server.puts[0]['If-Match']).toBe('"v1"');
  });

  it('two saves in a row from one tab both succeed (the save adopts the returned ETag)', async () => {
    const { server, fetchFn } = fakeServer();
    const v = createTaxonomyVersions(fetchFn);
    await v.loadForEdit('safetyist');
    await v.save('safetyist', { nodes: [1] });
    await v.save('safetyist', { nodes: [1, 2] });
    expect(server.puts.map(h => h['If-Match'])).toEqual(['"v1"', '"v2"']);
    expect(server.body).toEqual({ nodes: [1, 2] });
  });

  it('fault arm: if the new ETag never reaches the client, its second save conflicts with its first', async () => {
    const { server, fetchFn } = fakeServer();
    server.omitPutEtag = true;
    const v = createTaxonomyVersions(fetchFn);
    await v.loadForEdit('safetyist');
    await v.save('safetyist', { nodes: [1] });
    await expect(v.save('safetyist', { nodes: [1, 2] })).rejects.toMatchObject({ code: 'WRITE_CONFLICT', httpStatus: 409 });
  });

  it('overlapping saves (autosave + manual save) are serialized and both succeed', async () => {
    const { server, fetchFn } = fakeServer();
    const v = createTaxonomyVersions(fetchFn);
    await v.loadForEdit('safetyist');
    await Promise.all([v.save('safetyist', { nodes: [1] }), v.save('safetyist', { nodes: [1, 2] })]);
    expect(server.puts.map(h => h['If-Match'])).toEqual(['"v1"', '"v2"']);
    expect(server.body).toEqual({ nodes: [1, 2] });
  });

  it('a failed save does not jam the queue: the next save still goes out', async () => {
    const { server, fetchFn } = fakeServer();
    const v = createTaxonomyVersions(fetchFn);
    await v.loadForEdit('safetyist');
    server.externalWrite();
    await expect(v.save('safetyist', { nodes: [1] })).rejects.toMatchObject({ code: 'WRITE_CONFLICT' });
    await v.loadForEdit('safetyist'); // the reload the conflict message asks for
    await expect(v.save('safetyist', { nodes: [1] })).resolves.toBeUndefined();
  });

  it('another writer landing after the editor load gives WRITE_CONFLICT, not a silent overwrite', async () => {
    const { server, fetchFn } = fakeServer();
    const v = createTaxonomyVersions(fetchFn);
    await v.loadForEdit('safetyist');
    server.externalWrite();
    const err = await v.save('safetyist', { nodes: ['mine'] }).catch(e => e);
    expect(err).toMatchObject({ code: 'WRITE_CONFLICT', httpStatus: 409 });
    expect(err.problem).toMatch(/Someone else changed this file/);
    expect(server.body).toEqual({ nodes: [] });
  });

  it('guard: a plain read of a newer version (the pre-save re-read, a side panel) never advances the cell', async () => {
    const { server, fetchFn } = fakeServer();
    const v = createTaxonomyVersions(fetchFn);
    await v.loadForEdit('safetyist');
    server.externalWrite();
    await v.load('safetyist'); // e.g. reattachStrippedLogicalForms's re-read just before the save
    await expect(v.save('safetyist', { nodes: ['mine'] })).rejects.toMatchObject({ code: 'WRITE_CONFLICT' });
    expect(server.puts[0]['If-Match']).toBe('"v1"');
  });

  it('a refresh (another editor load) resets the cell to the current version', async () => {
    const { server, fetchFn } = fakeServer();
    const v = createTaxonomyVersions(fetchFn);
    await v.loadForEdit('safetyist');
    server.externalWrite();
    await v.loadForEdit('safetyist');
    await v.save('safetyist', { nodes: [1] });
    expect(server.puts[0]['If-Match']).toBe('"v2"');
  });

  it('a 503 VERSION_UNAVAILABLE surfaces its own code and "edits are kept" message, and leaves the cell as it was', async () => {
    const { server, fetchFn } = fakeServer();
    let down = true;
    const v = createTaxonomyVersions(async (path, init) => {
      if ((init.method ?? 'GET') === 'PUT' && down) return json(503, { code: 'VERSION_UNAVAILABLE' });
      return fetchFn(path, init);
    });
    await v.loadForEdit('safetyist');
    const err = await v.save('safetyist', { nodes: ['kept'] }).catch(e => e);
    expect(err).toMatchObject({ code: 'VERSION_UNAVAILABLE', httpStatus: 503 });
    expect(err.problem).toBe('GitHub is unavailable; your edits are kept; try saving again shortly.');
    expect(err.nextSteps.join(' ')).toMatch(/Do not reload/);
    // GitHub is back: the retry still carries the version the editor loaded, so it saves cleanly.
    down = false;
    await expect(v.save('safetyist', { nodes: ['kept'] })).resolves.toBeUndefined();
    expect(server.puts.at(-1)!['If-Match']).toBe('"v1"');
    expect(server.body).toEqual({ nodes: ['kept'] });
  });

  it('with no editor load there is no If-Match, and the 428 surfaces as BASE_VERSION_REQUIRED', async () => {
    const { server, fetchFn } = fakeServer();
    const v = createTaxonomyVersions(fetchFn);
    const err = await v.save('safetyist', { nodes: [1] }).catch(e => e);
    expect(server.puts[0]['If-Match']).toBeUndefined();
    expect(err).toMatchObject({ code: 'BASE_VERSION_REQUIRED', httpStatus: 428 });
    expect(err.problem).toMatch(/Reload to save/);
  });

  it('an editor load without an ETag clears a stale cell instead of keeping it', async () => {
    const { fetchFn } = fakeServer();
    let withEtag = true;
    const puts: Array<Record<string, string>> = [];
    const v = createTaxonomyVersions(async (path, init) => {
      if ((init.method ?? 'GET') === 'PUT') { puts.push(init.headers as Record<string, string>); return json(200, {}); }
      const res = await fetchFn(path, init);
      return withEtag ? res : json(200, await res.json());
    });
    await v.loadForEdit('safetyist');
    withEtag = false;
    await v.loadForEdit('safetyist');
    await v.save('safetyist', { nodes: [] });
    expect(puts[0]['If-Match']).toBeUndefined();
  });

  it('cells are per POV', async () => {
    const { server, fetchFn } = fakeServer();
    const v = createTaxonomyVersions(fetchFn);
    await v.loadForEdit('safetyist');
    await v.save('skeptic', { nodes: [] }).catch(() => undefined);
    expect(server.puts[0]['If-Match']).toBeUndefined();
  });

  it('a non-conflict failure keeps the HTTP status and has no code', async () => {
    const v = createTaxonomyVersions(async () => json(500, { error: 'boom' }));
    const err = await v.save('safetyist', {}).catch(e => e);
    expect(err).toMatchObject({ httpStatus: 500 });
    expect(err.code).toBeUndefined();
  });

  it('an HTML login page is refused, as web-bridge get/put do', async () => {
    const v = createTaxonomyVersions(async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(v.load('safetyist')).rejects.toMatchObject({ problem: expect.stringMatching(/login page/) });
  });
});
