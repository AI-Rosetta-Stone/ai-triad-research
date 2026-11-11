# t/4383 item 2 — re-extract org stance claims under the gate-passed prompt

The t/4383 candidate prompt passed its pre-registered gate (run 7): C1 90.1% verbatim (bar ≥ 90%),
C2 10/10 sources at ≥ half their old yield, C3 polarity mix unchanged. It landed on `main` in #4897
(68ced612b). Every claim in `organization_stance_claims.json` predates it. **Anchor: Interweave t/242.**

**Frozen scope (`frozen_list.json`):** 77 claims over 13 (org, source) pairs and 5 orgs, taken from
data `origin/main` 06cfbb9f (sha256 of the LF blob recorded). All were extracted 2026-07-12 with
gemini-3.1-flash-lite, and none has `text_verbatim`. Pairs linked after this snapshot are out of scope.
*Re-pinned* after t/293 removed org-017's 4 claims on a presidential EO misattributed to OSTP (Second
Opinion condition p/120#5). The first freeze (81 claims, 14 pairs, e8c0ea43) is kept under `repinned`.

**Status: on hold (human, p/97#4: keep the old claims).** A scratch re-extraction (authorized as
spend only) did not reproduce gate run 7: 81–87% verbatim against the 90% bar, and 9 of 14 pairs
covered (t/242#4). Before proposing again: establish run 7's model and settings, and decide how
the duplicate-variant pairs are handled (t/291). Any further run or write needs fresh authorization.

**Procedure (`/data-mutation`):**
1. Extract to a scratch file: `Invoke-OrgStanceExtraction -Org <the 5 orgs> -Force -OutputPath <scratch>`.
   This never writes the corpus. The cmdlet can't take a pair list, so the scratch output may hold
   extra pairs, and the write ignores them.
2. A write script reads `frozen_list.json` and replaces claims for exactly the 13 pairs with their
   scratch claims. It refuses if the target file's sha256 no longer matches. It is dry-run by
   default, and checks for zero collateral changes: only those pairs' claims change, `claim_count`
   is updated, and every other byte is unchanged.
3. Run it on a clean data tree, with its own commit. Verify the committed blob, then hand to a
   second agent for an independent re-count.
4. Re-measure: C1 verbatim share on the new claims (via `Test-StanceTextVerbatim`), and the
   precision of the t/4876 participant-attribution filter. Its calibration baseline is 3/3 recall
   and 0 FP over 123 unique claims.

**Model:** `enrichment.org-stance-extraction` now resolves to gemini-3.5-flash-lite (`ai-usages.json`),
not the 3.1 that produced the current claims. The re-extraction runs on the registry's current
model, and each claim records `extraction_model`.

**Provenance class:** derived (gate run 7, pre-registered criteria).
