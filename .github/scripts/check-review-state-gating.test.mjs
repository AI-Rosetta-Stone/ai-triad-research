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
    "# r.state === 'APPROVED' is the old way",
    " * (`state: 'APPROVED'`, submitted after the latest push).",
    "x = 1 // see reviewDecision in t/4957",
  ].join('\n')
  assert.deepEqual(rules(src), [])
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
