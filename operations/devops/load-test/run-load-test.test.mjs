// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4223 — proof that the editor-profile save sends If-Match from the preceding GET's
// ETag (the fix for #3266's 428 BASE_VERSION_REQUIRED), and that an absent ETag produces
// no If-Match plus a WARN rather than a thrown error. Mocks global.fetch (the driver is
// deliberately dependency-free, built-in fetch only — see run-load-test.mjs's own header
// comment) so no network or staging server is needed. Run:
//   node --test operations/devops/load-test/run-load-test.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timedFetch, editorIteration } from './run-load-test.mjs';

function fakeResponse({ status = 200, etag, body = '{}' } = {}) {
  const headers = new Map();
  if (etag !== undefined && etag !== null) headers.set('etag', etag);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
    text: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

test('timedFetch: captureBody=true returns the body text AND the ETag header', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => fakeResponse({ etag: '"v7"', body: '{"nodes":[]}' });

  const r = await timedFetch('http://x/api/taxonomy/accelerationist', {}, { captureBody: true });
  assert.equal(r.etag, '"v7"');
  assert.equal(r.body, '{"nodes":[]}');
  assert.equal(r.ok, true);
});

test('timedFetch: captureBody=false (default) does not retain the body', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => fakeResponse({ etag: '"v7"', body: '{"nodes":[]}' });

  const r = await timedFetch('http://x/api/taxonomy/accelerationist', {});
  assert.equal(r.body, null);
  assert.equal(r.etag, '"v7"'); // ETag is still captured even when the body isn't (cheap, header-only)
});

test('editorIteration: sends the GET\'s ETag as If-Match on the PUT (t/4223 fix)', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const putCalls = [];
  globalThis.fetch = async (url, init) => {
    if (init && init.method === 'PUT') {
      putCalls.push({ url, headers: init.headers });
      return fakeResponse({ status: 200 });
    }
    // every GET (reader traffic + the editor's own) returns the same ETag/body
    return fakeResponse({ etag: '"rev-42"', body: '{"nodes":["x"]}' });
  };

  // iterationIntervalMsEstimate=120_000 makes a SINGLE call cross the save threshold,
  // instead of needing 120 real calls at the default 1000ms estimate.
  await editorIteration('http://x', 120_000, 'cookie=1');

  assert.equal(putCalls.length, 1, 'expected exactly one PUT (the editor save)');
  assert.equal(putCalls[0].headers['if-match'], '"rev-42"');
  assert.equal(putCalls[0].headers['content-type'], 'application/json');
});

test('editorIteration: no ETag on the GET → PUT sent WITHOUT If-Match, plus a WARN (not a thrown error)', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalStderr = process.stderr.write;
  t.after(() => { globalThis.fetch = originalFetch; process.stderr.write = originalStderr; });

  const putCalls = [];
  let warnedText = '';
  process.stderr.write = (chunk) => { warnedText += String(chunk); return true; };
  globalThis.fetch = async (url, init) => {
    if (init && init.method === 'PUT') {
      putCalls.push({ url, headers: init.headers });
      return fakeResponse({ status: 200 });
    }
    return fakeResponse({ etag: null, body: '{"nodes":["x"]}' }); // pre-#3266 server: no ETag at all
  };

  await editorIteration('http://x', 120_000, 'cookie=1');

  assert.equal(putCalls.length, 1);
  assert.equal('if-match' in putCalls[0].headers, false, 'If-Match must be absent, not an empty string');
  assert.match(warnedText, /WARN editor save:.*no ETag/);
});

test('editorIteration: a 428 on the PUT is still returned as a sample (for runStep to classify, t/4223)', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, init) => {
    if (init && init.method === 'PUT') return fakeResponse({ status: 428 });
    return fakeResponse({ etag: '"stale"', body: '{}' });
  };

  const samples = await editorIteration('http://x', 120_000, 'cookie=1');
  const putSample = samples.find((s) => s.status === 428);
  assert.ok(putSample, 'expected a 428 sample among the returned results');
  assert.equal(putSample.ok, false); // Response.ok is false for 428 — runStep decides it's NOT a generic error
});
