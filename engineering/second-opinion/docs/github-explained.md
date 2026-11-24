# GitHub, Explained From Zero

A plain-language guide to git, GitHub, and how this project uses them. No prior knowledge assumed. Read it top to bottom once; after that, use the glossary and the strategy section as references.

---

## Part 1: Git, the thing underneath

GitHub gets the fame, but the engine underneath is **git**, a program that runs on your own machine. Understand git first and GitHub becomes easy.

### The core idea: save points

Git is a save-point system for a folder of files. A **repository** ("repo") is just a folder that git watches. At any moment you can say "save everything as it is right now," and git records a complete snapshot. That snapshot is a **commit**.

The key mental shift is that a commit is not a diff, not a delta, not "the changes." It is a *photograph of the entire folder* at one moment, plus a note saying who took it, when, and why (the **commit message**). Git stores these snapshots efficiently under the hood, but the model to hold in your head is simple: **a commit is a full snapshot of everything**.

Each commit also remembers which commit came before it. So the history of a project is a chain:

```
A ← B ← C ← D        (D is the newest; each points back at its parent)
```

Every commit gets a unique fingerprint, a long string of letters and numbers like `8a4a1f16...`, called a **SHA** (or "hash," or "OID"). When anyone anywhere says "commit 8a4a1f16," they mean one specific snapshot, unambiguously, forever. This matters later, because our merge-safety rules are built on comparing SHAs.

### Branches: named bookmarks, not copies

A **branch** is nothing more than a movable bookmark pointing at one commit. The default branch is usually called **main**.

When you "create a branch," git does not copy any files. It just plants a second bookmark on the same commit. Then, as you make new commits on that branch, the bookmark moves forward with you while `main` stays where it was:

```
            main
             ↓
A ← B ← C ← D
             ↖
               E ← F
                   ↑
              my-feature
```

Now the project has two live versions: the stable one (`main`) and yours (`my-feature`). Nobody working on `main` sees your work. This is the whole point. **A branch is a parallel universe where you can work without disturbing anyone**, and it costs nothing to create.

**HEAD** is git's name for "the commit your working folder currently reflects." Normally HEAD points at a branch. A **detached HEAD** means you've checked out a raw commit with no branch bookmark attached, so new commits made there dangle off nothing and are easy to lose. (Our tooling has a guard that refuses such commits; more in Part 4.)

### Merging: bringing universes back together

When your branch is ready, you **merge** it. Git takes the work from `my-feature` and folds it into `main`. If you and someone else changed *different* files (or different parts of the same file), git combines them automatically. If you both changed the *same lines*, git stops and asks a human to pick. That pause is a **merge conflict**. Conflicts are normal, not disasters; they're git refusing to guess.

A variant you'll see constantly here: a **squash merge** flattens all the little commits on your branch (E, F, "fix typo", "oops") into **one single tidy commit** on `main`. Main's history stays readable, one commit per finished piece of work. The trade-off: after squashing, the original branch's commits are not literally on `main` (their *content* is, as one new commit), so the old branch is dead. Never keep building on it. This trap has bitten this project before (Part 4).

### The working tree, staging, and committing

Three layers, in order:

1. **Working tree**: the actual files on disk you edit.
2. **Staging area (index)**: a loading dock. `git add <file>` puts a file's current state on the dock. This lets you commit *some* of your edits and not others.
3. **Commit**: `git commit` photographs whatever is on the dock and appends it to history.

`git status` shows what's edited, what's staged, and what's untracked. A rule of thumb used heavily in this project: **always look at `git status` before adding, and prefer `git add <specific files>` over `git add -A`** (which sweeps up *everything*, including accidental junk).

### Worktrees: several folders, one repo

Normally one repo means one working folder, and switching branches swaps the files in place. A **worktree** lets one repo have *several* working folders at once, each on its own branch. This project leans on worktrees hard. Many agents share one machine, so the main checkout stays parked on `main` while each piece of feature work happens in its own disposable worktree folder (`.worktrees/<name>`). Details in Part 4.

---

## Part 2: GitHub, the thing on top

Git works entirely on your machine. **GitHub is a website that hosts a copy of your repo** so that many people (or agents) can share it. Think of it as four things:

- **The meeting point.** The GitHub copy of the repo is called the **remote** (nicknamed **origin**). Everyone's local repos sync with it.
- **A review desk.** Before work joins `main`, it goes through a **pull request**, a structured "please review and accept this" process.
- **A robot test-runner.** GitHub can automatically run your tests on every proposed change (**CI**, via GitHub Actions).
- **A bouncer.** **Branch protection** rules let you say "nothing gets onto `main` unless the tests passed."

### Push and pull: syncing

- **push**: upload your local commits to GitHub.
- **fetch**: download what's new from GitHub, without touching your files.
- **pull**: fetch *and* fold the new stuff into your current branch.
- **clone**: your first download of a whole repo.

Nothing syncs automatically. Until you push, your commits exist only on your machine, one disk failure from gone and invisible to every other agent. An unpushed commit on a shared machine is what our incident write-ups call **stranded** work.

### The pull request (PR): where collaboration actually happens

The name is confusing; think of it as a **merge proposal**. The flow:

1. You push your branch (e.g. `my-feature`) to GitHub.
2. You open a **PR**: "please merge `my-feature` into `main`." The branch being merged is the **head**; the branch receiving it is the **base**.
3. GitHub shows every changed line (the **diff**), runs the automated tests (**checks**), and hosts discussion. Reviewers can comment or formally approve.
4. Someone clicks merge (here, usually **squash merge**). The work lands on `main`; the branch is deleted.

A **draft PR** is a PR marked "not ready, do not merge." This is not decoration. In our practice it is the *only* mechanism that actually prevents a premature merge; a comment saying "hold" does not physically stop anything (Part 4).

### CI: the robot gatekeeper

**CI (continuous integration)** means that every time you push, robots build the project and run the tests, then stamp the commit green (pass) or red (fail). On GitHub this runs via **GitHub Actions**: workflow files in the repo (like `ci.yml`) describe what to run.

The subtle, incident-causing detail: **a green check belongs to one specific commit (SHA), not to the PR.** If the PR's head moved after the tests ran, the green stamp is vouching for an *older* snapshot than the one you're about to merge. Our merge rules exist to catch this (Part 4).

### Issues vs. our tickets

GitHub has its own task tracker ("Issues"). **We don't use it.** Work is tracked in Orca tickets (`t/…`); GitHub is for code hosting, PRs, and CI only. The `gh` command-line tool is how agents talk to GitHub (open PRs, check runs, merge) without the website.

---

## Part 3: Glossary

| Term | Plain meaning |
|---|---|
| **repository (repo)** | A folder git watches, plus its entire history |
| **commit** | One full snapshot of the folder, with author/date/message |
| **SHA / hash / OID** | The unique fingerprint naming one commit |
| **branch** | A movable bookmark pointing at a commit; a cheap parallel line of work |
| **main** | The default branch; the "official" version |
| **HEAD** | The commit your working folder currently reflects |
| **detached HEAD** | HEAD pointing at a raw commit, no branch; commits made here are easy to lose |
| **working tree** | The actual editable files on disk |
| **staging area / index** | The loading dock of edits selected for the next commit (`git add`) |
| **untracked file** | A file git sees but has never been told to watch |
| **worktree** | An extra working folder for the same repo, on its own branch |
| **remote / origin** | The shared copy of the repo hosted on GitHub |
| **clone / fetch / pull / push** | First download / check for news / download+combine / upload |
| **merge** | Fold one branch's work into another |
| **merge conflict** | Both sides changed the same lines; a human must choose |
| **squash merge** | Flatten a branch's commits into one commit on the target; the source branch is dead afterward |
| **pull request (PR)** | A merge proposal: diff + discussion + test results + merge button |
| **head / base (of a PR)** | The branch being merged / the branch receiving it |
| **draft PR** | A PR flagged not-ready; GitHub will not let it merge until un-drafted |
| **CI / checks / GitHub Actions** | Robots that test each pushed commit and stamp it green or red |
| **branch protection** | Rules forbidding merges to `main` unless required checks are green |
| **auto-merge** | GitHub merges by itself the instant checks go green; banned here on any gated PR |
| **`gh`** | The command-line tool for GitHub (PRs, checks, merging) |
| **stranded commit** | A commit that exists only locally (or on a dead branch): real work, invisible to everyone |
| **fast-forward (ff)** | Your bookmark simply slides forward to catch up; no new merge commit, nothing to reconcile |
| **rebase** | Replay your commits on top of a newer base, rewriting them as new commits (new SHAs) |
| **amend** | Replace your most recent commit with a corrected version (new SHA) |
| **force-push** | Overwrite the remote branch with your rewritten history; use `--force-with-lease` only, never bare `--force` |
| **revert** | A *new* commit that undoes an earlier one; history grows, nothing is rewritten |
| **reset** | Move a branch bookmark backward, discarding commits from its history; dangerous on anything shared |
| **stash** | A temporary shelf for uncommitted edits (`git stash` / `git stash pop`) so you can get a clean tree |

---

## Part 4: Our strategy, or how this project actually uses git and GitHub

Everything above is generic. This section is the local law, and almost every rule below is scar tissue from a real incident. The recurring theme: **many agents share one machine and one repo, so the failure modes are collisions and stranded work, and the defenses are isolation (worktrees), verification (SHA checks), and hard gates (draft PRs, hooks).**

### 4.1 Two repos, and the overlay

- **Code vs. data.** Code lives in `ai-triad-research`; the large JSON data lives in a sibling repo `ai-triad-data`. The file `.aitriad.json` tells the code where the data is.
- **The overlay repo.** Orca's own configuration (`.orca.yaml`, `.orca/`, and every nested `AGENTS.md`) is tracked by a *second, private* git repo occupying the same folder, called the **overlay**, so the public code repo stays free of team-internal instructions. Plain `git` commands talk to the code repo; the alias **`ogit`** talks to the overlay. The two must never both track the same file. When unsure who owns an `AGENTS.md`, don't guess. Ask: `sh .githooks/agent-file-owner.sh --path <file>`. A pre-commit audit refuses commits that double-track a file or leave one tracked by neither repo.

### 4.2 The shared checkout stays on `main`; features live in worktrees

The main checkout is shared by the whole fleet. If one agent switched it to a feature branch, every other agent's work would land in the wrong universe.

- **Never do feature work on the shared tree.** Create a worktree *with a new branch in the same command*: `git worktree add -b <branch> .worktrees/<name>`. Branch-first creation also avoids the detached-HEAD trap. A hook warns if the shared tree's HEAD ever leaves `main`.
- **Your shell resets between tool calls.** A `cd` into the worktree does not persist. Every command that matters must be `cd .worktrees/<name> && <command>` in one line, or it silently runs against the shared `main` tree.
- **Committed hooks must be enabled once per checkout:** `git config core.hooksPath .githooks`. These hooks refuse commits directly on the shared `main` (which would strand work and diverge from origin) and refuse detached-HEAD commits in worktrees.
- The `/land-from-worktree` playbook packages this whole flow. Use it rather than improvising.

### 4.3 Junk-file hygiene

A mis-quoted shell command can word-split into dozens of 0-byte files named after code fragments (`0)`, `30s`, a file literally named `'`). No gate catches them because they're never committed, but a careless `git add -A` sweeps them in. **Scan `git status --short` before any add; prefer explicit paths; never paste multi-line code into the shell. Write scripts to a file and execute the file.**

### 4.4 The PR flow: how work lands

1. Work in a worktree on a named branch; commit there.
2. Push the branch; open a PR against **`main`** with `gh`.
3. Wait for CI to go green **on your latest commit**.
4. Verify (next section), then squash-merge, usually self-service.
5. The branch is dead after squash-merge. Never build on it again.

Practice rules (approved q/40):

- **Batch sequential work.** One agent, one feature, nobody blocked in between: that's one branch and one PR, not a PR per step. Split when the diff passes ~400 lines or mixes unrelated concerns.
- **Merge promptly on green** (~15 minutes), or record *why* you're holding as a PR/ticket comment. A green PR sitting silent invites landing races and stale-head merges.
- **Gated PRs stay draft.** If a PR must wait on anything (a sibling PR, a design review, an unfinished dependency) it is opened as **draft** and stays draft until the gate is verifiably clear. A "hold" comment is visibility, not enforcement, and **auto-merge on a gated PR is banned** because it merges with no agent in the loop the moment checks go green. (Incident: a comment-held flag flip auto-merged 22 minutes before its crash-fix dependency.)
- **Claim before implement.** Before starting a ticket, claim it (assign or comment). Two instances once implemented the same ticket in parallel and collided on the merge.

### 4.5 Pre-self-merge verification: the four checks

Before you enqueue a PR, confirm all four. Each exists because of a specific incident. Never land a PR with `gh pr merge`, in any form: it skips `enqueue-pr.mjs` and its gate-file check (see 5.3 and `docs/pr-landing.md`).

1. **Base is `main`.** GitHub silently suggests a parent feature branch as base if your branch was cut from one, and "merging" into a branch that later squash-dies strands your content off-main with no error anywhere.
2. **The PR's head SHA equals the commit you just pushed.** GitHub's PR head can lag your push by minutes; merging against a stale head ships the *old* code. (`gh pr view <N> --json headRefOid`.)
3. **CI ran green on that exact SHA**, not on a predecessor commit. A green check attached to an older commit vouches for nothing about the new one. (`gh run list --commit <sha>`.)
4. **No open hold**: no unresolved decision, review condition, or blocked dependency.

The unifying idea: **the PR page is a lobby display, not the ground truth. SHAs are the ground truth.** Verify the actual commit, the actual base, the actual test run.

### 4.6 Branch protection and gates

`main` is protected: PRs must pass the required checks (**ci-gate** and **CodeQL**) before merging. Beyond CI, this project builds deliberate **gates**: deploy-time assertions, config validators, verify scripts. The standard for any gate is fixed. **Prove both arms** (a deliberate failure makes it fire; the clean case passes with zero noise), make it reliable enough to block production (a flaky blocking gate is the next incident), and **co-locate the config and rationale at the point of use**, because a constraint explained only in ticket history has a shelf life of one refactor.

### 4.7 When you're stuck or the stakes are high

- Weird git errors on Windows agents (`unknown revision` on a ref you know exists) may be MSYS path-mangling, not a missing commit. Retry via PowerShell or prefix `MSYS_NO_PATHCONV=1`.
- High-stakes calls (irreversible changes, shared infrastructure like CI gates and branch protection, novel territory, security surfaces) go to a **Second Opinion consult** before they land. That review exists because git will happily record a bad decision as faithfully as a good one.

---

## Part 5: Common scenarios, step by step

The situations that come up over and over here, each with the mental model and the moves. Commands assume you've read Part 4; every feature-work command runs inside a worktree (`cd .worktrees/<name> && ...` in one line).

### 5.1 Starting a piece of work

```
git worktree add -b my-fix .worktrees/my-fix     # new branch + new folder, one command
cd .worktrees/my-fix && <edit, test>
cd .worktrees/my-fix && git add <files> && git commit -m "fix: ..."
```

What's happening: you planted a new bookmark (`my-fix`) on the current tip of `main` and got a private folder for it. The shared checkout never moved. Commit as often as you like; the mess gets squashed away at landing time.

### 5.2 Fast-forward: catching up when you have nothing new

You'll see the word "fast-forward" constantly, and it is the simplest thing in git. Suppose `main` on GitHub has moved ahead and your local `main` has no commits of its own:

```
your main:    A ← B
origin/main:  A ← B ← C ← D
```

Your bookmark is simply *behind* on the same road. A **fast-forward** slides it forward to D. No merging, no conflicts, nothing to reconcile, because there is nothing on your side to reconcile.

```
git pull --ff-only
```

The `--ff-only` flag is the safety catch this project uses on the shared checkout. It means "update me only if a pure slide-forward is possible; if I somehow have local commits, stop and tell me instead of inventing a merge." On the shared tree a refusal is itself a signal that something is wrong (a commit landed where it shouldn't have). This is the command that updates the shared checkout after every PR merge.

### 5.3 Landing finished work: the squash merge

The standard landing, start to finish:

```
cd .worktrees/my-fix && git push -u origin my-fix
cd .worktrees/my-fix && gh pr create --base main --title "fix: ..." --body "..."
# wait for CI green and the approvals the tier needs, run the four checks from 4.5
# then, from a checkout at origin/main (not the PR branch):
node operations/devops/enqueue-pr.mjs <owner>/<repo> <N>
# a PR that changes a gate file also names the review that approved the change, and who is enqueuing:
node operations/devops/enqueue-pr.mjs <owner>/<repo> <N> --gate-change-review=<review id> --by=<collaborator id>
```

`enqueue-pr.mjs` pins the PR to its current head, checks that it really entered the merge queue, and refuses a gate-file change without a named approving review. If it refuses, stop and escalate; never fall back to `gh pr merge` or the raw auto-merge mutation. The queue squash-merges the PR when its checks pass.

What squash does to history is turn your branch's five commits into **one new commit** on `main` with a fresh SHA. GitHub then deletes the remote branch. Afterward, clean up locally from the *shared tree* (the worktree must be removed before its branch can be deleted):

```
git worktree remove .worktrees/my-fix
git branch -D my-fix
git pull --ff-only          # bring the squashed commit into the shared checkout
```

Clean up only after the queue has merged the PR, and never push to the branch while it is queued. Removing the worktree first is what lets you delete its branch: git won't delete a branch that a worktree still has checked out.

### 5.4 Main moved while you were working

You branched from `main` on Monday; by Wednesday other PRs have landed and your branch is stale. Two questions decide what to do.

**Do you even need to update?** If your files don't overlap with what landed, no. The PR merge will combine them fine. Update when you *do* overlap, when CI needs the newer code, or when the PR page says "conflicts."

**If yes, merge main into your branch** (in the worktree):

```
cd .worktrees/my-fix && git fetch origin && git merge origin/main
```

If there's a conflict, git marks the clashing sections in each file with `<<<<<<<` / `=======` / `>>>>>>>` fences. Edit each file to keep what's right, delete the fences, then `git add` the resolved files and `git commit`. The extra "merge commit" this creates on your branch is fine; the squash at landing time erases it anyway. (Rebase is the tidier-history alternative, but since squash-merge flattens everything at the end, the tidiness is wasted effort here; merge is simpler and doesn't rewrite SHAs.)

### 5.5 Fixing a commit you already pushed

You pushed, then spotted a typo in the change (or the commit message). Amend rewrites the last commit, which changes its SHA, which means the remote now has *different* history than you do. Plain push will be refused; you must force-push:

```
cd .worktrees/my-fix && git commit --amend
cd .worktrees/my-fix && git push --force-with-lease
```

Always `--force-with-lease`, never bare `--force`. The lease version refuses to overwrite the remote if someone else pushed to the branch in the meantime; bare force would silently destroy their work. And remember the stale-head rule from 4.5: after any force-push, re-check that the PR's head SHA equals your new commit before merging. GitHub can lag, and merging the old head ships the typo you just fixed.

This is safe *only* on your own feature branch. Never rewrite history on `main` or on any branch someone else is building on; their repos still point at the old commits, and the divergence poisons everything downstream.

### 5.6 Undoing something that already landed on main

Wrong change merged? Do not reach for reset, and do not try to rewrite `main`. The tool is **revert**:

```
git revert <sha-of-the-bad-commit>
```

Revert creates a *new* commit whose content is the exact opposite of the bad one. History only grows; nothing is rewritten; every other agent's repo stays consistent. The revert goes through the normal PR flow like any other change. (This is also the pattern for backing out a feature flag or config change: a forward-moving undo, never a history rewrite.)

`git reset` has legitimate local uses (unstaging, abandoning uncommitted experiments), but on anything shared it is the wrong tool. The distinction in one line: **revert adds an undo commit; reset pretends the commit never happened.** Shared history must never pretend.

### 5.7 "I staged or committed something I didn't mean to" (still local)

Caught it before pushing? Everything is cheap to fix locally.

- Staged the wrong file: `git restore --staged <file>` takes it back off the loading dock; the file itself is untouched.
- Junk files in `git status` (the 0-byte word-split debris from 4.3): `rm -- <file>`, and re-check before adding.
- Last commit is wrong: `git commit --amend` (no force-push needed if you never pushed).
- Need a clean tree for a minute but don't want to commit: `git stash` shelves your edits, `git stash pop` brings them back.

### 5.8 Figuring out what happened

The read-only tools, safe to run anywhere, anytime:

- `git log --oneline -15`: the last 15 commits, one line each.
- `git show <sha>`: one commit's full diff and message.
- `git status --short`: what's edited, staged, untracked right now.
- `git diff` / `git diff --staged`: unstaged vs staged edits.
- `gh pr view <N>`: a PR's state, base, head SHA, checks.
- `gh run list --commit <sha>`: which CI runs vouch for that exact commit.

When history looks confusing, these six answer nearly every question before you touch anything that writes.

---

## The one-paragraph summary

Git takes named, fingerprinted snapshots of a folder and lets parallel lines of work (branches) diverge and re-merge safely. GitHub hosts the shared copy, wraps every merge proposal in a reviewable pull request, tests every pushed commit with robots, and refuses merges that fail. Our strategy layers discipline on top. Features happen in isolated worktrees on named branches while the shared checkout stays parked on `main`. Work lands through squash-merged PRs against `main`, and only after verifying by SHA (never by trusting the PR page) that the tests passed on the exact commit being merged. Anything that must wait stays a draft. And every constraint that matters is enforced by a hook or a gate, never by a comment and good intentions.
