// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/396: both arms of the gh budget check (enough budget passes, below the floor refuses, with the
// exact boundary), pool selection, fail-closed on a malformed rate_limit or a failed gh read, and
// the CLI's exit codes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FLOOR, EXIT, checkBudget, refusalError, parseArgs, runCli } from './gh-budget.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const RESET = 1794422495; // 2026-11-11T18:41:35Z

const rateLimit = ({ core = 4000, graphql = 4986 } = {}) => ({
  resources: {
    core: { limit: 5000, used: 5000 - core, remaining: core, reset: RESET },
    graphql: { limit: 5000, used: 5000 - graphql, remaining: graphql, reset: RESET + 60 },
  },
  rate: { limit: 5000, remaining: core, reset: RESET },
});

test('default floor is 1000', () => {
  assert.equal(DEFAULT_FLOOR, 1000);
  assert.equal(checkBudget({ need: 0, rateLimitJson: rateLimit({ core: 999 }) }).ok, false);
});

test('enough budget passes and reports remaining and reset', () => {
  const r = checkBudget({ need: 500, rateLimitJson: rateLimit({ core: 4000 }) });
  assert.equal(r.ok, true);
  assert.equal(r.unreadable, false);
  assert.equal(r.remaining, 4000);
  assert.equal(r.resetIso, '2026-11-11T18:41:35Z');
});

test('below the floor refuses', () => {
  const r = checkBudget({ need: 600, rateLimitJson: rateLimit({ core: 1541 }) });
  assert.equal(r.ok, false);
  assert.equal(r.unreadable, false);
  assert.match(r.reason, /1541 - 600 = 941 < floor 1000/);
});

test('boundary: remaining - need == floor passes, one more call refuses', () => {
  assert.equal(checkBudget({ need: 500, floor: 1000, rateLimitJson: rateLimit({ core: 1500 }) }).ok, true);
  assert.equal(checkBudget({ need: 501, floor: 1000, rateLimitJson: rateLimit({ core: 1500 }) }).ok, false);
});

test('a JSON string is accepted as well as an object', () => {
  assert.equal(checkBudget({ need: 1, rateLimitJson: JSON.stringify(rateLimit()) }).ok, true);
});

test('pool selection reads the named pool, not core', () => {
  const body = rateLimit({ core: 100, graphql: 4986 });
  assert.equal(checkBudget({ need: 10, pool: 'core', rateLimitJson: body }).ok, false);
  const g = checkBudget({ need: 10, pool: 'graphql', rateLimitJson: body });
  assert.equal(g.ok, true);
  assert.equal(g.remaining, 4986);
  assert.equal(g.reset, RESET + 60);
});

test('unknown pool fails closed', () => {
  const r = checkBudget({ need: 1, pool: 'search', rateLimitJson: rateLimit() });
  assert.equal(r.ok, false);
  assert.equal(r.unreadable, true);
});

for (const [label, rateLimitJson] of [
  ['undefined (gh read failed)', undefined],
  ['not JSON', '<html>502 Bad Gateway</html>'],
  ['empty string', ''],
  ['JSON null', 'null'],
  ['no resources', { rate: { remaining: 4000 } }],
  ['pool missing', { resources: { graphql: { remaining: 4000, reset: RESET } } }],
  ['remaining missing', { resources: { core: { limit: 5000, reset: RESET } } }],
  ['remaining a string', { resources: { core: { remaining: '4000', reset: RESET } } }],
  ['remaining negative', { resources: { core: { remaining: -1, reset: RESET } } }],
  ['remaining fractional', { resources: { core: { remaining: 4000.5, reset: RESET } } }],
  ['reset missing', { resources: { core: { remaining: 4000 } } }],
]) {
  test(`malformed rate_limit fails closed: ${label}`, () => {
    const r = checkBudget({ need: 1, rateLimitJson });
    assert.equal(r.ok, false);
    assert.equal(r.unreadable, true);
  });
}

for (const [label, args] of [
  ['need missing', { rateLimitJson: rateLimit() }],
  ['need negative', { need: -5, rateLimitJson: rateLimit() }],
  ['need NaN', { need: NaN, rateLimitJson: rateLimit() }],
  ['floor negative', { need: 1, floor: -1, rateLimitJson: rateLimit() }],
]) {
  test(`bad input fails closed: ${label}`, () => {
    assert.equal(checkBudget(args).ok, false);
  });
}

test('refusal names the reset time and the App token', () => {
  const msg = refusalError(checkBudget({ need: 600, rateLimitJson: rateLimit({ core: 1541 }) })).message;
  for (const part of ['Goal:', 'Problem:', 'Location:', 'Next Steps:', '2026-11-11T18:41:35Z', 'Invoke-AsAgentApp -Role reviewer']) {
    assert.ok(msg.includes(part), `missing ${part}`);
  }
  const unreadable = refusalError(checkBudget({ need: 1, rateLimitJson: 'nope' }));
  assert.equal(unreadable.name, 'ActionableError');
  assert.match(unreadable.message, /fail closed/);
  assert.match(unreadable.message, /Invoke-AsAgentApp -Role reviewer/);
});

test('parseArgs: defaults, overrides, and rejects bad input', () => {
  assert.deepEqual(parseArgs(['--need', '5']), { need: 5, floor: 1000, pool: 'core' });
  assert.deepEqual(parseArgs(['--need', '5', '--floor', '0', '--pool', 'graphql']), { need: 5, floor: 0, pool: 'graphql' });
  for (const bad of [[], ['--need'], ['--need', '-3'], ['--need', '1.5'], ['--need', '5', '--pool', 'search'], ['--needs', '5']]) {
    assert.throws(() => parseArgs(bad), undefined, JSON.stringify(bad));
  }
});

function capture() {
  const out = [];
  const err = [];
  return { out, err, log: (s) => out.push(s), error: (s) => err.push(s) };
}

test('CLI: enough budget exits 0 and prints remaining and reset', async () => {
  const c = capture();
  const code = await runCli(['--need', '100'], { read: async () => JSON.stringify(rateLimit()), ...c });
  assert.equal(code, EXIT.OK);
  assert.match(c.out.join('\n'), /remaining=4000 reset=2026-11-11T18:41:35Z/);
});

test('CLI: below the floor exits 3 with the ActionableError', async () => {
  const c = capture();
  const code = await runCli(['--need', '600'], { read: async () => JSON.stringify(rateLimit({ core: 1541 })), ...c });
  assert.equal(code, EXIT.REFUSED);
  assert.match(c.err.join('\n'), /REFUSED[\s\S]*Next Steps:[\s\S]*2026-11-11T18:41:35Z/);
});

test('CLI: a failed gh read exits 3 with a WARN (fail closed)', async () => {
  const c = capture();
  const code = await runCli(['--need', '1'], {
    read: async () => {
      throw new Error('HTTP 401: Bad credentials');
    },
    ...c,
  });
  assert.equal(code, EXIT.REFUSED);
  assert.match(c.err.join('\n'), /^WARN: gh api rate_limit failed/m);
});

test('CLI: malformed rate_limit exits 3', async () => {
  const c = capture();
  assert.equal(await runCli(['--need', '1'], { read: async () => '{}', ...c }), EXIT.REFUSED);
});

test('CLI: bad arguments exit 2 without reading the budget', async () => {
  const c = capture();
  let read = false;
  const code = await runCli(['--floor', '5'], { read: async () => ((read = true), '{}'), ...c });
  assert.equal(code, EXIT.USAGE);
  assert.equal(read, false);
});

test('entrypoint: running the file as a script reaches runCli (usage exit 2, no gh call)', () => {
  const r = spawnSync(process.execPath, [join(here, 'gh-budget.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, EXIT.USAGE, r.stderr);
  assert.match(r.stderr, /--need <N> is required/);
});
