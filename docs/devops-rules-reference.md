# DevOps Rules Reference

Rationale and incident history behind the short rules in `operations/devops/AGENTS.md`, mirroring the root AGENTS.md's own `docs/agent-rules-reference.md` pattern. Keep the AGENTS.md entries short; put the "why" here.

## §1 — Dual-Lockfile Footgun (t/2188, PR #1802)

After any change to the `overrides:` block in `pnpm-workspace.yaml`, run both:

```
node scripts/sync-standalone-lockfile.mjs   # syncs taxonomy-editor/pnpm-lock.yaml
pnpm install --lockfile-only                # syncs root pnpm-lock.yaml
```

`sync-standalone-lockfile.mjs` regenerates `taxonomy-editor/pnpm-lock.yaml` for the Dockerfile prod-deps stage (copies the standalone lockfile and runs `--frozen-lockfile`). `pnpm install --lockfile-only` updates the root `pnpm-lock.yaml` — required because CI dependency-audit jobs run `pnpm install --frozen-lockfile` at the root and fail with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` if the root lockfile doesn't match the workspace overrides. Both lockfiles must be committed together. CI gate `lockfile-overrides-check` catches standalone-lockfile drift; root-lockfile drift is caught by `dependency-audit`.

## §2 — Pre-Authorized-Trigger Discipline (t/2452 drift remediation; p/331#1243–1246)

When an action is pre-authorized conditional on a trigger, act on your own verification if the trigger is a checkable fact ("once PR #N merges", "when CI is green on this SHA", "after the base rebuild lands") — verify it against the system, then proceed. Don't wait for a courtesy ping: it adds latency without adding safety, because the verification is what makes the action safe, not anyone's say-so. Wait for an explicit go only when the trigger is judgment-based ("once it looks stable", "if the team agrees"). Before a destructive step on someone's WIP (e.g. `git restore` on a dirty shared-tree file), snapshot first, then prove the work is preserved elsewhere — every field present at the same value on `origin/main` — before proceeding.

## §3 — Platform Attribution (PI-approved 2026-10-27, owner DevOps, review-by 2027-01-31)

Three occurrences on 2026-10-27, all within the t/4567 merge-queue live-fire cycle:
- **t/4567#19** — a "silent trigger stall" initially read as GitHub-side flakiness; turned out to be the `GITHUB_TOKEN`-authenticated-call workflow-trigger limitation, our own design assumption, not a platform defect.
- **t/4567#37** — same root cause, confirmed: GitHub does not start new Actions workflow runs for events caused by `GITHUB_TOKEN`-authenticated API calls, invalidating the original re-enqueue design.
- **t/4567#52** — a "transient API blip" that was actually a deterministic `AGE_MIN=15` / `[ "$AGE_MIN" -gt 15 ]` boundary condition in our own liveness-check script (exactly 15 is false; a re-dispatch 90 seconds later crossed into 16 and correctly tripped) — caught and corrected by the Second Opinion.

Each was initially blamed on GitHub being unreliable, and each turned out to be our own code or an off-by-one in our own condition. The rule exists so the next ambiguous failure gets reproduced before it gets a platform label.

## §4 — Evidence for Claims (PI-approved 2026-10-28, owner DevOps, review-by 2027-01-31)

Four occurrences on 2026-10-28, all within the t/4567 HEADGREEN part-2 review cycle:
- **e/387** — reported the PI had disabled merge-queue ruleset 26043005 based on the TL saying they were "asking the PI to disable it now"; the SO's review found it was still `active` live, with 4 PRs stuck, not 3.
- **K1 (e/392#2/#3)** — an SO request described PR #4055 as already containing the `merge_group` concurrency cancel; the diff at the actual head had no `concurrency:` key at all. Caught by the SO, not self-caught.
- **K4 ("CI green", e/392#4/#6)** — reported CI green on PR #4055 at a specific head; `merge-queue-f4-shim-test` was actually `failure` on that exact run. Caught by the SO re-checking job conclusions directly, not the PR-checks summary line.
- **t/4567#37 (arm-5 pass)** — a live-fire arm reported as passing without the underlying job conclusion confirmed at the exact run ID.

Every one of these was a reported state (ruleset status, diff contents, CI result) that turned out wrong when someone actually read the system instead of trusting the report. **Before reporting any state — "CI green", "X is in the PR", "applied", "passed" — read it at the exact head SHA or the live system, and include the evidence in the report:** the job conclusions at that SHA (not just the `gh pr checks` summary line — pull the actual run/job conclusion), the diff line (not a description of what you meant to change), the live API response (not what a teammate said would happen). A claim without that evidence is a guess wearing a verified claim's clothes.
