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
//   node operations/devops/check-dockerfile-store-mounts.mjs log <buildkit-plain-log> [--advisory]
//   node operations/devops/check-dockerfile-store-mounts.mjs probe-install-cached <buildkit-plain-log>
//
// --advisory (TL, t/4883#2): a non-pass verdict is annotated ::warning:: instead of ::error::
// while the CI step runs continue-on-error. The exit code still reflects the verdict, so the
// step outcome records each run for the >=5-run promotion evidence.
//
// probe-install-cached (TL review, t/4902, PR #4642): exits 0 when the log's builder `pnpm
// install` step was CACHED, 1 otherwise. ci.yml's cold-store step calls this on its first,
// GHA-seeded attempt (`--cache-from type=gha,scope=shared-docker`) for a non-lockfile PR; a
// non-zero exit means the shared GHA cache missed (evicted, or this run never populated it),
// and the step falls back to the self-seeded `type=local` export path (WARN logged) rather than
// reading inconclusive or failing outright. A lockfile/manifest-changing PR skips the GHA
// attempt entirely and goes straight to the self-seed path, since it can never hit main's GHA
// cache (t/4902) — both fallback reasons keep the gate PROVEN and BLOCKING on every PR, per the
// TL's t/4902 review: a cheaper check must never weaken the check on its riskiest PR class.

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
 * A non-pass verdict always blocks (exit 1); `advisory` only softens the annotation to a
 * warning for the >=5-run promotion-evidence period, never the exit code.
 */
export function decideLogStepOutcome(verdict, { advisory = false } = {}) {
  if (verdict === 'pass') return { exitCode: 0, level: null };
  return { exitCode: 1, level: advisory ? 'warning' : 'error' };
}

/**
 * PURE. True when ci.yml's cold-store step should fall back from the GHA-seeded attempt to the
 * self-seeded local-export path: the GHA `shared-docker` cache didn't contain this PR's install
 * (a lockfile-PR miss or an LRU eviction, t/4902 TL review). Reuses checkColdStoreLog's own
 * installCached detection rather than re-parsing the log.
 */
export function shouldFallbackFromGha(log) {
  return !checkColdStoreLog(log).installCached;
}

const isCliEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliEntry) {
  const [mode, path] = process.argv.slice(2);
  const advisory = process.argv.includes('--advisory');
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
      const { exitCode, level } = decideLogStepOutcome(r.verdict, { advisory });
      console.log(level ? `::${level}::${msg}` : msg);
      process.exit(exitCode);
    } else if (mode === 'probe-install-cached' && path) {
      const cached = checkColdStoreLog(readFileSync(path, 'utf8')).installCached;
      console.log(`check-dockerfile-store-mounts: builder pnpm install cached=${cached}`);
      process.exit(cached ? 0 : 1);
    } else {
      console.log('::error::usage: check-dockerfile-store-mounts.mjs lint [Dockerfile] | log <buildkit-plain-log> | probe-install-cached <buildkit-plain-log>');
      process.exit(2);
    }
  } catch (err) {
    console.log(`::error::check-dockerfile-store-mounts could not run: ${err.message ?? err}`);
    process.exit(2);
  }
}
