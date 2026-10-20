// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4258/t/4281 (TL, e/310#4): "gate silently dead" (docs/CodeReview/failure-classes.md
 * Class 8), not a one-off — alert-github-rate-limit-warning/-critical turned out dead
 * because their emitters only ever reached FlightRecorder, never console. This is the
 * general prevention: for every log-based `alert-*` scheduled query in main.bicep,
 * extract the literal string(s) its KQL matches against `Log_s`, and assert at least
 * one `log.*` call in the server source actually emits each one. A missing emitter
 * fails loudly instead of silently never firing.
 *
 * Deliberately pure fs/regex, no mocking, no GitHubAPIBackend construction — so this
 * runs on any Node version, unlike the undici-gated githubApi*.test.ts files.
 *
 * ALLOWLIST (platform logs, not app `log.*` calls — auto-detected by table name):
 * any alert whose query starts from `ContainerAppSystemLogs_CL` (ACA's own platform
 * diagnostic table — Reason_s/Log_s there are emitted by Azure Container Apps itself,
 * never by this app's Pino logger) is exempt. As of this writing that's
 * alert-restart-loop, alert-image-pull-failure, alert-staging-container-backoff and
 * alert-prod-container-backoff. Metric-based alerts (no `query` field at all — e.g.
 * alert-ingress-5xx-backstop) are exempt for the same reason: they're not log-based.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const BICEP_PATH = path.join(REPO_ROOT, 'deploy/azure/main.bicep');
const SERVER_SRC_ROOT = path.join(REPO_ROOT, 'taxonomy-editor/src/server');

interface AlertQuery {
  name: string;
  query: string;
}

/** Extract every `name: 'alert-...'` ... `query: '''...'''` pair from main.bicep. */
function extractAlertQueries(bicepText: string): AlertQuery[] {
  const alerts: AlertQuery[] = [];
  const nameRe = /name:\s*'(alert-[a-z0-9-]+)'/g;
  let nameMatch: RegExpExecArray | null;
  while ((nameMatch = nameRe.exec(bicepText))) {
    const name = nameMatch[1];
    const afterName = bicepText.slice(nameMatch.index);
    // The next `query: '''...'''` block belongs to this alert, if one exists before
    // the next `name: 'alert-...'` (i.e. before the next resource starts).
    const nextNameIdx = afterName.slice(1).search(/name:\s*'alert-[a-z0-9-]+'/);
    const scope = nextNameIdx === -1 ? afterName : afterName.slice(0, nextNameIdx + 1);
    const queryMatch = scope.match(/query:\s*'''([\s\S]*?)'''/);
    if (queryMatch) alerts.push({ name, query: queryMatch[1] });
    // else: no `query` field — a metric alert (e.g. scheduledQueryRules-free), exempt.
  }
  return alerts;
}

/** Literal strings a KQL `where Log_s contains/has "X"` clause matches against. */
function extractLogLiterals(query: string): string[] {
  const literals: string[] = [];
  const re = /Log_s\s+(?:contains|has)\s+"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query))) literals.push(m[1]);
  return literals;
}

function isPlatformLogAlert(query: string): boolean {
  return /^\s*ContainerAppSystemLogs_CL/.test(query);
}

/** All .ts files under `root`, excluding `__tests__` directories. */
function walkServerSourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkServerSourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

// Window is bidirectional: a `log.*(data, message)` call's `message` is often a
// variable built by a helper a few dozen lines earlier in the same file (e.g.
// eventLoopMonitor.ts builds `{ level, message }` ~60 lines above its `log.server.warn`
// call site) — a forward-only window misses that. 4000 back / 1000 forward is sized
// to bridge that gap while staying far short of two genuinely-unrelated call sites in
// a long file (verified against githubAPIBackend.ts's real dead `cache.miss` literal,
// whose nearest actual log.* call is ~8500 chars away).
const BACKWARD_WINDOW = 4000;
const FORWARD_WINDOW = 1000;

/** True if any `log.<ns>.<level>(...)` call's nearby text contains `literal`. */
function hasLogEmitter(literal: string, sourceFiles: { path: string; text: string }[]): { file: string; line: number } | null {
  const callRe = /log\.\w+\.(warn|error|info|debug)\(/g;
  for (const { path: filePath, text } of sourceFiles) {
    let m: RegExpExecArray | null;
    callRe.lastIndex = 0;
    while ((m = callRe.exec(text))) {
      const window = text.slice(Math.max(0, m.index - BACKWARD_WINDOW), m.index + FORWARD_WINDOW);
      if (window.includes(literal)) {
        const line = text.slice(0, m.index).split('\n').length;
        return { file: path.relative(REPO_ROOT, filePath), line };
      }
    }
  }
  return null;
}

describe('alert-to-emitter contract (t/4258/t/4281, failure-classes.md Class 8)', () => {
  const bicepText = fs.readFileSync(BICEP_PATH, 'utf-8');
  const alerts = extractAlertQueries(bicepText);
  const sourceFiles = walkServerSourceFiles(SERVER_SRC_ROOT).map((p) => ({ path: p, text: fs.readFileSync(p, 'utf-8') }));

  it('found a non-trivial number of alert-* scheduled queries to check (sanity floor)', () => {
    // Guards against the extractor silently matching nothing if main.bicep's shape changes.
    expect(alerts.length).toBeGreaterThanOrEqual(10);
  });

  const liveAlerts = alerts.filter((a) => !isPlatformLogAlert(a.query));

  it.each(liveAlerts.map((a) => [a.name, a] as const))(
    '%s: every Log_s literal it matches has a server log.* emitter',
    (_name, alert) => {
      const literals = extractLogLiterals(alert.query);
      for (const literal of literals) {
        const emitter = hasLogEmitter(literal, sourceFiles);
        expect(
          emitter,
          `${alert.name}: no log.* call emits "${literal}" — this alert's KQL query will never match ` +
            `anything in ContainerAppConsoleLogs_CL (the "gate silently dead" class, failure-classes.md #8). ` +
            `Add a log.<ns>.warn/error call whose message or data contains "${literal}" verbatim, or fix the ` +
            `alert's query if the literal is stale.`,
        ).not.toBeNull();
      }
    },
  );
});
