// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Packed-build extraction check (t/660, for t/631). ci.yml's packed-extract-check job packs the
// desktop app with electron-builder and runs this against the unpacked result.
//
// Why: t/631. The packed app could not extract any PDF or DOCX, because the isolated parser
// looked for its dependencies at a path that exists only in a dev tree. Every test ran against
// dist/ or source, so nothing saw it. Only a run through the PACKED app's own binary and its
// app.asar layer can.
//
// What it does: finds the packed executable and its resources dir, then runs Shared Lib's
// lib/extraction/packed-extract-check.cjs as
//   ELECTRON_RUN_AS_NODE=1 <packed exe> packed-extract-check.cjs <resources dir> <fixtures dir>
// That script imports the extractor from app.asar, extracts the fixtures, and exits 1 when the
// text-layer fixture does not extract. No window opens.
//
// Verdict (operations/devops/gate-verdict.mjs, t/4496; docs/CodeReview/gate-signal-integrity.md §3):
//   PASS             the check ran in the packed app, exited 0, and printed an extraction line.
//   FAIL             the check ran in the packed app and exited non-zero: extraction is broken.
//   GATE-UNREADABLE  the check could not run or gave no usable answer: no packed build, no single
//                    executable, no app.asar, the check script or fixtures are missing, the
//                    process could not start or timed out, or it exited 0 without an extraction
//                    line. No verdict: never read it as a pass.
//
// Exit code: 1 on FAIL. 0 on PASS. 0 on GATE-UNREADABLE (with a warning annotation), or 2 with
// --strict. The job is not in ci-gate's needs (never-gating), so neither exit blocks a merge.
//
// Pure core: pickExecutable, evaluatePackedExtract. I/O: inspectPackedApp, runCheck, runCli.
// Run the tests: node --test operations/devops/packed-extract-gate.test.mjs
// Run it:        node operations/devops/packed-extract-gate.mjs --unpacked <dir> --check <file>
//                  --fixtures <dir> [--timeout-sec N] [--strict]

import { appendFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { VERDICTS, makeGateVerdict, classifyReadFailure, formatVerdictOutputs, formatVerdictSummary } from './gate-verdict.mjs';

export const GATE = 'packed-extract-check';

// Executables electron-builder puts beside the app's own binary. They are never the app.
const HELPER_BINARIES = new Set(['chrome-sandbox', 'chrome_crashpad_handler']);

/**
 * PURE. Choose the app's executable from the unpacked dir's entries.
 * Windows: the one `.exe`. Elsewhere: the one regular file with no extension and an execute bit
 * that is not a known helper. Anything but exactly one candidate is an error, never a guess.
 * @param {{name: string, isFile: boolean, mode: number}[]} entries
 * @param {string} platform process.platform
 * @returns {{exe: string} | {error: string}}
 */
export function pickExecutable(entries, platform) {
  const files = entries.filter((e) => e.isFile && !HELPER_BINARIES.has(e.name));
  const candidates =
    platform === 'win32'
      ? files.filter((e) => e.name.toLowerCase().endsWith('.exe'))
      : files.filter((e) => !e.name.includes('.') && (e.mode & 0o111) !== 0);
  if (candidates.length === 1) return { exe: candidates[0].name };
  if (candidates.length === 0) return { error: `no executable found among ${entries.length} entries` };
  return { error: `${candidates.length} executables found, expected one: ${candidates.map((c) => c.name).join(', ')}` };
}

/**
 * PURE. Turn what happened into a verdict.
 * @param {{problem?: string, spawnError?: unknown, timedOut?: boolean, status?: number|null,
 *          signal?: string|null, output?: string, ms?: number}} r
 */
export function evaluatePackedExtract(r) {
  if (r.problem) return makeGateVerdict({ gate: GATE, verdict: VERDICTS.UNREADABLE, reason: r.problem });
  const lines = String(r.output ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const details = lines.slice(-12);
  const took = Number.isFinite(r.ms) ? ` in ${r.ms} ms` : '';
  if (r.timedOut) {
    return makeGateVerdict({ gate: GATE, verdict: VERDICTS.UNREADABLE, reason: `the check did not finish${took} and was killed (timeout)`, details });
  }
  if (r.spawnError) {
    return makeGateVerdict({ gate: GATE, verdict: VERDICTS.UNREADABLE, reason: `the packed executable could not be started: ${classifyReadFailure(r.spawnError)}`, details });
  }
  if (r.status === null || r.status === undefined) {
    return makeGateVerdict({ gate: GATE, verdict: VERDICTS.UNREADABLE, reason: `the check ended with no exit code (signal ${r.signal ?? 'unknown'})`, details });
  }
  if (r.status !== 0) {
    const first = lines.find((l) => /THREW|FATAL/.test(l)) ?? lines[lines.length - 1] ?? 'no output';
    return makeGateVerdict({ gate: GATE, verdict: VERDICTS.FAIL, reason: `the packed app's extraction check exited ${r.status}${took}: ${first}`, details });
  }
  const ok = lines.filter((l) => /: OK format=/.test(l));
  if (ok.length === 0) {
    return makeGateVerdict({ gate: GATE, verdict: VERDICTS.UNREADABLE, reason: 'the check exited 0 but printed no "<fixture>: OK format=" line, so nothing shows a document was extracted', details });
  }
  // TL t/631#24: PDF alone does not pass. Both required formats must be reported, by name.
  const missing = ['pdf', 'docx'].filter((f) => !lines.some((l) => l.includes(`: OK format=${f} `)));
  if (missing.length > 0) {
    return makeGateVerdict({ gate: GATE, verdict: VERDICTS.FAIL, reason: `the check exited 0 but did not report "OK format=${missing.join('" and "OK format=')}" (both pdf and docx must extract through the packed app)`, details });
  }
  return makeGateVerdict({ gate: GATE, verdict: VERDICTS.PASS, reason: `${ok.length} fixture(s) extracted through the packed app${took}`, details });
}

/** I/O. Locate the executable and resources dir. Returns { exe, resources } or { problem }. */
export function inspectPackedApp({ unpacked, check, fixtures }, platform = process.platform) {
  if (!check || !existsSync(check)) return { problem: `the check script is not in this checkout: ${check || '(no --check given)'}` };
  if (!fixtures || !existsSync(fixtures)) return { problem: `the fixtures dir is not in this checkout: ${fixtures || '(no --fixtures given)'}` };
  if (!unpacked || !existsSync(unpacked)) return { problem: `the packed build is missing: ${unpacked || '(no --unpacked given)'}` };
  const resources = join(unpacked, 'resources');
  if (!existsSync(join(resources, 'app.asar'))) return { problem: `no app.asar under ${resources}` };
  let entries;
  try {
    entries = readdirSync(unpacked).map((name) => {
      const st = statSync(join(unpacked, name));
      return { name, isFile: st.isFile(), mode: st.mode };
    });
  } catch (e) {
    return { problem: `could not list ${unpacked}: ${classifyReadFailure(e)}` };
  }
  const picked = pickExecutable(entries, platform);
  if (picked.error) return { problem: `${picked.error} in ${unpacked}` };
  return { exe: join(unpacked, picked.exe), resources };
}

/** I/O. Run the check under the packed binary as plain Node. Never throws. */
export function runCheck({ exe, check, resources, fixtures, timeoutSec }, spawn = spawnSync) {
  const started = Date.now();
  const r = spawn(exe, [check, resources, fixtures], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: timeoutSec * 1000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const ms = Date.now() - started;
  const timedOut = Boolean(r.error && r.error.code === 'ETIMEDOUT');
  return {
    spawnError: timedOut ? undefined : r.error,
    timedOut,
    status: r.status,
    signal: r.signal,
    output: `${r.stdout ?? ''}\n${r.stderr ?? ''}`,
    ms,
  };
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** CLI. Returns the exit code. `deps` lets the tests replace the file system and the process. */
export function runCli(argv, deps = {}) {
  const { inspect = inspectPackedApp, run = runCheck, log = console.log, env = process.env, append = appendFileSync } = deps;
  const strict = argv.includes('--strict');
  const timeoutSec = Number(argValue(argv, '--timeout-sec') ?? 120);
  const paths = {
    unpacked: argValue(argv, '--unpacked'),
    check: argValue(argv, '--check'),
    fixtures: argValue(argv, '--fixtures'),
  };

  let result;
  const found = inspect(paths);
  if (found.problem) {
    log(`WARN: packed-extract-gate did not run the check (${found.problem}); reporting GATE-UNREADABLE, not a pass.`);
    result = { problem: found.problem };
  } else {
    log(`packed-extract-gate: ELECTRON_RUN_AS_NODE=1 ${found.exe} ${paths.check} ${found.resources} ${paths.fixtures}`);
    result = run({ exe: found.exe, check: resolvePath(paths.check), resources: found.resources, fixtures: resolvePath(paths.fixtures), timeoutSec });
    log(`packed-extract-gate: check wall time ${result.ms} ms`);
  }
  const v = evaluatePackedExtract(result);

  log(`GATE-VERDICT ${v.gate}: ${v.verdict} - ${v.reason}`);
  for (const d of v.details) log(`  ${d}`);
  if (env.GITHUB_ACTIONS === 'true' && v.verdict !== VERDICTS.PASS) {
    log(`::${v.verdict === VERDICTS.FAIL ? 'error' : 'warning'} title=${v.verdict}::${v.gate}: ${v.reason}`);
  }
  try {
    if (env.GITHUB_OUTPUT) {
      const out = formatVerdictOutputs(v);
      append(env.GITHUB_OUTPUT, Object.entries(out).map(([k, val]) => `${k}=${val}\n`).join(''));
    }
    if (env.GITHUB_STEP_SUMMARY) append(env.GITHUB_STEP_SUMMARY, `${formatVerdictSummary(v)}\n`);
  } catch (e) {
    log(`WARN: could not write the gate verdict to the step outputs or summary (${e && e.message}); this log line still carries it.`);
  }

  if (v.verdict === VERDICTS.FAIL) return 1;
  if (v.verdict === VERDICTS.UNREADABLE && strict) return 2;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href) {
  process.exitCode = runCli(process.argv.slice(2));
}
