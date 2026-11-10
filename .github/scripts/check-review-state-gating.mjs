// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.
//
// t/105 (backlog t/4957): warn-only lint against gating on GitHub `reviewDecision` or a review's
// `state`. Every team role reviews through ONE shared reviewer GitHub App account, and GitHub keeps
// only the latest review per user, so `reviewDecision` and an individual review's `state` can't carry
// one role's verdict: one role's APPROVED overwrites another role's CHANGES_REQUESTED (#4686). The
// sanctioned reader is operations/devops/role-review-verdicts.mjs (latestRoleVerdicts), which parses
// the role-tagged review bodies.
//
// Flags, in .github/workflows/** and operations/devops/** (tests and fixtures excluded):
//   1. any read of `reviewDecision` outside a comment;
//   2. a comparison of a review `state` to 'APPROVED' or 'CHANGES_REQUESTED' (a line that mentions
//      `state` and compares one of those literals with ===, !==, == or !=).
// Allowed with a reason: a same-line or preceding-line comment `lint:review-state-ok: <reason>`, or an
// entry in .github/ci/review-state-gating-allowlist.json ({ path, contains, reason }) for files that
// can't carry a comment (T2 paths).
//
// NOT detected (the visible blanks): a state read through an alias or destructuring followed by a
// comparison on another line, `['APPROVED', ...].includes(state)`, and GraphQL `reviews { state }`
// selections compared elsewhere. The lint narrows the class; it doesn't close it.
//
// Usage: node .github/scripts/check-review-state-gating.mjs [repoRoot]
// Exits 1 on findings, 0 when clean. ci.yml runs it continue-on-error (warn-only, t/95#1).

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCAN_ROOTS = ['.github/workflows', 'operations/devops']
export const ALLOWLIST_PATH = '.github/ci/review-state-gating-allowlist.json'
const SCANNED_EXT = /\.(ya?ml|m?js|cjs|ts|ps1|psm1|sh|py)$/i
const EXCLUDED = /(\.test\.m?js|\.Tests\.ps1|[\\/]__tests__[\\/]|[\\/]fixtures?[\\/]|[\\/]tests?[\\/])/i
const OK_TAG = /lint:review-state-ok:\s*(\S.*)$/
const STATE_LITERAL = String.raw`['"\x60](?:APPROVED|CHANGES_REQUESTED)['"\x60]`
const COMPARE = new RegExp(String.raw`(?:===|!==|==|!=)\s*${STATE_LITERAL}|${STATE_LITERAL}\s*(?:===|!==|==|!=)`)
const STATE_WORD = /\bstate\b/

/** Pure. The code part of a line: '' for a whole-line comment, else the line minus a trailing // comment. */
export function codeOf(line) {
  const t = line.trim()
  if (t === '' || t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<#')) return ''
  // Trailing `// ...` that isn't part of a URL (`://`). Quote-naive by design; good enough for a warn-only lint.
  const m = line.match(/(^|[^:])\/\/.*$/)
  return m ? line.slice(0, m.index + m[1].length) : line
}

/** Pure. The lint:review-state-ok reason on this line or the one above, or null. */
export function okReason(lines, i) {
  for (const j of [i, i - 1]) {
    if (j < 0) continue
    const m = lines[j].match(OK_TAG)
    if (m && m[1].trim().length >= 3) return m[1].trim()
  }
  return null
}

/** Pure. Findings for one file's text: [{ line, rule, text }]. Honors comments and allowlist entries. */
export function scanText(text, path, allowlist = []) {
  const lines = text.split(/\r?\n/)
  const out = []
  lines.forEach((raw, i) => {
    const code = codeOf(raw)
    if (!code) return
    let rule = null
    if (/\breviewDecision\b/.test(code)) rule = 'reviewDecision'
    else if (STATE_WORD.test(code) && COMPARE.test(code)) rule = 'review-state'
    if (!rule) return
    if (okReason(lines, i)) return
    if (allowlist.some((a) => a.path === path && typeof a.contains === 'string' && a.contains && raw.includes(a.contains))) return
    out.push({ line: i + 1, rule, text: raw.trim() })
  })
  return out
}

/** Pure. Validates allowlist entries; returns the problems (an entry without a reason is a problem). */
export function allowlistProblems(entries) {
  const problems = []
  if (!Array.isArray(entries)) return ['allowlist must be a JSON array']
  entries.forEach((e, k) => {
    if (!e || typeof e.path !== 'string' || !e.path) problems.push(`entry ${k}: missing path`)
    if (!e || typeof e.contains !== 'string' || !e.contains) problems.push(`entry ${k}: missing contains`)
    if (!e || typeof e.reason !== 'string' || e.reason.trim().length < 10) problems.push(`entry ${k}: missing or too-short reason`)
  })
  return problems
}

function* walk(dir) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

/** Scans the repo. Returns { findings: [{ path, line, rule, text }], problems: [string] }. */
export function scanRepo(root) {
  let allowlist = []
  const problems = []
  const alPath = join(root, ALLOWLIST_PATH)
  if (existsSync(alPath)) {
    try { allowlist = JSON.parse(readFileSync(alPath, 'utf8')).entries ?? [] }
    catch (e) { problems.push(`${ALLOWLIST_PATH} unreadable: ${e.message}`) }
    problems.push(...allowlistProblems(allowlist).map((p) => `${ALLOWLIST_PATH}: ${p}`))
  }
  const findings = []
  for (const scanRoot of SCAN_ROOTS) {
    for (const abs of walk(join(root, scanRoot))) {
      const rel = relative(root, abs).split(sep).join('/')
      if (!SCANNED_EXT.test(rel) || EXCLUDED.test('/' + rel)) continue
      for (const f of scanText(readFileSync(abs, 'utf8'), rel, allowlist)) findings.push({ path: rel, ...f })
    }
  }
  return { findings, problems }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.argv[2] || process.cwd()
  const { findings, problems } = scanRepo(root)
  for (const p of problems) console.log(`::warning::check-review-state-gating: ${p}`)
  for (const f of findings) {
    const why = f.rule === 'reviewDecision'
      ? 'reads reviewDecision, which the shared reviewer App collapses across roles'
      : "compares a review state to APPROVED/CHANGES_REQUESTED, and one role's review can overwrite another's"
    console.log(`::warning file=${f.path},line=${f.line}::check-review-state-gating (t/4957): ${why}. Use latestRoleVerdicts (operations/devops/role-review-verdicts.mjs), or mark an informational use with "lint:review-state-ok: <reason>".`)
  }
  if (findings.length || problems.length) {
    console.log(`check-review-state-gating: ${findings.length} finding(s), ${problems.length} allowlist problem(s) (warn-only, t/105)`)
    process.exit(1)
  }
  console.log('check-review-state-gating: no ungated reviewDecision/review-state reads (t/105)')
}
