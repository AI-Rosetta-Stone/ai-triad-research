// .github/scripts/check-control-chars.test.mjs
// Run: `node --test .github/scripts/check-control-chars.test.mjs` (ci.yml workflow-lint runs it, blocking since t/130).
//
// t/128: both arms of check-control-chars.mjs. Control bytes in these fixtures are built with
// String.fromCharCode / Buffer.from, never typed raw, so this file passes its own lint.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { findControlChars, isBadByte, isAllowlisted, allowlistProblems, scan, SCANNED_EXT, isScanned } from './check-control-chars.mjs'

const BS = String.fromCharCode(0x08)

test('FIRES: a literal backspace where \\b was meant (the #4809 shape)', () => {
  const src = `expect(msg).not.toMatch(/${BS}fail${BS}/i)\n`
  assert.deepEqual(findControlChars(Buffer.from(src)), [
    { line: 1, col: 26, hex: '0x08' },
    { line: 1, col: 31, hex: '0x08' },
  ])
})

test('FIRES: every rejected byte; reports line and column', () => {
  for (const b of [0x00, 0x01, 0x07, 0x08, 0x0b, 0x0c, 0x0e, 0x1b, 0x1f, 0x7f]) assert.ok(isBadByte(b), `0x${b.toString(16)}`)
  const f = findControlChars(Buffer.from(['ok', `x${String.fromCharCode(0x1b)}[31m`].join('\n')))
  assert.deepEqual(f, [{ line: 2, col: 2, hex: '0x1B' }])
})

test('QUIET: tab, LF, CR (CRLF files) and UTF-8 multibyte text', () => {
  for (const b of [0x09, 0x0a, 0x0d, 0x20, 0x7e, 0x80, 0xff]) assert.ok(!isBadByte(b), `0x${b.toString(16)}`)
  assert.deepEqual(findControlChars(Buffer.from('a\tb\r\nc\n— é → 😀\n', 'utf8')), [])
})

test('QUIET: the escape spelled out is fine; only the raw byte is rejected', () => {
  assert.deepEqual(findControlChars(Buffer.from('const re = /\\bfail\\b/; const s = "\\x08"\n')), [])
})

test('allowlist: exact path and directory prefix match; other paths do not', () => {
  const entries = [{ path: 'tests/fixtures/bin.json', reason: 'binary-ish fixture' }, { path: 'vendor/', reason: 'third-party vendored code' }]
  assert.ok(isAllowlisted('tests/fixtures/bin.json', entries))
  assert.ok(isAllowlisted('vendor/x/y.js', entries))
  assert.ok(!isAllowlisted('tests/fixtures/bin.json.bak', entries))
  assert.ok(!isAllowlisted('vendorx/y.js', entries))
})

test('allowlist entries need a path and a real reason', () => {
  assert.deepEqual(allowlistProblems([{ path: 'a', reason: 'a real reason here' }]), [])
  assert.equal(allowlistProblems([{ path: 'a', reason: 'no' }]).length, 1)
  assert.equal(allowlistProblems([{}]).length, 2)
})

test('scanned extensions follow the ticket list', () => {
  for (const p of ['a.ts', 'a.tsx', 'a.js', 'a.mjs', 'a.cjs', 'a.ps1', 'a.psm1', 'a.py', 'a.json', 'a.yml', 'a.yaml', 'a.md', 'a.css']) assert.ok(SCANNED_EXT.test(p), p)
  for (const p of ['a.png', 'a.woff2', 'a.onnx', 'a.txt']) assert.ok(!SCANNED_EXT.test(p), p)
})

test('t/130: .mts/.cts/.jsx, Dockerfiles and .githooks scripts are scanned; look-alikes are not', () => {
  for (const p of ['workflow-app/vitest.config.mts', 'a.cts', 'a.jsx', 'Dockerfile', 'taxonomy-editor/Dockerfile', 'deploy/azure/Dockerfile.base', '.githooks/pre-push', '.githooks/post-checkout']) assert.ok(isScanned(p), p)
  for (const p of ['docs/Dockerfile-notes.png', 'Dockerfiles/readme.txt', 'scripts/pre-push', '.githooks/README.txt', 'a.png']) assert.ok(!isScanned(p), p)
})

test('t/130: --stdin0 reads NUL-separated paths (a path with a space is scanned whole); empty stdin scans nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccl0-'))
  const cli = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'check-control-chars.mjs')
  const run = (input) => {
    try { return { code: 0, out: execFileSync(process.execPath, [cli, '--stdin0'], { cwd: root, input, encoding: 'utf8' }) } }
    catch (e) { return { code: e.status, out: e.stdout } }
  }
  try {
    mkdirSync(join(root, 'my dir'), { recursive: true })
    writeFileSync(join(root, 'my dir', 'bad file.ts'), `const re = /${BS}x/\n`)
    writeFileSync(join(root, 'ok.ts'), 'const x = 1\n')
    execFileSync('git', ['init', '-q'], { cwd: root })
    const hit = run('ok.ts\0my dir/bad file.ts\0')
    assert.equal(hit.code, 1)
    assert.match(hit.out, /my dir\/bad file\.ts:1:13: 0x08/)
    assert.match(hit.out, /; 2 file\(s\) scanned/)
    const none = run('')
    assert.equal(none.code, 0)
    assert.match(none.out, /clean, 0 file\(s\) scanned/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('scan: a git repo with a bad file, a clean file, an allowlisted bad file and an unscanned bad file', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccl-'))
  try {
    const put = (p, s) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), s) }
    put('src/bad.ts', `const re = /${BS}x${BS}/\n`)
    put('src/ok.ts', 'const re = /\\bx\\b/\n')
    put('fixtures/raw.json', `{"k":"${BS}"}\n`)
    put('assets/raw.png', `${BS}`)
    put('.github/ci/control-chars-allowlist.json', JSON.stringify({ entries: [{ path: 'fixtures/', reason: 'raw protocol fixtures on purpose' }] }))
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['add', '-A'], { cwd: root })
    const all = scan(root)
    assert.deepEqual(all.findings.map((f) => `${f.path}:${f.line}:${f.col}:${f.hex}`), ['src/bad.ts:1:13:0x08', 'src/bad.ts:1:15:0x08'])
    assert.deepEqual(all.problems, [])
    // explicit path list (the pre-push hook): only what's passed; a deleted path is skipped
    assert.equal(scan(root, ['src/ok.ts', 'src/gone.ts']).findings.length, 0)
    assert.equal(scan(root, ['src/bad.ts']).findings.length, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the real repo is clean', () => {
  const root = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..')
  const { findings, problems } = scan(root)
  assert.deepEqual(problems, [])
  assert.deepEqual(findings, [], findings.slice(0, 20).map((f) => `${f.path}:${f.line}:${f.col} ${f.hex}`).join('\n'))
})
