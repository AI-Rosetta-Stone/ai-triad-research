# Agent Rules Reference

**Last updated:** 2026-10-07
**Author:** Tech Lead (t/4094)

The detail, rationale and incident history behind the short rules in the root `AGENTS.md`. Moved here verbatim on 2026-10-07 so the root file stays short (t/4094). The root file is authoritative for *what* to do; this file explains *why* and records the incidents. Where the two ever disagree, the root wins and this file is corrected.

## 1. Feedback rules: authoring, repair and liveness

**Create feedback rules only through `create_feedback_rule` — never hand-edit `.orca/feedback-rules/*.yaml`.** Hand-writing bypasses validation *and* registration: the file lands on disk, `get_feedback_rule` reports it `enabled: true`, and the rule never loads or fires. Invisible-dead. Same discipline as `SKILL.md` → `manage_skill`, for the same reason.

This is how **13 rules sat dead fleet-wide**, including the workspace secret scanner — invalid parameter `source:` prefixes (`input.`, `toolInput.`, bare `tool_name`) that `create_feedback_rule` rejects at authoring but a direct file-write admits silently.

**Repairing an already-invalid rule: `update_feedback_rule` will refuse it.** It validates the *stored* definition first, so it rejects exactly the rules that need fixing. **Delete-then-create is the only repair route** — back the definition up first; the delete is irreversible, and per-rule `scope`/`scope_path` is easy to drop on re-creation (that would silently widen a profile-scoped guard fleet-wide).

**Three facts, and only the third proves a *specific* rule ran:**
- **Listed** in `list_feedback_rules(enabled: true)` → the runtime *loaded* it. (As of 2026-10-01 this returns all loaded rules — 33 — so the older short-set gap is gone; see the Pre-Self-Merge note below.)
- **`fire_count_24h > 0`** → the rule's **matcher** was invoked — **not** that *this* rule executed. The counter is per-matcher (within a scope), so every rule sharing a matcher reports the *same* number (e.g. all workspace `Bash|PowerShell` PreToolUse rules show one identical count, including rules that skip on every call). A non-zero count cannot distinguish a rule that ran from one merely eligible.
- **An injection you have read, with correct content** → it *works*. With the middle rung demoted to "the matcher was hit," this is the **only** evidence a specific rule executed.

A parameter referenced only in the `template` (not the `condition`) can resolve to empty while the rule fires normally — which is how the secret scanner ran telling agents to scan and handing them nothing. Where a parameter is used in the `condition`, a fire *does* prove resolution, because the condition cannot evaluate true on an empty value.

## 2. Workflow mode and the shared checkout

**Read the mode before assuming the rules below.** A single overlay-tracked file, `.orca/workflow-mode`, selects the fleet's branching discipline. Line 1 is the mode; everything from `#` is provenance (who set it, when, why). Check it with `sh .githooks/read-workflow-mode.sh`.

- **`worktree`** (strict) — feature work happens in a worktree off a branch; the shared checkout stays on `main`; `pre-commit` refuses commits on `main`.
- **`direct`** — worktrees and branches are not required; commits on `main` in the shared checkout are permitted.

**Fail-safe:** anything other than exactly `direct` on line 1 — missing file, empty, `Direct`, `direct foo` — resolves to `worktree`. A deleted or corrupt file tightens, never loosens. The canonical parse (trimmed line 1, case-sensitive `== "direct"`) lives in `.githooks/read-workflow-mode.sh`; the two feedback-rule scripts mirror it.

**Changing the mode is a deliberate act, not a preference.** `direct` removes a protection born from an incident (t/1926): the fleet shares one `main` checkout, so a commit there sits in every other agent's tree. That is low-cost when one person works alone and hazardous at high parallelism — **the dangerous transition is leaving `direct` on when the fleet spins back up.** Record set-by/set-at/reason in the file when you change it.

**In `direct` mode the shared checkout still stays on `main`. `direct` licenses *committing* there — not *rewriting what is on disk* there.** Six collisions in one session (2026-09-28), one cause: anything that moves HEAD or rewrites the working tree mutates every file other agents are actively reading. A file vanished from disk mid-edit; a working tree was swapped out from under an in-flight task (t/3704#8); uncommitted WIP compiled into a peer's `npm run verify`, producing a red that belonged to neither agent; a commit was orphaned by a concurrent HEAD move; and a `reset` left the tree **behind its own HEAD**, missing three just-landed files — a state in which any `git commit -a` would have deleted a colleague's merged work from `main`.

This is not `direct` failing at what it is chosen for — one agent committing small changes straight to `main` is exactly what it makes cheap, and that still works. Two things make it hazardous at fan-out. *"Branches are not required"* reads as *"branches are safe here."* And **the hazard is realized by careful work, not careless work**: the `reset` above was a deliberate attempt to resolve a push conflict *without* disturbing a colleague's uncommitted file. A mode whose failures arrive through care cannot be mitigated by asking people to be careful. So:

- **Safe *for other agents' trees*:** `commit`, `push`, `fetch`, `status`, `log`, `diff` — read-only, or additive to history. **"Safe" here means only that it will not disturb a colleague's working tree. It does NOT mean a direct push of code to `main` is sanctioned** — that bypasses the required status checks in *either* mode, which is a review concern the workflow mode does not govern. Land code through a PR.
- **Worktree-only, in BOTH modes:** `checkout`, `reset`, `rebase`, `merge`, `pull --rebase`, `stash` — anything that moves HEAD or rewrites the tree. `git worktree add` costs seconds; the collision costs a colleague's uncommitted work.
- **Never `git commit -a` (or `git add -A`) here.** Distinct from the staged-index rule below: `-a` bypasses the index and commits every tracked modification **including deletions**, so a stale working tree becomes a destructive commit in one step. Commit with an explicit pathspec.
- **Scan `git status --short` UNSCOPED before any tree-wide build.** A peer's uncommitted file compiles into your `npm run verify`, so a red may not be yours. Your branch's CI sees only committed files and is the authoritative signal.
- **Push immediately after committing on shared `main`** — not at the end of the task. If the push is rejected, do **not** resolve it in place; cherry-pick to a worktree and land it from there. Resolving a rejected push on the shared tree *is* the prohibited rewrite. A tree that has already diverged is cleaned up by **DevOps only**, per **`docs/shared-tree-divergence.md`** — the distinction is that an incidental rewrite mid-task is prohibited while an announced, precondition-checked maintenance sync is required (a tree that can never sync goes stale, which caused two of the six collisions itself).

**Applies in `worktree` mode.** `.githooks/pre-commit` refuses commits on `main` (t/1926); in `direct` mode it permits them. **Both modes** still refuse a commit on a detached HEAD inside a worktree (t/2009) — that guards a different failure and the switch does not govern it. `--no-verify` remains the emergency override. Enable once per checkout: `git config core.hooksPath .githooks`.

**In `worktree` mode, feature work is worktree-only and the shared checkout stays on `main`.** `/land-from-worktree` is branch-first (`git worktree add -b <branch>`). `.githooks/post-checkout` warns (advisory) when the shared tree leaves `main` (t/2209); silent in `direct`.

**Confirm you're in a worktree before your FIRST edit (t/3207) — in `worktree` mode.** Editing tracked files on the shared `main` tree leaks uncommitted WIP and risks a `git add -A` sweep spraying 0-byte junk. The PreToolUse Edit/Write hook warns, but the discipline is: worktree first, then edit. **Known gap:** the two feedback rules do not yet honour `direct` and will warn regardless — noise, not obstruction (t/3632).

**Shell cwd resets to the shared checkout between tool calls (t/2222).** Creating a worktree isn't enough — always `cd` into it **in the same command**: `cd .worktrees/<name> && <cmd>`. A stray `cd`-reliant command combined with a mis-quote sprays 0-byte junk files across every scope. Prevention: same-command `cd`; never paste multi-line code into the shell (see Shell Quoting Rule).

## 3. Pre-self-merge verification

Before `gh pr merge`, confirm all four (prevents stranded/stale-head merges — #710, #701, #830/#831, t/2470):
0. **Base is `main`** — `gh pr view <N> --json baseRefName` (GitHub silently suggests the parent feature branch).
1. **Head matches your push — ENFORCE it with `--match-head-commit`.** Always self-merge as:
   `gh pr merge <N> --squash --match-head-commit $(gh pr view <N> --json headRefOid -q .headRefOid)`
   GitHub then refuses the merge *atomically* if the live head ≠ that SHA — race-free: a stale local view OR a newer push both abort instead of stranding the later commit (#1868). Never run a bare `gh pr merge` without this flag.
2. **CI ran on that exact OID** — `gh run list --commit <headRefOid>` is green, not a predecessor's.
3. **No open decision/hold** you haven't cleared.

> **✅ LIVE as of 2026-10-05, ADVISORY (it warns; it does not block yet).** `pre-self-merge-verify` was inert for weeks: the stored rule had `parameters: []`, so `{command}` in its `run:` was never substituted. Orca Support re-created it with the parameter declared, and a bare `gh pr merge 99999` then **injected** the `PRE-SELF-MERGE HEAD GUARD (advisory…)` text in two independent fresh sessions (t/3698#38, #41). That is the only evidence that counts. **Flip to blocking** = one advisory cycle, then TL Gate Verification, then a mandatory Second Opinion. An earlier version of this note said "do NOT re-author, the definition is correct"; that was wrong, and re-creation was the fix.
>
> **Branch protection is still the enforcing layer** (t/3736: `enforce_admins: true`, required contexts `[ci-gate, CodeQL, joint-gv-guard]`). GitHub refuses any merge, admins included, unless every required context passed on the PR's **current head**, so *merging a head nothing tested* is refused there (observed, t/3736#11: `HTTP 405 Required status check "ci-gate" is failing.`). **What protection does not cover:** old head and new head **both green**, and you merge a SHA you never reviewed. `--match-head-commit` guards exactly that, so always pass it. (Reasoned from the protection predicate, not yet observed.)
>
> **`auto-merge-jointgv-guard`** had different defects (an invalid `input.command` source and an `argv[2]` off-by-one). Its definition is fixed but it stays **disabled** by design, since the `joint-gv-guard` required context covers the hazard. **Do not re-enable it without TL** (t/3698#39).
>
> **Authoring lessons for any `run:`-based rule** (all from these repairs, t/3698#38):
> 1. Every `{name}` used in `run.args` must be declared in `parameters`. An undeclared one renders empty, and the rule looks enabled while judging nothing.
> 2. `template` must contain `{run.stdout}`, or the run's output is silently dropped.
> 3. **Never put adjacent `}}` or `{{` in an inline script.** The executor collapses them into `}`/`{` and the script breaks (platform bug **t/3909**). Separate them with a space. `/feedback-rule-drift-check` now scans for this.
> 4. **No tool tells you a rule is live; only an observed injection does.** `get_feedback_rule` reports the *definition* (this rule said `enabled: true` while dead). `list_feedback_rules(enabled: true)` is the better liveness signal (absent ⇒ not live), but present ≠ executing. Fire a deliberately triggering no-op and read what comes back, and repeat after any platform update.

The `pre-self-merge-verify` hook **injects an advisory** on a manual `gh pr merge` that omits `--match-head-commit` (t/3270; pure-predicate `operations/devops/merge-guard-predicate.mjs`). It is not blocking yet; see above. `--auto` is exempt: it can't carry the flag and is stale-head-safe by GitHub re-targeting, and its gated-PR risk is handled by the `consult-hold` and `joint-gv` contexts. **Emergency override, once it blocks** (broken tooling / P1 hotfix), in the same spirit as the commit-guard's `--no-verify`: `disable_feedback_rule pre-self-merge-verify`, merge, then re-enable.

**Merge queue (t/4567, t/4580).** Once `main` moves to the GitHub merge queue, "self-merge" becomes "enqueue pinned", a bare manual merge is refused by branch protection, and the incident hotfix jumps the queue without skipping any required check. The queue rationale, the fail-closed label guards, and the SO conditions C1–C5 are in t/4567 and t/4580.

## 4. PR-flow practice rules (full text)

> **Superseded on 2026-10-12 (t/4093): the hold ceremony below.** The `consult-hold` label, for T2 only, is now the only required hold. Draft state, hold comments and the verbatim conditions checklist are optional visibility aids.
>
> **Why it's safe to drop them:** the label is a required context (`consult-hold-guard`) that blocks every merge path, admins included. The paraphrase risk that the checklist addressed (5 of 9 conditions lost, 2026-09-28) is closed differently: **the consultant clears against their own conditions,** so nothing depends on the author's restatement.
>
> **Why it changed:** the stacked devices raised the p90 lead time of held PRs to 6.05h, against 1.08h for the rest (t/4091). The bullets below are kept for their incident history.

- **Batch sequential same-feature work** onto one branch / one PR unless the diff exceeds ~400 lines, mixes concerns, or a peer needs an intermediate step on `main`.
- **Merge promptly on green** — verify (above) and merge within ~15 min, or record the hold as a PR/ticket comment. An unmerged green PR with no recorded hold is drift.
- **Arm auto-merge at PR creation for eligible PRs:** `gh pr merge <N> --auto --squash` right after `gh pr create`. **Arming means "I'm done"** — anything pushed afterwards merges as soon as it's green, so disarm (`--disable-auto`) before pushing more work. **Do not arm** `consult-hold` or `joint-gv` PRs (arming a `joint-gv` PR fails its required check), PRs awaiting a mandatory Second Opinion or implementing consult conditions (t/3714), PRs needing a Main (TL) review before merge, drafts, or PRs whose base isn't `main` (epic children and the epic → `main` PR). (e/245)
- **Gated PRs: apply the `consult-hold` label (the enforcing gate), AND keep draft + a hold comment (visibility).** The `consult-hold` label is now a **live required status context** — `consult-hold-guard` (t/3680; refusal proven end-to-end 2026-09-30, both arms isolated) **blocks the merge on GitHub's side for every path** (human, agent, server-side auto-merge), binding admins too under `enforce_admins: true` (t/3736). That is the gate. **Do NOT rely on draft alone to enforce** — the prior "only draft enforces" claim was false: automation can un-draft a PR with the owner's credentials, indistinguishable from a human in the timeline (t/3680#3, #2494). Draft + a hold comment remain worth keeping — they tell a reader *why* before they clear the label — but the enforcement is the label. Clear it only when the gate is verifiably clear (removing the label re-runs the check green without a push); emergency override is a branch-protection admin override — **PI-only; agents are classifier-blocked from branch-protection changes, so escalate rather than attempt it** (`deploy/azure/runbooks/enforce-admins-override.md`), not un-drafting. (t/2603/#997, t/3680)
- **A PR implementing consult conditions carries them in its body as a checklist — VERBATIM — and stays draft with no `--auto` until every box is ticked (t/3714, e/218).** Copy the conditions **as the consultant wrote them** and tick against *that* text, never against your own restatement: a faithful paraphrase is precisely where items vanish, and they vanish invisibly to the person paraphrasing. Five of nine went missing that way on 2026-09-28 and were only recovered because a third party diffed the two lists. Like a hold comment, the checklist is **visibility at the merge button, not a gate** — which is why it needs its pair: **auto-merge removes merge time, so a checklist on an `--auto` PR is a well-formatted list nobody reaches.** Both #2480 and #2491 armed auto-merge while the review that produced their conditions was still in flight, on the same day this rule was written. **The enforceable form — the `consult-hold` label as a live required context — is now in force (t/3680, 2026-09-30): apply it at PR creation (`gh pr create --label consult-hold`) so the gate holds from t=0.** The checklist + draft remain the *visibility* half (they say why); the label is the *gate* half (it blocks).
- **Co-merge / joint-GV PRs carry the `joint-gv` label; never `--auto` them.** When two+ PRs must land together (a locked cross-role contract) or a PR is gated on a joint TL Gate-Verification, label it `joint-gv`. Auto-merge fires the moment checks go green and merges the PR ALONE on whatever head is current — jumping the group and stranding reviewed work (t/3307: #1947 auto-merged without its ElectronMain pair, briefly breaking main). **The `auto-merge-jointgv-guard` FEEDBACK RULE is disabled by design.** Its definition was repaired on 2026-10-05 (t/3698#39), but the hazard it guarded is covered by a required status context. Don't re-enable it without TL. `.github/workflows/joint-gv-guard.yml` (t/3607) is a required check on `main` that **fails when a `joint-gv`-labelled PR has auto-merge armed**, and with `enforce_admins: true` (t/3736) that refusal binds admins, agents and GitHub's server-side auto-merge alike. So `--auto` on a `joint-gv` PR **is** blocked — by branch protection, not by the rule (the disabled rule's `merge-guard-predicate.mjs` `--jointgv` mode, t/3318). Keep merging these manually with `--match-head-commit` after the joint GV; the guard is a backstop, not a substitute for the coordination.

## 5. Epic branches and duplicate parallel land

A large feature spanning multiple roles uses an **epic integration branch** (`epic/<name>`) with a single shared PR (epic → `main`) as the sole integration point. Rules for everyone working an epic (t/3618):

- **Child PRs target the epic base, NEVER `main`.** A child that lands on `main` while the epic is live is the duplicate-parallel-land bug below. Epic-base PRs now get **full CI** (t/3642, #2403 — `push`/`pull_request` triggers include `epic/**`), so the old "open against `main` first, then retarget" workaround (t/3623#5) is **RETIRED** — that workaround was itself the duplicate-parallel-land vector.
- **Claim before implementing** an epic child (per above), and check whether the ticket already has a PR **on any base** — an epic child and a direct-to-`main` PR for the same ticket is exactly the failure.
- **One shared PR** (epic → `main`) is the integration point; don't open a second PR for the same ticket against a different base.
- **Review each child at merge-into-epic time**, not deferred to the final epic PR. A multi-role diff reviewed only at the end is effectively unreviewable; per-child review at integration is what keeps the shared PR landable.

**Duplicate parallel land** (t/3655, from t/3621 landing on both `main` #2385 and the epic branch): one ticket implemented twice, onto two non-ancestor bases, whose copies then co-evolve. Two variants:
- **LOUD** — the copies touch the same files → merge conflict blocks the epic→`main` PR. Self-announcing; you'll see it (this is how t/3621 surfaced). No gate needed; this section is the prevention.
- **QUIET** — one copy is a subset of, or disjoint from, the other → the epic PR **auto-merges clean and nobody notices** the duplicated work. "No conflict" does **not** mean "no duplicate land." This variant has no signal — the only defense is claiming + targeting the epic base up front.

## 6. Shell quoting, junk files and the shared index

For code with special shell chars (template literals, nested quotes, apostrophes, backticks, `$` vars, f-strings), **use Edit/Write, not Bash `sed`/`awk`/heredocs**. Run Python/PowerShell scripts from a temp file (Write then execute), never inline heredocs. Shell escaping is the #1 silent-corruption source.

**Junk-file hygiene (t/2112).** Mis-quoted Bash commands word-split into 0-byte files named after the fragment (`0)`, `30s`, `{,+`). Before any `git add`, scan `git status --short` for bare-fragment filenames and `rm --` them. Prefer explicit paths over `git add -A`/`-u`.

**Staged-index inheritance on the shared checkout (t/3670).** The fleet shares one index, so **another agent's `git add` stages files into *your* commit.** A bare `git commit` commits the **whole index**, not the path you added — `git add <file> && git commit` is not scoped, and the explicit pathspec on the `add` reads like a safeguard while providing none.

- **Commit with a pathspec: `git commit -m "…" -- <paths>`.** This is the fix; it commits only those paths whatever else is staged.
  - **Exception — executable-bit changes (Sage Pattern #197).** Under `core.fileMode=false` (the Windows default), a pathspec commit rebuilds the named paths from the working tree and **silently drops a mode staged with `git update-index --chmod=+x`**. The file lands `100644`, so a hook is inert on every Linux/macOS clone, and nothing errors. For a commit that sets `+x`, use an index nobody else shares: a worktree (`git add` → `git update-index --chmod=+x` → plain `git commit`) or a private `GIT_INDEX_FILE`. Then verify the mode with `git ls-tree HEAD <path>` → `100755`, and again on `origin/main` after the push.
- **Scan `git status --short` UNSCOPED before committing.** A path-scoped status (`git status --short -- <your file>`) cannot show inherited staged files — it reports clean while the index is dirty outside your filter.

Origin (t/3666/t/3637): a bare commit swept three of another agent's staged files into an unrelated docs PR under one author's message. It was **silent** — the commit succeeded, `git log -1` showed the expected message, and it surfaced only because the other agent read `git show --stat` on a PR that wasn't theirs. **Verify with `git show --stat HEAD` after committing on a shared checkout**; the file list is the only thing that distinguishes the two outcomes.

On some Windows agents, MSYS path conversion mangles the `<path>` half of a git colon-revspec (`git show <ref>:<path>`, `cat-file`, `rev-parse`), so a **valid** ref reports a spurious `unknown revision or path`. Discriminator: valid ref + `unknown revision` = suspect MSYS, not a real absence (confirmed on ≥2 agents). Fix: prefix `MSYS_NO_PATHCONV=1` or run via PowerShell.

## 7. Incident response: prevention, baselines and surviving vectors

- **Claim follow-ups before filing.** During a live incident, claim a follow-up on the anchor thread before `create_ticket` — prevents duplicate filings (t/2053+t/2054, t/2061+t/2062).
- **Claim binds per-instance and to writes, not just filings (t/2945).** Claim per instance/background-job on the anchor **before any shared-tree write** *and* before any filing. The anchor is a visibility point, not a lock; where serialization is required, re-read the anchor after claiming before acting.
- The Technical Lead coordinates incidents (`/tl-incident-response`); the anchor ticket is the source of truth.

### Prevention-per-incident (t/2379)

Every diagnosis files **two** follow-ups: **Observability** (make it diagnosable next time) **and Prevention** (the gate/test/guard that stops recurrence). Map each incident to a failure class (`docs/CodeReview/failure-classes.md`) and file the prevention that closes that class's gap for this surface. Gate-touching prevention tickets route to **Main (TL)** for Gate Verification (both arms proven; no flaky blocking gates; config co-located).

### Second recurrence → baseline validation (t/3085)

When an incident maps to a failure class that has **already recurred**, the diagnosis MUST include a **baseline-validation pass**: state what load/latency/behavior you treat as "normal," then verify it against **design intent** (docs, precomputation assets, original PR/ticket) — not just recent observations. A recurring class whose fixes keep landing at the symptom layer signals the assumed baseline is itself the bug.

### Closing a prevention: name a surviving vector (t/3666)

**Before closing any ticket that claims to prevent a failure class, name one concrete way that class could still occur through ordinary use of the system, without anyone bypassing or removing the mechanism you just built. If you can name one, you closed a *vector*, not the class — say so in the closing note, and file the remainder where it's worth tracking.**

The bound is load-bearing. "Name any way it could still fail" is satisfiable by *a future author deletes the test* — true, useless, and it fires on every close, which trains a reflex sentence and destroys the signal. Restricting it to **ordinary use, mechanism intact** makes it discriminating: it fires on real remainders and stays silent on adversarial or self-inflicted ones.

Why this needs saying at all: *vector* and *class* are indistinguishable at the moment you finish the work. You have just proven the fix, every arm is green, and "this class is closed" is the honest-feeling description. It only becomes visibly wrong when someone finds the next vector. So this is a structural blind spot, not a discipline lapse — which is why the check has to be answerable in the moment rather than a reminder to be careful.

It catches **scope** gaps as well as logic gaps, and scope is the harder case: a mechanism that works correctly everywhere it looks feels closed precisely because nothing fails. The model-literal lint (t/3557) went blocking with both implementations agreeing and zero offenders — and scanned only `.ps1` and `.ts`, so a retired model id in a `.json` config passes untouched (t/3664, found by applying this rule to that ticket's own close-out).

**Enforcement is TL Gate Verification, not a hook.** Gate-touching prevention tickets already route to Main (TL) per the rule above; the surviving-vector question belongs in that review. A Done-transition prompt was considered and rejected — feedback rules cannot filter on ticket type or label, so it would fire on every close including typo fixes and dep bumps, which is the decay this bound exists to avoid.
