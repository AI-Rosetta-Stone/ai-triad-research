# Runbook: Required-Context Swap Protocol

**Owner:** DevOps. **Last updated:** 2026-09-30

Changing which status contexts are required on `main` silently strands every open PR that predates the swap: the new check never reports on those PRs, so armed auto-merge cannot fire. This runbook makes the swap and the re-trigger a single atomic operation.

See also: `docs/orca-github-workflow.md` §5 (costs) and §6 item 4.

> **Before you touch branch protection:** if a PR is `BLOCKED` but its required checks all read
> **green**, this runbook is probably the WRONG tool — that's usually a duplicate in-flight CI
> suite, not a context problem. See [merge-state-troubleshooting.md](merge-state-troubleshooting.md)
> first (t/3605 was mis-diagnosed as a context outage and cost a HIGH ticket).

---

## When this applies

Any change to `required_status_checks.contexts` on the `main` branch — adding a context, removing one, or renaming one — requires running the re-trigger step below before considering the change complete.

---

## Protocol

### Step 1 — Make the protection change

> **⚠️ Use the `required_status_checks` SUB-RESOURCE, never a full `PUT /protection`.**
> A full `PUT` to `.../branches/main/protection` replaces the **entire** protection object — every
> field you omit or misstate is silently reset. That is how you regress `enforce_admins` to `false`
> (it is `true` today — t/3736) or drop a required context such as `joint-gv-guard`. The
> `PATCH .../required_status_checks` sub-resource below touches **only** `strict` + `contexts` and
> leaves `enforce_admins`, reviews, and restrictions untouched. (t/3780)

**First, read the CURRENT contexts** — the swap is relative to live state, not to this doc (which drifts):

```bash
gh api repos/AI-Rosetta-Stone/ai-triad-research/branches/main/protection/required_status_checks --jq '.contexts'
```

**Then PATCH the full desired set.** The `contexts` array is **replace-semantics** within this
sub-resource, so list every context you want to keep, plus/minus your change:

```bash
# Example: ADD "<new-context>" to the set you just read. Edit the list to match the CURRENT contexts.
gh api -X PATCH repos/AI-Rosetta-Stone/ai-triad-research/branches/main/protection/required_status_checks \
  --input - <<'EOF'
{
  "strict": false,
  "contexts": ["ci-gate", "CodeQL", "joint-gv-guard", "<new-context>"]
}
EOF
```

Verify the change took effect:

```bash
gh api repos/AI-Rosetta-Stone/ai-triad-research/branches/main/protection/required_status_checks --jq '.contexts'
```

### Step 2 — Re-trigger every open PR (mandatory)

Run immediately after the protection change — do not skip, do not defer:

```powershell
# Dry-run: shows what would be triggered
./operations/devops/Invoke-ContextSwapRetrigger.ps1 -WhatIf

# Live run: triggers ci.yml and codeql.yml on every open PR's branch
./operations/devops/Invoke-ContextSwapRetrigger.ps1
```

The script:
- Auto-fetches the current required contexts from the live branch protection
- Prints a **before** table showing each PR's current check state
- Close-reopens each open non-draft PR to synthesize a fresh `pull_request` event, causing all PR-triggered workflows (ci.yml, codeql.yml, etc.) to run without modifying the branch
- Polls up to 8 minutes for terminal state
- Prints an **after** table with `before → after` per context per PR
- Exits 0 if all PRs report all required contexts as `success`; exits 1 otherwise

**Trade-off:** close-reopen sends GitHub notifications and briefly de-arms auto-merge. For the rare context-swap operation this is acceptable; it is the only mechanism that reliably re-triggers all PR workflows without `workflow_dispatch` on each workflow file or empty commits on each branch.

Optional parameters:

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `-Repo` | `AI-Rosetta-Stone/ai-triad-research` | Target repo |
| `-RequiredContexts` | fetched from live protection | Override which contexts to verify |
| `-TimeoutMinutes` | `8` | Extend for slow CI |
| `-WhatIf` | off | Dry-run |

### Step 3 — Confirm

The script exits with a summary. If any PR is not green:

1. Check the after table — identify which context is missing or non-success.
2. Re-run without `-WhatIf` to trigger again, or trigger that specific PR manually: `gh pr view <N>` → push an empty commit.
3. Do not consider the swap complete until the script exits 0.

---

## Enforcement mechanism

A **feedback rule** (`context-swap-reminder`) fires on every Bash/PowerShell tool call and injects a reminder to run this protocol if a protection change is in progress.

**Limitations (both must be stated per ticket t/2076):**

1. **Session-start lag (t/1625):** A feedback rule is pinned to the manifest loaded at session start. A rule created mid-session is not active until the next session start — the creating session cannot verify it fires.

2. **Broad trigger (condition parser limitation):** The Orca condition parser does not support substring matching on `input.command`. The rule therefore fires on *all* Bash/PowerShell calls, not only protection-change calls. A 1-hour cooldown limits noise. Operators should dismiss it unless they are performing a context swap.

The rule is advisory: it surfaces the reminder but cannot block the protection call. The script's exit code and the before/after table are the authoritative gate.

---

## Precedents

- Six-contexts → `ci-gate` swap (t/1962): stranded open PRs discovered after the fact.
- `strict: true` evaluation (t/2074): planned swap that this protocol covers going forward.
