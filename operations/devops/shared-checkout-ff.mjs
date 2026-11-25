// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/604 (TL standing rule p/9#583, t/557#11): notice-then-fast-forward for the SAFE behind-only case.
//
// When the shared checkout is behind origin/main and ALL FIVE conditions hold:
//   1. on `main`;  2. no tracked modifications;  3. no file in the way of an incoming added path
//   (untracked OR ignored: a fast-forward silently overwrites an ignored file);  4. no `.git/*.lock`
//   (nor `.git/refs/heads/main.lock`);  5. fast-forwardable (HEAD is an ancestor of origin/main, 0 ahead)
// DevOps gives the agents with shared-tree writes in the last 2 h (plus the DevOps Lead) 5 minutes'
// notice, then runs `git merge --ff-only origin/main` unless one of them replied 'hold'. The five are
// re-checked immediately before the merge, and the before/after SHAs are posted on t/557.
// Every other case keeps the all-clear procedure (docs/shared-tree-divergence.md): this exits 2 and the
// caller pings the Lead as it does today.
//
// NEVER resets, stashes, cleans or moves files. Fails closed: an unreadable condition, a failed notice
// or a failed hold read means no fast-forward, and the Lead is pinged.
//
//   node operations/devops/shared-checkout-ff.mjs --repo <shared checkout> --sender <id> --lead <id>
//       [--notice-minutes 5] [--dry-run]
//   Exit 0 fast-forwarded | 2 safe case does not hold (caller alerts as today) | 3 stopped: a hold,
//   a failed notice or a failed re-check (the Lead was pinged) | 1 error (the Lead was pinged if possible).
//
// Pure core: safeCaseVerdict, writersSince, findHolds. Impure shims (all injectable): collectFacts,
// recentWrites, appRun (the local Interweave daemon), run.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NOTICE_MINUTES = 5;
export const WRITERS_WINDOW_MS = 2 * 60 * 60 * 1000;
export const TICKET = 't/557';
export const NOTICE_TEXT = "DevOps fast-forwarding the shared checkout in 5 min (t/557); reply hold to stop.";
const DAEMON_MCP = 'http://127.0.0.1:7420/api/mcp';

/**
 * PURE. Whether the safe behind-only case holds. `facts`: { error?, branch, ahead, behind, trackedMods: [],
 * locks: [], collisions: [], ffable: bool }. Returns { safe, reasons: [why not] }.
 */
export function safeCaseVerdict(facts) {
  if (!facts || facts.error) return { safe: false, reasons: [`cannot-verify: ${facts?.error ?? 'no reading'}`] };
  const reasons = [];
  if (facts.branch !== 'main') reasons.push('not-on-main');
  if (!(facts.ahead === 0)) reasons.push('ahead-of-origin');
  if (!(facts.behind > 0)) reasons.push('not-behind');
  if (facts.trackedMods?.length) reasons.push('tracked-modifications');
  if (facts.collisions?.length) reasons.push(`untracked-collision: ${facts.collisions.slice(0, 5).join(', ')}`);
  if (facts.locks?.length) reasons.push(`git-lock: ${facts.locks.join(', ')}`);
  if (facts.ffable !== true) reasons.push('not-fast-forwardable');
  return { safe: reasons.length === 0, reasons };
}

/**
 * Impure (git, fsx injectable). Reads the five conditions. Never throws: a failure returns { error }.
 * `git(args) -> stdout` runs in the shared checkout and throws on a non-zero exit; `fsx` is
 * { lstat(p) -> stat|null, readdir(p) -> [names] }.
 */
export function collectFacts(root, { git, fsx }) {
  try {
    git(['fetch', '-q', 'origin']);
    const branch = String(git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const head = String(git(['rev-parse', 'HEAD'])).trim();
    const target = String(git(['rev-parse', 'origin/main'])).trim();
    const m = /^(\d+)\s+(\d+)$/.exec(String(git(['rev-list', '--left-right', '--count', 'HEAD...origin/main'])).trim());
    if (!m) throw new Error('unexpected rev-list output');
    const [ahead, behind] = [Number(m[1]), Number(m[2])];
    const trackedMods = String(git(['status', '--porcelain', '--untracked-files=no'])).split('\n').filter((l) => l.trim()).map((l) => l.slice(3));
    let ffable = false;
    try { git(['merge-base', '--is-ancestor', 'HEAD', 'origin/main']); ffable = true; } catch (err) {
      if (err?.status !== 1) throw err; // 1 = not an ancestor; anything else is unreadable
    }
    // Paths the fast-forward ADDS. Anything already on disk there (untracked, or ignored, which git would
    // overwrite without asking), or a file where an incoming path needs a directory, is a collision.
    const added = String(git(['diff', '--name-only', '--no-renames', '--diff-filter=A', '-z', 'HEAD', 'origin/main'])).split('\0').filter(Boolean);
    const collisions = [];
    for (const p of added) {
      if (fsx.lstat(path.join(root, p))) { collisions.push(p); continue; }
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) {
        const st = fsx.lstat(path.join(root, ...parts.slice(0, i)));
        if (st && !st.isDirectory()) { collisions.push(p); break; }
      }
    }
    const gitDir = path.join(root, '.git');
    const locks = fsx.readdir(gitDir).filter((n) => n.endsWith('.lock')).map((n) => `.git/${n}`);
    if (fsx.lstat(path.join(gitDir, 'refs', 'heads', 'main.lock'))) locks.push('.git/refs/heads/main.lock');
    return { branch, head, target, ahead, behind, trackedMods, ffable, collisions, locks };
  } catch (err) {
    return { error: String(err?.stderr || err?.message || err).trim().split('\n')[0] };
  }
}

/** PURE. The directories holding writes newer than `sinceMs`. `writes`: [{ path, mtimeMs }]. */
export function writersSince(writes, sinceMs) {
  return [...new Set(writes.filter((w) => w.mtimeMs > sinceMs).map((w) => path.dirname(w.path)))].sort();
}

/** Impure. Untracked (not ignored) and modified files under the shared checkout, with mtimes. */
export function recentWrites(root, { git, fsx }) {
  const out = String(git(['ls-files', '--others', '--modified', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  return out.map((p) => {
    const st = fsx.lstat(path.join(root, p));
    return st ? { path: path.join(root, p), mtimeMs: st.mtimeMs } : null;
  }).filter(Boolean);
}

/**
 * PURE. Holds among the replies: a ping from one of `recipients` (ids) whose body says 'hold'.
 * `replies`: [{ sender: { id }, body }].
 */
export function findHolds(replies, recipients) {
  const ids = new Set(recipients);
  return replies.filter((p) => ids.has(p?.sender?.id) && /\bhold\b/i.test(String(p?.body ?? '')));
}

/** Impure. One app command through the local daemon's MCP endpoint, as the wrapper does. Throws on a refusal. */
export async function appRun(app, command, input, { fetchFn = fetch } = {}) {
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'app_run', arguments: { app, command, args: [JSON.stringify(input)] } } };
  const res = await fetchFn(DAEMON_MCP, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(rpc) });
  const text = await res.text();
  const json = JSON.parse(text.startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data:'))?.slice(5) ?? '{}');
  const stdout = json?.result?.structuredContent?.result?.stdout;
  const out = stdout ? JSON.parse(stdout) : null;
  if (!out || out.error) throw new Error(`${app} ${command}: ${out?.error?.message ?? `no answer (${text.slice(0, 200)})`}`);
  return out;
}

const short = (sha) => String(sha ?? '').slice(0, 9);

/**
 * One run. `deps`: { git, fsx, app (appRun-shaped), sleep(ms), now() }. Returns { exit, action, ... }.
 */
export async function run({ root, sender, lead, noticeMinutes = NOTICE_MINUTES, dryRun = false, deps }) {
  const { git, fsx, app, sleep, now } = deps;
  const log = (m) => console.log(m);
  const pingLead = async (body) => {
    try { await app('chat', 'send', { sender, to: lead, body }); } catch (err) { console.warn(`WARN: could not ping the Lead: ${err.message}`); }
  };

  const facts = collectFacts(root, { git, fsx });
  const v = safeCaseVerdict(facts);
  if (!v.safe) return { exit: 2, action: 'not-safe', reasons: v.reasons };

  // Who wrote to the shared tree in the last 2 h, by owner.
  let recipients;
  let writerDirs;
  try {
    writerDirs = writersSince(recentWrites(root, { git, fsx }), now() - WRITERS_WINDOW_MS);
    const owners = [];
    for (const d of writerDirs) owners.push((await app('org-chart', 'resolve-owner', { path: d })).collaborator.id);
    recipients = [...new Set([lead, ...owners])].filter((id) => id !== sender);
  } catch (err) {
    await pingLead(`Shared-checkout fast-forward (t/604) NOT started: could not work out whom to notify (${err.message}). Sync per docs/shared-tree-divergence.md.`);
    return { exit: 3, action: 'stopped', reasons: [`writers-unreadable: ${err.message}`] };
  }
  if (dryRun) return { exit: 0, action: 'dry-run', recipients, writerDirs, head: facts.head, target: facts.target };

  // The notice. A failed send means someone wasn't told: fail closed.
  const notices = [];
  for (const to of recipients) {
    try {
      const r = await app('chat', 'send', { sender, to, body: `${NOTICE_TEXT} Shared checkout ${short(facts.head)} → origin/main ${short(facts.target)} (${facts.behind} behind).` });
      notices.push({ to, ping: r.ping, seq: Number(String(r.ping).split('#')[1]) });
    } catch (err) {
      await pingLead(`Shared-checkout fast-forward (t/604) STOPPED: the notice to ${to} failed (${err.message}). Notified so far: ${notices.map((n) => n.ping).join(', ') || 'none'}. Not fast-forwarding.`);
      return { exit: 3, action: 'stopped', reasons: [`notice-failed: ${to}`], notices };
    }
  }
  log(`noticed ${notices.map((n) => `${n.to} (${n.ping})`).join(', ')}; waiting ${noticeMinutes} min`);
  await sleep(noticeMinutes * 60 * 1000);

  // Any hold since the notice? An unreadable conversation counts as a hold (fail closed).
  const holds = [];
  for (const n of notices) {
    try {
      const r = await app('chat', 'read', { member: sender, with: n.to, after: n.seq });
      holds.push(...findHolds(r.pings ?? [], [n.to]).map((p) => p.ref));
    } catch (err) {
      holds.push(`unreadable:${n.to}`);
    }
  }
  if (holds.length) {
    await pingLead(`Shared-checkout fast-forward (t/604) HELD: ${holds.join(', ')}. Not fast-forwarding; the all-clear procedure applies.`);
    return { exit: 3, action: 'held', holds, notices };
  }

  // Re-check all five immediately before, then fast-forward.
  const again = collectFacts(root, { git, fsx });
  const v2 = safeCaseVerdict(again);
  if (!v2.safe) {
    await pingLead(`Shared-checkout fast-forward (t/604) STOPPED at the re-check: ${v2.reasons.join('; ')}. Not fast-forwarding.`);
    return { exit: 3, action: 'stopped', reasons: v2.reasons, notices };
  }
  try {
    git(['merge', '--ff-only', '-q', again.target]);
  } catch (err) {
    const why = String(err?.stderr || err?.message || err).trim().split('\n')[0];
    await pingLead(`Shared-checkout fast-forward (t/604) FAILED: \`git merge --ff-only\` refused (${why}). Nothing else was touched.`);
    return { exit: 3, action: 'stopped', reasons: [`ff-failed: ${why}`], notices };
  }
  const after = String(git(['rev-parse', 'HEAD'])).trim();
  const body = `**Shared checkout fast-forwarded (t/604, TL standing rule p/9#583).** ${short(again.head)} → ${short(after)} = origin/main (${again.behind} commits). ` +
    `Notice ${noticeMinutes} min: ${notices.map((n) => n.ping).join(', ')}; no hold. Re-checked just before: on main, 0 ahead, no tracked mods, no collisions, no locks.` +
    (writerDirs.length ? ` Recent shared-tree writes: ${writerDirs.map((d) => path.relative(root, d) || '.').slice(0, 8).join(', ')}.` : '');
  try { await app('tickets', 'comment', { author: sender, id: TICKET, body }); } catch (err) {
    await pingLead(`${body}\n\n(WARN: could not post this on ${TICKET}: ${err.message})`);
  }
  return { exit: 0, action: 'fast-forwarded', before: again.head, after, notices };
}

const isCliEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliEntry) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const root = opt('--repo');
  const sender = opt('--sender');
  const lead = opt('--lead');
  if (!root || !sender || !lead) {
    console.error('usage: shared-checkout-ff.mjs --repo <shared checkout> --sender <id> --lead <id> [--notice-minutes N] [--dry-run]');
    process.exit(1);
  }
  const deps = {
    git: (a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    fsx: {
      lstat: (p) => { try { return fs.lstatSync(p); } catch { return null; } },
      readdir: (p) => fs.readdirSync(p),
    },
    app: (a, c, i) => appRun(a, c, i),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
  const noticeMinutes = Number(opt('--notice-minutes') ?? NOTICE_MINUTES);
  run({ root, sender, lead, noticeMinutes, dryRun: args.includes('--dry-run'), deps })
    .then((out) => { console.log(JSON.stringify(out)); process.exit(out.exit); })
    .catch(async (err) => {
      console.log(JSON.stringify({ exit: 1, action: 'error', error: String(err?.message ?? err) }));
      try { await appRun('chat', 'send', { sender, to: lead, body: `Shared-checkout fast-forward (t/604) ERROR: ${err?.message ?? err}. Not fast-forwarded unless the log says so.` }); } catch { /* best effort */ }
      process.exit(1);
    });
}
