// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/604: notice-then-fast-forward. Each of the five conditions, the hold path, fail-closed paths and the
// happy path, with an injected git, filesystem and chat (no network, no real repo).
// Run: node --test operations/devops/shared-checkout-ff.test.mjs

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectFacts, ffArgv, findHolds, run, safeCaseVerdict, writersSince, NOTICE_TEXT, TICKET } from './shared-checkout-ff.mjs';

const ROOT = path.resolve('/repo');
const SENDER = 'worker-id';
const LEAD = 'lead-id';
const TL = 'tl-id';
const NOW = Date.parse('2026-11-25T09:00:00Z');
const HEAD = 'aaaaaaaaa1111';
const TARGET = 'bbbbbbbbb2222';

/** World: git answers and a filesystem. `onMerge` lets a test change the world mid-run. */
function world(o = {}) {
  const w = {
    branch: 'main', ahead: 0, behind: 3, status: '', ancestor: true, added: ['lib/new.ts'],
    files: {}, // relpath -> { dir?: bool, mtimeMs }
    gitDirEntries: ['HEAD', 'config', 'index'],
    others: [], // ls-files --others --modified
    fetchFails: false, mergeFails: false, head: HEAD, target: TARGET,
    calls: [],
    ...o,
  };
  w.git = (argv) => {
    w.calls.push(argv.join(' '));
    // Leading `-c key=value` pairs are config for this one call (the ff's core.hooksPath); route on the rest.
    let args = argv;
    while (args[0] === '-c') args = args.slice(2);
    const a = args.join(' ');
    if (args[0] === 'fetch') { if (w.fetchFails) throw Object.assign(new Error('fatal: no network'), { stderr: 'fatal: no network' }); return ''; }
    if (a === 'rev-parse --abbrev-ref HEAD') return `${w.branch}\n`;
    if (a === 'rev-parse HEAD') return `${w.head}\n`;
    if (a === 'rev-parse origin/main') return `${w.target}\n`;
    if (args[0] === 'rev-list') return `${w.ahead}\t${w.behind}\n`;
    if (args[0] === 'status') return w.status;
    if (args[0] === 'merge-base') { if (w.ancestor === 'error') throw Object.assign(new Error('fatal: bad object'), { status: 128 }); if (!w.ancestor) throw Object.assign(new Error(''), { status: 1 }); return ''; }
    if (args[0] === 'diff') return w.added.map((p) => `${p}\0`).join('');
    if (args[0] === 'ls-files') return w.others.map((p) => `${p}\0`).join('');
    if (args[0] === 'merge') { if (w.mergeFails) throw Object.assign(new Error('x'), { stderr: 'fatal: Not possible to fast-forward' }); w.head = args.at(-1); return ''; }
    throw new Error(`unexpected git ${a}`);
  };
  const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
  w.fsx = {
    lstat: (p) => {
      const f = w.files[rel(p)];
      return f ? { isDirectory: () => !!f.dir, mtimeMs: f.mtimeMs ?? 0 } : null;
    },
    readdir: (p) => { if (rel(p) !== '.git') throw new Error(`unexpected readdir ${p}`); return w.gitDirEntries; },
  };
  return w;
}

/** Chat/org-chart/tickets fake. `replies[id]` are the pings read back after the notice. */
function fakeApp({ owners = {}, replies = {}, failSendTo = null, failRead = null, failResolve = false } = {}) {
  const calls = [];
  let seq = 10;
  const app = async (appName, command, input) => {
    calls.push({ appName, command, input });
    if (appName === 'org-chart' && command === 'resolve-owner') {
      if (failResolve) throw new Error('daemon unreachable');
      const dir = path.relative(ROOT, input.path).split(path.sep).join('/');
      return { collaborator: { id: owners[dir] ?? SENDER } };
    }
    if (appName === 'chat' && command === 'send') {
      if (input.to === failSendTo) throw new Error('chat send: NotFound');
      seq += 1;
      return { ping: `p/${input.to}#${seq}` };
    }
    if (appName === 'chat' && command === 'read') {
      if (input.with === failRead) throw new Error('chat read: Busy');
      return { pings: replies[input.with] ?? [] };
    }
    if (appName === 'tickets' && command === 'comment') return { id: `${input.id}#99` };
    throw new Error(`unexpected app ${appName} ${command}`);
  };
  app.calls = calls;
  return app;
}

async function go(w, app, extra = {}) {
  const sleeps = [];
  const logs = [];
  const mocks = [mock.method(console, 'log', (l) => logs.push(String(l))), mock.method(console, 'warn', (l) => logs.push(String(l)))];
  try {
    const hooks = extra.hooks ?? {
      made: [], removed: [],
      make() { if (extra.hooksFail) throw new Error('EACCES'); const d = path.join(path.resolve('/tmp'), `nohooks-${this.made.length}`); this.made.push(d); return d; },
      remove(d) { this.removed.push(d); },
    };
    const out = await run({ root: ROOT, sender: SENDER, lead: LEAD, deps: { git: w.git, fsx: w.fsx, app, hooks, sleep: async (ms) => { sleeps.push(ms); if (extra.duringWait) extra.duringWait(w); }, now: () => NOW }, ...extra });
    return { out, sleeps, logs, hooks };
  } finally { mocks.forEach((m) => m.mock.restore()); }
}
const sends = (app) => app.calls.filter((c) => c.appName === 'chat' && c.command === 'send');
const merged = (w) => w.calls.some((c) => /(^| )merge --ff-only/.test(c));

// ---- the five conditions (pure verdict over collected facts) ----
test('safe: on main, behind, clean, nothing in the way, no locks, fast-forwardable', () => {
  const w = world();
  assert.deepEqual(safeCaseVerdict(collectFacts(ROOT, w)), { safe: true, reasons: [] });
});

for (const [name, o, reason] of [
  ['1. not on main', { branch: 'feature/x' }, 'not-on-main'],
  ['5. ahead (diverged)', { ahead: 1 }, 'ahead-of-origin'],
  ['2. tracked modification', { status: ' M AGENTS.md\n' }, 'tracked-modifications'],
  ['3. untracked file at an incoming path', { files: { 'lib/new.ts': { mtimeMs: 1 } } }, 'untracked-collision: lib/new.ts'],
  ['3. a FILE where an incoming path needs a directory', { added: ['docs/x/y.md'], files: { 'docs/x': { mtimeMs: 1 } } }, 'untracked-collision: docs/x/y.md'],
  ['4. index.lock', { gitDirEntries: ['HEAD', 'index.lock'] }, 'git-lock: .git/index.lock'],
  ['4. refs/heads/main.lock', { files: { '.git/refs/heads/main.lock': {} } }, 'git-lock: .git/refs/heads/main.lock'],
  ['5. not fast-forwardable', { ancestor: false }, 'not-fast-forwardable'],
  ['nothing to do (0 behind)', { behind: 0 }, 'not-behind'],
]) {
  test(`not safe: ${name}`, () => {
    const v = safeCaseVerdict(collectFacts(ROOT, world(o)));
    assert.equal(v.safe, false);
    assert.ok(v.reasons.includes(reason), v.reasons.join(' | '));
  });
}

test('3. an existing DIRECTORY on the path to an incoming file is fine; an ignored file AT the path is a collision', () => {
  assert.equal(safeCaseVerdict(collectFacts(ROOT, world({ added: ['docs/x/y.md'], files: { docs: { dir: true }, 'docs/x': { dir: true } } }))).safe, true);
  // lstat sees ignored files too: git would overwrite one silently.
  assert.equal(safeCaseVerdict(collectFacts(ROOT, world({ added: ['.env'], files: { '.env': { mtimeMs: 1 } } }))).safe, false);
});

test('fail closed: a fetch failure or an unreadable ancestry check is not safe', () => {
  assert.match(safeCaseVerdict(collectFacts(ROOT, world({ fetchFails: true }))).reasons[0], /^cannot-verify: fatal: no network/);
  assert.match(safeCaseVerdict(collectFacts(ROOT, world({ ancestor: 'error' }))).reasons[0], /^cannot-verify/);
  assert.equal(safeCaseVerdict(null).safe, false);
});

// ---- pure helpers ----
test('writersSince: directories with writes in the window, deduped; older writes ignored', () => {
  const since = NOW - 7200000;
  assert.deepEqual(writersSince([
    { path: '/repo/engineering/tech-lead/decisions/a.md', mtimeMs: NOW - 60000 },
    { path: '/repo/engineering/tech-lead/decisions/b.md', mtimeMs: NOW - 120000 },
    { path: '/repo/agent-devops/old.txt', mtimeMs: since - 1 },
  ], since), ['/repo/engineering/tech-lead/decisions']);
});

test('findHolds: only a recipient saying hold counts (any case, whole word)', () => {
  const p = (id, body, ref = 'p/1#2') => ({ ref, sender: { id }, body });
  assert.equal(findHolds([p(TL, 'HOLD please')], [TL]).length, 1);
  assert.equal(findHolds([p(TL, 'hold.')], [TL]).length, 1);
  assert.equal(findHolds([p(TL, 'go ahead, no objection')], [TL]).length, 0);
  assert.equal(findHolds([p(TL, 'household')], [TL]).length, 0);
  assert.equal(findHolds([p(SENDER, 'reply hold to stop')], [TL]).length, 0, "our own notice text is not a hold");
});

// ---- the run ----
test('happy path: notice the writers and the Lead, wait 5 min, re-check, ff-only, post SHAs on t/557', async () => {
  const w = world({ others: ['engineering/tech-lead/decisions/d.md', 'agent-devops/x.md'],
    files: { 'engineering/tech-lead/decisions/d.md': { mtimeMs: NOW - 600000 }, 'agent-devops/x.md': { mtimeMs: NOW - 9000000 } } });
  const app = fakeApp({ owners: { 'engineering/tech-lead/decisions': TL } });
  const { out, sleeps, hooks } = await go(w, app);
  assert.equal(out.exit, 0, JSON.stringify(out));
  assert.equal(out.action, 'fast-forwarded');
  assert.deepEqual(sleeps, [5 * 60 * 1000]);
  assert.deepEqual(sends(app).map((s) => s.input.to), [LEAD, TL], 'the Lead plus the recent writer (the old write is outside 2 h)');
  assert.ok(sends(app).every((s) => s.input.body.startsWith(NOTICE_TEXT) && s.input.sender === SENDER));
  // Hooks OFF (Security on #5517): the exact argv, with core.hooksPath at the empty dir made for it.
  assert.equal(hooks.made.length, 1);
  assert.ok(w.calls.includes(`-c core.hooksPath=${hooks.made[0]} merge --ff-only -q ${TARGET}`), w.calls.join('\n'));
  assert.deepEqual(hooks.removed, hooks.made, 'the empty hooks dir is removed afterwards');
  assert.equal(w.calls.filter((c) => c === 'fetch -q origin').length, 2, 'the conditions are read again (with a fetch) right before');
  const post = app.calls.find((c) => c.appName === 'tickets');
  assert.equal(post.input.id, TICKET);
  assert.match(post.input.body, new RegExp(`${HEAD.slice(0, 9)} → ${TARGET.slice(0, 9)}`));
  assert.match(post.input.body, /p\/lead-id#11, p\/tl-id#12; no hold/);
});

test('not safe -> exit 2, nothing sent, nothing merged (the caller alerts as today)', async () => {
  const w = world({ status: ' M x\n' });
  const app = fakeApp();
  const { out } = await go(w, app);
  assert.equal(out.exit, 2);
  assert.deepEqual(app.calls, []);
  assert.equal(merged(w), false);
});

test('HOLD: a recipient replies hold -> no ff, the Lead is told', async () => {
  const w = world({ others: ['engineering/tech-lead/decisions/d.md'], files: { 'engineering/tech-lead/decisions/d.md': { mtimeMs: NOW - 1000 } } });
  const app = fakeApp({ owners: { 'engineering/tech-lead/decisions': TL }, replies: { [TL]: [{ ref: 'p/9#600', sender: { id: TL }, body: 'hold, mid-edit' }] } });
  const { out } = await go(w, app);
  assert.equal(out.exit, 3);
  assert.equal(out.action, 'held');
  assert.deepEqual(out.holds, ['p/9#600']);
  assert.equal(merged(w), false);
  assert.match(sends(app).at(-1).input.body, /HELD: p\/9#600/);
  assert.equal(sends(app).at(-1).input.to, LEAD);
});

test('fail closed: an unreadable reply conversation counts as a hold', async () => {
  const w = world();
  const app = fakeApp({ failRead: LEAD });
  const { out } = await go(w, app);
  assert.equal(out.action, 'held');
  assert.deepEqual(out.holds, [`unreadable:${LEAD}`]);
  assert.equal(merged(w), false);
});

test('fail closed: a failed notice stops before the wait; nothing merged', async () => {
  const w = world({ others: ['engineering/tech-lead/decisions/d.md'], files: { 'engineering/tech-lead/decisions/d.md': { mtimeMs: NOW - 1000 } } });
  const app = fakeApp({ owners: { 'engineering/tech-lead/decisions': TL }, failSendTo: TL });
  const { out, sleeps } = await go(w, app);
  assert.equal(out.exit, 3);
  assert.deepEqual(out.reasons, [`notice-failed: ${TL}`]);
  assert.deepEqual(sleeps, []);
  assert.equal(merged(w), false);
});

test('fail closed: owners unreadable -> no notice, no ff, the Lead is told', async () => {
  const w = world({ others: ['a/b.md'], files: { 'a/b.md': { mtimeMs: NOW - 1000 } } });
  const app = fakeApp({ failResolve: true });
  const { out } = await go(w, app);
  assert.equal(out.exit, 3);
  assert.equal(merged(w), false);
  assert.match(sends(app)[0].input.body, /NOT started: could not work out whom to notify/);
});

test('re-check: a condition that broke during the wait stops the ff (an agent started editing)', async () => {
  const w = world();
  const app = fakeApp();
  const { out } = await go(w, app, { duringWait: (x) => { x.status = ' M AGENTS.md\n'; } });
  assert.equal(out.exit, 3);
  assert.deepEqual(out.reasons, ['tracked-modifications']);
  assert.equal(merged(w), false);
  assert.match(sends(app).at(-1).input.body, /STOPPED at the re-check: tracked-modifications/);
});

test('re-check: origin/main moved during the wait -> ff to the NEW target, collisions judged against it', async () => {
  const w = world();
  const app = fakeApp();
  const { out } = await go(w, app, { duringWait: (x) => { x.target = 'ccccccccc3333'; x.behind = 4; } });
  assert.equal(out.exit, 0);
  assert.ok(w.calls.some((c) => c.endsWith('merge --ff-only -q ccccccccc3333')));
});

test('ff-only refusal is reported, never retried another way', async () => {
  const w = world({ mergeFails: true });
  const app = fakeApp();
  const { out } = await go(w, app);
  assert.equal(out.exit, 3);
  assert.match(out.reasons[0], /^ff-failed: fatal: Not possible to fast-forward/);
  assert.ok(!w.calls.some((c) => /^(reset|stash|clean|checkout)/.test(c)), w.calls.join('\n'));
});

test('never resets, stashes, cleans or checks out, on any path', async () => {
  for (const o of [{}, { status: ' M x\n' }, { mergeFails: true }]) {
    const w = world(o);
    await go(w, fakeApp());
    assert.ok(!w.calls.some((c) => /^(reset|stash|clean|checkout|rm|mv)\b/.test(c)), w.calls.join('\n'));
  }
});

test('the sender is never noticed (chat refuses a send to yourself); dry-run sends nothing', async () => {
  const w = world({ others: ['operations/devops/worker/x.md'], files: { 'operations/devops/worker/x.md': { mtimeMs: NOW - 1000 } } });
  const app = fakeApp(); // owner defaults to SENDER
  const { out } = await go(w, app, { dryRun: true });
  assert.equal(out.action, 'dry-run');
  assert.deepEqual(out.recipients, [LEAD]);
  assert.deepEqual(sends(app), []);
  assert.equal(merged(w), false);
});

// ---- hooks off (Security on #5517, Lead p/233#144, t/604) ----
test('ffArgv: hooks disabled through an empty core.hooksPath, then merge --ff-only to the exact SHA', () => {
  assert.deepEqual(ffArgv('/tmp/nohooks-x', TARGET), ['-c', 'core.hooksPath=/tmp/nohooks-x', 'merge', '--ff-only', '-q', TARGET]);
});

test('every merge the run makes carries core.hooksPath (no bare merge), on the happy path and on a refusal', async () => {
  for (const o of [{}, { mergeFails: true }]) {
    const w = world(o);
    const { hooks } = await go(w, fakeApp());
    const merges = w.calls.filter((c) => /(^| )merge --ff-only/.test(c));
    assert.equal(merges.length, 1, JSON.stringify(o));
    assert.ok(merges[0].startsWith(`-c core.hooksPath=${hooks.made[0]} `), merges[0]);
    assert.deepEqual(hooks.removed, hooks.made, `removed even when the merge failed: ${JSON.stringify(o)}`);
  }
});

test('fail closed: no empty hooks dir -> no merge (never with hooks on), the Lead is told', async () => {
  const w = world();
  const app = fakeApp();
  const { out } = await go(w, app, { hooksFail: true });
  assert.equal(out.exit, 3);
  assert.deepEqual(out.reasons, ['no-hooks-dir: EACCES']);
  assert.equal(merged(w), false);
  assert.match(sends(app).at(-1).input.body, /could not make an empty hooks dir/);
});

test('the script runs no worktree sweep and no hook itself (code lines, comments excluded)', () => {
  const src = readFileSync(fileURLToPath(new URL('./shared-checkout-ff.mjs', import.meta.url)), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  assert.doesNotMatch(code, /sweep-landed-worktrees|post-merge|\.githooks/);
});
