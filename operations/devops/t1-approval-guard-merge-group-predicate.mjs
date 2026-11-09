// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * PURE. t/4939 step 1: the `t1-approval-guard` merge_group arm must RE-EVALUATE the per-PR
 * predicate for every PR in the batch, not just report success -- an approval dismissed after
 * enqueue, or a PR whose approval never actually landed, must still fail the whole group.
 * `evaluateT1ApprovalGuard` (the already-unit-tested per-PR predicate) is run fresh for each
 * member by the caller (impure: needs live comments/reviews/commits); this function is the
 * pure aggregation step, kept separate so "does the group pass" is independently testable from
 * "how was each member's data fetched."
 *
 * `perPrResults` is `Array<{ number, result: { pass, tier, reason } }>`, one entry per PR
 * currently in the merge-group batch (self included). The group passes only if every member
 * passes; a single `pass: false` member fails the whole batch closed, same framing as
 * consult-hold-guard/joint-gv-guard (ci.yml).
 *
 * An EMPTY batch FAILS CLOSED (Lead/SO, p/648#348) -- it does not mean "nothing to check," it
 * means this function was handed nothing to prove, and "cannot prove this batch is safe" must
 * read as a failure, not a pass. In practice `get-merge-group-prs.sh` already exits 1 on zero
 * PRs before this function is ever called, so an empty array reaching here is itself a sign
 * something upstream (the enumerator, or its invocation) is broken -- failing here is the
 * second line of defense, not a load-bearing one.
 */
export function classifyMergeGroupApprovals(perPrResults) {
  if (!perPrResults || perPrResults.length === 0) {
    return { pass: false, failingNumbers: [] };
  }
  const failing = perPrResults.filter((p) => !p.result?.pass);
  return {
    pass: failing.length === 0,
    failingNumbers: failing.map((p) => p.number),
  };
}
