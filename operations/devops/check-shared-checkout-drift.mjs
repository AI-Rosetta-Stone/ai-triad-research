// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/557 (TL p/9#518 item 3, t/537#43): alert when the SHARED checkout falls behind or diverges from
// origin/main. It sat 71 commits and about 29 hours behind, so every session read stale AGENTS.md
// rules and ran a pre-#5439 enqueue-pr.mjs, and nothing noticed. check-data-checkout-drift.ps1
// covers only the data repo.
//
// READ-ONLY. It runs `git fetch origin` and reads; it never syncs, resets or stashes. Syncing stays
// the manual procedure with all-clears (docs/shared-tree-divergence.md).
//
// ALERT when any holds: the branch is not `main`; ahead > 0 (diverged); any tracked modification;
// behind > 10 commits; behind for more than 2 hours (the oldest commit on origin/main that the
// checkout lacks is older than 2 h). A fetch or read failure is ALERT `cannot-verify`, never OK.
//
// Output: one JSON line. Exit 0 on OK, 1 on ALERT.
//
// Run hourly by an Interweave reminder in the DevOps Worker's session. On ALERT the Worker pings the
// DevOps Lead once per distinct state: `isNewState` compares the state key (verdict + sorted reasons)
// with the ledger; pass `--record` after a successful ping to store it. An OK clears the ledger, so
// the next ALERT pings again.
//
//   node operations/devops/check-shared-checkout-drift.mjs [--repo <path>] [--record]
//   (--repo defaults to the shared checkout: the parent of `git rev-parse --git-common-dir`, so it
//    works from any worktree)
//
// Pure core: driftVerdict, stateKey. Impure shim: collectDrift (git injectable), ledger I/O.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_BEHIND_COMMITS = 10;
export const MAX_BEHIND_MS = 2 * 60 * 60 * 1000;

/**
 * PURE. The verdict for one reading. `facts` is collectDrift's result:
 * { fetchError?, branch, ahead, behind, oldestMissingMs, trackedMods: [path] }.
 * Returns { verdict: 'OK' | 'ALERT', reasons: [string], ...facts for the JSON line }.
 */
export function driftVerdict(facts, nowMs) {
  if (!facts || facts.fetchError) {
    return { verdict: 'ALERT', reasons: ['cannot-verify'], detail: String(facts?.fetchError ?? 'no reading') };
  }
  const { branch, ahead, behind, oldestMissingMs, trackedMods = [] } = facts;
  const ageMs = behind > 0 && Number.isFinite(oldestMissingMs) ? Math.max(0, nowMs - oldestMissingMs) : 0;
  const reasons = [];
  if (branch !== 'main') reasons.push('not-on-main');
  if (ahead > 0) reasons.push('ahead-of-origin');
  if (trackedMods.length > 0) reasons.push('tracked-modifications');
  if (behind > MAX_BEHIND_COMMITS) reasons.push('behind-too-many-commits');
  if (behind > 0 && ageMs > MAX_BEHIND_MS) reasons.push('behind-too-long');
  return {
    verdict: reasons.length ? 'ALERT' : 'OK',
    reasons,
    branch, ahead, behind,
    oldestMissingAgeMinutes: behind > 0 ? Math.round(ageMs / 60000) : 0,
    trackedMods,
  };
}

/** PURE. The dedupe key: one ping per distinct state. */
export function stateKey(result) {
  return `${result.verdict}:${[...(result.reasons ?? [])].sort().join(',')}`;
}

/**
 * Impure (git injectable). Reads the facts. Never throws: a failure returns { fetchError }.
 * `git(args) -> stdout` runs in the checkout being checked and throws on a non-zero exit.
 */
export function collectDrift(git) {
  try {
    git(['fetch', '-q', 'origin']);
    const branch = String(git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const counts = String(git(['rev-list', '--left-right', '--count', 'HEAD...origin/main'])).trim();
    const m = /^(\d+)\s+(\d+)$/.exec(counts);
    if (!m) throw new Error(`unexpected rev-list output ${JSON.stringify(counts)}`);
    const ahead = Number(m[1]);
    const behind = Number(m[2]);
    let oldestMissingMs = null;
    if (behind > 0) {
      // Empty fields dropped first: Number('') is 0, which would read as a 1970 commit.
      const times = String(git(['log', '--format=%ct', 'HEAD..origin/main'])).trim().split(/\s+/)
        .filter((t) => /^\d+$/.test(t)).map(Number);
      if (!times.length) throw new Error('behind > 0 but no missing commit times were read');
      oldestMissingMs = Math.min(...times) * 1000;
    }
    const status = String(git(['status', '--porcelain', '--untracked-files=no']));
    const trackedMods = status.split('\n').filter((l) => l.trim()).map((l) => l.slice(3));
    return { branch, ahead, behind, oldestMissingMs, trackedMods };
  } catch (err) {
    return { fetchError: String(err?.stderr || err?.message || err).trim().split('\n')[0] };
  }
}

export const DEFAULT_LEDGER = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'state'), 'aitriad', 'shared-checkout-drift.json');

/** Reads the last pinged state key, or null. An unreadable ledger reads as null (a ping is the safe side). */
export function readLedger(file = DEFAULT_LEDGER) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).lastKey ?? null : null;
  } catch {
    console.warn(`WARN check-shared-checkout-drift: could not read the ledger ${file}; treating this state as new (a duplicate ping is the safe side).`);
    return null;
  }
}

export function writeLedger(lastKey, file = DEFAULT_LEDGER) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ lastKey, at: new Date().toISOString() })}\n`);
}

/** The shared checkout's root: the parent of the common git dir, so a worktree finds the main checkout. */
export function sharedCheckoutRoot(cwd = process.cwd()) {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' }).trim();
  return path.dirname(common);
}

/** One run: collect, judge, compare with the ledger. `record` stores the key (after a successful ping). */
export function run({ git, nowMs = Date.now(), ledgerFile = DEFAULT_LEDGER, record = false } = {}) {
  const result = driftVerdict(collectDrift(git), nowMs);
  const key = stateKey(result);
  const last = readLedger(ledgerFile);
  const out = { ...result, stateKey: key, isNewState: result.verdict === 'ALERT' && key !== last };
  if (result.verdict === 'OK') {
    if (last !== null) writeLedger(null, ledgerFile); // a recovery clears it, so the next ALERT pings
  } else if (record) {
    writeLedger(key, ledgerFile);
  }
  return out;
}

const isCliEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliEntry) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--repo');
  let repo;
  try {
    repo = i >= 0 && args[i + 1] ? args[i + 1] : sharedCheckoutRoot();
  } catch (err) {
    console.log(JSON.stringify({ verdict: 'ALERT', reasons: ['cannot-verify'], detail: `could not find the shared checkout: ${String(err?.message ?? err).split('\n')[0]}` }));
    process.exit(1);
  }
  const git = (a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const out = run({ git, record: args.includes('--record') });
  console.log(JSON.stringify({ repo, ...out }));
  process.exit(out.verdict === 'OK' ? 0 : 1);
}
