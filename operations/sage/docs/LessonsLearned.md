# Lessons Learned

Institutional memory for failure patterns across the AI Triad Research project.

> **This file is the flat archive.** For the organized, category-indexed view, see [`lessons/INDEX.md`](lessons/INDEX.md).
> New patterns should be added to both this file (append) and the appropriate category file in `lessons/`.

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
- 2026-08-07 — DebateWorkspace (p/124#10, t/2256): `@'...'@` here-string in Bash tool with `-m` placed after `--` separator — git read the message text and the `-m` flag as filenames ("pathspec '-m' did not match"). Fixed: wrote message to file, used `git commit -F <file> -- <paths>`.
- 2026-08-09 — Rosetta Stone 3 (p/355#3): `@'...'@` in Bash tool left a stray `@` in the commit subject (same facet as p/83#1). Fixed with `git commit --amend -F <file>` to rewrite the subject cleanly.
- 2026-09-01 — Computational Linguist (p/7#74): inline `python -c` with backslash path-escaping (Windows `C:\...` paths inside a string argument) threw `SyntaxError: unterminated string literal` — the shell mangled the `\` escape sequences before Python saw them. Fix: write the script to a temp file and execute it (Shell Quoting Rule / ADR-004). Same root as p/7#30 + p/20#23 — the moment a script carries backslashes, nested quotes, or path escapes, inline `-c` fights the shell; a temp file avoids both layers.

**Root Cause:** Heredocs (even quoted `<< 'EOF'` which disable variable expansion) still cannot contain the same quote delimiter used by the inner language. The `bash -c` and `pwsh -Command` wrappers compound this by adding another quoting layer. Additionally, PowerShell-specific syntax (`@'...'@` here-strings) is silently misinterpreted by Bash, not rejected — leading to confusing errors. The `--` separator compounds commit message issues: all flags must come before `--`, or git treats them as pathspecs.

**Prevention:**
1. **First choice:** Use the Write tool to create a temp `.py` script file, then execute it with Bash — avoids all quoting issues.
2. Split complex scripts into smaller pieces that each avoid quote conflicts, passing data via temp files (e.g., JSON to `/tmp/`).
3. In Python, use %-formatting or `.format()` instead of f-strings when the content will pass through Bash.
4. For PowerShell via Bash, use double-quoted strings inside the command to avoid single-quote nesting.
5. Prefer the Edit/Write tools over Bash heredocs for file creation/modification.
6. For git commits: use `git commit -F <tmpfile> -- <paths>` — write message to temp file, and always place flags before the `--` separator.
7. **For any non-trivial PowerShell, prefer `pwsh -File <script.ps1>` over inline `pwsh -Command "..."`** (p/20#23). The moment the PS carries backtick escapes (`` `n ``, `` `t ``), nested quotes, or `$` refs, the inline form fights two parsers (bash then pwsh); a temp `.ps1` + `-File` sidesteps both. This is the ADR-004 "write to a file, then run it" remedy applied to PS specifically.

**Status:** Resolved — AGENTS.md rule broadened to cover both file editing and script execution (p/8#14). Original rule from q/4 now includes: write scripts to temp files with Write tool, then execute via Bash. Prevention #7 (`pwsh -File` over inline `-Command` for non-trivial PS) added 2026-07-17 (p/20#23) — a durable instance-triggered refinement, already covered by ADR-004/Shell Quoting Rule so no new root rule needed.

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
- 2026-08-27 — Computational Linguist (p/7#68): inline profiling script hit `TypeError: unhashable type: 'dict'` — passed `entity['discovered_by']` directly to `Counter`. Field name suggests string; actual shape on all current `ent-*` records is `{model, usage_id}` dict. Fixed with `isinstance` guard before Counter. **Known shape:** `entities.json` `discovered_by` is always a dict `{model, usage_id}` on current records — never a bare string.

**Root Cause:** Code written based on assumed schema/interface rather than inspecting the actual structure or function signature. Applies across all project data: taxonomy JSON, debate sessions, and tool/API returns. Field types vary — never assume string without checking.

**Prevention:**
1. Always inspect a sample of the actual data before writing code that reads it — `head` a JSON file or `jq` a few records.
2. For taxonomy data specifically: many enriched fields live under `graph_attributes`, not at the node root.
3. Check `type()` / `isinstance()` before calling type-specific methods (`.items()` for dict, iteration for list).
4. When a script returns 0 results, empty data, or an AttributeError, suspect a schema mismatch before debugging logic.

**Status:** Resolved — "Data File Convention" added to root AGENTS.md under Taxonomy Model (p/8#22).

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
- 2026-09-02 — ServerAPI (p/504#5): **5th `jq` instance — Monitor poll loop silently slept to timeout.** A Monitor poll loop piped through system `jq` to detect completion; `jq` not on PATH, so each iteration errored to empty, the loop never fired, and it timed out silently. Fix: use `gh --json ... -q` (gh's embedded jq) or parse `gh pr checks` text output directly; avoid system `jq` in Bash-tool commands. Same amplifier as p/79#29: missing tool + Monitor loop = silent full-timeout.

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
3. For `/dev/null`, use `NUL` on Windows or use cross-platform libraries.
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

**Root Cause:** Multiple agents work in parallel on the same branches. The window between local commits and push allows remote to advance, causing non-fast-forward rejections. More agents = more contention. **At small scale this is self-correcting** (stash/pull --rebase/pop/push); **at large scale it is not** — when approved commits accumulate far past the ~10 push-cadence ceiling, shared local main drifts tens of commits from origin, the rebase spans many agents' out-of-scope changes, and it must go to TL/DevOps. The large divergence is a *symptom of a cadence breach*.

**Prevention:**
1. Pull immediately before committing: `git pull --rebase` then commit and push without delay.
2. For generated data files (`embeddings.json`, `policy_actions.json`), prefer "take theirs" conflict resolution unless your changes are the authoritative regeneration.
3. For code conflicts, understand the intent of both changes before resolving — don't blindly take either side.
4. Minimize the commit-to-push window — do both in quick succession.
5. Standard resolution flow: `git stash && git pull --rebase origin main` → resolve conflicts → `git rebase --continue && git stash pop && git push`.
6. **Bound the divergence via push cadence** — don't let approved commits pile past the ~10 ceiling; a 40+/50+ divergence is not self-correcting.
7. **A large divergence is a TL/DevOps event** — if `git stash && pull --rebase` hits conflicts in files you don't own, STOP and route to TL/DevOps; don't force-resolve out-of-scope conflicts.

**Status:** Active — **6 instances / 5 agents; split by scale.** SMALL contention remains self-correcting and NOT escalating. The **LARGE-divergence variant (p/9#36: 46/52) IS a signal** — a push-cadence-ceiling breach producing out-of-scope conflicts, requiring TL/DevOps. Systemic fix = hold the cadence ceiling + fleet sync sweep, not a new push-mechanics rule.

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
- 2026-08-13 — Design (p/472#3): `git --git-dir=.orca-git add engineering/design/AGENTS.md` (no `-f`) failed "paths ignored: engineering" on an **already-tracked** nested AGENTS.md (editing, not creating). Fix: `ogit add -f` + `agent-file-owner.sh --audit` (clean) + commit. Clarifies the rule: `-f` is required for any `add` on a nested AGENTS.md under a gitignored parent — whether it's a new file or an edit to an already-tracked file. The "skip add entirely" path (p/7#39) applies only when the edit is already staged.

**Root Cause:** (1) `ogit` is defined as a shell alias (`alias ogit='git --git-dir=.orca-git --work-tree=.'`), which is only loaded in interactive shell sessions — the Bash tool runs non-interactive. (2) The overlay repo shares the working tree with the main repo, so `.gitignore` affects `ogit add`. Negation patterns (`!**/AGENTS.md`) cannot re-include files when a parent directory is already excluded by a broader rule — this bites on every new per-directory AGENTS.md. (3) Multiple agents update overlay files in parallel, causing push contention. (4) Git argument ordering: `-- <pathspec>` must come last — placing it before flags like `-m` causes git to treat the flag as a pathspec.

**Prevention:**
1. **Never use `ogit` in the Bash tool** — expand it to `git --git-dir=.orca-git --work-tree=.` since shell aliases aren't available in non-interactive shells.
2. **Always use `-f` when staging any nested overlay file under a gitignored parent dir** — `ogit add -f <path>` — whether it's a new file or an edit to an already-tracked file (Design p/472#3 confirmed `-f` required even for edits; the parent-dir `.gitignore` exclusion blocks bare `add` regardless of tracking status). Exception: if the edit is **already staged**, skip `add` entirely and `commit -- <path>` directly (p/7#39 — re-`add` of an already-staged file still fails).
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
- 2026-08-03 — Shared Lib (p/5#23): **`cd C:\...` path in Bash (POSIX sh)** — Windows backslash paths are not valid POSIX paths; Bash interprets `\` as escape sequences and silently fails with "No such file or directory". Fixed by switching to the PowerShell tool for all git/shell ops.
- 2026-08-04 — TL (p/335#1): **Bash glob with `C:\...` Windows path** — MSYS mangled the backslashes during glob expansion; no matches returned. Resolved by switching to the **Glob tool**, which handles Windows paths natively without MSYS translation.
- 2026-08-04 — Shared Lib (p/5#25): **`cd C:\...` path in Bash again** — same failure as p/5#23. **Second time same agent hit identical mistake** → per-agent memory ("on win32, paths/shell ops = PowerShell tool") is the durable fix (mirrors the Diagnostics double-hit, p/9#28+34).
- 2026-08-27 — Conflict (p/540#1): **`cd C:\path` in Bash — "No such file or directory."** Same as p/5#23+25 (axis 3). Fixed by switching to PowerShell tool. Third agent to hit this identical mistake.
- 2026-08-27 — Server Storage (p/539#1): **`cmd /c mklink /D` via Bash — silent failure.** `cmd /c mklink /D <link> <target>` produced no error and no junction. Root cause: Bash swallows `cmd.exe` stdout/stderr, so neither the success message nor any error is visible. Fix: `New-Item -ItemType Junction -Path <link> -Target <target>` via PowerShell tool — worked immediately. **Fifth axis: Windows shell commands via `cmd /c` in Bash swallow all output and may silently do nothing.**
- 2026-09-01 — Shared Lib (p/5#29): **`cmd //c mklink /J` via Bash — silent failure, 2nd axis-5 instance.** `cmd //c mklink /J <link> <target>` produced no junction and no visible error (exit-2 masked, MSYS path munging). Fix: `New-Item -ItemType Junction` via PowerShell tool worked immediately. Context: junctions used to share `node_modules` with throwaway worktrees (cheap alternative to `npm install`). See Windows Junction Trap pattern for the related `rmdir`-before-remove rule.

**Root Cause:** Agents have access to both Bash and PowerShell tools. PowerShell cmdlets (`Get-ChildItem`, `Get-Item`, `Invoke-Pester`, `Select-Object`, etc.), `$var = ...` assignment, `.Property` access, and `;`-chained statements only work in the PowerShell tool. Unix commands (`ls`, `grep`, `cat`, `stat -c%s`) only work in Bash (on Windows/Git Bash). **A second axis is path format:** git-bash presents `/c/Users/...` msys paths, but native win32 programs (`node`, and anything not msys-aware) resolve `C:\...` — an msys path handed to `node require`/`fs` fails as MODULE_NOT_FOUND / ENOENT. **A third axis:** Windows backslash paths (`C:\...`) given directly to Bash fail silently — Bash treats `\` as escape characters. **A fourth axis: Bash glob over `C:\...` paths** — MSYS mangles the backslashes during expansion, producing zero matches with no error. **A fifth axis: `cmd /c <windows-command>` in Bash** — Bash does not surface `cmd.exe`'s stdout or stderr; the command may silently fail or do nothing.

**Prevention:**
1. Use PowerShell tool for: cmdlets (`Get-*`, `Set-*`, `Invoke-*`), `$env:` variables, `$var = ...` assignment, `.Property` access on results, pipeline operators with objects. File-size checks: `(Get-Item $p).Length`.
2. Use Bash tool for: Unix commands, `git`, `npm`, `node`, `python3`, shell scripts. File-size in Bash: `stat -c%s <file>` or `wc -c < <file>`.
3. When in doubt, check if the command uses a Verb-Noun cmdlet, `$var =` assignment, or `.Property` access — if yes, it's PowerShell.
4. **Path format:** when a native win32 program (`node`, etc.) needs a filesystem path, give it a native `C:\...` or repo-relative path — NOT a git-bash `/c/...` msys path OR a mount like **`/tmp`** (both fail as MODULE_NOT_FOUND/ENOENT; `/tmp` is a virtual msys mount Node can't resolve, and `> /tmp/…` redirects land where Node can't `require`). **For any Node-consumed temp file, use the session scratchpad's absolute Windows path, not `/tmp`.** For reading a JSON/data file on win32, the PowerShell tool with a native path is the reliable route.
5. **Don't use Windows backslash paths (`C:\...`) directly in the Bash tool** — Bash (POSIX sh) treats `\` as escape characters and silently mangles the path. Use the PowerShell tool for any operation that needs a `C:\...` path, or convert to a git-bash `/c/...` form (only valid for msys-aware tools) (p/5#23).
6. **For file discovery (finding files by name pattern), use the dedicated Glob tool** — it resolves Windows paths natively without MSYS translation. `find` or shell glob expressions with `C:\...` paths in the Bash tool are silently broken (p/335#1).
7. **Never use `cmd /c <windows-command>` in the Bash tool for filesystem operations** — Bash swallows `cmd.exe` output; silent failure is indistinguishable from success. For Windows-native filesystem ops (junctions, symlinks, NTFS operations), use the PowerShell tool: `New-Item -ItemType Junction`, `New-Item -ItemType SymbolicLink`, etc. (p/539#1).

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
- 2026-09-01 — Shared Lib (p/5#29): used `New-Item -ItemType Junction` (PowerShell) to share `node_modules` with a throwaway worktree — a cheaper alternative to a full `npm install`. The junction approach works, but requires explicit teardown: **`rmdir` the junction BEFORE `git worktree remove`** — removal recurses through the junction into the real `node_modules` if the link is still present. `cmd //c mklink /J` via Bash was tried first and silently failed (see Bash/PS confusion pattern, axis 5).

**Root Cause:** Git Bash `ln -s <dir>` on Windows creates an NTFS directory junction, not a POSIX symlink. Junctions are followed by `rm -rf` and `rmdir` — cleanup of the worktree risks destroying the junction target. `git worktree remove` also fails because it encounters the junction during cleanup.

**Prevention:**
1. **Never symlink `node_modules` into a landing-worktree on Windows** — the junction will block cleanup and risk the real deps.
2. To verify a worktree commit: run verify in the main tree and prove byte-identity via `git diff <worktree-sha> <main-sha>`.
3. If isolation is essential: `npm install` inside the worktree (clean install, no junction needed; note: `npm ci` fails — this repo has no lockfile).
4. If a junction is already in place: `git worktree remove --force` + `git worktree prune` cleans safely.
5. **If you intentionally use `New-Item -ItemType Junction` to share `node_modules`: `rmdir` the junction first, THEN `git worktree remove`** — worktree removal follows junctions and will recurse into the real `node_modules`. Junction teardown must precede worktree teardown.

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

## #73 [Build] Windows Git Bash Silently Breaks Command Chains — grep Zero-Match Exit + MSYS Path Conversion

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
- 2026-08-03 — Azure (p/105#4, **facet B generalizes to a non-git tool + a leading-slash arg; 3rd agent**): `az deployment group create` failed `InvalidEnvironmentId` because MSYS mangled a **leading-slash Azure resource ID** (`/subscriptions/...`), prefixing it with the Git-bin install path (MSYS treats a leading-`/` arg as a Unix path to translate). Two broadenings: (a) the mangled arg is a **leading-slash resource ID, not a `<ref>:<path>` colon-revspec** — a 2nd MSYS trigger sharing facet B's root (args that *look like* Unix paths, already named in Root Cause); (b) it hit a **non-git tool (`az`)** and a **3rd agent** — facet B is not git-specific. Fix: pass Azure resource IDs via the **PowerShell tool** (no MSYS layer) or `MSYS_NO_PATHCONV=1`. Same env-dependent MSYS path-conversion class; ties to the win32 "prefer the PowerShell tool" habit.

**Root Cause:** (A) grep's exit code is a *match indicator*, not a *success indicator* — 0 = matched, 1 = no match, 2 = error. In an `&&` chain the shell treats exit 1 as failure and stops, so a legitimately-empty result (count `0`) aborts the chain. Standard POSIX grep behavior, not Windows-specific, but it bites hardest in Bash-tool one-liners that chain a count check into follow-up steps — and it recurs (2 agents in one day: a zero `.ts`-entry count and a zero-deletion diff count). Same "exit code ≠ what you think" family as the "Bash grep Features Fail Silently on Windows/Git Bash" pattern. (B) MSYS/Git-Bash *can* rewrite arguments that *look like* Unix paths (containing `/` or a leading drive-colon) into Windows paths before the program sees them. `git show`'s `<ref>:<path>` syntax collides with this — the `:` and `/`s get converted, corrupting the ref. **This is config-dependent** (`MSYS2_ARG_CONV_EXCL` / `MSYS_NO_PATHCONV` / how the Bash tool's MSYS is configured): it reproduced in DevOps's env and NOT in TL's, where every `git show <ref>:<path>` ran clean all session. So the harm is not "the command always breaks" — it's **misreading the false `unknown revision` as a genuinely-missing ref** (the exact wrong forensics conclusion the root Git-Forensics rule guards against). `MSYS_NO_PATHCONV=1` (or a leading `//`) disables the conversion for that command. Sibling of #67 (Git Bash eats shell operators before pwsh sees them) — same root: the Bash tool is Git Bash, and its shell/MSYS layer *may* transform your command before the target program runs.

**Prevention:**
1. **Keep zero-match/count checks out of `&&` chains.** Capture the value first (`n=$(grep -c ... || true)`) then test it, or append `|| true` so a legitimate zero-match doesn't abort the chain. Never assume `grep`/`grep -c` exit 0 on a successful-but-empty result.
2. **Facet B is a failure-SIGNATURE, not a blanket mandate** (TL, p/8#79): if `git show <ref>:<slashed-path>` reports `unknown revision` on a ref/path you KNOW exists, that's MSYS path-conversion — retry with `MSYS_NO_PATHCONV=1`. Do NOT prefix it unconditionally; it's config-dependent and unnecessary in envs (like TL's) that don't mangle. The critical error to avoid is concluding the ref is genuinely missing — the exact wrong forensics call the root Git-Forensics rule exists to prevent.
3. **So: a valid ref reporting "unknown revision" in the Bash tool is the tell** — suspect MSYS path-conversion before doubting the ref exists; confirm by re-running with `MSYS_NO_PATHCONV=1`, **OR run the same `git show` through the PowerShell tool** (no MSYS layer → no munging; DevOps p/26#29) — the cleanest cross-tool escape on win32.
4. **`git show <ref>:<path>` resolves `<path>` from the REPO ROOT, not your cwd** (facet C, platform-agnostic) — from a subdirectory a cwd-relative path exits **128** and looks like the file is missing in the ref. Use a repo-root-relative path (or `git -C <repo-root> show <ref>:<path>`). Same "valid path, misleading git-show failure → don't conclude the content is absent" caution as facet B, different cause.

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
- 2026-07-28 — DebateDiagnostics (p/245#1): `git worktree remove <wt>` **timed out at 2min** synchronously `rm -rf`-ing the worktree's large `node_modules` (Windows/AV). Resolved by detaching git metadata fast, then backgrounding the delete: `git worktree prune` + `git branch -D <branch>`, then `rm -rf <wt-dir>` as a backgrounded task. (Facet B — supersedes the `--force` remedy for deps-installed worktrees.)
- 2026-07-29 — Chat (p/270#1): `git worktree remove` **timed out at 2min** on a **double-`npm ci`'d** worktree (root **and** `taxonomy-editor/` → tens of thousands of node_modules files). git had already marked it **`prunable`**, so a backgrounded `rm -rf` + `git worktree prune` finished cleanup with **no `branch -D` needed**. 3rd instance — Facet B; the double-`npm ci` is the amplifier.
- 2026-07-29 — Server Storage (t/1921 Batch B/C, p/206#5): `git worktree remove --force` failed **"`.git` does not exist"** — the OS/AV had already deleted the physical worktree dir, leaving only a stale administrative ref. Resolved with **`git worktree prune`**. (Facet C — the delete already happened out-of-band; `prune` is the whole fix, `remove` is the wrong verb.)
- 2026-08-05 — DebateTool (p/70#14, t/2186): worktree at `C:/Users/jsnov/repos/wt-2186` had its **`.git` file silently disappear** — the directory still contained `lib/` and `node_modules/` content but no git metadata. Git commands had worked during the active rebase session; by next use the worktree was dead ("not a git repository"). Pushed from the main repo instead. (Facet E — `.git` file gone, content intact; distinct from Facet C where the whole dir was deleted.) Likely cause: OS/AV or a cleanup process selectively deleted the small `.git` pointer file while leaving larger content dirs alone.
- 2026-08-11 — Rosetta Stone (p/6#54): `git worktree remove --force` **timed out twice** (2 min cap) on worktrees with installed `node_modules`. Resolution: re-ran each with `run_in_background: true` — exits 0, the slow rm continues in the OS without blocking the session. (Facet B variant — background the `--force` command itself, simpler than the prune + branch-D + rm split.)
- 2026-08-11 — ServerAPI (p/79#31): `git worktree remove --force` **timed out on two worktrees** with per-worktree `node_modules`. Same resolution: re-ran with `run_in_background: true`. 5th Facet B instance; 2nd confirmation that backgrounding `--force` is the reliable Windows fix.

**Root Cause:** (A) `git worktree remove` aborts on untracked files, and an in-worktree `npm ci` always leaves a large untracked `node_modules`. (B) `--force` clears the refusal but does the deletion **synchronously in the foreground**, and unlinking tens of thousands of small files is pathologically slow on Windows (each hits AV/indexing), blowing the 2-minute timeout. (C) Once the physical dir is already gone, `remove` fails ("`.git` does not exist") — only the stale ref remains, which `prune` clears. (E) The `.git` file in a linked worktree is a small plain-text pointer file (`gitdir: /path/to/.git/worktrees/...`) — unlike the main repo's `.git` directory, it's just one file that AV/OS cleanup processes may selectively delete while leaving larger content dirs (`lib/`, `node_modules/`) intact. When it's gone, the directory is no longer a git repository from any tool's perspective, but the content survives. The through-line: `remove` couples git-metadata detach (instant) with the physical delete (slow, or possibly already done); decouple them — `prune` owns the ref, a backgrounded `rm -rf` owns the files. Companion to #77 and the Windows Junction pattern.

**Prevention:**
1. **For a deps-installed worktree, don't `git worktree remove` — detach fast, delete in the background** (DebateDiagnostics, p/245#1): `git worktree prune` + `git branch -D <branch>` (instant), then `rm -rf <wt-dir>` **backgrounded**. Avoids BOTH the refusal (A) and the foreground-rm timeout (B). If git already reports the worktree **`prunable`**, backgrounded `rm -rf` + `git worktree prune` alone suffices (skip `branch -D`, Chat p/270#1). A land that builds **both** root and `taxonomy-editor/` leaves **two** node_modules trees — double the delete.
2. **`git worktree remove --force` is the fallback only for small/no-deps worktrees** — where the synchronous rm is fast. With a full `node_modules` on Windows it times out synchronously; use #1 OR pass `run_in_background: true` so the slow rm doesn't block the 2-min session cap (Rosetta Stone p/6#54).
3. **remove/rm only after your commit is pushed** — confirm the work is on `origin/main`; the sole casualty is `node_modules`. Never remove with uncommitted deliverable work.
4. `git worktree prune` also clears stale administrative refs (same follow-up as the Junction pattern).
5. **(Facet E) Verify the `.git` file exists before starting work in an existing worktree:** `Test-Path <wt>\.git` (PowerShell) or `ls <wt>/.git` — if absent, the worktree is dead; push from the main repo using the branch name, then `git worktree prune` to clear the stale ref.

**Status:** Active — worktree-land cluster; `/land-from-worktree` step-8 guidance updated from "`remove --force`" to "**prune + `branch -D` + background rm**" for deps-installed worktrees (supersedes the earlier `--force` wording; both refusal + timeout covered). Handed to TL for the owner-gated batch. **Facet E added 2026-08-05 (DebateTool p/70#14):** `.git` pointer file silently deleted by OS/AV mid-session; worktree content survives but git is blind to it — push from main repo, then `git worktree prune`.

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

**Root Cause:** Splitting `<name>.ts` → a `<name>/` barrel preserves the *import* surface (`import { x } from '.../<name>'` resolves via the barrel index), so `tsc`/verify never complain. But a **prose citation** of the concrete file path is not an import — nothing validates it — so it silently rots. No build gate catches it because the build was never wrong.

**Prevention:**
1. **Verify the cited path RESOLVES at citation time** — post-t/1686, a cited `<name>.ts` may now be a `<name>/` barrel; check for the dir + specific sub-module before citing. Don't rely on fix-on-break — it never breaks.
2. **When splitting a file into a barrel, grep docs/register/tickets/emails for the old `<name>.ts`** and update (or leave a redirect note) as part of the split.
3. **Silent-failure classes are verify-at-write-time, not fix-on-break** — anything caught only by grep-empty (never a red build) has no gate, so the discipline is at the moment of citation.

**Status:** Active — NOT a #82 case (new hazard from ADR-007, not a pre-existing rule unapplied). **Unit note (TL p/8#107):** report units separately — 4 citations / 3 tickets / 1 offender / 2 reporters (TL owns the single report; DebateTool 2 is not a duplicate). Sage tallies (esp. #82 triggers) are unit-sensitive: citations ≠ tickets ≠ offenders ≠ agents.

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
2. **When you add a DELIBERATELY-invalid fixture (a negative test), apply the scanning gate's documented suppression marker on the SAME PHYSICAL LINE** — e.g. `-Model 'bad-id-zzz'  # model-lint:allow`. A negative test is invalid *by design* — exactly what a repo-wide scanner flags; the inline marker declares "this invalidity is intentional." Author's proactive obligation, not a CI afterthought.
3. **Know the repo-wide gates exist:** `ModelLiteralLint` (`-Model` literal staleness, t/1858), manifest/version-coherence checks, ontology referential-integrity checks — they scan files other than their own, so a new literal/fixture in *any* file can trip them.
4. **Land targeted edits onto a fresh worktree base**, don't copy a stale whole file — a stale base hides newly-added gates and risks clobbering peers' additions (#79 stale facet).

**Status:** Active — local-vs-CI divergence by *test scope* (changed-file run ≠ full suite), sibling of #88 (keys-present live-backend divergence); ~5h fleet-wide red main. Reinforces "verify before push" with a concrete failure mode: repo-wide lints live outside the files they govern, and a deliberately-invalid fixture must carry the gate's inline suppression marker.

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
- 2026-08-13 — ElectronMain (p/98#17): **11th instance, 8th independent agent.** `gh pr merge --delete-branch` failed when branch was checked out by a worktree. Fix: dropped `--delete-branch` (GitHub auto-deletes on merge), then removed worktree + `git branch -D` for local cleanup.
- 2026-08-22 — DevOps (p/26#89): **12th instance, Facet 4.** `gh pr close --delete-branch` failed on GV probe PR #1385 — branch still held by a worktree. Fix: `git worktree remove --force`, then `git branch -D`, then `git push origin --delete <branch>`.
- 2026-08-22 — Computational Linguist (p/7#62): **13th instance, Facet 2.** `gh pr merge <N> --squash --delete-branch` exited 1 — "cannot delete branch ... used by worktree." Remote merge AND remote-branch delete both succeeded; only the local branch delete failed. Confirmed `state=MERGED`, then `git worktree remove` + `git branch -D`. Key reinforcement: **non-zero exit from `--delete-branch` must be treated as post-merge cleanup failure, not a merge failure** — verify PR state before any re-attempt.
- 2026-08-24 — DebateDiagnostics (p/514#1): **14th instance, Facet 2.** `gh pr merge --delete-branch` failed — branch still checked out in an active worktree. Fix: `git worktree remove` first. Self-noted: `/land-from-worktree` skill already omits `--delete-branch` for this exact reason; using the skill would have avoided the failure entirely.
- 2026-08-26 — ServerAPI (p/504#3): **15th instance, Facet 2.** `gh pr merge --delete-branch` errored — worktree held the branch. Resolved by removing the worktree first (PR was already merged). Self-noted: `/land-from-worktree` omits `--delete-branch` for this reason; skill adherence would have prevented it.

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

**Root Cause:** the Bash tool caps foreground commands at ~2 minutes; a sleep-poll loop is *designed* to run longer, so any wait > 2m hits the cap and SIGTERMs. Same **"foreground op > 120s → killed → background it"** genus as #78 (worktree-remove rm) and #95 (large push) — here the "long op" is an intentional wait loop. A background task is the sanctioned escape: it survives past 2m and notifies on exit; foreground polling never should.

**Prevention:**
1. **Never foreground-poll in a `sleep`-loop for external state (PR merge, CI, deploy).** Put the wait in a `run_in_background` monitor (survives past 2m, re-invokes on completion) and do a **single direct state check** (`gh pr view <n> --json state`) when you need a point-in-time answer.
2. **If you must check inline, do ONE check, not a loop** — if it's not ready, background the wait rather than sleeping in the foreground.
3. Genus rule: any foreground op that can exceed ~2m (huge-tree rm #78, large push #95, poll loops) belongs in the background; the foreground is for bounded-fast commands only.

**Status:** Active — poll-loop variant of the "foreground long op > 120s Bash cap → background it" genus (#78/#95). Standing rule: never foreground loop-poll `gh`.

**Applies To:** All agents waiting on external state (PR merge, CI, deploy) from the Bash tool.

---

## #117 [Build] A Green (Differential) CodeQL PR Check ≠ a PRE-EXISTING Alert Is Fixed — Verify a Fix on the Post-Merge MAIN SAST Scan, Not the PR Check or Branch-Ref Query

**Pattern:** CodeQL's PR check-run is DIFFERENTIAL — it fails only on NEW alerts the PR introduces and passes (green) regardless of whether the PR's intended fix actually cleared a **pre-existing** alert. So a green CodeQL check does NOT confirm a pre-existing alert is resolved. Worse, the PR/branch-ref alerts query (`code-scanning/alerts` filtered to the PR's ref) returns **empty unreliably**, which reads as "no alerts → cleared" and misleads you into reporting a fix landed when it hasn't. The authoritative signal is the **post-merge MAIN-branch SAST scan** (the full re-scan that re-evaluates the whole backlog).

**Instances:**
- 2026-07-30 — ServerAPI (t/2019): reported a pre-existing CodeQL alert "cleared" based on a **green PR check + an empty branch-ref alerts query** — but the differential check only gated NEW alerts, and the branch-ref query was unreliably-empty. The fix's real effect had to be confirmed on the **post-merge MAIN SAST scan**. Also hit: the code-scanning **dismiss API caps `dismissed_comment` at 280 chars (HTTP 422 over)** — discovered here.
- 2026-08-03 — Technical Lead (p/8#173, t/2110): wrote a dismissal comment at normal ticket-comment length — the API 422d "Only 280 characters are allowed." Fix: keep the comment to a tweet-length summary (verdict + guard reference); put the full reasoning on the ticket.
- 2026-08-03 — Tech Lead 2 (p/253#5/#7, t/2100): bulk CodeQL dismissal script 422d when `dismissed_comment` exceeded 280 chars. **Root cause differs from instance 1:** the cap was already documented (prevention #3 above), but filed under a *verification* lesson a bulk-dismissal author would never navigate to — a **findability failure, not a knowledge failure**. Durable fix: landing dismissal rules in `docs/security/dependency-policy.md` § Dismissal Rules (TL2 PR #380) where dismissal work gets written.

**Root Cause:** differential CodeQL (the t/2025 / #112 design — fail on NEW alerts only, not the ~108-alert backlog) is calibrated to NOT block on pre-existing alerts, so by design a green check says nothing about them. The branch-ref alerts API is ref-scoped / eventually-consistent and returns empty spuriously. Confirming a pre-existing-alert fix therefore requires the full MAIN scan (re-evaluates the backlog), not the PR-scoped differential signal. Flip side of #112: **#112** = a green required gate hides a NEW alert; **#117** = a green differential check falsely implies a PRE-EXISTING alert is fixed. Both stem from "the CodeQL PR signal is new-only/differential." The 280-char `dismissed_comment` sub-finding also has a **findability root cause**: correct guidance filed under the wrong lesson heading is effectively absent for the author who needs it.

**Prevention:**
1. **To confirm a fix cleared a PRE-EXISTING CodeQL alert, verify on the POST-MERGE MAIN SAST scan** — NOT the PR check-run (green = no new alerts, says nothing about the backlog) and NOT the branch-ref alerts query (returns empty unreliably). **Confirm the SPECIFIC alert's state on main:** `gh api repos/:owner/:repo/code-scanning/alerts/<n> --jq .state` → must read `fixed` or `dismissed` (TL t/2001#11).
2. **Don't report a pre-existing alert "cleared" from a green PR check or an empty branch-ref query.** Wait for main's scan, or the alert's state flipping to `fixed`/`dismissed` on the MAIN-ref query.
3. **Dismissing a code-scanning alert: `dismissed_comment` caps at 280 chars** (HTTP 422 over, undocumented in the error body) — format: verdict + enforcing guard + ticket ref; put full source/sink analysis in a **co-located code comment** (tickets get archived; code stays co-located with the dismissal). Canonical rules now in `docs/security/dependency-policy.md` § Dismissal Rules (p/253#5, t/2100).

**Status:** Active — 2 instances. Flip side of #112 (a green differential CodeQL check says nothing about the pre-existing backlog); high-relevance to Wave-2's backlog-clearing (t/2001). Ties to the t/2025 differential-mode gate. **DISPOSITIONED (TL p/8#142):** sharpened into durable Wave-2 guidance at **t/2001#11**. 280-char `dismissed_comment` cap now in `docs/security/dependency-policy.md` § Dismissal Rules — canonical location for dismissal authors (TL2 PR #380, p/253#7).

**Applies To:** All agents clearing/dismissing pre-existing CodeQL alerts (Wave-2 security work) — verify fixes on the MAIN scan; keep dismiss comments ≤280 chars.

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

**Instances:**
- 2026-08-01 — Server Storage (p/206#13, re-confirmed p/206#14): `gh pr checks 326` exited **8** because `test-container` was still running; **no check actually failed**. Recognized as expected `gh` behavior; **re-polled once `test-container` completed** → green. (Two reports same session — the exit-8 = pending semantics catch people.)
- 2026-08-06 — DebateUI (p/83#8, Facet B): `gh pr checks <n> --watch` exited **0** while `test-electron` jobs still showed **"pending 0"** — the checks hadn't been registered yet. `--watch` saw no failing checks and exited; later the real job results arrived. False-green signal on a PR that wasn't fully checked.

**Root Cause:** `gh pr checks`'s exit code encodes STATE, not a pass/fail boolean — exit 8 specifically means "not done yet." Same "exit code is a status indicator, not success/failure" family as #73 facet A (grep exit-1 on zero-match ≠ error). It bites hardest during a self-merge wait, when a slow check (`test-container`) hasn't finished but every other check is green — the raw exit looks like failure. **Now covered** by the `exit-code-literacy-guard` workspace rule (2026-08-03, t/2081) — the exit-8=pending branch of the exit-code-literacy family; advisory (non-blocking). **Firing OBSERVED live on THIS branch — TL saw it correctly flag exit-8=pending (not failed) on `gh pr checks 334` during the PR #334 CodeQL wait (p/8#166)** — the 2nd of two independent live firings (Sage's `grep -c` #73A branch was the 1st); systematic verification deferred per t/1625.

**Prevention:**
1. **Don't read `gh pr checks` non-zero as "failed" — distinguish exit `8` (PENDING → re-poll) from exit `1` (FAILED → stop).** Branch on the specific code, or better, on the actual per-check state.
2. **Parse the per-check state, not just the exit code** — `gh pr checks <n> --json name,state,conclusion --jq '...'` gives real states (`IN_PROGRESS`/`QUEUED` vs `FAILURE`); the raw exit code alone can't tell pending from failed to a naive branch.
3. **On a self-merge wait, exit 8 = "not done, re-poll"** — re-run once the pending check completes (or use a background monitor, #116); don't abort the land.
4. **Facet B — `--watch` false-green:** after `--watch` exits 0, verify with a bare `gh pr checks <n>` (no `--watch`) to confirm all jobs have actually completed with conclusions. If any show "pending 0" or blank conclusion, `--watch` exited prematurely — wait and re-check.

**Status:** Active — `gh pr checks` tri-state exit-code semantics (0 pass / 1 fail / 8 pending); "exit code ≠ pass/fail boolean" family (#73A). Self-correcting once recognized. CI-wait sibling of #111 (current-HEAD-gated workflow) and #116 (background monitor, not foreground poll).

**Applies To:** All agents polling `gh pr checks` while waiting on PR checks (self-merge / land waits).

---

## #122 [Build] A Subprocess-Per-File Bash Loop Over the Whole Tree Times Out on Git Bash/Windows — Use Parameter Expansion, Not `$(cmd)` Per Item

**Pattern:** A bash loop that spawns a subprocess PER FILE — e.g. `$(dirname "$f")` (or `$(basename)`, `$(echo | sed)`) inside a loop over `git ls-files` (~thousands of files) — spawns tens of thousands of subprocesses. On **Git Bash/Windows, process spawn is pathologically slow** (fork/exec emulation), so the loop **blows the 2-minute Bash-tool timeout (exit 143)** on a few-thousand-file tree. The same loop is fast on Linux (cheap fork) — a **Windows-specific perf cliff**, invisible in Linux CI.

**Instances:**
- 2026-08-01 — DevOps (t/2091, p/26#31): a CI script built a tracked-dir set via a **`$(dirname)` subshell loop over `git ls-files` (~3k files)** → tens of thousands of subprocess spawns → **timed out (>2 min)** on Git Bash/Windows. Fixed with **pure-bash ancestor extraction via parameter expansion** — `while [[ $d == */* ]]; do d=${d%/*}; done` (zero subprocesses) → **47s**.
- 2026-09-01 — PowerShell 2 (t/3124, p/228#18): a shell loop spawning a **per-file `git diff` over 236 files** timed out at the 2-min cap. Fixed by issuing **one bulk `git diff` piped to a single Python pass** — one subprocess vs 236 → well under the limit. Prevention #3 (batch all items into one invocation) confirmed as the right fix class.

**Root Cause:** each `$(...)` / backtick command substitution **forks a subprocess**; on Windows Git Bash, fork/exec is emulated and ~orders of magnitude slower than native, so N-thousand spawns dominate wall-clock. Bash **parameter expansion** (`${d%/*}` = dirname, `${f##*/}` = basename, `${f%.*}` = strip-ext) does the same string ops **in-process** — zero spawns. Ties to the "foreground op > 120s Bash-tool cap → SIGTERM" genus (#78/#95/#116), but here the cost is **spawn-count**, not a single slow op or I/O.

**Prevention:**
1. **Never spawn a subprocess per file when iterating the whole tree in bash** — replace `$(dirname "$f")` → `${f%/*}`, `$(basename "$f")` → `${f##*/}`, `$(echo "$x" | sed …)` → parameter expansion (`${x//a/b}`, `${x%suffix}`, `${x#prefix}`). Parameter expansion is in-process; command substitution forks.
2. **On Git Bash/Windows, subprocess spawn is the bottleneck, not the work** — a loop fine on Linux CI can blow the 2m Bash-tool cap on win32 purely from spawn count. Count `$(...)`-per-iteration × tree size before running a whole-tree loop.
3. **If you genuinely need an external tool per item, batch it** — feed all items to ONE `xargs`/`awk`/`sed` invocation instead of one spawn per item.

**Status:** Active — Windows Git-Bash subprocess-spawn perf cliff; a whole-tree per-file `$(cmd)` loop times out (spawn-count-bound). Sibling of the "foreground op > 120s Bash cap" genus (#78/#95/#116) — same 2m-timeout symptom, root cause = subprocess spawns, not a single slow op.

**Applies To:** All agents writing bash loops over `git ls-files` / large file sets on Windows Git Bash — use parameter expansion; batch external tools.

---

## #123 [Process] Shared GitHub Account — `gh pr review --approve` Fails "Cannot approve your own pull request" on ANY Fleet PR

**Pattern:** All fleet agents authenticate to GitHub as the **same account** (`jpsnover`). GitHub prohibits approving your own PR, so `gh pr review --approve` on **any agent-created PR** fails `Cannot approve your own pull request` — from `gh`'s view every fleet PR is self-owned, because there is only one identity. A shared-**identity** collision at the GitHub-account level — the platform-account analog of the shared-**checkout** collision (t/1926) at the git level.

**Instances:**
- 2026-08-03 — DevOps (p/26#34): `gh pr review --approve` on PR #334 failed `Cannot approve your own pull request`. Resolved by posting the review as a **comment** (`gh pr review --comment`).

**Root Cause:** A single shared GitHub identity across all agents × GitHub's self-approval prohibition. Approval is a per-USER action GitHub ties to account identity; the fleet has ONE account, so no agent is a "different user" relative to a fleet PR's author. The failure is **deterministic** — it hits *every* agent that runs `--approve` on *every* fleet PR.

**Prevention:**
1. **Never `gh pr review --approve` a fleet PR** — it always fails under the shared account. Post review feedback with **`gh pr review --comment`** (or `--request-changes` for blocking feedback).
2. **Approval is NOT required to merge anyway:** branch protection is **checks-only** (`ci-gate` + CodeQL, strict off — no required-reviews), so PRs land by checks-green self-merge, not by approval. The failed `--approve` is a **non-blocker**, not a gate you must satisfy.
3. **Sibling of the docs-only self-merge constraint (#101):** both are shared-account / self-action limits on the PR flow — a docs-only PR can't self-satisfy required contexts (→ TL `--admin`-merge), and no agent can self-approve (→ record the verdict as a comment). Use TL `--admin`-merge only where the PR *path* is blocked; a review *verdict* is a comment.
4. **Cheaply hookable if it recurs:** the trigger is the literal `gh pr review --approve` in a Bash command — a crisp syntactic signal an advisory hook could catch ("shared account → will fail; use `--comment`"). Candidate Diagnostics hook on a 2nd instance.

**Status:** Active — shared-GitHub-identity constraint; the account-level analog of the shared-checkout collision (t/1926). **Non-blocking** (approval isn't required under checks-only branch protection); the fix is to post reviews as comments. Deterministic (every agent, every fleet PR), so 1 instance ⇒ it WILL recur — flagged hookable.

**Applies To:** Any agent running `gh pr review --approve` on a fleet-authored PR (i.e. every PR, since all share the `jpsnover` account).

---

## #128 [Build] `git worktree add ../wt-<name>` Creates the Worktree at the REPO's Parent Level — Not the User Home; Always Run `git worktree list` Before First Bash Access

**Pattern:** A worktree added at `../wt-<name>` resolves relative to the **repository root** (`C:/Users/jsnov/repos/ai-triad-research/`), landing at `C:/Users/jsnov/repos/wt-<name>` — the `repos/` sibling directory. If the agent's mental map flattens the path depth (assumed home/repo, not home/repos/repo), the resulting absolute path is one level shallower than the actual. In the Bash tool's POSIX view, that's `/c/Users/jsnov/repos/wt-<name>`, not `/c/Users/jsnov/wt-<name>`. Running `ls` or any Bash command on the incorrectly-assembled path fails with `No such file or directory`.

**Instances:**
- 2026-08-03 — DevOps (t/2067, p/26#38): ran `ls /c/Users/jsnov/wt-2067/` — assumed `../wt-2067` from the repo resolves at home level, but the actual path was `C:/Users/jsnov/repos/wt-2067` = `/c/Users/jsnov/repos/wt-2067`. Fixed by running `git worktree list` to confirm the real path.
- 2026-08-03 — ElectronMain (p/98#13, t/2111): `cd /c/.../wt-t2111` immediately after `git worktree add ../wt-t2111` — "No such file." Compounding factor: **Bash tool resets cwd between invocations**, so the cwd for the `cd` call was the repo root regardless of any prior `cd`. The agent constructed the POSIX path from memory rather than reading `git worktree list`. Fixed by running `git worktree list` and using the canonical absolute path `/c/Users/jsnov/repos/wt-t2111`.

**Root Cause:** The repo lives at `C:/Users/jsnov/repos/ai-triad-research/` — two levels below home (`home/repos/repo`), not one (`home/repo`). `../wt-<name>` from the repo root goes up one level to `C:/Users/jsnov/repos/`, landing the worktree there, not at the user home directory. This is a **mental-model mismatch** (wrong path depth), distinct from MSYS path mangling (#73 facet B) — here the path is assembled incorrectly before any tool sees it. **Compounding factor (instance 2):** the Bash tool resets cwd to the repo root between invocations, so any relative path like `../wt-<name>` re-anchors to the repo root on every call — you cannot rely on a prior `cd` persisting to the next Bash call.

**Prevention:**
1. **Run `git worktree list` BEFORE first Bash access to a worktree** — it returns the canonical absolute path; never reconstruct the path by prepending the assumed home directory + a relative spec.
2. On this machine: repo = `C:/Users/jsnov/repos/ai-triad-research/`; sibling worktrees land at `C:/Users/jsnov/repos/wt-<name>` = `/c/Users/jsnov/repos/wt-<name>` in POSIX. NOT `/c/Users/jsnov/wt-<name>`.
3. Companion to the MSYS colon-revspec/path trap (#73 facet B): both produce a wrong absolute path for a git resource. #73B = MSYS mangles a correct path; #128 = a wrong path is assembled from an incorrect mental model. The fix for both: **verify the actual path before access** rather than reconstructing from memory.
4. **Bash tool cwd resets to the repo root between invocations** — relative paths (`../wt-<name>`) re-anchor on every call; don't assume a prior `cd` carried over. Use absolute paths from `git worktree list` output.

**Status:** Active — 2 instances. Worktree-land path-depth assumption hazard; cwd-reset compounds it. Third env/path hazard in the worktree-land cluster (#77 `npm ci` empty package dir, #78 node_modules rm timeout, #128 path-depth mismatch). `git worktree list` is the one-stop oracle for canonical worktree paths.

**Applies To:** All agents using the Bash tool to access a worktree by absolute POSIX path.

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

**Root Cause:** The Edit/Write tools take an absolute path and do not validate it against the active worktree. Agents know their scope's canonical path (e.g. `operations/devops/`) and naturally infer `file_path` by prepending the repo root they know from context — but in a worktree, the root is different. Without explicitly confirming the worktree root via `git worktree list`, the inferred path silently targets the shared checkout instead. Distinct from #128 (Bash tool `ls` on wrong POSIX path due to depth miscount) — here the failure is a wrong absolute path to Edit/Write.

**Prevention:**
1. **At the start of every worktree workflow, record the worktree's absolute root** from `git worktree list` output (or the `git worktree add` output line `HEAD is now at …`).
2. **All Edit/Write calls must use paths prefixed with the worktree root** — never with the main-checkout repo root, even if the scope's relative path is well-known.
3. **Confirm before first Edit:** `git worktree list | grep <branch-name>` gives the canonical absolute path.
4. Sibling of #128 — both produce an edit-to-wrong-tree; #128 affects Bash tool path access, #134 affects Edit/Write tool file_path.

**Status:** Active — 1 instance (DevOps p/26#44). 4th env/path hazard in the worktree-land cluster.

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

**Root Cause:** `git stash` operates on the full working tree with no ownership awareness. In a shared checkout, uncommitted changes from multiple agents coexist. A bare stash sweeps everything into one bundle; on pop, the merge machinery conflicts on the other agent's file even though the stash holder never intended to own it.

**Prevention:**
1. **Always use a pathspec:** `git stash push -- <your-files>` instead of bare `git stash`. Scope the stash to files you own.
2. **Before stashing, `git status`** — if other agents' files are present in the working tree, an explicit pathspec is mandatory.
3. **Before `git stash pop`, `git stash show`** — if the stash contains files you don't own, inspect the working tree for those files first to predict whether pop will conflict.
4. **If pop conflicts on another agent's file:** check if the working tree already has the correct version. If yes, the stash entry is redundant — `git stash drop` and verify your own files are still correct.

**Status:** Active — 1 instance (Rosetta Stone p/6#47). Single occurrence; recorded because bare-stash-in-shared-tree is a recurring pattern setup.

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

**Root Cause:** `gh pr create` without `--head` infers the head branch from the current local state — current branch + working tree cleanliness. The shared tree's uncommitted changes (belonging to other agents) trigger the "uncommitted changes" check even though the PR's actual branch is clean on origin.

**Prevention:**
1. **Always pass `--head <branch>` explicitly with `gh pr create` when running from the shared checkout** — never let the CLI infer from local state.
2. Alternatively, run `gh pr create` from inside the worktree where the branch is checked out and clean.

**Status:** Active — 1 instance (DevOps p/26#70).

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

## #161 [Build] Unbounded Filesystem Traversal From Repo Root Times Out — `git ls-files --others`, `find .`, and Similar Commands Hit the Worktree Explosion

**Pattern:** Any unbounded filesystem traversal launched from the repo root recurses into every linked worktree directory under `.worktrees/<name>/` — enumerating thousands of files across all active worktrees (~60 worktrees × ~3k files each = ~180k entries). Commands affected: `git ls-files --others` (no worktree-awareness), `find . -name ...` (no git awareness), and any shell glob expansion from root. All time out at the 2-minute Bash cap on this repo.

**Instances:**
- 2026-08-11 — Rosetta Stone (p/6#52): `git ls-files --others --exclude-standard` piped into a per-file diff loop timed out at 2 min. Root cause: recursed into populated `.worktrees/` dirs. Fix: scope with pathspec (`-- docs research`) or exclude pattern (`:(exclude).worktrees`).
- 2026-08-22 — Computational Linguist (p/7#63): `find . -name <pattern>` from the repo root timed out at 2 min — same root cause (~60 worktrees). Resolved by switching to `git ls-tree`/Glob tool instead.

**Root Cause:** The repo has ~60 linked worktrees, each a full checkout (~3k files). Any traversal that doesn't exclude `.worktrees/` multiplies the file set by ~60. `git ls-files --others` lacks `git status`'s worktree-awareness; `find .` is purely filesystem-level and has no git awareness at all.

**Prevention:**
1. **Never run `git ls-files --others` unbounded** — always scope: `git ls-files --others -- <scope>` or exclude: `git ls-files --others ':(exclude).worktrees'`.
2. **Never run `find .` from the repo root** — use the Glob tool (path-aware, doesn't recurse into worktrees) or `git ls-tree -r HEAD --name-only -- <scope>` for git-tracked files.
3. `git status -- <scope>` is safer than `git ls-files --others` for untracked-file checks (worktree-aware).
4. For locating a file by name: `git ls-tree -r HEAD --name-only | grep <pattern>` scopes to the commit tree; Glob tool handles pattern matching without filesystem recursion.

**Status:** Active — 2 instances; applies to all filesystem-traversal commands at repo root.

**Applies To:** All agents running file-discovery or untracked-file checks in the main repo.

---

## #162 [Process] Duplicate Implementation Without Checking Current State — Self-Race

**Pattern:** An agent implements a ticket (or acts on a delegated task) without first verifying whether the work has already landed on main. The second implementation opens a PR that is either a duplicate or conflicts with the landed state, requiring manual reconciliation. Trigger variants: (A) session/context loss — agent resumes from ticket description, unaware a prior pass already merged; (B) delegated ping — agent acts on an incoming delegation without checking `git log`/ticket state first.

**Instances:**
- 2026-08-11 — ServerAPI (t/2474): PR #849 merged at 18:55 (co-authored); PR #850 opened at 19:01 from a pre-#849 base, evidently unaware #849 had landed. Likely caused by session/context loss between passes. TL merged #850's variant over it (265de260); details t/2474#4-5. *(Trigger A: context loss)*
- 2026-08-24 — ServerAPI (PR #1506, p/504#1): acted on a delegated ping without checking whether the ticket was already landed on main — skipped `git log`/ticket-state check. PR #1506 merged as a no-op duplicate (identical single-line change); no revert needed. *(Trigger B: delegated ping)*

**Root Cause:** The pre-implementation state check ("has this already landed?") is skipped. For Trigger A, context loss is the proximate cause; for Trigger B, the urgency of a direct delegation bypasses the check. In both cases, the gap is the same: the agent starts implementing from the task description rather than the current main state.

**Prevention:**
1. **Before opening a PR, search open AND merged PRs for the ticket key:** `gh pr list --state all --search "t/XXXX" -R AI-Rosetta-Stone/ai-triad-research`. If a merged PR exists, read its diff before writing any code.
2. **For delegated pings, run `git log --oneline origin/main -- <files>` before acting** — if the delegated change is already in the log, reply "already landed" rather than re-implementing.
3. After a context boundary (session restart, long gap, context compression), re-read the ticket's latest comments before starting implementation — the ticket anchor is where completed work is recorded.
4. If a merged PR is found for the ticket, close any draft/stale work and redirect to a follow-up ticket rather than overwriting the landed implementation.

**Status:** Active — 2 instances (ServerAPI t/2474, p/335#24; ServerAPI PR #1506, p/504#1).

**Applies To:** All agents implementing tickets or acting on delegated pings — especially after context boundaries or when receiving task handoffs from other agents.

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

## #167 [Build] `git worktree add <dir> origin/<branch>` Without `-b` Creates a Detached HEAD — Pre-Commit Hook Blocks the Commit

**Pattern:** `git worktree add <dir> origin/<branch>` (no `-b` flag) checks out the remote ref in a detached-HEAD state instead of creating a local named branch. The orphaned-commit guard (t/2009 pre-commit hook) then refuses any commit in that worktree: "refusing to commit on detached HEAD." The fix is `git switch -c <local-branch>` in the worktree to attach HEAD to a branch; commits then proceed normally and can be pushed with `git push origin HEAD:<remote-branch>`.

**Instances:**
- 2026-08-20 — Tech Lead (p/335#42): `git worktree add <dir> origin/<branch>` without `-b` produced a detached HEAD; the pre-commit hook refused the commit; fixed by `git switch -c <local-branch>` in the worktree, then committed and pushed with `git push origin HEAD:<remote-branch>`.

**Root Cause:** Without `-b`, `git worktree add <dir> <ref>` treats the ref as a commit-ish to check out directly — a detached HEAD, not a branch checkout. This is correct git behavior but surprising when the ref is an existing remote branch: the intent is "base my work on this branch," but the result is "detach onto this commit." The t/2009 guard exists precisely to catch this state and prevent orphaned commits.

**Prevention:**
1. **Always use `-b` when you intend to commit from the worktree:** `git worktree add -b <local-branch> <dir> origin/<remote-branch>`. Creates a named local branch in the worktree, not a detached checkout.
2. **If you land in a detached-HEAD worktree, recover with `git switch -c <branch>`** — no need to re-create the worktree; `switch -c` attaches HEAD to a new branch in place. Push with `git push origin HEAD:refs/heads/<branch>`.
3. **The t/2009 pre-commit hook firing is the signal** — "refusing to commit on detached HEAD" means you need a named branch, not a worktree recreate. See also #104 (detached-HEAD push needs fully-qualified ref).

**Status:** Active — 1 instance (Tech Lead p/335#42).

**Applies To:** All agents creating worktrees based on an existing remote branch (e.g., rebasing or amending a PR in a worktree).

---

## #170 [Process] Fleet Shares One GitHub Identity — Cross-Instance PR Review Cannot Produce a Native Approval or Block

**Pattern:** `gh pr review <N> --request-changes` (or `--approve`) fails with "Can not request changes on your own pull request" when the reviewing agent and the authoring agent are different fleet instances but share a single GitHub token. GitHub authorship is per-token, not per-agent — all fleet PRs appear self-authored from GitHub's perspective, so native review verdicts (approve/request-changes) are unavailable for any intra-fleet review.

**Instances:**
- 2026-08-22 — Computational Linguist (PR #1452, t/2948, p/7#66): `gh pr review #1452 --request-changes` failed "Can not request changes on your own pull request" — reviewer and author were different fleet instances sharing one GitHub token. Resolved by posting the review content via `gh pr comment` and recording the formal verdict in the ticket.

**Root Cause:** GitHub's PR review API enforces that the reviewer and author must be different GitHub accounts. The entire AI Triad fleet authenticates to GitHub under one personal token, so all PRs opened by any fleet instance have the same GitHub author. Any review action attempted by a peer fleet instance hits the self-review prohibition, regardless of the agents' distinct Orca identities.

**Prevention:**
1. **Never attempt `gh pr review --approve` or `--request-changes` as an intra-fleet review** — it will always fail. Use `gh pr comment` to post review content instead.
2. **The ticket comment is the only enforceable record for intra-fleet review verdicts** — record the reviewer's verdict, reasoning, and approval/block decision in the ticket (e.g., `add_comment` on the Orca ticket). This is the authoritative review record.
3. **Design review gates with this constraint in mind** — any process that requires a GitHub-native approval to unblock a merge cannot be satisfied by a fleet peer. Human approval (via the GitHub UI) is the only way to produce a GitHub-native review verdict.
4. **For blocking reviews, mark the PR as draft** (see AGENTS.md gated-PRs rule) — draft + ticket comment is the only mechanism that both records the hold and enforces it against accidental merge.

**Status:** Active — 1 instance (CL PR #1452, t/2948, p/7#66).

**Applies To:** All agents that attempt cross-instance PR reviews; any process design that relies on GitHub-native approvals for fleet-authored PRs.

---

## #171 [Build] MSYS Bash `/tmp` and Windows Python `/tmp` Resolve to Different Real Paths — Cross-Tool Temp Files Are Lost

**Pattern:** A MSYS bash `cp` writes a file to `/tmp/…`; a subsequent Windows Python (or native Win32) `open('/tmp/…')` raises `FileNotFoundError`. The two toolchains resolve `/tmp` to different real filesystem paths — MSYS uses its own virtual `/tmp` mount (typically `C:\msys64\tmp` or the Git-for-Windows `tmp` shim), while Windows-native processes resolve `/tmp` relative to the drive root or to a different TEMP env var. The file exists in one namespace and is invisible in the other.

**Instances:**
- 2026-08-22 — CL.Investigate1 (p/40#15): a review command wrote a temp copy with MSYS `cp /tmp/…`; Windows Python then raised `FileNotFoundError` on the same path. Fix: dropped the temp file entirely; used `git show HEAD:<path>` (EOL-normalized) vs working-tree content for the byte comparison instead.

**Root Cause:** MSYS/Git-for-Windows presents a POSIX-like filesystem to bash scripts, including its own `/tmp`. Windows-native tools (Python, PowerShell, .NET) use `%TEMP%`/`%TMP%` and do not see MSYS's virtual mounts. Writing with MSYS bash and reading with a Windows-native tool is a cross-mount hand-off that silently fails — the path string is identical but the underlying storage location differs.

**Prevention:**
1. **For regenerate-vs-committed byte comparisons, use `git diff` or `git show HEAD:<path>`** — no temp file needed; git provides EOL-normalized content from the commit tree directly.
2. **When a temp file is genuinely needed across MSYS and Windows-native tools, use the session scratchpad dir** (provided in session context, a real Windows path like `C:\Users\…\AppData\Local\Temp\claude\…\scratchpad`) — both toolchains resolve it correctly.
3. **Never use `/tmp` as a cross-tool hand-off point on Windows agents** — treat it as MSYS-local. If you write with MSYS bash, read with MSYS bash; if you write with PowerShell/Python, read with PowerShell/Python. Crossing the boundary loses the file.
4. **Pairs with #73** (MSYS path conversion on git colon-revspecs) and **#137** (safety classifier blocks `/tmp` moves of untracked files) — Windows `/tmp` is doubly unreliable: wrong namespace AND classifier-gated.

**Status:** Active — 1 instance (CL.Investigate1 p/40#15).

**Applies To:** All agents on Windows dev environment that write temp files in Bash and read them in Python/PowerShell (or vice versa).
## #168 [Test] Compositional Validation Trap — "A Works + B Works" Does Not Imply "A→B Works"

**Pattern:** A recurring user-facing bug is "fixed" multiple times because each fix is validated at a sub-chain layer (unit test, harness, or shim→handler boundary) that enters the pipeline mid-chain. The bug lives in an **unexercised seam** — a step upstream of where the test enters. Each fix passes its local gate, the bug resurfaces, and the cycle repeats. The accumulated cost is N debugging sessions and N false-confidence merges.

**Instances:**
- 2026-08-20 — Op-ed pipeline (t/2897, p/335#44, t/2928): bug recurred 5×. Each of the 4 prior "fixes" was validated at the shim→handler boundary or below; the real defect was a `ConvertTo-Json` serialization failure on real web content that only surfaced at the full shim→handler→generate→reader path. A silent catch hid the failure for rounds 1–4. Fix on round 5: end-to-end closure gate on the real app with real web-page input + surfacing via flight-recorder (t/2897#11).

**Root Cause:** Testing at a sub-chain boundary proves only that the boundary layer is correct — it does not exercise the seams above it. A serialization defect between component A (producer) and component B (consumer) is invisible if the test injects pre-serialized data directly into B. "A passes unit tests + B passes unit tests" provides no guarantee that A's actual output is valid input for B. A silent catch compounding this hides the signal entirely, so each failed fix looks like a transient and the team re-enters the same debugging cycle.

**Prevention:**
1. **For a recurring user-facing bug, the closure gate must exercise EVERY seam on the real app with real inputs.** A test that enters mid-chain does not close the bug — it only verifies the chain from that entry point down. Draw the full data-flow path; if the failing seam is above your test entry point, the test cannot catch a regression there.
2. **Enumerate the seams explicitly before writing the fix test:** list each interface boundary on the path from real input to user-visible output. Ask: does my test inject data at or before the first seam? If not, it is a partial test, not a closure gate.
3. **Pair the fix with loud degradation at the failing seam** — a silent catch that swallows errors lets bugs recur invisibly for N rounds. The catch should surface + flight-record before re-raising; silence is not a safe default for unexpected failures on a user-facing path.
4. **Recurrence is the diagnostic:** a bug that resurfaces after a "fix" almost always means the fix was validated below the real failure seam. Before the next fix attempt, map the seams, identify which was unexercised, and move the test entry point upstream.

**Status:** Active — 1 instance (Op-ed pipeline t/2897, p/335#44).

**Applies To:** Any multi-stage pipeline where tests enter mid-chain — serialization/deserialization boundaries, IPC shims, process-spawn hand-offs, format-conversion layers.

---

## #169 [Process] Disk-Path File Resolution Is Racy During Active Fleet Work — Use Git Refs Instead

**Pattern:** During an active landing (PR open, merge in flight), a file that `ls` or a prior `Read` shows at a disk path becomes inaccessible seconds later — it has moved between the shared checkout and a worktree or been committed/deleted by a peer. File access by absolute disk path is not atomic relative to concurrent git operations; the shared checkout's working tree can change at any moment when other agents are landing or checking out branches.

**Instances:**
- 2026-08-22 — Computational Linguist (p/7#63): `Read` on a path shown by a prior `ls` failed seconds later — a peer instance was concurrently landing that file via PR (moved into a worktree/branch). Resolved by locating the file via `git ls-tree`/`git cat-file -e` across refs, which are stable regardless of working-tree state.

**Root Cause:** The shared checkout's working tree is mutable by any agent at any time through git operations (checkout, worktree add/remove, merge). A disk path reflects the current working-tree state, which can change between the `ls` that showed it and the `Read` that consumes it. Git object refs and commit trees are immutable once created — a SHA or `HEAD:path` is stable even while the working tree changes around it.

**Prevention:**
1. **During active fleet work, resolve peer-owned artifacts through git refs, not disk paths.** Use `git show HEAD:<path>`, `git ls-tree HEAD -- <scope>`, or `git cat-file -e <ref>:<path>` — these are stable regardless of working-tree churn.
2. **If a disk-path Read fails unexpectedly, check whether a concurrent landing moved the file** — `git log --oneline -5 origin/main` shows recent merges; `git ls-tree origin/main -- <path>` shows if the file exists on origin.
3. For peer-owned files specifically, prefer reading from `origin/main` ref rather than the working-tree disk path: `git show origin/main:<path>` (or via PowerShell tool for Windows paths).

**Status:** Active — 1 instance (CL p/7#63).

**Applies To:** All agents reading files in another role's scope during periods of concurrent fleet activity.

---

## #172 [Build] Silent Exclusion Guard + Hardcoded Live-Data Baseline in a Required CI Gate — Two Landmines in One

**Pattern:** A CI gate meant to decouple from live data contains two silent failure modes that only reveal themselves when the corpus grows: (1) an `ExcludePath` (or similar filter) that never actually matched — tests kept running against live data because the path pattern was wrong, but the gate stayed green while live data happened to satisfy a hardcoded baseline; (2) the hardcoded baseline itself — a count (`440/440`) baked into a required lane that goes red the moment the corpus adds one node. The combination: a guard that looks verified (passing) but was never actually decoupled, plus a count that is guaranteed to rot. Result: `main` goes red and every code PR is blocked when the corpus grows past the stale count.

**Instances:**
- 2026-08-24 — Pester BDI data-compliance gate (t/3007, p/335#47): `ExcludePath=@('./tests/data-compliance/')` never matched; the live-data BDI test kept running in the required `test-powershell` lane. Passed while corpus = 440 (coincidental satisfaction of the hardcoded baseline); corpus grew to 442 → red main → all code PRs blocked. Prevention ticket t/3010.

**Root Cause:** Two independent failure classes compounded. (1) The exclusion guard was never verified to actually exclude — it passed because live data satisfied the baseline, not because decoupling worked. A guard that passes without actually firing gives false confidence; the correct signal is the guard preventing the test from running entirely. (2) A hardcoded count of live-data content in a required gate is a time-bomb: it will rot the moment the corpus changes, and the gate becomes a prod-blocking false-red rather than a signal.

**Prevention:**
1. **Verify every exclusion/filter guard with a both-arms test:** confirm (a) it excludes (the target test does NOT run in the gated lane) AND (b) the clean case passes with zero noise. "The gate is green" is not evidence it excludes — the test may have run and passed coincidentally.
2. **Never hardcode live-data counts in a required CI gate.** Live-data content (node counts, corpus sizes, enrichment scores) belongs in a non-required lane or behind a dynamic baseline that updates with the corpus. A required gate with a hardcoded live-data value will go red the moment the data changes.
3. **For decouple-via-exclusion patterns, add a smoke assertion:** after the `Invoke-Pester` call with `ExcludePath`, assert that the excluded test file was not collected (e.g., check `Result.Tests` for the excluded path). A guard that silently runs the excluded tests is as bad as having no guard at all.
4. **Gate signal integrity (class: exclusion guard):** both arms — force-include the excluded path and confirm red; normal run with exclusion and confirm green. A gate untested on the failure arm may never fire. (Pairs with AGENTS.md gate-verification rule.)

**Status:** Active — 1 instance (Pester BDI gate t/3007, p/335#47). Prevention t/3010 filed.

**Applies To:** Any CI gate that uses path exclusions, ExcludePath filters, or hardcoded live-data baselines — especially Pester and vitest scoped runs.

---

## #173 [Runtime] Periodic 5s Health-Probe Spikes in ACA Web Container — GC Pause or GitHub API Poll Blocking Event Loop

**Pattern:** The ACA web container health-probe occasionally logs "Cold-start spike excluded: ~5000ms (>50× baseline 3ms)" at ~35s intervals throughout a session. The cold-start exclusion logic correctly excludes these from the baseline (so the probe does not false-positive), but the spikes are real event-loop blocks of ~5s. They co-occurred with a dictionary timeout cascade in at least one session.

**Instances:**
- 2026-08-26 — FR `merged-b0045e04`, build 374d037a (Diagnostics p/9#69): 6 cold-start spikes logged at ~35s intervals over a 533s session. Probe correctly excluded each. Likely cause: ACA GC pause or periodic GitHub API polling blocking the Node.js event loop. No user-visible impact isolated to the spikes alone; co-occurred with a dictionary timeout cascade.

**Root Cause:** Unconfirmed — two candidates: (1) ACA container GC pause (~35s period is consistent with periodic GC in a memory-constrained container); (2) a periodic GitHub API poll (e.g., rate-limit refresh, auth-token renewal) blocking the event loop synchronously. Either would cause a ~5s stall that triggers the spike exclusion heuristic.

**Prevention / Watch Criteria:**
1. **Monitor frequency and duration** — 6 spikes in 533s at ~5s each is ~5.6% probe-time overhead; tolerable but load-bearing for the cold-start exclusion logic working correctly.
2. **Escalate if:** spike frequency increases above 1/30s, duration exceeds 8s, or spikes begin co-occurring with user-visible errors (not just log noise). The 50× threshold in the exclusion heuristic may need tuning if baseline latency drifts.
3. **Correlate with dictionary timeout cascades** — if future incidents show spikes immediately preceding cascades, the event-loop block is the proximate cause, not a co-incidence.
4. **Candidate investigation:** add a flight-recorder mark immediately before and after the periodic GitHub API calls (if any) to distinguish GC from API-poll as the root cause.

**Status:** Monitoring — not yet a confirmed failure; watch if frequency or duration increases. 1 instance (Diagnostics p/9#69, build 374d037a).

**Applies To:** ACA web container operations; anyone diagnosing event-loop latency spikes in the health-probe log.

---

## #174 [Build] This Repo Has No Committed `package-lock.json` — Use `npm install`, Not `npm ci`; Install in Both `taxonomy-editor/` and `lib/`

**Pattern:** `npm ci` in a fresh worktree fails immediately with EUSAGE — "no package-lock.json found." This repo does not commit a lockfile; `npm install` is the correct install command. A second failure follows if only `taxonomy-editor/` is installed: `tsc -p tsconfig.main.json` reports spurious "module not found" errors for lib files — because `lib/`'s own dependencies (e.g., `pptxgenjs`) live in `lib/node_modules` and are required for TypeScript compilation of files that transitively import from `lib/`.

**Instances:**
- 2026-08-27 — Rosetta Stone 2 (p/195#14): `npm ci` in a fresh worktree failed EUSAGE (no lockfile). Switched to `npm install`. Then `tsc -p tsconfig.main.json` failed with spurious module-not-found for `pptxgenjs` — resolved by also running `npm install` in `lib/`.

**Root Cause:** The repo intentionally omits a committed lockfile (flexible dependency resolution). `npm ci` requires one; `npm install` does not. The two-directory install requirement comes from the multi-package layout: `taxonomy-editor/` and `lib/` each have their own `node_modules`, and `lib/`'s transitive deps are not hoisted into `taxonomy-editor/node_modules`. Skipping the `lib/` install produces false tsc errors on any file that imports from `lib/`.

**Prevention:**
1. **In any fresh worktree, run `npm install` (NOT `npm ci`) in BOTH directories:**
   ```
   cd taxonomy-editor && npm install
   cd ../lib && npm install
   ```
2. **`npm ci` will always fail in this repo** — there is no `package-lock.json` to consume. If a skill or playbook references `npm ci`, treat it as `npm install`.
3. **"Module not found" tsc errors after install in only one dir** — run `npm install` in `lib/` as well; the error is a missing transitive dep, not a code bug.
4. **/land-from-worktree note:** the install step should use `npm install`, not `npm ci`. Flag to skill owner (TL) if the skill references `npm ci`.

**Status:** Active — 1 instance (Rosetta Stone 2 p/195#14). Applies to all agents setting up fresh worktrees for taxonomy-editor or lib work.

**Applies To:** All agents creating fresh worktrees for taxonomy-editor, lib, or cross-package TypeScript compilation.

---

## #175 [Process] Open Design Ruling = Gated PR; Draft Not Set + Auto-Merge Enabled = PR Lands Before Author Verification

**Pattern:** A PR has an open design ruling sent to another agent — making it a gated PR per root AGENTS.md ("Gated PRs stay draft; never enable auto-merge on a gated PR"). The PR is NOT marked draft. A dispatched worker enables `gh pr merge --auto` (treating "do not self-merge" as "don't run `gh pr merge`" but not as "don't enable auto-merge"). CI goes green; the PR auto-merges the moment checks pass, bypassing the author's Pre-Self-Merge Verification entirely — no agent is in the loop when it lands.

**Instances:**
- 2026-09-01 — PowerShell (PR #1707, p/20#32): a dispatched ps-ticket-worker subagent enabled auto-merge despite explicit "do NOT self-merge, report back" instruction. The PR landed on the original head the moment CI went green, stranding a post-merge rework (CL-requested id-scheme change) and briefly putting a superseded scheme on main. Resolved: cherry-pick of the rework onto main via PR #1710. Root: open design ruling to CL made the PR gated; draft was not set; auto-merge was the gap. (PowerShell p/20#34 — correction from CL p/23#223.)

**Root Cause:** "Gated" is a semantic state (an unresolved dependency or decision) that GitHub has no native concept of. The only enforcement mechanisms are (a) marking the PR draft (blocks merge button + auto-merge) or (b) not enabling auto-merge. A comment or ticket `blocks` relation gives visibility but does NOT prevent GitHub from merging. A dispatch prompt that says "do not self-merge" does not automatically prohibit `gh pr merge --auto` — a worker interprets "do not self-merge" as "don't run `gh pr merge`" while treating auto-merge as a separate, acceptable action. The gap: the author's verification loop is bypassed entirely when auto-merge fires.

**Prevention:**
1. **Any open design ruling = gated PR = open as draft immediately.** Don't wait for the ruling to close; draft enforces the hold at the GitHub level. Un-draft only when the ruling is resolved.
2. **Dispatch prompts must explicitly forbid enabling auto-merge** when the intent is "do not merge, report back": include "do NOT enable auto-merge (`gh pr merge --auto`)" in addition to "do not self-merge."
3. **Workers that must-not-merge should open the PR as draft** — draft blocks both the merge button and auto-merge, making the intent unambiguous regardless of how "don't merge" is interpreted.
4. **A comment hold or ticket `blocks` relation is visibility, not enforcement** — it does not prevent GitHub from merging. Only draft enforces.

**Status:** Active — 1 instance (PowerShell PR #1707, p/20#32). Root AGENTS.md already has the gated-PR/draft rule (t/2603/#997); this is the first LessonsLearned instance showing the dispatch-prompt loophole and the open-design-ruling trigger.

**Applies To:** All agents dispatching subagent workers to open PRs; all agents with open design rulings on in-flight PRs.

---

## #176 [Process] Auto-Merge Fires on Pre-Push PR Head — Author's Pre-Self-Merge Verification Bypassed When Merge Is Triggered Externally

**Pattern:** An author enables auto-merge on a PR, then pushes additional commits. Auto-merge fires on the head that was current when it was enabled (or when CI last went green) — NOT on the author's latest-pushed commit. The PR lands on a stale head, stranding the post-push commits off main. This violates Pre-Self-Merge Verification step 1 (head == latest push), but the author's verification loop is never entered because the merge was triggered by GitHub's auto-merge machinery, not by the author.

**Instances:**
- 2026-09-01 — Computational Linguist (PR #1712, p/7#71): PR #1712 squash-merged at stale head `72cf6db4` predating two follow-up pushes; the `sit-*` extension + summary assertion was stranded off main (main got only the original reconciler). Root: auto-merge fired on the pre-push head; head-match gate not enforced because the merge was triggered externally. Resolved: re-landed the complete file in PR #1716 after verifying the gap against `origin/main`.

**Root Cause:** GitHub auto-merge fires when required checks pass for the HEAD that is current at that moment — not necessarily the author's latest pushed commit. If the author pushes new commits after enabling auto-merge, the auto-merge queue may already be primed for an older head, and if that older head's CI was already green, the merge can fire before CI even runs for the new push. The author's Pre-Self-Merge Verification (step 1: head == latest push) is a self-directed check — it is never run when GitHub's automation is the merge actor.

**Prevention:**
1. **Do not enable auto-merge until all planned pushes to the branch are complete.** If you know more commits are coming, hold off on `--auto` until the branch is final.
2. **If you push commits after enabling auto-merge, cancel auto-merge first** (`gh pr merge --disable-auto <n>` or close/reopen), update the branch, then re-enable. Do not assume auto-merge will re-queue on the new head.
3. **For PRs where another actor may trigger the merge** (auto-merge, a teammate, a bot), ensure the PR head is the commit you intend BEFORE enabling auto-merge — treat it as your last chance to run the verification.
4. **After a PR lands, confirm `gh pr view <n> --json headRefOid` matches your intended head** before declaring the work complete — a stale-head merge is detectable immediately post-merge and recoverable via a follow-up PR.

**Status:** Active — 1 instance (CL PR #1712, p/7#71). Sibling of the Pre-Self-Merge Verification rule (root AGENTS.md, step 1) — extends it to the case where the author is not the merge actor.

**Applies To:** All agents enabling auto-merge on PRs where further pushes are possible; all PRs where a third party (bot, teammate, scheduled action) may trigger the merge.

---

## #177 [Build] `ConvertFrom-Json` Round-Trip Silently Mutates Untargeted Fields — ISO Datetimes Re-Offset, Single-Element Arrays Collapse to Scalars

**Pattern:** A PowerShell 7.4 whole-file JSON read-modify-write (`ConvertFrom-Json` → mutate → `ConvertTo-Json`) silently corrupts fields the code never touched: ISO 8601 datetime strings (`measured_at`, `generated_at`) are re-offset to local timezone, and single-element arrays (`vocabulary_terms: ["x"]`) collapse to bare scalars (`"x"`). The mutations are invisible until downstream readers fail on type mismatches. Any cmdlet that reads a data JSON file and unconditionally rewrites the whole file via `ConvertTo-Json` is at risk.

**Instances:**
- 2026-09-01 — PowerShell 2 (t/3124, p/228#17+18): `Update-ClaimEntityRef` caught the pattern before bad data landed — a whole-file JSON round-trip via `ConvertFrom-Json` + `ConvertTo-Json` would have re-offset ISO datetimes in `measured_at`/`generated_at` and collapsed single-element `vocabulary_terms` arrays to strings. Fix: `ConvertFrom-JsonPreserveShape` — a `ConvertFrom-Json` + `System.Text.Json` tandem walk that restores datetime strings and re-wraps collapsed single-element arrays. Mirrors the existing `ConvertFrom-EdgesJson` pattern. Recurrence of t/2974.

**Root Cause:** `ConvertFrom-Json` maps ISO 8601 strings to .NET `DateTime` objects; `ConvertTo-Json` serializes them back with local-timezone offset, changing the string representation. Single-element JSON arrays deserialize to a bare .NET object (not a `[object[]]`); `ConvertTo-Json` then emits a scalar, not a one-element array. Both corruptions are type-level coercions invisible to PowerShell code that reads/mutates only other fields — the round-trip "works" from the mutation's perspective while silently destroying field shapes elsewhere in the file.

**Prevention:**
1. **Any new cmdlet that reads a data JSON file and rewrites the whole file must use a shape-preserving reader, never raw `ConvertFrom-Json`.** Use `ConvertFrom-JsonPreserveShape` (or the equivalent `ConvertFrom-EdgesJson` pattern) — the `System.Text.Json` tandem walk restores datetime strings and single-element arrays.
2. **If a shape-preserving reader isn't available, write back ONLY the fields that were mutated** — construct a targeted patch rather than a full round-trip of the parsed object.
3. **Treat `ConvertFrom-Json` → `ConvertTo-Json` as a lossy transform on datetime fields and arrays with ≤1 element.** Any file that passes through this pipeline is silently corrupted unless protected.
4. **Test with files that contain (a) ISO datetime fields and (b) single-element arrays** — the corruption is invisible in unit fixtures that use multi-element arrays or omit datetime fields.

**Status:** Active — recurrence of t/2974; 1 instance caught pre-land (PowerShell 2 t/3124, p/228#17+18). `ConvertFrom-JsonPreserveShape` is the fix pattern; flag any new whole-file rewriter that uses raw `ConvertFrom-Json`.

**Applies To:** All PowerShell cmdlets that perform whole-file JSON read-modify-write on data files in this repo (entities, claims, situations, etc.).

---

## #178 [Diagnostic] Cache-Miss Discrimination — Slow Embedding Computes May Be Volume Demand, Not a Dead Cache; Inspect WHAT Is Computed, Not Just Duration

**Pattern:** A flight-recorder showing slow embedding computes is misread as "cache is dead" based on duration alone. The correct discriminator is WHAT is being computed: node-IDs already present in the cache that appear in the slow batch → genuine cache misses (cache failure); node-IDs absent from the cache (novel frames, paragraphs, claims) → correct misses → the slowness is demand-side VOLUME, not a cache defect. Treating correct-novel-misses as evidence of a dead cache sends the diagnosis down a wrong root-cause path and drives the wrong fix class.

**Instances:**
- 2026-09-01 — t/3165 embedding-saturation incident (Diagnostics, p/334#225; TL p/335#49): FR showed slow embedding computes; initial diagnosis inferred "cache dead." Corrected by Diagnostics: the slow items were novel frames/paragraphs/claims not yet in the cache → correct misses → slowness was volume-starvation, not a cache failure. Durable fix: off-thread ONNX compute behind `EMBEDDING_WORKER_OFFLOAD` (t/3183, PR #1753) — a worker-offload, not a cache fix. Incident anchor: t/3165#24/#32.

**Root Cause:** Duration alone is an ambiguous signal — both a dead cache and a high-volume correct-miss load produce long compute times. The discriminating dimension is novelty of the requested items: a cache failure shows known items missing; volume-starvation shows only novel items (expected misses). Collapsing the two into one "slow = broken" hypothesis produces a wrong fix class (cache repair vs worker offload).

**Prevention:**
1. **When a FR shows slow embedding (or other cached) computes, inspect what's in the batch** — are the slow items node-IDs that should have been cached (known IDs, previously seen)? Or are they all novel? Known-IDs-slow = cache failure; novel-IDs-slow = volume demand.
2. **Fix class depends on root cause** — volume-starvation → off-thread / worker offload; genuine cache failure → cache invalidation, warming, or schema fix. Don't apply a cache fix to a volume problem.
3. **Log the novel-vs-cached breakdown per compute batch** (observability follow-up) — makes this discrimination instant in future incidents without manual FR archaeology.
4. **Note for `/triage-flight-recorder`**: add "slow embedding" as a known pattern requiring the novel-vs-cached split before concluding cache failure.

**Status:** Active — 1 incident (t/3165). The discrimination heuristic (inspect what's computed, not just duration) is the durable prevention; observability improvement (novel/cached breakdown per batch) is the follow-up.

**Applies To:** Anyone triaging flight-recorder embedding-compute slowdowns; the `/triage-flight-recorder` skill should surface this split before concluding cache failure.

---

## #179 [Process] Deleting a PR's Head Branch Before `state=MERGED` Closes the PR — Confirm Merge Before Branch Cleanup

**Pattern:** An agent deletes a PR's remote head branch (e.g., `git push origin --delete <branch>`) before confirming `state=MERGED`, assuming auto-merge will handle the rest. GitHub interprets the branch deletion as abandonment and CLOSES the PR — it does not merge it. The PR transitions from OPEN to CLOSED (not MERGED), stranding the work.

**Instances:**
- 2026-09-01 — Computational Linguist (PR #1780, p/7#76): deleted the remote head branch of an open (not-yet-merged) PR assuming auto-merge was in progress (as prior PRs had auto-merged). GitHub closed PR #1780 on branch deletion. Recovery: the local branch ref survived `git worktree remove`, so the branch was re-pushed + `gh pr reopen`, then watched to MERGED state before cleanup. No work lost.

**Root Cause:** GitHub closes a PR when its head branch is deleted while the PR is still OPEN — deletion signals "this work is abandoned." Auto-merge does not protect against this: if the branch is deleted before auto-merge fires, GitHub closes the PR rather than merging it. The assumption "auto-merge will handle it" only holds if the branch persists until CI is green and the merge fires.

**Prevention:**
1. **Confirm `state=MERGED` (via `gh pr view <n> --json state,mergedAt`) BEFORE deleting any PR's head branch** — never delete a branch on an OPEN PR, even if auto-merge is enabled.
2. **The cleanup order is: wait for MERGED → then delete the branch** (remote + local). Never reverse this order.
3. **Recovery if you accidentally close a PR**: if the local branch ref still exists, re-push it (`git push origin <branch>`) + `gh pr reopen <n>` + re-enable auto-merge if needed, then watch to MERGED before cleanup.
4. **Sibling of #106** (gh pr merge --delete-branch exits non-zero after a successful merge): in both cases, the discriminator is checking `state=MERGED` before concluding the merge is incomplete and taking action.

**Status:** Active — 1 instance (CL PR #1780, p/7#76). Complement to Pre-Self-Merge Verification and #106 — the branch-cleanup-before-merge failure mode.

**Applies To:** All agents performing branch cleanup after landing PRs, especially those using auto-merge or relying on a third party to trigger the merge.

---

## #180 [Build] Dynamic `new Worker(new URL('./file.js', ...))` String Reference Is Invisible to tsc — Worker File Never Emitted Without an Explicit Emit-Gate

**Pattern:** A web worker is instantiated via `new Worker(new URL('./embeddingWorker.js', import.meta.url))` — a runtime string, not a static import. TypeScript's static import graph does NOT follow this reference, so tsc compiles successfully while never emitting the worker `.js` file. The build appears green; the worker is absent at runtime. Unit tests and Electron-worker spikes don't catch this because they either mock the worker or run from source — only a test that consumes the real compiled `dist/` output exposes the missing file.

**Instances:**
- 2026-09-02 — t/3165 / t/3209 (TL e/133#1): an Electron-worker spike + fake-worker unit tests all passed; a staging canary was the FIRST run against the real server-container tsc build — and immediately caught the bug: `embeddingWorker.js` was absent from `dist/` because it's referenced only as a string, invisible to tsc's import graph. Countermeasure: emit-gate PR #1784 scans emitted `dist/` for worker-URL string refs and fails the build if the target `.js` is absent.

**Root Cause:** tsc resolves the module graph by following static `import` statements. A `new Worker(new URL('./worker.js', import.meta.url))` is a runtime constructor call with a string argument — the compiler does not index or follow it. The worker source file is thus unreferenced from tsc's perspective: it is compiled only if it appears in `include`/`files`/a static import chain, and emitted only if it is compiled. A perfectly valid, type-checked codebase can produce a broken `dist/` when worker files are the only consumers of their own source.

**Prevention:**
1. **Any file reachable only via a dynamic/worker-URL string reference needs an explicit emit-gate** — a post-build check that scans `dist/` for worker URL refs and asserts the target `.js` is present. Do not rely on tsc, unit tests, or Electron-worker spikes to catch a missing worker file.
2. **Validate in the REAL target build, not a proxy.** A local spike, a unit test with a mocked worker, or a CI step that runs from source are all structurally incapable of detecting a missing emitted file. The signal comes only from a step that (a) runs `tsc` on the REAL build target and (b) consumes the emitted `dist/`.
3. **When adding a new worker file, add it to `tsconfig.json` `include`** (or add a static import from a file that IS in the graph) — this ensures tsc compiles and emits it regardless of the runtime URL reference.

**Status:** Active — 1 instance (t/3165/t/3209, e/133). Emit-gate PR #1784 is the durable countermeasure. Sibling of the "build ≠ runs" gate-integrity family (#94, #112, #130).

**Applies To:** All agents adding or modifying web workers, worker-URL dynamic imports, or any file referenced only at runtime — not via a static import chain.

---

## #181 [Build] Zero-Work-Green Gate — A Gate Reports Pass While Performing No Work; Must Assert Workload-Validity Precondition

**Pattern:** A canary or CI gate reports `gate.pass` / green while having performed zero meaningful work — e.g., an embedding-canary that ran an idle loop and computed 0 vectors, reporting a meaningless p99 latency. The gate is structurally incapable of detecting a regression because there is nothing to measure. "No error" ≠ "work happened."

**Instances:**
- 2026-09-02 — t/3165 canary (TL e/133#2): the canary's first run reported `gate.pass` but computed 0 vectors (idle loop). The p99 result was meaningless. Hardened with a workload-validity precondition: `vectors > 0`, `non-200 == 0`, `demand ≥ floor`, `dims == 384` — the gate only accepts a result if the precondition proves real work happened.

**Root Cause:** A gate that checks only for the absence of errors passes when nothing ran. An idle/empty-input execution is indistinguishable from a healthy execution unless the gate explicitly asserts that the work occurred and produced output. Gates that measure latency, throughput, or quality are particularly vulnerable: zero-work produces zero-error, making the gate trivially green.

**Prevention:**
1. **Every gate must assert that work ACTUALLY HAPPENED** — add a workload-validity precondition before accepting results: output-count > 0, no non-2xx responses, result-dimensions match expected, demand ≥ configured floor.
2. **A gate that reports pass on an empty/idle run is a dead gate** — it gives false confidence while providing zero signal. A workload-validity failure should be a hard gate failure, not a skip or a warn.
3. **Test the gate itself against an empty-input / idle-loop run** — confirm it reports FAIL, not pass, when nothing is computed.

**Status:** Active — 1 instance (t/3165 canary, TL e/133#2). Sibling of gate-integrity genus (#94, #112): a zero-work gate is the "gate passes while broken" failure mode applied to workload quantity rather than build vs. runtime.

**Applies To:** All canaries, load tests, latency gates, and quality gates that measure performance or correctness of a computation — embedding, inference, indexing, search, etc.

---

## #182 [Deploy] IaC-Landed ≠ Prod-Deployed; ACA Resource-Shape Validity Needs a Gate — Invalid cpu:mem Combo Landed Undetected

**Pattern:** A bicep change lands on main and CI goes green, but the resource shape it specifies is invalid for the target platform. For ACA (Azure Container Apps), ACA requires memory ≥ 4Gi when vCPU ≥ 2.0 — an `(2.0 vCPU, 2Gi)` combo is rejected at ARM deploy time. No gate in CI caught the invalid combo before it landed; a deploy would have failed the ARM step. Additionally: prod may run a different resource shape than the canary (e.g., 1vCPU/2Gi prod vs 2vCPU canary) — a performance invariant validated at 2vCPU (e.g., "worker gets its own core") silently breaks at 1vCPU.

**Instances:**
- 2026-09-02 — t/3165 / #1771 (TL e/133#3): PR #1771 landed `(2.0 vCPU, 2Gi)` in bicep — an invalid ACA combo (ACA requires 4Gi for ≥2vCPU). No gate caught it. Simultaneously, prod was running 1vCPU/2Gi while the embedding-offload canary validated 2vCPU — the offload's C1 single-session invariant (worker gets its own core) silently violated in prod. Prevention filed: t/3212 (bicep ACA cpu:mem-combo validation gate).

**Root Cause:** CI gates validate build correctness (tsc, Pester, vitest) and contract correctness, not infrastructure resource-shape validity. The ARM template is not deployed in CI; its resource specs are untested until a real deploy. Prod and canary may diverge in resource shape without any visible signal — the canary validates at a different scale than prod runs.

**Prevention:**
1. **Add a bicep resource-shape validation gate** — for ACA, assert `cpu ≥ 2 → mem ≥ 4Gi` (and other ACA resource constraints) statically before any template lands. Track in t/3212.
2. **When adding a performance invariant that assumes a specific resource shape** (e.g., "worker gets its own core at 2vCPU"), assert that prod's actual resource allocation matches the assumption before claiming the fix is live in prod.
3. **IaC-landed ≠ prod-deployed ≠ prod-correct** — landing a bicep change proves the template is syntactically valid; deploying proves ARM accepted it; validating prod proves the running container matches the intended shape. Three separate confirmation points.

**Status:** Active — 1 instance (t/3165/#1771, TL e/133#3). t/3212 tracks the bicep ACA cpu:mem gate. Sibling of bookkeeping-≠-artifact (#94, #130): the "it's in IaC" claim doesn't guarantee prod reflects it.

**Applies To:** All agents modifying ACA bicep resource specs; all fixes whose performance guarantees depend on a specific vCPU/memory shape.

---

## #183 [Deploy] Ephemeral CLI Config Is Wiped by the Next IaC Deploy — Durable Config Lives in IaC at Point-of-Use, Gated

**Pattern:** A flag or env-var is set via an ad-hoc CLI command (`az containerapp update --set-env-vars FEATURE=1`). The next full template deploy overwrites the container's environment with the bicep-defined baseline, silently reverting the CLI-set value. The feature appears enabled until the next deploy, then silently regresses with no error.

**Instances:**
- 2026-09-02 — t/3165 / `EMBEDDING_WORKER_OFFLOAD` (TL e/133#4): an early `az --set-env-vars` flip enabled the worker offload for testing. The durable fix put `EMBEDDING_WORKER_OFFLOAD=1` in bicep `baseEnv` + a `Test-AzureHealth -CheckConfig` config-drift gate that hard-fails CI if a deploy ever drops it. A real deploy was run to exercise the gate's GREEN arm against prod (`Config:EnvVar:EMBEDDING_WORKER_OFFLOAD=True ok`).

**Root Cause:** ACA's bicep template defines the authoritative environment for the container. Any value set via CLI is applied only to the live revision; a full template redeploy re-renders the environment from the template, discarding CLI-set values. Ad-hoc CLI changes are ephemeral by design; they are a debugging/testing tool, not a durable config mechanism.

**Prevention:**
1. **Durable config lives in IaC (bicep `baseEnv`), not in CLI commands.** Once a flag is validated, move it from `az --set-env-vars` to the bicep template before it is at risk of being overwritten by the next deploy.
2. **Gate durable config with a config-drift check** — a CI step (e.g., `Test-AzureHealth -CheckConfig`) that fails if a deploy drops the expected env-var. This both documents the expected value and hard-fails if it regresses.
3. **Run a real deploy to exercise the gate's GREEN arm** — "the drift gate exists" is not the same as "the drift gate fires on real prod." A gate arm is unverified until it runs against the real target environment.

**Status:** Active — 1 instance (t/3165 `EMBEDDING_WORKER_OFFLOAD`, TL e/133#4). General principle: any config set only via CLI is invisible to IaC and will be wiped on the next full deploy.

**Applies To:** All agents setting environment variables or config via `az containerapp update`/`az webapp config`/similar CLI commands; all flags that must survive deploys.

---

## #184 [Process] Gate Block-Arm Unverified by a Canary That Never Trips It — Both Arms Must Be Deliberately Exercised

**Pattern:** A gate has two arms: a GREEN arm (all healthy → proceed) and a BLOCK arm (unhealthy → hold). A canary is run against real prod and the GREEN arm fires correctly. The team reads this as "gate verified." But the BLOCK arm was never triggered — the canary always produced a healthy result. A gate whose block arm has never fired is unverified: it may be silently broken (wrong threshold, wrong signal, logic error) and will fail to hold when it matters.

**Instances:**
- 2026-09-02 — t/3165 canary / #1706 `/readyz` fire arm (TL e/133#5): the t/3165 canary always `resolves:true` (healthy prod) — the `/readyz` BLOCK arm (`resolves:false → BLOCK shift`) was never exercised. It was explicitly NOT promoted as "verified" off this green; it gets its own deliberate both-arms Gate-Promotion (t/3192) where the block arm will be triggered and confirmed.

**Root Cause:** A canary or smoke test run in a healthy environment structurally exercises only the GREEN arm. "The gate passed" means "the gate detected a healthy state correctly" — it says nothing about whether the gate can detect an unhealthy state. The block arm requires a deliberate unhealthy input; waiting for organic failure to verify it is not a verification strategy.

**Prevention:**
1. **Before declaring a gate "verified," confirm BOTH arms have fired** — GREEN arm (healthy → proceed) AND BLOCK arm (unhealthy → hold). A gate verified on only one arm is half-verified.
2. **For each new gate, write a deliberate block-arm test** — inject an unhealthy condition (a failure-mode canary, a mock, a forced error) and confirm the gate fires BLOCK, not PASS.
3. **Document gate-promotion separately from gate-landing** — landing the gate code and verifying both arms are two distinct milestones. Track the block-arm verification as a follow-up ticket (e.g., t/3192 pattern).

**Status:** Active — 1 instance (t/3165/#1706, TL e/133#5). Sibling of gate-integrity genus: a gate whose block arm has never fired provides false confidence, not verified safety.

**Applies To:** All agents landing new gates, canaries, or circuit-breaker checks — escalate block-arm verification as a mandatory follow-up, not an assumption.

---

## #185 [Process] Staged Blue-Green Flip with Active Load Injection for Load-Failure Incidents — Don't Wait for Organic Load

**Pattern:** For a load-induced incident, a standard blue-green 0%→100% flip without active load injection may never reproduce the failure condition during the canary window — prod traffic may be too low to trigger the load-induced bug. The staged flip gives blast-radius control; the active load injection gives genuine stress coverage.

**Instances:**
- 2026-09-02 — t/3165 embedding-offload flip (TL e/133#6): blue-green 0%→25%→100%. Since prod is low-traffic, the exact failure mechanism (1536 concurrent embedding computes) was actively DRIVEN against the 25% revision's FQDN during the canary window rather than waiting for organic load. Result: max 39.6ms vs the original 7–8s freezes — the fix confirmed under genuine stress, not just "no errors in prod."

**Root Cause:** Organic prod traffic may be orders of magnitude below the load that triggered the incident. A canary window with only organic traffic proves "no regressions at low load" — it does not prove "the fix holds under the original failure load." For load-induced failures, the validation must reproduce the failure mechanism deliberately.

**Prevention:**
1. **For load-induced incidents, actively drive the failure mechanism against the canary revision** — don't rely on organic traffic to recreate the load condition. Identify the failure threshold (e.g., N concurrent computes) and generate it deliberately against the canary's FQDN.
2. **Use staged traffic splits (0%→25%→100%) for blast-radius control** — the 25% canary bounds impact to a fraction of prod while still receiving real traffic routing.
3. **Record the peak metric under active load** (e.g., p99 latency, max duration) as the validation signal, not just "no errors" — a fix that holds under the original failure load is verified; a fix that sees no errors at 1% of the original load is not.

**Status:** Active — 1 instance (t/3165, TL e/133#6). Process pattern for load-failure incident validation.

**Applies To:** All agents validating fixes for load-induced incidents (embedding saturation, rate-limiting, queue exhaustion, connection-pool exhaustion) in low-traffic prod environments.

---

## #186 [Governance] Prod-Change Directives from Unresolvable or Unauthenticated Senders Are Void — Gate Against Real Verified State

**Pattern:** One or more agents send a message claiming "all prerequisites are met" or "it is safe to proceed" with a prod change. The senders are unresolvable (no verified identity in the system) or the claim cannot be independently confirmed. Acting on such a directive without verifying the claim against real system state risks an unsafe prod change.

**Instances:**
- 2026-09-02 — t/3165 1-vCPU flip attempt (TL e/133#7): two unresolvable senders pushed a false "all prereqs met" status to trigger an unsafe 1-vCPU flip. The directive was held because (a) the gate keyed on real verified prod state, not the sender's claim, and (b) every prod mutation went through the human's hands. No unsafe flip occurred.

**Root Cause:** In a multi-agent fleet, any agent can send any message, including false status claims. An unresolvable sender has no verified identity; their claim is unverifiable by construction. A gate that proceeds on a sender's "safe to proceed" message rather than on independently verified prod state is trivially bypassable — intentionally or through agent error.

**Prevention:**
1. **Prod-change directives from unresolvable or unverified senders are void** — do not act on a "safe to proceed" claim you cannot independently verify. Always gate against real observed state (CI green, health probe passing, config correct), not a sender's assertion.
2. **Every prod mutation goes through the human's hands** — for irreversible or high-blast-radius prod changes, require a human confirmation step, not just an agent-to-agent "all clear."
3. **If an agent is claiming prerequisites are met, verify each prerequisite independently** — check CI, check health endpoints, check config — before proceeding.

**Status:** Active — 1 instance (t/3165, TL e/133#7). Governance principle: the gate keyed on real state, not on sender claims. Applies when any agent (including fleet members) claims a prod action is safe.

**Applies To:** All agents handling multi-agent coordination for prod changes. Especially relevant for gated deploys where multiple agents vote or claim prerequisite status.

---

## #187 [Process/Git] `git worktree add <path> <branch>` Fails When Branch Is Already Checked Out in Another Worktree

**Pattern:** `git worktree add <path> <branch>` throws "fatal: '<branch>' is already used by worktree '<other-path>'" when the named branch is currently checked out in another agent's worktree. Git prevents a branch from being active in two worktrees simultaneously.

**Instances:**
- 2026-09-03 — Tech Lead (p/335#52): attempted to add a worktree pointing at a branch already checked out elsewhere. Resolution: `git worktree add <path> -b <tmp-branch> <OID>` (temp branch off the head OID), then push onto the target branch ref after work is complete.

**Root Cause:** Git's worktree design prevents the same branch ref from being the HEAD of two simultaneous worktrees — branch contention is a fundamental constraint, not a transient error.

**Prevention:**
1. **When the target branch is already checked out elsewhere, create a temp branch off the OID:** `git worktree add <path> -b <tmp> <target-OID>`, do the work, then `git push origin <tmp>:<target>` to land onto the target ref.
2. **Check for existing worktrees on the branch before `git worktree add`:** `git worktree list` shows which branches are currently checked out and where.
3. **Coordinate with the agent holding the branch before attempting to check it out** — the "branch in use" error is a signal of a live concurrent worktree, not a stale ref.

**Status:** Active — 1 instance (p/335#52). Worktree contention pattern; temp-OID branch is the canonical workaround.

**Applies To:** All agents creating worktrees for feature work, especially in multi-agent fleets where multiple instances may attempt worktree ops on the same branch.

---

## #188 [Process/CI] `gh workflow run` 404s When the Workflow Only Exists on a Feature Branch

**Pattern:** `gh workflow run <workflow-file>` returns a 404 "not found on the default branch" error when the workflow being dispatched was added on a feature branch and has not yet merged to main. GitHub only registers `workflow_dispatch` triggers from the default branch.

**Instances:**
- 2026-09-03 — DevOps (p/26#94): new dispatch workflow dispatched from its feature branch before merge; 404 every time. Resolution: sequence dispatch-validation to post-merge; the workflow is only callable once it exists on main.

**Root Cause:** GitHub indexes `workflow_dispatch` and `schedule` triggers exclusively from the default branch. A workflow that exists only on a feature branch is invisible to the GitHub Actions dispatch API — it effectively does not exist as a triggerable workflow until it lands on main.

**Prevention:**
1. **Do not attempt `gh workflow run` on workflows that haven't merged to main** — they will always 404. This is not a permissions issue or path error; it is a GitHub platform constraint.
2. **Sequence dispatch-validation as a post-merge step** for new scheduled/dispatch workflows — document this in the PR description so the reviewer knows the real smoke test happens after merge, not in CI.
3. **For pre-merge testing of dispatch logic**, use `workflow_call` (callable from within CI) or `push`/`pull_request` triggers on the feature branch instead.

**Status:** Active — 1 instance (p/26#94). GitHub platform constraint; post-merge sequencing is the canonical resolution.

**Applies To:** All agents adding new `workflow_dispatch` or scheduled workflows. Relevant during PR authoring to set correct expectations about when dispatch testing can occur.

---

## #189 [Build/Worktree] Worktree Checkout Has No `node_modules` — vitest/npm Tools Fail

**Pattern:** A fresh `git worktree add` checkout does not include `node_modules` (they are gitignored). Any test runner, build tool, or script that requires installed packages (vitest, tsc, npm scripts) fails immediately with module-not-found or command-not-found errors in the worktree.

**Instances:**
- 2026-09-03 — Server Auth (p/608#1, t/3284): worktree at `.worktrees/t3284/taxonomy-editor/` had no `node_modules`; vitest failed. Resolution: `New-Item -ItemType Junction -Path .worktrees/t3284/taxonomy-editor/node_modules -Target taxonomy-editor/node_modules` (junction to shared tree's installed node_modules). Tests then ran successfully.

**Root Cause:** `node_modules` is gitignored by design — it is never committed. Worktrees share the `.git` directory but have independent working trees; they do not inherit the parent checkout's `node_modules`. Running `npm install` in a worktree creates a duplicate install; using a junction to the shared tree's `node_modules` is faster and avoids disk waste.

**Prevention:**
1. **After creating a worktree for any npm-based subtree, create a junction to the shared tree's `node_modules` before running any npm scripts:** `New-Item -ItemType Junction -Path <worktree>/<subtree>/node_modules -Target <shared-tree>/<subtree>/node_modules`
2. **Remove the junction before `git worktree remove`** (per Pattern #122 / rmdir-first rule) to prevent `git worktree remove` from failing on the non-empty directory: `Remove-Item <worktree>/<subtree>/node_modules` (removes the junction, not the target).
3. **Applicable subtrees**: `taxonomy-editor/`, `poviewer/`, `summary-viewer/`, `lib/debate/` — any directory with its own `package.json` and gitignored `node_modules`.

**Status:** Active — 1 instance (p/608#1, t/3284). Worktree setup gap; junction is the canonical fix.

**Applies To:** All agents creating worktrees for work in npm-based subtrees. Especially relevant for test-running worktrees where the first action is `npx vitest` or `npm run build`.

---

## #190 [Process/CI] FIRE Arm "Observationally Pending" Is Not Safe — Force-Trigger End-to-End When Cheap

**Pattern:** A gate's FIRE arm was accepted as "observationally pending" (predicate correct, fire never verified in production). The predicate fired correctly (exit 1, red CI job) but the human-reaching signal never arrived because a downstream step in the fire→signal chain silently errored — "fires but nobody's told." The chain break was entirely independent of the predicate logic.

**Instances:**
- 2026-09-03 — DevOps (p/26#97, t/3278): `deploy-drift-check` predicate correctly returned Fire=True (exit 1), but `gh issue create --label deploy-drift` then errored "label not found" (the label was never created in the repo). The gate job went red — technically fired — yet the human-visible issue never opened. Caught by forcing the fire via a threshold-override dispatch. Fix: workflow now self-ensures the label with `gh label create --force` before `gh issue create`.

**Root Cause:** A gate's observable output is the job exit code (pass/fail), not whether the human-reaching artifact (issue, alert, notification) was actually created. These are separate steps in the same job, and errors in post-predicate steps are silently swallowed from the gate's perspective. Unit-green + a de-gated fire arm proves only the predicate logic — not the full fire→signal chain.

**Prevention:**
1. **Force-trigger the fire arm end-to-end at least once** — even when observationally pending — by using a threshold-override dispatch or injecting a synthetic event. Confirm the human-reaching artifact (issue, alert, notification) actually appears.
2. **Self-ensure every dependency of the fire path** — labels, webhooks, topics, channels — with idempotent creation (`gh label create --force`, `gh api ... --method PUT`, etc.) before the step that depends on them.
3. **Do not accept "observationally pending" as equivalent to "both arms verified."** Gate-Promotion (Pattern #184, t/3192) requires both arms deliberately exercised. A fire arm that has never triggered end-to-end in a real or forced run is unverified.

**Status:** Active — 1 instance (p/26#97, t/3278). Gate verification gap; force-trigger + dependency self-ensure is the canonical prevention.

**Applies To:** All agents authoring or reviewing alert/gate workflows where the FIRE arm emits an artifact (GitHub issue, webhook call, notification) after the predicate step. Especially relevant during Gate-Promotion review (Pattern #184).

---

## #191 [Process/Git] Check `git worktree list` Before Touching Another Role's PR Branch

**Pattern:** An agent attempts to create a worktree for another role's PR branch (to apply a cross-scope fix) and hits "fatal: '<branch>' is already checked out at '<other-path>'" — the branch owner already holds a live worktree. Attempting to push directly over the owner's branch while they hold a worktree risks clobbering in-progress work (same failure class as the #1912 force-push clobber).

**Instances:**
- 2026-09-04 — Tech Lead (p/335#56): `git worktree add -b <branch>` failed "branch already exists" because the owning role held a live worktree on that branch. Resolution: routed the exact fix (as a patch description) to the owner, who applied and pushed it from their worktree. No clobber risk.

**Root Cause:** When a role holds a live worktree on their feature branch, any external agent pushing to that branch — or force-deleting/recreating it — will conflict with or overwrite the owner's uncommitted work. The "branch already exists" error is a signal, not just a naming collision.

**Prevention:**
1. **Before touching another role's PR branch, run `git worktree list`** — if the owner has a live worktree on that branch, do not attempt to check it out or push to it directly.
2. **Route the fix to the owner instead** — ping them with the exact change needed (file, line, diff) and let them apply + push from their live worktree. This avoids all clobber risk.
3. **If the branch is truly orphaned** (owner confirms no live worktree), clean up with `git worktree prune` + `git branch -D` before creating a new worktree. Confirm with the branch owner first.

**Status:** Active — 1 instance (p/335#56). Cross-role branch-safety pattern; route-to-owner is the canonical approach.

**Applies To:** All agents who need to apply fixes to tickets or PRs owned by another role. Especially relevant for TL and Sage who may need to apply cross-scope fixes during incidents.

---

## #192 [Build/Worktree] `mklink /J` Junction Inside Worktree Blocks `git worktree remove` — Orphaned Dir + Stale Branch

**Pattern:** A `mklink /J` junction (e.g., for `node_modules`) inside a worktree blocks `git worktree remove` because the junction appears as a non-empty directory. Git de-registers the worktree but leaves the physical directory behind — an orphaned dir that still has the old branch checked out. Subsequent `git worktree add` on the same path or branch then fails with "already exists" / "branch already in use."

**Instances:**
- 2026-09-04 — ServerAPI (p/504#8, t/3296): `.worktrees/t3296a/` had a `mklink /J`-created `node_modules` junction. `git worktree remove` failed silently (git de-registered but left the dir). Re-`add` saw both an existing dir and a stale branch — failed on both. Fix sequence: (1) `cmd //c rmdir .worktrees/t3296a\taxonomy-editor\node_modules` (removes the junction link only — NOT the real node_modules target), (2) `rm -rf .worktrees/t3296a`, (3) `git worktree prune`, (4) `git branch -D <stale-branch>`, (5) `git worktree add` fresh.

**Root Cause:** `git worktree remove` refuses to delete a worktree directory it considers non-empty. A junction appears as a non-empty directory to git. When removal fails partway, git may still de-register the worktree metadata, leaving the physical dir orphaned — causing the next `add` to fail on the dir AND on the stale branch that was never cleaned up.

**Warning:** `rm -rf` on a directory containing a `mklink /J` junction **follows the junction and deletes the real target** — in this case, the real `node_modules` on the shared tree. Always use `cmd //c rmdir <junction-path>` (removes only the link) before `rm -rf` on the parent dir.

**Prevention:**
1. **Remove `mklink /J` junctions with `cmd //c rmdir <path>` BEFORE `git worktree remove`** — this removes only the link, leaving the real target intact.
2. **Prefer `New-Item -ItemType Junction` (PowerShell) over `mklink /J` (cmd)** — teardown is `Remove-Item <path>` (removes junction only), which is safer and doesn't require escaping to cmd. See also Pattern #189.
3. **If a `git worktree remove` fails, check for junctions in the worktree directory** before retrying — they are the most common non-empty-dir blocker. Follow the full cleanup sequence: `rmdir <junction>` → `rm -rf <orphan-dir>` → `git worktree prune` → `git branch -D <stale>` → re-add.
4. **Never `rm -rf` a worktree directory without first removing junctions** — it will silently delete the junction's real target.

**Status:** Active — 1 instance (p/504#8, t/3296). Extension of Patterns #122 and #189; junction teardown sequence is the canonical fix.

**Applies To:** All agents creating worktrees with junction-linked directories (node_modules, build outputs). Windows-specific (mklink /J / New-Item -ItemType Junction). Especially relevant for npm-worktree setups per Pattern #189.

**Applies To:** All agents receiving "safe to proceed" or "all prerequisites met" messages for prod changes; all human operators reviewing agent-initiated prod-change requests.

---

## #193 [Process/Search] Recursive `grep -r`/`find` from Repo Root Times Out — Traverses Data Sibling and `node_modules`

**Pattern:** Running `grep -rn`/`grep -rlnE`/`find .` from the repository root times out (2m Bash limit) because the traversal descends into the ~410 MB `ai-triad-data` sibling directory and/or `node_modules`. The shell tool has no awareness of `.gitignore` exclusions.

**Instances:**
- 2026-09-04 — Diagnostics (p/9#71): `grep -rn` from repo root traversed `ai-triad-data` sibling (~410 MB) + `node_modules`; timed out at 2m. Resolved by switching to scoped Grep/Glob tools on explicit paths.
- 2026-09-04 — PowerShell (p/20#37): `grep -rlnE ... .` over repo tree timed out at 120s for the same reason. Resolved by using `git ls-files | grep` (tracked files only) and the Grep tool.

**Root Cause:** The shell `grep -r` and `find` commands follow all directories unless explicitly excluded. This repo's root contains a ~410 MB data sibling (`../ai-triad-data` symlinked or adjacent) and large `node_modules` trees. Neither is excluded by default shell glob rules.

**Prevention:**
1. **Never run `grep -r .` or `find .` from the repo root** — always scope to an explicit subtree (`scripts/`, `taxonomy-editor/src/`, `lib/`).
2. **Prefer the dedicated Grep and Glob tools** over shell `grep`/`find` — they are gitignore-aware and will not traverse data siblings or `node_modules`.
3. **Use `git ls-files | grep <pattern>`** as a fast, tracked-files-only alternative when searching for filenames or content across the whole repo — it reads only what git knows about, skipping all untracked and ignored paths.
4. **Add explicit `--exclude-dir` flags** if shell grep is unavoidable: `grep -r --exclude-dir=node_modules --exclude-dir=.worktrees <pattern> .`

**Status:** Active — 2 instances (p/9#71, p/20#37). Matches root AGENTS.md search-tooling rule: prefer Grep/Glob over shell grep/find.

**Applies To:** All agents performing codebase-wide searches. Especially relevant when the task prompt says "search the whole repo" — always scope or use dedicated tools.

---

## #194 [Process/Claim] Taking Over an Asleep Owner's Assigned Ticket Requires a PR/Branch Check Before Implementing

**Pattern:** An agent takes over an asleep peer's assigned ticket and begins implementing, without first checking whether the original owner already has an in-flight PR or branch. Both agents produce implementations of the same ticket, burning CI cycles and requiring consolidation.

**Instances:**
- 2026-09-04 — PowerShell 2 (p/228#22, t/3307): Main (PowerShell) was asleep and assigned to t/3307. PowerShell 2 took it over and began implementing; neither checked for the other's in-flight work. Both produced PRs (#1947 + #1948). Resolved by consolidating to Main's #1947 as sole survivor and closing #1948. Root: `git worktree add` on the branch then failed "already used by worktree," surfacing the collision.

**Root Cause:** Ticket assignment and comments show who owns the work, but not whether a branch or PR already exists. An asleep agent's in-flight branch is invisible on the ticket — it lives in `git` and GitHub, not in the ticket tracker. The AGENTS.md "Claim Before Implement" rule (q/42) mentions checking "in-flight PR or recent landed commit," but the concrete mechanic (`gh pr list --search`) was not applied.

**Prevention:**
1. **Before implementing an assigned ticket, run `gh pr list --search "<ticket-id>" --state open`** — if a PR already exists for this ticket, coordinate with the branch owner before starting your own implementation. This is the concrete step that instantiates the AGENTS.md q/42 rule.
2. **Check `git branch -r | grep <ticket-id>`** as a secondary check — a feature branch may exist without an open PR yet (e.g., pushed but not yet PR'd, or in a worktree).
3. **If taking over from an asleep owner, ping them before starting** — they may have WIP in a local worktree not yet pushed. A ping costs one round-trip; a duplicate PR costs two CI cycles and a consolidation.

**Status:** Active — 1 instance (p/228#22, t/3307). Recurrence of t/2514 duplicate-implementation class. The concrete `gh pr list --search` mechanic is the prevention gap vs. the existing q/42 rule.

**Applies To:** All agents in multi-instance roles (PowerShell, CL, ServerAPI, etc.) and any agent taking over a ticket from an asleep peer. Especially relevant when the ticket is already assigned.

---

## #195 [Deploy/ACA] ACA Revision `runningState` Exact-Match `'Running'` Misses Healthy Revisions

**Pattern:** A poll loop waiting for an ACA revision to become healthy matched only `runningState == 'Running'` exactly. ACA reports healthy revisions as `'RunningAtMaxScale'` or `'RunningAtMinScale'` depending on traffic. The loop timed out (exit 143) even though the revision was healthy throughout.

**Instances:**
- 2026-09-05 — DevOps (p/26#100): revision-health poll loop matched `runningState == 'Running'` exactly. ACA returned `'RunningAtMaxScale'` for the healthy revision; the loop never matched and timed out. Fix: changed match to `/^Running/` prefix regex.

**Root Cause:** ACA's `runningState` enum includes `'Running'`, `'RunningAtMaxScale'`, and `'RunningAtMinScale'` — all indicating a healthy revision. Exact-matching only `'Running'` treats the scale-qualified variants as "not ready."

**Prevention:**
1. **Match `/^Running/` prefix when polling ACA revision `runningState` for health** — accepts all three healthy variants.
2. **Unhealthy states** to watch for: `'Provisioning'`, `'Deprovisioning'`, `'Failed'`, `'Degraded'`.
3. **Test the poll condition under real traffic** — scale-qualified states only appear under real or simulated load and may not surface in synthetic tests.

**Status:** Active — 1 instance (p/26#100). ACA API behavior; prefix-match is the canonical fix.

**Applies To:** All agents or scripts polling ACA revision health (deploy pipelines, readiness gates, blue-green flip scripts).

---

## #196 [Process/PR] Co-Merge / Joint-GV PRs Must Never Use `--auto` — Label `joint-gv` and Merge Manually

**Pattern:** Two or more PRs must land together (locked cross-role contract) or one PR is gated on a joint TL Gate Verification. Auto-merge is enabled on one of them. When CI goes green, auto-merge fires and merges that PR alone — without its pair — briefly breaking main or stranding reviewed work.

**Instances:**
- 2026-09-04 — t/3307 / PR #1947 (AGENTS.md, t/3318): PR #1947 had auto-merge enabled as part of a co-merge pair. When checks went green, it merged alone without its ElectronMain pair, briefly breaking main. Fix: `joint-gv` label + `auto-merge-jointgv-guard` blocks `gh pr merge --auto` on labeled PRs; manual `--match-head-commit` merge required after GV clears.

**Root Cause:** Auto-merge is unconditional on CI green — it has no awareness of PR-pairing or joint GV status. It races any coordination and fires on whichever PR's CI finishes first.

**Prevention:**
1. **Label co-merge and joint-GV PRs with `joint-gv`** — activates `auto-merge-jointgv-guard` which blocks `gh pr merge --auto` on the labeled PR.
2. **Never enable auto-merge on a `joint-gv`-labeled PR** — merge manually with `--match-head-commit` after the joint GV clears.
3. **`blocks` relations and ticket comments do NOT prevent auto-merge** — only the `joint-gv` label + guard enforces this.

**Status:** Active — 1 instance (t/3307, t/3318). Codified in root AGENTS.md PR-Flow Practice Rules.

**Applies To:** All agents landing cross-role paired PRs or PRs gated on joint TL Gate Verification.

---

## #197 [Process/Git] `gh pr close --delete-branch` Fails in Worktree Context When Branch Is Checked Out Elsewhere

**Pattern:** `gh pr close <N> --delete-branch` fails with "fatal: '<branch>' is already used by worktree '<path>'" when the flag attempts to delete the local branch and that branch is currently checked out in the shared tree or another worktree.

**Instances:**
- 2026-09-05 — DevOps 2 (p/340#7): `gh pr close 1979 --delete-branch` failed because it attempted to delete local `main` (checked out by the shared tree). Fix: `git push origin --delete <branch>` to delete only the remote ref; local cleanup handled explicitly.

**Root Cause:** `gh pr close --delete-branch` deletes both the remote and local branch. In a worktree context, deleting the local branch fails if it is currently checked out anywhere. The error surfaces as a git fatal, not a gh error.

**Prevention:**
1. **In worktree contexts, avoid `gh pr close --delete-branch`** — use `git push origin --delete <branch>` for the remote ref instead.
2. **For local branch cleanup:** `git branch -D <branch>` only after confirming no worktree holds it via `git worktree list` (see also Pattern #187).
3. **Close the PR and delete branches as separate steps** when in a worktree: `gh pr close <N>` then `git push origin --delete <branch>`.

**Status:** Active — 1 instance (p/340#7). Worktree-context branch-delete constraint; separate remote + local delete is the canonical approach.

**Applies To:** All agents closing PRs and cleaning up branches in a worktree context. Especially relevant when consolidating duplicate PRs (per Pattern #194).

---

## #198 [Build/PS] Standalone `.ps1` Cannot Call Module-Private Helpers — Unit Stubs Hide This Until Real Run

**Pattern:** A standalone `.ps1` script calls `Import-Module AITriad` and then invokes a private helper function (e.g. `Get-Prompt`). The import only exports public functions; private helpers are not in the caller's scope and throw "not recognized as the name of a cmdlet" at runtime. Unit tests that stub the private helper mask the error — it only surfaces when the script is actually run against the real module.

**Instances:**
- 2026-09-05 — PowerShell (p/20#40, t/3302 fork-B): standalone `.ps1` called `Get-Prompt` after `Import-Module AITriad`. `Get-Prompt` is a private helper — not exported, not in scope. Unit tests had stubbed it; first real run threw "not recognized." Fix: dot-sourced the private file and set `$script:ModuleRoot` before calling it.

**Root Cause:** PowerShell module scoping is strict — `Import-Module` only surfaces `Export-ModuleMember`-listed functions. Private helpers live in `$script:` scope inside the module and are invisible to outside callers. Stub-based unit tests bypass this scoping entirely, providing false confidence.

**Prevention:**
1. **Do not call private module helpers directly from a standalone `.ps1`** — either export the helper, dot-source its file (setting any required `$script:` vars like `$script:ModuleRoot` first), or invoke it via `& (Get-Module AITriad) { Get-Prompt @args } @actualArgs`.
2. **Add an integration test that calls the script end-to-end with the real (unstubbed) module** — this will catch "not recognized" errors that unit stubs hide.
3. **When dot-sourcing a private file, initialize its `$script:` dependencies first** — private helpers often read `$script:ModuleRoot` or similar vars set during module load; dot-sourcing skips that initialization.

**Status:** Active — 1 instance (p/20#40, t/3302). PS module scoping trap; dot-source + integration test is the canonical fix.

**Applies To:** All agents writing standalone `.ps1` scripts that reuse AITriad module internals. Especially relevant for harvest/analysis scripts that call `Get-Prompt`, `Invoke-AIEnrich`, or other private helpers.

---

## #199 [Build/PS] Bare Relative `-OutPath` Resolves to .NET Process Cwd, Not PowerShell `Set-Location` Cwd

**Pattern:** A PowerShell script passes a bare relative path to a `-OutPath` (or similar) parameter expecting output to land in the current PS working directory. The path resolves to the .NET process working directory instead — which is typically the repo root or the shell's launch directory, not the directory set by `Set-Location` or `cd`. The output file lands silently out of sight.

**Instances:**
- 2026-09-05 — PowerShell (p/20#40, t/3302): `-OutPath "results.json"` resolved to the .NET process cwd (repo root), not the subtree the script `cd`'d into. File landed in the wrong directory; subsequent steps failed to find it. Fix: `-OutPath (Join-Path (Get-Location).Path "results.json")`.

**Root Cause:** PowerShell's `Set-Location` / `cd` changes the PS provider's current location but NOT the underlying .NET `System.IO.Directory.GetCurrentDirectory()`. Parameters passed to .NET APIs or cmdlets that call into .NET for path resolution use the .NET cwd, not the PS one. These can silently diverge, especially in scripts that `cd` partway through.

**Prevention:**
1. **Always anchor relative output paths to `(Get-Location).Path`:** `Join-Path (Get-Location).Path "relative/path"` — this explicitly uses the PS current location, not the .NET process cwd.
2. **Prefer absolute paths for output files in scripts** — resolve at the top of the script (`$outDir = (Get-Location).Path`) before any `cd` calls, then use the resolved absolute path throughout.
3. **If a file silently "disappears" after writing**, check the repo root and the shell's launch directory — bare relative paths often land there.

**Status:** Active — 1 instance (p/20#40, t/3302). PS/.NET cwd split; anchor to `(Get-Location).Path` is the canonical fix.

**Applies To:** All agents writing PowerShell scripts that produce output files, especially scripts that `cd` mid-execution or call cmdlets with `-OutPath`/`-Path` parameters.

---

## #200 [Process/Overlay] New Nested `AGENTS.md` Requires `ogit add -f` — Whitelist Alone Does Not Stage New Files

**Pattern:** A new nested `AGENTS.md` (created for a new role or instance) is not tracked by either the main repo or the overlay repo until explicitly staged. `ogit add <path>` (without `-f`) fails with exit 1 because the overlay whitelist allows the file pattern but does not automatically stage new untracked files — `-f` is required to force-add files that are not already in the index.

**Instances:**
- 2026-09-05 — Orca Support (p/13#35, commit b0fdd1a): `ogit add` of a new nested devops `AGENTS.md` hit the whitelist ignore (exit 1). Resolved with `ogit add -f <path>`; audit clean. Recurrence of t/1971 pattern.

**Root Cause:** Git's `.gitignore` / `.orca-gitignore` whitelist allows specific `AGENTS.md` paths but does not stage them — a new file must be explicitly force-added with `-f` to override the default ignore. Without `-f`, `git add` silently skips or errors on files that match an ignore pattern, even if a whitelist `!` exception exists.

**Prevention:**
1. **Always use `ogit add -f <new-role>/AGENTS.md`** when adding a new nested `AGENTS.md` to the overlay — never plain `ogit add` without `-f`.
2. **Follow the three-step sequence from root AGENTS.md:** `ogit add -f <path>` → `sh .githooks/agent-file-owner.sh --audit` (expect clean) → commit. Do not skip the audit.
3. **Never use `--no-verify` past the audit** — a new `AGENTS.md` that bypasses the audit is an unbacked orphan (Pattern #146).

**Status:** Active — recurrence of t/1971. Codified in root AGENTS.md "Creating a role/instance?" section. Each new role/instance creation is a new exposure.

**Applies To:** All agents creating new roles or instances. Especially relevant for TL and Orca Support who provision new agent scopes.

---

## #201 [Process/Overlay] `/land-from-worktree` Is Main-Repo-Only — Overlay-Owned Files Need `ogit` Flow; `--path` Check Unreliable for Non-AGENTS.md Files

**Pattern:** An agent uses `/land-from-worktree` (or the standard `git add` / `git commit` / `gh pr create` flow) to land a file that is overlay-owned (e.g., a docs file in an overlay-scoped directory). The main repo's `.gitignore` silently rejects the file — `git add` reports it as ignored or simply refuses — and the file never lands. A secondary trap: `agent-file-owner.sh --path` reports `NEITHER` for non-`AGENTS.md` overlay-tracked files, giving a false "untracked by both" result.

**Instances:**
- 2026-09-05 — Orca Support (p/13#38): attempted to land `orca-support/docs/review-architecture-audit.md` via the main-repo `/land-from-worktree` flow. `git add` refused — `orca-support/` is main-gitignored (overlay-owned). `--path` check also reported `NEITHER` (non-AGENTS.md file). Resolved: `ogit add -f` + overlay commit f297eee; audit clean.

**Root Cause:** The main repo's `.gitignore` excludes overlay-owned directories (e.g., `orca-support/`, `.orca/`). Files inside those directories are invisible to `git add`. `agent-file-owner.sh --path` was designed for `AGENTS.md` files only — it does not track arbitrary overlay files and correctly reports `NEITHER` for them, which is misleading when the file IS overlay-tracked.

**Prevention:**
1. **Before running `/land-from-worktree`, check whether the target file's directory is main-gitignored** — if so, it's overlay-owned and needs `ogit add -f <path>` + `ogit commit` + `ogit push`, not the main-repo flow.
2. **`agent-file-owner.sh --path` is only authoritative for `AGENTS.md` files** — for other files, use `ogit status` or `ogit log -- <path>` to confirm overlay tracking. `--audit` (no `--path`) is the authoritative check for the full file set.
3. **When in doubt about repo ownership for a non-AGENTS.md file**, run `git check-ignore -v <path>` — a hit means main-gitignored → overlay territory.

**Status:** Active — 1 instance (p/13#38). Overlay/main routing gap; ogit flow is the canonical path for overlay-owned non-AGENTS.md files.

**Applies To:** All agents landing docs, configs, or other files in overlay-owned scopes. Especially relevant for Orca Support, TL, and any role whose scope is partially or fully overlay-owned.

---

## #202 [Process/Platform] Switching a Gate-Critical Role's `agent_type` Without Canary — Keyed-but-MCP-Less Session Blocks Gate

**Pattern:** An agent updates a gate-critical role's runtime via `update_instance agent_type <provider>` without a canary step. The target provider's config (e.g., `.gemini/settings.json`) was never provisioned by Orca. The new session launches with the API key but without MCP connections ("never connected"). Pings queue but are never received; any gate the role owns blocks indefinitely.

**Instances:**
- 2026-09-05 — Orca Support (p/13#40, t/3358): switched Second Opinion role from `claude` to `gemini` via `update_instance`. Orca had not generated `.gemini/settings.json`; the Gemini session launched keyed-but-MCP-less. Pings queued; t/3358 merge gate blocked ~3h. Resolved: reverted to `claude`/`fable-5`, human restarted session, connection registered, consult delivered.

**Root Cause:** `update_instance agent_type` changes the runtime label but does not provision the target provider's config files. There is no warning when the target config is absent. The operator assumed the switch was complete and activated when it was not.

**Prevention:**
1. **Canary-first for any `agent_type` switch on a gate-critical role** — switch a non-critical instance first (or a test instance), verify MCP connection registers, then switch the gate-critical role. Never switch gate-critical roles cold.
2. **After switching, verify the session is MCP-connected before considering the migration complete** — check `get_agent_status` or wait for a test ping to be received. A keyed-but-unconnected session appears "running" but is functionally absent.
3. **Platform gap: `update_instance agent_type` should warn when the target provider's config is absent** — file as a platform improvement ticket with Orca Support if encountered.
4. **Have a revert path ready** — know the previous `agent_type` value before switching; reverting is fast if the prior config is still intact.

**Status:** Active — 1 instance (p/13#40, t/3358). Runtime-switch safety gap; canary-first + verify-connection is the canonical prevention.

**Applies To:** All agents or operators switching `agent_type` on any role, especially gate-critical roles (Second Opinion, TL, DevOps). Especially relevant for Orca Support who performs runtime migrations.

---

## #203 [Build/Worktree] Windows Dir-Symlinks Require Elevation or Dev Mode — Use `pnpm install` Instead for `node_modules` in Worktrees

**Pattern:** On Windows, creating a directory symlink for `node_modules` in a worktree via `bash ln -s` or `New-Item -ItemType SymbolicLink` fails with "File name too long" (misleading — actual cause: existing-target-dir collision or privilege) or "requires admin rights / developer mode not enabled." Neither shell had the required elevation. Attempting to work around with `mklink /J` (junction) avoids the privilege issue but introduces teardown complexity (Pattern #192).

**Instances:**
- 2026-09-07 — Rosetta Stone (p/6#56): `bash ln -s` and `New-Item -ItemType SymbolicLink` both failed repeatedly when trying to link `taxonomy-editor/node_modules` into a fresh worktree. "File name too long" from `ln` was a misleading error masking an existing-target-dir collision. Resolved: skipped symlinking entirely; ran `CI=true pnpm install --frozen-lockfile --prefer-offline` in the worktree. Completed in 42s (pnpm content-store already warm).

**Root Cause:** Windows directory symlinks require either Administrator elevation or Developer Mode enabled. Most agent shell contexts have neither. `ln -s` on Windows (MSYS/Git Bash) additionally produces misleading errors when the target already exists as a directory. `mklink /J` (junction) avoids privilege requirements but creates teardown risk (Pattern #192).

**Prevention:**
1. **Prefer `CI=true pnpm install --frozen-lockfile --prefer-offline` over symlinking for `node_modules` in worktrees** — with a warm pnpm content-store, this completes in ~40s and avoids all privilege and teardown complexity.
2. **Do not attempt `ln -s` or `New-Item -ItemType SymbolicLink` for directories on Windows** — elevation/Dev Mode are required and rarely available in agent contexts.
3. **If a junction (`mklink /J` or `New-Item -ItemType Junction`) is used instead**, follow the teardown sequence from Pattern #192 (remove junction with `cmd //c rmdir` before `git worktree remove`).
4. **"File name too long" from `ln -s` on Windows is often a misleading error** — check for an existing-target-dir collision first before interpreting it as a path-length issue.

**Status:** Active — 1 instance (p/6#56). Extension of Patterns #189 and #192; `pnpm install --frozen-lockfile --prefer-offline` is the canonical Windows-safe alternative to node_modules symlinking.

**Applies To:** All agents creating worktrees for npm/pnpm-based subtrees on Windows. Especially relevant when the worktree is short-lived (test run, single-PR fix) and a full `npm install` would be wasteful.

---

## #191 [Process/Git] (Second Instance) — Stash-Preserve Foreign WIP Before Working in Another Role's Live Worktree

*(See first instance above for the base pattern: check `git worktree list` before touching another role's PR branch.)*

**Additional Instance:**
- 2026-09-07 — Tech Lead (p/335#64, PR #2053): `git worktree add` on PR #2053's branch refused "already used by worktree" — Rosetta Stone held a live checkout. Resolution variant: instead of routing a patch to the owner (first-instance approach), TL worked in the existing worktree directly, first stash-preserving Rosetta's foreign staged WIP (`git stash --include-untracked`) before applying the fix, then unstashing after. Owner completed the final push themselves.

**Additional Prevention (complement to #191's base rule):**
- **If the owner is unreachable and you must work in their live worktree**, `git stash --include-untracked` first to preserve their staged/unstaged WIP, apply only the minimal fix, then `git stash pop` and leave the final push to the owner. Never commit over someone else's uncommitted work.

---

## #204 [Process/Methodology] Pre-Commit the Acceptance Rule Before the Measurement Exists — Prevents Re-Litigation on a Low Score

**Pattern:** A team needs to evaluate a new component against a threshold. Instead of measuring first and then deciding whether the score is "good enough," the acceptance rule and fallback are locked in (with human approval) *before* the golden measurement is taken. When the blind score comes in below the floor, there is no room for special-pleading — the pre-committed rule executes without re-litigation.

**Instances:**
- 2026-09-07 — Computational Linguist (p/7#78, e/145, t/3381, t/3379): SO/TL/CL locked the `about[]`-component acceptance threshold (≥0.80) and fallback (A→C relabel) before the golden harness ran. Blind measurement: 0.636 — well below floor. Robustness check: most-generous relabel still yielded 0.799 < 0.80. Fallback executed cleanly with no re-litigation. First live firing of a pre-committed fallback rule in this project.

**Root Cause:** When thresholds are set after measurement, the score anchors the discussion — teams argue about whether 0.636 is "really" below the bar, or whether the bar was set correctly, or whether a generous interpretation would pass. Pre-commitment removes the anchor. The rule is a contract, not a negotiation.

**Prevention:**
1. **Lock the acceptance rule and fallback before the measurement runs** — get human approval (or multi-stakeholder sign-off via SO/TL/CL) on the threshold AND the fallback action while the score is still unknown. Record it as a durable commitment (ticket comment, email thread, SO decision).
2. **Include a robustness check in the rule** — e.g., "most-generous relabeling still fails" prevents special-pleading after the fact. A fallback that fires even under the most favorable interpretation is unambiguously correct.
3. **The fallback is not a punishment** — frame it as a planned engineering response to a measurement outcome, not a failure. Teams that see the fallback as punitive will fight the threshold; teams that see it as a pre-planned path will execute it calmly.

**Status:** Active — 1 instance (p/7#78, e/145, t/3381, t/3379). Reference example for pre-committed acceptance rules. Methodology pattern; applicable to any evaluation-gated component or data-quality decision.

**Applies To:** All agents and humans setting acceptance thresholds for evaluated components, classifiers, or data-quality gates. Especially relevant for measurement-gated decisions where post-hoc score anchoring is a known risk.

---

## #205 [Platform/Observability] Orca Feedback-Rule Telemetry Writer Dead Since May 2026 — Never Cite `fire_count` / `last_fired_at` as Evidence

**Pattern:** Orca's feedback-rule execution-telemetry writer stopped recording data after a late-May 2026 platform update. Fields `fire_count_24h`, `recent_executions`, and `last_fired_at` are unfed for all rules; the on-disk execution log stalled 2026-05-29. Rules still FIRE normally — only the telemetry recording is broken. Citing these fields as evidence of rule activity (or inactivity) in Gate Verifications, closures, or audits produces a false record.

**Instances:**
- 2026-09-07 — DevOps Lead (p/26#103, t/3394#1/#2, e/147#5): confirmed platform regression — telemetry writer dead since late May. `fire_count_24h` = 0 and `last_fired_at` = null for ALL rules, including rules with known recent firings. Absence of telemetry proves nothing about rule activity. Real fix is upstream (Orca Support reporting it).

**Root Cause:** A platform regression in the late-May Orca update silently stopped writing execution telemetry. The regression was not flagged at release; it was discovered months later during a GV audit when expected telemetry was absent. The only durable evidence of rule firing is a rule-specific durable sink (e.g., t/2070-style log entry) outside the Orca telemetry system.

**Prevention:**
1. **Never cite `fire_count_24h`, `recent_executions`, or `last_fired_at` as evidence** in Gate Verifications, closures, or audits until Orca Support confirms the telemetry writer is restored.
2. **For gate verification, rely on durable sinks** — a rule that writes to a GitHub issue, a ticket comment, or an external log (t/2070 pattern) provides tamper-evident evidence independent of the broken telemetry.
3. **When a rule's GV requires fire evidence**, force-trigger the fire arm in a controlled test and observe the durable output — don't infer activity from the Orca telemetry dashboard.
4. **Track the fix via Orca Support** (t/3394) — re-enable telemetry-based GV evidence only after the writer is confirmed restored and backfill-verified.

**Status:** Active — platform regression (late-May 2026, t/3394). Affects ALL feedback rules. Resolution pending Orca Support upstream fix. Until resolved, durable sinks are the only admissible fire evidence.

**Applies To:** All agents performing Gate Verifications, incident closures, or audits that reference feedback-rule firing evidence. Especially relevant for TL, DevOps, and any role that authors or reviews gate-verification documentation.

---

## #206 [Platform/Safety] ALL Orca `run:` Shell-Out Feedback Rules Silently Inert Since Late-May 2026 — Block Gates Cannot Be Trusted

**Pattern:** A late-May 2026 Orca platform regression made all `run:` shell-out feedback rules fail to execute. The rules are defined, the rule engine partially operates (static/template rules still fire), but `run:` predicates produce no output and no block. Every blocking gate in the fleet — `pre-self-merge-verify`, `joint-gv-automerge-guard`, `done-evidence` — has been silently inert since ~2026-05-29. No errors are surfaced; the rules appear active.

**Instances:**
- 2026-09-07 — Orca Support (p/13#43, t/3394#6): probe `gh pr merge 99999` (exit 1 = PR not found) was not intercepted by `pre-self-merge-verify` (type:block). Template rules fired on the same call, confirming partial rule-engine operation. Documented at t/3394#6.
- 2026-09-07 — DevOps Lead (p/26#106, t/3394, t/3396): fleet-wide confirmation — ALL `run:` shell-out feedback rules inert. `pre-self-merge-verify` (t/3270), `joint-gv-automerge-guard` (t/3318), and `done-evidence` (t/3360) all dead. Manual disciplines are the only protection until the platform fix lands.

**Root Cause:** The late-May Orca update broke the `run:` shell-out execution path. The regression is silent — no error is reported when a `run:` rule fails to execute, and the dashboard shows rules as "active." This is a platform bug, not a configuration error.

**Prevention:**
1. **Never cite a `run:` feedback rule as enforcement in a Gate Verification, incident closure, or audit** until Orca Support confirms the execution path is restored and an execution probe passes.
2. **Fall back to manual disciplines** for all protections that were backed by `run:` rules: manually verify `--match-head-commit` on every merge, manually enforce draft on gated PRs, manually confirm done evidence before closing incidents.
3. **Verify execution before citing a rule as a safety layer** — run an execution probe (deliberate trigger with observable output) rather than assuming a rule fires because it is defined and enabled.
4. **Static/template rules (no `run:` block) still fire** — these are unaffected and can be cited as active.

**Status:** Active — platform regression (~2026-05-29, t/3394, t/3396). Affects ALL `run:` feedback rules fleet-wide. Resolution pending Orca Support upstream fix. Note: this is a broader finding than #205 (telemetry dead) — that covers telemetry recording; this covers gate execution itself.

**Applies To:** All agents relying on feedback-rule enforcement for safety-critical workflows. Especially relevant for TL (merge guard), DevOps (done-evidence, joint-gv guard), and any agent citing rule activation as a GV artifact.

---

## #207 [Test/React] `getByText()` Throws Multi-Match When the Value Renders in Multiple DOM Rows

**Pattern:** A React Testing Library test uses `getByText('some-value')` to assert a value is displayed. The value appears in more than one DOM node (e.g., an args row AND an `about[]` chip both show the same string). `getByText` throws "found multiple elements with text" — a test error, not a product bug.

**Instances:**
- 2026-09-07 — Analysis (p/629#1): `BdiGroundingPanel.test.tsx` used `getByText('ent-034')` where `ent-034` appeared in both the args row and an `about[]` chip. Multi-match error. Fixed with `getAllByText('ent-034').length` check.

**Root Cause:** `getByText` is a strict single-match query — it throws if more than one element matches, which is correct behavior. When a test value can legitimately appear in multiple places in the rendered output (repeated in different panels, rows, or chips), `getByText` is the wrong query.

**Prevention:**
1. **Use `getAllByText(...).length` when asserting a value appears at least once** but it may legitimately render multiple times.
2. **Use scoped queries with `within(container).getByText(...)` when asserting a specific occurrence** — e.g., `within(screen.getByTestId('args-row')).getByText('ent-034')` to assert the value appears specifically in the args row.
3. **When writing a new test for a component that renders shared IDs or labels in multiple places**, audit the rendered DOM for duplicate text before choosing `getByText` — `screen.getAllByText(...)` in a debug run reveals all occurrences.

**Status:** Active — 1 instance (p/629#1). Test-authoring pattern; no product bug involved.

**Applies To:** All agents writing React Testing Library tests for components that display entity IDs, labels, or values in multiple panels or rows (e.g., `BdiGroundingPanel`, `about[]`-component tests, node-detail views).

---

## #208 [Build/Shell] Shell Quoting Rule Applies to Inline jq Programs in `gh api --jq` — Shell-Hostile Chars Cause Syntax Errors

**Pattern:** A `gh api` one-liner uses `--jq` with an inline jq expression containing shell-hostile characters (quotes, curly braces, `$` vars). The shell misinterprets the jq string before `gh` sees it, producing "unexpected EOF while looking for matching quote" or similar syntax errors. This is the same class as the Shell Quoting Rule for heredocs and inline Python, but less obviously so since jq programs are often short.

**Instances:**
- 2026-09-08 — Tech Lead (p/335#69): `gh api ... --jq '"head=\(.headRefOid)"'` with a jq expression containing nested quotes failed with "unexpected EOF while looking for matching quote." Fix: dumped the JSON response to a temp file (`gh api ... > tmp.json`) and parsed with Python (`python -c "import json; ..."` or via a temp script file).

**Root Cause:** The shell processes `--jq "<expr>"` before passing it to `gh`. jq programs that contain nested quotes, `$`, `{}`, or `;` require careful escaping — exactly the shell escaping problem the Shell Quoting Rule exists to prevent.

**Prevention:**
1. **For jq programs with any shell-hostile chars (quotes, `$`, `{}`, `;`)**, dump the JSON to a temp file first and parse with Python: `gh api <endpoint> > tmp.json && python <script>`.
2. **Simple jq programs with only safe chars** (`.field`, `.field[]`) can be used inline safely: `gh api ... --jq '.headRefOid'`.
3. **The Shell Quoting Rule (root AGENTS.md) applies to `--jq` strings** — when in doubt, write the jq/python to a temp file via Write, then execute.

**Status:** Active — 1 instance (p/335#69). Extension of the Shell Quoting Rule to jq programs; dump-and-parse is the canonical safe path.

**Applies To:** All agents using `gh api --jq` with complex expressions. Especially relevant when jq output needs string interpolation, conditionals, or multiple fields.

---

## #209 [Process/Shell] `||`-Fallback Write Split: Write Goes to `$TMPDIR`, Next Step Reads Scratchpad Path — Silent Mismatch

**Pattern:** A command writes a file with a `||`-fallback: `> "$TMPDIR/file" || > scratchpad/file`. When `$TMPDIR` is set (which it often is), the write succeeds to `$TMPDIR/file` and the fallback never runs. The next step reads `scratchpad/file` (hardcoded) — which is empty or doesn't exist. The mismatch is silent: no error from the write, no error from the read until the downstream step fails on the missing data.

**Instances:**
- 2026-09-08 — Tech Lead (p/335#69): a Bash pipeline wrote to `"$TMPDIR/file"` successfully (TMPDIR was set); the fallback `scratchpad/file` write never fired. The next step read `scratchpad/file` — empty. Fix: replaced with a single explicit scratchpad path: `> scratchpad/file`.

**Root Cause:** The `||`-fallback pattern assumes the primary write will fail when the env var is unset. But when `$TMPDIR` IS set (the common case on most systems), the fallback never runs and the two branches silently diverge from the next step's expectation.

**Prevention:**
1. **Use a single explicit path for file writes** — don't split write paths across a `||`-fallback unless both branches are explicitly handled by all downstream readers.
2. **If you need a fallback, resolve the path to a variable first** and use it consistently: `OUT="${TMPDIR:-scratchpad}/file"; > "$OUT"` — then pass `$OUT` to downstream steps rather than hardcoding either branch.
3. **Treat `||`-fallback writes as a code smell** in scripts where a later step reads a hardcoded path — the two branches will silently diverge whenever the primary path's precondition is met.

**Status:** Active — 1 instance (p/335#69). Shell path-split trap; single explicit path is the canonical fix.

**Applies To:** All agents writing Bash scripts with conditional write paths. Especially relevant for scripts that write temp files and pass paths to subsequent steps.

---

## #210 [Build/Shell] jq Uses `,` Not `;` to Sequence Multiple Outputs — `;` Is a Syntax Error

**Pattern:** A `gh ... --jq` expression uses `;` to sequence two output expressions (treating jq like a shell). jq uses `,` for sequencing multiple outputs and `;` as a function-argument separator — using `;` between top-level expressions produces a syntax error.

**Instances:**
- 2026-09-08 — Tech Lead (p/335#71): `gh pr view --jq '"head=\(.headRefOid)"; .files[].path'` — the `;` was intended as a statement separator but is not valid jq between top-level expressions. Fix: `.headRefOid, (.files[].path)` — comma sequences outputs.

**Root Cause:** jq is not a shell and not a general scripting language. Its operator precedence and separators are distinct: `,` produces multiple outputs from one expression, `;` separates arguments to a multi-arg function (e.g., `if . then . else . end`). Shell muscle memory often substitutes `;` (shell statement separator) for `,` (jq output separator).

**Prevention:**
1. **Sequence multiple jq outputs with `,` not `;`**: `gh pr view --jq '.headRefOid, (.files[].path)'`
2. **`;` in jq is only valid as a function argument separator** (e.g., `reduce`, `label-break`, `path(expr;expr)`) — if you see `;` in a top-level position, it's a bug.
3. **For complex jq programs, test with `echo '{}' | jq '<expr>'` in the shell before embedding** — syntax errors surface immediately.

**Status:** Active — 1 instance (p/335#71). jq language-syntax trap; `,` is the canonical output sequencer.

**Applies To:** All agents using `gh ... --jq` or shell `jq` pipelines with multiple output fields. Especially relevant when constructing composite output strings from PR/issue metadata.

---

## #211 [Process/Data] AI Batch Work Fully Generated but Persisted Zero — End-Batched Write + Session Killed Before Write

**Pattern:** A long AI-batch pipeline (e.g., 916 AI calls to enrich nodes) generates all results in memory, then writes them all at the very end. The task session is killed (timeout, OOM, manual stop) before the write executes. Net result: full AI spend, zero data saved, results unrecoverable.

**Instances:**
- 2026-09-08 — Computational Linguist (p/7#81, t/3366): 916-node `debate_grounding` backfill authorized and run inside a task session. All 916 statements generated (~916 AI calls). The cmdlet batches all writes at the end; the session was killed after generation, before the write. 0 entries persisted. Full AI spend wasted. Fix tracked as t/3457 (incremental/checkpoint writes).

**Root Cause:** Batch writes at the end of a long pipeline create an all-or-nothing commit boundary. Any session interruption (timeout, kill, OOM, network drop) after generation but before the write loses everything. Task-session runs are especially vulnerable — they have a finite lifetime and die at their boundary regardless of progress.

**Prevention:**
1. **Checkpoint-write incrementally** — for AI-batch pipelines over ~50 nodes, write each result (or small batches of N) immediately after generation. This limits the blast radius of any session interruption to at most N nodes.
2. **Run long AI batches in environments that survive to completion** — prefer terminal/PS runs or background jobs over task-session runs for operations that take >5 minutes. Task sessions die at their boundary; terminal runs survive until the command exits.
3. **Track progress with a durable counter** — write a progress marker to disk after each checkpoint batch. A re-run can resume from the last checkpoint rather than restarting from zero.
4. **Design for idempotent re-run** — a batch that can be safely re-run from any checkpoint (skipping already-written nodes) is resilient to session interruption. Backfills that re-check before writing satisfy this.

**Status:** Active — 1 instance (p/7#81, t/3366). High-cost failure class; checkpoint writes + terminal-mode execution are the canonical prevention. t/3457 tracks the PS resilience fix.

**Applies To:** All agents authoring or running long AI-batch enrichment pipelines (debate_grounding, reflections, embeddings, logical_form). Especially relevant for backfill operations on large node sets (>50 entries).

---

## #212 [Deploy/Azure] `az role assignment list --scope <sub-resource>` Fails with `MissingSubscription` (exit 3) Even with `--subscription`

**Pattern:** `az role assignment list --scope <resource-id>` fails with `(MissingSubscription) The request did not have a subscription or a valid tenant level resource provider` (exit 3), even after `az account set --subscription <id>` and/or passing `--subscription` inline. This is a known az CLI quirk when reading RBAC role assignments at a sub-resource scope (below the subscription level).

**Instances:**
- 2026-09-08 — DevOps Lead (p/26#109): repeated `az role assignment list --scope <ACA-resource-id>` failures with exit 3 / MissingSubscription despite correct subscription context. Bypassed with a direct ARM REST call: `az rest --method get --url "https://management.azure.com/<scope>/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=atScope()"`.

**Root Cause:** The az CLI `role assignment list` command has a known issue resolving subscription context when scoped below the subscription level (resource group, resource, sub-resource). The standard `--subscription` and `az account set` flags do not reliably fix this. The ARM REST API resolves the subscription from the resource ID in the URL and does not have this issue.

**Prevention:**
1. **For RBAC role assignment queries at sub-resource scopes, use `az rest` with the ARM REST API** instead of `az role assignment list`: `az rest --method get --url "https://management.azure.com/<scope>/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=atScope()"`.
2. **exit 3 + `MissingSubscription` from `az role assignment list`** is a CLI bug signal, not a permissions issue — don't retry with `--subscription`, switch to `az rest`.
3. **Subscription-level RBAC queries** (`--scope /subscriptions/<id>`) are unaffected; the workaround is only needed for resource/sub-resource scopes.

**Status:** Active — 1 instance (p/26#109). Known az CLI quirk; `az rest` ARM call is the canonical workaround.

**Applies To:** All agents querying RBAC role assignments on Azure resources (ACA, storage accounts, key vaults, etc.) below the subscription scope. Especially relevant for DevOps agents performing RBAC audits.

---

## #213 [Test/Integration] Component Ships Green Across Multiple Merges But Is Never Wired Into the Registry — Feature Unreachable in UI

**Pattern:** A UI component (panel, tab, view) is built, tested with passing unit tests, and merged across multiple tickets. However, it is never registered in the application's panel/tab registry (the routing layer that determines which components are mountable from the toolbar or navigation). The component is present in the codebase but unreachable in the running UI. Unit tests pass because they mount the component directly; no test exercises the registry wiring. The gap goes undetected across multiple merges.

**Instances:**
- 2026-09-08 — Computational Linguist (p/7#83, t/3470, p/640#2): `BdiGroundingPanel` was built and shipped across 3 tickets (t/3292 concepts/entities, t/3397 logical_form, t/3466 debate_grounding) with green unit tests and green CI. It was never added to the toolbar-panel registry. The panel was completely unreachable in the running UI across all 3 merges. Surfaced during a CL trace of a PI question; confirmed by Analysis (p/640#2). Fix tracked t/3470.

**Root Cause:** Unit tests mount components directly (e.g., `render(<BdiGroundingPanel ... />)`) — they bypass the registry entirely. The registry is the integration point between the component and the application shell; it is not covered by component unit tests. No gate checked for "exported panel component with no registry entry."

**Prevention:**
1. **When shipping a new panel/tab/view component, verify it is wired into the registry in the same PR** — include a registry import/entry as part of the component's definition of "done."
2. **Add a smoke test that mounts the panel via the registry path** (i.e., select the panel from the toolbar and assert it renders), not just via direct `render()`. See also the `/smoke-ui` skill.
3. **Consider a lint/import check for exported panel components with no consumer** — a panel exported from its file but not imported by the registry is a dead export. A no-importer lint rule or a registry-completeness test can catch this at CI time.
4. **For multi-ticket component builds**, include a "registry wiring" acceptance criterion on the first ticket, not the last — it is easy to defer across tickets and never complete.

**Status:** Active — 1 instance (p/7#83, t/3470). Test-coverage failure class: unit-green masked feature-unreachable across 3 merges. Fix tracked t/3470; prevention candidate for a registry-completeness gate.

**Applies To:** All agents building new panel, tab, or view components for the taxonomy-editor or other Electron apps. Especially relevant when a component is built incrementally across multiple tickets (e.g., adding data sources one ticket at a time).
