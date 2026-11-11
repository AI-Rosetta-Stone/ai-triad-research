// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/244: ci.yml's advisory "Evaluate shared-input coverage" step must never fail the job on a
// crash. On #4922 (run 42839444486) the crash was a rate limit, and the crash handler's own
// comment post hit the same limit and threw out of the handler. This runs the step's real script
// (extracted from ci.yml) against a fake GitHub.
// Run: node --test operations/devops/ci-shared-input-coverage-workflow.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const nodeRequire = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

/** The dedented `script: |` block of the step with this name in ci.yml. */
function extractStepScript(stepName) {
  const lines = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  assert.ok(at >= 0, `ci.yml: no step named "${stepName}"`);
  const start = lines.findIndex((l, i) => i > at && /^\s*script:\s*\|\s*$/.test(l));
  const body = [];
  let indent = null;
  for (const l of lines.slice(start + 1)) {
    if (l.trim() === '') { body.push(''); continue; }
    const ind = l.match(/^ */)[0].length;
    if (indent === null) indent = ind;
    if (ind < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

const SCRIPT = extractStepScript('Evaluate shared-input coverage');
const rateLimited = () => Object.assign(new Error('API rate limit exceeded for installation'), { status: 403 });

async function runStep({ commentsApi }) {
  const log = { warning: [], failed: [], info: [] };
  const posted = [];
  const core = {
    warning: (m) => log.warning.push(String(m)),
    info: (m) => log.info.push(String(m)),
    setFailed: (m) => log.failed.push(String(m)),
    setOutput: () => {},
  };
  const github = {
    paginate: async () => commentsApi(),
    rest: { issues: {
      listComments: () => {},
      createComment: async (p) => { posted.push(p.body); return { data: {} }; },
      updateComment: async (p) => { posted.push(p.body); return { data: {} }; },
    }, pulls: { listFiles: () => {} } },
  };
  const context = { repo: { owner: 'o', repo: 'r' }, payload: { pull_request: { number: 7, base: { ref: 'main' } } } };
  // The crash: the very first thing run() does is `git fetch` the base, so make that throw.
  const fakeRequire = (m) => (m === 'child_process'
    ? { execSync: () => { throw rateLimited(); } }
    : nodeRequire(m));
  let threw = null;
  try {
    await new AsyncFunction('require', 'github', 'context', 'core', 'process', SCRIPT)(fakeRequire, github, context, core, { ...process, env: { ...process.env, GITHUB_WORKSPACE: root } });
  } catch (e) { threw = e; }
  return { threw, log, posted };
}

test('crash + the CANNOT EVALUATE post is ALSO rate-limited: the step still resolves and WARNs twice, never fails', async () => {
  const { threw, log } = await runStep({ commentsApi: () => { throw rateLimited(); } });
  assert.equal(threw, null, `the step threw: ${threw?.message}`);
  assert.equal(log.failed.length, 0);
  assert.ok(log.warning.some((w) => w.startsWith('ci-shared-input-coverage CRASHED:')), 'the crash itself is logged');
  assert.ok(log.warning.some((w) => /could not post the CANNOT EVALUATE comment either/.test(w)), 'the failed post is logged as a WARN');
});

test('crash with a working API: the CANNOT EVALUATE comment is still posted (a crash never reads as clean)', async () => {
  const { threw, posted } = await runStep({ commentsApi: () => [] });
  assert.equal(threw, null);
  assert.equal(posted.length, 1);
  assert.match(posted[0], /ci-shared-input-coverage: CANNOT EVALUATE/);
});
