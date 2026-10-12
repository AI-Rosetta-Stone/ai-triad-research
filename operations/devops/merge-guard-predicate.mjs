// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// TESTED vs RUNNING (t/3871): merge-guard-predicate.test.mjs now runs in CI (ci.yml
// complexity-budget job, via run-merge-guard-tests.sh, test-count floor). That proves THIS FILE AS IT
// IS ON main. It does NOT prove what the live `pre-self-merge-verify` feedback rule executes: the rule
// calls this module by absolute path INTO THE SHARED CHECKOUT, so it runs whatever is on disk there —
// a stale (unsynced) shared tree runs stale gate code, and an uncommitted edit to this file in the
// shared tree changes fleet-wide gate behaviour without ever passing CI. Named surviving vector, not
// fixed (TL p/331#1801); candidate fixes are a content-hash pin or running from an origin/main blob.
import { execFileSync } from 'node:child_process'; // used only by the --jointgv CLI fetch shim
import { appendGateTelemetry, gateTelemetryDir } from './gate-telemetry.mjs'; // shared durable sink (t/3395)

/**
 * Pure command-string predicate for the pre-self-merge head-guard (t/3270, TL GV t/3270#2).
 *
 * FAILURE CLASS it closes: a manual `gh pr merge` completes against a CACHED/stale head that is
 * BEHIND the latest push, stranding later-pushed commits off main (#701/#830/#1810/#1868 — #1868
 * bypassed a TL-conditioned parity test). The root-AGENTS Pre-Self-Merge head-match check was only
 * ADVISORY (the pre-self-merge-verify hook merely nudged).
 *
 * DESIGN (why a command-string predicate, not an OID compare): requiring `gh pr merge
 * --match-head-commit <SHA>` lets GITHUB enforce head==SHA atomically at merge time — race-free, no
 * check-then-merge window, no fail-open. A hook that shelled out to compare `gh pr view headRefOid`
 * vs the local tip would be racy (head moves between check and merge) and must fail-open on a `gh`
 * error, defeating the gate. So the ONLY thing this predicate decides is a pure string question:
 * does a manual merge carry the flag? GitHub does the rest.
 *
 * `--auto` is NO LONGER unconditionally exempt (t/3695#30, superseding the t/3270#2 ruling below,
 * folding in t/4109 root rule #7). The original exemption reasoned that `--auto` "CANNOT carry
 * `--match-head-commit`" — false: `gh` accepts the combination (verified live, t/3695#30), and
 * t/4131 showed `--auto` on an already-green PR merges INSTANTLY with no arm event at all, which is
 * exactly this gate's stranding vector reached a different way. `--auto` now needs the pin too,
 * exactly like a manual merge; only `--disable-auto`, `--help` and `-h` stay exempt (they merge
 * nothing). The gated-PR auto-merging hazard this exemption used to carve out is still the SEPARATE
 * draft-discipline's job, unaffected by this change.
 *
 * Returns { block:boolean, reason:string }. The live `pre-self-merge-verify` feedback rule invokes
 * THIS FILE directly (`execFileSync('node', [<absolute path to this file>, command])`), not a
 * hand-copied inline script — confirmed via `get_feedback_rule` (t/3695#30) — so editing this
 * module's exported functions changes the rule's live behavior with no second copy to keep in sync.
 * The one remaining risk is staleness of the CHECKOUT the rule reads from (see the file-top note).
 */
// t/3695#19: `gh` accepts its repo selector on either side of `pr` — `gh -R o/r pr merge`,
// `gh --repo o/r pr merge`, `gh --repo=o/r pr merge`, `gh pr -R o/r merge`. The old
// `/\bgh(?:\.exe)?\s+pr\s+merge\b/` required `pr` immediately after `gh`, so every repo-scoped bare
// merge returned 'not-a-merge' and passed silently through ordinary use. Only -R/--repo are allowed
// between the words (not arbitrary flags) to keep false positives out. Any flag AFTER `merge` was
// already matched. Used ONLY by the pure-string head guard below: the --jointgv and --base-ref-stale
// paths look the PR up with `gh pr view <num>` in the CURRENT repo, so widening them would query the
// wrong repo for a -R merge — they deliberately keep the narrow regex (neither has a live caller as
// of t/3695#17: auto-merge-jointgv-guard disabled; --base-ref-stale unwired).
const REPO_FLAG = String.raw`(?:\s+(?:-R|--repo)(?:=|\s+)\S+)`;
export const GH_PR_MERGE_RE = new RegExp(
  String.raw`\bgh(?:\.exe)?` + REPO_FLAG + '*' + String.raw`\s+pr` + REPO_FLAG + '*' + String.raw`\s+merge\b`,
);

// t/3695#26-27: the verdict is per CLAUSE, not per shell line. Judging the whole line let any
// exempting flag anywhere on it (`--auto`, `--disable-auto`, a `--match-head-commit` belonging to a
// DIFFERENT merge) wave through every other `gh pr merge` on that line. A clause runs from a
// `gh … pr … merge` match to the next shell separator (; && || | & newline), or end of line
// (t/3695#30: clause boundaries now come from the tokenizer's own operator splitting, not a
// separate regex re-scan of the matched substring).

// Heredoc bodies fed to a DATA SINK (commit message, PR body, file write) are data, not commands.
// Observed while landing this change (t/3695#28): a commit message and a PR body that MENTIONED
// `gh pr merge N --disable-auto` were judged as merges. But a heredoc fed to an INTERPRETER
// (`bash <<EOF`, `sh -s`, `pwsh -Command -`) RUNS its body (TL review of #2966, t/3695#29), so
// stripping every heredoc opened a hole `main` did not have. ALLOWLIST: only the consumers below
// are data sinks; any other consumer — including an unknown one — leaves the body to be judged.
// A sink whose stdout is PIPED ONWARD counts only if every downstream stage is itself a sink:
// `tee f <<'EOF' | sh` passes the body straight to a shell (TL re-review of #2966, t/3695#30).
//
// Known blanks (judged by review, not by this guard):
//   - quoted single-line text (`-m "…gh pr merge 5…"`) is not stripped, so it can false-positive;
//   - the SCRIPT-FILE route: `cat > x.sh <<EOF` (stripped, a data sink) then `bash x.sh` runs a merge
//     the guard never saw. The guard judges command text, not the files a command later executes.
const SEG_SPLIT_RE = /;|&&|\|\||\|/;
const PIPE_RE = /(?<!\|)\|(?!\|)/;
const HEREDOC_DATA_SINKS = [
  /^\s*git\s+commit\b.*(?:\s-F\s*-|\s--file(?:=|\s+)-)(?:\s|$)/, // git commit -F - / --file=-
  /^\s*gh(?:\.exe)?\s.*(?:\s--body-file(?:=|\s+)-|\s-F\s*-)(?:\s|$)/, // gh … --body-file - / -F -
  /^\s*cat\s+(?:[^|]*\s)?>>?\s*\S/, // cat > file <<EOF  /  cat <<EOF > file
  /^\s*tee\s+\S/, // tee file <<EOF
];
// `git commit -m "$(cat <<'EOF'` / `gh pr create --body "$(cat <<'EOF'`: the heredoc's consumer is a
// bare `cat` inside a command substitution that is the message/body ARGUMENT of a data sink. Tested
// on the text BEFORE the marker only (the `)"` after it is irrelevant).
const SUBST_CAT_SINK = /^\s*(?:git\s+commit|gh(?:\.exe)?\s+(?:pr|issue)\s+(?:create|comment|edit))\b.*\$\(\s*cat\s*$/;

const isSinkStage = (stage) => HEREDOC_DATA_SINKS.some((re) => re.test(stage));

export function heredocConsumerIsDataSink(openerLine, markerIndex, markerLength) {
  const before = openerLine.slice(0, markerIndex).split(SEG_SPLIT_RE).pop();
  const rest = openerLine.slice(markerIndex + markerLength);
  const after = rest.split(SEG_SPLIT_RE)[0];
  // Stages the consumer's stdout is piped into, up to the end of this pipeline (; && ||).
  const downstream = rest.split(/;|&&|\|\|/)[0].split(PIPE_RE).slice(1);
  if (!downstream.every(isSinkStage)) return false;
  if (SUBST_CAT_SINK.test(before)) return true;
  return isSinkStage(`${before} ${after}`);
}

export function stripHeredocBodies(command) {
  const lines = (command || '').split(/\r?\n/);
  const out = [];
  let term = null;
  let strip = false;
  for (const line of lines) {
    if (term !== null) {
      if (line.trim() === term) { term = null; if (!strip) out.push(line); continue; }
      if (!strip) out.push(line);
      continue;
    }
    out.push(line);
    const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (m) { term = m[2]; strip = heredocConsumerIsDataSink(line, m.index, m[0].length); }
  }
  return out.join('\n');
}

// t/3695#30 (cycle 3): a bare-text regex search matches `gh pr merge` wherever the SUBSTRING
// appears — including inside a quoted grep/sed pattern, a `--body "…"` argument, or a comment
// string. Five such false positives were recorded live (10-07/10-12) before this fix. A real
// shell-word tokenizer closes the class structurally: a double-quoted argument like
// `"gh pr merge 1 --auto"` becomes ONE word (quotes stripped, spaces preserved inside), never
// three separate words `gh`, `pr`, `merge` — so it can never match in COMMAND POSITION, which is
// the only place this guard judges. `--help`/`-h` are judged separately in mergeClauseVerdict
// ("help merges nothing").
//
// Quote/escape handling is boundary-only (find where a word starts/ends), not full POSIX
// semantics — sufficient for this guard's one question (is `gh`/`pr`/`merge` a bare top-level
// word here?), not a general shell interpreter.
function tokenizeShellWords(command) {
  const s = command;
  const n = s.length;
  const tokens = [];
  let i = 0;
  while (i < n) {
    while (i < n && (s[i] === ' ' || s[i] === '\t' || s[i] === '\r')) i++;
    if (i >= n) break;
    if (s[i] === '\n') { tokens.push({ type: 'op', text: '\n' }); i++; continue; }
    if (s[i] === ';') { tokens.push({ type: 'op', text: ';' }); i++; continue; }
    if (s[i] === '&' && s[i + 1] === '&') { tokens.push({ type: 'op', text: '&&' }); i += 2; continue; }
    if (s[i] === '|' && s[i + 1] === '|') { tokens.push({ type: 'op', text: '||' }); i += 2; continue; }
    if (s[i] === '|') { tokens.push({ type: 'op', text: '|' }); i++; continue; }
    if (s[i] === '&') { i++; continue; } // bare & (background) is not a clause separator here
    const start = i;
    let value = '';
    while (i < n) {
      const c = s[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ';' || c === '&' || c === '|') break;
      if (c === '\\') { i++; if (i < n) { value += s[i]; i++; } continue; }
      if (c === "'") {
        i++;
        while (i < n && s[i] !== "'") { value += s[i]; i++; }
        i++;
        continue;
      }
      if (c === '"') {
        i++;
        while (i < n && s[i] !== '"') {
          if (s[i] === '\\' && i + 1 < n) { value += s[i + 1]; i += 2; } else { value += s[i]; i++; }
        }
        i++;
        continue;
      }
      if (c === '$' && s[i + 1] === "'") {
        i += 2;
        while (i < n && s[i] !== "'") {
          if (s[i] === '\\' && i + 1 < n) { value += s[i + 1]; i += 2; } else { value += s[i]; i++; }
        }
        i++;
        continue;
      }
      value += c;
      i++;
    }
    tokens.push({ type: 'word', text: value, start, end: i });
  }
  return tokens;
}

function splitIntoClauseWordGroups(tokens) {
  const groups = [];
  let current = [];
  for (const t of tokens) {
    if (t.type === 'op') { if (current.length) groups.push(current); current = []; }
    else current.push(t);
  }
  if (current.length) groups.push(current);
  return groups;
}

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function skipRepoFlag(words, i) {
  while (i < words.length) {
    const w = words[i].text;
    if (w === '-R' || w === '--repo') { i += 2; continue; }
    if (/^--repo=/.test(w)) { i += 1; continue; }
    break;
  }
  return i;
}

// Finds `gh`/`gh.exe` in COMMAND POSITION within one clause's words (after skipping leading
// `NAME=value` assignments and an optional `env` prefix with its own assignments), followed by
// `pr` then `merge` (with -R/--repo tolerated on either side, same tolerance as before). Returns
// the index of the `gh` word, or null if this clause is not a `gh pr merge` invocation.
function findMergeCommandStart(words) {
  let i = 0;
  while (i < words.length && ASSIGNMENT_RE.test(words[i].text)) i++;
  if (i < words.length && words[i].text === 'env') {
    i++;
    while (i < words.length && ASSIGNMENT_RE.test(words[i].text)) i++;
  }
  if (i >= words.length) return null;
  if (words[i].text !== 'gh' && words[i].text !== 'gh.exe') return null;
  const ghIndex = i;
  i = skipRepoFlag(words, i + 1);
  if (i >= words.length || words[i].text !== 'pr') return null;
  i = skipRepoFlag(words, i + 1);
  if (i >= words.length || words[i].text !== 'merge') return null;
  return ghIndex;
}

export function mergeClauses(command) {
  const cmd = stripHeredocBodies(command);
  const tokens = tokenizeShellWords(cmd);
  const groups = splitIntoClauseWordGroups(tokens);
  const out = [];
  for (const words of groups) {
    const ghIndex = findMergeCommandStart(words);
    if (ghIndex === null) continue;
    out.push(cmd.slice(words[ghIndex].start, words[words.length - 1].end));
  }
  return out;
}

// Pure verdict for ONE merge clause.
export function mergeClauseVerdict(clause) {
  const c = clause || '';
  // `--help`/`-h` merges nothing (t/3695#30, a live false positive on 10-12) — checked first,
  // since help always wins regardless of what else is on the line.
  if (/(?:^|\s)(?:--help|-h)(?:\s|$)/.test(c)) return { block: false, reason: 'help' };
  // `--disable-auto` only DISARMS auto-merge — it never merges (t/3695#26: 9 of the first advisory
  // window's 11 blocks were disarms; a blocking guard would have refused a safety action).
  if (/(?:^|\s)--disable-auto(?:\s|$)/.test(c)) return { block: false, reason: 'disable-auto' };
  // Guarded iff the head-match flag carries a value — BOTH `--match-head-commit SHA` and
  // `--match-head-commit=SHA` forms (a bare flag with no value would false-pass, so require \S).
  if (/--match-head-commit(?:=|\s+)\S/.test(c)) return { block: false, reason: 'guarded' };
  // t/3695#30 (t/4109 root rule #7): `--auto` is NO LONGER exempt on its own. It merges directly,
  // with no arm event at all, the moment an already-green PR's auto-merge is enabled (t/4131) --
  // exactly the stranding vector this guard exists to close, just reached a different way. `gh`
  // accepts `--match-head-commit` together with `--auto` (verified live, t/3695#30 precondition:
  // the pin reaches `enablePullRequestAutoMerge.expectedHeadOid` and a stale SHA is refused), so
  // there is no reason left to exempt it.
  if (/(?:^|\s)--auto(?:[=\s]|$)/.test(c)) return { block: true, reason: 'auto-missing-match-head-commit' };
  // Manual merge, no head guard → BLOCK (the stranding vector).
  return { block: true, reason: 'missing-match-head-commit' };
}

export function mergeGuardVerdict(command) {
  // Only manual `gh pr merge` (or gh.exe) is in scope — flag order / PR-number-optional /
  // repo-selector (-R/--repo, either side of `pr`) tolerant.
  const clauses = mergeClauses(command);
  if (clauses.length === 0) return { block: false, reason: 'not-a-merge' };
  const verdicts = clauses.map(mergeClauseVerdict);
  // Any blocking clause blocks the line; otherwise report the first clause's allow reason.
  return verdicts.find((v) => v.block) || verdicts[0];
}

// Join keys for the coverage reconciler (t/3695#26). prRef is the PR number or pull URL right after
// `merge`, else null (gh then targets the current branch's PR — unjoinable, so the reconciler counts
// it separately). repo is the -R/--repo value, else null.
export function parseMergeClause(clause) {
  const c = clause || '';
  const repo = (c.match(/(?:^|\s)(?:-R|--repo)(?:=|\s+)(\S+)/) || [])[1] || null;
  const url = c.match(/\bmerge\s+(\S*\/pull\/\d+)/);
  const num = c.match(/\bmerge\s+(\d+)(?:\s|$)/);
  return { prRef: url ? url[1] : num ? num[1] : null, repo };
}

/**
 * Auto-merge-on-joint-GV guard (t/3318, TL gate design t/3318#1 — prevention for the t/3307 incident).
 *
 * FAILURE CLASS it closes: `gh pr merge --auto` was enabled on a PR that was part of a JOINT GV
 * (co-merge group — #1947 had to land WITH ElectronMain #1940 per a locked cross-role contract).
 * Auto-merge fired the moment #1947's checks went green and merged it ALONE on its pre-consolidation
 * head — jumping the joint GV (main briefly broken) and stranding the reviewed consolidation. The
 * "gated PRs stay draft / never --auto a gated PR" rule is a convention auto-merge does not honor.
 *
 * DESIGN (t/3247 split, per TL): key on a MARKER, not draft-ness — a *solo* draft legitimately uses
 * --auto (TL recommends it). The hazard is the co-merge grouping. Marker = a `joint-gv` LABEL applied
 * when a PR is in a co-merge group / gated on a joint TL-GV. This decision is a PURE predicate
 * `(isAutoMerge ∧ isJointGvLabeled) → block`; the ONLY impure part is the label lookup, isolated in a
 * fetch shim (kept out of the pure predicate so both arms stay unit-testable, t/2971). Unlike the
 * t/3270 head-guard (which stays pure-string to avoid fail-open), this NEEDS PR-state I/O — so it
 * fails CLOSED on a gh error (blocks --auto with a distinct "couldn't verify" message), because
 * --auto-enable is rare + overridable and letting the t/3307 hazard through on a transient gh blip is
 * the worse failure. `--match-head-commit` manual self-merge is entirely unaffected (no --auto).
 *
 * NOT THE ENFORCER — READ THIS BEFORE FILING AN "ORDERING HOLE" BUG (t/3531). This command-level
 * predicate is POINT-IN-TIME: it only sees the label state at the `gh pr merge --auto` call, so
 * enabling --auto BEFORE the `joint-gv` label is applied does not trip it. That is a cosmetic
 * early-feedback gap, NOT a correctness hole. The ORDER-INDEPENDENT enforcer is the
 * `joint-gv-guard` REQUIRED STATUS CONTEXT (`.github/workflows/joint-gv-guard.yml`, t/3318/t/3607 PR B) —
 * an INDEPENDENT required context (authoritative check: branch-protection `required_status_checks` =
 * [ci-gate, CodeQL, joint-gv-guard], confirmed 2026-09-28 t/3700), re-fired on
 * labeled/unlabeled/auto_merge_enabled/auto_merge_disabled/edited events; it fails whenever joint-gv +
 * auto-merge coexist regardless of which came first and so blocks the merge. This predicate is
 * convenience UX layered ON TOP of that context; the context is what actually protects the t/3307 hazard.
 *
 * ROUTING HISTORY — do NOT re-assert the old form. This was the `joint-gv-automerge-guard` CI check
 * gated *via ci-gate* (t/3332) until t/3607 PR B moved the enforcement out to its own workflow + its own
 * required status context (`ci.yml:~1735` records the removal). A prior version of this header still
 * said "required via ci-gate" after the move; t/3607 changed the routing without updating this comment
 * (t/3700). Verify "where enforcement lives" against branch protection / the workflow files — NOT this
 * comment; comments drift, the required-contexts API does not.
 */
export function jointGvAutoMergeVerdict({ isAutoMerge, isJointGvLabeled } = {}) {
  if (isAutoMerge && isJointGvLabeled) return { block: true, reason: 'auto-merge-on-joint-gv' };
  if (isAutoMerge) return { block: false, reason: 'auto-merge-unlabeled-ok' };
  return { block: false, reason: 'not-auto-merge' };
}

// Is this an auto-merge enable of a `gh pr merge`? (reuses the t/3270 --auto detection verbatim)
export function isAutoMergeCommand(command) {
  const cmd = command || '';
  if (!/\bgh(?:\.exe)?\s+pr\s+merge\b/.test(cmd)) return false;
  return /(?:^|\s)--auto(?:[=\s]|$)/.test(cmd);
}

// Extract the PR ref from a `gh pr merge <ref> …` command: a pull URL, else a numeric id, else null
// (null → the caller lets `gh pr view` default to the current branch's PR). Only the leading ref
// position is read, so a `--match-head-commit <sha>` value can't be mistaken for the ref (and --auto
// commands can't carry that flag anyway — gh rejects the combination).
export function parsePrRef(command) {
  const cmd = command || '';
  const url = cmd.match(/\bpr\s+merge\s+(\S*\/pull\/\d+)/);
  if (url) return url[1];
  const num = cmd.match(/\bpr\s+merge\s+(\d+)(?:\s|$)/);
  if (num) return num[1];
  return null;
}

/**
 * PURE builder for a durable telemetry record (t/3395) — mirrors done-evidence's buildSinkRecord but
 * for the merge guards. The platform telemetry writer is dead (t/3394#2), so the shim appends this to
 * the shared sink after computing its verdict. `mode` is 'head-guard' (t/3270) or 'jointgv' (t/3318);
 * the HIGH-VALUE event is the jointgv fail-CLOSED block (couldn't verify labels → reason
 * 'failclosed-unverifiable', failClosed:true). Command is truncated (it's a `gh pr merge …` line, no
 * secrets, but bounded for log hygiene). Pure + exported so the shape is unit-tested.
 */
export function buildMergeGuardSinkRecord({ nowIso, mode, command, verdict, failClosed } = {}) {
  // t/3695#26: also record each extracted merge clause with its own verdict and join keys. The
  // 300-char shell-line prefix alone lost the `gh pr merge` clause on long lines (2 unclassifiable
  // records in the first advisory window).
  const clauses = typeof command === 'string'
    ? mergeClauses(command).map((c) => ({
      clause: c.slice(0, 300),
      reason: mergeClauseVerdict(c).reason,
      ...parseMergeClause(c),
    }))
    : [];
  return {
    clauses,
    ts: nowIso ?? null,
    gate: 'merge-guard',
    mode: mode ?? null,
    decision: verdict && verdict.block ? 'block' : 'allow',
    reason: verdict ? verdict.reason : null,
    failClosed: !!failClosed,
    command: typeof command === 'string' ? command.slice(0, 300) : null,
  };
}

/**
 * ⚠️ INERT — NOT WIRED, GUARDS NOTHING YET (t/3687#8, TL). The full guard mechanism now exists in this
 * module — `baseRefStaleVerdict`, `parseBaseRefRecords`, the `--base-ref-stale` CLI shim, `classifyGhError`
 * — AND the `record-base-ref` recorder jobs are LIVE on main (via #2456) and post `base-ref-record/*`
 * commit statuses on every PR. But NOTHING invokes the shim: there is NO feedback rule calling
 * `--base-ref-stale`, so nothing reads those statuses and NO merge is gated. The one remaining step —
 * wiring a feedback rule to the shim — is the enablement, and it is held behind TL Gate-Verification.
 * Until it lands, this reads like a live guard (green arms, posted statuses, tested) and guards nothing.
 * Do NOT conclude the retarget stale-green class is covered from the code's presence, its passing tests,
 * or the statuses appearing on PRs — that is the Class-9 shape (assert-from-artifact, not from behaviour;
 * 74d3b548). The pieces landed on main early via TWO premature merges of gated drafts (#2455 → the
 * predicate; #2456 → parser + recorders; the shim recovered separately after the same); TL ruled
 * leave-not-revert (t/3687#8), so the inert code stays and the wiring remains the sole gated step.
 *
 * Retarget stale-green guard — base-ref-NAME identity (t/3687; supersedes t/3684's rejected timestamp
 * design). Design of record locked via the e/212 Second-Opinion + TL review (t/3687#2).
 *
 * FAILURE CLASS: a PR's base branch is retargeted (GitHub auto-retargets on epic-base deletion; base
 * correction) AFTER the CI that validated it, so the green required checks ran against the OLD base —
 * stale for the new base — and with branch protection strict=false the PR can self-merge. The t/3270
 * head-guard (`--match-head-commit`) misses this: the HEAD is unchanged, the BASE moved.
 *
 * MECHANISM — base-ref NAME identity. Each instrumented required workflow records the base ref NAME it
 * ran against (`github.base_ref`). Block iff the LATEST record from any required recorder names a base
 * ref different from the PR's CURRENT `baseRefName`. Why the name, and not:
 *   - timestamps (t/3684): the created/finished axis produced FOUR wrong boundaries in one review.
 *   - the merge-ref SHA: `potentialMergeCommit = merge(current_main_tip, head)` recomputes whenever main
 *     ADVANCES (verified e/212#13/#14: its first parent IS the live main tip), so comparing it is
 *     `strict=true` by side-effect — t/3686's scope, deliberately separate.
 *   The base ref NAME is invariant under base advancement and changes ONLY on retarget — exactly this
 *   ticket's question and nothing more.
 *
 * SELECTION survives identity (e/212#14/#15 — identity dissolves the COMPARISON boundary, NOT selection):
 *   - WITHIN a recorder: take the LATEST record by `createdAt`. A post-retarget `synchronize` mints a
 *     fresh record naming the NEW base; old records are IMMUTABLE and keep the old name. "ANY record
 *     mismatches" would block a correctly-retargeted PR FOREVER (no operator remedy → override pressure).
 *     Latest-per-recorder is what makes the guard CLEARABLE: push → synchronize → fresh record names the
 *     new base → matches → allow. That re-run IS the remedy, obtained by making staleness unmergeable
 *     rather than by widening triggers (the block-forces-a-push rationale, t/3687).
 *   - ACROSS recorders: ANY latest-record mismatch blocks (all required, one stale suffices).
 * Ordering is by `createdAt` — one instant, no created/finished split. Duplicate records per recorder are
 * UNBOUNDED (t/3646 added `edited`/`auto_merge_disabled` triggers → more runs), so this maxes over a set;
 * ties at the max resolve to the SAFE side (any base ≠ current at the max instant → block).
 *
 * MISSING record → BLOCK, never allow (e/212#5): an expected recorder with no record means the set was
 * only partially evaluated; degrading to allow is the "verdict narrower than it reads" failure. Distinct
 * per-recorder reason so the shim's message can name the remedy.
 *
 * PURE: the impure shim fetches `currentBaseRefName` + `records` (with fail-closed I/O) and calls this.
 *
 * @param currentBaseRefName  the PR's current base ref name (e.g. 'main').
 * @param expectedRecorders   recorder ids that MUST have a record — the enumerated instrumented
 *                            workflows (ci.yml, joint-gv-guard, codeql.yml).
 * @param records             array of { recorder, baseRef, createdAt }; may hold multiple per recorder
 *                            (latest wins). `createdAt` is an ISO-8601 UTC string.
 */
export function baseRefStaleVerdict({ currentBaseRefName, expectedRecorders, records } = {}) {
  if (!currentBaseRefName) return { block: true, reason: 'no-current-base-ref' };
  const recs = Array.isArray(records) ? records : [];
  const expected = Array.isArray(expectedRecorders) ? expectedRecorders : [];
  if (expected.length === 0) return { block: true, reason: 'no-expected-recorders' };
  for (const recorder of expected) {
    const mine = recs.filter((r) => r && r.recorder === recorder && r.baseRef && r.createdAt);
    if (mine.length === 0) return { block: true, reason: `missing-record:${recorder}` };
    const times = mine.map((r) => new Date(r.createdAt).getTime());
    const maxT = Math.max(...times);
    if (!Number.isFinite(maxT)) return { block: true, reason: `unorderable-records:${recorder}` };
    // Latest record(s) for this recorder; a tie at second-granularity resolves to the SAFE side —
    // if ANY record at the max createdAt names a base other than current, the ordering is unknown → block.
    const latestMismatch = mine.some(
      (r) => new Date(r.createdAt).getTime() === maxT && r.baseRef !== currentBaseRefName,
    );
    if (latestMismatch) return { block: true, reason: `base-ref-mismatch:${recorder}` };
  }
  return { block: false, reason: 'all-recorders-match-current-base' };
}

/**
 * Pure parser for the base-ref records the impure shim fetches (t/3687).
 *
 * RECORD STORAGE (proposed — pending TL Gate-Verification): each instrumented recorder posts a COMMIT
 * STATUS on the PR head — context `base-ref-record/<recorder>`, description = the `github.base_ref` it ran
 * against, state `success`. Rationale: commit statuses ACCUMULATE (the `/commits/{sha}/statuses` API
 * returns full history, each entry carrying `created_at`), so duplicates-per-recorder and latest-by-time
 * selection fall out for free; posting is a one-liner (`gh api .../statuses -f context=... -f
 * description=...`); and it's not a required context, so it never gates merge on its own. Chosen over
 * check-run output (fragile text parsing, and the CodeQL context is app-posted anyway) and job summaries
 * (not cleanly API-retrievable per run). If TL's GV prefers a different sink, only this parser + the
 * fetch wrapper change — `baseRefStaleVerdict` is storage-agnostic.
 *
 * A `base-ref-record/*` status missing its description or created_at is SKIPPED (unusable) — which
 * degrades that recorder to `missing-record` → block in the verdict, never to a silent allow.
 *
 * @param statuses  array from `gh api repos/{o}/{r}/commits/{sha}/statuses` — { context, description,
 *                  created_at, state } objects.
 * @returns array of { recorder, baseRef, createdAt } for every well-formed `base-ref-record/*` status
 *          (ALL history; `baseRefStaleVerdict` does the latest-per-recorder selection).
 */
export function parseBaseRefRecords(statuses) {
  const arr = Array.isArray(statuses) ? statuses : [];
  const out = [];
  for (const s of arr) {
    if (!s || typeof s.context !== 'string') continue;
    const m = s.context.match(/^base-ref-record\/(.+)$/);
    if (!m) continue;
    if (!s.description || !s.created_at) continue; // no base-ref or no timestamp → unusable, skip (→ missing-record)
    out.push({ recorder: m[1], baseRef: s.description, createdAt: s.created_at });
  }
  return out;
}

/**
 * Pure classifier for a gh/API failure — the `--base-ref-stale` shim's fail-policy (SO+TL locked, e/212).
 * 4xx client/permission errors (except 408 request-timeout and 429 rate-limit) will NOT recover on retry
 * → fail fast; 5xx / 408 / 429 / network / no-HTTP-code are transient → bounded retry. Either way the shim
 * ultimately FAILS CLOSED (block) if it cannot get a verdict; this only governs whether it retries first
 * and what tag the discriminating `failclosed:<tag>` reason carries (so the block message can name an
 * infra failure rather than a retarget that never happened).
 *
 * @param text  gh stderr or Error.message.
 * @returns { retryable: boolean, reason: string }  reason = `http-<code>` or `no-http-code`.
 */
export function classifyGhError(text) {
  const s = String(text == null ? '' : text);
  const m = s.match(/HTTP (\d{3})/);
  if (m) {
    const code = Number(m[1]);
    if (code >= 400 && code <= 499 && code !== 408 && code !== 429) {
      return { retryable: false, reason: `http-${code}` }; // auth / permission / not-found — won't recover
    }
    return { retryable: true, reason: `http-${code}` }; // 5xx / 408 / 429 — transient
  }
  return { retryable: true, reason: 'no-http-code' }; // network / timeout / DNS — transient
}

// CLI shim (t/3270#4 / t/3318, TL GV): the feedback rules invoke THIS module directly so the rule
// runs the exact logic the both-arms test proves — test == runtime. (A hand-copied inline node -e
// would let a typo in the un-tested copy brick every merge or silently negate the gate; TL's
// load-bearing fix.) Convention: BLOCK == write 'fire' to stdout; ALLOW == exit 0, no stdout — the
// worktree-path-guard blocking contract. The endsWith guard makes this fire only on direct
// invocation (any path form), never when imported by the test.
//
// Two modes, both feed the same 'fire' contract but from DIFFERENT rules (distinct remediation text):
//   node <path>/merge-guard-predicate.mjs "<command>"              → t/3270 head-guard (pre-self-merge-verify)
//   node <path>/merge-guard-predicate.mjs --jointgv "<command>"    → t/3318 auto-merge joint-GV guard
// The head-guard path is byte-identical to before (its 13/13 test stays green); --auto is
// 'auto-exempt' there, so the two guards never double-fire on one command.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('merge-guard-predicate.mjs')) {
  // Durable telemetry (t/3395): append AFTER the verdict + any 'fire' write — writes to a file, never
  // stdout, and is best-effort inside appendGateTelemetry, so it cannot affect the 'fire' contract.
  const sink = (mode, command, verdict, failClosed) =>
    appendGateTelemetry({
      dir: gateTelemetryDir(import.meta.url),
      fileName: 'merge-guard.jsonl',
      record: buildMergeGuardSinkRecord({ nowIso: new Date().toISOString(), mode, command, verdict, failClosed }),
    });
  if (process.argv[2] === '--jointgv') {
    const cmd = process.argv[3] || '';
    if (isAutoMergeCommand(cmd)) {
      // Fetch shim (the only impure part): look up the PR's labels. Fail CLOSED on a gh error (after
      // one retry) — a joint-GV PR must not auto-merge, and an unverifiable label is treated as unsafe.
      let labeled;
      try {
        const ref = parsePrRef(cmd);
        const args = ['pr', 'view', ...(ref ? [ref] : []), '--json', 'labels', '-q', '.labels[].name'];
        let out = '';
        for (let attempt = 1; attempt <= 2; attempt++) {
          try { out = execFileSync('gh', args, { windowsHide: true, encoding: 'utf8', timeout: 8000 }); break; }
          catch (e) { if (attempt === 2) throw e; }
        }
        labeled = out.split(/\r?\n/).some((l) => l.trim() === 'joint-gv');
      } catch {
        process.stdout.write('fire'); // fail-closed: couldn't verify → block --auto
        labeled = null;
      }
      if (labeled === null) {
        // fail-closed block (the 'fire' above) — record the high-value unverifiable event
        sink('jointgv', cmd, { block: true, reason: 'failclosed-unverifiable' }, true);
      } else {
        const verdict = jointGvAutoMergeVerdict({ isAutoMerge: true, isJointGvLabeled: labeled });
        if (verdict.block) process.stdout.write('fire');
        sink('jointgv', cmd, verdict, false);
      }
    }
  } else if (process.argv[2] === '--base-ref-stale') {
    // t/3687 retarget stale-green guard. Same scope as the head-guard: manual `gh pr merge` only; --auto
    // is exempt (it re-targets on new pushes and can't carry --match-head-commit; its gatedness is the
    // draft-discipline's job). Diagnostic recorders post `base-ref-record/*` commit statuses on the PR
    // head; here we compare the LATEST per required recorder against the PR's CURRENT base ref name.
    const cmd = process.argv[3] || '';
    const isMerge = /\bgh(?:\.exe)?\s+pr\s+merge\b/.test(cmd);
    const isAuto = /(?:^|\s)--auto(?:[=\s]|$)/.test(cmd);
    if (isMerge && !isAuto) {
      // Enumerated recorders = the workflows carrying the record-base-ref step (t/3687#2, TL sink ruling).
      const EXPECTED_RECORDERS = ['ci.yml', 'joint-gv-guard', 'codeql.yml'];
      const ref = parsePrRef(cmd);
      // Impure fetch, FAIL CLOSED (SO+TL e/212): transient (5xx/408/429/network) → retry ≤3; 4xx → fast
      // fail. classifyGhError decides; an unrecoverable fetch → block with a DISCRIMINATING reason
      // (`failclosed:<tag>`) distinct from `base-ref-mismatch:*`, so the message never blames a retarget
      // that didn't happen. Uses --paginate so the full status history reaches parseBaseRefRecords.
      const ghJson = (args) => {
        for (let attempt = 1; ; attempt++) {
          try {
            return JSON.parse(execFileSync('gh', args, { windowsHide: true, encoding: 'utf8', timeout: 10000 }));
          } catch (e) {
            const cls = classifyGhError((e && (e.stderr || e.message)) || '');
            if (!cls.retryable || attempt >= 3) {
              const err = new Error(`gh failed (${cls.reason})`);
              err.failReason = cls.reason;
              throw err;
            }
          }
        }
      };
      let verdict;
      let failClosed = false;
      try {
        const view = ghJson(['pr', 'view', ...(ref ? [ref] : []), '--json', 'baseRefName,headRefOid']);
        const statuses = ghJson(['api', `repos/{owner}/{repo}/commits/${view.headRefOid}/statuses`, '--paginate']);
        verdict = baseRefStaleVerdict({
          currentBaseRefName: view.baseRefName,
          expectedRecorders: EXPECTED_RECORDERS,
          records: parseBaseRefRecords(statuses),
        });
      } catch (e) {
        failClosed = true;
        verdict = { block: true, reason: `failclosed:${(e && e.failReason) || 'unknown'}` };
      }
      if (verdict.block) process.stdout.write('fire');
      sink('base-ref-stale', cmd, verdict, failClosed);
    }
  } else {
    const command = process.argv[2] || '';
    const verdict = mergeGuardVerdict(command);
    if (verdict.block) process.stdout.write('fire');
    sink('head-guard', command, verdict, false);
  }
}
