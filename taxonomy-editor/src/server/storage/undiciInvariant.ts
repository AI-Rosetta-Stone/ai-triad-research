// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { createRequire } from 'module';

// Invariant guard: the Agent in githubRestClient is constructed from userland undici and
// passed as dispatcher: to Node's built-in fetch. This only works correctly when the
// userland major equals the node-bundled major — mismatched majors cause fetch to silently
// ignore the dispatcher, re-enabling TLS session caching (CVE-2026-58040, t/2053).
// Extracted to its own module so tests can import the function without triggering the
// module-level startup check in githubRestClient.ts. (t/2113)
export function assertUndiciMajorInvariant(
  userlandVersion: string,
  bundledVersion: string | undefined,
): void {
  if (!bundledVersion) return; // node <22 has no bundled undici — skip
  if (undiciMajorsAligned(userlandVersion, bundledVersion)) return;
  throw new Error(
    `undici major-version skew: userland ${userlandVersion} vs node built-in ${bundledVersion}. ` +
    `The GitHub dispatcher passes an undici.Agent as dispatcher: to Node's built-in fetch — ` +
    `mismatched majors cause fetch to silently ignore the dispatcher and fall back to TLS ` +
    `session caching (CVE-2026-58040 condition). ` +
    `LOCAL-ONLY: CI's test runner (actions/setup-node) pins Node 26, which bundles undici 8.x ` +
    `matching the userland pin. Your local Node (${bundledVersion.split('.')[0]}.x) is outside ` +
    `the required range — switch to Node 26.x (see package.json engines: ">=26 <27") via ` +
    `nvm/fnm. (t/2053, t/2113, t/2281, t/1990)`,
  );
}

function undiciMajorsAligned(userlandVersion: string, bundledVersion: string): boolean {
  const userlandMajor = parseInt(userlandVersion.split('.')[0], 10);
  const bundledMajor = parseInt(bundledVersion.split('.')[0], 10);
  return userlandMajor === bundledMajor;
}

// t/3444: shared test-environment gate — lets local-only, Node-version-dependent test
// suites (githubApi.test.ts, t2020Security.test.ts) self-skip with `describe.skipIf(...)`
// instead of failing deterministically on every non-Node-22 dev machine, masking real
// local failures in the noise. Mirrors assertUndiciMajorInvariant's own comparison so the
// gate can never drift out of sync with the invariant it's gating tests around.
export function isUndiciMajorAlignedWithRuntime(): boolean {
  const bundledVersion = process.versions.undici;
  if (!bundledVersion) return true; // node <22 has no bundled undici — invariant doesn't apply
  const userlandVersion = (
    createRequire(import.meta.url)('undici/package.json') as { version: string }
  ).version;
  return undiciMajorsAligned(userlandVersion, bundledVersion);
}
