// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// CSS brace-balance check (t/420). WARN-ONLY: it reports a verdict and never fails the job.
//
// Why: nothing in the gate parses CSS (no stylelint; jsdom does not parse stylesheets), so a broken
// brace in any of the ~260 tracked .css files passed every gate. This is option A from t/420#1: a
// dependency-free scan that tracks {} depth, skipping /* */ comments, quoted strings and backslash
// escapes, and reports file:line of the first mismatch. It checks brace balance only, not property
// names or values.
//
// Verdict (operations/devops/gate-verdict.mjs, t/4496; docs/CodeReview/gate-signal-integrity.md §3):
//   PASS             every tracked .css file was read and is balanced.
//   FAIL             at least one file has an extra `}`, an unclosed `{`, or an unterminated comment.
//   GATE-UNREADABLE  the file list could not be read, it was empty, or any listed file could not be
//                    read. No verdict: never read it as clean.
//
// Pure core: checkCssBraces, evaluateCssFiles. I/O: listTrackedCss, readFiles, runCli.
// Run the tests: node --test operations/devops/css-brace-check.test.mjs
// Run it:        node operations/devops/css-brace-check.mjs [--strict]
//   Default (warn-only) always exits 0 and carries the verdict in its output, the step outputs
//   (`gate=`, `verdict=`, `reason=` in $GITHUB_OUTPUT) and the step summary. `--strict` exits 1 on
//   FAIL and 2 on GATE-UNREADABLE, for local use; CI must not pass it until the T2 promotion.

import { readFileSync, appendFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { VERDICTS, makeGateVerdict, classifyReadFailure, formatVerdictOutputs, formatVerdictSummary } from './gate-verdict.mjs';

export const GATE_NAME = 'css-brace-check';

/**
 * PURE. Scan one stylesheet. Returns { ok: true } or { ok: false, line, problem } for the first
 * mismatch. Lines are 1-based. An unclosed `{` is reported at the line of the innermost open brace.
 */
export function checkCssBraces(text) {
  const src = String(text ?? '');
  const open = []; // line numbers of unmatched `{`
  let line = 1;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') {
      line++;
      i++;
    } else if (ch === '/' && src[i + 1] === '*') {
      const startLine = line;
      const end = src.indexOf('*/', i + 2);
      if (end < 0) return { ok: false, line: startLine, problem: 'unterminated /* comment' };
      for (let k = i; k < end; k++) if (src[k] === '\n') line++;
      i = end + 2;
    } else if (ch === '"' || ch === "'") {
      // A CSS string ends at its matching quote; an unescaped newline ends it too (a bad-string
      // token), so a stray quote can never swallow the rest of the file.
      i++;
      while (i < src.length && src[i] !== ch && src[i] !== '\n') {
        if (src[i] === '\\' && i + 1 < src.length) {
          if (src[i + 1] === '\n') line++;
          i += 2;
        } else {
          i++;
        }
      }
      if (src[i] === ch) i++;
    } else if (ch === '\\') {
      if (src[i + 1] === '\n') line++;
      i += 2; // an escaped character (e.g. `\{`) is never a brace
    } else if (ch === '{') {
      open.push(line);
      i++;
    } else if (ch === '}') {
      if (open.length === 0) return { ok: false, line, problem: 'unexpected } (no matching {)' };
      open.pop();
      i++;
    } else {
      i++;
    }
  }
  if (open.length > 0) {
    return { ok: false, line: open[open.length - 1], problem: `unclosed { (${open.length} still open at end of file)` };
  }
  return { ok: true };
}

/**
 * PURE. The gate verdict over a set of files.
 * @param {{ files?: Array<{path: string, text?: string, readError?: unknown}>, listError?: unknown }} input
 */
export function evaluateCssFiles({ files, listError } = {}) {
  if (listError !== undefined) {
    return makeGateVerdict({
      gate: GATE_NAME,
      verdict: VERDICTS.UNREADABLE,
      reason: `could not list tracked .css files: ${classifyReadFailure(listError)}`,
    });
  }
  if (!Array.isArray(files) || files.length === 0) {
    return makeGateVerdict({
      gate: GATE_NAME,
      verdict: VERDICTS.UNREADABLE,
      reason: 'no tracked .css files were found; an empty list is not a clean pass',
    });
  }
  const unreadable = files.filter((f) => f.readError !== undefined || typeof f.text !== 'string');
  if (unreadable.length > 0) {
    return makeGateVerdict({
      gate: GATE_NAME,
      verdict: VERDICTS.UNREADABLE,
      reason: `${unreadable.length} of ${files.length} .css file(s) could not be read`,
      details: unreadable.map((f) => `${f.path}: ${classifyReadFailure(f.readError ?? 'no text')}`),
    });
  }
  const failures = [];
  for (const f of files) {
    const r = checkCssBraces(f.text);
    if (!r.ok) failures.push(`${f.path}:${r.line}: ${r.problem}`);
  }
  if (failures.length > 0) {
    return makeGateVerdict({
      gate: GATE_NAME,
      verdict: VERDICTS.FAIL,
      reason: `${failures.length} of ${files.length} .css file(s) have unbalanced braces; first: ${failures[0]}`,
      details: failures,
    });
  }
  return makeGateVerdict({
    gate: GATE_NAME,
    verdict: VERDICTS.PASS,
    reason: `${files.length} tracked .css file(s) read; braces balanced in all`,
  });
}

/** I/O. Tracked .css paths from git (NUL-separated, so odd names survive). Throws on failure. */
export async function listTrackedCss(cwd) {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('git', ['ls-files', '-z', '--', '*.css'], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return out.split('\0').filter(Boolean);
}

/** I/O. Read each file; a failure is recorded on the entry, never thrown. */
export function readFiles(paths, cwd) {
  return paths.map((p) => {
    try {
      return { path: p, text: readFileSync(resolvePath(cwd, p), 'utf8') };
    } catch (readError) {
      return { path: p, readError };
    }
  });
}

/** CLI. Returns the exit code. `deps` lets the tests replace the file system and environment. */
export async function runCli(argv, deps = {}) {
  const {
    cwd = process.cwd(),
    list = listTrackedCss,
    read = readFiles,
    log = console.log,
    env = process.env,
    append = appendFileSync,
  } = deps;
  const strict = argv.includes('--strict');
  let input;
  try {
    input = { files: read(await list(cwd), cwd) };
  } catch (listError) {
    log(`WARN: could not list tracked .css files with git; reporting GATE-UNREADABLE, not clean.`);
    input = { listError };
  }
  const v = evaluateCssFiles(input);

  log(`GATE-VERDICT ${v.gate}: ${v.verdict} - ${v.reason}`);
  for (const d of v.details) log(`  ${d}`);
  // Annotations: a warning for FAIL and GATE-UNREADABLE (warn-only), so the PR shows it.
  if (env.GITHUB_ACTIONS === 'true' && v.verdict !== VERDICTS.PASS) {
    log(`::warning title=${v.verdict}::${v.gate}: ${v.reason}`);
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

  if (!strict) return 0;
  if (v.verdict === VERDICTS.FAIL) return 1;
  if (v.verdict === VERDICTS.UNREADABLE) return 2;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
