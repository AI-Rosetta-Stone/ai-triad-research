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
