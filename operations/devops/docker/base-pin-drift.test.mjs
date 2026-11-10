// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Both arms of every decision site in base-pin-drift.mjs (t/255; gate-signal-integrity rule 1).
// Run: node --test operations/devops/docker/base-pin-drift.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseRuntimePin,
  pickLatestDateTag,
  evaluateDrift,
  repinDockerfile,
  repinBranch,
  readLatestFromGhcr,
} from './base-pin-drift.mjs';

const D_OLD = `sha256:${'a'.repeat(64)}`;
const D_NEW = `sha256:${'b'.repeat(64)}`;
const dockerfile = (tag, digest, eol = '\n') =>
  [
    'FROM node:26 AS builder',
    'RUN echo build',
    `FROM ghcr.io/ai-rosetta-stone/ai-triad-base:${tag}@${digest} AS runtime`,
    'USER aitriad',
  ].join(eol);

test('parseRuntimePin: reads the one runtime pin', () => {
  assert.deepEqual(parseRuntimePin(dockerfile('2026-11-08', D_OLD)), { tag: '2026-11-08', digest: D_OLD, lineIndex: 2 });
});

test('parseRuntimePin: null when the pin has no digest, is missing, or appears twice', () => {
  assert.equal(parseRuntimePin('FROM ghcr.io/ai-rosetta-stone/ai-triad-base:2026-11-08 AS runtime'), null);
  assert.equal(parseRuntimePin('FROM node:26 AS runtime'), null);
  assert.equal(parseRuntimePin(`${dockerfile('2026-11-08', D_OLD)}\n${dockerfile('2026-11-09', D_NEW)}`), null);
});

test('parseRuntimePin: the real taxonomy-editor/Dockerfile parses', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const real = fs.readFileSync(path.join(here, '..', '..', '..', 'taxonomy-editor', 'Dockerfile'), 'utf8');
  const pin = parseRuntimePin(real);
  assert.ok(pin, 'runtime FROM line not found in taxonomy-editor/Dockerfile');
  assert.match(pin.tag, /^\d{4}-\d{2}-\d{2}$/);
});

test('pickLatestDateTag: newest date tag; ignores latest and non-date tags; null when none', () => {
  assert.equal(pickLatestDateTag(['latest', '2026-11-01', '2026-11-10', '2026-11-08', 'sha-abc']), '2026-11-10');
  assert.equal(pickLatestDateTag(['latest', 'sha-abc']), null);
  assert.equal(pickLatestDateTag(undefined), null);
});

test('evaluateDrift PASS: same tag, same digest', () => {
  const v = evaluateDrift({ pin: { tag: '2026-11-10', digest: D_OLD }, latest: { tag: '2026-11-10', digest: D_OLD } });
  assert.equal(v.verdict, 'PASS');
});

test('evaluateDrift FAIL: a newer date tag (the 2026-11-08 incident)', () => {
  const v = evaluateDrift({ pin: { tag: '2026-11-01', digest: D_OLD }, latest: { tag: '2026-11-08', digest: D_NEW } });
  assert.equal(v.verdict, 'FAIL');
  assert.match(v.reason, /newer base 2026-11-08/);
});

test('evaluateDrift FAIL: same tag re-pushed with a new digest', () => {
  const v = evaluateDrift({ pin: { tag: '2026-11-10', digest: D_OLD }, latest: { tag: '2026-11-10', digest: D_NEW } });
  assert.equal(v.verdict, 'FAIL');
  assert.match(v.reason, /re-pushed/);
});

test('evaluateDrift GATE-UNREADABLE: no pin, registry error, malformed answer, pin newer than registry', () => {
  const latest = { tag: '2026-11-10', digest: D_NEW };
  const pin = { tag: '2026-11-10', digest: D_OLD };
  assert.equal(evaluateDrift({ pin: null, latest }).verdict, 'GATE-UNREADABLE');
  const e = evaluateDrift({ pin, latest: { error: 'access denied (403): x' } });
  assert.equal(e.verdict, 'GATE-UNREADABLE');
  assert.match(e.reason, /403/);
  assert.equal(evaluateDrift({ pin, latest: null }).verdict, 'GATE-UNREADABLE');
  assert.equal(evaluateDrift({ pin, latest: { tag: '2026-11-10', digest: null } }).verdict, 'GATE-UNREADABLE');
  assert.equal(evaluateDrift({ pin: { tag: '2026-11-12', digest: D_OLD }, latest }).verdict, 'GATE-UNREADABLE');
});

test('repinDockerfile: changes only the runtime FROM line and keeps CRLF', () => {
  const before = dockerfile('2026-11-01', D_OLD, '\r\n');
  const after = repinDockerfile(before, { tag: '2026-11-08', digest: D_NEW });
  const b = before.split('\r\n');
  const a = after.split('\r\n');
  assert.equal(a.length, b.length);
  assert.deepEqual(a.filter((l, i) => l !== b[i]), [`FROM ghcr.io/ai-rosetta-stone/ai-triad-base:2026-11-08@${D_NEW} AS runtime`]);
  assert.deepEqual(parseRuntimePin(after), { tag: '2026-11-08', digest: D_NEW, lineIndex: 2 });
});

test('repinDockerfile: refuses a bad tag, a bad digest, or a file without the pin', () => {
  assert.throws(() => repinDockerfile(dockerfile('2026-11-01', D_OLD), { tag: 'latest', digest: D_NEW }));
  assert.throws(() => repinDockerfile(dockerfile('2026-11-01', D_OLD), { tag: '2026-11-08', digest: 'sha256:xyz' }));
  assert.throws(() => repinDockerfile('FROM node:26', { tag: '2026-11-08', digest: D_NEW }));
});

test('repinBranch: date tag plus a digest prefix, so a same-day re-push gets its own branch', () => {
  assert.equal(repinBranch({ tag: '2026-11-10', digest: D_NEW }), 'docker/base-repin-2026-11-10-bbbbbbbbbbbb');
  assert.notEqual(repinBranch({ tag: '2026-11-10', digest: D_NEW }), repinBranch({ tag: '2026-11-10', digest: D_OLD }));
});

function fakeFetch(routes) {
  return async (url, opts = {}) => {
    const key = `${opts.method || 'GET'} ${url}`;
    const r = routes[key];
    if (!r) throw new Error(`unexpected ${key}`);
    const headers = new Map(Object.entries(r.headers || {}));
    return {
      ok: (r.status || 200) < 400,
      status: r.status || 200,
      statusText: r.statusText || '',
      headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
      json: async () => r.body,
    };
  };
}

const TOKEN_URL = 'GET https://ghcr.io/token?scope=repository:ai-rosetta-stone/ai-triad-base:pull';
const TAGS_URL = 'GET https://ghcr.io/v2/ai-rosetta-stone/ai-triad-base/tags/list?n=1000';

test('readLatestFromGhcr: follows tag pagination and reads the newest tag digest', async () => {
  const f = fakeFetch({
    [TOKEN_URL]: { body: { token: 't' } },
    [TAGS_URL]: {
      body: { tags: ['latest', '2026-11-01'] },
      headers: { link: '</v2/ai-rosetta-stone/ai-triad-base/tags/list?n=1000&last=2026-11-01>; rel="next"' },
    },
    'GET https://ghcr.io/v2/ai-rosetta-stone/ai-triad-base/tags/list?n=1000&last=2026-11-01': { body: { tags: ['2026-11-08'] } },
    'HEAD https://ghcr.io/v2/ai-rosetta-stone/ai-triad-base/manifests/2026-11-08': { headers: { 'docker-content-digest': D_NEW } },
  });
  assert.deepEqual(await readLatestFromGhcr(f), { tag: '2026-11-08', digest: D_NEW });
});

test('readLatestFromGhcr: a 403 becomes a classified error, never a tag', async () => {
  const f = fakeFetch({ [TOKEN_URL]: { body: { token: 't' } }, [TAGS_URL]: { status: 403, statusText: 'Forbidden' } });
  const r = await readLatestFromGhcr(f);
  assert.match(r.error, /access denied \(403\)/);
  assert.equal(evaluateDrift({ pin: { tag: '2026-11-01', digest: D_OLD }, latest: r }).verdict, 'GATE-UNREADABLE');
});

test('readLatestFromGhcr: no date tags is an error, not a pass', async () => {
  const f = fakeFetch({ [TOKEN_URL]: { body: { token: 't' } }, [TAGS_URL]: { body: { tags: ['latest'] } } });
  assert.match((await readLatestFromGhcr(f)).error, /no YYYY-MM-DD tag/);
});
