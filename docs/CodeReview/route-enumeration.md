# Route Enumeration

How to review a gate, guard, or monitor for **scope** rather than correctness. Origin: 2026-09-29, where a fourteen-hour red `main` produced a chain of defects and **every one was in the *remedy*, not the original problem** (t/3736, t/3737, t/3738; consult e/225). The chain is enumerated at the end rather than counted here.

Companion to the five Gate signal integrity rules in `engineering/tech-lead/AGENTS.md`. Those ask *does this gate work?* This asks *what does it not look at?*

## The rule

**Name every route that reaches the protected thing. Show which mechanism covers each. Leave the uncovered ones as visible blanks.**

Then, for any check with a health check or a probe: **name what its health check does not assert.**

The output is a table, produced once at Gate Verification. It is cheap, falsifiable by someone without domain priors, and a blank cell is an admission rather than an omission.

## Restricting a route lists and fixes every caller (t/610, t/609)

A change that restricts who may call a route (auth, admin-only, refusing anonymous callers) lists every caller in the PR body, found by searching for the path: deploy smoke phases, PowerShell cmdlets, tests, scheduled jobs and workflows. It fixes them in the same change, or names the follow-up ticket that does. Why: #5500 locked `/api/analytics/query`, which the deploy smoke and three cmdlets read anonymously (t/579, t/603).

## Why a rule and not more care

Three enforcement mechanisms failed in one week, and all three were **day-one** scope gaps rather than decay:

| | reads as | actually |
|---|---|---|
| t/3695 | `enabled: true` | never executes — predicate proven, runtime loading never was |
| t/3716 | draft blocks the merge | blocks a human; automation is indistinguishable in the timeline |
| t/3736 | required checks gate `main` | gates PR merges; a red check blocks no admin, and every agent is an admin |

Periodic re-testing would have passed cleanly every cycle from the beginning, because each mechanism worked *within its scope* and nobody tested the scope boundary. A schedule catches a mechanism that stops working. These never covered what they appeared to.

## The worked examples carry more weight than the rule

The rule tells you to make a table. The examples train the recognition that produces rows you would not otherwise have written. Read these rather than the rule.

### Example 1 — a correct playbook, bypassed

`/land-from-worktree` step 1 specifies the base ref explicitly:

```
git worktree add -b <branch> <path> origin/main
```

and step 6 carries a merge-base scope check with a STOP on foreign files, traced to t/3670. It even records its own residual: *"this is discipline, not enforcement — not invoking this playbook bypasses it entirely."*

A TL handed out an ad-hoc `git worktree add -b <branch> <path>` — dropping `origin/main` — on a shared tree three commits ahead of origin. The branch inherited three other agents' commits; the PR landed them; the rescue PRs for the same content were still open. QUIET duplicate-parallel-land. **The playbook was blamed twice before anyone read it.**

**The discriminator, which is this example's whole point:**

> **Before concluding a mechanism is deficient, establish that it ran.**

A deficient mechanism needs redesign. A **bypassed** one needs a different remedy entirely — mandatory invocation, or making the ad-hoc route impossible. Conflating them produces the wrong fix, and here the wrong fix would have been editing a correct playbook.

Note this is the **same sentence as the fail-closed rule below, one domain over**: *assert the mechanism could have acted before concluding it failed to.* Query, playbook, gate — same move. A mechanism that never ran and a mechanism that ran and failed are indistinguishable from the outcome alone.

**Row it produces:** *branch off a tree that is itself diverged.* Not derivable by thinking carefully about branch protection, because it is not a branch-protection problem. It came from an incident.

### Example 2 — a health check asserting less than its name

A `main`-CI monitor was specified with "a known-positive probe" in its health check. That answers *can I see anything at all?* It does not answer:

- *would I notice a red?* — a drifted predicate passes a known-positive probe **every cycle**: visible runs, no conclusions. Needs a **constructed, persistent** red fixture; today's outage cannot serve, because it evaporates when fixed.
- *am I pointed at the right thing?* — a monitor on the wrong branch satisfies both of the above and reports green while `main` burns. This is the original fourteen-hour incident restated: a mechanism that worked, watching something nobody read.
- *does the alert reach someone who acts?* — detecting correctly into an unread channel reproduces the incident with more machinery.

**Prompt worth carrying:** when a check needs a fixture, ask whether the **production target** can serve as one. Changing the probe's subject from an arbitrary known-positive SHA to `main` itself collapsed *query health* and *wiring* into one assertion, against the thing that matters — the only correction in the chain that **removed** machinery while covering more.

### Example 3 — the check that failed open, then false-fired, on real history

A CI check was designed to detect branches carrying foreign commits (t/3738):

```bash
git log --format=%s%n%b $(git merge-base origin/main HEAD)..HEAD | grep -oE 't/[0-9]+' | sort -u
```

Three defects, each found by **running** it, none by reading it:

1. **Fails open.** `actions/checkout` defaults to `fetch-depth: 1`, so `origin/main` may not resolve. The ref set comes back **empty**, empty is a subset of the PR's own ticket, and the check **passes** — a negative result that is an artifact of the question, presenting as a clean bill of health, inside the check built to catch exactly that. Its author had catalogued that pattern one hour earlier.
2. **`%s%n%b` false-fires on documentation.** Commit *bodies* cite related tickets, and this repo's `Ref:` convention encourages it. Run against the commit introducing this very document: six refs on a single-ticket commit. Subject-only yields one. The better-documented the commit, the likelier it tripped.
3. **Range-wide `sort -u` false-fires on a normal commit.** `cb35c91e` — *"feat(cl): t/3350 demotion-set manifest … (t/3633…)"* — is one legitimate commit naming its ticket and a related one. Collapsing the range into a single ref set loses which commit carried which ref, which is the only thing that makes "foreign" meaningful. Correct predicate: **per-commit, foreign iff its subject refs are non-empty AND disjoint from the PR's ticket.**

**What the check sees, and does not — and the residual is worse than its size.** A commit whose subject carries no ticket ref is invisible. Measured over 60 `main` commits: 14 are ref-less (23%), of which **all 4 merge commits** — `git pull` writes their subjects, so no ticket can appear by construction.

That matters more than 23% suggests, because **a merge commit is the characteristic artifact of reconciling a diverged tree**, which is exactly what this check exists to detect. **The blind spot is not independent of the target; it sits on the target's signature.** A uniformly-distributed gap degrades coverage proportionally; a correlated one degrades it more than the number implies.

So the honest statement is *blind to merge commits, which are the divergence artifact* — **not** the more comfortable *"catches the ticketed case."*

**Both are true. Choosing the comfortable one is overclaiming by selection**, and it is a distinct form from every other instance above — those were claims that were simply *false*. This one lies about nothing, which is why the usual detector misses it:

> The test is not *"is this true?"* but **"is there a truer statement I am not making?"**

It recurs at every level. The residual above was first written as *"catches the ticketed case"*; when that was corrected, the implementation brief restated it as *"blind to a ref-less non-merge foreign commit (**rare**)"* — accurate, and "rare" was unmeasured. It is **~15%** of recent `main` commits, about one in seven, across ordinary classes: `docs(lessons)`, dependency bumps, UI fixes. Twice in one hour, in successive artifacts, by two authors, each correcting the previous overclaim while introducing the next.

**Sizes beat adjectives.** "Rare," "narrow," "edge case" are all selections; a measured rate with its date is not.

**Generalizable:** when you size a residual, ask whether it is **correlated with the thing being detected**. An uncorrelated blind spot is a coverage percentage. A correlated one is a hole shaped like the problem.

**Note which of the three teaches most.** Defect 2 is a wrong tool — the extraction read the wrong thing. Defect 3 is a **correct-looking predicate whose fault lives in how results were combined**, and `cb35c91e` legitimately naming two tickets in one subject is a case no amount of reading finds. Aggregation defects are the harder class precisely because every part looks right in isolation.

**Fluency in a failure shape does not prevent producing it** — defect 1's author had catalogued that shape an hour earlier. That rules out "learn the pattern" as the remedy and is the argument for a mechanical check.

**All three were found by execution. None by inspection.**

## Fail closed on uncertainty — the requirement, not the config

**Assert the query could have answered before trusting that it did.** If a lookup errors, or its range is empty, or its scope was never established, exit *cannot evaluate* — loudly. Never pass.

Four instances of the same sentence:

| instance | the misleading negative |
|---|---|
| `gh run list --commit <sha>` | returns nothing for push-event runs — reads as "no CI ran" |
| `gh api commits/<ref>/status` | `{"state":"pending","total_count":0}` while the tree is red — Actions posts check-runs, not legacy statuses. A **confident wrong answer**, which no known-positive probe catches |
| `gh run list --workflow --branch --event` | **not portable** — current runs for one agent, stale runs for another, identical command |
| the t/3738 check above | shallow checkout → empty range → passes |

Generalizable form: **when a question has several plausible query forms, the disagreement between them is the finding.** Two agents getting different answers from the same command was more informative than either answer.

Config (`fetch-depth: 0`) fixes today. The **assertion** survives someone copying a checkout step from another job. Specify the assertion; treat the config as an optimisation.

## What this rule does NOT close

**A route table makes blanks visible and missing rows invisible.**

A blank cell says *uncovered*. An unlisted route says nothing at all — the absence-doesn't-announce-itself property from the query traps above, relocated one level up. No amount of care in filling the table addresses it, because the failure is in what never became a row.

**And the least-tested claim is locatable, so it is named here rather than left as a general caution.** Every row in the worked table below came from an incident. The rule has therefore never been applied **prospectively**. The untested proposition is:

> A useful table can be produced **before** the incident that would have supplied its rows.

That is what would settle whether this rule is a method or a retrospective. Until someone produces a table that names a route *and* that route later turns out to have mattered, this document records a habit that worked backwards.

So the enumeration converts *some* unknowns into visible blanks and leaves the unnamed-route case exactly where it was. An improvement, **not a closure of the class** — anyone citing this rule to close a prevention ticket still owes the surviving-vector sentence required by root `AGENTS.md`.

Stated plainly because the alternative would be this document committing the error it catalogues: every defect in the chain that produced it was in the remedy, which predicts the next one is in here.

## Worked table — routes to an unverified `main` (2026-09-29)

| route | covered by | status |
|---|---|---|
| merge a PR whose required checks are **failing** | `enforce_admins: true` (t/3736) | specified, not landed |
| merge a **stale** PR (`strict: false`) + skip-tolerance | — | **no mechanism** |
| **PR aperture smaller than push aperture** | — | **no mechanism.** Push runs the full matrix, PR runs prune, so a green PR *structurally* cannot guarantee green `main`. Open choice: widen the PR aperture (t/3686) or mandate post-merge detection |
| rebase/squash lands a **SHA never tested** | — | **no mechanism**, inherent to the merge method |
| **branch off a diverged tree** | t/3738 | specified, **partial** — ticketed case only |
| `main` goes red and **nobody is told** | t/3737 | specified, not landed |

Two things this table makes visible that prose did not:

- **Three rows have no candidate mechanism at all.** Those are the structural blanks; the rest are build status.
- The last row is **detection** in a prevention table, and it is the row that did the damage. A table scoped to prevention would have scored this surface as mostly solved with the expensive gap outside the frame.

And one thing the table cannot show: **detection everywhere, attribution nowhere.** Every row above detects; none attributes. Every agent acts with the repo owner's credentials, so post-incident questions here are answerable as *what happened*, never *who did it* (t/3736#4).

## Appendix — the chain, enumerated

Each entry is a correction to the *remedy*, not to the original incident. Listed so the count is derivable rather than asserted.

**`main`-CI monitor (t/3737):**
1. "Known-positive probe" covered query health only; detection health needed its own constructed fixture (#3)
2. Wiring unasserted — a monitor on the wrong branch passes both probes (#4)
3. Notification path unasserted — fires but reaches nobody (#4)
4. Subject set undefined — *what counts as "`main` is red"* (#5)
5. Two-state definition alerted on **every merge**; observed live, twice, ten minutes apart (#8)

**Ticketed-ancestry check (t/3738):**
6. Fails open on a shallow checkout (#2)
7. Expected-ref source unspecified; a no-ticket PR breaks it (#2)
8. `%s%n%b` false-fires on any well-cited commit (#3)
9. Range-wide `sort -u` false-fires on a legitimate multi-ref subject (#4)

Plus one **misdiagnosis** rather than a defect: a correct playbook blamed twice before being read (Example 1).

### What the chain shows, and what it does not

**It is not an argument for execution over reasoning.** Roughly half of these were found by tracing a case mentally (1, 4, 5, 6, and the `{3,}` cliff) and half by running or measuring (8, 9, the merge correlation, and "rare"). A route table is itself a thinking artifact; if the lesson were *instrumentation beats thought*, this document would argue against itself.

**What none of them was reachable by is thinking about it *once*.** Each became visible only after the previous fix changed what there was to think about — the subject set was not a question until wiring was settled; the aggregation bug was not visible until extraction was correct. **The lesson is iteration, not instrumentation.** That is also the rule's central bet: enumeration front-loads iterations you would otherwise pay for one incident at a time.

**And the rate held while severity collapsed.** The early defects would have shipped outages — a monitor paging on every merge, a check passing on a shallow checkout, a health check certifying a blind monitor. The late ones are a regex quantifier and one word in a residual sentence. Both halves were worth doing, for different reasons, and **a reader deciding how long to run such an exchange should know the knee exists**: the iterations keep finding things, and what they find gets cheaper.

Ref: t/3736, t/3737, t/3738, t/3695, t/3716, t/3670, t/3686, e/225 (the consult)
