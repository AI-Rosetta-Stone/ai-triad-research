// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Re-pin tier predicate (t/305, t/309). PURE: no imports, no I/O, no globals, so it can be
// imported as-is by both its callers:
//   - operations/devops/docker/base-pin-drift.mjs, when the drift workflow opens a re-pin PR;
//   - the T0 enqueue sweep (DevOps, t/309), which re-checks a `docker/base-repin-*` head before
//     auto-merging it. That way a later push to the branch can't keep a `Tier: T0` it no
//     longer earns.
// Keep it import-free: repin-tier.test.mjs fails if an import appears.
//
// Tests: node --test operations/devops/docker/repin-tier.test.mjs
//        (the drift module's own tests also cover classifyRepinTier through its re-export)

export const IMAGE = 'ghcr.io/ai-rosetta-stone/ai-triad-base';
/** Branch prefix of the drift workflow's re-pin PRs; the T0 sweep keys its re-check on it (t/312). */
export const BRANCH_PREFIX = 'docker/base-repin-';
export const DATE_TAG = /^\d{4}-\d{2}-\d{2}$/;
export const DIGEST = /^sha256:[0-9a-f]{64}$/;
/** The runtime stage's FROM line, and ONLY for our own ai-triad-base. Groups: tag, digest. */
export const RUNTIME_FROM = /^FROM\s+ghcr\.io\/ai-rosetta-stone\/ai-triad-base:(\S+?)@(sha256:[0-9a-f]{64})\s+AS\s+runtime\s*$/i;

/**
 * PURE. The tier a re-pin change may declare (t/305; PI decision 4, TL guardrail p/103#19).
 * `Tier: T0` makes the T0 enqueue sweep merge it with no human, so T0 is allowed ONLY when the
 * change is exactly one line, that line is the runtime FROM before and after, and both point at
 * our own ai-triad-base (RUNTIME_FROM matches only that image) with a date tag and digest.
 * Anything else is T1, so `Tier: T0` can't carry another Dockerfile edit.
 *
 * Inputs are the Dockerfile's full text before (base) and after (head). Callers must also check
 * that the change touches no other file; this function only sees one file.
 * @param {string} beforeText
 * @param {string} afterText
 * @returns {{tier: 'T0'|'T1', reason: string}}
 */
export function classifyRepinTier(beforeText, afterText) {
  const t1 = (reason) => ({ tier: 'T1', reason });
  const before = String(beforeText).split(/\r?\n/);
  const after = String(afterText).split(/\r?\n/);
  if (before.length !== after.length) return t1(`line count changed (${before.length} -> ${after.length})`);
  const changed = [];
  before.forEach((line, i) => { if (line !== after[i]) changed.push(i); });
  if (changed.length !== 1) return t1(`${changed.length} lines changed, want exactly 1`);
  const i = changed[0];
  const was = RUNTIME_FROM.exec(before[i].trim());
  const now = RUNTIME_FROM.exec(after[i].trim());
  if (!was || !now) return t1(`line ${i + 1} is not the '${IMAGE}:<tag>@sha256:<digest> AS runtime' line on both sides`);
  if (!DATE_TAG.test(was[1]) || !DATE_TAG.test(now[1])) return t1('tag is not YYYY-MM-DD on both sides');
  if (was[1] === now[1] && was[2] === now[2]) return t1('pin did not change');
  return { tier: 'T0', reason: 'only the runtime ai-triad-base tag/digest changed (dependency bump, docs/change-tiers.md)' };
}
