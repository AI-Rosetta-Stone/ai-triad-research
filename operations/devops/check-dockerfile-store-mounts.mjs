// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Regression guard for the warm-layer / cold-store build failure (t/4883, fixed by #4565).
//
// WHY: container.yml run 41957003986 failed all 3 attempts at `pnpm licenses list`. The
// builder's `pnpm install` layers came from the layer cache (`cache-to mode=max`, #4498), but
// the pnpm store lived in a BuildKit `--mount=type=cache`, which is empty on a fresh runner.
// The cached install restored node_modules without the store, and licenses reads package index
// files from the store. #4565 moved the builder store into the image layer. Two checks keep it
// from coming back:
//
//   lint   -- the fast tripwire: the `builder` stage of taxonomy-editor/Dockerfile must not
//             mount the pnpm store as a cache (other stages, e.g. prod-deps, may: they don't
//             run licenses).
//   log    -- the behavioural proof: given the --progress=plain log of a rebuild on a FRESH
//             builder (empty cache mounts) seeded from the first build's layer cache, the
//             builder's `pnpm install` must be CACHED and generate-notices must have run and
//             written the notices. A log where the build step was itself CACHED proves nothing
//             (licenses never ran) and is reported as such, never as a pass.
//
// Pure cores are unit-tested (check-dockerfile-store-mounts.test.mjs); the CLI is the shim.
//
//   node operations/devops/check-dockerfile-store-mounts.mjs lint [Dockerfile]
//   node operations/devops/check-dockerfile-store-mounts.mjs log <buildkit-plain-log> [--advisory] [--lockfile-pr]
//
// --advisory (TL, t/4883#2): a non-pass verdict is annotated ::warning:: instead of ::error::
// while the CI step runs continue-on-error. The exit code still reflects the verdict, so the
// step outcome records each run for the >=5-run promotion evidence.
//
// --lockfile-pr (DevOps Lead, t/4902, p/648#332): since t/4883's blocking promotion (#4634), a
// PR that changes pnpm-lock.yaml/package.json/pnpm-workspace.yaml can never find its install in
// main's GHA cache (t/4902) and reads INCONCLUSIVE every time — a false-red for Dependabot/
// security bumps, not a regression. Pass this flag (from a caller-side diff check against the
// PR base, not done here) to downgrade ONLY `inconclusive` to a non-blocking ::warning:: with
// exit 0. A `fail` verdict (the real regression) still errors and still fails, lockfile PR or not.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STORE_MOUNT = /--mount=type=cache,[^\s]*target=[^\s,]*pnpm\/store/;

/**
 * PURE. Returns the 1-based line numbers of pnpm-store cache mounts inside the named stage.
 * Stage boundaries are `FROM ... AS <name>` lines; a stage runs until the next FROM.
 */
export function findStoreMountsInStage(dockerfileText, stage = 'builder') {
  const hits = [];
  let current = null;
  dockerfileText.split(/\r?\n/).forEach((line, i) => {
    const from = line.match(/^\s*FROM\s+\S+(?:\s+AS\s+(\S+))?/i);
    if (from) { current = from[1] ? from[1].toLowerCase() : null; return; }
    if (current === stage.toLowerCase() && STORE_MOUNT.test(line)) hits.push(i + 1);
  });
  return hits;
}

/**
 * PURE. Reads a `docker buildx build --progress=plain` log and decides whether it proves the
 * warm-layer / cold-store path. Returns { verdict, installCached, noticesWritten, buildStepCached, reason }.
 * verdict: 'pass' | 'fail' | 'inconclusive'.
 */
export function checkColdStoreLog(log) {
  const lines = log.split(/\r?\n/);
  const stepId = (re) => {
    const m = lines.map((l) => l.match(/^(#\d+) \[builder [^\]]*\] RUN (.*)$/)).find((x) => x && re.test(x[2]));
    return m ? m[1] : null;
  };
  const resultOf = (id) => {
    if (!id) return null;
    const r = lines.find((l) => l.startsWith(`${id} CACHED`) || l.startsWith(`${id} DONE`) || l.startsWith(`${id} ERROR`));
    return r ? r.slice(id.length + 1).split(/\s+/)[0] : null;
  };
  const installId = stepId(/pnpm install --frozen-lockfile/);
  const buildId = stepId(/build:container/);
  const installCached = resultOf(installId) === 'CACHED';
  const buildResult = resultOf(buildId);
  const buildStepCached = buildResult === 'CACHED';
  const noticesWritten = lines.some((l) => /generate-notices: wrote /.test(l));
  const noticesFailed = lines.some((l) => /generate-notices: ".*licenses list" failed/.test(l));

  if (!installId || !buildId) {
    return { verdict: 'inconclusive', installCached, noticesWritten, buildStepCached,
      reason: `could not find the builder ${!installId ? 'pnpm install' : 'build:container'} step in the log` };
  }
  if (noticesFailed || buildResult === 'ERROR') {
    return { verdict: 'fail', installCached, noticesWritten, buildStepCached,
      reason: 'generate-notices failed on a cold pnpm store: the t/4883 regression is back' };
  }
  if (!installCached) {
    return { verdict: 'inconclusive', installCached, noticesWritten, buildStepCached,
      reason: 'the builder pnpm install was NOT cached, so this run did not exercise the warm-layer path' };
  }
  if (buildStepCached || !noticesWritten) {
    return { verdict: 'inconclusive', installCached, noticesWritten, buildStepCached,
      reason: 'the build:container step did not execute (cached), so licenses never ran against the cold store' };
  }
  return { verdict: 'pass', installCached, noticesWritten, buildStepCached,
    reason: 'install CACHED, build:container executed, generate-notices wrote the notices' };
}

/**
 * PURE. Decides the CLI's exit code and annotation level for a verdict, given CLI flags.
 * `lockfilePR` (t/4902): an `inconclusive` verdict on a PR that changed the lockfile/manifest
 * is an expected GHA-cache miss, not a regression — downgrade to a non-blocking warning. A
 * `fail` verdict is always a real regression and always blocks, lockfile PR or not.
 */
export function decideLogStepOutcome(verdict, { advisory = false, lockfilePR = false } = {}) {
  if (verdict === 'pass') return { exitCode: 0, level: null };
  if (verdict === 'inconclusive' && lockfilePR) return { exitCode: 0, level: 'warning' };
  return { exitCode: 1, level: advisory ? 'warning' : 'error' };
}

const isCliEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliEntry) {
  const [mode, path] = process.argv.slice(2);
  const advisory = process.argv.includes('--advisory');
  const lockfilePR = process.argv.includes('--lockfile-pr');
  try {
    if (mode === 'lint') {
      const file = path ?? 'taxonomy-editor/Dockerfile';
      const hits = findStoreMountsInStage(readFileSync(file, 'utf8'), 'builder');
      if (hits.length) {
        for (const n of hits) console.log(`::error file=${file},line=${n}::pnpm-store cache mount in the builder stage (t/4883). A layer-cache hit restores node_modules without the store and \`pnpm licenses list\` fails. Keep the builder store in the image layer (#4565).`);
        process.exit(1);
      }
      console.log(`check-dockerfile-store-mounts: ${file} builder stage has no pnpm-store cache mount.`);
    } else if (mode === 'log' && path) {
      const r = checkColdStoreLog(readFileSync(path, 'utf8'));
      const msg = `cold-store rebuild: ${r.verdict.toUpperCase()} -- ${r.reason} (installCached=${r.installCached}, buildStepCached=${r.buildStepCached}, noticesWritten=${r.noticesWritten})`;
      const { exitCode, level } = decideLogStepOutcome(r.verdict, { advisory, lockfilePR });
      console.log(level ? `::${level}::${msg}` : msg);
      process.exit(exitCode);
    } else {
      console.log('::error::usage: check-dockerfile-store-mounts.mjs lint [Dockerfile] | log <buildkit-plain-log>');
      process.exit(2);
    }
  } catch (err) {
    console.log(`::error::check-dockerfile-store-mounts could not run: ${err.message ?? err}`);
    process.exit(2);
  }
}
