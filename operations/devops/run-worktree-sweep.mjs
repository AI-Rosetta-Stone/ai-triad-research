// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/9: the daily scheduled worktree sweep (PI rule p/4#32; TL p/12#244; Security p/278#9; DevOps Lead
// owns the scheduled task, p/173#29). Run from .worktrees/main-tools, re-detached at origin/main.
//
//   node operations/devops/run-worktree-sweep.mjs [--report-only]
//
// 1. Refuses unless the running copy is origin/main's (Security condition 4, #5517's principle): this
//    file and every local module it imports are compared with origin/main by running-copy-current.mjs
//    (the check enqueue-pr uses), and sweep-landed-worktrees.sh, which is not imported, is compared here.
//    Any difference, a failed fetch or a failed read runs NOTHING and exits 1.
// 2. Runs sweep-landed-worktrees.sh, with --dry-run when --report-only (the first 3 days, TL p/12#244).
//    The sweep removes only worktrees whose PR merged (HEAD at or behind the PR head), that are clean, and
//    that had no file modified in 2 hours; never --force, never the shared checkout, never a remote branch.
// 3. Writes every line (removals, WARNs, skips with reasons) to <git common dir>/worktree-sweep/<date>.log
//    and prints a summary and, last, one JSON line for the scheduled task (counts, WARN lines, log path).
//
//
// sh (t/727): the sweep script needs sh. It is taken from PATH, or on Windows from Git for Windows' own
// folder with a WARN; when neither has one the run exits 1 naming where it looked. It never reports a
// sweep that did not run as a clean one.
//
// Exit: 0 = ran (WARNs included; the task pings them); 1 = refused or the sweep could not run.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRunningCopy, currencyRefusalMessage, currencyOkLine, REPO_ROOT } from './running-copy-current.mjs';

export const SELF = 'operations/devops/run-worktree-sweep.mjs';
export const SWEEP_SCRIPT = 'operations/devops/sweep-landed-worktrees.sh';
/** The line sweep-landed-worktrees.sh prints last, only when it walked the worktrees to the end. */
export const DONE_LINE = 'sweep-landed-worktrees: done';

/** PURE. Counts and WARN lines from the sweep's output. */
export function summarize(output) {
  const lines = String(output ?? '').split(/\r?\n/).filter(Boolean);
  const pick = (re) => lines.filter((l) => re.test(l));
  return {
    removed: pick(/^sweep-landed-worktrees: removed /).length,
    wouldRemove: pick(/^sweep-landed-worktrees: WOULD remove /).length,
    skipped: pick(/^sweep-landed-worktrees: skip /).length,
    warnings: pick(/^sweep-landed-worktrees: WARN /),
  };
}

/** PURE. The script blob must equal origin/main's. Returns { ok, reason?, detail? }. */
export function scriptCurrency(localText, mainText) {
  if (mainText === null) return { ok: false, reason: 'missing_on_main', detail: SWEEP_SCRIPT };
  if (localText === null) return { ok: false, reason: 'read_failed', detail: SWEEP_SCRIPT };
  const norm = (s) => s.replace(/\r\n/g, '\n');
  return norm(localText) === norm(mainText) ? { ok: true } : { ok: false, reason: 'differs', detail: SWEEP_SCRIPT };
}

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * t/727: finds the `sh` that runs the sweep script. The scheduled task starts from a plain pwsh PATH that
 * has Git\cmd but not Git\bin, where a bare `sh` is ENOENT (DevOps Lead p/173#45). Order: PATH first; then,
 * on Windows, Git for Windows' own sh, located from `git --exec-path` and the usual install folders.
 * Returns { sh, how: 'path' | 'git-install', searched } or { sh: null, searched }. Never guesses: a
 * candidate counts only if the file exists.
 */
export function resolveSh({ env = process.env, platform = process.platform, exists = existsSync, gitExecPath } = {}) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const name = win ? 'sh.exe' : 'sh';
  const searched = [];
  const firstExisting = (candidates) => {
    for (const c of candidates) {
      if (searched.includes(c)) continue;
      searched.push(c);
      if (exists(c)) return c;
    }
    return null;
  };
  const pathVar = env.PATH ?? env.Path ?? '';
  // Absolute entries only: a relative PATH entry would resolve against the spawn's cwd (the repo root).
  const onPath = firstExisting(pathVar.split(p.delimiter).filter((d) => d && p.isAbsolute(d)).map((d) => p.join(d, name)));
  if (onPath) return { sh: onPath, how: 'path', searched };
  if (!win) return { sh: null, searched };

  const roots = [];
  try {
    // e.g. C:/Program Files/Git/mingw64/libexec/git-core -> C:\Program Files\Git
    const execPath = (gitExecPath ?? (() => git(['--exec-path'])))().trim();
    if (execPath) roots.push(p.resolve(execPath.replace(/\//g, '\\'), '..', '..', '..'));
  } catch (err) {
    console.warn(`WARN run-worktree-sweep: could not ask git for its install folder (${err.message}); trying the usual install folders.`);
  }
  for (const v of ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)', 'LOCALAPPDATA']) {
    if (env[v]) roots.push(v === 'LOCALAPPDATA' ? p.join(env[v], 'Programs', 'Git') : p.join(env[v], 'Git'));
  }
  const fromGit = firstExisting(roots.flatMap((r) => [p.join(r, 'bin', name), p.join(r, 'usr', 'bin', name)]));
  return fromGit ? { sh: fromGit, how: 'git-install', searched } : { sh: null, searched };
}

export async function run({ reportOnly, currency = checkRunningCopy, gitFn = git, readLocal, sweep, findSh = resolveSh, now = new Date() } = {}) {
  const read = readLocal ?? ((p) => { try { return readFileSync(path.join(REPO_ROOT, p), 'utf8'); } catch { return null; } });
  const out = [];
  const log = (l) => { out.push(l); console.log(l); };

  // 1. Running-copy check (fail closed).
  const cur = currency({ entries: [SELF] });
  if (!cur?.ok) {
    console.error(currencyRefusalMessage(cur ?? { reason: 'no_result', detail: 'the check returned nothing' }));
    console.log(JSON.stringify({ ok: false, refused: cur?.reason ?? 'no_result' }));
    return 1;
  }
  let mainText = null;
  try { mainText = gitFn(['show', `${cur.mainSha}:${SWEEP_SCRIPT}`]); } catch { mainText = null; }
  const sc = scriptCurrency(read(SWEEP_SCRIPT), mainText);
  if (!sc.ok) {
    console.error(`run-worktree-sweep: refusing -- ${SWEEP_SCRIPT} ${sc.reason} vs origin/main ${cur.mainSha}. Nothing runs. Re-detach main-tools at origin/main and retry.`);
    console.log(JSON.stringify({ ok: false, refused: `script_${sc.reason}` }));
    return 1;
  }
  log(currencyOkLine(cur));
  log(`run-worktree-sweep: ${SWEEP_SCRIPT} matches origin/main ${cur.mainSha}`);

  // 2. The sweep.
  const mode = reportOnly ? 'report-only' : 'live';
  log(`run-worktree-sweep: mode=${mode} at ${now.toISOString()}`);
  let doSweep = sweep;
  if (!doSweep) {
    const found = findSh();
    if (!found.sh) {
      console.error([
        'run-worktree-sweep: the sweep did not run.',
        `  Goal: run ${SWEEP_SCRIPT} with sh.`,
        '  Problem: no sh was found, so nothing was swept and nothing was removed.',
        `  Location: looked for it at ${found.searched.length ? found.searched.join('; ') : '(PATH is empty)'}.`,
        '  Next steps: add Git for Windows\' bin folder (for example C:\\Program Files\\Git\\bin) to the PATH of the task that runs this, or install Git for Windows.',
      ].join('\n'));
      console.log(JSON.stringify({ ok: false, mode, failed: true, reason: 'sh_not_found' }));
      return 1;
    }
    if (found.how !== 'path') {
      const warn = `WARN run-worktree-sweep: sh is not on PATH; using Git for Windows' own at ${found.sh} (t/727). Add its folder to the task's PATH to stop this warning.`;
      out.push(warn);
      console.warn(warn);
    }
    doSweep = () => spawnSync(found.sh, [SWEEP_SCRIPT, ...(reportOnly ? ['--dry-run'] : [])], { cwd: REPO_ROOT, encoding: 'utf8' });
  }
  const r = doSweep();
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  for (const l of text.split(/\r?\n/).filter(Boolean)) out.push(l);
  if (r.status !== 0 || r.error) {
    console.error(`run-worktree-sweep: the sweep did not run cleanly (status ${r.status}${r.error ? `, ${r.error.message}` : ''}).`);
    console.log(JSON.stringify({ ok: false, mode, failed: true }));
    return 1;
  }
  // t/727 (SO t/727#3): exit 0 is not enough. The script prints DONE_LINE only after walking every
  // worktree; without it (no gh, not a repo, a shell that ran nothing) the sweep did not happen.
  if (!text.split(/\r?\n/).includes(DONE_LINE)) {
    console.error([
      'run-worktree-sweep: the sweep did not complete.',
      `  Goal: run ${SWEEP_SCRIPT} over every worktree.`,
      `  Problem: it exited 0 without printing its completion line ("${DONE_LINE}"), so nothing can be said about what it did.`,
      `  Location: ${SWEEP_SCRIPT}; its output was: ${text.trim() ? text.trim().split(/\r?\n/).slice(-3).join(' | ') : '(empty)'}`,
      '  Next steps: run the script by hand from the repo root with --dry-run; check that gh is on PATH and signed in.',
    ].join('\n'));
    console.log(JSON.stringify({ ok: false, mode, failed: true, reason: 'sweep_incomplete' }));
    return 1;
  }
  const s = summarize(text);

  // 3. Log file and summary.
  let logPath = null;
  try {
    const common = path.resolve(REPO_ROOT, gitFn(['rev-parse', '--git-common-dir']).trim());
    const dir = path.join(common, 'worktree-sweep');
    mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, `${now.toISOString().slice(0, 10)}.log`);
    writeFileSync(logPath, `${out.join('\n')}\n`, { flag: 'a' });
  } catch (err) {
    console.warn(`WARN run-worktree-sweep: could not write the log file (${err.message}); the summary below is the record.`);
  }
  for (const w of s.warnings) console.log(w);
  console.log(`run-worktree-sweep: ${mode}: ${reportOnly ? `${s.wouldRemove} would be removed` : `${s.removed} removed`}, ${s.warnings.length} WARN, ${s.skipped} skipped${logPath ? `; log ${logPath}` : ''}`);
  console.log(JSON.stringify({ ok: true, mode, mainSha: cur.mainSha, removed: s.removed, wouldRemove: s.wouldRemove, skipped: s.skipped, warnings: s.warnings, log: logPath }));
  return 0;
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--report-only');
  if (unknown.length) { console.error('usage: node operations/devops/run-worktree-sweep.mjs [--report-only]'); process.exit(1); }
  run({ reportOnly: args.includes('--report-only') }).then((code) => process.exit(code), (err) => { console.error(err?.stack ?? err); process.exit(1); });
}
