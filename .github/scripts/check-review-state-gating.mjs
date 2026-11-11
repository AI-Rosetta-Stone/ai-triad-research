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
//      `state` and compares one of those literals with ===, !==, == or !=, or in PowerShell with
//      -eq/-ne and their -c/-i forms, case-insensitively).
// Comments are skipped per language (t/119): `//` and `/* */` in JS and YAML, `#` in YAML, shell,
// PowerShell and Python, and `<# #>` in PowerShell.
// Allowed with a reason: `lint:review-state-ok: <reason>` inside a comment, on the same line or on a
// comment-only line directly above (a tag in a string literal doesn't count), or an entry in
// .github/ci/review-state-gating-allowlist.json ({ path, contains, reason }) for files that can't carry
// a comment (T2 paths).
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
// t/119: PowerShell's -eq/-ne and their case-sensitive (-c) and explicit case-insensitive (-i) forms.
const OPS = String.raw`(?:===|!==|==|!=|(?:^|\s)-[ci]?(?:eq|ne)\b)`
const COMPARE = new RegExp(String.raw`${OPS}\s*${STATE_LITERAL}|${STATE_LITERAL}\s*${OPS}`)
// PowerShell compares strings case-insensitively, so `$r.State -eq 'Approved'` is the same read there.
const COMPARE_PS = new RegExp(COMPARE.source, 'i')
const STATE_WORD = /\bstate\b/
const STATE_WORD_PS = /\bstate\b/i
const PS_EXT = /\.(ps1|psm1)$/i
const HASH_EXT = /\.(ya?ml|sh|ps1|psm1|py)$/i   // `#` starts a comment (YAML, shell, PowerShell, Python)
const SLASH_EXT = /\.(ya?ml|m?js|cjs|ts)$/i      // `//` and `/* */` (JS, including github-script blocks in YAML)

/**
 * Pure. Splits each line into its code and comment parts: [{ code, comment }]. Tracks block comments
 * across lines (`/* … *\/` in JS and YAML, `<# … #>` in PowerShell) and trailing comments (`//` that
 * isn't a URL's `://`, and `#` after whitespace in YAML, shell, PowerShell and Python). Quote-naive by
 * design: a marker inside a string ends the code early, which can only hide a read, never invent one.
 */
export function splitLines(lines, path = '') {
  // No path (a bare line, as codeOf's callers pass): every comment style applies.
  const any = !path, hash = any || HASH_EXT.test(path), slash = any || SLASH_EXT.test(path), ps = any || PS_EXT.test(path)
  let close = null   // the end marker of the block comment we're inside, if any
  return lines.map((line) => {
    let code = '', comment = '', rest = line
    while (rest) {
      if (close) {
        const k = rest.indexOf(close)
        if (k < 0) { comment += rest; rest = ''; break }
        comment += rest.slice(0, k + close.length); rest = rest.slice(k + close.length); close = null
        continue
      }
      const cands = []
      if (slash) {
        const b = rest.indexOf('/*'); if (b >= 0) cands.push([b, 'block', '*/'])
        const m = rest.match(/(^|[^:])\/\//); if (m) cands.push([m.index + m[1].length, 'line'])
      }
      if (ps) { const b = rest.indexOf('<#'); if (b >= 0) cands.push([b, 'block', '#>']) }
      if (hash) { const m = rest.match(/(^|\s)#/); if (m) cands.push([m.index + m[1].length, 'line']) }
      // A JSDoc/block continuation line (` * …`) is comment text.
      if (!code && /^\s*\*(\s|\/|$)/.test(rest)) cands.push([rest.search(/\*/), 'line'])
      if (!cands.length) { code += rest; break }
      const [at, kind, end] = cands.sort((a, b) => a[0] - b[0])[0]
      code += rest.slice(0, at)
      if (kind === 'line') { comment += rest.slice(at); break }
      comment += rest.slice(at, at + 2); rest = rest.slice(at + 2); close = end
    }
    return { code: code.trim() ? code : '', comment }
  })
}

/** Pure. The code part of one line on its own (no block-comment state). '' for a whole-line comment. */
export function codeOf(line, path = '') {
  return splitLines([line], path)[0].code
}

/**
 * Pure. The lint:review-state-ok reason for line i, or null. t/119: the tag counts only inside a
 * comment, on the same line or on the line immediately above when that line is comment-only. A tag in
 * a string literal, or above a line of code, doesn't count.
 */
export function okReason(parts, i) {
  const tagIn = (s) => { const m = s.match(OK_TAG); return m && m[1].trim().length >= 3 ? m[1].trim() : null }
  return tagIn(parts[i].comment) ?? (i > 0 && !parts[i - 1].code ? tagIn(parts[i - 1].comment) : null)
}

/** Pure. Findings for one file's text: [{ line, rule, text }]. Honors comments and allowlist entries. */
export function scanText(text, path, allowlist = []) {
  const lines = text.split(/\r?\n/)
  const parts = splitLines(lines, path)
  const ps = PS_EXT.test(path)
  const out = []
  lines.forEach((raw, i) => {
    const { code } = parts[i]
    if (!code) return
    let rule = null
    if (/\breviewDecision\b/.test(code)) rule = 'reviewDecision'
    else if ((ps ? STATE_WORD_PS : STATE_WORD).test(code) && (ps ? COMPARE_PS : COMPARE).test(code)) rule = 'review-state'
    if (!rule) return
    if (okReason(parts, i)) return
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
