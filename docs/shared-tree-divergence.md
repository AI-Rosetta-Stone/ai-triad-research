# Shared-Tree Divergence — Cleanup Procedure

**Scope:** the shared checkout's local `main` is **out of sync** with `origin/main` — either **diverged** (N ahead, M behind; cannot fast-forward) or **behind-only** (0 ahead, M behind; fast-forwardable). Referenced from root `AGENTS.md` → Workflow Mode. The two cases take **different operations** (`reset --hard` vs `merge --ff-only`); **classify which you are in before doing anything else** (Step 0) — choosing the wrong arm is the failure the behind-only addition (t/3806) exists to prevent.

## The distinction this procedure exists to make

Root `AGENTS.md` says tree-rewriting operations (`checkout`, `reset`, `rebase`, `merge`, `pull --rebase`, `stash`) are worktree-only in the shared checkout. Read literally, that leaves a diverged shared tree with no legal way back — and a tree that can never sync becomes permanently stale, which is its own hazard: two of the six collisions on 2026-09-28 were caused by stale or foreign content in the shared tree, not by rewrites.

So the rule is not "never sync." It is:

> **An incidental rewrite — done mid-task, unannounced, to unblock your own push — is prohibited. A maintenance sync — announced, serialized, preconditions verified, by the designated owner — is required.**

Same git commands, different acts, opposite risk profiles. The incidental one injures whoever is reading the tree. The scheduled one is the thing that stops the tree rotting.

**Do not use this procedure to resolve your own rejected push.** That is the incidental case. See *Prevention* below.

## Owner

**DevOps** performs the sync. They run the hourly drift check and own shared-tree health. Anyone else who finds a diverged tree reports it and stops — a second actor mid-sync is how you get two agents rewriting one tree.

**Fallback (DevOps unavailable):** if DevOps is asleep or unreachable and the tree is diverged, the **Technical Lead** may sync under the *identical* preconditions below, and MUST include an explicit "DevOps unavailable — TL syncing" line in the announcement. This exists because the procedure must not deadlock on one agent's availability — a permanently-stale tree is itself the hazard (it caused two of the six 2026-09-28 collisions). Still single-owner-at-a-time: never two syncers.

## Cadence — sync promptly, not rarely

Blast radius is a function of **M** (how many commits the tree moves at once), not of how often you sync. Rarity *maximises* M: defer a sync an afternoon and the reset rewrites dozens of commits under everyone; sync on detection and M is 1–2, close to harmless. So **sync promptly whenever divergence appears — the hourly drift check is the natural trigger — precisely so no individual sync is large.** Frequency is the safety property once the preconditions are mechanical, and it keeps the operation routine rather than an event: a procedure run hourly gets followed; one run monthly gets improvised.

> **The first sync after this procedure is adopted is the largest one you will ever run** — it clears whatever accumulated before the cadence existed. It is the least-representative sample there is: a rough first sync does not discredit the cadence, and a smooth one does not validate it.

## Step 0 — Classify the sync state (run this first, before choosing an arm)

The two cases need different operations, and picking the wrong one is the failure this doc's behind-only arm (t/3806) exists to prevent. One command decides:

```sh
git fetch origin
git rev-list --left-right --count HEAD...origin/main   #  <left: local-ahead>  <right: behind>
```

- **Left > 0 — diverged.** Local commits exist that must be classified and possibly rescued before the tree can be reset. Use **Steps 1–5** below.
- **Left == 0 — behind-only.** No local commits; the tree only needs to fast-forward. Use the **[Behind-only arm](#behind-only-arm--fast-forward-0-ahead-n-behind)** (after Step 5). Do **not** use `reset --hard` here: Steps 1–3 exist to classify and rescue local commits, and there are none, so their entire precondition set is vacuous — `reset --hard` would be strictly more destructive than the fast-forward that does the job.

## Step 1 — Classify the local commits

Diverged trees differ only in whether the local commits carry content that exists nowhere else.

```sh
git fetch origin
git log --oneline origin/main..main          # local-only commits
git rev-list --left-right --count origin/main...main
```

For **each** local commit, ask whether its *content* is already on `origin/main`. Ancestry is the wrong test — a squash-merge or cherry-pick lands the content under a different SHA, so `--is-ancestor` reports "not merged" for work that landed hours ago. Compare content:

```sh
git show <local-sha> --stat                  # what did it touch?
git diff <local-sha> origin/main -- <paths>  # empty ⇒ content already on origin
```

- **REDUNDANT** — every local commit's content is on `origin/main`. Go to Step 3.
- **UNIQUE** — some content exists only locally. Go to Step 2 first. **Do not reset; you would destroy it.**

### Classifying UNIQUE-vs-stale when a file overlaps an incoming commit (t/3785)

The content test above is right, but it has a trap when the **same file** is touched by both a local change and an incoming commit. Learned live on t/3785 — where the method misfired in both directions in one incident:

1. **A file-level line-diff is UNRELIABLE when an incoming commit touches that file — in BOTH directions.** A net-deletion incoming fix makes deliberately-removed pre-fix code look line-*unique* (so you think you have novel work you don't); a restructuring incoming batch can hide genuine unique work behind an apparent-supersede (so you discard work you needed). File-overlap **narrows** the suspect set; it does **not settle** it.
2. **Settle each suspect by a CONTENT MARKER, per-suspect** — pick a symbol/heading from the "unique" lines and count it: N× at local-HEAD vs M× on `origin/main`. If the incoming commit *removed* it (N>0, M=0), the local copy is stale pre-fix code → discard. If it exists only locally (M=0 and no incoming commit removed it), it is genuine → Step 2. **Never discard on file-overlap alone. Order: narrow by overlap → settle by content marker.**
3. **`git cherry` / patch-id is the WRONG test for "already landed."** A squash-merge or a review edit lands identical semantic content under a *different* patch-id, so a **patch-id mismatch is INCONCLUSIVE, not negative** — it cannot distinguish *lost* from *landed-differently*. Use the `git diff <sha> origin/main -- <paths>` content test, then content-marker-settle any residual. (Same narrow-then-settle order, applied to the tool rather than the file.)
4. **Line count measures ELAPSED TIME, not risk.** A large `behind-N` / big `-` diff means `origin` advanced a lot since the branch was cut; the reset *gains* that, it does not *lose* yours. Don't read diff size as danger — read it as "origin moved."
5. **Preserve-first (Step 2) makes being wrong cheap.** When in any doubt, push the exact HEAD to a rescue branch *before* the reset (seconds, lossless) and classify afterward against the pushed branch. The reset is then unambiguously safe regardless of how the classification lands.

## Step 2 — Rescue unique content into a branch

Never resolve unique local commits in place. Move them to a branch off current `origin/main`:

```sh
git worktree add .worktrees/<name> -b <rescue-branch> origin/main
cd .worktrees/<name> && git cherry-pick <local-sha> [<local-sha>...]
git push -u origin <rescue-branch>
```

Open a PR, verify, merge with `node operations/devops/enqueue-pr.mjs <owner>/<repo> <N>` (t/4740, pins the head and verifies real queue entry). Preservative by construction: the author's content lands unchanged under a new SHA.

Then confirm at the object level that it landed, and only then treat the local commits as REDUNDANT:

```sh
git fetch origin && git diff <local-sha> origin/main -- <paths>   # must be empty
```

**Notify the commit's author.** You are landing someone else's work; they should know it is safe and where it went.

## Step 3 — Verify the preconditions

Every check here must be **adjacent to the reset** — re-run immediately before Step 4, not minutes earlier. A clean result at classification time is not a clean result now; the window between them is long enough for a colleague to begin work the reset would destroy. (This is the *verify at the point of use* discipline: a stale check is itself the failure mode this procedure exists to prevent.)

**1. No uncommitted TRACKED work by anyone.** `reset --hard` destroys uncommitted modifications to *tracked* files; it does **not** touch untracked files — so the two are not equal and must not be treated equally.
   ```sh
   git status --short --untracked-files=no   # TRACKED mods — these BLOCK absolutely
   git status --short                         # full picture, including untracked
   ```
   - **Data checkout: a PROTECTED path (`check-data-checkout-drift.ps1`'s `ProtectedPaths` map, e.g. `taxonomy/Origin/pov-tag-proposals.json` → Computational Linguist) is never a phantom, no matter what the diff says (t/4056, SO e/270#2).** This is checked **before** the mechanical diff test below, not as a tie-breaker after it — an uncommitted pov-tag review decision is reviewer WIP whether or not it happens to diff empty against `origin/main` right now (an empty diff only means the review hasn't yet changed anything *relative to that ref*, not that the decision is safely captured elsewhere). **Stop and route to the owner; do not restore, reset, or otherwise discard it**, exactly as for real WIP that needs eyeballing below.
   - **Any tracked modification → STOP.** Classify real WIP vs phantom **mechanically, never by inspection** — a judgment call about a colleague's file, made by the one person whose next command destroys it, is exactly incident #6. A path is a phantom **only** if it is not a protected path (above) **and** `git diff --ignore-cr-at-eol --ignore-all-space -- <path>` is empty, or it matches a declared generated-file glob. Restore phantoms; anything that needs the diff eyeballed to decide is real WIP by definition → `resolve_owner` the path, ping the owner, wait. (If `resolve_owner` returns `match_type: implicit` — the path has no explicit owner and resolves to the root **Project Instructions** role — then *that* role is the responsible party to ping, not nobody. An implicitly-owned path is not owner-less; treating it as such is how a blocking WIP sat with no actor on 2026-10-01. The durable fix is explicit ownership for these infra paths — tracked separately in the e/227 explicit-scope work.)
   - **Untracked files do NOT block.** `reset --hard` will not delete them, and this tree permanently carries `.cache/`, `.fol-eval-corr*/`, `scripts/batch-configs-t3411/`, etc. — blocking on untracked makes this precondition unsatisfiable, and an unsatisfiable precondition gets waived on first use. **Exception:** an untracked path that *collides* with a path the incoming commits add can be clobbered — check explicitly and STOP on any overlap:
     ```sh
     comm -12 <(git diff --name-only main origin/main | sort) <(git ls-files --others --exclude-standard | sort)
     ```

**2. No agent actively READING the tree — gated by a per-owner explicit ACK, never by a state read.** `git status` detects writers, not readers — an agent with a perfectly clean tree can be mid-build or mid-test, about to act on file contents it read seconds ago, and the reset moves the ground under it (incident #4's shape, delivered by the sync itself).

   **A fleet state read (`get_status_overview` / `list_instances`) is advisory only — it tells you *whom to ask*, never that it is safe.** Two independent reasons, both observed on 2026-10-01:
   - **The read can be wrong when taken, not merely stale after.** A `get_status_overview` reported an instance `asleep` that a second, near-simultaneous live read showed `working (57s)` on the shared tree. "Check closer to the reset" cannot fix a read that was already false at the moment it was taken.
   - **Pings wake sleeping agents.** A routing burst — tickets dispatched, agents woken — can move an instance into `working` *inside* your wait window, by the very mechanism that makes the fleet active. A correct read goes stale seconds later.
   - **The read can be cold (2026-10-03, Orca Support p/156#34).** The awake-set is held in memory and **zeroed on every Orca MCP reconnect**; until each agent's next call, *every* agent reads `asleep`. A cold read looks exactly like a quiet fleet, and an all-asleep read is the one most likely to be taken as consent.

   **Self-check — the syncer must read itself awake, or it stops.** You are mid-task, so a warm read shows **you** as `working`/`idle`. If your own instance reads `asleep`, the read is cold: its asleep list is not evidence that anyone is asleep, so it cannot even tell you whom to ask. **Stop.** Make any Orca call, re-read, and proceed to collect acks only once you see yourself awake. This does not make a warm read a gate (the two reasons above still hold); it rejects a read that cannot even serve as the list of whom to ask.

   So the precondition is an **explicit all-clear from every owner who could be on the shared tree** ("I'm in a worktree" / "no shared-tree edits from me — proceed"); use the state read only to decide whom to ping. **The ack is required even when the agent has nothing uncommitted** — on 2026-10-01 the live agent had zero shared-tree edits and the hold was still correct, because *that fact was unknowable until the owner said it*. Gate on unknowability, not on an imminent loss: do **not** record such a hold as a near-miss "save" (there was nothing to lose) — record it as the precondition doing its one job, which is refusing to act on a belief the tree has not confirmed.

**3. REDUNDANT confirmed** (Step 1), or Step 2 completed and object-level verified.

**4. Announced, then get the ACKS — waiting is a weak fallback, not the gate.** Announce in the channel the fleet reads, naming the owner ("DevOps syncing" / "DevOps unavailable — TL syncing"). Then **collect an explicit all-clear from every instance a state read shows non-asleep (`working`/`idle`) on the shared tree** — per precondition 2, that ack is the real gate. A bare "wait **≥60s**" is a fallback for a demonstrably quiet fleet only: it cannot close the ping-wake race (an agent can enter `working` during the wait), so never treat elapsed time as consent when any instance is — or could be woken — active. On 2026-10-01 the 60s wait had elapsed and a state read still read the one live agent as `asleep`; only the owner's direct ack ("I'm in a worktree — proceed") actually cleared the precondition.

## Step 4 — Record the rollback, then sync (in one command)

```sh
git log --oneline -8 main > "$SCRATCH/pre-sync-main.txt"   # SHAs for rollback; session scratchpad, NOT /tmp (unstable under Git Bash on this fleet)
```

Then couple precondition-1's tracked check to the reset **in a single command**, so the TOCTOU gap is milliseconds, not the minutes that two tool calls allow (shell state does not persist between calls, and they can be arbitrarily far apart):

```sh
git status --short --untracked-files=no && git fetch origin && git reset --hard origin/main
```

If the status check surfaces any tracked modification, the `&&` chain stops before the reset. **Precondition 2 cannot be made adjacent, and that is the point:** an ack requires another agent's reply, so it can never be folded into the reset command the way the tracked-mods check is. Adjacency *mitigates* precondition 1; it is *impossible* for precondition 2 — which is exactly why 2 is an **ack, not a check**. So collect the acks as the **last** action before the reset and issue the reset immediately after; do **not** substitute an adjacent-but-wrong state re-read for the non-adjacent-but-right ack — that substitution is the failure precondition 2 was rewritten to forbid. If a ping-wake or new activity intervenes between the acks and the reset, re-collect; do not proceed on elapsed time.

`reset --hard` is correct here and there is no gentler option — `merge --ff-only` fails by definition on a diverged branch. **The reset moves files on disk under anyone currently reading them** — which is exactly why precondition 1 must clear the tracked index *adjacent to this command*, and precondition 2 must clear the fleet by ack *immediately before* it — not minutes before. (An agent mid-task does not expect the tree at `origin/main`; it expects the tree where it last read it. The reassuring-sounding opposite is the belief that makes an operator stop thinking about readers.)

**Rollback if Step 1 misjudged and unique content was lost:** do NOT `git reset --hard <old-sha>` from the reflog — that re-diverges the tree, the exact state you just cleaned. Recovery is Step 2 after the fact: take the lost SHA from `pre-sync-main.txt`, cherry-pick it onto a fresh worktree branch off `origin/main`, PR, merge.

## Step 5 — Verify, and say what you verified

```sh
git rev-parse HEAD origin/main               # must match
git status --short --untracked-files=no      # must be empty
git rev-list --left-right --count origin/main...main   # must be 0  0
```

Report the SHA. "Synced" without a SHA is indistinguishable from a sync that silently failed.

## Behind-only arm — fast-forward (0 ahead, N behind)

Reached from **Step 0** when `rev-list --left-right` shows **left == 0**: no local commits, the tree only needs to catch up to `origin/main`. This is the live 2026-10-01 case (`0  23`) and the one t/3801's grant is actually for.

**Same owner and announcement as the diverged arm — do not weaken either.** DevOps performs it; the TL fallback in *Owner* above applies identically, with the same explicit announcement line. And announce-then-wait exactly as Step 3.4: **a fast-forward rewrites the working tree under concurrent readers exactly as a `reset` does.** The verb sounds gentle, and the belief that `--ff-only` "rewrites nothing under readers" is false — it was asserted and disproved (t/3801#1). An agent mid-build does not expect the tree at `origin/main`; it expects the tree where it last read it. So the readers check (Step 3.2) and announce-then-wait (Step 3.4) are **not** optional here, and the announcement must not read as lighter than the divergence arm's.

**Preconditions: reuse Step 3 verbatim — all four, unchanged.** Do not restate them here (restating a procedure is the drift defect of t/3803). The only thing that differs is the operation Step 3 gates: a fast-forward instead of a reset.

**Ordering is load-bearing: restore phantoms → verify clean → fast-forward.** `git merge --ff-only` **aborts** if any phantom file is present in the working tree, *even though its content is byte-identical to the merge target* — git compares working-tree-against-**index**, not working-tree-against-destination, so a file that is clean relative to `origin/main` still blocks the merge. Worse, its error — `error: Your local changes to the following files would be overwritten by merge` — actively argues against the correct diagnosis for a reader who already knows the files are phantoms. Clear them first (abort output and proof: t/3801#7).

**The phantom test here runs against `origin/main`, not `HEAD`.** Step 3.1's mechanical rule catches CR/whitespace-only diffs, but behind-only adds a second way a file looks dirty-but-isn't: it can differ from the *stale local HEAD* and be byte-identical to the *merge target*. Test against the target:

```sh
git fetch origin
git diff origin/main -- <path>                             # empty ⇒ phantom relative to the merge target → restorable
git diff --ignore-cr-at-eol --ignore-all-space -- <path>   # Step 3.1's CR/WS test (vs index)
```

A path empty against `origin/main` is restored with `git restore -- <path>` (equivalently `git checkout -- <path>`). Anything that still needs the diff eyeballed is real WIP by definition → `resolve_owner`, ping the owner (or the root role if implicit), wait. **A PROTECTED path (Step 3.1 above) is never restored by this test either, even when the diff against `origin/main` comes back empty** — the same t/4056 carve-out applies here, because this is a second route to the same `git restore`/`git checkout --` action the carve-out exists to prevent.

**Remedy** (after Step 3's four preconditions pass and phantoms are restored) — one command, same TOCTOU-closing adjacency as Step 4:

```sh
git status --short --untracked-files=no && git fetch origin && git merge --ff-only origin/main
```

If any tracked modification remains, the `&&` chain stops before the merge. `--ff-only` cannot create a merge commit — it either fast-forwards or aborts — so unlike `reset --hard` it can never itself produce the diverged state. Record the pre-sync SHA first (Step 4's `pre-sync-main.txt`) if you want a rollback anchor, though a fast-forward of a 0-ahead tree loses no local commits by construction.

**Verify as Step 5** and report the SHA:

```sh
git rev-parse HEAD origin/main                         # must match
git rev-list --left-right --count HEAD...origin/main   # must be 0  0
```

## Prevention — the cheap path that avoids all of the above

Divergence is not inevitable. It is the product of a gap between committing and pushing, and at this fleet's merge rate that gap is usually enough.

- **Push immediately after committing on shared `main`.** Not at the end of the task — in the same breath as the commit.
- **If the push is rejected, do NOT resolve it in place.** That is the incidental rewrite. Cherry-pick to a worktree (Step 2) and land it from there. Costs seconds; a shared-tree rebase costs somebody else's uncommitted work.
- **For anything beyond a one-file edit, start in a worktree.** Then divergence cannot arise, because you never commit on the shared tree at all.
- **Dispatched work must name its workspace.** A ticket that assigns multi-file implementation without saying "worktree" defaults the assignee onto the shared checkout — observed 2026-10-01, when a freshly-dispatched ticket put an agent back on the shared tree within minutes of a clean sync, reopening the exposure the sync had just closed. Ticket authors: say "worktree" for any multi-file build. A sync's clean state is **ephemeral** at fleet speed — this procedure keeps the window small and safe, it does not keep the tree clean.

## Why each step is there

Every precondition maps to an observed failure on 2026-09-28 (anchor: t/3714, six collisions in one session):

| Step | Failure it prevents |
|---|---|
| 1 — content, not ancestry | A `reset` that discards work which squash-merge made *look* unmerged |
| 2 — rescue before reset | Destroying unique local commits; the incident-#6 shape (a local commit invisible to origin) |
| 3.1 — tracked blocks, untracked doesn't, phantom-by-diff-only | A sync over a peer's uncommitted WIP; an unsatisfiable precondition waived on first use; the incident-#6 eyeball-judgment about a colleague's file |
| 3.2 — readers cleared by per-owner ACK, not a state read | A tree swapped under an agent mid-build/test whose index is clean (incident #4, via the sync); and a state read trusted as the gate when it was wrong-when-taken or woken-stale by a ping burst (2026-10-01), or cold after an MCP reconnect (syncer reads itself `asleep`, 2026-10-03) |
| 3.4 — announce **then wait** | Two actors rewriting one tree; an announcement nobody has read yet |
| 4 — adjacent single-command check + written rollback | A stale precondition (TOCTOU); an irreversible reset on a wrong Step-1 call with no recovery |
| 5 — verify with a SHA | "Done" reported for an operation that did not complete |
| Cadence — prompt, not rare | A large-M sync (wide blast radius); a procedure run so seldom it gets improvised |

The through-line: **every step is a check that the thing you believe about the tree is actually true of the tree.** The session that produced these six incidents produced them mostly through careful work on an untrue belief about what was on disk.
