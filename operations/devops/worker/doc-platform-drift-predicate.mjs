// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Doc-vs-platform drift detector (t/3797). Prevention for the e/227 incident: three
 * docs + a skill restated `enforce_admins=false` / admin-bypass-works / a stale
 * required-context list for ~2 days after t/3736 flipped `enforce_admins:true` —
 * found by two reviewers reading the files for unrelated reasons, not by any check.
 *
 * SCOPE BOUNDARY (state exactly this, never broader — t/3797#2):
 * this check closes DRIFT-FROM-PLATFORM — a literal claim about branch-protection
 * config that disagrees with the live `gh api …/branches/main/protection` snapshot.
 * It does NOT catch:
 *   - doc-vs-doc self-contradiction with no platform fact to diff against (the
 *     *founding* defect class — two docs disagreeing with each other, neither
 *     wrong by any API)
 *   - stale claims about things with no queryable source (e.g. "the
 *     pre-self-merge-verify hook BLOCKS" — loaded≠enforcing has no API; only a
 *     live fire discriminates, t/3695)
 *   - `.orca/skills/**` content — those files are OVERLAY-tracked (separate
 *     `.orca-git` repo) and are NOT present in a standard `actions/checkout` of
 *     this repo, so the CI shim structurally cannot see them. (The unit tests
 *     below still prove the PURE evaluator would catch the skill's historical
 *     stale text if it could — this is a scanning-scope gap, not an evaluation
 *     gap.)
 *
 * Pure-core/impure-shim split (t/3699/t/3738 pattern): the exported functions here
 * take only plain data (file text, a pre-fetched live-protection snapshot) — no
 * git/gh calls. The CLI shim at the bottom does the impure part (grep the repo,
 * fetch the live API) and is the only piece the workflow actually invokes.
 */

// ── Claim extraction patterns (narrow + high-precision by design, t/3797 spec) ──

const CLAIM_PATTERNS = [
  {
    kind: 'enforce_admins_false',
    // `enforce_admins=false` / `enforce_admins: false` as a literal factual claim.
    re: /enforce_admins\s*[:=]\s*false\b/gi,
  },
  {
    kind: 'admin_bypass_works',
    // "bypasses the (required) checks" — the admin-bypass-works assertion.
    re: /\bbypasses?\s+the\s+(required\s+)?checks?\b/gi,
  },
  {
    kind: 'hardcoded_context_count',
    // "6 strict required status checks" / "6 strict contexts" — a hardcoded count.
    re: /\b(\d+)\s+strict\s+(required\s+status\s+)?(checks?|contexts?)\b/gi,
    captureCount: true,
  },
  {
    kind: 'hardcoded_context_names',
    // the specific named 3-context list, NOT followed by consult-hold-guard —
    // the exact literal both the pre-fix runbook and land-from-worktree used.
    re: /`ci-gate`,\s*`CodeQL`,\s*`joint-gv-guard`(?!,\s*`consult-hold-guard`)/gi,
  },
  {
    kind: 'enforce_admins_true_not_landed',
    // the OTHER polarity (route-enumeration.md): claims enforce_admins:true is
    // "specified, not landed" when it has, in fact, landed.
    re: /enforce_admins:\s*true[^\n]{0,100}?(specified,?\s*not\s*landed|not\s+yet\s+landed)/gis,
  },
];

// How far around an `admin_bypass_works` match to look for a co-located
// `enforce_admins=false` literal before treating the bypass phrase as a live claim
// (Lead review, PR #2623): a bare "bypasses the (required) checks" is too broad on
// its own — docs/LessonsLearned.md:2621 (the CORRECT, post-flip #177 entry) uses
// that exact phrase to quote the land-from-worktree skill's HISTORICAL wording
// while narrating that it is no longer true, with no enforce_admins=false anywhere
// nearby. Requiring proximity to an actual false-literal turns the bypass phrase
// from a standalone (noisy) signal into a corroborating one.
const ENFORCE_ADMINS_FALSE_RE = /enforce_admins\s*[:=]\s*false\b/i;
const BYPASS_PROXIMITY_WINDOW = 300;

/** Pure: extract claims from a single doc's text. No I/O. */
export function extractClaims(text, file) {
  const s = typeof text === 'string' ? text : '';
  const claims = [];
  for (const { kind, re, captureCount } of CLAIM_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      if (kind === 'admin_bypass_works') {
        const start = Math.max(0, m.index - BYPASS_PROXIMITY_WINDOW);
        const end = Math.min(s.length, m.index + m[0].length + BYPASS_PROXIMITY_WINDOW);
        if (!ENFORCE_ADMINS_FALSE_RE.test(s.slice(start, end))) {
          if (m[0].length === 0) re.lastIndex++;
          continue; // no nearby false-claim -> likely quoted/historical framing, skip
        }
      }
      const line = s.slice(0, m.index).split('\n').length;
      const claim = { kind, file, line, match: m[0] };
      if (captureCount) claim.count = Number(m[1]);
      claims.push(claim);
      if (m[0].length === 0) re.lastIndex++; // guard against zero-width infinite loop
    }
  }
  return claims;
}

/**
 * Pure: is a single claim drift, given the live branch-protection snapshot?
 * `live = { enforceAdmins: bool, contexts: string[] }`.
 */
export function evaluateClaim(claim, live) {
  if (!claim || !live) return false;
  switch (claim.kind) {
    case 'enforce_admins_false':
      // The claim literally asserts enforce_admins is false. Drift iff live says true.
      return live.enforceAdmins === true;
    case 'admin_bypass_works':
      // Bypass only "works" when enforce_admins is false. Drift iff live says true.
      return live.enforceAdmins === true;
    case 'hardcoded_context_count':
      return claim.count !== live.contexts.length;
    case 'hardcoded_context_names': {
      const liveSet = new Set(live.contexts);
      const claimed = ['ci-gate', 'CodeQL', 'joint-gv-guard'];
      return claimed.length !== liveSet.size || !claimed.every((c) => liveSet.has(c));
    }
    case 'enforce_admins_true_not_landed':
      // The claim says enforce_admins:true is "not landed". Drift iff it HAS landed.
      return live.enforceAdmins === true;
    default:
      return false;
  }
}

/**
 * Pure: evaluate a full set of claims against the live snapshot.
 * `rangeValid` false (the live snapshot couldn't be fetched) -> 'cannot-evaluate'
 * UNCONDITIONALLY, never 'clean' (t/3738 fail-closed lesson — an unresolved
 * comparison must never read as "nothing found").
 */
export function evaluateDocPlatformDrift({ claims, live, rangeValid } = {}) {
  if (!rangeValid) {
    return { verdict: 'cannot-evaluate', drift: [] };
  }
  const list = Array.isArray(claims) ? claims : [];
  const drift = list.filter((c) => evaluateClaim(c, live));
  return { verdict: drift.length > 0 ? 'fire' : 'clean', drift };
}

/** Pure: format the human-readable result the CLI shim prints. */
export function formatResult(result) {
  if (result.verdict === 'cannot-evaluate') {
    return 'CANNOT EVALUATE — the live branch-protection API did not resolve. This is ' +
      'never treated as clean (t/3797 fail-closed rule, mirroring t/3738). Check gh ' +
      'auth / network and re-run.';
  }
  if (result.verdict === 'clean') return 'clean — no doc-vs-platform drift found';

  const lines = ['DOC-VS-PLATFORM DRIFT CHECK FIRED (t/3797):'];
  for (const c of result.drift) {
    lines.push(`- ${c.file}:${c.line} [${c.kind}] "${c.match.slice(0, 80)}"`);
  }
  lines.push(
    '',
    'Residual: catches drift-from-PLATFORM only (a literal claim vs. the live ' +
      'branch-protection API). Does NOT catch doc-vs-doc self-contradiction with no ' +
      'platform fact, stale claims about things with no queryable source (e.g. ' +
      'feedback-rule liveness), or .orca/skills/** content (overlay-tracked, not ' +
      'present in this checkout).',
  );
  return lines.join('\n');
}

// ── Impure shim ──────────────────────────────────────────────────────────────────
// Invoked as: node doc-platform-drift-predicate.mjs [repoRoot]
// Scans docs/**/*.md, deploy/**/*.md, and root AGENTS.md (the only main-repo-tracked
// AGENTS.md per root AGENTS.md's Orca Overlay Repo section) for the claim patterns
// above, fetches the live branch-protection snapshot via `gh api`, and diffs.
// Exit 0 ONLY on 'clean'. continue-on-error:true in the workflow makes this
// advisory regardless (warn-only — no blocking flip without a separate SO).

function walkMarkdownFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMarkdownFiles(p));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function fetchLiveProtection() {
  const raw = execFileSync(
    'gh',
    [
      'api',
      'repos/AI-Rosetta-Stone/ai-triad-research/branches/main/protection',
      '--jq',
      '{enforceAdmins: .enforce_admins.enabled, contexts: .required_status_checks.contexts}',
    ],
    { windowsHide: true, encoding: 'utf8' },
  );
  return JSON.parse(raw);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('doc-platform-drift-predicate.mjs')) {
  const repoRoot = process.argv[2] || fileURLToPath(new URL('../../../', import.meta.url));

  const scanDirs = ['docs', 'deploy'].map((d) => path.join(repoRoot, d));
  const scanFiles = [...scanDirs.flatMap(walkMarkdownFiles), path.join(repoRoot, 'AGENTS.md')];

  const claims = [];
  for (const f of scanFiles) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const rel = path.relative(repoRoot, f).replace(/\\/g, '/');
    claims.push(...extractClaims(text, rel));
  }

  let live = null;
  let rangeValid = false;
  try {
    live = fetchLiveProtection();
    rangeValid = true;
  } catch {
    rangeValid = false;
  }

  const result = evaluateDocPlatformDrift({ claims, live, rangeValid });
  process.stdout.write(formatResult(result) + '\n');
  process.exitCode = result.verdict === 'clean' ? 0 : 1;
}
