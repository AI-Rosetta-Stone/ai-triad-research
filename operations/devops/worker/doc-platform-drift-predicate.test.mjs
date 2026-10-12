// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Both-arms + regression-fixture proof for the t/3797 doc-vs-platform drift detector.
// Run: node --test operations/devops/worker/doc-platform-drift-predicate.test.mjs
//
// The 4 fixture files are from t/3797#1/#2 (TL's e/227 sweep), plus the land-from-worktree
// skill text that founded the incident (t/3797 description). All FIRE-fixture text below
// was read directly from origin/main (or git/PR history for already-fixed files) at build
// time, 2026-10-01 — not paraphrased.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractClaims, evaluateClaim, evaluateDocPlatformDrift, formatResult } from './doc-platform-drift-predicate.mjs';

const LIVE = { enforceAdmins: true, contexts: ['ci-gate', 'CodeQL', 'joint-gv-guard', 'consult-hold-guard'] };

// ── extractClaims ──

test('extractClaims: enforce_admins=false literal, both separator forms', () => {
  assert.equal(extractClaims('enforce_admins=false', 'f.md')[0].kind, 'enforce_admins_false');
  assert.equal(extractClaims('enforce_admins: false', 'f.md')[0].kind, 'enforce_admins_false');
});

test('extractClaims: admin_bypass_works phrase, co-located with enforce_admins=false -> claimed', () => {
  const claims = extractClaims('enforce_admins=false, so the admin identity bypasses the required checks on a direct push.', 'f.md');
  assert.ok(claims.some((c) => c.kind === 'admin_bypass_works'));
});

test('extractClaims: admin_bypass_works phrase with NO nearby enforce_admins=false -> NOT claimed (Lead review, PR #2623 false-positive fix)', () => {
  // docs/LessonsLearned.md:2621-shaped: the phrase appears quoting HISTORICAL wording
  // while narrating that it is no longer true, with no false-literal anywhere nearby.
  const claims = extractClaims('the land-from-worktree skill separately notes "a direct push to `main` bypasses the required checks in EITHER mode" — but this was only true by convention until t/3736.', 'f.md');
  assert.ok(!claims.some((c) => c.kind === 'admin_bypass_works'));
});

test('extractClaims: admin_bypass_works phrase far outside the proximity window -> NOT claimed', () => {
  const far = 'enforce_admins=false. ' + 'x'.repeat(400) + ' bypasses the required checks.';
  const claims = extractClaims(far, 'f.md');
  assert.ok(!claims.some((c) => c.kind === 'admin_bypass_works'));
});

test('extractClaims: hardcoded_context_count captures the number', () => {
  const claims = extractClaims('6 strict required status checks, NO required review', 'f.md');
  const c = claims.find((x) => x.kind === 'hardcoded_context_count');
  assert.equal(c.count, 6);
});

test('extractClaims: hardcoded_context_names matches the stale 3-name list, not the corrected 4-name one', () => {
  const stale = extractClaims('to the required status checks (`ci-gate`, `CodeQL`, `joint-gv-guard`).', 'f.md');
  assert.ok(stale.some((c) => c.kind === 'hardcoded_context_names'));
  const corrected = extractClaims('required contexts: `ci-gate`, `CodeQL`, `joint-gv-guard`, `consult-hold-guard`.', 'f.md');
  assert.ok(!corrected.some((c) => c.kind === 'hardcoded_context_names'));
});

test('extractClaims: enforce_admins_true_not_landed (the OTHER polarity)', () => {
  const claims = extractClaims('`enforce_admins: true` (t/3736) | specified, not landed |', 'f.md');
  assert.ok(claims.some((c) => c.kind === 'enforce_admins_true_not_landed'));
});

test('extractClaims: no claims in ordinary prose', () => {
  assert.deepEqual(extractClaims('This document discusses deployment practices.', 'f.md'), []);
  assert.deepEqual(extractClaims('', 'f.md'), []);
  assert.deepEqual(extractClaims(undefined, 'f.md'), []);
});

// ── evaluateClaim — both arms per claim kind, against the real live snapshot ──

test('evaluateClaim: enforce_admins_false -> drift (live is true)', () => {
  assert.equal(evaluateClaim({ kind: 'enforce_admins_false' }, LIVE), true);
});

test('evaluateClaim: admin_bypass_works -> drift (live enforce_admins is true, so bypass does not work)', () => {
  assert.equal(evaluateClaim({ kind: 'admin_bypass_works' }, LIVE), true);
});

test('evaluateClaim: hardcoded_context_count -> drift when count != live count (4)', () => {
  assert.equal(evaluateClaim({ kind: 'hardcoded_context_count', count: 6 }, LIVE), true);
  assert.equal(evaluateClaim({ kind: 'hardcoded_context_count', count: 4 }, LIVE), false);
});

test('evaluateClaim: hardcoded_context_names -> drift (live has a 4th context, consult-hold-guard)', () => {
  assert.equal(evaluateClaim({ kind: 'hardcoded_context_names' }, LIVE), true);
});

test('evaluateClaim: enforce_admins_true_not_landed -> drift (it HAS landed)', () => {
  assert.equal(evaluateClaim({ kind: 'enforce_admins_true_not_landed' }, LIVE), true);
});

test('evaluateClaim: unknown claim kind -> never drift (fail-quiet on unrecognized, not fail-fire)', () => {
  assert.equal(evaluateClaim({ kind: 'something_unrecognized' }, LIVE), false);
});

// ── evaluateDocPlatformDrift — the aggregator, both arms ──

test('clean: no claims -> clean', () => {
  const r = evaluateDocPlatformDrift({ claims: [], live: LIVE, rangeValid: true });
  assert.equal(r.verdict, 'clean');
});

test('fire: any drifting claim -> fire, names it', () => {
  const r = evaluateDocPlatformDrift({
    claims: [{ kind: 'enforce_admins_false', file: 'f.md', line: 1, match: 'enforce_admins=false' }],
    live: LIVE,
    rangeValid: true,
  });
  assert.equal(r.verdict, 'fire');
  assert.equal(r.drift.length, 1);
});

test('cannot-evaluate: rangeValid false -> NEVER clean, regardless of claims', () => {
  const r1 = evaluateDocPlatformDrift({ claims: [], live: null, rangeValid: false });
  assert.equal(r1.verdict, 'cannot-evaluate');
  const r2 = evaluateDocPlatformDrift({
    claims: [{ kind: 'enforce_admins_false' }],
    live: LIVE,
    rangeValid: false,
  });
  assert.equal(r2.verdict, 'cannot-evaluate');
});

// ── Regression fixtures — real text from the e/227 sweep (t/3797#1/#2) ──
// All 4 FIRE texts below were read directly from the live doc (origin/main) or PR/commit
// history at build time; all PASS texts are the corrected wording (actual where it has
// already landed, else the expected-correct form).

test('Fixture 1 (branch-protection-and-deployment.md:34) — pre-fix FIRES, corrected PASSES', () => {
  const stale = 'Bypass rights — `enforce_admins=false`, so the admin identity (`jpsnover`) bypasses the required checks on a direct push.';
  const fixed = 'Bypass rights — `enforce_admins=true` (t/3736), so a direct push from the admin identity is refused just like any other actor; there is no bypass.';
  const r1 = evaluateDocPlatformDrift({ claims: extractClaims(stale, 'docs/branch-protection-and-deployment.md'), live: LIVE, rangeValid: true });
  assert.equal(r1.verdict, 'fire');
  const r2 = evaluateDocPlatformDrift({ claims: extractClaims(fixed, 'docs/branch-protection-and-deployment.md'), live: LIVE, rangeValid: true });
  assert.equal(r2.verdict, 'clean');
});

test('Fixture 2 (LessonsLearned.md #100, self-contradicts #177) — pre-fix #100 text FIRES, #177-style text PASSES', () => {
  const stale100 = '## #100 [Process] Branch Protection With `enforce_admins=false` Is Not a Hard Block for Admin Identities — "PR-flow" Is a Convention\n' +
    'a direct `git push origin HEAD:main` from an **admin identity SUCCEEDS and bypasses the checks** ("Bypassed rule violations, accepted") when `enforce_admins=false`.';
  const fixed177 = '## #177 [Process] `direct` Mode Permits Committing on `main` — NOT Pushing; `enforce_admins:true` Blocks All Direct Pushes\n' +
    'Since t/3736 added `enforce_admins:true` to `main`, branch protection applies to admins too: a direct push that skips CI is refused even for the repo owner.';
  const r1 = evaluateDocPlatformDrift({ claims: extractClaims(stale100, 'docs/LessonsLearned.md'), live: LIVE, rangeValid: true });
  assert.equal(r1.verdict, 'fire');
  const r2 = evaluateDocPlatformDrift({ claims: extractClaims(fixed177, 'docs/LessonsLearned.md'), live: LIVE, rangeValid: true });
  assert.equal(r2.verdict, 'clean');
});

test('Fixture 2b (LessonsLearned.md:2621, the REAL false-positive the Lead caught, PR #2623) — must PASS', () => {
  // Verbatim from docs/LessonsLearned.md:2621 on origin/main (2026-10-01) — part of the
  // CORRECT #177 entry. Quotes the land-from-worktree skill's historical wording while
  // narrating that enforce_admins:true (not false) now governs; no false-literal nearby.
  const line2621 = '**Root Cause:** Conflating two independent gates: (1) the `pre-commit` hook (Orca/local) governs whether a commit is allowed on the shared `main` branch — `direct` mode disables this gate; (2) branch protection on GitHub governs whether a push to `main` is accepted — `enforce_admins:true` means this gate is always active, regardless of mode or admin status. AGENTS.md says direct mode makes committing *permitted*; the land-from-worktree skill separately notes "a direct push to `main` bypasses the required checks in EITHER mode and remains a process violation" — but the implication ("and will be rejected") was only enforced by convention until t/3736.';
  const r = evaluateDocPlatformDrift({ claims: extractClaims(line2621, 'docs/LessonsLearned.md'), live: LIVE, rangeValid: true });
  assert.equal(r.verdict, 'clean');
});

test('Fixture 3 (route-enumeration.md:136, OTHER polarity) — "specified, not landed" FIRES, "landed" PASSES', () => {
  const stale = '| merge a PR whose required checks are **failing** | `enforce_admins: true` (t/3736) | specified, not landed |';
  const fixed = '| merge a PR whose required checks are **failing** | `enforce_admins: true` (t/3736) | **landed** |';
  const r1 = evaluateDocPlatformDrift({ claims: extractClaims(stale, 'docs/CodeReview/route-enumeration.md'), live: LIVE, rangeValid: true });
  assert.equal(r1.verdict, 'fire');
  const r2 = evaluateDocPlatformDrift({ claims: extractClaims(fixed, 'docs/CodeReview/route-enumeration.md'), live: LIVE, rangeValid: true });
  assert.equal(r2.verdict, 'clean');
});

test('Fixture 4 (enforce-admins-override.md, pre-#2620 vs. merged #2620 text) — stale named-context list FIRES, query-pointer form PASSES', () => {
  // Verbatim from PR #2620's diff (ai-triad-research), the "-" (old) and "+" (new) lines.
  const preFix = 'This binds **admins** — i.e. every agent acting with the PI\'s credentials — to the required status checks (`ci-gate`, `CodeQL`, `joint-gv-guard`). Before this, an admin could merge a PR whose required checks were red.\n' +
    '- **Does NOT:** add or remove required contexts (unchanged: `ci-gate`, `CodeQL`, `joint-gv-guard`); gate consult/draft holds (that is t/3680\'s `consult-hold`); or close the stale-base vector.';
  const postFix = 'This binds **admins** — i.e. every agent acting with the PI\'s credentials — to the required status checks. **Do not trust any enumerated list of those contexts — query it** (`gh api repos/AI-Rosetta-Stone/ai-triad-research/branches/main/protection/required_status_checks --jq .contexts`); as of 2026-10-01 it is `ci-gate, CodeQL, joint-gv-guard, consult-hold-guard`, but that set changes.\n' +
    '- **Does NOT:** add or remove required contexts (it binds whatever contexts are required — query them, per above); or close the stale-base vector.';
  const r1 = evaluateDocPlatformDrift({ claims: extractClaims(preFix, 'deploy/azure/runbooks/enforce-admins-override.md'), live: LIVE, rangeValid: true });
  assert.equal(r1.verdict, 'fire');
  const r2 = evaluateDocPlatformDrift({ claims: extractClaims(postFix, 'deploy/azure/runbooks/enforce-admins-override.md'), live: LIVE, rangeValid: true });
  assert.equal(r2.verdict, 'clean');
});

test('Fixture 5 (land-from-worktree skill, the FOUNDING defect) — pre-fix overlay text FIRES; current corrected text PASSES', () => {
  // Pre-fix text extracted verbatim from .orca-git history (commit context predating
  // 180b44b) via `ogit show <rev>:.orca/skills/land-from-worktree/SKILL.md`. This file
  // is overlay-tracked and the live CI shim cannot scan it (stated residual) -- this
  // fixture proves the EVALUATOR would catch it if it could see it.
  const stale = '`main` protection (owner-approved 2026-07-29): **6 strict required status checks, NO required review** (required_pull_request_reviews was removed — the fleet is one GitHub identity, so no one could approve their own PR anyway). **BUT `enforce_admins=false` + the fleet pushes as the repo owner (admin), so a direct `git push origin HEAD:main` SUCCEEDS and BYPASSES the checks** ("Bypassed rule violations", accepted).';
  // Current corrected text, read from .orca/skills/land-from-worktree/SKILL.md on disk.
  const fixed = '**The invariant — this is what to rely on:** `main` advances **only** through a PR whose required status checks concluded `success` on its **current head**. **`enforce_admins: true` (t/3736), so there is no admin bypass** — a direct `git push origin HEAD:main` is REFUSED, and so is `gh pr merge --admin`.';
  const r1 = evaluateDocPlatformDrift({ claims: extractClaims(stale, '.orca/skills/land-from-worktree/SKILL.md'), live: LIVE, rangeValid: true });
  assert.equal(r1.verdict, 'fire');
  const r2 = evaluateDocPlatformDrift({ claims: extractClaims(fixed, '.orca/skills/land-from-worktree/SKILL.md'), live: LIVE, rangeValid: true });
  assert.equal(r2.verdict, 'clean');
});

// ── formatResult ──

test('formatResult: cannot-evaluate message names the fail-closed rule', () => {
  assert.match(formatResult({ verdict: 'cannot-evaluate', drift: [] }), /CANNOT EVALUATE/);
});

test('formatResult: fire message states the scope-boundary residual, never overclaims', () => {
  const msg = formatResult({
    verdict: 'fire',
    drift: [{ kind: 'enforce_admins_false', file: 'docs/x.md', line: 5, match: 'enforce_admins=false' }],
  });
  assert.match(msg, /drift-from-PLATFORM only/);
  assert.match(msg, /\.orca\/skills/);
});

// ── CLI shim: prove the RUNTIME the workflow invokes (test == runtime) ──
// Exercised against a temp dir with a synthetic stale doc, and against this repo's REAL
// docs/ tree to confirm the scanner finds the still-outstanding live drift (t/3797#1/#2
// docs have not yet been corrected as of this build — see the ticket for the live
// escalation of that separately-owned content fix).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MODULE = fileURLToPath(new URL('./doc-platform-drift-predicate.mjs', import.meta.url));

test('CLI shim: a temp repo with a stale doc and a reachable gh API fires', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3797-cli-'));
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'stale.md'), 'Bypass rights — `enforce_admins=false`, admins bypass the checks.');
  let threw = false;
  let stdout = '';
  try {
    execFileSync(process.execPath, [MODULE, dir], { encoding: 'utf8' });
  } catch (e) {
    threw = true;
    stdout = e.stdout;
    assert.equal(e.status, 1);
  }
  assert.equal(threw, true);
  assert.match(stdout, /FIRED/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI shim: a temp repo with no stale docs and a reachable gh API is clean', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3797-cli-'));
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'clean.md'), 'This document discusses deployment practices.');
  const out = execFileSync(process.execPath, [MODULE, dir], { encoding: 'utf8' });
  assert.match(out, /clean/);
  fs.rmSync(dir, { recursive: true, force: true });
});
