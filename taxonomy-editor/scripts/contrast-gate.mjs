// Verdict for the token-contrast ratchet gate (t/111), kept apart from check-contrast.sh so both
// arms are unit-testable (docs/CodeReview/gate-signal-integrity.md rules 1 and 4).
//
// The gate used to fail OPEN: a truncated --json payload made the count empty, `[ "" -gt N ]`
// errored, and the script fell through to "OK". Every decision below fails CLOSED: anything the
// gate can't read is UNREADABLE (exit 1), never OK.
//
// CLI: node contrast-gate.mjs <stdoutFile> <checkerExitCode> <ceiling>
//   prints one line and exits 0 (OK) or 1 (FAIL / UNREADABLE).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NON_NEGATIVE_INT = /^\d+$/;

/**
 * @param {{ stdout: string, exitCode: number, ceiling: unknown }} input
 * @returns {{ ok: boolean, verdict: 'OK' | 'FAIL' | 'UNREADABLE', count: number | null, message: string, warnings?: string[] }}
 */
export function evaluateContrastGate({ stdout, exitCode, ceiling }) {
  const unreadable = (why) => ({
    ok: false,
    verdict: 'UNREADABLE',
    count: null,
    message: `GATE UNREADABLE: ${why}. The contrast gate fails closed; fix the checker or its output before merging.`,
  });

  const ceilingText = String(ceiling ?? '').trim();
  if (!NON_NEGATIVE_INT.test(ceilingText)) {
    return unreadable(`contrast ceiling is not a non-negative integer (got '${ceilingText}') in quality-gates.json`);
  }
  const ceilingNum = Number(ceilingText);

  // check-contrast.mjs exits 0 (no findings) or 1 (findings present). Anything else is a crash.
  if (exitCode !== 0 && exitCode !== 1) {
    return unreadable(`check-contrast.mjs exited ${exitCode} (expected 0 or 1)`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    return unreadable(`check-contrast.mjs --json output did not parse (${stdout.length} bytes; ${err.message})`);
  }
  if (!parsed || !Array.isArray(parsed.findings)) {
    return unreadable('check-contrast.mjs --json output has no findings array');
  }

  const count = parsed.findings.length;
  if ((exitCode === 0) !== (count === 0)) {
    return unreadable(`check-contrast.mjs exit code ${exitCode} disagrees with ${count} findings`);
  }
  // t/147: color-mix values the checker could not measure are not in the count. Warn on every run,
  // pass or fail, so they can't hide behind a green gate.
  const warnings = (Array.isArray(parsed.unmeasured) ? parsed.unmeasured : []).map(
    (v) => `WARN: color-mix value not measured, so its pairs are not in the count: ${v}`,
  );
  if (count > ceilingNum) {
    return {
      ok: false,
      verdict: 'FAIL',
      count,
      warnings,
      message: `FAIL: contrast findings (${count}) exceeded ceiling (${ceilingNum}). The ceiling only goes DOWN. Fix the new violations before merging.`,
    };
  }
  return { ok: true, verdict: 'OK', count, warnings, message: `contrast check: ${count} / ${ceilingNum} findings (OK)` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [stdoutFile, exitCodeArg, ceiling] = process.argv.slice(2);
  let stdout = '';
  try {
    stdout = readFileSync(stdoutFile, 'utf8');
  } catch (err) {
    console.log(`GATE UNREADABLE: could not read checker output '${stdoutFile}' (${err.message}).`);
    process.exitCode = 1;
  }
  if (process.exitCode !== 1) {
    const result = evaluateContrastGate({ stdout, exitCode: Number(exitCodeArg), ceiling });
    // `::warning::` makes GitHub Actions annotate the run, so a green check still shows them.
    for (const w of result.warnings ?? []) console.log(`::warning::${w}`);
    console.log(result.message);
    process.exitCode = result.ok ? 0 : 1;
  }
}
