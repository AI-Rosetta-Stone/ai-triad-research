// t/4486 (TL review, t/4486#2) — "Route enumeration" gate-signal-integrity test. The free-tier
// geo restriction lives at key INJECTION (ai/freePoolKeyAccess.ts), not at tier resolution,
// because a route was found (`/api/nli/classify`) that injected the pool directly and never
// touched `generationContext.ts`'s resolveGenerationContext/enforceBackendAllowed gate — a guard
// placed only there would have missed it silently. This test is the backstop: it fails if a
// FOURTH call site starts reading `FREE_TIER_GEMINI_KEY` or calling `parseFreeTierKeys(` outside
// the allowlist below, so a future route can't bypass the geo gate the same way.
//
// Scope: counting/diagnostics reads (pool size for a log line or /health) are NOT injection and
// are allowed via `proxyTiers.freeTierKeyCount()` from any file — this test only flags a file
// that reads the raw env var or calls `parseFreeTierKeys(` directly.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = join(HERE, '..'); // src/server

/** The only files allowed to read `process.env.FREE_TIER_GEMINI_KEY` or call
 *  `parseFreeTierKeys(` directly, each with why (t/4486#2):
 *  - ai/proxyTiers.ts        defines parseFreeTierKeys + its own count/rpm/enabled helpers
 *  - ai/keyRotator.ts        boot-time pool-membership Set (not per-request injection)
 *  - server.ts               boot diagnostics log line (pool size at startup)
 *  - ai/freePoolKeyAccess.ts the ONE request-path injection accessor — applies the geo gate */
const ALLOWLIST = new Set([
  'ai/proxyTiers.ts',
  'ai/keyRotator.ts',
  'server.ts',
  'ai/freePoolKeyAccess.ts',
]);

const PATTERN = /process\.env\.FREE_TIER_GEMINI_KEY|parseFreeTierKeys\s*\(/;

/** Strip `//` line comments and block comments crudely — good enough for this codebase's
 *  style (no `//` inside string literals on these particular lines in practice; a false
 *  negative here would show up as a flagged file needing a human look anyway). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(line => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules' || entry === 'data') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('FREE_TIER_GEMINI_KEY has exactly one injection-path reader (t/4486)', () => {
  it('no file outside the allowlist reads the raw env var or calls parseFreeTierKeys(', () => {
    const offenders: string[] = [];
    for (const file of collectTsFiles(SERVER_SRC)) {
      const rel = relative(SERVER_SRC, file).replace(/\\/g, '/');
      const src = stripComments(readFileSync(file, 'utf-8'));
      if (PATTERN.test(src) && !ALLOWLIST.has(rel)) offenders.push(rel);
    }
    expect(offenders, `Unexpected reader(s) of FREE_TIER_GEMINI_KEY / parseFreeTierKeys(:\n${offenders.join('\n')}\n\nFix: inject the free pool only via ai/freePoolKeyAccess.ts's getFreePoolKeys(req, res), or count it via ai/proxyTiers.ts's freeTierKeyCount() — never read the env var or call parseFreeTierKeys( directly outside the allowlist in this test.`).toEqual([]);
  });

  it('every allowlisted file still exists and still matches the pattern (catches a stale allowlist entry)', () => {
    for (const rel of ALLOWLIST) {
      const full = join(SERVER_SRC, rel);
      const src = stripComments(readFileSync(full, 'utf-8'));
      expect(PATTERN.test(src), `${rel} is allowlisted but no longer reads FREE_TIER_GEMINI_KEY/parseFreeTierKeys( — remove it from ALLOWLIST`).toBe(true);
    }
  });
});
