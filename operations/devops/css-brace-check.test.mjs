// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/420: the CSS brace check. The fixtures from t/420#1 (balanced, unclosed, extra close, brace in a
// comment, brace in a string), all three verdicts (PASS, FAIL, GATE-UNREADABLE), the warn-only CLI
// (always exit 0, verdict in step outputs and summary), and the ci.yml wiring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { GATE_NAME, checkCssBraces, evaluateCssFiles, runCli } from './css-brace-check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

// ── checkCssBraces: the fixtures ────────────────────────────────────────────────────────────────

test('balanced: nested at-rules pass', () => {
  const css = '.a { color: red; }\n@media (min-width: 1px) {\n  .b { margin: 0; }\n}\n';
  assert.deepEqual(checkCssBraces(css), { ok: true });
});

test('unclosed: reports the line of the innermost open brace', () => {
  const r = checkCssBraces('.a { color: red; }\n@media print {\n  .b {\n    color: blue;\n}\n');
  assert.equal(r.ok, false);
  assert.equal(r.line, 2);
  assert.match(r.problem, /unclosed \{ \(1 still open/);
});

test('extra close: reports the line of the stray }', () => {
  const r = checkCssBraces('.a { color: red; }\n}\n.b { color: blue; }\n');
  assert.deepEqual(r, { ok: false, line: 2, problem: 'unexpected } (no matching {)' });
});

test('brace in a comment is ignored, and line numbers still count comment lines', () => {
  assert.deepEqual(checkCssBraces('/* { not a block\n } */\n.a { color: red; }\n'), { ok: true });
  const r = checkCssBraces('/* line 1\n line 2 { */\n}\n');
  assert.equal(r.line, 3);
});

test('brace in a string is ignored (double and single quotes, escaped quote)', () => {
  assert.deepEqual(checkCssBraces('.a::before { content: "{"; }\n'), { ok: true });
  assert.deepEqual(checkCssBraces(".a::after { content: '}}'; }\n"), { ok: true });
  assert.deepEqual(checkCssBraces('.a::after { content: "\\"{"; }\n'), { ok: true });
});

test('a stray quote ends at the newline and does not swallow the rest of the file', () => {
  const r = checkCssBraces('.a { content: "oops;\n}\n}\n');
  assert.equal(r.ok, false);
  assert.equal(r.line, 3);
});

test('an escaped brace outside a string is not a brace', () => {
  assert.deepEqual(checkCssBraces('.\\{weird { color: red; }\n'), { ok: true });
});

test('an unterminated comment fails at the line it opens', () => {
  assert.deepEqual(checkCssBraces('.a { }\n/* never closed {\n'), { ok: false, line: 2, problem: 'unterminated /* comment' });
});

test('CRLF line endings count lines the same way', () => {
  assert.equal(checkCssBraces('.a {\r\n}\r\n}\r\n').line, 3);
});

test('empty file is balanced', () => {
  assert.deepEqual(checkCssBraces(''), { ok: true });
});

// ── evaluateCssFiles: the three verdicts ────────────────────────────────────────────────────────

test('PASS: every file read and balanced', () => {
  const v = evaluateCssFiles({ files: [{ path: 'a.css', text: '.a{}' }, { path: 'b.css', text: '' }] });
  assert.equal(v.gate, GATE_NAME);
  assert.equal(v.verdict, 'PASS');
  assert.match(v.reason, /2 tracked \.css file/);
});

test('FAIL: names file:line of each mismatch, first one in the reason', () => {
  const v = evaluateCssFiles({
    files: [
      { path: 'ok.css', text: '.a{}' },
      { path: 'src/x.css', text: '.a{}\n}' },
      { path: 'src/y.css', text: '.a{' },
    ],
  });
  assert.equal(v.verdict, 'FAIL');
  assert.match(v.reason, /2 of 3 .*first: src\/x\.css:2: unexpected \}/);
  assert.deepEqual(v.details, ['src/x.css:2: unexpected } (no matching {)', 'src/y.css:1: unclosed { (1 still open at end of file)']);
});

test('GATE-UNREADABLE: the file list could not be read', () => {
  const v = evaluateCssFiles({ listError: new Error('fatal: not a git repository') });
  assert.equal(v.verdict, 'GATE-UNREADABLE');
  assert.match(v.reason, /could not list/);
});

test('GATE-UNREADABLE: an empty file list is not a clean pass', () => {
  assert.equal(evaluateCssFiles({ files: [] }).verdict, 'GATE-UNREADABLE');
  assert.equal(evaluateCssFiles({}).verdict, 'GATE-UNREADABLE');
});

test('GATE-UNREADABLE wins over FAIL when any file could not be read', () => {
  const v = evaluateCssFiles({
    files: [
      { path: 'bad.css', text: '}' },
      { path: 'gone.css', readError: Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }) },
    ],
  });
  assert.equal(v.verdict, 'GATE-UNREADABLE');
  assert.match(v.details[0], /^gone\.css: target not found/);
});

// ── CLI: warn-only ──────────────────────────────────────────────────────────────────────────────

function harness(files, { listThrows = false, env = {} } = {}) {
  const lines = [];
  const appended = {};
  return {
    lines,
    appended,
    deps: {
      cwd: '/repo',
      list: async () => {
        if (listThrows) throw new Error('git failed');
        return files.map((f) => f.path);
      },
      read: (paths) => paths.map((p) => files.find((f) => f.path === p)),
      log: (s) => lines.push(s),
      env: { GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: 'out', GITHUB_STEP_SUMMARY: 'sum', ...env },
      append: (file, text) => {
        appended[file] = (appended[file] ?? '') + text;
      },
    },
  };
}

for (const [label, files, opts, verdict, strictCode] of [
  ['PASS', [{ path: 'a.css', text: '.a{}' }], {}, 'PASS', 0],
  ['FAIL', [{ path: 'a.css', text: '.a{' }], {}, 'FAIL', 1],
  ['GATE-UNREADABLE', [], { listThrows: true }, 'GATE-UNREADABLE', 2],
]) {
  test(`CLI ${label}: exits 0 by default, writes verdict= to the step outputs and the summary`, async () => {
    const h = harness(files, opts);
    assert.equal(await runCli([], h.deps), 0);
    assert.match(h.appended.out, new RegExp(`^gate=${GATE_NAME}\\nverdict=${verdict}\\nreason=.+\\n$`));
    assert.match(h.appended.sum, new RegExp(`### Gate verdict: ${GATE_NAME}[\\s\\S]*\\*\\*${verdict}\\*\\*`));
    assert.ok(h.lines.some((l) => l.startsWith(`GATE-VERDICT ${GATE_NAME}: ${verdict}`)));
    const warned = h.lines.some((l) => l.startsWith(`::warning title=${verdict}::`));
    assert.equal(warned, verdict !== 'PASS');
  });

  test(`CLI ${label}: --strict exits ${strictCode}`, async () => {
    assert.equal(await runCli(['--strict'], harness(files, opts).deps), strictCode);
  });
}

test('CLI: a failed write to the step outputs is a WARN, never a throw', async () => {
  const h = harness([{ path: 'a.css', text: '.a{}' }]);
  h.deps.append = () => {
    throw new Error('EACCES');
  };
  assert.equal(await runCli([], h.deps), 0);
  assert.ok(h.lines.some((l) => /^WARN: could not write the gate verdict/.test(l)));
});

test('end to end: the script reads real files from a git repo (FAIL found, still exit 0)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'css-brace-'));
  try {
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    writeFileSync(join(dir, 'ok.css'), '.a { color: red; }\n');
    writeFileSync(join(dir, 'bad.css'), '.a { color: red; }\n}\n');
    writeFileSync(join(dir, 'untracked.css'), '}\n');
    git('add', 'ok.css', 'bad.css');
    const env = { ...process.env, GITHUB_ACTIONS: '', GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' };
    const r = spawnSync(process.execPath, [join(here, 'css-brace-check.mjs')], { cwd: dir, encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /FAIL - 1 of 2 .*bad\.css:2: unexpected \}/);
    assert.doesNotMatch(r.stdout, /untracked\.css/);
    const s = spawnSync(process.execPath, [join(here, 'css-brace-check.mjs'), '--strict'], { cwd: dir, encoding: 'utf8', env });
    assert.equal(s.status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Wiring: blocking in ci.yml (t/420 T2 flip) ──────────────────────────────────────────────────

test('ci.yml runs the check blocking: --strict, no continue-on-error, an id for its outputs', () => {
  const yml = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  const m = yml.match(/- name: CSS brace check[^\n]*\n((?:        [^\n]*\n)+)/);
  assert.ok(m, 'ci.yml has no "CSS brace check" step');
  const step = m[1];
  assert.match(step, /id: css-brace-check/);
  assert.doesNotMatch(step, /continue-on-error/);
  assert.match(step, /run: node operations\/devops\/css-brace-check\.mjs --strict\s*\n/);
});
