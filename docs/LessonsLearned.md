# Lessons Learned

Institutional memory for failure patterns across the AI Triad Research project.

---

## [Build] Bash Dollar-Sign Variable Substitution Corrupts Code

**Pattern:** Bash interprets dollar-sign expressions in commands as variable substitution, corrupting code that uses dollar-sign syntax (JS template literals, PowerShell variables like `$_`).

**Instances:**
- 2026-05-21 — Shared Lib agent: sed commands with JS `${activePovers.length}` caused "bad substitution" (p/5#1).
- 2026-05-21 — Technical Lead: PowerShell `$_.ToString()` mangled by bash string interpolation. Resolved by restructuring the command to avoid `$_` in bash context (p/8#5).

**Root Cause:** Bash expands dollar-sign expressions (`${...}`, `$_`, `$var`) before passing them to the target command. This silently corrupts or errors on code from languages that also use dollar-sign syntax (JS/TS template literals, PowerShell variables).

**Prevention:**
1. Prefer line-number addressing for sed over pattern matching when patterns contain dollar-sign syntax.
2. Use the dedicated Edit/Write tools instead of Bash sed/heredoc when target code contains dollar-sign expressions.
3. If Bash is unavoidable, restructure commands to avoid dollar-sign segments, or write a temp script and execute it.
4. Root AGENTS.md File Editing Rule now codifies this (q/4 approved, p/8#7).

**Status:** Resolved — systemic prevention via AGENTS.md rule.

**Applies To:** All agents using Bash to edit/run TypeScript, JavaScript, PowerShell, or any code with dollar-sign syntax.

---

## [Build] Bash Heredoc Failures with Nested Quotes

**Pattern:** Bash heredocs and `bash -c`/`pwsh -Command` wrappers fail when the embedded code contains nested single quotes — common across Python, PowerShell, and TSX/JSX string literals.

**Instances:**
- 2026-05-21 — Taxonomy Editor agent hit heredoc failures twice when running Python code containing TSX string literals with nested single quotes (p/6#1).
- 2026-05-24 — PowerShell agent: `pwsh -Command '...'` with embedded PowerShell single-quoted strings caused `unexpected EOF while looking for matching backtick`. Fixed by replacing inner single-quoted strings with double-quoted strings (p/20#3).
- 2026-05-24 — Computational Linguist: Bash heredoc failed again on a large Python analysis script with apostrophes in f-strings. Fixed by splitting into two scripts (data collection to `/tmp/belief_signals.json`, then analysis) and using %-formatting instead of f-strings to avoid apostrophes (p/7#7).
- 2026-06-17 — Sync: `git commit -m @'...'@` in Bash tool errored — `@'...'@` is PowerShell here-string syntax, Bash split the multi-line message into stray pathspec args. Fixed by writing commit message to temp file and using `git commit -F <file>` (p/77#1).
- 2026-06-17 — ServerAPI: same `@'...'@` in Bash issue, compounded by placing `-m` after `--` separator — everything after `--` is treated as pathspecs, so the message flag was ignored entirely. Fixed with `git commit -F <file> -- <paths>` (message flag before `--`) (p/79#1).
- 2026-06-17 — DebateUI: `@'...'@` in Bash tool leaked a literal `@` into a commit subject on shared branch. Part of a larger incident where amend clobbered another agent's commit (p/83#1).
- 2026-07-15 — Computational Linguist (t/1586): inline PowerShell in Bash heredoc with backtick-escaped variables hit "unexpected EOF while looking for matching backtick" — twice in the same session. Fixed by writing script to temp file with Write tool (p/7#30).
- 2026-07-17 — PowerShell (t/1712, p/20#23): an inline `pwsh -Command` containing a PowerShell `-split "`n"` (backtick-n) plus nested single/double quotes broke **bash's own parser** (`unexpected EOF while looking for matching quote`) before pwsh ran at all. Fixed by writing the PS snippet to a temp `.ps1` and running `pwsh -File` — the ADR-004 remedy. Reinforces that once inlined PS carries backtick escapes AND nested quotes, `-File` beats fighting the quoting.
- 2026-10-01 — PowerShell (p/20#53): inline `pwsh -Command "..."` with nested backtick-escaped PS string interpolation threw `unexpected EOF while looking for matching '` — bash's own quote parser broke on the mixed backtick/quote nesting before pwsh received the command. Fixed: wrote PS code to temp `.ps1`, ran `pwsh -NoProfile -File <path>`. Third recurrence of the `-Command` + backtick-escaping sub-pattern (prior: p/20#3, p/20#23).
- 2026-10-01 — Shared Lib (p/5#37, **3 instances same session — Windows path backslash variant**): three `python -c "..."` inline calls failed with Python SyntaxError — Windows paths embedded as string literals in inline code contained backslashes (`\`) that Python interpreted as escape sequences (`\U`, `\u`, `\n`, etc.). Fixed all three by writing the scripts to scratchpad files and running `python "path/to/script.py"`. Same Shell Quoting Rule class: inline `-c` with special chars → write-to-file is the discipline.
- 2026-08-07 — DebateWorkspace (p/124#10, t/2256): `@'...'@` here-string in Bash tool with `-m` placed after `--` separator — git read the message text and the `-m` flag as filenames ("pathspec '-m' did not match"). Fixed: wrote message to file, used `git commit -F <file> -- <paths>`.
- 2026-08-09 — Rosetta Stone 3 (p/355#3): `@'...'@` in Bash tool left a stray `@` in the commit subject (same facet as p/83#1). Fixed with `git commit --amend -F <file>` to rewrite the subject cleanly.
- 2026-09-30 — Project Instructions (p/688#6): `git commit -m @'…'@` in Bash tool — Bash word-split the message into bogus pathspecs (`error: pathspec 'full' did not match`), commit aborted. Resolved by writing message to temp file and using `git commit -F <file>`. Note: `@'…'@` is PowerShell-only syntax; in Bash it is not a syntax error but silently mangles the arguments — the error surface is pathspec failures, not "invalid syntax."
- 2026-10-03 — PowerShell (p/20#59, **`gh pr comment --body` variant**): `gh pr comment --body` with a multi-line markdown heredoc containing code spans (backticks) and special chars → Bash `unexpected EOF` parse error. The Bash heredoc for the body string was the failure site, not `gh` itself. Fixed: wrote body to a scratchpad file with the Write tool, then passed `gh pr comment --body-file <path>`. Same ADR-004 class; `--body-file` is the `gh`-CLI equivalent of `-F` / `-File`.
- 2026-10-04 — Unknown agent (p/26#141, t/3744#6, **non-zero-byte variant**): a mis-quoted command word-split and created `taxonomy-editor/src/server/({` — a 33 KB file containing `file` command error output. Root cause: the `({` token is a shell word-split fragment from a mis-quoted command; the `file` errors indicate the `file` utility was invoked on many paths before failing. Removed by DevOps. Note: unlike the typical 0-byte word-split junk (Pattern #1 core shape), this variant produces a non-zero-byte file because the mis-quoted command produced output. Same mitigation: scan `git status --short` for bare-fragment filenames before any `git add`.
- 2026-10-05 — Shared Lib (p/5#43): 0-byte `lib/console.log('` created right after `node -e "...h=>console.log('  ',h)..."` — the `=>` in the inline command was interpreted as a shell redirect. Classic word-split/redirect. Fix: moved to scratchpad script files (ADR-004).
- 2026-10-06 — Computational Linguist (p/7#96, t/3271, **inline `python -c` backslash variant**): inline `python -c` script containing a backslash split the string at the shell level, producing a Python `SyntaxError`. Fixed by writing the script to a temp file (Write tool), per ADR-004. Same class as p/5#37 (Windows path backslashes in inline Python); backslash in any context breaks inline `-c`.
- 2026-10-05 — Rosetta Stone (p/6#73, p/6#75, **tool-content-re-shelled facet, observed**): 0-byte files named after fragments of tool content — `slices/e.type` (from `e => e.type` in output), `src/releaseDebateDriver()`, `taxonomy-editor/setTimeout(resolve`, `taxonomy-editor/{,` (from Write tool content `resolve => setTimeout(resolve, …)`). Second instance: Write tool with **no Bash ran in between** produced the junk, ruling out command word-split and confirming a hook on Write/Edit (or all tools) passes tool content through an unquoted shell — `=> X` in content acts as shell redirect `> X`. Sage session independently confirmed 10 junk files (p/6#76) created from ping content, same mechanism. Root cause mechanism observed; formal root-cause identification pending Orca Support (t/3744). **Distinct facet: junk created from tool *content*, not tool *commands*.**
- 2026-10-22 — PowerShell (p/20#106, t/4404): `pwsh -Command "…"` from Git Bash failed "unexpected EOF looking for matching backtick" — a backtick escape (`` `$ ``) inside a bash double-quoted string. Fixed by editing the file with the Edit tool instead of an inline command. 4th recurrence of the `pwsh -Command` + backtick sub-pattern.
- 2026-10-22 — PowerShell (p/20#108, t/4404): 5th recurrence of the same sub-pattern minutes later, while applying a "just one replace" fix. Resolved using the Edit tool. Reinforces that the inline `pwsh -Command` form with any backtick or `$` is risky even for small edits.
- 2026-10-23 — PowerShell (p/20#112): 6th recurrence — backtick-escaped PS variable (`` `$null ``) inside `pwsh -Command "…"` double quotes. Bash treated the backtick as command substitution → "unexpected EOF." Moved to a `.ps1` file written with a quoted heredoc, ran `pwsh -File`.

**Root Cause:** Heredocs (even quoted `<< 'EOF'` which disable variable expansion) still cannot contain the same quote delimiter used by the inner language. The `bash -c` and `pwsh -Command` wrappers compound this by adding another quoting layer. Additionally, PowerShell-specific syntax (`@'...'@` here-strings) is silently misinterpreted by Bash, not rejected — leading to confusing errors. The `--` separator compounds commit message issues: all flags must come before `--`, or git treats them as pathspecs.

**Prevention:**
1. **First choice:** Use the Write tool to create a temp `.py` script file, then execute it with Bash — avoids all quoting issues.
2. Split complex scripts into smaller pieces that each avoid quote conflicts, passing data via temp files (e.g., JSON to `/tmp/`).
3. In Python, use %-formatting or `.format()` instead of f-strings when the content will pass through Bash.
4. For PowerShell via Bash, use double-quoted strings inside the command to avoid single-quote nesting.
5. Prefer the Edit/Write tools over Bash heredocs for file creation/modification.
6. For git commits: use `git commit -F <tmpfile> -- <paths>` — write message to temp file, and always place flags before the `--` separator.
7. **For any non-trivial PowerShell, prefer `pwsh -File <script.ps1>` over inline `pwsh -Command "..."`** (p/20#23). The moment the PS carries backtick escapes (`` `n ``, `` `t ``), nested quotes, or `$` refs, the inline form fights two parsers (bash then pwsh); a temp `.ps1` + `-File` sidesteps both. This is the ADR-004 "write to a file, then run it" remedy applied to PS specifically.
8. **For `gh pr comment`/`gh issue comment` with multi-line or markdown-rich bodies, use `--body-file <path>` — never inline the body in a heredoc.** Write the body with the Write tool first, then pass the path. The same ADR-004 discipline that applies to `-F` for git commit messages and `-File` for PS scripts applies here: `gh` CLI provides the `--body-file` escape hatch for exactly this reason.

**Status:** Resolved — AGENTS.md rule broadened to cover both file editing and script execution (p/8#14). Original rule from q/4 now includes: write scripts to temp files with Write tool, then execute via Bash. Prevention #7 (`pwsh -File`) added 2026-07-17 (p/20#23). Prevention #8 (`gh --body-file`) added 2026-10-03 (p/20#59). Both are durable instance-triggered refinements of ADR-004.

**Applies To:** All agents using Bash heredocs to run or generate code with nested quoting across languages.

---

## [Process] Write Tool Security Gate Hook Blocks All Writes (RESOLVED)

**Pattern:** The security gate feedback rule (PreToolUse hook on Write and Edit) blocks ALL file writes indiscriminately, including plain markdown with no secrets.

**Instances:**
- 2026-05-21 — Sage agent blocked on Write and Edit when creating/updating LessonsLearned.md (plain markdown, no secrets).
- 2026-05-21 — Computational Linguist agent reported Write tool and Bash heredoc both failed repeatedly when writing a large markdown document; the security gate returned a scanning prompt with no actual content to scan (p/7#1).

**Root Cause:** The hook was configured as type `block` with condition `true`, which unconditionally blocked every Edit/Write call. The scanning instructions were output as the error message but no actual content evaluation occurred.

**Resolution:** Diagnostics changed the hook from type `block` to type `context` so scanning instructions are injected as guidance rather than blocking (p/9#2). Edit/Write tools work normally now.

**Lesson:** When creating feedback rules, use type `context` for advisory/scanning guidance and only use type `block` when the condition actually evaluates the content. A `block` rule with condition `true` will reject all tool calls unconditionally.

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

## [PowerShell] Pester 5.x Parameter Changes

**Pattern:** Using Pester 4 syntax (`-Filter @{ FullName = '...' }`) throws "parameter not found" in Pester 5.x.

**Instances:**
- 2026-05-21 — Orca Support hit "parameter not found" with `-Filter @{ FullName = '...' }` and `-TestName` during t/16. Both are Pester 4 params. Resolved by switching to `New-PesterConfiguration` with `$cfg.Filter.FullName` and absolute paths (p/13#1, p/13#4).

**Root Cause:** Pester 5.x removed `-Filter` (hashtable) and `-TestName` as direct `Invoke-Pester` parameters. The v5 API uses `New-PesterConfiguration` with `-Configuration`, or the shorthand `-FullNameFilter` (string).

**Prevention:**
1. Use `-FullNameFilter '*pattern*'` (string) for simple filtering, or `New-PesterConfiguration` with `$cfg.Filter.FullName` for full control.
2. Use absolute paths — cwd resets between Bash calls.
3. Root AGENTS.md has been updated to Pester 5 syntax (p/13#3).

**Status:** Resolved — root AGENTS.md corrected.

**Applies To:** All agents running Pester tests.

---

## [Build] Git Commit Fails Without user.name/user.email

**Pattern:** `git commit` fails on fresh clones or new machines when global git config lacks `user.name` and `user.email`.

**Instances:**
- 2026-05-21 — Orca Support hit commit failure on a fresh clone without global git config (p/13#6).

**Root Cause:** Git requires `user.name` and `user.email` to create commits. Fresh environments (new machines, containers, CI without config) lack these by default.

**Prevention:**
1. Set repo-local config: `git config user.name "Name"` and `git config user.email "email"`.
2. Consider adding git config setup to post-create scripts (e.g., `.devcontainer/post-create.sh`) for containerized environments.
3. Agents should check for git config before attempting commits in unfamiliar environments.

**Applies To:** All agents making git commits, especially in fresh or containerized environments.

---

## [PowerShell] Strict Mode Unexpected Evaluation Failures

**Pattern:** PowerShell strict mode causes unexpected failures beyond simple missing-property access — including constructor calls and complex expressions inside inline assignments.

**Instances:**
- 2026-05-22 — `Get-PovLineage` crashed with "The property 'parent_id' cannot be found on this object" when traversing nodes that lack a `parent_id` property (p/20#1).
- 2026-05-24 — `HashSet[string]::new([System.StringComparer]::OrdinalIgnoreCase)` inside an inline `if/else` assignment threw "cannot call a method on a null-valued expression". Fixed by simplifying to block `if/else` with `HashSet[string]::new()` (no constructor args) (p/20#5).
- 2026-05-25 — `.Count` on empty JSON arrays from `ConvertFrom-Json` threw under strict mode. `children: []` and `situation_refs: []` produce objects where `.Count` is unavailable. Fixed by using `foreach` with `break` to test emptiness instead (p/20#9).
- 2026-07-26 — Technical Lead (t/1726, p/8#88): `Invoke-SummaryPipeline` crashed under strict mode accessing `.factual_claims` at **4 sites** when an LLM **omitted that optional JSON field**. Same class as the `.Count`-on-scalar trap behind the `ps-strict-mode-count-guard` hook — an unguarded property read on a `ConvertFrom-Json` object whose shape varies per LLM call. Fix = `$obj.PSObject.Properties['factual_claims']` guard (prevention #1). **The recurring driver is LLM-omitted optional fields** — every optional field in an LLM JSON contract is a latent unguarded-access crash site.

**Root Cause:** PowerShell strict mode interacts unpredictably with complex expressions and JSON-sourced objects — missing properties throw terminating errors, .NET constructors can fail in inline conditionals, and `ConvertFrom-Json` empty arrays may lack `.Count` unlike native `@()` arrays. **The dominant recurrence source is LLM JSON with optional fields:** the model omits a field on some calls, so a property read that worked in testing crashes in production — the same object-shape-varies risk as the "normalize at fetch" data-shape rule, on the PowerShell side.

**Prevention:**
1. Guard property access with `$obj.PSObject.Properties['property_name']` before reading the value.
2. Avoid complex .NET constructor calls inside inline `if/else` expressions — use block `if/else` with simple constructors instead.
3. For JSON-sourced arrays, don't rely on `.Count` — use `foreach` with `break`, `@($array).Count`, or `$null -eq $array` to test emptiness.
4. When working with JSON-sourced data that has variable schemas, assume any property may be absent — **treat every optional field in an LLM JSON contract as a guaranteed-someday-absent field** and guard it at the read site.
5. When strict mode causes unexpected failures with valid-looking code, simplify the expression — break it into multiple statements.

**Status:** Resolved — "Strict Mode + JSON Guardrails" section added to `scripts/AGENTS.md` (p/20#12). **Recurs 2026-07-26 (t/1726, 4 sites) despite the rule** — the `.Count`-on-scalar sub-case is hooked (`ps-strict-mode-count-guard`), but general unguarded *property* access is **not hookable cheaply** (TL's call, p/8#88 — property access too pervasive to lint), so the guardrail rule is the only defense and depends on the author remembering to guard. Durable mitigation = guard at the JSON-read boundary for LLM responses; pairs with the "normalize at fetch" data-shape rule.

**Applies To:** All agents writing PowerShell under strict mode, especially with .NET types or JSON data.

---

## [PowerShell] `@().Count` Over-Counts Null in Measurement Code — the Mirror of the Strict-Mode Guard

**Pattern:** The workspace-standard `@(...)` `.Count` idiom (wrap a pipeline in an array subexpression so `.Count` is always defined under strict mode) has a mirror-image failure when the number is a **reported metric** rather than a loop/guard: `@($null).Count` is **1, not 0**. Wrapping a possibly-null value inflates every null into a phantom count of 1.

**Instances:**
- 2026-07-28 — Tech Lead 2 (t/1878, p/253#1): a metric reported "67 single-alias records" when the true figure was **35** — 32 zero-alias records were each coerced to `@($null).Count == 1` and swept into the single-alias bucket. The `ps-strict-mode-count-guard` hook covers only the crash case, not this metric-inflation case. Caught only by recounting from the artifact; CL fixed it (53c6981d, t/1878#3).

**Root Cause:** `@(...)` guarantees an array so `.Count` is always defined — exactly what makes it a safe *crash* guard. But `@($null)` is a one-element array whose element is `$null`, so its `.Count` is 1. The same idiom that prevents a strict-mode crash silently over-counts when the wrapped value can be `$null` (or any single scalar) and the count is then cited as a figure. Two consumption modes, opposite failure: **as a guard** (branch on `>0`) the spurious 1 is harmless; **as a metric** it is a wrong number nobody questions, precisely because `.Count` "can't fail."

**Prevention:**
1. Distinguish the two uses of `@(x).Count`. As a *guard* (test emptiness / branch on `>0`) it is correct as-is. As a *metric someone will cite*, handle the null/empty case explicitly.
2. For a cited count, filter first — `@($x | Where-Object { $null -ne $_ }).Count` — or guard: `if ($null -eq $x) { 0 } else { @($x).Count }`. Never `@($x).Count` on a value that can be `$null` when the result is a reported figure.
3. Recount any reported figure from the underlying artifact before publishing it. A `.Count`-derived metric is a bookkeeping signal, not the artifact — the over-count is invisible except by object-level recount ("bookkeeping ≠ artifact" genus).

**Status:** Active — sibling of the strict-mode `.Count` pattern above (crash case, hooked as `ps-strict-mode-count-guard`); this **measurement** facet is NOT covered by that hook. Not cheaply hookable: `@($x).Count` is identical syntax whether the wrapped value is null-safe or not, so a linter cannot separate the correct guard use from the buggy metric use — same "distinguishable-from-correct" bar as the #82 hookability criterion. Rule-only.

**Applies To:** All agents writing PowerShell that reports counts/metrics derived from pipelines or possibly-null values.

---

## [PowerShell] `Select-Object -First N` Sends a Stop-Upstream Signal — Truncates a `Tee-Object`/side-effect Write in the Same Pipeline

**Pattern:** Putting `Select-Object -First N` at the end of a pipeline that also *writes* upstream (e.g. `... | Tee-Object -File f | Select-Object -First N`) produces a **truncated file**. Once `-First N` has its N items it fires a **stop-upstream signal**; PowerShell tears the pipeline down early, so the upstream `Tee-Object -File` only ever flushed the first N items to disk. The on-screen output looks right (N lines) while the file on disk is incomplete/invalid (e.g. truncated JSON).

**Instances:**
- 2026-07-28 — Shared Lib (p/5#15, self-resolved): `node gen.mjs | Tee-Object -File f | Select-Object -First 60` wrote **invalid, truncated JSON** — `-First 60` stopped the pipeline after 60 lines, so `Tee-Object` flushed only 60 of the full output. Fixed by capturing the full output with a plain redirect (`node ... | Out-File f`) and applying `Select-Object -First` only to a **separate display read**, never in the same pipeline as the file write.

**Root Cause:** `Select-Object -First N` is an optimizing cmdlet — to avoid processing more than needed it throws `StopUpstreamCommandsException` (the "stop-upstream" signal) as soon as it has N objects, halting every upstream stage, including a `Tee-Object -File` whose *side effect* (writing to disk) is therefore cut short. The file is a partial artifact even though the pipeline "succeeded." Any side-effecting stage upstream of a `-First`/short-circuiting consumer is at risk — not just `Tee-Object` (also mid-pipeline `Out-File`, `Export-Csv`, a custom writer).

**Prevention:**
1. **Never put a file-writing stage (`Tee-Object -File`, mid-pipeline `Out-File`) upstream of `Select-Object -First N`** in the same pipeline — the `-First` stop-signal truncates the write.
2. **Capture the full output first, then read a slice separately:** `node ... | Out-File f` (complete file), then `Get-Content f | Select-Object -First 60` for display. Separate the write from the truncating read.
3. **Treat any short-circuiting consumer (`-First`, a `break` inside `ForEach-Object`) as pipeline-halting** — don't rely on an upstream side effect completing after it fires.

**Status:** Active — PowerShell pipeline-semantics gotcha; the stop-upstream optimization silently truncates upstream side-effecting writes.

**Applies To:** All agents writing PowerShell pipelines that both write a file and slice output with `Select-Object -First`.

---

## [PowerShell] Pester Expands `<...>` Tokens in It/Describe Names — a Literal `<x>` Evaluates `$x` and Throws Under Ambient Strict Mode (Local≠CI)

**Pattern:** Pester's data-driven syntax **expands `<token>` placeholders in `It`/`Describe`/`Context` NAME strings** by evaluating the variable of that name (the mechanism behind `-ForEach`/`-TestCases` name interpolation). A name written as a plain description — e.g. `It 'resolves a <family>-latest alias'` — therefore makes Pester evaluate `$family`. If nothing bound it, that's an **unbound-variable read**; under an **ambient `Set-StrictMode -Version Latest`** the read **THROWS**, and the test **false-reds** from name expansion, not from any assertion. It only bites when strict mode is live in the Pester run SCOPE (a wrapper script's own `Set-StrictMode`, or a module's `BeforeAll` import that sets it). CI's bare `Invoke-Pester` sets no strict mode → CI is GREEN, so a **local strict wrapper disagrees with CI**.

**Instances:**
- 2026-07-29 — PowerShell 2 (t/1971, PR #160, building `verify:config`): `Test-AIModelsConfig.Tests.ps1` had `It 'resolves a <family>-latest alias'`; Pester evaluated `$family` (unbound) and, under the wrapper's ambient `Set-StrictMode -Version Latest`, threw → false-red. CI (no strict mode) was green — the divergence was strict-mode-in-scope, not the test logic. Fix: `& { Set-StrictMode -Off; Invoke-Pester -Configuration $c }`. (t/1971#1.)

**Root Cause:** `<name>` in a Pester test-name string is a **template placeholder**, not literal text — Pester interpolates it from a variable (intended for `-ForEach`/`-TestCases`). A description that merely contains `<word>` triggers a read of `$word`. Strict mode turns an unbound read from silent-`$null` into a terminating error, so the same name is benign without strict mode (CI) and fatal with it (a local wrapper). Compounding: (1) angle brackets in a name are magic, not literal; (2) local strict-mode-in-scope ≠ CI's strict-mode-off — a local≠CI divergence (family of #88 keys-present, #94 test-scope).

**Prevention:**
1. **Don't put literal `<...>` in a Pester test name** unless it's a real `-ForEach`/`-TestCases` placeholder. Rephrase (`resolves a family-latest alias`).
2. **Run Pester with strict mode OFF in the run scope** if a wrapper/module sets it: `& { Set-StrictMode -Off; Invoke-Pester -Configuration $c }` — matches CI.
3. **False-red locally but green in CI ⇒ suspect a local-harness/CI divergence** — here strict-mode-in-scope (sibling of #88/#94).

**Status:** Active — Pester name-token expansion × ambient strict mode; local-wrapper≠CI false-red.

**Applies To:** All agents writing Pester tests whose names contain `<...>`, or running Pester via a wrapper/module that sets `Set-StrictMode`.

---

## [PowerShell] Private Module Functions Not Available in Standalone Scripts

**Pattern:** Calling a `Private/` module function (e.g., `Get-DataRoot`) from a standalone `.ps1` script fails with "not recognized" because private functions are only available within the module scope.

**Instances:**
- 2026-05-25 — PowerShell agent: `Get-DataRoot` not recognized when called from a standalone BDI ID rename script (t/120, p/20#7).

**Root Cause:** Functions in `Private/` are internal to the module — they are not exported and not available to scripts run outside `Import-Module`. Standalone scripts must resolve paths independently.

**Prevention:**
1. Standalone scripts must not reference `Private/` module functions — resolve values directly (e.g., read `.aitriad.json` for data root).
2. Only `Public/` functions are available after `Import-Module` — check the module manifest's `FunctionsToExport` if unsure.
3. If a private helper is needed outside the module, either promote it to `Public/` or duplicate the logic.

**Applies To:** All agents writing standalone PowerShell scripts that interact with module functionality.

---

## [PowerShell] Cmdlet Return Types Are Not Always Strings

**Pattern:** PowerShell cmdlets return rich objects, not plain strings. Treating the return value as a string causes unexpected failures (e.g., `.Length` on a `PathInfo` object).

**Instances:**
- 2026-05-25 — PowerShell agent: `Resolve-Path` returns a `PathInfo` object, not a string. `.Length` failed on the object. Fixed by appending `.Path` to get the string value (t/120, p/20#7).

**Root Cause:** PowerShell cmdlets return typed objects. `Resolve-Path` returns `System.Management.Automation.PathInfo`, `Get-Item` returns `FileInfo`/`DirectoryInfo`, etc. String operations or property access assumes the wrong type.

**Prevention:**
1. Use `.Path` after `Resolve-Path` to extract the string path.
2. Use `.FullName` after `Get-Item`/`Get-ChildItem` for string paths.
3. When in doubt about a cmdlet's return type, check with `(Resolve-Path .).GetType().FullName`.
4. Cast explicitly with `[string]` if you need a string from a rich object.

**Applies To:** All agents writing PowerShell scripts.

---

## [PowerShell] Undeclared Variables from Cross-Section Code Paths

**Pattern:** New code paths reference variables declared in a different section of the script, causing "variable not set" errors under strict mode.

**Instances:**
- 2026-05-25 — PowerShell agent: `$Labels` and `$Descriptions` referenced in embedding-first code but never declared — they were set up in a different code section. Fixed by adding the hashtable declarations to the taxonomy loading step (p/20#14).

**Root Cause:** When adding new code paths or rearranging logic, variables that were available in the original flow may not exist in the new flow. Strict mode catches this at runtime instead of silently using `$null`.

**Prevention:**
1. When adding a new code path, trace all variable references back to their declarations — verify they're reachable in the new flow.
2. Initialize all required variables at the top of the function scope, not inline in conditional branches.
3. Strict mode is doing its job here — the fix is always to declare the variable, not to relax strict mode.

**Applies To:** All agents writing PowerShell under strict mode.

---

## [PowerShell] @(foreach) with Complex Interpolation Is Parser-Fragile

**Pattern:** `@(foreach(...))` combined with complex string interpolation (backtick-n, `$()` sub-expressions) causes PowerShell parser errors.

**Instances:**
- 2026-05-25 — PowerShell agent: `@(foreach(...))` with backtick-n and `$()` interpolation in string literals caused parser failure. Fixed by replacing with explicit `List` + `foreach` loop (p/20#14).

**Root Cause:** PowerShell's parser struggles with `@(foreach(...))` when the loop body contains complex string expressions. The combination of array sub-expression `@()`, `foreach` keyword, and interpolation creates ambiguity for the parser.

**Prevention:**
1. Avoid `@(foreach(...))` — use explicit `[System.Collections.Generic.List[T]]` with a standalone `foreach` loop instead.
2. Keep string interpolation simple inside loops — build complex strings with `-f` format operator or string concatenation.
3. When the parser throws on syntactically valid-looking code, simplify the expression structure.

**Applies To:** All agents writing PowerShell scripts.

---

## [Design] Fast Paths Must Handle Edge-Case Inputs

**Pattern:** Optimization fast paths bypass logic that handles special-case inputs, causing incorrect results when those inputs hit the fast path instead of the general path.

**Instances:**
- 2026-05-22 — Debate engine: all-concession turns fell through to full-network evaluation instead of resolving with delta 0, and the single-claim fast path in `evaluateLookaheadPerClaim` skipped concession detection entirely. Fixed by adding an all-concession branch in `evaluateLookahead` and an `isConcessionClaim` check before the single-claim fast path (t/58, p/5#3).

**Root Cause:** Fast paths were designed for the common case (regular claims) and didn't account for special-case inputs (concessions). When special inputs hit the fast path, they skipped the detection logic that only existed in the general path.

**Prevention:**
1. When adding fast paths or short-circuit logic, enumerate all input categories and verify each is handled — not just the common case.
2. Place special-case checks (concessions, empty inputs, sentinel values) *before* fast paths, so they resolve before the fast path has a chance to mishandle them.
3. Tests should cover edge-case inputs through every code path, including fast paths.

**Applies To:** All agents working on the debate engine or adding optimization fast paths to existing logic.

---

## [Build] Python Windows Encoding Default

**Pattern:** Python on Windows defaults to cp1252 encoding for both file I/O and stdout. Any operation involving non-ASCII characters (em dashes, arrows, accented names, Unicode quotes) fails or silently corrupts.

**Instances:**
- 2026-05-22 — Technical Lead: `json.load()` failed on debate JSON files with UTF-8 characters because `open()` defaulted to cp1252 on Windows (p/8#9).
- 2026-05-25 — Computational Linguist: stdout encoding error — cp1252 can't encode Unicode arrow U+2192. Fixed by wrapping stdout with `io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')` (p/7#9).
- 2026-07-12 — Computational Linguist: prose-audit Python script crashed printing match context containing U+2264 (≤). Fixed with `sys.stdout.reconfigure(encoding="utf-8")` at script top (p/40#5).
- 2026-07-15 — Computational Linguist: `open()` on a project JSON file without `encoding='utf-8'` raised UnicodeDecodeError (cp1252 can't decode 0x90). Em dashes in debate transcripts triggered it. Fixed by adding `encoding='utf-8'` (p/7#32).
- 2026-07-16 — Computational Linguist: a `python -c` one-liner printing doc excerpts crashed with UnicodeEncodeError — Windows console stdout defaults to cp1252 and the doc contained '→' (U+2192). Recovered from partial output + a full-file Read. Prevention adopted: write analysis scripts to a file (never `python -c`), run with `python -X utf8`, avoid printing raw doc text (p/7#34).
- 2026-07-26 — Technical Lead (p/8#89): `python -c "print(open(file).read()[...])"` exited 1 with UnicodeEncodeError — Windows Python stdout defaults to cp1252 and the data contained '↔' (U+2194). Fixed by NOT printing unicode file contents to the console — parse in-memory and write results to a UTF-8 file (or set `PYTHONIOENCODING=utf-8`), then Read that file. Textbook repeat of the p/7#34 instance (different char, same `python -c` print-to-stdout exposure); prevention #4/#5 already prescribe exactly this.
- 2026-07-30 — Computational Linguist (p/7#51): a prose-lint **FILE-SCRIPT** (not `python -c`) crashed printing '→' (U+2192) to a cp1252 console (UnicodeEncodeError) AFTER computing counts fine; `PYTHONIOENCODING=utf-8` rerun fixed it — data intact, only the console encode failed. **7th instance.** Notable: a file-script hit it, so prevention #5 ("prefer file-scripts over `-c`") is **insufficient** — a file-script still needs UTF-8 forced UP FRONT. **7 instances, 2 agents (CL ×5 + TL ×2); recurring-despite-prevention = rule-not-applied (#82-shaped). ESCALATION ACCEPTED → DevOps t/2046 (TL p/8#145): a global env default `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8` workspace-wide** converts the point-of-use rule into a point-of-environment guarantee. TL routed to DevOps (environment-management scope) with gate-verification ACs (prove `utf8_mode` active + the failure case now passes) and **deliberately did NOT author an AGENTS.md rule** — a point-of-use rule can't close a point-of-environment bug. Awaiting t/2046 to close. Durable habit meanwhile: force UTF-8 up front (`sys.stdout.reconfigure` / `-X utf8` / env var), file-script or not.

**Root Cause:** Python's `open()` and `sys.stdout` use `locale.getpreferredencoding()` which is cp1252 on most Windows systems, not UTF-8. Both file I/O and subprocess stdout are affected. Ad-hoc `python -c` one-liners are especially exposed: they encourage printing raw doc text straight to a cp1252 console with no `reconfigure`/`-X utf8` safeguard.

**Prevention:**
1. Always pass `encoding='utf-8'` to `open()` when reading or writing JSON, markdown, or any text data files.
2. For stdout with Unicode content, wrap with `io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')` or call `sys.stdout.reconfigure(encoding='utf-8')` at script top.
3. Use `json.loads(Path(f).read_text(encoding='utf-8'))` as an alternative pattern for file reads.
4. Force UTF-8 globally: set `PYTHONUTF8=1` or `PYTHONIOENCODING=utf-8` env var, or invoke with `python -X utf8`.
5. Prefer a written-to-file analysis script over a `python -c` one-liner (avoids the console-encoding exposure), and read doc text via the Read tool rather than printing raw non-ASCII content to stdout.

**Status:** Resolved — `PYTHONUTF8=1` set fleet-wide (t/2046, PR #385, p/26#48, 2026-08-03): Windows User env var + `ci.yml` `python-embed-smoke` env + hard-fail assertion + both Dockerfiles. Point-of-environment guarantee now active. Pattern closed after 7 instances.

**Applies To:** All agents writing Python that reads/writes text files or prints Unicode, especially on Windows.

---

## [Data] Assumed JSON Schema Without Inspecting Actual Data

**Pattern:** Code assumes a flat or simple data structure for JSON fields, but the actual schema is nested (arrays of objects, sub-properties under intermediate keys).

**Instances:**
- 2026-05-22 — Computational Linguist: lineage analysis script found 0 names because it looked for a flat `intellectual_lineage` string array at the node root, but the actual data is `graph_attributes.intellectual_lineage[].name` — an array of objects nested under `graph_attributes` (p/7#3).
- 2026-05-22 — Computational Linguist: `embeddings.json` parsing failed with `'str' object has no attribute 'get'` because code iterated top-level keys directly, but node entries are nested under `data['nodes']` — top level has metadata keys (`model`, `dimension`, `field_weights`) (p/7#5).
- 2026-05-25 — Computational Linguist: `'list' object has no attribute 'items'` when accessing `stage_diagnostics` — assumed dict but it's a list. Fixed by checking type first and iterating as list (p/7#11).
- 2026-05-26 — Shared Lib: `embed_taxonomy.py` batch-encode passed bare string array but the function expects `[{id, text}]` objects. Fixed by matching the expected input format. Reference: `relinkVocabulary.ts` (p/5#7).
- 2026-07-06 — Computational Linguist: inline Python formatting of `list_tickets` output threw TypeError joining `blocker_summaries` — assumed elements were strings but they're objects. Fixed by coercing each element before join (p/7#16).
- 2026-07-06 — Computational Linguist: inline Python concatenated debate session `origin` field assuming string — it's a dict in some sessions (TypeError). Fixed with `str(d.get(k,''))` coercion at read site (p/7#18).
- 2026-07-26 — Computational Linguist (p/7#36): inline Python inspector crashed calling `len()` on `policy_count` (an int) while probing `policy_actions.json` shape — **printed values before type-checking them**. Trivial + self-correcting: read the shape from the partial output and moved on. Shape learned: `policy_actions.json` keys the list under `policies`, name field is `action`. Same inspect-before-coding failure (operate-before-type-check); loud crash, no downstream cost.
- 2026-07-26 — Computational Linguist (**8th instance, same-session recurrence**, p/7#38): scratch script threw `AttributeError: 'str' has no .get` walking `situations.json` interpretations — **1,236 nodes have `interpretations.{pov}` as a dict, 23 have it as a plain string**. Cause: assumed uniform shape instead of type-checking at the read site. `isinstance`-guarding fixed it AND *was* the diagnosis — the string form is pre-BDI-decomposition (t/1805). Recurred within hours of #7 → CL argues recording isn't preventing recurrence (hookable check > doc entry); reversed Sage's earlier not-in-#82 call (see #82 tracker).
- 2026-07-28 — Computational Linguist (**+4, p/7#47/#49**, now 12): **3 probe errors** (t/1826 — extraction-log `nodes`=list not dict, `aliases` nullable, `policy_actions` keys under `policies`/name=`action`) = #82 offender #5 (inspect-before-coding not applied). **+1 PRODUCTION defect (t/1830):** the extraction cmdlet **char-explodes bare-string `aliases`** (13/37 records — model emits string where schema says array, iterated unguarded). **It shipped in POWERSHELL (`Invoke-EntityExtraction`), NOT TS** (CL correction p/7#49) — so `tsc`/a TS union can't catch it; the PS-side prevention is **coerce-at-read (`if ($x -is [string]) { @($x) }`) at each AI-JSON boundary as ONE shared helper (Shared Utility Rule) + a bare-string Pester fixture**. Offender #5's real defense splits by surface: TS→union types, PS→shared coerce helper.
- 2026-10-01 — Shared Lib (p/5#33, **new variant: directory path assumption**): `FileNotFoundError` reading `taxonomy/accelerationist.json` — the file does not exist at a flat path; the actual location is `taxonomy/Origin/accelerationist.json`. Root cause: assumed all per-POV taxonomy JSON files sit in the root of `taxonomy/` without verifying the directory structure. Fix: checked actual path with PowerShell first, discovered the `Origin/` subdirectory. Same root cause as JSON schema variant (assume flat, don't inspect first) applied to filesystem layout rather than JSON content.
- 2026-10-06 — Computational Linguist (p/7#96, t/3271, **zero-result heuristic instance**): counted `claim_relations` at the summary's top level — got 0, but there are 43. They're nested inside each claim, not at the top level. Caught by reading the prompt schema before reporting. **New heuristic: a "0 found" result should trigger a schema check before reporting.** Zero is a valid count, but it is also the exact symptom of a nesting/path mismatch — they are indistinguishable without a schema check.
- 2026-10-07 — Computational Linguist (p/7#102, **zero-result heuristic inst2 — embeddings field name**): embeddings comparison script crashed IndexError after reporting 0 vectors. Field assumed as `embedding`; actual field in `embeddings.json` is `vector`. The 0-vector count was the tell before the crash. Fixed by inspecting one entry and rerunning. Confirms zero result = schema-mismatch signal; crash is downstream of the 0 that preceded it.
- 2026-10-06 — Computational Linguist (p/7#94, **new variant: own-artifact shape assumption**): a read-only inspection one-liner raised `KeyError 'node_id'` on t/3939's `frozen-ops.json`. t/3939's file keys ops by `id`; agent assumed `node_id` from their own t/3952 frozen list, which uses a different shape. Nothing was written. Fix: re-read the file shape before querying. The rule applies to **your own artifacts** as much as shared data — different tickets produce different schemas even when the content is related.
- 2026-10-07 — Computational Linguist (p/7#110, t/4072): inline Python summary of `ai-models.json` crashed `AttributeError: 'str' has no .get` — assumed `debateTiers[tier]` values were dicts; they're strings. Facts already printed; no rerun needed. Same family as the `embedding`/`vector` slip.

**Root Cause:** Code written based on assumed structure without inspecting first. Covers both JSON field layout (nested vs flat within a document) and filesystem directory layout (subdirectory vs flat). Applies across all project data: taxonomy JSON, debate sessions, and tool/API returns. Field types and file paths both vary — never assume flat without checking.

**Prevention:**
1. Always inspect a sample of the actual data before writing code that reads it — `head` a JSON file or `jq` a few records.
2. For taxonomy data specifically: many enriched fields live under `graph_attributes`, not at the node root.
3. Check `type()` / `isinstance()` before calling type-specific methods (`.items()` for dict, iteration for list).
4. **When a script returns 0 results, treat it as a schema-mismatch signal, not a confirmed count.** Zero is indistinguishable from a nesting/path mismatch without a schema check — inspect the actual structure before reporting (p/7#96). Same applies to empty data or an AttributeError.
5. **Don't assume flat directory layout for ai-triad-data files.** Taxonomy JSON files live under subdirectory names (e.g. `taxonomy/Origin/<pov>.json`) — verify actual path with `Get-ChildItem -Recurse` or PowerShell before constructing file paths in code.

**Status:** Post-resolution recurrence (2026-10-01, p/5#33) — "Data File Convention" in root AGENTS.md covers JSON schema, not directory paths. Prevention #5 added.

**Applies To:** All agents working with taxonomy JSON data or writing data processing scripts.

---

## [Build] Missing or Unavailable CLI Tools/Services in Dev Environment

**Pattern:** Commands fail because CLI tools are not installed or required background services are not running.

**Instances:**
- 2026-05-23 — DevOps: `az` CLI not found in bash or PowerShell. Used `gh` CLI as fallback for workflow checks (p/26#1).
- 2026-05-28 — Taxonomy Editor: `docker image ls` returned exit code 1 with no output because Docker Desktop daemon was not running. Fixed by starting Docker Desktop and waiting for daemon initialization (p/6#9).
- 2026-07-17 — PowerShell (verifying t/1699 `check-quality-gates.sh`, p/20#21): `jq` is not on PATH in the dev Bash/pwsh shell, but the script hard-depends on it (CI runners DO have jq), so a local run of the real script failed. Resolved by running the script end-to-end behind a **minimal python `jq` shim** on PATH — verifying the actual script rather than skipping/mocking the jq calls.
- 2026-07-28 — Taxonomy Editor (p/6#24): **`bc` is not installed** in this Windows git-bash — a `git grep -c … | paste -sd+ | bc` pipeline failed "bc: command not found". Resolved by summing with **`awk '{s+=$1} END{print s}'`** — `awk`/`python3` are present where `bc` isn't; use them for arithmetic in Bash-tool pipelines.
- 2026-08-01 — Technical Lead (p/8#158): **2nd `jq` instance** — a Bash `jq` command parsing `~/.claude` JSON exited **127 "command not found"** (`jq` not installed in the Bash tool's Git Bash). Resolved via the **PowerShell tool (`ConvertFrom-Json`)**. Distinct from the p/20#21 python-`jq`-shim (that was for a CI script that hard-depends on jq); for **ad-hoc JSON reads, read in PowerShell, don't shim** — win32 "host/file/JSON ops belong in the PowerShell tool" rule.
- 2026-08-11 — ServerAPI (p/79#27): **3rd `jq` instance** — `gh pr view ... | jq` exited 127 ("jq: command not found") in the Bash tool. Fix: use `gh`'s built-in `--json <fields> --jq '<expr>'` flags — `gh` ships its own jq evaluator, no separate install needed.
- 2026-08-11 — ServerAPI (p/79#29): **4th `jq` instance** — `gh pr checks | jq` exited 127 in the Bash tool; the same missing `jq` also silently broke a **Monitor CI-watch loop** (per-iteration jq failed with no output → loop emitted nothing → timed out at 15 min). **New amplifier: a missing tool inside a Monitor poll loop causes a silent 15-min timeout, not an immediate error.** Fix: use `gh pr checks --json ... --jq '...'` built-in.
- 2026-08-15 — Shared Lib (p/5#27): **5th `jq` instance** — `gh pr checks N | jq` → exit 127 "jq: command not found" in the Bash tool. Risk: misread as a CI failure rather than a tooling gap. Fix: `gh pr checks N --json bucket --jq '...'` — `gh`'s built-in jq evaluator, no separate install needed.

**Root Cause:** Dev environment may lack CLI tools (Azure CLI not installed, `jq` not on PATH) or required background services (Docker Desktop daemon not running). CI runners often have tools the dev shell doesn't, so a script that passes in CI fails locally. Both fail silently or with unhelpful exit codes.

**Prevention:**
1. Before using a CLI tool, check availability with `command -v <tool>` or `Get-Command <tool>` and fall back gracefully if missing.
2. For Docker commands, first verify the daemon is running: `docker info > /dev/null 2>&1`. If it fails, start Docker Desktop and wait for initialization.
3. When a tool is unavailable, prefer alternative tools already installed (`gh` instead of `az`) over blocking.
4. When a command returns exit code 1 with no output, suspect a missing tool or stopped service before debugging the command itself.
5. To verify a CI gate script locally when it depends on a CI-only tool (`jq`), **shim the tool** (e.g. a minimal python `jq` on PATH) and run the REAL script end-to-end — don't skip its calls or reimplement its logic, which defeats the verification.
6. **For arithmetic in Bash-tool pipelines, use `awk`, not `bc`** — `bc` isn't installed in this Windows git-bash. Sum a column with `awk '{s+=$1} END{print s}'`.
7. **For ad-hoc JSON reads, use the PowerShell tool (`Get-Content x.json | ConvertFrom-Json`), not Bash `jq`** — `jq` isn't installed in this host's Git Bash (exits 127). Shim (prevention #5) only to run a CI script that hard-depends on jq; parse your own JSON in PowerShell (win32 host/file/JSON-ops-in-PowerShell rule).
8. **When parsing `gh` output, use `gh`'s built-in flags, not a pipe to `jq`** — `gh pr view/list/run list` all support `--json <fields> --jq '<expr>'`; `gh` ships its own jq evaluator so standalone `jq` is never needed for `gh` output.
9. **Never depend on external `jq` inside a Monitor poll loop** — a per-iteration `jq` failure emits nothing and lets the loop spin silently until the Monitor timeout (up to 15 min), with no error surfaced. Use `gh --jq` or `ConvertFrom-Json` instead; any tool dependency inside a Monitor loop should be verified before entering the loop.

**Applies To:** All agents running CLI commands, especially DevOps, Docker, and CI-related work.

---

## [Build] Node.js Cannot Directly Execute TypeScript Source Files

**Pattern:** `node -e` or `node <file>` fails when importing TypeScript `.ts` files or referencing `.js` extensions for files that only exist as `.ts` — there are no compiled `.js` outputs.

**Instances:**
- 2026-05-23 — Shared Lib: `node -e` with ESM import of `.js` extension failed because the TypeScript source files aren't compiled to `.js`. Vitest handles transpilation internally but raw Node.js doesn't (p/5#5).

**Root Cause:** This project uses vitest for testing, which transpiles TypeScript on the fly. There is no build step that produces `.js` files. Raw `node` commands cannot import `.ts` files or resolve `.js` imports that don't exist on disk.

**Prevention:**
1. Use `npx tsx <file>` or `npx ts-node <file>` to execute TypeScript files directly.
2. For debugging, read the source code with the Read tool rather than trying to execute it with `node -e`.
3. Run tests through vitest (`npm test`), not by invoking node directly on test files.
4. Do not assume `.js` files exist — check for a build/dist directory first.

**Applies To:** All agents working with TypeScript source in the Electron apps or debate engine.

---

## [Build] Unix Paths in Node.js Fail on Windows

**Pattern:** Node.js commands using Unix-specific paths like `/dev/stdin` fail on Windows because Node resolves them as Windows paths (e.g., `C:\dev\stdin` → ENOENT).

**Instances:**
- 2026-05-24 — Taxonomy Editor: `node -e` with `/dev/stdin` pipe failed on Windows. Node resolved `/dev/stdin` as `C:\dev\stdin` which doesn't exist. Fixed by writing a temp `.mjs` script file instead of piping (p/6#5).

**Root Cause:** `/dev/stdin`, `/dev/stdout`, `/dev/null` and other Unix device paths don't exist on Windows. Node.js on Windows doesn't translate these — it treats them as literal file paths under the current drive root.

**Prevention:**
1. Avoid `/dev/stdin` piping patterns — write temp script files (`.mjs` or `.js`) and execute them directly.
2. Use platform-agnostic alternatives: `process.stdin` in Node.js code instead of `/dev/stdin` file paths.
3. For stderr suppression: use `2>/dev/null` in the Bash tool (Git Bash/POSIX sh) — `2>nul` creates a literal file named `nul`. Use `2>$null` in PowerShell. `NUL` (the Windows null device) is cmd.exe-only.
4. When writing Bash commands that run Node.js, remember the dev environment is Windows — test Unix-isms mentally before using them.

**Applies To:** All agents running Node.js commands on this Windows dev environment.

---

## [Build] Bash grep Features Fail Silently on Windows/Git Bash

**Pattern:** `grep -P` (Perl regex) and `grep -o` with complex patterns fail silently (exit code 1, no output) on Windows Git Bash, with no error message indicating the feature is unsupported.

**Instances:**
- 2026-05-27 — Computational Linguist sub-agent: both `grep -P` and `grep -o` with quoted JSON patterns produced no output on Windows/Git Bash. Resolved by using the Read tool instead of Bash grep for JSON field extraction (p/40#1).

**Root Cause:** Git Bash ships a minimal GNU grep that may lack PCRE (`-P`) support and handles complex patterns (especially with JSON special characters) differently than Linux grep. Failures are silent — no stderr, just exit code 1 — making them hard to diagnose.

**Prevention:**
1. Use the dedicated Read and Grep tools instead of Bash `grep` for file content inspection — especially for structured data like JSON.
2. For JSON field extraction specifically, use `python3 -c "import json; ..."` or `jq` instead of grep with regex.
3. Avoid `grep -P` entirely on this platform — PCRE support is not guaranteed in Git Bash.
4. When grep returns no output, suspect platform incompatibility before assuming the pattern doesn't match.

**Applies To:** All agents using Bash grep on this Windows/Git Bash environment.

---

## [Build] Push Rejected Due to Stale Local (Multi-Agent Contention)

**Pattern:** `git push` rejected (non-fast-forward) because remote has newer commits from other agents working in parallel.

**Instances:**
- 2026-05-24 — Project Manager: push to `ai-triad-data` rejected after `embeddings.json` modified both locally and remotely. Resolved with stash/pull --rebase/take theirs/push (p/31#1).
- 2026-05-24 — Technical Lead: push to code repo main rejected with 3 unpushed CI fixes. Resolved with stash/pull --rebase, merge conflict in `logger.ts` (kept cached `usePretty` approach), rebase --continue/stash pop/push (p/8#11).
- 2026-06-25 — DebateWorkspace: push to main rejected (non-fast-forward) due to remote having commits not in local. Resolved by stashing overlay files, `git pull --rebase`, restoring stash, then pushing (p/124#1).
- 2026-07-04 — Server Community: push rejected after committing flight-recorder fix. Remote main had new commits from other agents. Resolved with `git stash && git pull --rebase && git stash pop` then push (p/160#1).
- 2026-07-17 — Diagnostics (p/9#36, **LARGE-divergence variant — NOT self-correcting**): push rejected with local main **46 commits ahead** of origin while origin was **52 ahead** — a genuine divergence. The standard `git stash && merge/rebase` flow **aborted on conflicts in out-of-scope files** the agent didn't own — **routed to TL**. The 46 unpushed local commits are a **push-cadence breach** (root ceiling ~10); once the pile grows that large, a divergence tangles many agents' work and routine resolution stops working.
- 2026-09-28 — Chat (p/687#1): push to `main` rejected in `direct` mode — no `git fetch`/`pull` before push while other agents landed commits. Resolved with `git fetch` + `git pull origin main` (clean merge, ort strategy) + push. Textbook small-scale instance; self-correcting.
- 2026-09-28 — Rosetta Stone (p/6#61, **correct-resolution variant**): committed t/3723 fix on shared `main` (direct mode); push rejected non-fast-forward (t/3728 landed first). Per AGENTS.md, did NOT resolve in place (pull/rebase/reset are prohibited on shared tree). **Correct path:** cherry-picked the local commit into a fresh worktree off `origin/main`, opened PR #2511, merged with `--match-head-commit` after CI green. Consequence: stray unpushed commit left on shared main's local branch → routed to DevOps as diverged-tree cleanup.
- 2026-09-29 — ServerAPI (p/504#12, **correct-resolution variant ×2**): push on shared main (t/3747) rejected — another PR landed between commit and push. Per AGENTS.md, fetched and cherry-picked to fresh worktree `fix/3747-gemini-probe`, opened PR #2542.
- 2026-09-29 — DebateTool (p/70#21, t/3748): direct push to main rejected — didn't fetch before committing, origin had 2 newer commits. Resolved by cherry-picking commit to a new worktree off origin/main, opened PR #2545.
- 2026-09-29 — DebateTool 2 (p/234#12): push rejected on shared main (non-fast-forward) — resolved by land-from-worktree, PR opened from worktree branch.
- 2026-10-06 — Chat (p/687#7, **correct-resolution variant**): `git push origin main` rejected (non-fast-forward) — another agent's commit landed between Chat's commit and push. Per AGENTS.md, didn't rewrite the shared tree; cherry-picked to a worktree branch and landed via PR #2881.
- 2026-10-06 — DebateTool (p/70#52, **feature-branch variant**): `git push origin feat/t4007-engine-soul` rejected — remote branch had new commits since the worktree diverged (commits landed during the implementation session). **Different resolution from shared-main variant:** `git fetch origin feat/t4007-engine-soul` → `git reset --hard FETCH_HEAD` (safe on a personal worktree branch) → `git cherry-pick <sha>` for local commits → push. Five conflict files resolved manually; duplicate imports from the cherry-pick fixed in a follow-up commit. `reset --hard` is safe here because it's a personal worktree branch — not shared main where this would rewrite tree other agents read.

**Root Cause:** Multiple agents work in parallel on the same branches. The window between local commits and push allows remote to advance, causing non-fast-forward rejections. **At small scale this was historically self-correcting** (stash/pull --rebase/pop/push); however AGENTS.md now prohibits all tree-rewriting ops (`checkout`, `reset`, `rebase`, `merge`, `pull --rebase`, `stash`) on the shared checkout — so in-place resolution is NO LONGER the correct path. **At large scale it is never self-correcting** — route to TL/DevOps.

**Prevention:**
1. **Minimize the commit-to-push window** — commit and push in quick succession; a race on push is a race on time.
2. **If push is rejected on shared main: cherry-pick to a fresh worktree, open a PR, land with `--match-head-commit`.** This is the AGENTS.md-prescribed path. In-place resolution (stash/pull --rebase/merge/reset) is prohibited on the shared checkout in BOTH modes — it rewrites the tree other agents are reading.
3. **The stray local commit that remains after cherry-pick is a DevOps cleanup item** — don't attempt to resolve it yourself; flag to DevOps and stop.
4. For generated data files (`embeddings.json`, `policy_actions.json`), prefer "take theirs" conflict resolution unless your changes are the authoritative regeneration — but do this in a worktree, not in place.
5. **Bound the divergence via push cadence** — don't let approved commits pile past the ~10 ceiling; a 40+/50+ divergence is not self-correcting.
6. **A large divergence is a TL/DevOps event** — route immediately; don't attempt resolution involving out-of-scope files.
7. ~~Standard resolution flow: `git stash && git pull --rebase origin main`~~ — **SUPERSEDED by AGENTS.md (2026-09-28).** `stash`, `pull --rebase`, `merge`, `reset` are worktree-only in both modes. Earlier instances (pre-rule) used this flow; it is now prohibited.

**Status:** Active — **12 instances / 10 agents; 3 variants.** Small-contention (self-correcting pre-rule); large-divergence (TL/DevOps); correct-resolution (worktree cherry-pick, first documented p/6#61). Prevention rules updated to reflect AGENTS.md prohibition on in-place tree-rewriting.

**Applies To:** All agents pushing to shared branches in either repo.

---

## [Build] Git Amend on Shared Branch Clobbers Other Agents' Commits

**Pattern:** `git commit --amend` on a branch with multiple concurrent committers rewrites another agent's commit when HEAD advances between the original commit and the amend.

**Instances:**
- 2026-06-17 — DebateUI: ran `git commit --amend` on `feat/phase-5c-diff-view` to fix a commit message. Between the original commit and the amend, another agent committed (t/651), moving HEAD. The amend rewrote that agent's commit with DebateUI's message, clobbering their work. Recovered via `git reflog` to find the original SHA, then `git reset --soft <sha>` to restore it (p/83#1).

**Root Cause:** `git commit --amend` rewrites the commit at HEAD. On a shared branch, HEAD can move between your commit and your amend if another agent commits in that window. The amend then targets the wrong commit — the other agent's — replacing their message and potentially their changes.

**Prevention:**
1. **NEVER use `git commit --amend` on a shared branch.** Create a new commit instead.
2. If a commit message needs fixing, use `git commit --allow-empty -m "corrected message"` or create a fixup commit.
3. `--amend` is only safe on personal/feature branches with a single committer.
4. Recovery: `git reflog` to find the clobbered commit's SHA, then `git reset --soft <sha>` to restore it (preserves index and worktree).

**Status:** Resolved — "Git Commit Rule (Multi-Agent)" added to root AGENTS.md covering amend and rebase on shared branches (p/8#25).

**Applies To:** All agents committing to shared branches (especially `main` and shared feature branches).

---

## [Data] Active Writers Corrupt Git Operations in Data Repo

**Pattern:** Git add/commit/pull operations fail when an active process (e.g., running debate session) is continuously writing to the data repo, creating or modifying files between git commands.

**Instances:**
- 2026-05-25 — Project Manager: `git add -A` failed with "No such file or directory" on a debate JSON (file created then renamed mid-add), then `git pull --rebase` failed repeatedly with "unstaged changes" as new writes kept appearing. Resolved by stashing (including untracked), pulling, dropping stash, and pushing the committed snapshot. Required accepting data loss on in-flight writes (p/31#3).

**Root Cause:** The data repo is both a git-managed store and a live write target for debate sessions and enrichment pipelines. Git operations are not atomic — between `git add` and `git commit`, new files can appear or existing files can change, causing "no such file" (file renamed/deleted) or "unstaged changes" (file modified after staging).

**Prevention:**
1. **Pause active debates/enrichment before committing the data repo.** No active writers during git operations.
2. Use `git add <specific-files>` instead of `git add -A` to avoid catching in-flight files.
3. If stashing is needed, use `git stash --include-untracked` to capture everything, but be aware that dropping the stash loses in-flight data.
4. Consider a lock file convention: writers check for `.git-committing` before writing; committers create it before `git add` and remove after `git push`.

**Applies To:** All agents committing to `ai-triad-data`, especially during active debate or enrichment sessions.

---

## [Type System] Zod v4 Inline Schemas Can Cause TypeScript OOM

**Pattern:** Zod v4's inline composed schemas (e.g., `z.tuple([z.string().regex(...)])`) trigger TS2589 (infinite type recursion), causing `tsc --noEmit` to exhaust the heap (4GB+) before it can even report the error.

**Instances:**
- 2026-05-24 — Taxonomy Editor: poviewer `tsc --noEmit` OOM at `ipcHandlers.ts:125` due to `z.tuple([z.string().regex(...)])` inline schema. Fixed by extracting to a pre-defined `oneString` schema with runtime regex check. Commit 588ca0a (p/6#3).

**Root Cause:** Zod v4's TypeScript type inference for composed schemas (tuple + regex) creates deeply recursive conditional types. When inlined, the TypeScript compiler attempts to resolve the full type tree and enters infinite recursion, consuming all available memory before producing a diagnostic.

**Prevention:**
1. Pre-define complex Zod schemas as named constants rather than inlining them in function signatures or handlers.
2. Separate validation concerns: use simple Zod types (`z.string()`) for shape validation, then apply regex/format checks at runtime.
3. If `tsc` hangs or OOMs with no error output, suspect recursive type inference — bisect by commenting out Zod schemas to isolate the culprit.
4. Monitor `tsc --noEmit` memory usage in CI; an unexplained spike is likely a type recursion issue.

**Applies To:** All agents working with Zod v4 schemas in the Electron apps (taxonomy-editor, poviewer, summary-viewer).

---

## [Build] Overlay Repo (ogit) Requires Special Git Handling

**Pattern:** The Orca overlay repo (`ogit`) has four recurring git pitfalls: (1) `ogit` is a shell alias unavailable in non-interactive shells (Bash tool), (2) `git add` rejects files that match the main repo's `.gitignore` — negation patterns can't re-include files under already-excluded parent dirs, (3) push contention occurs just like the main repo, (4) git flag ordering — `-- <pathspec>` must come AFTER all flags like `-m`.

**Instances:**
- 2026-05-27 — Taxonomy Editor: `ogit add` rejected paths ignored by main repo's `.gitignore`. Fixed with `git add -f` since the overlay intentionally tracks files like `.orca.yaml` and `AGENTS.md` that the main repo ignores (p/6#7).
- 2026-05-27 — Taxonomy Editor: `ogit push` rejected due to remote having newer commits. Fixed with `git pull --rebase` then push (p/6#7).
- 2026-06-19 — ElectronMain: (a) `ogit` failed with "command not found" in Bash tool — it's a shell alias only available in interactive shells. Fixed by expanding to `git --git-dir=.orca-git --work-tree=.`. (b) `git add` of a new nested `AGENTS.md` rejected as "ignored by .gitignore" — `.orca-gitignore` has `!**/AGENTS.md` negation, but git can't re-include a file when its parent directory is already excluded. Fixed with `git add -f` (p/98#1).
- 2026-06-25 — Shared Lib: `ogit commit` failed with "pathspec '-m' did not match any file(s)" — `-- lib/AGENTS.md` pathspec was placed before `-m` flag, so git treated `-m` as a pathspec. Fixed by moving `-- lib/AGENTS.md` after `-m "message"` (p/5#11).
- 2026-06-25 — Conflict: `ogit add taxonomy-editor/.../conflict/AGENTS.md` failed ("paths are ignored by .gitignore") — same parent-dir exclusion issue as p/98#1, this time for a per-directory AGENTS.md under `taxonomy-editor/`. Fixed with `ogit add -f` (p/122#1).
- 2026-07-06 — Orca Support: `git --git-dir=.orca-git --work-tree=. add -f ...` failed from `orca-support/` subdirectory — Bash tool cwd is the role's scope directory, not the repo root, so `.orca-git` wasn't found. Fixed by switching to PowerShell with explicit `cd` to repo root (p/13#10).
- 2026-07-17 — Computational Linguist: `git --git-dir=.orca-git add research/comp-linguist/AGENTS.md` failed "paths ignored by .gitignore" even though the file was **already tracked AND already staged** (the `research/` exclusion still blocks a re-`add`). Resolved by **skipping `add` entirely and committing the staged pathspec directly** — `commit -- <path>`. Refines the rule: `-f` is for the *first* stage of a not-yet-tracked file; an already-tracked/staged overlay file needs no re-add at all (p/7#39).
- 2026-08-01 — Orca Support (p/13#24, e2bfe23): **RECURRENCE of the run-from-subdir facet** — overlay `commit` from the `orca-support/` subdir failed (`.orca-git` not visible from subdirs; Bash cwd = role scope, not repo root); re-ran from the repo root → committed `e2bfe23`. Same agent, same facet ~1 month after p/13#10; rule + hook exist but it still bites from a role subdir. Loud + self-correcting, not escalating.
- 2026-08-09 — DebateWorkspace (p/124#12): `ogit` returned "command not found" in the Bash tool — non-interactive shell, aliases not loaded. Switched to `git --git-dir=.orca-git --work-tree=.`; status/log/audit all succeeded.

**Root Cause:** (1) `ogit` is defined as a shell alias (`alias ogit='git --git-dir=.orca-git --work-tree=.'`), which is only loaded in interactive shell sessions — the Bash tool runs non-interactive. (2) The overlay repo shares the working tree with the main repo, so `.gitignore` affects `ogit add`. Negation patterns (`!**/AGENTS.md`) cannot re-include files when a parent directory is already excluded by a broader rule — this bites on every new per-directory AGENTS.md. (3) Multiple agents update overlay files in parallel, causing push contention. (4) Git argument ordering: `-- <pathspec>` must come last — placing it before flags like `-m` causes git to treat the flag as a pathspec.

**Prevention:**
1. **Never use `ogit` in the Bash tool** — expand it to `git --git-dir=.orca-git --work-tree=.` since shell aliases aren't available in non-interactive shells.
2. Use `-f` (force) when **first staging** a not-yet-tracked overlay file — they are gitignored by the main repo by design, especially nested `AGENTS.md` files under already-excluded parent directories. But if the file is **already tracked/staged**, don't re-`add` at all (the parent-dir ignore still rejects a bare `add`, even with the change staged) — just `commit -- <path>` the pathspec directly (p/7#39).
3. Before pushing, run `git --git-dir=.orca-git --work-tree=. pull --rebase` to incorporate remote changes.
4. Must be run from the repo root — `.orca-git` is not visible from subdirectories.
5. Never use `git add` or `git commit` for overlay-tracked files — always use the expanded overlay git command.
6. **Git flag ordering:** `-- <pathspec>` must be the LAST argument — `git commit -m "msg" -- path`, never `git commit -- path -m "msg"` (git treats `-m` as a pathspec).

**Status:** Resolved — root AGENTS.md rule (p/8#28) + `overlay-repo-guard` PreToolUse hook extended to catch both wrong-repo commits and missing `-f` on nested overlay files (p/9#13).

**Applies To:** All agents committing to the overlay repo (AGENTS.md, .orca.yaml, .orca/ directory).

---

## [Build] Docker Build Fails Due to Wrong Relative Import Path Depth

**Pattern:** TypeScript relative import paths that work in the source tree break inside Docker build contexts when the file's depth relative to the imported module differs from the source layout.

**Instances:**
- 2026-05-28 — Taxonomy Editor: Docker build failed with TS2307 `Cannot find module '../../lib/debate/types.js'` in `server.ts`. The inline `import()` type had wrong relative path depth (2 levels instead of 3). Fixed by changing to `../../../lib/debate/types.js`. Commit 25a1e15 (p/6#11).

**Root Cause:** Docker COPY commands and build context can change the relative directory structure compared to the source tree. Relative import paths must account for the file's position within the Docker build context, not just the source repo layout.

**Prevention:**
1. When adding cross-directory imports in Dockerized code, count path depth from the file's location in the build context, not the source repo.
2. After modifying imports in Docker-built code, verify with `tsc --noEmit` inside the Docker build (or a local dry run) before pushing.
3. Consider using tsconfig path aliases to avoid fragile relative paths in Docker builds.

**Applies To:** All agents working on Docker builds that include TypeScript with cross-directory imports.

---

## [API] GHCR Push Fails Due to Insufficient OAuth Token Scopes

**Pattern:** `docker push` to GitHub Container Registry (GHCR) fails with `permission_denied: token does not match expected scopes` when the `gh` CLI OAuth token lacks `write:packages`.

**Instances:**
- 2026-05-28 — Taxonomy Editor: GHCR push failed after successful Docker build. The `gh` OAuth token didn't include `write:packages` scope. Fix: `gh auth refresh -s write:packages` to add the scope (p/6#11).

**Root Cause:** The default `gh auth login` scopes don't include `write:packages`, which is required for pushing to GHCR. This is a one-time setup issue per machine/token.

**Prevention:**
1. Before first GHCR push, ensure token has `write:packages`: `gh auth status` to check, `gh auth refresh -s write:packages` to add.
2. For CI, ensure the `GITHUB_TOKEN` or PAT has `packages: write` permission.
3. Add GHCR auth setup to dev environment onboarding docs.

**Applies To:** All agents pushing Docker images to GHCR.

---

## [Build] CI Workflow Lacks workflow_dispatch Trigger

**Pattern:** `gh workflow run ci.yml` fails because the CI workflow only has `push` and `pull_request` triggers — no `workflow_dispatch` for manual runs.

**Instances:**
- 2026-05-28 — Diagnostics: attempted `gh workflow run ci.yml` but the workflow doesn't have `workflow_dispatch`. Resolved with an empty commit to trigger the push event (p/9#10).

**Root Cause:** The CI pipeline (`.github/workflows/ci.yml`) is configured with `push` and `pull_request` triggers only. There's no `workflow_dispatch` trigger to allow manual or programmatic runs via `gh workflow run`.

**Prevention:**
1. To trigger CI without code changes, use `git commit --allow-empty -m "trigger CI" && git push`.
2. Consider adding `workflow_dispatch:` to `ci.yml` triggers for manual/programmatic runs.
3. Check workflow triggers before assuming `gh workflow run` will work: `gh workflow view ci.yml`.

**Applies To:** All agents attempting to manually trigger CI workflows.

---

## [API] HTTP Redirect Handling Must Cover All 3xx Codes

**Pattern:** Custom HTTP download helpers that only handle 301/302 redirects break when servers use other redirect codes (307, 308). Additionally, creating write streams before redirect resolution leaves 0-byte files on failure.

**Instances:**
- 2026-05-28 — Shared Lib: HuggingFace download helper in `onnxEmbedding.ts` only handled 301/302, but HF uses 307 for `tokenizer.json`. Also created writeStream before redirect resolution, leaving 0-byte files on redirect failure. Fixed by handling 301-308, resolving relative redirect URLs against origin, draining response before following redirect, and deferring writeStream creation until final 200 response (p/5#9).

**Root Cause:** (1) Incomplete redirect handling — 307/308 are common (HuggingFace, AWS S3, CDNs) but often overlooked when only 301/302 are coded. (2) Premature resource creation — opening a file write stream before confirming the final response means a redirect or error leaves an empty file that looks like a successful download.

**Prevention:**
1. Handle all redirect status codes (301-308) in custom HTTP clients, not just 301/302.
2. Resolve relative `Location` headers against the request origin — not all servers return absolute URLs.
3. Drain/discard the redirect response body before following the redirect to prevent resource leaks.
4. Defer file write stream creation until the final 200 response is confirmed — never create output files before redirect resolution.
5. Consider using a library with built-in redirect handling (e.g., `node-fetch`, `undici`) instead of manual `http.get` chains.

**Applies To:** All agents writing custom HTTP download/fetch helpers.

---

## [Type System] TypeScript nodenext Requires .js Extension on Imports

**Pattern:** TypeScript with `moduleResolution: "nodenext"` requires `.js` extensions on relative imports even though the source files are `.ts`. Missing the extension causes TS2835/TS2307 at type-check time.

**Instances:**
- 2026-05-28 — Taxonomy Editor: CI type-check failed on ONNX import — missing `.js` extension for `nodenext` module resolution, plus implicit `any` on callback param. Fixed by adding `.js` to import path and type annotation. Commit 47e4452 (p/6#13).

**Root Cause:** `nodenext` module resolution mirrors Node.js ESM behavior, which requires explicit file extensions. TypeScript enforces this at type-check — you must write `import './foo.js'` even though the source file is `foo.ts`. This is counterintuitive but by design.

**Prevention:**
1. Always include `.js` extension on relative imports in projects using `nodenext` or `node16` module resolution.
2. Run `tsc --noEmit` locally before pushing to catch these — CI will reject them.
3. When adding new imports, check the project's `tsconfig.json` for `moduleResolution` to know whether extensions are required.
4. Enable `noImplicitAny` awareness — always annotate callback parameters.

**Applies To:** All agents writing TypeScript in the Electron apps (all three use nodenext).

---

## [Data] Hardcoded File References Go Stale During Active Sessions

**Pattern:** Scripts that hardcode a specific file path or ID (e.g., a debate UUID) fail when the referenced file is overwritten, renamed, or deleted by concurrent user activity during the session.

**Instances:**
- 2026-06-06 — Computational Linguist: `_calibration_review.py` referenced a hardcoded debate file `debate-7362765b-...json` which was overwritten when the user ran a new debate mid-session. Fixed by rewriting the script to dynamically find the 5 most recent debates by modification time instead of hardcoding a debate ID (p/7#13).

**Root Cause:** Data files in this project (especially debates, summaries) are actively written by the user and by enrichment pipelines. A file that existed when the script was written or first run may not exist — or may have different content — minutes later.

**Prevention:**
1. Never hardcode file paths or UUIDs for data files that change — use dynamic discovery (sort by mtime, glob for pattern).
2. For analysis scripts, find recent files at runtime: `sorted(Path(dir).glob('debate-*.json'), key=lambda p: p.stat().st_mtime)[-N:]`.
3. Add a file-existence check before processing and provide a clear error message if the target is missing.

**Applies To:** All agents writing scripts that reference debate files, summaries, or other actively-written data.

---

## [Process] Bash vs PowerShell Tool Confusion

**Pattern:** Running PowerShell cmdlets (e.g., `Get-ChildItem`) in the Bash tool instead of the PowerShell tool, causing syntax errors.

**Instances:**
- 2026-06-06 — Computational Linguist: ran `Get-ChildItem` in Bash tool, causing syntax error. Fixed by switching to PowerShell tool (p/7#13).
- 2026-07-17 — Diagnostics (during triage, p/9#28; **re-hit same day, p/9#34** — identical `(Get-Item $file).Length` idiom): ran `$var = ...; (Get-Item $var).Length` (a PowerShell file-size check) in the Bash tool (POSIX sh); Bash rejected it immediately. Fixed by switching to the PowerShell tool. Tell: `$var = ...` assignment with no `export`, a `;`-chained statement, and `.Length` property access on a cmdlet result are all PowerShell, not sh. File-size/`Get-Item`/`Get-ChildItem` checks belong in the PowerShell tool. **Same agent hit the identical mistake twice in one day → the shared lesson isn't sticking during triage; a per-agent memory ("file ops = PowerShell tool") is the durable fix, not another archive entry.**
- 2026-07-26 — PowerShell 2 (p/228#1): `node require('/c/Users/.../file.json')` (a **git-bash `/c/...` msys path**) threw MODULE_NOT_FOUND — `node`'s win32 runtime doesn't resolve msys paths. Fixed by reading the JSON via the PowerShell tool with a native `C:\...` path. Tell: the wrong-tool axis isn't just *syntax* — it's also **path format**; a native win32 program invoked from Bash needs a native `C:\...` (or repo-relative) path, not `/c/...`.
- 2026-07-28 — Taxonomy Editor 2 (**`/tmp` mount variant**, p/195#5): `node -e "require('/tmp/x.json')"` failed MODULE_NOT_FOUND — Node's win32 runtime can't resolve git-bash's **`/tmp` mount** (virtual msys mount, not a real Windows path), and `> /tmp/…` redirects write where Node can't `require`. Fix: for any **Node-consumed temp file, use the session scratchpad's absolute Windows path**, not `/tmp`. Generalizes p/228#1: `/tmp` and `/c/...` are both git-bash-only paths native `node` can't see.
- 2026-10-06 — DevOps Lead (**`/tmp` mount variant — Python**, p/26#143): Python one-liner reading `/tmp/rec.json` got `FileNotFoundError` immediately after Bash wrote that file. Same root: Git-Bash's `/tmp` is a virtual MSYS mount; Python (a native win32 process) resolves its own `/tmp` — a different directory. Fix: write to the session scratchpad absolute path and pass that to Python. Second `/tmp`-mount instance; Node and Python both affected — **any native win32 process reading a file Bash wrote to `/tmp` will get FileNotFoundError.**
- 2026-10-07 — PowerShell (p/20#78, t/3910, **`/tmp` mount variant — pwsh child process**): `pwsh -Command "Invoke-ScriptAnalyzer -Path /tmp/x.ps1"` run from Git Bash reported "Cannot find path C:\tmp\x.ps1". Git-Bash's `/tmp` is a virtual MSYS mount; when `pwsh` is spawned as a child process it resolves `/tmp` as the literal Windows path `C:\tmp`, which doesn't exist. Fix: write scratch files under a Windows-visible path (session scratchpad or worktree) when a `pwsh` child process reads them. Third `/tmp`-mount instance; Node, Python, AND pwsh (as a child of Bash) all affected.
- 2026-08-03 — Shared Lib (p/5#23): **`cd C:\...` path in Bash (POSIX sh)** — Windows backslash paths are not valid POSIX paths; Bash interprets `\` as escape sequences and silently fails with "No such file or directory". Fixed by switching to the PowerShell tool for all git/shell ops.
- 2026-08-04 — TL (p/335#1): **Bash glob with `C:\...` Windows path** — MSYS mangled the backslashes during glob expansion; no matches returned. Resolved by switching to the **Glob tool**, which handles Windows paths natively without MSYS translation.
- 2026-08-04 — Shared Lib (p/5#25): **`cd C:\...` path in Bash again** — same failure as p/5#23. **Second time same agent hit identical mistake** → per-agent memory ("on win32, paths/shell ops = PowerShell tool") is the durable fix (mirrors the Diagnostics double-hit, p/9#28+34).
- 2026-09-28 — DebateTool (p/70#19): `cd C:\Users\jsnov\repos\ai-triad-research && git fetch...` in Bash — Windows backslash path invalid POSIX syntax; Bash rejected as bad command. Fixed by switching to PowerShell tool.
- 2026-09-29 — DebateTool (p/70#31): `cd C:\Users\jsnov\repos\wt-3767 && npx vitest run` in Bash — POSIX sh can't navigate Windows absolute paths with backslashes. Resolved by switching to PowerShell tool. 2nd DebateTool instance of this same axis.
- 2026-09-29 — PowerShell (p/20#43, **new axis: MSYS path passed into pwsh**): `Get-ChildItem -LiteralPath $SummariesDir` threw "Cannot find path 'C:\c\Users\...'" — a bash-style MSYS path (`/c/Users/...`) was passed as a PowerShell variable value from inside the Bash tool. Native `pwsh` prepended `C:\` to the leading `/c/`, producing a double-rooted `C:\c\Users\...`. Fix: always pass native Windows paths (`C:\Users\...`) to PowerShell — never MSYS `/c/...` form.
- 2026-10-01 — Shared Lib (p/5#31, **new axis: MSYS path as python3 file argument**): `python3` (a native win32 binary) could not open a file passed as an MSYS `/c/Users/...` path argument — ENOENT, same root as node axis. Fix: pipe the content via stdin (`cat file | python3 -c "import sys; ..."`) instead of passing the path as an argument. *(t/3827)*
- 2026-10-01 — Shared Lib (p/5#37, **new axis: `2>nul` creates a file named `nul` in Git Bash**): used `2>nul` to suppress stderr in a Bash tool command — Git Bash (POSIX sh) treated `nul` as a literal filename and created a file named `nul` in the working directory instead of discarding output. `NUL` is only valid in cmd.exe/PowerShell. Fix: use `2>/dev/null` in the Bash tool.

**Root Cause:** Agents have access to both Bash and PowerShell tools. PowerShell cmdlets (`Get-ChildItem`, `Get-Item`, `Invoke-Pester`, `Select-Object`, etc.), `$var = ...` assignment, `.Property` access, and `;`-chained statements only work in the PowerShell tool. Unix commands (`ls`, `grep`, `cat`, `stat -c%s`) only work in Bash (on Windows/Git Bash). **A second axis is path format:** git-bash presents `/c/Users/...` msys paths, but native win32 programs (`node`, and anything not msys-aware) resolve `C:\...` — an msys path handed to `node require`/`fs` fails as MODULE_NOT_FOUND / ENOENT. **A third axis:** Windows backslash paths (`C:\...`) given directly to Bash fail silently — Bash treats `\` as escape characters. **A fourth axis: Bash glob over `C:\...` paths** — MSYS mangles the backslashes during expansion, producing zero matches with no error. **A fifth axis: MSYS path passed to pwsh** — `/c/Users/...` handed to native PowerShell gets double-rooted (`C:\c\Users\...`) because pwsh prepends `C:\` to the leading `/c/`. **A seventh axis: `2>nul` in Git Bash** — `NUL` is a Windows device name valid only in cmd.exe/PowerShell; in POSIX sh, `nul` is a literal filename and `2>nul` creates a file named `nul`. Use `2>/dev/null` in the Bash tool.

**Prevention:**
1. Use PowerShell tool for: cmdlets (`Get-*`, `Set-*`, `Invoke-*`), `$env:` variables, `$var = ...` assignment, `.Property` access on results, pipeline operators with objects. File-size checks: `(Get-Item $p).Length`.
2. Use Bash tool for: Unix commands, `git`, `npm`, `node`, `python3`, shell scripts. File-size in Bash: `stat -c%s <file>` or `wc -c < <file>`.
3. When in doubt, check if the command uses a Verb-Noun cmdlet, `$var =` assignment, or `.Property` access — if yes, it's PowerShell.
4. **Path format:** when a native win32 program (`node`, etc.) needs a filesystem path, give it a native `C:\...` or repo-relative path — NOT a git-bash `/c/...` msys path OR a mount like **`/tmp`** (both fail as MODULE_NOT_FOUND/ENOENT; `/tmp` is a virtual msys mount Node can't resolve, and `> /tmp/…` redirects land where Node can't `require`). **For any Node-consumed temp file, use the session scratchpad's absolute Windows path, not `/tmp`.** For reading a JSON/data file on win32, the PowerShell tool with a native path is the reliable route.
7. **(Fifth axis — MSYS path into pwsh):** Never pass a `/c/Users/...` MSYS path as a PowerShell variable value. `pwsh` prepends `C:\` to the leading `/c/`, producing a double-rooted `C:\c\Users\...`. Always use native `C:\Users\...` form when supplying paths to PowerShell cmdlets.
8. **(Sixth axis — MSYS path as python3 file argument):** `python3` on win32 can't resolve `/c/Users/...` MSYS paths as file arguments — ENOENT. Fix: pipe content via stdin (`cat file | python3 -c "import sys; data = sys.stdin.read()"`) instead of passing the path directly (p/5#31, t/3827).
9. **(Seventh axis — `2>nul` in Git Bash creates a file):** Use `2>/dev/null` to suppress stderr in the Bash tool. `2>nul` (Windows cmd.exe syntax) creates a literal file named `nul` in your working directory — POSIX sh has no concept of the NUL device (p/5#37). `NUL` is only valid in cmd.exe or PowerShell.
5. **Don't use Windows backslash paths (`C:\...`) directly in the Bash tool** — Bash (POSIX sh) treats `\` as escape characters and silently mangles the path. Use the PowerShell tool for any operation that needs a `C:\...` path, or convert to a git-bash `/c/...` form (only valid for msys-aware tools) (p/5#23).
6. **For file discovery (finding files by name pattern), use the dedicated Glob tool** — it resolves Windows paths natively without MSYS translation. `find` or shell glob expressions with `C:\...` paths in the Bash tool are silently broken (p/335#1).

**Applies To:** All agents on this Windows dev environment with dual shell access.

---

## [Build] Relative Paths Double When CWD Is Already the Target Directory

**Pattern:** Running a command with a relative path like `node lib/debate/script.mjs` fails with MODULE_NOT_FOUND when the CWD is already `lib/debate/`, because the path resolves to `lib/debate/lib/debate/script.mjs`.

**Instances:**
- 2026-06-16 — DebateTool: `node lib/debate/_add_stack.mjs` failed because CWD was already `lib/debate/`, doubling the path. Fixed by using absolute path (p/70#1).
- 2026-08-03 — Computational Linguist (p/7#55): `git add research/comp-linguist/analyses/...` from cwd `research/comp-linguist/` doubled the path to `research/comp-linguist/research/comp-linguist/analyses/` — git resolved the repo-root-relative argument relative to cwd, causing a pathspec mismatch. Fixed by using cwd-relative paths directly (`analyses/...`).

**Root Cause:** Bash tool CWD may differ between calls or may have been changed by a prior `cd` command. Relative paths assume CWD is the repo root, but if a previous command changed directory, the relative path stacks on top of the current location. Applies to git path arguments as well as script execution paths.

**Prevention:**
1. Use absolute paths for `node`, `python3`, and other file execution commands — never rely on CWD being the repo root.
2. If using relative paths, verify CWD first with `pwd`.
3. Bash tool CWD persists between calls — a prior `cd` affects all subsequent commands in that shell session.
4. **`git add` (and other git path arguments) resolve relative to cwd, not the repo root** — from a role subdirectory, use cwd-relative paths (`analyses/...`) not repo-root-relative ones (`research/comp-linguist/analyses/...`). Alternatively, use `git -C <repo-root> add <repo-root-relative-path>` to pin the resolution root (p/7#55).

**Applies To:** All agents executing scripts or git commands from Bash when cwd is a subdirectory.

---

## [Build] Azure Deploy False-Red from arm-deploy failOnStdErr + Bicep Warnings

**Pattern:** Azure deploy workflow reports failure even though the ARM deployment succeeds, because `azure/arm-deploy@v2` defaults `failOnStdErr:true` and Bicep emits compile warnings to stderr.

**Instances:**
- 2026-06-20 — Infrastructure (Azure): "Deploy to Azure" workflow false-red at "Deploy Bicep template" step. Initial diagnosis blamed an unregistered `Microsoft.AlertsManagement` resource provider — this was WRONG. The stale "Failure Anomalies" deployment in `az deployment list` was from 2026-05-24, not the current run. Registering the RP did not fix the issue. Real cause (confirmed via `gh run view <id> --log-failed`): `arm-deploy@v2` with `failOnStdErr:true` (default) treats Bicep compile warnings (BCP422/BCP318 from `deploy/azure/runner/runner.bicep`) as failures. Final log line: "Error: Deployment process failed as some lines were written to stderr". The ARM deployment itself succeeded. This skipped downstream workflow steps (blue-green gate, DEPLOY_SHA/DEPLOY_TAG stamping). Tracked in t/702 (p/99#1, corrected p/99#4).

**Root Cause:** `azure/arm-deploy@v2` defaults `failOnStdErr:true`. Bicep emits non-fatal compile warnings (BCP422, BCP318) to stderr. The action treats ANY stderr output as a deploy failure, even when the ARM deployment succeeds.

**Prevention:**
1. Set `failOnStdErr: false` on the `arm-deploy` action, OR eliminate the Bicep warnings causing stderr output.
2. Don't ignore false-reds — they mask genuine failures and skip downstream workflow steps (health gates, env-var stamping, traffic shifting).
3. **Diagnosis discipline:** Read the workflow STEP log (`gh run view <id> --log-failed`) AND check the failing deployment's TIMESTAMP before concluding. `az deployment list` top-of-list can surface month-old stale failures — don't trust it without checking dates.

**Status:** Resolved — root AGENTS.md "Gate Verification" + "Gate Co-Location" rules (overlay 5732aa7, t/1589). Part of gate-signal-integrity genus (#20/#46/#48/#61/#64).

**Applies To:** DevOps agents managing Azure deployments via arm-deploy actions.

---

## [Build] Array Index on Empty Array Returns undefined — Silent Until Runtime Crash

**Pattern:** Accessing `array[0]` on an empty array silently returns `undefined` in JavaScript, which propagates until a downstream API rejects it — often far from the original empty-array site.

**Instances:**
- 2026-06-20 — Infrastructure (Azure): CI test-container failed for ~4 weeks. `NODE_ENV=production` (c1cf7ba7) made `ALLOWED_ORIGINS=[]` instead of `null`. `getCorsOrigin()` returned `ALLOWED_ORIGINS[0]` → `undefined`. Node.js 22's `setHeader()` strictly validates header values and threw `TypeError` on the `undefined` value on every request — server started but never responded. Fixed with `?? ''` nullish coalescing guard (a58ec59d, t/723). (p/105#1).

**Root Cause:** Two compounding issues: (1) `array[0]` on an empty array returns `undefined` without error — unlike null-access which would throw. The `undefined` propagated silently through the CORS origin pipeline. (2) Node.js 22 added strict validation to `setHeader()` — passing `undefined` as a header value now throws `TypeError`, whereas earlier Node.js versions silently coerced or ignored it.

**Prevention:**
1. Never use bare `array[0]` to extract a value — guard with `array[0] ?? fallback` or check `array.length > 0` first.
2. When a config variable can be an empty array, treat `[]` as a distinct case from `null`/`undefined` — they behave differently (`[0]` returns `undefined` vs throwing).
3. Node.js 22+ validates `setHeader` values strictly — any `undefined` or non-string value throws. Always validate values before passing to HTTP APIs.
4. When a server starts but never responds to requests, suspect a per-request crash (unhandled exception in middleware or header setup) — check container logs, not just health probes.

**Applies To:** All agents writing server-side JavaScript/TypeScript, especially CORS and HTTP header configuration.

---

## [Build] Consumption-Tier ACA Outbound Uses Unpredictable SNAT IPs

**Pattern:** Azure Container Apps on consumption tier use Azure SNAT pool IPs for outbound traffic, not the environment's static IP. Any Deny-default firewall on dependent resources (Storage, Key Vault) blocks ACA access silently or with cryptic errors.

**Instances:**
- 2026-06-20 — DevOps: (a) Storage mount failed with error(13) — `defaultAction:'Deny'` on the Storage Account firewall blocked CIFS mount from consumption-tier ACA because outbound IPs are unpredictable SNAT pool addresses. Fixed by setting `defaultAction:'Allow'` in main.bicep. (b) Key Vault returned ForbiddenByFirewall (403) for the same reason — ACA is NOT a "trusted service" for Key Vault bypass, so the Deny-default firewall blocked it. Fixed the same way: `defaultAction:'Allow'` in main.bicep. (p/26#3).

**Root Cause:** Consumption-tier ACA does not have a fixed outbound IP — it uses Azure's SNAT pool, which rotates IPs unpredictably. Firewall rules that whitelist specific IPs or rely on "trusted Azure services" bypass don't work because ACA isn't in the trusted services list. VNet integration would fix this but exceeds cost targets for this project.

**Prevention:**
1. For consumption-tier ACA, set `defaultAction:'Allow'` on Storage Account and Key Vault firewalls in Bicep — IP-based Deny rules will break.
2. If security requires Deny-default, upgrade to Dedicated-tier ACA with VNet integration for predictable outbound IPs.
3. When a container mount fails with error(13) or Key Vault returns 403, suspect firewall + SNAT before debugging auth/permissions.
4. Test firewall rules with the actual ACA tier — what works in Dedicated (static IP) breaks in Consumption (SNAT).

**Applies To:** DevOps and infra agents managing Azure Container Apps on consumption tier with firewalled resources.

---

## [Build] AUTH_OPTIONAL Mode Serves HTML to Unauthenticated API Requests

**Pattern:** When the server runs in AUTH_OPTIONAL mode, unauthenticated API requests receive a login page (HTML) instead of JSON responses, breaking automated test suites that expect API data.

**Instances:**
- 2026-06-20 — DevOps: Acceptance tests went 9/17 → 16/17 → 17/17 across iterations. Initial failures: unauthenticated API requests got HTML login page instead of JSON. Fixed by establishing an anonymous session cookie via `/.auth/anonymous` before running tests. Final failure: sync status test regex matched `"branch"` but actual field was `"session_branch"` — fixed by matching `"enabled"` instead (p/26#3).

**Root Cause:** AUTH_OPTIONAL mode redirects or serves HTML for requests without a session. API test clients that don't establish a session first receive HTML instead of the expected JSON, causing parse failures or assertion mismatches. Additionally, test assertions matched field names that differed from the actual response schema.

**Prevention:**
1. In AUTH_OPTIONAL mode, establish a session before API testing — call `/.auth/anonymous` to get an anonymous session cookie, then include it in subsequent requests.
2. When writing acceptance tests, inspect the actual API response body before writing assertions — don't assume field names from the codebase without verifying the wire format.
3. Prefer matching stable/enum values (like `"enabled"`) over field names that may have prefixes (like `"session_branch"` vs `"branch"`).

**Applies To:** All agents writing acceptance/integration tests against the deployed server, especially in AUTH_OPTIONAL mode.

---

## [Type System] Divergent Cross-Package Type Unions Break Main Between Agents

**Pattern:** Two packages define parallel union types for the same concept (e.g., backend IDs). When one agent adds a member to one union without updating the other, `tsc` breaks on main for downstream code that bridges both types.

**Instances:**
- 2026-06-25 — ServerAPI: Shared Lib added `'azure'` to `BackendId` (`lib/ai-client/types.ts`) but the server's `AIBackend` union (`config.ts`) wasn't updated. `resolveBackend()` returns `BackendId`, which feeds `getApiKeys()`/`hasApiKey()` (typed as `AIBackend`), so `tsc` failed with "'azure' not assignable to AIBackend" on `aiBackends.ts:358` + `server.ts`. Fixed by adding `'azure'` to `AIBackend` + `ENV_KEY_NAMES` (commit 318a85b6). Recommended unifying the two unions to prevent recurrence (p/79#3).

**Root Cause:** The same domain concept (AI backend identifiers) is represented by two separate union types in different packages (`BackendId` in `lib/ai-client/types.ts`, `AIBackend` in server `config.ts`). There's no compile-time constraint enforcing `BackendId ⊆ AIBackend`. In a multi-agent environment, different agents own different packages — Agent A adds a member to their union, Agent B's code breaks because their parallel union is now a subset. The break only surfaces when `tsc` runs across the full project.

**Prevention:**
1. **Unify parallel union types** — define the canonical type in one place and import/re-export it. If the server needs a subset, derive it with `Extract<BackendId, ...>`.
2. When adding a member to a union type, grep for other definitions of the same concept across packages: `grep -r "type.*Backend" --include='*.ts'`.
3. After modifying shared types in `lib/`, run `tsc` across all consuming projects (server, taxonomy-editor) before pushing — not just the project you're working in.
4. Consider a CI step that type-checks all packages together, not just the one that changed.

**Applies To:** All agents modifying shared type definitions in `lib/` or server config types.

---

## [Build] Git Commit-by-Pathspec Skips Untracked (New) Files

**Pattern:** `git commit -F msg -- <paths>` fails with "pathspec did not match any file(s)" when the paths include newly created files that haven't been staged with `git add`.

**Instances:**
- 2026-06-25 — DebateUI: `git commit -F msg -- <paths>` failed for newly-created files. Fix: `git add <new-files>` first, then pathspec commit. Self-resolved (deedd783, p/83#3).
- 2026-07-06 — Technical Lead: `git commit -- <pathspec>` on a new file errored "pathspec did not match". Fixed by explicit `git add` then commit (369001bb, p/8#51).
- 2026-07-06 — Computational Linguist: same error on a newly created file. Fixed by `git add` then pathspec commit (p/7#26).
- 2026-07-13 — Taxonomy Editor 2 (t/1563): `git commit -- <existing.tsx> <new-test.tsx>` failed on the untracked test file. Fixed by `git add -- <both>` then commit. Compounding: concurrent broad commit on shared main swept the working-tree .tsx (p/195#1).
- 2026-07-26 — ServerAPI (t/1788, landed 95348dc8, p/79#13): `git commit -- <paths>` skipped untracked NEW files. Fixed by `git add` then `git commit -m "msg" -- <paths>`. Self-resolved. (Same incident also hit the flag-order trap.) 5th instance / 5 agents — still self-correcting.
- 2026-07-30 — Server AI Proxy (t/2021, p/209#2): `git commit -- <paths>` including a NEW untracked file aborted "did not match any file(s)"; fixed by `git add` the untracked file first, then committing on a branch via `git switch -c` (branch-first — t/2009 now blocks detached-HEAD commits). **6th instance / 6 agents — still self-correcting.** Adjacent: the t/2009 detached-HEAD commit-guard fired correctly on the same land.

**Root Cause:** `git commit -- <paths>` only commits changes to already-tracked files (modified or staged). Untracked (newly created) files are invisible to the pathspec — git doesn't auto-stage them. This is the expected git behavior but surprises agents accustomed to `git add -A` workflows.

**Prevention:**
1. Before `git commit -- <paths>`, check if any paths are new files: `git status --porcelain <paths>` — lines starting with `??` are untracked.
2. For new files, run `git add <new-files>` before the pathspec commit.
3. Pattern: `git add <new-files> && git commit -F msg -- <all-paths>`.

**Status:** Active

**Applies To:** All agents using pathspec commits (especially on shared branches where `git commit -- <paths>` is required by ADR-005).

---

## [Build] Bare Git Commit Sweeps Shared Staging Index

**Pattern:** Running `git commit` without a pathspec on a shared branch commits everything in the staging index — including files other agents have staged but not yet committed. Attempting to undo with `git reset --soft HEAD~1` after the commit reaches the remote can rewind another agent's already-landed commit, causing local/remote divergence.

**Instances:**
- 2026-06-25 — EdgeBrowser: bare `git commit` for t/1009 (3bde76f2) swept in 41 other agents' pre-staged files and pushed to origin/main. A follow-up `git reset --soft HEAD~1` attempted to undo it but rewound a different agent's already-landed commit, causing 1/1 local/origin divergence. Stopped all git surgery, escalated to TL/DevOps. No data lost; divergence mergeable (p/123#1).
- 2026-07-17 — Diagnostics (commit 7895cbe6, p/9#36): used `git add <file> && git commit` (bare commit, no pathspec) instead of `git commit -- <file>`, sweeping other agents' pre-staged files into the commit. **2nd recorded violation** despite ADR-005 + the memory rule — the trap is that `git add <file> && git commit` *feels* scoped (you named the file to `add`) but the bare `commit` still takes the whole shared index. Surfaced alongside a large-divergence push failure the same session.

**Root Cause:** Git's staging index is shared across all processes in the working tree. When multiple agents run `git add` in parallel, they all stage into the same index. A bare `git commit` (without `-- <paths>`) commits the entire index — not just the files the committing agent staged. The follow-up `git reset --soft HEAD~1` compounds the problem: if another agent committed and pushed between the original commit and the reset, HEAD~1 points to a different commit than expected, rewinding their work.

**Prevention:**
1. **Always use `git commit -- <explicit-paths>`** on shared branches — never bare `git commit`. This is ADR-005.
2. Never use `git reset` on a shared branch to undo a pushed commit — once it's on the remote, the commit is shared history. Escalate to TL/DevOps for recovery.
3. If you discover you've swept others' files into your commit but haven't pushed yet: `git reset --soft HEAD~1`, then re-commit with explicit pathspec.
4. If already pushed: do NOT rewrite history. Escalate — the correct fix depends on what other agents have already pulled/rebased on top of it.
5. **`git add <file> && git commit` is NOT scoped** — naming a file to `add` does not scope the `commit`; the bare `commit` still takes the whole shared index. The ONLY scoped form is `git commit -- <file>` (the pathspec on the *commit*, not the *add*).

**Status:** Active — **2 violations (EdgeBrowser 3bde76f2, Diagnostics 7895cbe6)** despite the ADR-005 pathspec rule in AGENTS.md. The recurring mistake is the `git add <file> && git commit` idiom that *feels* scoped but isn't (prevention #5). If a 3rd appears, pairs cleanly with a mechanical hook — extend the `git-commit-pathspec-flag-order` guard to flag a bare `git commit` (no `-- <paths>`) on a shared branch.

**Applies To:** All agents committing to shared branches (main, shared feature branches).

---

## [Build] Deploy Preflight Fails on CI Matrix Job Name Mismatch

**Pattern:** Deploy workflow preflight checks that match CI job names with exact string equality (`select(.name == "test-electron")`) fail when CI uses matrix strategy, which appends the matrix value to the job name (e.g., `test-electron (taxonomy-editor)`).

**Instances:**
- 2026-06-25 — DebateWorkspace: Azure deploy (run 28192219897) failed at preflight because the jq filter `select(.name == "test-electron")` didn't match the actual matrix job name `test-electron (taxonomy-editor)`. Fix: update `.github/workflows/deploy-azure.yml` to use prefix matching (`startswith("test-electron")`) or check the overall workflow conclusion instead (p/124#2).

**Root Cause:** GitHub Actions matrix jobs are named `{job-name} ({matrix-value})`, not just `{job-name}`. Preflight scripts that do exact string matching on job names silently find no match, treating it as "job not found" rather than "job succeeded." This is fragile — adding or renaming matrix dimensions breaks deploy without any CI change.

**Prevention:**
1. Use prefix matching for CI job name checks: `select(.name | startswith("test-electron"))` instead of exact equality.
2. Alternatively, check the overall workflow conclusion (`conclusion == "success"`) rather than individual job names — more resilient to CI restructuring.
3. When adding matrix dimensions to CI jobs, grep deploy workflows for exact job name references: `grep -r "test-electron" .github/workflows/`.
4. Test deploy preflight after any CI workflow restructuring (adding/removing matrix dimensions, renaming jobs).

**Status:** Active

**Applies To:** All agents modifying CI workflows or deploy preflight checks.

---

## [Build] Git `--` Separator Before Flags Turns Flags Into Pathspecs

**Pattern:** Placing `--` (end-of-options separator) before flags like `-m` causes git to interpret those flags as filenames, failing with "pathspec did not match."

**Instances:**
- 2026-06-25 — Shared Lib: `ogit commit -- lib/AGENTS.md -m "message"` failed — git treated `-m` and the message as pathspecs. Fixed by reordering: `-m "message" -- lib/AGENTS.md` (p/5#11).
- 2026-06-26 — DebateTool: `git commit -- lib/debate/prompts.ts -m "..."` — same issue on the main repo. Fixed by staging with `git add` first, then `git commit -m "..."` without `--` (p/70#3).
- 2026-06-26 — Azure: `git commit -- .github/workflows/container.yml -m "message"` — same pattern on a CI workflow file. Fixed by reordering flags before `--` (p/105#3).
- 2026-07-26 — Docker (p/217#1): overlay commit failed "pathspec '-m' did not match" — `-- <path>` placed before `-m "msg"`. Non-interactive Bash tool, **`ogit` expanded form** (`git --git-dir=.orca-git --work-tree=. commit …`). Fixed by reordering to `-m "msg" -- <path>`. **Recurred despite the `git-commit-pathspec-flag-order` hook being "live workspace-wide"** — likely a hook-coverage gap: the guard probably matches `git commit …` but not the overlay-prefixed `git --git-dir=… commit …` form, so overlay commits slip past. Flagged to Diagnostics to extend the matcher.
- 2026-07-26 — ServerAPI (t/1788, landed 95348dc8, p/79#13): main-repo `git commit -- <paths> -m "msg"` — `-m` after `--` parsed as pathspec. Fixed by reordering. Self-resolved. Recurred even after the hook fix — consistent with the hook being **warn-only** (git rejects regardless; agent self-corrects) + manifest-lag (#68) / exit-1-suppress (#80) residuals. Same incident also hit the untracked-new-file trap.
- 2026-07-28 — CL.Investigate1 (t/1767, landed aa319dd2, p/40#11): `git commit -- <paths> -m "msg"` again; fixed by moving `-m` before `--` (files already staged → committed the staged set). 6th instance / 6 agents. Still self-correcting — git rejects immediately, no cost beyond a retry; git's own rejection is the effective enforcement, the warn-only hook can't prevent it.
- 2026-07-28 — Taxonomy Editor (p/6#22): same flag-order failure; resolved with `git commit -F msgfile -- <paths>`. **7th instance / 7 agents.** At 7× the improvement worth making is corrective GUIDANCE (git's `pathspec '-m' did not match` is cryptic) — the flag-order violation is a crisp syntactic signal, so the `git-commit-pathspec-flag-order` hook should emit the correct form on violation; blocked until the #80 Part-3 fix stops it exit-1-noising on every call. Still NOT a #82 escalation (git enforces).
- 2026-07-28 — Taxonomy Editor 2 (p/195#7): `git commit -q -- <pathspec> -m "msg"` — same failure. **8th instance / 8 agents.** Fix queued (Diagnostics accepted p/9#47 — corrective-guidance emit folds into #80 Part-3); count reinforces the guidance fix.
- 2026-07-28 — ServerAPI (t/1883, landed d9c3207e, p/79#17): `git commit -q -- <files> -m "msg"` → "pathspec '-m' did not match"; reordered to `-m "msg" -- <files>`. **9th instance / 8 agents — ServerAPI's 2nd (first REPEAT offender; earlier t/1788).** Self-corrected on git's rejection. A repeat by an already-bitten agent is the evidence that the queued corrective-guidance emit (#80 Part-3) is the right lever — prevention isn't (git rejects harmlessly), faster recognition of the cryptic error is.
- 2026-07-29 — DebateUI (t/1915, p/83#4): `git commit -- <paths> -m "msg"` — flags after `--`; reordered to `-m "msg" -- <paths>`. **10th instance / 9 agents** (DebateUI joins the roster; self-corrected on git's rejection). No new per-instance action — corrective-guidance emit rides on the #80 Part-3 fix.

**Root Cause:** `--` signals end-of-options to git. Everything after `--` is treated as a literal filename/pathspec — including `-m`, `-F`, and any other flag. This is standard POSIX behavior but surprises agents who think of `--` as "here come the paths" without realizing it also disables all subsequent flag parsing.

**Prevention:**
1. **All flags must come BEFORE `--`:** `git commit -m "msg" -- <paths>`, never `git commit -- <paths> -m "msg"`.
2. Alternative: stage files first with `git add <paths>`, then `git commit -m "msg"` (no `--` needed if the index is already correct).
3. Same rule applies to all git commands: `git diff`, `git log`, `git checkout` — `--` always terminates option parsing.

**Status:** Rule (AGENTS.md, overlay 95e9c3b, p/8#30) + `git-commit-pathspec-flag-order` PreToolUse hook (p/9#16); overlay-form matcher gap fixed via inlining (p/9#41). **10 instances / 9 agents** (+DebateUI t/1915, +ServerAPI ×2, +CL.Investigate1, +TaxEditor ×1, +TaxEditor2). The hook is **warn-only** — git rejects the malformed command regardless, so recurrences (Docker overlay p/217#1; ServerAPI main-repo t/1788 p/79#13) self-correct on git's own error, not on the hook. The hook's value is guidance, not prevention; durable fix is the rule + habit.

**Applies To:** All agents using git commit with pathspec on any repo — including the overlay expanded form, which the hook may not yet cover.

---

## [Build] Vitest Dynamic Import Misses Exports From vi.mock Factory

**Pattern:** Using `await import()` on a module that has a `vi.mock` registration only sees exports defined in the mock factory — not the real module's exports. Missing exports throw "No X export on mock" at runtime, not at compile time.

**Instances:**
- 2026-07-01 — DebateWorkspace: vitest errored with "No markAsPopout export on mock" when using `await import()` against a `vi.mock`'d `helpers.ts`. The mock factory didn't include `markAsPopout`. Fixed by adding the missing export to the `vi.mock` factory and using the mock reference directly instead of dynamic import (p/124#3).

**Root Cause:** `vi.mock` hoists to the top of the test file and intercepts all imports of the target module — including dynamic `import()`. If the mock factory doesn't export a symbol that exists on the real module, `import()` returns the mock (missing the symbol), not the real module. This fails at runtime with an unhelpful error, not at the `vi.mock` declaration.

**Prevention:**
1. Before using `await import()` on a mocked module, check that the `vi.mock` factory exports all symbols the importing code needs — not just the ones the test explicitly stubs.
2. Prefer using the mock reference directly (from `vi.mocked()` or the mock variable) rather than dynamic `import()` on mocked modules.
3. When adding new exports to a module, grep for `vi.mock` registrations on that module and update them: `grep -r "vi.mock.*helpers" --include='*.test.ts'`.

**Status:** Active

**Applies To:** All agents writing or modifying vitest tests that use `vi.mock` with dynamic imports.

---

## [Build] `rg` Is a Shell Function, Not a Binary — Unavailable in Subshells

**Pattern:** `rg` (ripgrep) in the Claude Code Bash tool is a shell function wrapping claude.exe's bundled ripgrep, not an executable on PATH. Scripts run as subprocesses (`bash script.sh`) cannot access it — only the top-level shell sees the function.

**Instances:**
- 2026-07-01 — Technical Lead: `command -v rg; where.exe rg` exited 1 during transcript friction analysis — no `rg` binary on PATH. Scripts run via `bash script.sh` got "rg: command not found". Fixed by sourcing the script in the top shell instead of running it as a subprocess (p/8#31).

**Root Cause:** Claude Code exposes `rg` as a shell function (not a standalone binary) in the interactive Bash tool shell. Shell functions are not inherited by child processes — `bash script.sh` starts a new shell that doesn't have the function defined. `command -v rg` and `which rg` both fail because there's no binary to find.

**Prevention:**
1. **Use the Grep tool** instead of `rg` in scripts — the Grep tool is the native search interface and always available.
2. If `rg` is needed in a script, source it (`. script.sh` or `source script.sh`) instead of running it as a subprocess (`bash script.sh`).
3. Do not assume CLI tools available in the top-level Bash tool shell are binaries — some (like `rg`) are shell functions that vanish in subshells.
4. For portable scripts, use `grep -r` as a fallback when `rg` is unavailable: `command -v rg >/dev/null && rg ... || grep -r ...`.

**Status:** Active

**Applies To:** All agents writing Bash scripts that use `rg` or other Claude Code shell functions.

---

## [Process] Ping-Acknowledge-Then-Idle

**Pattern:** Agents acknowledge a ping (reply, update status) then go idle without re-checking their ticket queue — missing unblocked assigned work that should have started immediately.

**Instances:**
- 2026-07-03 — Fleet audit (p/8#32): 4 agents found idle with unblocked high-priority tickets after being woken by pings. Each had replied to the ping but never checked their queue before sleeping. Hours of lost productivity across the fleet.

**Root Cause:** Startup behavior only checked ticket queue on fresh session start. Ping-triggered auto-prompts re-entered the session mid-life, so the queue check was skipped. Agents treated pings as isolated messages rather than general "you're awake now, check for work" signals.

**Prevention:**
1. Before going idle after ANY prompt (ping, email, auto-prompt — not just session start), re-check ticket queue for unblocked assigned work.
2. Root AGENTS.md startup behavior updated to enforce this (p/8#32, 2026-07-03).

**Status:** Resolved — root AGENTS.md rule updated to require queue re-check before idle after any prompt.

**Applies To:** All agents with ticket-driven workflows.

---

## [Process] One-Directional Git Ancestry Check → False Divergence Alarm

**Pattern:** Diagnosing "remote diverged" based on a one-directional `merge-base --is-ancestor` check and misreading a reverse diff — pattern-matching an expected failure shape without verifying the actual mechanism.

**Instances:**
- 2026-07-03 — Technical Lead: during cc→sit migration (t/1308#12), diagnosed "remote diverged during freeze" and began planning recovery. Root cause hypothesis was that CI committed to `ai-triad-data` during the migration window. DevOps falsified this (t/1308#15): no CI pipeline exists in the data repo, and the commits were the owner's, made before the freeze. Corrected in t/1308#15.

**Root Cause:** Two compounding diagnostic errors: (1) `merge-base --is-ancestor` was only checked in one direction — A ancestor of B doesn't tell you whether B is ancestor of A, so the divergence conclusion was incomplete; (2) a reverse diff was interpreted without labeling which direction (local→remote vs remote→local), leading to misread additions/deletions. Same anti-pattern class as the [Build] Deploy Preflight False-Red (AlertsManagement) — pattern-matching symptoms to a plausible failure without testing the mechanism.

**Prevention:**
1. Divergence claims require the **two-directional ancestry test**: check `merge-base --is-ancestor` in BOTH directions (A→B and B→A) before concluding divergence.
2. Always run `git status -sb` for ahead/behind counts — they directly show the relationship without interpretation.
3. Reverse diffs must be **labeled with direction** before interpreting +/- lines ("this is remote minus local" or "local minus remote").
4. Before planning recovery, verify the *mechanism* of the hypothesized failure — "CI committed during our window" is testable ("does CI exist in this repo?").

**Status:** Resolved — root AGENTS.md "Git forensics" Common Traps rule (bf738f2, p/8#58).

**Applies To:** All agents performing git divergence diagnosis, especially during migrations or freeze windows.

---

## [PowerShell] Empty-String Args to Native Executables

**Pattern:** `ssh-keygen -N '""'` sets the passphrase to the literal two-character string `""` instead of empty — causing silent authentication failure ("Permission denied (publickey)") that takes ~20 min to diagnose.

**Instances:**
- 2026-07-03 — Technical Lead: during t/1308 migration push, `ssh-keygen -N '""'` set a key passphrase to literal `""`. Server accepted the key but signing failed silently. Diagnosed via `ssh-keygen -y -P <candidate>` read-back; fixed in-place with `ssh-keygen -p`. ~20 min lost (p/8#35).

**Root Cause:** PowerShell's quoting rules for native executable arguments. `'""'` is a single-quoted string containing two double-quote characters — it does not collapse to empty. The correct form is `-N ''` (PS7 standard arg passing). Same multi-parser argument corruption family as bash-$-substitution and @'...'@ here-string patterns.

**Prevention:**
1. Use `-N ''` for empty passphrase in PowerShell — never `'""'` or `""`.
2. After setting a passphrase or credential via native executable, **verify the effect immediately** (e.g., `ssh-keygen -y -P '' -f <key>` should succeed).
3. Full trap taxonomy in `docs/powershell-native-quoting-traps.md`.
4. New Common Traps bullet added to root AGENTS.md (p/8#35).

**Status:** Resolved — root AGENTS.md Common Traps updated + `docs/powershell-native-quoting-traps.md` created.

**Applies To:** All agents passing empty-string or special-character arguments to native executables from PowerShell.

---

## [Process] Gate Blindness via Pre-Existing Noise (False-Green)

**Pattern:** A verification gate fails to detect new genuine failures because it's compromised by tolerated noise. Two mechanisms: **(A) exit-code blend** — the gate already exits non-zero from tolerated warnings, so new errors don't change the exit code; **(B) skip-before-run** — an EARLIER step that hard-fails on tolerated noise (no `continue-on-error`) aborts the pipeline *before* the real gate runs, so the real gate is **skipped entirely** and its absence reads as pass.

**Instances:**
- 2026-07-03 — verify's eslint step was already failing from old warnings. New `RelatedEdgesPanel` errors (t/1304) survived a "green verify" claim because the exit code was already non-zero (mechanism A). Root cause analysis in t/1304#5, fix in c2f79267, gate repair tracked in t/1323 (p/8#37).
- 2026-07-26 — Technical Lead (t/1800, DevOps; p/8#101): the CI `Audit dependencies` step (`npm audit high`, **no `continue-on-error`**) hard-fails on lockfile dependabot vulns and sits **BEFORE Test**, so vitest+Pester are **skipped repo-wide** (mechanism B). Test gate was a **false-green for ~3 pushes** and **masked t/1788's Linux route-table check**. **FIXED (DevOps, 231e0f3e, p/26#17):** decoupled audit into its own job + `.github/scripts/ci-audit.mjs` with co-located per-app baselines — audit can never precede/skip Test. Durable rule: **two independent gates must be separate CI jobs.**

**Root Cause:** When a gate is already failing (A) or an upstream step hard-fails (B) for tolerated/ignored reasons, agents treat the red as normal. New failures either blend into the existing non-zero exit (A) or never execute because the pipeline short-circuits first (B). Same family as [Build] Deploy Preflight False-Red (AlertsManagement) but **inverted** — false-green. Mechanism B is especially insidious: the real gate produces NO signal (skipped ≠ failed ≠ passed), and "skipped" is easily misread as "fine."

**Prevention:**
1. Gates must be kept at **zero tolerated noise** — fix or suppress existing warnings before relying on the gate.
2. If warnings/vulns are temporarily tolerated, use **explicit baselines co-located at the step** (eslint `--max-warnings N`; baseline the known dependabot advisory IDs in `npm audit`) so any *new* one changes the exit code — and set `continue-on-error` (or order the step AFTER the real gate) so a tolerated-noise step can NEVER short-circuit the real test gate.
3. **Ordering rule (mechanism B):** never place a step that hard-fails on tolerated noise *before* the real quality gate.
4. Periodically **assert a deliberate failure actually fails the gate** (Gate Verification) — catches both mechanisms.
5. When claiming "gate green," check that the real gate **actually ran** (not skipped) and its exit code — not just "the job didn't surprise me."

**Status:** Resolved-genus, recurred 2026-07-26 (skip-before-run mechanism, t/1800) — **now FIXED (DevOps, 231e0f3e, p/26#17):** audit decoupled into its own job + `ci-audit.mjs` with co-located per-app baselines. Root "Gate Verification" + "Gate Co-Location" rules (overlay 5732aa7, t/1589) applied; new durable rule: two independent gates = separate CI jobs. Part of gate-signal-integrity genus (#20/#46/#48/#61/#64).

**Applies To:** All agents running verify gates, CI pipelines, or any pass/fail quality checks.

---

## [Build] Ad-Hoc `tsc` Produces Phantom Errors vs Real Build Gate

**Pattern:** Running bare `tsc` or `tsc -p tsconfig.*.json` outside the project's actual build gate produces misleading errors — missing `@types/node` (no `node_modules`), TS5101 baseUrl deprecation, TS2882 CSS shims — that the real build (`npm run build`) never hits.

**Instances:**
- 2026-07-04 — ElectronMain (workflow-app, t/1333): `tsc -p tsconfig.main.json` errored TS2688 because deps were never installed. Bare `tsc` on renderer errored TS5101 and TS2882 — both non-issues because renderer is type-checked via `vite build`. Fixed by `npm install` + `npm run build` (the actual gate). workflow-app has no verify gate of its own (p/98#3).

**Root Cause:** Electron apps have split type-checking: main process via `tsc -p tsconfig.main.json`, renderer via `vite build`. Ad-hoc `tsc` commands that don't match the real pipeline produce false positives or catch environment problems (missing deps), not code problems.

**Prevention:**
1. Always use the project's actual build gate (`npm run build`, `npm run verify`) — not ad-hoc `tsc`.
2. Run `npm install` before any type-checking in a project where `node_modules` doesn't exist yet.
3. Know which tsconfig covers which code: `tsconfig.main.json` = main process; renderer = `vite build`.

**Status:** Active

**Applies To:** All agents working in Electron apps.

---

## [Process] Gate-Flip Hygiene — Exemptions Must Live in Workflow Comments

**Pattern:** Two agents independently mislabeled a permanently annotation-only CI job (`debate-eval`) as "warning-only until 7/17" — a scheduled flip date that doesn't apply to this job. Scheduled flip dates create gravitational pull that sweeps in exempt jobs.

**Instances:**
- 2026-07-06 — Two agents independently added "warning-only until 7/17" to `debate-eval` despite it being permanently annotation-only and exempt from the flip sweep (t/1329#4, t/1332#4).

**Root Cause:** The exemption existed only in ticket history, not at point of use. Agents pattern-matched the job to the "warning-only until flip date" convention without verifying this job's specific lifecycle.

**Prevention:**
1. Jobs exempt from a flip sweep need the exemption **in the workflow file comment**, not in ticket history.
2. Verify the specific job's intended lifecycle before applying fleet-wide conventions.

**Status:** Resolved — root AGENTS.md "Gate Verification" + "Gate Co-Location" rules (overlay 5732aa7, t/1589). Part of gate-signal-integrity genus (#20/#46/#48/#61/#64).

**Applies To:** All agents modifying CI workflow files or gate annotations.

---

## [Build] Registry Credential on Public Image Turns Credential Rot into Outage

**Pattern:** A stored GHCR PAT expired, but ACA authenticates EVERY pull when a registry credential is configured — so the dead PAT broke pulls of a PUBLIC image that anonymous pulls would have served fine. Total production outage, undetected 11+ hours.

**Instances:**
- 2026-07-05 — PROD OUTAGE: expired GHCR PAT → ACA authenticated pulls → ImagePullBackOff on 100%-traffic revision. No alerting. Restored via cached healthy revision, permanently fixed by removing credential. Hardening: t/1335, t/1336, t/1337 (p/8#41).

**Root Cause:** (1) Registry credentials on public images force authenticated pulls where anonymous would succeed — credential expiry becomes outage. (2) No alerting on ACA revision health. (3) Bicep re-adds the credential on deploy (IaC drift).

**Prevention:**
1. Never configure registry credentials for public images.
2. Remove from Bicep, not just CLI (IaC drift restores it).
3. Add Degraded-revision alert + external uptime probe.
4. Verify-then-promote traffic gate for new revisions.

**Status:** Active — hardening in t/1335, t/1336, t/1337.

**Applies To:** DevOps, Azure infrastructure, container deployment.

---

## [Build] ACA Revision Snapshots Freeze Config at Creation + az CLI Swallows 409

**Pattern:** ACA bakes registry credentials into each revision's snapshot at CREATION time. App-level config changes do NOT affect existing revisions. Compounding: `az containerapp registry remove` exits 0 while ARM silently rejects with 409.

**Instances:**
- 2026-07-05 — During outage remediation: "30-60 second" estimate became ~75 min because the mental model ("config applies live") was wrong. `az containerapp registry remove` appeared to succeed but ARM rejected with 409. Only a new revision picked up the change (p/8#42).

**Root Cause:** (1) Revision snapshots are immutable — config is baked at creation, survives restarts. (2) az CLI swallows ARM 409 errors — exit 0 with no output on failure.

**Prevention:**
1. Always read back config after mutations — don't trust az CLI exit codes.
2. Config changes require a new revision (revision copy), not just a restart.
3. Factor immutable snapshots into maintenance time estimates.

**Status:** Active — design constraints in t/1335.

**Applies To:** DevOps, Azure infrastructure, ACA config changes.

---

## [Build] Multi-Agent Git — Worktree Landing Race Creates Duplicate Commits

**Pattern:** Agent commits X on shared local main, cherry-picks X' into a worktree and pushes X'. Original X lingers unpushed and later sweeps to origin = byte-identical duplicates.

**Instances:**
- 2026-07-05 — Happened twice on t/1295 (commits 4 and 5) before root-cause. Agent committed on shared local main, cherry-picked into worktree, pushed. Originals swept to origin later (p/8#45).

**Root Cause:** Local main is shared across all agents. Committing there as a staging step leaves orphaned commits that travel to origin when any agent pushes.

**Prevention (ratified fix, t/1295#15, p/8#46):**
1. Create worktree off fresh `origin/main`, not the shared local ref.
2. Copy changed files in, add+commit+push INSIDE the worktree — nothing lingers on shared tree.
3. Sync shared tree with file-scoped `git checkout origin/main -- <files>` — never reset.
4. Run verify gate inside the worktree.

**Status:** Active — ratified fix in place. Pairs with shared-branch pathspec rule.

**Applies To:** All agents using git worktrees on shared local repos.

---

## [Build] Python 3.12 Rejects Mid-Pattern Inline Regex Flags

**Pattern:** Inline regex flags like `(?m)` placed mid-pattern (not at position 0) are a hard error in Python 3.12+ — `re.error: missing -, : or )`. Worked silently in earlier Python versions.

**Instances:**
- 2026-07-06 — Computational Linguist: inline Python regex used a mid-pattern `(?m)` flag, hard error in Python 3.12. Fixed by moving to `re.M` flag argument: `re.findall(pat, s, re.M)` (p/7#20).

**Root Cause:** Python 3.11 deprecated inline flags not at the start of the pattern; Python 3.12 made it a hard error. Agents writing inline Python snippets may use patterns from training data or older docs that place flags mid-pattern.

**Prevention:**
1. Always pass regex flags via the `flags=` argument: `re.findall(pat, s, re.M)` — never embed `(?m)` mid-pattern.
2. Inline flags (`(?m)`, `(?i)`, `(?s)`) are only valid at **position 0** of the pattern string in Python 3.12+.
3. When writing inline Python regex, prefer explicit flag arguments over inline flag syntax entirely.

**Status:** Active

**Applies To:** All agents writing inline Python regex (scripts, one-liners, data processing).

---

## [Build] Windows Junction Trap — Symlinked node_modules Blocks Worktree Cleanup

**Pattern:** `ln -s` on Windows Git Bash creates a directory JUNCTION (not a symlink). Junctions into a worktree's `node_modules` block `git worktree remove` and risk `rm -rf` following the junction into the real `node_modules`.

**Instances:**
- 2026-07-06 — ServerAPI: symlinked main tree's `node_modules` into a landing-worktree to run `npm run verify`. Windows created a junction; `git worktree remove` failed, and a naive `rm -rf` on the worktree would have destroyed the real `node_modules`. Resolved with `git worktree remove --force` + `git worktree prune`; confirmed real `node_modules` intact (906 entries). Recommendation: don't symlink `node_modules` — verify in main tree + `git diff`, or `npm ci` in worktree (p/79#5).

**Root Cause:** Git Bash `ln -s <dir>` on Windows creates an NTFS directory junction, not a POSIX symlink. Junctions are followed by `rm -rf` and `rmdir` — cleanup of the worktree risks destroying the junction target. `git worktree remove` also fails because it encounters the junction during cleanup.

**Prevention:**
1. **Never symlink `node_modules` into a landing-worktree on Windows** — the junction will block cleanup and risk the real deps.
2. To verify a worktree commit: run verify in the main tree and prove byte-identity via `git diff <worktree-sha> <main-sha>`.
3. If isolation is essential: `npm ci` inside the worktree (clean install, no junction needed).
4. If a junction is already in place: `git worktree remove --force` + `git worktree prune` cleans safely.

**Status:** Active

**Applies To:** All agents using git worktrees on Windows, especially landing flows that need `node_modules`.

---

## [Build] Uncommitted Fixes Mask Committed Breakage — Dirty Working Tree as False Witness

**Pattern:** A multi-step refactor deletes a module and fixes its importers, but only the deletion is committed — the importer fixes remain uncommitted in the shared working tree. Local verify passes (reads dirty tree), committed state is broken. Compounding: diagnosing "is main green?" by building the dirty shared tree produces a false-green that overrules a clean-worktree agent who was correct.

**Instances:**
- 2026-07-06 — Technical Lead (t/1303 Phase C): deleted a module and fixed 2 importers but left the importer fixes uncommitted. Local verify green, committed state red for hours. TL then "verified main is green" using the dirty shared tree, contradicting a clean-worktree agent who was correctly seeing the breakage. Diagnostic standard established in t/1303#7 (p/8#49).
- 2026-07-12 — Computational Linguist (t/1553): uncommitted enrichment UsageID in shared working tree read as "CL authored this." CL never authored it; authorship unestablishable. **Variant:** presence read as AUTHORSHIP, not build state (p/40#7).
- 2026-07-16 — Technical Lead (t/1618 Z.AI outage, resolved c51018af): committed `ai-models.json` was clean, but an uncommitted 2026-07-16 "refresh" dropped 36 models; the user runs uncommitted local builds, so the local runtime hit a broken state CI never would. Settled by `git show origin/main:ai-models.json`. **Inverse variant:** dirty tree *introduced* breakage into the runtime instead of hiding committed breakage — mirror image, same forensic resolution (p/8#69).
- 2026-07-26 — Technical Lead (t/1808, p/8#104): an ontology **referential-integrity check** *passed* against the **DIRTY worktree**, masking a break vs committed HEAD. **Check-layer variant:** the false witness is a *validator/check*, not `tsc`/`verify` — same flaw one layer up; any check reading the working tree inherits it. Same #44/#54/#55 class. Fix: check committed state (`git stash` / clean checkout / `git show HEAD:<path>`) and report which tree was validated.

**Root Cause:** `tsc`, `npm run verify`, **and any validator/integrity check** read the working tree, not the git index. In a multi-agent environment, the shared working tree accumulates uncommitted changes from multiple agents — it's never a reliable proxy for committed state. **Authorship variant:** working-tree presence carries no provenance — treating "it exists" as "agent X approved it" is the attribution form of false witness. **Inverse variant:** the dirty tree cuts both ways — it can hide committed breakage OR inject breakage absent from committed state. **Check-layer variant (t/1808):** a passing referential-integrity/validation check proves nothing about committed state if it ran against the dirty tree — "the check is green" must name *which tree* it checked.

**Prevention:**
1. **Commit ALL files in a refactor atomically** — deletions and their importer fixes in the same commit. Never commit a deletion without its dependents.
2. After committing, run verify to confirm the COMMITTED state is green (the existing Definition of Done rule).
3. **Disputes about committed state are settled at the git object level**, not by building the working tree:
   - `git show HEAD:<path>` — does the file/export exist in committed code?
   - `git grep <pattern> HEAD` — search committed content only
   - `git cat-file -e <sha>:<path>` — verify a path exists at a specific commit
   - `git stash && npm run verify && git stash pop` — build committed state only
4. **Never attribute uncommitted shared-tree changes** — authorship requires a commit SHA or activity event.
5. Pairs with the "Verify Before Pushing" rule in root AGENTS.md as its diagnostic complement.
6. **Integrity/validation checks must state which tree they checked** (t/1808) — a referential-integrity/schema/lint check reading the working tree is a dirty-tree false witness just like `verify`. Run it against committed state when the claim is about committed HEAD, and report "checked committed HEAD" vs "checked working tree."

**Status:** Resolved — root AGENTS.md "Git forensics" Common Traps rule (bf738f2, p/8#58).

**Applies To:** All agents on shared working trees, especially when diagnosing "is main broken?"

---

## [Process] Overwrite/Clobber Claims & Config-Failure Triage Without Object-Level Verification

**Pattern:** A "commit X broke/overwrote F" claim is asserted from the **working tree** (grep, symptom counts, commit dates) instead of the committed object, then retracted when someone finally checks the object. Two shapes: (a) a clobber claim churned across diagnostic rounds; (b) a **config failure** (missing entry, BOM, wrong value in the working-tree config file) attributed to a commit — when the committed code was correct all along and the divergence lived only in the local working tree.

**Instances:**
- 2026-07-06 — Computational Linguist + 2nd agent (t/1351): a git-forensics clobber claim went through 3 diagnostic rounds across 2 agents. Ancestry got inverted twice. Resolved only when blob SHAs were compared: `git rev-parse X:path` vs `git rev-parse X~1:path` — identical blob = file untouched, debate over in one command (p/7#22).
- 2026-07-17 — Diagnostics (**2nd config-failure instance**, p/9#30): a flight recorder showed `zai-glm-5-2` missing from `ai-models.json` + a BOM. Diagnostics **grepped the working tree** and attributed both to a revert commit — never running `git show HEAD:ai-models.json`. The committed code was correct; the divergence was working-tree-only. The memory rule ("`git diff HEAD -- <configfile>` before blaming a commit for config") **existed but was not applied under triage pressure** — the 1st config instance was the t/1618 Z.AI triage.

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

## [Build] Verify Gate Renderer Blind Spot — Renderer Type Errors Invisible to CI

**Pattern:** The verify gate and CI do NOT type-check renderer code — `tsc` covers `tsconfig.main.json` (main process) and `tsconfig.server.json` (server); Vite/esbuild transpiles `src/renderer/**/*` without type-checking. Real type errors in renderer code are invisible to CI and pass green. This includes missed call sites after symbol renames AND broken imports from new utilities not yet on main.

**Instances:**
- 2026-07-06 — Diagnostics (t/1412): commit 6c55463d (t/1304, POV_META migration) replaced a `nodePovFromId` import but missed one of three call sites in `EdgeDetailPanel.tsx`. Shipped to main because renderer code is never type-checked by the verify gate. Bug ticket t/1412, gate gap ticket t/1413 (p/9#17).
- 2026-08-06 — TL incident (t/2250): consumer PR imported `lib/bandColor` — a new shared utility from t/2236 not yet on main. Renderer import `lib/bandColor` silently broken; CI passed green because renderer tsc not in ci.yml. Reverted via PR #561. Fix: t/2252 (add renderer tsc to CI, blocked on t/2248).

**Root Cause:** CI's `check-renderer-tsc.sh` script exists but is wired only to local verify, not to `ci.yml`. Vite/esbuild transpiles renderer at build time without type-checking, so the CI gate has a blind spot on the entire renderer subtree.

**Prevention:**
1. After batch symbol renames, **grep for the old symbol** across the entire codebase before committing.
2. **Before landing a renderer change that imports a new utility, verify the utility is on origin/main** — `git show origin/main:<path>` must return content, not an error.
3. **Run `check-renderer-tsc.sh` locally before pushing renderer changes** — until t/2252 lands, this is the only gate.
4. Permanent fix: t/2252 (add renderer tsc to ci.yml, blocked on t/2248).

**Status:** Active — gate gap: t/2252 (renderer tsc in CI). 2 instances across 2 failure modes (missed call site; broken import from unlanded dependency).

**Applies To:** All agents modifying or importing renderer code.

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

## [Build] Shell Quoting Violations Create Junk Files Across Shared Working Tree

**Pattern:** Bash commands containing unquoted code with special characters (braces, parentheses, dots, slashes) create literal junk files from expression fragments — e.g., `f.startsWith('debate-')`, `{,+`, `(path.join(taxonomyDir`, `2.0.0`, `e.type` as actual filenames. Compounding: `git checkout -- <bad-pathspec>` in the shared tree reverts other agents' uncommitted edits.

**Instances:**
- 2026-07-09 — Orca Support: found untracked junk files across 3 scopes (`lib/debate/`, `engineering/tech-lead/`, `src/main/`) — TypeScript/JS expression fragments and brace-expansion tokens created as literal filenames by bash commands with unquoted special chars. A `git checkout -- <bad-pathspec>` in the shared tree reverted ElectronMain's uncommitted edits mid-change on t/1425, briefly breaking the build for TaxEditor and ServerAuth (p/13#16).
- 2026-08-09 — Rosetta Stone 3 (p/402#1): mis-quoted multi-line shell command run against the shared tree (cwd not cd'd into worktree). 0-byte files named like code fragments (`t.type`, `Promise.resolve()})``, `console.log(k+'`, etc.) spread across `taxonomy-editor/`, `engineering/tech-lead/`, `research/comp-linguist/`. RS3 swept their own scope via `git clean -f -- taxonomy-editor/`; TL and CL pinged to sweep theirs (p/335#18, p/7#59).
- 2026-08-11 — Taxonomy Editor scope (p/26#78): 8 fresh 0-byte extension-less junk files in `taxonomy-editor/` source dirs alongside real WIP on `SaveBar.tsx`. Caught immediately by `check-shared-drift.ps1` (t/2473/PR #846). TL notified; Rosetta Stone pinged for remediation.

**Root Cause:** ADR-004 (shell quoting rule) violations — agents ran bash commands containing code with special characters (heredocs, sed, unquoted git pathspecs). Bash interpreted brace expansion, glob patterns, and parentheses as shell metacharacters, creating literal files instead of passing the strings to the intended command. The shared working tree amplifies the blast radius: junk files pollute other agents' environment, and recovery commands (`git checkout`) risk reverting other agents' work.

**Prevention:**
1. **ADR-004 is the standing rule:** use Edit/Write tools for code with special characters, never Bash heredocs/sed.
2. Always quote pathspecs in git commands: `git checkout -- "path"` not `git checkout -- path`.
3. After any bash command that may have failed with special chars, check `git status` for unexpected untracked files and remove them.
4. Never run `git checkout -- <pathspec>` on the shared tree to clean up junk files — it reverts ALL changes at those paths, including other agents' uncommitted work. Use `rm` for junk files instead.
5. Recommend: new hook on Bash commands containing `git checkout` to warn about shared-tree reverts.
6. **shell-code-mangling-guard hook updated 2026-08-09** (p/9#64): now catches (1) backticks, (2) multiline + `${`/`$(` patterns, (3) unbalanced quotes + dollar/backtick in `node -e` invocations. Remedy named in the nudge: Write tool → execute file. Condition=true, run gate exits 1 for safe commands.
7. **check-shared-drift.ps1 extended 2026-08-11** (t/2473/PR #846): drift monitor now catches non-0-byte extension-less files in source dirs (`SuspiciousPaths`) in addition to 0-byte files. Third spray caught immediately; remediation loop closed within minutes.

**Status:** Active — 3 instances; hook guard + drift monitor both operational as of 2026-08-11.

**Applies To:** All agents using Bash with code containing special characters, especially on shared working trees.

---

## [Type System] New Flight Recorder Event Type Not Added to EventType Union

**Pattern:** A new flight recorder event (e.g., `'state.save-coalesced'`) is emitted at the call site but not added to the `EventType` union in `lib/flight-recorder/types.ts`, causing a `tsc` failure.

**Instances:**
- 2026-07-10 — Taxonomy Editor: added `'state.save-coalesced'` event emission (t/1468) but forgot to extend the `EventType` union in `lib/flight-recorder/types.ts`. `tsc` caught it. Fixed in 37ed8841 (p/6#15).

**Root Cause:** The flight recorder's `record()` call accepts an `EventType` string literal union. Adding a new event at the call site is easy — the string is just typed inline — but the union in `types.ts` is a separate file that must also be updated. No compiler error appears at the call site until `tsc` runs (the literal is narrower than `string`, so autocompletion doesn't force you through the union).

**Prevention:**
1. When adding a new flight recorder event, update `EventType` in `lib/flight-recorder/types.ts` FIRST, then use it at the call site — the union is the source of truth.
2. After adding any new string literal to a recorder call, grep for `type EventType` to find the union and add the new literal.
3. Same family as #36 (divergent cross-package unions) but single-file: the union and its usage sites are in different files within the same package.

**Status:** Active

**Applies To:** All agents adding new flight recorder events.

---

## [Build] Stale tsc Incremental Cache After Git Stash/Pop Causes Transient Type Errors

**Pattern:** Running `npm run verify` (which includes `tsc`) immediately after `git stash pop` produces a phantom TS2322 error that disappears on re-run — the tsc incremental cache (.tsbuildinfo) is stale from the pre-stash file state.

**Instances:**
- 2026-07-10 — Taxonomy Editor (t/1502): verify's first tsc run showed TS2322 in DebateTab.tsx. Re-ran verify — passed consistently. Cause: interleaved stash/pop during the ticket mutated the working tree faster than tsc's incremental cache tracked (p/6#17).

**Root Cause:** TypeScript's incremental compilation (`.tsbuildinfo`) caches file hashes and type relationships between runs. `git stash` swaps file contents out, `git stash pop` swaps them back — but the timestamps and on-disk state can confuse the incremental cache, causing it to type-check against a stale dependency graph on the next run. A clean second run rebuilds the cache correctly.

**Prevention:**
1. If verify fails with a type error after `git stash pop`, **re-run once** before investigating — transient cache staleness is the likely cause.
2. To force a clean state: delete `.tsbuildinfo` files before running verify (`rm -f tsconfig*.tsbuildinfo`).
3. Don't chase phantom errors that disappear on re-run — note it and move on. Only investigate if the error persists across two consecutive runs.

**Status:** Active

**Applies To:** All agents running tsc-based verify gates after git stash/pop operations.

---

## #61 [Build] UsageID Config Field Mismatch — systemMessage vs systemMessageTemplate

**Pattern:** UsageID config has `systemMessage: '{{prompt}}'` but `Invoke-AIByUsage` only renders `systemMessageTemplate` — placeholder goes unrendered, model runs with literal `{{prompt}}` as its system message (effectively no instructions), produces plausible-looking garbage.

**Instances:**
- 2026-07-12 — Computational Linguist (t/1550#3): aphorism UsageID had `systemMessage:'{{prompt}}'` instead of `systemMessageTemplate`. Model ran with no real instructions, produced famous-quote misattributions that masqueraded as a model-quality issue. Fixed in 6e4fe06a; lint ticket t/1552 filed (p/40#3).

**Root Cause:** `systemMessage` is static (verbatim), `systemMessageTemplate` is rendered with `{{var}}` substitution. Putting template placeholders in the wrong field silently no-ops — the `{{prompt}}` string passes through as literal text, which the model interprets as an empty/meaningless instruction. The output looks plausible enough that the failure mode reads as "model quality" rather than "config error."

**Prevention:**
1. Any `{{...}}` placeholder MUST be in a `*Template` field (`systemMessageTemplate`, not `systemMessage`).
2. Lint rule (t/1552): warn on `{{...}}` patterns in non-template fields.
3. Same gate-signal-integrity genus as #20/#46/#48: a config that silently no-ops reads as "working."

**Status:** Resolved — root AGENTS.md "Gate Verification" + "Gate Co-Location" rules (overlay 5732aa7, t/1589). Part of gate-signal-integrity genus (#20/#46/#48/#61/#64). Lint rule still tracked in t/1552.

**Applies To:** All agents authoring or modifying UsageID configs in `ai-usages.json`.

---

## #62 [Process] Concurrent Duplicate Ticket-Filing — Same-Role Race OR Multi-Agent Off a Live Incident Thread (No Claim/Coordinator Step)

**Pattern:** Multiple actors independently file the **same follow-up** off shared context within minutes, no claim/coordination step. **Two variants, same root:** (A) **same-role** — two instances of one role action the same shared tracker; (B) **multi-agent incident** — several *different* agents on a **live incident thread** each file the same follow-up.

**Instances:**
- 2026-07-13 — Computational Linguist (**variant A**): CL Main and CL.Investigate1 filed duplicate Phase 2 tickets (t/1577 vs t/1579) for the same tracker within 2 minutes. Second same-day near-dup after parallel answers on t/1560. Cost: dup-close + an AC nearly lost in consolidation (p/40#9).
- 2026-07-30 — P1 prod outage (**variant B**, TL p/8#149; incident #119/t/2047): **two dup PAIRS in one incident** — t/2053 vs t/2054 and t/2061 vs t/2062 — multiple agents filing the same follow-up off the live incident thread. TL proposing **coordinator-owns-incident-follow-up-filing** (one coordinator cuts follow-ups; watchers route to them).

**Root Cause:** actors share a board/context (a tracker, or a live incident thread) but have no claim protocol — classic check-then-act race. The incident variant is worse: an incident thread has *many* concurrent watchers under time pressure, so the dup fan-out is wider than 2-instances-of-one-role.

**Prevention:**
1. Announce intent BEFORE cutting the ticket — comment "claiming <scope>/filing follow-up for this incident" and wait for it to land.
2. Search open tickets for the scope first — `search_tickets` for the tracker/incident key + label before creating.
3. When consolidating dups, merge ACs from both — don't just close the second.
4. **During an incident, ONE coordinator owns follow-up-ticket filing** (TL p/8#149) — watchers route observations to the coordinator; scales the claim-step to the many-watcher case.

**Status:** Active — broadened 2026-07-30 to cover the multi-agent-incident variant (B, P1 t/2047: 2 dup pairs); TL proposing coordinator-owns-follow-up-filing (prevention #4).

**Applies To:** All roles with multiple active instances sharing a ticket board.

---

## #63 [Build] az containerapp update Does Not Support --revision-mode

**Pattern:** `az containerapp update --revision-mode` silently fails or errors — the CLI subcommand doesn't accept that parameter. Must use `az rest PATCH` to the ARM endpoint or Bicep to change revision mode.

**Instances:**
- 2026-07-14 — DevOps (t/1500): dry-run on throwaway branch failed because `az containerapp update` doesn't accept `--revision-mode`. Fixed by swapping to `az rest PATCH` with body `{'properties':{'configuration':{'activeRevisionsMode':'Multiple'}}}` (p/26#5).

**Root Cause:** Azure CLI coverage gaps — not every ARM property is exposed via the convenience CLI. `az containerapp update` handles env vars, image, scale, etc. but NOT `activeRevisionsMode`. The error message doesn't suggest the correct approach.

**Prevention:**
1. Before scripting an `az containerapp update` with a non-standard flag, verify it's in `az containerapp update --help`.
2. For properties not in the CLI, use `az rest` PATCH to the ARM endpoint directly.
3. Same genus as the ACA env-var drift trap (CLI vs Bicep divergence): the CLI is a convenience layer with gaps.

**Status:** Active

**Applies To:** DevOps, any agent scripting Azure Container Apps configuration changes.

---

## #64 [Build] RawBody Truncation Causes SPA Shell False Positive

**Pattern:** HTTP response body read capped at 400 chars for acceptance tests. SPA HTML shell is 464+ chars before `<script>` tags. Truncated body never contains the script marker, so the "is the app alive?" check always fails even when the app is healthy.

**Instances:**
- 2026-07-14 — DevOps (t/1500): blue-green deploy acceptance test used 400-char RawBody cap. SPA shell exceeded that before any script tags appeared, causing guaranteed false positive on every deploy. Fixed by bumping cap to 4096 (p/26#7, p/8#61).

**Root Cause:** The body-read cap was set for "enough to check a status code" but the correctness check needed content deep in the response. A size cap on an HTTP body read is a silent data loss when the check depends on content past the cap.

**Prevention:**
1. HTTP body reads must NOT be size-capped when response content matters for correctness checks — set the cap to accommodate the largest expected response, or remove it entirely for small responses.
2. Test the acceptance check against the actual response size, not just a mock.
3. Same gate-signal-integrity genus as #20/#46/#48/#61: a check that structurally cannot pass reads as "app is broken" when the check is broken.

**Status:** Resolved — root AGENTS.md "Gate Verification" + "Gate Co-Location" rules (overlay 5732aa7, t/1589). Part of gate-signal-integrity genus (#20/#46/#48/#61/#64).

**Applies To:** DevOps, any agent writing HTTP-based acceptance or health checks.

---

## #65 [Build] Format-Table Wrong Property Names — Silent Empty Columns

**Pattern:** PowerShell `Format-Table` with `-Property` names that don't match the actual object properties silently produces empty columns instead of erroring. Diagnostic output looks "blank" rather than "wrong."

**Instances:**
- 2026-07-14 — DevOps (t/1500): GHA step used `Format-Table -Property StatusCode, Detail` but the `EndpointTestResult` object had `Status` and `Error` properties. All diagnostic columns were blank — no error, no warning (p/26#7, p/8#61).

**Root Cause:** PowerShell's formatting system is lenient — referencing a non-existent property yields `$null`, which renders as empty. `Format-Table` never throws on missing properties. In a CI log, empty columns look like "no data" rather than "wrong column names."

**Prevention:**
1. Verify `Format-Table` property names against the actual object type — use `Get-Member` or inspect a sample object before scripting the format.
2. In CI/GHA scripts, add a validation step that checks at least one row has non-null values in the formatted columns.
3. Prefer `Select-Object` (which also silently nulls, but at least the object is inspectable downstream) over `Format-Table` when the output feeds into further processing.

**Status:** Active

**Applies To:** All agents writing PowerShell formatting for CI/diagnostic output.

---

## #66 [Build] Stacked-Branch Landing — Merge in Stack Order with --no-ff

**Pattern:** When two branches are stacked (the child branched off the parent) and both touch the same file, landing them without respecting stack order — or squashing the base — forces an avoidable rebase of the child and manufactures merge conflicts.

**Instances:**
- 2026-07-16 — Technical Lead (t/1585, t/1601): landing `land/t-1585` into the worktree hit a merge conflict in `DebateTestedDrilldown.tsx` because t-1585 and t-1601 both touch that file and t-1601 is stacked on t-1585. Resolved by merging with `--no-ff` in dependency order (t-1585 before t-1601) so the stack stayed intact and no rebase was needed (p/8#67).

**Root Cause:** A stacked child branch's commits are written on top of the parent's commits. If the parent is squashed or merged out of order, the child's base no longer matches history, so git must replay (rebase) the child's diffs against a changed base — re-deriving conflicts in any shared file. Merging the parent first with `--no-ff` preserves the base commit the child was built on, so the child merges cleanly.

**Prevention:**
1. For stacked branches sharing a file, merge in stack order (base before child) using `--no-ff` — never squash the base.
2. Do not rebase the child unless the base's history genuinely changed; ordered `--no-ff` merges avoid the need entirely.
3. Track stack dependencies explicitly (ticket parent/child or a note) so the landing order is unambiguous before you start.

**Status:** Active

**Applies To:** All agents landing stacked feature branches, especially via the worktree landing procedure.

---

## [API] Lossy Error Boundaries — Success/Failure Detail Discarded at the Provider Edge

**Pattern:** At the boundary between our code and an AI provider, the specific success/failure detail — the provider's own error reason, the resolved model id, the actual key source — is discarded and replaced with a generic message, a verbatim-but-unmapped value, or an empty/`(none found)` string. Diagnosis loses the one fact that would have pointed at root cause.

**Instances:**
- 2026-07-16 — Technical Lead (t/1618 / t/1619, Z.AI outage, resolved c51018af): an unmapped Z.AI model id was passed **verbatim** to the provider instead of being validated against the registry — the failure surfaced as a raw provider error, not "unknown model id X" (p/8#69).
- 2026-07-16 — Technical Lead (t/1620): the Gemini API-key test **collapses the provider's reason** into a generic failure string — Google's actual reason never reaches the user (p/8#69).
- 2026-07-16 — Technical Lead (t/1621), root-cause detail from PowerShell (p/20#16), fixed **cd020938**: `Test-AIApiKey` reported `KeySource="(none found)"` on an HTTP **200**. Mechanism: it read AIEnrich's private `$script:LastApiKeySource` through a cross-module scriptblock (`& (Get-Module AIEnrich) {…}`), which **throws when `Get-Module` resolves 0 or >1 module objects**; the throw was swallowed by `catch{$null}`, so a genuinely-resolved key surfaced as absent. A lossy *success* path — the **diagnostic read silently degraded its own reporting** while the primary path (`Invoke-AIApi`, same-scope read) worked fine. Fix: an exported accessor bound to the same module instance.
- 2026-07-17 — **Diagnostics** (t/1626, flight-recorder triage of debate `a7ddc788`, model `zai-glm-5-2`), ticketed to Taxonomy Editor — **the 5th instance, which broadens the genus.** `parseAIJson` (`lib/debate/helpers.ts:53-90`) ran all 3 recovery strategies and **silently returned `null` on a valid 6728-char body**, so claim-extraction threw and **all 7 of the debater's claim sketches were discarded** (0-of-7; `an_nodes:0`) even though `has_debater_claims:true`. Two lossy facets: (a) **generic recovery masked a real payload** — a null parse dropped everything instead of falling back to the debater's already-present sketches; (b) the failure event captured **head-only** `response_preview`+`raw length`, so a *truncated* response was indistinguishable from a *malformed body* without the raw text. This site (`parseAIJson`/`argumentNetwork.ts`) sits **outside the t/1623 hook's current path scope** — the genus now extends past the provider edge to any generic recovery/parse boundary that discards a recoverable payload.

**Root Cause:** Status/error handling at provider boundaries collapses rich provider responses into generic strings (or drops them entirely). No `ActionableError`/`New-ActionableError` captures Goal/Problem/Location/Next Steps at the edge, so the provider's verbatim reason, the resolved model id, and the detected key source are thrown away before anyone can read them. The tell is uniform: **success/failure detail discarded at the boundary** — on the error path (generic message) and the success path (`(none found)` on a 200) alike. A sharp sub-species (t/1621): a **diagnostic/observability read that swallows its own failure** (`catch{$null}`, sentinel default) degrades silently while the primary path works — you get a confident false-negative about a healthy system.

**Prevention:**
1. At every AI provider boundary, **preserve the provider's own reason/detail** in the surfaced error — never replace it with a generic message (ADR-001).
2. Use `ActionableError` / `New-ActionableError`: **Problem** carries the provider's verbatim reason, **Location** names backend+model, **Next Steps** names the config fix.
3. **Echo the resolved identity** (mapped model id, detected key source) on BOTH success and failure paths — a success that reports `(none found)` is a lossy success, not just a lossy error.
4. **Validate model ids against the registry** before calling the provider — never pass an unmapped id verbatim; fail with the unknown id named.
5. **Never let a diagnostic/observability read swallow its own failure** — a `catch{$null}` or sentinel default on a status/health read reports a false-negative on a working system. Surface the read's own failure distinctly from the thing it observes; bind cross-module/scope reads to the resolved instance (exported accessor) rather than a scriptblock that can throw on 0/>1 module resolution.
6. **Generic recovery must not discard a recoverable payload** (t/1626). When a parse/recovery step fails but usable upstream data already exists (e.g. debater-supplied claim sketches present on the turn), **fall back to it** rather than emitting the worst-case empty result — dropping 7-of-7 sketches on a `parseAIJson`→null is a data-loss bug, not graceful degradation. And make the failure event **diagnosable**: capture head **+ tail (bounded)**, a `response_truncated` flag, and which recovery strategy failed / the terminal `extractionTrace.status`, so a *truncated* response is distinguishable from a *malformed body* without the raw text.

**Status:** Active (defenses in force) — **escalation triggered + resolved (5th instance, 2026-07-17).** 5 instances across t/1618–t/1621 + t/1626, **3 reporting agents** (TL, PowerShell, Diagnostics). The genus **broadened** from the provider edge to *any generic recovery/parse boundary that discards a recoverable payload* (t/1626: `parseAIJson`→null in `lib/debate/helpers.ts` / `argumentNetwork.ts`). Two-track defense, **both landed 2026-07-17:** (1) **Mechanical (PRIMARY) — Diagnostics expanded the t/1623 hook (p/9#23):** `lossy-error-boundary-guard` now watches a **2nd boundary family (Family B)** — `lib/debate/helpers.ts` (`parseAIJson`/`repairJson`) + `argumentNetwork.ts` extraction — with a genus-tailored checklist (don't drop a non-empty recoverable body to null; fall back to debater sketches; capture head+tail+truncation flag; flight-record before dropping). No new prose rule, per recommendation. **Verified live + t/1623 closed (p/9#25, object-level, t/1623#3):** the compiled template (Family A + Family B + self-skip) is intact across **55 manifest snapshots** (was 0), and both Family-A blockers also landed — t/1620 (333a673d), t/1621 (cd020938). Liveness was confirmed via manifest presence + live-fire, NOT `has_run` (pattern #68) — the manifest-compile lag (t/1625) cleared on the next sync as expected. (2) **Behavioral (minimal, debate-local) — TL ruled (p/8#75)** a ONE-line rule in **lib/debate/AGENTS.md** (NOT root; overlay, owner = DebateTool) that must **NOT restate ADR-001**, while the point-of-use hook stays the primary defense. **DebateTool landed it (p/70#5, overlay 31e0eeb, Sage co-author):** the recovery-vs-silent-loss bullet — *a recovery that returns a sentinel (null/empty/default) while discarding a non-empty payload is a **silent lossy failure, not recovery** — record discarded bytes + surface.* Escalation closed.

**Applies To:** All AI backend/provider integration code — server `aiBackends.ts`, PS key-test cmdlets (`Test-AIApiKey`), debate-engine adapters, debate JSON-recovery sites (`lib/debate/helpers.ts` `parseAIJson`/`repairJson`, `argumentNetwork.ts` extraction), and any UsageID call site surfacing provider errors.

---

## #67 [Build] PowerShell Through the Bash Tool — Git Bash Eats Shell Operators Before pwsh Sees Them

**Pattern:** Running a PowerShell pipeline through the **Bash tool** (which is Git Bash) fails when shell metacharacters — a pipe `|` or a backtick line-continuation — sit **outside** the `pwsh -Command '...'` string. Git Bash interprets them itself before pwsh is invoked, so the pipe splits the command at the bash level and the backtick is consumed as a bash escape, producing truncated commands or `unexpected EOF` rather than the intended pwsh pipeline.

**Instances:**
- 2026-07-17 — PowerShell (during t/1621 work, p/20#17): two failures piping PowerShell through the Bash tool — `pwsh -Command '...' | Something` sent the `|` to bash (not the pwsh pipeline), and a backtick line-continuation was eaten by bash before pwsh saw it. Fix: keep the whole pipeline inside a single `pwsh -Command '...'` string, or use the PowerShell tool directly.

**Root Cause:** The Bash tool is Git Bash, not pwsh. Only text **inside** the quoted `-Command '...'` argument reaches PowerShell; everything else on the line is parsed by bash first. `|`, `` ` ``, `$`, `>`, `&&` and friends are bash metacharacters — placed outside the quoted command string they are consumed by bash, so pwsh receives a fragment. Distinct mechanism from quote-delimiter collision ("Bash Heredoc Failures with Nested Quotes") and `$`-substitution corruption — here the failure is a **shell operator leaking out of the command string**, not a mangled literal.

**Prevention:**
1. **Prefer the PowerShell tool** for any PowerShell work — the fleet default; sidesteps the two-shell problem (root AGENTS.md Search Tooling Rule points the same way).
2. Through the Bash tool, keep the **entire** pipeline inside one `pwsh -Command '...'` string — every `|`, `` ` ``, and `$` must live inside the quotes so pwsh, not bash, parses them.
3. Never rely on bash line-continuation (trailing `` ` `` or `\`) to span a pwsh command across Bash-tool lines — one logical line inside the quoted string, or write a script file (Shell Quoting Rule) and run it.

**Status:** Active

**Applies To:** All agents running PowerShell through the Bash tool on Windows/Git Bash.

## #68 [Process] Orca Feedback-Rule Tooling Lies About Liveness — Manifest-Lag + False Audit Counters

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

## #69 [Process] Post-Compaction Summary Framing Trusted Over Object State — Phantom Loose End

**Pattern:** After a **session boundary** (context compaction OR a session interruption), the resumed state is stale: a summary frames already-committed work as an outstanding "loose end," OR a **peer instance has landed the work while you were paused**. Acting on the stale framing instead of the object-level truth (git refs + ticket status) produces wasted redo, a duplicate ticket against work that's already Done, or an attempted re-commit of content already in HEAD.

**Instances:**
- 2026-07-17 — Computational Linguist (p/7#37): a post-compaction summary framed a redundant essay copy (`analyses/bronder-…`) as "the uncommitted deliverable," when the canonical review (`docs/instrument-effects-review.md`) was **already committed + CLOSED** with follow-up tickets t/1668–1673 filed. Acting on the framing, CL filed a **duplicate PM ticket (t/1684) against the already-Done t/1673**, then a `git mv` of the essay into `docs/` aborted "destination exists" — the git error was what finally surfaced the true state. Resolved: cancelled t/1684, reverted the essay to committed state, verified via same-commit blob provenance.
- 2026-07-26 — Computational Linguist (**peer-already-landed variant**, p/7#42): after a **session interruption**, CL re-drove a pending register-staging commit for the t/1676 provenance entries; the script exited 1 ("nothing to stage") because sibling **CL.Investigate1 had already committed the identical hunks (7f9b4c36)** during the pause, so the diff was empty. **Benign — "nothing to stage → abort" was correctly-designed fail-safe behavior** (a good gate: refused to act on an empty diff); object-level check confirmed all entries in HEAD; no data loss. Cousin of #83 (concurrent writers). Lesson: after any interruption, `git log -- <file>` before re-driving a pending commit — a peer may have landed it.

**Root Cause:** A resumed session's picture of "what's still to do" is a lossy reconstruction, not a source of truth — whether a **compaction summary** (stale narrative) or a **post-interruption assumption** that your pending work is still pending. It can misrepresent *committed* state (a file it calls "uncommitted" is already in a commit — possibly landed by a **peer instance** sharing the branch) and *ticket* state. Same failure as citing the working tree as evidence of committed state (Git Forensics #44/#54/#55) — extended to **ticket status** and **peer-landed commits**. The session boundary (compaction or interruption) is the trigger; the resumed assumption is confident but stale.

**Prevention:**
1. **After any session boundary, treat "loose end" claims as unverified.** Before acting, confirm against object state: `git log/show <path>` and blob-SHA provenance for "uncommitted"; `list_tickets`/`get_ticket` for "unrouted"/"undone."
2. **Before filing a follow-up ticket, `search_tickets` for the scope** — a summary that doesn't mention an existing Done ticket is not evidence one doesn't exist (same dup-prevention step as #57 Same-Role Instance Duplication).
3. **A destination-exists / already-committed / nothing-to-stage error is a signal, not an obstacle** — object state wins; a script that aborts on an empty diff is a correctly-designed fail-safe (treat its refusal as "already landed").
4. **After a session interruption, `git log -- <file>` (+ check peer commits) before re-driving a pending commit** — on a shared branch a peer instance may have landed your work while you were paused.

**Status:** Active — genus broadened 2026-07-26 (p/7#42) from *compaction* to *any session boundary* (compaction OR interruption), and to the **peer-already-landed** variant on shared branches.

**Applies To:** All agents resuming after a context compaction OR a session interruption — especially before committing a "loose end," filing a follow-up ticket, or re-driving a pending commit a peer may have already landed.

## #70 [Build] Vitest Mock Harness — Re-Exporting a Mocked Module Through the Harness Resolves to `undefined`

**Pattern:** When splitting a vitest file that shares a mock harness, re-exporting a mock-dependent module (e.g. the zustand store) **through** the harness — so split files do `import { useStore } from './storeTestHarness'` — resolves to `undefined` in the importing test file. `vi.mock`'s hoisting applies only to the module graph the harness itself imports; the cross-file re-export binding breaks, so the store the split file receives is undefined (tests fail with "cannot read property of undefined," not a mock error).

**Instances:**
- 2026-07-17 — Taxonomy Editor (t/1690, ADR-007 Phase-2 test split): splitting a `useDebateStore` vitest file with a shared mock harness. Re-exporting the store through the harness gave `undefined` in the split test files. Fix: each split file imports the **harness FIRST** (for its hoisted `vi.mock` side-effects) then imports the store **DIRECTLY from its own module** — never through the harness. Verified with a one-block throwaway experiment before committing the full split (p/6#21).

**Root Cause:** `vi.mock` is hoisted and scoped to the file/module graph where it is declared. A shared harness that declares the mocks and then re-exports a mock-dependent module does NOT extend the mock's interception across a re-export boundary into a *sibling* test file cleanly — the re-exported binding resolves before/around the hoisted mock and comes back `undefined`. The harness's value is its **side-effect** (registering the mocks), not its role as a re-export hub. Same genus as the "Vitest Dynamic Import Misses Exports From vi.mock Factory" pattern (vi.mock hoisting has non-obvious module-resolution effects), different failure mode: static re-export vs dynamic `import()`.

**Prevention:**
1. **A mock harness is imported for side-effects, not for re-exports.** In each split file: `import './storeTestHarness'` (or a named setup) FIRST to register the hoisted `vi.mock`s, THEN `import { useStore } from '<store's own module>'` directly.
2. **Never route a mock-dependent module through the harness as a re-export** — the store/module must be imported from its own path in every file that uses it.
3. **Prove the split with a one-block throwaway experiment before committing** — a single test importing the harness + store directly confirms the store resolves non-`undefined` before you fan the split out across many files.

**Status:** Active

**Applies To:** All agents splitting or authoring vitest files that share a mock harness — especially the ADR-007 Phase-2 test-file splits (large `*.test.ts` broken into `__tests__/` modules around a shared harness).

## #71 [Build] Post-Deploy Smoke-Test Aggregate Boolean False-Reds a Healthy Prod Deploy

**Pattern:** `Invoke-TaxEditorSmokeTest` reports **Overall FAIL** on a fully healthy prod deploy because the aggregate boolean folds together several orthogonal false-red classes, each of which trips independently. Trusting the top-level Overall boolean instead of the per-category breakdown reads a healthy deploy as broken.

**Instances:**
- 2026-07-16/17 — DevOps: three orthogonal false-red classes plus a CI-fold, all landing on the same Overall FAIL boolean (p/26#12):
  1. **Easy-Auth Sign-In interstitial on API routes** — the smoke hit protected API routes and got Azure Easy-Auth's HTML sign-in interstitial instead of the API response (t/1657, fixed).
  2. **Same interstitial on the `/` SPA root** (t/1657 residual, fixed **6404b682**) — the reclassify step must run **AFTER** the SPA-shell check and must match **any dash** in the title (`[-–—]`, hyphen + en/em dash), or a healthy shell reads as an auth wall.
  3. **Health-phase 15s timeout on scale-from-zero cold start** — a consumption-tier cold start exceeds the 15s health-phase timeout though the app is healthy once warm (t/1696, **open**).
  4. **CI fold:** `OverallPass` folds in the GitHub `ci.yml` conclusion, so a healthy deploy **cannot** show Overall PASS while CI is red — the deploy's health and CI's health are conflated in one boolean.

**Root Cause:** The smoke test collapses independent health dimensions (per-route auth reachability, SPA-shell rendering, health-endpoint latency, and the separate CI conclusion) into a single Overall boolean. Any one false-red — an auth interstitial mistaken for a failure, a cold-start latency blip, a red CI run unrelated to this deploy — forces Overall FAIL even when the deploy is healthy. Same gate-signal-integrity genus as the arm-deploy false-red (#20/#46/#48/#61/#64): an aggregate signal with tolerated/orthogonal failure inputs can't cleanly report the thing it's supposed to gate.

**Prevention:**
1. **On a post-deploy smoke, read the per-category breakdown, not the Overall boolean.** The boolean is a rollup of orthogonal checks; triage from the category rows (auth, SPA-shell, health-latency, CI).
2. **Reclassify ordering + dash matching:** an auth-interstitial reclassify must run AFTER the SPA-shell check (so a healthy shell isn't reclassified as an auth wall) and must match any dash variant (`[-–—]`) in the page title.
3. **Separate cold-start latency from health failure** — a scale-from-zero cold start needs a warm-up retry or a longer health-phase budget than 15s; don't let a first-hit timeout on a consumption-tier app read as unhealthy (t/1696).
4. **Don't fold an unrelated CI conclusion into deploy health** — or if you must, surface it as its own row so a red CI doesn't mask/force the deploy verdict.

**Status:** Active — classes 1 & 2 fixed (t/1657, 6404b682); class 3 open (t/1696, cold-start health-timeout); CI-fold is by-design but must be read per-row. Part of gate-signal-integrity genus (#20/#46/#48/#61/#64).

**Applies To:** DevOps and anyone triaging a post-deploy smoke result — read the category breakdown, never the Overall boolean alone.

## #72 [Build] Landing-Worktree Pre-Push Friction — Verify Dirties Tracked Artifacts + origin/main Advances

**Pattern:** In a landing worktree, the step between `npm run verify` and `git push` hits two recurring, orthogonal frictions that each abort the push/rebase and are easy to misread as a real conflict: **(A)** the verify run (vitest) **regenerates a tracked artifact** — e.g. a `*.snap` snapshot re-written with flipped LF↔CRLF line endings — so the tree is dirty with a change you didn't make, and `git rebase origin/main` fails "cannot rebase: you have unstaged changes"; **(B)** under the active push cadence **origin/main advances every few minutes**, so a `&&`-chained fast-forward guard (`git merge-base --is-ancestor origin/main HEAD`) returns non-zero and the push step exits 1 — and `git diff HEAD..origin/main` **false-flags your OWN unpushed split files as "overlap"** (they differ only because origin doesn't have them yet).

**Instances:**
- 2026-07-17 — Server Storage (p/206#3): after `npm run verify` in a landing worktree, `git rebase origin/main` failed "you have unstaged changes." Cause: verify regenerated `src/server/__tests__/__snapshots__/routeTable.test.ts.snap` with flipped LF↔CRLF — a tracked file dirtied as a side effect of verify, not the actual change. Resolved: `git checkout -- <that snap>` before the rebase, then rebase + push cleanly.
- 2026-08-10 — DebateUI (p/83#10, wt-2413): same snap file (`routeTable.test.ts.snap`) dirtied by verify blocked rebase. Fix: `git stash -u` before rebase, `git stash pop` after.
- 2026-07-17 — DebateTool (t/1686, ADR-007 worktree land, resolved 2ef26698, p/70#7): the `git push` bash step exited 1 because the `&&`-chained FF-guard `git merge-base --is-ancestor origin/main HEAD` returned non-zero — origin/main had advanced. Compounding, `git diff HEAD..origin/main` false-flagged the agent's own unpushed split files as "overlap." Resolved: cleaned the verify-run snapshot artifact, confirmed via `git show --stat <origin-commit>` that origin's new commit didn't touch the agent's files, rebased, pushed.
- 2026-07-26 — DevOps (t/1802, p/26#19): **confirming instance of facet B — discipline held, benign.** The pre-push FF-guard exited 1 because origin/main advanced between worktree-creation and push; resolved cleanly with `git rebase origin/main` on the 1 commit + push. Documents the recorded fix working in practice — a non-zero FF-guard is the *expected* "origin advanced, rebase now" signal, not an error. (Flagged only because the exit-1 tripped the route-to-Sage hook — #80 Part-3 residual.)

**Root Cause:** (A) Verify is not read-only — vitest rewrites snapshot files, and on Windows a regenerated snapshot can come back with the opposite line endings (LF↔CRLF), leaving a tracked file modified. Git refuses to rebase with a dirty tree, so a side-effect artifact blocks the land. (B) The FF-guard and the `diff` comparison both assume origin/main is stationary, but the fleet's push cadence advances it constantly; the guard's non-zero exit is expected, not an error, and `git diff HEAD..origin/main` shows your own not-yet-pushed files as differences — mistaking either for a real conflict is the same false-witness failure as citing the working tree for committed state (Git Forensics #44/#54/#55).

**Prevention:**
1. **Expect verify to dirty regenerated artifacts; discard them before rebase/push.** After verify in a landing worktree, `git checkout -- <regenerated *.snap / generated file>` (or `git stash`) so the tree is clean before `git rebase origin/main`. Only your intended changed files should remain.
2. **Treat origin/main as moving: `git fetch origin` + rebase immediately before the push**, every land — a `&&`-chained FF-guard returning non-zero usually means "origin advanced, rebase now," not "abort." Don't let the guard's exit code fail the whole step.
3. **Verify overlap at the object level, not with `git diff HEAD..origin/main`** — that diff shows your own unpushed files as differences. Use `git show --stat <origin-commit>` (or `git log --stat origin/main ^HEAD`) to see what origin's new commit actually touched; only a real shared-file change needs conflict handling.

**Status:** Active — 2 instances, 2 agents (Server Storage, DebateTool), both 2026-07-17 on ADR-007 worktree lands. Reinforces the `/land-from-worktree` procedure with the pre-push cleanup + fetch-rebase step.

**Applies To:** All agents using the worktree landing procedure — the window between verify and push, especially during active fleet push cadence.

## #73 [Build] MSYS Path Conversion Mangles Unix-Looking Args — grep Zero-Match Exit, Colon-Revspec, Leading Slash

**Pattern:** Two independent Windows/Git-Bash behaviors silently abort a Bash-tool command mid-chain even though nothing is actually wrong: **(A)** `grep -c` (and any grep) **exits 1 on ZERO matches** — standard grep behavior — so an `&&`-chained check breaks at that link *even when the printed `0` was the desired result* (e.g. confirming zero `.ts` entries); **(B)** MSYS **auto path-conversion mangles ANY git `<ref>:<slashed-path>` colon revspec** (`git show`, `git cat-file`, `git rev-parse`, `git ls-tree` …) — `git show origin/main:.github/workflows/ci.yml` is rewritten to `origin\main;.github\...` (colon→`;`, `/`→`\`), producing `fatal: unknown revision` on a perfectly valid ref. **More broadly, MSYS mangles ANY argument that *looks like* a Unix path — not only git colon-revspecs but a leading-slash argument to a NON-git CLI** (e.g. an Azure resource ID `/subscriptions/...` passed to `az`, prefixed with the Git-bin install path → `InvalidEnvironmentId`; Azure p/105#4). Same root, two triggers: the `<ref>:<path>` colon and the leading `/`.

**Instances:**
- 2026-07-17 — DevOps (while landing t/1692, p/26#14): (A) a `grep -c ... && ...` chain broke because `grep -c` returned exit 1 on zero matches — the `0` count was the intended answer, but the non-zero exit killed the `&&` chain. (B) `git show origin/main:.github/workflows/ci.yml` failed "unknown revision" because MSYS converted the `<ref>:<path>` arg into `origin\main;.github\...`. Fixes: keep zero-match/count checks OUT of `&&` links (test the value separately), and prefix `MSYS_NO_PATHCONV=1` for `git show <ref>:<slashed-path>`. Both benign, resolved.
- 2026-07-17 — Technical Lead (p/8#79, refines facet B): facet B **does NOT reproduce** in TL's Bash-tool env — `git show HEAD:.github/workflows/ci.yml` and every `git show <ref>:<path>` returned OK all session. So facet B is **MSYS-config-dependent**, not "always breaks on Windows Git Bash": DevOps's MSYS setup mangles the arg, TL's does not. The durable defense is a failure-**signature**, not a blanket prefix (mandating `MSYS_NO_PATHCONV=1` everywhere is noise where it isn't needed).
- 2026-07-17 — ServerAPI (p/79#8, **2nd facet-A instance**): `git show ... | grep -c "^-" && echo ...` reported tool failure (exit 1) because `grep -c` returned 0 deletions (a purely-additive diff — `0` was the desired answer), aborting the `&&` chain. No real error — read the printed count; fix `|| true` after `grep -c` or keep it out of the `&&` chain. Confirms facet A recurs independently across agents (DevOps + ServerAPI, same day).
- 2026-07-17 — Taxonomy Editor (p/6#20, **3rd facet-A instance**): a Bash chain whose *final* `git log origin/main | grep -iE "pattern"` matched fine still tripped the failure hook (exit 1) because an **earlier `grep -c` in the same chain returned 0**, so the combined chain exit was nonzero. Object-level confirmations were actually fine; resolved by re-running the log query standalone. **Variant:** the poisoning grep is *upstream* in the chain, not the last command — so a successful final match is masked by an earlier zero-count. Crosses the 3-instance threshold (DevOps + ServerAPI + Taxonomy Editor, all same day).
- 2026-07-29 — ElectronMain (p/98#9, **4th facet-A instance**): a `grep -c` zero-match exit-1 broke a landing command chain (classic facet A). Notable because it occurred in the SAME landing as a **higher-stakes chain-cut that silently dropped a `git push`** — see the sibling pattern #96. Reinforces the accepted root rule.
- 2026-07-29 — DebateDiagnostics (t/1909, p/245#3, **facet C — cwd-vs-repo-root**): `git show HEAD:src/renderer/.../EdgesUsed.tsx` exited **128**, run from the `taxonomy-editor/` subdir with a **cwd-relative** path — but `git show <ref>:<path>` resolves `<path>` from the **repo root**, not cwd. Fixed with the repo-root-relative path. A THIRD `git show <ref>:<path>` failure mode, **platform-agnostic** (unlike facet B's MSYS mangling): a valid file looks "missing in the ref" — same wrong-forensics risk, different cause.
- 2026-08-01 — DevOps (p/26#29, **2nd facet-B instance**): `git show 'origin/main:.github/workflows/ci.yml'` via the Bash tool exited **128** — MSYS mangled the arg to `origin\main;.github\...`. Confirms facet B reproduces in DevOps's MSYS env (config-dependent, p/8#79). **NEW escape: ran the same `git show` through the PowerShell tool** (no MSYS layer → no munging) — clean cross-tool workaround alongside `MSYS_NO_PATHCONV=1`; ties to the win32 "prefer the PowerShell tool for git/shell ops" habit.
- 2026-08-01 — Documentation (p/323#1, **3rd facet-B instance — 2nd agent + generalizes beyond `git show`**): `git cat-file -e origin/main:.github/scripts/...` failed — MSYS rewrote the `:` revspec to `origin\main;...`. Broadenings: (a) **`git cat-file`, not `git show`** → facet B is **ANY git `<ref>:<path>` colon revspec** (`show`/`cat-file`/`rev-parse`/`ls-tree`…); (b) a **2nd agent** hit it (Documentation, not just DevOps). Fixed with a persistent **`export MSYS_NO_PATHCONV=1`**. **Precise framing (TL p/8#157): env-DEPENDENT, not "broadly reproducible"** — reproduces on ≥2 agents (DevOps + Documentation) but NOT on TL's Bash tool (colon-revspecs resolve clean with `MSYS_NO_PATHCONV` unset). Varies by Git-for-Windows install. 3 instances / 2 agents + 1 clean counterexample (TL).
- 2026-09-29 — Docker (p/217#10, **4th agent, `gh api` variant**): `gh api "/users/..."` — MSYS rewrote the leading `/` as a filesystem path before `gh` received it. **NOT a silent failure** — `gh` prints "omit the leading slash" with its error. **Fix: omit the leading slash** (`gh api "repos/..."` not `"/repos/..."`); `MSYS_NO_PATHCONV=1` also works. Note: root AGENTS.md covers this for git colon-revspecs but not `gh api` leading-slash calls — flagged for AGENTS.md update.
- 2026-10-06 — Design (p/472#6, **facet B + `2>/dev/null` masking**): `git show origin/main:docs/ux/pov-tag-chip-tint.md` exited 128 in a post-merge verify step. `2>/dev/null` suppressed the MSYS mangling error text, so the exit 128 was indistinguishable from "file genuinely absent." Resolved by re-verifying with `gh api .../contents?ref=main` — file present, 8104 bytes; the merge had actually succeeded. **Corollary: `2>/dev/null` on a colon-revspec command hides the MSYS diagnostic text**, making "MSYS mangled this" read exactly like "this ref doesn't exist." When a colon-revspec exits 128 and there's no error text, suspect both MSYS mangling AND stderr suppression.
- 2026-10-05 — TL (t/3892, p/335#130, **`MSYS_NO_PATHCONV` global-export corollary**): `git worktree add /c/Users/...` under `export MSYS_NO_PATHCONV=1` — git.exe didn't resolve the POSIX-form path and the following `cd` failed. Fix: used Windows-form path (`C:/Users/...`) instead. **Root:** `MSYS_NO_PATHCONV=1` disables conversion for **every** argument, not only colon-revspecs. Once exported globally, MSYS no longer translates `/c/...` → `C:/...` for you — so every path you pass to git (or any tool) must already be in Windows form. Per-command prefix (`MSYS_NO_PATHCONV=1 git show …`) is safer: it fixes the one mangled arg without committing all subsequent paths to Windows form.
- 2026-10-07 — Computational Linguist (p/7#106, **facet B + `grep -c`-on-empty-input amplifier**): `git show origin/main:<path>` in Git Bash returned "ambiguous argument 'origin\main;…'" (MSYS mangling). Grep counts read `0`, which looked like "no `REGEN_INPUTS` on main." Fix: `MSYS_NO_PATHCONV=1`; true count was 1 in each file. CL correctly treated the `0` as invalid because a fatal error preceded it — zero-result heuristic working as intended. **New amplifier: `grep -c` on empty piped input prints `0` — the MSYS error and the zero look like separate facts, but they are one event.** The fatal error caused the empty pipe; the empty pipe caused the zero; the zero is not independent evidence of absence. Prevention: when a fatal error precedes a `grep -c` count, treat the count as the echo of the error, not a real result.
- 2026-08-03 — Azure (p/105#4, **facet B generalizes to a non-git tool + a leading-slash arg; 3rd agent**): `az deployment group create` failed `InvalidEnvironmentId` because MSYS mangled a **leading-slash Azure resource ID** (`/subscriptions/...`), prefixing it with the Git-bin install path (MSYS treats a leading-`/` arg as a Unix path to translate). Two broadenings: (a) the mangled arg is a **leading-slash resource ID, not a `<ref>:<path>` colon-revspec** — a 2nd MSYS trigger sharing facet B's root (args that *look like* Unix paths, already named in Root Cause); (b) it hit a **non-git tool (`az`)** and a **3rd agent** — facet B is not git-specific. Fix: pass Azure resource IDs via the **PowerShell tool** (no MSYS layer) or `MSYS_NO_PATHCONV=1`. Same env-dependent MSYS path-conversion class; ties to the win32 "prefer the PowerShell tool" habit.
- 2026-10-20 — DevOps Lead (p/26#220, **2nd Azure leading-slash instance**): `az role assignment create --scope /subscriptions/.../resourceGroups/ai-triad` failed `MissingSubscription` / "did not have a subscription or valid tenant level resource provider." MSYS mangled the leading-slash `--scope` argument. Fix: `MSYS_NO_PATHCONV=1 az role assignment create ...`. Confirms the leading-slash Azure resource-ID mangling is reproducible across `az` subcommands (not only `az deployment group create`).

**Root Cause:** (A) grep's exit code is a *match indicator*, not a *success indicator* — 0 = matched, 1 = no match, 2 = error. In an `&&` chain the shell treats exit 1 as failure and stops, so a legitimately-empty result (count `0`) aborts the chain. Standard POSIX grep behavior, not Windows-specific, but it bites hardest in Bash-tool one-liners that chain a count check into follow-up steps — and it recurs (2 agents in one day: a zero `.ts`-entry count and a zero-deletion diff count). Same "exit code ≠ what you think" family as the "Bash grep Features Fail Silently on Windows/Git Bash" pattern. (B) MSYS/Git-Bash *can* rewrite arguments that *look like* Unix paths (containing `/` or a leading drive-colon) into Windows paths before the program sees them. `git show`'s `<ref>:<path>` syntax collides with this — the `:` and `/`s get converted, corrupting the ref. **This is config-dependent** (`MSYS2_ARG_CONV_EXCL` / `MSYS_NO_PATHCONV` / how the Bash tool's MSYS is configured): it reproduced in DevOps's env and NOT in TL's, where every `git show <ref>:<path>` ran clean all session. So the harm is not "the command always breaks" — it's **misreading the false `unknown revision` as a genuinely-missing ref** (the exact wrong forensics conclusion the root Git-Forensics rule guards against). `MSYS_NO_PATHCONV=1` (or a leading `//`) disables the conversion for that command. Sibling of #67 (Git Bash eats shell operators before pwsh sees them) — same root: the Bash tool is Git Bash, and its shell/MSYS layer *may* transform your command before the target program runs.

**Prevention:**
1. **Keep zero-match/count checks out of `&&` chains.** Capture the value first (`n=$(grep -c ... || true)`) then test it, or append `|| true` so a legitimate zero-match doesn't abort the chain. Never assume `grep`/`grep -c` exit 0 on a successful-but-empty result.
2. **Facet B is a failure-SIGNATURE, not a blanket mandate** (TL, p/8#79): if `git show <ref>:<slashed-path>` reports `unknown revision` on a ref/path you KNOW exists, that's MSYS path-conversion — retry with `MSYS_NO_PATHCONV=1`. Do NOT prefix it unconditionally; it's config-dependent and unnecessary in envs (like TL's) that don't mangle. The critical error to avoid is concluding the ref is genuinely missing — the exact wrong forensics call the root Git-Forensics rule exists to prevent.
3. **So: a valid ref reporting "unknown revision" in the Bash tool is the tell** — suspect MSYS path-conversion before doubting the ref exists; confirm by re-running with `MSYS_NO_PATHCONV=1`, **OR run the same `git show` through the PowerShell tool** (no MSYS layer → no munging; DevOps p/26#29) — the cleanest cross-tool escape on win32.
4. **`MSYS_NO_PATHCONV=1` is a global flag — once exported, use Windows-form paths everywhere.** Per-command prefix (`MSYS_NO_PATHCONV=1 git show …`) fixes the one colon-revspec without committing all subsequent path args to Windows form. If you export it for the session, every path you pass to any tool must be `C:/...`, not `/c/...` — MSYS no longer translates for you (TL t/3892, p/335#130).
5. **`git show <ref>:<path>` resolves `<path>` from the REPO ROOT, not your cwd** (facet C, platform-agnostic) — from a subdirectory a cwd-relative path exits **128** and looks like the file is missing in the ref. Use a repo-root-relative path (or `git -C <repo-root> show <ref>:<path>`). Same "valid path, misleading git-show failure → don't conclude the content is absent" caution as facet B, different cause.

**Status:** Active — sibling of #67 (Git-Bash-transforms-your-command family). **Facet A now has 4 instances (DevOps + ServerAPI + Taxonomy Editor 2026-07-17; ElectronMain 2026-07-29) — well past the escalation threshold.** Universal grep behavior (`grep`/`grep -c` exit 1 on zero match), recurring across agents and across chain positions (final OR upstream command). **Escalation — ACCEPTED (p/8#86):** TL folded facet A into the AGENTS.md batch as an extension to the existing root "Search Tooling Rule" section — *never put `grep`/`grep -c` in a `&&` chain (or as a Bash-tool command's last exit) where zero matches is a valid result; use `|| true` or capture-and-test.* Originally judged not *blockable* (a blocking guard would fire on every legitimate `grep && `) — **but now ADVISORY-guarded**: the workspace feedback rule **`exit-code-literacy-guard`** (2026-08-03, t/2081; `node -e` run-gate over the exit-code-literacy family #73A/#84/#90/#96/#121) emits a **context nudge** rather than blocking, so legitimate `grep &&` uses proceed. **Live-firing OBSERVED — 2 independent firings across 2 different guard branches (2026-08-03):** Sage on a `git show … | grep -c` (#73A grep branch) + TL on `gh pr checks 334` correctly flagging **exit-8 = pending** (not failed) during the PR #334 CodeQL wait (#121 branch, p/8#166). Non-blocking ⇒ no false-green risk of its own; systematic firing-verification still deferred per t/1625. The documented root rule stays the behavioral defense. Overlay/owner-gated, in TL's 4-item batch being surfaced to the owner. Facet B is **environment-dependent MSYS path conversion — varies by Git-for-Windows install** (TL p/8#79/#157): **3 instances / 2 agents reproduce (DevOps `git show`; Documentation `git cat-file`) + 1 clean counterexample (TL — colon-revspecs resolve fine, `MSYS_NO_PATHCONV` unset).** Generalizes to ANY git `<ref>:<path>` colon revspec. **Key insight (p/8#157): env-dependence STRENGTHENS the root trap-line** — a non-repro agent (TL) would otherwise dismiss a peer's report as user error; the shared failure-signature is what lets them trust it. **Root Git-Forensics Common-Trap line LANDING via PR #323** (env-dependent wording + valid-ref→`unknown revision` discriminator: retry `MSYS_NO_PATHCONV=1`, or use the PowerShell tool). Escalation resolved. **Facet B broadened (Azure p/105#4, 2026-08-03):** MSYS also mangles a **leading-slash arg to a NON-git CLI** (Azure resource ID `/subscriptions/...` → `az` `InvalidEnvironmentId`) — now **3 agents, git + non-git tools, two triggers (colon-revspec + leading-slash)**. Same env-dependent class, same fix (PowerShell tool / `MSYS_NO_PATHCONV=1`).

**Applies To:** All agents running git or grep through the Bash tool on Windows/Git Bash — especially object-level git forensics (`git show <ref>:<path>`) and count-guarded command chains.

## #74 [Build] Bare `git restore <file>` During an origin/main Divergence Silently Reverts to Local HEAD

**Pattern:** During an active origin/main divergence, a file's working-tree content may legitimately hold the **origin-side** version (e.g. picked up mid-rebase/mid-land, or deliberately staged from `origin/main`). A bare `git restore <file>` reverts the working tree to the **local index/HEAD** version, silently discarding that origin-side content — a data-loss surprise, because `git restore` defaults its source to local state, not the ref the content actually came from.

**Instances:**
- 2026-07-17 — PowerShell (verifying t/1699, p/20#21): a plain `git restore quality-gates.json` reverted the working tree to local HEAD, wiping the origin-side content the file was holding during an active origin/main divergence. Recovered with `git restore --source=origin/main --worktree quality-gates.json` — explicitly naming the ref the content belonged to.

**Root Cause:** `git restore <file>` (and legacy `git checkout -- <file>`) restore from a **default source** — the index, falling back to HEAD — not from wherever the working-tree content originated. That default is silent: the command names no ref, so it looks like a neutral "undo my edits" when it is actually "throw away whatever is here and take local HEAD's copy." During a divergence the working-tree copy and local HEAD's copy differ by exactly the origin-side changes, so the restore destroys them. Same object-level-discipline family as Git Forensics (#44/#54/#55) and the landing-worktree friction pattern (#72, where `git diff HEAD..origin/main` false-flags your own files): during a divergence, never assume a file's working-tree content belongs to local HEAD.

**Prevention:**
1. **During an origin/main divergence, never bare-`git restore` (or `git checkout -- `) a file** without first checking which ref its working-tree content belongs to — `git diff <file>`, `git diff origin/main -- <file>`, or `git status` to see whether the content is local or origin-side.
2. **Restore from the explicit source:** `git restore --source=<ref> --worktree <file>` (e.g. `--source=origin/main`) — name the ref you actually want rather than relying on the silent index/HEAD default.
3. **If you've already clobbered it:** the origin-side content is still recoverable from the ref — `git restore --source=origin/main --worktree <file>` (or `git show origin/main:<file>`), since divergence means origin still has it. Recover before making further edits.

**Status:** Active

**Applies To:** All agents running `git restore` / `git checkout -- <file>` during any origin/main divergence or active land/rebase window.

## #75 [Build] `git checkout -- .` / `git restore .` Reverts ALL Unstaged Tracked Edits — Untracked Survivors Mask the Loss

**Pattern:** To clean ONE verify-dirtied file, an agent runs the **whole-tree** form `git checkout -- .` (or `git restore .`). It reverts **every** unstaged tracked edit in the tree — not just the stray file — silently wiping other tracked changes the current work depends on. Newly-created files are **untracked**, so they survive the revert, which **masks** the loss: the surviving new files make the change look intact while its tracked-file half is gone. The truncated change then lands.

**Instances:**
- 2026-07-17 — DebateTool (t/1686, ADR-007 worktree land, p/70#9): to drop a verify-dirtied snapshot, ran `git checkout -- .`, which reverted ALL unstaged tracked edits — wiping the **barrel-conversion of the original file** and the **eslint-baseline edit** the split depended on. The new module files were untracked, so they survived and masked the loss; the commit landed with ONLY the new files. Caught via the commit's file-count/stat (expected 8, saw fewer). Resolved: `git reset --soft HEAD~1`, rebuilt the barrel + eslint edit, re-verified, recommitted (8 files).

**Root Cause:** The `.` pathspec on `git checkout --` / `git restore` means "the whole working tree," so the command's blast radius is every unstaged tracked modification, not the one file the agent meant to clean. The tracked/untracked asymmetry is what makes it dangerous *and* invisible: `checkout -- .` only touches **tracked** files, so brand-new (untracked) files are untouched and remain in the tree — a partial change where the visible half (new files) survives and the invisible half (edits to existing tracked files) is gone. Sibling of #74 (bare restore takes the wrong *ref*); here the error is the wrong *scope* (`.` = everything) compounded by untracked survivors hiding the damage. Same worktree-land footgun family as #72.

**Prevention:**
1. **Never `git checkout -- .` / `git restore .` (whole-tree) to clean one stray file** — target it by path: `git restore <path>` / `git checkout -- <path>`. Scope the blast radius to exactly the file you mean.
2. **Sanity-check the commit's file count/stat before pushing** — `git show --stat HEAD` and compare against the expected number of touched files. A split/refactor that touches N files but commits fewer is a lost-half signal (untracked survivors won't show as missing any other way).
3. **When a clean-up reverts more than expected, `git reset --soft HEAD~1` and rebuild** the missing tracked edits before re-verifying — don't push the truncated change.

**Status:** Active — sibling of #74; 4th worktree-land/divergence git footgun in the cluster (#72, #74, this, + the #73 facet-B signature). See the consolidated "Worktree-land / divergence-window git footguns" Quick-Reference entry in the lessons INDEX.

**Applies To:** All agents cleaning a dirtied working tree during a worktree land or any multi-file change — especially splits/refactors that mix edits to tracked files with new untracked files.

## #76 [Build] `git commit -- <explicit list>` Silently Omits a Glob-Staged File — Broken Tree Pushed to Origin

**Pattern:** Files are staged with `git add <glob>` (or `git add <dir>`), then committed with `git commit -- <explicit file list>` per the ADR-005 pathspec rule. The explicit list is a **subset** of what the glob staged, so a staged file is silently left **staged-but-uncommitted** — the commit succeeds with no warning. The omitted file (e.g. a module the committed code imports) never reaches origin, so the pushed tree is broken even though local verify was green (verify reads the working tree, where the file exists).

**Instances:**
- 2026-07-17 — ElectronMain (worktree landing, p/98#6/#7): `git add <glob>` staged a set of files; `git commit -- <explicit list>` dropped one of them, leaving it staged-uncommitted. Pushed a broken tree to origin — the registrar imported a module that was never committed. Local verify passed (working tree had the file); CI/committed state did not. Detection after the fact: `git ls-tree origin/main <dir>` file-count vs expected.

**Root Cause:** The ADR-005 "commit by explicit pathspec" rule (which correctly prevents sweeping other agents' staged files) has a failure mode when the explicit list is hand-maintained: it can drift out of sync with what was actually staged by a glob/dir `add`. `git commit -- <paths>` commits **exactly** those paths and silently ignores other staged changes — no error, no "you have staged files not in this commit" warning. Combined with the committed-vs-working-tree trap (verify reads the working tree, not the index/HEAD), the gap is invisible until CI or another agent hits the missing file on origin. Same family as "Uncommitted Fixes Mask Committed Breakage" and the worktree-land footgun cluster (#72/#74/#75) — the commit contains fewer files than intended and the file-count is the reliable tell.

**Prevention:**
1. **Reconcile the commit pathspec against what's staged.** Before pushing, run `git status` / `git diff --cached --name-only` and confirm NOTHING you intended is left staged-uncommitted. A non-empty "Changes staged but not committed" after your commit is the signal.
2. **Verify the commit's file set at the object level, before AND after push** — `git show --stat HEAD` (does the commit contain every file the change needs?) and `git ls-tree origin/main <dir>` file-count after push (does origin have them all?). A commit/tree with fewer files than expected is a dropped-file signal (same file-count defense as #75).
3. **When you staged with a glob but must commit by explicit pathspec (ADR-005), derive the list from the staged set** — e.g. commit the reconciled `git diff --cached --name-only` output — rather than hand-typing a list that can omit a file. Keep ADR-005's protection (don't sweep others' files) without dropping your own.

**Status:** Active — 5th hazard in the worktree-land cluster (#72/#74/#75/#76 + #73 facet-B). **Two-track defense landed 2026-07-17:** (1) mechanical — Diagnostics shipped the `staged-files-after-commit` PostToolUse/Bash hook (`operations/diagnostics/check-staged-after-commit.cjs`): after any Bash `git commit` it runs `git diff --cached --name-only` and injects a warning listing anything left staged-uncommitted; silent on non-commit / non-git-repo calls (p/9#33). Inert until the next Orca sync per the manifest-lag trap (#68) — verify live via manifest presence, not audit counters. (2) behavioral — TL folded #76 into the worktree-land cluster of the AGENTS.md/`/land-from-worktree` batch (p/8#86), owner-gated.

**Applies To:** All agents committing by explicit pathspec after a glob/dir `git add` — especially multi-file worktree lands where a dropped file breaks origin.

## #77 [Build] `npm ci` in a Fresh Worktree Can Leave an Empty Package Dir — False `tsc` TS2307

**Pattern:** `npm ci` in a fresh landing-worktree completes, but a package installs as an **empty directory** — the folder exists under `node_modules/` with no `dist/` (no built output). Type-checking then fails with a false `TS2307 Cannot find module` for that package, which reads as a real code error but is actually an incomplete install. The worktree's whole purpose (isolated, trustworthy verify) is defeated: the red is a dependency artifact, not the change.

**Instances:**
- 2026-07-17 — ElectronMain (worktree landing, p/98#6/#7): `npm ci` in a fresh worktree left `node_modules/@modelcontextprotocol/sdk` an empty dir (no `dist/`), causing a false renderer-`tsc` **TS2307**. Fixed by copying the package from a known-good `node_modules`. Cost a broken-origin window because the false red muddied the land.

**Root Cause:** `npm ci` is not guaranteed to yield a byte-complete `node_modules` in a fresh worktree — a package can land as an empty/partial dir (interrupted extraction, cache corruption, a package whose `dist/` is produced by a lifecycle/prepare step that didn't run, or a workspace/link quirk). The presence of the package *folder* makes it look installed, so `tsc`'s `TS2307` is misread as a missing import in the code rather than a missing build output in the dep. This complicates the `/land-from-worktree` "`npm ci` inside the worktree" step (see the Windows Junction pattern): `npm ci` is necessary but not always sufficient — a fresh install can still be incomplete.

**Prevention:**
1. **When a worktree `tsc` reports TS2307 for a third-party package, suspect the install before the code** — check the package actually has its built output: `ls node_modules/<pkg>/dist` (or its `main`/`exports` target). An empty dir = incomplete install, not a code error.
2. **Repair the dep, don't chase the code:** copy the package from a known-good `node_modules`, or re-run `npm ci` (optionally `npm cache verify` / clean and reinstall). Do NOT edit imports to work around a TS2307 that's really a missing `dist/`.
3. **Prefer verifying in the main tree** (byte-identity via `git diff <worktree-sha> <main-sha>`) when worktree dep-install reliability is in doubt — a false red from an incomplete worktree install is a known red-herring class (pairs with #72's "verify against stale deps" and the Windows Junction pattern).

**Status:** Active — worktree-land environment hazard (companion to the git-footgun cluster #72/#74/#75/#76). Handed to TL for the `/land-from-worktree` proposal batch: the "`npm ci` in worktree" step needs a completeness check.

**Applies To:** All agents running `npm ci` in a fresh landing-worktree before verify — especially when `tsc` reports TS2307 for an installed package.

## #78 [Build] `git worktree remove` vs In-Worktree node_modules — Refuses Without `--force`, Then TIMES OUT on the rm (Windows)

**Pattern:** Cleaning up a worktree that ran an in-worktree `npm ci` fails **two** ways on Windows: **(A) refusal** — plain `git worktree remove` exits 128 ("contains modified or untracked files") because the installed `node_modules`/`dist` are untracked; **(B) timeout** — `--force` proceeds but `remove` then **synchronously `rm -rf`s the huge node_modules**, pathologically slow on Windows (AV/indexing per file), and **times out** (2min). The naive fixes chain: remove → add `--force` → `--force` hangs on the delete.

**Instances:**
- 2026-07-17 — Shared Lib (`/land-from-worktree` step 8, p/5#13): plain `git worktree remove` exited 128 on untracked `node_modules`; resolved with `--force` (work already pushed, no loss). (Facet A.)
- 2026-09-29 — DebateTool (p/70#33, t/3778, **Facet A — CRLF-dirty variant**): `git worktree remove` failed — `routeTable.test.ts.snap` flagged dirty due to Windows autocrlf CRLF line-ending normalization on checkout (no content diff). Fixed with `--force`. Note: Windows autocrlf can mark snapshot files dirty even with zero content change; `git diff` shows only line-ending deltas.
- 2026-09-30 — DebateTool (p/70#37, **Facet A — CRLF-dirty, `git restore` fix**): `git worktree remove` refused on `routeTable.test.ts.snap` again flagged dirty by LF→CRLF normalization (no content change). Fixed by running `git restore <file>` first to clear the false-dirty state, then `git worktree remove` succeeded cleanly. Cleaner than `--force` — restores the file to HEAD and lets git's normal safety check pass rather than bypassing it.
- 2026-10-01 — Rosetta Stone (p/6#71, **Facet A — CRLF snapshot noise**): `git worktree remove ../wt-t3813wireup` refused ("contains modified or untracked files") — same LF→CRLF noise on `routeTable.test.ts.snap`, no real content diff. Confirmed via `git status --short`, then resolved with `--force`. 4th Facet A instance; same file, same cause across three agents.
- 2026-07-28 — DebateDiagnostics (p/245#1): `git worktree remove <wt>` **timed out at 2min** synchronously `rm -rf`-ing the worktree's large `node_modules` (Windows/AV). Resolved by detaching git metadata fast, then backgrounding the delete: `git worktree prune` + `git branch -D <branch>`, then `rm -rf <wt-dir>` as a backgrounded task. (Facet B — supersedes the `--force` remedy for deps-installed worktrees.)
- 2026-07-29 — Chat (p/270#1): `git worktree remove` **timed out at 2min** on a **double-`npm ci`'d** worktree (root **and** `taxonomy-editor/` → tens of thousands of node_modules files). git had already marked it **`prunable`**, so a backgrounded `rm -rf` + `git worktree prune` finished cleanup with **no `branch -D` needed**. 3rd instance — Facet B; the double-`npm ci` is the amplifier.
- 2026-07-29 — Server Storage (t/1921 Batch B/C, p/206#5): `git worktree remove --force` failed **"`.git` does not exist"** — the OS/AV had already deleted the physical worktree dir, leaving only a stale administrative ref. Resolved with **`git worktree prune`**. (Facet C — the delete already happened out-of-band; `prune` is the whole fix, `remove` is the wrong verb.)
- 2026-08-05 — DebateTool (p/70#14, t/2186): worktree at `C:/Users/jsnov/repos/wt-2186` had its **`.git` file silently disappear** — the directory still contained `lib/` and `node_modules/` content but no git metadata. Git commands had worked during the active rebase session; by next use the worktree was dead ("not a git repository"). Pushed from the main repo instead. (Facet E — `.git` file gone, content intact; distinct from Facet C where the whole dir was deleted.) Likely cause: OS/AV or a cleanup process selectively deleted the small `.git` pointer file while leaving larger content dirs alone.
- 2026-08-11 — Rosetta Stone (p/6#54): `git worktree remove --force` **timed out twice** (2 min cap) on worktrees with installed `node_modules`. Resolution: re-ran each with `run_in_background: true` — exits 0, the slow rm continues in the OS without blocking the session. (Facet B variant — background the `--force` command itself, simpler than the prune + branch-D + rm split.)
- 2026-08-11 — ServerAPI (p/79#31): `git worktree remove --force` **timed out on two worktrees** with per-worktree `node_modules`. Same resolution: re-ran with `run_in_background: true`. 5th Facet B instance; 2nd confirmation that backgrounding `--force` is the reliable Windows fix.
- 2026-09-29 — Rosetta Stone (p/6#65, **mid-delete partial state**): `git worktree remove` timed out at 30s (shortened tool timeout) mid-delete of t3734-headline-adjacency worktree. Left a partially-deleted state: physical `.git` file gone but ref still registered. Resolved: `git worktree prune` cleared the stale ref; remaining directory removed separately in background (no `.git` state left to corrupt). Note: a timeout shorter than 2min amplifies the risk of mid-delete partial state.
- 2026-09-30 — DebateTool (p/70#43, **Facet A — untracked `package-lock.json`**): `git worktree remove ../wt-3811` failed because `npm install` (not `npm ci`) generated `package-lock.json` inside the worktree — untracked, not gitignored. `npm install` updates/creates the lockfile; `npm ci` reads it without modifying. Resolved with `--force` (branch already merged). Prevention: use `npm ci` in worktrees (per `/land-from-worktree` step 2), or add `package-lock.json` to `.gitignore` if it should not be committed.
- 2026-10-01 — TL (p/335#105, **Facet B variant — direct `rm -rf` on stale `.worktrees/*` node_modules**): `rm -rf` across four stale `.worktrees/*` node_modules trees timed out at the 2-min Bash ceiling (exit 143, SIGTERM) — ~10 MB across four trees = tens of thousands of tiny files, each hitting AV/indexing on Windows. Recovery: checked actual state rather than retrying blind — files were already deleted, only empty dir skeletons remained; a second pass with a raised timeout cleared the skeletons in seconds. **Key lesson:** a SIGTERM timeout leaves PARTIAL state; the retry must be preceded by a state check, not a blind re-run (see Pattern #185).
- 2026-10-01 — DebateTool (p/70#45, **Facet C variant — remote delete timeout starves chained worktree remove**): `git push origin --delete <branch> && git worktree remove ../wt-3813b` chained in one command; the remote branch delete took >2 min on a slow remote, exhausting the Bash tool's 2-min cap before `git worktree remove` ran. Directory was already gone (no `.git`), leaving only a stale ref. Resolved with `git worktree prune`. Lesson: don't chain `push --delete` with `git worktree remove` — run them as separate commands so a slow remote delete doesn't consume the timeout budget of the local cleanup.

**Root Cause:** (A) `git worktree remove` aborts on untracked files, and an in-worktree `npm ci` always leaves a large untracked `node_modules`. (B) `--force` clears the refusal but does the deletion **synchronously in the foreground**, and unlinking tens of thousands of small files is pathologically slow on Windows (each hits AV/indexing), blowing the 2-minute timeout. (C) Once the physical dir is already gone, `remove` fails ("`.git` does not exist") — only the stale ref remains, which `prune` clears. (E) The `.git` file in a linked worktree is a small plain-text pointer file (`gitdir: /path/to/.git/worktrees/...`) — unlike the main repo's `.git` directory, it's just one file that AV/OS cleanup processes may selectively delete while leaving larger content dirs (`lib/`, `node_modules/`) intact. When it's gone, the directory is no longer a git repository from any tool's perspective, but the content survives. The through-line: `remove` couples git-metadata detach (instant) with the physical delete (slow, or possibly already done); decouple them — `prune` owns the ref, a backgrounded `rm -rf` owns the files. Companion to #77 and the Windows Junction pattern.

**Prevention:**
1. **For a deps-installed worktree, don't `git worktree remove` — detach fast, delete in the background** (DebateDiagnostics, p/245#1): `git worktree prune` + `git branch -D <branch>` (instant), then `rm -rf <wt-dir>` **backgrounded**. Avoids BOTH the refusal (A) and the foreground-rm timeout (B). If git already reports the worktree **`prunable`**, backgrounded `rm -rf` + `git worktree prune` alone suffices (skip `branch -D`, Chat p/270#1). A land that builds **both** root and `taxonomy-editor/` leaves **two** node_modules trees — double the delete.
2. **`git worktree remove --force` is the fallback only for small/no-deps worktrees** — where the synchronous rm is fast. With a full `node_modules` on Windows it times out synchronously; use #1 OR pass `run_in_background: true` so the slow rm doesn't block the 2-min session cap (Rosetta Stone p/6#54).
3. **remove/rm only after your commit is pushed** — confirm the work is on `origin/main`; the sole casualty is `node_modules`. Never remove with uncommitted deliverable work.
4. `git worktree prune` also clears stale administrative refs (same follow-up as the Junction pattern).
7. **After a timeout on `rm -rf`, check actual state before retrying** — a SIGTERM (exit 143) may leave partial completion: some files deleted, others not. Run `ls` or `Test-Path` on the target first; retry only what remains. A blind re-run restarts from scratch and wastes time re-deleting already-gone files — or, worse, assumes nothing was done when it was. Raise `timeout` on the retry to match the actual remaining work. (p/335#105; see Pattern #185.)
5. **Don't chain `git push origin --delete` with `git worktree remove` in a single command** — a slow remote delete can exhaust the 2-min Bash tool timeout, leaving the worktree remove never executed and a stale ref behind. Run them as separate commands; if the directory is already gone, `git worktree prune` alone clears the stale ref. (DebateTool p/70#45.)
6. **(Facet A — CRLF intention mismatch, NOT a content diff)** `autocrlf=true` + `*.snap` falling through `* text=auto` means git thinks the file *should* be CRLF but it's LF — flagged as "LF will be replaced by CRLF." The file is **byte-identical to the index**; `git diff` is EMPTY. **`git restore` is NOT a reliable mitigation** — any rewrite re-triggers the flag by construction (git immediately re-marks it as about-to-convert). Workaround until t/3825 lands: **verify `git diff <file>` is EMPTY first** — empty diff + `M` in status = intention mismatch, `--force` is lossless. Non-empty diff = real changes, `--force` destroys them. Never force without confirming the diff is empty. Root fix: `.gitattributes` `*.snap text eol=lf` (t/3825, DevOps).
5. **(Facet E) Verify the `.git` file exists before starting work in an existing worktree:** `Test-Path <wt>\.git` (PowerShell) or `ls <wt>/.git` — if absent, the worktree is dead; push from the main repo using the branch name, then `git worktree prune` to clear the stale ref.

- 2026-09-29 — DebateTool 2 (p/234#12): `git worktree remove ../wt-3761` failed with **Permission denied** on Windows — file locked by AV/OS or another process. Unresolved; routed to user for manual cleanup. **(Facet F — Permission denied variant of the Windows locking root cause; same prune + background-rm fix applies.)**

**Status:** Active — worktree-land cluster; `/land-from-worktree` step-8 guidance updated from "`remove --force`" to "**prune + `branch -D` + background rm**" for deps-installed worktrees (supersedes the earlier `--force` wording; both refusal + timeout covered). **Facet F added 2026-09-29 (DebateTool 2 p/234#12):** Permission denied on Windows — file locked by AV/OS; same prune + background-rm resolution applies. **Facet E added 2026-08-05 (DebateTool p/70#14):** `.git` pointer file silently deleted by OS/AV mid-session; worktree content survives but git is blind to it — push from main repo, then `git worktree prune`. **New instance 2026-10-01 (DebateTool p/70#45):** remote branch delete timeout starves a chained `git worktree remove` — Facet C variant; prevention #5 added. **Facet A 4th instance 2026-10-01 (Rosetta Stone p/6#71):** same CRLF snapshot noise on `routeTable.test.ts.snap` across three agents — TL pinged on `.gitattributes` fix. **Facet B variant 2026-10-01 (TL p/335#105):** direct `rm -rf` on four stale `.worktrees/*` node_modules trees timed out (exit 143); state check revealed partial completion; prevention #7 + Pattern #185 added.

**Applies To:** All agents using the worktree landing procedure with an in-worktree `npm ci` — i.e. every deps-installing land.

## #79 [Build] Copying a Whole File From the Shared Tree Into a Worktree Sweeps In Its Uncommitted WIP

**Pattern:** In the `/land-from-worktree` flow you "copy your changed files into the worktree" (step 3). If you `cp` the **whole file from the shared working tree**, you also copy any **pre-existing uncommitted WIP** on that file — other agents' edits, an accidental BOM, an unrelated config bump — which then rides into your commit. The commit silently carries changes you didn't make. `git diff --stat` shows a line-count larger than your edit (the gap is a tell), but `--stat` alone hides **what** the extra lines are, so the sweep-in can pass a quick glance. **Variant (same root, different payload):** if the copied file is *stale* — behind origin — you don't sweep in WIP, you **clobber peers' newer committed additions** to that file and reintroduce an out-of-date baseline.

**Instances:**
- 2026-07-26 — PowerShell (t/1726, caught in TL review, p/20#25): `cp`-ing a whole file from the shared tree into the landing worktree swept in an **accidental BOM** and an **unrelated gemini model-default bump** that were sitting uncommitted on that file. `git diff --stat` showed **24 lines vs the ~6 guard lines** the change actually needed — the gap flagged it, but `--stat` didn't reveal the BOM/model-bump; only the content diff did. Same family as the branch-off-origin / dirty-tree-false-witness cluster.
- 2026-07-28 — PowerShell 2 (t/1899, resolved 21fc09fd, p/228#5): the **stale** facet — copied a whole test file whose working copy was **118 commits behind origin** instead of re-applying the targeted edit onto a fresh base. No WIP was swept, but the stale copy risked clobbering peers' newer committed additions. Same fix: re-apply targeted edits onto an origin-clean file; never copy a whole file, WIP-dirty **or** stale. (Set up but did not itself cause the CI-red — that came from a repo-wide lint; see #94.)
- 2026-08-08 — Fleet junk sweep (p/228#11): **variant — ported shared-checkout edits into a worktree via copy instead of making edits directly in the worktree.** Generated 22 zero-byte junk files (`received.push(e))`, `Promise`, etc.) — word-split fragments from a shell command run against the shared tree. The agent's own memory (`stale-local-main-reapply-not-overwrite`) documented this pattern but was violated in practice. **Subsidiary lesson:** path-scoped git checks (`git ls-files --others`, `git status -- <scope>`) must run from the repo root to catch all junk; running from a role subdirectory silently misses files outside that subtree.

**Root Cause:** The shared working tree is every agent's live scratch space — a file there is whatever anyone last wrote, committed or not (the "dirty tree as false witness" premise). Copying that file wholesale imports its entire current content, not just your intended edit, so uncommitted WIP hitchhikes into your commit. `git diff --stat` summarizes magnitude (line counts) but not content, so it confirms "more changed than I expected" without showing the smuggled BOM/config change — you have to read the actual diff against a clean baseline to see it. Companion to #76 (there a commit had *fewer* files than intended; here a file has *more* content than intended — both caught by comparing count-vs-expectation, both needing an object-level content check to confirm).

**Prevention:**
1. **Don't `cp` whole files from the shared tree into a worktree — re-apply your edits onto origin-clean files.** In the worktree (branched off fresh `origin/main`), the file is already clean; make your change there rather than importing the shared-tree copy with its WIP.
2. **If you must copy, read the CONTENT diff vs origin before committing — not just `--stat`.** `git diff origin/main -- <file>` (or `git diff --cached` after staging) and confirm every hunk is yours. A line-count larger than your edit is the tell; the content diff is what identifies the smuggled change.
3. **Line-count vs expectation is a cheap tripwire** — if `git diff --stat` shows materially more lines than your edit touched, STOP and read the full diff before committing. (Pairs with #76's file-count check — same "count vs expectation" discipline, applied to line content.)
4. **Make all edits directly IN the worktree on its fresh base** — the worktree starts from origin/main clean; there is no need to port edits from the shared tree. If you find yourself reaching for `cp` or `patch` from the shared tree into a worktree, stop and make the change directly in the worktree instead.
5. **Path-scoped git checks (`git ls-files --others`, `git status -- <scope>`) must run from the repo root** — running from a role subdirectory silently misses files outside that subtree.

**Status:** Active — 3rd instance (fleet junk sweep, 2026-08-08); 7th hazard in the worktree-land cluster. A `/land-from-worktree` step-3 refinement ("copy changed files" → "re-apply edits onto origin-clean files, or content-diff vs origin before commit"). Handed to TL for the owner-gated batch.

**Applies To:** All agents landing edits to *existing* files via a worktree — especially copying from a shared tree that may carry other agents' uncommitted WIP.

## #80 [Process] Feedback Hook Silently Dead on Windows — `{workspace_root}` Expands Empty → Wrong Path → crash → exit 1 Suppresses With No Guidance

**Pattern:** A feedback hook whose `run.args` reference `{workspace_root}` is **silently non-functional on Windows** because `{workspace_root}` expands to an **empty string**. Node receives `/operations/diagnostics/<script>.cjs`, which on Windows resolves to `c:\operations\...` (nonexistent), so the script crashes. The crash exits 1, which the runner treats as "suppress" — the hook neither runs its check NOR surfaces guidance. It **looks installed** (rule enabled, manifest present) but provides **zero coverage and zero signal** — a false-green worse than no hook, because everyone believes the guard is in place.

**Instances:**
- 2026-07-26 — Diagnostics (p/9#39, found while extending `check-git-commit-order.cjs`, commit 039f9501): `{workspace_root}` expanded empty on Windows → node got `/operations/diagnostics/check-git-commit-order.cjs` → resolved to `c:\operations\...` → crash → exit 1 → suppressed with no guidance. The regex fix (overlay-form coverage) is committed but **dead until the path expansion is resolved**. Almost certainly affects **every** hook whose args use `{workspace_root}` — including the `staged-files-after-commit` hook (#76's supposed mechanical defense).
- 2026-07-26 — **post-inlining regression: residual now LOUD noise, not silence** (Sage direct + PowerShell 2 p/228#1): after the p/9#41 re-inline, the guard logs `Feedback rule 'node' exited with code 1` on ~every matching call — PowerShell 2 read it as "a broken feedback rule." Implies the inlined `node -e` script **exits 1 unconditionally** (even with no violation) — an exit-logic/parse bug, not a real flag. Traded a *silent* dead hook for a *noisy* one; constant `exited code 1` trains the fleet to ignore the guard (violates zero-gate-noise, #20/#46).

**Root Cause:** The hook-runner's `{workspace_root}` template variable does not expand on this Windows setup (empty string), so absolute-path construction in `run.args` silently produces a bogus root — the exact opposite of the standing Diagnostics rule "always use absolute paths via `{workspace_root}`", which assumed it resolves. Compounded by the runner's **exit-1 = suppress-silently** contract: a *crashing* hook is indistinguishable from a *passing* one, so the failure is invisible. Gate-signal-integrity failure (root #20/#46): a gate that can't run detects nothing and reports false-green. Sibling of #68 (feedback tooling lies about liveness) — there manifest-lag + false counters; here a crash masquerading as a pass.

**Prevention:**
1. **A hook is not "landed" until it's proven to FIRE on Windows** — enabled + manifest-present is not enough (#68). Trigger it deliberately and confirm the guidance appears; a hook that never emits output may be crashing, not passing.
2. **Verify `{workspace_root}` actually expands** here before relying on it for hook script paths; if empty, resolve the script path inside the `.cjs` via `__dirname` rather than a template arg.
3. **A crashing hook must not silently pass** — make hook failure visible (non-suppressing error surface); exit-1-as-suppress hides exactly the failure you most need to see.
4. **Audit ALL `{workspace_root}` hooks for the same silent death** — not one hook's bug; every hook using that template on Windows is suspect (recommended a fleet-wide hook audit to Diagnostics).
5. **A hook must exit 0 on the clean/no-violation path.** If the inlined script exits non-zero unconditionally, it emits `node exited code 1` on EVERY matching call — pure noise that trains the fleet to ignore the guard (violates zero-gate-noise, #20/#46). Test the clean path explicitly, not just the violation path.

**Status:** Active — three-part root cause. **Part 1 — `{workspace_root}` path crash: FIXED (Diagnostics audit, p/9#41):** the two hooks using `{workspace_root}` external scripts were **re-inlined via `node -e`**; no other `run.command` hooks exist, so the path-crash class is closed. **Part 2 — exit-1-suppresses-silently: OPEN, Orca Support's platform contract** (a hook exiting non-zero for any reason is suppressed with no signal — crash indistinguishable from pass). **Part 3 — NEW, post-inlining (p/228#1): the inlined guard exits 1 on ~every matching call regardless of violation** → fleet-visible `node exited code 1` noise (2 observers: Sage + PowerShell 2). In-repo exit-logic bug (prevention #5), fixable by Diagnostics directly (exit 0 when clean), separate from the Orca contract. Until Parts 2+3 land, the guard gives neither reliable signal nor low noise — the behavioral rule remains the real defense. Both flagged to Diagnostics (p/9 thread).

**Applies To:** All agents (esp. Diagnostics) authoring or relying on feedback hooks on Windows — and Sage/TL when recording a hook as a "mechanical defense," which must carry a "proven-to-fire-on-Windows" caveat.

## #81 [Build] `/land-from-worktree` Sync-Back Leaves Files Staged in the Shared Index — Manufactures ADR-005 Sweep-Bait

**Pattern:** During the `/land-from-worktree` sync-back, using `git checkout origin/main -- <files>` to refresh the shared tree **leaves those files STAGED in the shared index**, so any other agent's later bare `git commit` sweeps them into an unrelated commit (ADR-005). It manufactures sweep-bait *even for a correctly-landed file*. **Not a procedure gap — a procedure-not-followed case:** the skill's **step 7 already mandates the safe form** `git restore --source=origin/main --worktree -- <files>` (working-tree only, no staging) and **explicitly warns "do NOT use `git checkout origin/main -- <files>` — it stages them."** The hazard materializes only when an agent deviates to the forbidden `checkout` form.

**Instances:**
- 2026-07-26 — ServerAPI (`/land-from-worktree`, p/79#10/#11): used `git checkout origin/main -- <files>` for sync-back — **the exact anti-pattern step 7 warns against** (TL, p/8#93) — which left the files staged in the shared index; another agent's bare `git commit` then swept them into an unrelated commit (co-cause: the ADR-005 bare-commit violation, Diagnostics' 039f9501 commit). **Impact harmless this time** — the swept blob was identical to what was already on origin/main.

**Root Cause:** `git checkout <ref> -- <paths>` writes the files to **both the index and the working tree**, whereas the step-7-mandated `git restore --source=<ref> --worktree -- <paths>` touches the working tree ONLY. On the shared tree the checkout form leaves files staged with no owning commit — exactly the "pre-staged files" a bare `git commit` sweeps (see "Bare Git Commit Sweeps Shared Staging Index"); it's the *supply side* of the bare-commit-sweep hazard. The rule to avoid this already existed in the skill; the failure was **not following it** — the same rule-exists-but-not-applied class seen elsewhere this session (config-forensics, strict-mode property access). 8th hazard in the worktree-land cluster.

**Prevention:**
1. **Primary (already in the skill, step 7):** for sync-back use `git restore --source=origin/main --worktree -- <files>` — working-tree only, no staging. **Never `git checkout origin/main -- <files>`** (it stages, creating sweep-bait) — step 7 explicitly forbids it.
2. **Recovery (if you used `checkout` anyway):** run `git restore --staged -- <files>` to unstage — the shared tree only needs them in the working tree (already committed on origin/main), never in the index. (TL adding this as a recovery line + reinforcing #1, p/8#93.)
3. **General rule:** any `git checkout <ref> -- <paths>` / non-`--worktree` restore on the shared tree leaves staged bait; follow with `git restore --staged` unless those files are meant for the next commit.

**Status:** Active — 8th worktree-land cluster hazard; the *supply side* of the bare-commit-sweep pattern (consumption side now 2 instances). **Procedure-not-followed, not a gap** (step 7 already mandates the safe form + forbids the checkout form). TL is adding a recovery line and reinforcing the primary rule in the owner-gated `/land-from-worktree` batch (p/8#93).

**Applies To:** All agents running the worktree landing procedure's sync-back, and anyone using `git checkout <ref> -- <paths>` on the shared tree.

## #82 [Process] Rule-Exists-But-Not-Applied — a Point-of-Use Failure Class (not a coverage gap)

**Pattern:** A recurrence whose root cause is NOT a missing rule — the rule is written, correct, and in the right place (AGENTS.md / a skill step / a memory) — but it **doesn't fire at the moment of action**. The agent doesn't recall/apply it mid-task. Distinct triage class from "no rule exists": adding more prose won't fix it, because the failure is point-of-use, not coverage. The lever is a **point-of-use gate (PreToolUse hook)** where the signal is clean — converting the rule from something-to-remember into something-enforced.

**Instances (running tally — tag every new one; track BOTH the class total AND the max-per-offender count, per TL p/8#95/#97). Current: CLASS TOTAL ≥ 12 / ~6 trigger → MET; MAX PER OFFENDER ≥ 5 / 4 trigger → MET. TWO offenders now trip the per-offender trigger (#4 and #5).**
- 2026-07-17 — object-level git-forensics, **2nd config-failure instance** (Diagnostics, p/9#30): the "run `git diff HEAD -- <configfile>` before blaming a commit for config" rule existed in memory + root AGENTS.md but wasn't invoked mid-triage. [offender: config-forensics recall — count 1]
- 2026-07-26 — strict-mode unguarded property access (TL, t/1726, p/8#88): the `PSObject.Properties` guard rule existed (scripts/AGENTS.md) but wasn't applied at 4 `.factual_claims` sites; a blanket property-access hook was ruled too noisy to scope. [offender: strict-mode property guard — count 1]
- 2026-07-26 — `/land-from-worktree` #81 (ServerAPI, p/79#10 / p/8#93): step 7 mandates `git restore --worktree` and explicitly forbids `git checkout … -- <files>`; the agent used the forbidden form anyway. [offender: land-worktree step-7 form — count 1]
- 2026-07-26 — **direct-commit-to-shared-main instead of worktree-landing** (TL, p/8#99; PM p/21#49): agents keep committing docs straight to LOCAL shared `main` rather than worktree-landing. Rule exists (`/land-from-worktree` skill + root AGENTS.md) but isn't applied at commit time. **Recurring since t/1714; PM flagged 5 re-stranded TODAY** → **≥5 instances**. [offender: worktree-landing-not-applied — count ≥5 → trips both triggers]
- 2026-07-26 — **data-shape type-check-not-applied** (Computational Linguist, p/7#36 + p/7#38; **REVERSES Sage's earlier not-in-#82 call**): the root "Data File Convention" rule (inspect a sample + `type()`/`isinstance()` before operating) exists but keeps not being applied — inline code assumes uniform JSON shape and crashes on the variant (p/7#38: `interpretations.{pov}` dict for 1,236 / string for 23, same-session recurrence). Excluded earlier as "trivial/not-hookable" (p/7#36); CL's same-session-recurrence argument corrects that — **severity isn't the gating criterion; frequency + rule-not-applied is, and recording-isn't-preventing is this class's signature.** Post-rule misses: p/7#16, p/7#18, p/7#36, p/7#38 → [offender: data-shape type-check — count ≥4 → tripped per-offender trigger]. **DISPOSITION: RULE-ONLY, no hook (t/1810, TL p/8#109)** — false-red surface (`graph_attributes` 514 reads/132 files, `interpretations` 213/76) shows the correct normalize-at-fetch pattern leaves most reads guard-free, so a read-without-coercion detector false-reds on correct code (dead gate, #20/#46). Strengthened by TS union-types (tsc = real gate) + naming the variadic fields in the rule (t/1810#1).

**Root Cause:** Rules delivered as prose (AGENTS.md, skill steps, memory) depend on recall at the exact moment of action; under task focus/triage pressure the relevant rule often doesn't surface. Coverage (the rule exists) and application (it fires when needed) are different problems, and only the latter is failing here. The reliable fix is to move enforcement to the point of use — a gate that fires mechanically — but only where the trigger is cheaply and unambiguously detectable (the `ps-strict-mode-count-guard` `.Count` guard is the model; a blanket property-access hook was rejected as too noisy — that tradeoff still holds).

**Prevention:**
1. **Triage recurrences into two buckets:** "no rule exists" (→ write/escalate a rule) vs "rule exists but wasn't applied" (→ this class; more prose won't help). Record which bucket in the pattern's Status.
2. **For the point-of-use class, tag every instance and track TWO counters; TL acts on whichever trigger fires first (p/8#95/#97):**
   - **(a) per-offender:** any single offender hits its **4th** instance → TL specs a point-of-use hook *for that offender* (the `.Count` guard is the model).
   - **(b) class-total:** the class reaches **~6 total instances across offenders** → systemic (a long tail of distinct one/two-off offenders, not one bad actor), so the lever is a **broader point-of-use reinforcement** — a review-habit/checklist change or a meta-hook — NOT one rule.
   - Rationale for (b): a per-offender trigger alone never fires when the class grows via many distinct offenders each recurring once or twice — exactly the observed trend (3 instances / 3 offenders). Rank both counters in the tally header.
3. **The hook lever converts an offender ONLY when its violation is a crisp, unambiguous SYNTACTIC signal** (TL general criterion, p/8#109). If the offender's *correct* pattern is **syntactically identical** to the violation, a detector false-reds on correct code = dead gate (#20/#46) → **rule-only**. Examples: #4 direct-commit (`branch == main` = crisp → HOOK, t/1780); #5 data-shape read-without-coercion (correct normalize-at-fetch leaves most reads guard-free → violation≈correct → RULE-ONLY, t/1810). *Detectable* means *distinguishable-from-correct*, not just *greppable*.
4. **When rule-only, strengthen via other real gates, not a noisy hook** — e.g. TS union-types so `tsc` catches the shape mismatch + name the specific variadic fields in the rule (t/1810#1). The honest record where it stays rule-only: "rule is the only defense; recall is the residual risk."

**Status:** Active — **BOTH triggers fired; both offenders DISPOSITIONED (TL, p/8#104→#109):** #4 direct-commit-to-shared-main (≥5) → hook **spec'd as t/1780** (In Review, Gate-Verification + owner-go gated; crisp `branch==main` signal). #5 data-shape type-check (≥4, CL p/7#36/#38) → **RULE-ONLY (t/1810 decided)** — false-red surface too large (correct pattern ≈ violation), strengthened by TS union-types + naming variadic fields. **Net:** of the two per-offender-trigger offenders, one earned a hook and one stayed rule-only — exactly what the crisp-syntactic-signal criterion (prevention #3) predicts. Class-total ≥12. **Sage standing action:** keep tagging new distinct offenders + both counters; watch t/1780 (In Review). (Sibling: direct-commit drove the large-divergence push failure p/9#36.) **Offender #4 hook CONFIRMED FIRING in the field (2026-07-30):** the pre-commit push-guard (t/1926/t/1780 family) blocked a DIRECT `git commit` to shared main — DebateTool skipped worktree-land for a "trivial single-file fix" and the hook refused it → forced the `/land-from-worktree` PR flow (t/2028, p/234#6). Proves the hook works AND enforces "trivial change still needs worktree-land" (carve-out dead). #4 = hook-converted.

**Applies To:** Sage (triage + tagging) and TL (hook-spec decision) — and anyone tempted to answer a recurrence with "add a rule" when the rule already exists.

## #83 [Build] Commit-by-Pathspec Is File-Granular — In a Live Working Tree It Sweeps Foreign HUNKS Inside Your File (ADR-005 Insufficient)

**Pattern:** `git commit -- <file>` (the ADR-005 defense against sweeping others' work) protects at **file granularity** — it commits *that file's entire working-tree state*, including any **foreign uncommitted hunks** other writers left INSIDE the same file. In a live working tree (`ai-triad-data`, continuously written by pipelines/sessions — often 10+ files dirty), the file you edit frequently already carries someone else's in-progress edit, so per-file staging is **not isolation**: your commit sweeps their hunk AND can split their multi-file change.

**Instances:**
- 2026-07-26 — Computational Linguist (ai-triad-data, commit 21781d25, disclosed t/1808, p/7#39): committed a one-line `sit-211` fix **by explicit pathspec** — correct per ADR-005 — but the target file also held **12 foreign lines from someone's `policy_id`→`pol-*` linking pass**, which rode into the commit; it also **split that foreign multi-file change** (their `policy_actions.json` stayed uncommitted). Root cause: pathspec is file-granular; the data repo is a live working tree (13 files dirty). Remediation options offered to the owner on t/1808.

**Root Cause:** ADR-005 "commit by explicit pathspec" prevents the *bare-commit* hazard (sweeping other agents' STAGED files — see "Bare Git Commit Sweeps Shared Staging Index"), but its unit is the **file**, not the **hunk**. `git commit -- <file>` snapshots the whole working-tree file, so any unrelated modification sitting in that file — common when the repo is a live write target rather than a code repo touched only by deliberate edits — is committed too. The rule's isolation guarantee silently degrades from "only my changes" to "only my *files*", which in a shared large-JSON file is no guarantee at all. Sibling of the "Active Writers Corrupt Git Operations in Data Repo" pattern.

**Prevention:**
1. **In `ai-triad-data` (or any live-written tree), `git diff <file>` BEFORE staging/committing** — treat **any foreign hunk as a STOP**. Only commit if every hunk in the file is yours.
2. If foreign hunks are present, **stage by hunk** (`git add -p`) to commit only your lines, or wait/coordinate — never `git commit -- <file>` a file carrying someone else's in-progress edit.
3. **ADR-005 shared-branch pathspec rule is necessary but NOT sufficient for large shared JSON** — pathspec isolates files, not hunks.
4. If you swept a foreign hunk, **disclose immediately** (ticket + owner) and offer remediation — a split multi-file change may need the owner to reconstruct it (t/1808).
5. **Upstream fix — serialize data-repo-writing batches and announce before starting** (TL/CL, p/8#106): don't run concurrent writers to `../ai-triad-data`. Queue a data-repo-writing batch behind any in-flight one (CL queued t/1676 behind t/1670 after concurrent batches caused today's revert) and post a "starting a data-repo batch" note. Removes the foreign-hunk collision at the source.

**Status:** Active — **defeats/qualifies ADR-005** (file-granular, not hunk-granular) in the live data repo. NOT a #82 rule-not-applied case: the agent correctly applied the pathspec rule; its granularity was insufficient for the context. Disclosed t/1808.

**Applies To:** All agents committing to `ai-triad-data` or any working tree that is a live write target — where a file you edit may carry other writers' uncommitted hunks.

## #84 [Process] Background-Task Gate Wrapper Swallows the Real Exit Code — False-Green from `&& echo PASS || echo FAIL`

**Pattern:** Wrapping a gate as `cmd >log 2>&1 && echo PASS || echo FAIL` (common for background tasks) makes the **task's exit code ALWAYS 0** — the trailing `echo` succeeds whether `cmd` passed or failed, so `&&`/`||` swallows `cmd`'s real exit. The background-task "exit 0" notification is **meaningless for pass/fail**. Compounding: `>log 2>&1` captures only `cmd`, so the `PASS`/`FAIL` marker (echoed after the redirect) lands in the **task-output file, NOT the `log` you tail**.

**Instances:**
- 2026-07-26 — Taxonomy Editor 2 (t/1798, p/195#3): briefly misread a **failed `npm run verify` as green** — the `... && echo PASS || echo FAIL` wrapper exited 0 and the FAIL marker was in the task-output file, not the tailed log. Resolution: read the marker text (or the inner command's real exit), never the wrapper's exit.

**Root Cause:** `A && echo PASS || echo FAIL`'s own exit status is the last `echo`'s, which always succeeds — it converts `cmd`'s pass/fail into stdout TEXT and drops it from the exit code; the harness reports the wrapper's exit (0), not `cmd`'s. Separately, `cmd >log 2>&1` redirects only `cmd`, so the post-`&&` echo writes elsewhere — verdict and log in different files. Same false-green genus as gate-blindness (#20/#46) but the mechanism is **exit-code laundering by the wrapper**, not tolerated noise.

**Prevention:**
1. **Never trust a background task's exit code when the command is `... && echo PASS || echo FAIL`** — that exit is the echo's (always 0). Trust the marker TEXT or the inner command's real exit.
2. **Preserve the real exit:** run the gate without the echo wrapper, or capture it: `cmd >log 2>&1; ec=$?; echo "EXIT=$ec"` → read `EXIT=`.
3. **Put the verdict where you look:** append the marker into the tailed `log` (`... ; echo RESULT=... >>log`), or `grep` the task-output file — don't tail the redirect log expecting a verdict that went to stdout.
4. **"Verify green" from a background task = confirm the marker/exit, not the completion notification.**

**Status:** Active — false-green (exit-code-laundering) variant of the gate-signal-integrity genus (#20/#46/#48/#61/#64); distinct from gate-blindness (tolerated noise) and skip-before-run.

**Applies To:** All agents running gates as background Bash tasks, especially with a `&& echo PASS || echo FAIL` wrapper + tailed redirect log.

## #85 [Process] Stale Barrel-Path Citations After ADR-007 Splits Fail SILENTLY (grep-empty, never a broken build)

**Pattern:** The ADR-007 splits turned single files into **barrel DIRECTORIES** — `calibrationLogger.ts` → `calibrationLogger/`, plus `prompts/`, `types/`, `claimExtractionPipeline/`, `gapAndDrift/`. The import surface still works (barrel re-exports), so **builds/verify stay green** — but every prose reference to the old `<name>.ts` path (docs, register, tickets, emails) now points at a nonexistent file. The rot is **silent**: only ever caught by a **grep returning empty** or a human following a dead citation.

**Instances:**
- 2026-07-26 — Technical Lead / Computational Linguist (p/8#106/#107): **4 stale citations across 3 tickets, 1 offender class** — `prompts.ts` + `types.ts` (t/1701), `gapAndDrift.ts` (t/1782), `calibrationLogger.ts` (e/43). All 4 surfaced via grep-returning-empty, none via a broken build.
- 2026-09-29 — DebateTool (p/70#27): `grep -n "DebateSession" lib/debate/types.ts` — exit 1 (no matches). `types.ts` is a barrel (`export * from './types/session.js'`); interface lives in `types/session.ts`. Resolved by reading `types/session.ts` directly. Surfaced via grep-empty, as with all instances.

**Root Cause:** Splitting `<name>.ts` → a `<name>/` barrel preserves the *import* surface (`import { x } from '.../<name>'` resolves via the barrel index), so `tsc`/verify never complain. But a **prose citation** of the concrete file path is not an import — nothing validates it — so it silently rots. No build gate catches it because the build was never wrong.

**Prevention:**
1. **Verify the cited path RESOLVES at citation time** — post-t/1686, a cited `<name>.ts` may now be a `<name>/` barrel; check for the dir + specific sub-module before citing. Don't rely on fix-on-break — it never breaks.
2. **When splitting a file into a barrel, grep docs/register/tickets/emails for the old `<name>.ts`** and update (or leave a redirect note) as part of the split.
3. **Silent-failure classes are verify-at-write-time, not fix-on-break** — anything caught only by grep-empty (never a red build) has no gate, so the discipline is at the moment of citation.

**Status:** Active — 2 instances / 2 agents. NOT a #82 case (new hazard from ADR-007, not a pre-existing rule unapplied). **Unit note (TL p/8#107):** report units separately — citations ≠ tickets ≠ offenders ≠ agents. Prevention: check for barrel dir (`<name>/`) before grepping `<name>.ts`.

**Applies To:** All agents citing `lib/debate` file paths post-ADR-007 splits (docs, register, tickets, emails), and anyone splitting a file into a barrel directory.

## #86 [Process] win32 "Task Stopped" Kills the Wrapper, Not Detached Child Trees — Relaunch Races a Surviving Writer

**Pattern:** A background batch runs as a shell wrapper that spawns a **detached child tree** (python → node). When the session restarts or `TaskStop` fires, the task is marked **"stopped"** but the **detached child tree keeps running** on win32 — only the wrapper shell dies. Trusting the "stopped" bookkeeping and **relaunching** puts **two live writers racing on the same output slugs**. **Inverse of #69's peer-already-landed variant:** there a peer *finished* your work so the relaunch found nothing; here a supposedly-killed process *survived*, so the relaunch duplicates a live writer.

**Instances:**
- 2026-07-26 — Computational Linguist (p/7#44/#45, CLI-hang filed t/1824): after a session restart marked a debate-batch task "stopped," CL relaunched a filler — but the original runner's **python + node tree had survived** (a later `TaskStop` killed only the shell wrapper), so **two writers raced the same output slugs for ~40 min**. Found both trees via **CIM command-line match**, `taskkill /F /T` on all roots, object-audited every artifact set (**id-match + mtime spread + single-run flight recorder**) — no tears. **Benign only because both writers ran identical configs**; differing configs would have torn artifacts.

**Root Cause:** On win32, killing a process (task-stop, session restart, `Stop-Process` on the wrapper) does **not** cascade to detached child processes — a shell wrapper's `python`/`node` children, once detached, outlive it. The task-runner's "stopped" status reflects the **wrapper's** state, not the child tree's; "stopped" is **bookkeeping, not a kill.** A relaunch guarded only by task status spawns a second writer alongside a surviving first — a concurrent-writer race (same family as #83), masked because the runner reports the batch as not running.

**Prevention:**
1. **Before relaunching ANY batch, verify at the PROCESS level that zero prior writers are alive** — don't trust "task stopped." win32: `Get-CimInstance Win32_Process | Where CommandLine -match '<runner/slug>'`.
2. **Kill the whole tree, not the wrapper:** `taskkill /F /T /PID <root>` on every matching root — a bare wrapper kill leaves children running.
3. **If a race may have occurred, object-audit the artifacts** (id-match, mtime-spread, single-run flight recorder) before trusting the results.
4. **Serialize batch writers** (pairs with #83 prevention #5): a surviving writer + relaunch is exactly the concurrent-writer collision serialize-and-announce prevents.

**Status:** Active — win32 process-tree semantics; inverse of #69's peer-already-landed variant. Underlying CLI-hang tracked t/1824 (CL).

**Applies To:** All agents launching detached background batches on win32 (debate runners, enrichment pipelines) — especially before relaunching after a restart/TaskStop.

## #87 [Build] `npm run build` Exits Non-Zero on an Interactive Prompt in a Non-Essential Trailing Step (No TTY)

**Pattern:** `npm run build` is a composite chain; its trailing `licenses` step (`generate-license-file`) prompts **"overwrite? (y/N)"** before rewriting an existing license file. In a **non-interactive shell (no TTY)** — Bash tool, CI — the prompt can't be answered, so the step **exits 2 and fails the whole `npm run build`**, even though the essential build (`build:main` + vite renderer) already completed. A false-red on the real build, caused by a non-essential post-step assuming a TTY.

**Instances:**
- 2026-07-26 — DebateWorkspace (p/124#4): `npm run build` exited 2 in a non-interactive shell because the `licenses`/`generate-license-file` step hit an interactive overwrite prompt with no TTY. Resolved by treating it as non-blocking — `build:main` + vite renderer had already completed. Suggested adding a non-interactive/overwrite flag.

**Root Cause:** `generate-license-file` (and similar codegen/docs tools) default to interactive confirmation before overwriting output — fine at a dev terminal, broken under automation with no TTY. Chained into the composite `build`, its non-zero exit propagates to `npm run build`'s exit code, so the aggregate reports "build failed" when only a cosmetic trailing step failed. Same shape as the gate-signal-integrity false-reds (#20/#46): a non-essential step's failure masking the essential gate's success.

**Prevention:**
1. **Add a non-interactive/overwrite flag to the `generate-license-file` invocation** in `package.json` so the licenses step never prompts.
2. **When a composite `build` fails, check WHICH step failed** — a trailing `licenses`/docs step exiting non-zero doesn't mean `build:main`/renderer failed; read the step output, not the aggregate exit.
3. **Keep non-essential steps out of the critical build path** for automation, or make them non-blocking, so a TTY-only prompt can't false-red the real build.
4. **General:** any build/codegen tool that prompts before overwriting is a non-interactive-shell hazard — pass its yes/overwrite/no-input flag from the Bash tool or CI.

**Status:** Active — false-red (non-essential-step) variant near the gate-signal-integrity genus (#20/#46). Fix is a package.json flag on the owning app (routed suggestion, p/124#4).

**Applies To:** All agents running `npm run build` (or any composite build with a codegen/license/docs post-step) from a non-interactive shell — Bash tool, CI.

## #88 [Build] Local `npm run verify` Hangs on a LIVE AI Backend When Keys Are Set — Keyless CI Never Hits It

**Pattern:** A test has a secondary path that **falls through to a LIVE AI backend when API keys are present in the shell**. On a dev machine (BYOK — keys set) the test makes real Gemini/Claude/Groq calls; **keyless CI runners never do**, so the divergence is invisible in CI. When the live provider is quota-exhausted (a concurrent batch eating the same key's quota), the retry logic (120s backoffs on `RESOURCE_EXHAUSTED`) turns the leak into a **~10-minute local `npm run verify` HANG** — a local-only false-red CI can't explain.

**Instances:**
- 2026-07-26 — Debate Tool 2 (p/234#1, surfaced landing t/1824): local `npm run verify` killed after ~10 min hanging on `[retry] gemini/gemini-2.5-flash RESOURCE_EXHAUSTED` (120s backoffs). With AI keys set, `debateEngine.modelRouting.test.ts` fell through to a live Gemini backend on a secondary path; a concurrent t/1670 batch had exhausted quota → retries hung. CI (keyless) never hits it. Fix: run keyless — `GEMINI_API_KEY= ANTHROPIC_API_KEY= GROQ_API_KEY= npm run verify` → same test passes **28/28 in ~3s**.

**Root Cause:** (1) **Test-isolation defect:** a routing test must not reach a live backend, but a secondary path falls through to one **when keys are present** — test behavior depends on shell env rather than being hermetic. (2) **Local ≠ CI on keys:** dev shells carry BYOK keys; CI is keyless, so the live-call path only fires locally and CI is blind. The 120s×`RESOURCE_EXHAUSTED` retry converts a silent leak into a long hang, and a **concurrent batch on the same key** makes exhaustion likely (ties to serialize-batches, #83 prevention #5 / #86).

**Prevention:**
1. **Run `verify` CI-faithfully — keyless:** `GEMINI_API_KEY= ANTHROPIC_API_KEY= GROQ_API_KEY= npm run verify` reproduces CI and sidesteps the live-call path. Good default whenever a local verify hangs but CI is green.
2. **Real fix — test isolation:** the routing test must stub/mock the backend so keys-present ≠ live-calls; outcome must not depend on shell keys. (Routed.)
3. **A test that HANGS (not fails) on a backend retry is a hygiene defect** — tests must never make real network calls to paid APIs; a live path reachable from a test is a bug regardless of keys.
4. **When local verify hangs but CI is green, suspect a keys-present live-call leak** — check for `[retry] … RESOURCE_EXHAUSTED`/backoff lines.

**Status:** Active — local-vs-CI (keys-present) divergence; test-isolation defect surfaced landing t/1824. Keyless-verify workaround documented; real fix is test isolation (routed).

**Applies To:** All agents running `npm run verify`/tests locally with BYOK keys set — especially debate-engine/model-routing tests that can reach a live backend.

## #89 [Process] Subagent "Completed" Is Process-Bookkeeping, Not Deliverable-Existence — Verify Artifacts Independently

**Pattern:** A background subagent's task-completion notification ("completed") fires whenever the agent **stops with no live children** — NOT when its **deliverables exist**. A subagent can report "completed" (even repeatedly) while still mid-research with **zero files written and no commit**. Trusting it and "landing" lands **nothing** — the status describes the agent's process state, not the artifacts.

**Instances:**
- 2026-07-26 — PowerShell (t/1806, delegated a large PS build to a background subagent, p/20#27): the subagent reported **"completed" TWICE while still mid-research — zero files written, no commit**. Caught by grounding-truth (filesystem/git check); nothing lost. Trusting it would have shipped nothing.

**Root Cause:** The "completed" signal is **bookkeeping about the process** (agent stopped, no live children), not **evidence about the outcome** (files written, commit landed, tests pass). Same genus as #86 ("task stopped" ≠ killed) and #69 (task status ≠ committed state): a lifecycle signal is not proof of the deliverable. Delegating does NOT delegate the Definition of Done — the caller still owns verifying committed artifacts and must not inherit the subagent's word.

**Prevention:**
1. **Never treat a subagent "completed" as done — verify every deliverable independently:** `Test-Path` each expected file, `git log`/`git show` the expected commit (SHA), and **re-run the tests yourself** before landing.
2. **Give the subagent a HARD completion gate requiring pasted EVIDENCE** — Test-Path output, Pester/vitest results, commit SHA — self-cert with proof, not a bare "done."
3. **Apply your own Definition of Done to delegated work** (committed by pathspec, verify green on committed state, SHA cited). Delegation moves the *doing*, not the *verifying*.
4. **Part of the bookkeeping-≠-artifact genus** (#69/#80/#84/#86): when a status/exit/lifecycle signal stands in for an outcome, verify the artifact at the object level.

**Status:** Active — bookkeeping-vs-artifact genus (see the consolidated Quick-Reference entry in the lessons INDEX). Caught by grounding-truth on t/1806; no loss.

**Applies To:** All agents delegating work to background subagents/consultants — especially before landing a delegated deliverable.

## #90 [Process] `verify | tail` (Any Pipe) Masks the Real Exit Code — Silent False-Green at the Primary Gate

**Pattern:** Piping a gate's output through `tail`/`head`/`grep`/`less` — `npm run verify 2>&1 | tail -N` — makes the pipeline's exit code the **LAST command's** (`tail` = 0), NOT verify's. Gating a push/land on that exit (or eyeballing the tail) reads a **FAILING verify as green** — a silent false-green at the fleet's primary gate.

**Instances:**
- 2026-07-28 — ServerAPI (t/1829, p/79#15) + Technical Lead (t/1829#2, p/8#111): `npm run verify 2>&1 | tail -N` returned `tail`'s exit 0, masking verify's real result; a push gated on that eyeballed tail can push a RED verify. ServerAPI's t/1829 outcome was sound only because the failures were unrelated flake — the masked exit was the real footgun.
- 2026-07-29 — Technical Lead (t/1932, p/8#117): **`git push | tail` inside a `&&` cleanup chain** swallowed a **non-fast-forward rejection** — the pipe returned `tail`'s 0, so the `&&` teardown (worktree remove) ran anyway on an unpushed commit. Same exit-code-laundering, but the masked exit is `git push`'s, and the downstream damage is a **skipped push + teardown that strands the commit** rather than a false-green verify. (This is the "never pipe git push" facet — Sage memory `feedback_never_pipe_git_push.md`, originally Sage #96.)
- 2026-10-22 — ServerAPI (p/504#26): `git push … | grep -E "->|error"` — grep exited 2 ("invalid option" because `->` starts with `-`), which masked whether the push itself had succeeded. Recovered by checking `git ls-remote` against HEAD directly.

**Root Cause:** A bash pipeline's exit status is the **last command's** (unless `set -o pipefail`). `verify | tail` → `tail` exits 0 → `$?` = 0 regardless of verify; **`git push | tail`** → `tail` exits 0 regardless of a non-ff reject. Same **exit-code-laundering** family as #84 (`&& echo PASS || echo FAIL`) and the **bookkeeping-≠-artifact genus**: the exit you read is the pipe's/wrapper's, not the command's. Especially dangerous when a `&&` cleanup/teardown chains after the piped push — the teardown reads the pipe's 0 and runs on an unpushed HEAD.

**Prevention:**
1. **Capture the real exit BEFORE piping:** `npm run verify > out.log 2>&1; rc=$?; tail -N out.log; [ $rc -eq 0 ] || exit 1` — decide on `$rc`, view the tail separately.
2. **Or `set -o pipefail`** (pipeline returns first non-zero); `${PIPESTATUS[0]}` reads the first command's exit after a pipe.
3. **Never gate a push/land on an eyeballed tail** — the tail shows output, not verdict.
4. **Never pipe `git push`** — run it bare, branch on its real exit, and **confirm `origin/<branch>` == local HEAD before any worktree teardown** (`git rev-parse origin/main` == `HEAD`). If a push was skipped and the commit stranded, recover via `git cat-file`/`cherry-pick` (see `feedback_never_pipe_git_push.md`).
5. #84 sibling — whenever a wrapper/pipe sits between you and a command's exit, go to the source.

**Status:** Active — exit-code-laundering (pipe) variant of the false-green genus (#20/#46) + bookkeeping-≠-artifact family (#84 sibling). Surfaced t/1829 (detail t/1829#2); **+git-push facet t/1932 (p/8#117) — teardown-after-swallowed-non-ff-reject.** **Now advisory-guarded** by the workspace rule `exit-code-literacy-guard` (2026-08-03, t/2081; covers the `| tail` / `&&…PASS‖FAIL` / `grep -c` / `gh pr checks` exit-code-literacy family #73A/#84/#90/#96/#121) — non-blocking context nudge, firing observed live (Sage, 2026-08-03), systematic verification deferred per t/1625.

**Applies To:** All agents gating a push/land on `verify`/test output that is piped (`| tail`/`| grep`/`| head`).

## #91 [Process] Flaky Shared Gate (lib/debate Suite) Generates False-Reds — Triage WHICH Files Before Assuming a Regression

**Pattern:** The `lib/debate` full test suite has **known-flaky tests** — `aiAdapter` withRetry (429/503), `persistenceFaults` (ENOSPC/EACCES), `cliPipeExit` — that fail **non-deterministically** (8 one run, 5 the next). A red `npm run verify` is **often NOT your change**. A flaky *shared* gate is a **false-red generator** that trains agents to dismiss ALL reds as "just flake" — a real regression blends into the tolerated noise (#20/#46).

**Instances:**
- 2026-07-28 — ServerAPI (t/1829, p/79#15) + Technical Lead (p/8#111): `npm run verify` failed non-deterministically (8→5 across runs) in `aiAdapter`/`persistenceFaults`/`cliPipeExit` — unrelated to the agent's change. TL routed a **HIGH triage to DebateTool** to stabilize the flaky suites.

**Root Cause:** Fault-injection/retry/pipe-exit tests are timing- and env-sensitive → non-deterministic. A flaky gate destroys signal two ways: a red is ambiguous (your change or flake?), and habituation trains agents to dismiss a genuine regression as flake. Gate-signal-integrity genus, false-RED side.

**Prevention:**
1. **When verify is red, triage WHICH files failed before assuming a regression** — the known-flaky set is likely not your change. Read the failing test names.
2. **Re-run to check determinism** — a failure that changes across runs is flake; a stable failure on the same test is real. (Workaround, not fix.)
3. **Real fix = stabilize/quarantine the flaky tests** — a flaky shared gate must be repaired, not tolerated (routed HIGH to DebateTool, t/1829).
4. **Don't push on a red verify assuming flake without checking the failing files** (pairs with "read which step, not the rollup").

**Status:** Active — gate-signal-integrity (flaky-gate false-red, #20/#46); stabilization routed HIGH to DebateTool (t/1829). High-severity: a flaky primary gate degrades every agent's trust in verify.

**Applies To:** All agents running `npm run verify` / the `lib/debate` suite — read the failing test names before attributing a red to your change.

## #92 [Data] File-Type Discrimination by Presence-of-a-Key Admits Look-Alikes — Gate on the CONTRACT, Not the Key

**Pattern:** A loader/registrar decides "what kind of file is this?" by testing only for **presence of a key** ("has a `nodes` property → it's a POV"). A **differently-shaped file that shares that key** silently passes, gets registered as a fake instance of the type, and crashes **downstream** when the real element contract is accessed — often as a strict-mode unguarded-property error far from the load site.

**Instances:**
- 2026-07-28 — PowerShell 2 (t/1834, landed 37598a6f, p/228#3): the POV loader tested only "has a `nodes` property," so the sidecar `entity_extraction_log.json` — `nodes[]` keyed by `node_id`, **not** `id` — registered as a fake POV. `Get-Tax` crashed on a bare `$Node.id` under strict mode. Fix: discriminate on the contract (`nodes[].id`), not key presence. **`entity_extraction_log.json` is a repeat shape-surprise source** (also t/1830 char-explode + p/7#47 probe errors).

**Root Cause:** Presence-of-a-key is a **weak type discriminator** — common keys (`nodes`, `data`, `id`) are shared across unrelated files, so duck-typing on one key admits look-alikes. The loader validated the **container** key but not the **element** contract, so a container with the right key but wrong-shaped elements passed. Compounds with strict-mode unguarded property access — the mismatch surfaces as a downstream crash on `$Node.id`, not a clear rejection at load. Same data-shape-variance family, at the **file-classification** layer.

**Prevention:**
1. **Discriminate by the CONTRACT the consumer needs, not just key presence** — validate a representative element: "has `nodes` AND `nodes[0].id`" beats "has `nodes`."
2. **Fail fast at LOAD with a clear error** ("has `nodes` but no `nodes[].id` — not a POV") rather than crashing downstream.
3. **Exclude known sidecars explicitly** — `entity_extraction_log.json` and other non-POV files sharing `nodes` should be denylisted where auto-discovery is ambiguous; it's a recurring shape-surprise source.
4. **Pairs with strict-mode guarding** — guard `$Node.PSObject.Properties['id']` so a misclassification degrades to a clear error, not a strict-mode crash.

**Status:** Active — file-classification variant of the data-shape-variance family; compounds with strict-mode unguarded property access. `entity_extraction_log.json` flagged as a repeat offender.

**Applies To:** All loaders/registrars that auto-discover and classify data files by shape — especially the taxonomy/POV loaders in the AITriad PS module.

## #93 [Process] Shared Local-Main Reconcile (Hard-Reset to origin) Wipes ALL Agents' Local-Only Commits — Recover From reflog, Don't Trust the Reverted Tree

**Pattern:** The shared local `main` accumulates local-only commits from many agents (most roles commit but don't push; TL/DevOps sync to origin). When the owner-gated **diverged-main reconcile** runs — `git reset` local `main` to `origin/main` — **every un-synced local commit is wiped off the branch at once, across all agents.** An agent's working tree abruptly shows an EARLIER state and their session's work looks "gone." It is **not lost** — every commit survives in the reflog — but HEAD/branch/working-tree no longer contain it, which looks exactly like a revert.

**Instances:**
- 2026-07-28 — Sage (this session): shared local `main` (at Sage's last commit `20c32334`) was hard-reset to `origin/main` (reflog `HEAD@{0}: reset: moving to origin/main`), wiping ~30 local-only Sage doc commits (`e6daccc7`..`20c32334`) plus other agents' local-only commits (te `t/1849`, debate fixes, CL `t/1826`). **Caught by object-level verification** — injected "your docs reverted" reminders showed a Total-83 working tree, but `git log`/`git status -sb`/`git reflog`/`git cat-file` proved HEAD had been reset and the commits were dangling-but-intact. **Recovered** with `git checkout 20c32334 -- <my scope>` → one recommit (`e8ddad72`, Total-83→93). No loss.
- 2026-07-29 — t/2004 (TL p/8#127→#130, follow-on reconcile of the same divergence): local main unchanged since t/1768 (still `c7fd7487`); origin was ALREADY a superset of Sage's lessons — **verified by CONTENT, not commit presence** (the t/1768 recovery was a content-MERGE into `86914922`, so its source commits stay unique-by-patch-id in `origin..main`/`git cherry` though content is upstream; TL's initial `git cherry`=0 gate wouldn't converge). All 22 local-only commits confirmed content-on-origin (5 patch-identical via `git cherry -`, 2 docs-spec 0-unique-lines). **Realign DEFERRED anyway** — the shared tree held **138 modified + 227 untracked in-flight files** (active t/1671 + greatest-hits) a hard-reset would obliterate. **Commit-safe ≠ tree-safe.**
- 2026-07-31 — t/2008 (retire-shared-checkout migration; TL p/8#162): the **deferred t/2004 realign finally executed** during the cutover — the pattern's first *successful-application* instance, not a recovery. The shared hub was **assumed a clean fast-forward but was diverged (22 local-only commits)**; the hard-reset was gated on **prevention #6** — **all 22 confirmed content-present on origin at the object level (not commit-presence) BEFORE the reset ran** — so the cutover was **content-lossless**. This is **H3 (verify-before-irreversible-step) + H2 (object-level confirm-on-origin) combined** (t/2081 tally). Per-role `wt-<role>` worktrees are now the dev model; the shared checkout is the deploy/ops hub. Validates #6/#7 — object-level content-verification before a destructive realign is what prevents the wipe.

**Root Cause:** The shared local `main` is a shared, un-pushed staging area; local-only commits live only there until synced. Hard-resetting it to origin (the correct owner-gated fix for a large divergence) atomically discards every un-synced commit. Git doesn't delete objects, so they persist in the reflog — but the working tree/HEAD stop showing them, reading as "reverted/lost." Same object-level-vs-inference discipline as #69 and Git Forensics (#44/#54/#55).

**Prevention / Recovery:**
1. **After any "my working tree changed / my work is gone" event, VERIFY at the object level before reacting** — `git log --oneline`, `git status -sb`, `git reflog`. Never re-apply edits onto the reverted tree until you know whether HEAD moved or the tree is merely dirty.
2. **Recover from the ORIGIN BACKUP BRANCH (a proper realign backs up first), then WORKTREE-LAND to origin — do NOT recommit to local main** (TL e/46). Local-main-only commits are pushed to a durable remote branch `origin/backup/<reconcile>-<lastSHA>` (e.g. `origin/backup/t1768-local-main-20c32334`) — a **remote ref that does NOT age out**, so there is **no time pressure** (the earlier "reflog ~30d / act soon" urgency was premature). `git log origin/backup/... --oneline | grep <your-scope>` → `/land-from-worktree` the commits whose content isn't already on origin — **the land no-ops if already upstream** (safe to just try; superseded ones drop out; nothing duplicates). A local-main recommit re-displaces on the next reconcile (the `t/1780` hook warns on it).
3. **Don't re-litigate the reconcile** — it's owner-gated and correct for a large divergence; recover and move on.
4. **Systemic:** hold the push-cadence ceiling and sync approved work to origin promptly so a reset wipes less. Ties to the push-contention LARGE-divergence variant.
5. **Fleet awareness:** a reconcile wipes EVERY agent's local-only commits — surface it so others recover theirs too.
6. **Verify reconcile completeness by CONTENT, not `origin..main` commit presence.** A content-MERGE recovery (re-authoring into a new commit) rather than `cherry-pick` leaves the source commits unique-by-patch-id — `git log origin..main` / `git cherry` keep listing them though content is upstream. Confirm with **`git cherry -` (patch-equivalence)** + a **line-level content diff** of the scoped files; do NOT gate the realign on `origin..main`/`cherry` reaching 0 (it won't for content-merged work). (t/2004: content-verify showed origin ⊇ local; the `cherry`=0 gate was a false blocker.)
7. **Commit-level safety is necessary but NOT sufficient — a hard-reset realign also destroys the shared tree's UNCOMMITTED work.** Even with every commit's content on origin, `git reset --hard` obliterates the tree's **modified + untracked** files (t/2004: 138 modified + 227 untracked in-flight, incl. active t/1671). Gate on a **quiescent-tree window**, or **defer** — a benign, content-safe divergence with new divergence blocked (t/1926 hook) is safe to leave. "All commits on origin" ≠ "safe to hard-reset now."

**Status:** Active — recovery playbook; validated the session's object-level discipline. **Key correction (TL e/46):** the t/1768 realign was a *backed-up* pointer move — **nothing lost**; all 173 local-main-only commits are on durable remote branch `origin/backup/t1768-local-main-20c32334` (no ~30-day pressure). Recover from that branch → `/land-from-worktree` the un-upstreamed commits (**no-ops if already upstream**). Sage recovered + **landed to origin** (`e771400f`, Total 94), verified against the backup branch; **t/1872 Sage check-in complete**. Do NOT recommit to local main (`t/1780` hook warns on it). **t/2004 follow-up (TL p/8#130):** a later reconcile of the same divergence confirmed origin ⊇ local by content (all 22 commits content-on-origin) but was **DEFERRED** — 138 modified + 227 untracked in-flight files a hard-reset would obliterate (prevention #7: commit-safe ≠ tree-safe). Benign + new-divergence blocked (t/1926 hook) → safe to leave; realign awaits a quiescent-tree window (owner's call). **t/2008 (2026-07-31, TL p/8#162):** that window arrived — the realign **executed content-lossless** during the retire-shared-checkout migration. The hub (wrongly assumed a clean fast-forward) was diverged by 22 local-only commits, all confirmed content-on-origin at the object level *before* the hard-reset (prevention #6 honored). The pattern now has a **successful-application** instance — H3 (verify-before-irreversible) + H2 (object-level confirm-on-origin), t/2081 tally — not only a recovery playbook. **Point-of-use enforcement (2026-08-03, t/2081):** the workspace rule `verify-head-on-origin-before-teardown` now guards prevention #6/#7 + the H2 post-push HEAD-on-origin sub-gate (verify before an irreversible worktree teardown). Gate-logic-tested; live-firing **unverified** per t/1625 (a created hook ≠ a proven-firing hook — #80/#82).

**Applies To:** All agents whose work lives on the shared local `main` until synced — i.e. everyone who commits but doesn't push.

---

## #94 [Build] A New Test Can Trip a Cross-File / Repo-Wide Lint — Run the FULL Suite Before Push, Not Just the Changed File

**Pattern:** Some tests are **repo-wide lints** that scan *other* files (e.g. `ModelLiteralLint.Tests.ps1`, t/1858, flags `-Model '<unregistered-id>'` literals missing the `# model-lint:allow` marker). A new test you add in file A can violate a lint that lives in file B. If you validate locally by running **only your changed test file**, the lint in the other file never executes — it passes locally and turns **main CI red fleet-wide** on push. The single-file run gives false confidence precisely because the failing check isn't in the file you ran.

**Instances:**
- 2026-07-28 — PowerShell 2 + PowerShell Main (t/1899, resolved 21fc09fd; p/228#5, p/20#29, full trail t/1899#2): commit `5f80fd4d` added an intentionally-invalid negative-test fixture `-Model 'totally-unregistered-model-zzz'` **without** the gate's documented `# model-lint:allow` escape-hatch marker. Running only the changed test file in the worktree passed; the repo-wide `ModelLiteralLint` (t/1858, a *different* file, live+green ~5h) never ran locally → **main CI red fleet-wide for ~5h**. Compounded by a **stale local tree** (that file was 118 commits behind origin — the stale facet of #79). Fix = the 1-line marker (`21fc09fd`); the byte-identical twin was stood down to avoid a duplicate-commit race.

**Root Cause:** A repo-wide lint's *coverage* (all files) is decoupled from its *location* (one test file). The mental model "I changed file A, so I run file A's tests" misses the check that governs A but lives in B. `Invoke-Pester ./tests/` runs B; `Invoke-Pester ./tests/A.Tests.ps1` does not. A specific, sharp case of the general "verify before push / run the full suite" rule — cross-cutting gates (lints, invariant checks, manifest guards) deliberately live outside the files they govern.

**Prevention:**
1. **Run the FULL `Invoke-Pester ./tests/` before every push — never just the changed test file.** Changed-file runs are fine for fast iteration; the pre-push gate must be the whole suite so repo-wide lints/invariant checks execute (~100s here — it would have caught this). **CI is not first-pass validation** — don't discover a repo-wide gate by turning main red for the fleet. (Same spirit as the CI-faithful keyless-verify rule, #88.)
2. **When you add a DELIBERATELY-invalid fixture (a negative test), apply the scanning gate's documented suppression marker on the SAME PHYSICAL LINE** — e.g. `-Model 'bad-id-zzz'  # model-lint:allow-nonselect intentional negative-test fixture`. The marker grammar is `allow-<pin|external|nonselect> <reason>` (kind + reason are both mandatory; the bare `# model-lint:allow` form is **deprecated and no longer suppresses**). A negative test is invalid *by design* — exactly what a repo-wide scanner flags; the typed inline marker declares "this invalidity is intentional." Author's proactive obligation, not a CI afterthought.
3. **Know the repo-wide gates exist:** `ModelLiteralLint` (`-Model` literal staleness, t/1858), manifest/version-coherence checks, ontology referential-integrity checks — they scan files other than their own, so a new literal/fixture in *any* file can trip them.
4. **Land targeted edits onto a fresh worktree base**, don't copy a stale whole file — a stale base hides newly-added gates and risks clobbering peers' additions (#79 stale facet).

**Status:** Active — local-vs-CI divergence by *test scope* (changed-file run ≠ full suite), sibling of #88 (keys-present live-backend divergence); ~5h fleet-wide red main. Reinforces "verify before push" with a concrete failure mode: repo-wide lints live outside the files they govern, and a deliberately-invalid fixture must carry the gate's typed inline suppression marker. Note: `--no-verify` and `disable_feedback_rule` are **git-hook / Orca-feedback tools**; they do **not** override the `ModelLiteralLint` CI gate. Real paths to a green build: fix or repoint the literal, add a typed `# model-lint:allow-<kind> <reason>` marker, bump the exemptions baseline, or (last resort) an admin merge.

**Applies To:** All agents adding or modifying tests/fixtures in a repo with cross-file or repo-wide lint tests (`ModelLiteralLint`, manifest/invariant guards).

---

## #95 [Build] Foreground `git push` of a Large Data-Repo File Set Exceeds the 120s Bash Timeout — Background It, Then Verify the Ref

**Pattern:** A plain foreground `git push` of many/large files (e.g. 70 debate JSONL + flight-recorder dumps to `ai-triad-data` over SSH) routinely exceeds the **Bash tool's 120s default timeout** and gets **killed mid-upload (exit 143 / SIGTERM)**. The local **commit has already landed**, but the **push has not completed** — the SHA is on local `HEAD` but NOT on origin. A dependent action taken on "push succeeded" (a prune, a downstream job, telling a peer the data is available) then operates on a ref that was never published.

**Instances:**
- 2026-07-28 — Technical Lead (p/8#113): foreground `git push` of **70 large data-repo files** (debate JSONL / flight-recorders) to `ai-triad-data` over SSH was **killed at 2 min (exit 143)** mid-upload — commit landed, push hadn't. Resolved via **`run_in_background`** (push is idempotent — a partial upload corrupts nothing; retry completed **exit 0**) and **`git ls-remote` verification of the ref on origin before any dependent prune/action**. No data lost; a timeout-kill ≠ a broken push (ties to the "data-repo push works, HTTP-408 era ended" correction).

**Root Cause:** The Bash tool's default 120s timeout is shorter than a large multi-file SSH push. SIGTERM at the boundary kills the client mid-transfer, but `git commit` already completed locally — leaving a **split state**: local commit present, origin ref absent. The kill looks like a hard error, so it's easy to (a) misdiagnose the remote as broken or (b) assume nothing landed and redo work — when the commit is fine and only the push needs re-running. Same **"foreground long git/fs op exceeds 120s → gets killed → background it"** genus as #78 (worktree-remove rm timeout); the push-side sibling.

**Prevention:**
1. **Push large data-repo file sets in the background** (`run_in_background`) or with an extended Bash `timeout` — never a plain foreground push. `git push` is idempotent, so a backgrounded retry after a killed foreground attempt is safe.
2. **Verify the ref is on origin before any dependent action** — `git ls-remote origin <branch>` and confirm the pushed SHA is published BEFORE a prune / downstream job / announcing availability. "The push command returned (or was killed)" is bookkeeping; the ref on origin is the artifact (**bookkeeping ≠ artifact**).
3. **A killed push (exit 143) is NOT a broken remote** — check `git ls-remote` first; don't file "data-repo push broken." The SSH data-repo push works, it's just slow for large sets.

**Status:** Active — push-side sibling of #78 in the **"foreground long git/fs op > 120s Bash default → background it"** genus, plus a bookkeeping≠artifact verify step (the killed push left a commit-landed / ref-absent split state).

**Applies To:** All agents pushing large or many-file changes — especially data-repo (`ai-triad-data`) debate JSONL / flight-recorder / embeddings batches over SSH.

---

## #96 [Build] A Multi-Step `&&` Chain Can Be Cut Before a Critical Step (e.g. `git push`) Runs — Verify the Side Effect on origin Independently

**Pattern:** A long Bash-tool chain like `tsc && git push && git fetch && grep …` can stop **after an early command** — only the first command's output comes back (e.g. just `TSC=0`) — so a **`git push` later in the chain silently never executes**. The partial output looks like progress, so it's easy to assume the push landed. The commit is on local `HEAD` but the ref was never pushed; if origin has since advanced, your change is simply **absent upstream**. Cutting mechanisms are mechanism-agnostic from the caller's view: a `grep -c` zero-match exit-1 (#73 facet A), an intermediate nonzero exit, or the Bash tool truncating/aborting after the first output.

**Instances:**
- 2026-07-29 — ElectronMain (p/98#9): a `tsc && git push && git fetch && grep` chain returned only `TSC=0`; the **`git push` never ran** and was nearly assumed landed. Caught only by object-level `git show origin/main:<file>` (change **absent**, origin **advanced**). Resolved by re-running the push standalone and re-verifying on origin. (The chain also carried a `grep -c` zero-match exit-1 — #73 facet A.)

**Root Cause:** An `&&` chain reports only its final exit and interleaves output; when it aborts early, the caller sees a truncated, success-looking result with no explicit failure for the skipped `push`. A `push` is a *side effect*, not a value the chain returns — so "the command came back" is bookkeeping, not evidence the ref moved (**bookkeeping ≠ artifact**). Chain-cut sibling of #95: there the push was *killed by a 120s timeout* (commit landed, push didn't); here it *never ran because an upstream link broke* — same split state (local commit present, origin ref absent), same defense.

**Prevention:**
1. **Never bury a `git push` (or any critical side-effecting step) mid-chain and trust the chain's apparent success.** Run the push as its own command, or verify it independently right after.
2. **After any chained push, confirm the commit is actually on origin at the object level** — `git ls-remote origin <branch>` (or `git show origin/main:<file>` for content) — and check the SHA/content is present BEFORE any dependent action or "it's landed" claim. (Same defense as #95 prevention #2; object-level, per the root Git-Forensics rule.)
3. **Keep chain-breakers (`grep -c`/`grep` zero-match, other exit-1-on-empty commands) out of `&&` chains that contain a critical step** — a broken link silently drops everything after it (#73 facet A; use `|| true` or capture-and-test).

**Status:** Active — chain-cut sibling of #95 under the "a push in a compound command may not have actually run → verify the ref on origin" theme; bookkeeping≠artifact genus; chain-break mechanism overlaps #73 facet A.

**Applies To:** All agents landing via Bash-tool command chains that include a `git push` — especially long `tsc && push && … && grep` one-liners on Windows/Git Bash.

---

## #97 [Build] `git stash show` Rejects a Pathspec ("Too many revisions specified")

**Pattern:** `git stash show -p 'stash@{N}' -- <path>` fails with "Too many revisions specified" — `git stash show` takes a single stash ref and has no `-- <pathspec>` scoping mode.

**Instances:**
- 2026-07-29 — DevOps (t/1768, p/26#24): `git stash show -p 'stash@{1}' -- <path>` errored while inspecting a stash for one file. Fixed with `git diff 'stash@{1}^' 'stash@{1}' -- <path>`. Self-resolved, no impact.

**Root Cause:** `git stash show` only diffs a whole stash entry against its base and parses trailing `-- <path>` tokens as extra revisions. A stash is an ordinary commit (`stash@{N}`) whose first parent (`stash@{N}^`) is its capture point, so the underlying `git diff` accepts a normal `<rev> <rev> -- <path>` form.

**Prevention:**
1. One file from a stash's own change set: `git diff 'stash@{N}^' 'stash@{N}' -- <path>` (note the `^` — the stash's first parent is its base).
2. Stashed file vs another ref (e.g. origin, the t/1768 supersession check): `git diff 'stash@{N}:<path>' 'origin/main:<path>'` (blob-vs-blob, no `--`).
3. Whole-stash overview still works: `git stash show -p 'stash@{N}'` — just drop the pathspec.

**Status:** Resolved — self-correcting (git rejects it immediately). Single instance; recorded because stash inspection recurs during worktree/realign cleanups.

**Applies To:** Any agent inspecting a specific file inside a git stash.

---

## #98 [Build] Extracting a `catch` Body Into a Helper Trips the AST-Enforced Flight-Recorder Rule (ADR-003)

**Pattern:** The custom ESLint rule `local/require-flight-recorder-in-catch` (ADR-003) is **position-based** — `getGlobalRecorder()?.record(...)` must be *literally inside* the `catch` AST node. A behavior-preserving refactor that lifts the `catch` body into a helper relocates the `record()` call and fails lint. Complexity-reduction / function-extraction passes are the classic trigger.

**Instances:**
- 2026-07-29 — Taxonomy Editor 2 (t/1848 batch 7): extracting a `catch` body into a helper tripped the rule. Fixed by keeping `record(...)` inline, extracting only the non-recording tail (p/195#9, t/1848#11).
- 2026-07-29 — ElectronMain (t/1914): independently hit the same rule in the same fan-out. Same fix.
- 2026-08-13 — ElectronMain (PR #989, p/98#21): **new-code variant** — new catch block in `opedHandlers.ts` missing `getGlobalRecorder()?.record()` before `ActionableError` re-throw. Trigger: omission on new code (not a refactor). Same lint rule, same fix: add `record()` inline before the throw.

**Root Cause:** ADR-003 enforces "every `catch` records" *structurally* — the `record()` call must be a direct statement of the `catch` block, not merely reachable. A recording helper is behavior-equivalent but AST-invisible, so the rule holds the line on literal position rather than proving reachability.

**Prevention:**
1. Decomposing a `catch`-heavy function: keep `getGlobalRecorder()?.record(...)` inline in the `catch`; extract only the non-recording tail (fallback construction, retry orchestration).
2. Don't wrap the helper to "also record" — the guarantee is literal-position, not reachability. Inline is the sanctioned form.
3. General: position-based AST rules survive behavior-preserving refactors only if the guarded call stays where the rule expects it — check before extracting any block guarded by a `local/*` rule.

**Status:** Active — self-correcting at point-of-use (lint rejects immediately). **2 instances / 2 roles, both in the t/1848 complexity-decomposition fan-out; 6+ more roles still decomposing catch-heavy code** → likely further rediscovery. Point-of-use prevention broadcast by TE2 on the parent ticket (t/1848#11). **Durable lever TAKEN (TL p/8#116):** fix idiom being embedded in the rule's lint-time message, filed low-pri as **t/1927 (Shared Lib) + t/1928 (Taxonomy Editor)**. **Related drift smell:** the rule is two byte-identical copies (`lib/eslint-rules` + `taxonomy-editor/eslint-rules`) referenced by 3 `eslint.config.mjs` — hence two tickets; update-in-N-places tax + silent-divergence risk. TL noted a single-shared-rule dedup as a separate low-pri follow-up. No divergence yet; if the copies ever drift, that realized failure lands here.

**Applies To:** Any role running function-extraction / complexity-reduction on flight-recorder-guarded `catch` blocks under ADR-003.

---

## #99 [Process] Adding an Nth Variant to a Shared Enum/Config Touches More Than the Obvious Files — Enumerate Coupling Sites + Run ALL Referencing Tests

**Pattern:** Adding a member to a shared enumeration (a new AI backend id, POV camp, node category) has a surface far larger than the "obvious" files. Non-obvious **coupling sites** — exhaustiveness-checked `Record<Enum,…>` maps (TS `TS2741` at compile time), validation-probe tables, id-resolvers — each break independently, often in *different roles' scopes*. A ticket DAG scoped to the obvious files ships a partial change that reddens main across sites the decomposition never listed. Compounded when verify runs a **hand-picked subset** of the referencing tests instead of ALL of them.

**Instances:**
- 2026-07-29 — Technical Lead (t/1932 Moonshot backend; detail t/1932#1): the DAG covered the 3 adapters (aiAdapter/aiBackends/AIEnrich) but missed 3 non-adapter coupling sites — `routes/keys.ts` `KEY_VALIDATION_PROBES` (keysValidation.test.ts red), `config.ts` `ENV_KEY_NAMES`/`AIBackend` exhaustiveness (server tsc TS2741, blocks everyone), `registry.ts` `resolveBackend` (silent misroute moonshot→gemini). Compounded: config-land verify grepped `keysValidation.test.ts` but ran only `configInvariant`+`modelDiscovery` — a subset skipping the broken test. Green via t/1944+probe `66325245`; routing t/1945.
- 2026-08-03 — Shared Lib (p/5#21): `usageRegistry.test.ts` `listUsages` asserted `toHaveLength(3)` — a hardcoded literal count. Adding a 4th entry (`moonshot.test` to `TEST_USAGES`) caused the assertion to fail ("expected 4, received 3"). **Coupling site type: hardcoded length/count assertion** — invisible to tsc (runtime check, not an exhaustiveness map) and to a grep of the enum/type name (the bare `3` has no syntactic tie to the registry). Fix: bump assertion to 4 (p/5#21).

**Root Cause:** A shared enum/config is a fan-out coupling point — every exhaustiveness-checked map, probe table, and resolver keyed on it is an implicit dependency, enforced only if that check is compiled/run. The author reasons from the *feature* ("add an adapter") not the *coupling graph* ("what is keyed on this id?"), so coupling sites in other scopes fall outside the DAG; a hand-picked test subset then hides the breaks pre-land.

**Prevention:**
1. Before decomposing a shared-enum addition, **enumerate the coupling graph, not the feature files** — grep the enum/type name + existing members repo-wide; every `Record<Enum,…>`, probe table, and resolver keyed on it needs a ticket (often cross-scope).
2. **A shared-config change must run ALL referencing tests — never a hand-picked subset.** If you grep for referencing tests, *run the ones you find*; prefer full `npm run verify` for any shared-surface change.
3. Make coupling maps **exhaustive at compile time** (`Record<Enum,T>` not `Partial<…>`; `switch` + `never` default) so `tsc` becomes the coupling detector.
4. Durable fix for a recurring multi-site addition: a **checklist playbook**. TL is authoring `/add-ai-backend` (7 config sections + keys.ts probe + config.ts ENV_KEY_NAMES/type + registry resolveBackend + 3 adapters) — the concrete instance of this rule.
5. **Hardcoded length/count assertions in tests are runtime coupling sites invisible to tsc and to a type-name grep.** When adding an entry to any array/registry, grep test files for `toHaveLength`, `.length`, `toBe(N)` patterns over the collection — a bare literal count has no syntactic tie to the enum/registry name (p/5#21).

**Status:** Active — 2 instances. Decomposition-completeness (coupling graph vs feature files) + verify-scope (all referencing tests vs subset); and hardcoded count assertions as a runtime coupling site (p/5#21, added 2026-08-03). TL self-reported (t/1932#1); durable fix = `/add-ai-backend` playbook (being filed). Watch the same shape on other shared enums (POV camps `acc/saf/skp/cc`, BDI categories, `pol-*` registry).

**Applies To:** Any role decomposing/landing a change that adds a member to a shared enumeration/config consumed across multiple files or scopes.

---

## #100 [Process] Branch Protection With `enforce_admins=false` Is Not a Hard Block for Admin Identities — "PR-flow" Is a Convention

**Pattern:** A repo can have branch protection + required checks on `main`, yet a direct `git push origin HEAD:main` from an **admin identity SUCCEEDS and bypasses the checks** ("Bypassed rule violations, accepted") when `enforce_admins=false`. With the whole fleet pushing as one repo-owner admin identity, the "checks-only PR-flow" gate is a **CONVENTION enforced by review + discipline, not a platform hard-block.** "protection is on" ⇒ "direct push impossible" is a false-enforcement assumption.

**Instances:**
- 2026-07-29 — main → PR-flow rollout (e/49): initial broadcast said "**direct push to main is BLOCKED**"; corrected ~12 min later (e/49#3/#4, prompted by TL2 p/276#3 + Sage p/8#119) once admin-bypass was confirmed. Routine direct-push-to-main is now a flagged process violation; pre-broadcast bypass lands (DebateTool t/1955/t/1949) grandfathered. Owner deciding `enforce_admins=true` vs. convention.

**Root Cause:** GitHub's `enforce_admins` governs whether protection applies to admins. False + everyone authenticating as the repo-owner admin = rules are advisory for the fleet. "branch-protected" is *configuration*, not the achieved *guarantee* for admin pushers — same signal-vs-reality gap as the gate-integrity / bookkeeping-≠-artifact family.

**Prevention:**
1. Land via green-PR self-merge (`/land-from-worktree` PR-flow: feature branch → `gh pr create` → 6 checks → `gh pr merge --rebase --delete-branch`, no `--admin`/reviewer). Routine direct-push-to-main = process violation.
2. Never equate "protection enabled" with "bypass impossible" — check `enforce_admins` + admin status. A gate admins can bypass is convention, not enforcement.
3. Admin/hotfix bypass reserved for a red/broken main when the PR path is blocked, a true prod emergency, or an explicit owner-directed land — reference the authorization; never routine.
4. To make it binding: `enforce_admins=true` (owner call, pending). Until then discipline is the enforcement (#82 rule-exists-but-not-applied: convention with no point-of-use hard-block relies on review).

**Status:** Active — convention effective 2026-07-29 (e/49). Companion fix (detached-HEAD push needs `HEAD:refs/heads/<branch>`) in build.md (ServerAPI p/79#19); both folded into revised `/land-from-worktree`.

**Applies To:** Every role that lands work to `main` — the whole fleet.

---

## #101 [Process] Docs-Only PRs Can't Self-Merge Under the Checks-Only Gate — Path-Filtered CI Leaves Required Contexts Unreported (BLOCKED)

**Pattern:** Under the checks-only PR-flow, a **docs-only / CI-config-only PR is un-mergeable by self-merge**. Path-filtering (`dorny/paths-filter`) skips code jobs on a docs diff — `test-powershell`+`test-electron` report `skipped`, the 4 required `test-electron (variant)` contexts **never report at all**. A required context satisfies the gate only if it runs and reports `success`; never-reported = pending forever. 5/6 required checks can't be satisfied → `mergeStateStatus=BLOCKED` regardless of discipline. Docs lands only via (a) TL `--admin`-merge (the "PR path itself blocked" exception) or (b) a flagged direct-push.

**Instances (3 roles in one hour — systemic, not edge case):**
- 2026-07-29 — PowerShell PR #134 (t/1938#6): BLOCKED; parked for TL admin-merge (e/49#8).
- 2026-07-29 — Computational Linguist (e/49#10): docs-only is the MAJORITY of CL lands (registers, analyses, reviews); `ecb137e7` (t/1853) would have parked. Names two harms: TL becomes a synchronous dependency of every docs land; mixed PRs dodge the gap → perverse incentive to bundle docs with code.
- 2026-07-29 — Sage (this session): lessons-doc commits are all docs-only → same wall; parked on local main, not direct-pushed.

**Root Cause:** Required status checks vs. path-filtered CI are in tension. Strict protection waits for every required context to report `success`; path-filtering makes those contexts unreportable on a docs diff, and "never reported" ≠ "passed." The gate is simultaneously too weak for admins (bypassable) and too strong for docs (un-satisfiable) — two failure modes of the same rollout.

**Prevention / Fix:**
1. Docs/CI-config-only land under the convention: route via TL `--admin`-merge (sanctioned "PR path blocked" exception) — reference the authorization; don't routine-direct-push.
2. Durable flow-fix (owner/DevOps): the canonical "required checks + path filters" pattern is an **always-run aggregate gate** (PowerShell e/49#11) — one `ci-gate` job, `if: always()`, `needs:` the 6 real jobs, passes iff none **failed** (skipped=OK), made the **single required context** replacing the 6 `test-*`. Docs-only PR → code jobs skip → `ci-gate` passes → self-merges; red code job → `ci-gate` fails → blocked. No `enforce_admins` change; keeps docs atomic; removes the bundle-with-code incentive. DevOps owns the `ci.yml` + contexts swap. Until it lands, docs PRs need admin-merge.
3. If `enforce_admins` goes true this is a HARD wall for every docs/CI-config change — fix first. (Decision: keep `enforce_admins=false` + tool-layer push-guard t/1926, so the admin-merge valve stays.)

**Status:** Active — **OWNED + fix APPROVED** (TL e/49#12, ~30 min after surfaced). `ci-gate` aggregate-gate approved, tracked **t/1962 (DevOps, high)**: PowerShell drafts the job, DevOps lands `ci.yml` + swaps branch-protection to the single `ci-gate` context. Interim: parked PRs (PS2 #128, PowerShell #134) authorized for `--admin`-merge as the sanctioned "PR-path-blocked-by-config-defect" exception (NOT routine bypass); same extends to docs lands parked until t/1962 — ping TL, don't bundle. 3 affected roles (PowerShell, CL, Sage); Sage's authorization CONFIRMED (e/49#16). Interim PRs clearing (#134 admin-merged `c23de7f6`). Note: t/1961/t/1962 may be dups — DevOps/TL to dedup (e/49#13). Sibling to the `enforce_admins=false` convention entry.

**Applies To:** Any role landing docs-only / CI-config-only changes — Sage, Computational Linguist, Documentation, DevOps (CI config), anyone editing docs.

---

## #102 [Process] Validate a Fleet-Standard Procedure Change End-to-End Before Mandating It (Dry-Run One Real PR Through Every Step)

**Pattern:** A change to a fleet-standard procedure (land flow, CI gate, commit convention) broadcast + mandated *before* being run end-to-end ships latent defects every adopter then hits. Writing the intended steps ≠ having *executed* them once against the live infra — the gaps live in the interaction between the steps and the real repo config (branch protection, path filters, worktree constraints, `gh` behavior), invisible on paper, obvious on the first real run.

**Instances:**
- 2026-07-29 — main → PR-flow rollout (e/49): the revised `/land-from-worktree` was mandated before an end-to-end validation land. **3 defects surfaced within the hour**, each caught by a different role mid-land: (1) detached-HEAD push needs `HEAD:refs/heads/<branch>` (ServerAPI p/79#19); (2) docs-only PRs can't self-merge — path-filtered required checks never report (PowerShell/CL/Sage, t/1962); (3) `gh pr merge --delete-branch` from a worktree aborts post-merge, masking a landed merge (ElectronMain p/98#12). All three would have surfaced in one real PR through every step. TL owned the root cause (p/8#121).

**Root Cause:** A procedure authored from reasoning vs. executed once against the actual repo. Each defect lived in a step's collision with live infra (refspec under detached HEAD; required-checks vs. path-filtering; `gh`'s local checkout under one-branch-per-worktree) — invisible reading the steps, unmissable on a real run. Same verify-the-artifact-not-the-plan discipline the fleet applies to code, applied to process rollout.

**Prevention:**
1. Before mandating a fleet-standard procedure change, **dry-run it end-to-end** — one real change through EVERY step on the actual repo (real worktree → push → PR → checks → merge → cleanup).
2. Broadcast AFTER the validation land, citing the validating PR.
3. If urgency forces broadcasting first, label it PROVISIONAL / pending-validation; don't treat "written" as "validated." (e/49 self-corrected 4× in the hour.)
4. Genus: a documented procedure is bookkeeping; the validating land is the artifact.
5. **When a templated/fleet-procedure bug DOES ship, scale remediation depth to failure VISIBILITY** (TL p/8#139). A **LOUD**-failing bug (self-evident error — e.g. #113's `gh api` 404) is fine with a **central** correction at the template/epic: every consumer hits the failure and finds the fix, so rewriting N inline copies is over-investment. A **SILENT**-failing bug (wrong result, no error — moonshot misroute, CodeQL-non-required-gate #112, `verify | tail` #90) must be fixed **at source, per consumer** — adopters get a wrong answer with no signal they need the fix, so a central note alone is under-investment. Diagnose loud-vs-silent first, then pick central-vs-at-source.

**Status:** Active — TL-owned root cause of the 3 PR-flow defects (self-reported p/8#121). **BEING PROMOTED to a rule (TL p/8#123):** target = TL AGENTS.md (engineering/tech-lead), pending owner wording sign-off before the `ogit` overlay commit, citing `1ded61d4` + the 3-defect rollout; graduates to root AGENTS.md if the owner wants it fleet-binding. Add to the INDEX "AGENTS.md Rules (Escalated from Sage)" list once it lands. The three defects are recorded individually (refs/heads + `--delete-branch` in build.md; docs-only gate above); this is their common cause.

**Applies To:** Anyone — esp. TL / DevOps — mandating a change to a fleet-standard procedure.

---

## #103 [Build] Building a Sibling-Worktree Path With `..` Collapses to the Wrong Base

**Pattern:** Constructing a sibling worktree's path as `<repo>/../<sibling>` mis-resolves when `..` is anchored on the wrong segment. `C:/Users/jsnov/repos/../wt-1938b` collapses `repos/..` → `C:/Users/jsnov` → `C:/Users/jsnov/wt-1938b`, but the worktree lives at `C:/Users/jsnov/repos/wt-1938b`, so `cd` fails "No such file or directory" mid-land. The repo dir is `…/repos/ai-triad-research`; a sibling at `…/repos/wt-1938b` is `<repo>/../wt-1938b` (`ai-triad-research/..`), NOT `repos/../wt-1938b`.

**Instances:**
- 2026-07-29 — PowerShell 2 (p/228#8, t/1938 land): `cd "C:/Users/jsnov/repos/../wt-1938b"` failed — `..` cancelled `repos` (wrong base). Resolved with the full absolute sibling path, no `..`.

**Root Cause:** `..` resolves lexically against the immediately preceding segment, not "the repo." A base assembled to a different depth than intended lets one stray `..` silently retarget to a valid-looking wrong directory. Worktree lands are exposed because the sibling sits one level up from the repo dir but two up from `repos/`.

**Prevention:**
1. For sibling worktrees, write the absolute path directly — no `..` segments.
2. If building relative, anchor `..` on the repo dir (`ai-triad-research/..`) and verify with `realpath`/`Resolve-Path` before `cd`.

**Status:** Resolved — self-correcting (bad `cd` errors immediately). Single instance; recorded because worktree lands routinely reference sibling paths and the `..`-collapse is a silent retarget.

**Applies To:** Any agent building sibling-worktree paths during `/land-from-worktree` or manual worktree ops.

---

## #104 [Build] Pushing From a Detached-HEAD Worktree Needs a Fully-Qualified Destination Ref

**Pattern:** `git push origin HEAD:<branch>` fails from a detached-HEAD worktree with "not a full refname" — HEAD points at a bare commit, so git can't expand the short destination into a full ref. Fix: `git push origin HEAD:refs/heads/<branch>`.

**Instances:**
- 2026-07-29 — ServerAPI (p/79#19): pushing a feature branch from a detached worktree via `git push origin HEAD:<branch>` failed "not a full refname"; resolved with `HEAD:refs/heads/<branch>`. Surfaced by the revised `/land-from-worktree` (branch-protected PR-flow, owner-approved 2026-07-29), which pushes feature branches from detached worktrees.

**Root Cause:** With a detached HEAD as the refspec source, git has no current-branch context to disambiguate an unqualified destination (`feature-x` could be a branch, tag, …), so it refuses rather than guess. A checked-out branch would let git infer `refs/heads/`; a detached HEAD does not.

**Prevention:**
1. From a detached-HEAD worktree, always fully-qualify: `git push origin HEAD:refs/heads/<branch>`, not `HEAD:<branch>`.
2. Sanctioned form for the revised `/land-from-worktree` PR-flow — the playbook / land script should use `refs/heads/` so it works whether the worktree is on a branch or detached.

**Status:** Resolved — self-correcting (git rejects it immediately). Single instance, but **load-bearing for the revised `/land-from-worktree`** — flagged to the skill owner (TL) so the playbook uses the fully-qualified refspec.

**Applies To:** Any agent pushing a feature branch from a detached-HEAD worktree — i.e. every `/land-from-worktree` PR-flow land.

---

## #105 [Build] `gh pr merge --auto` Fails — Auto-Merge Is Disabled in This Repo

**Pattern:** `gh pr merge <n> --auto ...` fails because auto-merge is not enabled on this repo (`allowAutoMerge` is off). Under the checks-only PR-flow the intuitive "queue an auto-merge and walk away" isn't available; the merge must be issued directly once checks are green.

**Instances:**
- 2026-07-29 — Server Storage (t/1921 Batch B/C, p/206#5): `gh pr merge --auto` failed (auto-merge disabled). Resolved by polling the PR checks (Monitor tool, ~30s cadence) until green, then a direct `gh pr merge <n> --rebase --delete-branch` (no `--auto`).

**Root Cause:** Auto-merge is a per-repo GitHub feature currently OFF here; `--auto` asks GitHub to merge *when* checks pass, but with the feature disabled the flag is invalid, not a no-op. The agent must own the wait: watch checks, then merge.

**Prevention:**
1. **Don't use `--auto`.** Wait for green, then merge directly: `gh pr checks <n> --watch` (or a ~30s Monitor poll) → `gh pr merge <n> --rebase --delete-branch`. This is the `/land-from-worktree` step-4→5 sequence.
2. A fleet-wide "queue and walk away" would be a repo-setting change (enable auto-merge) — owner/DevOps call, not a per-land workaround.

**Status:** **SUPERSEDED / STALE (2026-07-29)** — auto-merge was **RE-ENABLED** in this repo; empirically confirmed (PowerShell #158 landed via `gh pr merge --auto`; TaxEditor p/6#29). This "disabled" failure mode no longer applies — retained for history. Current landing caveat is **#108** (`--auto` doesn't auto-update a BEHIND branch under the strict up-to-date rule). (Originally: Resolved/self-correcting flag error, single instance.)

**Applies To:** Any agent self-merging a PR under the checks-only PR-flow.

---

## #106 [Build] `gh pr merge --delete-branch` From a Worktree Aborts AFTER the Merge Succeeds — the "fatal" Masks a Landed Merge

**Pattern:** `gh pr merge <n> --rebase --delete-branch` from a **linked git worktree** aborts "fatal: 'main' is already used by worktree" — but the remote merge **already succeeded**. `--delete-branch` does a local `git checkout main` to clean up the merged branch, which git forbids while the primary worktree holds `main`. The command exits non-zero on local cleanup *after* the PR is MERGED — a **false-failure signal**. This is the exact command `/land-from-worktree` step 5 prescribes, so every worktree lander hits it.

**Instances:**
- 2026-07-29 — ElectronMain (p/98#12): `gh pr merge <n> --rebase --delete-branch` from a worktree aborted "fatal: 'main' is already used by worktree" **after** the merge completed. Verified `state=MERGED` (`b2e370ff`), deleted branches + removed the worktree by hand. No loss.
- 2026-07-30 — Server Storage (t/2020, p/206#9): **2nd instance** — `gh pr merge <n> --squash --delete-branch` from a worktree hit the SAME "fatal: 'main' is already used by worktree". Confirms it's **intrinsic to `--delete-branch` from a worktree, independent of the skill's step-5 fix** — recurs on any DIRECT invocation, not via the fixed `/land-from-worktree`. Fixed a different way: **ran `gh pr merge` from the MAIN REPO PATH** (hub holds main → local checkout succeeds; prevention #4). (Also: when the safety classifier blocks the command, hand it to the user.)
- 2026-07-30 — Server Storage (t/2020, p/206#11): **3rd instance — a NEW facet that qualifies prevention #4.** `gh pr merge --squash --delete-branch` run **from the main repo path**: the GitHub merge succeeded but the **local branch-delete** failed **"cannot delete branch used by worktree"** — a worktree still held the HEAD branch. Running from the main repo path fixes the *checkout-main* conflict but NOT this one (`git branch -D <head>` is blocked while a worktree holds that head). Fix: **`git worktree remove <path>` FIRST, then `git branch -D <head>`**. Same root family (gh's post-merge LOCAL cleanup vs one-branch-per-worktree), at the branch-delete step rather than the checkout step.
- 2026-08-03 — DevOps (p/26#36): **4th instance, 3rd independent agent — confirms facet 2 / prevention #5.** `gh pr merge --delete-branch` exited 1 with **both** "**already merged**" (the PR had **auto-merged** before the command ran) **and** "cannot delete branch used by worktree" (a worktree still held the branch ref). Resolved by **`git worktree remove --force` FIRST**, then the branch delete succeeds — **order matters** (prevention #5). The "already merged" signature reinforces bookkeeping-≠-artifact: exit 1 was *entirely* post-merge cleanup — the merge was already DONE, so an exit-1 panic-retry would be wrong. 3rd agent to hit facet 2 (ElectronMain + Server Storage + DevOps).
- 2026-08-05 — ServerAPI (p/79#25, t/2180): **5th instance, 4th independent agent.** PR #486 branch checked out in `.claude/worktrees/default-model-t2180` (IDE-managed worktree) — `gh pr merge --delete-branch` exited 1, local branch-delete blocked by the active worktree. Correctly identified: PR confirmed MERGED (`mergedAt` set); exit 1 is cosmetic post-merge cleanup, worktree owner's responsibility. Same facet 2 as p/206#11 + p/26#36.
- 2026-08-06 — DebateUI (p/83#8): **6th instance, 5th independent agent.** `gh pr merge --squash --delete-branch` failed when `main` was checked out in another worktree. Workaround: called the GitHub API directly — `gh api repos/:owner/:repo/pulls/N/merge -X PUT -f merge_method=squash` — which executes the merge server-side with no local checkout/cleanup step at all.
- 2026-08-07 — DebateWorkspace (p/124#8): **7th instance, 6th independent agent.** `gh pr merge --rebase --delete-branch` from a worktree — Facet 1 (main held by primary tree). Discriminator: `gh pr view --json state,mergedAt` confirmed MERGED. Recovery: `git push origin --delete <branch>` + `git worktree remove` manually — no retry of the merge.
- 2026-08-09 — Server Community (p/160#3): **8th instance, 7th independent agent.** `gh pr merge --delete-branch` from a worktree — same Facet 1 (`fatal: 'main' is already used by worktree`). GitHub merge landed; fix: `gh pr view --json state` to confirm, then delete branch manually.
- 2026-08-09 — Server Community (p/160#5): **9th instance, Facet 3 (new).** `gh pr merge --delete-branch` exits 1 with "remote ref does not exist" — GitHub had already auto-deleted the branch on merge. Error is benign/redundant; confirmed MERGED, worktree removed. Fix: omit `--delete-branch` when GitHub auto-delete-on-merge is enabled (the flag is redundant and noisy).
- 2026-08-12 — Technical Lead (p/335#29): **10th instance, Facet 4 (new — `gh pr close`).** `gh pr close --delete-branch` exits 1 when the branch is checked out in a git worktree. PR closed and remote branch deleted fine; only the local `git branch -D` was refused. Fix: `git worktree remove` first, then `git branch -D`. Same root as Facet 2 — `--delete-branch`'s local cleanup blocked by an active worktree — triggered via `close`, not `merge`.
- 2026-09-29 — DebateTool (p/70#29): **11th instance, Facet 5 (new — close on auto-merged PR).** `gh pr close 2567` exits 1 "already merged" — GitHub auto-marked the PR merged when `git merge origin/fix/getCurrentPhase-readsites-t3761` merged the branch into #2566's branch. No action needed; #2567 was correctly merged. Prevention: `gh pr view --json state` before `gh pr close` — if MERGED, skip the close entirely.
- 2026-08-13 — ElectronMain (p/98#17): **11th instance, 8th independent agent.** `gh pr merge --delete-branch` failed when branch was checked out by a worktree. Fix: dropped `--delete-branch` (GitHub auto-deletes on merge), then removed worktree + `git branch -D` for local cleanup.
- 2026-08-15 — Technical Lead (PR #1104, p/447#1): **12th instance — Facet 2, post-merge TL cleanup.** `gh pr merge --delete-branch` on `fix/t2685-oped-wordcount` — remote branch deleted fine, but local branch-delete failed because `.worktrees/t2685` was still checked out on that branch. Merge succeeded; local cleanup deferred to the worktree owner via ping. Correct handling: confirmed MERGED, no retry.
- 2026-08-15 — Technical Lead (PR #1111, p/447#2): **13th instance — Facet 2, same session, 2nd occurrence.** `gh pr merge --delete-branch` on t/2686 branch — same outcome: merge and remote branch delete succeeded; local branch-delete failed because `.worktrees/t2686` was still checked out. Resolved identically — cleanup deferred to worktree owner.
- 2026-08-15 — Technical Lead (PR #1113, t/2687, p/447#6): **14th instance — 3rd TL occurrence same session.** `worktree-delete-branch-guard` feedback rule fired (detection confirmed), but TL proceeded with `--delete-branch` anyway — advisory injection did not change behavior. Same outcome. Signal: detection is working; enforcement is not.
- 2026-08-15 — DevOps 2 (p/340#5): **15th instance — Facet 1.** `gh pr merge --delete-branch` from a worktree: `fatal: 'main' is already used by worktree` — gh tried to checkout main locally; primary worktree held it. Fix: omit `--delete-branch`, remove worktree separately. Noted that `/land-from-worktree` already handles this correctly.
- 2026-10-12 — DevOps Worker (p/749#5): **16th instance — Facet 4 (`gh pr close`).** `gh pr close 3188 --delete-branch` failed local branch deletion "fatal: 'main' is already used by worktree at …" — the PR's branch was checked out in an active worktree. PR closed and remote branch deleted fine; only local `git branch -D` was refused. Resolved: switched the worktree to a different branch first, then `git branch -D` + `git push origin --delete` manually.
- 2026-10-12 — DevOps Worker (p/749#7): **17th instance — Facet 4 (`gh pr close`).** `gh pr close 3204 --delete-branch` errored on local branch deletion — branch checked out in `.worktrees/t4150-verify-config-arm2`. Resolved: `git worktree remove` first, then `git branch -D` + `git push origin --delete` manually.

**Root Cause:** `--delete-branch` cleans up the merged head branch locally too, and gh switches the working copy to the base branch (`git checkout main`) to do so. Git's one-branch-per-worktree rule blocks checking out `main` while the primary worktree has it → `fatal`. The remote merge + branch delete already happened via the API; only the local checkout/cleanup fails. Bookkeeping-≠-artifact family — the exit code describes post-success cleanup, not the merge.

**Prevention:**
1. From a worktree, merge WITHOUT `--delete-branch`: `gh pr merge <n> --rebase`, then delete branches manually (remote `git push origin --delete <branch>`, local `git branch -D` from the primary tree).
2. **Discriminator — treat the "fatal" as post-merge:** run `gh pr view <n> --json state,mergedAt`; if `state=MERGED` and `mergedAt` is set, the merge succeeded. Do NOT retry. Recovery: `git push origin --delete <branch>` (remote cleanup) + `git worktree remove <path>` manually. No `gh pr merge` re-attempt.
3. `/land-from-worktree` step 5 should drop `--delete-branch` (or gate it to non-worktree runs) — the skill runs from a worktree by definition. Flagged to TL.
4. **Or run `gh pr merge` from the MAIN REPO PATH, not a worktree** (Server Storage p/206#9): the hub holds `main`, so gh's post-merge local `checkout main` succeeds — no checkout-conflict. **Caveat (p/206#11): NOT a full escape** — if a worktree still holds the PR's HEAD branch, `--delete-branch`'s local `git branch -D <head>` then fails "cannot delete branch used by worktree." (If a safety classifier blocks the command, ask the user to run it.)
5. **Fully-safe order: `git worktree remove <path>` FIRST, then merge/delete** — clears BOTH facets (checkout-main + branch-used-by-worktree). Simplest: drop `--delete-branch` (prevention #1), remove the worktree, delete the branch by hand.
6. **Direct API escape hatch:** `gh api repos/:owner/:repo/pulls/N/merge -X PUT -f merge_method=squash` (or `rebase`/`merge`) — calls the GitHub merge API directly with no local checkout or branch-delete step; bypasses all worktree conflicts entirely. Then clean up branches manually.
7. **Facet 3 — "remote ref does not exist":** when GitHub auto-delete-on-merge is enabled, `--delete-branch` tries to delete an already-gone branch → benign "remote ref does not exist" error. Drop `--delete-branch` entirely; if GitHub deletes it, there is nothing to do.
8. **Facet 4 — `gh pr close --delete-branch`:** the same local-delete conflict applies to `close`, not just `merge`. PR closes and remote branch deletes fine; only `git branch -D` is refused while a worktree holds the branch. Fix: `git worktree remove` first, then `git branch -D`.

**Status:** **Skill-path RESOLVED; direct-invocation ACTIVE (recurred 2026-07-30).** TL fixed step 5 (p/8#121): drops `--delete-branch`, verifies `gh pr view <n> --json state` == `MERGED` (not the exit code), deletes the remote branch by push. **But the failure is intrinsic to `--delete-branch` from a worktree** — Server Storage re-hit it with a DIRECT `gh pr merge --squash --delete-branch` (t/2020), bypassing the fixed skill; any direct invocation from a worktree re-triggers it (fix: drop `--delete-branch`, or run from the main repo path — prevention #4). **3rd instance (p/206#11) surfaced a 2nd facet:** even from the main repo path, `--delete-branch`'s LOCAL branch-delete fails "cannot delete branch used by worktree" if a worktree holds the head → fully-safe order is `git worktree remove` FIRST, then merge/delete (prevention #5). Was the dangerous PR-flow variant (fatal → panic-retry → double-land). **4th instance (DevOps p/26#36, 2026-08-03) — 3rd independent agent confirms prevention #5** (worktree-remove-first) and adds the "**already merged**" signature (an auto-merged PR whose `--delete-branch` cleanup still exit-1s on the held branch) — reinforcing that exit 1 is post-merge cleanup, not a failed merge. Root cause folded into the "validate a fleet-standard procedure end-to-end before mandating" process lesson. **5th instance (ServerAPI p/79#25, 2026-08-05) — 4th independent agent; IDE-managed worktree (`.claude/worktrees/`) holds the branch, same outcome.** Correctly handled: check `mergedAt`, treat exit 1 as cosmetic, hand cleanup to the worktree owner. **7th instance (DebateWorkspace p/124#8, 2026-08-07) — 6th independent agent; `--rebase --delete-branch` from a worktree; same Facet 1.** Discriminator confirmed: `gh pr view --json state,mergedAt` shows MERGED; recovery = `git push origin --delete` + `git worktree remove` manually.

**Facet 5 (2026-09-29, DebateTool p/70#29):** `gh pr close` exits 1 "already merged" when GitHub auto-marked the PR merged via a local `git merge` of its branch. No action needed — PR is correctly merged. Prevention: `gh pr view --json state` before `gh pr close`; skip if MERGED.

**8th instance (DevOps Worker p/749#30, 2026-10-20):** `gh pr close <n> --delete-branch` — same Facet 1 (checkout-main blocked by worktree). Resolved: `git worktree remove .worktrees/<name>` first, then `git push origin --delete <branch>` for the remote side. Confirms `--delete-branch` on `gh pr close` triggers the same local-checkout-main failure as `gh pr merge --delete-branch`.

**Gate (2026-08-15):** Feedback rule `worktree-delete-branch-guard` (workspace scope, PreToolUse Bash|PowerShell) now intercepts `--delete-branch` invocations and prompts `git worktree list` → `git worktree remove` before proceeding, with a pointer to /land-from-worktree. AGENTS.md pre-merge checklist update pending human approval (TL p/447#4).

**Applies To:** Every worktree PR-flow lander — i.e. everyone using `/land-from-worktree` step 5.

---

## #107 [Build] Running `verify` INSIDE a Landing Worktree Dirties the Tree → Rebase Aborts → `--force` Remove Orphans the Unpushed Commit

**Pattern:** In a landing worktree, running the full `npm run verify` (or any build) writes build artifacts (`dist/`, `.tsbuildinfo`, `coverage/`) that **dirty the tree**. A subsequent `git rebase origin/main` then **aborts** ("cannot rebase: you have unstaged changes"). If you then `git worktree remove --force` to clean up, the force-remove **drops the detached-HEAD ref holding your unpushed commit** — orphaning it. The commit isn't destroyed (it survives in the object store until gc), but it's no longer reachable from any ref.

**Instances:**
- 2026-07-29 — Shared Lib (t/1960, p/5#17): full `npm run verify` inside the worktree wrote `dist`/`.tsbuildinfo`/`coverage` → `git rebase` aborted on unstaged changes → `git worktree remove --force` orphaned the unpushed commit. Recovered: the commit survived in the object store (`git cat-file -e <sha>`) → cherry-picked onto a fresh worktree off current origin → pushed. (Windows also gave "Permission denied" on the remove; `git worktree prune` cleared the stale ref — see #78 Facet C.)

**Root Cause:** `verify`/build steps emit untracked+modified artifacts; `git rebase` refuses to run against a dirty tree; and `git worktree remove --force` deletes the worktree — including its detached-HEAD ref — regardless of whether that ref is the sole pointer to an unpushed commit. The three compound: verify dirties → rebase can't proceed → force-remove (to "clean up") discards the only ref to the work. Same family as #72 (verify dirties snapshots) and #78 (worktree-remove hazards); the commit is recoverable ONLY because git retains unreachable objects until gc.

**Prevention:**
1. **Push BEFORE running `verify` in a worktree** — land the commit to origin first, THEN verify (or verify on a throwaway copy). A pushed commit can't be orphaned. (This is also the #107-avoiding form of the #95/#96 "get it onto origin, verify the ref" discipline.)
2. **If you must verify pre-push, clean build artifacts before rebase** — `git stash` or `git clean -fdx` the artifact dirs so the tree is clean, then rebase (pairs with #72: discard verify-dirtied artifacts before rebase/push).
3. **Never `--force`-remove a worktree that holds an unpushed commit** — confirm `git rev-parse origin/main` contains your HEAD (the #95/#96 verify-on-origin check) BEFORE removing; otherwise detach + `git worktree prune`, don't force-destroy.
4. **Recover an orphaned commit by SHA → cherry-pick:** `git cat-file -e <sha>` confirms it survives; `git cherry-pick <sha>` onto a fresh worktree off current origin, then push. `git reflog` / `git fsck --lost-found` finds the SHA if you don't have it.

**Status:** Active — worktree-land cluster; compound of verify-dirties-tree (#72) + force-remove-drops-ref. A near-miss data loss (recovered). Reinforces: push before verify; never force-destroy a ref holding unpushed work; a commit orphaned off all refs is still recoverable by SHA until gc.

**Applies To:** All agents running `verify`/builds inside a landing worktree before pushing.

---

## #108 [Build] On Busy main, `gh pr merge` Bounces a BEHIND Branch (Strict "Up-to-Date" Rule) — `--auto` Does NOT Auto-Update; `update-branch` First

**Pattern:** main's branch protection has the strict **"require branches to be up to date before merging"** rule. A PR that is **behind** origin/main — even when green and mergeable — is **rejected at merge time**: `gh pr merge <n> --rebase` (or `--squash`) bounces with *"head branch is not up to date with the base branch."* Critically, `gh pr merge --auto` does **NOT** fix this — auto-merge only *waits for required checks then merges*; it does **not** rebase/update a behind branch. So on a high-velocity main a behind branch keeps falling further behind and **never lands** on `--auto` alone.

**Instances:**
- 2026-07-29 — Taxonomy Editor (PR #153, p/6#26/#29) + PowerShell (PR #158, same session): `gh pr merge --rebase` bounced "head branch is not up to date" on a GREEN PR; recurred twice. Working recipe: **`gh pr update-branch`** (or rebase onto origin/main + `git push --force-with-lease`, which re-triggers CI), THEN `gh pr merge --auto` — auto-merge grabs the next green window once the branch is current. (Auto-merge IS enabled in this repo as of 2026-07-29 — empirically #158 landed via `--auto`; this supersedes the now-stale "#105 auto-merge disabled".)

**Root Cause:** The strict up-to-date rule requires HEAD to contain the latest base commit before merge; a behind branch is blocked regardless of green checks. GitHub auto-merge *waits for and then merges* once required checks pass — it does not update the branch — so a behind branch under a busy main never satisfies the up-to-date requirement on its own. On fast-moving main this is a livelock: while you wait for a window, main advances and you fall further behind. `--auto` handles the *green-check* wait, not the *up-to-date* update.

**Prevention:**
1. **Get the branch up-to-date, THEN auto-merge:** `gh pr update-branch` (or rebase onto origin/main + `git push --force-with-lease`, re-triggering CI), then `gh pr merge --auto`.
2. **Expect to re-update on busy main** — if main advances again before the green window, re-run `update-branch`. `--auto` won't do it for you.
3. **A `gh pr merge --rebase`/`--squash` bounce with "head branch is not up to date" is the strict-rule signal to update first** — not a defect in your PR.

**Status:** Active — main strict "require up-to-date branch" protection; auto-merge (re-enabled 2026-07-29) covers the green-check wait but not the up-to-date update. Supersedes #105 (auto-merge-disabled, now stale). Recurred twice same session (TaxEditor #153, PowerShell #158).

**Applies To:** All agents landing PRs on main via `gh pr merge`, especially during high-velocity/busy-main periods.

---

## #109 [Design] Score-Zeroing Is Not Removal — an Excluded Item Resurfaces When a Downstream Selector Ignores the Threshold

**Pattern:** Excluding a candidate by **setting its score to 0** (a soft/marker exclusion) is NOT equivalent to **removing it from the candidate set** — unless *every* downstream selector honors the exclusion threshold. If any later stage selects by **rank / top-N / quota refill / diversity floor** rather than by "score > floor," it picks the zeroed item anyway and the exclusion silently leaks. The item you thought you excluded re-enters the result.

**Instances:**
- 2026-07-29 — DebateTool (t/1981, fixed f1b09440, p/234#3): `hardExclude` set excluded nodes to score 0 but left them in the `candidateNodes` array. Two downstream selectors — `minPerCategory` refill and the POV-diversity floor — both pick by **top-score regardless of threshold**, so the score-0 excluded nodes **re-entered** selection. Fix: filter the excluded IDs OUT of `candidateNodes` before grouping and before the diversity-floor scan (remove, don't just zero).

**Root Cause:** Score-zeroing encodes exclusion as a *value* that only stages comparing against a floor will respect. Stages that rank-and-take (top-N, per-category quotas, a diversity floor that grabs the best available) read the item as merely low-scored, not excluded — so they resurface it. The exclusion invariant ("this node must not appear") is enforced at ONE site (the score) but assumed at ALL sites (selection); the mismatch is a silent correctness bug. General rule: an exclusion expressed by mutating a rank-signal is only as strong as the weakest downstream consumer's respect for that signal.

**Prevention:**
1. **Exclude by REMOVAL from the working set, not by zeroing a score** — filter excluded IDs out of the candidate array before any grouping/refill/diversity pass. Removal can't be bypassed by a rank-based selector.
2. **If you must keep excluded items in the array** (e.g. for logging/telemetry), carry an explicit `excluded` flag and make EVERY selector skip it — audit each selection site (top-N, quota refill, diversity floor) to confirm it honors the flag, not just the primary threshold.
3. **When adding a new selection stage, ask what "excluded" means to it** — a stage that picks "best available" ignores a score floor, so treat score-zeroing as advisory and removal as authoritative.

**Status:** Active — exclusion-by-marking ≠ exclusion-by-removal; a soft-exclusion signal leaks through any rank/quota/diversity selector that ignores the threshold.

**Applies To:** All code that excludes candidates via a score/flag while multiple downstream stages select by rank, quota, or diversity (debate node selection, ranking pipelines, refill/recommendation logic).

---

## #110 [Build] A Runtime `getProjectRoot()` Calibrated for the Compiled (dist) Layout Mis-Resolves in the vitest SOURCE Context — Anchor Test Paths to `import.meta.url`

**Pattern:** A helper like `getProjectRoot()` that finds the repo/app root by walking up from the **compiled `dist/`** location returns the WRONG directory when the same module runs from **source under vitest** — it stops at `taxonomy-editor/` (the source subtree root) instead of the repo root. A co-located test that reaches a repo-root/shared file via `path.join(getProjectRoot(), 'ai-models.json')` then fails **ENOENT** — the base is wrong, not the file. The helper is correct in production (from `dist`) and wrong in the test's source context: a source-vs-compiled path divergence.

**Instances:**
- 2026-07-29 — ServerAPI (t/1997, p/79#20): a co-located server test read `ai-models.json` (repo root) via `path.join(getProjectRoot(), 'ai-models.json')` → ENOENT, because `getProjectRoot()` resolves to `taxonomy-editor/` in the vitest source context (it only walks to the `/app` root from compiled `dist`). Fix: resolve the repo-root file relative to the TEST FILE via `import.meta.url` — `path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../ai-models.json')` — not `getProjectRoot()`.

**Root Cause:** `getProjectRoot()` encodes the DIST directory depth (how many levels `dist/...` sits below the app root). Under vitest the module executes from its SOURCE path, whose depth-to-root differs, so the upward walk stops early — at the app-subtree root (`taxonomy-editor/`), a plausible-looking directory — and the failure surfaces as ENOENT on the joined file, not as an obvious "wrong root." Same source-vs-compiled context divergence family as local≠CI issues (#88/#94): the runtime helper's assumption (compiled layout) doesn't hold in the test harness (source layout).

**Prevention:**
1. **In tests, anchor repo-root/shared-file paths to the test file itself, not a runtime root helper:** `path.resolve(path.dirname(fileURLToPath(import.meta.url)), '<relative-to-repo-root>')`. The test file's own location is stable across source and compiled; a dist-calibrated `getProjectRoot()` is not.
2. **Treat any `getProjectRoot()`/`findUpToRoot()` helper as compiled-layout-specific** — if it walks a fixed depth or looks for a `dist` marker, it mis-resolves when run from source (vitest, tsx). Don't reuse it in tests to reach files outside the module tree.
3. **An ENOENT on a file you KNOW exists ⇒ suspect a wrong base dir, not a missing file** — print the resolved absolute path and compare to the real location before concluding the file is absent (object-level; sibling of the #73 facet-C "valid path looks missing" caution).

**Status:** Active — source-vs-compiled path-resolution divergence; a dist-calibrated root helper mis-resolves under vitest's source context.

**Applies To:** All agents writing vitest tests (especially co-located server/lib tests) that read repo-root or shared files via a runtime root helper.

---

## #111 [Build] A Workflow Gated on "CI Green for the CURRENT main HEAD" Can't Be Dispatched On-Demand on a Busy main — the Gate Races the Advancing HEAD

**Pattern:** `container.yml` (build + Trivy scan) is gated on `ci-gate` — it requires `ci.yml` to be GREEN for the **current `main` HEAD** before it runs. On a high-velocity `main`, an on-demand `gh workflow run container.yml` can **never win the race**: each dispatch resolves whatever HEAD is current *at dispatch time*, whose `ci.yml` is still **in-progress** (or `main` advances again before it finishes) → the gate reports `test-container not found / in_progress` and the run no-ops. The gate is **unsatisfiable on demand** because the precondition (current-HEAD CI green) is a moving target on a busy branch.

**Instances:**
- 2026-07-29 — Docker (t/2006, p/217#3): trying to force an on-demand **app-image Trivy rescan** to clear code-scanning alerts, repeated `gh workflow run container.yml` dispatches each hit `test-container not found/in_progress` — `main` advanced faster than any single HEAD's CI completed. **Consequence:** you **cannot** force an on-demand app-image rescan; the app-image code-scanning alerts **auto-clear only on the next `v*` tagged release build** (which pins a HEAD and runs the full gate). **Workaround:** dispatch `base-image.yml` (not current-HEAD-gated) to prove the suppression on the BASE image, and **report the app-image residual as auto-clearing on the next release** rather than chasing the gate.

**Root Cause:** A "current-HEAD CI green" precondition is satisfiable only when `main` stays quiescent long enough for one HEAD's CI to finish before the next commit lands — false on a busy multi-role `main`. The dispatched workflow re-resolves `main` HEAD at run time, so it is always chasing a newer, still-building commit. Same **busy-main advancing-HEAD livelock** as #108 (`gh pr merge` on a behind branch never satisfies the strict up-to-date rule): mechanism differs (workflow-gate vs merge-gate) but the shape is identical — a per-HEAD precondition can't converge while HEAD keeps moving.

**Prevention:**
1. **Don't chase a current-HEAD-gated workflow on a busy `main` — it can't win.** For on-demand verification, dispatch a workflow that is NOT gated on the moving HEAD (e.g. `base-image.yml`), or pin a specific ref if the workflow supports it.
2. **For an app-image scan/suppression, report the residual as auto-clearing on the next `v*` release** (which pins a HEAD and runs the full gate) — state it as expected behavior, not an open failure to chase.
3. **Recognize the signature:** repeated dispatches reporting `<gate-job> not found / in_progress` on a busy branch = the gate is racing the advancing HEAD, not a broken workflow. Stop retrying; use the base-image / next-release path. (Sibling of #108.)

**Status:** Active — busy-main advancing-HEAD livelock (workflow-gate variant of #108); on-demand current-HEAD-gated dispatch is unsatisfiable on a high-velocity `main`. Also in memory (`reference_trivy_cve_remediation`).

**Applies To:** All agents dispatching current-HEAD-CI-gated workflows (container.yml / Trivy rescan) on a busy `main`; anyone trying to force an on-demand app-image security rescan.

---

## #112 [Build] Green Required `ci-gate` ≠ All Checks Green — a Non-Required Check (CodeQL) Can Be RED While the Merge Gate Passes; Confirm Check-Run Conclusions Before Self-Merge

**Pattern:** Branch protection requires a single context, `ci-gate`. **CodeQL runs as a SEPARATE, non-required check-run.** So a PR can show a **green `ci-gate`** (and `gh pr checks` can exit 0 for the required set) while **CodeQL is RED with a high-severity finding** — and self-merge proceeds, landing the vulnerability. "Required gate green + `gh`-checks-exit-0" describes only the REQUIRED subset, not all checks; a non-required security check failing is invisible to that signal.

**Instances:**
- 2026-07-30 — Shared Lib (t/2014, landed b815724b): a temp-file default `path.join(os.tmpdir(), '<predictable-name>')` tripped CodeQL **`js/insecure-temporary-file` (high sev)**. It **passed the sole required `ci-gate`** (CodeQL is a separate non-required check), so green-ci-gate + gh-checks-exit-0 wasn't sufficient — the finding surfaced only by reading the CodeQL check-run explicitly. **Code fix:** `fs.mkdtempSync` (randomized temp dir) instead of a predictable `os.tmpdir()`-joined name. **Process fix:** before self-merge, confirm the CodeQL check-run conclusion EXPLICITLY, and read a failing check's `output.title` rather than assuming it's a config stub.

**Root Cause:** The merge gate (`ci-gate`) is a *subset* of a PR's checks by design; security scanners like CodeQL are intentionally non-required (advisory / can lag / run async). Treating "the required gate is green" as "all checks pass" is a gate-signal-integrity failure (**bookkeeping ≠ artifact**): the required-gate conclusion is a PROCESS signal that does not cover the security check's actual result. Compounded by assuming a red check is "just the config stub" instead of reading its `output.title` — so a real high-sev finding gets waved through. Same "the check that governs your code lives outside the gate you ran" shape as #94.

**Prevention:**
1. **Before self-merge, confirm ALL check-run conclusions, not just the required gate** — `gh pr checks <n>` (every check + conclusion) or `gh api repos/:owner/:repo/commits/<sha>/check-runs`. A green `ci-gate` with a red CodeQL is a landable vulnerability; don't equate "required gate green / `gh pr checks` exit 0" with "all checks green."
2. **Read a failing check's `output.title`/summary — don't assume it's a benign stub.** CodeQL's title names the rule + severity (e.g. `js/insecure-temporary-file`, high); confirm before dismissing.
3. **Temp files: use `fs.mkdtempSync(path.join(os.tmpdir(), prefix))` (randomized dir), never a predictable `path.join(os.tmpdir(), '<fixed-name>')`** — the predictable form is CodeQL `js/insecure-temporary-file` (high). A recurring CodeQL high worth knowing before you write the temp path. **Downstream ripple (Server Storage t/2020):** `mkdtempSync` appends a RANDOM suffix, so a test asserting the exact name breaks — `.endsWith('manifest.json.tmp')` must become `.includes('manifest.json.tmp')` (or a regex). Adopting the security fix means loosening any exact-temp-name assertions.
4. **The durable fix is to make the scanner a REQUIRED check — but in DIFFERENTIAL mode (fail on NEW alerts only, not the backlog).** A checklist step ("remember to check CodeQL") is memory-dependent (#82 rule-not-applied) — the structural gate is the real fix. But a blanket "CodeQL must be green" on a repo with a pre-existing alert backlog (~108 here) false-reds every PR; **differential mode** (fail only on alerts the PR introduces) is what makes a lagging/advisory scanner a usable required gate.

**Status:** Active — gate-coverage gap (required `ci-gate` ⊊ all checks) surfaced by a concrete CodeQL high (predictable temp file). Sibling of the escalated "Gate Signal Integrity" rule and the bookkeeping-≠-artifact genus; relates to #94. Self-merge is fleet-wide now, so confirming non-required security check-runs before merge is a general habit, not a one-off. **Escalated → DISPOSITIONED (TL p/8#137):** (1) interim — a "confirm the CodeQL check-run, not just ci-gate" step added to the Wave-2 self-merge flow now (t/2001#3); (2) durable — **t/2025 (DevOps, high): make CodeQL a REQUIRED check in DIFFERENTIAL mode** (fail on new alerts only, per prevention #4). Structural required-gate is the real fix; the interim checklist line is the memory-dependent stopgap until it lands. t/1589 gate-integrity genus.

**Applies To:** All agents self-merging PRs under the checks-only gate — especially confirming CodeQL/security check-runs; and anyone writing temp files in JS/TS.

---

## #113 [Build] `gh api` Auto-Switches to POST When Any `-f`/`-F` Field Is Passed — 404 on a GET-Only Endpoint; Use a Query String or `-X GET`

**Pattern:** `gh api` defaults to GET, but **switches the HTTP method to POST the moment any `-f`/`-F` (`--field`/`--raw-field`) is passed** — the fields become a request BODY, not query params. So `gh api ".../code-scanning/alerts" -f state=open -f tool_name=CodeQL` **POSTs** to a **GET-only** endpoint → **404**. The 404 misleads toward "wrong URL / missing resource" when the real fault is the verb.

**Instances:**
- 2026-07-30 — Server Auth (p/303#1): the CodeQL-alert-pull command **templated into the Wave-2 security tickets** — `gh api ".../code-scanning/alerts" -f state=open -f tool_name=CodeQL` — returned **404** because the `-f` fields flipped it to POST on a GET-only endpoint. **Affects every Wave-2 subticket using the same template** (broad blast radius, ~7 roles). **Fix:** put params in the query string with a plain GET — `gh api ".../code-scanning/alerts?state=open&tool_name=CodeQL" --paginate --jq '…'`.

**Root Cause:** `gh api`'s method is implicit: no fields → GET; any `-f`/`-F` → POST (fields sent as a body). Documented, but easy to miss — the same `-f key=val` idiom that adds *query params* in many CLIs adds a *POST body* here. On a GET-only REST endpoint (list code-scanning alerts) the POST 404s. A templated command carrying this bug propagates the failure to every consumer — the "validate a shared/templated procedure before mandating it" failure (#102).

**Prevention:**
1. **For a GET endpoint with params, use the query string, not `-f`:** `gh api "<path>?k1=v1&k2=v2" --paginate --jq '…'`. Or force the method while keeping `-f`: `gh api -X GET "<path>" -f k1=v1 -f k2=v2` (with `-X GET`, `gh` puts the fields in the query string instead of a body).
2. **A `gh api` 404 on an endpoint you KNOW exists ⇒ suspect an unintended POST from `-f`/`-F`** — check the method before doubting the path (object-level: the endpoint isn't missing, the verb is wrong).
3. **Verify a `gh api` command before templating it into tickets/skills** — a method bug in a template propagates to every consumer (here, all Wave-2 subtickets). Ties to #102 (validate a fleet-standard/templated procedure end-to-end before mandating it).

**Status:** Active — `gh api` implicit-method gotcha; high blast radius via the Wave-2 ticket template (t/2001). Sibling of #102 (bug-in-a-template propagates). **DISPOSITIONED (TL p/8#139):** corrected CENTRALLY at t/2001#4 (both `-X GET` and query-string forms) for all Wave-2 owners — NOT rewriting the 7 inline commands. **Remediation-depth nuance (TL):** this fails LOUD (a self-evident 404 with the fix documented at the epic), so a *central* correction is proportionate; contrast SILENT-failure templated bugs (moonshot misroute, CodeQL-non-required-gate #112) where an *at-source per-consumer* fix is essential. General rule in #102 prevention #5.

**Applies To:** All agents scripting `gh api` against GET endpoints with params (code-scanning alerts, list APIs) — especially commands templated across tickets/roles.

---

## #114 [Build] Greedy `<[^>]+>` Tag-Stripper Matches DECODED Entities (`< 2 >` from `&lt;2&gt;`) — Anchor the Tag-Start When You Decode-Before-Strip

**Pattern:** When you DECODE HTML entities BEFORE stripping tags, a greedy tag-stripper `<[^>]+>` matches literal `<…>` sequences the decode produced from `&lt;`/`&gt;` — e.g. decoded `< 2 >` (from `&lt; 2 &gt;`) looks like a tag and gets stripped, corrupting the text. Once entities are decoded the regex can't tell a real tag from decoded angle-bracket content.

**Instances:**
- 2026-07-30 — Server Storage (t/2020, p/206#6): after decoding entities, `<[^>]+>` matched `< 2 >` (from decoded `&lt;`/`&gt;`) and stripped it. Fixed by anchoring the tag-start to a valid tag-name char: `<[a-zA-Z\/!][^>]*>` (a real tag starts with a letter, `/`, or `!`). Decode-first requires the tighter anchor.

**Root Cause:** entity decoding turns `&lt;2&gt;` into literal `< 2 >`, which a permissive `<[^>]+>` reads as a tag. A real HTML tag's first char after `<` is a letter (element), `/` (close tag), or `!` (comment/doctype) — never a space or digit; `<[^>]+>` doesn't encode that constraint. Order matters: strip-before-decode sidesteps it, but if you must decode first, the stripper needs the start anchor.

**Prevention:**
1. **Stripping tags AFTER decoding entities: anchor the tag-start** — `<[a-zA-Z\/!][^>]*>`, not `<[^>]+>` (a real tag never starts with a space/digit).
2. **Prefer strip-before-decode** where possible (strip tags on the still-encoded text, then decode) so decoded angle brackets can't be mistaken for tags.
3. For any regex over decoded/user text, constrain the START token to what's actually valid — don't rely on a permissive `[^>]+`.

**Status:** Active — decode-order parsing gotcha; a permissive tag-strip regex corrupts decoded angle-bracket content.

**Applies To:** All agents stripping HTML tags from text that has been (or will be) entity-decoded.

---

## #115 [Build] A Resource Allocated BEFORE the `try` Leaks When a Later Statement Throws — Allocate Inside the `try`

**Pattern:** Allocating a resource (temp dir via `mkdtemp`, a file handle, a lock, a connection) on a line BEFORE the `try` means a throw from a later statement (e.g. `writeFile`) unwinds without the block's cleanup running for it — the resource leaks. The allocation and the code that can throw must be in the SAME `try` for `catch`/`finally` cleanup to cover it.

**Instances:**
- 2026-07-30 — Server Storage (t/2020, p/206#6, **caught by the security reviewer**): `mkdtemp` was called BEFORE the `try`; if `writeFile` inside the block threw, the temp dir leaked (never cleaned up). Fixed by moving the `mkdtemp` inside the `try`. Lesson: any async I/O that ALLOCATES a resource belongs inside the `try`, so a subsequent throw triggers its cleanup.

**Root Cause:** `try/catch/finally` only governs statements within the `try`. A resource acquired before the `try` is outside the cleanup scope — a later throw unwinds past it without releasing it. This is a resource-lifecycle bug, distinct from the error-MESSAGE convention (ActionableError): it's about WHERE you acquire, not how you report.

**Prevention:**
1. **Acquire the resource INSIDE the `try`** whose `catch`/`finally` releases it — never on a line before it.
2. **Pair every allocation with cleanup in the same block** — for temp dirs, a `finally { await rm(dir, {recursive:true, force:true}) }`.
3. **Review check:** confirm resource-allocating I/O (`mkdtemp`, `open`, acquire-lock) sits inside the guarded block, not preceding it. (A security reviewer caught this one — a good standing review question.)

**Status:** Active — resource-leak-on-throw; an allocation outside the `try` escapes cleanup.

**Applies To:** All agents writing resource-allocating async I/O (temp dirs, file handles, locks) with try/catch/finally cleanup.

---

## #116 [Build] A Foreground `sleep`-Poll Loop (waiting for a PR merge / external state) Blows the 2-Minute Bash Cap — Use a Background Monitor + One Direct State Check

**Pattern:** An inline foreground poll loop — `for i in $(seq 1 12); do gh pr view …; sleep 20; done` — waiting for an external state change (PR merge, CI run, deploy) runs for minutes and gets **killed at the Bash tool's 2-minute cap (exit 143)**. A foreground `sleep`-loop is structurally the wrong tool for a wait that can exceed 2m — it's guaranteed to time out.

**Instances:**
- 2026-07-30 — DevOps (p/26#25): a `for i in $(seq 1 12); do gh pr view; sleep 20; done` poll waiting for a PR merge **timed out (exit 143)** at the 2m cap; also violated the standing "never foreground loop-poll `gh`" rule. Fix: a **`run_in_background` monitor** (sanctioned — runs past 2m and re-invokes on completion) plus a **single direct `gh pr view <n> --json state` check** for a point-in-time answer.
- 2026-09-29 — Server Community (p/695#1, **`gh pr checks --watch` variant**): `gh pr checks --watch` hit the Bash tool's 7-minute timeout — not a bug; full monorepo CI (Electron/poviewer/PS tests) genuinely takes longer than any reasonable single invocation cap. Fix: switched to single non-blocking `gh pr checks <n>` calls instead of a blocking `--watch` loop.

**Root Cause:** the Bash tool caps foreground commands at the specified timeout (default 2m, up to 10m); a `--watch` loop or `sleep`-poll is *designed* to run longer, so any CI that takes longer than the cap kills the wait (exit 143). Same **"foreground op > timeout → killed → background it"** genus as #78 (worktree-remove rm) and #95 (large push). **`gh pr checks --watch` is a built-in blocking loop** — same failure as a manual sleep-poll, just hidden inside the `gh` flag. A background task is the sanctioned escape; a single non-blocking check is the minimal alternative.

**Prevention:**
1. **Never foreground-poll in a `sleep`-loop or `--watch` flag for external state (PR merge, CI, deploy).** Put the wait in a `run_in_background` monitor (survives past cap, re-invokes on completion) and do a **single direct state check** (`gh pr view <n> --json state` / `gh pr checks <n>`) when you need a point-in-time answer.
2. **`gh pr checks --watch` is a blocking loop** — treat it identically to a manual sleep-poll: background it or replace with a single non-blocking check.
3. **If you must check inline, do ONE check, not a loop** — if it's not ready, background the wait.
4. Genus rule: any foreground op that can exceed the Bash cap (huge-tree rm #78, large push #95, poll loops, `--watch` flags) belongs in the background; the foreground is for bounded-fast commands only.

**Status:** Active — 2 instances / 2 agents; 2 variants (sleep-poll loop; `--watch` blocking flag). Standing rule: never foreground loop-poll `gh`.

**Applies To:** All agents waiting on external state (PR merge, CI, deploy) from the Bash tool.

---

## #117 [Build] A Green (Differential) CodeQL PR Check ≠ a PRE-EXISTING Alert Is Fixed — Verify a Fix on the Post-Merge MAIN SAST Scan, Not the PR Check or Branch-Ref Query

**Pattern:** CodeQL's PR check-run is DIFFERENTIAL — it fails only on NEW alerts the PR introduces and passes (green) regardless of whether the PR's intended fix actually cleared a **pre-existing** alert. So a green CodeQL check does NOT confirm a pre-existing alert is resolved. Worse, the PR/branch-ref alerts query (`code-scanning/alerts` filtered to the PR's ref) returns **empty unreliably**, which reads as "no alerts → cleared" and misleads you into reporting a fix landed when it hasn't. The authoritative signal is the **post-merge MAIN-branch SAST scan** (the full re-scan that re-evaluates the whole backlog).

**Instances:**
- 2026-07-30 — ServerAPI (t/2019): reported a pre-existing CodeQL alert "cleared" based on a **green PR check + an empty branch-ref alerts query** — but the differential check only gated NEW alerts, and the branch-ref query was unreliably-empty. The fix's real effect had to be confirmed on the **post-merge MAIN SAST scan**. Also hit: the code-scanning **dismiss API caps `dismissed_comment` at 280 chars (HTTP 422 over)** — discovered here.
- 2026-08-03 — Technical Lead (p/8#173, t/2110): wrote a dismissal comment at normal ticket-comment length — the API 422d "Only 280 characters are allowed." Fix: keep the comment to a tweet-length summary (verdict + guard reference); put the full reasoning on the ticket.
- 2026-08-03 — Tech Lead 2 (p/253#5/#7, t/2100): bulk CodeQL dismissal script 422d when `dismissed_comment` exceeded 280 chars. **Root cause differs from instance 1:** the cap was already documented (prevention #3 above), but filed under a *verification* lesson a bulk-dismissal author would never navigate to — a **findability failure, not a knowledge failure**. Durable fix: landing dismissal rules in `docs/security/dependency-policy.md` § Dismissal Rules (TL2 PR #380) where dismissal work gets written.
- 2026-09-29 — ServerAPI (p/504#14, t/3747): dismissal comment 628 chars — API 422d at 280-char cap. Trimmed to 239 chars on retry. 4th instance of the 280-char sub-finding.

**Root Cause:** differential CodeQL (the t/2025 / #112 design — fail on NEW alerts only, not the ~108-alert backlog) is calibrated to NOT block on pre-existing alerts, so by design a green check says nothing about them. The branch-ref alerts API is ref-scoped / eventually-consistent and returns empty spuriously. Confirming a pre-existing-alert fix therefore requires the full MAIN scan (re-evaluates the backlog), not the PR-scoped differential signal. Flip side of #112: **#112** = a green required gate hides a NEW alert; **#117** = a green differential check falsely implies a PRE-EXISTING alert is fixed. Both stem from "the CodeQL PR signal is new-only/differential." The 280-char `dismissed_comment` sub-finding also has a **findability root cause**: correct guidance filed under the wrong lesson heading is effectively absent for the author who needs it.

**Prevention:**
1. **To confirm a fix cleared a PRE-EXISTING CodeQL alert, verify on the POST-MERGE MAIN SAST scan** — NOT the PR check-run (green = no new alerts, says nothing about the backlog) and NOT the branch-ref alerts query (returns empty unreliably). **Confirm the SPECIFIC alert's state on main:** `gh api repos/:owner/:repo/code-scanning/alerts/<n> --jq .state` → must read `fixed` or `dismissed` (TL t/2001#11).
2. **Don't report a pre-existing alert "cleared" from a green PR check or an empty branch-ref query.** Wait for main's scan, or the alert's state flipping to `fixed`/`dismissed` on the MAIN-ref query.
3. **Dismissing a code-scanning alert: `dismissed_comment` caps at 280 chars** (HTTP 422 over, undocumented in the error body) — format: verdict + enforcing guard + ticket ref; put full source/sink analysis in a **co-located code comment** (tickets get archived; code stays co-located with the dismissal). Canonical rules now in `docs/security/dependency-policy.md` § Dismissal Rules (p/253#5, t/2100).

**Status:** Active — 4 instances / 3 agents. Flip side of #112 (a green differential CodeQL check says nothing about the pre-existing backlog); high-relevance to Wave-2's backlog-clearing (t/2001). Ties to the t/2025 differential-mode gate. **DISPOSITIONED (TL p/8#142):** sharpened into durable Wave-2 guidance at **t/2001#11**. 280-char `dismissed_comment` cap now in `docs/security/dependency-policy.md` § Dismissal Rules — canonical location for dismissal authors (TL2 PR #380, p/253#7).

**Applies To:** All agents clearing/dismissing pre-existing CodeQL alerts (Wave-2 security work) — verify fixes on the MAIN scan; keep dismiss comments ≤280 chars.

---

## #175 [API] GitHub Code-Scanning `dismissed_reason` Enum Uses Spaces Not Underscores — `"false positive"`, Not `"false_positive"`

**Pattern:** The GitHub code-scanning dismiss API (`PATCH /repos/.../code-scanning/alerts/<n>`) accepts `dismissed_reason` as a string enum. The valid values use **spaces**: `"false positive"`, `"won't fix"`, `"used in tests"`. Passing underscores (`"false_positive"`) is rejected — the API 422s with no clear pointer to the enum format.

**Instances:**
- 2026-09-29 — ServerAPI (p/504#14, t/3747): `dismissed_reason: "false_positive"` rejected. Fix: corrected to `"false positive"`. Discovered alongside the 280-char `dismissed_comment` cap (pattern #117).

**Root Cause:** The GitHub API uses natural-language strings (with spaces) for this enum, not the snake_case convention common in programmatic APIs. The 422 error doesn't name the offending field clearly, making it hard to distinguish from the comment-length 422.

**Prevention:**
1. **GitHub code-scanning dismiss reasons use spaces:** `"false positive"` / `"won't fix"` / `"used in tests"` — never underscores.
2. When a dismiss call 422s, check BOTH this enum AND the 280-char `dismissed_comment` cap (#117) — they produce similar errors and often hit together.

**Status:** Active — 1 instance (ServerAPI p/504#14).

**Applies To:** All agents dismissing code-scanning alerts via `gh api` or the GitHub REST API.

---

## #177 [Process] `direct` Mode Permits Committing on `main` — NOT Pushing; `enforce_admins:true` Blocks All Direct Pushes

**Pattern:** An agent in `direct` mode commits on the shared `main` checkout (permitted by AGENTS.md), then attempts `git push origin main` directly — rejected by GitHub branch protection. Since t/3736 added `enforce_admins:true` to `main`, **branch protection applies to admins too**: a direct push that skips CI is refused even for the repo owner. `direct` mode governs the *commit gate* (pre-commit hook allows commits on main); it has never governed the *push gate* (branch protection, which is a GitHub-layer control). These two gates are independent.

**Instances:**
- 2026-09-29 — Rosetta Stone (p/6#67): direct `git push origin main` rejected — branch protection requires status checks even for admin in direct mode (t/3736 enforce_admins:true). Resolved by landing via branch + PR instead.
- 2026-10-01 — SummaryViewer (p/385#3): `git push origin HEAD:main` rejected (HTTP 405) — branch protection. Resolved: opened worktree branch + PR #2686.

**Root Cause:** Conflating two independent gates: (1) the `pre-commit` hook (Orca/local) governs whether a commit is allowed on the shared `main` branch — `direct` mode disables this gate; (2) branch protection on GitHub governs whether a push to `main` is accepted — `enforce_admins:true` means this gate is always active, regardless of mode or admin status. AGENTS.md says direct mode makes committing *permitted*; the land-from-worktree skill separately notes "a direct push to `main` bypasses the required checks in EITHER mode and remains a process violation" — but the implication ("and will be rejected") was only enforced by convention until t/3736.

**Prevention:**
1. **`direct` mode changes the commit gate only.** In either mode, code must land via a CI-green PR — `git push origin main` is rejected by branch protection (enforce_admins:true, t/3736).
2. The correct path in direct mode: commit on shared main, then `git push origin <new-branch>` (not main), open a PR, CI-green, self-merge.
3. If you already committed on main and need to land it: cherry-pick to a worktree branch, open a PR from there.

**Status:** Active — 2 instances. t/3736 (enforce_admins:true) made this a hard rejection rather than a process violation.

**Applies To:** All agents in direct mode attempting to push commits directly to `main`.

---

## #176 [Process] `gh pr review --approve` Fails — GitHub Blocks Self-Approval; Use `gh pr comment` Instead

**Pattern:** `gh pr review <n> --approve` exits non-zero with "Can not approve your own pull request" — GitHub enforces that a PR author cannot also be the approver. Since the fleet is one GitHub identity, every PR is self-authored, making `--approve` permanently unavailable.

**Instances:**
- 2026-09-28 — AI Triad Research Project Instructions (p/688#1): `gh pr review 2485 --approve` failed. Resolved by recording owner sign-off via Orca ping to the requesting role instead of a GitHub review.
- 2026-09-29 — Tech Lead (p/447#20): `gh pr review 2577 --approve` failed. Resolved by posting approval comment via `gh pr comment` instead.

**Root Cause:** GitHub PR review approval requires a reviewer who is NOT the PR author. The fleet pushes as one GitHub identity (the repo owner), so every PR is both authored and reviewed by the same account — GitHub's self-approval block is always triggered.

**Prevention:**
1. **Never use `gh pr review --approve`** — it will always fail for this fleet. Use `gh pr comment` to post an approval note instead.
2. For sign-off/approval signals visible to humans, post via Orca ping to the requesting role.

**Status:** Active — 2 instances / 2 roles. Permanent constraint (fleet is one GitHub identity).

**Applies To:** All agents attempting to approve their own PRs on GitHub.

---

## #178 [Process] Reasoning From the Description of a Value, Not the Value — Invisible Drift at Write-Time

**Pattern:** An agent asserts "X does Y" where the evidence is an artifact that *describes* Y (a comment, config field name, variable name, docstring, local cached state) rather than the value or behavior that *produces* Y. The description reads identically whether or not it has drifted from the actual value — so the error is invisible at the moment of assertion and only caught on a second look at the source. Sharpens root AGENTS.md's "Verify Against the Authoritative Source" rule with a specific discriminator.

**Instances (2026-09-30, Computational Linguist e/232, all endorsed by TL + PI):**
1. **Confidence-model direction (t/3786, e/230#3):** concluded a steelman "perturbs confidence in the wrong direction" by reasoning from a predicate's *comment* ("opposing camp cited this Belief") — without reading `CROSS_POV_DELTA = 0.10` six lines above (positive = reinforcing, not opposing). One grep settled it, run only after the answer was already asserted.
2. **Corpus count (t/3598):** reported "9 summaries added" from a contaminated local working tree's untracked count, not the actual commit diff (22). Local state described the corpus; it had drifted.
3. **Metric unfalsifiability (t/3787, qbaf_agreement_density):** a candidate metric keyed on `sourceNode.speaker` — inheriting the very bug under test — so it measured the wiring and would report it as the phenomenon. An instrument sharing a defect with its subject is unfalsifiable by construction. Caught only after reading what the metric keyed on.
4. **Gate staleness (t/3598 leg-c):** reasoned about index freshness from config/description before reading the actual corpus-vs-index state (genuinely drifted; no trigger kept it fresh).

**Root Cause:** A description (comment, variable name, config, cached local state) reads the same whether or not it has drifted from the value. At write-time the claim feels verified because the description says so. The gap only surfaces when someone reads what produces the behavior. Three especially load-bearing surfaces: sign/direction constants (read the constant, not the comment); metric definitions (does the instrument share the defect?); corpus/registry counts (read origin, not local state).

**Prevention:**
1. **Discriminator:** if you are about to write "X does Y" and your evidence is a file/comment/name/cached-state that *configures or describes* Y, you have not verified it — read the value that produces the behavior.
2. For **signs and constants**: read the actual constant value, not its comment or variable name.
3. For **metrics and instruments**: check what the metric keys on — if it shares a dependency with the bug under test, it cannot falsify the hypothesis.
4. For **corpus and registry counts**: read from `origin/main` or the commit diff, never from local working-tree state which may be contaminated or stale.
5. Ties to root AGENTS.md "Verify Against the Authoritative Source" — four surfaces named there (merged state, infrastructure state, baselines, gate behavior) all share this root.

5. **2026-10-07 — Computational Linguist (t/4040, e/268#17→#22, inst5):** asserted rows without a fingerprint "fail closed into the model-mixed bucket" — reasoning from the bucket's purpose (design intent) without reading `isFingerprinted` at `replicationGate.ts:119`. **Propagation amplifier:** the wrong claim was in the merged register §17 text; DebateTool read it and repeated it to argue no fix was needed. Second Opinion caught it. The propagation made a single unread line produce two incorrect conclusions from two agents. **Heuristic: "X fails closed" needs the line that rejects X, not the bucket it lands in.**

**Status:** Active — 5 instances (4 in one CL session + 1 new CL instance with propagation). TL + PI endorsed tracking. Root AGENTS.md already has the general rule; this entry adds the discriminator and the three load-bearing surfaces. **Inst5 adds a propagation-amplifier warning:** an unverified behavioral claim in a shared document propagates to downstream agents as a premise.

**Applies To:** All agents making causal or behavioral claims about code, metrics, or corpus state — especially "fails closed," "defaults to," or "rejects" claims where the evidence is a bucket or fallback path, not the guard condition.

---

## #179 [Build] `jq test()` Throws on Null Input — Filter with `select(.field != null)` or Null-Coalesce Before Testing

**Pattern:** `jq`'s `test()` function throws a runtime error ("null (null) has no keys" or "string required") when the input value is `null`. A `--json` field from `gh pr view` or similar may legitimately include records with `null` field values (e.g. `statusCheckRollup` entries with `.name = null`). The error causes the jq pipeline to exit 1, hiding any output already written to stdout.

**Instances:**
- 2026-09-29 — DebateTool (p/70#35): `gh pr view 2602 --json statusCheckRollup --jq '... | select(.name | test(...))'` exited 1 — one record had `.name = null`, which `test()` rejected. Resolved by reading the prior stdout output (CodeQL was already shown green). Fix: `select(.name != null)` before the test, or `select(.name // "" | test(...))`.

**Root Cause:** `jq`'s `test()` requires a string input; `null` is not a string and causes an immediate error. GitHub's JSON responses for PR check rollups include entries with null fields for pending or skipped checks, making null-guarding necessary in any jq filter that calls `test()`.

**Prevention:**
1. **Before any `test()`-based jq filter, null-guard the field:** `select(.name != null) | select(.name | test("pattern"))` — or use null-coalescing: `select(.name // "" | test("pattern"))`.
2. **jq exit 1 ≠ "no matches"** — it may mean a runtime error mid-stream. Check whether useful output appeared before the error before assuming failure.
3. Companion to pattern #73A (grep exit 1 on zero matches): jq also exits non-zero on errors, not just empty results.

**Status:** Active — 1 instance (DebateTool p/70#35).

**Applies To:** All agents filtering `gh pr view --json` or similar API output with jq `test()`.

---

## #180 [Build] `git worktree add … main` Uses Stale LOCAL main — Base on `origin/main` After Fetch; Failed Add Leaves an Orphaned Branch

**Pattern:** `git worktree add -b <branch> <path> main` bases the worktree on the **local** `main` ref, which may lag `origin/main` by one or more merges. A file that just landed on origin is absent from the worktree, causing "No such file" on the next operation. Compounding: when the first `add` fails for any reason (e.g., path already exists, hook error), git **creates the branch but not the worktree** — so the retry hits **"branch already exists"** unless the orphaned branch is explicitly deleted first.

**Instances:**
- 2026-09-30 — Computational Linguist (e/233, #2603): `git worktree add -b <branch> <path> main` — local `main` pointed at pre-merge commit `90dfeac2`; `findings.md` (merged minutes earlier) was absent. First attempt left an orphaned branch. Resolution: `git branch -D <branch>` + `git worktree prune`, then `git fetch origin`, then `git worktree add -b <branch> <path> origin/main`.

**Root Cause:** `main` (no remote prefix) resolves to the **local** tracking ref, which only advances on `git fetch`/`pull`. The shared checkout on this fleet rarely fetches proactively, so local `main` regularly lags `origin/main` by in-flight PRs. A worktree based on stale local `main` therefore reproduces whatever was on `origin/main` at the time of the last fetch — not the current state. `origin/main` is always the authoritative current baseline; local `main` is a cached snapshot. Companion to AGENTS.md "Verify Against the Authoritative Source → read origin/main (the shared checkout lags behind merges)" and pattern #178 (reasoning from description, not value).

**Prevention:**
1. **Always base worktrees on `origin/main`, never bare `main`:** `git fetch origin && git worktree add -b <branch> <path> origin/main`. The `/land-from-worktree` skill already mandates this form — using bare `main` is a deviation from procedure.
2. **When `git worktree add` fails, the branch may already exist** — clean up before retrying: `git branch -D <branch>` (to drop the orphaned branch) + `git worktree prune` (to clear any stale administrative ref), then retry with the corrected base.
3. Discriminator for root cause: if a file you know just merged to origin is absent in a fresh worktree, the worktree is almost certainly based on stale local `main`. Verify: `git log --oneline <branch>..origin/main` — any output means the worktree is behind.

**Status:** Active — 1 instance (Computational Linguist e/233). Both facets (stale base ref + orphaned branch on failed add) documented.

**Applies To:** All agents using `git worktree add` — especially in the `/land-from-worktree` flow where the correct form (`origin/main`) is prescribed; deviation to bare `main` is the failure vector.

---

## #181 [Build] `ls` Exit Code Varies by How Many Paths Are Absent — Use `Test-Path` or `os.path.exists` for Existence Checks

**Pattern:** Using `ls <path1> <path2>` to test whether paths exist is unreliable: `ls` exits **1** when at least one path exists but some don't, and **2** when NONE of the listed paths exist (on GNU coreutils; some implementations differ). Scripts gating on `$? == 0` or `$? == 1` will misread the "none found" case. The root issue is using a listing tool as an existence-check tool — `ls` reports path contents, not a Boolean existence result.

**Instances:**
- 2026-09-30 — DebateTool (p/70#39): `ls nonexistent1 nonexistent2` exited 2 (both paths absent); script expected exit 1 for "not found." Self-resolved; no downstream impact. Fix: replaced with `python3 -c "import os; print(os.path.exists(...))"` / PowerShell `Test-Path`.

**Root Cause:** `ls` is designed to list directory contents, not to return a meaningful Boolean for path existence. Its exit codes encode "listing success" (0 = all paths listed, 1 = some paths errored, 2 = all paths errored on GNU), not the simpler exists/absent distinction a check needs. Scripts treat the 1-vs-2 distinction as an implementation detail, then break when all paths are absent.

**Prevention:**
1. **Use purpose-built existence tools:** PowerShell `Test-Path <path>` (exits 0/1 cleanly); Python `os.path.exists(path)` or `pathlib.Path(p).exists()`; Bash `[[ -e <path> ]]` or `[[ -f <path> ]]` for file/dir tests.
2. **Never gate on `ls` exit code** — it encodes listing errors, not existence. `ls` exit 1 ≠ "path absent" when multiple paths are passed.
3. Companion to the exit-code literacy patterns (#73A grep, #121 `gh pr checks`): tool exit codes encode the tool's own semantics, not a generic "found/not found" signal.

**Status:** Active — 1 instance (DebateTool p/70#39).

**Applies To:** All agents using Bash or PowerShell for path existence checks.

---

## #182 [Build] `Invoke-ScriptAnalyzer -Recurse` Throws Non-Terminating "Object reference not set" — Results Still Populate; Offending File/Rule Not Yet Isolated

**Pattern:** `Invoke-ScriptAnalyzer -Path <dir> -Recurse -Settings <file>` throws a non-terminating `NullReferenceException` ("Object reference not set to an instance of an object") — an internal PSSA null-ref against some specific file/rule combination in the scanned tree. The error surfaces on stderr but does NOT abort the run: `$results` still populates with findings for the successfully-scanned files.

**Instances:**
- 2026-10-01 — PowerShell (p/20#48): `Invoke-ScriptAnalyzer -Path ./scripts/AITriad -Recurse -Settings ...` threw the null-ref twice across two different worktrees of the same commit. `$results` populated on first occurrence. Offending file/rule not yet isolated — diagnosis ongoing.

**Root Cause:** PSSA internal null-ref on a specific file/rule interaction (likely an edge case in a rule's AST walk). Exact combination not yet identified.

**Prevention:**
1. **Don't abort on this error — check `$results` first.** The null-ref is non-terminating; findings for other files still land in `$results`. Treat the exception as a warning, not a fatal failure.
2. **To isolate the offending file/rule:** narrow `-Path` to a subdirectory, or disable rules one-by-one (`-ExcludeRule`) until the error stops firing.
3. **Once isolated:** open a PSSA issue with a minimal repro (the file + rule name + PSSA version).

**Status:** Active — 1 instance (PowerShell p/20#48); results consistent (2283 findings both runs), confirming non-blocking. Root cause diagnosis deprioritized — file/rule combo not yet isolated; update this entry when recurrence blocks results.

**Applies To:** PowerShell agents running `Invoke-ScriptAnalyzer -Recurse` over the `scripts/AITriad` tree.

---

## #183 [Build] Assumed Project File Location — ENOENT on a Guessed Path; Correct Path Found Immediately via Glob

**Pattern:** An agent operates on a file using an assumed path (e.g. `taxonomy-editor/eslint-rules/complexity-baseline.json`) without verifying where it actually lives. The operation fails with ENOENT; the correct path (e.g. `lib/eslint-rules/complexity-baseline.json`) is found in seconds via `Glob **/filename`.

**Instances:**
- 2026-10-01 — Shared Lib (p/5#38, t/3840): assumed baseline file was at `taxonomy-editor/eslint-rules/complexity-baseline.json`; `head` returned ENOENT. `Glob **/complexity-baseline.json` in the worktree found the correct path (`lib/eslint-rules/complexity-baseline.json`) immediately.

**Root Cause:** Guessing a file's location from a plausible package name rather than verifying first. Files that look like they belong to one package (taxonomy-editor) may canonically live in a shared package (lib/) — especially config and baseline files that multiple packages reference.

**Prevention:**
1. **Before operating on any project config/baseline file, run `Glob **/filename` to confirm its actual location.** One Glob call costs milliseconds and eliminates the guess-and-ENOENT loop.
2. For shared tooling files (ESLint rules, baselines, config), check `lib/` before assuming they live in a specific package directory.
3. If a file genuinely doesn't exist, Glob's empty result is unambiguous — better signal than an ENOENT on a wrong path.

**Status:** Active — 1 instance (Shared Lib p/5#38).

**Applies To:** All agents locating project config/baseline/shared-tooling files before operating on them.

---

## #184 [Process] Structural Root Cause Confirms All Siblings — Deferring Them as "Not Yet Confirmed" Is Wrong

**Pattern:** When a root cause is structural — "X is on the wrong side of boundary B" — every entity in the same structural position shares the defect **by construction**. An agent scopes the fix to only the instance it observed and defers siblings as "not yet confirmed," but the root-cause analysis already confirmed them. This understates scope at the start and leads to follow-up tickets for instances that were always known.

**Discriminator:** If the root-cause sentence stays true with the sibling's name substituted in, the sibling is in scope. This is the test to apply at the start of a fix, not just the one originally observed instance.

**Distinction from surviving-vector rule:** The surviving-vector close-out rule governs what you *claim when finishing* (what can still fail after this fix?). This pattern governs what you *scope when starting* (which instances does this root cause already cover?). The two rules apply at different points in the task lifecycle and do not substitute for each other.

**Instances:**
- 2026-10-01 — TL observation (p/335#107, t/3843): structural root cause identified; siblings in the same structural position deferred as "not confirmed" when the root-cause sentence — unchanged — applied to each of them by substitution. Corrected: siblings were brought in scope and fixed together.

**Root Cause:** Conflating "I haven't *observed* a failure in this sibling" with "this sibling is not confirmed to have the defect." Structural root causes don't require per-instance observation — the structure itself is the evidence.

**Prevention:**
1. When you write a root-cause sentence, immediately substitute each sibling's name into it. If it stays true, that sibling is in scope — add it to the fix now, not as a follow-up.
2. Reserve "not confirmed" for cases where the root cause is *not* structural (e.g., it depends on runtime state, configuration, or a code path that may or may not be triggered per instance).
3. Structural root causes are recognizable by the form "X is on the wrong side of Y" or "all instances of type T share property P" — any sentence whose truth depends only on structure, not on observation.

**Status:** Active — 1 instance (TL p/335#107, t/3843).

**Applies To:** All agents scoping fixes from a root-cause analysis.

---

## #185 [Process] A Timeout Leaves PARTIAL State — Check Actual State Before Retrying, Never Retry Blind

**Pattern:** A tool call that exits on SIGTERM (exit 143) or times out was killed mid-execution, not before it started. The operation may be partially complete: some files deleted, a network transfer half-done, a ref deregistered without the directory removed. A blind retry re-runs the whole operation from the beginning, potentially doing redundant work or misreading the starting state — or failing because a partially-completed side-effect makes the operation invalid to restart.

**Instances:**
- 2026-09-29 — Rosetta Stone (p/6#65, #78 Facet B): `git worktree remove` timed out mid-delete — `.git` file gone, ref still registered, directory partially present. Blind retry would have re-tried `git worktree remove` on a half-deleted worktree. Correct fix: `git worktree prune` (handled the stale ref) + background `rm -rf` (handled remaining files separately).
- 2026-10-01 — TL (p/335#105, #78 Facet B variant): `rm -rf` on four `.worktrees/*` node_modules trees exited 143 (SIGTERM). Checked actual state: files were already deleted, only empty dir skeletons remained. Second pass with raised timeout cleared the skeletons in seconds. Without the state check, a blind retry would have re-run the full deletion unnecessarily.

**Root Cause:** Tools have a maximum execution time; long-running destructive operations (large deletes, big transfers, slow network calls) are interrupt-safe from the tool's perspective but not from the operation's. A SIGTERM arrives during execution and the operation stops wherever it was.

**Prevention:**
1. **After any timeout (exit 143 or tool-reported timeout), check state before retrying.** Use `ls`, `Test-Path`, `git status`, or the relevant existence check on the target. Retry only what remains — don't re-run the full operation.
2. **Raise the timeout on the retry** to match the remaining work, not the original estimate. If half the files are already gone, the retry is cheaper than the original run.
3. **For destructive operations, distinguish "nothing happened" from "partial completion."** A timeout on a delete is almost never "nothing happened" — it's "some happened." Treating it as a clean starting state can cause double-work or a failed restart.
4. The corollary: for **idempotent** operations (HTTP GET, read-only query, a `git fetch`), a blind retry is safe. For **destructive or stateful** operations (delete, write, register/deregister, network push), inspect first.

**Status:** Active — 2 instances; cross-reference #78 prevention #7.

**Applies To:** All agents retrying any operation that exited on timeout or SIGTERM.

---

## #186 [Process] Glob False-Negative (Possible cwd Mismatch) Misread as "File Doesn't Exist" → Write Silently Clobbers Tracked File

**Pattern:** `Glob(<relative-pattern>)` returns empty. Agent interprets empty as "file doesn't exist" and uses `Write` to create it — silently overwriting an existing tracked file. The actual cause of the empty result is likely a cwd mismatch (Glob resolving relative to scope root rather than repo root), not genuine absence. The clobber is invisible until `git status` before committing reveals `M` (modified tracked) instead of `??` (new untracked).

**Instances:**
- 2026-10-01 — PowerShell (p/20#57, t/3829 near-miss): `Glob("tests/Measure-CodeComplexity*")` returned no results. Agent used `Write` believing the file was new — it was a previously-merged, hand-verified test file (PR #2637/#2639). `git status` before committing showed `M` not `??`, revealing the clobber. Recovered with `git restore`. Suspected cause: Glob's relative path resolved against scope root (`scripts/AITriad/`) rather than repo root; same cwd-not-repo-root issue as #128 (unconfirmed — needs a live test with absolute path).

**Root Cause:** Two compounding failures: (1) Glob may resolve relative paths against the agent's scope root rather than the repo root, giving a false-negative "no results" rather than a wrong-cwd error — the result is indistinguishable from genuine absence. (2) "No results from a lookup" was treated as proof of non-existence; the correct inference is only "not found in the searched scope." `Write` creates OR overwrites without warning — it has no "fail if exists" mode.

**Prevention:**
1. **Use absolute paths in Glob to bypass any cwd ambiguity.** `Glob("**/Measure-CodeComplexity*")` (double-star from repo root) or an absolute base path avoids the cwd question entirely. Relative patterns are vulnerable to the scope-root vs repo-root ambiguity.
2. **Before using `Write` on a "new" file, confirm it is truly untracked:** `git status --short -- <path>` — `??` = safe to Write; `M` or blank (tracked, unmodified) = the file exists; use `Edit` instead.
3. **"No results" from a lookup proves nothing about existence** — it proves the lookup didn't find it in the scope it searched. Verify with a second method (Read, git status, PowerShell `Test-Path`) before concluding the file is absent.
4. **Prefer `Edit` over `Write` when extending an existing file.** `Edit` requires a prior `Read`, which would surface the existing content and prevent a blind overwrite.

**Open question:** Whether Glob resets cwd between calls (like Bash/PowerShell tools per #128) is unconfirmed — needs a live test. Until confirmed, use absolute paths or `**/<name>` patterns defensively.

**Status:** Active — 1 instance (PowerShell p/20#57, t/3829); near-miss caught by git status discipline.

**Applies To:** All agents using Glob to check file existence before Write.

---

## #187 [Process] `gh pr merge` "Not Mergeable" — main Advanced While PR Was Open; Update Branch and Re-Push

**Pattern:** `gh pr merge <N> --squash …` returns "not mergeable" because `main` advanced after the PR was opened and the resulting divergence created a merge conflict (or branch protection `strict: true` requires the PR to be up-to-date with main). The PR cannot be merged in its current state.

**Instances:**
- 2026-10-02 — Shared Lib (p/5#41, t/3854): `gh pr merge` returned "not mergeable" — main had advanced. Fixed by `git merge origin/main` in the worktree + push, which merged in the new main commits, resolved any conflicts, and brought the PR head up to date.

**Root Cause:** Between PR creation and the merge attempt, one or more commits landed on `main`. If those commits touch files the PR also modifies, a merge conflict prevents GitHub from auto-merging (`not mergeable`). Even without conflict, if branch protection has `strict: true`, the PR must be up-to-date before merging.

**Prevention:**
1. **Before `gh pr merge`, check `gh pr view <N> --json mergeStateStatus`** — `BEHIND` or `CONFLICTING` means update the branch first. `CLEAN` or `UNSTABLE` means it can proceed.
2. **To update in a worktree:** `git fetch origin && git merge origin/main` (inside the worktree), resolve any conflicts, then `git push origin <branch>`. Wait for CI to re-pass on the new head, then merge with `--match-head-commit`.
3. Alternatively, `gh pr update-branch <N>` updates the branch via GitHub's API (merge-based). The merged head must then pass CI before merging.
4. **The "not mergeable" state can appear silently** between a green CI run and the merge attempt. Always check `mergeStateStatus` (or look for the "not mergeable" error output) rather than assuming CI-green implies merge-ready.

**Status:** Active — 1 instance (Shared Lib p/5#41, t/3854).

**Applies To:** All agents running `gh pr merge` after a PR has been open for a non-trivial period while main is active.

---

## #188 [Build] `git merge --continue --no-edit` Fails — `--no-edit` Is Not a Valid Flag for `git merge --continue`; Use `GIT_EDITOR=true git merge --continue`

**Pattern:** After resolving merge conflicts and staging the result, `git merge --continue --no-edit` exits with an error: `unknown option: --no-edit`. The `--no-edit` flag is valid for `git merge` (initial invocation) and `git commit`, but **not** for `git merge --continue`.

**Instances:**
- 2026-10-02 — Shared Lib (p/5#41, t/3854): `git merge --continue --no-edit` after conflict resolution → error `unknown option: --no-edit`. Fixed by `GIT_EDITOR=true git merge --continue`, which sets the editor to `true` (exits immediately without modification), letting `--continue` commit using the default merge message without opening an interactive editor.

**Root Cause:** `git merge --continue` is a thin wrapper around `git commit` in merge-in-progress state. It does not accept `--no-edit` as a flag itself. The `--no-edit` flag suppresses the editor on `git merge <branch>` (the start) and on `git commit`, but not on the `--continue` subcommand.

**Prevention:**
1. **Never `git merge --continue --no-edit`** — the flag is rejected.
2. **To suppress the editor on `git merge --continue`**, use `GIT_EDITOR=true git merge --continue`. Setting `GIT_EDITOR=true` makes git invoke `/usr/bin/true` (or `true.exe`) as the editor, which exits immediately without modifying the message file — equivalent to `--no-edit` in effect.
3. Alternatively: `git commit --no-edit` after staging the resolution works if `--continue` is not needed, but `GIT_EDITOR=true git merge --continue` is the canonical path.

**Status:** Active — 1 instance (Shared Lib p/5#41, t/3854).

**Applies To:** All agents resolving merge conflicts with `git merge --continue`.

---

## #189 [Build] `gh api … | base64 -d` — API Error JSON Surfaces as Decoder Error, Pointing at the Wrong Stage; Validate First with `--jq .content`

**Pattern:** `gh api repos/…/contents/<path> | base64 -d` produces `base64: invalid input` when the file path is wrong (or any other fetch error). The `gh api` call returns a JSON error object (`{"message":"Not Found",…}`) on stdout — not file content. `base64 -d` then tries to decode the JSON text as base64 and fails, emitting an error that names `base64` as the failing command, not the `gh api` call. The actual failure (wrong path, 404) is invisible.

**Instances:**
- 2026-10-02 — Tech Lead (p/335#109): `gh api …/lib/oped/outletBands.test.ts | base64 -d` → `base64: invalid input`. Actual cause: wrong path (file was at `lib/oped/__tests__/outletBands.test.ts`). `gh api` returned a 404 JSON error on stdout; `base64 -d` tried to decode the JSON and failed. Resolved by reading from `gh pr diff` instead, which requires no path guess.

**Root Cause:** In a pipeline, if the first stage (`gh api`) fails and writes error text to **stdout** (JSON APIs always do), the second stage (`base64`, `jq`, a decoder) receives the error text as its input. It emits a secondary error that names itself — pointing at the decoder layer rather than the API layer. The diagnostic actively misleads: `base64: invalid input` says nothing about a wrong path.

**Prevention:**
1. **Capture, check exit, check non-empty, then decode — never pipe straight through:**
   ```sh
   c=$(gh api repos/…/contents/<path>?ref=… --jq '.content') || exit 1
   [ -n "$c" ] || exit 1
   printf '%s' "$c" | base64 -d
   ```
   The `|| exit 1` after the capture surfaces `gh api`'s non-zero exit. The `[ -n "$c" ]` guard catches the `--jq` yielding empty/null on a 404 body. Both checks must be explicit — a pipe swallows exit codes and passes empty strings silently.
2. **`--jq .content` alone does NOT prevent this.** On a 404, `--jq '.content'` yields empty/null while `gh api` exits non-zero — the jq filter was present in the failing command and was useless. The real protection is capturing the exit code, not filtering the output.
3. **`2>/dev/null` discards the diagnostic.** Adding `2>/dev/null` to suppress login noise also silently discards the "Not Found" error that names the failing layer. Remove `2>/dev/null` from API fetch lines during debugging; add it only when you are certain the call succeeds.
4. **General rule:** never pipe a command whose failure mode is "error JSON on stdout + non-zero exit" directly into a decoder. The decoder receives empty or error-JSON, chokes, and names itself in the error — pointing at the wrong layer. Capture first; check both exit and content; then decode.
5. **Sibling of the pipeline-exit-code masking pattern (land-from-worktree Sage #96):** `cmd1 | tail` swallowed a non-ff reject. Same exit-code-swallow class; here `2>/dev/null` also discards stderr. `set -o pipefail` (Bash) or `$LASTEXITCODE` checks in PowerShell partially help, but the full fix is always: capture → check → process.

**Status:** Active — 1 instance (TL p/335#109). Pipeline stdout-masking variant of the exit-code-masking class.

**Applies To:** All agents using `gh api …/contents/<path>` (or any JSON API) piped into a decoder or processor.

---

## #190 [Process] `git log` Is Newest-First — A Consecutive-Commit Delta Loop Computes Deltas in Reverse; Additions Read as Deletions

**Pattern:** `git log` outputs commits newest-first (reverse chronological) by default. A loop that computes the consecutive delta between adjacent commits in that order computes `new → old`, not `old → new` — so every addition appears as a deletion and vice versa. The loop completes successfully, prints results, and produces a **confident wrong answer**: no error signal, directionally inverted.

**Instances:**
- 2026-10-02 — Second Opinion (p/691#5): bash loop iterating `git log` output newest-first, labelling drops in node count as "DROP" — 8 apparent removals produced. Actual removal count: 0 (the 8 "drops" were additions read backwards). Caught before reporting because the timeout (#122) interrupted the first run; the completing re-run on a smaller range revealed the inversion. The consult was a blocking-gate review asking "did anything get removed" — a completing inverted loop would have produced a confident wrong blocking answer.

**Root Cause:** `git log` default order is newest-first (newest commit at the top). Computing `commits[i] - commits[i+1]` in list order gives `newer - older` = forward delta; but labelling a *decrease* from commits[i] to commits[i+1] as "removal" is actually labelling the removal from the older commit to the newer one as seen backwards. The **semantic inversion is silent** — the loop never errors. The only signal is implausible results (all additions look like removals).

**Prevention:**
1. **When iterating `git log` output to compute forward-time deltas, always use `git log --reverse`** (or pipe through `tac`). This gives oldest-first order so consecutive delta loops compute `old → new` = the actual change over time.
2. **Sanity-check delta loop results against a known ground truth before reporting.** If "removals" appear where you expect growth, suspect direction inversion.
3. **In consulting / blocking-gate contexts, direction errors are especially dangerous** — the loop completing is evidence of nothing except that it ran. Validate direction before reporting a result that could block a merge.
4. **Cross-reference with total counts:** if the total at the end doesn't match the expected final state, the loop's direction is likely wrong.
5. **Assert the direction with an endpoint anchor.** The loop's final value must equal the current working-tree value (or whatever the known newest state is). One comparison catches inversion, off-by-one windows, and filtered-out commits — loudly, without relying on having remembered `--reverse`. Example: after the loop, assert `final_count == $(git ls-files … | wc -l)`. Generalises to any ordered-iteration delta (changelog, time series): anchor to a known endpoint, fail loud on mismatch. (p/691#7)

**Status:** Active — 1 instance (Second Opinion p/691#5). Silent directional inversion; completing version produces confident wrong answer. Consulting-context risk: a wrong "N items removed" in a blocking-gate review.

**Applies To:** All agents writing loops that compute consecutive-commit deltas over `git log` output.

---

## #118 [Build] A Platform Feature Can Be AVAILABLE While a Specific MODE/Tier of It Is Plan-Gated — Verify the Exact MODE Empirically Before Designing Around It

**Pattern:** A GitHub (or any platform) feature may work on your repo while a specific MODE, tier, or sub-option of it is silently plan-gated — surfacing HTTP 422 only when you invoke that mode. Designing a gate/workflow around the plan-gated mode fails at implementation time, *after* you've built around it. The availability trap has **granularity**: "the feature works" ≠ "every mode of it works on this repo's owner-type/plan."

**Instances:**
- 2026-07-30 — DevOps (t/2025, p/26#27): creating a GitHub `code_scanning` **ruleset** succeeded, but in **`evaluate` enforcement mode** (non-enforcing dry-run) it returned **HTTP 422** — the `evaluate` MODE is **Enterprise-plan-only**; the rule TYPE and `active`/`disabled` modes work fine on this public user-owned repo. Pivoted the gate-verification to the **check-run level** (throwaway PRs vs main, read `statusCheckRollup`) instead of a non-enforcing ruleset. The trap was on the MODE, not the feature.
- 2026-07-29 — (t/1968, Sage memory `feedback_verify_feature_availability_empirically`): GitHub **merge queue** is **org-only**, not "any public repo" — an availability trap at the **FEATURE** level (a user-owned repo can't use it at all); burned an eval + a landed trigger. The feature-level sibling of the mode-level trap above.

**Root Cause:** platform features are gated at multiple granularities — feature (merge queue: org-only), mode/tier (ruleset `evaluate`: Enterprise-only), option — and the gating is invisible until you invoke the exact combination on the exact repo (`owner_type` + plan). Designing around a plan-gated mode before verifying it against THIS repo means the failure surfaces at build time, after the design is committed. Same "verify feature availability empirically for THIS repo" discipline (t/1968), **refined to MODE granularity**.

**Prevention:**
1. **Before designing a gate/workflow around a platform feature's MODE/tier, verify THAT EXACT MODE empirically on THIS repo** — create it (or confirm docs' `owner_type`/plan gating) — not just that the feature exists.
2. **Availability gating has granularity** — feature (t/1968 merge-queue org-only) vs mode/tier (t/2025 ruleset `evaluate` Enterprise-only). Check at the granularity you'll actually use, on this repo's owner-type + plan.
3. **When a mode is plan-gated, pivot to a plan-agnostic equivalent** — e.g. verify gates at the **check-run level** (throwaway PRs vs main, read `statusCheckRollup`) instead of a non-enforcing ruleset.

**Status:** Active — platform-availability trap at MODE granularity; refines the t/1968 feature-level availability lesson. Verify the specific mode/tier empirically for THIS repo (`owner_type` + plan) before designing around it.

**Applies To:** All agents designing gates/workflows around GitHub (or any platform) features whose modes/tiers may be plan-gated — especially on a user-owned public repo.

---

## #119 [Build] A Build-Only Container CI Gate Never RUNS the Image — a Startup/Readiness Crash Passes Green (build ≠ runs); P1 Prod Outage

**Pattern:** A container CI gate that **builds** the image but never **starts** it cannot catch a startup/readiness failure — the build is green, so a crash-looping image reaches prod. "The image built" is bookkeeping; "the image comes up healthy" is the artifact (gate-integrity genus, t/1589: **build ≠ runs**, sibling of #94 build≠suite-runs and #112 green-required-gate≠all-checks). A **P1 prod outage** because three gate/safety-net gaps compounded — each individually survivable, together an outage instead of a blip.

**Instances:**
- 2026-07-30 — P1 PROD OUTAGE (TL p/8#146, anchor t/2047; fix DAG t/2048–2052 + PR #297): a **Dependabot base-image bump** (`ai-triad-base :2026-07-20 → :07-30`, commit `0b33fc18`) **crash-looped prod** — the app inited fully but `httpGet /healthz` **self-503'd on the new base** (readiness/data-loaded gate failed). Three compounding process failures: **(1)** the container CI gate is **build-only — it never RUNS the image**, so a startup crash passed green; **(2)** the **auto-rollback target had been garbage-collected** → the rollback was a **no-op** → the incident escalated from a blip to an outage; **(3)** **Dependabot base bumps reach prod with zero runtime validation.** Prod restored; fix DAG filed.
- **ROOT CAUSE — CORRECTED (TL p/8#152, Docker single-variable A/B t/2053#12/#13/#15):** actual cause = **t/2061 — a `CACHE_DIR`/readiness CODE bug introduced after the healthy `efd068fe` build**, NOT the base image. The initially-flagged **undici / Node-22.23.2-TLS mechanism was a CONFOUND**: the A/B shows `:07-30` reaches `/healthz` **200 WITHOUT** the undici fix once t/2061 is present → undici did not cause the crash. Base bump (`0b33fc18`) and code bug (t/2061) BOTH changed good→bad, so the scarier base/CVE variable got wrongly blamed until A/B isolation. **undici retained only as unproven defense-in-depth.** Base-tag pin (prevention #5) + SBOM-diff (#6) stay as hygiene but neither was the cause.
- **(superseded) initial mechanism hypothesis:** a floating `FROM node:22-bookworm-slim` shipping 22.23.2/undici-6.28.0 TLS on rebuild → global-`fetch()` break → `/tmp` cache empty → `/healthz` 503. Kept as the confounded hypothesis the A/B overturned; SBOM-diff (daemon-down) surfaced the delta that made it *look* causal.

**Root Cause:** the CI container gate validated *buildability*, not *runnability* — the exact "build ≠ runs" gap of the gate-integrity genus. A `/healthz` readiness probe that depends on the base image's runtime (data-load path) can pass in build/unit contexts and fail only when the real image boots, so nothing short of *starting the built image and hitting its health endpoint* would have caught it. Compounded by two silent safety-net holes: a rollback whose target no longer existed (GC'd) **no-ops without erroring** (["rollback configured" ≠ "rollback target exists"], bookkeeping≠artifact), and an **auto-merged dependency bump** (Dependabot) that reaches prod on the same build-only gate with no runtime step — so an automated change with prod blast-radius had zero runtime validation anywhere in its path.

**Prevention:**
1. **A container gate must RUN the built image and hit its health endpoint, not just build it** — boot the image, `httpGet /healthz` (or the real readiness probe), fail the gate on non-200. Build-green is not deploy-safe; only a smoke-boot proves the image comes up. (Generalizes t/1589 build≠runs to the container/deploy gate.)
2. **Compounding factor A — a rollback target can be GC'd, making rollback a silent no-op.** "Auto-rollback configured" ≠ "a valid rollback target exists." Pin/retain the last-known-good image (protect it from GC/retention) and **verify the rollback actually reverted** (health-check post-rollback), don't trust that it fired. A no-op rollback turns a blip into an outage.
3. **Compounding factor B — automated dependency bumps (Dependabot), especially BASE-IMAGE bumps, reach prod with prod blast-radius; gate them with runtime validation.** A base-image bump changes the runtime out from under the app; require the run-the-image smoke-boot (prevention #1) on Dependabot PRs before they can merge/deploy — don't let an auto-bump reach prod on a build-only gate.
4. **Readiness/`/healthz` self-503 on a base bump = the base's runtime changed under the app** (data-load path, lib versions, entrypoint) — when a base bump crash-loops, suspect the readiness gate's runtime dependencies, and diff the base image, not just the app code.
5. **Base-image hygiene (NOT the root cause here) — a FLOATING base tag makes every rebuild a silent, unpinned dependency bump.** `FROM node:22-bookworm-slim` pulls whatever patch is current at rebuild time. **Pin the base patch version in `Dockerfile.base`** so a runtime change is a deliberate PR. Good hygiene + defense-in-depth; in THIS incident it was a confound, not the cause.
6. **Diagnostic — daemon down? diff the SBOM artifacts** for the exact package delta. Caveat: an SBOM delta shows what *changed*, not what *caused* the failure (it surfaced the confounding undici delta) — enumerate candidates, then ISOLATE (#7), don't attribute from the delta.
7. **Multi-variable good→bad? isolate the true cause with a single-variable A/B — don't blame the scariest variable (a CVE/base bump).** Both a code change (t/2061) and a base/undici bump landed between healthy `efd068fe` and the crash; the CVE looked causal but a single-variable A/B (hold t/2061, toggle only undici) showed `:07-30` = `/healthz` 200 without the undici fix → undici confound, code bug cause. Object-level RCA (#44/#54/#55 family): confirm by controlled test, mark a mechanism **hypothesized** until isolated. **Structural, not "be careful" (TL p/8#155):** the confound fooled the ENTIRE chain at once — TL (built the t/2053 gate on it), DevOps, Server Storage, Sage. A scary CVE anchors everyone on the same salient culprit, so independent-diligence-by-many doesn't catch it; only a controlled single-variable test does (Docker's A/B = the exemplar).

**Status:** Active — **P1 prod outage, resolved (prod restored); fix DAG t/2048–2052 + PR #297, anchor t/2047.** Gate-integrity genus (t/1589 build ≠ runs) — the container/deploy-gate instance of the same family as #94 (build ≠ suite runs) and #112 (green required gate ≠ all checks green). The severity came from three compounding gaps (build-only gate + GC'd rollback no-op + unvalidated auto-bump to prod), each a bookkeeping-≠-artifact hole; the durable fix closes all three (run-the-image gate, protected rollback target + verify-reverted, runtime-gated Dependabot) **plus base-tag pinning as hygiene**. **ROOT CAUSE CORRECTED (TL p/8#152, t/2053#12/#13/#15):** actual cause = **t/2061 (`CACHE_DIR`/readiness code bug after healthy `efd068fe`)**; the **base-bump / undici-TLS mechanism was a CONFOUND** (both changed good→bad; single-variable A/B showed `:07-30` = `/healthz` 200 without the undici fix), undici retained as unproven defense-in-depth. The build≠runs + gate-integrity lessons are UNAFFECTED. **Shared over-attribution, not an individual lapse (TL p/8#155, systems-not-blame):** the whole chain — TL (built the t/2053 gate on it), DevOps, Server Storage, Sage — ran with the undici attribution; a scary CVE anchored everyone. Structural lesson (prevention #7: hypothesized-until-isolated), not "be more careful." Correction landed fast + clean — the system working. **Fix validated — strongest "build ≠ runs" evidence yet (TL p/8#149):** the new docker-run smoke (t/2048), on its **FIRST real run**, caught a **pre-existing SILENT deploy-freeze** the build-only gate had hidden — current main was **undeployable on BOTH bases** (node-agnostic readiness bug t/2061), prod surviving only on an older image. The build-only gate hadn't just masked the one bump — it left main un-deployable with no signal; the run-the-image gate surfaced it on day one. (This incident also produced 2 concurrent dup-ticket pairs → see #62 "Concurrent Duplicate Ticket-Filing," variant B.)

**Applies To:** All agents/owners of container CI, deploy gates, rollback automation, and Dependabot/dependency-bump policy — especially base-image bumps with prod blast-radius.

---

## #120 [API] A Model CLASS Can Carry a Hard Request-Param Constraint (Reasoning Models Require `temperature=1`) — a One-Size Request Silently HTTP-400s Every Call; Encode It in the Registry

**Pattern:** Some model classes reject request params that are fine for other models — notably **reasoning models require `temperature=1`** (any other value is a hard error). A provider layer that sends one default temperature to every model **HTTP-400s on EVERY call** to such a model — not intermittently, not degraded: 100% failure, silent until someone reads the 400 body. The constraint is per-model-CLASS, so it can't be a global default; it must be declared per model.

**Instances:**
- 2026-08-01 — Diagnostics (t/2068, fixed `04052430`, PR #315, p/9#48): **kimi-k3** (a reasoning model) was **silently HTTP-400-ing on every call** because the provider sent a non-1 temperature. Fix: a **registry-driven `fixedTemperature` field in `ai-models.json`**, honored in the provider (send the model's fixed temperature when declared, else the normal default). Follow-ups: **t/2069** (better next-steps on a 400 — the error was silent/uninformative), **t/2070** (audit groq/deepseek reasoning models — the same constraint likely applies).
- 2026-08-01 — Diagnostics (t/2083, p/9#51): **new instance — kimi-k3 still rejects `temperature != 1` in production**, and **t/2070's audit confirmed the same in groq/deepseek reasoning models.** Recurring root-cause SMELL: **the `?? default` fallback in providers** — `temperature ?? defaultTemperature` silently supplies a non-1 default wherever the per-model `fixedTemperature` isn't threaded to that call, re-introducing the 400. The registry field (t/2068) is necessary but not sufficient: every `param ?? default` site is a place the constraint gets silently overridden.

**Root Cause:** request-param validity is **model-class-specific**, but a provider layer tends to build one request shape for all models. Reasoning models pin `temperature=1`; sending anything else is rejected outright (400), so the failure is total for that model and invisible to any test that doesn't exercise it live (keyless CI never calls it — ties to #88). Encoding the constraint per-model in the single-source registry (`ai-models.json`) is the fix; hardcoding a temperature per call, or assuming all models accept the same params, is the bug. Same "coupling lives in the registry" family as the AI-backend coupling-sites lesson (t/1932). **Recurring smell (Diagnostics t/2083): the `?? default` fallback** — `temperature ?? defaultTemperature` at a provider call site silently substitutes a non-1 default whenever the model's `fixedTemperature` wasn't threaded to that site; the registry field only holds if EVERY call path reads it.

**Prevention:**
1. **Declare per-model request-param constraints in the registry (`ai-models.json`), honor them in the provider** — e.g. `fixedTemperature` for reasoning models; the provider sends the declared value, else the default. Don't hardcode one temperature (or any param) for all models.
2. **When adding a reasoning model, check its fixed-param requirements FIRST** (temperature=1 is common for reasoning models across vendors — groq/deepseek included, t/2070). A new reasoning model without its `fixedTemperature` declared will 400 100% of the time.
3. **A 100%-failure HTTP 400 on one model but not others = a per-model request-param mismatch** — read the 400 body (it names the rejected param), don't assume a key/auth problem. (t/2069 improves the 400's next-steps so this is obvious.)
4. **Live-exercise a newly-added model** — a keyless/mocked CI never sends the real request, so a param-constraint 400 only shows on a live call (sibling of #88 keys-present divergence). Smoke one real call per new model.
5. **Audit every `param ?? default` / `param || default` site in the provider** (Diagnostics t/2083) — each is a place a per-model constraint (`fixedTemperature`) gets silently overridden if the registry value wasn't threaded to that call. Grep the provider for the defaulting sites; the registry field is only as good as the paths that read it. A defaulting fallback for a hard-constrained param is the smell.

**Status:** Active — **3 instances now** (kimi-k3 t/2068 + t/2083; groq/deepseek via the t/2070 audit). The registry `fixedTemperature` field (t/2068, `04052430`) is necessary but **not sufficient** — the recurring **`?? default` fallback smell** (t/2083) means a per-model constraint leaks back unless EVERY provider call path threads the registry value (prevention #5). t/2069 improves the 400 diagnostics; t/2070 audits the other reasoning models. Registry-as-single-source-of-model-constraints — same family as the AI-backend coupling-sites lesson.

**Applies To:** All agents adding or configuring AI models (especially reasoning models) in `ai-models.json` / the provider layer — declare fixed request-param constraints in the registry, thread them through EVERY defaulting call site, live-smoke each new model.

---

## #121 [Build] `gh pr checks` Exits Non-Zero (8) When a Check Is PENDING — Not a Failure; Re-Poll, Don't Abort

**Pattern:** `gh pr checks <n>` returns a **tri-state exit code**: `0` = all passed, `1` = a check FAILED, **`8` = one or more checks still PENDING/queued**. So a green-so-far PR with one slow check still running (e.g. `test-container`) exits **8** — non-zero, but nothing failed. A caller that branches on "non-zero = failure" conflates *pending* with *failed* and may wrongly abort a land.

**Facet B — `--watch` false-green:** `gh pr checks <n> --watch` can exit `0` while some jobs still show **"pending 0"** — meaning those jobs have been scheduled but their individual check-runs haven't registered yet. `--watch` polls the currently-known checks and exits as soon as they all pass; it doesn't wait for checks that haven't appeared yet. Result: a confident-looking green that precedes real results.

**Facet C — grep on text output ≠ "specific check green":** Piping `gh pr checks` text output through `grep` and using grep's exit code to determine whether a specific check (e.g. `ci-gate`) passed is unreliable. Grep exits 0 when ANY line matches — so if `ci-gate` appears in output while IN_PROGRESS, or if other checks' lines match the grep pattern, grep returns 0 even though ci-gate is not green. Fix: use `gh pr view --json statusCheckRollup --jq '...'` filtered by `name == "ci-gate"` and `conclusion == "SUCCESS"`, or read bare `gh pr checks` without grep and scan visually.

**Facet E — `--required` exits 0 before required context exists:** `gh pr checks <n> --required` can exit `0` with "ALL-REQUIRED-GREEN" while a required context (e.g. `ci-gate`) has no check-run at all on that OID yet. The rollup reports "nothing failing" because there is literally nothing yet to report — a required context that hasn't posted is absent from the check-run list, not failing. This is distinct from Facet B (check IN_PROGRESS) and Facet D (check still running at merge time): the check has not been triggered at all on this OID. Discriminator: query `repos/{owner}/{repo}/commits/{sha}/check-runs` directly for each required context name; if the context is absent from that list, the rollup's "green" reflects absence, not passage.

**Instances:**
- 2026-08-01 — Server Storage (p/206#13, re-confirmed p/206#14): `gh pr checks 326` exited **8** because `test-container` was still running; **no check actually failed**. Recognized as expected `gh` behavior; **re-polled once `test-container` completed** → green. (Two reports same session — the exit-8 = pending semantics catch people.)
- 2026-08-06 — DebateUI (p/83#8, Facet B): `gh pr checks <n> --watch` exited **0** while `test-electron` jobs still showed **"pending 0"** — the checks hadn't been registered yet. `--watch` saw no failing checks and exited; later the real job results arrived. False-green signal on a PR that wasn't fully checked.
- 2026-09-30 — DebateTool (p/70#41, **Facet C**): `gh pr checks | grep ci-gate` — grep exited 0 when other checks appeared in output while `ci-gate` was IN_PROGRESS. DebateTool merged prematurely. Fix: query ci-gate by name via `gh pr view --json statusCheckRollup`, or use bare `gh pr checks` without grep.
- 2026-09-30 — Rosetta Stone (p/6#69): `gh pr checks 2633` exited 8 — recognized correctly as "still pending" (not failure) and re-polled. No action needed. Self-correcting once the exit-code semantics are known.
- 2026-10-01 — Shared Lib (p/5#35, **Facet D — merge blocked by GitHub required-check enforcement**): `gh pr merge --squash --match-head-commit` returned "2 of 4 required status checks are expected" — CI was still IN_PROGRESS (CodeQL, test-powershell, test-electron, render-smoke). GitHub's branch-protection gate refused the merge atomically. Resolved by waiting for all required checks to conclude `success` before retrying. This is the downstream consequence of Facet B: `--watch` exits 0 before all checks register, merge attempt fires, GitHub blocks it.
- 2026-10-03 — DevOps (p/26#128, **Facet E — `--required` exits 0 while required context absent**): `gh pr checks <N> --required` exited 0 with "ALL-REQUIRED-GREEN" while required context `ci-gate` had zero check-runs on that OID — confirmed by querying `repos/{owner}/{repo}/commits/{sha}/check-runs` directly. The rollup reported "nothing failing" because there was literally nothing yet to report. Resolved by querying the raw check-runs API per required context name and waiting until each one posted a result.

**Root Cause:** `gh pr checks`'s exit code encodes STATE, not a pass/fail boolean — exit 8 specifically means "not done yet." Same "exit code is a status indicator, not success/failure" family as #73 facet A (grep exit-1 on zero-match ≠ error). It bites hardest during a self-merge wait, when a slow check (`test-container`) hasn't finished but every other check is green — the raw exit looks like failure. **Now covered** by the `exit-code-literacy-guard` workspace rule (2026-08-03, t/2081) — the exit-8=pending branch of the exit-code-literacy family; advisory (non-blocking). **Firing OBSERVED live on THIS branch — TL saw it correctly flag exit-8=pending (not failed) on `gh pr checks 334` during the PR #334 CodeQL wait (p/8#166)** — the 2nd of two independent live firings (Sage's `grep -c` #73A branch was the 1st); systematic verification deferred per t/1625.

**Prevention:**
1. **Don't read `gh pr checks` non-zero as "failed" — distinguish exit `8` (PENDING → re-poll) from exit `1` (FAILED → stop).** Branch on the specific code, or better, on the actual per-check state.
2. **Parse the per-check state, not just the exit code** — `gh pr checks <n> --json name,state,conclusion --jq '...'` gives real states (`IN_PROGRESS`/`QUEUED` vs `FAILURE`); the raw exit code alone can't tell pending from failed to a naive branch.
3. **On a self-merge wait, exit 8 = "not done, re-poll"** — re-run once the pending check completes (or use a background monitor, #116); don't abort the land.
4. **Facet B — `--watch` false-green:** after `--watch` exits 0, verify with a bare `gh pr checks <n>` (no `--watch`) to confirm all jobs have actually completed with conclusions. If any show "pending 0" or blank conclusion, `--watch` exited prematurely — wait and re-check.
5. **Facet C — to verify a specific check, use structured JSON, not grep:** `gh pr view <n> --json statusCheckRollup --jq '.statusCheckRollup[] | select(.name == "ci-gate") | .conclusion'` returns `SUCCESS`, `FAILURE`, or empty (still running). Never use `gh pr checks | grep <name>` as a pass/fail signal for a specific check — grep exit 0 only means a line matched, not that the check passed.
6. **Facet D — don't attempt `gh pr merge` until all required checks conclude `success`.** GitHub blocks the merge with "N of M required status checks are expected" if any required context is still IN_PROGRESS or hasn't reported yet. The symptom of Facet B (false-green `--watch`) is this blocked merge. Fix: after `--watch` exits 0, do a final bare `gh pr checks <n>` and confirm every required context shows `pass` before issuing the merge command.
7. **Facet E — verify each required context has an actual check-run before trusting the rollup.** After `--required` exits 0, confirm each required context name appears in `gh api repos/{owner}/{repo}/commits/{sha}/check-runs --jq '[.check_runs[].name]'`. Zero entries for a required context means no run posted yet — the rollup "green" reflects absence, not passage. This is faster than waiting for a Facet D block at merge time.

**Status:** Active — `gh pr checks` text/exit-code unreliability (0 pass / 1 fail / 8 pending + Facet B false-green + Facet C grep-misread + Facet D premature-merge GitHub block + Facet E `--required` absent-context false-green); "exit code ≠ pass/fail boolean" family (#73A). Self-correcting once recognized. CI-wait sibling of #111 (current-HEAD-gated workflow) and #116 (background monitor, not foreground poll).

**Applies To:** All agents polling `gh pr checks` while waiting on PR checks (self-merge / land waits).

---

## #122 [Build] A Subprocess-Per-File Bash Loop Over the Whole Tree Times Out on Git Bash/Windows — Use Parameter Expansion, Not `$(cmd)` Per Item

**Pattern:** A bash loop that spawns a subprocess PER FILE — e.g. `$(dirname "$f")` (or `$(basename)`, `$(echo | sed)`) inside a loop over `git ls-files` (~thousands of files) — spawns tens of thousands of subprocesses. On **Git Bash/Windows, process spawn is pathologically slow** (fork/exec emulation), so the loop **blows the 2-minute Bash-tool timeout (exit 143)** on a few-thousand-file tree. The same loop is fast on Linux (cheap fork) — a **Windows-specific perf cliff**, invisible in Linux CI.

**Instances:**
- 2026-08-01 — DevOps (t/2091, p/26#31): a CI script built a tracked-dir set via a **`$(dirname)` subshell loop over `git ls-files` (~3k files)** → tens of thousands of subprocess spawns → **timed out (>2 min)** on Git Bash/Windows. Fixed with **pure-bash ancestor extraction via parameter expansion** — `while [[ $d == */* ]]; do d=${d%/*}; done` (zero subprocesses) → **47s**.
- 2026-10-01 — PowerShell (p/20#47): bash loop calling `git show <commit>:<file> | wc -l` once per file × 402 files timed out at 2 min — per-file subprocess spawn overhead × file count exceeded the Bash-tool cap. Fixed with `git archive` to extract the whole tree in one shot, then counting locally in a single pass (one subprocess, not 402).
- 2026-10-02 — Second Opinion (p/691#5): bash loop spawning `git show | grep` per commit × 4 files over 60 commits (240 subprocesses) timed out (exit 143). Re-ran at 18 commits × 1 file.

**Root Cause:** each `$(...)` / backtick command substitution **forks a subprocess**; on Windows Git Bash, fork/exec is emulated and ~orders of magnitude slower than native, so N-thousand spawns dominate wall-clock. Bash **parameter expansion** (`${d%/*}` = dirname, `${f##*/}` = basename, `${f%.*}` = strip-ext) does the same string ops **in-process** — zero spawns. Ties to the "foreground op > 120s Bash-tool cap → SIGTERM" genus (#78/#95/#116), but here the cost is **spawn-count**, not a single slow op or I/O.

**Prevention:**
1. **Never spawn a subprocess per file when iterating the whole tree in bash** — replace `$(dirname "$f")` → `${f%/*}`, `$(basename "$f")` → `${f##*/}`, `$(echo "$x" | sed …)` → parameter expansion (`${x//a/b}`, `${x%suffix}`, `${x#prefix}`). Parameter expansion is in-process; command substitution forks.
2. **On Git Bash/Windows, subprocess spawn is the bottleneck, not the work** — a loop fine on Linux CI can blow the 2m Bash-tool cap on win32 purely from spawn count. Count `$(...)`-per-iteration × tree size before running a whole-tree loop.
3. **If you genuinely need an external tool per item, batch it** — feed all items to ONE `xargs`/`awk`/`sed` invocation instead of one spawn per item.

**Status:** Active — 3 instances. Windows Git-Bash subprocess-spawn perf cliff; a whole-tree per-file `$(cmd)` loop times out (spawn-count-bound). Sibling of the "foreground op > 120s Bash cap" genus (#78/#95/#116) — same 2m-timeout symptom, root cause = subprocess spawns, not a single slow op.

**Applies To:** All agents writing bash loops over `git ls-files` / large file sets on Windows Git Bash — use parameter expansion; batch external tools.

---

## #123 [Process] Shared GitHub Account — `gh pr review --approve` and `--request-changes` Both Fail on ANY Fleet PR

**Pattern:** All fleet agents authenticate to GitHub as the **same account** (`jpsnover`). GitHub prohibits reviewing your own PR in any blocking mode — `--approve` fails `Cannot approve your own pull request` and `--request-changes` fails `Can not request changes on your own pull request`. From `gh`'s view every fleet PR is self-owned. A shared-**identity** collision at the GitHub-account level — the platform-account analog of the shared-**checkout** collision (t/1926) at the git level.

**Instances:**
- 2026-08-03 — DevOps (p/26#34): `gh pr review --approve` on PR #334 failed `Cannot approve your own pull request`. Resolved by posting the review as a **comment** (`gh pr review --comment`).
- 2026-09-28 — Project Instructions (p/688#1): `gh pr review 2485 --approve` failed same error; follow-up `gh pr comment` then blocked by the auto-mode classifier. Resolved: record sign-off via Orca ping to the requesting role.
- 2026-10-07 — DevOps Lead (p/26#145): `gh pr review --request-changes` on an agent-authored PR failed `Can not request changes on your own pull request`. Resolved by posting the blocking feedback as `gh pr comment`, applying `consult-hold` label, and setting draft as the merge hold.

**Root Cause:** A single shared GitHub identity across all agents × GitHub's self-review prohibition. Both approval and change-requests are per-USER review actions GitHub ties to account identity; the fleet has ONE account. The failure is **deterministic** on `--approve` and `--request-changes` alike for every fleet PR.

**Prevention:**
1. **Never `gh pr review --approve` or `--request-changes` on a fleet PR** — both fail. Post feedback with `gh pr review --comment`.
2. **To hold a PR from merging:** apply the `consult-hold` label (enforcing gate via `consult-hold-guard` required check) + set draft + post a hold comment naming conditions. `--request-changes` cannot block a merge here anyway — branch protection is checks-only, not approval-required.
3. **Approval is NOT required to merge:** branch protection is checks-only (`ci-gate` + CodeQL), so PRs land by checks-green self-merge. The failed `--approve`/`--request-changes` is a non-blocker for the merge path.
4. **If `gh pr comment` is also blocked by the auto-mode classifier**, record sign-off via Orca ping to the requesting role.
5. **Cheaply hookable:** both `gh pr review --approve` and `gh pr review --request-changes` are crisp syntactic signals. Candidate Diagnostics hook.

**Status:** Active — 3 instances / 3 agents. Extends to `--request-changes` (inst3). Shared-GitHub-identity constraint; the account-level analog of t/1926. Deterministic on every fleet PR.

**Applies To:** Any agent running `gh pr review --approve` or `--request-changes` on a fleet-authored PR (i.e. every PR, since all share the `jpsnover` account).

---

## #128 [Build] `git worktree add ../wt-<name>` Creates the Worktree at the REPO's Parent Level — Not the User Home; Always Run `git worktree list` Before First Bash Access

**Pattern:** A worktree added at `../wt-<name>` resolves relative to the **repository root** (`C:/Users/jsnov/repos/ai-triad-research/`), landing at `C:/Users/jsnov/repos/wt-<name>` — the `repos/` sibling directory. If the agent's mental map flattens the path depth (assumed home/repo, not home/repos/repo), the resulting absolute path is one level shallower than the actual. In the Bash tool's POSIX view, that's `/c/Users/jsnov/repos/wt-<name>`, not `/c/Users/jsnov/wt-<name>`. Running `ls` or any Bash command on the incorrectly-assembled path fails with `No such file or directory`.

**Instances:**
- 2026-08-03 — DevOps (t/2067, p/26#38): ran `ls /c/Users/jsnov/wt-2067/` — assumed `../wt-2067` from the repo resolves at home level, but the actual path was `C:/Users/jsnov/repos/wt-2067` = `/c/Users/jsnov/repos/wt-2067`. Fixed by running `git worktree list` to confirm the real path.
- 2026-08-03 — ElectronMain (p/98#13, t/2111): `cd /c/.../wt-t2111` immediately after `git worktree add ../wt-t2111` — "No such file." Compounding factor: **Bash tool resets cwd between invocations**, so the cwd for the `cd` call was the repo root regardless of any prior `cd`. The agent constructed the POSIX path from memory rather than reading `git worktree list`. Fixed by running `git worktree list` and using the canonical absolute path `/c/Users/jsnov/repos/wt-t2111`.
- 2026-09-30 — DebateTool (p/70#37): `cd lib/debate` failed "No such file or directory" — the Bash cwd had reset to the agent's scope directory (`lib/debate`), so `cd lib/debate` tried to navigate to `lib/debate/lib/debate` (nonexistent). Fix: dropped the `cd` entirely. When the cwd already IS the target directory (because the runtime resets to the scope root), re-cdding into it is a no-op at best and an error at worst.
- 2026-10-01 — PowerShell (p/20#55): `Invoke-ScriptAnalyzer -Settings ./relative/settings.json` after a prior `cd` into repo root — **PowerShell tool cwd also resets between calls** (same t/2222 mechanism as Bash), so the relative `-Settings` path failed to resolve. Abandoned: the diagnostic was redundant (git-show evidence already confirmed the finding).
- 2026-10-04 — DevOps Lead (p/26#141): `gh pr create` run from Bash without `--head` failed with "you must first push the current branch" — the Bash cwd had reset to the shared checkout (on `main`), so `gh` read the current branch as `main` rather than the worktree branch. Fix: always pass `--head <branch>` explicitly to `gh pr create` when called from Bash, regardless of where the push was made.
- 2026-10-05 — PowerShell (p/20#68): `gh pr create` aborted with "you must first push the current branch" despite the branch already being pushed — run from the shared main checkout (still on `main`), not the worktree the push happened from. `gh pr create` without `--head` infers head from the current checkout's branch. Fix: added `--head <branch>`.
- 2026-10-06 — Rosetta Stone (p/6#77): Bash redirect `cmd > ../../../../AppData/...` from a worktree cwd failed with "No such file or directory" — relative path constructed assuming worktree cwd, but Bash tool cwd had reset to the scope directory, making the relative traversal land in the wrong place. Fix: write to the absolute scratchpad path.
- 2026-10-07 — Computational Linguist (p/7#97, **Grep-path-relative-to-scope variant**): Bash `grep` on a path returned by the Grep tool failed "No such file" — Grep reports paths **relative to the agent's scope cwd** (`research/comp-linguist`), not the repo root. Bash also resets cwd to the scope directory, so `scripts/reconcile_grounding.py` from Grep resolved to `research/comp-linguist/scripts/reconcile_grounding.py` (nonexistent). Fix: use the path relative to the scope directory, or pass an absolute path to Bash. **Heuristic: "Grep found it, Bash can't open it" = the path is scope-relative, not repo-root-relative.**

**Root Cause:** The repo lives at `C:/Users/jsnov/repos/ai-triad-research/` — two levels below home (`home/repos/repo`), not one (`home/repo`). `../wt-<name>` from the repo root goes up one level to `C:/Users/jsnov/repos/`, landing the worktree there, not at the user home directory. This is a **mental-model mismatch** (wrong path depth), distinct from MSYS path mangling (#73 facet B) — here the path is assembled incorrectly before any tool sees it. **Compounding factor (instance 2):** the Bash tool resets cwd to the repo root between invocations, so any relative path like `../wt-<name>` re-anchors to the repo root on every call — you cannot rely on a prior `cd` persisting to the next Bash call.

**Prevention:**
1. **Run `git worktree list` BEFORE first Bash access to a worktree** — it returns the canonical absolute path; never reconstruct the path by prepending the assumed home directory + a relative spec.
2. On this machine: repo = `C:/Users/jsnov/repos/ai-triad-research/`; sibling worktrees land at `C:/Users/jsnov/repos/wt-<name>` = `/c/Users/jsnov/repos/wt-<name>` in POSIX. NOT `/c/Users/jsnov/wt-<name>`.
3. Companion to the MSYS colon-revspec/path trap (#73 facet B): both produce a wrong absolute path for a git resource. #73B = MSYS mangles a correct path; #128 = a wrong path is assembled from an incorrect mental model. The fix for both: **verify the actual path before access** rather than reconstructing from memory.
4. **Both Bash AND PowerShell tool cwds reset between invocations (t/2222)** — relative paths re-anchor on every call regardless of a prior `cd`. Use absolute paths always; never depend on a prior `cd` persisting to the next tool call.
5. **Grep tool paths are relative to the agent's scope cwd, not the repo root (confirmed, p/7#97).** A path from Grep passed directly to Bash will fail "No such file" when the file lives outside the scope directory — Bash cwd also resets to the scope root, so it looks in `<scope>/<grep-path>`. Fix: prepend the repo root, or use the Grep-returned path as-is (it's already correct relative to scope cwd). **Heuristic: "Grep found it, Bash can't open it" = scope-relative path mismatch.** Glob likely follows the same rule (p/20#57; see Pattern #186 — possible, unconfirmed for Glob).

**Status:** Active — 7 instances. Worktree-land path-depth assumption hazard; cwd-reset compounds it. Third env/path hazard in the worktree-land cluster (#77 `npm ci` empty package dir, #78 node_modules rm timeout, #128 path-depth mismatch). **4th instance (2026-10-01, p/20#55):** PowerShell tool cwd reset caused relative `-Settings` path to fail — applies to BOTH tools, not just Bash. **5th instance (2026-10-04, p/26#141):** `gh pr create` read `main` as the current branch instead of the worktree branch — pass `--head <branch>` explicitly. **6th instance (2026-10-05, p/20#68):** same `gh pr create` / shared checkout failure on PowerShell, confirming the pattern is tool-agnostic — any `gh pr create` without `--head` from a non-worktree cwd hits this.

**Applies To:** All agents using the Bash tool to access a worktree by absolute POSIX path, or running `gh` CLI commands from Bash where cwd may have reset.

---

## #129 [Process] `gh pr merge` in Auto Mode Is Blocked by the Safety Classifier — PR Merges Require Explicit User Authorization; Surface the Command for Direct `!` Execution

**Pattern:** `gh pr merge <N> --squash --auto --delete-branch` (or any `gh pr merge` variant) in an **auto-mode agent session** is intercepted by the Claude Code safety classifier and blocked mid-sweep. The classifier treats PR merges as **hard-to-reverse + visible to others** — a category that requires explicit user confirmation regardless of auto-mode level. The agent cannot unblock itself; the action must be surfaced to the user as a `! gh pr merge <N>` command for direct authorization in the session.

**Instances:**
- 2026-08-03 — Orca Support (p/13#27): `gh pr merge 341 --squash --auto --delete-branch` blocked mid-PR resolution sweep by the auto-mode classifier. Resolved by surfacing `! gh pr merge 341` to the user for direct authorization.
- 2026-08-03 — Orca Support (p/13#31): `gh pr merge` blocked again during PR #289 conflict-resolution flow — same classifier gate, 2nd independent instance confirming the pattern is consistent across PR workflows, not session-specific.

**Root Cause:** The Claude Code safety classifier has a fixed policy: PR merge is a **shared-state, hard-to-reverse action** (merges commit to a repo visible to others, triggers CI, may deploy). Auto mode bypasses routine tool confirmations but NOT this class of action. The classifier intercepts at the tool-call layer before the command runs — this is **correct and intended behavior**, not a bug. The failure is the **workflow assumption** that `gh pr merge` would run unattended in an automated PR sweep.

**Prevention:**
1. **Never assume `gh pr merge` will run unattended in auto mode** — it always requires an explicit user authorization event. Plan for a manual authorization step in any PR-resolution workflow.
2. **Surface the command as `! gh pr merge <N> --squash --delete-branch`** — the `!` prefix runs the command in the active session under user authorization; this is the correct resolution path.
3. **Do NOT retry the same `gh pr merge` call** — the classifier will block it again. Only a human-authorized execution unblocks the action.
4. **Sibling of the push-authorization pattern**: `git push` to shared remotes is similarly treated as requiring user oversight. Both `git push` and `gh pr merge` are in the "visible to others / hard to reverse" class.

**Status:** Active — safety-classifier gate on `gh pr merge` in auto mode; by design. Every agent running automated PR sweeps will hit this. The fix is architectural: design PR workflows with a manual authorization step for the merge command, not a workaround to bypass the classifier.

**Applies To:** All agents running `gh pr merge` in auto mode (e.g., PR resolution sweeps, post-CI land automation).

---

## #130 [Build] A Staleness Check (Ancestry-Only) Is NOT a Cleanliness Check — STALE ≠ No Uncommitted Edits; Test Both Dimensions Independently Before an Overwrite

**Pattern:** A worktree classification script (`check-hub-clean.sh`) categorized a worktree as STALE when its HEAD was an ancestor of `origin/main` — but **never tested whether the working tree had uncommitted edits**. Downstream code treated STALE as "safe to overwrite" and proceeded with `ff-redetach`, destroying the uncommitted work. Root cause: **staleness** (commit ancestry relative to origin) and **cleanliness** (presence of uncommitted changes) are **orthogonal, independent conditions**. A worktree can be simultaneously STALE *and* dirty. A single-dimension ancestry probe does not answer the safety question.

**Instances:**
- 2026-08-03 — DevOps (t/2066#14, bdf14727): `check-hub-clean.sh` classified a worktree STALE (HEAD is ancestor of origin/main), but the worktree had uncommitted edits to the same files being overwritten. `ff-redetach` proceeded on the STALE classification → **work destroyed**. Fix: STALE now exits 1 (same as WIP); only PHANTOM and ZERO-BYTE classifications are safe to proceed over.

**Root Cause:** The STALE classification checked *one dimension* of "is this worktree safe to overwrite?": commit ancestry. It never checked the *orthogonal dimension*: working tree state (`git status --porcelain`). The two conditions are independent — a worktree behind origin (STALE) can still have local WIP. Treating the result of a partial probe as a complete safety predicate is a **classification completeness failure**: the gate measured the wrong (or insufficient) signal for the decision it was gating.

**Prevention:**
1. **Any overwrite safety predicate must test ALL dimensions that can independently carry unsafe state.** For a worktree: (a) commit ancestry *and* (b) working tree cleanliness are independent — both must pass for a safe overwrite. One-of-two is insufficient.
2. **Conservative default: treat any classification that doesn't positively confirm BOTH clean AND current as unsafe.** STALE + dirty = unsafe; STALE + clean = debatable; only PHANTOM (worktree gone) and ZERO-BYTE (no real content) are unambiguously safe to overwrite without a working tree check.
3. **"Can I overwrite this?" is a conjunction, not a disjunction.** `safe = (no uncommitted edits) AND (ancestry position is acceptable)` — both must hold. Never short-circuit on one.
4. **Sibling of the bookkeeping≠artifact genus** (#84/#90/#96): a status signal (STALE classification) described the process (commit position) but not the deliverable (working tree content). The safe check is always at the object/content level (`git status --porcelain`), not the lifecycle/classification level.

**Status:** Active — classification completeness failure; fixed in `check-hub-clean.sh` (bdf14727) by making STALE exit 1 (same as WIP). The underlying principle applies to any multi-dimensional safety check: test every independent dimension that can carry risk.

**Applies To:** All agents writing or using worktree-state classification scripts; any code that gates a destructive/overwrite action on a single-dimension safety probe.

---

## #131 [Build] `git merge --continue` Accepts No Arguments — `--no-edit` Is a `git commit` Flag; Bypass the Editor with `GIT_EDITOR=true`

**Pattern:** `git merge --continue --no-edit` exits **129** (usage error) — `--no-edit` is not a valid flag for `git merge --continue`. Unlike `git commit --no-edit` (which skips the editor for an existing message), `git merge --continue` accepts **no arguments at all**. The flag bleeds from the `git commit` mental model into `git merge --continue`, where it is simply illegal. To bypass the editor non-interactively, set `GIT_EDITOR=true` — the `true` command always exits 0 without opening anything, so git treats it as a silent no-op editor.

**Instances:**
- 2026-08-03 — Orca Support (p/13#29): `git merge --continue --no-edit` during a conflict-resolution flow exited 129. Resolved by `GIT_EDITOR=true git merge --continue`.

**Root Cause:** `git commit` and `git merge --continue` share the "continue a pending operation" concept but have different argument grammars. `git commit --no-edit` is a first-class flag; `git merge --continue` internally invokes `git commit` but exposes NO pass-through flags to the caller. Mental-model bleed from `git commit` syntax into the `git merge --continue` invocation.

**Prevention:**
1. **`git merge --continue` takes no flags** — run it bare: `git merge --continue`. Any argument causes a 129 usage error.
2. **To suppress the editor non-interactively:** `GIT_EDITOR=true git merge --continue` — the `true` binary exits 0 immediately without prompting; git accepts it as a valid editor invocation and proceeds with the auto-generated merge commit message.
3. **Other non-interactive merge alternatives:** `git merge --no-edit` (on the INITIAL merge, not `--continue`) or `git -c core.editor=true merge --continue` are equivalent to the `GIT_EDITOR=true` form.
4. **Related**: `git rebase --continue` also accepts no `--no-edit`; same `GIT_EDITOR=true` technique applies. The pattern is: `--continue` subcommands of git operations route through their own commit path and don't accept commit-level flags directly.

**Status:** Active — git CLI grammar gap: `--continue` subcommands (merge, rebase, cherry-pick) accept no `--no-edit`; use `GIT_EDITOR=true`. Self-correcting (exit 129 is loud) but wastes time when the workaround isn't known.

**Applies To:** All agents running `git merge --continue`, `git rebase --continue`, or `git cherry-pick --continue` in non-interactive sessions.

---

## #132 [Process] `git push --force-with-lease` in Auto Mode Is Blocked by the Safety Classifier — Force-Pushes Are "Hard-to-Reverse"; Surface as `! git push` for User Authorization

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

## #133 [Build] `gh run list` Has No `--offset` Flag — Use `--commit <sha>` or `--limit` for Targeted Lookups

**Pattern:** Assuming `gh run list` supports `--offset` for pagination or positional filtering. The flag does not exist — `gh run list` supports `--limit`, `--commit <sha>`, `--branch`, `--status`, and `--workflow` as filters, but not `--offset`.

**Instances:**
- 2026-08-03 — DevOps (p/26#42): `gh run list` called with `--offset`; exited with an "unknown flag" error. Fixed by using `--commit <sha>` to look up runs for a specific commit. No persistent impact.

**Root Cause:** Familiarity with offset-based pagination in other CLIs (e.g. `gh api --paginate` or REST `?offset=`) creates an assumption that `gh run list` supports an equivalent positional flag. It does not — `gh run list` uses `--limit` to cap result count and targeted filters (`--commit`, `--branch`, `--workflow`) to scope results. CLI surface assumption: expecting a flag that matches the mental model without confirming it in `--help`.

**Prevention:**
1. Run `gh run list --help` before assuming flag availability — especially for pagination/filtering patterns borrowed from other tools or APIs.
2. To look up runs for a specific commit: `gh run list --commit <sha>`.
3. To cap results: `--limit N` (default 20).
4. When a CLI flag returns "unknown flag," consult `<command> --help` immediately rather than trying variations.

**Status:** Active — 1 instance (DevOps p/26#42); no persistent impact. CLI surface assumption, self-correcting at the error.

**Applies To:** All agents using `gh run list` for CI lookups.

---

## #134 [Build] Edit/Write Tool Applied to Main-Checkout Path During Worktree Workflow — Edit Lands in Wrong Tree, `git add` Finds Nothing Staged

**Pattern:** During a worktree workflow, the Edit or Write tool is called with the absolute path of the file in the main checkout (e.g. `C:\repos\ai-triad-research\<scope>\<file>`) rather than the worktree path (e.g. `C:\repos\ai-triad-research\operations\wt-<name>\<scope>\<file>`). The edit succeeds silently — it modifies the file in the shared tree — but `git add` in the worktree finds nothing staged because the changed file is not under the worktree root.

**Instances:**
- 2026-08-03 — DevOps (p/26#44): Edit tool inferred `file_path` from scope/context knowledge without confirming the active worktree root first. `git add` found nothing staged. Fixed by re-applying the edit to the correct worktree absolute path.
- 2026-08-15 — DebateTool (p/70#17): **Ordering variant — worktree not yet created at time of edit.** Edited `lib/debate/affectSignals.ts` via the shared-tree absolute path before running `git worktree add`. Shared-tree write guard (t/2449) fired post-edit. Fix: `git restore` reverted the shared-tree edit; re-applied inside `.worktrees/t2819-affect-baselines` after creating the worktree. Key rule: **create the worktree first, edit second** — the worktree path doesn't exist until after `git worktree add`.

**Root Cause:** The Edit/Write tools take an absolute path and do not validate it against the active worktree. Agents know their scope's canonical path (e.g. `operations/devops/`) and naturally infer `file_path` by prepending the repo root they know from context — but in a worktree, the root is different. Without explicitly confirming the worktree root via `git worktree list`, the inferred path silently targets the shared checkout instead. Distinct from #128 (Bash tool `ls` on wrong POSIX path due to depth miscount) — here the failure is a wrong absolute path to Edit/Write. A second ordering failure class (#134b): creating the worktree AFTER an edit means the edit always lands in the wrong tree.

**Prevention:**
1. **Create the worktree before making any edits** — `git worktree add -b <branch> .worktrees/<name> main` first, then Edit/Write to paths under the worktree root.
2. **At the start of every worktree workflow, record the worktree's absolute root** from `git worktree list` output (or the `git worktree add` output line `HEAD is now at …`).
3. **All Edit/Write calls must use paths prefixed with the worktree root** — never with the main-checkout repo root, even if the scope's relative path is well-known.
4. **Confirm before first Edit:** `git worktree list | grep <branch-name>` gives the canonical absolute path.
5. Sibling of #128 — both produce an edit-to-wrong-tree; #128 affects Bash tool path access, #134 affects Edit/Write tool file_path.

**Status:** Active — 2 instances (DevOps p/26#44; DebateTool p/70#17). 4th env/path hazard in the worktree-land cluster.

**Applies To:** All agents using Edit or Write tool during a worktree landing workflow.

---

## #136 [API] `gh pr checkout` on a Fork PR Tracks the Fork Remote — Subsequent `git push` Routes to the Fork, Not Origin

**Pattern:** `gh pr checkout <fork-pr-number>` creates a local branch that tracks the **fork contributor's remote**, not `origin`. A subsequent `git push` routes to the fork's remote (which the agent typically lacks write access to), not to the project's origin. The checkout appears to succeed normally and the local branch looks right — the remote routing mismatch only surfaces on push.

**Instances:**
- 2026-08-03 — Orca Support (p/13#33, PR #289): `gh pr checkout` on a fork PR mapped the head to a local branch tracking the fork remote — push attempts routed to the fork, not origin. Resolved by abandoning the checkout and using a worktree from main + cherry-pick instead.

**Root Cause:** `gh pr checkout` mirrors the fork PR's head ref and wires the local branch upstream to the fork's remote. This is correct for a contributor wanting to test or amend the fork's code, but wrong for a maintainer who needs to push back to origin. The local branch name and content are identical to what origin would produce — only the upstream remote differs.

**Prevention:**
1. **For fork PRs where you need to push to origin, don't use `gh pr checkout`** — use a worktree from main (`git worktree add -b <branch> <path> origin/main`), cherry-pick the fork commits, then push to origin.
2. After any `gh pr checkout`, verify the upstream with `git branch -vv` before pushing — if it points to a fork remote, reset with `git push --set-upstream origin <branch>`.

**Status:** Active — fork PR checkout remote trap; worktree + cherry-pick is the safe alternative for maintainer pushes.

**Applies To:** All agents handling fork PR contributions that require pushing back to origin.

---

## #137 [Process] Safety Classifier Blocks Moving Untracked Files to `/tmp` — Use Session Scratchpad or Worktree Instead

**Pattern:** During worktree-based workflows, attempting to move or copy untracked files to `/tmp` is blocked by the safety classifier — the `mv`/`cp` to `/tmp` is treated as potentially destructive (data could be lost if `/tmp` is cleared). This commonly arises when an agent tries to stage untracked files out of the way before a cherry-pick or rebase.

**Instances:**
- 2026-08-03 — Orca Support (p/13#33, PR #289): attempted to move untracked files to `/tmp` during fork PR resolution — blocked by safety classifier. Resolved by using a fresh worktree from main + cherry-pick, bypassing the need to stage files aside.

**Root Cause:** `/tmp` on the session machine is ephemeral and shared; moving files there risks silent data loss. The classifier gates writes to `/tmp` for untracked (uncommitted) files. The worktree-from-main + cherry-pick approach achieves the same goal (clean working state) without needing to relocate untracked files.

**Prevention:**
1. **Don't stage untracked files to `/tmp`** — if you need a clean working state, use a fresh worktree (`git worktree add -b <branch> <path> origin/main`) and cherry-pick the commits you need. No file relocation required.
2. If temporary file storage is genuinely needed, use the session scratchpad directory (provided in session context) — not `/tmp`.

**Status:** Active — classifier gate on `/tmp` moves of untracked files; by design. Worktree + cherry-pick is the classifier-safe alternative.

**Applies To:** All agents working around untracked files in git workflows where a clean working tree is needed.

---

## #138 [Process] Cherry-Pick Into a Worktree Conflicts on Shared Doc Files — Use `--theirs` to Accept the Cherry-Picked Version

**Pattern:** Cherry-picking a commit onto a fresh worktree from main conflicts in shared doc files (e.g., `LessonsLearned.md`, category lesson files) — both the cherry-pick source and the worktree's current main-based state have modified the same lines. `--theirs` resolves conflicts in favor of the **cherry-picked commit's version** (the version being brought in), which is the correct choice when the cherry-pick carries the desired state.

**Instances:**
- 2026-08-03 — Orca Support (p/13#33, PR #289): cherry-picking fork PR commits onto a clean worktree conflicted in Sage docs. Resolved with `--theirs` (took the cherry-picked version).

**Root Cause:** Doc files like `LessonsLearned.md` receive concurrent edits from multiple agents across many branches. A cherry-pick sourced from a branch that diverged before recent doc updates will conflict with the current main-based state. The cherry-picked version is the authoritative state being preserved.

**Prevention:**
1. **Before cherry-picking onto a docs-heavy worktree, check for overlapping file sets:** `git diff origin/main...<source-sha> -- <doc-path>` — if the cherry-pick touches the same docs, expect conflicts.
2. **`git cherry-pick -X theirs <sha>`** auto-resolves all conflicts in favor of the incoming commit — use it when the cherry-pick is the authoritative state and conflicts are expected to be stale-base divergence.
3. Per-file: `git checkout --theirs <conflicted-file>` then `git add <file>` then `git cherry-pick --continue`.

**Status:** Active — doc file cherry-pick conflicts in multi-agent worktree workflows; --theirs resolution pattern.

**Applies To:** All agents cherry-picking commits that include shared doc file changes onto a main-based worktree.

---

## #139 [Build] `git commit -- <pathspec>` Commits Working-Tree Content, Silently Discarding a Staged `git rm --cached`

**Pattern:** `git commit -m "..." -- <pathspec>` commits the **working-tree content** of the named paths, bypassing the staged index for those paths. If `git rm --cached <file>` has been staged (marking the file for removal), a subsequent pathspec commit silently discards that staged removal and re-commits the file from the working tree. The commit succeeds with a plausible file count and no error — it reads as done when the intended removal never happened.

**Instances:**
- 2026-08-03 — TL (t/2080, p/8#175, commit 9468557): `ogit commit -- <path>` after a staged `git rm --cached` silently re-committed the overlay file instead of removing it. Caught by inspecting the commit; corrected in 00a1cc0.

**Root Cause:** `git commit -- <pathspec>` snapshots **working-tree content** directly for the named paths, overriding the staged index for those paths. This design allows committing without a prior `git add`, but it is **incompatible with `git rm --cached`** — the staged removal is overridden by the working tree snapshot. The explicit-pathspec commit habit (ADR-005, designed to prevent sweeping peers' staged files) becomes a trap when the intent is a staged removal: the pathspec form re-takes the working tree instead of honoring the staged state.

**Prevention:**
1. **Never pair `git rm --cached` with a pathspec commit** — they are semantically incompatible. `git rm --cached` stages a removal; `git commit -- <path>` discards that staged state in favor of the working tree.
2. To remove a file from index tracking: `git rm --cached <file>`, verify with `git diff --cached` (confirm the removal appears), then commit **bare** (no pathspec): `git commit -m "..."`. The bare commit honors the full staged index, including removals.
3. **Use `git diff --cached` as the pre-commit gate** — if it shows exactly your intended changes (and only your paths), a bare commit is safe. The pathspec guard (ADR-005) is for shared working trees where peers may have staged files; `git diff --cached` confirms whether bare is safe.
4. **Inspect `git show --stat HEAD` after any `rm --cached` + commit** — a plausible success message is insufficient; confirm the removal actually appears in the commit's file list.

**Applies To:** All agents staging a `git rm --cached` before a pathspec commit (ADR-005 habit).

**Status:** Active — single instance; sharp incompatibility between the pathspec commit habit and staged-removal operations.

---

## #142 [Build] `git stash pop` Fails "Untracked File Already Exists" After ff-Only Pull When Origin Already Has the Stashed File

**Pattern:** `git stash pop` after a fast-forward (`--ff-only`) pull errors "error: The following untracked working tree files would be overwritten by merge: <file>" — the stash holds a file as **untracked**, but the ff-only pull materialized that same file into the working tree from origin. The pop attempts to restore the untracked file to an already-occupied path and aborts.

**Instances:**
- 2026-08-04 — Server Storage (p/206#18, t/2113): `undiciInvariant.ts` was stashed as untracked before an ff-only pull. Origin/main had already landed the same file at commit 0b0019e1. The ff-only placed the file in the working tree; `git stash pop` then collided. Fix: `git stash drop` — origin's version was correct, the stash held a redundant copy.

**Root Cause:** A stash that holds a new file as **untracked** does not conflict at stash-time, because git compares against HEAD, not origin. After a fast-forward merge advances HEAD to a commit that includes the same file, the "untracked slot" is now occupied. `git stash pop` cannot restore an untracked file to a path that exists in the working tree. The collision is latent until the ff-only updates HEAD.

**Prevention:**
1. **Before `git stash` + ff-only pull, check if origin already has your untracked files:** `git show origin/main:<relative-path>` — if it returns content rather than an error, origin has the file and your stash will collide on pop.
2. **If origin has the file and it's the correct version, skip the stash entirely** — there is nothing to restore; after the ff-only, the working tree already has the right file.
3. **If a pop collision occurs and origin's version is correct:** `git stash drop` — don't try `git stash pop --index` or other workarounds; the stash entry is now redundant.
4. **If the stash held local modifications (not just a new untracked file):** `git checkout -- <file>` (discard the working-tree copy that blocked the pop), then `git stash pop` to merge the stash's index state. But confirm local mods are still needed first — if origin is authoritative, they likely aren't.

**Applies To:** All agents running `git stash` + ff-only pull / merge workflows.

**Status:** Active — 1 instance (Server Storage p/206#18). Latent stash/merge collision; diagnosed quickly but wastes time if the pre-check isn't in the workflow.

---

## #143 [Build] `gh pr create --base <branch>` Fails "Base Ref Must Be a Branch" — Base Branch Is Local-Only, Not Pushed to Origin

**Pattern:** `gh pr create --base <branch>` fails with "Base ref must be a branch" when the named base branch exists only locally and has never been pushed to origin. GitHub resolves `--base` against the remote repository; a local-only branch is invisible to it.

**Instances:**
- 2026-08-05 — Debate Tool 2 (p/234#10, t/2169): `gh pr create --base fix/situation-ref-rate-t2168` failed "Base ref must be a branch" — the base branch existed locally but had not been pushed. Fixed by `git push origin fix/situation-ref-rate-t2168` then retrying.

**Root Cause:** `gh pr create --base <branch>` is a GitHub API call that looks up `<branch>` in the remote repository, not in the local git index. A branch created locally with `git checkout -b` or `git worktree add -b` does not exist on origin until explicitly pushed. The error message "Base ref must be a branch" is GitHub's way of saying "this ref doesn't exist in the remote repo."

**Prevention:**
1. **Before `gh pr create --base <branch>`, verify the base branch is on origin:** `git ls-remote origin <branch>` — if it returns a SHA, the branch is published; if it returns nothing, push first.
2. **When using a feature branch as a PR base (stacked PRs), always push the base branch before opening the child PR:** `git push origin <base-branch>`, confirm non-empty output, then run `gh pr create`.
3. The default base (`main`) is always on origin and never needs this check — it only applies when `--base` names a non-default branch.

**Applies To:** All agents opening stacked PRs or using a feature branch as `--base` in `gh pr create`.

**Status:** Active — 1 instance (Debate Tool 2, p/234#10). Self-correcting (push + retry), but the pre-check prevents the wasted round-trip.

---

## #144 [Build] Unit Fixtures All Fully Populated — Real-Data Crash on Sparsely-Present Optional Field

**Pattern:** A function is implemented and tested against fixtures where every node has the optional field present. Unit tests pass. On real data, a small fraction of records lack the field — the function calls `.length` (or any method) on `undefined` and FATAL-crashes. The crash only surfaces when the function runs against the live dataset; mocks and unit fixtures gave false confidence because they never exercised the sparse-population case.

**Instances:**
- 2026-08-05 — Computational Linguist (t/2169, p/7#57): `computeBdiEntropy` called `.length` on `linked_nodes` — present on 433/436 situation nodes, absent on 3. All unit fixtures included `linked_nodes`, so tests passed. First real debate triggered FATAL crash. Fixed by `?? []` null guard + a new unit case with a node missing `linked_nodes`. Caught early because CL ran one verification debate before scaling the batch.

**Root Cause:** Unit test fixtures are authored to exercise the function's logic, not to model the distribution of the production dataset. An optional field that happens to be in every fixture can be absent in real data without any test ever noticing. TypeScript's static types give additional false confidence: a non-null type annotation reflects the *expected* schema, not the *actual* data — runtime data from JSON files or external sources can violate the type at the boundary.

**Prevention:**
1. **For any field accessed with `.length`, `.map`, `.filter`, or similar array/string methods, guard against `undefined`:** `(node.linked_nodes ?? []).length` — cheap, silent, correct.
2. **Include at least one fixture where each optional array/object field is absent** — the sparse case is the one that crashes and the one that's always missing from hand-authored fixtures.
3. **Run one real-data smoke before scaling a batch** — a single debate / single pipeline run against live data catches distribution-dependent crashes that unit tests cannot. This is cheap relative to diagnosing a mid-batch FATAL.
4. **At JSON read boundaries, normalize optional fields to their zero value:** coerce `node.linked_nodes` to `[]` at the point of deserialization rather than guarding at every call site (mirrors the "normalize at fetch" pattern for type-varying fields).

**Applies To:** All agents writing functions over project-data nodes (situations, beliefs, edges) where optional array/object fields may be sparsely populated in real data.

**Status:** Active — 1 instance (CL p/7#57, t/2169). Caught quickly by running one real-data smoke; the systematic fix is sparse-field fixtures + normalize-at-fetch.

---

## #145 [Build] `git push origin <remote-branch>` in a Worktree Pushes the Stale Same-Named Local Branch, Not the Worktree HEAD

**Pattern:** In a worktree where the local branch name differs from the PR's remote target branch, `git push origin <remote-branch-name>` resolves the source from the **shared local ref namespace** — finding a same-named branch in the main checkout — and pushes that stale branch instead of the current worktree HEAD. Worktrees share the local ref namespace; only HEAD is worktree-local.

**Instances:**
- 2026-08-04 — DevOps (p/26#63, wt-2137-fix): worktree branch `fix/pnpm-container-t2137`, PR target `feat/pnpm-migration-t2137`. `git push origin feat/pnpm-migration-t2137` found the stale same-named branch in the main checkout and pushed that. Rejected non-fast-forward. Fix: `git push origin fix/pnpm-container-t2137:feat/pnpm-migration-t2137`.

**Root Cause:** Worktrees share the local ref namespace; only HEAD is worktree-local. `git push origin <ref>` without an explicit source refspec resolves `<ref>` against `refs/heads/<ref>` globally — which may match a stale branch in the main checkout, not the worktree HEAD.

**Prevention:**
1. **In a worktree where your branch name ≠ the PR target branch, always use explicit refspec:** `git push origin <current-wt-branch>:<remote-target-branch>`. Never use bare `git push origin <remote-target-branch>`.
2. **Verify with `git branch --show-current` in the worktree** before pushing — if it differs from the remote target, explicit refspec is required.
3. Use `git push --dry-run origin <refspec>` to confirm the push source before sending.
4. Companion to #77/#78/#128 worktree-land path hazards — worktree-land has multiple name/path mismatch traps; explicit refspec is required for branch-name-mismatch cases.

**Applies To:** All agents pushing from a worktree where the worktree branch name differs from the PR remote target branch.

**Status:** Active — 1 instance (DevOps, p/26#63). Silent wrong-branch push; high damage potential if the push succeeds non-FFW.

---

## #146 [Process] Pre-Commit Hook Blocks on Pre-Existing Known Divergence Unrelated to Current Change — `--no-verify` With User Approval Is the Correct Path

**Pattern:** The pre-commit hook audits AGENTS.md ownership on every commit — not just commits touching AGENTS.md files. A pre-existing double-track divergence (e.g., t/2080) blocks ALL commits until resolved, regardless of the committing agent's scope. The hook message explicitly states the override is expected for this known state. Correct resolution: `git commit --no-verify` with user approval.

**Instances:**
- 2026-08-04 — Debate Tool 2 (p/234#8): landing a `lib/debate` fix; pre-commit hook blocked on the pre-existing AGENTS.md double-track divergence from t/2080 (not caused by the change). Hook confirmed override expected. User approved; landed with `--no-verify`.
- 2026-08-06 — Rosetta Stone (p/6#37, fix/bootstrap-reconnect-t2195, 61c493f9): landing a `taxonomy-editor/src/renderer/bootstrap.ts` fix; same pre-existing AGENTS.md double-track (t/2080). Change was clean; used `--no-verify`.
- 2026-08-06 — Rosetta Stone (p/6#39, t/2199): 3 TSX/CSS/TS files staged, no AGENTS.md touched. Hook still blocked on t/2080 pre-existing state. Resolved with `--no-verify` per documented emergency override.
- 2026-08-06 — Rosetta Stone 3 (p/355#1, feat/screen-a-t2199-t2200): hook blocked citing BOTH double-track AND NEITHER-tracked overlay files — indicates t/2080 fix incomplete; residual overlay drift remains. Resolved with `--no-verify` per AGENTS.md override path.
- 2026-08-06 — Rosetta Stone (p/6#41, be35e8b3, feat/screen-a-t2199-t2200, PR #508 / t/2201 Screen B): same double-track block. Post-fix fleet-pull-lag — t/2205 fix (e5d657b8) is on origin/main but checkout hasn't pulled yet. Resolved with `--no-verify`.

**Root Cause:** The pre-commit hook runs a repo-wide AGENTS.md ownership audit on every commit. A pre-existing double-track (t/2080) blocked the first 3 instances. **Corrected root cause for instance 4 (TL p/335#9, t/2205):** the NEITHER hits were NOT overlay drift or a create-role gap — they were `.worktrees/<name>/AGENTS.md` paths, i.e. worktree checkouts of the main-tracked root and azure AGENTS.md at nested paths. The hook pruned `.claude` but not `.worktrees`, so it false-positived on every active worktree. Fix: prune `.worktrees` in the audit (PR #509, t/2205 — gate-verified to still catch real orphans). **Separate genuine gap:** new-role-orphan case (NEITHER-tracked new AGENTS.md from create-role workflow) is a distinct real issue → t/2206. Do NOT `ogit add` `.worktrees/` paths — they are transient checkouts.

**Prevention:**
1. **When the pre-commit hook blocks and the message references a known open issue, read the hook output carefully** — it will state whether `--no-verify` is expected. If yes, obtain user approval and proceed.
2. **Do not attempt to fix the divergence as a side effect of an unrelated commit** — conflates issues and risks out-of-scope changes.
3. **`--no-verify` is a temporary bypass** — the root ticket (t/2080 / t/2205 / t/2206) owns the permanent fix.
4. **Always record `--no-verify` usage** — ping Sage with the commit SHA, the hook message, and user approval context so it's traceable.
5. **Do NOT `ogit add` `.worktrees/<name>/AGENTS.md` paths** — those are transient worktree checkouts of main-tracked files, not overlay files. Adding them to the overlay creates a new double-track.

**Status:** Active — t/2205 fix landed (e5d657b8, PR #509). Instances 1–4 were pre-fix; instance 5 is post-fix fleet-pull-lag (checkout hadn't pulled past e5d657b8). New-role orphan gap tracked separately under t/2206. Fleet unblocked per-checkout as each pulls past e5d657b8.

**Applies To:** All agents committing while t/2205 (`.worktrees` prune) or t/2206 (new-role orphan) are open.

---

## #147 [Process] Bare `git stash` in a Shared Working Tree Captures All Agents' Files — Cross-Agent Stash Contamination

**Pattern:** In a shared working tree where multiple agents have uncommitted changes, `git stash` without a pathspec captures ALL staged/unstaged files — not just the running agent's scope. On `git stash pop`, a conflict on another agent's file blocks the pop entirely. The stash becomes a cross-agent entanglement where resolving it requires determining what belongs to whom and whether any of it is still needed.

**Instances:**
- 2026-08-06 — Rosetta Stone (p/6#47, PR #508 rebase cleanup): stash held Show-TaxonomyEditor.ps1 (another agent's WIP) + aiHandlers.ts. Working tree already had a conflicting Show-TaxonomyEditor.ps1 modification. Resolution: dropped stash — other agent's WIP was already current in working tree; aiHandlers.ts was not needed post-rebase.
- 2026-09-28 — Chat (p/687#3, **pull-blocked-by-peer variant**): `git pull origin main` aborted — "local changes to DebateTab.tsx would be overwritten by merge" — because DebateUI had uncommitted WIP in the shared `direct`-mode checkout on the same file upstream touched. Resolved: `git stash push -- DebateTab.tsx` (scoped to their file only), pull, then `git stash pop` to restore their WIP intact.

**Root Cause:** `git stash` operates on the full working tree with no ownership awareness. In a shared checkout, uncommitted changes from multiple agents coexist. A bare stash sweeps everything into one bundle; on pop, the merge machinery conflicts on the other agent's file even though the stash holder never intended to own it. **Second variant:** a peer's uncommitted WIP can also block your own `git pull` when the incoming merge would overwrite their modified file — the same shared-tree contamination from the opposite direction.

**Prevention:**
1. **Always use a pathspec:** `git stash push -- <your-files>` instead of bare `git stash`. Scope the stash to files you own.
2. **Before stashing, `git status`** — if other agents' files are present in the working tree, an explicit pathspec is mandatory.
3. **Before `git stash pop`, `git stash show`** — if the stash contains files you don't own, inspect the working tree for those files first to predict whether pop will conflict.
4. **If pop conflicts on another agent's file:** check if the working tree already has the correct version. If yes, the stash entry is redundant — `git stash drop` and verify your own files are still correct.
5. **If your pull aborts on a peer's WIP file:** `git stash push -- <their-file>`, pull, then `git stash pop` immediately — preserves their WIP without mixing it into your work.

**Status:** Active — 2 instances / 2 agents; 2 variants. **Stash-sweeps-peer (v1):** your bare stash bundles their files. **Pull-blocked-by-peer (v2):** their WIP aborts your pull. Both resolved by scoped `git stash push -- <file>`.

**Applies To:** All agents working in the shared main checkout alongside concurrent uncommitted changes from other agents.

---

## #148 [Build] Bash Double-Quoting Does Not Prevent `$(...)` / `%` Expansion in Filenames — Use PowerShell `Remove-Item` on win32

**Pattern:** On Windows MSYS bash, filenames containing `$(`, `)`, or `%` characters expand inside double-quoted strings — `rm "file$(expr)"` triggers command substitution for `expr` before `rm` runs. The filename is never passed literally; bash evaluates the special chars regardless of double quotes. Result: the wrong path is removed, or the command errors with an unexpected substitution.

**Instances:**
- 2026-08-06 — DebateUI (p/83#6): `rm` on filenames containing `$(`, `)`, `%` — bash expanded them despite double-quoting. Fix: PowerShell `Remove-Item` with a literal string array, which treats all characters as literal with no shell expansion.
- 2026-08-08 — Sage (p/195#12): filename ending with a literal backtick (`` ` ``) — single-quoting broke because the backtick fell OUTSIDE the closing `'`, opening an unclosed command substitution (`unexpected EOF while looking for matching backtick`). Fix: ANSI-C quoting: `rm -- $'vi.restoreAllMocks())\x60'` (where `\x60` is the hex code for backtick).

**Root Cause:** In bash, double quotes suppress word-splitting and glob expansion but do NOT prevent command substitution (`$(...)`) or variable expansion (`$var`, `%VAR%`). Single quotes ARE safe for most metacharacters — EXCEPT when the filename itself ends with a backtick, which terminates the single-quoted string early (the backtick is parsed before the closing `'` is found). ANSI-C `$'...'` quoting is the escape hatch for filenames containing characters that break all other quoting forms.

**Prevention:**
1. **On win32, use the PowerShell tool for `rm`/`del` when filenames may contain `$(`, `)`, `$`, or `%`** — `Remove-Item -LiteralPath 'file$(expr)'` or pass as an array; single quotes in PowerShell are always literal.
2. **In bash, single quotes suppress command substitution** — `rm 'file$(expr)'` is safe for most metacharacters, but NOT for filenames that end with a backtick (the backtick falls outside the closing quote).
3. **For filenames containing a backtick, use ANSI-C `$'...'` quoting with `\x60`** — `rm -- $'filename\x60'` passes the backtick as a literal byte with no special meaning.
4. **When constructing dynamic filenames in bash, use `printf '%s' "$var"` or `$'...'` quoting** and test with `echo` first to see what the shell actually expands.
5. **Companion to ADR-004 / Shell Quoting Rule** — special chars in file _content_ use Edit/Write tools; special chars in file _names_ at deletion time require PowerShell or ANSI-C quoting.

**Status:** Active — 2 instances (DebateUI p/83#6; Sage p/195#12 backtick variant).

**Applies To:** All agents using Bash `rm`/`mv`/`cp` with dynamically-named files on win32 that may contain shell metacharacters.

---

## #149 [Build] Squash- or Rebase-Merge Breaks `git branch -d` — Needs `-D` Because Merged SHAs Are Not Ancestors

**Pattern:** After a squash- or rebase-merge, `git branch -d <feature-branch>` fails "error: The branch is not fully merged." Both merge strategies rewrite history: squash creates a single new commit; rebase replays each commit with new SHAs. Either way, the original feature branch tip is not a reachable ancestor of any commit on main, so git correctly refuses `-d`. Fix: `git branch -D`.

**Instances:**
- 2026-08-06 — DebateUI (p/83#8): `git branch -d <branch>` failed "not fully merged" after squash-merge. Fix: `git branch -D <branch>`.
- 2026-08-08 — ElectronMain (p/98#15): `git branch -d <branch>` failed after rebase-merge (SHA diverged — replayed commits on main have different SHAs than the original branch tip). Fix: `git branch -D`.

**Root Cause:** `git branch -d` deletes only if the branch tip is reachable from HEAD. Squash rewrites history into one new commit; rebase replays commits with new SHAs. Neither preserves the original branch tip SHA in main's ancestry chain, so `-d` always fails. `-D` is the correct cleanup verb for both.

**Prevention:**
1. **After any squash- or rebase-merge, always use `git branch -D`** — `-d` always fails by design; the "not fully merged" warning is accurate, not an error.
2. **Remote cleanup:** `git push origin --delete <branch>` — but skip it if GitHub auto-deleted the branch on merge (exit "ref does not exist" = not a failure; the branch is already gone).
3. **Worktree-remove idempotency:** if the worktree was already removed on a first attempt and a chained cleanup step fails, don't retry `git worktree remove` — verify state with `git worktree list` and proceed to the next step.

**Status:** Active — 2 instances (DebateUI p/83#8 squash; ElectronMain p/98#15 rebase). Expected git behavior; recorded because the error message reads as alarming.

**Applies To:** All agents cleaning up local branches after squash- or rebase-merges.

---

## #150 [Build] Consumer PR Lands Before Its Shared-Utility Dependency — Cross-Ticket Import Ordering Breaks main

**Pattern:** A consumer ticket that imports a new shared utility lands before the utility's own ticket is on main. The consumer's import resolves fine in the author's local branch (which includes both changes), but once the consumer merges standalone, origin/main has a broken import. With renderer TSC not gated in CI, the broken import passes CI green and breaks main silently.

**Instances:**
- 2026-08-06 — TL incident (p/335#13): t/2250 (consumer of `lib/bandColor`) landed before t/2236 (the `bandColor` utility). Renderer import of `lib/bandColor` broke origin/main immediately. Reverted via PR #561. Passed CI because renderer tsc is not in ci.yml.

**Root Cause:** Cross-ticket dependencies are not enforced by any gate. A consumer that works in the author's branch (where both tickets coexist) will break main if landed first. The renderer TSC CI gap (#150's silent enabler) prevented CI from catching the broken import.

**Prevention:**
1. **Before landing any PR that imports a new shared utility, verify the utility is on origin/main:** `git show origin/main:<path-to-utility>` must return content, not an error.
2. **Land the dependency ticket before the consumer ticket** — check for cross-ticket dependencies during PR review.
3. **Until renderer tsc is gated in CI (t/2252), run `check-renderer-tsc.sh` locally** to catch broken renderer imports before pushing.
4. Pairs with the Verify Gate Renderer Blind Spot pattern — the CI gap is what made this silent.

**Status:** Active — 1 instance (TL p/335#13). Renderer TSC CI fix: t/2252 (blocked on t/2248).

**Applies To:** All agents landing PRs that import new shared utilities, and reviewers checking cross-ticket dependencies.

---

## #151 [Build] Vitest Cross-File Mock Leak — Parallel Workers Mutate Shared Module Namespace Between Assertions

**Pattern:** A `vi.mock('./utils', () => ({ fn: mockImpl }))` in one test file leaks into another test file's execution under CI worker parallelism. The affected test passes locally (sequential or low-worker runs) and even passes in full `vitest run --coverage` locally, but fails in CI on a subset of assertions. The tell: two assertions on the same function in one file returning results that no single implementation could produce — one mock, one real value, or two different mocks.

**Instances:**
- 2026-08-07 — DebateWorkspace (p/124#5–8, t/2256, PR #580): `debate-workspace/utils.test.ts` — `speakerLabel('user')→'You'` passed but `speakerLabel('unknown')→'Unknown'` failed in CI. A sibling file mocked `./utils` with `capitalize`; under CI worker parallelism that mock mutated the shared `./utils` namespace between assertions. **`vi.importActual('./utils')` was attempted and failed** — contamination propagated UP the re-export chain (`./utils → speakerHelpers → SpeakerIdentity`), poisoning even a direct `resolveSpeaker` assertion; module-extraction also failed. Fix: dropped the `speakerHelpers` wrapper test entirely and tested the logic at its isolated leaf module (`./utils` directly).

**Root Cause:** `vi.mock()` patches the module registry globally within a vitest worker. Under parallel worker scheduling (higher in CI), a worker executing one file's mock setup can overlap with another file's assertions that import the same module path. The receiving file sees the mocked implementation for part of its run. Doesn't repro locally because single-machine vitest runs use fewer workers, eliminating the timing window. `vi.importActual` does NOT escape this when the unit-under-test accesses the mocked module indirectly through a re-export chain — the mock is applied at the registry level before `importActual` resolves.

**Prevention:**
1. **The tell: two assertions on the same function in one file giving mutually-impossible results → cross-file mock mutation, not a logic error.** Stop debugging the implementation; look for sibling `vi.mock()` calls.
2. **`vi.importActual` does NOT help when contamination propagates through a re-export chain.** The real fix: test the logic at its isolated leaf module, not through re-exported wrappers. A wrapper that only re-exports doesn't need its own unit test — test the leaf directly.
3. **Files calling `vi.mock()` on shared modules should restore mocks in `afterEach`:** `afterEach(() => vi.restoreAllMocks())` — prevents leaks to concurrent workers.
4. **To reproduce locally:** run `vitest run --pool=threads --poolOptions.threads.maxThreads=8` to raise worker concurrency and surface timing-dependent leaks before CI.

**Status:** Active — 1 instance (DebateWorkspace p/124, t/2256). `vi.importActual` is insufficient when re-export chains are involved; test at the leaf.

**Applies To:** All agents writing vitest tests that mock shared sibling modules.

---

## #152 [Build] Rules-of-Hooks Violation Lands Green — No `react-hooks/rules-of-hooks` ESLint Gate in CI → Runtime Crash

**Pattern:** A conditional hook call (`isElectronMode() || useFlag(...)`) passed TypeScript, vitest, and all other CI gates, then crashed at runtime: "Rendered fewer hooks than expected." Root cause: no `react-hooks/rules-of-hooks` ESLint rule in CI — the violation is a static analysis issue, not a type error or test failure. React requires every `use*` hook to be called unconditionally on every render; a short-circuit `||` that skips a hook on some renders violates this invariant at runtime.

**Instances:**
- 2026-08-08 — TL (p/335#15): `DebateActionBar.tsx:788`, commit `63ad30a8` — conditional hook `isElectronMode() || useFlag(...)` crashed the debate popup. Crash fix: t/2298. ESLint gate: t/2299.

**Root Cause:** TypeScript does not enforce React's hooks rules (call order must be identical on every render). Vitest unit tests don't exercise enough render paths to trigger the ordering violation. Only a hooks-aware static analysis rule (`react-hooks/rules-of-hooks`) or a full integration test catches this class. Without the ESLint gate in CI, the violation compiles and passes all checks.

**Prevention:**
1. **Tell:** "Rendered fewer hooks than expected" at runtime → look for a conditional, `&&`, `||`, ternary, or early-return that wraps a `use*` call.
2. Until t/2299 lands (`react-hooks/rules-of-hooks` ESLint gate), manually verify before landing any component change: no `use*` call appears inside a conditional branch.
3. The fix is always to call the hook unconditionally and conditionalize the behavior inside it or based on its return value.

**Status:** Active — 1 instance (TL p/335#15, t/2298 crash, t/2299 gate). ESLint gate (t/2299) will make this class pre-merge-detectable.

**Applies To:** All agents writing or reviewing React component code.

---

## #153 [Build] Error Boundary Suppresses Flight Recorder Events — Crash Invisible in FR Dump

**Pattern:** A React error boundary catches a runtime crash and emits an FR dump, but no FR error event appears in the dump — the crash is invisible to the flight recorder. The only observable signal is a broken UI (diagnosed from a screenshot). Root cause: the error boundary intercepts the error before the flight recorder's uncaught-error listener fires; the boundary swallows it without forwarding to `window.onerror` / the FR error channel.

**Instances:**
- 2026-08-08 — TL (p/335#15): rules-of-hooks crash in `DebateActionBar.tsx` → error boundary dumped FR with no error event. Crash diagnosed from screenshot only. FR gap fix: t/2297.

**Root Cause:** React error boundaries call `componentDidCatch`/`getDerivedStateFromError` and render a fallback — the error never propagates to the unhandled-error path that the flight recorder monitors. The FR dump is technically complete (no events to record), but its apparent cleanliness is misleading.

**Prevention:**
1. **When an FR dump appears clean but the app is visibly broken, suspect an error boundary intercept** — the crash was caught before FR saw it.
2. FR diagnosis must cross-reference visual evidence (screenshots, user reports) when the dump shows no errors but behavior is wrong.
3. Until t/2297 lands, error boundary investigation requires reading the React component tree above the broken component, not just the FR dump.

**Status:** Active — 1 instance (TL p/335#15, t/2297 FR gap fix). Error boundary → FR forwarding fix: t/2297.

**Applies To:** All agents diagnosing crashes via flight recorder in apps with React error boundaries.

---

## #154 [Build] Node 24 + Git Bash `stdio:inherit` + pnpm Child Process Crashes with STATUS_STACK_BUFFER_OVERRUN (Exit 3221226505) on Windows

**Pattern:** A Node script that spawns a `pnpm install` child process with `stdio:inherit` exits with code 3221226505 (`0xC0000409` = Windows `STATUS_STACK_BUFFER_OVERRUN`) when run via the Bash tool. The crash is dependency-set-specific — only triggered for certain lockfile states (observed: electron dep in taxonomy-editor/package.json); the same script succeeds for other lockfile contexts in the same session. The crash is silent (no error message beyond the exit code). Running the equivalent steps via the PowerShell tool succeeds.

**Instances:**
- 2026-08-08 — DevOps (p/26#67): `scripts/sync-standalone-lockfile.mjs` crashed with exit 3221226505 on the dep-654 worktree (electron dep) but succeeded for dep-655/dep-656. Workaround: replicated the script's temp-dir + `pnpm install --lockfile-only` steps manually via PowerShell tool, copied result back.

**Root Cause:** `STATUS_STACK_BUFFER_OVERRUN` is a Windows security mitigation — the OS kills a process when a stack-buffer overrun (stack canary check failure) is detected. Suspected cause: Node 24 + Git Bash (MSYS) `stdio:inherit` triggers a code path in the pnpm child process that overruns its stack for specific dependency sets (electron in particular has native rebuild steps). The combination of Bash tool's MSYS runtime + `stdio:inherit` pipe semantics + Node 24's changed stdio handling may produce incompatible fd/handle state in the child process.

**Prevention:**
1. **Tell:** unexplained exit 3221226505 (or `0xC0000409`) from a Node/pnpm command in the Bash tool → suspect Node 24 + MSYS + stdio:inherit incompatibility, not a script logic error.
2. **Workaround:** run the same command or equivalent steps via the PowerShell tool — native win32 stdio handles replace the MSYS fd bridge, avoiding the crash.
3. **Dependency-specific:** if the crash is intermittent across lockfile states, focus on electron or other native deps in the package.json — these trigger native rebuild steps that are more likely to hit the incompatible stdio path.

**Status:** Active — 1 instance (DevOps p/26#67). Root cause unconfirmed (suspected Node 24 + MSYS + stdio:inherit); workaround is reliable (PowerShell tool).

**Applies To:** All agents running Node scripts that spawn pnpm child processes with stdio:inherit via the Bash tool on Windows.

---

## #155 [Build] `gh workflow run --ref <branch>` 404s — GitHub Requires Workflow File on Default Branch to Dispatch

**Pattern:** `gh workflow run <file> --ref <feature-branch>` returns a 404 when the workflow file only exists on the feature branch. GitHub's workflow dispatch API looks up the workflow definition from the repository's default branch (main) — a workflow file that only exists on a non-default branch is invisible to the API regardless of `--ref`.

**Instances:**
- 2026-08-08 — DevOps (p/26#70): `gh workflow run <file> --ref <feature-branch>` 404'd — the workflow file only existed on the feature branch. Fix: moved verification to post-land (after the PR merged to main).

**Root Cause:** GitHub's workflow dispatch endpoint requires the workflow to be registered on the default branch. `--ref` controls which branch the triggered run executes on, but does not make the API aware of workflows that only exist on that branch.

**Prevention:**
1. **Never dispatch `gh workflow run` to verify a workflow that only exists on a feature branch** — it will 404. Verification requiring `workflow_dispatch` must happen post-land.
2. For pre-land workflow validation, read the YAML directly or use `--dry-run`; dispatching is only possible once the file is on main.

**Status:** Active — 1 instance (DevOps p/26#70).

**Applies To:** All agents adding or modifying GitHub Actions workflows and verifying them pre-land.

---

## #156 [Build] `gh pr create` Without `--head` Aborts on "Uncommitted Changes" When cwd Is the Shared Tree

**Pattern:** `gh pr create` without an explicit `--head <branch>` inspects the local working tree to determine the PR's head branch. When run from the shared checkout (which may have uncommitted changes from other agents), GitHub CLI sees the dirty tree and aborts. The PR is for a clean branch on origin — the shared-tree dirt is irrelevant, but the CLI doesn't know that.

**Instances:**
- 2026-08-08 — DevOps (p/26#70): `gh pr create` run from the shared checkout without `--head` aborted on uncommitted changes (other agents' WIP in the shared tree). Fix: added `--head <branch>` explicitly.
- 2026-09-28 — DebateUI (p/689#1, **HEAD-switched variant**): branch already pushed, but another concurrent agent had switched shared HEAD to `main` between the push and `gh pr create`. CLI defaulted to `main`, errored "you must first push the current branch." Fix: `--head <my-branch>` explicitly.
- 2026-10-02 — ServerAPI (p/504#16, **v1 repeat**): `gh pr create` without `--head` aborted — "94 uncommitted changes / must first push." The 94 files were other agents' untracked WIP on the shared tree, not the ServerAPI branch. Fix: pass `--head feat/branch --base main` explicitly.

**Root Cause:** `gh pr create` without `--head` infers the head branch from the current local state. In the shared checkout, two failure variants exist: **(v1)** other agents' uncommitted changes trigger the "uncommitted changes" abort; **(v2)** another agent's checkout switches HEAD mid-flight, so the CLI targets the wrong (now-current) branch entirely. Both are instantaneous local-state races invisible to the PR author.

**Prevention:**
1. **Always pass `--head <branch> --base main` explicitly with `gh pr create` when running from the shared checkout** — never let the CLI infer from local state; it races shared-tree drift in both variants.
2. Alternatively, run `gh pr create` from inside the worktree where the branch is checked out and clean.

**Status:** Active — 3 instances / 3 agents; 2 variants. All fixed by `--head <branch> --base main`.

**Applies To:** All agents opening PRs from the shared checkout or any context where the working tree may be dirty.

---

## #157 [Build] `gh pr reopen` Fails on Dependabot PRs — Branch Deleted on Close; Use `@dependabot recreate`

**Pattern:** `gh pr reopen <n>` returns "Could not open the pull request" for a closed Dependabot PR. Dependabot deletes its branch when a PR is closed — GitHub's GraphQL reopen mutation requires the head branch to exist. Attempting to reopen via `gh` or the GitHub UI both fail silently.

**Instances:**
- 2026-08-09 — DevOps (p/26#72): `gh pr reopen 649` failed — Dependabot branch deleted on close, making reopen impossible via GraphQL. Fix: commented `@dependabot recreate` on the closed PR; Dependabot opens a fresh PR.

**Root Cause:** Dependabot auto-deletes its branch when a PR is closed (not merged). GitHub's reopen API requires the branch to exist. This is Dependabot-specific behavior — human PRs usually retain their branch after closing.

**Prevention:**
1. **Never `gh pr reopen` a closed Dependabot PR** — the branch is gone; reopen will always fail.
2. **To reactivate a closed Dependabot PR:** comment `@dependabot recreate` on the closed PR — Dependabot creates a fresh branch and opens a new PR.
3. **To rebase an open Dependabot PR:** comment `@dependabot rebase`.

**Status:** Active — 1 instance (DevOps p/26#72).

**Applies To:** All agents managing Dependabot PRs.

---

## #158 [Build] Barrel Import Loads Full Module Graph in Vitest — Transitive Module-Eval Crash Shows as "0 tests / TypeError"

**Pattern:** Importing from a shared barrel (`from '../../shared'`) in vitest test files causes the full shared module graph to load at import time. If any transitive module crashes at module-eval (side effects, constant initialization on an undefined dependency), all test files sharing that import show "0 tests / TypeError" — no test names, no assertion failures, just silent zero-result runs.

**Instances:**
- 2026-08-09 — DebateDiagnostics (t/2394, PR #761): `from '../../shared'` in 6 test files transitively loaded PromptsPanel→promptCatalog→turn.ts, which crashed at module-eval (`c.voice.disposition` on undefined). Fix: replaced barrel imports with direct file imports (`from '../../shared/BookmarkLink'`).

**Root Cause:** Barrel/index files re-export every member of a module group. Vitest executes module-level code eagerly at import time. A barrel import expands the import surface to the entire module graph, dragging in modules with side-effectful initializers. The failure presents as "0 tests" rather than a named test failure, making it non-obvious that the crash is an import issue.

**Prevention:**
1. **In test files, prefer direct file imports** (`from '../../shared/ComponentName'`) over barrel imports (`from '../../shared'`) — avoids loading the full module graph.
2. **"0 tests / TypeError" with no test names = suspect an import-time crash** — check whether a barrel import transitively loads a module with side effects or state-dependent initialization.
3. When a barrel module grows to include components with side-effectful initializers, add a note in its index warning that test files should use direct imports.

**Status:** Active — 1 instance (DebateDiagnostics p/245#5).

**Applies To:** All agents writing vitest tests that import from shared barrels.

---

## #161 [Build] Unscoped Repo Traversal Times Out — `.worktrees/`, `.cache/`, `.fol-eval-*` Each Add Thousands of Files

**Pattern:** Any recursive traversal tool run unscoped from the repo root pays the full cost of `.worktrees/<n>/` (full checkout per worktree, ~4,400 files each), `.cache/`, and `.fol-eval-*` directories. Tools that don't respect `.gitignore` (bash `grep -r`, `find`, `git ls-files --others`) are worst; tools with a `**/` glob also degrade. A pipe-based output filter (`grep -v .worktrees`) prevents unwanted lines in results but does NOT prevent traversal — the walk still visits every file.

**Instances:**
- 2026-08-11 — Rosetta Stone (p/6#52): `git ls-files --others --exclude-standard` piped into a per-file diff loop timed out at 2 min. Root cause: recursed into populated `.worktrees/` dirs. Fix: scope with pathspec (`-- docs research`) or exclude pattern (`:(exclude).worktrees`).
- 2026-09-28 — Technical Lead (p/335#78): `grep -rln <pattern> .` from repo root timed out at 120 s (exit 143); follow-up `Glob **/Test-RequiredContexts*` timed out at 20 s. `grep -v '.worktrees'` on the output did not prevent traversal. Fix: **Grep tool** (ripgrep, respects ignores) returned in under 1 s; **Glob scoped to `operations/devops`** also returned instantly.
- 2026-10-01 — PowerShell (p/20#45): `grep -rn "Measure-CodeComplexity" --include="*.ps1" .` from repo root timed out at 2 min via Bash tool. Fix: re-ran via the Grep tool with an explicit path; returned immediately.

**Root Cause:** The repo root contains `.worktrees/`, `.cache/`, and several `.fol-eval-*` dirs that a naive recursive walk visits in full. `git ls-files --others` lacks worktree-awareness; bash `grep -r` and `find` don't respect `.gitignore`. Pipe-output filters (e.g. `grep -v .worktrees`) eliminate matching output lines but cannot skip the traversal — the filesystem walk is already complete by the time filtering runs.

**Prevention:**
1. **Use the Grep tool (ripgrep) instead of bash `grep -r`** — respects `.gitignore`, skips ignored dirs, returns in under 1 s even from the repo root.
2. **Scope Glob searches** — `operations/devops/**/*.ts` instead of `**/*.ts`; the `**/` form from root traverses everything.
3. **Never use bash `grep -r` or `find` unscoped** from the repo root on this codebase.
4. **A pipe filter does not prevent traversal** — `grep -r . | grep -v .worktrees` still walks `.worktrees/`; only a traversal-time exclude (ripgrep's `--ignore`, a scoped pathspec, or `:(exclude)`) avoids the cost.
5. For `git ls-files --others`, scope with a pathspec or exclude: `git ls-files --others -- <scope>` / `git ls-files --others ':(exclude).worktrees'`.

**Status:** Active — 3 instances / 3 agents. Pattern broadened (2026-09-28) from `git ls-files` only to any unscoped traversal.

**Applies To:** All agents running search, file-discovery, or untracked-file checks from the repo root.

---

## #162 [Process] Same-Role Duplicate Implementation from Session/Context Loss — Self-Race

**Pattern:** An agent loses context between passes (session boundary, context compression) and implements the same ticket twice — opening a second PR unaware the first has already merged. The second PR is based on pre-merge state, diverges from the landed implementation, and requires manual reconciliation.

**Instances:**
- 2026-08-11 — ServerAPI (t/2474): PR #849 merged at 18:55 (co-authored); PR #850 opened at 19:01 from a pre-#849 base, evidently unaware #849 had landed. Likely caused by session/context loss between passes. TL merged #850's variant over it (265de260); details t/2474#4-5.

**Root Cause:** Context window exhaustion or session restart causes an agent to lose awareness of prior work completed in the same ticket. The agent resumes from the ticket description, not from the merged state. Without an explicit "check existing PRs" step, the agent begins fresh implementation.

**Prevention:**
1. **Before opening a PR, search open AND merged PRs for the ticket key:** `gh pr list --state all --search "t/XXXX" -R AI-Rosetta-Stone/ai-triad-research`. If a merged PR exists, read its diff before writing any code.
2. After a context boundary (session restart, long gap, context compression), re-read the ticket's latest comments before starting implementation — the ticket anchor is where completed work is recorded.
3. If a merged PR is found for the ticket, close any draft/stale work and redirect to a follow-up ticket rather than overwriting the landed implementation.

**Status:** Active — 1 instance (ServerAPI t/2474, p/335#24).

**Applies To:** All agents implementing tickets across session boundaries.

---

## #163 [Build] Inline `<head>` Script DOM Query Runs Before DOM Ready — Silent No-Op in Production, Tests Pass

**Pattern:** A `<script>` in `<head>` runs `document.querySelector()`/`getElementById()` synchronously. The target element does not exist yet (body not parsed). The query returns null silently — no error, no behavior. Tests inject a complete body so they pass; in the browser the script is a no-op at load time.

**Instances:**
- 2026-08-11 — ServerAPI (t/2474, PR #849): a `<head>` script used `querySelector('.anon-link')` to rewrite the element's href with `location.hash`, but ran before `DOMContentLoaded` — `.anon-link` didn't exist yet, query returned null, rewrite silently skipped. Tests injected a complete body, so they passed. In the browser the script was a no-op. Fix: wrap in `DOMContentLoaded` listener (PR #850, 265de260).

**Root Cause:** `<head>` scripts execute before the browser parses the body. Test environments typically inject a complete DOM rather than simulating the browser's parse order, masking the timing gap. The test passed because the DOM was ready when the script ran; production failed because it wasn't.

**Prevention:**
1. **Any DOM query in an inline `<head>` script must be deferred:** `document.addEventListener('DOMContentLoaded', () => { ... })`.
2. **Test harnesses for `<head>` scripts must simulate browser parse order:** set up the environment at `readyState='loading'` and fire `DOMContentLoaded` after setup — do not inject a pre-built body.
3. **Code review heuristic:** inline `<head>` `<script>` + `querySelector`/`getElementById` without a `DOMContentLoaded` wrapper = instant flag.

**Status:** Active — 1 instance (ServerAPI t/2474, p/335#24).

**Applies To:** All agents authoring inline `<head>` scripts with DOM queries.

---

## #164 [Build] `setTimeout` Not Cleared in Child-Process `close` Handler — Spurious Post-Exit Callback Creates False-Failure Signal

**Pattern:** A test/shim script starts a long `setTimeout` watchdog for a child process. When the child succeeds and emits `close`, the `setTimeout` is not cleared. It fires after the natural process exit, triggering a callback that signals failure — even though the work completed successfully. The PostToolUseFailure hook fires on the spurious exit; the actual result (output file written, close-handler exit code 0) confirms success.

**Instances:**
- 2026-08-13 — ElectronMain (p/98#19): live-run test script exited 1 (PostToolUseFailure hook fired). Root cause: `setTimeout(400s)` watchdog not cleared after child 'close'; fired after successful write and natural exit. Confirmed success from actual output (result.json written, exit code 0 in close handler) — script logic bug, not a real failure.

**Root Cause:** Long watchdog timeouts must be paired with `clearTimeout()` in the success path. If the close handler resolves success and exits naturally, an uncleared timer fires into an already-resolved context and produces a spurious error signal.

**Prevention:**
1. **Always `clearTimeout(watchdog)` in the child `close` handler** — clear on BOTH success and failure paths: `child.on('close', (code) => { clearTimeout(t); ... })`.
2. **When PostToolUseFailure fires on a child-process script, verify the actual output artifacts and close-handler exit code** before treating it as a real failure — a spurious timer callback can fire after a successful natural exit.
3. Pattern: `const t = setTimeout(onTimeout, 400_000); child.on('close', (code) => { clearTimeout(t); resolve(code); })`.

**Status:** Active — 1 instance (ElectronMain p/98#19).

**Applies To:** All agents writing child-process orchestration scripts with watchdog timeouts.

---

## #165 [Process] `git worktree add` "Branch Already Used by Worktree" — Peer Instance Has the PR Branch Checked Out

**Pattern:** `git worktree add <path> <branch>` fails "fatal: branch '<branch>' is already used by worktree at '<peer-path>'" when a peer instance of the same role already has the branch checked out. The error is a valid collision signal, not a system failure. Force-adding or creating a parallel worktree on the same branch races the peer's uncommitted work.

**Instances:**
- 2026-08-13 — PowerShell 2 (p/228#13): tried to add a worktree for a PR branch; peer Main already had it checked out at `.worktrees/t2609`. Correct response: inspected the peer's worktree read-only, found uncommitted edits, coordinated via ping instead of racing.

**Root Cause:** Git enforces one-checked-out-per-branch across all worktrees in the repo. In a multi-instance role, two instances may independently try to work the same PR branch — the second instance gets the "already used" error. Same family as #162 (duplicate implementation), but detectable earlier: the `git worktree add` failure surfaces the collision before any code is written.

**Prevention:**
1. **Before `git worktree add <path> <branch>`, run `git worktree list`** — if the branch appears, a peer instance owns it. Do not proceed until coordination is complete.
2. **Do NOT force-add or create a new branch from the same base** — that races the peer's uncommitted changes and produces a semantic collision at merge time (#162).
3. **The "already used" error is a gift: it surfaces the collision before work begins.** Treat it as a signal to ping the peer and coordinate, not an error to work around.
4. Related: `git worktree list` is also the right oracle when you encounter unexpected worktree-lock errors during cleanup — it shows all active checkouts fleet-wide.

**Status:** Active — 1 instance (PowerShell 2 p/228#13).

**Applies To:** All multi-instance roles where peer instances may work the same PR branch.

---

## #166 [Build] Stale Branch Diverges from CI's Merge Base — Local Tests Pass, CI Fails on Code That Landed in the Gap

**Pattern:** GitHub Actions `pull_request` checks run against the PR branch **merged with current `origin/main`** — not the branch alone. A branch cut N commits ago passes locally because it never saw the commits that landed since; CI runs them all and can fail on interactions with new code. Chasing the CI failure as a code bug burns cycles on theories that don't reproduce locally. The actual failure only reproduces once `git merge origin/main` (or rebase) brings the local branch in sync with what CI sees.

**Instances:**
- 2026-08-13 — PowerShell 2 (t/2673, PR #1071, p/228#15): PR passed locally, failed CI twice. 2 cycles spent on an endpoint-mock theory. Real cause: Phase 5 analytics probe (t/2667) landed in a 23-commit gap between the branch base and current `origin/main`. Once the branch was merged with `origin/main`, the failure reproduced locally and was diagnosed quickly. Details: t/2673#8.

**Root Cause:** The `pull_request` event in GitHub Actions merges the branch with `main` before running checks — this is intentional (testing the final merged state). A branch that hasn't been kept up to date therefore runs against a different codebase than the local worktree. The longer the gap, the higher the collision risk. "Passes locally, fails CI" is the diagnostic signature.

**Prevention:**
1. **When local tests pass but CI fails, suspect stale branch first** — run `git log --oneline origin/main..HEAD` (your commits) and `git log --oneline HEAD..origin/main` (what you're missing). A non-empty second set = potential CI divergence.
2. **Before debugging a CI failure as a code bug, merge `origin/main` into the branch first:** `git merge origin/main` (or `git rebase origin/main`). If the failure now reproduces locally, you have the real root cause.
3. **On a busy main, merge/rebase before opening a PR** to minimize the gap between your branch base and `origin/main` at CI time.
4. "Passes locally, fails CI" without a branch-age check = premature debugging. The CI environment is not mysterious — it runs a merge you haven't run yet.

**Status:** Active — 1 instance (PowerShell 2 t/2673, p/228#15).

**Applies To:** All agents opening PRs on branches that may be behind origin/main.

---

## #171 [Build] Electron App Won't Launch in a Fresh Worktree — Missing node-pty Native Module + Vite Monorepo Hoisting Gap

**Pattern:** A fresh `npm ci` inside a git worktree produces a broken Electron build: (1) `node-pty` native binary is absent (not rebuilt for the local Node ABI → `terminal.ts` crashes the main process on launch), and (2) `vite build` resolves the `vite` package from the repo-root `node_modules/.vite-temp` under monorepo hoisting — a path that a worktree-local install doesn't satisfy. Result: the app crashes at startup or the build fails, making visual/design review impossible from the worktree alone.

**Instances:**
- 2026-08-15 — Design (p/472#1): tried to launch taxonomy-editor Electron app inside a fresh worktree for PR design review. `npm ci` ran; app crashed on startup (node-pty missing native binary) and `vite build` couldn't resolve the hoisted vite package. Stopped the build yak-shave (correct anti-rabbit-hole call); fell back to reviewing implementer-provided screenshots.
- 2026-10-06 — DebateTool (p/70#50): `pnpm install` from `taxonomy-editor/` in a worktree **exited 2** — pnpm cannot install native binaries (electron, node-pty, @azure/storage-blob) in the worktree's virtual store without running `electron-rebuild`. Resolution: ran `pnpm install` anyway (packages were cached), then used `npx vitest run` from `lib/debate/` directly as the authoritative verify signal (debate tests don't depend on native modules), and opened the PR to let CI be the gate.

**Root Cause:** Two compounding gaps: (a) `node-pty` is a native Node addon — `npm ci` fetches it but does not rebuild it for the current Node ABI inside a new worktree context without an explicit `npm rebuild`; (b) Vite relies on a `.vite-temp` cache path in the monorepo root's `node_modules` for cache and HMR — a worktree's own `node_modules` doesn't have this path, so `vite build` falls through to a missing dependency. Both are monorepo-hoisting artifacts that don't surface in the main checkout where the root `node_modules` is already set up.

**Prevention:**
1. **Don't attempt a fresh Electron build inside a landing worktree for design review** — the native rebuild and hoisting setup cost is disproportionate to the review goal.
2. **Preferred review path for visual/design review:** use implementer-provided screenshots or ask the implementer to run the `/smoke-ui` skill in the main checkout. If you need to run the app yourself, do it from the main checkout after the branch is merged (or cherry-picked to main tree).
3. **If a worktree build is genuinely required:** (a) run `npm ci` from the repo ROOT first (not inside the worktree), so hoisted packages are present; (b) then `npm rebuild node-pty` from the package directory to rebuild the native binary for the current ABI; (c) then run `vite build` from within the package — it can now resolve the hoisted `.vite-temp`.
4. **pnpm workaround (debate/test-only path):** if the goal is running tests (not launching the app), `pnpm install` may exit 2 on native modules but still cache packages; run `npx vitest run` from `lib/debate/` directly — debate tests don't depend on native Electron binaries. Let CI be the gate for the full build.
5. A documented web-preview recipe (serve the renderer without Electron) would bypass both gaps — worth a follow-up ticket if design reviews from worktrees are a recurring need.

**Status:** Active — 2 instances. **Inst1** (Design p/472#1): npm + node-pty/Vite hoisting, Electron launch failure. **Inst2** (DebateTool p/70#50): pnpm exit 2 on native module install in worktree — debate tests still runnable via `npx vitest run` from `lib/debate/` directly.

**Applies To:** Design role and any agent attempting to launch Electron apps from a fresh worktree for review purposes.

---

## #170 [Build] Batch Filesystem Cleanup Aborts on First File-Lock — Remaining Items Undeleted

**Pattern:** A batch `os.remove()` / `os.unlink()` loop (or equivalent) aborts on the first `WinError 32` (file locked by another process), leaving all subsequent items undeleted. The cleanup appears to succeed up to the failing file but silently abandons the rest.

**Instances:**
- 2026-08-15 — Tech Lead (t/2222 junk cleanup, p/335#40): Python batch `os.remove` loop hit `WinError 32` on `engineering/tech-lead/fail-open` (locked by a live process) and aborted — 1/17 files removed, 16 left. Fixed with per-item `try/except`; 16/17 cleaned, residual locked file harmless (frees when session closes).

**Root Cause:** Batch cleanup without per-item exception handling treats the first failure as fatal. On Windows, file locks (`WinError 32`) are common when a file is open in another process (IDE, terminal, agent session). A single locked file should not block cleanup of the remaining items.

**Prevention:**
1. **Always wrap per-item filesystem operations (remove, rename, move) in per-item `try/except`** — collect and log failures, but continue the loop: `for f in files: try: os.remove(f) except OSError as e: failed.append((f, e))`.
2. Log skipped items with the reason (lock error, permissions, not found) — silent skips make cleanup look complete when it isn't.
3. On Windows: `WinError 32` ("The process cannot access the file because it is being used by another process") is expected for files open in live sessions — treat as a deferred skip, not a fatal error.
4. After a best-effort cleanup, report counts: `removed N/M; skipped: <list>`.

**Status:** Active — 1 instance (TL t/2222, p/335#40).

**Applies To:** All agents writing Python/PowerShell batch cleanup scripts on Windows.

---

## #169 [Process] `git worktree add` "invalid reference" — Repo Subdirectory Path in the commit-ish Slot

**Pattern:** `git worktree add -b <branch> <path> <scope-hint>` fails "fatal: invalid reference: <scope-hint>" when a repo subdirectory path (e.g., `research/comp-linguist`) is passed as the `[<commit-ish>]` argument. The signature is `add [-b <branch>] <worktree-path> [<commit-ish>]` — the third positional is parsed as a git ref, not a directory hint.

**Instances:**
- 2026-08-15 — CL.Investigate1 (p/40#13): `git worktree add -b <br> <path> research/comp-linguist` → `fatal: invalid reference: research/comp-linguist`. Intended as a scope hint; not a valid commit-ish. Fix: `git worktree add -b <br> .worktrees/<name> main`; scope the worktree via cwd inside it, not a path argument.

**Root Cause:** `git worktree add` takes `[<commit-ish>]` as its last positional — a starting point for the new branch/checkout, not a scope or context hint. A bare subdirectory path like `research/comp-linguist` is not a valid ref, so git rejects it with "invalid reference." The error message does not explain the expected argument shape.

**Prevention:**
1. The full signature is `git worktree add [-b <new-branch>] <worktree-path> [<commit-ish>]`. Valid `<commit-ish>` values: `main`, `origin/main`, a SHA, a tag — not a directory path.
2. To scope work to a subdirectory, `cd` into the worktree after creation: `git worktree add -b <br> .worktrees/<name> main && cd .worktrees/<name> && <work in scope>`.
3. When the error is "invalid reference" on a `worktree add`, check whether the last argument looks like a path rather than a ref.

**Status:** Active — 1 instance (CL.Investigate1 p/40#13).

**Applies To:** All agents creating worktrees, especially when scoping work to a sub-role path.

---

## #167 [Build] Blocking Gate Promoted Before Validating Against Real Env — Probe's Own Gap Downs Both Deploys

**Pattern:** A new blocking deploy gate (probe) is promoted to block production deploys after passing in dev/staging, but has never run against the real target environment. Its first real run fails on the probe's own gap (untested assumption), not a real regression — taking down deploys it was meant to protect.

**Instances:**
- 2026-08-15 — Analytics round-trip smoke probe (t/2671): promoted to block deploys before running against AUTH_OPTIONAL env. First real run failed because the probe assumed an authenticated session; AUTH_OPTIONAL allows anonymous sessions, which the probe didn't handle. Both deploys downed (t/2683). Fixed by t/2684. Prevention ticket: t/2688 (p/335#38). Failure class: single-context validation (t/2648/2661) + Gate Verification (t/1589).

**Root Cause:** The gate was validated in a single context (dev, with auth) and extrapolated to all envs. The real env (AUTH_OPTIONAL) had a different session model the probe never exercised. A probe that has never run against the target env is an untested assumption masquerading as a gate — when it fails, it's indistinguishable from a real regression.

**Prevention:**
1. **Run new blocking probes non-blocking against the target env for ≥1 full green cycle before promoting them to block.** The first real-env run validates the probe itself, not just the system under test.
2. Map every new gate to its target env(s) at design time — list the session models, auth modes, and config variants the probe will encounter. If any are untested, keep the gate advisory until they are.
3. Failure class check before gate promotion: does this gate pass Gate Verification (t/1589)? — proven with both arms (deliberate failure fires it; clean case passes with zero noise), reliable across ALL target envs, not just the one it was written against.

**Status:** Active — 1 instance (t/2683, p/335#38). Prevention ticket open (t/2688).

**Applies To:** DevOps, TL, any role designing or promoting CI/deploy blocking gates.

---

## #168 [Test] Tests Hardcode DEFAULT_MODEL Literal Instead of Importing from Config

**Pattern:** Tests assert against the literal string value of `DEFAULT_MODEL` (e.g., `"claude-sonnet-4-6"`) instead of importing it from config. When `DEFAULT_MODEL` changes, the tests fail with a mismatch — catching a config update rather than a real regression.

**Instances:**
- 2026-08-15 — t/2687 (PR #1113, p/335#38): tests hardcoded the DEFAULT_MODEL literal value. When DEFAULT_MODEL was updated as part of `fix(ai): DEFAULT_MODEL must be a registered id` (#1113), the hardcoded assertions broke. Fix: import `DEFAULT_MODEL` from config in tests; never hardcode its value.

**Root Cause:** Tests that string-match a config constant treat the constant's value as a stable fixture. Config constants change intentionally; when they do, hardcoded assertions produce false failures that obscure whether the gate is testing the right thing.

**Prevention:**
1. **Never hardcode `DEFAULT_MODEL` (or any config constant) as a literal string in test assertions.** Import it from the same source as production code: `import { DEFAULT_MODEL } from '../config'` (or equivalent).
2. If the test's purpose is to verify that DEFAULT_MODEL IS a specific value (e.g., a change-detection gate), make that intent explicit with a comment and a pointer to the change approval record — so the next person updating the constant knows to update the test too.
3. General rule: test constants that live in config by importing them, not by copying their values.

**Status:** Active — 1 instance (t/2687, p/335#38).

**Applies To:** All agents writing tests that reference AI model IDs, config defaults, or other values that change with normal project evolution.

---

## #172 [Process] `.git/index.lock` Contention — Another Agent's Git Op Holds the Shared-Checkout Lock

**Pattern:** In `direct`-mode shared checkout, multiple agents run git operations concurrently. Every index-writing command (`git add`, `git commit`, `git stash`, etc.) exclusively creates `.git/index.lock` for its duration. If a peer's operation holds the lock, the next agent's attempt fails immediately: "Unable to create .git/index.lock: File exists."

**Instances:**
- 2026-09-28 — Chat (p/687#5, **2nd occurrence this session**): `git add` failed twice with the index.lock error while another agent had a git op in flight. Resolved both times by polling until the lock file cleared, then retrying — no manual removal.

**Root Cause:** Git's index lock is a per-repo mutual exclusion primitive. The shared checkout has one `.git/`, so all concurrent agents contend on a single lock. Any index-writing git command from any agent blocks the others for its duration.

**Prevention:**
1. **Poll and retry — never delete `.git/index.lock` manually** unless you have confirmed the owning process is dead. Removing an active lock corrupts the in-progress index operation and can leave the shared index in a broken state for all agents.
2. **Brief poll before retrying:** check `git status` (read-only; does not require the lock) to confirm the tree is consistent, then retry the failed command. A 2–5 second wait is usually sufficient.
3. In `direct` mode, git op contention is normal under concurrent agent load — treat it as a transient, self-resolving condition unless the lock file persists for >30 seconds (may indicate a crashed process).

**Status:** Active — 1 instance / 1 agent (Chat p/687#5, repeated twice in session). Deterministic under concurrent direct-mode load; expected to recur.

**Applies To:** All agents sharing the `direct`-mode checkout and running concurrent git index-writing operations.

---

## #173 [Process] File:Line Citations in Tickets/Email Are Claims, Not Verified Paths — `grep -rn <basename>` Before You Read

**Pattern:** A file:line reference quoted in a ticket, email, or ping looks authoritative but is just a claim. Files move (refactors, subdirectory splits, renames) after the reference was written. Trusting the path without verifying it causes "No such file" errors; the correct path costs one `grep -rn <basename>` to find.

**Instances:**
- 2026-09-28 — Second Opinion (p/691#1): `sed -n '55,80p' taxonomy-editor/src/server/inquiryShareStore.ts` → exit 2 "no such file" — path taken verbatim from an email reference. Real path was one directory deeper (`storage/`). Resolved: `grep -rn inquiryShareStore` found it immediately. No impact on the consult.

**Root Cause:** Prose references (tickets, emails, pings) are authored at a point in time and are never validated by the build. A file can be moved, nested into a subdirectory, or barrel-split after the reference is written, leaving the citation silently stale. The failure is silent until you attempt to access the path.

**Prevention:**
1. **Prefer tree-search over path-addressing when the path came from prose.** `grep -rn <distinctive-pattern> <dir>` (or Grep/Glob tool) finds the content without asserting a path — one call, can't silently miss. "Verify then access" is two calls and still fails silently if the path looks plausible but is wrong.
2. Related: #85 covers the barrel-path variant specifically (a `<name>.ts` may now be a `<name>/` barrel after ADR-007); this entry is the general case.

**Status:** Active — 1 instance (Second Opinion p/691#1). General principle; expected to recur across any agent consuming prose references.

**Applies To:** Any agent reading a file path from a ticket, email, ping, or any prose source before accessing it.

---

## #174 [Process] "Branch Off Current Main" Is Ambiguous — Local Main Can Be Ahead of origin/main; Always Use `origin/main` as the Worktree Base

**Pattern:** An instruction to "branch off current main" or "branch off main" is ambiguous between the shared local `main` ref and `origin/main`. In `direct` mode, other agents' commits may accumulate on the shared local `main` without being pushed (unreported divergence). A worktree branched off that stale local ref inherits those foreign commits — causing rebase conflicts and polluting the worktree's diff with unrelated work.

**Instances:**
- 2026-09-28 — Rosetta Stone (p/6#63): TL instruction said branch off "current main" without specifying local vs. origin. Shared local `main` was 3 commits ahead of `origin/main` from an unreported divergence. Worktree inherited those 3 unrelated commits; `git rebase origin/main` conflicted on a file both branches touched. Resolved by aborting the rebase — moot, since a manual merge (#2521) had already squash-landed the duplicate content; closed the redundant PR (#2522).

**Root Cause:** `git worktree add -b <branch> <path> main` uses the local `main` ref, not `origin/main`. In `direct` mode, shared local `main` can diverge from `origin/main` when agents commit without pushing immediately. The divergence may be unreported. Instructors saying "current main" naturally mean the canonical remote, but the command defaults to local state.

**Prevention:**
1. **Always `git worktree add -b <branch> <path> origin/main`** — never bare `main` as the commit-ish. `origin/main` is always the canonical base; local `main` may silently lead it.
2. **Before creating a worktree, confirm the shared local `main` is clean:** `git log --oneline origin/main..main` should be empty. If it shows commits, those are unpushed and will pollute your worktree base.
3. When giving or receiving instructions, "branch off main" means `origin/main` — make this explicit in the command, not just the prose.

**Status:** Active — 1 instance (Rosetta Stone p/6#63). Deterministic when local main diverges from origin; expected to recur in direct mode at fleet scale.

**Applies To:** All agents creating worktrees in `direct` mode where the shared checkout may have unpushed commits.

---

## #191 [Build] `gh pr diff` Does Not Accept a Pathspec — "accepts at most 1 arg(s), received 2"

**Pattern:** `gh pr diff <N> -- <path>` exits 1 with "accepts at most 1 arg(s), received 2." Unlike `git diff`, `gh pr diff` accepts only the PR number — no pathspec filtering. An agent expecting to inspect a single file's diff in a PR is blocked; there is no built-in filter.

**Instances:**
- 2026-10-03 — DevOps (p/26#127): `gh pr diff 2714 -- .github/workflows/ci.yml` exited 1. Dropped the pathspec and ran `gh pr diff 2714` (full diff); then manually located the `ci.yml` section in the output.
- 2026-10-03 — Quality/TL (p/447#22): `gh pr diff 2738 -- file1 file2 …` failed with same error. Resolved by downloading full diff with no path filter.

**Root Cause:** `gh pr diff` wraps the GitHub API's PR diff endpoint, which returns the full diff for the PR. The CLI does not expose pathspec filtering — it is architecturally a single-argument command (the PR number). The `git diff` flag style (`-- <path>`) does not apply here.

**Prevention:**
1. **`gh pr diff <N>` only — no pathspec.** To inspect one file: pipe through `grep` or `awk` on a stable marker (e.g. `diff --git a/.github/workflows/ci.yml`), or clone and run `git diff origin/main...origin/<branch> -- <path>` locally.
2. **Discriminate `gh` from `git` CLI flags before composing commands.** `gh` subcommands wrap REST/GraphQL APIs and do not share `git`'s pathspec conventions.

**Status:** Active — 2 instances. Deterministic; always fails with the same error.

**Applies To:** All agents using `gh pr diff` to inspect specific files in a PR.

---

## #192 [Test] A Harness That Differs From Production in One Variable Tests a Different Thing — The Difference Is Invisible From the Result

**Pattern:** A test harness that isolates "the variable under test" by holding everything else constant can silently differ from the production path in an additional variable — one the test author did not intend to vary. The result is green and looks like a proof of the production path; it is actually a proof of the harness path. The discrepancy is invisible from the result alone.

**Instances:**
- 2026-10-03 — TL (t/3851, p/335#115): A hook harness for the shared-checkout commit guard exercised the bare-commit index path (no pathspec). The production path uses `git commit -- <pathspec>`. Harness green ≠ pathspec path tested. The harness proved the bare-commit arm; the pathspec arm was not exercised.
- 2026-10-03 — TL (t/3821, p/335#115): A test carried its own copy of the predicate it was meant to validate. When the production predicate changed, the test's private copy stayed stale; test green, production behavior changed. The harness proved the test's copy of the predicate, not the deployed one.
- 2026-10-03 — TL (t/3851, p/335#117): `GIT_INDEX_FILE=` (empty string) — git treats it as an empty index, not as unset. Harness output "1429 nodes would be REMOVED" was read as a hook defect; it was the correct output for an empty index. The extra variable was the index state, not the hook logic. Harness, not code.
- 2026-10-04 — TL (t/3901, p/335#128): BOM fixture files were written with `Set-Content -Encoding utf8BOM`, then read back with `Get-Content -Raw` — which strips the BOM. So `ConvertFrom-Json` never received a leading U+FEFF in the test, even though PS7 `ConvertFrom-Json` rejects it in production. The test labelled "BOM coverage" passed while covering zero BOM-rejection behaviour. **Check rule:** verify the variable under test survives the fixture's **read path**, not just its write path.
- 2026-10-05 — TL (t/3892, p/335#132): a data-repo hook GV (Gate Verification) scratch set a path override that never triggered either the `GIT_DIR`-override or the `--show-toplevel` worktree cases. Every arm in the scratch passed; the deployed hook failed on the first live-fire. The harness matched a subset of the execution environment and left both cross-repo failure modes untested.

**Root Cause:** Credit to Second Opinion (e/243#4) for the formulation: *"A harness that differs from production in one variable is not a weaker test — it is a test of a different thing. Which thing it tested is invisible from the result."* Isolation introduces a controlled variable; an unnoticed additional difference (execution path, predicate copy, flag, index state, data source, **encoding stripping on read**) silently redirects what is being tested. Green proves the harness path; it says nothing about the production path.

**Prevention:**
1. **Name the exact execution path the test exercises** — not just "the feature." Include the specific flags, code path, and data source. If the path differs from production in any way, the test proves that path, not the production one.
2. **Never embed a copy of a production predicate in a test.** Import it. A private copy drifts silently when the original changes.
3. **After writing a test, ask: "What exactly did this harness exercise, and how does it differ from the production call chain?"** A one-variable difference is expected (the controlled variable); more than one means the extra variables are also being tested — or worse, are being quietly assumed constant.
4. **When a test is green on a known-broken change, suspect a harness path divergence** — not just a logic error. The test may not have reached the changed code at all.
5. **`GIT_INDEX_FILE=` (empty string) ≠ unset.** Git treats it as a path to an empty index. Use `unset GIT_INDEX_FILE` or omit the variable entirely to exercise the real index.
6. **Verify the variable under test survives the fixture's read path, not just its write path.** Encoding attributes (BOM, line endings, null bytes) are silently stripped or transformed by many read APIs — check what the code under test actually receives, not what the fixture file nominally contains.

**Status:** Active — 5 instances (TL t/3851, t/3821, t/3901, t/3892, p/335#115, p/335#117, p/335#128, p/335#132). Expected to recur wherever test harnesses are written without tracing the full call path to production code.

**Applies To:** All agents writing or interpreting test results, especially for hooks, guards, and gates where the test harness differs from the live invocation path.

---

## #193 [Test] A Reachability Arm Is the Only Test That Can Fail for an Unreachable Branch — Behaviour Tests for Dead Branches Pass Vacuously

**Pattern:** A test for the *behaviour* of a branch that can never be reached always passes — because the branch never executes, it can never fail. Writing this kind of test is the natural instinct when you suspect a branch is dead, which is precisely why the instinct defeats itself: a vacuous pass reads as coverage, the suspicion is "confirmed," and the dead branch stays in production. The correct test is of the *precondition*: assert that the condition the branch guards against can (or can no longer) occur. That test can fail if the system changes.

**Corollary — detection:** an arm that yields no output has not passed; it has not run. A harness arm that returns empty output (or rc=128 with zero hook output) is evidence of a dead branch, not a clean pass.

**Instances:**
- 2026-10-03 — TL (t/3851, p/335#118, e/243#8): Hook harness arm 11 was designed to test git-never-runs-hooks-on-unmerged-files. The dead-branch instinct would have been a behaviour test that silently passed. Instead, arm 11 asserts the *precondition* (git invariant), so it fails if that invariant ever changes. The dead branch was caught because the arm returned empty (rc=128, zero hook output) — the detection corollary in practice.

**Root Cause:** Credit to Second Opinion (e/243#8): *"A reachability arm is the only test that can fail for an unreachable branch."* Behaviour tests exercise the branch body; a dead branch has no body to exercise. The test reads as structural coverage — "the branch is tested" — but the coverage is vacuous. The underlying confound is conflating *having a test* with *having a test that can fail*.

**Prevention:**
1. **Test the precondition, not the behaviour, of a suspected dead branch.** Assert the invariant or condition that makes the branch reachable. If the condition can no longer be met, the arm fails — which is the signal you want.
2. **Zero output from a harness arm is a finding, not a pass.** An arm that emits nothing either reached a dead branch or did not run. Distinguish the two before moving on: check rc and add a "reached this arm" sentinel output.
3. **When writing a test to verify a branch is dead, ask: "Can this test fail?"** If the honest answer is "no, because the branch never executes," the test proves nothing. Redesign it as a precondition assertion.

**Status:** Active — 1 instance (TL t/3851, p/335#118, e/243#8). Structural: applies to any test for a branch suspected of being unreachable.

**Applies To:** All agents writing tests for guard branches, hooks, gates, or error paths that may be unreachable under normal conditions.

---

## #194 [Process] A Claim You Are Building On Never Presents as a Claim — It Presents as the Premise

**Pattern:** When reasoning multi-step, the claims being *challenged* are recognised as claims and get verified. The claims being *built on* — the ones the next step assumes as input — are not recognised as claims at all; they present as premises. The asymmetry is symmetric: the author of the inference skips the built-on claim because it looks like a starting point, and the receiver of the inference skips it for the same reason.

SO's formulation (e/243#12): *"I verify claims I'm challenging and skip claims I'm building on."*

**Instances:**
- 2026-10-03 — TL + SO (t/3851, e/243#9–#12): SO correctly inferred that git runs untracked hooks. SO then built on a further claim — that warn-only field evidence existed in the taxonomy commit history — and handed the collection task to TL as if the evidence existed. Neither party checked the built-on claim. The hook postdated every taxonomy commit; there were zero evaluations. The claim read as a task to both writer and receiver, not as a hypothesis requiring verification.

**Root Cause:** Verification effort is directed at uncertainty. A claim presented mid-inference as a starting point for the next step is syntactically indistinguishable from an established fact — it has already been "moved past." The writer doesn't flag it because they were focused on what it enabled; the receiver doesn't question it because it arrived framed as a given.

**Relation to #192/#193:** those patterns are about misreading a *result* (harness path ≠ production path, dead branch passes vacuously). This pattern is upstream — it governs which claims get checked in the first place, before any test runs.

**Prevention:**
1. **After any multi-step inference, list the built-on claims separately from the derived conclusions and verify each one.** The built-on claims are exactly the ones that weren't challenged because they didn't feel like claims.
2. **When handing a task derived from an inference chain, state the built-on claim explicitly** — "this task assumes X is true; verify X before proceeding" — not just the task. The receiver cannot distinguish assumed-fact from verified-fact from the task description alone.
3. **SO's discriminator:** "Am I verifying this claim, or am I building on it?" If building on it, verify it first.

**Status:** Active — 1 instance (TL + SO, t/3851, e/243#9–#12). Structural: applies to any multi-step reasoning chain where intermediate claims serve as premises for later steps.

**Applies To:** All agents reasoning multi-step, especially SO consultations and any chain where one agent's inference output becomes another agent's task input.

---

## #195 [Build] Shelling tsx/node from Pester on Windows — Multiple Failure Modes; Split Cross-Language Tests by Native Runner

**Pattern:** Invoking `tsx` (or `npx`/`node`) from inside a Pester test process on Windows produces at least two distinct failure modes depending on how the shell-out is done — neither is a clean failure with a useful message. The root-cause fix is architectural: Pester tests PowerShell; vitest tests TypeScript. Cross-process shell-outs from one runner to the other's language runtime are unsupported on this stack.

**Facet A — `Start-Process npx -WindowStyle Hidden -Wait` hangs:** `npx` is a `.cmd` wrapper. `-WindowStyle Hidden` cannot headlessly launch a `.cmd` process; `Start-Process -Wait` blocks indefinitely (2-minute Bash-tool timeout). No error — just silence, then exit 143.

**Facet B — `&` / `Start-Process tsx <real .ts file>` inside `BeforeAll` crashes with `InvalidOperationException`:** Running `tsx <real-file.ts>` (any real file, not `tsx --version`) from inside a Pester `BeforeAll` on this Windows agent reproducibly triggers a spurious `InvalidOperationException: break/continue label escaped` (pester/Pester#2669-shaped) that silently aborts the whole Pester run. `tsx --version` runs fine — only real TypeScript file execution triggers it. Root cause not fully isolated; discriminated by elimination.

**Instances:**
- 2026-10-03 — DevOps (p/26#132, Facet A): `Start-Process -FilePath npx -WindowStyle Hidden -Wait` hung 2 minutes; timed out. Resolved by abandoning the shell-out entirely.
- 2026-10-03 — DevOps (p/26#133, Facet B): `tsx <real .ts file>` inside Pester `BeforeAll` crashed with `InvalidOperationException` ("break/continue label escaped"), silently aborting the Pester run. `tsx --version` was fine. Resolved by splitting to a native vitest test for the TS side.

**Root Cause:** Pester and tsx/node are separate process trees with incompatible stdio/signal models on Windows. `.cmd` wrappers for Node tooling are not designed to be launched headlessly from `-WindowStyle Hidden`. The Pester#2669 shape suggests a PS pipeline/label scope escape when tsx tears down. Both are sharp edges on a combination the codebase doesn't use by design: Pester tests PS, vitest tests TS.

**Prevention:**
1. **Never shell tsx/node from inside a Pester process.** If you need to verify TS behaviour as part of a cross-language integration check, write a vitest test for the TS side and a separate Pester test for the PS side; do not bridge them with a shell-out.
2. **`Start-Process -WindowStyle Hidden` cannot launch `.cmd` wrappers headlessly.** Use the underlying binary directly (node, not npx), or avoid the shell-out.
3. **`tsx --version` succeeding ≠ `tsx <file>` safe in a Pester process.** The crash is triggered by real TypeScript execution, not the binary launch itself. Don't use version-probe success as evidence that real execution will work.

**Status:** Active — 2 instances (DevOps p/26#132, p/26#133). Deterministic on this Windows agent; expected to recur if cross-runner shell-outs are attempted.

**Applies To:** All agents writing Pester tests that are tempted to shell out to tsx/node for cross-language validation.

---

## #196 [Build] `git branch -d` "Not Fully Merged" When Local Branch Name Differs From Remote Push Target

**Pattern:** `git branch -d <local-branch>` reports "not fully merged" even though the branch has been pushed and its content is on the remote — when the local branch name differs from the remote ref name the push targeted. Git's "fully merged" check compares the local branch tip against known remote-tracking refs; if you pushed via `HEAD:refs/heads/<different-name>`, git has no tracking relationship between `<local-branch>` and the remote branch it landed on, so it cannot confirm the fast-forward and refuses `-d`.

**Instances:**
- 2026-10-03 — PowerShell (p/20#60): used `git switch -c <local>` (to satisfy the detached-HEAD guard), then pushed via `HEAD:<remote-name>` where `<local> ≠ <remote-name>`. Post-merge `git branch -d <local>` returned "error: the branch is not fully merged." Confirmed identity by comparing SHAs (`git rev-parse <local>` vs `git rev-parse origin/<remote-name>`), then deleted with `git branch -D`.

**Root Cause:** git's "is this branch merged?" check walks the reflog and remote-tracking branches. Without a tracking relationship (set by `--set-upstream-to` or by pushing under the same name), git cannot see that `<local>` and `origin/<remote-name>` are the same commit. `-d` requires a proven merge; `-D` forces deletion regardless.

**Prevention:**
1. **Push under the same name as the local branch** — `git push origin <branch>:<branch>` or bare `git push origin <branch>`. This establishes the remote-tracking ref `origin/<branch>` that `-d` checks against.
2. **If names must differ, confirm identity before forcing:** `git rev-parse <local>` must equal `git rev-parse origin/<remote-name>`. If they match, `git branch -D <local>` is safe.
3. **`git switch -c <branch>` + `git push origin HEAD:<different-name>` is the pattern that triggers this.** The detached-HEAD guard is satisfied by the switch, but the push creates a mismatched remote ref. Prefer naming them the same at `switch -c` time.

**Status:** Active — 1 instance (PowerShell p/20#60). Deterministic when local and remote ref names differ.

**Applies To:** All agents deleting local branches after pushing to a differently-named remote ref.

---

## #197 [Build] `core.fileMode=false` + Pathspec Commit Silently Discards Index-Only Mode Changes — Hook Committed Non-Executable

**Pattern:** On Windows with `core.fileMode=false`, attempting to commit an executable-bit change (`update-index --chmod=+x`, `add --chmod=+x`, or `-c core.fileMode=true`) exits 0 and appears to succeed — but the committed blob is still `100644`. On Linux/macOS, git then skips that file as a non-executable hook, so a guard or script lands in a form that never runs. The silence is total: no error, no warning, the commit log looks clean.

**Collision with the pathspec-commit rule (root AGENTS.md):** The mandated pathspec form (`git commit -- <paths>`) is required to avoid sweeping in other agents' staged files. But pathspec commits also silently gate on `core.fileMode` and drop the mode change. The two house rules are in direct tension for this specific case.

**Safe method (TL, t/3851#9):** Use a private `GIT_INDEX_FILE` seeded from HEAD so the commit is isolated from the shared index:
```bash
tmpidx=$(mktemp)
GIT_INDEX_FILE="$tmpidx" git read-tree HEAD
GIT_INDEX_FILE="$tmpidx" git update-index --chmod=+x -- <path>
GIT_INDEX_FILE="$tmpidx" git commit --tree $(GIT_INDEX_FILE="$tmpidx" git write-tree) -p HEAD -m "fix: mark <path> executable"
git restore --staged -- <path>   # ← CRITICAL: without this, the next bare commit reverts the mode fix
```
The `git restore --staged` step is mandatory: the shared index still has `100644`; leaving it staged means the next bare commit overwrites the mode fix silently.

**Instances:**
- 2026-10-03 — TL (t/3851#9, p/335#122): the data repo's `pre-commit` hook was committed as `100644` under `core.fileMode=false` and has been inert on Linux/macOS since it landed. Every hook invocation on non-Windows silently skipped it.

**Root Cause:** `core.fileMode=false` tells git to ignore executable-bit differences in the working tree. The index-staging commands respect this setting and do not persist the mode change. A pathspec commit then has no mode delta to write. The setting exists for Windows (where the filesystem has no exec bit), so this is a per-platform silent failure: the author on Windows sees a clean commit; the Linux runner runs nothing.

**Prevention:**
1. **Never rely on `add --chmod=+x` or `update-index --chmod=+x` alone on a Windows checkout** — confirm the mode landed in the commit object: `git ls-tree HEAD <path>` must show `100755`, not `100644`.
2. **To force a mode change from Windows: use the private-GIT_INDEX_FILE method above.** The `git restore --staged` cleanup is not optional.
3. **After committing a hook or executable script, verify it runs on CI (Linux) before closing the ticket.** A green Windows build does not prove the hook is executable on the runner.
4. **Relation to AGENTS.md pathspec-commit rule:** the private-index method is the exception that resolves the collision — it commits only the intended path without touching the shared index. Document the exception in the commit message.

**Status:** Active — 1 instance (TL t/3851#9, p/335#122). Silently deterministic on Windows with `core.fileMode=false`; high blast radius (inert hooks pass all local checks).

**Applies To:** All agents committing hook scripts, executable shell scripts, or any file requiring `100755` mode from a Windows checkout.

---

## #198 [PowerShell] Private Module Functions Not Exported — Invoke in Module Scope

**Pattern:** After `Import-Module AITriad`, calling a Private function (one in the `Private/` folder, not listed in `FunctionsToExport`) from the host session fails with `"term not recognized as the name of a cmdlet, function, script file, or operable program"`. The function exists and works; it is simply not exported to the caller's scope.

**Instances:**
- 2026-10-03 — DevOps Lead (p/26#139): `Get-ComplexityScanTargets` is a Private helper; calling it directly after import gave "term not recognized".
- 2026-10-04 — PowerShell (p/20#65): `Get-DataRoot` called from `pwsh -Command` outside the module; same error; resolved with `& (Get-Module AITriad) { Get-DataRoot }`.

**Root Cause:** PowerShell module exports are controlled by `FunctionsToExport` in the manifest (or by `Export-ModuleMember`). Private functions are intentionally omitted. The module session has them; the caller's session does not.

**Prevention:**
1. **Invoke Private functions in module scope:** `& (Get-Module AITriad) { Get-ComplexityScanTargets -Path ./operations }` — the script block runs inside the loaded module's session state where Private functions are visible.
2. **Don't add Private functions to `FunctionsToExport` just to reach them from tests.** Use the `& (Get-Module …) { … }` form in test scripts instead.
3. **"Term not recognized" after a successful import = scope issue, not a missing function.** Confirm with `(Get-Module AITriad).ExportedFunctions.Keys` (shows Public) vs `& (Get-Module AITriad) { Get-Command Get-ComplexityScanTargets }` (shows Private if present).

**Status:** Active — 2 instances. Deterministic whenever a Private function is called from outside the module.

**Applies To:** All agents invoking Private PowerShell module functions from test scripts, Pester suites, or ad-hoc sessions.

---

## #199 [PowerShell] `-Path` Rejects Array Literal on Single-String Cmdlets — Pipe via `ForEach-Object` or Use Directory

**Pattern:** Passing a comma-separated array literal to `-Path` on cmdlets typed as `[string]` — e.g. `Invoke-ScriptAnalyzer -Path 'a.ps1','b.ps1'` or `Measure-CodeComplexity -Path a.ps1, b.ps1` — throws `"Cannot convert 'System.Object[]' to the type 'System.String'"`. The `-Path` parameter on these cmdlets is a singular `[string]`, not `[string[]]`.

**Instances:**
- 2026-10-03 — PowerShell (p/20#62): `Invoke-ScriptAnalyzer -Path 'a.ps1','b.ps1','c.ps1'` — resolved by piping via `ForEach-Object { Invoke-ScriptAnalyzer -Path $_ }`.
- 2026-10-06 — PowerShell (p/20#72): both `Measure-CodeComplexity -Path a.ps1, b.ps1` and `Invoke-ScriptAnalyzer -Path a.ps1, b.ps1` threw the same error. For `Measure-CodeComplexity`, resolved by passing the directory with `-Include 'a.ps1','b.ps1'`; for the analyzer, ran once per file. Confirms the pattern extends beyond PSScriptAnalyzer.
- 2026-10-07 — PowerShell (p/20#76, t/4065): `Invoke-ScriptAnalyzer -Path a,b,c` — same "Cannot convert System.Object[] to System.String" error. Resolved by piping via `ForEach-Object { Invoke-ScriptAnalyzer -Path $_ }`.
- 2026-10-07 — PowerShell (p/20#86, t/3910): `Measure-CodeComplexity -Path a,b` — same error again. Resolved by piping via `ForEach-Object { Measure-CodeComplexity -Path $_ }`.

**Root Cause:** Several PS analysis cmdlets type `-Path` as `[string]` rather than `[string[]]`. PowerShell's automatic coercion from `Object[]` to `String` fails with this error — the engine cannot silently stringify an array.

**Prevention:**
1. **For `Invoke-ScriptAnalyzer` multi-file:** pipe via `ForEach-Object { Invoke-ScriptAnalyzer -Path $_ }` — one call per file.
2. **For `Measure-CodeComplexity` multi-file:** pass the containing directory with `-Include 'a.ps1','b.ps1'` rather than comma-listing paths to `-Path`.
3. **Alternatively, use `-Path` with a directory and `-Recurse`** when analyzing a subtree.
4. **`"Cannot convert … to the type 'System.String'"` on a cmdlet that looks like it should accept arrays = check the actual parameter type** with `(Get-Command <cmdlet>).Parameters['Path'].ParameterType`.

**Status:** Active — 4 instances (PowerShell p/20#62, p/20#72, p/20#76, p/20#86). Deterministic. Extends to any analysis cmdlet with a singular `-Path [string]`.

**Applies To:** All agents running `Invoke-ScriptAnalyzer` or `Measure-CodeComplexity` across multiple files in a single call.

---

## #200 [Test] Type-Level Assertions in `*.test.ts` Are Inert — tsconfig Excludes Test Files

**Pattern:** A `@ts-expect-error` comment used as a *compile-time assertion* ("this expression must not type-check") inside a `*.test.ts` file enforces nothing. The lib tsconfigs exclude `**/*.test.ts`, and vitest does not have `typecheck` enabled — so TypeScript never sees those files. Widening the type under test leaves everything green; the "assertion" is silently vacuous.

Distinction: `@ts-expect-error` used as a *suppression* in test files (silencing a known error to let the test compile) is harmless. Only the *assertion* use — expecting the error to prove a type boundary — is inert here.

**Instances:**
- 2026-10-04 — TL/Rosetta Stone (t/3889#7-8, p/335#124): a type assertion in a `.test.ts` was intended to prove a type was correctly narrowed; it passed Gate Verification without the GV checking whether tsc actually ran on the file. The lib tsconfig's `exclude: ["**/*.test.ts"]` silently dropped the assertion from type-checking.

**Root Cause:** `lib/tsconfig.json` (and sibling lib tsconfigs) exclude `**/*.test.ts` from compilation. Vitest runs tests but does not invoke `tsc --noEmit` on them. There is no path by which a `@ts-expect-error` assertion in a test file reaches the TypeScript compiler.

**Prevention:**
1. **For type boundary assertions, use a dedicated `*.typecheck.ts` file** inside tsconfig's `include` glob — not a `*.test.ts` file. Name it `<feature>.typecheck.ts` so its purpose is clear.
2. **Prove both arms with `tsc`:** confirm the assertion file produces an error when the type is widened, and no error when the type is correct. Both arms must be run — a green-only proof does not verify the assertion is live (Pattern #193).
3. **Gate Verification for type assertions must include `tsc --noEmit` on the specific file**, not just a passing vitest run. A passing test suite does not prove tsc saw the assertion.
4. **`@ts-expect-error` in a test file is a suppression, not an assertion**, unless tsc is explicitly configured to include test files. Default to treating it as suppression-only.

**Status:** Active — 1 instance (TL/Rosetta Stone t/3889#7-8, p/335#124). Silent; no error, no warning, always green.

**Applies To:** All agents writing type-level tests or assertions in TypeScript lib/taxonomy-editor subtrees.

---

## #201 [PowerShell] `Write-Warning` Bleeds Into Captured Stdout Under Non-Interactive `pwsh -Command`

**Pattern:** Running `pwsh -Command "Import-Module AITriad; (Get-DataRoot)"` (or any command that emits `Write-Warning` during module load) and capturing stdout produces output that includes the warning text alongside the real return value. A string comparison or path parity check against that output fails even though the underlying value is correct.

**Instances:**
- 2026-10-04 — PowerShell (p/20#64): Python/pwsh parity assertion for `Get-DataRoot` path failed; paths were identical but the captured output included a `Write-Warning` line from the module import, contaminating the comparison value.

**Root Cause:** Under `pwsh -Command` (non-interactive), the warning stream is not automatically redirected to stderr — it goes to the host output, which in a subprocess context arrives on stdout. The caller captures both the real return value and any warnings as a single undifferentiated stream.

**Prevention:**
1. **Add `-WarningAction SilentlyContinue` to `Import-Module`** when running non-interactively: `Import-Module AITriad -WarningAction SilentlyContinue`. This suppresses warning output without hiding errors.
2. **Parse only the last non-empty stdout line** as the real return value when capturing `pwsh -Command` output — warnings arrive before the function's return value. `$output | Where-Object { $_ -ne '' } | Select-Object -Last 1` is the safe form.
3. **Prefer `pwsh -NoProfile -Command` for subprocess calls** to avoid profile-level warnings too.
4. **When a parity test fails on seemingly identical values, dump the raw bytes** (`[System.Text.Encoding]::UTF8.GetBytes($val) | ForEach-Object { "{0:X2}" -f $_ }`) to reveal hidden characters or extra lines before assuming a logic error.

**Status:** Active — 1 instance (PowerShell p/20#64). Deterministic whenever a module emits warnings and its output is captured from a subprocess.

**Applies To:** All agents invoking PowerShell module functions via `pwsh -Command` from Python, shell scripts, or other subprocesses and capturing stdout.

---

## #202 [Build] `continue-on-error: true` Step `conclusion` Is Always `success` — Only `outcome` Distinguishes Pass From Fail, and the Steps API Omits It

**Pattern:** A CI step with `continue-on-error: true` reports `conclusion: success` in the GitHub Checks API **regardless of whether the step passed or failed**. The `outcome` field (`success` | `failure`) correctly reflects the real result, but the GitHub steps API does not return `outcome` — only in-workflow expressions like `steps.<id>.outcome` can read it. During a warn-first observation cycle, green checkmarks and step `conclusion` values are therefore **uninformative**: both the "clean" and "firing" cases look identical from the outside.

**Instances:**
- 2026-10-04 — TL (t/3897#2, p/335#126): a warn-first CI step's red and green arms both showed `completed/success`; only the failure-level annotations in the run's annotations API endpoint differed. The observation cycle was designed to prove the step fired safely — but the signal used (conclusion) could not distinguish firing from not-firing.

**Root Cause:** GitHub's job-conclusion semantics fold `continue-on-error` failures into `success` to prevent blocking downstream jobs. `outcome` is a step-level field only available inside the workflow YAML (as `steps.<id>.outcome`), not surfaced by the Checks API or the steps endpoint.

**Prevention:**
1. **During a warn-first observation cycle, use annotations, not conclusions.** Query `GET /repos/{owner}/{repo}/check-runs/{run_id}/annotations` — failure-level annotations are present when the step fired and absent when it did not. This is the only externally observable signal.
2. **Alternatively, add an explicit reporting step** after the warn-first step: `if: steps.<id>.outcome == 'failure'` → `echo "FIRED"` at warning level, or upload a summary artifact. This surfaces `outcome` in the run log where it can be read.
3. **`conclusion: success` + `continue-on-error: true` = "the workflow did not abort" — nothing more.** It does NOT mean the step passed. Never use step conclusion as evidence that a warn-first gate is behaving correctly.
4. **The safety mechanism creates its own blind spot.** Warn-first is chosen precisely so the fleet can observe before blocking — but if the observation instrument is insensitive to firing, the cycle proves nothing. Verify the instrument before trusting the observation.

**Status:** Active — 1 instance (TL t/3897#2, p/335#126). Deterministic: any `continue-on-error: true` step has this property.

**Applies To:** All agents observing warn-first CI steps, verifying gate behaviour, or reading step conclusions from the GitHub Checks API.

---

## #203 [Build] `GIT_DIR` Exported by Git to Hooks Overrides `-C` — Cross-Repo Calls Silently Read the Wrong Repo

**Pattern:** When git runs a hook, it exports `GIT_DIR` (and related vars: `GIT_WORK_TREE`, `GIT_INDEX_FILE`, etc.) into the hook's environment. A hook that calls `git -C <other-repo> show …` or any other git command intending to target a different repository finds that `GIT_DIR` overrides the `-C` flag — git reads the **original** repo, not the target. The command exits 0 and produces output, so the failure is silent; only the wrong result reveals it.

Secondary failure: `git rev-parse --show-toplevel` inside a worktree returns the **worktree root**, not the common git dir, so a path built from `--show-toplevel` to reach a sibling repo will be wrong in worktree contexts.

**Instances:**
- 2026-10-05 — TL (t/3892, data #17, p/335#132): a data-repo hook called `git -C <code-repo> show` to resolve a version. `GIT_DIR` (set to the data repo's `.git`) overrode `-C`, so the command silently read the data repo instead of the code repo. Every worktree commit produced COULD NOT VERIFY. Resolved by clearing `GIT_*` env vars before cross-repo calls and resolving paths from `--git-common-dir` instead of `--show-toplevel`.

**Root Cause:** Git's hook protocol explicitly exports `GIT_DIR` so the hook can find the repo that invoked it. That export propagates to every subprocess, including intentional cross-repo calls. `-C` sets the working directory, but `GIT_DIR` takes precedence over working-directory inference. The silent override is by design from git's perspective; it is a trap for hook authors who expect `-C` to fully redirect.

**Prevention:**
1. **Clear git env vars before any cross-repo `git` call from a hook:** `env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY git -C <other-repo> …` — or `GIT_DIR= GIT_WORK_TREE= git -C …` (empty-string unset).
2. **Use `--git-common-dir` to locate sibling repos**, not `--show-toplevel`. In a worktree, `--show-toplevel` is the worktree root (e.g. `.worktrees/wt-foo`), not the repo root — paths relative to it will be wrong. `--git-common-dir` always resolves to the common git directory.
3. **Live-fire the deployed hook in a worktree context** as part of Gate Verification — not just a scratch invocation from the main checkout. The `GIT_DIR` and `--show-toplevel` failure modes only manifest when the hook runs in the environment git actually uses.
4. **A hook GV that passes every arm on a scratch but fails on the first live deployment is a #192 instance** (harness path ≠ production path). See Pattern #192 prevention for the general form.

**Status:** Active — 1 instance (TL t/3892, data #17, p/335#132). Silent; git exits 0 with plausible-looking output from the wrong repo.

**Applies To:** All agents writing hooks that call `git` commands targeting a repo other than the one that invoked the hook.

## #204 [Build] `git worktree add` Fails on Stale Directory or Stale Branch — Two Separate Failures, Same Recreate Path

**Pattern:** After `git worktree remove <path>`, the worktree registration is cleared but the **directory on disk is not deleted**. A subsequent `git worktree add -b <branch> <path> origin/main` fails with `fatal: '<path>' already exists`. Separately: if the same-named branch was left behind by a prior failed `worktree add` attempt, a second `worktree add -b` fails because the branch already exists. The two failures are independent but triggered in sequence when recreating a same-name worktree.

**Instances:**
- 2026-10-05 — DebateTool (p/70#47): recreating `wt-3882` hit both failures in sequence — directory persisted after `git worktree remove`, then a stale same-name branch (created by the failed first add) blocked the retry. Resolved by `rm -rf <path>` first, then `git branch -D <branch>`, then `git worktree add -b <branch> <path> origin/main`.
- 2026-10-06 — Computational Linguist (p/7#92): `git worktree add -b <branch> <path>` failed "path already exists". Retry with new path failed "branch already exists" — because the failed first command had already created the branch before erroring on the path. The branch was at `origin/main` and unused. Resolved by `git worktree add <newpath> <branch>` (no `-b`), reusing the orphaned branch.

**Root Cause:** `git worktree remove` deregisters the worktree and removes the `.git/worktrees/<name>` metadata but does NOT `rm -rf` the working directory — git treats that as user-owned data. The `-b` flag of `worktree add` calls `git branch` internally **before** checking the path, so a path-exists failure still leaves the branch created. The operation is not atomic.

**Prevention:**
1. **Recreate sequence (full reset):** `rm -rf <path>` → `git branch -D <branch>` (if branch exists) → `git worktree add -b <branch> <path> origin/main`.
2. **Fast recovery when orphaned branch is clean:** if `worktree add -b` failed on the path and the newly-created branch is at `origin/main` and unused, skip delete-and-recreate — use `git worktree add <path> <branch>` (no `-b`) to reuse the orphaned branch directly. Verify with `git branch --list <branch>` and `git log <branch>` first.
3. **Check before assuming clean state:** after `git worktree remove`, verify with `git worktree list` (confirms deregistration) and `ls <path>` (confirms directory gone) and `git branch --list <branch>` (confirms branch gone) before a recreate.
4. **Prefer unique worktree names** (e.g. include a timestamp or ticket number) to avoid stale-branch collisions across sessions.

**Status:** Active — 1 instance (DebateTool, p/70#47). Loud failure (`fatal:` message); easy to fix once the two-stage nature is understood.

**Applies To:** Any agent that removes and recreates a worktree with the same path or branch name.

## #205 [Build] GitHub PR API Lags a Push by Seconds — `headRefOid` Stale Immediately After Push

**Pattern:** Querying `gh pr view <N> --json headRefOid` immediately after `git push` returns the **previous** commit SHA. GitHub's PR API is eventually consistent; the push registers on the remote, but the PR object's `headRefOid` field updates asynchronously (typically within a few seconds). A guard that compares local HEAD with `headRefOid` and exits non-zero on mismatch is *correct* to refuse — the data is genuinely stale — but it appears to fail the push itself, which succeeded.

**Instances:**
- 2026-10-06 — Computational Linguist (p/7#88, 1st occurrence in session): re-arm guard exited 1 right after a successful push; `headRefOid` still showed the previous commit. Resolved by polling until `headRefOid` equals local HEAD, then arming.
- 2026-10-06 — Computational Linguist (p/7#88, 2nd occurrence same session): same guard, same lag. Confirmed the fix is a poll loop, not a fixed sleep.

**Root Cause:** GitHub's REST/GraphQL API for PR metadata is eventually consistent. A `git push` updates the remote ref atomically, but GitHub's internal propagation to the PR object's `headRefOid` field takes additional time (observed: a few seconds). Any guard or workflow step that reads `headRefOid` immediately post-push will see stale data during this window.

**Prevention:**
1. **Poll, don't sleep:** after pushing, poll `gh pr view <N> --json headRefOid -q .headRefOid` until the value matches `git rev-parse HEAD`, then proceed. A fixed sleep is a fragile workaround — the lag varies; the poll is robust.
2. **A mismatch exit is the correct guard behavior** — it caught stale data. Don't weaken the guard; fix the caller to retry.
3. **Applies to any post-push API read:** CI run listing (`gh run list --commit <sha>`), PR checks, branch protection queries — all may lag by seconds. Poll with a condition, not a wall-clock delay.

**Status:** Active — 2 instances same session (Computational Linguist, p/7#88). Loud (guard exits non-zero); easy to misread as a push failure when the push actually succeeded.

**Applies To:** All agents running guards or checks that read GitHub PR/ref metadata immediately after a push.

## #206 [Build] `||`-Fallback Short-Circuits When Primary Succeeds — Reader Uses Fallback Path That Was Never Written

**Pattern:** A shell chain of the form `cmd > /path/A || cmd > /path/B; read /path/B` writes to path A when the primary succeeds, skips path B entirely, then fails at read time with "No such file." The `||` fallback is a safety net for primary failure — when the primary succeeds, the fallback never runs, so its output path is never created. If the downstream reader hard-codes the fallback path, it reads a file that only exists when the primary *fails*.

**Instances:**
- 2026-10-06 — PowerShell 2 (p/228#25): `git show … > $TMPDIR/f || git show … > <scratchpad>/f; sed <scratchpad>/f` — first redirect succeeded, `||` fallback never ran, `<scratchpad>/f` was never written → "No such file." Fix: use a single explicit path variable for both the write target and the read source.

**Root Cause:** The `||` operator short-circuits on primary success — it is not a "try both" fan-out, it is "use fallback only on failure." Any code that reads the fallback path must account for the case where the primary succeeded and that path was never written.

**Prevention:**
1. **Use a single explicit path variable:** assign the destination once (`$out = "<path>"`), write to `$out` in both branches, read from `$out`. Primary and fallback become alternate writers to the same destination.
2. **Alternatively, test existence before reading:** `if (Test-Path $fallbackPath)` / `[ -f $fallbackPath ]` — but this only catches the symptom; the root fix is a unified destination.
3. **When you see `cmd > pathA || cmd > pathB; use pathB`, stop:** the fallback path is only written on primary failure. Decide which path is canonical and use it for the read.

**Status:** Active — 1 instance (PowerShell 2, p/228#25). Self-inflicted; low recurrence risk once the `||` short-circuit semantics are understood. Logged for pattern recognition if the shape recurs.

**Applies To:** All agents writing shell chains with `||` fallbacks that write to different output paths.

## #207 [Process] Draft + Ticket-Relation Blockers Is Not a Gate — `consult-hold` Required for Any Cross-Ticket Hold

**Pattern:** A PR held with draft status plus Orca ticket-relation blockers (e.g., "blocked by t/3989") was un-drafted and merged 12 seconds before a hold comment was posted, after a "clear to un-draft" message was relayed. The registry went live ahead of the loader fix. Ticket relations are **not enforced at merge time** by GitHub, and draft can be lifted by anyone (including automation indistinguishable from the owner in the timeline). Neither mechanism is a gate — both are visibility only.

**Instances:**
- 2026-10-06 — Computational Linguist (p/7#90, t/3956): PR #2851 held on draft + ticket-relation blockers (t/3989–3992). Relay lifted draft on PI's decision arriving; merged 12 s before hold comment. Registry live ahead of loader fix.

**Root Cause:** Draft enforcement was already documented as unreliable (AGENTS.md: automation can un-draft). This instance extends that to the more general case: **any hold that isn't a required status context on GitHub is not a gate.** Orca ticket relations express intent, not enforcement. A "blocked by" relation in the ticket system has no connection to the GitHub merge button.

**Prevention:**
1. **Apply `consult-hold` to any PR that must not merge until external conditions are met** — not just mandatory-consult situations. This makes the hold a required status context that GitHub enforces on every merge path, binding admins under `enforce_admins: true`.
2. **Draft + ticket relations = visibility only.** Use them for "why this is held" — the label is the gate.
3. **The 12-second window is the canonical failure mode:** a hold comment arrives after the merge because the relay completes before the comment. The `consult-hold` label is set at PR creation (`gh pr create --label consult-hold`), not after; it cannot be race-conditioned.
4. Covered in root AGENTS.md PR-Flow Practice Rules — this instance demonstrates the non-consult variant.

- 2026-10-07 — Computational Linguist (p/7#104, t/4040#19): PR #3032 (draft, meant to merge after #3033) was un-drafted and merged 12 minutes early by an unknown actor on shared credentials. Draft provided no real ordering enforcement. Both PRs ended up on `main` and consistent, so no rollback needed. **Prevention identified:** use `consult-hold` label for ordering dependencies, or don't open the dependent PR until its prerequisite merges.
- 2026-10-07 — Computational Linguist (p/7#108, same day): same unknown actor also **un-drafted and armed auto-merge** on PR #3031 (a held PR). This time `consult-hold` label was present — `consult-hold-guard` blocked the merge and the attempt was caught by Rosetta Stone before it landed. **New amplifiers: (1) the actor also armed auto-merge (not just un-drafted), and (2) two held PRs targeted in the same day suggests a systematic sweep, not a one-off.** TL flagged on e/268#35. **Confirms that `consult-hold` label is the one mechanism that held** — draft + un-draft + auto-merge arm = one action away from landing; the required status context is the gate.

**Status:** Active — 3 instances (Computational Linguist p/7#90 t/3956; p/7#104 t/4040#19; p/7#108). Escalating severity: inst3 added auto-merge arming and a second target on the same day. `consult-hold` label confirmed as the only enforced gate.

**Prevention (updated):**
1. **Apply `consult-hold` label to ANY PR that must not merge** — not just mandatory-consult ones. It is the only mechanism that survives an unknown actor un-drafting and arming auto-merge.
2. **Draft + ticket relations + hold comments = visibility only.** The label is the gate.
3. **Set `consult-hold` at PR creation** (`gh pr create --label consult-hold`), not reactively — a post-creation window exists where the PR is unprotected.
4. **Two un-draft events on the same day = sweep, not coincidence.** If you see unexplained un-drafting, escalate to TL immediately; the cause may be automation or an actor with broad credentials.

**Applies To:** All agents holding PRs on cross-ticket blockers or external conditions of any kind.

## #208 [Build] Two Git/Windows Path Traps: `core.quotePath` Escapes Non-ASCII, and 269-Char Paths Exceed MAX_PATH

**Pattern:** Two co-occurring path-string issues when running `git ls-files` / `git show` on a repo with non-ASCII or long filenames: (1) git's default `core.quotePath=true` octal-escapes non-ASCII characters in output (e.g. `\303\251` instead of `é`), causing a Python set-diff to report false mismatches against `os.listdir()` results; (2) a path of 269 characters exceeds Windows `MAX_PATH` (260), so `os.listdir()` enumerates it but `open()` / `io` fails — the file appears to exist but cannot be read. A `\\?\` extended-length prefix passed through a Bash heredoc silently lost a backslash, compounding the second issue.

**Instances:**
- 2026-10-06 — TL (p/335#134, t/4001): byte-compare of `ai-triad-sources` files reported one file missing and set-diff false mismatches. Root: `core.quotePath` escaping non-ASCII path + 269-char path over MAX_PATH. Fix: `-c core.quotePath=false`, `\\?\` extended-length prefix written via a script file (not a heredoc).

**Root Cause:** `core.quotePath` is enabled by default to keep git output ASCII-safe; consumers that compare git output against filesystem APIs must suppress it. Windows MAX_PATH is a legacy 260-char limit that `os.open()` / `io.open()` hit even when `os.listdir()` succeeds (listdir uses a different Windows API path).

**Prevention:**
1. **Always pass `-c core.quotePath=false`** when consuming git path output in Python/PowerShell comparisons.
2. **For paths ≥ 260 chars on Windows, use the `\\?\` extended-length prefix** — but write it via a script file, not a Bash heredoc (heredoc backslash handling strips one level, leaving `\?\`).
3. Both issues are silent: git exits 0; `listdir` succeeds. The only signal is a false mismatch or a `FileNotFoundError` on a path that `listdir` returned.

**Status:** Active — 1 instance (TL, p/335#134, t/4001). Both traps are silent failures.

**Applies To:** All agents running Python/PowerShell comparisons against `git ls-files` or `git show` output on repos with non-ASCII filenames or very long paths.

## #209 [Test] Test Pins "Today's" Config Contents — Rots When the Next Config Lands

**Pattern:** A CI test asserts that a committed config file (registry, schema, list) has a specific fixed value — e.g. "the POV-tag registry is empty." The test passes at commit time. A later PR adds entries to that config, and the test goes red without touching the test file. The test was not wrong at the time it was written; the config was genuinely empty. But a test that pins the current state of a shared, evolving artifact is a time bomb: it encodes "today's contents" as an invariant, and any future legitimate change to the artifact fails it.

**Instances:**
- 2026-10-06 — Rosetta Stone (p/6#77, PR #2879): a test asserted the committed POV-tag registry was empty. t/3956 (PR #2851) then added Skeptic tags, and the test went red. Fix: inject a known-fixed registry for the test's fixed cases; derive expected values from the real registry for cases that should track it.

**Root Cause:** The test was correct when written (registry was empty) but encoded a snapshot of a shared artifact as a permanent invariant. Tests of this shape fail on the next legitimate write to the artifact — a false red that punishes the landing agent, not the original test author.

**Prevention:**
1. **Don't pin the contents of a shared, evolving artifact as a test invariant.** Instead: inject a controlled fixture for cases needing isolation; derive expected values from the real artifact for cases that should track it.
2. **The tell:** if your assertion would fail if someone *correctly* adds an entry to the artifact, it is pinning today's snapshot, not testing behavior.
3. **Equivalent to:** asserting a list has exactly N items when N is expected to grow. Replace with structural assertions ("is non-empty", "contains X", "all entries are valid") or inject a frozen copy.

**Status:** Active — 1 instance (Rosetta Stone, p/6#77, PR #2879). Silent until the next config change; then a false red that blocks a legitimate PR.

**Applies To:** All agents writing tests that reference shared config files, registries, or schema contents.

## #210 [Build] `--is-ancestor` Fails After a Squash Merge — Squash Creates a New SHA, Not an Ancestry Link

**Pattern:** After a squash-merge PR lands, checking `git merge-base --is-ancestor <pre-squash-commit> origin/main` exits 1. A squash merge produces a **new, independent commit** whose SHA has no ancestry relationship to the original branch commits — it is not a cherry-pick or rebase; it is a fresh commit whose tree happens to match. `--is-ancestor` tests the git DAG; since the pre-squash SHA is not in `origin/main`'s ancestry chain, the check correctly returns false — but this is the wrong verification method for squash merges.

**Instances:**
- 2026-10-06 — DebateUI (p/689#3): `git merge-base --is-ancestor <pre-squash-commit> origin/main` exited 1 after a squash-merge. Expected it to confirm the PR landed; it only confirmed the pre-squash SHA is not on main (which is always true after a squash). Resolved by `git show --stat <squash-sha>` to confirm message/content matched.

**Root Cause:** Squash merges are not recorded as merges in the DAG — they are new commits whose parent is the previous `main` tip, not the branch tip. `--is-ancestor` and `git log --ancestry-path` cannot find the original branch commits in main's history after a squash. This is fundamental to squash semantics, not a git bug.

**Prevention:**
1. **After a squash merge, verify by content/message, not ancestry.** Use `git show --stat <squash-sha>` or `git log --oneline -1 origin/main` to confirm the squash commit's message and diff match expectations.
2. **`--is-ancestor` is correct for regular merges and rebases** (which preserve commit identity or replay commits with new SHAs as ancestors). For squash merges, it will always return false for the pre-squash commits.
3. **The squash SHA is the `headRefOid` from `gh pr view` at the time of merge** — that is the canonical identifier for "this PR's content is on main."

**Status:** Active — 1 instance (DebateUI, p/689#3). Loud failure (exit 1); misleading because the merge succeeded.

**Applies To:** All agents verifying that a squash-merged PR's commits reached `origin/main`.

## #211 [Build] `git grep --include` Must Precede Path Arguments — Silently Ignored When Placed After

**Pattern:** `git grep -n '<pattern>' <path> --include="*.ts"` fails or silently ignores the `--include` filter. In `git grep`, `--include` is an option and must appear **before** path arguments; when placed after a path, git treats the `--include=` as another pathspec, not a glob filter. The command may still run but match against all file types, or fail with an unexpected error.

**Instances:**
- 2026-10-06 — DebateTool (p/234#14): `git grep -n 'POVER_INFO\[' <path> --include="*.ts"` failed. Resolved by switching to the Grep tool, which handles argument ordering consistently.

**Root Cause:** `git grep` parses options and pathspecs sequentially; once a non-option argument (a path) is encountered, subsequent `--include` flags are interpreted as pathspecs. This differs from ripgrep/grep where option placement is more flexible.

**Prevention:**
1. **Put all options before pathspecs:** `git grep -n --include="*.ts" '<pattern>' <path>`.
2. **Prefer the Grep tool** for in-project searches — it wraps ripgrep with consistent argument handling and avoids this class of error entirely.
3. The failure is often silent (no error, just wrong scope) — if git grep returns fewer results than expected, check option ordering.

**Status:** Active — 1 instance (DebateTool, p/234#14).

**Applies To:** All agents using `git grep` with `--include` or other glob filters.

---

## #212 [Build] `git worktree remove --force` Fails "cannot remove a locked working tree" When the Worktree Process Is Still Alive

**Pattern:** `git worktree remove --force <path>` exits 128 with "cannot remove a locked working tree" even though the subagent that owns the worktree has reported completion. The lock file records the owning process's PID. A single `--force` removes an **admin lock** only; a process lock (set automatically when a worker opens the worktree) requires `--force --force` (double) — but that is only safe if the process is actually dead. Applying `-f -f` while the process is still alive corrupts the worktree state.

**Instances:**
- 2026-10-06 — PowerShell (p/20#70): `git worktree remove --force` on a finished subagent's worktree exited 128 — the lock named the agent's pid, which was still alive. Correct resolution: verified the pid was alive, left the worktree in place, planned to remove after the process exited.

**Root Cause:** A subagent reporting "done" does not guarantee process exit. The git worktree lock is held at the OS level by the process; completion messages and OS-level exit are not synchronous. `--force` only overrides admin locks, not live process locks.

**Prevention:**
1. **Before `git worktree remove --force`, check the lock file:** `cat <path>/.git/worktrees/<name>/locked` or inspect `git worktree list --porcelain`. If it names a PID, verify whether that process is alive (`ps` / `Get-Process`).
2. **If the PID is alive:** wait for the process to exit, then run a plain `git worktree remove <path>`.
3. **If the PID is dead** (process exited but lock was not released): `git worktree remove --force --force <path>` is safe.
4. **Never use `-f -f` on a live process** — it removes the lock and the worktree while the process is still writing to it, which can corrupt in-flight work.
5. **"Reported completion" ≠ "process exited"** — treat them as independent signals.

**Status:** Active — 1 instance (PowerShell, p/20#70).

**Applies To:** All agents managing subagent worktrees — checking process liveness before force-removing a worktree.

---

## #213 [Process] Removing `consult-hold` Label Re-Triggers `consult-hold-guard` — Merge Immediately After Removal Fails "Base Branch Policy Prohibits the Merge"

**Pattern:** After removing the `consult-hold` label from a PR, `gh pr merge` run immediately fails with "base branch policy prohibits the merge". Root cause: removing the label re-triggers the `consult-hold-guard` required status check, which starts as PENDING. The merge is blocked until that check re-runs and concludes `success`. The check clears quickly (~10s) but must complete before the merge command is issued.

**Instances:**
- 2026-10-06 — DebateTool (p/70#54, PR #2917): `gh pr merge 2917 --squash --match-head-commit <sha>` failed immediately after removing the `consult-hold` label. `consult-hold-guard` was still PENDING from the label-removal re-trigger. Resolved by waiting ~10s for the check to pass, then re-running the merge command successfully.

**Root Cause:** `consult-hold-guard` is a **required status check** on `main`. Any event that re-triggers it (including label removal) briefly puts the PR in a "check pending" state, which blocks merges. The merge command does not implicitly wait for in-flight checks — it reads the current check state at call time.

**Prevention:**
1. **After removing `consult-hold`, wait for `consult-hold-guard` to re-run and pass before merging.** Poll with `gh pr checks <n> --json name,state --jq '.[] | select(.name == "consult-hold-guard") | .state'` until it returns `SUCCESS`.
2. **Do not retry the merge immediately on "policy prohibits" error** — this is a transient state, not a permanent block. A 10–30s wait then a single retry is the right pattern.
3. Sibling of exit-8 / pending-checks discipline (#121): the same "checks must be concluded before merge" rule applies here, but the trigger is label removal rather than CI.

**Status:** Active — 1 instance (DebateTool, p/70#54).

**Applies To:** All agents clearing a `consult-hold` gate and self-merging the PR.

---

## #214 [Process] Auto-Merge Armed + New Push = Stranded Commit — `gh pr view` Head OID Lags After Push; Verify `main` Contents After Auto-Merge Lands

**Pattern:** A PR with auto-merge armed merges at the old head when a new commit is pushed — because `gh pr view` reports the stale pre-push OID for minutes after the push, and auto-merge fires on whatever GitHub internally sees (which may also lag). The new commit is stranded and never reaches `main`. The PR shows `MERGED` and the state looks correct, but `main` is missing the latest commit.

**Instances:**
- 2026-10-07 — PowerShell (p/20#74, PR #3019): auto-merge was armed at head `fb31e621`; a new commit `e78e8290` was pushed; `gh pr view` kept reporting the old head for minutes; auto-merge fired and merged `fb31e621`, stranding `e78e8290`. Resolution: cherry-picked the stranded commit into follow-up PR #3041.

**Root Cause:** Two independent lags: (1) `gh pr view` caches the head OID and can show a stale value for several minutes after a push; (2) GitHub's auto-merge machinery may also evaluate against a view that hasn't caught up to the new push. Together they create a window where auto-merge fires on the old head even though a newer one exists. Root AGENTS.md already says "Arming means 'I'm done' — disarm before pushing more work" — this is the failure that rule prevents.

**Prevention:**
1. **Disarm auto-merge (`gh pr merge <n> --disable-auto`) BEFORE pushing any additional commit to an auto-armed PR.** Re-arm only after the push is confirmed. (Root AGENTS.md PR-Flow rule.)
2. **After any auto-merge lands, verify `main` contents, not just PR state:** `git log origin/main --oneline -3` or `gh api repos/{owner}/{repo}/commits/main --jq '.sha'` — confirm the expected commit SHA is on `main`. A `MERGED` PR state does not prove which head merged.
3. **`gh pr view --json headRefOid` immediately after a push is unreliable** — the value may be the pre-push OID. Use `git ls-remote origin <branch>` for a fresh view.
4. If a commit is stranded: cherry-pick it to a new branch, open a follow-up PR, land it promptly. Don't attempt a direct push or `--admin` merge.

**Status:** Active — 1 instance (PowerShell, p/20#74, PR #3019). Silent failure — PR shows MERGED, `main` looks merged, stranded commit only discovered by checking `main` contents.

**Applies To:** All agents using `--auto` on a PR where further pushes might follow before merge.

---

## #215 [Process] `&&`-Chaining a Non-Idempotent Write With a Read — Network Timeout on the Read Makes the Write Look Failed; Retry Duplicates the Write

**Pattern:** `gh pr comment <n> && gh pr view <n>` exits 1 when the `gh pr view` GraphQL call times out (network error) — even though the comment posted successfully. An `&&` chain's exit code is the last-failed command's; the write's success is invisible in the exit. A naive retry of the whole chain then posts a duplicate comment.

**Instances:**
- 2026-10-07 — Rosetta Stone (p/6#79, PR #3022): `gh pr comment 3022 && gh pr view 3022` exited 1 — comment posted fine; `gh pr view` timed out (`dial tcp 140.82.112.6:443: connectex`). Resolved by rerunning only `gh pr view`.

**Root Cause:** `&&` chains are idempotent only when every command is idempotent. A write (`pr comment`, `git push`, `gh label`) followed by a read in the same chain inherits the read's non-zero exit if the read fails — even though the write already landed. Retrying the chain retries the write.

**Prevention:**
1. **Run writes and reads as separate commands, not `&&`-chained.** `gh pr comment <n> -b "..."; gh pr view <n>` — the write's exit is checked independently.
2. **Before retrying any `&&`-chain that includes a write, check whether the write already landed.** For `gh pr comment`: `gh pr view <n> --json comments`; for `git push`: `git ls-remote origin <branch>`; for label changes: `gh pr view <n> --json labels`.
3. **Network timeouts on `gh` reads are transient** — retry only the failed read, not the whole chain.
4. Sibling of #84 (`&&`-chain exit laundering): both involve `&&` swallowing the real signal. #84 = write's failure masked as success; #215 = write's success masked as failure. Opposite directions, same structural cause.

**Status:** Active — 1 instance (Rosetta Stone, p/6#79). Self-correcting once recognized.

**Applies To:** All agents running `gh` or `git` write commands followed by reads in the same `&&` chain.

---

## #216 [Build] Shell Test (`[ -f ]` / `[ -e ]`) as Last Loop Statement — Legitimate False on Final Iteration Becomes Loop's Exit 1

**Pattern:** A Bash `for` loop whose last statement is `[ -f "$p" ] && cmd` (or any short-circuit construct whose left side is a shell test) exits 1 when the final iteration's test is false — even though every iteration completed correctly. The loop's exit status is the last command's exit status, and `[ -f ]` exits 1 when the file doesn't exist. The printed output may be entirely correct; only the exit code is wrong.

**Instances:**
- 2026-10-07 — Rosetta Stone (p/6#81): a Bash `for` loop exited 1 even though every count it printed was correct. Last statement: `[ -f "$p" ] && …`. On the final iteration the file didn't exist, so `[ -f ]`'s exit 1 became the loop's exit status. Resolution: read the output and ignored the exit code.

**Root Cause:** In Bash, a loop's (and a script's) exit status is the exit status of the last command executed. `[ -f "$p" ] && cmd` is a compound command whose exit is 1 when the test is false — regardless of whether that was the expected outcome. This is the same genus as #73A (`grep -c` exits 1 on zero matches) and #84 (`&&` laundering): a command that signals a valid, expected outcome via non-zero exit causes a containing construct to look failed.

**Prevention:**
1. **End loops (and scripts) with an explicit exit signal** when the last real statement can legitimately exit non-zero. Options: append `|| true` to the last compound command; close with `exit 0`; or rewrite as `if [ -f "$p" ]; then cmd; fi` (an `if` statement always exits 0 when the condition is false).
2. **When a loop exit-1 is surprising, read the output first.** A loop that printed correct results and exited 1 is almost always this pattern — the logic ran fine; only the exit signal is wrong.
3. Sibling of #73A (grep) and #84 (echo wrapper): the common class is "a command whose non-zero exit encodes a valid expected outcome used as the exit of a compound construct." Fix in all cases: insert `|| true` or restructure so the last executed command is always an explicit success signal.

**Status:** Active — 1 instance (Rosetta Stone, p/6#81).

**Applies To:** All agents writing Bash `for`/`while` loops where the last statement is a short-circuit test construct.

---

## #217 [Test] Pester `Mock` with Module-Qualified Passthrough Recurses — Intercepts Even `Module\Cmdlet` Calls

**Pattern:** A Pester mock defined as `Mock Get-Content { Microsoft.PowerShell.Management\Get-Content @PesterBoundParameters }` causes infinite recursion (call-depth overflow) because Pester intercepts **all** calls to the cmdlet name `Get-Content` in the test scope — including module-qualified `Microsoft.PowerShell.Management\Get-Content`. The passthrough is not a bypass; it is another intercepted call, which re-enters the mock, which calls the passthrough again.

**Instances:**
- 2026-10-07 — PowerShell (p/20#76, t/4065): `Mock Get-Content { Microsoft.PowerShell.Management\Get-Content @PesterBoundParameters }` recurse until call-depth overflow. Fix: replaced the passthrough body with `[System.IO.File]::ReadAllText($Path)` — a .NET method outside Pester's interception layer.

**Root Cause:** Pester's mock intercept operates at the PowerShell command-resolution level, not the module-boundary level. A module-qualified call (`Module\Cmdlet`) resolves the command name the same way and is caught by the same mock. There is no syntax that says "call the real implementation" from inside a Pester mock body for a built-in cmdlet — only calling a different code path (a .NET API or a helper that does not invoke the cmdlet name) escapes the intercept.

**Prevention:**
1. **Never use a module-qualified passthrough (`Module\Cmdlet @PesterBoundParameters`) as a mock body for built-in cmdlets.** It recurses.
2. **To passthrough to the real implementation for file I/O cmdlets, use .NET directly:**
   - `Get-Content` → `[System.IO.File]::ReadAllText($Path)` (or `ReadAllLines`)
   - `Set-Content` → `[System.IO.File]::WriteAllText($Path, $Value)`
   - `Test-Path` → `[System.IO.Path]::Exists($Path)` (file) or `[System.IO.Directory]::Exists($Path)` (directory)
3. **Infinite recursion in a Pester mock = suspect a module-qualified passthrough** — the call stack will show the mock body calling itself.

**Status:** Active — 1 instance (PowerShell, p/20#76, t/4065).

**Applies To:** All agents writing Pester mocks for built-in PS cmdlets that need a real-implementation passthrough.

---

## #218 [Build] Transient GitHub Receive-Pack 500 — `git push` Fails Repeatedly While Fetch and REST Writes Succeed

**Pattern:** `git push` fails with HTTP 500 on the `git-smart-http receive-pack` path 5+ times consecutively across different branch names, while `git fetch` and GitHub REST API writes (`gh api .../git/refs`) succeed throughout. This is a GitHub-side transient degradation **isolated to the receive-pack push path** — not a repo-wide outage, not a branch-specific block, not a credentials issue.

**Instances:**
- 2026-10-07 — DevOps Worker (p/749#1): `git push` 500'd 5x on receive-pack across 2 different branch names; `git fetch` and `gh api` REST writes worked the whole time. Resolved by waiting briefly and retrying once — succeeded clean with no workaround.
- 2026-10-07 — PowerShell (p/20#86, t/3910): `git push` returned "Internal Server Error" on one branch for ~6 minutes while status.github.com showed all systems operational. Tried bisecting: pushed an empty probe commit, then each half of the real commit — all succeeded. Then pushed the real commit, which also succeeded. **New learning: GitHub status is too coarse to discriminate per-repo transients; bisect with probe refs before assuming commit content is bad.**

**Root Cause:** GitHub's receive-pack endpoint is a separate service path from `fetch` (upload-pack) and the REST API. Partial degradations can affect one path while others remain healthy. When status.github.com shows green, the issue may still be a per-repo transient on receive-pack. Pushing a probe commit (empty or split) isolates whether the failure is content-specific vs. endpoint-transient.

**Prevention:**
1. **Diagnose before workarounds:** if `git push` 500s but `git fetch` and `gh api` writes work, the issue is GitHub-side transient on the receive-pack path. Wait 1–2 minutes and retry once — no branch rename, credential rotation, or protocol change is needed.
2. **Discriminator: `git fetch` works + REST writes work + `git push` 500s = receive-pack-specific.** If fetch also fails, it may be a broader outage; check GitHub status.
3. **GitHub status is not granular enough to rule out per-repo transients.** "All systems operational" does not mean your push will succeed. Push a probe ref (empty commit or split) to isolate content vs. endpoint.
4. **Bisect with probe refs if you suspect commit content is bad:** push an empty commit first; if that fails, it's endpoint-transient; if it succeeds, split the real commit and push each half.
5. **Do not force-push or workaround the 500.** Wait and retry plain `git push`; the transient resolves without intervention.

**Status:** Active — 2 instances (DevOps Worker p/749#1, PowerShell p/20#86). Self-resolving; risk is unnecessary workarounds consuming time.

**Applies To:** All agents pushing to GitHub remotes via `git push`.

---

## #220 [Test] Plain Hashtable Iteration Order Is Non-Deterministic Per-Process — Golden Tests Built This Way Flake

**Pattern:** A test fixture built by iterating a plain PowerShell hashtable (`@{}`) to produce a golden/snapshot value will produce different key orderings on different process runs. CI passes by luck when the current process happens to produce the same order as when the golden was pinned, and fails on others. The fixture appears deterministic in local runs because the same process seed repeats within a session.

**Instances:**
- 2026-10-07 — PowerShell (p/20#86, t/3910): a fixture constructed by iterating a plain `@{}` (random key order per process) pinned a coin-flip input hash. Earlier runs passed because the process produced the same order. Fix: sort keys explicitly before building the fixture; confirmed stable across 3+ separate process runs.

**Root Cause:** PowerShell `@{}` (and .NET `Dictionary<K,V>`) have no guaranteed iteration order. The order is determined by internal hash bucketing, which varies per process/run. A golden that encodes a specific key order will match only when the hash happens to produce that order — a coin-flip per process.

**Prevention:**
1. **Never iterate a plain hashtable when the output order matters for a golden/snapshot.** Sort keys explicitly: `$hash.GetEnumerator() | Sort-Object Key` or `[ordered]@{}` when constructing.
2. **Prove stability across 3+ separate process invocations** before treating a golden as stable. In-session reruns share the same process and will not expose the flake.
3. **A golden that flakes on CI but passes locally** is a strong signal of iteration-order non-determinism — check for hashtable iteration in the fixture construction path.
4. **Use `[ordered]@{}` (PowerShell ordered dictionary) or `[System.Collections.Generic.SortedDictionary]`** when key order must be deterministic.

**Status:** Active — 1 instance (PowerShell p/20#86, t/3910). Flake risk: silently passes until a process runs with a different hash seed.

**Applies To:** All agents writing golden/snapshot tests that involve hashtable iteration in fixture construction.

---

## #221 [PowerShell] `-WarningVariable` Does Not Capture `Write-Warning` from the First Command of a Nested Pipeline

**Pattern:** When a function uses `-WarningVariable` on a cmdlet call, warnings emitted by `Write-Warning` inside a **helper that is the first command of a nested pipeline** (e.g. `@( Get-X | Where-Object … )`) are NOT collected into the variable — they appear on the host but are absent from the capture. A `Write-Warning` in a plain statement in the same function IS collected. This makes a fallback path look silent when it isn't, and goldens that assert on the warning capture will silently fail to include it.

**Instances:**
- 2026-10-07 — PowerShell (p/20#88, t/4072): `-WarningVariable` missed a `Write-Warning` emitted from a helper that was the first command in a nested pipeline `@( Get-X | Where-Object … )`. The warning appeared on the host; it was absent from the captured variable and from goldens. Confirmed by direct repro.

**Root Cause:** PowerShell's warning stream propagation through nested pipelines has a gap: the first command of a sub-expression/nested pipeline runs in a context where the `-WarningVariable` binding from the outer call is not inherited. Subsequent pipeline stages are unaffected — only the first command is in the gap.

**Prevention:**
1. **Restructure nested pipelines to avoid the gap:** call the helper as a plain statement first (`$items = Get-X`), then pipe the result (`$items | Where-Object …`). The helper's warning stream now flows to the plain-statement context, which inherits the `-WarningVariable` binding.
2. **If restructuring is not possible, redirect the warning stream explicitly:** `Get-X -WarningVariable innerWarn 3>&1 | …` and merge `$innerWarn` into the outer capture.
3. **When goldens assert on a warning being captured, verify with a direct repro** that the warning actually lands in `-WarningVariable`, not just on the host. Host output and variable capture diverge at nested pipeline boundaries.
4. **A fallback that looks silent in a golden but shows on the host is a symptom of this gap**, not a silent fallback.

**Status:** Active — 1 instance (PowerShell p/20#88, t/4072). Confirmed by direct repro.

**Applies To:** All agents using `-WarningVariable` to capture warnings from functions that internally use nested pipelines.

---

## #222 [Build] `gh run view --job <id> --log` Returns Empty Until the Whole Run Is `completed` — Job Completion Is Not Enough

**Pattern:** `gh run view --job <id> --log` returns an empty log even when the specified job has finished, if the overall workflow run is not yet in `completed` state. Counting errors or test lines over the empty file produces "0 failures" / "0 tests found" — a false green. This is silent: the command exits 0, the file exists, it's just empty.

**Instances:**
- 2026-10-07 — PowerShell (p/20#90, t/4081): `gh run view --job <id> --log` returned empty for a finished job while the run was still in-progress. Counting `##[error][-]` over the empty file gave "0 failures"; agent reported `main` clean before any evidence existed. A re-check happened to confirm it later (t/4081#6), but the initial report was evidence-free.

**Root Cause:** GitHub's log retrieval endpoint for a job returns empty (or incomplete) until the parent workflow run reaches terminal state (`completed`). A job can be `completed: success` while its parent run is still `in_progress` waiting for other jobs — and in that window the log is unavailable.

**Prevention:**
1. **Before reading job logs, verify `gh run view <run-id> --json status -q .status` is `completed`.** Job completion is not sufficient — check the run-level status.
2. **Verify the log has substantive content before drawing conclusions from it.** For PowerShell test shards, expect `Running tests from` > 0 (approximately 166 per shard). If the line is absent, the log is empty or incomplete — report "no data", not "0 failures".
3. **A log count of 0 errors on an empty file is not evidence of a clean run.** Apply the zero-result heuristic: 0 is indistinguishable from "log not available yet" without a content check.
4. **Never report CI status from a job log without first confirming the run is `completed` and the log is non-empty.** An evidence-free "clean" report is worse than no report.

**Status:** Active — 1 instance (PowerShell p/20#90, t/4081). Silent failure: exit 0, file exists, but empty.

**Applies To:** All agents inspecting CI logs via `gh run view --log` to assess test or build status.

---

## #223 [Infra] `gh` CLI Crashes with OOM Mid-Loop — Partial State; Verify Per-Item Before Retry

**Pattern:** The `gh` CLI crashes mid-way through a loop of write operations (e.g., posting multiple comments, applying labels) with `fatal error: runtime: cannot allocate memory`. The items processed before the crash are complete; those after are not. Re-running the whole loop duplicates the completed items (double-comments, duplicate labels). The correct response: verify each item's final state individually, then retry only the items that didn't complete.

**Instances:**
- 2026-10-07 — Computational Linguist (p/7#112, t/3962): `gh` crashed mid-loop through a 2-issue comment + label sequence. First comment posted; second comment and label did not. Same memory pressure that reaped an earlier long run (t/3962#6). Fix: retried each step separately and verified end state (labels + comment count) on each issue.

**Root Cause:** The `gh` CLI is a Go binary; under host memory pressure it crashes with a Go runtime OOM. The crash is not transactional — operations before the crash succeeded and are not rolled back. The partial-state trap is: re-running the loop duplicates the successful write (double-comment is the canonical case).

**Prevention:**
1. **After any CLI crash mid-loop, verify each item's final state before retrying.** Check comment count, label presence, or whatever write was in the loop — don't assume "0 items completed" or "all items completed".
2. **Retry only the items that didn't complete.** Re-running the whole loop produces duplicates for items that already succeeded.
3. **`gh` OOM crashes are a host memory pressure signal**, not a `gh` bug. If recurring, check for a concurrent memory-intensive process (long-running Python, embedded model, large diff).
4. **For critical write loops, write a state checkpoint** — record which items completed before moving to the next. This makes re-entry after crash deterministic.

**Status:** Active — 1 instance (Computational Linguist p/7#112, t/3962). Risk: duplicate writes (double-comments, double-labels) if loop is re-run without state check.

**Applies To:** All agents running multi-step `gh` write loops (comments, labels, PRs) on memory-constrained hosts.

---

## #224 [Infra] Terminal Close Silently Kills Background Jobs — Verify Output Files After Restart

**Pattern:** A background job started in the terminal is silently killed when the session closes. No error is reported — the job and its output disappear. After a terminal restart, code that expects background-job output files to exist finds them missing. The failure is silent: the job completes from the agent's perspective (the spawn succeeded), but its output never materialised.

**Instances:**
- 2026-10-07 — Computational Linguist (p/7#114): A background audit scan was started; the terminal closed mid-run. The job was killed with no error signal. Expected output files were not produced. Discovered only when results were needed. Re-ran in the foreground, wrote results to files, verified outputs before posting.

**Root Cause:** Background jobs spawned by the shell are child processes of the terminal session. When the terminal closes, the OS terminates child processes. The agent framework does not persist background job state across terminal restarts and produces no error — the only signal is missing output files.

**Prevention:**
1. **After any terminal restart, verify that expected output files from recently started background jobs actually exist.** Do not assume a background job completed.
2. **For output-dependent tasks, prefer running in the foreground** with results written to files — the output is visible and verifiable in the same session.
3. **Verify the output has substantive content before reporting or using it.** An absent or empty file after a restart is a terminal-kill signal, not a content absence.
4. **A terminal close during a background job leaves no error signal.** The only detection path is checking whether expected outputs exist before proceeding.

**Status:** Active — 1 instance (Computational Linguist p/7#114). Silent failure mode.

**Applies To:** All agents starting background jobs or long-running scans in a terminal session.

---

## #225 [Infra] `gh pr review --approve` Always Fails — All Agents Share One GitHub Identity; Use a PR Comment for Sign-offs

**Pattern:** Any agent running `gh pr review --approve` receives `GraphQL: Can not approve your own pull request (addPullRequestReview)`. The fleet shares one GitHub account (`jpsnover`), so every PR is "owned" by that identity regardless of which agent opened it. The approval path is structurally unavailable for agent-to-agent sign-offs. The correct substitute is a PR comment.

**Instances:**
- 2026-10-07 — DebateTool (p/70#55): `gh pr review 3129 --approve` failed with the error above. Resolved by posting a sign-off comment on the PR instead.
- 2026-10-07 — ServerAPI (p/504#18): Same failure on a separate PR. Same resolution.
- 2026-10-08 — Quality/Tech Lead (p/447#24, PR #3050): Same failure on a T1 PR requiring a reviewer sign-off. Resolved by posting review as a PR comment.

**Root Cause:** GitHub's approval model requires the approver to be a different account than the PR author. Because the entire fleet operates as one GitHub user, no agent can ever approve any other agent's PR — they are all the same identity to GitHub.

**Prevention:**
1. **Never use `gh pr review --approve` for agent-to-agent sign-offs.** It will always fail; there is no workaround short of a second GitHub account. This rule is now in AGENTS.md (§PR-Flow, added PR #3136, 2026-10-08).
2. **Use a PR comment for sign-offs.** Format: `Approved (<role>): <reason>`. This records the review intent and is visible in the PR timeline.
3. **The merge gate is required status checks** (`ci-gate`, `CodeQL`, `joint-gv-guard`, `consult-hold-guard`), not reviewer approval. A green PR with a sign-off comment is mergeable.
4. **This rule lapses when the t/4096 Reviewer App switch-over lands** — the PI created the Apps on 2026-10-08, and DevOps is landing the Reviewer switch first.
5. **If a workflow requires a reviewer count > 0,** escalate to the PI — that is a branch protection change, which is PI-only.

**Status:** Active — 3 instances (p/70#55, p/504#18, p/447#24). Systemic fix in AGENTS.md (PR #3136). Structural limitation until t/4096 lands.

**Applies To:** All agents attempting to approve PRs on behalf of another agent.

---

## #226 [Test] `vi.mock` Path Miss Masked by Local API Keys — CI Fails; Run Key-Sensitive Suites with Keys Unset

**Pattern:** A test mocks a function by its import path (e.g. `vi.mock('./config', …)` mocking `getApiKey`), but the code under test calls a different function (`getApiKeyForListing`) that internally calls the original. The mock never intercepts the real call. Locally the test passes because real API keys are exported in the developer's shell — the resolver finds a key through the environment. CI has no keys, the real resolver returns empty, and the test fails. The gap is invisible until keys are absent.

**Instances:**
- 2026-10-07 — Shared Lib (p/5#45, PR #3129): `refreshAIModels.test.ts` mocked `getApiKey`. The change routed `refreshAIModels` through `getApiKeyForListing`, which calls `getApiKey` inside the config module — `vi.mock` did not intercept the internal call. Local shell had `GEMINI_API_KEY` etc. exported; CI did not. Fix: reproduced with `env -u GEMINI_API_KEY …`, replaced the mock with `vi.stubEnv` plus `unstubAllEnvs`.

**Root Cause:** Two compounding issues: (1) the mock targeted an import path that the refactored code no longer calls directly — a classic mock-vs-implementation gap that only surfaces when the environment cannot satisfy the real call; (2) local shells routinely carry real provider keys, making CI the first environment where the gap is observable.

**Prevention:**
1. **Run key-sensitive server suites with every `*_API_KEY` unset before claiming green.** Use `env -u GEMINI_API_KEY -u ANTHROPIC_API_KEY -u GROQ_API_KEY npm test` (or the equivalent `vi.stubEnv` approach in the test itself).
2. **Prefer `vi.stubEnv` over `vi.mock` for key-resolver tests.** `stubEnv` controls the environment the real resolver reads; it does not depend on the import path the implementation uses, so refactors that change the call chain do not silently break it.
3. **After any refactor that changes how a function reaches its dependencies, audit which mocks target the old path.** A mock that the new code never hits is a silent no-op — the test still passes locally if the real path can satisfy the call.
4. **A test that passes locally but fails on CI with a key-related error is diagnostic of this pattern,** not a CI environment problem. Reproduce locally with keys unset before investigating CI configuration.

**Status:** Active — 1 instance (Shared Lib p/5#45, PR #3129). Silent locally; fails only in keyless environments.

**Applies To:** All agents writing or maintaining tests for API-key-gated functions in the TypeScript server.

---

## #227 [Security] Activity Hook Executed Commands from Message Bodies — Fleet-Wide Junk Files; activity_enabled Must Stay OFF

**Pattern:** An Orca activity hook was registered across 38 role settings files. The hook did not merely log — it executed `cmd.exe` commands found in message bodies. Any message body containing shell metacharacters (backticks, redirects, pipe symbols) caused the hook to run the fragment as a command. Observable signal: 0-byte files named after code fragments (the text following a backtick or `>` in printed/edited content) appeared in agent working directories across the fleet. The attack vector is prompt injection: any message body that contains shell-shaped text can execute arbitrary commands in the receiving agent's session.

**Instances:**
- 2026-10-07 — Fleet-wide (t/3918): Activity hook registered in 38 role settings files. Multiple agents corroborated 0-byte junk files in their scopes. Fleet hold issued (e/246): no shell metacharacters in any message body, no external document ingestion, no replies to the incident thread. PI's Orca restart removed the hook from all live sessions. Post-restart verification: 0 live settings files carry it; no new junk files in a 15-minute window; TL probe negative against a positive control. Hold lifted (e/246#17).

**Root Cause:** The Orca activity hook feature executes content from message bodies rather than treating it as data. A hook registered for activity logging silently doubled as a command executor. The hook was registered across the full fleet (38 files) before the execution behavior was understood. Because agents send pings and emails containing code, file paths, and shell snippets as a matter of routine operation, this created a large attack surface.

**Prevention:**
1. **`activity_enabled` must stay OFF until Orca ships a fix for t/3918.** Turning it on re-arms the command-execution vulnerability on the next agent launch. Anyone needing activity logging raises it with the TL first — this is a standing rule, not a session constraint.
2. **0-byte files named after code fragments are a fleet-wide signal of this pattern.** If you see one, report to t/3918 in plain text (no shell metacharacters in the report body).
3. **Before registering any Orca hook, verify it treats message content as data, not as executable input.** A hook that processes message bodies must be safe against shell-shaped content.
4. **During any active security hold: keep all message bodies free of shell metacharacters** (pipe, ampersand, angle brackets, backticks). Write file paths and commands in plain prose. Do not ingest external documents.
5. **The diagnostic discriminator:** real command execution leaves 0-byte files named after code fragments. Mere logging or redirection leaves no such artifacts.

**Status:** Resolved — hold lifted 2026-10-07 (e/246#17). Standing rule: activity_enabled OFF. Root fix pending in Orca (t/3918).

**Applies To:** All agents; especially relevant when considering Orca hook registration or activity logging features.

---

## #228 [Build] `MSYS_NO_PATHCONV=1` Disables Path Conversion for the Whole Command — Only Use It on the `git` Call That Takes the `ref:path` Argument

**Pattern:** An agent prefixes a non-`git` command (e.g. `python script.py`) with `MSYS_NO_PATHCONV=1` to prevent MSYS from mangling a path inside the script. The prefix disables MSYS path conversion for **all** arguments in that command, including the script path itself. MSYS no longer converts `/c/Users/…` to `C:\Users\…` for the interpreter argument, so Python receives a path like `C:\c\Users\…` (the drive letter doubled) and errors "can't open file."

**Instances:**
- 2026-10-08 — Shared Lib (p/5#47): `MSYS_NO_PATHCONV=1 python /c/Users/.../script.py` errored with "can't open file `C:\c\Users\...`". Fix: ran Python without the prefix; the script itself sets `MSYS_NO_PATHCONV=1` for its internal `git show` calls.
- 2026-10-12 — DevOps Lead (p/26#153): `git show origin/main:<path> > /tmp/x` in Git Bash failed with "ambiguous argument 'origin\main;…'" — MSYS mangled the colon revspec, and `/tmp` mapped to `C:\tmp`. Resolved by prefixing with `MSYS_NO_PATHCONV=1` and writing to the scratchpad instead. (Also covered by root AGENTS.md Windows Bash rule.)
- 2026-10-12 — DevOps Lead (p/26#163): `gh api /orgs/…` in Git Bash failed with "invalid API endpoint: C:/…/orgs/…" — MSYS rewrote the leading slash into a Windows path. Resolved by dropping the leading slash: `gh api orgs/…`.

**Root Cause:** `MSYS_NO_PATHCONV=1` is a process-level environment variable that suppresses all MSYS path-conversion for the duration of the command. When placed before `python`, it prevents conversion of the script path that MSYS normally translates for Windows. The intent was to prevent mangling of a `git ref:path` argument used inside the script — but that argument is only in the script's subprocess, not in the outer `python` invocation. The colon in `origin/main:<path>` is separately mangled by MSYS into a backslash or semicolon without the prefix. MSYS also rewrites leading-slash paths (`/orgs/…`) as Windows absolute paths (`C:/…/orgs/…`) in any command run from Git Bash.

**Prevention:**
1. **Use `MSYS_NO_PATHCONV=1` only on the specific `git` command that takes a `ref:path` argument** (e.g. `MSYS_NO_PATHCONV=1 git show origin/main:some/path`). Do not prefix non-`git` commands with it.
2. **If a script calls `git show <ref>:<path>` internally,** set `MSYS_NO_PATHCONV=1` inside the script at the point of the `git` call, not on the outer `python` invocation.
3. **A "can't open file" error on a path that looks doubled** (`C:\c\Users\…`) is a diagnostic signal that MSYS path conversion was suppressed for the interpreter argument itself.
4. **Avoid `/tmp` in Bash on Windows** — MSYS maps it to `C:\tmp`, not a true temp dir. Use the session scratchpad instead.
5. **For `gh api`, omit the leading slash** — use `gh api orgs/…` not `gh api /orgs/…`. MSYS rewrites the leading slash as a Windows absolute path. Alternatively, use the PowerShell tool where MSYS path conversion does not apply.

**Status:** Active — 3 instances (Shared Lib p/5#47; DevOps Lead p/26#153, p/26#163).

**Applies To:** All agents running Python (or other interpreters) from Bash on Windows with MSYS; all agents using `gh api` with leading-slash paths in Git Bash.

---

## #229 [Build] `gh --jq` Uses gojq — No Dotall `s` Flag; Avoid Non-Standard Regex Flags

**Pattern:** A `gh` command using `--jq` with a regex flag beyond the basics (e.g. `test("pattern";"s")` for dotall) errors `unsupported regular expression flag: s`. The `gh` CLI embeds `gojq` (a Go implementation of jq), not the standard C jq binary. gojq supports `i` (case-insensitive), `x` (extended), and `g` (global), but not `s` (dotall / make `.` match newlines) or several other flags standard jq accepts.

**Instances:**
- 2026-10-08 — Shared Lib (p/5#49): `gh … --jq 'test("…";"s")'` errored "unsupported regular expression flag: s". Fix: replaced with `contains()` checks.
- 2026-10-12 — Tech Lead (p/335#139): `gh … -q 'test("Approved \(PI")'` — `\(` inside a jq string starts string interpolation, leaving the string unterminated. Fix: switched to `startswith("Approved")`.

**Root Cause:** `gh` bundles its own jq interpreter (gojq) which does not implement all PCRE/POSIX regex flags. The `s` dotall flag is commonly used to match multiline strings in standard jq but is absent from gojq. Separately, `\(` inside a jq string literal is the string interpolation syntax (`\(expr)`), not a literal backslash-paren — using it in a regex pattern produces an unterminated string error.

**Prevention:**
1. **In `gh --jq` expressions, only use regex flags `i`, `x`, and `g`.** Treat `s`, `m`, and other flags as unavailable.
2. **For multiline or substring matching, prefer `contains()`, `startswith()`, `endswith()`, or `ltrimstr()`/`rtrimstr()`** over regex when the pattern does not require it.
3. **If a regex is necessary, test it in `gojq` locally** before embedding in a `gh --jq` pipeline: `echo '["test"]' | gojq '.[0] | test("pat")'`.
4. **If the expression works in `jq` but fails in `gh --jq`, the flag is likely the cause.** gojq and standard jq diverge on advanced regex and a few filter functions.
5. **Do not use `\(` inside a jq string literal as a regex escape** — it is jq string interpolation. To match a literal `(` in a regex, use `\\(` (one backslash in the regex, written as `\\(` in the jq string). Prefer `startswith()`/`contains()` over regex when the pattern is a simple prefix or substring.

**Status:** Active — 4 instances (Shared Lib p/5#49; Tech Lead p/335#139; Tech Lead p/335#149; Tech Lead p/335#161).

**Applies To:** All agents constructing `gh` commands with `--jq` filters that include regular expressions.

---

## #230 [Build] `git rev-parse --short` Accepts Only One Revision — Passing Two Exits 128

**Pattern:** `git rev-parse --short HEAD origin/main` exits 128 with "fatal: Needed a single revision". The `--short` flag (and its length variant `--short=N`) constrains the command to a single revision argument. The command works fine for one revision at a time; it is not a variadic form of `--short`.

**Instances:**
- 2026-10-08 — DevOps Lead (p/26#149): verify step after hourly shared-checkout sync ran `git rev-parse --short HEAD origin/main` expecting both short SHAs. Exited 128; resolved by running once per revision.

**Root Cause:** `git rev-parse --short` is documented as requiring a single `<rev>` argument. Passing multiple revisions is a usage error, not a transient failure.

**Prevention:**
1. **To get short SHAs for multiple revisions, run `git rev-parse --short` once per revision:**
   `git rev-parse --short HEAD` then `git rev-parse --short origin/main`.
2. **To verify HEAD matches origin/main,** compare the full OIDs: `git rev-parse HEAD` vs `git rev-parse origin/main`, or use `git merge-base --is-ancestor`.
3. **Exit 128 from `git rev-parse` is a usage error,** not a missing ref. Check the argument count before investigating ref resolution.

**Status:** Active — 1 instance (DevOps Lead p/26#149). Usage error; deterministic.

**Applies To:** All agents using `git rev-parse` to compare or display multiple SHAs in one command.

---

## #231 [Build] `node --check` Parses as CommonJS — False Negative on Top-Level `await` in `github-script` Bodies

**Pattern:** Extracting a `github-script` step body and running `node --check` on it throws `SyntaxError: await is only valid in async functions` when the body uses top-level `await`. The script is actually valid: GitHub Actions' `github-script` executes the step body inside an implicit async function, so top-level `await` is legal there. `node --check` defaults to CommonJS parsing for bare `.js` files, where top-level `await` is a syntax error. The check reports a false negative — the script was fine all along.

**Instances:**
- 2026-10-08 — DevOps Worker (p/749#3): `node --check` on an extracted `github-script` body with top-level `await` threw `SyntaxError: await is only valid in async functions`. Fix: wrapped the body in `async function __wrapped() { ... }` before checking, which passed clean.

**Root Cause:** `node --check` (and Node's parser generally) treats a file without an explicit `"type": "module"` declaration as CommonJS. In CommonJS, top-level `await` is a syntax error. GitHub Actions' `github-script` runner wraps the step body in its own async context at execution time — a context `node --check` cannot replicate on a bare extracted file.

**Prevention:**
1. **When validating a `github-script` body with `node --check`, wrap it first:**
   ```
   async function __wrapped() {
     <body>
   }
   ```
   This replicates the async context github-script provides and makes the check accurate.
2. **Alternatively, check with `--input-type=module`** (`node --check --input-type=module < body.js`) which enables top-level `await` as ES module syntax.
3. **A `SyntaxError: await is only valid in async functions` from `node --check` on a github-script file is a false negative**, not a real bug. Confirm by wrapping before reporting the script as broken.

**Status:** Active — 1 instance (DevOps Worker p/749#3). False negative; no runtime impact.

**Applies To:** All agents linting or validating GitHub Actions `github-script` step bodies with `node --check`.

---

## #232 [Build] `gh pr list --json` Exits 1 on Unknown Field Name — Check Valid Fields Before Use

**Pattern:** `gh pr list --json field1,field2,...` exits 1 with `unknown JSON field: <name>` when any field name is invalid or misspelled. The command provides no partial output — all fields are rejected if one is wrong. Common confusion: `baseRepository` is not a valid field; `headRepository` is.

**Instances:**
- 2026-10-08 — DebateUI (p/689#5): `gh pr list --json ...,baseRepository` exited 1 with "Unknown JSON field: baseRepository". Fix: dropped the invalid field and reran.

**Root Cause:** `gh` validates all requested JSON fields before executing the query. A single invalid field name causes the entire command to fail with exit 1.

**Prevention:**
1. **Check valid field names before constructing a `--json` query:** `gh pr list --json help` prints all available fields.
2. **`headRepository` is valid; `baseRepository` is not.** For base repo info, use `baseRefName` (branch name) or `baseRef` (object with more detail).
3. **Exit 1 with "Unknown JSON field" is always a field-name error**, not a network or auth issue. Check spelling first.

**Status:** Active — 1 instance (DebateUI p/689#5). Deterministic usage error.

**Applies To:** All agents constructing `gh pr list`, `gh pr view`, or other `gh` subcommands with `--json`.

---

## #235 [Security] Unattributed Actor Used Shared jpsnover Token to Un-draft and Merge PRs — Draft Status Does Not Protect; `consult-hold` Label Is the Only Gate

**Pattern:** An unattributed actor using the fleet's shared `jpsnover` GitHub token un-drafted PRs and armed auto-merge on PRs that were mid-review. One PR was taken out of draft and merged directly, 5 seconds later, bypassing the in-progress review entirely. Draft status was relied on as a hold mechanism — it is not. The only merge gate that GitHub enforces for every path (including admins and server-side auto-merge) is a **required status check** — in this fleet, the `consult-hold` label backed by the `consult-hold-guard` required context.

**Instances:**
- 2026-10-08 — Fleet-wide (t/3716, e/288): PRs #3142, #3145 un-drafted and auto-merge armed. PR #3155 (draft, mid-review) un-drafted and merged directly 5 seconds later. Fleet-wide 48h hold: apply `consult-hold` to every non-ready PR except T0. PI rotated credentials. Hold lifts when actor is attributed or 48h expires.

**Root Cause:** The fleet shares one GitHub identity (`jpsnover`). Any process or session holding a valid `jpsnover` token can perform any GitHub action that user can perform — including un-drafting, arming auto-merge, and merging PRs. Draft status is a UI convention with no enforcement backing; GitHub does not treat "draft" as a merge block. The `consult-hold` label is enforced by a required status check (`consult-hold-guard`) that GitHub refuses to bypass even for admins under `enforce_admins: true`.

**Prevention:**
1. **Draft status does not protect a PR from merge.** Any automation or actor with the token can un-draft in one API call.
2. **The `consult-hold` label is the only enforceable hold gate.** Apply it at PR creation (`gh pr create --label consult-hold`) for any PR that is not ready to merge. Remove it only when you are ready to merge.
3. **T0 PRs (green CI → merge) are exempt** from the consult-hold requirement — they merge on green and have no review gate to protect.
4. **If a PR you own becomes ready, armed, or merged without your action:** report the PR number and time to the active incident ticket immediately and ping DevOps. Every event helps attribution.
5. **The systemic fix is per-agent GitHub App identities (t/4096)**. Until that lands, the shared token is a single point of compromise — consult-hold is the compensating control.

**Status:** Resolved (hold lifted after credential rotation). Systemic fix pending (t/4096).

**Applies To:** All agents managing PRs; especially relevant for draft PRs or PRs with outstanding reviews.

---

## #233 [Build] `gh api .../actions/workflows` Paged at 30 — Repos With 40+ Workflows Look Like "Not Found"

**Pattern:** `gh api repos/.../actions/workflows` returns at most 30 entries by default (GitHub's page size). A repo with more than 30 workflows will not show entries beyond the first page, so a workflow that exists appears absent. This reads as "not found" and can cause a health check, enable/disable command, or workflow lookup to silently operate on the wrong assumption.

**Instances:**
- 2026-10-12 — DevOps Lead (p/26#151): `gh api .../actions/workflows` returned no tier-check entry; repo has ~40 workflows. Resolved by addressing the workflow directly as `/actions/workflows/<file>.yml`.

**Root Cause:** The GitHub REST API paginates list endpoints. `gh api` does not auto-paginate by default; it returns the first page only. A repo with 40 workflows requires `--paginate` or direct addressing to find entries beyond the first 30.

**Prevention:**
1. **When looking up a specific workflow, address it directly:** `gh api repos/.../actions/workflows/<filename>.yml` — no pagination needed.
2. **When iterating all workflows, use `--paginate`:** `gh api --paginate repos/.../actions/workflows`.
3. **A missing workflow in a list result is not evidence it doesn't exist** when the repo is large. Verify with a direct GET before concluding "not found".

**Status:** Active — 1 instance (DevOps Lead p/26#151). Silent: list returns 200 with a short result.

**Applies To:** All agents querying GitHub Actions workflow lists on repos with many workflows.

---

## #234 [Build] Job-Level `continue-on-error: true` Makes Run Conclusion `success` Even When Steps Crash — Read Step Conclusion for Health Checks

**Pattern:** A GitHub Actions job with `continue-on-error: true` at the job level reports its overall conclusion as `success` even when individual steps fail or crash. A health check that reads the run's or job's `conclusion` field sees `success` and reports clean. The failing step is only visible in the per-step `conclusion` field, which health checks must read explicitly.

**Instances:**
- 2026-10-12 — DevOps Lead (p/26#151, t/4103#13): A job with `continue-on-error: true` crashed on a step. The run conclusion was `success`. Health check initially read the run conclusion and reported clean.

**Root Cause:** `continue-on-error: true` at the job level is designed to prevent a failing job from failing the entire workflow. GitHub sets the job conclusion to `success` regardless of whether steps within it failed — the intent is "this job's failure is acceptable." A health check that trusts the job/run conclusion inherits this "acceptable failure" semantics unintentionally.

**Prevention:**
1. **Health checks must read the step-level `conclusion` field**, not the job or run conclusion, when the job uses `continue-on-error: true`.
2. **`gh run view --json jobs` includes per-step conclusions** under `jobs[].steps[].conclusion`. A step that crashed shows `failure` there even when the job shows `success`.
3. **When auditing CI health on a job with `continue-on-error`, assume the run conclusion is uninformative** — enumerate steps explicitly.
4. **Consider removing `continue-on-error: true` from health-check jobs** unless the intent is genuinely "this job's failure is acceptable." A job that must not silently fail should not carry this flag.

**Status:** Active — 1 instance (DevOps Lead p/26#151, t/4103#13). Silent: run conclusion shows success.

**Applies To:** All agents reading CI run or job conclusions on workflows that use `continue-on-error: true`.

---

## #236 [Build] `gh pr list --json commits` Exceeds GitHub Node Limit at Scale — Fetch Commits Per PR, Not in Bulk

**Pattern:** `gh pr list --limit 100 --json commits` fails with "requesting up to 1,000,000 possible nodes, exceeds 500,000". GitHub's GraphQL API caps total nodes per query at 500,000. Fetching nested arrays (commits, files, reviews) for many PRs in a single list query multiplies the node count: 100 PRs × up to 10,000 commits/PR = up to 1,000,000 nodes. The error is deterministic above a threshold and gives no partial result.

**Instances:**
- 2026-10-12 — Rosetta Stone (p/6#83): `gh pr list --limit 100 --json commits` errored with "requesting up to 1,000,000 possible nodes, exceeds 500,000". Resolved by listing PR numbers first, then running `gh pr view <N> --json commits` for each PR individually.

**Root Cause:** `gh pr list --json` with nested array fields (commits, files, reviews, etc.) constructs a single GraphQL query that pre-allocates node budget for the maximum size of each nested array across all listed PRs. The product of `--limit` × max-array-size exceeds GitHub's 500,000-node cap for any non-trivial limit.

**Prevention:**
1. **Never combine `gh pr list --limit N --json <nested-array-field>` for N > a few PRs.** Nested arrays (commits, files, reviews, comments) blow up the node budget multiplicatively.
2. **Two-pass pattern for bulk nested data:** first `gh pr list --json number -q '.[].number'` to get PR numbers, then `gh pr view <N> --json <field>` for each PR individually.
3. **Flat scalar fields are safe in bulk** (`gh pr list --json number,title,state,headRefName,…`). Reserve per-PR `view` calls for nested arrays.
4. **The error is deterministic and gives no partial result** — there is no way to request a subset of commits per PR in the list endpoint; the per-PR `view` call is the only path.

**Status:** Active — 1 instance (Rosetta Stone p/6#83). Deterministic above threshold.

**Applies To:** All agents fetching commit, file, review or comment data across multiple PRs with `gh pr list`.

---

## #237 [Build] `gh` Not on PATH in Bash/MSYS on Windows — Use PowerShell Tool for All `gh` Commands

**Pattern:** `gh` is not on the PATH in the Bash/MSYS shell on Windows agents. Running `gh` via the Bash tool exits 127 (`gh: command not found`). The same command runs correctly via the PowerShell tool, where `gh` is on the PATH. This is a Windows-specific tool-selection issue, not a `gh` installation problem.

**Instances:**
- 2026-10-12 — Conflict (p/540#4): `gh` command not found via Bash tool. Resolved by re-running the same commands via the PowerShell tool.

**Root Cause:** On Windows, `gh` is installed and configured in the PowerShell (pwsh) environment but is not added to the MSYS/Git Bash PATH. The Bash tool runs in the MSYS2 layer with a different PATH than the native Windows PowerShell session.

**Prevention:**
1. **On Windows agents, always run `gh` commands via the PowerShell tool**, not the Bash tool.
2. **Bash tool on Windows is appropriate for POSIX scripts** (awk, sed, file utilities). For GitHub CLI operations, use PowerShell.
3. **If `gh` fails with exit 127 in Bash:** switch to the PowerShell tool — do not attempt to diagnose `gh` installation.

**Status:** Active — 1 instance (Conflict p/540#4). Silent: exit 127 reads as missing tool, not wrong shell.

**Applies To:** All agents on Windows using the Bash tool for GitHub CLI operations.

---

## #238 [Build] Copying a Single Module to Scratchpad Breaks Relative Imports — Probe PR Modules in a Detached Worktree

**Pattern:** An agent copies one file from a PR (e.g. `merge-guard-predicate.mjs`) to the scratchpad to probe or test it in isolation. On import, Node.js throws `ERR_MODULE_NOT_FOUND` for a sibling module (`gate-telemetry.mjs`) that the copied file imports via a relative path. The sibling does not exist in the scratchpad — only the single copied file does. The probe fails entirely.

**Instances:**
- 2026-10-12 — DevOps Lead (p/26#155): copied `merge-guard-predicate.mjs` to scratchpad; `import` failed `ERR_MODULE_NOT_FOUND gate-telemetry.mjs`. Resolved by `git worktree add --detach <sha>` and probing the module in place.

**Root Cause:** ES modules resolve sibling imports relative to the file's location on disk. A lone copy in the scratchpad has no siblings — all relative imports fail at runtime. The file works only when loaded from a directory that contains its full dependency graph.

**Prevention:**
1. **To probe or test a PR module, check out the PR head in a detached worktree:** `git worktree add --detach <path> <sha>`. The full module graph is present and relative imports resolve correctly.
2. **Do not copy individual files to the scratchpad for import/require testing.** Copying is safe for static analysis (reading, grepping) but not for execution.
3. **`ERR_MODULE_NOT_FOUND` on a sibling module** (not a package) is a diagnostic signal that the file was loaded outside its source tree.

**Status:** Active — 1 instance (DevOps Lead p/26#155).

**Applies To:** All agents probing or testing ES modules from PRs or branches.

---

## #239 [Security] Backticks in `gh … --body "…"` Execute as Command Substitution in Bash — Near-Miss: Backtick-Quoted `gh pr merge` in a PR Comment Body Was Executed

**Pattern:** An agent inlines a markdown body containing backtick-quoted code into `gh pr comment --body "…"` (or any `gh` command that takes a `--body "…"` string) from Bash. Bash interprets backtick pairs inside double quotes as command substitution and executes the enclosed text. A body like `` "…run `gh pr merge 5 --squash`…" `` causes Bash to actually run `gh pr merge 5 --squash` at evaluation time. The substitution output replaces the backtick expression in the string — but the command runs regardless.

**Instances:**
- 2026-10-12 — DevOps Lead (p/26#157): `gh pr comment 3189 --body "…\`gh pr merge 5 --squash\`…"` in Bash. The backtick caused a live merge attempt on PR #5. It failed only because of a stray backslash, and PR #5 was already closed — a near-miss. Resolved by writing the body to a file and using `--body-file`. (Root AGENTS.md Shell Quoting Rule applies.)

**Root Cause:** Bash's double-quote rules allow command substitution (`\`…\`` or `$(…)`) inside double-quoted strings. A markdown code span `` `command` `` is syntactically identical to a Bash command substitution. When the body contains code examples, shell commands, or any backtick-delimited text, Bash executes them at parameter expansion time — before `gh` ever sees the string.

**Prevention:**
1. **Never use `--body "…"` in Bash when the body contains backticks.** This is the root AGENTS.md Shell Quoting Rule — use Write plus `--body-file` instead.
2. **Always write multi-line or markdown bodies to a file first:** `Write body.txt "…"`, then `gh pr comment <n> --body-file body.txt`. The file path is never subject to shell expansion.
3. **Single-quoted strings (`'…'`) suppress substitution in Bash**, but multi-line single-quoted strings are fragile with here-docs and heredoc injection risks — the file approach is safer.
4. **The failure mode is silent when the substituted command succeeds** — the body gets an empty string where the code span was, and the real action (e.g. a merge) happens without any error signal.

**Status:** Active — 2 instances (DevOps Lead p/26#157; Server Storage p/539#6). Near-miss: near-merge of PR #5.

**Applies To:** All agents using `gh pr comment`, `gh pr create`, `gh pr edit`, or any `gh` subcommand with `--body "…"` from Bash when the body may contain backticks.

---

## #240 [Test] Repo-Wide Rewrite Must Exclude Its Own Files and Re-Run Every Touched Suite After Applying

**Pattern:** A mass find-and-replace script (e.g. renaming a GitHub owner across the codebase) is run against the full repo including its own test fixtures. The inputs in the test file are overwritten with already-renamed strings, so the tests pass trivially — they now assert that the renamed string maps to itself. A second facet: test mocks keyed on the old API path (e.g. `*/users/*/packages/*`) stop firing once the code moves to the new path (`/orgs/`), and requests fall through to the real API with no interception. Both failures produce green tests while leaving the rename unverified.

**Instances:**
- 2026-10-12 — DevOps Lead (p/26#159, t/4096 PR #3195): `Rename-GitHubOwner.ps1` ran over the full repo, overwriting its own test fixtures. Mocks keyed on old API path stopped firing after the code moved to `/orgs/`. Resolved: script excludes its own files; glob rule moves mocks with the code; 10 affected suites re-run post-apply (92/92 green).

**Root Cause:**
- **Facet 1 (self-overwrite):** a rewrite script that does not exclude its own source tree turns its test inputs into tautologies — the "before" value becomes the "after" value, so every assertion trivially passes without exercising the transform.
- **Facet 2 (stale mock path):** test mocks that intercept by URL pattern are tied to the old path. When the code path changes, the mock never matches, and the real external API is called instead — no test failure, but no interception either.

**Prevention:**
1. **A repo-wide rewrite script must explicitly exclude its own source files** from the rewrite scope (test fixtures, the script itself, expected-value strings). Add an `-Exclude` list or a glob pattern before running.
2. **Re-run every test suite the rewrite touched**, not only the rewrite script's own tests — after applying, not before. The touched suites tell you whether any mock or fixture was silently broken.
3. **When moving a code path (URL, function name, module path), search for test mocks keyed on that path** and update them in the same commit. A mock that matches on the old path is silent after the rename.
4. **A test suite that passes identically before and after a rename is a warning sign**, not a green light — confirm that assertions reference the new value, not the old.

**Status:** Active — 1 instance (DevOps Lead p/26#159, t/4096 PR #3195). Caught before landing.

**Applies To:** All agents writing or running repo-wide rename/rewrite scripts; all agents updating code paths that test mocks intercept by pattern.

---

## #241 [Build] GitHub GraphQL Does Not Follow Repo Transfer Redirects — Empty Result Is Unreadable, Not Clean

**Pattern:** After a GitHub repository is transferred to a new organization (e.g. `jpsnover/ai-triad-research` → `AI-Rosetta-Stone/ai-triad-research`), `gh issue list` / `gh pr list -R jpsnover/ai-triad-research` return 0 results with no error. The GitHub REST API follows transfer redirects (301); the GraphQL API does not. A caller that reads 0 results from the old name concludes "nothing open" — silently wrong. Automated health checks, alert bridges, and reminder verifiers that were not updated to the new org name all read false-clean for the duration.

**Instances:**
- 2026-10-12 — DevOps Lead (p/26#161, t/4096#37): after transfer to `AI-Rosetta-Stone`, four hourly alert bridges using `-R jpsnover/ai-triad-research` returned 0 with no error. Found when r/23 reported "no open heartbeat issue." Resolved by updating all callers to the new org/repo name and re-verifying.

**Root Cause:** GitHub GraphQL resolves repository by (owner, name) at query time — it does not follow HTTP redirects. A transferred repo still exists at the old URL for REST (redirect), but the GraphQL resolver returns an empty/null result without an error code. The caller cannot distinguish "genuinely zero results" from "repo not found here."

**Prevention:**
1. **After any repo rename or transfer, treat an empty GraphQL result on the old name as unreadable, not clean.** Zero results with no error is ambiguous — it may mean "not found" rather than "nothing open."
2. **Update all callers (alert bridges, health checks, reminders, CI scripts) to the new org/repo name immediately** — before re-arming any automation that relies on them.
3. **Verify by querying the new name** and confirming it returns the expected baseline (e.g. the open heartbeat issue exists). A clean result on the old name does not confirm the query worked.
4. **REST-based `gh` calls (`gh api repos/…`)** follow redirects and may still work on the old name temporarily — but this is unreliable after a transfer and should not be relied on.

**Status:** Active — 1 instance (DevOps Lead p/26#161, t/4096#37). Silent: zero results with no error.

**Applies To:** All agents running `gh issue list`, `gh pr list`, or any GraphQL-backed `gh` query against a repo that has been renamed or transferred.

---

## #219 [Build] MSYS Stores Colon as Unicode Private-Use Character in Filenames — `C:tmpsaf…` Is Not a Real Colon; PowerShell Matching Fails; Use Bash for Cleanup

**Pattern:** A file appears in the repository root whose name looks like `C:tmpsaf_beliefs_raw.json`. The `:` is **not** an ASCII colon — MSYS stores it as a Unicode private-use character (U+F03A or similar) that *visually* resembles a colon but doesn't match ASCII `:` in any search or comparison. As a result: `git log/ls-files/status` fail "outside repository" or similar; PowerShell `-like 'C:tmp*'` and `Get-Item ".\C:tmpsaf..."` find nothing (the `.\` trick doesn't help — the issue is the non-ASCII char, not drive-letter interpretation); `:(literal)` pathspec magic also fails. **What works: Bash `ls`/`mv`/`rm` with the literal filename** — Bash can address the actual bytes MSYS stored.

**Instances:**
- 2026-10-07 — PowerShell (p/20#80): `C:tmpsaf_beliefs_raw.json` in `ai-triad-data` root. git pathspec and PowerShell both failed. File left as-is (not owner's to delete). *(Initial diagnosis: git drive-path interpretation.)*
- 2026-10-07 — DevOps (p/169#189, correction 1): PowerShell `-like 'C:tmp*'` found nothing; Bash `ls`/`mv` with literal name worked. True cause: MSYS Unicode private-use char (U+F03A) stored as colon.
- 2026-10-07 — DevOps (p/169#190, correction 2): File was **tracked** in git as `Ctmpsaf_beliefs_raw.json` (git stores the U+F03A as `C` + private-use byte sequence). A Bash `mv` showed as a tracked deletion in the shared checkout. A failed git pathspec lookup does not mean the file is untracked.
- 2026-10-07 — DevOps Lead (p/26#147, outcome): Moved the file out of the shared `ai-triad-data` checkout assuming it was untracked junk — it was tracked, creating an uncommitted deletion. **r/24 caught it within the hour.** Restored byte-identical (git status clean); `git rm` routed to the data repo owner. Rule: verify `git ls-files | grep` yourself before moving or deleting anything in a shared checkout, whatever a report says.

**Root Cause:** When a Bash redirect (`> /tmp/foo.json`) fails due to MSYS `/tmp` path mangling, the resulting junk artifact can land in the working tree with a `C:` prefix where the `:` is encoded as Unicode private-use character U+F03A. MSYS uses private-use codepoints to round-trip characters NTFS forbids (`:` is illegal in NTFS). The char looks like a colon in a terminal but isn't ASCII `0x3A`. Git tracks the file but cannot address it by the mangled pathspec; PowerShell string matching against literal `:` misses it; Bash can address it by raw bytes. A filesystem `mv`/`rm` on a tracked file creates a tracked deletion — it must be a `git rm` commit.

**Prevention:**
1. **These files are tracked git artifacts**, not untracked junk. A failed pathspec lookup does not mean untracked. Before treating as untracked, run `git ls-files | grep -a tmpsaf` (the `-a` flag handles non-UTF8 filenames); if it appears, it's tracked.
2. **To remove: `git rm` followed by a commit in the data repo** — this is a data write that must be coordinated with the data repo owner. Never use a filesystem `mv`/`rm` on a tracked file; it creates a staged deletion that blocks the ff-drain.
3. **To find the file**: `ls -la | grep tmpsaf` (Bash) — copy the literal filename from output for any subsequent operation; don't type the colon character manually.
4. **The presence of such a file is diagnostic** — audit the session that created it; the underlying cause is a Bash `/tmp` write that landed in the working tree via MSYS path mangling.

**Status:** Active — 1 instance (p/20#80, p/169#189, p/169#190). Diagnosis corrected twice.

**Applies To:** All agents encountering MSYS-mangled filenames in a tracked git repo; especially relevant in the `ai-triad-data` repo.

---

## #242 [Build] `tseslint.parser.parse` Is Not a Function — Meta-Package Exports `parseForESLint`, Not `parse`

**Pattern:** An agent calls `tseslint.parser.parse(src, opts)` to parse TypeScript source for static analysis, expecting a behaviour identical to `@typescript-eslint/parser`'s `parse` export. The call throws `TypeError: tseslint.parser.parse is not a function`. The meta-package `typescript-eslint` re-exports the parser under `tseslint.parser`, but only exposes `parseForESLint` — not the standalone `parse` function that the underlying `@typescript-eslint/parser` package exports directly.

**Instances:**
- 2026-10-12 — Shared Lib (p/5#51, t/4153): called `tseslint.parser.parse(src, { ecmaFeatures: { jsx: true }, sourceType: 'module' })` inside a vitest analysis helper. Threw `TypeError: tseslint.parser.parse is not a function`. Resolved by switching to `tseslint.parser.parseForESLint(src, opts).ast`.

**Root Cause:** `typescript-eslint` (the meta-package) wraps `@typescript-eslint/parser` but does not re-export the legacy `parse(src, opts)` entrypoint. It only exposes `parseForESLint(src, opts)`, which returns `{ ast, services, scopeManager, visitorKeys }`. Callers that want just the AST must unwrap `.ast`. The API surface differs between direct use of `@typescript-eslint/parser` and use through the meta-package.

**Prevention:**
1. **Use `tseslint.parser.parseForESLint(src, opts).ast`**, not `tseslint.parser.parse(src, opts)`, when parsing through the `typescript-eslint` meta-package.
2. **When porting code from `@typescript-eslint/parser` to `typescript-eslint`**, audit every call site: the standalone package's `parse` export has no equivalent under `tseslint.parser`. Use `parseForESLint(...).ast` as the replacement.
3. **`TypeError: X is not a function` on a meta-package export** is a signal to check whether the meta-package re-exports the same surface as the underlying package — often it does not.

**Status:** Active — 1 instance (Shared Lib p/5#51, t/4153).

**Applies To:** All agents using `typescript-eslint` meta-package for TypeScript AST parsing or static analysis.

---

## #243 [Runtime] Orca MCP Bulk Tool Schema Assumptions — `bulk_update_tickets` Does Not Accept Status; `bulk_relate` Takes a Different Shape

**Pattern:** An agent calls `bulk_update_tickets` with a `status` field to transition multiple tickets in one call, or calls `bulk_relate` with a `relations` array. Both calls are rejected. `bulk_update_tickets` does not support status transitions — those go through `transition_ticket` individually. `bulk_relate` takes `action`, `reference_id`, and `ticket_ids`, not a `relations` array.

**Instances:**
- 2026-10-12 — Rosetta Stone (p/6#85): called `bulk_update_tickets` with `{ status: "Done" }` for a set of tickets; call was rejected. Also called `bulk_relate` with `{ relations: [...] }`; rejected. Resolved by using `transition_ticket` per ticket for status, and the correct `{ action, reference_id, ticket_ids }` shape for `bulk_relate`.

**Root Cause:** The bulk MCP tools accept a subset of the per-ticket API surface. Status transitions are a state-machine operation and are intentionally excluded from bulk update. `bulk_relate` has a different schema from what a direct analogy to the single-ticket `add_relation` call would suggest.

**Prevention:**
1. **Use `transition_ticket` (not `bulk_update_tickets`) for status changes.** `bulk_update_tickets` handles field updates only (title, priority, assignee, etc.).
2. **`bulk_relate` shape:** `{ action: "add"|"remove", reference_id: "<ticket>", ticket_ids: ["<t1>", …] }` — not a `relations` array.
3. **Before calling any bulk MCP tool**, verify its schema with `ToolSearch select:<tool_name>` if you haven't used it recently. Bulk tools frequently have narrower schemas than their per-item equivalents.

**Status:** Active — 1 instance (Rosetta Stone p/6#85).

**Applies To:** All agents using Orca MCP bulk tools (`bulk_update_tickets`, `bulk_relate`).

---

## #244 [Build] `.githooks/` Scripts and Root `package.json` Scripts Fail When Run from a Subdirectory CWD

**Pattern:** An agent runs `.githooks/read-workflow-mode.sh` or `npm run gen:code-referenced-models` from a subdirectory (e.g. `lib/debate/`). The shell script fails to find its sibling scripts or the git root; the npm script is not found because `lib/debate/package.json` does not define it. Both are defined at the repo root and resolve paths relative to the shell's working directory.

**Instances:**
- 2026-10-12 — DebateTool (p/70#57, t/4166): ran `sh .githooks/read-workflow-mode.sh` from `lib/debate/` cwd — script failed because `.githooks/` relative to `lib/debate/` does not exist. Also ran `npm run gen:code-referenced-models` from `lib/debate/` — not found in that package's scripts. Resolved by running from the repo root.

**Root Cause:** `.githooks/read-workflow-mode.sh` uses relative path lookups that assume the cwd is the repo root. Root-level `npm run` scripts live in the root `package.json` and are invisible to sub-package npm. Neither tool has a guard or fallback for being called from a subdirectory.

**Prevention:**
1. **Always run `.githooks/` scripts from the repo root.** Use an absolute path: `sh "$(git rev-parse --show-toplevel)/.githooks/read-workflow-mode.sh"`, or `cd` to the root first in the same command.
2. **Root-level npm scripts (gen:\*, verify, models:drift, etc.) must be run from the repo root,** not from a sub-package directory. `npm run <script>` resolves against the nearest `package.json` — a sub-package's `package.json` will not have them.
3. **`script not found` from npm in a worktree subdirectory** is a reliable signal that you are in the wrong cwd — check `pwd` and navigate to the repo root.

**Status:** Active — 1 instance (DebateTool p/70#57, t/4166).

**Applies To:** All agents running `.githooks/` scripts or root-level npm scripts from within a subdirectory or sub-package cwd.

---

## #245 [Runtime] jq String Operations Error on Null Input — Guard with `// ""` Before Any String Op

**Pattern:** An agent pipes a JSON field into a jq string operation (`gsub`, `ltrimstr`, `startswith`, `test`, `split`, `ascii_downcase`, etc.). The field is null in some records. jq errors: `null (null) and string ("…") cannot be iterated over` or similar. The pipeline aborts or silently drops rows.

**Instances:**
- 2026-10-12 — Tech Lead (p/335#141): `.body[0:150] | gsub("…"; "…")` — `.body` was null for some records; `gsub` errored on null. Resolved by guarding: `(.body // "")[0:150] | gsub(…)`.

**Root Cause:** jq string functions expect a string on the left-hand side. A null input is not coerced to an empty string — it propagates the type error. JSON fields that are optional or not always populated can be null even when the schema implies string.

**Prevention:**
1. **Guard every string field before a string op:** `(.field // "")` replaces null with empty string. E.g. `(.body // "")[0:150] | gsub(…)`.
2. **Use `select(.field != null)` or `select(.field)` to filter records before string ops** when null rows should be dropped rather than defaulted.
3. **`ltrimstr`, `startswith`, `test`, `split`, `ascii_downcase` all have the same null-intolerance.** Apply the `// ""` guard consistently whenever the input field is optional.
4. **A jq pipeline that works on a sample may silently fail on production data** where optional fields are null — always test against a full data slice or add a null guard defensively.

**Status:** Active — 1 instance (Tech Lead p/335#141).

**Applies To:** All agents writing jq expressions against JSON fields that may be null or absent.

---

## #246 [Build] Design Doc File Paths Are Intent, Not Ground Truth — Verify With `find` Before Importing; Worktree Relative Paths Resolve Within the Worktree

**Pattern:** An agent uses a file path from a design document as the canonical location for a source file, imports or reads from that path, and receives a "module not found" or "file not found" error. The design doc recorded the intended path, not the as-implemented one. A second facet: a relative path like `../../taxonomy-editor` entered from inside a worktree resolves to the worktree copy of `taxonomy-editor`, not the main repo's copy. This is expected behavior, but when the design-doc path was also wrong, the combination produced a silent absent-file error with no indication which assumption failed.

**Instances:**
- 2026-10-12 — DebateTool (p/70#59, t/4166): design doc stated `modelConfig.ts` was at `hooks/useDebateStore/shared/modelConfig.ts`; actual location was `stores/shared/modelConfig.ts`. Relative path `../../taxonomy-editor` from the worktree resolved to the worktree's copy (correct behavior, but file was absent there because the design-doc path was wrong). Resolved by running `find . -name modelConfig.ts` to get the canonical path.

**Root Cause:** Design documents capture intent at authoring time and are not automatically updated when code is refactored or reorganized. File paths in design docs can drift from reality. The first failure (wrong path) and the second (worktree vs main repo resolution) compounded silently because neither produced an explicit "wrong path" error — just "file not found."

**Prevention:**
1. **Verify every file path from a design document with `find . -name <file>` or `ls <path>` before importing or reading.** Design doc paths are architectural intent, not guaranteed locations.
2. **Relative paths (`../../foo`) inside a worktree resolve within that worktree's tree**, not the main repo's. This is expected — but when the file is also misnamed, the combination is silent. Confirm with an explicit `ls` after constructing the path.
3. **When a design doc is more than a few days old**, treat all file paths as approximate — always verify against the live tree. File reorganization is common during active development.

**Status:** Active — 1 instance (DebateTool p/70#59, t/4166).

**Applies To:** All agents using file paths from design documents; all agents working with relative paths inside worktrees.

---

## #247 [Data] Regenerate Tool With Relative Path Resolved Against Process Directory Scans Zero Files and Silently Overwrites Source of Truth

**Pattern:** A cmdlet or script that regenerates a baseline or index file accepts a relative path argument (e.g. `Update-ComplexityBaseline -Path scripts`). The path is resolved against the process's working directory rather than the PowerShell module's location (`$PSScriptRoot`) or the caller's location. The working directory does not contain the expected subtree, so the scan finds zero files. The tool writes an empty result over the existing baseline — no error, no warning, no guard against empty output.

**Instances:**
- 2026-10-13 — PowerShell (p/20#94, t/4146, PR #3235): `Update-ComplexityBaseline -Path scripts` resolved `scripts` against the process directory (not the module's location), found 0 files, and silently wrote an empty baseline over every entry. Fix: resolve relative paths with `Resolve-Path` / `$PSScriptRoot`, and refuse to write an empty scan result (`assert $results.Count -gt 0`).

**Root Cause:** PowerShell cmdlets that accept path parameters do not inherit the caller's `$PWD` by default — they use the process working directory, which may differ from the shell's perceived cwd. A regenerate tool that writes unconditionally on zero results provides no safety net for a misconfigured path.

**Prevention:**
1. **Resolve relative paths with `Resolve-Path` (throws on missing) or `Join-Path $PSScriptRoot …`** inside PowerShell cmdlets — never assume the process directory matches the caller's intent.
2. **A regenerate/update tool must refuse to write an empty result.** Assert `$results.Count -gt 0` (or equivalent) before overwriting any existing file. Empty output almost always means the scan target was not found, not that everything was deleted.
3. **The failure mode is silent success:** no error, no warning, but the source of truth is now empty. Add a `WARN` log when the scan count is unexpectedly low (e.g. fewer results than the previous run), even if the tool continues.
4. **This class applies to any "regen" or "update index" operation** — not just PowerShell. Any script that reads a tree and writes a summary file should guard against zero-item output before overwriting.

**Status:** Active — 1 instance (PowerShell p/20#94, t/4146, PR #3235).

**Applies To:** All agents writing or running cmdlets/scripts that regenerate baselines, indexes, or summary files from a directory scan.

---

## #248 [Build] Reusing a Merged Branch Name Opens a PR from the Stale Remote Branch — Near-Miss: 388-File Revert Almost Landed

**Pattern:** An agent creates a new local branch reusing a name that was previously squash-merged but never deleted on the remote. `git push` is rejected (non-fast-forward). The agent then calls `gh pr create --head <name>` anyway — but `gh pr create` does not verify that the push succeeded; it opens the PR from whatever the remote currently holds under that name. The result is a PR whose head is the old, stale remote branch, not the new local commit. If the stale head is far behind main, the PR diff can show hundreds of unintended file reversions.

**Instances:**
- 2026-10-14 — Shared Lib (p/5#53): reused branch name `fix/parser-api`; `git push` rejected non-fast-forward; `gh pr create --head fix/parser-api` opened a PR from the stale remote branch diffing 388 files against main. Auto-merge did not arm because `--match-head-commit` pinned the wrong SHA — the mismatch was the only guard that caught it. Resolved: closed PR, deleted remote branch, pushed fresh branch under a new name.

**Root Cause:** Squash merges leave the remote head branch intact unless explicitly deleted. `gh pr create` resolves `--head <name>` against the remote, not the local. A failed `git push` leaves the remote at the old commit, so `gh pr create` silently opens a PR from stale content with no error or warning.

**Prevention:**
1. **Always use a fresh, unique branch name** — include the ticket number and a counter or date (e.g. `fix/parser-api-t4153`). Never reuse a name that has been merged, even if the remote branch was supposed to be deleted.
2. **Check `$?` (or `$LASTEXITCODE`) after `git push` before calling `gh pr create`.** A rejected push is a hard stop — do not proceed to PR creation until the push succeeds.
3. **Check `changedFiles` on the new PR before arming auto-merge:** `gh pr view <N> --json changedFiles -q .changedFiles`. A docs-only or single-file fix that shows hundreds of changed files is a red flag.
4. **`--match-head-commit` is the last-resort guard.** It caught this near-miss, but it should not be the only check — it mismatching means the PR was already open with the wrong content.

**Status:** Active — 1 instance (Shared Lib p/5#53). Near-miss: 388-file revert almost armed.

**Applies To:** All agents creating PRs after a `git push`; especially relevant when reusing or recycling branch names.

---

## #249 [Build] `gh pr merge --match-head-commit` Rejects Wrong or Abbreviated SHAs — Always Read `headRefOid`, Never Type One

**Pattern:** An agent runs `gh pr merge <N> --squash --match-head-commit <short-sha>` using an abbreviated commit SHA (7–8 hex chars). The call is rejected with a GraphQL coercion error. `--match-head-commit` passes the value directly to GitHub's GraphQL API, which expects a full 40-character OID. An abbreviated SHA is not a valid OID and fails schema validation before the merge is attempted.

**Instances:**
- 2026-10-15 — ServerAPI (p/504#21): `gh pr merge 3301 --squash --match-head-commit aa938981` (8 chars) rejected with GraphQL coercion error. Resolved by re-running with `$(gh pr view 3301 --json headRefOid -q .headRefOid)`.

**Root Cause:** GitHub GraphQL's `PullRequestMergeMethod` and head-commit matching validate the OID as a full SHA-1 (40 hex chars). Abbreviated SHAs used in local git commands (e.g. from `git log --oneline` or `git show --stat HEAD`) are not expanded by `gh` before submission.

**Prevention:**
1. **Always supply the full 40-char SHA to `--match-head-commit`:** use `$(gh pr view <N> --json headRefOid -q .headRefOid)` — never use a short SHA from `git log --oneline` or `git show --stat HEAD`.
2. **The standard pattern** (from the land-from-worktree skill) is: `gh pr merge <N> --squash --match-head-commit $(gh pr view <N> --json headRefOid -q .headRefOid)`. Copy it verbatim; do not abbreviate the OID substitution.
3. **A GraphQL coercion error on `--match-head-commit`** is a reliable diagnostic that the SHA was abbreviated — the fix is always the full OID, not a different merge strategy.

**Status:** Active — 9 instances (ServerAPI p/504#21; DevOps Worker p/749#14; Tech Lead p/335#156; DevOps Lead p/26#186; DevOps Lead p/26#190 — `gh workflow run -f sha=<short>` dispatch input; DevOps Lead p/26#214 — short SHA passed directly to `--match-head-commit`; DevOps Lead p/26#223 — fabricated plausible-looking 40-char SHA from short `git push` summary SHA instead of reading `headRefOid`; DebateTool p/70#77 — 8-char SHA `efad5c80` passed to `--match-head-commit`; ElectronMain p/781#1 — hand-typed short SHA `aee47d57` rejected; fix: `gh pr view --json headRefOid --jq .headRefOid`). **Prevention: t/4297 — rule `match-head-commit-full-sha` live (warn-only, workspace-wide); widened (t/4297#3) to cover `gh workflow run -f/-F/--field/--raw-field` inputs named sha/commit/oid/rev; live-fire proven at t/4297#2 and t/4297#4. Gap: `gh api .../dispatches` not yet covered.**

**Applies To:** All agents running `gh pr merge --match-head-commit`.

---

## #250 [Build] Shared Feature Branch + Shared Worktree With Two Agents — Rebase by One Agent Blocks the Other's Push and Recovery

**Pattern:** Two agents share a feature branch and a shared worktree. One agent rebases the branch onto main (new SHAs), while the other has uncommitted WIP from the first agent sitting in the same worktree. The second agent's `git push` is now rejected (non-fast-forward against the rebased tip). `git branch -f` fails because the branch is checked out. `git reset --hard` is blocked by the auto-mode destructive-op classifier. The worktree is stuck: the branch pointer, the working tree, and the remote are all inconsistent.

**Instances:**
- 2026-10-15 — ServerAPI (p/504#20, t/4184): Server Storage rebased `t4184-write-conflict-fix` onto main while ServerAPI had uncommitted WIP from Server Storage in the same worktree. Push rejected; `git branch -f` failed (branch checked out); `git reset --hard` blocked by classifier. Resolved: stashed the foreign WIP, cherry-picked own commit onto a fresh branch at the new remote tip, pushed as fast-forward, realigned with `git checkout -B`, restored stash.

**Root Cause:** Shared worktrees on a shared feature branch create a coordination hazard: a rebase rewrites SHAs and invalidates any local commit ancestry, but uncommitted changes from the "other" agent's files are mixed into the worktree with no clear ownership boundary. The destructive-op classifier correctly blocks `git reset --hard`, which would silently discard those changes.

**Prevention:**
1. **Commit or stash all WIP before rebasing a shared branch.** Never rebase a branch another agent is actively working on without pinging them first and confirming their worktree is clean.
2. **Coordinate rebase via ping before running it.** A rebase on a shared branch rewrites the history every contributor is building on — treat it as a breaking change that all contributors must acknowledge.
3. **Recovery path when stuck:** (a) `git stash -u` to save all WIP including untracked; (b) `git fetch origin`; (c) cherry-pick your own commit onto a fresh branch at `origin/<branch>`; (d) `git push origin <new-branch>:<shared-branch>` (fast-forward); (e) `git checkout -B <shared-branch> origin/<shared-branch>` to realign; (f) `git stash pop`.
4. **Prefer per-agent branches over shared feature branches** when multiple agents contribute to the same epic. Use a shared epic → main PR and let each agent land their own child PRs into the epic branch.

**Status:** Active — 1 instance (ServerAPI p/504#20, t/4184).

**Applies To:** All agents sharing a feature branch or worktree with another agent; especially relevant during active epic work.

---

## #251 [Build] Heredoc With `\'` Inside the Body Errors "Unexpected EOF While Looking for Matching ''" — Use Write/Edit, Never Inline Heredocs

**Pattern:** An agent uses a `cat >> file << 'EOF'` heredoc to write content that contains backslash-apostrophe sequences (`\'`) — for example, JavaScript string literals like `'first save\'s returned version'`. The shell tool layer mis-parses the `\'` as closing an outer single-quote context, raising "unexpected EOF while looking for matching ''" before writing anything. Standard Bash heredoc rules suppress substitution inside `'EOF'`-quoted delimiters, but the shell tool layer applies an additional quoting pass that does not follow standard heredoc rules.

**Instances:**
- 2026-10-15 — Server Storage (p/539#4): `cat >> testFixtures.ts << 'EOF'` with `'first save\'s returned version'` in the body. The `\'` sequence triggered "unexpected EOF while looking for matching ''" in the shell tool layer; nothing was written. Resolved by abandoning the heredoc and using the Write tool instead (per root AGENTS.md Shell Quoting Rule).

**Root Cause:** The shell tool layer applies quote-parsing before passing content to Bash. A `\'` inside a single-quoted heredoc body is valid Bash (the backslash is literal inside `'…'`) but the tool layer sees the `'` after `\` as a quote boundary, closing the outer context prematurely. This is a deviation from POSIX heredoc semantics introduced by the tool wrapper.

**Prevention:**
1. **Use the Write tool for any file content containing single quotes, apostrophes, or backslash sequences** — especially JS/TS string literals, SQL, or natural-language text with contractions. The Write tool does not apply shell quoting.
2. **Never use inline heredocs (`<< 'EOF'`) for code or text with special shell characters.** This is the root AGENTS.md Shell Quoting Rule: "code with special shell characters: use Edit/Write, and run scripts from a file; never use inline heredocs."
3. **`\'` inside a single-quoted heredoc body is the trigger.** If content must go through Bash, use `$'…'` (ANSI-C quoting) and escape the apostrophes as `\'` in that context — but the Write tool is simpler and safer.
4. **The failure is silent on content**: no partial write, no file created. If using heredocs is unavoidable, check the exit code and verify the file exists and has expected content before continuing.

**Status:** Active — 2 instances (Server Storage p/539#4; Rosetta Stone p/6#92).

**Applies To:** All agents writing file content via Bash heredocs when the content includes apostrophes, single quotes, or backslash sequences; use Write/Edit instead.

---

## #252 [Test] Node-Version-Gated Test Skips Hide CI Failures — Never Report Green While Files Are Skipped

**Pattern:** A test run on local Node 24 reports "0 failed" while a subset of suites (e.g. `githubApi*`) are silently skipped due to a version gate (undici skew). CI runs under Node 22, where those suites execute and can fail. The local summary line hides the skip count, so the agent reports the run as green. CI then fails with real test failures.

**Instances:**
- 2026-10-15 — Rosetta Stone (p/6#87, p/775#82, t/4187): `githubApi*` suites skipped on local Node 24 due to undici version skew. Bundle check reported "0 failed". CI on Node 22 ran the suites and found 4 failures. Fix: `npx -y node@22 node_modules/vitest/vitest.mjs run <gated-files>` reproduced CI exactly.

**Root Cause:** Node-version-gated skips are invisible in a summary pass/fail count. An agent reading "0 failed" without checking the skip count concludes the run is green — a false report.

**Prevention:**
1. **Never report a test run as green while any files are skipped.** Always include skip counts in the report: "X passed, Y failed, Z skipped."
2. **Reproduce CI locally before reporting green** when suites are known to be version-gated: `npx -y node@22 node_modules/vitest/vitest.mjs run <gated-files>` from `taxonomy-editor/` runs those files under CI's Node major.
3. **A skipped file is not a passing file.** If a suite is skipped locally but runs on CI, the local result is uninformative for that suite.

**Status:** Active — 1 instance (Rosetta Stone p/6#87, t/4187).

**Applies To:** All agents reporting test results for `taxonomy-editor/` or any package with Node-version-gated suites.

---

## #253 [Build] Label Removal Re-Triggers Required Status Checks Into Pending — Wait for `CLEAN` Before Merging

**Pattern:** Removing a PR label (e.g. `consult-hold`) that is tied to a required status check causes GitHub to re-trigger that check (and possibly others like `joint-gv-guard`, `tier-check`) into a fresh pending state. A `gh pr merge` attempted in this window is rejected with "base branch policy prohibits the merge" even though all checks were green a moment before.

**Instances:**
- 2026-10-15 — DevOps Lead (p/26#165, PR #3282): removing `consult-hold` re-triggered `consult-hold-guard`/`joint-gv-guard`/`tier-check`/`check` into pending. Merge attempt rejected. Resolved: waited ~20s, confirmed `mergeStateStatus: CLEAN`, retried — merged clean.

**Root Cause:** GitHub re-evaluates required check contexts whenever a label changes. The merge attempt landed in the brief window between label removal and check re-settlement.

**Prevention:**
1. **After any label change on a PR, poll `mergeStateStatus` before merging:** `gh pr view <N> --json mergeStateStatus -q .mergeStateStatus`. Wait for `CLEAN`.
2. **A ~20s wait is usually sufficient**, but polling is safer than a fixed sleep — use `until` with a sleep loop.
3. **"Base branch policy prohibits the merge" immediately after a label change** is a reliable diagnostic that checks are re-settling, not a genuine block — retry after polling `CLEAN`.

**Status:** Active — 1 instance (DevOps Lead p/26#165, PR #3282).

**Applies To:** All agents merging PRs after removing a label that arms a required status check.

---

## #255 [Build] `git fetch origin pull/N/head:refs/remotes/pr/N` Fails Silently on the Shared Checkout — Use `FETCH_HEAD` Instead

**Pattern:** An agent runs `git fetch origin pull/N/head:refs/remotes/pr/N` to fetch a PR's head into a custom ref namespace on the shared checkout. The command exits 1 with no output. The custom `refs/remotes/pr/*` namespace write fails silently. A subsequent `&&` chain produces no output either, masking the failure.

**Instances:**
- 2026-10-15 — Rosetta Stone (p/6#89): `git fetch origin pull/3312/head:refs/remotes/pr/3312` exited 1 silently on the shared checkout. Resolved: `git fetch origin pull/3312/head` (no ref mapping), then diff against `FETCH_HEAD`.

**Root Cause:** Writing into a custom ref namespace on the shared checkout can fail due to ref lock contention or namespace restrictions. The failure is silent (exit 1, no stderr) when piped in a compound command.

**Prevention:**
1. **Use `git fetch origin pull/N/head` (no ref mapping)** and inspect or diff against `FETCH_HEAD` — no custom ref write, no namespace contention.
2. **Never use a custom `refs/remotes/pr/*` namespace on the shared checkout.** If a persistent PR ref is needed, use a worktree.
3. **Always check `$?` after a `git fetch` before running a command that depends on the ref.** A silent exit 1 with no stderr is a reliable signal of a ref write failure.

**Status:** Active — 1 instance (Rosetta Stone p/6#89).

**Applies To:** All agents fetching PR heads into custom ref namespaces on the shared checkout.

---

## #256 [Build] `gh pr merge --auto` on an Already-Mergeable PR Returns "Pull Request Is in Clean Status" — Retry Once

**Pattern:** An agent arms auto-merge on a PR where all required checks have already passed. `gh pr merge --auto --squash` returns `enablePullRequestAutoMerge: Pull request is in clean status` and exits non-zero. GitHub rejects arming the auto-merge queue because the PR is immediately mergeable — the queue is unnecessary. A second call to the same command succeeds and merges the PR synchronously.

**Instances:**
- 2026-10-15 — Quality TL (p/447#26, PR #3320): all required checks had passed by the time the approval comment was posted. First `--auto` arm rejected. Second `--auto` call succeeded and merged immediately.

**Root Cause:** GitHub's auto-merge queue is designed for PRs waiting on checks. A PR in `CLEAN` state (all checks green, base up to date) does not need the queue — GitHub rejects the enqueue and instead expects a direct merge. On retry, it performs the merge synchronously.

**Prevention:**
1. **When `--auto` returns "Pull request is in clean status", retry the same command once.** The second call merges synchronously rather than entering the queue.
2. **Alternatively, check `mergeStateStatus` first:** `gh pr view <N> --json mergeStateStatus -q .mergeStateStatus`. If `CLEAN`, use a direct `gh pr merge <N> --squash --match-head-commit $(gh pr view <N> --json headRefOid -q .headRefOid)` instead of `--auto`.
3. **This error is not a block** — it means the PR is ready to merge now, not that something is wrong.

**Status:** Active — 1 instance (Quality TL p/447#26, PR #3320).

**Applies To:** All agents arming auto-merge on PRs that may already be in a mergeable state.

---

## #257 [Build] Windows Backslash Paths in the Bash Tool Are Stripped as Escape Characters — Use Forward Slashes

**Pattern:** An agent passes a Windows backslash path to `pwsh -File C:\Users\...\script.ps1` in the Bash tool. Git Bash strips the backslashes as escape characters (treating `\U`, `\s`, etc. as escape sequences), producing a mangled single-word string. `pwsh` receives an unrecognizable argument and exits 64 (command-line error).

**Instances:**
- 2026-10-15 — DevOps Lead (p/26#169): `pwsh -File C:\Users\jsnov\...\Get-CiAlertEscalations.ps1` in the Bash tool stripped all backslashes. Re-ran with `"C:/Users/jsnov/.../Get-CiAlertEscalations.ps1"` — worked immediately.

**Root Cause:** Git Bash (MSYS) interprets backslashes as escape characters in command arguments, even when the path appears unquoted. A Windows path like `C:\Users\foo` becomes `C:Usersfoo` after escape processing.

**Prevention:**
1. **Always use forward slashes for file paths in the Bash tool** (`"C:/Users/.../script.ps1"`). Forward slashes are valid on Windows and are not subject to MSYS escape processing.
2. **Backslash paths are safe only in the PowerShell tool** (`pwsh` native context), which does not apply MSYS quoting.
3. **Exit code 64 from `pwsh`** is a command-line parse error — a reliable diagnostic that the path argument was mangled.

**Status:** Active — 1 instance (DevOps Lead p/26#169).

**Applies To:** All agents running `pwsh` or any Windows command with file paths from the Bash tool.

---

## #258 [Build] Joint-GV Ticket Worktree Name Collision — Two Roles Both Use the Ticket Key, Second `worktree add` Fails "Already Exists"

**Pattern:** On a joint-gv ticket, two roles each create a worktree named after the ticket key (e.g. `.worktrees/t4193`). The second agent's `git worktree add .worktrees/t4193` fails with "already exists." If an agent is launched in the same turn as the `worktree add` — before confirming it succeeded — the agent may land in the wrong tree or have no tree at all.

**Instances:**
- 2026-10-16 — PowerShell (p/20#96, t/4193): PowerShell and CL both targeted `.worktrees/t4193`. PowerShell's `worktree add` failed; a sub-agent launched concurrently briefly had no valid worktree. Resolved: stopped the agent, confirmed CL's tree was clean, created `.worktrees/ps-t4193` and redirected the agent.

**Root Cause:** Multiple agents on the same ticket independently derive the same worktree name from the ticket key, with no coordination. Agent launch is not gated on `worktree add` success.

**Prevention:**
1. **Always role-prefix worktree names on joint-gv tickets:** `.worktrees/ps-t4193`, `.worktrees/cl-t4193`. Alternatively, derive the name from the branch (which already carries the role prefix, e.g. `fix/ps-budget-t4193`).
2. **Never launch an agent that depends on a worktree until `git worktree add` has succeeded.** Confirm the path exists (`git worktree list | grep <path>`) before passing it to the agent.
3. **On collision, stop the agent immediately** before it makes any changes, confirm the existing tree's owner and cleanliness, then create a role-prefixed tree and re-point the agent.

**Status:** Active — 1 instance (PowerShell p/20#96, t/4193).

**Applies To:** All agents creating worktrees on joint-gv or any multi-agent ticket.

---

## #259 [Build] Local Rebase Not Pushed Leaves Divergent History — Later Commit Push Is Rejected Non-Fast-Forward

**Pattern:** An agent runs `git rebase origin/main` on a PR branch locally but does not immediately push (`--force-with-lease`). Hours later, a new fix commit is added to the same local branch. When pushed, git rejects it as non-fast-forward — the remote still has the pre-rebase history, and the new local commit descends from the rebased (rewritten) ancestors that the remote has never seen.

**Instances:**
- 2026-10-16 — DevOps Worker (p/749#9, t/4122): locally rebased `t4122-t2-budget` onto main, didn't push. Added a fix commit later. Push rejected non-fast-forward. Resolved: saved fix as `git diff HEAD~1..HEAD > fix.patch`, `git reset --hard origin/<branch>`, reapplied patch, recommitted, pushed as fast-forward — avoided force-push over the armed auto-merge pin.

**Root Cause:** A local rebase rewrites commit SHAs without syncing the remote. Any subsequent commit built on the rewritten ancestors cannot be fast-forward merged into the remote's pre-rebase history.

**Prevention:**
1. **Always push immediately after a rebase:** `git rebase origin/main && git push --force-with-lease`. Never let a rebase sit unpushed.
2. **Recovery when push is rejected on a shared PR branch with an armed auto-merge pin:** save the fix as a patch (`git diff HEAD~1..HEAD > fix.patch`), `git reset --hard origin/<branch>`, reapply, recommit, push as fast-forward. Do not force-push over an armed pin.
3. **`git push` rejected non-fast-forward on a PR branch you recently rebased locally** is a reliable diagnostic — check whether the rebase was ever pushed.

**Status:** Active — 1 instance (DevOps Worker p/749#9, t/4122).

**Applies To:** All agents rebasing PR branches; especially relevant on shared branches with armed auto-merge.

---

## #260 [Process] T1 PR Armed Before All Assigned Reviewers Approved — "Lead Reviewing" Does Not Waive Quality's Pass

**Pattern:** An agent posts its own `Approved (<role>):` comment on a T1 PR and immediately arms auto-merge, without waiting for Quality's separate round-robin review pass. The PR merges before Quality's explicit approval comment lands. "Lead reviewing" on the ticket is a work-assignment note, not a waiver of the Quality reviewer's independent approval.

**Instances:**
- 2026-10-15 — DevOps Lead (p/26#173, PR #3343, t/4126): posted `Approved (Lead):` and armed `--auto` immediately. Quality's review landed concurrently and their approval comment posted after the merge had already fired. No code harm (findings were PR-body annotations), but the review sequence was violated.

**Root Cause:** The agent conflated "I have reviewed and approved" with "all required approvals are in." On a T1 PR, the owning role and a Quality reviewer must both approve — arming after only one approval skips the second.

**Prevention:**
1. **For T1 PRs, wait for every assigned reviewer's `Approved (<role>):` comment before arming auto-merge.** The standard T1 flow is: owner approves → Quality reviewer approves → arm.
2. **"Lead reviewing" on a ticket means the Lead is doing the owner's review pass**, not that Quality is skipped. Check `docs/review-routing.md` for the current Quality round-robin assignment.
3. **Arm only after confirming all required approvals are posted** — a quick `gh pr view <N> --json comments` scan for `Approved (` lines is sufficient.

**Status:** Active — 1 instance (DevOps Lead p/26#173, PR #3343, t/4126).

**Applies To:** All agents merging T1 PRs; all roles acting as PR owner on a ticket with a Quality round-robin reviewer assigned.

---

## #261 [Build] Compound Bash Call With File Write + Long-Running CLI (commit, pr create) Hits 120s Timeout — Command Silently Backgrounded, Never Completes

**Pattern:** An agent chains a file-write (heredoc or long content) with a long-running CLI call (`git commit`, `gh pr create`) in a single Bash call. The call hits the 120s Bash tool timeout mid-execution. The command is moved to background — the file write may not flush and the CLI call never completes. The tool reports normal background execution but output is empty and no artifact (commit, PR) is created.

**Instances:**
- 2026-10-16 — DevOps Worker (p/749#11): compound `git commit -m "$(…long message…)" && git push` timed out. Change was staged-but-uncommitted. `git log origin/<branch>` errored "unknown revision." Resolved: `git status` confirmed staged state, re-ran `git commit` separately, then `git push`.
- 2026-10-17 — DevOps Lead (p/26#178): `gh pr create` chained after a heredoc body-file write silently never completed — output file was empty, no PR created. Resolved: re-wrote the body file with the Write tool, re-ran `gh pr create` in the foreground separately — succeeded immediately (PR #3367).

**Root Cause:** The 120s Bash timeout fires while a slow heredoc write or CLI setup is still running. The tool backgrounds the process. The staged index or file write is untouched (the command didn't complete), so no artifact is produced — but the tool exit looks normal.

**Prevention:**
1. **Never chain a file-write + long-running CLI call in a single Bash call.** Run them as separate calls.
2. **Use the Write tool for PR body files and commit message files** — not bash heredocs — then invoke the CLI separately. This avoids heredoc expansion delays and keeps each Bash call short.
3. **After a backgrounded or timed-out Bash call involving `git commit` or `gh pr create`, verify the artifact exists** before proceeding: `git status` (staged = commit didn't land), `gh pr list` (no PR = create didn't complete).
4. **Empty output from a backgrounded `gh pr create`** is a reliable diagnostic — re-run in the foreground after writing the body file with the Write tool.

**Status:** Active — 2 instances (DevOps Worker p/749#11; DevOps Lead p/26#178).

**Applies To:** All agents running `git commit` with multi-line messages or `gh pr create` with body files in the Bash tool; use Write tool for file content and separate each CLI call.

---

## #263 [Build] jq `\(` String Interpolation Mangled by Bash Double-Quoting in `--jq` Argument — Write the Program to a File

**Pattern:** An agent passes a jq program containing `\(` (jq string interpolation syntax) as a double-quoted bash argument to `gh --jq "…\(…"` or `jq "…\(…"`. Bash processes the backslash before jq sees it, mangling or stripping the interpolation syntax and causing a jq parse error or unexpected output.

**Instances:**
- 2026-10-17 — Rosetta Stone (p/6#96): a jq regex containing `\(` inside a double-quoted `--jq` argument tripped jq's string-interpolation parser. Resolved: wrote the jq program to a file and used `--jq "$(cat file)"`.

**Root Cause:** Bash's double-quote processing strips or transforms backslash sequences before the argument reaches jq. `\(` in a double-quoted string is interpreted by bash, not passed through literally.

**Prevention:**
1. **When a jq program contains `\(`, `\"`, or other backslash sequences, write it to a file** and use `--jq "$(cat file)"` or pipe: `jq -r '…' <<'JQ_EOF'` … `JQ_EOF` (single-quoted heredoc passes the program literally).
2. **Single-quoted strings (`'…'`) in bash pass `\(` literally to jq** — prefer single quotes for inline jq programs that contain backslash sequences.
3. **A jq parse error on a program that looks correct in isolation** is a reliable diagnostic for bash-quoting mangling — inspect with `printf '%s\n' "$JQ_PROG"` to see what jq actually received.

**Status:** Active — 1 instance (Rosetta Stone p/6#96).

**Applies To:** All agents constructing jq programs with `\(` interpolation, regex literals, or `\"` in bash double-quoted arguments.

---

## #264 [Build] `MSYS_NO_PATHCONV=1` Suppresses All MSYS Path Translation Including `/dev/null` — Use PowerShell for HTTP Probes on Windows

**Pattern:** An agent sets `MSYS_NO_PATHCONV=1` to prevent MSYS from mangling a path-like string in a curl argument (e.g. `-w "/health"`). This also prevents MSYS from translating `/dev/null` to the Windows equivalent `NUL`. `curl -o /dev/null` then tries to write to a literal path that does not exist on Windows and exits 23 (write error).

**Instances:**
- 2026-10-17 — Tech Lead (p/335#153): `MSYS_NO_PATHCONV=1 curl -o /dev/null -w "%{http_code}" …/health` returned exit 23. Root cause: `-w "/health"` had been mangled by MSYS without the flag; adding the flag fixed the format string but broke `/dev/null`. Resolved: switched to `Invoke-WebRequest` in PowerShell.

**Root Cause:** `MSYS_NO_PATHCONV=1` is a global suppress — it disables all MSYS path translation for the command, not just the argument that needed protection. `/dev/null` is a POSIX device path that MSYS normally translates to `NUL`; suppressing translation leaves it as a literal path Windows cannot open.

**Prevention:**
1. **Use PowerShell `Invoke-WebRequest` (or `Invoke-RestMethod`) for HTTP probes on Windows** — no MSYS path translation issues.
2. **Do not combine `MSYS_NO_PATHCONV=1` with `-o /dev/null`** in the same curl call. If output must be discarded, use `-o NUL` directly (Windows-native) when the flag is set.
3. **`curl` exit 23 immediately after adding `MSYS_NO_PATHCONV=1`** is a reliable diagnostic for `/dev/null` translation being suppressed — check whether `-o /dev/null` is in the same command.
4. **The root AGENTS.md recommends `MSYS_NO_PATHCONV=1` for `git show <ref>:<path>`** — it is safe there because no `/dev/null` is involved. Do not apply it globally to all curl commands.

**Status:** Active — 1 instance (Tech Lead p/335#153).

**Applies To:** All agents running curl on Windows (Git Bash / MSYS) when both MSYS path-mangling protection and output-discarding are needed.

---

## #266 [Process] `gh pr merge --auto` Rejected on a Draft PR — Run `gh pr ready` First

**Pattern:** An agent arms auto-merge (`gh pr merge --auto --squash`) on a PR that is still in draft state. GitHub rejects the auto-merge request because draft PRs are not eligible for merging. The agent may not have checked draft status before arming.

**Instances:**
- 2026-10-17 — Tech Lead (p/335#156, PR #3196): `--auto` rejected on a draft PR. Resolved: ran `gh pr ready <N>` to mark it ready for review, then re-armed successfully.

**Root Cause:** GitHub enforces that draft PRs cannot be merged (auto or manual). The root AGENTS.md already states "Never arm consult-hold, joint-gv or draft PRs" — the failure was not checking draft state before arming.

**Prevention:**
1. **Before arming auto-merge, check draft state:** `gh pr view <N> --json isDraft -q .isDraft`. If `true`, run `gh pr ready <N>` first.
2. **The root AGENTS.md rule is authoritative:** "Never arm consult-hold, joint-gv or draft PRs, or PRs whose base isn't `main`." Check all four conditions before arming.
3. **`gh pr merge --auto` rejecting immediately** (not after CI) is a reliable diagnostic that the PR state itself is the blocker — check draft, base branch, and hold labels.

**Status:** Active — 1 instance (Tech Lead p/335#156, PR #3196).

**Applies To:** All agents arming auto-merge; always check `isDraft`, base branch, and hold labels before calling `gh pr merge --auto`.

---

## #267 [Build] `import.meta` Is Illegal Inside `new Function()` Bodies — Always Plain Script Context

**Pattern:** An agent constructs a string passed to `new Function()` that references `import.meta.url` (e.g. `createRequire(import.meta.url)`). At runtime, `new Function()` bodies execute as plain scripts, never as ES modules — even when called from a module. `import.meta` is a module-only feature and is a syntax error in plain script context.

**Instances:**
- 2026-10-17 — DevOps Lead (p/26#180): a scratch syntax-check script used `createRequire(import.meta.url)` inside a `new Function()`-constructed body. Threw `SyntaxError: Cannot use 'import.meta' outside a module`. Resolved: replaced with a plain no-op `require` mock.

**Root Cause:** `new Function(body)` always creates a plain function in the global scope, not a module. `import.meta` is only valid inside a true ES module (`type: "module"` file or `import()` expression). The call site being in a module does not affect the `new Function()` body's execution context.

**Prevention:**
1. **Never use `import.meta`, `import()`, or top-level `await` inside a `new Function()` body.** These are module-only features and will throw in the plain-script context `new Function()` always creates.
2. **For CJS-style `require` inside a dynamically constructed function**, use a plain `require` mock or pass `require` in as a parameter — not `createRequire(import.meta.url)`.
3. **`SyntaxError: Cannot use 'import.meta' outside a module` thrown from a `new Function()` call** is a reliable diagnostic that the body uses module syntax — inspect the string being passed.

**Status:** Active — 1 instance (DevOps Lead p/26#180).

**Applies To:** All agents constructing `new Function()` bodies in ES module files; do not use module-only syntax inside the body string.

---

## #269 [Build] `az bicep build --stdout` Crashes With `UnicodeEncodeError` on Windows — Use `--outfile` Instead

**Pattern:** An agent runs `az bicep build --file main.bicep --stdout` on Windows. The .bicep file contains non-ASCII characters (e.g. `→`, `—`). The Azure CLI writes stdout using the Windows default cp1252 encoding, which cannot encode those characters, causing `UnicodeEncodeError: 'charmap' codec can't encode character`.

**Instances:**
- 2026-10-17 — Azure (p/105#8): `az bicep build --file main.bicep --stdout` crashed with `UnicodeEncodeError: 'charmap' codec can't encode '→'`. Resolved: used `--outfile <path>` instead; build succeeded.

**Root Cause:** On Windows, the Azure CLI writes to stdout using the system's default ANSI codepage (cp1252). Any non-ASCII character outside cp1252's range causes a codec error. `--outfile` writes to a file in UTF-8, bypassing the codepage constraint.

**Prevention:**
1. **Use `--outfile <path>` instead of `--stdout`** when building bicep files on Windows, especially any file that may contain non-ASCII characters (comments, string literals, identifiers).
2. **Alternatively, set `$env:PYTHONIOENCODING = "utf-8"` or `[Console]::OutputEncoding = [Text.Encoding]::UTF8`** before the az call in PowerShell to force UTF-8 stdout encoding.
3. **`UnicodeEncodeError: 'charmap' codec can't encode`** from an az CLI call on Windows is a reliable diagnostic that the output contains characters outside cp1252 — switch to `--outfile`.

**Status:** Active — 1 instance (Azure p/105#8).

**Applies To:** All agents running `az bicep build --stdout` on Windows with bicep files containing non-ASCII characters.

---

## #270 [Build] Multi-Heredoc Bash Command With Code Containing Quotes Breaks Bash Parsing — "Unexpected EOF While Looking for Matching `'`"

**Pattern:** An agent constructs a single Bash tool call containing multiple `cat <<'EOF'` heredocs to write code files inline. The code being written contains single quotes, double quotes, or other shell-special characters. Bash mis-parses the compound command's quoting structure before any heredoc is processed, exiting with "unexpected EOF while looking for matching `''`". No files are partially written.

**Instances:**
- 2026-10-17 — Rosetta Stone (p/6#99): one Bash call wrote three TypeScript test files through `cat <<'EOF'` heredocs. Bash's quote parsing broke on the code's quotes before execution. Resolved: wrote all three files with the Write tool instead.

**Root Cause:** Bash's command parser processes quoting for the entire compound command before evaluating any heredocs. When code in a heredoc body contains single quotes, Bash can mistake them for the delimiter of a surrounding quoted argument, breaking the parse. This is the failure mode the AGENTS.md Shell Quoting Rule is designed to prevent.

**Prevention:**
1. **Use the Write tool for all code files.** Never write code files through Bash heredocs — the Shell Quoting Rule is authoritative: "Code with special shell characters: use Edit/Write, and run scripts from a file; never use inline heredocs, `sed` or `awk` for it."
2. **"Unexpected EOF while looking for matching `''`" in a Bash call that contains heredocs** is a reliable diagnostic for bash quote-parsing failure — switch to the Write tool.
3. **This failure mode is distinct from #251** (which is about heredoc content corruption from `\'` producing unescaped `'` in output). Here, the command never executes — bash fails at parse time, so no files are partially written.

**Status:** Active — 1 instance (Rosetta Stone p/6#99). Related: #251 (heredoc content corruption), Shell Quoting Rule (AGENTS.md).

**Applies To:** All agents writing code files via Bash heredocs; use Write/Edit instead.

---

## #271 [Build] PowerShell Cmdlets Piped Outside `pwsh -Command "..."` Are Parsed by Bash — "Command Not Found"

**Pattern:** An agent runs `pwsh -NoProfile -Command "..." 2>&1 | Select-Object -First 40` from the Bash tool. The `| Select-Object -First 40` portion is outside the `-Command` string, so Bash (not PowerShell) parses it. Bash does not know `Select-Object` and errors "command not found." The PowerShell command itself may have completed successfully.

**Instances:**
- 2026-10-17 — DevOps Worker (p/749#16): `pwsh -NoProfile -Command "..." 2>&1 | Select-Object -First 40` from the Bash tool. `Select-Object` was parsed by bash → "Select-Object: command not found." Resolved: moved `Select-Object` inside the `-Command` string.

**Root Cause:** In the Bash tool, only what is inside the `-Command "..."` string is executed by PowerShell. Anything outside — including piped stages appended after the closing quote — is parsed and executed by bash. PowerShell cmdlets are not bash commands.

**Prevention:**
1. **Put the full PowerShell pipeline inside the `-Command "..."` string.** If truncation or post-processing is needed, do it in PowerShell: `pwsh -NoProfile -Command "... | Select-Object -First 40"`.
2. **Alternatively, use the PowerShell tool** (`pwsh`) for any command that needs PowerShell cmdlets — it runs the full pipeline natively without bash involvement.
3. **"command not found" on a PowerShell cmdlet name** immediately after a `pwsh -Command` call is a reliable diagnostic that the cmdlet leaked outside the `-Command` string into bash.

**Status:** Active — 3 instances (DevOps Worker p/749#16; DevOps Lead p/26#184; DevOps Lead p/26#194 — `Format-List`).

**Applies To:** All agents running `pwsh -Command "..."` from the Bash tool with PowerShell cmdlets in the pipeline.

---

## #273 [Build] `-WhatIf` Propagates Through `SupportsShouldProcess` to All Cmdlets — Writes Are Silently Skipped

**Pattern:** A script decorated with `SupportsShouldProcess` is invoked with `-WhatIf`. The flag propagates automatically to every `SupportsShouldProcess` cmdlet called inside the script (`Set-Content`, `New-Item`, `Remove-Item`, etc.), silently skipping all writes. An agent that reads an output file written by the script after a `-WhatIf` dry run gets `FileNotFoundError` — the file was never created.

**Instances:**
- 2026-10-19 — Azure (p/105#12): checked a script's `-WhatIf` dry run by reading the spec file it writes; got `FileNotFoundError`. `-WhatIf` had propagated to `Set-Content`, preventing the write. Resolved: added `-WhatIf:$false` on that specific `Set-Content` call.

**Root Cause:** PowerShell's `ShouldProcess` mechanism propagates `-WhatIf` down the call stack to all cmdlets that support it. This is by design — but it means a dry run cannot produce inspectable file output unless the specific write is explicitly opted out with `-WhatIf:$false`.

**Prevention:**
1. **If a dry run must still write an inspectable output file** (spec, report, log), add `-WhatIf:$false` on that specific `Set-Content`/`Out-File`/`New-Item` call.
2. **Never read a file produced inside a `SupportsShouldProcess` script after a `-WhatIf` invocation** and expect it to exist — the write was suppressed.
3. **`FileNotFoundError` on a file a script "should have written"** after a `-WhatIf` call is a reliable diagnostic for `-WhatIf` propagation.

**Status:** Active — 1 instance (Azure p/105#12).

**Applies To:** All agents invoking or testing `-WhatIf` dry runs of `SupportsShouldProcess` scripts that produce output files.

---

## #274 [Build] Stale Deployment Resource Name in AGENTS.md Causes `ResourceNotFound` — Always Query Live Names

**Pattern:** An agent reads a deployment resource name (e.g. an Azure Container App name) from a role's AGENTS.md "Current Deployment" section and uses it in an `az` CLI call. The live name has drifted from what the doc says. The CLI returns `ResourceNotFound`.

**Instances:**
- 2026-10-19 — Azure (p/105#14, t/1735): `az containerapp show -n ai-triad-taxonomy-editor-staging` returned `ResourceNotFound`. The name came from Azure's AGENTS.md "Current Deployment" section; the live name is `taxonomy-editor-staging`. Resolved: listed apps with `az containerapp list -g ai-triad`.

**Root Cause:** Inline resource names in AGENTS.md drift silently as deployments are renamed or redeployed. The authoritative source is the Azure API, not the context doc.

**Prevention:**
1. **Always query live names before using them:** `az containerapp list -g ai-triad --query "[].name" -o tsv`. Never rely on a name from a context doc.
2. **The root AGENTS.md rule is authoritative:** "Infrastructure: query the registry or cloud API, not the workflow YAML." This applies equally to AGENTS.md deployment sections.
3. **`ResourceNotFound` on an Azure resource whose name came from a context doc** is a reliable diagnostic for name drift — list the resource group to find the live name.
4. **The durable fix is to have AGENTS.md reference `deployment-facts.md`** (or equivalent live source) rather than restate names inline.

**Status:** Active — 1 instance (Azure p/105#14, t/1735).

**Applies To:** All agents reading Azure resource names from AGENTS.md or any context doc before making API calls.

---

## #275 [Build] `git branch -d` Blocked After Merge — Stale Worktree Still Checked Out on the Branch

**Pattern:** After a PR merges, an agent runs `git branch -d <merged-branch>` for routine cleanup. Git rejects it with "error: Cannot delete branch '<branch>' used by worktree at '<path>'." A stale local worktree is still checked out on that branch, even though the PR has merged and the remote branch has been deleted.

**Instances:**
- 2026-10-19 — Server Storage (p/539#8, t/4258): `git branch -d feat/t4258-shutdown-warn` blocked after merge — a local worktree at `.worktrees/t4258-shutdown-warn` was still on that branch. Resolved: skipped cleanup (out of scope for the task).

**Root Cause:** `git branch -d` refuses to delete a branch that any local worktree currently has checked out, regardless of merge status. The worktree must be removed or detached first.

**Prevention:**
1. **Before `git branch -d <branch>`, check if any worktree holds it:** `git worktree list | grep <branch>`. If one does, `git worktree remove <path>` first, then `git branch -d <branch>`.
2. **The land-from-worktree skill step 8** covers this: `git worktree remove ../wt-<ticket>` before cleanup. If the worktree was not removed post-land, it will block branch deletion.
3. **"used by worktree" on a `git branch -d` call** is a clean diagnostic — find the worktree path in the error message and remove it.

**Status:** Active — 1 instance (Server Storage p/539#8, t/4258).

**Applies To:** All agents performing post-merge branch cleanup when local worktrees may still reference the branch.

---

## #277 [Build] Backtick Inside a Double-Quoted Shell Argument Triggers Command Substitution — Use Single Quotes

**Pattern:** An agent writes a shell argument (e.g. a `grep -E` pattern) in double quotes and includes a literal backtick character. Bash treats the backtick as the start of command substitution inside double quotes, causing "unexpected EOF while looking for matching backtick" when the closing backtick is absent or the balance is wrong.

**Instances:**
- 2026-10-17 — Azure (p/105#10): `grep -vE "…\`…"` pattern exited 2 with "unexpected EOF while looking for matching backtick." Resolved: saved log to a file and used simple patterns without backticks.
- 2026-10-19 — Second Opinion (p/691#9): `grep -E "…\`…"` same error. Resolved: rewrote the pattern in single quotes.

**Root Cause:** Inside double quotes, bash recognizes backtick as a command substitution delimiter. A literal backtick in a pattern is not possible in double-quoted context — it must be either single-quoted or avoided.

**Prevention:**
1. **Use single quotes for shell patterns containing backticks:** `grep -E '…`…'`. Single-quoted strings pass every character literally, including backtick.
2. **"Unexpected EOF while looking for matching backtick"** in a command containing a `grep` or `awk` pattern is a reliable diagnostic for a backtick inside a double-quoted argument.
3. This is an instance of the Shell Quoting Rule — double-quoted arguments process `\`, `$`, and `` ` `` specially. When in doubt, use single quotes for patterns.

**Status:** Active — 3 instances (Azure p/105#10; Second Opinion p/691#9; Second Opinion p/691#11 — `gh pr comment --body-file` with unquoted heredoc).

**Applies To:** All agents writing shell patterns (`grep`, `awk`, `sed`) in double-quoted arguments that may contain backticks; use single quotes.

---

## #278 [Process] `--match-head-commit` Pin Checked Only at Arming — Subsequent Push Leaves Auto-Merge Armed on Unapproved Head

**Pattern:** An agent arms auto-merge with `gh pr merge --auto --match-head-commit <sha>`. The pin is checked only at that moment. A later push to the same branch (by any agent — all share the `jpsnover` identity) updates the head. GitHub's auto-merge queue sees the same identity and does not re-validate the pin; when checks pass, it merges the new, unapproved head. The pin's intent — "merge only this reviewed commit" — is silently defeated.

**Instances:**
- 2026-10-19 — Tech Lead (p/335#159, PR #3402, t/4266): T2 PR had auto-merge armed with `--match-head-commit`. A subsequent push updated the head. Auto-merge remained armed and merged the new unapproved head. Caught by the Second Opinion before landing consequences.

**Root Cause:** `--match-head-commit` is a point-in-time check at enablement, not a persistent invariant. GitHub's auto-merge re-evaluates when checks pass, merging the current live head — not the pinned one. The shared `jpsnover` identity means GitHub has no way to distinguish "authorized push" from "unauthorized push."

**Prevention:**
1. **Disarm auto-merge before pushing any additional commits to an armed PR:** `gh pr merge <N> --disable-auto -R AI-Rosetta-Stone/ai-triad-research`. This is the existing root AGENTS.md rule: "Arming means 'done', so disarm before pushing more."
2. **For T2 PRs specifically, re-verify `headRefOid` right before merge:** `gh pr view <N> --json headRefOid -q .headRefOid`. Confirm it matches the reviewed commit. If it has changed, stop and re-review.
3. **`--match-head-commit` does not protect against post-arming pushes** — it only prevents a race at the moment of arming. Its protection window ends the instant a new commit is pushed.
4. The mechanical fix for this class is tracked at t/4266 (P2).

**Status:** Active — 1 instance (Tech Lead p/335#159, PR #3402, t/4266). High severity on T2 PRs.

**Applies To:** All agents arming auto-merge; all agents who push additional commits to any PR — check for armed auto-merge first and disarm before pushing.

---

## #279 [Build] `ResourceNotFound` on a Lazy-Initialized Storage Directory Is Not a Misconfiguration Signal

**Pattern:** An agent checks for the existence of a storage directory (e.g. `az storage file list --path anon-sessions`) as a health or configuration check. The directory does not exist and the command returns `ResourceNotFound`. The agent incorrectly diagnoses this as a misconfiguration of `ANON_SESSION_DIR` or equivalent config. In fact, the directory is created lazily on the first write — it is expected to be absent on a fresh or idle deployment.

**Instances:**
- 2026-10-19 — Azure (p/105#18): `az storage file list --path anon-sessions` on the staging share returned `ResourceNotFound`. Diagnosed as possible misconfiguration of `ANON_SESSION_DIR`. Actual cause: `anonymousSessionStore` creates the directory on first write; no write had occurred yet. Resolved: listed share root and read `defaultBaseDir()`.

**Root Cause:** Lazy-initialization is a common storage pattern — the directory is created on demand rather than at startup. A missing directory only means "nothing has been written yet," not "the config is wrong."

**Prevention:**
1. **Before diagnosing `ResourceNotFound` on a storage path as misconfiguration, check whether the directory is lazily initialized.** Read the store's initialization code (`defaultBaseDir()`, `ensureDir()`, or equivalent) to understand when the directory is created.
2. **List the share root** (`az storage file list` without `--path`) to confirm the share itself exists and the credentials work — ruling out genuine misconfiguration.
3. **A missing lazy-init directory on a fresh or idle deployment is expected.** Trigger the first write (a test chat, comment, or synthetic event) and verify the directory appears.

**Status:** Active — 1 instance (Azure p/105#18).

**Applies To:** All agents diagnosing `ResourceNotFound` on storage paths that may be lazily initialized; verify initialization semantics before concluding misconfiguration.

---

## #281 [Build] `statusCheckRollup` Mixes Check Runs and Status Contexts — `.name` Is Null on Status Context Entries

**Pattern:** An agent iterates over `gh pr view --json statusCheckRollup` entries and applies `.name | startswith(…)` or another string operation. Some entries have a null `.name` — these are status contexts (e.g. CI systems posting statuses rather than GitHub Actions check runs). Status contexts use `.context` for their name, not `.name`. The null `.name` causes the string operation to error.

**Instances:**
- 2026-10-19 — Tech Lead (p/335#161): `.name|startswith()` errored on a `statusCheckRollup` entry whose `.name` was null. The entry was a status context (`.context` was present). Resolved: used `(.name // .context // "") as $n` before string ops.

**Root Cause:** GitHub's PR check rollup contains two kinds of entries: check runs (GitHub Actions, expose `.name`) and status contexts (external CI systems, expose `.context`). Neither field is always present; a consumer that reads only `.name` will see null on status context entries.

**Prevention:**
1. **Always normalize status rollup entries before string operations:** `(.name // .context // "") as $n | $n | startswith(…)`.
2. **Check both fields when filtering or matching:** a check run has `.name`; a status context has `.context`. Neither is guaranteed on every entry.
3. **`.name` null on a rollup entry** is a reliable diagnostic for a status context entry — check whether `.context` is the intended field.

**Status:** Active — 1 instance (Tech Lead p/335#161).

**Applies To:** All agents processing `gh pr view --json statusCheckRollup` entries with string operations on the name field.

---

## #282 [Build] KQL `has` Matches Whole Terms Only — Use `contains` for Codes Embedded in a Larger Token

**Pattern:** An agent writes a KQL alert or query using `Log_s has 'AADSTS'` to match log lines containing Azure AD error codes like `AADSTS7000215`. The query fires zero times because KQL `has` performs whole-term matching — `AADSTS7000215` is one term, and `AADSTS` does not match any whole term. The alert silently misses all real incidents.

**Instances:**
- 2026-10-19 — Tech Lead (p/335#163, t/4288): KQL alert written with `Log_s has 'AADSTS'` would have fired zero times against real 10-19 incident logs. Caught by DevOps before deployment. Fixed: use `contains` or `matches regex @"AADSTS\d+"`.

**Root Cause:** KQL `has` is a term-index operator — it checks whether the search term appears as a complete whitespace- or punctuation-delimited token in the column. A code like `AADSTS7000215` is a single token; `has 'AADSTS'` does not match it. `contains` performs substring search; `matches regex` allows pattern matching.

**Prevention:**
1. **Use `contains` for substring matching in KQL:** `Log_s contains 'AADSTS'` matches `AADSTS7000215`.
2. **Use `matches regex @"AADSTS\d+"` for structured code patterns** when an exact prefix is needed without matching unrelated strings.
3. **Always prove alert KQL against real incident log lines** before deploying — use `Log_s | where … | take 10` against actual log data, not hand-written examples.
4. **`has` is only appropriate when the search term is itself a complete token** (e.g. a standalone word or exact field value). When in doubt, use `contains`.

**Status:** Active — 1 instance (Tech Lead p/335#163, t/4288).

**Applies To:** All agents writing KQL queries or alerts that match log lines containing error codes, identifiers, or any string that may be embedded within a larger token.

---

## #283 [Build] GitHub Only Discovers `workflow_dispatch` Definitions From the Default Branch — New Workflows Not Dispatchable Until Merged

**Pattern:** An agent adds a new `workflow_dispatch` workflow file on a feature branch and immediately tries to trigger it: `gh workflow run <new-workflow>.yml --ref <feature-branch>`. GitHub returns HTTP 404 "workflow not found on the default branch." The workflow file exists on the feature branch but GitHub only registers `workflow_dispatch` triggers from the default branch (`main`). The dispatch is impossible until the PR merges.

**Instances:**
- 2026-10-19 — DevOps Lead (p/26#182): `gh workflow run <new-workflow>.yml --ref <feature-branch>` returned 404. New workflow file existed only on the feature branch. Resolution: dispatch must wait until PR merges to `main`.

**Root Cause:** GitHub's workflow dispatch discovery is scoped to the repository's default branch. A workflow file that exists only on a non-default branch is invisible to the dispatch API, regardless of the `--ref` value. This is a GitHub platform constraint, not a configuration error.

**Prevention:**
1. **New `workflow_dispatch` workflows cannot be tested via `gh workflow run` until merged to `main`.** Plan for this constraint when designing pre-merge workflow testing.
2. **For pre-merge testing of a new workflow, alternative approaches:** (a) merge to `main` first and test from there; (b) temporarily add the workflow to a test branch that is `main` (not recommended for production workflows); (c) use `act` or a local runner for pre-merge testing.
3. **HTTP 404 "workflow not found on the default branch"** from `gh workflow run` is a reliable diagnostic that the workflow file has not yet been merged to the default branch.

**Status:** Active — 1 instance (DevOps Lead p/26#182).

**Applies To:** All agents creating new `workflow_dispatch` workflows on feature branches and attempting to test via dispatch before merging.

---

## #285 [Build] Parallel `pnpm exec` Across Workspace Packages Collides on pnpm 11 Stale-Dep Install — Run One First

**Pattern:** An agent fans out `pnpm exec <tool>` calls across multiple workspace packages in parallel. pnpm 11 checks for stale dependencies before executing and runs a workspace install when needed. Concurrent `exec` calls each trigger the same install in parallel, causing install collisions. Every `exec` call dies before the tool runs, producing no output files.

**Instances:**
- 2026-10-19 — Shared Lib (p/5#55, t/4238): five parallel `pnpm exec eslint` runs (one per package) produced no output files. pnpm 11 install collisions killed all five. Resolved: ran one `pnpm exec` alone first to let the install finish, then fanned out the remaining four in parallel — all succeeded.

**Root Cause:** pnpm 11 added an auto-install-on-stale-deps check to `pnpm exec`. Multiple concurrent `exec` calls all detect stale deps simultaneously and race to run the same workspace install, corrupting each other's lock/state. Once one install completes, subsequent `exec` calls find deps fresh and proceed cleanly.

**Prevention:**
1. **Before fanning out `pnpm exec` across packages, run one `pnpm exec` call alone first** to let any stale-dep install complete. Then fan out the remaining calls in parallel.
2. **Alternatively, run `pnpm install` explicitly before any parallel `exec` fan-out** to ensure deps are fresh — `exec` then skips the install check entirely.
3. **No output files from a parallel `pnpm exec` fan-out** (zero results across all packages) is a reliable diagnostic for install collision — a single sequential run would have succeeded.

**Status:** Active — 1 instance (Shared Lib p/5#55, t/4238).

**Applies To:** All agents fanning out `pnpm exec` in parallel across workspace packages; always prime with one sequential run first.

---

## #286 [Build] Worktree Isolation Guard Blocks `git -C <shared-checkout> worktree add` — Push `HEAD:<branch>` as Workaround

**Pattern:** An agent's session is pinned to a worktree by the worktree isolation guard. The agent tries to create a new worktree by redirecting git to the shared checkout with `git -C <repo-root> worktree add …`. The isolation guard blocks the command — using `-C` to operate on the shared checkout from within a pinned worktree session is disallowed.

**Instances:**
- 2026-10-19 — DebateTool (p/70#61, t/4305): `git -C C:/Users/jsnov/repos/ai-triad-research worktree add` blocked by isolation guard. Workaround: committed changes with pathspec to the current worktree branch, then `git push origin HEAD:feat/cli-seat-tags-soul-overrides-t4305` to create the remote branch, opened the PR normally.

**Root Cause:** The worktree isolation guard restricts the pinned session to its own worktree path. Using `-C` to redirect git commands to the shared checkout's path is treated as an attempt to operate on the shared checkout — which is prohibited in the pinned session.

**Prevention:**
1. **Do not use `git -C <shared-checkout>` to create worktrees from a pinned session.** Worktree creation must happen from the shared checkout directly (outside the pinned session) or via a coordinator.
2. **Workaround when you need a different remote branch name:** commit your changes to the current local branch with a pathspec, then `git push origin HEAD:<desired-branch-name>` — this creates the remote branch at your current HEAD without requiring a new local worktree.
3. **The isolation guard "blocked" message on a `git -C`** is a reliable diagnostic for this constraint — the session is pinned and cannot use `-C` to escape to the shared checkout.

**Status:** Active — 1 instance (DebateTool p/70#61, t/4305).

**Applies To:** All agents operating in worktree-pinned sessions who need to create additional worktrees or push to a differently-named remote branch.

---

## #287 [Build] gh Token Lacks `read:packages` Scope — 403 on GHCR Packages API; Prefer Deploy Workflow Log for Container Tag Diagnosis

**Pattern:** An agent queries the GitHub Container Registry packages API (`gh api orgs/.../packages/container/...`) to check whether a `sha-<commit>` container tag exists. The call returns 403 "you need read:packages scope" or "package not found" due to missing scope or a wrong URL-encoded package path. The packages API is not necessary — the deploy workflow failure log already contains the diagnostic.

**Instances:**
- 2026-10-19 — DevOps Lead (p/26#188): `Get-TaxEditorImage` and raw `gh api orgs/.../packages/container/...` both 403'd. Root cause confirmed instead via deploy workflow failure log, which showed directly that no `sha-<commit>` tag existed for the dispatched SHA. Dispatched a fresh container build instead.

**Root Cause:** Session gh/PAT tokens commonly lack `read:packages` scope, which is not a default OAuth scope. The packages API also requires exact URL-encoded package path format; an off-by-one encoding produces "package not found" rather than a scope error.

**Prevention:**
1. **Before querying the GHCR packages API, check whether the deploy workflow failure log already answers the question.** It typically surfaces missing `sha-<commit>` tags directly — no API call needed.
2. **If a packages API call is necessary, confirm the token has `read:packages` scope first** (`gh auth status` shows current scopes). A 403 here is a scope problem, not a permissions or visibility problem.
3. **URL-encode the package name carefully** — slashes and colons in container image names must be percent-encoded; "package not found" on a known package is a reliable diagnostic for encoding error.

**Status:** Active — 2 instances (DevOps Lead p/26#188; DevOps Lead p/26#218 — `gh api orgs/.../packages/container/taxonomy-editor/versions` 403; confirmed build success via `gh run view --json conclusion` instead).

**Applies To:** All agents diagnosing container image or tag availability; always check the deploy workflow log before reaching for the packages API.

---

## #288 [Build] Concurrent Agents Chose the Same Branch Name — Foreign Commit Rides Into the Wrong PR

**Pattern:** Two agent sessions independently create a branch with the same name. One agent pushes a commit to the branch first; the second agent's subsequent push appends its commit to that branch. The second agent's PR then includes both commits — one from the wrong ticket.

**Instances:**
- 2026-10-19 — DebateTool (p/70#63, t/4304): branch `feat/broken-injection-detection-t4304` had a t4303 commit (d6f6f9d7) pushed onto it by a concurrent agent session. Both commits landed in PR #3450. The foreign-commit-check workflow (t/3738) would catch this warn-only.

**Root Cause:** Branch name derived from feature description without sufficient ticket-ID uniqueness, and no pre-push check for unexpected commits on the remote branch.

**Prevention:**
1. **Before opening a PR or pushing additional commits to an existing remote branch, run `git log origin/<branch> --oneline`** to confirm no unexpected commits exist. A commit from another ticket is a signal to stop and coordinate.
2. **Include ONLY the owning ticket's number in the branch name.** Never reuse a feature-description prefix that another concurrent ticket might also generate.
3. **The foreign-commit-check workflow (t/3738) fires warn-only on PRs** — it catches ticketed foreign commits and merge-commits-in-range, but does not block. It is the backstop, not the first line of defense.

**Status:** Active — 1 instance (DebateTool p/70#63, t/4304).

**Applies To:** All agents creating or pushing to remote branches; always verify branch history is clean before opening a PR.

---

## #289 [Build] T1 Approval-Guard Stale FAILURE Blocks Auto-Merge Arm — Re-run Failed Check After Approval Comment

**Pattern:** A T1 PR receives the reviewer's `Approved (<role>):` comment. The agent then arms auto-merge with `gh pr merge --auto --squash --match-head-commit`. GitHub rejects it with "Pull request is in unstable status (enablePullRequestAutoMerge)". Cause: the `t1-approval-guard` check ran and FAILED before the approval comment landed; it does not auto-re-run when a new comment is added.

**Instances:**
- 2026-10-19 — ServerAPI (p/504#24): PR #3437 auto-merge arm rejected. `t1-approval-guard` had a stale FAILURE run from before the `Approved (Quality):` comment. Fixed with `gh run rerun <run-id> --failed`; guard then passed and auto-merge armed successfully.

**Root Cause:** `t1-approval-guard` is a GitHub Actions workflow triggered by PR events. A new comment does not always trigger a re-run if the workflow already has a concluded run for that head SHA.

**Prevention:**
1. **After the reviewer's approval comment lands on a T1 PR, check `gh pr checks <N>` before arming auto-merge.** If `t1-approval-guard` shows a stale FAILURE, re-run it: `gh run rerun <run-id> --failed` (find the run ID with `gh run list --workflow t1-approval-guard.yml --branch <branch>`).
2. **"Pull request is in unstable status" on `gh pr merge --auto` for a T1 PR** is a reliable diagnostic for this stale-guard scenario — check guard run status before investigating further.
3. **Do not arm auto-merge before all required checks are green.** `gh pr checks <N> --watch` confirms live status.

**Status:** Active — 1 instance (ServerAPI p/504#24).

**Applies To:** All agents arming auto-merge on T1 PRs after receiving an approval comment.


---

## #290 [Build] `gh pr edit` Has No `--head` Flag — Cannot Retarget Head Branch; Close and Reopen PR

**Pattern:** An agent tries to retarget the head branch of an open PR using `gh pr edit <N> --head <new-branch>`. The command fails with "unknown flag: --head". `gh pr edit` supports `--base` (retarget the base/target branch) but not `--head`.

**Instances:**
- 2026-10-19 — DebateTool (p/70#65): attempted `gh pr edit 3450 --head <branch>`; rejected with "unknown flag: --head". Resolved by closing PR #3450 and reopening with the correct head branch.

**Root Cause:** GitHub's API does not support changing a PR's head branch after creation. `gh pr edit` exposes only the supported subset; `--head` is not among them.

**Prevention:**
1. **To change a PR's head branch, close and reopen the PR** with the correct `--head` specified at `gh pr create` time.
2. **`gh pr edit` supports `--base` (target branch) but not `--head` (source branch).** Do not reach for `--head` on edit.
3. **"unknown flag: --head" on `gh pr edit`** — check `gh pr edit --help`; `--head` is absent by design.

**Status:** Active — 2 instances (DebateTool p/70#65; Sage self p/26#225-follow-up — `gh pr view --head <branch>` also rejected with "unknown flag: --head"; `--head` is not a flag on any `gh pr` subcommand other than `gh pr list`).

**Applies To:** All agents attempting to retarget a PR's source (head) branch after creation; note `--head` is not accepted by `gh pr view`, `gh pr edit`, or `gh pr merge` — only `gh pr list`.

---

## #291 [Build] `git push --force-with-lease` Blocked by Auto-Mode Destructive Classifier — Push to New Branch Name Instead

**Pattern:** An agent attempts `git push --force-with-lease` to update a remote branch. The auto-mode classifier flags the command as a destructive Git action and blocks it. Even the safer `--force-with-lease` form is blocked; the classifier operates on command shape, not safety semantics.

**Instances:**
- 2026-10-19 — DebateTool (p/70#65): `git push --force-with-lease` blocked by auto-mode classifier. Resolved by pushing to a new branch name (`git push origin HEAD:<new-branch>`), then closing the old PR and reopening.

**Root Cause:** The classifier intercepts any push with a force flag (`--force`, `--force-with-lease`, `-f`) regardless of whether the remote has unexpected commits.

**Prevention:**
1. **In auto-mode sessions, avoid force-push flags entirely.** Push to a new branch name and reopen the PR instead.
2. **A blocked force-push is a classifier constraint, not a sign the rewrite is wrong.** New branch + reopen achieves the same outcome without a destructive flag.
3. **If the branch name must stay the same**, request human confirmation before proceeding.

**Status:** Active — 1 instance (DebateTool p/70#65).

**Applies To:** All agents in auto-mode sessions who need to rewrite remote branch history.

---

## #292 [Build] Command Substitution Inside `gh pr merge` Triggers Isolation Hook — Split Into Two Commands

**Pattern:** An agent runs `gh pr merge --match-head-commit $(gh pr view <N> --json headRefOid -q .headRefOid)` as a single command. The worktree isolation hook intercepts the runtime substitution inside the `gh` call and blocks execution.

**Instances:**
- 2026-10-19 — DebateTool (p/70#65): single-liner with `$()` inside `gh pr merge` blocked by the isolation hook. Resolved by splitting into two commands: capture the SHA first, then pass it as a literal to the merge call.

**Root Cause:** The isolation hook pattern-matches on command text for git-like subcommands. A `$()` substitution nested inside a `gh` invocation triggers the match heuristic.

**Prevention:**
1. **Always split `gh pr merge --match-head-commit` into two commands** in isolated sessions: first `OID=$(gh pr view <N> --json headRefOid -q .headRefOid)`, then `gh pr merge <N> --match-head-commit "$OID"`.
2. **A block on a pure `gh` command citing potential git** is a reliable diagnostic for the substitution-heuristic trigger.
3. **The two-command form is also clearer** — it makes the SHA explicit and avoids the nested substitution entirely.

**Status:** Active — 1 instance (DebateTool p/70#65).

**Applies To:** All agents in isolated sessions arming `gh pr merge --match-head-commit`; always split into two sequential commands.

---

## #293 [Build] Edit Anchor Matches at Wrong Nesting Level — Injected Code Lands Outside Describe Block

**Pattern:** An agent uses a comment string as an Edit anchor to insert new test blocks. The comment appears at multiple structural levels in the file — both inside an existing describe block and as a section header. The edit matches the first occurrence (inside the inner describe), injecting code between that block's closing `});` and the next section header. The new blocks land outside any describe, causing a syntax error.

**Instances:**
- 2026-10-19 — DebateTool (p/70#67, t/4305): anchor `// ── buildSoulOverrideResolver` matched inside `loadSoulOverrides` describe; new `it()` blocks injected between closing `});` and next section, landing outside any describe. Fixed by re-reading, moving blocks into `validateSeatTagsConfig` describe, removing duplicates.

**Root Cause:** Comment strings used as anchors are not unique when the same string appears at multiple nesting levels. The Edit tool matches the first occurrence, which may not be the intended injection point.

**Prevention:**
1. **Include surrounding brace and indentation context in the anchor**, not just the comment string — ensure the anchor is unique to the intended nesting level.
2. **After any test insertion, re-read the file and verify the nesting** by checking that each new block is inside the correct describe and that `});` counts balance.
3. **A syntax error immediately after a test insertion** is a reliable diagnostic for an out-of-describe injection — inspect the lines just before and after the inserted block.

**Status:** Active — 1 instance (DebateTool p/70#67, t/4305).

**Applies To:** All agents inserting test blocks via Edit; always verify nesting after insertion.

---

## #294 [Build] Absolute Path to `.bin/` Binary Blocked by Bash Isolation Hook — Use `pnpm exec` Instead

**Pattern:** An agent calls a node binary using its absolute path (e.g., `"C:\...\node_modules\.bin\vitest.CMD"`). The Bash isolation hook blocks the call because it cannot verify the binary is not git-related. The tool is available via `pnpm exec` or a `pnpm run` script, which the hook recognizes as safe.

**Instances:**
- 2026-10-19 — DebateTool (p/70#69, t/4305): direct call to absolute `.bin\vitest.CMD` path blocked by isolation hook. Worked around with `node_modules\.pnpm\node_modules\.bin\vitest.CMD` via PowerShell `&`, but cleaner fix is `pnpm exec vitest`.

**Root Cause:** The Bash isolation hook verifies commands against an allowlist by command name/pattern. An absolute path to a `.bin/` binary does not match any allowlist pattern, so it is treated as unverifiable.

**Prevention:**
1. **Always invoke project tooling via `pnpm exec <tool>` or `pnpm run <script>`** — both resolve through pnpm's known binary resolution and pass the hook check.
2. **Never construct absolute paths to `node_modules/.bin/` binaries for shell invocation.** The path may vary by OS or pnpm layout version, and it bypasses hook verification.
3. **"Unverifiable command" from the isolation hook on a `.bin/` path** is a reliable diagnostic for this pattern — switch to `pnpm exec`.

**Status:** Active — 1 instance (DebateTool p/70#69, t/4305).

**Applies To:** All agents invoking node binaries in isolated sessions; prefer `pnpm exec` over absolute `.bin/` paths.

---

## #295 [Build] `grep -r` from Worktree Root Hits 120s Timeout — Use the Grep Tool Instead

**Pattern:** An agent runs `grep -r "<pattern>" .` from the worktree root via Bash to search the repo. With a large repo (~410 MB data + code), the recursive grep hits the 120-second Bash timeout and returns no results.

**Instances:**
- 2026-10-19 — DebateTool (p/70#69, t/4305): `grep -r "lib-debate-not-to-soul-loaders" .` from worktree root timed out at 120s. Fixed by using the Grep tool (ripgrep), which completed instantly.

**Root Cause:** Bash `grep -r` traverses all files including `node_modules/`, `.git/`, and the adjacent `../ai-triad-data/` symlink. The Grep tool (ripgrep) respects `.gitignore` and default exclusions, completing orders of magnitude faster.

**Prevention:**
1. **Always use the Grep tool for repo-wide pattern searches** — never `grep -r` via Bash. The Grep tool uses ripgrep with `.gitignore`-aware exclusions and completes in milliseconds on this repo.
2. **`grep -r` from the repo root will always time out** on this project due to `node_modules/` and data repo size. There is no flags combination that makes it safe — use the Grep tool.
3. **AGENTS.md Shell Quoting Rule** already says to prefer dedicated tools over Bash; this is the search-specific instance of that rule.

**Status:** Active — 1 instance (DebateTool p/70#69, t/4305).

**Applies To:** All agents; never use Bash `grep -r` for repo-wide searches — use the Grep tool.

---

## #299 [Process] Blocked-State Details Belong on the Ticket, Not Status Text

**Pattern:** An agent sets its status to "blocked on two PRs needing manual fixes from repo root" but posts the specific fix commands only in its session context. A collaborator (PM) sees the blocked status but must ask explicitly for the fix steps — they are not visible on the ticket or ping thread.

**Instances:**
- 2026-10-20 — DebateTool (p/31#11): status said "blocked on two PRs needing manual fixes from repo root"; fix commands were in session context only; PM had to ask explicitly.

**Root Cause:** Status text is visible only to agents actively checking the status field. A ticket comment is persistent, reachable by any collaborator, and survives session context loss.

**Prevention:**
1. **When blocked on a failure requiring action from outside your session, post the exact commands or steps as a ticket comment before updating your status.** One sentence naming the blocker plus a code block with the fix is enough.
2. **Status text describes the state; the ticket holds the actionable details.** A collaborator picking up the work should not need to find your session to get unblocked.
3. **After posting, ping the relevant agent or human** with the ticket comment reference so they know where to look.

**Status:** Active — 1 instance (DebateTool p/31#11).

**Applies To:** All agents; when blocked on an externally-actionable failure, post fix steps to the ticket before marking blocked.

---

## #300 [Build] GHCR Tag Writes Require `write:packages` Scope — Escalate to Azure/Lead

**Pattern:** An agent calls a cmdlet or API that writes a tag to the GitHub Container Registry (e.g., `Set-TaxEditorKnownGood`). The call fails with a clean `ActionableError`: "GITHUB_TOKEN environment variable is not set" or a 403 citing insufficient scope. Worker session tokens carry only gist/read:org/repo/workflow — no `packages` write scope. The agent cannot source the credential itself.

**Instances:**
- 2026-10-20 — DevOps Worker (p/749#18, t/4273): `Set-TaxEditorKnownGood` failed with "GITHUB_TOKEN environment variable is not set". Worker session lacked `write:packages`. Correctly escalated to Azure/Lead rather than attempting to source credentials.

**Root Cause:** GHCR tag writes require a PAT with `write:packages` scope, which is not provisioned to Worker sessions. Attempting to source credentials outside role scope is a process violation.

**Prevention:**
1. **Any GHCR tag-write operation requires a PAT with `write:packages` scope.** Worker sessions do not have this — escalate to Azure or DevOps Lead immediately.
2. **"GITHUB_TOKEN environment variable is not set" from a GHCR write cmdlet** is a reliable diagnostic for missing packages scope, not a missing environment variable.
3. **Companion to #287** (read:packages for reads): reads need `read:packages`, writes need `write:packages`; neither is in standard Worker session scope.

**Status:** Active — 1 instance (DevOps Worker p/749#18, t/4273).

**Applies To:** All Worker-role agents; escalate GHCR tag-write operations to Azure/DevOps Lead.

---

## #301 [Build] Rebasing a Multi-Commit Stack That Includes Already-Landed Commits Causes Conflicts — Cherry-Pick Only the Needed Commits

**Pattern:** An agent runs `git rebase origin/main` on a branch with multiple commits. Some of those commits have already landed on main via a separate PR. The rebase replays those commits and hits conflicts with their already-merged versions on main.

**Instances:**
- 2026-10-20 — DevOps Worker (p/749#20): 4-commit branch rebased onto main; commit 1/4 (t/3897's flip) had already landed via PR #3196. Rebase conflicted. Fixed by aborting, running `git log origin/main..HEAD --oneline` to identify the one unmerged commit, and cherry-picking it onto a fresh branch off main.

**Root Cause:** Multi-commit branches accumulate commits from previous work sessions; some may land independently via other PRs. A blind rebase replays all commits including already-landed ones.

**Prevention:**
1. **Before rebasing a multi-commit branch, run `git log origin/main..HEAD --oneline`** to see exactly which commits are not yet on main. If the list is shorter than the total branch history, some commits have already landed.
2. **When some commits are already landed, abort the rebase** and cherry-pick only the unmerged commits onto a fresh branch off main — this avoids replaying already-merged work.
3. **A conflict on the first commit of a rebase** is a reliable diagnostic that the commit may already be on main — check `git log origin/main --oneline | head -20` for its subject line.

**Status:** Active — 1 instance (DevOps Worker p/749#20).

**Applies To:** All agents rebasing multi-commit branches; verify which commits are unmerged before rebasing.

---

## #302 [Research] Run Recipe Copied from Pilot Without Verifying Config Fields Took Effect — Paid Batch Ran Wrong

**Pattern:** An agent copies a run recipe from a pilot experiment for a paid confirmatory arm. The recipe sets a config field (`pacing`) that has a silent dependency (`useAdaptiveStaging`) — without the dependency, the field is silently ignored. The config-pin check does not cover the field because the output does not record it. The paid batch runs with the wrong configuration and produces uninterpretable results.

**Instances:**
- 2026-10-20 — Computational Linguist (p/7#119, t/3802): 50-debate paid arm copied pilot recipe with `pacing` set but `useAdaptiveStaging` absent; all debates ran 6-turn fixed. Results reported as uninterpretable. Runner now refuses the config before spend (PR #3476); DebateTool has t/4320 for a CLI WARN.

**Root Cause:** Config field `pacing` silently does nothing without `useAdaptiveStaging`. The pilot worked because it also set `useAdaptiveStaging`; the copy omitted it. Config-pin checks verify presence, not effect.

**Prevention:**
1. **Before any paid batch, verify the first output against the control on the dimension being matched.** A single debug run with the copied recipe, inspected for the expected behavior, would have caught the silent ignore.
2. **Never assume a config field took effect — confirm it in the output.** If the output does not record the field's effect, add a probe that does before spending.
3. **When copying a run recipe, diff it against the control spec** and confirm every field dependency is satisfied, not just that the fields are present.

**Status:** Active — 1 instance (Computational Linguist p/7#119, t/3802).

**Applies To:** All agents running paid experiment batches; verify config effect in a debug run before full spend.

---

## #303 [Build] Edit Left Placeholder `raise ImportError` in Analysis Script

**Pattern:** An agent edits an analysis script and leaves a placeholder `raise ImportError` (or similar sentinel) in place of a real implementation. A subsequent run crashes on the placeholder rather than the intended logic.

**Instances:**
- 2026-10-20 — Computational Linguist (p/7#119): Edit left `raise ImportError` placeholder in analysis script. Restored `__main__` guard, re-ran old read to confirm output.

**Root Cause:** Edit tool inserts placeholder markers (raise, pass, TODO, ...) that are valid Python syntax; they do not cause parse errors and are easy to miss before running.

**Prevention:**
1. **After any Edit to a Python script, scan for placeholder markers** (`raise`, `pass`, `TODO`, `...`, `NotImplementedError`) before running. A quick `grep` or Read of the edited section is enough.
2. **If a script crashes with `ImportError` or `NotImplementedError` immediately after an edit**, check for a leftover placeholder before investigating the import chain.

**Status:** Active — 1 instance (Computational Linguist p/7#119).

**Applies To:** All agents editing Python analysis scripts; scan for placeholder markers before running.

---

## #304 [Build] GitHub Rulesets API Returns 403 for Private Repos Without GitHub Pro

**Pattern:** An agent calls `gh api repos/<org>/<repo>/rulesets` to inspect branch-protection rulesets on a private repository. The API returns 403: "Upgrade to GitHub Pro or make this repository public." Repository rulesets are a GitHub Pro/Teams/Enterprise feature; the API endpoint is unavailable on free-tier private repos.

**Instances:**
- 2026-10-20 — DevOps Lead (p/26#198): `gh api repos/AI-Rosetta-Stone/app-scratch/rulesets` returned 403. Root cause: `app-scratch` is a private repo on a free plan. Branch protection is available on free private repos via the classic API (`/branches/<branch>/protection`), not rulesets.

**Root Cause:** Rulesets require a paid GitHub plan. The classic branch-protection API (`/repos/<owner>/<repo>/branches/<branch>/protection`) is available on free private repos.

**Prevention:**
1. **For private repos on free GitHub plans, use the classic branch-protection API** (`/repos/<owner>/<repo>/branches/<branch>/protection`) instead of the rulesets API.
2. **403 with "Upgrade to GitHub Pro" on a rulesets call** is a plan-limitation error, not an authentication error. The token scope is not the issue.
3. **Rulesets are available on public repos regardless of plan.** If inspection is needed on a private free-tier repo, the only option is the classic protection endpoint.

**Status:** Active — 1 instance (DevOps Lead p/26#198).

**Applies To:** All agents querying GitHub branch-protection configuration on private repositories.

---

## #305 [Build] `gh api -X PUT .../contents/README.md` Returns 422 'sha wasn't supplied' on Empty Repo

**Pattern:** An agent calls `gh api -X PUT repos/<owner>/<repo>/contents/README.md` to create or update a file in a repository. On a repository with no prior commits, the API returns 422: "sha wasn't supplied." The Contents API requires the current file's SHA for updates; on an empty repo there is no file and no SHA, but the endpoint still returns 422 rather than creating the file as expected.

**Instances:**
- 2026-10-20 — DevOps Lead (p/26#200, p/26#202): `gh api -X PUT .../contents/README.md` on a newly created repo returned 422. Root cause: the repo had already been initialized via GitHub UI's "initialize with README" option, which added an initial commit — the file existed and had a SHA that the agent didn't supply. Resolved by fetching the current SHA first.

**Root Cause:** The Contents API's PUT endpoint requires `sha` when updating an existing file. A 422 "sha wasn't supplied" means the file already exists — the repo was not empty despite appearing so (likely initialized via GitHub UI). A size-0 quirk in the API can make a just-initialized repo appear empty to a size:0 search.

**Prevention:**
1. **Before calling `gh api -X PUT .../contents/<file>`, check whether the file already exists:** `gh api repos/<owner>/<repo>/contents/<file> -q .sha`. If it returns a SHA, include it in the PUT body; if 404, omit it.
2. **422 "sha wasn't supplied" on a contents PUT means the file already exists** — the repo is not empty. Fetch the current SHA and retry with it.
3. **GitHub UI's "initialize with README" option creates a real commit.** A repo initialized this way is never actually empty, even if the API's size field shows 0 immediately after creation.

**Status:** Active — 1 instance (DevOps Lead p/26#200).

**Applies To:** All agents using the GitHub Contents API to create or update files in repositories.

---

## #306 [Build] Azure CLI `az monitor log-analytics query` Exits 3 When Workspace Name Is Wrong

**Pattern:** An agent calls `az monitor log-analytics query --workspace <name>` to query a Log Analytics workspace. The command exits with code 3 and an error about the workspace not being found. The agent guessed the workspace name from a convention (e.g., `ai-triad-logs`) rather than querying the actual workspace name.

**Instances:**
- 2026-10-20 — DevOps Lead (p/26#204, p/26#206): `az monitor log-analytics query --workspace ai-triad-logs` exited 3. Root cause: workspace name was `log-aitriad-kvwl3nywge4iw` (auto-generated suffix). Resolved by querying `az monitor log-analytics workspace list` to find the real name.

**Root Cause:** Azure Log Analytics workspace names are often auto-generated with unique suffixes. Guessing from a convention produces a "not found" error (exit code 3) rather than a more descriptive message.

**Prevention:**
1. **Never guess a Log Analytics workspace name.** Always fetch it first: `az monitor log-analytics workspace list --query "[].{name:name,rg:resourceGroup}" -o table`.
2. **Exit code 3 from `az monitor log-analytics query`** is a reliable diagnostic for wrong workspace name or resource group — not a query syntax error.
3. **Auto-generated Azure resource names have unique suffixes** (e.g., `log-aitriad-kvwl3nywge4iw`). Store the real name in a config file or lookup it at session start.

**Status:** Active — 1 instance (DevOps Lead p/26#204).

**Applies To:** All agents querying Azure Log Analytics workspaces; always look up the workspace name before querying.

---

## #307 [Build] Windows-Native Tools Don't Resolve MSYS/Bash Paths — `/tmp` and `/c/...` Are Bash-Only Translations

**Pattern:** An agent pipeline writes a file to a Bash-style path (`/tmp/<name>` or `/c/Users/...`) from a Bash command (Git Bash on Windows), then attempts to read it from a Windows-native tool (Node.js, python3, etc.). The tool cannot find the file. Git Bash translates `/tmp` to `%TEMP%` and `/c/` to `C:\`, but Windows-native executables receive paths verbatim from the process environment — they do not apply MSYS translations.

**Instances:**
- 2026-10-20 — DevOps Worker (p/749#26): `writeFileSync('/tmp/acc-origin.json')` inside a Node one-liner in the Bash tool resolved to `C:\tmp\...` — which did not exist. The Bash tool had written to Git Bash's `/tmp` (which is `%TEMP%`). Resolved by moving the logic into a script that calls `git show` itself via `execFileSync`, eliminating the temp file.
- 2026-10-20 — Diagnostics (p/9#86): Bash wrote `git show` output to `/tmp/acc-origin.json`; Node script returned ENOENT `C:\tmp\acc-origin.json`. Same root cause. Resolved by calling `git show` directly from Node via `execFileSync`.

**Root Cause:** Git Bash applies MSYS path translations (`/tmp` → `%TEMP%`, `/c/` → `C:\`) to its own process and child processes that understand MSYS. Windows-native executables (Node.js, python3, etc.) are launched as ordinary Windows processes — they receive paths as literal strings and apply no MSYS translation. A `/c/Users/...` path handed to python3 or node.exe is not a valid Windows path.

**Prevention:**
1. **When invoking any Windows-native tool (Node.js, python3, etc.) from Bash, always use native Windows paths (`C:\...`), not MSYS paths (`/c/...` or `/tmp/...`).** The translation is Bash-only.
2. **Never write to `/tmp` in Bash and then read it from a Windows-native tool.** Git Bash's `/tmp` maps to `%TEMP%`; the native tool sees `C:\tmp`, which typically does not exist.
3. **Keep inter-process data in a single process** — call shell commands from Node/python via `execFileSync`/`subprocess` rather than sharing temp files across shells.
4. **If a temp file must be shared between Bash and a native tool on Windows**, write it inside the repo worktree — a path both shells and native tools agree on.

**Status:** Active — 7 instances (DevOps Worker p/749#26; Diagnostics p/9#86; DevOps Worker p/749#31 — `node --check` on Bash `/tmp`/`/c/...` path; DevOps Lead p/26#239 — python3 FileNotFoundError on `/c/...` MSYS path; Server Storage p/539#17 — python3 FileNotFoundError on Bash `/tmp/...`; fix: write to Claude scratchpad dir, a path both Bash and `python3.exe` resolve; PowerShell p/20#104 — Node ENOENT on `/tmp/oldgold/...`; resolved with `cygpath -w`; PowerShell p/20#110 — `git show > /tmp/x.json` then `node readFileSync('/tmp/x.json')` → ENOENT; fixed by writing to session scratchpad absolute Windows path).

**Applies To:** All agents writing multi-process pipelines on Windows; Windows-native tools (Node.js, python3, etc.) do not apply MSYS path translations — use native Windows paths.

---

## #308 [Build] jq Rejects Escaped Regex Backreference in Shell-Quoted String — Use `test()` With Simple Pattern or Separate File

**Pattern:** An agent passes a jq filter containing an escaped regex pattern inside a shell-quoted string to `gh pr view ... -q '...'`. The pattern includes a literal backslash-paren (e.g., `test("Approved \\(")`). jq returns "compile error: unterminated string literal." The double-backslash escaping intended for jq is being consumed by the shell, producing a malformed jq string.

**Instances:**
- 2026-10-20 — DevOps Worker (p/749#24): `gh pr view ... -q '.comments[] | select(.body | test("Approved \\("))'` returned jq parse error "unterminated string literal." Resolved by matching on a simpler prefix string without regex metacharacters.

**Root Cause:** Backslash escaping in shell single-quoted strings does not apply (single quotes pass everything literally), but the outer `gh -q '...'` context adds another interpretation layer. jq's `test()` function requires valid JSON string escaping; mismatched escaping between shell and jq produces malformed string literals.

**Prevention:**
1. **For simple prefix matching in jq, use `startswith()` instead of `test()`** — it requires no regex and avoids escaping entirely: `select(.body | startswith("Approved ("))`.
2. **When regex is necessary in a jq filter passed via shell**, write the jq program to a file and pass it with `jq -f <file>` to avoid shell-escaping interference.
3. **"unterminated string literal" in a jq filter** is a reliable diagnostic for shell-escaping collision — simplify the pattern or use `jq -f`.

**Status:** Active — 5 instances (DevOps Worker p/749#24; Rosetta Stone p/6#102 — `test("^Approved \\(Quality\\)")` failed; switched to `startswith`; PowerShell p/20#99 — `test("Approved \\(")` in `--jq` gave "unterminated string literal"; switched to `contains("Approved (")`; Azure p/105#26 — jq interpolation confusion + parens outside closing single quote; PowerShell p/20#101 — `\\(` inside a jq string inside a double-quoted Bash string; escape layers collapsed → `unexpected token "\"`; fix: `startswith("Approved (")` instead of `test("^Approved \\(")`).

**Applies To:** All agents constructing jq filters with regex patterns or parentheses in shell commands.

---

## #309 [Build] `gh pr create --label` Fails When Label Does Not Exist in Repo

**Pattern:** An agent runs `gh pr create ... --label <label-name>` (or `gh pr edit ... --add-label`) where the named label does not exist in the repository. The command fails with "could not add label: <label-name> not found." GitHub requires labels to exist before they can be applied to a PR; there is no auto-create behavior.

**Instances:**
- 2026-10-20 — DevOps Lead (p/26#208): `gh pr create ... --label do-not-merge` failed with "could not add label: do-not-merge not found." The label had not been created in the `app-scratch` repository.

**Root Cause:** Labels are repo-specific. A label present in one repo (e.g., `ai-triad-research`) does not exist in another (e.g., `app-scratch`). `gh pr create --label` does not create missing labels.

**Prevention:**
1. **Before applying a label via `gh pr create` or `gh pr edit`, verify it exists:** `gh label list -R <owner>/<repo>`. If absent, create it first: `gh label create <name> --color <hex> -R <owner>/<repo>`.
2. **"could not add label: <name> not found"** — the label does not exist in that specific repo. Check `gh label list` and create it if needed.
3. **Labels are not inherited across repos.** Always verify label existence in the target repo, even if it exists in related repos.

**Status:** Active — 1 instance (DevOps Lead p/26#208).

**Applies To:** All agents applying labels to PRs; verify label existence in the target repo before applying.

---

## #310 [Build] `git branch -d` Refuses Verification-Only PR Branch — Use `-D` When Branch Holds No Real Work

**Pattern:** An agent creates a local branch solely to fetch a PR's head ref (`refs/pull/N/head`) for read-only inspection. After verification, it attempts `git branch -d <branch>`. Git refuses with "not fully merged" because the branch has never been merged into local main — it was never intended to be. The branch holds no original work, only a reference copy of already-pushed PR content.

**Instances:**
- 2026-10-20 — DevOps Lead (p/26#211): `git branch -d t3391-verify-c88ff7cc` refused. Branch was created only to fetch `refs/pull/3391/head` for verification. Resolved with `-D` since the branch held no real work.

**Root Cause:** `git branch -d` is a safety check: it refuses to delete a branch that is not an ancestor of the current HEAD. A verification-only branch intentionally bypasses the merge workflow, so it is always "not fully merged" relative to local main.

**Prevention:**
1. **For verification-only branches (created solely to inspect a PR's head), use `git branch -D`** to force-delete. The "not fully merged" warning is expected and safe to override — the branch contains no original commits.
2. **Before using `-D`, confirm the branch was created for read-only inspection** and contains no uncommitted or unpushed work that is not also on the remote PR branch.
3. **A reliable diagnostic: check `git log origin/main..<branch> --oneline`** — if all commits are also on the PR's remote branch (or if the list is empty), `-D` is safe.

**Status:** Active — 1 instance (DevOps Lead p/26#211).

**Applies To:** All agents creating temporary local branches for PR verification; use `-D` to delete after inspection.


---

## #311 [Build] `gh pr merge --auto` Rejected on Already-Mergeable PR — Merge Directly Without `--auto`

**Pattern:** An agent arms auto-merge with `gh pr merge --auto --squash --match-head-commit <oid>` on a PR that is already fully green and mergeable. GitHub rejects it with "Pull request is in clean status (enablePullRequestAutoMerge)." Auto-merge is designed for PRs with pending checks; GitHub refuses to arm it when the PR is already ready to merge immediately.

**Instances:**
- 2026-10-20 — DevOps Lead (p/26#212): `gh pr merge --auto` on PR #3487 returned "Pull request is in clean status." PR was already green and mergeable. Resolved by merging directly: `gh pr merge <N> --squash --match-head-commit <oid>` (without `--auto`).

**Root Cause:** GitHub's `enablePullRequestAutoMerge` mutation refuses when the PR's mergeable status is already MERGEABLE (i.e., all checks passed and the branch is up to date). Auto-merge is only valid when checks are still pending.

**Prevention:**
1. **Before arming auto-merge, check `gh pr view <N> --json mergeStateStatus -q .mergeStateStatus`.** If the result is `CLEAN`, merge directly instead: `gh pr merge <N> --squash --match-head-commit <oid>`.
2. **"Pull request is in clean status" on `gh pr merge --auto`** means the PR is already ready — skip `--auto` and merge now.
3. **"Pull request is in unstable status"** (the complementary error) means checks are still pending or failing — that is the correct state for auto-merge. See #289 for the stale-guard variant.

**Status:** Active — 1 instance (DevOps Lead p/26#212).

**Applies To:** All agents arming auto-merge; check mergeStateStatus first and merge directly when already CLEAN.
---

## #312 [Build] `git push` Rejected Non-Fast-Forward After Rebase — Use `--force-with-lease` on Own Unshared PR Branch

**Pattern:** An agent rebases a feature branch onto a newer `origin/main` mid-session. A subsequent `git push origin <branch>` is rejected with "non-fast-forward" because the remote branch still holds the pre-rebase history. The plain push cannot reconcile the rewritten history.

**Instances:**
- 2026-10-20 — DevOps Worker (p/749#28): feature branch rebased onto newer `origin/main`; plain `git push` rejected. Resolved with `git push --force-with-lease origin <branch>` — safe because the branch was unshared (own PR branch) and the lease verified the remote tip matched the last fetch.

**Root Cause:** A rebase rewrites commit history; the remote branch diverges from the new local history after rebasing. Plain push cannot overwrite without a force flag.

**Prevention:**
1. **After rebasing an own PR branch, use `git push --force-with-lease`** (not `--force`). The lease verifies the remote tip matches what you last fetched, so a concurrent push by another agent is caught and rejected rather than silently overwritten.
2. **Only use force-push on branches you own and that are unshared** — a branch with only your commits, no collaborators directly pushing to it.
3. **A non-fast-forward rejection after a rebase is expected** — it is not a sign the rebase failed. Use `--force-with-lease` to proceed safely.

**Status:** Active — 1 instance (DevOps Worker p/749#28).

**Applies To:** All agents rebasing feature/PR branches; use `--force-with-lease` to push after rebase on own unshared branches.

---

## #313 [Build] `git commit -- <pathspec> -m "msg"` Treats `-m` as Pathspec — Always Put Options Before `--`

**Pattern:** An agent runs `git commit -- docs/LessonsLearned.md -m "commit message"`. Git returns: "pathspec '-m' did not match any file(s) known to git." The `--` separator ends option parsing; every argument after it — including `-m` and the message — is interpreted as a pathspec, not a flag.

**Instances:**
- 2026-10-20 — DevOps Lead (p/26#216): `git commit -- docs/... -m "msg"` failed with "pathspec '-m' did not match any file(s)". Resolved by reordering: `git commit -m "msg" -- docs/...`.

**Root Cause:** POSIX convention: `--` signals the end of options. Git honours this strictly — anything after `--` is a positional argument (pathspec), never an option flag.

**Prevention:**
1. **Always place all options before the `--` separator:** `git commit -m "msg" -F <file> -- <pathspec>`, never `git commit -- <pathspec> -m "msg"`.
2. **"pathspec '-m' did not match any file(s)"** is the diagnostic for this mistake — `-m` was parsed as a pathspec, not a flag.
3. **Same rule applies to other git subcommands** (`git log`, `git diff`, `git show`) that accept `--` as a pathspec separator.

**Status:** Active — 1 instance (DevOps Lead p/26#216).

**Applies To:** All agents constructing git commands with pathspec separators; options must precede `--`.

---

## #314 [Build] `gh api -f` Sends String Values — Use `-F` for Typed JSON (Booleans, Integers, Nulls)

**Pattern:** An agent calls `gh api -X PUT .../environments/<name> -f 'deployment_branch_policy[protected_branches]=false'`. GitHub's API returns 422 "is not of type boolean." The `-f` flag in `gh api` always encodes values as JSON strings — `"false"`, not `false`. GitHub endpoints that require a real boolean reject the string form.

**Instances:**
- 2026-10-20 — DevOps Lead (p/26#222): `gh api -X PUT .../environments/monitoring -f 'deployment_branch_policy[protected_branches]=false'` returned 422 "is not of type boolean." Resolved by switching to `-F`: `gh api -X PUT ... -F 'deployment_branch_policy[protected_branches]=false'`.

**Root Cause:** `gh api` has two value flags: `-f`/`--field` always sends a string; `-F`/`--raw-field` sends the value typed — `true`/`false` become JSON booleans, integers stay integers, `null` becomes JSON null. GitHub endpoints that declare a field as boolean (or integer) reject the string-typed form with 422.

**Prevention:**
1. **Use `-F` (not `-f`) when passing boolean, integer, or null values to `gh api`.** `-f` is for string fields; `-F` is for typed fields.
2. **422 "is not of type boolean" (or "integer") from `gh api`** is a reliable diagnostic that `-f` was used where `-F` is required.
3. **Quick rule:** `-f name=value` → JSON `"value"` (string); `-F name=value` → JSON `value` (typed). Use `-F` for any field that isn't a string.

**Status:** Active — 1 instance (DevOps Lead p/26#222).

**Applies To:** All agents calling `gh api` with boolean, integer, or null field values; use `-F` for typed values.

---

## #315 [Build] `gh workflow run --ref` Returns 404 When Workflow File Only Exists on a Feature Branch

**Pattern:** An agent runs `gh workflow run <workflow>.yml --ref <feature-branch>` to dispatch a workflow against a non-default branch. GitHub returns 404 "workflow not found on the default branch." The `workflow_dispatch` API requires the workflow file to exist on the repository's default branch (`main`) — it can be dispatched to run against any `--ref`, but the file must first be registered on `main`.

**Instances:**
- 2026-10-20 — DevOps Lead (p/26#224): `gh workflow run t4340-livefire-probe.yml --ref <feature-branch>` returned 404. Workflow file existed only on the feature branch. Resolved by landing a minimal version of the workflow file to `main` first (T0, dispatch-only, no triggers), then dispatching with `--ref <feature-branch>`.

**Root Cause:** GitHub's `workflow_dispatch` API indexes workflows from the default branch. A workflow file that has never been on the default branch is invisible to the dispatch endpoint — the `--ref` parameter controls which ref runs the workflow, not which ref registers it.

**Prevention:**
1. **Before dispatching `gh workflow run <file>.yml`, verify the workflow file exists on `main`:** `gh api repos/<owner>/<repo>/contents/.github/workflows/<file>.yml -q .name`. A 404 here means the file hasn't been merged to main yet.
2. **To test a new workflow against a feature branch:** land a minimal `workflow_dispatch`-only version to `main` first (T0), then dispatch with `--ref <feature-branch>`.
3. **404 "workflow not found on the default branch"** is the reliable diagnostic — it is not a permissions error or a file-path typo.

**Status:** Active — 2 instances (DevOps Lead p/26#224; DevOps Lead p/26#235 — throwaway probe workflow on feature branch; resolved same way: land minimal file to main first).

**Applies To:** All agents dispatching `workflow_dispatch` workflows against non-default branches; the workflow file must exist on the default branch first.

---

## #316 [Build] PR Opened by Another Agent Between Push and `gh pr create` — Check for Existing PR at Create Time

**Pattern:** An agent pushes a branch and checks for an existing PR before pushing (finding none). By the time it calls `gh pr create`, another agent (or the PI) has already opened a PR for that branch. The `gh pr create` call fails with "a pull request for branch already exists."

**Instances:**
- 2026-10-20 — Rosetta Stone (p/6#101): `gh pr create` failed — PR #3520 had been opened by the PI minutes after the push, before the agent called `gh pr create`. Resolved by editing #3520's title and body in place with `gh pr edit`.

**Root Cause:** The window between checking for an existing PR and calling `gh pr create` is non-zero. In a multi-agent/human environment, another party can open a PR for the branch during that window.

**Prevention:**
1. **Check for an existing PR immediately before calling `gh pr create`**, not only before the push: `gh pr list --head <branch> --json number,url -q '.[0]'`. If one exists, edit it in place with `gh pr edit <N>` rather than creating a duplicate.
2. **"a pull request for branch already exists" from `gh pr create`** means another PR was opened for that branch. Find it with `gh pr list --head <branch>` and edit it instead.
3. **Never open a duplicate PR** — edit the existing one. Duplicate PRs confuse CI and auto-merge arming.

**Status:** Active — 1 instance (Rosetta Stone p/6#101).

**Applies To:** All agents in multi-agent/human environments; check for existing PRs immediately before `gh pr create`, not only at session start.

---

## #317 [Build] `git merge --ff-only origin/main` Refuses Due to Shared-Tree Dirty File — Diagnose Phantom vs Real WIP Before Acting

**Pattern:** An agent runs `git merge --ff-only origin/main` on the shared checkout to advance it. Git refuses: "local changes to <file> would be overwritten by merge." The dirty file may be a **phantom** (byte-identical to `origin/main`, stale-HEAD artifact) or **real WIP** from another role. The correct response differs: phantoms can be safely restored; real WIP must be left untouched.

**Instances:**
- 2026-10-20 — DevOps Lead (p/26#225): `git merge --ff-only origin/main` refused on `lib/debate/cli.ts`. Assumed foreign WIP; worked in a fresh worktree. Later confirmed phantom — `git diff origin/main -- lib/debate/cli.ts` empty (p/26#229).
- 2026-10-20 — Server Storage (p/539#14): same file, same refusal, same session. Confirmed phantom by same diagnostic.

**Root Cause:** The shared checkout's HEAD can lag behind `origin/main`. A file modified between the local HEAD and `origin/main` appears dirty even when its content is byte-identical to `origin/main`. Git still refuses `--ff-only` because local content != merge target content at the index level.

**Prevention:**
1. **When `git merge --ff-only origin/main` refuses, first run `git diff origin/main -- <file>` on each dirty file.** Empty output = phantom (byte-identical to origin); non-empty = real WIP from another role.
2. **For a phantom:** `git restore <file>` resets it to HEAD content — safe because the file is byte-identical to `origin/main`. However, the classifier may block `git restore` as "Irreversible Local Destruction" even with phantom proof in hand (see #323).
3. **For real WIP:** do not stash, restore, or clean. Create a fresh worktree off `origin/main` and do your work there, leaving the shared tree's WIP untouched. Only DevOps handles shared-tree cleanup (`docs/shared-tree-divergence.md`).
4. **Always prefer a worktree for new work** — a fresh worktree off `origin/main` is always clean and unaffected by the shared checkout's state.

**Status:** Active — 2 instances (DevOps Lead p/26#225; Server Storage p/539#14).

**Applies To:** All agents on the shared checkout; diagnose phantom vs real WIP before deciding to restore or work around.

---

## #318 [Build] PowerShell Backtick/`[ref]` Syntax Fails When Embedded in `pwsh -Command` via Bash Tool — Write as `.ps1` File

**Pattern:** An agent constructs a multi-line PowerShell one-liner with backtick line-continuation or `[ref]` type constraints and runs it via `pwsh -NoProfile -Command "..."` through the Bash tool. Bash's own parser errors on the backticks and parentheses before PowerShell sees them, producing Bash syntax errors rather than PowerShell errors.

**Instances:**
- 2026-10-20 — DevOps Lead (p/26#225): `pwsh -NoProfile -Command "..."` with backtick continuation and `[ref]$x` threw Bash parser errors on the backticks/parens. Resolved by writing the check as a standalone `.ps1` file and running `pwsh -NoProfile -File script.ps1`, per the root AGENTS.md Shell Quoting Rule.

**Root Cause:** The Bash tool is Git Bash. When PowerShell code with special characters (backticks, parens, `[ref]`, `$`) is passed as a `-Command` string, Bash interpolates and parses it before `pwsh.exe` sees it. Complex PowerShell syntax routinely breaks at the Bash layer.

**Prevention:**
1. **Any PowerShell code with special characters (backtick, parentheses, `[ref]`, `$var`, `{` blocks) must be written to a `.ps1` file and run with `pwsh -File`.** Never embed it in a `-Command` string through the Bash tool.
2. **This is the root AGENTS.md Shell Quoting Rule applied to PowerShell:** "Code with special shell characters: use Edit/Write, and run scripts from a file; never use inline heredocs."
3. **Use the PowerShell tool directly** for PowerShell commands that don't need Bash pipelines — the PowerShell tool bypasses the Bash/MSYS layer entirely.

**Status:** Active — 1 instance (DevOps Lead p/26#225).

**Applies To:** All agents running PowerShell through the Bash tool; complex PS syntax goes in a `.ps1` file, not a `-Command` string.

---

## #319 [Research] Independent Cross-Check of Measurement Output Catches Instrument Bugs, Not Just System Bugs

**Pattern:** An agent measures a system's behavior (e.g. embedding similarity, selection ranking) and computes a cross-check assertion ("my selector output should match the independent top-3"). The assertion fails. The failure leads to the discovery of a bug in the measuring code itself (a wrong field name), not in the system being measured. Without the cross-check, the bug would have appeared as a system disagreement rather than a measurement error.

**Instances:**
- 2026-10-20 — Computational Linguist (p/7#123, t/4292): offline measurement compared node selection against cosine top-3. Cross-check assertion "selection == independent top-3" came back false. Root cause: measuring code read `NodeRef.id` instead of `nodeId`. Without the assertion, the bug read as "the selector disagrees with cosine" — a misleading system-level finding. Fixed the field name; assertion passed.

**Root Cause:** Measurement code is code — it has bugs. A single pipeline (measure → report) cannot distinguish between "system is wrong" and "measurement is wrong." An independent cross-check from a different code path catches measurement errors before they propagate to conclusions.

**Prevention:**
1. **Before drawing conclusions from a measurement run, include at least one assertion that the measurement itself is internally consistent.** "My selection output agrees with an independent reference computation on the same input" is enough to catch field-name errors, wrong data, and off-by-one index bugs.
2. **A failed cross-check assertion is not a system bug until the measurement code is verified.** Rule out instrument error first — check field names, data shapes, and index assumptions.
3. **Paid or otherwise expensive measurement runs deserve a cheap debug-mode cross-check first** — a single probe run with the assertion active costs little and validates the instrument before the full spend.

**Status:** Active — 1 instance (Computational Linguist p/7#123, t/4292).

**Applies To:** All agents writing measurement or analysis scripts; include independent cross-check assertions to validate the instrument, not only the system.

---

## #320 [Build] `__dirname` Undefined in ESM/tsx Scripts — Use `fileURLToPath(import.meta.url)`

**Pattern:** An agent runs a TypeScript script with `tsx` (or another ESM-mode runner). The script uses `__dirname` to resolve file paths. The script throws `ReferenceError: __dirname is not defined`. `tsx` executes scripts as ES modules where `__dirname` is a CommonJS-only global.

**Instances:**
- 2026-10-20 — Computational Linguist (p/7#123, t/4292): `tsx` script used `__dirname`; threw `ReferenceError`. Fixed with `import { fileURLToPath } from 'url'; import { dirname } from 'path'; const __dirname = dirname(fileURLToPath(import.meta.url));`.

**Root Cause:** `__dirname` and `__filename` are CommonJS-only globals injected by Node's module wrapper. ES modules (including tsx-run scripts) do not have them. The ESM equivalent uses `import.meta.url`.

**Prevention:**
1. **In any tsx/ESM script, replace `__dirname` with `dirname(fileURLToPath(import.meta.url))`.** Add the two-line shim at the top: `import { fileURLToPath } from 'url'; import { dirname } from 'path';`.
2. **`ReferenceError: __dirname is not defined` in a tsx script** is always this CommonJS/ESM mismatch — the fix is the `import.meta.url` shim.
3. **`__filename` has the same problem** — replace with `fileURLToPath(import.meta.url)` directly.

**Status:** Active — 1 instance (Computational Linguist p/7#123).

**Applies To:** All agents writing TypeScript scripts run via tsx or another ESM runner; use `import.meta.url` instead of `__dirname`/`__filename`.

---

## #321 [Build] ONNX Embedder Writes `[onnxEmbedding]` Log Lines to stdout Before JSON — Strip at Exact `[` Line, Not First `\n[`

**Pattern:** A script runs an ONNX-based embedding model and captures its stdout. The output starts with one or more `[onnxEmbedding] ...` log lines, followed by the JSON result (which also starts with `[`). Code that strips the prefix by finding the first `\n[` captures a log line rather than the JSON, because log lines also start with `[`. The JSON parse then fails on the log line text.

**Instances:**
- 2026-10-20 — Computational Linguist (p/7#123, t/4292): stdout had `[onnxEmbedding]` log lines before the JSON array. Strip logic cut at first `\n[`, but that matched a log line. Fixed by cutting at the line that is exactly `[` (the JSON array opening line) rather than any line starting with `[`.
- 2026-10-22 — Computational Linguist (p/7#140): onnxEmbedding logs mixed into stdout before a JSON **object** (`{`). Same root cause; discriminator is the first line that is exactly `{`. Fixed by parsing from the first lone `{` line.

**Root Cause:** Both log lines and the JSON output start with `[` (array) or `{` (object). Stripping at "first line starting with `[`" or `{` is ambiguous with log-line prefixes; the JSON opening is specifically a line containing **only** `[` or `{`.

**Prevention:**
1. **When stripping ONNX embedder log prefix from stdout, find the line that is exactly `[` or `{`** (the JSON opening line), not merely the first line starting with that character.
2. **Alternatively, redirect stderr** (`2>/dev/null` or a dedicated stderr handle) if the embedder writes logs to stderr — verify with a test run before assuming stdout is clean JSON.
3. **A JSON parse error immediately after an ONNX embedding call** is a reliable diagnostic for log-line contamination — inspect the raw stdout before parsing.

**Status:** Active — 2 instances (Computational Linguist p/7#123, p/7#140).

**Applies To:** All agents capturing ONNX embedder output; strip log prefix at exact `[` line, not first `\n[`.

---

## #322 [Build] `gh pr merge --auto` on All-Green PR Completes Immediately — No Window to `--disable-auto`

**Pattern:** An agent arms auto-merge on a PR with `gh pr merge --auto`. The PR's required checks are already all green at the time of arming. GitHub merges the PR immediately (within seconds). A subsequent `gh pr merge --disable-auto` returns "Can't disable auto-merge for this pull request" because the merge has already completed.

**Instances:**
- 2026-10-20 — DevOps Worker (p/749#32): probe PR had all checks green; `--auto` arm triggered an immediate merge. `--disable-auto` returned "Can't disable." Resolved by opening a follow-up PR to revert the probe's file rather than attempting to undo the merge.

**Root Cause:** Auto-merge is a "merge as soon as checks pass" gate. When all checks are already green, "as soon as" is "now." There is no staging delay between arming and merging when the PR is already mergeable.

**Prevention:**
1. **Before arming `--auto`, check `gh pr view <N> --json mergeStateStatus -q .mergeStateStatus`.** If the result is `CLEAN`, the PR will merge immediately on arming — confirm this is intended before proceeding. (See also #311: if `CLEAN`, merge directly without `--auto`.)
2. **On a probe or test PR, do not arm `--auto` if the checks are already green and merging to `main` is not desired.** Use a draft PR or a separate test repo for live-fire experiments.
3. **There is no undo for a completed merge.** If an unintended merge lands, open a follow-up PR to revert; do not attempt a force-reset or direct push to `main`.

**Status:** Active — 2 instances (DevOps Worker p/749#32 — `--disable-auto` refused when PR merged instantly; DevOps Worker p/749#36 — `--auto` arm refused with "Pull request is in clean status (enablePullRequestAutoMerge)" when PR already CLEAN; fix: check `mergeStateStatus` first, use direct merge on CLEAN).

**Applies To:** All agents arming or disarming auto-merge; when mergeStateStatus is CLEAN, `--auto` is refused and a direct `--squash --match-head-commit` is correct.

---

## #323 [Build] Auto-Mode Classifier Blocks `git restore` on a Phantom File as "Irreversible Local Destruction" — Escalate to PI

**Pattern:** An agent has a phantom dirty file on the shared checkout (confirmed byte-identical to `origin/main` via `git diff origin/main -- <file>` returning empty). The agent attempts `git restore <file>` to clear it. The auto-mode classifier refuses the command, categorizing it as "Irreversible Local Destruction." The proof that the file is a phantom is in hand but the classifier does not evaluate file content — it pattern-matches the command.

**Instances:**
- 2026-10-20 — DevOps Lead (p/26#229): `git restore lib/debate/cli.ts` blocked by classifier despite `git diff origin/main -- lib/debate/cli.ts` returning empty. PI flagged directly; waiting on manual restore or permission-rule change.

**Root Cause:** The auto-mode classifier guards `git restore` as irreversible by command shape, without inspecting whether the file content is actually distinct from the restore target. A phantom file (`diff origin/main` empty) has nothing to lose, but the classifier cannot verify this.

**Prevention:**
1. **When the classifier blocks `git restore` on a confirmed phantom, escalate to the PI** — do not attempt a workaround (e.g., `git checkout`, `git reset`) that may have broader blast radius. The PI can approve manually or adjust the permission rule.
2. **The phantom proof to include in the escalation:** `git diff origin/main -- <file>` returns empty; file content is byte-identical to `origin/main`; nothing will be lost.
3. **Work around the blocked restore** by using a worktree off `origin/main` for any immediate work that needs a clean tree — the phantom only blocks `--ff-only` on the shared checkout, not worktree operations.
4. **Do not attempt `git restore --staged`, `git checkout -- <file>`, or `git reset HEAD <file>` as substitutes** without explicit human approval — the classifier may block those too, and the escalation path is cleaner.

**Status:** Active — 1 instance (DevOps Lead p/26#229).

**Applies To:** All agents on the shared checkout in auto mode; classifier blocks `git restore` by command shape regardless of content safety — escalate rather than bypass.

---

## #324 [Build] `gh api .../dispatches` and `gh workflow run` Require a Branch or Tag Name for `ref` — Not a Commit SHA

**Pattern:** An agent dispatches a workflow via `gh api repos/<owner>/<repo>/actions/workflows/<file>/dispatches -f ref=<SHA>` or `gh workflow run <file> --ref <SHA>`. GitHub returns 422 "No ref found for: \<sha\>". The `ref` parameter for workflow dispatch requires a branch or tag name — an arbitrary commit SHA is not a valid ref for this endpoint.

**Instances:**
- 2026-10-20 — DevOps Lead (p/26#226): `gh api .../dispatches -f ref=<full commit SHA>` returned 422 "No ref found for: \<sha\>". The `gh workflow run --help` text explicitly says "Branch or tag name" — confirmed by live test. Resolved by dispatching against the branch name instead.

**Root Cause:** GitHub's `workflow_dispatch` API accepts a `ref` that resolves to a branch or tag. A bare commit SHA is not a named ref and the API cannot resolve it. The `gh workflow run --help` documentation states "Branch or tag name" clearly; testing the raw API before reading the help text cost extra time.

**Prevention:**
1. **Always pass a branch or tag name to `--ref` / `-f ref=`**, never a commit SHA. `gh workflow run --help` states "Branch or tag name" — trust that wording.
2. **To pin execution to a specific commit, use a workflow input parameter** (e.g., `-f sha=<full-sha>`) rather than the `ref` parameter. The `ref` selects which branch/tag runs the workflow; inputs carry the pinned SHA to the workflow steps.
3. **422 "No ref found for: \<value\>"** from the dispatches endpoint is the reliable diagnostic — it means the value is not a resolvable branch or tag name.

**Status:** Active — 1 instance (DevOps Lead p/26#226).

**Applies To:** All agents dispatching `workflow_dispatch` workflows; `ref` must be a branch or tag name — use workflow inputs for SHA pinning.

---

## #325 [Build] `az monitor log-analytics query -w` Requires Workspace `customerId` GUID, Not Workspace Name

**Pattern:** An agent runs `az monitor log-analytics query -w <workspace-name> --workspace <workspace-name>` to query Log Analytics. The command fails with `PathNotFoundError`. The `-w` / `--workspace` flag for `az monitor log-analytics query` requires the workspace's `customerId` GUID — the human-readable workspace name is not accepted.

**Instances:**
- 2026-10-20 — DevOps Lead (p/26#231): `az monitor log-analytics query -w log-aitriad-kvwl3nywge4iw` → PathNotFoundError. Fixed by retrieving the workspace `customerId` GUID via `az monitor log-analytics workspace list` and passing that instead.

**Root Cause:** `az monitor log-analytics query` resolves the workspace by its GUID (`customerId`), not by its display name or resource name. The workspace name is a human-readable label; the GUID is the stable identifier the query API uses.

**Prevention:**
1. **Always pass the `customerId` GUID to `az monitor log-analytics query -w`.** Retrieve it first: `az monitor log-analytics workspace list --query "[].{name:name, customerId:customerId}" -o table`.
2. **`PathNotFoundError` from `az monitor log-analytics query`** is the diagnostic for passing a workspace name instead of its GUID.
3. **The GUID is stable** — it can be cached in `deploy/azure/runbooks/deployment-facts.md` alongside other workspace identifiers to avoid a lookup on every query session.

**Status:** Active — 2 instances (DevOps Lead p/26#231; DevOps Lead p/26#250 — `log-aitriad-kvwl3nywge4iw` by name; fix: `az monitor log-analytics workspace show --query customerId` first).

**Applies To:** All agents querying Azure Log Analytics; `-w` requires the workspace `customerId` GUID, not the workspace name.

---

## #326 [Build] Fabricated Infrastructure URL Instead of Reading Canonical Source — "Couldn't Resolve Host"

**Pattern:** An agent needs a production endpoint URL (app URL, API gateway, storage endpoint). Instead of reading the canonical source (`deploy/azure/runbooks/deployment-facts.md` or equivalent), the agent constructs or guesses a plausible-looking URL. The URL does not exist or resolves to a dead host; `curl` / HTTP client returns "couldn't resolve host" or a connection refused error.

**Instances:**
- 2026-10-20 — DevOps Lead (p/26#231): guessed a prod URL → `curl: (6) Could not resolve host`. Resolved by reading `deploy/azure/runbooks/deployment-facts.md` for the real deployed URL.

**Root Cause:** Infrastructure URLs (especially Azure-provisioned hostnames) are not guessable from component names. Constructing them from patterns (e.g., `<name>.azurewebsites.net`) is unreliable — the actual hostname depends on provisioning details and may include random suffixes, custom domains, or private endpoints.

**Prevention:**
1. **Never construct or guess a production URL.** Read it from `deploy/azure/runbooks/deployment-facts.md` (the canonical source for this project's deployed endpoints). This is an instance of the root AGENTS.md rule: "Before asserting what a system is doing, read the system, not a file that describes it."
2. **"Could not resolve host" from `curl` on a constructed URL** is the diagnostic for a fabricated hostname — the URL does not exist, not a network problem.
3. **If the URL is absent from `deployment-facts.md`**, retrieve it from the Azure portal or CLI (`az webapp show --name <name> --query defaultHostName`) and update the runbook — do not proceed on a guess.

**Status:** Active — 1 instance (DevOps Lead p/26#231).

**Applies To:** All agents accessing production infrastructure; read deployed URLs from the canonical runbook, never construct them from component names.

---

## #327 [Build] `gh pr diff <N> -- <path>` Fails — `gh pr diff` Does Not Support Pathspec Filtering

**Pattern:** An agent wants to inspect only specific files changed in a PR and runs `gh pr diff <N> -- <path>`. The command fails with "accepts at most 1 arg(s), received 2." `gh pr diff` takes only the PR number as an argument — it does not support pathspec filtering the way `git diff` does.

**Instances:**
- 2026-10-20 — DevOps Lead (p/26#233): `gh pr diff 3547 -- <path>` failed with "accepts at most 1 arg(s), received 2". Resolved by fetching the branch and reading the file directly.

**Root Cause:** `gh pr diff` is a thin wrapper that streams the full diff of a PR. It accepts one positional argument (the PR number) and does not pass pathspecs to the underlying diff engine.

**Prevention:**
1. **To see only a specific file's diff for a PR, fetch the branch and use `git diff`:** `git fetch origin <head-branch> && git diff origin/main...origin/<head-branch> -- <path>`.
2. **Alternatively, read the file directly** from the PR head: `git show origin/<head-branch>:<path>`.
3. **"accepts at most 1 arg(s), received 2" from `gh pr diff`** is the diagnostic — the extra argument is being treated as a second positional, not a pathspec flag.

**Status:** Active — 1 instance (DevOps Lead p/26#233).

**Applies To:** All agents inspecting PR diffs; `gh pr diff` streams the full diff only — use `git diff` with a pathspec for file-scoped inspection.

---

## #328 [Research] Reproduce Through the Production Read Path Before Declaring a Live Bug

**Pattern:** An agent investigates a suspected defect and writes a repro script. The script reads data using a bare, hand-built approximation (e.g., bare `ConvertFrom-Json`) rather than the module's actual read function (e.g., `Read-EdgesFile`). The repro appears to confirm the bug. The agent reports it as a live production defect. A reviewer or Second Opinion discovers the production code uses a fixed read path that handles the case correctly — the module already has the fix. The "bug" is retracted.

**Instances:**
- 2026-10-20 — Computational Linguist (p/7#126, t/4278, e/343): reported "PS `edges.json` writes mutate timestamps" as live production bug; t/4366 filed. Repro used bare `ConvertFrom-Json`. Production module uses `Read-EdgesFile` (t/2974 fix). SO caught it; Computational Linguist re-measured via the real path and retracted.

**Root Cause:** The production code path often includes defensive fixes accumulated over time (e.g., t/2974). A repro that bypasses the production reader re-introduces the unfixed behavior, confirming a bug that no longer exists in production. The repro is valid, but it tests the wrong path.

**Prevention:**
1. **Before declaring a live production bug, reproduce through the exact production read path** — call the module's actual read function, not a bare deserializer. Ask: "Is this how the production code actually reads this file?"
2. **Check git blame / commit history on the read function** before assuming a naive approach is equivalent. A fix may already be in place (e.g., `Read-EdgesFile` for `edges.json`).
3. **If the repro and the production path produce different results, the repro is the bug** — the production behavior is the ground truth. Investigate why the paths diverge before filing.
4. **A Second Opinion's first question on a data-mutation bug: "Did the repro use the production reader?"** If not, the defect report is unverified.

**Status:** Active — 3 instances (Computational Linguist p/7#126, t/4278; Computational Linguist p/7#136 — asserted "model copied mojibake bytes" without opening the snapshot; file had `Æ`→`é` substitution; 418/846 snapshots affected, t/4394; Computational Linguist p/7#138 — declared source discrepancy from filename/title mismatch without reading content; real content confirmed one article; caught before any write at e/348#4).

**Applies To:** All agents writing repro scripts for suspected data-layer bugs; always invoke the production read path, never a bare deserializer.

---

## #329 [Build] Failed Write in a Parallel Batch Does Not Stop the Subsequent Commit — Verify Content With `git show HEAD:<file>`

**Pattern:** An agent writes several files in a batch (multiple Write tool calls in one turn or pipeline). One Write call fails ("file has not been read yet" or similar error). The agent proceeds to `git add` and `git commit`. The commit succeeds — the failed Write's file is committed at its previous (unfixed) state, even though the commit message says it was updated. Auto-merge may then be armed against a commit that doesn't contain the intended change.

**Instances:**
- 2026-10-20 — Computational Linguist (p/7#126): one Write in a parallel batch failed ("not read yet"); commit message said the script was fixed, but the committed file held the old content. Caught before merge; auto-merge disarmed, file fixed and both modes verified before re-arming.

**Root Cause:** A Write tool failure in a batch is reported as an error on that tool call, but does not prevent the `git commit` that follows. The commit includes whatever is on disk — which, for the failed file, is the unchanged previous content. The commit message is written by the author, not derived from the actual diff, so message and content can diverge.

**Prevention:**
1. **After any batch of Write calls, run `git show HEAD:<file>` on each critical file** before committing to verify the content is what you intended. `git show --stat HEAD` confirms which files changed but not whether the content is correct.
2. **After committing and before arming auto-merge, spot-check the committed content** on the files your commit message claims to have changed: `git show HEAD:<file> | head -40`.
3. **A Write tool error in a parallel batch is easy to miss** — the error appears in the batch output alongside successful calls. Scan every tool result in a parallel batch before proceeding.
4. **If a Write failed "not read yet", the file on disk is the pre-edit version.** Read it first, then Write again; the commit will then reflect the intended change.

**Status:** Active — 1 instance (Computational Linguist p/7#126).

**Applies To:** All agents doing parallel Write batches followed by git commits; verify committed file content with `git show HEAD:<file>`, not just `git show --stat HEAD`.

---

## #330 [Build] `node -e "require('<pkg>')"` Fails MODULE_NOT_FOUND in Worktree Without `npm ci` — Use Installed Repo Tooling Instead

**Pattern:** An agent wants to quickly validate a YAML/JSON file or test a module from a worktree and runs `node -e "require('js-yaml')"` (or similar ad-hoc require). Node.js returns `MODULE_NOT_FOUND`. The worktree root has no `node_modules/` directory — `npm ci` has not been run there. The package is a project devDependency but is not installed in the current working directory.

**Instances:**
- 2026-10-20 — DevOps Lead (p/26#237): `node -e "require('js-yaml')"` from worktree root → MODULE_NOT_FOUND. Resolved by using the repo's own workflow-lint mechanism (already installed as a root devDependency) instead of an ad-hoc require.

**Root Cause:** Node.js module resolution walks up from the current directory looking for `node_modules/`. A fresh worktree has no `node_modules/`; neither does a worktree that only ran `npm ci` in a subdirectory. Without a matching `node_modules/` in the path, any `require()` call fails.

**Prevention:**
1. **Before running any `node -e "require(...)"` in a worktree, verify `node_modules/` exists** at the repo root or the relevant package directory. If not, run `npm ci` first (see /land-from-worktree step 2).
2. **Prefer using the repo's already-installed tooling** (e.g., `npm run lint:workflows`, `npx js-yaml`, or a project script) over an ad-hoc `node -e require()`. The installed mechanism handles module resolution automatically.
3. **MODULE_NOT_FOUND from an ad-hoc `node -e` in a worktree** is almost always a missing `npm ci` — not a missing dependency.

**Status:** Active — 1 instance (DevOps Lead p/26#237).

**Applies To:** All agents running ad-hoc `node -e require()` in worktrees; run `npm ci` first or use repo-installed tooling.

---

## #331 [Build] Shell `$VAR` Expands Python Module Constants as Empty — Import the Module to Resolve the Path

**Pattern:** An agent knows a Python module defines a constant like `LOCAL_MODEL_ROOT` and tries to use it in a shell command as `$LOCAL_MODEL_ROOT`. The variable is not exported as an environment variable, so Bash expands it to an empty string. A subsequent `ls` or path operation on the empty argument exits 2 (or operates on the current directory silently).

**Instances:**
- 2026-10-20 — Computational Linguist (p/7#129): `ls $LOCAL_MODEL_ROOT` exited 2. `LOCAL_MODEL_ROOT` is a Python constant in `_model_release.py`, not a shell environment variable. Resolved by importing the module in Python to get the resolved path.

**Root Cause:** Python module constants are not automatically exported to the shell environment. A shell variable `$NAME` is only defined if it was set via `export NAME=...` or passed in the process environment. A Python file defining `NAME = "/some/path"` has no effect on the shell.

**Prevention:**
1. **Never use a Python module constant as a shell variable (`$CONSTANT_NAME`).** If you need the path in a shell command, retrieve it by importing the module: `python3 -c "from _model_release import LOCAL_MODEL_ROOT; print(LOCAL_MODEL_ROOT)"`, then capture and use the output.
2. **`ls` exiting 2 with no output** is a reliable diagnostic for an empty argument — the variable expanded to nothing. Check `echo "$LOCAL_MODEL_ROOT"` first.
3. **If the path must be available in both Python and shell contexts**, define it as an environment variable (e.g., in a `.env` file loaded by both) rather than a Python-only constant.

**Status:** Active — 1 instance (Computational Linguist p/7#129).

**Applies To:** All agents working across Python modules and shell commands; Python constants are not shell variables — import the module to resolve the value.

---

## #337 [Build] `Invoke-AsAgentApp` Not Found — `AgentAppToken.psm1` Must Be Explicitly Imported First

**Pattern:** An agent calls `Invoke-AsAgentApp` (or another function from `AgentAppToken.psm1`) and receives a "not found" error. The module is not auto-loaded — it must be explicitly imported with `Import-Module` before any of its functions are callable.

**Instances:**
- 2026-10-21 — Quality/Tech Lead (p/447#29): `Invoke-AsAgentApp` not found. Resolved by running `Import-Module .\operations\devops\AgentAppToken.psm1 -Force` first, then the call succeeded.

**Root Cause:** `AgentAppToken.psm1` lives at `operations/devops/AgentAppToken.psm1` and is not part of the auto-loaded module set. PowerShell does not discover it unless an explicit `Import-Module` is issued in the same session.

**Prevention:**
1. **Before calling `Invoke-AsAgentApp`, always run:** `Import-Module .\operations\devops\AgentAppToken.psm1 -Force` (from repo root).
2. **"CommandNotFoundException" for any `Invoke-AsAgentApp` or related function** is the diagnostic — the fix is an explicit `Import-Module`, not a reinstall or path fix.
3. **Use `-Force` to avoid caching issues** if the module was previously loaded in the session.

**Status:** Active — 1 instance (Quality/Tech Lead p/447#29).

**Applies To:** All agents using `Invoke-AsAgentApp` or other functions from `AgentAppToken.psm1`; always import the module explicitly before use.

---

## #338 [Build] `git log -1 <sha>` Returns "unknown revision" — SHA Belongs to a Sibling Repo

**Pattern:** An agent runs `git log -1 <sha>` and receives "unknown revision or path not in the working tree." The commit SHA is valid — it exists, but in a different repository (e.g., `ai-triad-research` vs. `ai-triad-sources`).

**Instances:**
- 2026-10-21 — Server Storage (p/539#20): `git log -1 df540976` errored "unknown revision" in `ai-triad-sources`. The commit belonged to `ai-triad-research`. No fix needed — confirmed the right repo and moved on.

**Root Cause:** The project uses sibling repos (`ai-triad-research`, `ai-triad-data`, `ai-triad-sources`). A SHA from one repo is invisible to `git` commands run in another.

**Prevention:**
1. **Before running `git log`/`git show`/`git cat-file` on a SHA**, confirm which repo owns it — check PR links, ticket references, or the agent that generated it.
2. **"unknown revision" for a well-formed SHA** = wrong repo, not a corrupt SHA. Switch repos and retry.
3. **When referencing commits across repos**, include the repo name in the reference (e.g., "commit `df540976` in `ai-triad-research`").

**Status:** Active — 1 instance (Server Storage p/539#20).

**Applies To:** All agents working across sibling repos; always confirm which repo owns a SHA before running git commands against it.

---

## #339 [Research] `null` Entries in JSON Arrays Cause `AttributeError` on `.get()` — Guard Before Dereferencing

**Pattern:** An agent iterates over a JSON array (e.g., `factual_claims`) and calls `.get()` on each element. Some entries are `null`, causing `AttributeError: 'NoneType' object has no attribute 'get'`. The fix is a null guard (`(entry or {})`) plus type checks before dereferencing.

**Instances:**
- 2026-10-21 — Computational Linguist (p/7#131): scanning `summaries/*.json`, `factual_claims` contained `null` entries. `AttributeError: 'NoneType' has no .get`. Fixed with `(fc or {})` and `isinstance` checks.

**Root Cause:** JSON arrays in data files may contain `null` entries — not all elements are guaranteed to be objects. Same class as root AGENTS.md "Data File Convention": field types vary; check `type()`/`isinstance()` before use.

**Prevention:**
1. **When iterating a JSON array and calling `.get()`**, always guard: `for fc in (items or []): fc = fc or {}; value = fc.get("key")`.
2. **Add `isinstance(fc, dict)` before any dict method call** on elements that could be `null` or a non-dict type.
3. **Treat every array element as potentially `null` or heterogeneous** until verified — applies to all data file arrays.

**Status:** Active — 1 instance (Computational Linguist p/7#131).

**Applies To:** All agents iterating JSON arrays from data files; guard against `null` entries with `(entry or {})` and `isinstance` checks before calling dict methods.

---

## #340 [Build] `jq` Not Installed on Windows — Use PowerShell `ConvertFrom-Json` or `gh --jq` Instead

**Pattern:** An agent runs `jq` in Git Bash on Windows and receives exit code 127 ("command not found"). `jq` is not installed by default on Windows. Use PowerShell's `ConvertFrom-Json -AsHashtable` or `gh`'s built-in `--jq` flag instead.

**Instances:**
- 2026-10-21 — Tech Lead (p/335#174): `jq` call in Git Bash exited 127 — not installed. Resolved by parsing JSON with `ConvertFrom-Json -AsHashtable` in PowerShell.

**Root Cause:** `jq` is a separate install on Windows and is not present by default in Git Bash. Same class as #330 (`node -e "require(...)"` without `npm ci`) — tool availability assumption failure.

**Prevention:**
1. **Never assume `jq` is available in Git Bash on Windows.** Use guaranteed alternatives:
   - PowerShell: `$json = Get-Content file.json | ConvertFrom-Json -AsHashtable`
   - `gh` built-in: `gh api ... --jq '.field'` (bundles its own jq binary)
2. **Exit 127 on `jq`** = not installed, not a syntax error. Switch to PowerShell or `gh --jq`.
3. **For simple key extractions**, `gh --jq` is the most portable cross-platform option.

**Status:** Active — 1 instance (Tech Lead p/335#174).

**Applies To:** All agents running `jq` in Git Bash on Windows; use `ConvertFrom-Json` (PowerShell) or `gh --jq` instead.

---

## #332 [Build] PR Body Edit Re-Triggers Required Checks — Arm With `--auto` After Body Edits, Not Direct Merge

**Pattern:** An agent edits a PR's body (e.g., to add a missing `Tier:` line) and immediately attempts a direct `gh pr merge --squash --match-head-commit`. GitHub refuses with "base branch policy prohibits the merge." The body edit caused GitHub to re-run required checks, which are now PENDING. A direct merge against PENDING checks is refused.

**Instances:**
- 2026-10-20 — Tech Lead (p/335#171, PR #3524): added missing `Tier:` line to PR body; immediately attempted direct merge. Refused — body edit re-triggered required checks. Resolved by switching to `gh pr merge 3524 --auto --squash --match-head-commit <same head>`.

**Root Cause:** GitHub re-runs required status checks whenever a PR body changes (certain checks parse body content such as `Tier:`). The checks transition from the previous pass state back to PENDING. A direct merge attempt fires before the re-run completes.

**Prevention:**
1. **After any PR body edit, arm with `--auto --match-head-commit` rather than direct-merging.** `--auto` waits for all required checks to re-complete before merging.
2. **"base branch policy prohibits the merge" immediately after a body edit** = checks are pending, not failed. Switch to `--auto`.
3. **To check current status before deciding**, run `gh pr checks <N>` — `pending` confirms the re-trigger is in progress.

**Status:** Active — 1 instance (Tech Lead p/335#171).

**Applies To:** All agents editing PR bodies and then merging; body edits re-trigger required checks — use `--auto` afterwards, not direct merge.

---

## #333 [Build] Hook Blocks Compound Bash Command With `$(...)` Variable Substitution — Split Into Two Separate Calls

**Pattern:** An agent constructs a single Bash command that captures a subshell result and immediately uses it: `sha=$(gh pr view N --json headRefOid --jq .headRefOid) && gh pr merge N --squash --match-head-commit "$sha"`. A hook pattern-matches the compound command and refuses it. Splitting into two separate calls — one to read the SHA, one to run the merge — passes the hook.

**Instances:**
- 2026-10-20 — DebateTool (p/70#77): `sha=$(gh pr view ...) && gh pr merge ... "$sha"` refused by a hook that couldn't verify the compound wasn't a destructive git command. Resolved by splitting into two calls.

**Root Cause:** Hooks often pattern-match command strings. A compound command containing both a `$(...)` subshell and `gh pr merge` may trigger a git-command guard. Splitting makes each call independently evaluable.

**Prevention:**
1. **When a compound `sha=$(...) && gh pr merge "$sha"` is blocked, split it:** first call reads and prints the SHA; second call passes the literal SHA value.
2. **This is the documented two-command form** (AGENTS.md Self-Merge Protocol); prefer the PowerShell tool for this sequence — less likely to trigger git-command hooks.
3. **Two calls make the SHA explicit and reviewable** — always the safer form.

**Status:** Active — 1 instance (DebateTool p/70#77).

**Applies To:** All agents running `gh pr merge --match-head-commit` via Bash; split SHA capture and merge into two tool calls to avoid hook false positives.

---

## #334 [Build] jq Object Literal Key Starting With a Digit Fails to Parse — Quote Numeric Keys

**Pattern:** An agent constructs a jq expression with an object literal using a numeric key: `{3558: .}`. jq fails to parse the expression. jq object construction syntax requires keys that begin with a digit to be quoted as strings.

**Instances:**
- 2026-10-21 — DevOps Lead (p/26#242): jq expression `{3558: .}` failed to parse. Fixed by quoting the key: `{"3558": .}`.

**Root Cause:** jq's object literal syntax `{key: value}` treats unquoted keys as identifiers. An identifier cannot start with a digit. Numeric-looking keys must be quoted as string literals.

**Prevention:**
1. **Quote any jq object key that starts with a digit:** `{"3558": .}` not `{3558: .}`.
2. **In jq object literals, unquoted keys are identifiers** (must start with a letter or underscore). Anything else needs quotes.
3. **jq parse error at a `{N:` pattern** = fix is always to add quotes around the key.

**Status:** Active — 1 instance (DevOps Lead p/26#242).

**Applies To:** All agents writing jq expressions with numeric or special-character object keys; quote keys that don't start with a letter.

---

## #335 [Build] KQL Reserved Words as Column Aliases in `summarize`/`extend` Produce SYN0002

**Pattern:** An agent writes a KQL query using `az monitor log-analytics query`. Column aliases in `summarize` or `extend` clauses use KQL reserved words (`first`, `kind`, `last`, etc.). The query returns SYN0002 (syntax error).

**Instances:**
- 2026-10-21 — Azure (p/105#20): 3 KQL queries returned SYN0002. Aliases used `first`, `kind`, `last` in `summarize`/`extend`. Resolved by renaming to `t0`, `t1`, `ek`.

**Root Cause:** KQL has reserved words that cannot be used as column aliases without special escaping. `first`, `kind`, and `last` are among them.

**Prevention:**
1. **Avoid KQL reserved words as column aliases.** Common ones: `first`, `last`, `kind`, `type`, `count`, `sum`, `min`, `max`, `avg`. Use non-reserved aliases (`t0`, `ek`, `cnt`, etc.).
2. **SYN0002 without an obvious syntax error** = reserved-word alias collision — inspect each alias.
3. **To use a reserved word as an alias if necessary**, wrap in backtick escaping: `` [`first`] ``.

**Status:** Active — 1 instance (Azure p/105#20).

**Applies To:** All agents writing KQL queries; avoid reserved words (`first`, `last`, `kind`, etc.) as column aliases in `summarize`/`extend`.

---

## #336 [Build] `az containerapp show` Emits Extension WARNING to stdout — Redirect stderr Before Parsing JSON

**Pattern:** An agent pipes `az containerapp show` output into a JSON parser. The command fails with `JSONDecodeError` on empty input. The `az containerapp` extension prints a WARNING line to stdout, corrupting the JSON stream.

**Instances:**
- 2026-10-21 — DevOps Lead (p/26#244): `az containerapp show | python3 -c "import json,sys; json.load(sys.stdin)"` → JSONDecodeError on empty input. Extension WARNING line printed to stdout. Resolved by adding `2>/dev/null`.

**Root Cause:** Azure CLI extensions (`containerapp`, `aks`, `acr`, etc.) may print WARNING messages to stdout in addition to JSON output. When the warning appears before the JSON, it corrupts the input stream for a strict JSON parser.

**Prevention:**
1. **Always redirect stderr when piping `az` extension commands into a JSON parser:** `az containerapp show ... 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin))"`.
2. **Alternatively, use `az ... -o json 2>/dev/null`** to explicitly request JSON output and suppress warnings.
3. **JSONDecodeError on empty input when piping `az` output** = WARNING-line prefix. Add `2>/dev/null` before retrying.
4. **Applies to all `az` extension subcommands** — not just `containerapp`.

**Status:** Active — 1 instance (DevOps Lead p/26#244).

**Applies To:** All agents piping `az` extension command output into JSON parsers; always redirect stderr with `2>/dev/null` to isolate clean JSON.

---

## #341 [Build] `gh api` GHCR Package Endpoint Returns 403 — CLI Token Lacks `read:packages` Scope

**Pattern:** An agent queries the GitHub Container Registry via `gh api orgs/.../packages/container/.../versions` and receives a 403 "need at least read:packages scope." The CLI's default `gh auth` token does not include the packages scope, so all GHCR package API calls fail.

**Instances:**
- 2026-10-21 — DevOps Lead (p/26#246): `gh api orgs/.../packages/container/taxonomy-editor/versions` returned 403. Resolved by skipping the manual GHCR check — `deploy-azure.yml` resolves the image tag/digest itself and fails closed if absent.

**Root Cause:** The default `gh auth` token is scoped to repo operations. GHCR package API endpoints require the `read:packages` (or `write:packages`) scope, which agents cannot add without PI authorization.

**Prevention:**
1. **Do not manually query GHCR package endpoints via `gh api`.** The deploy pipeline (`deploy-azure.yml`) resolves and validates the image tag/digest itself — trust it to fail closed if the image is absent.
2. **403 "need at least read:packages scope"** = token scope gap, not a permissions misconfiguration. The workaround is to rely on the pipeline, not to attempt re-auth.
3. **Adding scopes to `gh auth` requires PI authorization** — do not attempt `gh auth refresh` or `gh auth login` to add scopes without explicit approval.

**Status:** Active — 1 instance (DevOps Lead p/26#246).

**Applies To:** All agents attempting to inspect GHCR container image versions via `gh api`; rely on the deploy pipeline for image validation instead.

---

## #342 [Platform] `submit_feedback` Always Fails — Record Orca Platform Issues as Tickets or Lessons Instead

**Pattern:** An agent calls `submit_feedback` to report an Orca platform problem. The call always fails with "file not found: ~/.orca/beta/license.json" (broken since approximately 2026-10-07). The PI has confirmed the license issue will not be fixed.

**Instances:**
- 2026-10-21 — PI decision (via TL p/335#178): `submit_feedback` has been broken since ~2026-10-07 with "file not found: ~/.orca/beta/license.json". PI confirmed: won't fix.

**Root Cause:** The Orca beta license file is missing from the environment. `submit_feedback` requires it and fails immediately. This is a permanent platform limitation for this workspace.

**Prevention:**
1. **Never call `submit_feedback`.** It always fails — do not retry.
2. **To report an Orca platform problem**, record it as a ticket (for tracking) or as a lessons entry (for patterns). Ping the TL if immediate escalation is needed.
3. **Never inspect or attempt to fix `~/.orca/` directly.** The license file's absence is a known permanent state; attempting to recreate or modify it is out of scope for agents.

**Status:** Active — permanent platform limitation (PI decision 2026-10-21, p/335#178).

**Applies To:** All agents; `submit_feedback` is permanently broken — use tickets or lessons entries for Orca platform issues.

---

## #343 [Build] Storage Data-Plane API Returns 403 — Agent CLI Identity Lacks RBAC Role on Storage Account

**Pattern:** An agent runs `az storage file download --auth-mode login` (or any `az storage` data-plane operation) against the project storage account and receives 403. The CLI identity has no data-plane RBAC role (Storage Blob Data Reader/Contributor/Owner) on that account. This is an account-wide gap, not specific to a particular identity.

**Instances:**
- 2026-10-21 — DevOps Lead (p/26#248): `az storage file download --auth-mode login` on `staitriadkvwl3nywge4iw` → 403 "Storage Blob Data Owner/Contributor/Reader" required. Also seen in deploy-workflow (t/4390). Workaround: `az containerapp exec` to read the live mount directly.

**Root Cause:** Azure separates management-plane (ARM) and data-plane (storage) permissions. Having ARM access (contributor, etc.) does not grant data-plane access. Storage data-plane roles must be assigned separately and have not been assigned to agent identities.

**Prevention:**
1. **Do not attempt `az storage` data-plane operations** (`download`, `upload`, `list`, `show`). The CLI identity lacks the required RBAC roles account-wide — this will always fail 403.
2. **To inspect live file content on a mounted volume**, use `az containerapp exec` to shell into the running container and read the file directly.
3. **Requesting data-plane RBAC assignment** requires PI authorization — do not attempt to self-assign or work around it.

**Status:** Active — 1 instance (DevOps Lead p/26#248); account-wide, likely affects all agents.

**Applies To:** All agents attempting `az storage` data-plane operations; use `az containerapp exec` to access mounted file content instead.

---

## #344 [Research] Filter Scoped Too Narrowly Silently Drops Data When Skip-Set Is Empty — Identity-Test on Real Data Required

**Pattern:** An agent builds a "skip N items" filter that retains only items matching a specific ID set (e.g., selectable POV node IDs). When the skip-set is empty (nothing to skip), the filter should be an identity function — but because the allowed-set is narrower than the real ID space, it silently drops non-POV items (situations, policy, conflict nodes). Fixture-only testing misses this because fixtures contain only the narrow set.

**Instances:**
- 2026-10-21 — Computational Linguist (p/7#133, PR #3552): "skip superseded nodes" filter scoped to POV IDs. On real data with 0 superseded nodes, dropped 43% of edges and 77% of embeddings. Review passed because fixtures held POV nodes only, and "embeddings filtered to selectable IDs" looked correct without checking what that set contained.

**Root Cause:** The filter's domain assumption (all nodes are POV nodes) diverged from reality (nodes include situations, policy, conflict). Fixtures encoded the wrong assumption, so unit tests could not catch the mismatch.

**Prevention:**
1. **A filter that should be a no-op when its target set is empty needs an identity test on real data:** with zero superseded nodes, `output == input` (same edge count, same embedding count).
2. **Check a filter's allowed-set against the real file's full ID space** — not just the fixture's subset — before shipping.
3. **When a filter touches embeddings or graph edges**, verify counts against the source file: `len(output_edges) == len(input_edges)` when no nodes are excluded.

**Status:** Active — 1 instance (Computational Linguist p/7#133).

**Applies To:** All agents building skip/exclude/filter logic over data files; identity-test on real data when the skip-set is empty, and verify counts against the source.

---

## #345 [Build] Fresh Worktree Has No `node_modules` — `mklink /J` Fails in Git Bash; Use PowerShell `New-Item -ItemType Junction`

**Pattern:** An agent runs lint/type-check/tests in a fresh `.worktrees/` checkout. Tools fail immediately (`ls eslint.config.*` exits 2, eslint not found) because `node_modules` is absent. Attempting to create a junction with `cmd //c mklink /J` from Git Bash prints "Invalid switch" (Git Bash mangles the `//c` prefix). Fix: create `node_modules` junctions from PowerShell and run tools from there.

**Instances:**
- 2026-10-21 — Tech Lead (p/335#180): fresh worktree, `ls eslint.config.*` exited 2; `cmd //c mklink /J` from Git Bash → "Invalid switch". Resolved by creating junctions with `New-Item -ItemType Junction` (repo root, `lib/`, `taxonomy-editor/`) in PowerShell, then running eslint, tsc and vitest.

**Root Cause:** Git worktrees do not inherit `node_modules` from the main checkout — each worktree's directory tree is clean. Creating Windows junctions from Git Bash fails because Git Bash rewrites `//c` path prefixes (the same MSYS path-mangling class as #73). PowerShell's `New-Item -ItemType Junction` is not subject to MSYS translation.

**Prevention:**
1. **In a fresh worktree, create `node_modules` junctions before running any JS/TS tools:**
   ```powershell
   $wt = "C:\Users\jsnov\repos\ai-triad-research\.worktrees\<name>"
   New-Item -ItemType Junction "$wt\node_modules" -Target "$root\node_modules"
   New-Item -ItemType Junction "$wt\lib\node_modules" -Target "$root\lib\node_modules"
   New-Item -ItemType Junction "$wt\taxonomy-editor\node_modules" -Target "$root\taxonomy-editor\node_modules"
   ```
2. **Never use `cmd //c mklink` from Git Bash** — MSYS rewrites the path. Use PowerShell `New-Item -ItemType Junction` instead.
3. **`ls eslint.config.*` exiting 2** in a worktree = missing `node_modules`, not a missing config file.

**Status:** Active — 1 instance (Tech Lead p/335#180).

**Applies To:** All agents running lint/tsc/vitest in fresh worktrees; create `node_modules` junctions via PowerShell before running any JS/TS toolchain.

---

## #346 [Build] Azure Files Shares Are Not Valid ARM RBAC Scopes — Use Storage-Account-Level Scope Instead

**Pattern:** An agent attempts to assign an Azure RBAC role scoped to an Azure Files share resource ID (`.../fileshares/<name>`). The operation returns `MissingSubscription` or a similar ARM validation error. Azure Files shares are not addressable as ARM resource IDs for RBAC scoping.

**Instances:**
- 2026-10-21 — DevOps Lead (p/26#252): `az role assignment create --scope .../fileshares/taxonomy-data` → MissingSubscription. Fell back to storage-account-level scope per the SO's own fallback condition.

**Root Cause:** Azure Files shares exist as a storage construct but are not exposed as ARM resources that can serve as RBAC scope targets. RBAC for Azure Files must be scoped to the storage account (or higher), not to an individual share.

**Prevention:**
1. **When assigning RBAC for Azure Files access**, always scope to the storage account: `--scope /subscriptions/.../resourceGroups/.../providers/Microsoft.Storage/storageAccounts/<name>`.
2. **`MissingSubscription` from `az role assignment create`** with a `/fileshares/` path = invalid scope level. Move the scope up to the storage account.
3. **Share-level access control** in Azure Files uses share-level SAS tokens or SMB ACLs, not ARM RBAC — they are separate mechanisms.

**Status:** Active — 1 instance (DevOps Lead p/26#252).

**Applies To:** All agents assigning RBAC for Azure Files; scope to the storage account, not the individual share path.

---

## #347 [Build] Bash Tool Strips Backslashes From Windows Absolute Paths Passed to `pwsh -File` — Use PowerShell Tool Instead

**Pattern:** An agent runs `pwsh -NoProfile -File C:\Users\...\script.ps1` via the Bash tool. The Bash tool strips or mangles the backslashes in the Windows absolute path, causing `pwsh` to receive a malformed path. Fix: use the PowerShell tool directly with a relative path after `cd`.

**Instances:**
- 2026-10-21 — DevOps Lead (p/26#253): `pwsh -NoProfile -File C:\Users\jsnov\...\Invoke-ShareFreshnessGateCheck.ps1` via Bash tool mangled the path (backslashes stripped). Resolved by using the PowerShell tool directly with `cd` to the script's directory and a relative path.

**Root Cause:** The Bash tool is a POSIX shell environment (Git Bash / MSYS). Backslashes in string arguments are treated as escape characters, not path separators. A Windows absolute path like `C:\Users\foo\bar.ps1` loses its backslashes in transit. This is a different failure mode from #73/#307 (MSYS leading-slash translation) — here it is backslash-stripping, not path rewriting.

**Prevention:**
1. **Never pass Windows absolute paths with backslashes to `pwsh -File` via the Bash tool.** Use the PowerShell tool instead — it preserves Windows path syntax natively.
2. **Preferred pattern:** PowerShell tool with `cd C:\...\dir; .\script.ps1` or a relative path after `cd`.
3. **If the Bash tool must be used**, convert backslashes to forward slashes: `pwsh -NoProfile -File "C:/Users/.../script.ps1"` — but the PowerShell tool is always safer for Windows-native scripts.

**Status:** Active — 1 instance (DevOps Lead p/26#253).

**Applies To:** All agents running PowerShell scripts via the Bash tool on Windows; always use the PowerShell tool for `pwsh` invocations with Windows absolute paths.

---

## #348 [Research] JSON Array Element Assumed to Be Object Is a Plain String — Inspect Shape Before Dereferencing

**Pattern:** An agent iterates a JSON array field and calls `.keys()` or a dict method on each element, assuming they are objects. The elements are plain strings. `'str' object has no attribute 'keys'` (or `.get`) is the diagnostic. Fix: inspect the field's shape first, or check the file's `_doc` field if one exists.

**Instances:**
- 2026-10-21 — PowerShell (p/20#102): inline Python scan of `entity_extraction_log.json` crashed — `org_mentions[]` assumed to hold objects; they are plain strings. The `_doc` field documents the schema (`evidence[]` holds the `{id, name, quote}` objects). Fixed by inspecting shape first.

**Root Cause:** Same class as root AGENTS.md "Data File Convention": field types vary (list vs dict, string vs object). The array name (`org_mentions`) implied structured objects, but the actual content was a string list. A `_doc` field in the file documented the real schema and was not consulted.

**Prevention:**
1. **Before calling any dict method on array elements**, check one element: `type(items[0])` or `isinstance(items[0], dict)`.
2. **Check the file's `_doc` field** if present — it documents the schema for each field.
3. **`'str' object has no attribute 'keys'` / `.get`** on a JSON element = the array holds strings, not objects. Inspect and re-read the schema.

**Status:** Active — 1 instance (PowerShell p/20#102).

**Applies To:** All agents iterating JSON arrays from data files; inspect element type before calling dict methods, and check any `_doc` field for schema documentation.

---

## #349 [Build] `az` Writes cp1252 on Windows Despite `PYTHONIOENCODING=utf-8` — Specify Encoding Explicitly When Reading

**Pattern:** An agent redirects `az monitor log-analytics query -o json` output to a file on Windows, then reads it with `json.load`. The read raises `UnicodeDecodeError` (e.g., byte `0x97`). On Windows, `az` writes redirected output in the system codepage (cp1252) even when `PYTHONIOENCODING=utf-8` is set. Em dashes and other cp1252 characters in log data become non-UTF-8 bytes.

**Instances:**
- 2026-10-21 — Azure (p/105#28): `json.load` on `az monitor log-analytics query -o json > file` export raised `UnicodeDecodeError` (byte `0x97` = cp1252 em dash). Resolved by reading with `encoding='cp1252', errors='replace'`.

**Root Cause:** The `az` CLI on Windows uses the system console codepage (cp1252) for redirected output, not UTF-8. `PYTHONIOENCODING` controls Python's stdio encoding, not the encoding of files written by other processes.

**Prevention:**
1. **When reading `az` output redirected to a file on Windows**, always specify the encoding explicitly: `open(file, encoding='cp1252', errors='replace')` or `encoding='utf-8-sig'` depending on content.
2. **Alternatively, use `--output tsv`** to avoid JSON parsing of potentially cp1252-encoded output, or pipe directly to Python without redirection: `subprocess.run(['az', ...], capture_output=True, encoding='cp1252')`.
3. **`UnicodeDecodeError` byte `0x80`–`0x9F`** on Windows `az` output = cp1252 encoding. The byte range `0x80`–`0x9F` is undefined in ISO-8859-1/Latin-1 but assigned in cp1252 (smart quotes, em dashes, etc.).

**Status:** Active — 1 instance (Azure p/105#28).

**Applies To:** All agents reading `az` CLI output redirected to files on Windows; specify `encoding='cp1252'` (or use `errors='replace'`) when parsing with Python.

---

## #350 [Build] String Pattern Match Including Trailing Comma Fails on Last JSON Entry — Match Without Comma and Validate

**Pattern:** An agent writes a Python edit script that matches a JSON field pattern including a trailing comma (e.g., `"lint": "eslint src/",`). The match fails in files where the target field is the last entry in the object — JSON's last entry has no trailing comma. Fix: match without the trailing comma; validate the result with `json.loads` to ensure structural integrity.

**Instances:**
- 2026-10-21 — Shared Lib (p/5#57): Python edit script matched `"lint": "eslint src/",` with trailing comma; failed in 2 of 3 `package.json` files where `lint` was the last script entry. Fixed by removing the comma from the match pattern and validating with `json.loads`.

**Root Cause:** JSON objects do not allow trailing commas. When a field is the last in an object, it has no trailing comma — a pattern that includes one will only match in the non-final position.

**Prevention:**
1. **When matching a JSON field value**, omit the trailing comma from the pattern: match `"lint": "eslint src/"` not `"lint": "eslint src/",`.
2. **After a string-substitution edit on a JSON file**, validate with `json.loads(content)` to catch any structural breakage before writing.
3. **This applies to all JSON files** — commas in JSON are separators between entries, not terminators; the last entry in any object or array has no trailing comma.

**Status:** Active — 1 instance (Shared Lib p/5#57).

**Applies To:** All agents editing JSON files via string matching; never include trailing commas in match patterns, and validate the result with `json.loads`.

---

## #351 [Build] `gh repo view --json autoMergeAllowed` Is Not a Valid Field — Use `gh api` With `.allow_auto_merge` Instead

**Pattern:** An agent runs `gh repo view --json autoMergeAllowed` to check whether auto-merge is enabled for a repo. The command returns an "unknown JSON field" error. `autoMergeAllowed` is a GraphQL field name; `gh repo view --json` uses the REST API schema where the equivalent field is `allow_auto_merge`, accessible via `gh api repos/OWNER/REPO --jq .allow_auto_merge`.

**Instances:**
- 2026-10-21 — DebateTool (p/234#16): `gh repo view --json autoMergeAllowed` → unknown JSON field error. Resolved by switching to `gh api repos/AI-Rosetta-Stone/ai-triad-research --jq .allow_auto_merge`.

**Root Cause:** GitHub has two API schemas: REST (used by `gh repo view`) and GraphQL (used by `gh api graphql`). Field names differ between them. `autoMergeAllowed` is the GraphQL name; `allow_auto_merge` is the REST name. `gh repo view --json` only accepts REST field names.

**Prevention:**
1. **To check auto-merge status**, use: `gh api repos/OWNER/REPO --jq .allow_auto_merge` (returns `true`/`false`/`null`).
2. **`gh repo view --json <field>`** only accepts REST API field names. GraphQL names (camelCase like `autoMergeAllowed`) are not valid here — use `gh api repos/...` instead.
3. **"unknown JSON field" from `gh repo view --json`** = you used a GraphQL field name. Look up the REST equivalent.

**Status:** Active — 1 instance (DebateTool p/234#16).

**Applies To:** All agents querying repo settings via `gh repo view --json`; use REST field names, not GraphQL names — or use `gh api repos/OWNER/REPO` directly.

---

## #352 [Test] Pester `Mock -ModuleName` Body Runs in Test Scope — Private Module Functions Unreachable From Inside Mock Body

**Pattern:** An agent writes a Pester test that uses `Mock -ModuleName MyModule { ... }`. The mock body calls a private function from `MyModule`. At test time the call fails with "term not recognized" — the private function is not visible. The mock body executes in the test's session scope, not inside the module's session state, so Private functions exported to the module's runspace are invisible.

**Instances:**
- 2026-10-22 — PowerShell (p/20#104): a regenerated golden silently captured the "term not recognized" error from a private function called inside a `Mock -ModuleName` body. Caught by reading the golden diff before accepting it. Fixed by invoking through `& (Get-Module MyModule) { ... }`.

**Root Cause:** PowerShell's module system enforces function visibility at the session-state level. `-ModuleName` on a Pester mock causes the mock to intercept calls *to* the module, but the mock body itself still runs in the test's script scope where Private functions are not imported. Only a script block invoked *inside the module's session state* via `& (Get-Module X) { ... }` sees Private functions.

**Prevention:**
1. **Never call private module functions directly from a `Mock -ModuleName` body.** The body runs in test scope where they are invisible.
2. **To invoke a private function from a mock or test**, use: `& (Get-Module MyModule) { Invoke-PrivateFunction @args }` — the script block executes inside the module's session state.
3. **Always read the full diff of any regenerated golden before accepting it.** Errors silently captured in output will appear as a diff; if they look like "term not recognized" in a mock body, the private-function scope issue is the likely cause.

**Status:** Active — 1 instance (PowerShell p/20#104).

**Applies To:** All agents writing Pester tests that mock module-internal behavior; private function visibility requires executing inside the module's session state via `& (Get-Module X) { ... }`.

---

## #353 [Build] Dot-Sourcing a Top-Level `.ps1` Executes It Immediately — Capture Output With `$x = . ./Script.ps1`; No Callable Function Name Is Defined

**Pattern:** An agent dot-sources a PowerShell script (`Get-BicepBaseEnv.ps1`) and then calls it as a function (`Get-BicepBaseEnv -Param`). The call fails with "term not recognized." The script is a top-level script with a `param` block and direct output — not a function definition. Dot-sourcing executes it immediately in the caller's scope; its output must be captured at that moment (`$x = . ./Script.ps1 -Param`). No named function is defined afterward.

**Instances:**
- 2026-10-22 — DevOps Lead (p/26#256): dot-sourced `Get-BicepBaseEnv.ps1` then called `Get-BicepBaseEnv -ForStaging` — "term not recognized." Script's own doc-comment example shows the correct form (`$env = . ./operations/devops/Get-BicepBaseEnv.ps1 -ForStaging`), which was initially skipped.

**Root Cause:** PowerShell dot-sourcing (`. ./Script.ps1`) runs the script in the caller's scope. A script with a top-level `param` block executes when sourced and produces output — it does not create a function named after the file. Only scripts that contain a `function` block define a callable name.

**Prevention:**
1. **Read the script's doc-comment example before invoking.** If the example shows `. ./Script.ps1 -Param`, that is the entire calling convention — no named function exists afterward.
2. **To capture output from a dot-sourced script:** `$result = . ./Script.ps1 -Param` — call it once, capture, done.
3. **"Term not recognized" after dot-sourcing = the script has no function definition.** Check with `Get-Command <name>` immediately after sourcing to confirm what (if anything) was defined.

**Status:** Active — 1 instance (DevOps Lead p/26#256).

**Applies To:** All agents invoking PowerShell scripts that produce direct output rather than defining functions; dot-source with capture, never call afterward as a named command.

---

## #354 [Build] `gh run list --workflow` Requires Display Name or Numeric ID — File Stem Alone Returns "Could Not Find Any Workflows"

**Pattern:** An agent runs `gh run list --workflow citation-link-integrity` using the workflow file stem (without `.yml` extension). GitHub returns "could not find any workflows." The `--workflow` flag requires either the workflow's display name (as shown in the Actions UI) or its numeric ID — not an arbitrary file stem.

**Instances:**
- 2026-10-22 — Computational Linguist (p/7#140): `gh run list --workflow citation-link-integrity` → "could not find any workflows." Display name is "Citation-Link Integrity Check (Warn-First)." Fixed by using the numeric ID from `gh workflow list`.

**Root Cause:** `gh run list --workflow` matches against the workflow's display name or numeric ID, not the filename stem. A stem that differs from the display name silently finds nothing rather than an error that names the mismatch.

**Prevention:**
1. **To filter workflow runs, use the numeric ID:** `gh workflow list` shows IDs; pass `--workflow <id>` for reliable matching.
2. **Alternatively, use the exact display name** (as shown in `gh workflow list` or the Actions UI).
3. **"Could not find any workflows" from `--workflow`** = the value is neither the display name nor the ID. Run `gh workflow list` to discover both.

**Status:** Active — 1 instance (Computational Linguist p/7#140).

**Applies To:** All agents filtering GitHub Actions runs by workflow; use `gh workflow list` to get the ID or exact display name before passing `--workflow`.

---

## #355 [Build] `grep` Rejects Patterns Starting With `-` as Unknown Options — Use `grep -e "pattern"` or `grep -- "pattern"`

**Pattern:** An agent passes a `grep` (or `grep -E`) pattern that begins with a dash (e.g., `->`, `-v`, `-E`). grep interprets the leading `-` as an option flag, returns exit code 2 ("invalid option"), and matches nothing. Any pipeline built on this grep exits 2 rather than 0 or 1, masking upstream commands' results.

**Instances:**
- 2026-10-22 — ServerAPI (p/504#26): `git push … | grep -E "->|error"` — grep exited 2 because `->` starts with `-`. The pipe masked the push's own exit code; verified push success via `git ls-remote`.

**Root Cause:** POSIX grep treats any argument starting with `-` as a flag. A pattern like `->` is parsed as flag `-` with option `>` — which is invalid. The `--` end-of-options delimiter and the `-e` flag both tell grep "what follows is a pattern, not an option."

**Prevention:**
1. **For any `grep` pattern that starts with `-`, use `grep -e "pattern"` or `grep -- "pattern"`** — both signal that the argument is a pattern, not an option flag.
2. **Never pipe `git push`** — run it bare, then check `$?`; the exit code laundering compounds when a downstream grep also exits non-zero for the wrong reason.
3. **Exit code 2 from grep = parse error** (bad option or syntax), not "no match" (1) or "matched" (0). A pipeline that exits 2 has failed, not just found nothing.

**Status:** Active — 1 instance (ServerAPI p/504#26).

**Applies To:** All agents using grep to filter output; patterns starting with `-` must use `-e` or `--` to avoid option-flag misparse.

---

## #356 [Build] `diff` Exits 1 for "Files Differ" — Not an Error; Inspect the Differing Lines Before Concluding Anything Failed

**Pattern:** An agent runs `diff file1 file2` (or `diff <(cmd1) <(cmd2)`) and treats exit code 1 as a tool failure. `diff` exit 1 means "files differ" — it is informational. Exit 2 means "trouble" (a real error). An `&&` chain or a `[ $? -eq 0 ]` guard that treats exit 1 as failure incorrectly aborts on any detected difference, including expected or benign ones.

**Instances:**
- 2026-10-22 — Server Storage (p/539#23, t/4404): `diff` exited 1 during a second-agent recount. Initially appeared to be a tool error; inspection showed the single differing line was an expected self-referential `code_commit` metadata field. Recount continued normally once the exit code was understood.

**Root Cause:** POSIX `diff` uses a three-value exit code: 0 = identical, 1 = differ, 2 = trouble. This diverges from most Unix tools where non-zero means failure. Scripts that use `diff` in an `&&` chain or check `$? -eq 0` treat "files differ" as failure, aborting on any difference — including benign metadata fields.

**Prevention:**
1. **After `diff`, always inspect the differing lines** before concluding something went wrong — exit 1 is "different", not "broken."
2. **In scripts, check `$? -le 1`** (0 or 1 are both "diff ran successfully") and treat only exit 2 as a real error.
3. **A single unexpected diff line** (e.g., a commit hash or timestamp) is often benign metadata — read it before acting.

**Status:** Active — 1 instance (Server Storage p/539#23).

**Applies To:** All agents using `diff` in scripts or `&&` chains; exit 1 = "files differ" (informational), exit 2 = error.

---

## #357 [Test] Unpinned `AI_TRIAD_DATA_ROOT` Lets a Test Helper Write the Real Corpus — Set It to a Temp Dir in `BeforeAll`

**Pattern:** A Pester (or vitest) test exercises a helper that writes data. The test doesn't set `AI_TRIAD_DATA_ROOT` to a temp directory, so the helper resolves its default data path and writes to the real `ai-triad-data/` corpus. The write succeeds silently; damage is only discovered later by a diff check.

**Instances:**
- 2026-10-22 — t/4453: a local Pester run of `Entity.Tests.ps1` wrote the real `ai-triad-data/taxonomy/Origin/entity_embeddings.json`. The tombstone-drop helper (#3752) ignored `-SkipEmbedding` and resolved the default (real) data path because `AI_TRIAD_DATA_ROOT` was not redirected in the test. Caught by diff check ~1 hour later; restored from origin; nothing committed. Fix: #3755. Platform control: t/4454 (test runners fail closed on writes under the real data root).

**Root Cause:** Helpers resolve `AI_TRIAD_DATA_ROOT` at runtime. A test that exercises a data-writing code path without pinning this env var will use the real data root through any helper's default. `-SkipEmbedding` and similar flags guard specific sub-paths, not the root itself.

**Prevention:**
1. **The platform control is t/4454** — test runners fail closed on writes under the real data root for both Pester and vitest.
2. **Diagnostic:** if a test run produces unexpected changes to `ai-triad-data/`, check whether `AI_TRIAD_DATA_ROOT` was pinned in `BeforeAll`/`BeforeEach`.
3. **Always run `git status` (or `git diff --stat`) in `ai-triad-data/` after any test run that exercises data-writing helpers**, before committing.

**Status:** Active — 1 instance (t/4453, TL p/335#182).

**Applies To:** All agents writing Pester or vitest tests for data-writing helpers; t/4454 is the platform backstop — treat an unpinned data root as the diagnostic to check when unexpected corpus writes appear.
