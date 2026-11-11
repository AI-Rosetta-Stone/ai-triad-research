// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// GitHub API budget check before a bulk `gh` loop (t/396).
//
// Why: every agent shares one user token (5,000 REST calls/hour). On 2026-11-11 at 17:33Z a single
// bulk diagnostic loop exhausted it, and every agent's `gh` failed until 17:40:57Z (p/9#76). Run
// this first with the number of calls the loop will make; it refuses when the loop would take the
// shared pool below a floor that keeps room for everyone else.
//
//   node operations/devops/gh-budget.mjs --need <N> [--floor 1000] [--pool core|graphql]
//
// Exit codes:
//   0  remaining - need >= floor. Prints remaining and reset; go ahead.
//   2  bad arguments (nothing was read).
//   3  refused: below the floor, or the rate_limit response could not be read or understood
//      (fail closed: an unreadable budget is never treated as enough).
//
// For bulk work, prefer the reviewer App token: it is a separate installation pool, so the loop
// does not draw on the shared user token at all.
//   Import-Module operations/devops/AgentAppToken.psm1
//   Invoke-AsAgentApp -Role reviewer -ScriptBlock { node operations/devops/gh-budget.mjs --need 300; <loop> }
//
// `gh api rate_limit` does not count against the primary rate limit.
//
// Pure core: checkBudget. I/O: readRateLimit and runCli (dependencies injectable for the tests).
// Run the tests: node --test operations/devops/gh-budget.test.mjs

import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_FLOOR = 1000;
export const POOLS = Object.freeze(['core', 'graphql']);
export const EXIT = Object.freeze({ OK: 0, USAGE: 2, REFUSED: 3 });

const LOCATION = 'operations/devops/gh-budget.mjs';
const APP_TOKEN_HINT =
  'Run the loop under the reviewer App token, a separate pool: ' +
  'Import-Module operations/devops/AgentAppToken.psm1; Invoke-AsAgentApp -Role reviewer -ScriptBlock { ... }';

function actionableError({ goal, problem, location, nextSteps }) {
  const err = new Error(
    `  Goal:       ${goal}\n  Problem:    ${problem}\n  Location:   ${location}\n` +
      `  Next Steps: ${nextSteps.map((s, i) => `${i + 1}. ${s}`).join(' ')}`,
  );
  Object.assign(err, { name: 'ActionableError', goal, problem, location, nextSteps });
  return err;
}

const isCount = (n) => Number.isInteger(n) && n >= 0;

function resetIso(reset) {
  return new Date(reset * 1000).toISOString().replace('.000Z', 'Z');
}

/**
 * PURE. Decide whether a loop of `need` calls fits the `pool` budget above `floor`.
 * `rateLimitJson` is the body of `gh api rate_limit`, as a string or an already-parsed object.
 * Fails closed: anything it cannot read or understand returns ok: false with unreadable: true.
 * @returns {{ok: boolean, unreadable: boolean, pool: string, need: number, floor: number,
 *   remaining: number|null, limit: number|null, reset: number|null, resetIso: string|null, reason: string}}
 */
export function checkBudget({ need, floor = DEFAULT_FLOOR, pool = 'core', rateLimitJson } = {}) {
  const base = { pool, need, floor, remaining: null, limit: null, reset: null, resetIso: null };
  const unreadable = (reason) => ({ ...base, ok: false, unreadable: true, reason });

  if (!isCount(need)) return unreadable(`need must be a non-negative integer, got ${JSON.stringify(need)}`);
  if (!isCount(floor)) return unreadable(`floor must be a non-negative integer, got ${JSON.stringify(floor)}`);
  if (!POOLS.includes(pool)) return unreadable(`pool must be one of ${POOLS.join('|')}, got ${JSON.stringify(pool)}`);

  let body = rateLimitJson;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return unreadable(`rate_limit response is not JSON (${e.message})`);
    }
  }
  const entry = body && typeof body === 'object' ? body.resources?.[pool] : undefined;
  if (!entry || typeof entry !== 'object') return unreadable(`rate_limit response has no resources.${pool}`);
  const { remaining, limit, reset } = entry;
  if (!isCount(remaining)) return unreadable(`resources.${pool}.remaining is not a count: ${JSON.stringify(remaining)}`);
  if (!isCount(reset)) return unreadable(`resources.${pool}.reset is not an epoch time: ${JSON.stringify(reset)}`);

  const read = { ...base, remaining, limit: isCount(limit) ? limit : null, reset, resetIso: resetIso(reset) };
  const after = remaining - need;
  if (after >= floor) {
    return { ...read, ok: true, unreadable: false, reason: `${remaining} - ${need} = ${after} >= floor ${floor}` };
  }
  return { ...read, ok: false, unreadable: false, reason: `${remaining} - ${need} = ${after} < floor ${floor}` };
}

/** PURE. The refusal as an ActionableError, naming the reset time and the App token. */
export function refusalError(result) {
  const goal = `Run a bulk gh loop of ${result.need} ${result.pool} calls without starving the shared token (t/396)`;
  if (result.unreadable) {
    return actionableError({
      goal,
      problem: `Could not read the ${result.pool} budget, so the loop is refused (fail closed): ${result.reason}`,
      location: LOCATION,
      nextSteps: ['Check `gh auth status` and `gh api rate_limit` by hand.', APP_TOKEN_HINT],
    });
  }
  return actionableError({
    goal,
    problem: `The ${result.pool} pool has ${result.remaining} calls left; this loop would leave ${result.remaining - result.need}, below the floor of ${result.floor}.`,
    location: LOCATION,
    nextSteps: [
      `Wait for the reset at ${result.resetIso}.`,
      APP_TOKEN_HINT,
      'Or split the loop so each run needs fewer calls.',
    ],
  });
}

/** I/O. The body of `gh api rate_limit`. Throws if gh fails. */
export async function readRateLimit() {
  const { execFileSync } = await import('node:child_process');
  return execFileSync('gh', ['api', 'rate_limit'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function parseArgs(argv) {
  const opts = { need: undefined, floor: DEFAULT_FLOOR, pool: 'core' };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    const value = argv[i + 1];
    if (!['--need', '--floor', '--pool'].includes(name)) throw new Error(`unknown argument ${name}`);
    if (value === undefined) throw new Error(`${name} needs a value`);
    i++;
    if (name === '--pool') {
      if (!POOLS.includes(value)) throw new Error(`--pool must be one of ${POOLS.join('|')}, got ${value}`);
      opts.pool = value;
    } else {
      const n = Number(value);
      if (!/^\d+$/.test(value) || !isCount(n)) throw new Error(`${name} must be a non-negative integer, got ${value}`);
      opts[name.slice(2)] = n;
    }
  }
  if (opts.need === undefined) throw new Error('--need <N> is required');
  return opts;
}

/** CLI. Returns the exit code; `deps` lets the tests replace gh and the console. */
export async function runCli(argv, { read = readRateLimit, log = console.log, error = console.error } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    error(`gh-budget: ${e.message}\nUsage: node ${LOCATION} --need <N> [--floor ${DEFAULT_FLOOR}] [--pool core|graphql]`);
    return EXIT.USAGE;
  }
  let rateLimitJson;
  try {
    rateLimitJson = await read();
  } catch (e) {
    error(`WARN: gh api rate_limit failed; refusing rather than assuming budget (${String(e.message).split('\n')[0]}).`);
    rateLimitJson = undefined;
  }
  const result = checkBudget({ ...opts, rateLimitJson });
  if (result.ok) {
    log(`gh-budget OK (${result.pool}): remaining=${result.remaining} reset=${result.resetIso} need=${result.need} floor=${result.floor}`);
    return EXIT.OK;
  }
  error(`gh-budget REFUSED (${result.pool}): ${result.reason}\n${refusalError(result).message}`);
  return EXIT.REFUSED;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
