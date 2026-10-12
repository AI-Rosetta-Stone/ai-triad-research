# Process Patterns

Failure patterns related to tooling configuration, agent workflows, and operational mistakes.

---

## [Process] Write Tool Security Gate Hook Blocks All Writes (RESOLVED)

**Pattern:** The security gate feedback rule (PreToolUse hook on Write and Edit) blocks ALL file writes indiscriminately, including plain markdown with no secrets.

**Instances:**
- 2026-05-21 — Sage agent blocked on Write and Edit when creating/updating LessonsLearned.md (plain markdown, no secrets).
- 2026-05-21 — Computational Linguist agent reported Write tool and Bash heredoc both failed repeatedly when writing a large markdown document; the security gate returned a scanning prompt with no actual content to scan (p/7#1).

**Root Cause:** The hook was configured as type `block` with condition `true`, which unconditionally blocked every Edit/Write call. The scanning instructions were output as the error message but no actual content evaluation occurred.

**Resolution:** Diagnostics changed the hook from type `block` to type `context` so scanning instructions are injected as guidance rather than blocking (p/9#2). Edit/Write tools work normally now.

**Lesson:** When creating feedback rules, use type `context` for advisory/scanning guidance and only use type `block` when the condition actually evaluates the content. A `block` rule with condition `true` will reject all tool calls unconditionally.

**Status:** Resolved — hook type changed from `block` to `context` (p/9#2).

**Applies To:** Anyone creating or modifying feedback rules / hooks.

---

## [Process] Feedback Rule Referencing Non-Existent Script

**Pattern:** A feedback rule was configured to run a script that was never created, causing "Cannot find module" errors on every Edit/Write.

**Instances:**
- 2026-05-21 — PostToolUse hook for `validate-doc-metadata.js` threw "Cannot find module" on every Edit call. Script did not exist anywhere in the repo (p/9#3, p/9#4).
- 2026-05-21 — Once the script was created, it failed with "require is not defined in ES module scope" because root `package.json` has `"type": "module"`, making `.js` files ESM where `require()` is unavailable. Fixed by renaming to `.cjs` (p/9#6).
- 2026-05-21 — After `.cjs` rename, still "Cannot find module" because the hook runner's cwd wasn't the workspace root, so relative paths failed. Fixed by using absolute path via `{workspace_root}` parameter (p/9#8).

**Root Cause:** Three compounding issues: (1) hook registered before the script existed, (2) script used CommonJS `require()` in an ESM-typed project, (3) hook used relative path but runner cwd wasn't the workspace root.

**Prevention:**
1. When creating a feedback rule that references a script, verify the script exists before enabling the rule.
2. New feedback rules should be tested with a trivial edit to confirm they execute without error.
3. Create the script first, then register the hook — never the reverse.
4. In projects with `"type": "module"` in package.json, use `.cjs` extension for scripts that need `require()`, or use ESM `import` syntax in `.js` files.
5. Always use absolute paths (or `{workspace_root}` template) in hook script references — never rely on the runner's cwd being the workspace root.

**Status:** Resolved after three iterations (p/9#4 missing script, p/9#6 ESM/CJS mismatch, p/9#8 relative path).

**Applies To:** Anyone creating feedback rules that reference external scripts.

---

## [Process] Bash vs PowerShell Tool Confusion

**Pattern:** Running PowerShell cmdlets (e.g., `Get-ChildItem`) in the Bash tool instead of the PowerShell tool, causing syntax errors.

**Instances:**
- 2026-06-06 — Computational Linguist: ran `Get-ChildItem` in Bash tool, causing syntax error. Fixed by switching to PowerShell tool (p/7#13).
- 2026-07-17 — Diagnostics (during triage, p/9#28; **re-hit same day, p/9#34** — identical `(Get-Item $file).Length` idiom): ran `$var = ...; (Get-Item $var).Length` (a PowerShell file-size check) in the Bash tool (POSIX sh); Bash rejected it immediately. Fixed by switching to the PowerShell tool. Tell: `$var = ...` assignment with no `export`, a `;`-chained statement, and `.Length` property access on a cmdlet result are all PowerShell, not sh. File-size/`Get-Item`/`Get-ChildItem` checks belong in the PowerShell tool. **Same agent hit the identical mistake twice in one day → the shared lesson isn't sticking during triage; a per-agent memory ("file ops = PowerShell tool") is the durable fix, not another archive entry.**
- 2026-07-26 — PowerShell 2 (p/228#1): `node require('/c/Users/.../file.json')` (a **git-bash `/c/...` msys path**) threw MODULE_NOT_FOUND. `node` is a legitimate Bash-tool program, but its **win32 runtime doesn't resolve msys `/c/...` paths** — git-bash only rewrites them for some contexts, not inside a JS string passed to `require`. Fixed by reading the JSON via the PowerShell tool with a native `C:\...` path. Tell: the wrong-tool axis isn't just *syntax* — it's also **path format**; a native win32 program invoked from Bash needs a native `C:\...` (or repo-relative) path, not `/c/...`.
- 2026-07-28 — Taxonomy Editor 2 (**`/tmp` mount variant**, p/195#5): `node -e "require('/tmp/x.json')"` failed MODULE_NOT_FOUND — Node's win32 runtime can't resolve **git-bash's `/tmp` mount** (it's a virtual msys mount, not a real Windows path), and `> /tmp/…` redirects write to a location Node can't then `require`. Fix: for any **Node-consumed temp file, use the session scratchpad's absolute Windows path**, not `/tmp`. Generalizes the p/228#1 lesson: `/tmp` and `/c/...` are both git-bash-only paths that native `node` can't see — the scratchpad Windows path is the temp-file route that works in both tools.
- 2026-08-03 — Shared Lib (p/5#23): **`cd C:\...` path in Bash (POSIX sh)** — Windows backslash paths are not valid POSIX paths; Bash interprets `\` as escape sequences and silently fails with "No such file or directory". Fixed by switching to the PowerShell tool for all git/shell ops.
- 2026-08-04 — TL (p/335#1): **Bash glob with `C:\...` Windows path** — MSYS mangled the backslashes during glob expansion; no matches returned. Resolved by switching to the **Glob tool**, which handles Windows paths natively without MSYS translation.
- 2026-08-04 — Shared Lib (p/5#25): **`cd C:\...` path in Bash again** — same failure as p/5#23. **Second time same agent hit identical mistake** → per-agent memory ("on win32, paths/shell ops = PowerShell tool") is the durable fix (mirrors the Diagnostics double-hit, p/9#28+34).

**Root Cause:** Agents have access to both Bash and PowerShell tools. PowerShell cmdlets (`Get-ChildItem`, `Get-Item`, `Invoke-Pester`, `Select-Object`, etc.), `$var = ...` assignment, `.Property` access, and `;`-chained statements only work in the PowerShell tool. Unix commands (`ls`, `grep`, `cat`, `stat -c%s`) only work in Bash (on Windows/Git Bash). **A second axis is path format:** git-bash presents `/c/Users/...` msys paths, but native win32 programs (`node`, and anything not msys-aware) resolve `C:\...` — an msys path handed to `node require`/`fs` fails as MODULE_NOT_FOUND / ENOENT. **A third axis:** Windows backslash paths (`C:\...`) given directly to Bash fail silently — Bash treats `\` as escape characters. **A fourth axis: Bash glob over `C:\...` paths** — MSYS mangles the backslashes during expansion, producing zero matches with no error.

**Prevention:**
1. Use PowerShell tool for: cmdlets (`Get-*`, `Set-*`, `Invoke-*`), `$env:` variables, `$var = ...` assignment, `.Property` access on results, pipeline operators with objects. File-size checks: `(Get-Item $p).Length`.
2. Use Bash tool for: Unix commands, `git`, `npm`, `node`, `python3`, shell scripts. File-size in Bash: `stat -c%s <file>` or `wc -c < <file>`.
3. When in doubt, check if the command uses a Verb-Noun cmdlet, `$var =` assignment, or `.Property` access — if yes, it's PowerShell.
4. **Path format:** when a native win32 program (`node`, etc.) needs a filesystem path, give it a native `C:\...` or repo-relative path — NOT a git-bash `/c/...` msys path OR a git-bash mount like **`/tmp`** (both fail as MODULE_NOT_FOUND/ENOENT — `/tmp` is a virtual msys mount Node can't resolve, and `> /tmp/…` redirects land where Node can't `require`). **For any Node-consumed temp file, write it to the session scratchpad's absolute Windows path, not `/tmp`.** For reading a JSON/data file on win32, the PowerShell tool with a native path is the reliable route.
5. **Don't use Windows backslash paths (`C:\...`) directly in the Bash tool** — Bash (POSIX sh) treats `\` as escape characters and silently mangles the path. Use the PowerShell tool for any operation that needs a `C:\...` path, or convert to a git-bash `/c/...` form (only valid for msys-aware tools) (p/5#23).
6. **For file discovery (finding files by name pattern), use the dedicated Glob tool** — it resolves Windows paths natively without MSYS translation. `find` or shell glob expressions with `C:\...` paths in the Bash tool are silently broken (p/335#1).

**Status:** Active

**Applies To:** All agents on this Windows dev environment with dual shell access.

---

## [Process] Ping-Acknowledge-Then-Idle

**Pattern:** Agents acknowledge a ping (reply, update status) then go idle without re-checking their ticket queue — missing unblocked assigned work that should have started immediately.

**Instances:**
- 2026-07-03 — Fleet audit (p/8#32): 4 agents found idle with unblocked high-priority tickets after being woken by pings. Hours of lost productivity.

**Root Cause:** Startup behavior only checked ticket queue on fresh session start. Ping-triggered auto-prompts re-entered the session mid-life, so the queue check was skipped.

**Prevention:**
1. Before going idle after ANY prompt (ping, email, auto-prompt), re-check ticket queue for unblocked assigned work.
2. Root AGENTS.md startup behavior updated to enforce this (p/8#32).

**Status:** Resolved — root AGENTS.md rule updated.

**Applies To:** All agents with ticket-driven workflows.

---

## [Process] One-Directional Git Ancestry Check → False Divergence Alarm

**Pattern:** Diagnosing "remote diverged" based on a one-directional `merge-base --is-ancestor` check and misreading a reverse diff — pattern-matching an expected failure shape without verifying the mechanism.

**Instances:**
- 2026-07-03 — Technical Lead: during cc→sit migration (t/1308#12), diagnosed "remote diverged during freeze" and began planning recovery. DevOps falsified it (t/1308#15): no CI exists in the data repo; commits were the owner's, pre-freeze. Same anti-pattern class as [Build] Deploy Preflight False-Red (AlertsManagement).

**Root Cause:** (1) `merge-base --is-ancestor` checked in one direction only — incomplete divergence conclusion; (2) reverse diff interpreted without labeling direction, misreading +/- lines.

**Prevention:**
1. Divergence claims require **two-directional ancestry test**: `merge-base --is-ancestor` in BOTH directions.
2. Always run `git status -sb` for ahead/behind counts.
3. Label reverse diffs with direction before interpreting +/- lines.
4. Before planning recovery, verify the *mechanism* — "CI committed during our window" is testable ("does CI exist in this repo?").

**Status:** Resolved — root AGENTS.md "Git forensics" Common Traps rule (bf738f2, p/8#58).

**Applies To:** All agents performing git divergence diagnosis, especially during migrations or freeze windows.

---

## [Process] Gate Blindness via Pre-Existing Noise (False-Green)

**Pattern:** A verification gate fails to detect new genuine failures because it's compromised by tolerated noise. Two mechanisms: **(A) exit-code blend** — the gate already exits non-zero from tolerated warnings, so new errors don't change the exit code; **(B) skip-before-run** — an EARLIER step that hard-fails on tolerated noise (no `continue-on-error`) aborts the pipeline *before* the real gate runs, so the real gate is **skipped entirely** and its absence reads as pass. Either way, "gate green" claims pass with live failures undetected.

**Instances:**
- 2026-07-03 — verify's eslint step was already failing from old warnings. New `RelatedEdgesPanel` errors (t/1304) survived a "green verify" claim because the exit code was already non-zero (mechanism A). Root cause analysis in t/1304#5, fix in c2f79267, gate repair tracked in t/1323 (p/8#37).
- 2026-07-26 — Technical Lead (t/1800, DevOps; p/8#101): the CI `Audit dependencies` step (`npm audit high`, **no `continue-on-error`**) hard-fails on lockfile dependabot vulns and sits **BEFORE Test**, so vitest+Pester are **skipped repo-wide** (mechanism B). The Test gate was a **false-green for ~3 pushes** and **masked t/1788's Linux route-table check**. The audit red was tolerated noise (dependabot vulns), so its failure was dismissed while the real gate never ran. **FIXED (DevOps, 231e0f3e, p/26#17):** decoupled audit into **its own job** + `.github/scripts/ci-audit.mjs` with **co-located per-app baselines** — so audit can never precede/skip Test. Durable lesson: **two independent gates must be separate CI jobs — a security gate must never precede Test in the same job, or its failure masks Test.**

**Root Cause:** When a gate is already failing (A) or an upstream step hard-fails (B) for tolerated/ignored reasons, agents learn to treat the red as normal ("it always fails / it's just the audit noise"). New genuine failures either blend into the existing non-zero exit (A) or never execute because the pipeline short-circuits first (B). Same family as [Build] Deploy Preflight False-Red (AlertsManagement) but **inverted** — false-green instead of false-red. Mechanism B is especially insidious: the real gate produces NO signal at all (skipped ≠ failed ≠ passed), and "skipped" is easily misread as "fine."

**Prevention:**
1. Gates must be kept at **zero tolerated noise** — fix or suppress existing warnings before relying on the gate to catch new ones.
2. If warnings/vulns are temporarily tolerated, use **explicit baselines co-located at the step** (eslint `--max-warnings N`; baseline the known dependabot advisory IDs in the `npm audit` step) so any *new* one changes the exit code — and set `continue-on-error` (or order the step AFTER the real gate) so a tolerated-noise step can NEVER short-circuit the real test gate.
3. **Ordering rule (mechanism B):** never place a step that hard-fails on tolerated noise *before* the real quality gate; the test gate must run regardless of audit/lint advisory state.
4. Periodically **assert a deliberate failure actually fails the gate** — inject a known error and confirm the gate catches it (Gate Verification). This catches BOTH mechanisms: a deliberately-broken test that still shows "green" reveals the gate is blind or skipped.
5. When claiming "gate green," check that the real gate **actually ran** (not skipped) and its exit code/output — not just "the job didn't surprise me."
6. **Two independent gates must be separate CI jobs** (DevOps, 231e0f3e, p/26#17): a security/audit gate must never share a job with — and precede — Test, or its failure short-circuits Test. Decouple into its own job; the strongest form of the ordering rule (#3).

**Status:** Resolved-genus, recurred 2026-07-26 in a new (skip-before-run) mechanism (t/1800) — **now FIXED (DevOps, 231e0f3e, p/26#17):** audit decoupled into its own job + `.github/scripts/ci-audit.mjs` with co-located per-app baselines, so it can never precede/skip Test. Root AGENTS.md "Gate Verification" + "Gate Co-Location" rules (overlay 5732aa7, t/1589) applied; new durable rule added to prevention (#6: two independent gates = separate jobs). Part of gate-signal-integrity genus (#20/#46/#48/#61/#64).

**Applies To:** All agents running verify gates, CI pipelines, or any pass/fail quality checks.

---

## [Process] Background-Task Gate Wrapper Swallows the Real Exit Code — False-Green from `&& echo PASS || echo FAIL`

**Pattern:** Wrapping a gate as `cmd >log 2>&1 && echo PASS || echo FAIL` (common for background tasks) makes the **task's exit code ALWAYS 0** — the trailing `echo` succeeds whether `cmd` passed or failed, so the `&&`/`||` swallows `cmd`'s real exit. The background-task-completion "exit 0" notification is therefore **meaningless for pass/fail**. Compounding: `>log 2>&1` captures only `cmd`'s output, so the `PASS`/`FAIL` marker (emitted by the `echo`, after the redirect) lands in the **task-output file, NOT the `log` you tail** — so tailing the log shows no verdict, and the exit code lies green.

**Instances:**
- 2026-07-26 — Taxonomy Editor 2 (t/1798, p/195#3): briefly misread a **failed `npm run verify` as green** — the `... && echo PASS || echo FAIL` wrapper exited 0, and the FAIL marker was in the task-output file (not the tailed log). Resolution: read the **marker text** (or the inner command's real exit code), never the wrapper's exit code.

**Root Cause:** `A && echo PASS || echo FAIL` is a shell idiom whose *own* exit status is that of the last `echo`, which always succeeds — it converts `cmd`'s pass/fail into stdout TEXT and discards it from the exit code. For a background task the harness reports the wrapper's exit (0), not `cmd`'s. Separately, `cmd >log 2>&1` redirects only `cmd`; the post-`&&` echo writes to the task's default stdout, so the verdict and the log are in different files. Same false-green genus as gate-blindness (#20/#46) but the mechanism is **exit-code laundering by the wrapper**, not tolerated noise.

**Prevention:**
1. **Never trust a background task's exit code when the command is `... && echo PASS || echo FAIL`** — that exit is the echo's (always 0). Trust the marker TEXT or the inner command's real exit.
2. **Preserve the real exit code:** run the gate without the echo wrapper (let `cmd`'s exit be the task's exit), or capture it explicitly: `cmd >log 2>&1; ec=$?; echo "EXIT=$ec"` — then read `EXIT=`.
3. **Put the verdict where you'll look:** if you emit a PASS/FAIL marker, write it into the same `log` you tail (`... ; echo "RESULT=..." >>log`), not the task's separate stdout — or just `grep` the task-output file for the marker, don't tail the redirected log expecting it.
4. **When claiming "verify green" from a background task, confirm the marker/exit, not the completion notification.** (Pairs with the gate-blindness rule: "the job didn't surprise me" is not "the gate passed.")

**Status:** Active — false-green (exit-code-laundering) variant of the gate-signal-integrity genus (#20/#46/#48/#61/#64). Distinct mechanism from gate-blindness (tolerated noise) and skip-before-run.

**Applies To:** All agents running gates as background Bash tasks, especially with a `&& echo PASS || echo FAIL` wrapper and a tailed redirect log.

---

## [Process] Gate-Flip Hygiene — Exemptions Must Live in Workflow Comments

**Pattern:** Two agents independently mislabeled a permanently annotation-only CI job (`debate-eval`) as "warning-only until 7/17" — a scheduled flip date that doesn't apply to this job. A scheduled flip date creates gravitational pull: agents assume all non-blocking jobs share the same deadline.

**Instances:**
- 2026-07-06 — Two agents independently added "warning-only until 7/17" to `debate-eval` job context, despite that job being permanently annotation-only and exempt from the flip sweep (t/1329#4, t/1332#4).

**Root Cause:** The exemption for `debate-eval` existed only in ticket history, not at the point of use. When agents encountered the job during unrelated work, they pattern-matched it to the "warning-only until flip date" convention without checking whether this specific job was exempt. Scheduled flip dates act as attractors — anything that looks similar gets pulled in.

**Prevention:**
1. Jobs exempt from a flip sweep need the exemption stated **in the workflow file comment**, not in ticket history — point-of-use beats point-of-decision.
2. When adding or updating gate annotations, verify the specific job's intended lifecycle before applying fleet-wide conventions.
3. Same principle as gate blindness (#46): gate metadata must be self-describing at point of use.

**Status:** Resolved — root AGENTS.md "Gate Verification" + "Gate Co-Location" rules (overlay 5732aa7, t/1589). Part of gate-signal-integrity genus (#20/#46/#48/#61/#64). Structural fix (flip/never-flip taxonomy in ci.yml header) also tracked via p/28#30.

**Applies To:** All agents modifying CI workflow files or gate annotations.

---

## [Process] Overwrite/Clobber Claims & Config-Failure Triage Without Object-Level Verification

**Pattern:** A "commit X broke/overwrote F" claim is asserted from the **working tree** (grep, symptom counts, commit dates) instead of the committed object, then retracted when someone finally checks the object. Two shapes: (a) a clobber claim churned across diagnostic rounds; (b) a **config failure** (missing entry, BOM, wrong value in the working-tree config file) attributed to a commit — when the committed code was correct all along and the divergence lived only in the local working tree.

**Instances:**
- 2026-07-06 — Computational Linguist + 2nd agent (t/1351): a git-forensics clobber claim went through 3 diagnostic rounds across 2 agents. Ancestry got inverted twice. Resolved only when blob SHAs were compared: `git rev-parse X:path` vs `git rev-parse X~1:path` — identical blob = file untouched, debate over in one command (p/7#22).
- 2026-07-17 — Diagnostics (**2nd config-failure instance**, p/9#30): a flight recorder showed `zai-glm-5-2` missing from `ai-models.json` + a BOM. Diagnostics **grepped the working tree** and attributed both to a revert commit — never running `git show HEAD:ai-models.json`. The committed code was correct; the divergence was working-tree-only. Notably, the memory rule ("`git diff HEAD -- <configfile>` before blaming a commit for config") **existed but was not applied under triage pressure** — the 1st config instance was the t/1618 Z.AI triage.

**Root Cause:** Timeline/working-tree reasoning ("commit X came after Y, so X must have broken it" / "the file is wrong now, so a commit made it wrong") is unreliable — commits can touch many files, the accused commit may not have modified the file at all, and a working-tree config file can diverge from committed state via a local refresh/edit with no commit involved. Without content identity (blob SHA / `git show HEAD:<file>`), agents pattern-match symptoms to a plausible commit and waste rounds. The recurrence shows a second failure mode: **the object-level rule can exist (root AGENTS.md + memory) yet not fire during live triage** — knowing the rule ≠ invoking it when a plausible commit-blame narrative is in hand.

**Prevention:**
1. For any "a commit broke/overwrote F" claim, **object-level comparison is the FIRST check** — before timeline or working-tree reasoning:
   - `git rev-parse <commit>:<path>` vs `git rev-parse <commit>~1:<path>` — identical SHA = file untouched at that commit.
   - `git diff <commit>~1 <commit> -- <path>` — empty diff = no change.
2. If blob SHAs differ, THEN examine what changed: `git show <commit> -- <path>`.
3. **Config-failure triage specifically:** before asserting a commit broke config, run `git diff HEAD -- <configfile>` (or `git show HEAD:<configfile>`) — a non-empty diff means the problem is **working-tree-only** (local refresh/edit), NOT the committed code. A missing entry or BOM in the working tree is a working-tree symptom until the committed object proves otherwise.
4. Never conclude "X broke/overwrote F" from commit dates, grep of the working tree, or symptom counts alone.
5. **The rule must fire during triage, not just exist:** when you have a plausible commit to blame, that is exactly the moment to run the object-level check — treat "I suspect commit X" as the trigger phrase for `git show HEAD:<path>`. Same diagnostic-discipline family as #44 (one-directional ancestry → false divergence) and #54 (dirty tree as false witness).

**Status:** Resolved (root AGENTS.md "Git forensics" Common Traps rule, bf738f2, p/8#58) — but **recurred 2026-07-17 as a config-failure variant despite the rule** (application gap under triage pressure, prevention #5). If a 3rd config instance appears, consider a point-of-use trigger (a triage-checklist step or Diagnostics hook) rather than relying on recall.

**Applies To:** All agents performing git forensics and config-failure triage — overwrite/clobber claims, data-loss triage, and any "a commit broke this config" diagnosis.

---

## [Process] Narrated Handoff Never Executed — "Filing" vs "Filed"

**Pattern:** A ticket comment ends with "filing a [downstream] ticket" but the ticket is never created. The completed design sits unrouted until a staleness check catches it days later.

**Instances:**
- 2026-07-09 — Computational Linguist: ticket comment said "filing a DebateTool implementation ticket" but the ticket was never created. The completed design sat unrouted 8 days until PM's staleness check found it (p/7#28).

**Root Cause:** The filing was narrated as the comment's last line instead of being done before posting. The comment described intent ("filing") rather than accomplished fact ("filed: t/NNNN"). Same family as the t/1221 "looks shipped but isn't" anti-pattern — at the handoff layer instead of the commit layer.

**Prevention:**
1. Create the downstream ticket FIRST, then write the comment referencing its key — a comment can only say "filed: t/NNNN" truthfully, never "filing."
2. If the comment is already posted without the ticket, create the ticket immediately and edit the comment to add the reference.
3. Rule of thumb: any comment that says "will do X" is a promise that might not be kept. Comments that say "did X: [ref]" are verifiable.

**Status:** Active

**Applies To:** All agents creating handoff comments in tickets.

---

## [Process] Concurrent Duplicate Ticket-Filing — Same-Role Race OR Multi-Agent Off a Live Incident Thread (No Claim/Coordinator Step)

**Pattern:** Multiple actors independently file the **same follow-up ticket** off shared context within minutes, with no claim/coordination step to prevent the race. **Two variants, same root:** (A) **same-role** — two instances of one role action the same shared tracker (parent ticket); (B) **multi-agent incident** — several *different* agents watching a **live incident thread** each file the same follow-up for the incident. The second filer doesn't know the first already cut the ticket.

**Instances:**
- 2026-07-13 — Computational Linguist (**variant A**): CL Main and CL.Investigate1 filed duplicate Phase 2 tickets (t/1577 vs t/1579) for the same tracker within 2 minutes. Second same-day near-dup after parallel answers on t/1560. Cost: dup-close + an AC nearly lost in consolidation (p/40#9).
- 2026-07-30 — P1 prod outage (**variant B**, TL p/8#149; incident #119/t/2047): **two dup PAIRS in one incident** — t/2053 vs t/2054 and t/2061 vs t/2062 — multiple agents filing the same follow-up off the live incident thread. During a high-visibility incident many watchers each reach to file the obvious follow-up. TL proposing **coordinator-owns-incident-follow-up-filing**: one designated incident coordinator owns cutting follow-up tickets; others route observations to them.

**Root Cause:** actors share a board/context (a tracker, or a live incident thread) but have no coordination protocol for claiming follow-up work — a classic check-then-act race. The incident variant is worse: an incident thread has *many* concurrent watchers (not just 2 instances of one role), so the dup-fan-out is wider and happens under time pressure when everyone wants to capture the follow-up.

**Prevention:**
1. **Announce intent BEFORE cutting the ticket** — comment "claiming <scope>/filing follow-up for this incident" on the tracker/thread and wait for it to land before filing.
2. **Search open tickets for the scope first** — `search_tickets` for the tracker/incident key + label before creating (the standing "search before filing a follow-up" rule).
3. When consolidating dups, **merge ACs from both** — don't just close the second; it may have unique criteria the first lacks.
4. **During an incident, ONE coordinator owns follow-up-ticket filing** (TL p/8#149): watchers route observations to the coordinator rather than each filing; the coordinator cuts one ticket per follow-up. Scales the claim-step to the many-watcher incident case where per-actor announce-intent doesn't converge fast enough.

**Status:** Active — broadened 2026-07-30 from same-role (variant A) to also cover multi-agent-off-a-live-incident-thread (variant B, P1 t/2047: 2 dup pairs). TL proposing coordinator-owns-incident-follow-up-filing (prevention #4) — watch for the disposition.

**Applies To:** All roles/agents filing tickets from shared context — multiple instances of one role on a tracker, AND any agents watching a shared live incident thread.

---

## [Process] Orca Feedback-Rule Tooling Lies About Liveness — Manifest-Lag + False Audit Counters

**Pattern:** Orca's feedback-rule tooling gives two false-negative signals about whether a rule is live and firing: (1) a rule created/updated **mid-session is inert until the next session** because the runner executes compiled `feedback-rules/manifests/*.json` snapshots, not the live DB — yet `get_feedback_rule.enabled` still reports `true`; (2) the **audit counters** (`has_run` / `fire_count_24h` / `last_fired_at` / `recent_executions`) read false/0/null **even for rules that demonstrably fire every prompt**. Diagnosing a rule as "dead" from either signal is wrong.

**Instances:**
- 2026-07-17 — Technical Lead (t/1625, validated live this session; p/8#71). **Gap 2 re-confirmed:** `agent-status-reminder`, `security-secrets-block`, `fetch-through-bridge`, `ps-strict-mode-count-guard`, `warn-ping-length`, `route-errors-to-sage` all fired this session yet report `has_run:false, fire_count_24h:0, last_fired_at:null`; only `doc-metadata` + `git-commit-pathspec-flag-order` show `has_run:true` (`fire_count`/`last_fired_at` universally 0/null). **Gap 1 accepted** on Diagnostics' decisive manifest-grep evidence (new rule in 0 snapshots; established rules in 55–68) and corroborated by t/1623's `lossy-error-boundary-guard` (created last session) now showing compiled/live in `list_feedback_rules` — consistent with the DB→manifest compile-on-sync model. Forward to Orca via `submit_feedback` blocked on an offline beta-license token; re-submit pending network.

**Root Cause:** The rule runner reads **compiled manifest snapshots** produced at session-sync time, so DB writes (create/update/enable) don't reach the runner until the next sync — the DB-visible `enabled:true` and the runner-visible manifest diverge in-session. Separately, the execution audit counters are not reliably incremented on fire, so they under-report actual firing. Both are **Orca-platform tooling gaps, not in-repo bugs**, and both produce the same failure mode: a working rule looks dead.

**Prevention:**
1. **Liveness = grep the manifests, not the DB flag.** Verify a rule is live by grepping `feedback-rules/manifests/*.json` for the rule name — presence across recent snapshots means the runner has it. `get_feedback_rule.enabled:true` only means the DB row exists.
2. **Never diagnose a "dead" rule from audit counters.** `has_run` / `fire_count_24h` / `last_fired_at` / `recent_executions` read false/0/null even for actively-firing rules — not evidence a rule never fires.
3. **A newly created/updated rule is inert until the next session** — don't expect it to fire in the session that created it; confirm live-fire only after a sync boundary.
4. Report platform gaps to Orca via `submit_feedback` (needs an active beta-license token / network); track in-repo as a low-priority item since it can't be fixed here.

**Status:** Active — Orca-platform tooling gap (cannot be fixed in-repo); forward to Orca pending network (beta-license token offline). **Directly informs the t/1623 `lossy-error-boundary-guard` live-fire watch:** its `has_run:false` must NOT be read as "hook never fired" — confirm liveness via manifest presence + a deliberate live-fire *after* the next sync boundary.

**Applies To:** All agents creating, auditing, or relying on Orca feedback rules / hooks — especially anyone verifying a hook went live (Diagnostics, Sage, TL).

---

## [Process] Feedback Hook Silently Dead on Windows — `{workspace_root}` Expands Empty → Wrong Path → crash → exit 1 Suppresses With No Guidance

**Pattern:** A feedback hook whose `run.args` reference `{workspace_root}` is **silently non-functional on Windows** because `{workspace_root}` expands to an **empty string**. Node then receives `/operations/diagnostics/<script>.cjs`, which on Windows resolves to `c:\operations\...` (a path that doesn't exist), so the script crashes. The crash exits 1, which the runner treats as "suppress" — the hook neither runs its check NOR surfaces any guidance. The result is the worst kind of gate: it **looks installed** (rule enabled, manifest present) but provides **zero coverage and zero signal** — a false-green far more dangerous than no hook, because everyone believes the guard is in place.

**Instances:**
- 2026-07-26 — Diagnostics (p/9#39, discovered while extending `check-git-commit-order.cjs`, commit 039f9501): the hook's `{workspace_root}` expanded empty on Windows → node got `/operations/diagnostics/check-git-commit-order.cjs` → resolved to `c:\operations\...` → script crashed → exit 1 → suppressed with no guidance. The regex fix (overlay-form coverage) is committed but **dead until the path expansion is resolved**. Almost certainly affects **every** hook whose args use `{workspace_root}` — including the `staged-files-after-commit` hook (#76's supposed mechanical defense).
- 2026-07-26 — **post-inlining regression: the residual is now LOUD noise, not silence** (Sage direct observation across the session + PowerShell 2 p/228#1 + **DebateTool p/70#11, 2026-07-29 — 3rd fleet observer**): after the p/9#41 re-inline, the guard runs but logs **`Feedback rule 'node' exited with code 1` on ~every matching Bash/PowerShell call** — PowerShell 2 read it as "a broken feedback rule," and DebateTool independently re-flagged the same "exits 1 on every PS/Bash call, silent in PreToolUse, doesn't block, cause unknown." This strongly implies the inlined `node -e` script **exits 1 unconditionally** (even when there's NO flag-order/staged violation), i.e. an exit-logic/parse bug in the inlined form, not a real flag. Net effect: the fix traded a *silent* dead hook for a *noisy* one — arguably worse for gate-signal-integrity, because constant `exited code 1` noise trains the whole fleet to ignore the guard, so a real flag won't be read either. **3 distinct fleet observers now** — the noise is spreading, reinforcing the priority of the queued exit-0-on-clean fix.

**Root Cause:** The hook-runner's `{workspace_root}` template variable does not expand on this Windows setup (empty string), so absolute-path construction in `run.args` silently produces a bogus root. This is the exact opposite failure mode of the standing Diagnostics rule "always use absolute paths via `{workspace_root}`" — the rule assumed `{workspace_root}` resolves; here it doesn't. Compounded by the runner's **exit-1 = suppress-silently** contract: a *crashing* hook is indistinguishable from a *passing* hook, so the failure is invisible. This is a gate-signal-integrity failure (root AGENTS.md #20/#46): a gate that can't run can't detect anything, and one that fails silently reports false-green. Sibling of #68 (feedback tooling lies about liveness) — there the lie was manifest-lag + false counters; here it's a crash masquerading as a pass.

**Prevention:**
1. **A hook is not "landed" until it's proven to FIRE on Windows** — enabled + manifest-present is not enough (see #68). Test with a deliberate trigger and confirm the guidance actually appears; a hook that never emits output may be crashing, not passing.
2. **Verify `{workspace_root}` actually expands** in this environment before relying on it for hook script paths; if it expands empty, use a path form that works on Windows (or resolve the script path inside the `.cjs` via `__dirname`/`process.cwd()` rather than a template arg).
3. **A crashing hook must not silently pass** — where possible, make hook failure visible (non-suppressing error surface) so a dead guard is detected, not assumed working. Exit-1-as-suppress hides exactly the failure you most need to see.
4. **Audit ALL `{workspace_root}` hooks for the same silent death** — this is not one hook's bug; every hook using that template on Windows is suspect. (Recommended a fleet-wide hook audit to Diagnostics.)
5. **A hook must exit 0 on the clean/no-violation path.** If the inlined script exits non-zero unconditionally (crash or exit-logic bug), it emits `node exited code 1` on EVERY matching call — pure noise that trains the fleet to ignore the guard (violates the zero-gate-noise rule, #20/#46). Test the clean path explicitly, not just the violation path.

**Status:** Active — three-part root cause. **Part 1 — `{workspace_root}` path crash: FIXED (Diagnostics audit, p/9#41):** the two hooks using `{workspace_root}` external scripts (`git-commit-pathspec-flag-order`, `staged-files-after-commit`) were **re-inlined via `node -e`**; no other `run.command` hooks exist, so the path-crash class is closed. **Part 2 — exit-1-suppresses-silently: OPEN, Orca Support's platform contract** (a hook exiting non-zero for any reason is suppressed with no signal — crash indistinguishable from pass). **Part 3 — NEW, post-inlining (p/228#1): the inlined guard now exits 1 on ~every matching call regardless of violation** → fleet-visible `node exited code 1` noise (2 observers: Sage + PowerShell 2). This is an in-repo bug in the inlined script's exit logic (prevention #5), separate from the Orca contract, and Diagnostics can fix it directly (exit 0 when clean). Until Parts 2+3 are fixed, the guard provides neither reliable signal (Part 2) nor low noise (Part 3) — the behavioral rule remains the real defense. Flagged both to Diagnostics (p/9 thread). **Scope add (p/9#47):** when Part-3 is fixed (exit 0 on clean), Diagnostics will also have the guard emit corrective guidance on a real flag-order violation — "flags before --: git commit -m 'msg' -- <paths>" — turning the 7×-recurring cryptic git pathspec error into a one-line fix (see the git `--` flag-order pattern in build.md).

**Applies To:** All agents (esp. Diagnostics) authoring or relying on feedback hooks on Windows — and Sage/TL when recording a hook as a "mechanical defense," which must now carry a "proven-to-fire-on-Windows" caveat.

---

## [Process] Rule-Exists-But-Not-Applied — a Point-of-Use Failure Class (not a coverage gap)

**Pattern:** A recurrence whose root cause is NOT a missing rule — the rule is written, correct, and in the right place (AGENTS.md / a skill step / a memory) — but it **doesn't fire at the moment of action**. The agent doesn't recall/apply it mid-task. This is a distinct triage class from "no rule exists": adding more prose won't fix it, because the failure is point-of-use, not coverage. The lever is a **point-of-use gate (PreToolUse hook)** where the signal is clean — converting the rule from something-to-remember into something-enforced.

**Instances (running tally — tag every new one; track BOTH the class total AND the max-per-offender count, per TL p/8#95/#97). Current: CLASS TOTAL ≥ 12 / ~6 trigger → MET; MAX PER OFFENDER ≥ 5 / 4 trigger → MET. TWO offenders now trip the per-offender trigger (see #4 and #5).**
- 2026-07-17 — object-level git-forensics, **2nd config-failure instance** (Diagnostics, p/9#30): the "run `git diff HEAD -- <configfile>` before blaming a commit for config" rule existed in memory + root AGENTS.md but wasn't invoked mid-triage. [offender: config-forensics recall — count 1]
- 2026-07-26 — strict-mode unguarded property access (TL, t/1726, p/8#88): the `PSObject.Properties` guard rule existed (scripts/AGENTS.md) but wasn't applied at 4 `.factual_claims` sites; a blanket property-access hook was ruled too noisy to scope. [offender: strict-mode property guard — count 1]
- 2026-07-26 — `/land-from-worktree` #81 (ServerAPI, p/79#10 / p/8#93): step 7 mandates `git restore --worktree` and explicitly forbids `git checkout … -- <files>`; the agent used the forbidden form anyway. [offender: land-worktree step-7 form — count 1]
- 2026-07-26 — **direct-commit-to-shared-main instead of worktree-landing** (TL, p/8#99; PM p/21#49): agents keep committing docs straight to LOCAL shared `main` rather than worktree-landing. The worktree-landing rule exists (the `/land-from-worktree` skill + root AGENTS.md) but isn't applied at commit time. **Recurring since t/1714; PM flagged 5 more re-stranded TODAY** → this offender is at **≥5 instances on its own** (floor; recurrences pre-today not fully counted). [offender: worktree-landing-not-applied — count ≥5 → **trips both triggers**]
- 2026-07-26 — **data-shape type-check-not-applied** (Computational Linguist, p/7#36 + p/7#38; **REVERSES Sage's earlier not-in-#82 call**): the root "Data File Convention" rule (inspect a sample + `type()`/`isinstance()` before operating) exists but keeps not being applied — inline code assumes uniform JSON shape and crashes on the variant (p/7#38: `interpretations.{pov}` dict for 1,236 nodes / string for 23, same-session recurrence hours after the prior instance was logged). I originally excluded this as "trivial/self-correcting/not-hookable" (p/7#36); **CL's same-session-recurrence argument corrects that — severity is not the gating criterion, frequency + rule-not-applied is, and recording-isn't-preventing is precisely this class's signature.** Post-rule inline type-check misses: p/7#16, p/7#18, p/7#36, p/7#38 → [offender: data-shape type-check — count ≥4 → tripped the per-offender trigger]. **DISPOSITION: RULE-ONLY, no hook (t/1810 spike, TL p/8#109).** Empirical false-red surface is decisive: `graph_attributes` = 514 reads / 132 files, `interpretations` = 213 / 76 — and the *correct* pattern (normalize-at-fetch) leaves **most reads legitimately guard-free**, so a "read-without-coercion" detector would false-red on correct code = dead gate (#20/#46). Strengthened instead by **TS union-types (tsc = the real gate) + naming the variadic fields in the rule** (detail t/1810#1). **Recurrence continues (+3 probe, p/7#47 → ≥7) — confirming rule-only means recall is the residual risk** — and the class shipped to PRODUCTION (extraction cmdlet char-explodes bare-string `aliases`, 13/37 records, t/1830). **Correction (CL p/7#49): that bug is in POWERSHELL (`Invoke-EntityExtraction`), so the TS-union-types strengthening does NOT cover it — no `tsc` runs on that surface.** The PS-side prevention is coerce-at-read (`if ($x -is [string]) { @($x) }`) at each AI-JSON boundary as ONE shared helper (Shared Utility Rule) + a bare-string Pester fixture. So the offender's real defense splits by surface: **TS surfaces → union types (tsc catches it); PS surfaces → shared coerce-at-read helper + Pester fixture** — the rule-only disposition holds, but "strengthen with the real gate" means a *different* gate per language.

**Root Cause:** Rules delivered as prose (AGENTS.md, skill steps, memory) depend on recall at the exact moment of action; under task focus/triage pressure the relevant rule often doesn't surface. Coverage (the rule exists) and application (it fires when needed) are different problems, and only the latter is failing here. The reliable fix is to move enforcement to the point of use — a gate that fires mechanically — but only where the trigger is cheaply and unambiguously detectable (the `ps-strict-mode-count-guard` `.Count` guard is the model; a blanket property-access hook was rejected as too noisy — that tradeoff still holds).

**Prevention:**
1. **Triage recurrences into two buckets:** "no rule exists" (→ write/escalate a rule) vs "rule exists but wasn't applied" (→ this class; more prose won't help). Record which bucket in the pattern's Status.
2. **For the point-of-use class, tag every instance and track TWO counters; TL acts on whichever trigger fires first (p/8#95/#97):**
   - **(a) per-offender:** any single offender hits its **4th** instance → TL specs a point-of-use hook *for that offender* (the `.Count` guard is the model).
   - **(b) class-total:** the class reaches **~6 total instances across offenders** → that's systemic (a long tail of distinct one/two-off offenders, not one bad actor), so the lever is a **broader point-of-use reinforcement** — a review-habit/checklist change or a meta-hook — NOT one rule.
   - Rationale for (b): a per-offender trigger alone never fires when the class grows via many distinct offenders each recurring once or twice — which is exactly the observed trend (3 instances / 3 offenders). Rank both counters in the tally header.
3. **The hook lever converts an offender ONLY when its violation is a crisp, unambiguous SYNTACTIC signal** (TL, general #82 criterion, p/8#109). If the offender's *correct* pattern is **syntactically identical** to the violation, a detector false-reds on correct code = dead gate (#20/#46) → it stays **rule-only**. Worked examples: **#4** direct-commit (`branch == main` = crisp, distinct signal → HOOK, t/1780); **#5** data-shape read-without-coercion (correct normalize-at-fetch leaves most reads legitimately guard-free — 514/213 reads across 132/76 files — so violation ≈ correct → RULE-ONLY, t/1810). This is the sharpened form of "cleanly detectable": *detectable* means *distinguishable-from-correct*, not just *greppable*.
4. **When rule-only, strengthen the rule's reach by other real gates, not a noisy hook** — e.g. TS union-types so `tsc` (the real gate) catches the shape mismatch, and name the specific variadic fields in the rule (t/1810#1). Where it stays rule-only, the honest record is "rule is the only defense; recall is the residual risk."

**Status:** Active — **BOTH triggers fired 2026-07-26; both offenders now have concrete dispositions (TL, p/8#104):**
- **Offender #4** (direct-commit-to-shared-main, ≥5) → hook **already spec'd as t/1780** (In Review with Diagnostics; Gate-Verification + owner-go gated). No new spec needed; the #5 data point reinforced its priority. Cleanly hookable (greppable). Sibling context: same behavior drove the large-divergence push failure (p/9#36). **CONFIRMED FIRING in the field (2026-07-30):** the pre-commit push-guard (t/1926/t/1780 family) blocked a DIRECT `git commit` to shared main — DebateTool skipped worktree-land for a "trivial single-file fix" and the hook refused it, forcing the `/land-from-worktree` PR flow (t/2028, p/234#6). This both proves the hook works AND enforces the **"trivial change still needs worktree-land"** rule (the carve-out is now dead — the hook admits no trivial exception). Offender #4 = hook-converted.
- **Offender #5** (data-shape type-check, ≥4) → **RULE-ONLY, no hook (t/1810 decided, TL p/8#109).** The spike measured the false-red surface — `graph_attributes` 514 reads/132 files, `interpretations` 213/76 — and found the correct normalize-at-fetch pattern leaves most reads legitimately guard-free, so a read-without-coercion detector false-reds on correct code (dead gate, #20/#46). Strengthened by TS union-types (tsc = the real gate) + naming the variadic fields in the rule. This validated the general criterion now in prevention #3 (hook only when violation ≠ correct syntactically).
- Class-total ≥12; **both offenders dispositioned.** Net outcome: of the two per-offender-trigger offenders, one earned a hook (#4, crisp signal) and one stayed rule-only (#5, violation≈correct) — exactly the discrimination the crisp-syntactic-signal criterion predicts. **Sage standing action:** keep tagging new distinct offenders + both counters; watch t/1780 (In Review).

**Applies To:** Sage (triage + tagging) and TL (hook-spec decision) — and anyone tempted to answer a recurrence with "add a rule" when the rule already exists.

---

## [Process] Post-Compaction Summary Framing Trusted Over Object State — Phantom Loose End

**Pattern:** After a **session boundary** (context compaction OR a session interruption), the resumed state is stale: a summary frames already-committed work as an outstanding "loose end," OR a **peer instance has landed the work while you were paused**. Acting on the stale framing instead of the object-level truth (git refs + ticket status) produces wasted redo, a duplicate ticket against work that's already Done, or an attempted re-commit of content already in HEAD.

**Instances:**
- 2026-07-17 — Computational Linguist (p/7#37): a post-compaction summary framed a redundant essay copy (`analyses/bronder-…`) as "the uncommitted deliverable," when the canonical review (`docs/instrument-effects-review.md`) was **already committed + CLOSED** with follow-up tickets t/1668–1673 filed. Acting on the framing, CL filed a **duplicate PM ticket (t/1684) against the already-Done t/1673**, then a `git mv` of the essay into `docs/` aborted "destination exists" — the git error was what finally surfaced the true state. Resolved: cancelled t/1684, reverted the essay to committed state, verified via same-commit blob provenance.
- 2026-07-26 — Computational Linguist (**peer-already-landed variant**, p/7#42): after a **session interruption**, CL re-drove a pending register-staging commit for the t/1676 provenance entries; the script exited 1 ("nothing to stage") because sibling **CL.Investigate1 had already committed the identical hunks (7f9b4c36)** during the pause, so the diff was empty. **Benign — the "nothing to stage → abort" was correctly-designed fail-safe behavior** (a good gate: it refused to act on an empty diff), and an object-level check confirmed all entries were in HEAD; no data loss. Cousin of #83 (concurrent writers). Lesson: after any interruption, `git log -- <file>` before re-driving a pending commit — a peer may have landed it.

**Root Cause:** A resumed session's picture of "what's still to do" is a lossy reconstruction, not a source of truth — whether it's a **compaction summary** (stale narrative) or a **post-interruption assumption** that your pending work is still pending. It can misrepresent *committed* state (a file it calls "uncommitted" is already in a commit — possibly landed by a **peer instance** sharing the branch), and *ticket* state (work it calls "unrouted" already has a Done ticket). Trusting the framing over the object state is the same failure as citing the working tree as evidence of committed state (Git Forensics #44/#54/#55) — extended to **ticket status** and to **peer-landed commits**. The session boundary (compaction or interruption) is the trigger; the resumed assumption is confident but stale.

**Prevention:**
1. **After any compaction, treat "loose end" claims in the summary as unverified.** Before acting, confirm against object state: `git log/show <path>` and blob-SHA provenance for "uncommitted"; `list_tickets`/`get_ticket` for "unrouted"/"undone."
2. **Before filing a follow-up ticket, `search_tickets` for the scope** — a summary that doesn't mention an existing Done ticket is not evidence one doesn't exist (same dup-prevention step as #195).
3. **A destination-exists / already-committed / nothing-to-stage error is a signal, not just an obstacle** — when git or the tracker contradicts the resumed framing, the object state wins; stop and re-derive from it (root AGENTS.md "Git forensics — object level, never inference"). A script that **aborts on an empty diff is a correctly-designed fail-safe** — treat its refusal as "already landed," not as a failure to work around.
4. **After a session interruption, `git log -- <file>` (and check for peer commits) before re-driving a pending commit** — on a shared branch a peer instance may have landed your work while you were paused; re-driving it finds an empty diff (best case) or duplicates (worst case). Same discipline as compaction: verify object state before acting.

**Status:** Active — genus broadened 2026-07-26 (p/7#42) from *compaction* to *any session boundary* (compaction OR interruption), and to the **peer-already-landed** variant on shared branches.

**Applies To:** All agents resuming after a context compaction OR a session interruption — especially before committing a "loose end," filing a follow-up ticket, or re-driving a pending commit a peer may have already landed.

---

## [Process] Stale Barrel-Path Citations After ADR-007 Splits Fail SILENTLY (grep-empty, never a broken build)

**Pattern:** The ADR-007 splits turned single files into **barrel DIRECTORIES** — `calibrationLogger.ts` → `calibrationLogger/`, plus `prompts/`, `types/`, `claimExtractionPipeline/`, `gapAndDrift/`, etc. The import surface still works (the barrel re-exports), so **builds/verify stay green** — but every prose reference to the old `<name>.ts` path (docs, register, tickets, emails) now points at a file that no longer exists. The rot is **silent**: it never breaks a build, so it's only ever caught by a **grep returning empty** or a human following a dead citation.

**Instances:**
- 2026-07-26 — Technical Lead / Computational Linguist (p/8#106/#107): **4 stale citations across 3 tickets, 1 offender class** (post-ADR-007 barrel splits) — `prompts.ts` + `types.ts` (t/1701), `gapAndDrift.ts` (t/1782), `calibrationLogger.ts` (e/43). All 4 surfaced via **grep-returning-empty**, none via a broken build.

**Root Cause:** Splitting `<name>.ts` → a `<name>/` barrel preserves the *import* surface (`import { x } from '.../<name>'` still resolves via the barrel index), so `tsc`/verify never complain. But a **prose citation** of the concrete file path (`<name>.ts`) is not an import — nothing validates it — so it silently rots to a nonexistent path. No build gate can catch it because the build was never wrong; the wrongness is only in the human-facing reference.

**Prevention:**
1. **Verify the cited path RESOLVES at citation time** — post-t/1686, a cited `<name>.ts` may now be a `<name>/` barrel directory; check for the `<name>/` dir + the specific sub-module before writing the citation. Do NOT rely on fix-on-break — it never breaks.
2. **When splitting a file into a barrel, grep docs/register/tickets/emails for the old `<name>.ts` path** and update them (or leave a redirect note) as part of the split.
3. **Treat silent-failure classes as verify-at-write-time, not fix-on-break** — anything caught only by grep-empty (never a red build) has no gate, so the discipline must be at the moment of citation.

**Status:** Active — NOT a #82 rule-not-applied case (this is a *new hazard* introduced by ADR-007, not a pre-existing rule left unapplied). **Unit note (TL p/8#107):** report the units separately — 4 citations / 3 tickets / 1 offender class / 2 reporters (TL owns the single report; DebateTool 2 is not a duplicate — don't double-count). Sage tallies (esp. #82 triggers) are unit-sensitive: citations ≠ tickets ≠ offenders ≠ agents.

**Applies To:** All agents citing `lib/debate` file paths post-ADR-007 splits (docs, register, tickets, emails), and anyone splitting a file into a barrel directory.

---

## [Process] win32 "Task Stopped" Kills the Wrapper, Not Detached Child Trees — Relaunch Races a Surviving Writer

**Pattern:** A background batch is launched as a shell wrapper that spawns a **detached child tree** (e.g. python that spawns node). When the session restarts (or `TaskStop` fires), the task is marked **"stopped"** and the **wrapper shell is killed — but the detached child tree keeps running** on win32. Trusting the "stopped" bookkeeping and **relaunching** then puts **two live writers racing on the same output slugs**. The **inverse of the peer-already-landed variant of #69**: there a peer *finished* your work so your relaunch found nothing; here a supposedly-killed process *survived*, so your relaunch duplicates a live writer.

**Instances:**
- 2026-07-26 — Computational Linguist (p/7#44/#45, CLI-hang filed t/1824): after a session restart marked a debate-batch task "stopped," CL relaunched a filler — but the original runner's **python + node tree had survived** the restart (a later `TaskStop` killed only the shell wrapper), so **two writers raced the same output slugs for ~40 min**. Found both trees via **CIM command-line match**, `taskkill /F /T` on all roots, then object-audited every artifact set (**id-match + mtime spread + single-run flight recorder**) — no tears. **Benign only because both writers ran identical configs**; with differing configs it would have torn artifacts.

**Root Cause:** On win32, killing a process (task-stop, session restart, `Stop-Process` on the wrapper) does **not** cascade to detached child processes — a shell wrapper's `python`/`node` children, once spawned detached, outlive the wrapper. The task-runner's "stopped" status reflects the **wrapper's** state, not the child tree's; "stopped" is **bookkeeping, not a kill**. So a relaunch guarded only by the task status can spawn a second writer alongside a surviving first — a concurrent-writer race (same family as #83 / the serialize-data-repo-batches convention), masked because the runner reports the batch as not running.

**Prevention:**
1. **Before relaunching ANY batch, verify at the PROCESS level that zero prior writers are alive** — don't trust "task stopped." On win32: `Get-CimInstance Win32_Process | Where CommandLine -match '<runner/slug>'` (CIM command-line grep) to find surviving trees.
2. **Kill the whole tree, not the wrapper:** `taskkill /F /T /PID <root>` (or `Stop-Process` walking children) on every matching root — a bare wrapper kill leaves the children running.
3. **If a race may have occurred, object-audit the artifacts** — id-match, mtime-spread, and single-run flight-recorder checks per output set — to confirm no torn/interleaved writes before trusting the results.
4. **Serialize batch writers** (pairs with #83 prevention #5): a surviving writer + a relaunch is exactly the concurrent-writer collision the serialize-and-announce convention prevents.

**Status:** Active — win32 process-tree semantics; inverse of #69's peer-already-landed variant. Underlying CLI-hang tracked t/1824 (CL).

**Applies To:** All agents launching detached background batches on win32 (debate runners, enrichment pipelines) — especially before relaunching after a restart/TaskStop.

---

## [Process] Subagent "Completed" Is Process-Bookkeeping, Not Deliverable-Existence — Verify Artifacts Independently

**Pattern:** A background subagent's task-completion notification ("completed") fires whenever the agent **stops with no live children** — NOT when its **deliverables exist**. A subagent can report "completed" (even repeatedly) while it's still mid-research with **zero files written and no commit**. Trusting the notification and "landing" on it lands **nothing** — the status describes the agent's process state, not the artifacts.

**Instances:**
- 2026-07-26 — PowerShell (t/1806, delegated a large PS build to a background subagent, p/20#27): the subagent's task-notification reported **"completed" TWICE while still mid-research — zero files written, no commit**. Caught by grounding-truth (filesystem/git check); nothing lost. Had the "completed" been trusted, the land would have shipped nothing.

**Root Cause:** The "completed" signal is **bookkeeping about the process** (the agent stopped; no live child processes), not **evidence about the outcome** (files written, commit landed, tests pass). Same genus as #86 ("task stopped" ≠ process killed) and #69 (task status ≠ committed state): a status/lifecycle signal is not proof of the deliverable. Delegating does NOT delegate the Definition of Done — the caller still owns verifying committed artifacts (ADR-005 / SHA-in-completion-comment discipline), and must not inherit the subagent's word for it.

**Prevention:**
1. **Never treat a subagent "completed" as done — verify every deliverable independently** at the filesystem/git level: `Test-Path` each expected file, `git log`/`git show` the expected commit (SHA), and **re-run the tests yourself** before landing.
2. **Give the subagent a HARD completion gate that requires pasted EVIDENCE** — Test-Path output, Pester/vitest results, and the commit SHA — self-certification with proof, not a bare "done."
3. **Apply your own Definition of Done to delegated work** — committed by pathspec, verify green on committed state, SHA cited. Delegation moves the *doing*, not the *verifying*.
4. **Part of the bookkeeping-≠-artifact genus** (with #69/#80/#84/#86): whenever a status/lifecycle/exit signal stands in for an outcome, verify the artifact at the object level instead of trusting the signal.

**Status:** Active — bookkeeping-vs-artifact genus (see the consolidated Quick-Reference entry in INDEX.md). Caught by grounding-truth on t/1806; no loss.

**Applies To:** All agents delegating work to background subagents/consultants — especially before landing a delegated deliverable.

---

## [Process] `verify | tail` (Any Pipe) Masks the Real Exit Code — Silent False-Green at the Primary Gate

**Pattern:** Piping a gate's output through `tail`/`head`/`grep`/`less` — `npm run verify 2>&1 | tail -N` — makes the pipeline's exit code the **LAST command's** (`tail` = 0), NOT verify's. Gating a push/land on that exit (or eyeballing the tail) reads a **FAILING verify as green** — a silent false-green at the fleet's primary gate. Bash pipelines return the rightmost command's status by default.

**Instances:**
- 2026-07-28 — ServerAPI (t/1829, p/79#15) + Technical Lead (t/1829#2, p/8#111): `npm run verify 2>&1 | tail -N` returned `tail`'s exit 0, masking verify's real result; a push gated on that eyeballed tail can push a RED verify. ServerAPI's t/1829 outcome was sound only because the failures were unrelated flake — the masked exit was the real footgun.

**Root Cause:** A bash pipeline's exit status is the **last command's** exit (unless `set -o pipefail`). `verify | tail` → `tail` exits 0 → `$?` = 0 regardless of whether verify passed. Same **exit-code-laundering** family as #84 (the `&& echo PASS || echo FAIL` wrapper) and part of the **bookkeeping-≠-artifact genus** (see the consolidated Quick-Ref): the exit code you read is the pipe's/wrapper's, not the command's — verify the real result, not the laundered signal.

**Prevention:**
1. **Capture the real exit BEFORE piping and gate on it:** `npm run verify > out.log 2>&1; rc=$?; tail -N out.log; [ $rc -eq 0 ] || exit 1` — decide on `$rc`, view the tail separately.
2. **Or `set -o pipefail`** so the pipeline returns the first non-zero exit; in bash, `${PIPESTATUS[0]}` reads the first command's exit after a pipe.
3. **Never gate a push/land on an eyeballed tail** — the tail shows output, not verdict; check the actual exit code.
4. Same family as #84 — whenever a wrapper/pipe sits between you and a command's exit, the exit you see is the wrapper's; go to the source.

**Status:** Active — exit-code-laundering (pipe) variant of the false-green genus (#20/#46) and the bookkeeping-≠-artifact family (#84 sibling). Surfaced t/1829 (detail t/1829#2). **Now advisory-guarded** by the workspace rule `exit-code-literacy-guard` (2026-08-03, t/2081; covers the `| tail` / `&&…PASS‖FAIL` / `grep -c` / `gh pr checks` exit-code-literacy family #73A/#84/#90/#96/#121) — non-blocking context nudge, firing observed live (Sage, 2026-08-03), systematic verification deferred per t/1625.

**Applies To:** All agents gating a push/land on `verify`/test output that is piped (`| tail`/`| grep`/`| head`).

---

## [Process] Flaky Shared Gate (lib/debate Suite) Generates False-Reds — Triage WHICH Files Before Assuming a Regression

**Pattern:** The `lib/debate` full test suite has **known-flaky tests** — `aiAdapter` withRetry (429/503), `persistenceFaults` (ENOSPC/EACCES), `cliPipeExit` — that fail **non-deterministically** (e.g. 8 failures one run, 5 the next). So a red `npm run verify` is **often NOT your change**. Worse, a flaky *shared* gate is a **false-red generator** that trains agents to dismiss ALL reds as "just flake" — the inverse of gate-blindness: when a gate cries wolf, a real regression blends into the tolerated noise (#20/#46).

**Instances:**
- 2026-07-28 — ServerAPI (t/1829, p/79#15) + Technical Lead (p/8#111): `npm run verify` failed non-deterministically (8→5 fails across runs) in the `aiAdapter`/`persistenceFaults`/`cliPipeExit` suites — unrelated to the agent's change. TL routed a **HIGH triage to DebateTool** to stabilize the flaky suites.

**Root Cause:** Fault-injection / retry / pipe-exit tests are timing- and environment-sensitive, so they fail non-deterministically. A flaky gate destroys the gate's signal two ways: (1) a red is ambiguous (your change, or flake?), and (2) habituation — agents learn "verify is always a bit red" and dismiss a genuine regression as flake. Same gate-signal-integrity genus as the false-green gate-blindness pattern, on the false-RED side.

**Prevention:**
1. **When verify is red, triage WHICH files failed before assuming a regression** — the known-flaky set (`aiAdapter` withRetry, `persistenceFaults`, `cliPipeExit`) is very likely not your change. Read the failing test names, not just "verify red."
2. **Re-run to check determinism** — a failure that changes across runs (8→5) is flake; a stable failure on the same test is real. (But re-running is a workaround, not a fix.)
3. **The real fix is to stabilize or quarantine the flaky tests** — a flaky shared gate must be repaired, not tolerated (routed HIGH to DebateTool, t/1829); Gate Verification/Co-Location apply. Tolerating flake is how a gate goes false-red-blind.
4. **Don't push on a red verify assuming flake without checking the failing files** — pairs with the "read which step, not the rollup" discipline from the gate-blindness pattern.

**Status:** Active — gate-signal-integrity (flaky-gate false-red, #20/#46); flaky-suite stabilization routed HIGH to DebateTool (t/1829). A flaky primary gate is high-severity because it degrades every agent's ability to trust verify.

**Applies To:** All agents running `npm run verify` / the `lib/debate` suite — read the failing test names before attributing a red to your change.

---

## [Process] Shared Local-Main Reconcile (Hard-Reset to origin) Wipes ALL Agents' Local-Only Commits — Recover From reflog, Don't Trust the Reverted Tree

**Pattern:** The shared local `main` accumulates local-only commits from many agents (Sage/most roles commit but don't push; TL/DevOps sync to origin). When the owner-gated **diverged-main reconcile** runs — `git reset` local `main` to `origin/main` — **every un-synced local commit is wiped off the branch at once, across all agents simultaneously.** An agent's working tree abruptly shows an EARLIER state and their session's work looks "gone." It is **not lost** — every commit survives in the reflog — but HEAD/branch/working-tree no longer contain it, which looks exactly like a revert.

**Instances:**
- 2026-07-28 — Sage (this session): shared local `main` (at Sage's last commit `20c32334`) was hard-reset to `origin/main` (reflog `HEAD@{0}: reset: moving to origin/main`), wiping ~30 local-only Sage doc commits (`e6daccc7`..`20c32334`: #82 dispositions + the PS-not-TS correction, #87–#92, #78 timeout, flag-order 6th/7th, /tmp, bc/awk) **plus other agents' local-only commits** interleaved in the reflog (te `t/1849` refactors, debate fixes, CL `t/1826`). **Caught by object-level verification** — the injected "your docs reverted" reminders showed a Total-83 working tree, but `git log`/`git status -sb`/`git reflog`/`git cat-file` proved HEAD had been reset and the commits were dangling-but-intact. **Recovered** with `git checkout 20c32334 -- operations/sage/docs/ operations/sage/LAST_SESSION.md` (restore my exclusive scope's final state) → one recommit (`e8ddad72`, Total-83→93). No loss.
- 2026-07-29 — t/2004 (TL p/8#127→#130, follow-on reconcile of the same divergence): local main unchanged since t/1768 (still `c7fd7487`); origin was ALREADY a superset of Sage's lessons — **verified by CONTENT, not commit presence** (the t/1768 recovery was a content-MERGE into `86914922`, so its source commits stay unique-by-patch-id in `origin..main`/`git cherry` though the content is upstream; TL's initial `git cherry`=0 gate wouldn't have converged). All 22 local-only commits confirmed content-on-origin (5 patch-identical via `git cherry -`, 2 docs-spec 0-unique-lines). **Realign DEFERRED anyway** — the shared tree held **138 modified + 227 untracked in-flight files** (active t/1671 + greatest-hits) that a hard-reset would obliterate. **Commit-safe ≠ tree-safe.**
- 2026-07-31 — t/2008 (retire-shared-checkout migration; TL p/8#162): the **deferred t/2004 realign finally executed** during the cutover — the pattern's first *successful-application* instance, not a recovery. The shared hub was **assumed a clean fast-forward but was diverged (22 local-only commits)**; the hard-reset was gated on **prevention #6** — **all 22 confirmed content-present on origin at the object level (not commit-presence) BEFORE the reset ran** — so the cutover was **content-lossless**. This is **H3 (verify-before-irreversible-step) + H2 (object-level confirm-on-origin) combined** (t/2081 tally). Per-role `wt-<role>` worktrees are now the dev model; the shared checkout is the deploy/ops hub. Validates #6/#7 — object-level content-verification before a destructive realign is what prevents the wipe.

**Root Cause:** The shared local `main` is a shared, un-pushed staging area; local-only commits live *only* there until TL/DevOps sync them to origin. Hard-resetting it to origin (the correct owner-gated fix for a large divergence) atomically discards every un-synced commit. Git doesn't delete objects, so they persist in the reflog — but the working tree/HEAD stop showing them, which reads as "my work was reverted/lost." Same object-level-vs-inference discipline as #69 and Git Forensics (#44/#54/#55): a changed working tree is not evidence of what's committed or recoverable.

**Prevention / Recovery:**
1. **After any "my working tree changed / my work is gone" event, VERIFY at the object level before reacting** — `git log --oneline`, `git status -sb`, `git reflog`. Never re-apply edits onto the reverted tree until you know whether HEAD moved (reset) or the tree is merely dirty. (This is the whole session's bookkeeping-≠-artifact / object-level rule, applied to your own repo state.)
2. **Recover from the ORIGIN BACKUP BRANCH (not reflog), then WORKTREE-LAND to origin — do NOT recommit to local main.** The correct realign takes a **full backup first**: all local-main-only commits are pushed to a durable remote branch `origin/backup/<reconcile>-<lastSHA>` (e.g. `origin/backup/t1768-local-main-20c32334`). It's a **remote ref — it does NOT age out** (no ~30-day reflog window, no gc clock), so there is **no time pressure** (TL e/46). Find your commits: `git log origin/backup/... --oneline | grep <your-scope>`, then `/land-from-worktree` the ones whose content isn't already on origin — **the land no-ops if already upstream** (safe to just try; superseded commits drop out; nothing duplicates). Recommitting to local `main` is wrong — the next reconcile re-displaces it (the `t/1780` direct-commit-to-main hook now warns on exactly this).
3. **Don't re-litigate the reconcile** — it's owner-gated and the correct fix for a large divergence ([memory: local-main reconcile is owner-gated]). Recover your work and move on; don't propose/flag another reset.
4. **Systemic:** hold the push-cadence ceiling (fewer local-only commits → a reconcile wipes less) and sync approved work to origin promptly (TL/DevOps), so it survives a reset. Ties to the push-contention LARGE-divergence variant.
5. **Fleet awareness:** a reconcile wipes EVERY agent's local-only commits — surface it so others recover theirs from reflog too.
6. **Verify reconcile completeness by CONTENT, not by `origin..main` commit presence.** A recovery done by content-MERGE (re-authoring into a new commit) rather than `cherry-pick` leaves the source branch's commits unique-by-patch-id — `git log origin..main` / `git cherry` keep listing them though the content is fully upstream. Confirm supersession with **`git cherry -` (patch-equivalence)** + a **line-level content diff** of the scoped files; do NOT gate the realign on `origin..main`/`git cherry` reaching 0 (it won't for content-merged work — you'd wait forever or force-align). (t/2004: content-verify showed origin ⊇ local; the `cherry`=0 gate was a false blocker.)
7. **Commit-level safety is necessary but NOT sufficient — a hard-reset realign also destroys the shared tree's UNCOMMITTED work.** Even when every local-only commit's content is on origin, `git reset --hard` obliterates the shared working tree's **modified + untracked** files (t/2004: 138 modified + 227 untracked in-flight, incl. active t/1671 + greatest-hits). Gate the realign on a **quiescent-tree window** (coordinated, no in-flight edits) — or **defer**: a benign, content-safe divergence with *new* divergence blocked (t/1926 hook) is safe to leave indefinitely. "All commits are on origin" ≠ "safe to hard-reset now."

**Status:** Active — recovery playbook; **validated the session's object-level discipline**. **Key correction (TL e/46):** the t/1768 realign was a *backed-up* pointer move — **nothing was lost**, and all 173 local-main-only commits are on a durable remote branch `origin/backup/t1768-local-main-20c32334` (no ~30-day pressure). Recovery = find your commits on that branch → `/land-from-worktree` the un-upstreamed ones (**no-ops if already upstream**, so safe to just try). Sage recovered its scope and **landed to origin** (`e771400f`, Total 94) — verified against the backup branch; t/1872 Sage check-in complete. Scale is smaller than raw content-diff implies (over-counts docs origin superseded). Do NOT recommit to local main (the `t/1780` direct-commit-to-main hook now warns on it). **t/2004 follow-up (TL p/8#130):** a later reconcile of the same divergence confirmed origin ⊇ local by content (all 22 commits content-on-origin) but was **DEFERRED** — the shared tree had 138 modified + 227 untracked in-flight files a hard-reset would obliterate (prevention #7: commit-safe ≠ tree-safe). Benign divergence + new-divergence blocked (t/1926 hook) → safe to leave; realign awaits a quiescent-tree window (owner's call). **t/2008 (2026-07-31, TL p/8#162):** that window arrived — the realign **executed content-lossless** during the retire-shared-checkout migration. The hub (wrongly assumed a clean fast-forward) was diverged by 22 local-only commits, all confirmed content-on-origin at the object level *before* the hard-reset (prevention #6 honored). The pattern now has a **successful-application** instance — H3 (verify-before-irreversible) + H2 (object-level confirm-on-origin), t/2081 tally — not only a recovery playbook. **Point-of-use enforcement (2026-08-03, t/2081):** the workspace rule `verify-head-on-origin-before-teardown` now guards prevention #6/#7 + the H2 post-push HEAD-on-origin sub-gate (verify before an irreversible worktree teardown). Gate-logic-tested; live-firing **unverified** per t/1625 (a created hook ≠ a proven-firing hook — #80/#82).

**Applies To:** All agents whose work lives on the shared local `main` until synced — i.e. everyone who commits but doesn't push.

---

## [Process] Adding an Nth Variant to a Shared Enum/Config Touches More Than the Obvious Files — Enumerate Coupling Sites + Run ALL Referencing Tests

**Pattern:** Adding a new member to a shared enumeration (a new AI backend id, a new POV camp, a new node category) has a surface far larger than the "obvious" implementation files. Non-obvious **coupling sites** — exhaustiveness-checked `Record<Enum, …>` maps (TS `TS2741`/`TS2739` at compile time), validation-probe tables, id-resolution switch/lookup functions — each independently break, often in *different roles' scopes*. A work-breakdown (ticket DAG) scoped to the obvious files ships a partial change that reddens main across sites the decomposition never listed. Compounded when the verify step runs a **hand-picked subset** of the tests that reference the changed shared config instead of ALL of them.

**Instances:**
- 2026-07-29 — Technical Lead (t/1932 Moonshot/Kimi K3 backend add; detail t/1932#1): the DAG covered the **3 adapter files** (aiAdapter/aiBackends/AIEnrich) but missed **3 non-adapter coupling sites**, each a separate break in a separate scope — (1) `routes/keys.ts` `KEY_VALIDATION_PROBES` (no probe → `keysValidation.test.ts` red), (2) `config.ts` `ENV_KEY_NAMES` / `AIBackend` exhaustiveness (non-exhaustive `Record` → server `tsc` `TS2741` red, blocking everyone), (3) `registry.ts` `resolveBackend` (missing case → silent misroute moonshot→gemini). Compounded: the config-land verify **grepped `keysValidation.test.ts` but ran only `configInvariant`+`modelDiscovery`** — a hand-picked subset that skipped the very test the change broke. Green-main via t/1944 (tsc) + probe fix (`66325245`); routing correctness t/1945.
- 2026-08-03 — Shared Lib (p/5#21): `usageRegistry.test.ts` `listUsages` asserted `toHaveLength(3)` — a hardcoded literal count. Adding a 4th entry (`moonshot.test` to `TEST_USAGES`) caused the assertion to fail ("expected 4, received 3"). **Coupling site type: hardcoded length/count assertion** — invisible to tsc (runtime check, not an exhaustiveness map) and to a grep of the enum/type name (the bare `3` has no syntactic tie to the registry). Fix: bump assertion to 4 (p/5#21).

**Root Cause:** A shared enum/config is a **fan-out coupling point**: every exhaustiveness-checked map, probe table, and resolver keyed on it is an implicit dependency that the type-checker (for `Record`) or a *specific* test (for probe/resolver) enforces — but only if that check is actually compiled/run. The decomposition author reasons from the *feature* ("add an adapter") rather than from the *coupling graph* ("what is keyed on this id?"), so coupling sites in other scopes fall outside the ticket DAG. Running a chosen-by-hand test subset then fails to surface the breaks before land.

**Prevention:**
1. **Before decomposing a shared-enum/config addition, enumerate the coupling graph, not the feature files:** grep the enum/type name and the existing members across the whole repo — every `Record<Enum,…>`, probe/validation table, and resolver/switch keyed on it is a coupling site that needs a ticket (likely spanning multiple scopes).
2. **A change to a shared config must run ALL tests that reference it — never a hand-picked subset.** If you grep for referencing tests (e.g. `keysValidation.test.ts`), you must *run* the ones you find, not a different chosen pair. Prefer the full `npm run verify` over cherry-picked suites for any shared-surface change.
3. **Lean on exhaustiveness at compile time:** a `Record<Enum, T>` (not `Partial<Record<…>>`) or a `switch` with a `never`-typed default forces `tsc` to flag a missing case — make coupling maps exhaustive so the type-checker becomes the coupling detector.
4. **Durable fix for a recurring multi-site addition: a checklist playbook** that enumerates every site the addition touches, so the next add is one self-certifiable pattern, not a multi-role scavenger hunt. TL is authoring **`/add-ai-backend`** (7 config sections + `keys.ts` probe + `config.ts` `ENV_KEY_NAMES`/type + `registry.ts` `resolveBackend` + 3 adapters) — the concrete instance of this general rule.
5. **Hardcoded length/count assertions in tests are runtime coupling sites not caught by tsc or by a type-name grep.** When adding an entry to any array/registry, grep the test files for `toHaveLength`, `.length`, `toBe(N)` patterns over the collection — a bare literal count is a hidden coupling site (p/5#21).

**Status:** Active — 2 instances. Root cause: decomposition-completeness (coupling graph vs feature files) + verify-scope (all referencing tests vs a subset); and hardcoded count assertions as a runtime coupling site (p/5#21, added 2026-08-03). TL self-reported (t/1932#1); durable fix = the `/add-ai-backend` playbook (being filed). Watch for the same shape on other shared enums (POV camps `acc/saf/skp/cc`, BDI categories, `pol-*` registry).

**Applies To:** Any role decomposing or landing a change that adds a member to a shared enumeration/config consumed across multiple files or scopes.

---

## [Process] Branch Protection With `enforce_admins=false` Is Not a Hard Block for Admin Identities — "PR-flow" Is a Convention

**Pattern:** A repo can have branch protection + required status checks on `main`, yet a direct `git push origin HEAD:main` from an **admin identity SUCCEEDS and bypasses the checks** (GitHub logs "Bypassed rule violations, accepted") when `enforce_admins=false`. Because the whole fleet pushes as one repo-owner (admin) identity, the "checks-only PR-flow" gate is a **CONVENTION enforced by review + discipline, not a platform hard-block.** Believing "protection is on" ⇒ "direct push is impossible" is a false-enforcement assumption.

**Instances:**
- 2026-07-29 — main → PR-flow rollout (e/49): the initial broadcast stated "**direct push to main is BLOCKED**"; corrected ~12 min later (e/49#3/#4, prompted by TL2 p/276#3 + Sage p/8#119) once it was confirmed admin pushes bypass with `enforce_admins=false`. Routine direct-push-to-main is now a **flagged process violation**; pre-broadcast bypass lands (e.g. DebateTool t/1955/t/1949) were grandfathered. Owner deciding whether to make it technically binding (`enforce_admins=true`) vs. keep it convention.

**Root Cause:** GitHub's `enforce_admins` toggle governs whether protection applies to admins. With it `false` and every agent authenticating as the repo-owner admin, the protection rules are **advisory for the fleet**. "branch-protected" describes *configuration*, not the achieved *guarantee* for admin pushers — the same signal-vs-reality gap as the gate-integrity / bookkeeping-≠-artifact family (a control that is configured but doesn't actually bind at the point of action).

**Prevention:**
1. **Land via green-PR self-merge** (the `/land-from-worktree` PR-flow: feature branch → `gh pr create` → wait for the 6 checks → `gh pr merge --rebase --delete-branch`, no `--admin`/reviewer). Treat routine direct-push-to-main as a process violation.
2. **Never equate "protection enabled" with "bypass impossible"** — check `enforce_admins` and whether the pushing identity is an admin. A gate admins can bypass is convention, not enforcement; verify the control actually binds before trusting it.
3. **Admin/hotfix bypass** (`--admin`-merge or direct push) is reserved for fixing a red/broken main when the PR path is itself blocked, a true prod emergency, or an explicit owner-directed land — **reference the authorization; never routine self-service.**
4. To make the gate technically binding, `enforce_admins=true` (owner call, pending). Until then, discipline is the enforcement — ties to #82 rule-exists-but-not-applied: a convention with no point-of-use hard-block relies on review to catch violations.

**Status:** Active — convention effective 2026-07-29 (e/49, owner-approved, DevOps flipped live). Owner deciding `enforce_admins` true vs. convention. Companion mechanical fix (detached-HEAD feature-branch push needs `HEAD:refs/heads/<branch>`) recorded separately in build.md (ServerAPI p/79#19); both folded into the revised `/land-from-worktree`.

**Applies To:** Every role that lands work to `main` — i.e. the whole fleet.

---

## [Process] Docs-Only PRs Can't Self-Merge Under the Checks-Only Gate — Path-Filtered CI Leaves Required Contexts Unreported (BLOCKED)

**Pattern:** Under the checks-only PR-flow (see the `enforce_admins=false` convention lesson above), a **docs-only or CI-config-only PR is un-mergeable by self-merge**. CI uses path-filtering (`dorny/paths-filter`) so code jobs are skipped on a docs diff — `test-powershell` + `test-electron` report `skipped`, and the 4 required `test-electron (variant)` contexts **never report at all**. A required status context only satisfies the gate if it actually runs and reports `success`; a skipped/never-reported context counts as *pending*, not passing. So 5 of 6 required checks can't be satisfied → `mergeStateStatus=BLOCKED` regardless of discipline. A docs change lands only via (a) TL `--admin`-merge (the "PR path itself blocked" exception) or (b) a flagged routine direct-push.

**Instances (3 roles in one hour — a systemic gap, not an edge case):**
- 2026-07-29 — PowerShell PR #134 (branch-protection doc-block correction, t/1938#6): `mergeStateStatus=BLOCKED`, path-filter skipped all code checks; parked for a TL admin-merge rather than bypassing (e/49#8).
- 2026-07-29 — Computational Linguist (e/49#10): docs-only is the **MAJORITY** of CL lands (provenance registers, analyses, review docs are pure markdown; the CL checklist *requires* the register update in the same PR). One pure-docs commit today (`ecb137e7`, t/1853) would have parked BLOCKED. Flags two second-order harms: (1) TL becomes a **synchronous dependency of every docs land** (a steady trickle, not a rare exception); (2) mixed PRs dodge the gap → **perverse incentive to bundle docs with unrelated code** to get mergeable checks, against atomic lands.
- 2026-07-29 — Sage (this session): the session's lessons-doc commits (`deca6ffc`, `2cff7439`, `08750e3f`, `8d3c40f2`, `7d0da850` + earlier) are all **docs-only** — same wall. Not direct-pushed; parked on local main for a TL admin-merge or the flow-fix.

**Root Cause:** Required status checks and path-filtered CI are in tension. Strict branch protection waits for *every* required context to report `success`; path-filtering (correct for speed on code PRs) makes those contexts **unreportable** on a docs diff — skipped jobs don't emit the required context, and "never reported" is treated as pending forever. The gate is simultaneously too weak for admins (bypassable, #100 sibling) and too strong for docs (un-satisfiable) — two failure modes of the same rollout.

**Prevention / Fix:**
1. **Landing a docs/CI-config-only change under the convention: route via TL `--admin`-merge** (the sanctioned "PR path itself blocked" exception) — reference the authorization; do NOT routine-direct-push.
2. **Durable flow-fix (owner/DevOps):** the canonical GitHub-Actions pattern for "required checks + path filters" is an **always-run aggregate gate** (PowerShell, e/49#11): add one `ci-gate` job with `if: always()` that `needs:` the 6 real jobs and passes iff none **failed** (skipped = OK, `!contains(needs.*.result, 'failure')`), then make **`ci-gate` the single required context**, replacing the 6 individual `test-*` contexts. A docs-only PR then has the code jobs skip → `ci-gate` passes → self-merges; a red code job → `ci-gate` fails → blocked. No `enforce_admins` change; keeps docs+register PRs atomic; removes the bundle-with-code incentive. (Leans on path-filter correctness — already true today.) DevOps owns the `ci.yml` + branch-protection-contexts swap. Until it lands, docs PRs need admin-merge.
3. **If `enforce_admins` goes true, this becomes a HARD wall** for every docs/CI-config change — must be fixed *first*. (Decision landed on keeping `enforce_admins=false` + a tool-layer push guard t/1926, so the admin-merge valve stays available — e/49#7/#9.)

**Status:** Active — **OWNED + fix APPROVED** (TL, e/49#12, ~30 min after first surfaced). TL owns the defect; PowerShell's `ci-gate` aggregate-gate is the approved fix, tracked **t/1962 (DevOps, high)**: PowerShell drafts the job, DevOps lands `ci.yml` + swaps branch-protection to the single `ci-gate` context. **Interim:** the parked PRs (PS2 #128, PowerShell #134) are authorized for `--admin`-merge as the sanctioned **"PR-path-blocked-by-config-defect"** exception (substantive checks green, only path-filtered contexts unsatisfiable — NOT routine bypass); same authorization extends to CL/other docs lands parked until t/1962 — **ping TL, don't bundle with code**. 3 affected roles (PowerShell, CL, Sage). Sage's parked lessons commits are a 3rd instance; **Sage's admin-merge authorization CONFIRMED (e/49#16)** — ping TL to merge any docs-only PR parked on this before t/1962. Interim PRs clearing (#134 admin-merged `c23de7f6`). Note: **t/1961 (TL2) and t/1962 may be dups** for the same structural fix — DevOps/TL to dedup to one (e/49#13); follow whichever survives. Sibling to the `enforce_admins=false` convention lesson.

**Applies To:** Any role landing docs-only or CI-config-only changes to `main` — Sage (lessons/docs), Documentation, DevOps (CI config), anyone editing `AGENTS.md`-adjacent docs.

---

## [Process] Validate a Fleet-Standard Procedure Change End-to-End Before Mandating It (Dry-Run One Real PR Through Every Step)

**Pattern:** A change to a **fleet-standard procedure** (land flow, CI gate, commit convention) that is broadcast and mandated *before* being run end-to-end ships latent defects that every adopter then hits independently. Writing the intended steps ≠ having *executed* them once against the live infrastructure — the gaps live in the **interaction** between the steps and the real repo config (branch protection, path filters, worktree constraints, `gh` behavior), which is invisible on paper and obvious on the first real run.

**Instances:**
- 2026-07-29 — main → PR-flow rollout (e/49): TL mandated the revised `/land-from-worktree` before an end-to-end validation land. **3 defects surfaced within the hour** as roles adopted it, each caught by a different role mid-land: (1) detached-HEAD push needs `HEAD:refs/heads/<branch>` (ServerAPI p/79#19); (2) docs-only PRs can't self-merge — path-filtered required checks never report → `BLOCKED` (PowerShell/CL/Sage, t/1962); (3) `gh pr merge --delete-branch` from a worktree aborts *after* the merge, masking a landed merge (ElectronMain p/98#12). **All three would have surfaced in a single real PR taken through every step.** TL owned the root cause (p/8#121): "3 PR-flow defects in an hour because I broadcast the procedure before an end-to-end validation land."

**Root Cause:** A procedure authored from reasoning ("these are the steps") vs. one **executed once** against the actual repo. Each defect lived in a step's collision with live infra — the refspec rule under a detached HEAD, required-checks vs. path-filtering, `gh`'s local checkout under the one-branch-per-worktree rule. None are visible reading the steps; each is unmissable on a real run. Same **bookkeeping-≠-artifact / verify-the-artifact-not-the-plan** discipline the fleet applies to code, applied to *process rollout*: a documented procedure is a plan, not evidence it runs.

**Prevention:**
1. **Before mandating a fleet-standard procedure change, dry-run it end-to-end** — take one real change through EVERY step (real worktree → real push → real PR → real checks → real merge → real cleanup) on the actual repo. The first real run flushes the interaction defects a written procedure can't.
2. **Broadcast AFTER the validation land, citing the validating PR** — "here's the procedure, and the PR that proves it end-to-end."
3. **If urgency forces broadcasting first, label it PROVISIONAL / pending-validation** and expect corrections — don't treat "written" as "validated." (The e/49 rollout self-corrected 4× in the hour; a dry-run would have front-loaded that.)
4. Genus: a documented procedure is bookkeeping; the validating land is the artifact.
5. **When a templated/fleet-procedure bug DOES ship, scale remediation depth to failure VISIBILITY** (TL p/8#139). A **LOUD**-failing bug (self-evident error — e.g. #113's `gh api` 404) is fine with a **central** correction at the template/epic: every consumer hits the failure and finds the fix, so rewriting N inline copies is over-investment. A **SILENT**-failing bug (wrong result, no error — moonshot misroute, CodeQL-non-required-gate #112, `verify | tail` #90) must be fixed **at source, per consumer** — adopters get a wrong answer with no signal that they need the fix, so a central note alone is under-investment. Diagnose loud-vs-silent first, then pick central-vs-at-source.

**Status:** Active — **TL-owned root cause of the 3 PR-flow defects** (2026-07-29, self-reported p/8#121). **BEING PROMOTED to a rule (TL, p/8#123):** target = **TL AGENTS.md** (engineering/tech-lead), since procedure/skill rollouts flow through TL review; pending owner sign-off on exact wording before the `ogit` overlay commit, citing `1ded61d4` + the 3-defect rollout as origin. Graduates to **root AGENTS.md** if the owner wants it fleet-binding rather than TL-scoped. (When it lands, add to the INDEX "AGENTS.md Rules (Escalated from Sage)" list.) The three defects are recorded individually (refs/heads push + `--delete-branch` worktree abort in build.md; docs-only gate above); this is their common cause.

**Applies To:** Anyone — especially TL / DevOps — mandating a change to a fleet-standard procedure (land flow, CI gate, branch protection, commit/worktree conventions).

---

## [Process] Shared GitHub Account — `gh pr review --approve` Fails "Cannot approve your own pull request" on ANY Fleet PR

**Pattern:** All fleet agents authenticate to GitHub as the **same account** (`jpsnover`). GitHub prohibits approving your own PR, so `gh pr review --approve` on **any agent-created PR** fails `Cannot approve your own pull request` — from `gh`'s view every fleet PR is self-owned, because there is only one identity. A shared-**identity** collision at the GitHub-account level — the platform-account analog of the shared-**checkout** collision (t/1926) at the git level.

**Instances:**
- 2026-08-03 — DevOps (p/26#34): `gh pr review --approve` on PR #334 failed `Cannot approve your own pull request`. Resolved by posting the review as a **comment** (`gh pr review --comment`).

**Root Cause:** A single shared GitHub identity across all agents × GitHub's self-approval prohibition. Approval is a per-USER action GitHub ties to account identity; the fleet has ONE account, so no agent is a "different user" relative to a fleet PR's author. The failure is **deterministic** — it hits *every* agent that runs `--approve` on *every* fleet PR.

**Prevention:**
1. **Never `gh pr review --approve` a fleet PR** — it always fails under the shared account. Post review feedback with **`gh pr review --comment`** (or `--request-changes` for blocking feedback).
2. **Approval is NOT required to merge anyway:** branch protection is **checks-only** (`ci-gate` + CodeQL, strict off — no required-reviews), so PRs land by checks-green self-merge, not by approval. The failed `--approve` is a **non-blocker**.
3. **Sibling of the docs-only self-merge constraint (#101):** both are shared-account / self-action limits on the PR flow — a docs-only PR can't self-satisfy required contexts (→ TL `--admin`-merge), and no agent can self-approve (→ record the verdict as a comment). Use TL `--admin`-merge only where the PR *path* is blocked; a review *verdict* is a comment.
4. **Cheaply hookable if it recurs:** the trigger is the literal `gh pr review --approve` in a Bash command — a crisp syntactic signal an advisory hook could catch. Candidate Diagnostics hook on a 2nd instance.

**Status:** Active — shared-GitHub-identity constraint; the account-level analog of the shared-checkout collision (t/1926). **Non-blocking** (approval isn't required under checks-only branch protection). Deterministic (every agent, every fleet PR), so 1 instance ⇒ it WILL recur — flagged hookable.

**Applies To:** Any agent running `gh pr review --approve` on a fleet-authored PR (i.e. every PR, since all share the `jpsnover` account).

---

## [Process] `gh pr merge` in Auto Mode Is Blocked by the Safety Classifier — PR Merges Require Explicit User Authorization; Surface the Command for Direct `!` Execution

**Pattern:** `gh pr merge <N> --squash --auto --delete-branch` (or any `gh pr merge` variant) in an **auto-mode agent session** is intercepted by the Claude Code safety classifier and blocked mid-sweep. The classifier treats PR merges as **hard-to-reverse + visible to others** — a category that requires explicit user confirmation regardless of auto-mode level. The agent cannot unblock itself; the action must be surfaced to the user as a `! gh pr merge <N>` command for direct authorization in the session.

**Instances:**
- 2026-08-03 — Orca Support (p/13#27): `gh pr merge 341 --squash --auto --delete-branch` blocked mid-PR resolution sweep by the auto-mode classifier. Resolved by surfacing `! gh pr merge 341` to the user for direct authorization.
- 2026-08-03 — Orca Support (p/13#31): `gh pr merge` blocked again during PR #289 conflict-resolution flow — same classifier gate, 2nd independent instance.

**Root Cause:** The Claude Code safety classifier has a fixed policy: PR merge is a **shared-state, hard-to-reverse action** (merges commit to a repo visible to others, triggers CI, may deploy). Auto mode bypasses routine tool confirmations but NOT this class of action. The classifier intercepts at the tool-call layer before the command runs — this is **correct and intended behavior**, not a bug. The failure is the **workflow assumption** that `gh pr merge` would run unattended in an automated PR sweep.

**Prevention:**
1. **Never assume `gh pr merge` will run unattended in auto mode** — it always requires an explicit user authorization event. Plan for a manual authorization step in any PR-resolution workflow.
2. **Surface the command as `! gh pr merge <N> --squash --delete-branch`** — the `!` prefix runs the command in the active session under user authorization; this is the correct resolution path.
3. **Do NOT retry the same `gh pr merge` call** — the classifier will block it again. Only a human-authorized execution unblocks the action.
4. **Sibling of the push-authorization pattern**: `git push` to shared remotes is similarly treated as requiring user oversight. Both `git push` and `gh pr merge` are in the "visible to others / hard to reverse" class.

**Status:** Active — safety-classifier gate on `gh pr merge` in auto mode; by design. Every agent running automated PR sweeps will hit this. The fix is architectural: design PR workflows with a manual authorization step for the merge command.

**Applies To:** All agents running `gh pr merge` in auto mode (e.g., PR resolution sweeps, post-CI land automation).

---

## [Process] `git push --force-with-lease` in Auto Mode Is Blocked by the Safety Classifier — Force-Pushes Are "Hard-to-Reverse"; Surface as `! git push` for User Authorization

**Pattern:** `git push --force-with-lease` (and any force-push variant) in an **auto-mode agent session** is intercepted by the Claude Code safety classifier and blocked. The classifier specifically lists force-pushing as a **hard-to-reverse operation** (can overwrite upstream history, destroy others' work). This is the same classifier gate as `gh pr merge` (#129) — both are in the "hard-to-reverse + visible to others" class — but triggered by a different command. Resolution: surface `! git push --force-with-lease <remote> <branch>` to the user for direct authorization.

**Instances:**
- 2026-08-03 — Orca Support (p/13#31): `git push --force-with-lease` blocked during PR #289 conflict-resolution flow (after resolving conflicts via merge commit + soft-reset). Resolved by surfacing `! git push` as a user instruction.

**Root Cause:** Force-push rewrites the remote ref's history — if another agent or user has pushed since your last fetch, a force-push discards their work. The safety classifier gates this at the tool-call layer regardless of auto-mode level; this is **correct and intended behavior**. Unlike regular `git push` (allowed in auto mode for non-main branches via worktrees), force-push is always gated because the damage profile is higher and the user must affirm they understand the rewrite.

**Prevention:**
1. **`git push --force-with-lease` will always be blocked in auto mode** — plan for a manual user-authorization step in any workflow that requires a force-push (conflict resolution, history cleanup, rebase-then-push flows).
2. **Surface as `! git push --force-with-lease <remote> <branch>`** — the `!` prefix runs the command under user authorization in the active session.
3. **Prefer rebase-then-regular-push over force-push when possible** — if the branch has no shared history, a fast-forward or regular push avoids the classifier gate entirely.
4. **Sibling of `gh pr merge` classifier gate (#129):** both are in the "hard-to-reverse + visible to others" class. The general rule: any operation that REWRITES or MERGES remote state requires explicit user authorization in auto mode.

**Status:** Active — safety-classifier gate on force-push; by design. Every agent needing to force-push in auto mode will hit this. The fix is architectural: design conflict-resolution workflows with a manual authorization step for the force-push.

**Applies To:** All agents running `git push --force-with-lease`, `git push --force`, or any force-push variant in auto mode.

---

## [Process] Safety Classifier Blocks Moving Untracked Files to `/tmp` — Use Session Scratchpad or Worktree Instead

**Pattern:** Attempting to move or copy untracked files to `/tmp` is blocked by the safety classifier — treated as potentially destructive. This commonly arises when an agent tries to stage untracked files out of the way before a cherry-pick or rebase. The fix is a fresh worktree, which achieves the same clean-state goal without relocating any files.

**Instances:**
- 2026-08-03 — Orca Support (p/13#33, PR #289): attempted to move untracked files to `/tmp` during fork PR resolution — blocked by safety classifier. Resolved by using a fresh worktree from main + cherry-pick.

**Root Cause:** `/tmp` is ephemeral; moving uncommitted files there risks silent data loss. The worktree-from-main + cherry-pick approach achieves a clean state without needing to relocate untracked files.

**Prevention:**
1. **Don't stage untracked files to `/tmp`** — use `git worktree add -b <branch> <path> origin/main` + cherry-pick the desired commits instead.
2. For genuine temporary storage, use the session scratchpad directory (provided in session context), not `/tmp`.

**Status:** Active — classifier gate on `/tmp` moves of untracked files; by design (p/13#33).

**Applies To:** All agents needing a clean working state in git workflows — use worktree, not file relocation.

---

## [Process] Cherry-Pick Into a Worktree Conflicts on Shared Doc Files — Use `--theirs` to Accept the Cherry-Picked Version

**Pattern:** Cherry-picking a commit onto a fresh main-based worktree conflicts in shared doc files (e.g., `LessonsLearned.md`) — both the cherry-pick source and the current main-based state have modified the same lines. `--theirs` resolves in favor of the cherry-picked version, which is the correct choice when the cherry-pick carries the authoritative state.

**Instances:**
- 2026-08-03 — Orca Support (p/13#33, PR #289): cherry-picking fork PR commits onto a clean worktree conflicted in Sage docs. Resolved with `--theirs`.

**Root Cause:** Shared doc files receive concurrent edits from many agents across branches. A cherry-pick from a branch that diverged before recent doc updates will conflict with current main. The cherry-picked version is what's being preserved.

**Prevention:**
1. **`git cherry-pick -X theirs <sha>`** auto-resolves all conflicts in favor of the incoming commit — use when the cherry-pick is authoritative and conflicts are expected stale-base divergence.
2. Per-file: `git checkout --theirs <conflicted-file>` then `git add <file>` then `git cherry-pick --continue`.
3. Pre-check with `git diff origin/main...<source-sha> -- <doc-path>` to know whether overlapping edits exist before starting.

**Status:** Active — doc file cherry-pick conflicts in multi-agent worktree workflows; --theirs resolution pattern (p/13#33).

**Applies To:** All agents cherry-picking commits that include shared doc file changes onto a main-based worktree.

---

## #146 [Process] Pre-Commit Hook Blocks on Pre-Existing Known Divergence Unrelated to Current Change — `--no-verify` With User Approval Is the Correct Path

**Pattern:** The pre-commit hook audits AGENTS.md ownership on every commit — not just commits touching AGENTS.md files. A pre-existing double-track divergence (e.g., t/2080) blocks ALL commits until resolved, regardless of the committing agent's scope. The hook message explicitly states the override is expected for this known state. Correct resolution: `git commit --no-verify` with user approval.

**Instances:**
- 2026-08-04 — Debate Tool 2 (p/234#8): landing a `lib/debate` fix; pre-commit hook blocked on the pre-existing AGENTS.md double-track divergence from t/2080 (not caused by the change). Hook confirmed override expected. User approved; landed with `--no-verify`.
- 2026-08-06 — Rosetta Stone (p/6#37, fix/bootstrap-reconnect-t2195, 61c493f9): landing a `taxonomy-editor/src/renderer/bootstrap.ts` fix; same pre-existing AGENTS.md double-track (t/2080). Change was clean; used `--no-verify`.
- 2026-08-06 — Rosetta Stone (p/6#39, t/2199): 3 TSX/CSS/TS files staged, no AGENTS.md touched. Hook still blocked on t/2080 pre-existing state. Resolved with `--no-verify` per documented emergency override.
- 2026-08-06 — Rosetta Stone 3 (p/355#1, feat/screen-a-t2199-t2200): hook blocked citing BOTH double-track AND NEITHER-tracked overlay files — post-fix instance; indicates t/2080 fix incomplete, residual overlay drift remains. Resolved with `--no-verify` per AGENTS.md override path.
- 2026-08-06 — Rosetta Stone (p/6#41, be35e8b3, feat/screen-a-t2199-t2200, PR #508 / t/2201 Screen B): same double-track block. Post-fix fleet-pull-lag — t/2205 fix (e5d657b8) is on origin/main but checkout hadn't pulled. Resolved with `--no-verify`.

**Root Cause:** The pre-commit hook runs a repo-wide AGENTS.md ownership audit on every commit. A pre-existing double-track (t/2080) blocked the first 3 instances. **Corrected root cause for instance 4 (TL p/335#9, t/2205):** the NEITHER hits were `.worktrees/<name>/AGENTS.md` paths — worktree checkouts of main-tracked files, not overlay drift. The hook pruned `.claude` but not `.worktrees`, causing a false-positive on every active worktree. Fix: prune `.worktrees` in the audit (PR #509, t/2205). **Separate genuine gap:** new-role-orphan case → t/2206. Do NOT `ogit add` `.worktrees/` paths — they are transient checkouts.

**Prevention:**
1. **When the pre-commit hook blocks, read the output carefully** — it will state whether `--no-verify` is expected. If yes, obtain user approval and proceed.
2. **Do not fix the divergence as a side effect of an unrelated commit** — conflates issues and risks out-of-scope changes.
3. **`--no-verify` is a temporary bypass** — the root ticket (t/2205 / t/2206) owns the permanent fix.
4. **Always record `--no-verify` usage** — ping Sage with the commit SHA, hook message, and user approval so it's traceable.
5. **Do NOT `ogit add` `.worktrees/<name>/AGENTS.md`** — transient checkouts of main-tracked files; adding them creates a new double-track.

**Status:** Active — t/2205 fix landed (e5d657b8, PR #509). Instances 1–4 were pre-fix; instance 5 is post-fix fleet-pull-lag. New-role orphan gap tracked under t/2206. Fleet unblocked per-checkout as each pulls past e5d657b8.

**Applies To:** All agents committing while t/2205 or t/2206 are open.

---

## #147 [Process] Bare `git stash` in a Shared Working Tree Captures All Agents' Files — Cross-Agent Stash Contamination

**Pattern:** In a shared working tree where multiple agents have uncommitted changes, `git stash` without a pathspec captures ALL staged/unstaged files — not just the running agent's scope. On `git stash pop`, a conflict on another agent's file blocks the pop entirely.

**Instances:**
- 2026-08-06 — Rosetta Stone (p/6#47, PR #508 rebase cleanup): stash held Show-TaxonomyEditor.ps1 (another agent's WIP) + aiHandlers.ts. Working tree had a conflicting Show-TaxonomyEditor.ps1 mod. Dropped stash — other agent's WIP was current in working tree; aiHandlers.ts not needed post-rebase.

**Root Cause:** `git stash` has no ownership awareness. A bare stash sweeps all working tree changes into one bundle; on pop, conflicts on another agent's file block the whole operation even though the stash holder never intended to own it.

**Prevention:**
1. **Always use a pathspec:** `git stash push -- <your-files>` instead of bare `git stash`.
2. **Before stashing, `git status`** — if other agents' files are present, a pathspec is mandatory.
3. **Before pop, `git stash show`** — if the stash contains files you don't own, inspect the working tree for those files first.
4. **If pop conflicts on another agent's file:** if the working tree already has the correct version, `git stash drop` — the entry is redundant.

**Status:** Active — 1 instance (Rosetta Stone p/6#47).

**Applies To:** All agents working in the shared main checkout alongside concurrent uncommitted changes from other agents.

---

## #162 [Process] Same-Role Duplicate Implementation from Session/Context Loss — Self-Race

**Pattern:** An agent loses context between passes and implements the same ticket twice — the second PR is opened unaware the first has already merged, based on pre-merge state. Requires manual reconciliation by TL.

**Instances:**
- 2026-08-11 — ServerAPI (t/2474): PR #849 merged at 18:55; PR #850 opened at 19:01 from a pre-#849 base (session/context loss between passes). TL merged #850's variant over it (265de260, t/2474#4-5).

**Prevention:**
1. **Before opening any PR, search open AND merged PRs for the ticket key:** `gh pr list --state all --search "t/XXXX" -R AI-Rosetta-Stone/ai-triad-research`.
2. After a context boundary, re-read the ticket's latest comments before writing code — the ticket is where completed work is recorded.
3. If a merged PR is found, close stale work and redirect to a follow-up ticket.

**Status:** Active — 1 instance (ServerAPI t/2474, p/335#24).

**Applies To:** All agents implementing tickets across session boundaries.
