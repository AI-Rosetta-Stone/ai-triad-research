// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Pure command-string predicate for the shared-checkout git-hygiene guard (t/4149, moving root
 * AGENTS.md rules #4/#5/#16 from prose into code, t/4109#1).
 *
 * WHAT IT CATCHES, warn-only for now (T2 promotion to deny is separate, t/4149's own acceptance):
 * 1. HEAD-moving git verbs (checkout, reset, rebase, merge, pull, stash, restore) run directly on
 *    the shared checkout, not inside a `.worktrees/<name>` linked worktree — except
 *    `merge --ff-only` / `pull --ff-only`, the r/11 hourly sync procedure, which can't rewrite or
 *    discard anything.
 * 2. `git commit -a`/`--all`, `git add -A`/`--all`/`git add .` on the shared checkout — these
 *    stage/commit whatever the shared tree happens to hold at that moment, including another
 *    agent's uncommitted WIP (the exact t/2449/t/4212 failure class, one level removed).
 *
 * TOKENIZER: a straight copy of merge-guard-predicate.mjs's `tokenizeShellWords` /
 * `splitIntoClauseWordGroups` (quote-aware, clause-splitting on `;`/`&&`/`||`/`|`/newline) — same
 * TESTED logic, not a second regex (t/4149#1's own instruction). Copied rather than imported: that
 * module is the live pre-self-merge head-guard, and adding an export surface to a security-critical,
 * already-fleet-proven file for this guard's sake is a worse risk than ~90 lines of duplication.
 *
 * WORKTREE DETECTION (t/4212 lesson, p/156#68/#69, t/4212#13, extended here): this predicate does
 * NOT attempt to resolve a `cd`/`Set-Location`/`-C` target to a real absolute path, or even to a
 * per-clause tokenized target — t/4212 proved that kind of cwd-relative reconstruction is
 * unreliable. The naive next step (tokenize, then substring-match each `cd` TARGET TOKEN) turned
 * out to have its own trap, caught by this module's own test suite: `tokenizeShellWords` applies
 * POSIX backslash-escaping (correct for Bash, where a lone `\` before an ordinary character is
 * eaten as an escape — `.worktrees\foo` tokenizes to `.worktreesfoo`, LOSING the separator), but
 * this guard's matcher is Bash **and** PowerShell, where backslash is never an escape character at
 * all. A per-token check would silently mis-classify a real Windows PowerShell worktree `cd` as
 * "not a worktree" and warn on an otherwise-exempt command.
 *
 * Fixed by checking the RAW, UN-TOKENIZED command string for a `.worktrees/` (or `\`) substring
 * ANYWHERE, before any tokenizing happens at all — no escaping, no quoting, no per-clause state to
 * get wrong. This is deliberately COARSE: a multi-clause command that both touches a worktree AND
 * later `cd`s back out to mutate the shared root (e.g. `cd .worktrees/foo && git status; cd ..;
 * git reset --hard`) is exempted ENTIRELY, even though the final clause really does run on the
 * shared root. That's an accepted false-negative, not a bug: this guard is warn-only advisory, not
 * a blocking gate, so erring toward silence on an ambiguous/unusual command is the safer failure
 * direction than erring toward a confusing false-positive warning on a legitimate worktree-touching
 * command. (If this is ever promoted to a blocking deny, T2 per t/4149's own acceptance criteria,
 * that promotion PR should revisit this trade-off — a per-clause design is worth getting right once
 * there's something real at stake in getting it wrong.)
 *
 * SCOPE: the sibling data repos (`ai-triad-data`, `ai-triad-sources`) have their own procedures
 * (r/24, `/data-mutation`) and are explicitly out of scope (t/4149's own ask) — same raw-substring
 * mechanism, same coarse trade-off.
 */

const SUBSHELL_CHAR_RE = /[(){}]/;

/** Copied verbatim from merge-guard-predicate.mjs (see module header). */
export function tokenizeShellWords(command) {
  const s = String(command ?? '');
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
    if (s[i] === '&') { i++; continue; }
    if (s[i] === '$' && s[i + 1] === '(') { i += 2; continue; }
    if (SUBSHELL_CHAR_RE.test(s[i])) { i++; continue; }
    let value = '';
    while (i < n) {
      const c = s[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ';' || c === '&' || c === '|') break;
      if (SUBSHELL_CHAR_RE.test(c)) break;
      if (c === '$' && s[i + 1] === '(') break;
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
          if (s[i] === '\\' && i + 1 < n && '$`"\\\n'.includes(s[i + 1])) { value += s[i + 1]; i += 2; }
          else { value += s[i]; i++; }
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
    tokens.push({ type: 'word', text: value });
  }
  return tokens;
}

/** Copied verbatim from merge-guard-predicate.mjs (see module header). */
export function splitIntoClauseWordGroups(tokens) {
  const groups = [];
  let current = [];
  for (const t of tokens) {
    if (t.type === 'op') { if (current.length) groups.push(current); current = []; }
    else current.push(t.text);
  }
  if (current.length) groups.push(current);
  return groups;
}

function commandBasename(word) {
  return String(word ?? '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
}

/** Substring match, slash- and case-insensitive — the t/4212-lesson worktree check, applied here. */
function targetContains(target, needle) {
  return String(target ?? '').replace(/\\/g, '/').toLowerCase().includes(needle);
}

/** Whole-command, pre-tokenize check (module header: why this must run on the RAW string). */
function isWorktreeOrSiblingRepoCommand(rawCommand) {
  return targetContains(rawCommand, '.worktrees/') || isSiblingDataRepoTarget(rawCommand);
}

function isSiblingDataRepoTarget(target) {
  return targetContains(target, 'ai-triad-data') || targetContains(target, 'ai-triad-sources');
}

const HEAD_MOVING_VERBS = new Set(['checkout', 'reset', 'rebase', 'merge', 'pull', 'stash', 'restore']);

/** Returns the matched HEAD-moving verb, or '' if this clause isn't a git invocation with one in
 *  scope (including the `merge --ff-only` / `pull --ff-only` exemption — the r/11 sync procedure,
 *  which cannot rewrite or discard anything). */
function headMovingGitVerb(words) {
  if (!words.length || commandBasename(words[0]) !== 'git') return '';
  // Skip a leading `-C <dir>` pair before looking for the subcommand verb.
  let i = 1;
  if (words[i] === '-C') i += 2;
  const verb = (words[i] ?? '').toLowerCase();
  if (!HEAD_MOVING_VERBS.has(verb)) return '';
  if ((verb === 'merge' || verb === 'pull') && words.slice(i + 1).includes('--ff-only')) return '';
  return verb;
}

/** `git commit -a`/`--all`, or `git add -A`/`--all`/`.` — rule 2 (t/4149). An overlay commit
 *  (`--git-dir=.orca-git ...`) is exempt entirely: it runs on the shared root BY DESIGN
 *  (t/4149#1's own carve-out), and root AGENTS.md's overlay-tracking convention is a separate,
 *  already-reviewed procedure this guard isn't meant to flag. */
function isCommitDashAOrAddAll(words) {
  if (!words.length || commandBasename(words[0]) !== 'git') return false;
  if (words.some((w) => String(w).startsWith('--git-dir='))) return false;
  let i = 1;
  if (words[i] === '-C') i += 2;
  const verb = (words[i] ?? '').toLowerCase();
  const rest = words.slice(i + 1);
  // t/4149 follow-up: `-am`/`-as`/etc. are valid getopt-style bundled short flags (e.g.
  // `git commit -am "msg"`, by far the more common idiom than bare `-a`) — a plain
  // `rest.includes('-a')` missed every bundled form. Match any single-dash token whose letters
  // include 'a' (never '--', which can't be a bundle).
  const hasBundledShortA = (w) => /^-[a-zA-Z]+$/.test(w) && w.includes('a');
  if (verb === 'commit') return rest.some(hasBundledShortA) || rest.includes('--all');
  if (verb === 'add') return rest.includes('-A') || rest.includes('--all') || rest.includes('.');
  return false;
}

/**
 * Full evaluation for a Bash/PowerShell command. First checks the RAW command string for any
 * worktree/sibling-data-repo mention anywhere (module header: whole-command, coarse, pre-tokenize —
 * exempts the entire command rather than risk the tokenizer's lossy backslash handling). Only once
 * that's ruled out does it tokenize and walk clauses for the two in-scope rules. Returns:
 *   { action: 'silent', reason } — nothing in scope fired.
 *   { action: 'warn', reason: 'head-moving-verb' | 'commit-a-or-add-all', op, clause }
 */
export function evaluateSharedGitHygiene({ command }) {
  if (isWorktreeOrSiblingRepoCommand(command)) {
    return { action: 'silent', reason: 'no-mutating-clause-on-shared-root' };
  }
  const clauses = splitIntoClauseWordGroups(tokenizeShellWords(command));
  for (const words of clauses) {
    const verb = headMovingGitVerb(words);
    if (verb) return { action: 'warn', reason: 'head-moving-verb', op: verb, clause: words.join(' ') };

    if (isCommitDashAOrAddAll(words)) {
      return { action: 'warn', reason: 'commit-a-or-add-all', op: words[1] === '-C' ? words[3] : words[1], clause: words.join(' ') };
    }
  }
  return { action: 'silent', reason: 'no-mutating-clause-on-shared-root' };
}

/** Human-readable warning text (T1, warn-only). */
export function buildSharedGitHygieneWarning({ reason, op, clause }) {
  if (reason === 'head-moving-verb') {
    return `⚠ SHARED-CHECKOUT GIT HYGIENE (t/4149, warn-only): \`git ${op}\` moves/discards HEAD state `
      + `on the SHARED main checkout, not a worktree ('${clause}'). This is the mechanism behind the `
      + `t/2449 reconciliation incident — run it in a linked worktree (git worktree add -b <branch> `
      + `.worktrees/<name>) instead. (Warn-only: not blocked yet.)`;
  }
  return `⚠ SHARED-CHECKOUT GIT HYGIENE (t/4149, warn-only): \`${clause}\` stages/commits whatever the `
    + `SHARED main checkout currently holds, which can silently sweep up another agent's uncommitted `
    + `WIP. Commit with an explicit pathspec instead ('git commit -m "..." -- <paths>'), never -a/-A/\`. `
    + `(Warn-only: not blocked yet.)`;
}

// CLI shim (test==runtime, same convention as worktree-target-guard.mjs): the two
// shared-git-hygiene feedback rules each invoke
//   node <path>/shared-git-hygiene-predicate.mjs "<command>"
// and grep the single-line stdout for THEIR OWN reason string ('head-moving-verb' or
// 'commit-a-or-add-all'). Nothing on stdout == no finding (silent or the other rule's reason).
// Each rule's own `template` field carries the human-readable warning text (buildSharedGitHygieneWarning
// is for direct/manual use and tests, not consumed by the CLI shim — the Orca feedback-rule template
// can't take dynamic text from a script, only a fixed string per rule).
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('shared-git-hygiene-predicate.mjs')) {
  const verdict = evaluateSharedGitHygiene({ command: process.argv[2] || '' });
  if (verdict.action === 'warn') process.stdout.write(verdict.reason);
}
