// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.
//
// t/128: reject ASCII control characters in tracked source/text files. GitHub's diff view doesn't show
// them: on #4809 (t/122) literal backspace bytes (0x08) sat where `\b` was meant in a test regex, so a
// banned-word guard passed vacuously and two reviews missed it.
//
// Flags any byte 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F or 0x7F. Tab (0x09), LF (0x0A) and CR (0x0D) are
// allowed. UTF-8 multibyte sequences only use bytes >= 0x80, so they never match.
// Exclusions need a reason: .github/ci/control-chars-allowlist.json { entries: [{ path, reason }] }, where
// `path` is an exact repo path or a directory prefix ending in '/'.
//
// Usage:
//   node .github/scripts/check-control-chars.mjs              # every tracked file with a scanned extension
//   node .github/scripts/check-control-chars.mjs <path>...    # just these (the pre-push hook passes changed files)
// Exits 1 on findings or allowlist problems, 0 when clean. ci.yml runs it continue-on-error (warn-only first).

import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ALLOWLIST_PATH = '.github/ci/control-chars-allowlist.json'
export const SCANNED_EXT = /\.(ts|tsx|js|mjs|cjs|ps1|psm1|psd1|py|json|ya?ml|md|css|sh)$/i

/** Pure. True for a byte this lint rejects. */
export function isBadByte(b) {
  return (b <= 0x08) || b === 0x0b || b === 0x0c || (b >= 0x0e && b <= 0x1f) || b === 0x7f
}

/** Pure. Every rejected byte in a buffer: [{ line, col, hex }], 1-based, col counted in bytes. */
export function findControlChars(buf) {
  const out = []
  let line = 1, col = 1
  for (const b of buf) {
    if (b === 0x0a) { line++; col = 1; continue }
    if (isBadByte(b)) out.push({ line, col, hex: '0x' + b.toString(16).padStart(2, '0').toUpperCase() })
    col++
  }
  return out
}

/** Pure. Problems with allowlist entries (each needs a path and a real reason). */
export function allowlistProblems(entries) {
  if (!Array.isArray(entries)) return ['allowlist entries must be an array']
  const p = []
  entries.forEach((e, k) => {
    if (!e || typeof e.path !== 'string' || !e.path) p.push(`entry ${k}: missing path`)
    if (!e || typeof e.reason !== 'string' || e.reason.trim().length < 10) p.push(`entry ${k}: missing or too-short reason`)
  })
  return p
}

/** Pure. Is this repo path excluded by an allowlist entry? */
export function isAllowlisted(path, entries) {
  return entries.some((e) => typeof e?.path === 'string' && e.path && (e.path.endsWith('/') ? path.startsWith(e.path) : path === e.path))
}

/** Scans the given repo paths (or every tracked scanned file). Returns { findings, problems, scanned }. */
export function scan(root, paths = null) {
  const problems = []
  let entries = []
  const al = join(root, ALLOWLIST_PATH)
  if (existsSync(al)) {
    try { entries = JSON.parse(readFileSync(al, 'utf8')).entries ?? [] } catch (e) { problems.push(`${ALLOWLIST_PATH} unreadable: ${e.message}`) }
    problems.push(...allowlistProblems(entries).map((x) => `${ALLOWLIST_PATH}: ${x}`))
  }
  const list = paths ?? execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean)
  const findings = []
  let scanned = 0
  for (const rel of list) {
    const p = rel.replace(/\\/g, '/')
    if (!SCANNED_EXT.test(p) || isAllowlisted(p, entries)) continue
    const abs = join(root, p)
    if (!existsSync(abs)) continue   // deleted in the pushed range
    scanned++
    for (const f of findControlChars(readFileSync(abs))) findings.push({ path: p, ...f })
  }
  return { findings, problems, scanned }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.cwd()
  const args = process.argv.slice(2)
  const { findings, problems, scanned } = scan(root, args.length ? args : null)
  for (const p of problems) console.log(`::warning::check-control-chars: ${p}`)
  for (const f of findings) {
    console.log(`::warning file=${f.path},line=${f.line},col=${f.col}::check-control-chars (t/128): control byte ${f.hex}; invisible in PR diffs. Use an escape (e.g. \\b, \\x08) instead of the raw byte, or allowlist the file with a reason in ${ALLOWLIST_PATH}.`)
    console.log(`${f.path}:${f.line}:${f.col}: ${f.hex}`)
  }
  if (findings.length || problems.length) {
    console.log(`check-control-chars: ${findings.length} control byte(s) in ${new Set(findings.map((f) => f.path)).size} file(s), ${problems.length} allowlist problem(s); ${scanned} file(s) scanned (t/128)`)
    process.exit(1)
  }
  console.log(`check-control-chars: clean, ${scanned} file(s) scanned (t/128)`)
}
