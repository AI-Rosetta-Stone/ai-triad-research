// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Both arms of the t/4883 guard. Log fixtures are trimmed copies of real BuildKit plain-progress
// output from container.yml runs on 2026-11-05: 41957003986 (the failure), 42000049628 (fresh
// install) and 42003339839 (fully cached rebuild).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findStoreMountsInStage, checkColdStoreLog, decideLogStepOutcome, shouldFallbackFromGha } from './check-dockerfile-store-mounts.mjs';

const MOUNT = 'RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile';

test('lint: flags a pnpm-store cache mount in the builder stage (red)', () => {
  const df = ['FROM node:26 AS builder', 'WORKDIR /build', MOUNT, 'FROM node:26 AS prod-deps', MOUNT].join('\n');
  assert.deepEqual(findStoreMountsInStage(df), [3]);
});

test('lint: a multi-line RUN with the mount on its own line is flagged', () => {
  const df = ['FROM node:26 AS builder', 'RUN --mount=type=cache,target=/root/.local/share/pnpm/store \\', '    npm run build:container'].join('\n');
  assert.deepEqual(findStoreMountsInStage(df), [2]);
});

test('lint: the same mount in another stage (prod-deps) is allowed', () => {
  const df = ['FROM node:26 AS builder', 'RUN pnpm install --frozen-lockfile', 'FROM node:26 AS prod-deps', MOUNT].join('\n');
  assert.deepEqual(findStoreMountsInStage(df), []);
});

test('lint: an apt cache mount in the builder is not a pnpm-store mount', () => {
  const df = ['FROM node:26 AS builder', 'RUN --mount=type=cache,target=/var/cache/apt,sharing=locked apt-get update'].join('\n');
  assert.deepEqual(findStoreMountsInStage(df), []);
});

test('lint: the real taxonomy-editor/Dockerfile on this branch is clean (green)', () => {
  const df = readFileSync(new URL('../../taxonomy-editor/Dockerfile', import.meta.url), 'utf8');
  assert.deepEqual(findStoreMountsInStage(df), []);
});

const INSTALL_CACHED = '#31 [builder 11/25] RUN pnpm install --frozen-lockfile --config.node-linker=isolated\n#31 CACHED';
const INSTALL_FRESH = '#42 [builder 11/25] RUN pnpm install --frozen-lockfile --config.node-linker=isolated\n#42 DONE 0.5s';
const BUILD_RAN_OK = [
  '#56 [builder 25/25] RUN REAL_PNPM="$(which pnpm)" &&     PATH="/tmp:$PATH" npm run build:container',
  '#56 11.10 generate-notices: wrote THIRD-PARTY-NOTICES.txt (320 packages, 124 license blocks).',
  '#56 DONE 30.2s',
].join('\n');
const BUILD_RAN_FAILED = [
  '#56 [builder 25/25] RUN REAL_PNPM="$(which pnpm)" &&     PATH="/tmp:$PATH" npm run build:container',
  '#56 12.76 generate-notices: "pnpm --filter taxonomy-editor licenses list" failed: Command failed: pnpm --filter taxonomy-editor licenses list --prod --json',
  '#56 ERROR: process "/bin/sh -c REAL_PNPM=..." did not complete successfully: exit code: 1',
].join('\n');
const BUILD_CACHED = '#18 [builder 25/25] RUN REAL_PNPM="$(which pnpm)" &&     PATH="/tmp:$PATH" npm run build:container\n#18 CACHED';

test('log: install CACHED + build executed + notices written -> pass', () => {
  assert.equal(checkColdStoreLog(`${INSTALL_CACHED}\n${BUILD_RAN_OK}`).verdict, 'pass');
});

test('log: install CACHED + licenses failed -> fail (the 41957003986 shape)', () => {
  const r = checkColdStoreLog(`${INSTALL_CACHED}\n${BUILD_RAN_FAILED}`);
  assert.equal(r.verdict, 'fail');
  assert.match(r.reason, /regression is back/);
});

test('log: install executed fresh -> inconclusive, never pass (the 42000049628 shape)', () => {
  assert.equal(checkColdStoreLog(`${INSTALL_FRESH}\n${BUILD_RAN_OK}`).verdict, 'inconclusive');
});

test('log: build step itself CACHED -> inconclusive, never pass (the 42003339839 shape)', () => {
  const r = checkColdStoreLog(`${INSTALL_CACHED}\n${BUILD_CACHED}`);
  assert.equal(r.verdict, 'inconclusive');
  assert.match(r.reason, /licenses never ran/);
});

test('log: missing steps -> inconclusive, never pass', () => {
  assert.equal(checkColdStoreLog('#1 [internal] load build definition\n#1 DONE 0.0s').verdict, 'inconclusive');
});

// TL review, t/4902, PR #4642: every arm (GHA-seeded, lockfile self-seed, evicted-cache
// self-seed) must stay BLOCKING and PROVEN -- downgrading inconclusive to a warning would have
// let every dependency-bump PR skip the one check most likely to catch a cold-store break.
test('decideLogStepOutcome: pass is always exit 0, no annotation', () => {
  assert.deepEqual(decideLogStepOutcome('pass'), { exitCode: 0, level: null });
});

test('decideLogStepOutcome: inconclusive blocks by default (no silent pass on any arm)', () => {
  assert.deepEqual(decideLogStepOutcome('inconclusive'), { exitCode: 1, level: 'error' });
});

test('decideLogStepOutcome: fail always blocks -- the real regression is never downgraded', () => {
  assert.deepEqual(decideLogStepOutcome('fail'), { exitCode: 1, level: 'error' });
});

test('decideLogStepOutcome: --advisory softens the annotation only, exit code unchanged', () => {
  assert.deepEqual(decideLogStepOutcome('inconclusive', { advisory: true }), { exitCode: 1, level: 'warning' });
  assert.deepEqual(decideLogStepOutcome('fail', { advisory: true }), { exitCode: 1, level: 'warning' });
});

// shouldFallbackFromGha: ci.yml's first, GHA-seeded attempt probes this to decide whether to
// fall back to the self-seeded local-export path (t/4902 TL review, cache-eviction arm).
test('shouldFallbackFromGha: install CACHED on the GHA attempt -> no fallback needed', () => {
  assert.equal(shouldFallbackFromGha(`${INSTALL_CACHED}\n${BUILD_RAN_OK}`), false);
});

test('shouldFallbackFromGha: install NOT cached (shared-docker evicted/missed) -> fall back', () => {
  assert.equal(shouldFallbackFromGha(`${INSTALL_FRESH}\n${BUILD_RAN_OK}`), true);
});

// The final `log` check doesn't know or care which path produced the log -- a self-seeded
// fallback run (lockfile PR, or eviction) is checked identically and still fails on a real
// licenses regression, proving the fallback arm stays blocking too (TL review point 3).
test('log: a self-seeded fallback run with licenses broken still fails (fallback stays blocking)', () => {
  const r = checkColdStoreLog(`${INSTALL_CACHED}\n${BUILD_RAN_FAILED}`);
  assert.equal(r.verdict, 'fail');
  assert.equal(decideLogStepOutcome(r.verdict).exitCode, 1);
});

test('log: a self-seeded fallback run that proves the warm-layer path passes', () => {
  const r = checkColdStoreLog(`${INSTALL_CACHED}\n${BUILD_RAN_OK}`);
  assert.equal(r.verdict, 'pass');
  assert.equal(decideLogStepOutcome(r.verdict).exitCode, 0);
});
