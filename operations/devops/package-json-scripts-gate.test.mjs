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
