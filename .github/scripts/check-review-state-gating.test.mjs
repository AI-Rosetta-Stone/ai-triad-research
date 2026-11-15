// .github/scripts/check-review-state-gating.test.mjs
// Run: `node --test .github/scripts/check-review-state-gating.test.mjs` (ci.yml workflow-lint runs it, warn-first).
//
// t/105 (t/4957): both arms of every rule in check-review-state-gating.mjs, plus a whole-repo scan.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanText, scanRepo, codeOf, allowlistProblems } from './check-review-state-gating.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const rules = (text, path = 'operations/devops/x.mjs', al) => scanText(text, path, al).map((f) => f.rule)

test('FIRES: a reviewDecision read', () => {
  assert.deepEqual(rules('const d = pr.reviewDecision\nif (d === "APPROVED") enqueue()'), ['reviewDecision'])
})

test('FIRES: reviewDecision selected in a GraphQL query string', () => {
  assert.deepEqual(rules('const q = `query { repository { pullRequest(number: 1) { reviewDecision } } }`'), ['reviewDecision'])
})

test('QUIET: the sanctioned latestRoleVerdicts reader', () => {
  const src = [
    "import { latestRoleVerdicts } from './role-review-verdicts.mjs'",
    'const v = latestRoleVerdicts({ reviews, comments, reviewerAppLogin, headSha, lastPushAt })',
    "if (v.Quality?.verdict === 'approved') ok = true",
  ].join('\n')
  assert.deepEqual(rules(src), [])
})

test('FIRES: a review state compared to APPROVED with no allowlist', () => {
  assert.deepEqual(rules("if (r.state === 'APPROVED') pass = true"), ['review-state'])
})

test('FIRES: CHANGES_REQUESTED, the reversed operand order, and the case-folded form', () => {
  assert.deepEqual(rules("reviews.some(r => r.state === 'CHANGES_REQUESTED')"), ['review-state'])
  assert.deepEqual(rules("if ('APPROVED' == review.state) x()"), ['review-state'])
  assert.deepEqual(rules("if (String(r?.state ?? '').toUpperCase() !== 'APPROVED') continue"), ['review-state'])
})

test('QUIET: an allowlisted informational use (same line and preceding line)', () => {
  assert.deepEqual(rules("if (r.state === 'APPROVED') seen++ // lint:review-state-ok: digest count only"), [])
  assert.deepEqual(rules("// lint:review-state-ok: digest count only, never gates\nif (r.state === 'APPROVED') seen++"), [])
})

test('FIRES: an allowlist tag with no reason does not count', () => {
  assert.deepEqual(rules("// lint:review-state-ok:\nif (r.state === 'APPROVED') pass = true"), ['review-state'])
})

test('QUIET: mentions in comments (JS, YAML/PowerShell, JSDoc)', () => {
  const src = [
    '// never gate on reviewDecision here',
    " * (`state: 'APPROVED'`, submitted after the latest push).",
    "x = 1 // see reviewDecision in t/4957",
  ].join('\n')
  assert.deepEqual(rules(src), [])
  // `#` is a comment in YAML/PowerShell, not in JS (t/119 made comment syntax per language)
  assert.deepEqual(rules("# r.state === 'APPROVED' is the old way", '.github/workflows/w.yml'), [])
  assert.deepEqual(rules("# $r.state -eq 'APPROVED' is the old way", 'operations/devops/x.ps1'), [])
})

test('t/119 item 1: the ok-tag counts only in a comment, same line or a comment-only line directly above', () => {
  // QUIET: same-line trailing comment; comment-only line above (JS //, YAML #, block-comment line)
  assert.deepEqual(rules("if (r.state === 'APPROVED') seen++ // lint:review-state-ok: digest count only"), [])
  assert.deepEqual(rules("// lint:review-state-ok: digest count only\nif (r.state === 'APPROVED') seen++"), [])
  assert.deepEqual(rules("# lint:review-state-ok: digest count only\nif [ \"$s\" ] && r.state === 'APPROVED'", '.github/workflows/w.yml'), [])
  assert.deepEqual(rules("/* lint:review-state-ok: digest count only */\nif (r.state === 'APPROVED') seen++"), [])
  // FIRES: the tag inside a string literal on the line above (Quality's case), or on the same line
  assert.deepEqual(rules("const note = 'lint:review-state-ok: not a comment'\nif (r.state === 'APPROVED') pass = true"), ['review-state'])
  assert.deepEqual(rules("if (r.state === 'APPROVED' && t !== 'lint:review-state-ok: in a string') pass = true"), ['review-state'])
  // FIRES: a tag two lines up, or above a code line rather than directly above the read
  assert.deepEqual(rules("// lint:review-state-ok: too far away\nconst x = 1\nif (r.state === 'APPROVED') pass = true"), ['review-state'])
  assert.deepEqual(rules("x() // lint:review-state-ok: belongs to x()\nif (r.state === 'APPROVED') pass = true"), ['review-state'])
})

test('t/119 item 2: PowerShell -eq/-ne/-ceq/-cne/-ieq comparisons, case-insensitive like PowerShell', () => {
  const ps = (s) => rules(s, 'operations/devops/x.ps1')
  assert.deepEqual(ps("if ($r.state -eq 'APPROVED') { $ok = $true }"), ['review-state'])
  assert.deepEqual(ps("$blocked = $reviews | Where-Object { $_.state -ne 'CHANGES_REQUESTED' }"), ['review-state'])
  assert.deepEqual(ps("if ($r.State -ceq 'APPROVED') { }"), ['review-state'])
  assert.deepEqual(ps("if ($r.State -ieq 'Approved') { }"), ['review-state'])
  assert.deepEqual(ps("if ('APPROVED' -eq $review.state) { }"), ['review-state'])
  // QUIET: no state on the line; -eq on a non-review literal; an ok-tag in a PowerShell comment
  assert.deepEqual(ps("if ($verdict -eq 'APPROVED') { }"), [])
  assert.deepEqual(ps("if ($r.state -eq 'open') { }"), [])
  assert.deepEqual(ps("if ($r.state -eq 'APPROVED') { $n++ } # lint:review-state-ok: count for a digest"), [])
  // JS keeps its case-sensitive literal: a lowercase 'approved' verdict kind isn't a review state
  assert.deepEqual(rules("if (state === 'approved') n++"), [])
})

test('t/119 item 3: block comments (JS /* */ and PowerShell <# #>) and YAML # after code', () => {
  const js = ['/*', " * if (r.state === 'APPROVED') was the old gate", ' reviewDecision too', '*/', 'const y = 2'].join('\n')
  assert.deepEqual(rules(js), [])
  assert.deepEqual(rules("const a = 1 /* r.state === 'APPROVED' */ ; const b = 2"), [])
  const ps1 = ['<#', "  .NOTES  `$r.state -eq 'APPROVED'` was the old gate", '#>', '$x = 1'].join('\n')
  assert.deepEqual(rules(ps1, 'operations/devops/x.ps1'), [])
  assert.deepEqual(rules("      run: echo ok   # r.state === 'APPROVED' is the old way", '.github/workflows/w.yml'), [])
  // FIRES: code after a block comment closes, and code on the line after a block ends
  assert.deepEqual(rules("/* note */ if (r.state === 'APPROVED') pass = true"), ['review-state'])
  assert.deepEqual(rules("/*\n note\n*/\nif (r.state === 'APPROVED') pass = true"), ['review-state'])
  assert.deepEqual(rules("<# note #> if ($r.state -eq 'APPROVED') { }", 'operations/devops/x.ps1'), ['review-state'])
  // FIRES: a URL's // isn't a comment
  assert.deepEqual(rules("fetch('https://x/' + pr.reviewDecision)"), ['reviewDecision'])
})

test("QUIET: an 'APPROVED' verdict string that isn't a review state (gate-performance.yml shape)", () => {
  assert.deepEqual(rules("console.log('GATE_VERDICT=' + (passed ? 'APPROVED' : 'REVIEW_REQUIRED'))", '.github/workflows/g.yml'), [])
  assert.deepEqual(rules('if [ "$GATE_VERDICT" = "APPROVED" ]; then', '.github/workflows/g.yml'), [])
})

test('QUIET: a matching allowlist-file entry; FIRES for another path', () => {
  const al = [{ path: 'operations/devops/t2.mjs', contains: "r.state === 'APPROVED' &&", reason: 'T2 file, role verdict comes from the body' }]
  assert.deepEqual(rules("  r.state === 'APPROVED' &&", 'operations/devops/t2.mjs', al), [])
  assert.deepEqual(rules("  r.state === 'APPROVED' &&", 'operations/devops/other.mjs', al), ['review-state'])
})

test('allowlist-file entries need a path, a contains and a real reason', () => {
  assert.deepEqual(allowlistProblems([{ path: 'a', contains: 'b', reason: 'a good long reason' }]), [])
  assert.equal(allowlistProblems([{ path: 'a', contains: 'b', reason: 'x' }]).length, 1)
  assert.equal(allowlistProblems([{ path: 'a' }]).length, 2)
  assert.equal(allowlistProblems({}).length, 1)
})

test('codeOf keeps URLs and strips trailing comments', () => {
  assert.equal(codeOf("fetch('https://api.github.com/x') // c").trim(), "fetch('https://api.github.com/x')")
  assert.equal(codeOf('   # yaml comment'), '')
})

test('scanRepo: scans workflows and operations/devops, skips tests and fixtures, reports allowlist problems', () => {
  const root = mkdtempSync(join(tmpdir(), 'rsg-'))
  try {
    const put = (p, s) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), s) }
    put('.github/workflows/a.yml', "      if (r.state === 'APPROVED') ok = true\n")
    put('operations/devops/b.mjs', 'const d = pr.reviewDecision\n')
    put('operations/devops/b.test.mjs', 'const d = pr.reviewDecision\n')
    put('operations/devops/fixtures/c.mjs', 'const d = pr.reviewDecision\n')
    put('lib/elsewhere.mjs', 'const d = pr.reviewDecision\n')
    put('.github/ci/review-state-gating-allowlist.json', JSON.stringify({ entries: [{ path: 'x', contains: 'y' }] }))
    const { findings, problems } = scanRepo(root)
    assert.deepEqual(findings.map((f) => `${f.path}:${f.line}:${f.rule}`).sort(),
      ['.github/workflows/a.yml:1:review-state', 'operations/devops/b.mjs:1:reviewDecision'])
    assert.equal(problems.length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the real repo is clean: every existing read carries an honest allowlist reason', () => {
  const { findings, problems } = scanRepo(REPO)
  assert.deepEqual(problems, [])
  assert.deepEqual(findings, [], findings.map((f) => `${f.path}:${f.line} ${f.text}`).join('\n'))
})
