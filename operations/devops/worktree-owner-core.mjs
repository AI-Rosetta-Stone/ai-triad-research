// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Pure predicates for the worktree-owner guard (t/4212, TL design review t/4212#2).
 *
 * WHY: three collisions in one day in a single shared bundle worktree (#3266) — one role's `git
 * stash`/restore swept up another role's uncommitted work, because nothing records or checks WHO a
 * linked worktree belongs to. `git stash` has no git hook at all, so the mechanism is a PreToolUse
 * feedback rule (this module) that resolves the command's target worktree — NOT the session cwd,
 * which always resets to the role's scope directory (TL cond. 1) — and compares its recorded owner
 * to the calling agent.
 *
 * OWNERSHIP RECORDING: a `post-checkout` hook write (see .githooks/post-checkout) covers both a raw
 * `git worktree add` and the `/land-from-worktree` skill's `git worktree add -b` (both are checkouts
 * with a previous HEAD of all zeros, TL cond. 2) — one mechanism, no separate skill-side write needed.
 * The owner file lives at `<repoRoot>/.git/worktrees/<name>/orca-owner`, the worktree's own git-admin
 * directory (not its working tree), so it's never a tracked/untracked file an agent could delete.
 *
 * WORKTREE RESOLUTION: by convention (enforced by the existing worktree-path-guard, t/3154/t/3254),
 * every worktree this repo creates lives under `<repoRoot>/.worktrees/<name>`. Resolving worktree
 * identity by that path convention — not by shelling out to `git -C <dir> rev-parse --git-dir` — keeps
 * these predicates pure, fast, and trivially unit-testable (no git subprocess, no fixture repo).
 *
 * IDENTITY (TL cond. 3): the calling agent's stable id is `ORCA_AGENT_ID` (also exposed to a feedback
 * rule's run.args as the `agent.id` parameter source — confirmed empirically, t/4212 probe) — a UUID,
 * stable across a session, unlike the human-readable `agent.address`/`role.path` (used only for the
 * warning text). An absent or empty id — caller OR recorded owner — counts as UNKNOWN, never a match
 * (fail-closed): `ownerVerdict` never returns 'match' unless BOTH ids are non-empty and equal.
 *
 * OVERRIDE (TL cond. 5): `ORCA_WT_OVERRIDE=<ticket>` must appear as a literal inline assignment in the
 * command text itself (Bash `ORCA_WT_OVERRIDE=t/1234 <cmd>` or PowerShell
 * `$env:ORCA_WT_OVERRIDE='t/1234'; <cmd>`) — not read from ambient process.env — so every bypass is
 * visible in the reviewed command and leaves a telemetry trail with the ticket it names. It is NOT
 * identity-gated: anyone can use it, which is the point (DevOps' documented cleanup procedure is the
 * one legitimate user, and the trail is what keeps that honest).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root inferred from this module's install location (<root>/operations/devops/…), same idiom
 *  as worktree-target-guard.mjs. Overridable for tests. */
export function repoRootFromHere(metaUrl) {
  const here = fileURLToPath(metaUrl).replace(/\\/g, '/');
  return here.split('/').slice(0, -3).join('/');
}

function toSlash(p) {
  return String(p ?? '').replace(/\\/g, '/');
}

/** OS-independent canonical absolute form (slash-fold, lowercase, `.`/`..` collapse) — same idiom as
 *  worktree-target-guard.mjs's canonAbs. Returns null if `p` is not absolute. */
export function canonAbs(p) {
  const s = toSlash(p).toLowerCase();
  const driveM = s.match(/^([a-z]:)\//);
  const prefix = driveM ? driveM[1] : (s.startsWith('/') ? '' : null);
  if (prefix === null) return null;
  const body = driveM ? s.slice(driveM[0].length) : s.slice(1);
  const out = [];
  for (const seg of body.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return prefix + '/' + out.join('/');
}

/**
 * Extract the `cd`/`Set-Location`/`-C`/`--git-dir`/`--work-tree` target directory from a shell
 * command string. Returns '' if none of those forms are present (the command then runs wherever the
 * real session cwd is, which TL cond. 1 notes is always the role's scope dir — never a worktree, so
 * no finding is correct there).
 *
 * Precedence: an explicit `git -C <dir>` / `--git-dir=<dir>` / `--work-tree=<dir>` on the git
 * invocation itself is the most precise signal and wins over a leading `cd`; a leading `cd </
 * Set-Location` prefix is the fallback (today's real collisions, `cd .worktrees/<x> && git stash…`).
 */
export function extractCdTarget(command) {
  const cmd = String(command ?? '');

  const gitDirM = cmd.match(/--git-dir[= ]\s*["']?([^"'\s]+)["']?/);
  if (gitDirM) return gitDirM[1];
  const workTreeM = cmd.match(/--work-tree[= ]\s*["']?([^"'\s]+)["']?/);
  if (workTreeM) return workTreeM[1];
  const dashCM = cmd.match(/git\s+-C\s+["']?([^"'\s]+)["']?/);
  if (dashCM) return dashCM[1];

  // Leading `cd <dir> &&`/`;` or PowerShell `Set-Location <dir>` (also `;`-chained, also `cd` alias).
  const cdM = cmd.match(/^\s*(?:cd|Set-Location|sl)\s+["']?([^"';&|]+?)["']?\s*(?:&&|;|\n|$)/i);
  if (cdM) return cdM[1].trim();

  return '';
}

/**
 * Resolve an absolute (or cwd-relative) path to `{ name, root }` if it falls under
 * `<repoRoot>/.worktrees/<name>` — `name` is the first path segment under `.worktrees/`, `root` the
 * full canonical `.worktrees/<name>` prefix. Returns null if the path is not under `.worktrees/` at
 * all (covers the main-checkout exemption automatically: the shared checkout is never under
 * `.worktrees/`).
 */
export function resolveWorktree(absOrRelPath, repoRoot, cwd) {
  const resolved = path.isAbsolute(absOrRelPath)
    ? absOrRelPath
    : path.resolve(cwd ?? process.cwd(), absOrRelPath);
  const canon = canonAbs(resolved);
  const root = canonAbs(repoRoot);
  if (canon == null || root == null) return null;
  const wtRoot = `${root}/.worktrees`;
  if (canon !== wtRoot && !canon.startsWith(`${wtRoot}/`)) return null;
  const rest = canon === wtRoot ? '' : canon.slice(wtRoot.length + 1);
  const name = rest.split('/')[0];
  if (!name) return null;
  return { name, root: `${wtRoot}/${name}` };
}

/**
 * Resolve a worktree name from ANY string containing `.worktrees/<name>` as a substring — absolute
 * or relative, forward- or back-slash, regardless of what it's relative TO. (t/4212 platform finding,
 * Orca Support p/156#68 / t/4212#13: a PreToolUse rule's `file_path` parameter is delivered relative
 * to the calling agent's OWN scope cwd, not the repo root and not this script's own `process.cwd()`
 * — e.g. `../../../.worktrees/<name>/file` — so reconstructing an absolute path via
 * `path.resolve(cwd, …)`, as `resolveWorktree` below does, is unreliable: there is no cwd this script
 * can use that is guaranteed to match the base the engine computed the relative path from. A
 * `.worktrees/` substring match needs no base at all — it works identically on the relative form, an
 * absolute form, and either slash direction, since the segment immediately after `.worktrees/` is the
 * name regardless of what precedes it.) Returns `{ name }`, or null if `.worktrees/` doesn't appear in
 * the string at all — callers resolve the owner file against their OWN trusted `repoRoot` (never
 * derived from this string), per Support's fix guidance (resolve ownership from `repoRoot` + `name`,
 * not from path shape or cwd).
 */
export function resolveWorktreeFromPathString(pathStr) {
  const slashed = toSlash(pathStr).toLowerCase();
  const idx = slashed.indexOf('.worktrees/');
  if (idx === -1) return null;
  const rest = slashed.slice(idx + '.worktrees/'.length);
  const name = rest.split('/')[0];
  if (!name) return null;
  return { name };
}

/** The worktree's git-admin directory (where its `orca-owner` file lives), from the repo root and
 *  worktree name — this is `<repoRoot>/.git/worktrees/<name>`, NOT the worktree's own working tree. */
export function ownerFilePath(repoRoot, worktreeName) {
  return path.join(repoRoot, '.git', 'worktrees', worktreeName, 'orca-owner');
}

/** Read the recorded owner id, or '' if the file is absent/unreadable/empty (never throws). */
export function readOwner(repoRoot, worktreeName) {
  try {
    return fs.readFileSync(ownerFilePath(repoRoot, worktreeName), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Fail-closed owner comparison (TL cond. 3): 'match' iff BOTH ids are non-empty and equal; otherwise
 * 'unknown' (missing/empty owner — most often a worktree predating this guard, or the post-checkout
 * hook failing open) or 'mismatch' (both known, different).
 */
export function ownerVerdict(ownerId, callerId) {
  const o = String(ownerId ?? '').trim();
  const c = String(callerId ?? '').trim();
  if (!o || !c) return 'unknown';
  return o === c ? 'match' : 'mismatch';
}

/** Mutating git subcommands this guard warns on (route-enumeration row 1, t/4212). `checkout` only
 *  counts when it is a PATHSPEC restore (`checkout -- <path>`), never a branch switch — matching the
 *  existing warn-git-checkout-pathspec rule's own scope. `stash` with no verb defaults to `push`. */
const MUTATING_GIT_RE =
  /\bgit\b[^&;|\n]*?\b(?:commit\b|stash\b(?:\s+(?:push|pop|apply|drop))?|checkout\s+--\s|restore\b|reset\b|merge\b|rebase\b|clean\b|worktree\s+(?:remove\s+--force|prune)\b)/;

/** Returns the matched operation name (for telemetry/message), or '' if the command has no mutating
 *  git subcommand in scope. Read-only commands (status/diff/log/show) and test runs never match. */
export function detectMutatingGitOp(command) {
  const m = String(command ?? '').match(MUTATING_GIT_RE);
  if (!m) return '';
  const tail = m[0];
  if (/commit\b/.test(tail)) return 'commit';
  if (/stash\b/.test(tail)) return 'stash';
  if (/checkout\s+--\s/.test(tail)) return 'checkout--';
  if (/restore\b/.test(tail)) return 'restore';
  if (/reset\b/.test(tail)) return 'reset';
  if (/merge\b/.test(tail)) return 'merge';
  if (/rebase\b/.test(tail)) return 'rebase';
  if (/clean\b/.test(tail)) return 'clean';
  if (/worktree\s+remove/.test(tail)) return 'worktree-remove';
  if (/worktree\s+prune/.test(tail)) return 'worktree-prune';
  return 'unknown-mutation';
}

const SINGLE_ARG_OPTS = new Set(['--reason']);

/** The `<target>` of `git worktree remove --force <target>` / `git worktree prune` (prune takes no
 *  path argument, so '' there is correct). Mirrors worktree-target-guard.mjs's own add-target parse. */
export function extractWorktreeRemoveTarget(command) {
  const cmd = String(command ?? '');
  const m = cmd.match(/git\s+worktree\s+remove\b([^&;|\n]*)/);
  if (!m) return '';
  const rest = m[1].trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < rest.length) {
    if (rest[i] === '--') { i++; break; }
    if (SINGLE_ARG_OPTS.has(rest[i])) { i += 2; continue; }
    if (rest[i].startsWith('-')) { i++; continue; } // incl. --force
    return rest[i];
  }
  return i < rest.length ? rest[i] : '';
}

/**
 * Route-enumeration row "deleting the worktree directory" (t/4212 blank #2, closed per TL cond. 4):
 * an `rm`/`Remove-Item` whose target resolves to EXACTLY a `.worktrees/<name>` root or under one.
 * Returns the raw target string, or '' if the command isn't an rm/Remove-Item at all.
 */
export function extractRmTarget(command) {
  const cmd = String(command ?? '');
  // `rm -rf <path>` / `rm -r -f <path>` (last non-flag token).
  const rmM = cmd.match(/\brm\b(?:\s+-{1,2}[A-Za-z-]+)*\s+["']?([^"'\s]+)["']?/);
  if (rmM) return rmM[1];
  // PowerShell `Remove-Item <path> -Recurse -Force` (first non-flag token after the cmdlet).
  const riM = cmd.match(/\bRemove-Item\b\s+["']?([^"'\s-][^"'\s]*)["']?/i);
  if (riM) return riM[1];
  return '';
}

/** Literal inline override token (TL cond. 5): `ORCA_WT_OVERRIDE=<ticket>` (Bash) or
 *  `$env:ORCA_WT_OVERRIDE='<ticket>'`/`="<ticket>"` (PowerShell), anywhere in the command text. Returns
 *  the ticket ref, or '' if no override is present. */
export function extractOverrideTicket(command) {
  const cmd = String(command ?? '');
  // PowerShell form checked FIRST: `$env:ORCA_WT_OVERRIDE=` contains the literal substring
  // `ORCA_WT_OVERRIDE=` the bash pattern below would also match (with the quote/semicolon folded in,
  // since bash's `=(\S+)` doesn't know to stop at a closing quote) — so the more specific form wins.
  const psM = cmd.match(/\$env:ORCA_WT_OVERRIDE\s*=\s*['"]?([^'";\s]+)['"]?/i);
  if (psM) return psM[1];
  const bashM = cmd.match(/(?<!\$env:)\bORCA_WT_OVERRIDE=(\S+)/);
  if (bashM) return bashM[1];
  return '';
}

/**
 * Full evaluation for a Bash/PowerShell command: resolves the target worktree (via `cd`/`-C`/
 * `--git-dir` parsing), checks for a mutating git op or a worktree-targeted rm, and compares the
 * recorded owner to the caller. Returns:
 *   { action: 'silent', reason } — not a worktree, no mutating op, override used, or owner matches.
 *   { action: 'warn', reason, op, worktreeName, ownerId, overrideTicket? }
 * `overrideTicket` is present (and action is 'silent') when the bypass was used, so the caller can
 * still log it to telemetry even though no warning is shown.
 *
 * Resolves the extracted target via `resolveWorktreeFromPathString` (substring match), NOT
 * `resolveWorktree` (cwd-relative reconstruction) — same t/4212 platform-finding rationale as
 * `evaluateFilePath` above (p/156#68/#69, t/4212#13): this guard script's own `process.cwd()` at
 * invocation time was never actually PROVEN to match the real shell cwd the agent's `cd`/`-C` target
 * is relative to (the Worker's one successful live-fire used an absolute, forward-slash `cd` target,
 * which needs no cwd resolution at all — a plain relative `cd .worktrees/<name> && …`, today's real
 * collision shape per this module's own header, was never actually exercised end-to-end). The
 * substring match needs no cwd at all, so it's correct whether the agent's target was relative or
 * absolute. The no-`cd`-at-all fallback (`targetPath = '.'`) is unchanged in effect: `'.'.`
 * contains no `.worktrees/` substring, so it still (correctly) returns `not-under-worktrees-root` —
 * matching TL cond. 1's own framing that the real session cwd is always the role's scope dir, never a
 * worktree, so no finding there is correct either way.
 */
export function evaluateShellCommand({ command, callerId, repoRoot }) {
  const op = detectMutatingGitOp(command);
  const rmTarget = extractRmTarget(command);
  if (!op && !rmTarget) return { action: 'silent', reason: 'not-a-mutating-command' };

  // Priority: an explicit cd/-C/--git-dir prefix is the cwd the WHOLE command runs in, and wins over
  // an operation's own trailing path argument (if both are present, the prefix is what's real). Only
  // fall back to the operation's own argument — `git worktree remove --force <path>` / `rm -rf <path>`
  // — when there's no such prefix, since those two ops target a path directly, independent of cwd.
  const cdTarget = extractCdTarget(command);
  const targetPath = cdTarget
    || (op === 'worktree-remove' ? extractWorktreeRemoveTarget(command) : '')
    || (!op && rmTarget ? rmTarget : '')
    || '.';
  const wt = resolveWorktreeFromPathString(targetPath);
  if (!wt) return { action: 'silent', reason: 'not-under-worktrees-root' };

  const overrideTicket = extractOverrideTicket(command);
  if (overrideTicket) {
    return { action: 'silent', reason: 'override-used', op: op || 'rm', worktreeName: wt.name, overrideTicket };
  }

  const ownerId = readOwner(repoRoot, wt.name);
  const verdict = ownerVerdict(ownerId, callerId);
  if (verdict === 'match') return { action: 'silent', reason: 'owner-match', op: op || 'rm', worktreeName: wt.name };

  return {
    action: 'warn',
    reason: verdict, // 'unknown' | 'mismatch'
    op: op || 'rm',
    worktreeName: wt.name,
    ownerId,
  };
}

/** Full evaluation for an Edit/Write/NotebookEdit `file_path` — route-enumeration blank #1 (t/4212,
 *  closed per TL cond. 4). Same owner comparison, no git-op detection (any write under another role's
 *  worktree is in scope).
 *
 *  Uses `resolveWorktreeFromPathString` (substring match), NOT `resolveWorktree` (cwd-relative
 *  reconstruction) — t/4212 platform finding (p/156#68/#69, t/4212#13): Orca delivers `file_path`
 *  relative to the calling agent's own scope cwd, which this script has no reliable way to recover,
 *  so `path.resolve(cwd, filePath)` silently resolved to the WRONG absolute path and never matched
 *  `.worktrees/` at all — the guard ran, saw an unrelated path, and correctly (from its own
 *  perspective) returned `not-under-worktrees-root` on every real Edit/Write call. `cwd` is no
 *  longer used here; `repoRoot` still is, but only to locate the OWNER FILE (`ownerFilePath` below),
 *  never to reconstruct or validate the received path shape. */
export function evaluateFilePath({ filePath, callerId, repoRoot }) {
  const wt = resolveWorktreeFromPathString(filePath);
  if (!wt) return { action: 'silent', reason: 'not-under-worktrees-root' };

  const overrideTicket = extractOverrideTicket(filePath);
  if (overrideTicket) {
    return { action: 'silent', reason: 'override-used', op: 'edit', worktreeName: wt.name, overrideTicket };
  }

  const ownerId = readOwner(repoRoot, wt.name);
  const verdict = ownerVerdict(ownerId, callerId);
  if (verdict === 'match') return { action: 'silent', reason: 'owner-match', op: 'edit', worktreeName: wt.name };

  return { action: 'warn', reason: verdict, op: 'edit', worktreeName: wt.name, ownerId };
}

/** Human-readable warning text (T1, warn-only — see .githooks/pre-commit's own wording style). */
export function buildWarningMessage({ op, worktreeName, reason, callerRole, callerAddress }) {
  const who = reason === 'unknown'
    ? 'has no recorded owner (predates this guard, or ownership recording failed)'
    : 'is recorded as owned by a different role';
  return `⚠ WORKTREE OWNERSHIP GUARD (t/4212, warn-only): '${op}' in .worktrees/${worktreeName} ${who}. `
    + `You (${callerRole || 'unknown role'}, ${callerAddress || 'unknown address'}) are not its recorded owner. `
    + `Three same-day collisions (#3266) are why this exists — a non-owner stash/restore/reset here can silently `
    + `discard another role's uncommitted work. STOP and confirm with the owner before proceeding, or use `
    + `ORCA_WT_OVERRIDE=<ticket> for DevOps' documented cleanup procedure. (Warn-only: not blocked yet.)`;
}
