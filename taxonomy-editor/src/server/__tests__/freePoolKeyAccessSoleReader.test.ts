// t/4486 (TL review, t/4486#2 + t/4486#4) — "Route enumeration" gate-signal-integrity test. The
// free-tier geo restriction lives at key INJECTION (ai/freePoolKeyAccess.ts), not at tier
// resolution, because TWO bypasses were found during review:
//   - /api/nli/classify read the pool directly, never touching generationContext.ts's
//     resolveGenerationContext/enforceBackendAllowed gate (t/4486#2);
//   - proxyTiers.byokGeminiFallbackKey() (t/945) handed the free pool to a BYOK user with no
//     Gemini key, also reading the env var directly — found only because a FILE-level
//     allowlist for ai/proxyTiers.ts hid it among that file's legitimate count-only reads
//     (t/4486#4). byokGeminiFallbackKey is now byokGeminiFallbackApplies: a pure boolean
//     decision with NO env read; the caller fetches keys through getFreePoolKeys instead.
//
// This test is the backstop against a FIFTH bypass:
//   - most files get a FILE-level allowlist (boot/injection-accessor files, single export
//     each, low risk of a new function hiding among unrelated ones);
//   - ai/proxyTiers.ts — the file where the bypass actually hid — gets a FUNCTION-level
//     allowlist instead (t/4486#4): only the three named functions below may read the pool;
//     any other function added to that file that does is flagged, even though the file as a
//     whole is a legitimate reader.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = join(HERE, '..'); // src/server

/** Files allowed to read the pool WHOLESALE (boot or the one injection accessor) — each is
 *  single-purpose enough that a new bypass function hiding inside it is a low risk, unlike
 *  ai/proxyTiers.ts (handled separately, function-level, below):
 *  - ai/keyRotator.ts        boot-time pool-membership Set (not per-request injection)
 *  - server.ts               boot diagnostics log line (pool size at startup)
 *  - ai/freePoolKeyAccess.ts the ONE request-path injection accessor — applies the geo gate */
const FILE_ALLOWLIST = new Set([
  'ai/keyRotator.ts',
  'server.ts',
  'ai/freePoolKeyAccess.ts',
]);

/** ai/proxyTiers.ts (t/4486#4): FUNCTION-level allowlist, not file-level — this is the file
 *  the bypass hid in. Only these three may read the raw env var / call parseFreeTierKeys(;
 *  every other function in the file (e.g. a reintroduced byokGeminiFallbackKey) is flagged. */
const PROXY_TIERS_PATH = 'ai/proxyTiers.ts';
const PROXY_TIERS_FUNCTION_ALLOWLIST = new Set([
  'parseFreeTierKeys', // the definition itself
  'freeTierEnabled',   // count-only (> 0)
  'freeTierKeyCount',  // count-only (.length) — t/4486, for diagnostics/log call sites
]);

// t/4486 TL (Quality) follow-up: match the bare name, not just `process.env.FREE_TIER_GEMINI_KEY`
// — the dotted form misses bracket access (`process.env['FREE_TIER_GEMINI_KEY']`), which reads
// the exact same value. Nothing uses bracket access today; this closes the gap before it matters.
const PATTERN = /FREE_TIER_GEMINI_KEY|parseFreeTierKeys\s*\(/;

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

/** Split a (comment-stripped) source file into top-level function bodies: `{ name, body }` for
 *  each `(export )?(async )?function <name>(` at column 0, plus a final `{ name: null, body }`
 *  for any code before the first such function (module scope — must never match PATTERN here,
 *  there's no legitimate reason for it to). Good enough for this codebase's style: top-level
 *  functions are unindented and this file (proxyTiers.ts) has no nested same-pattern function. */
function splitTopLevelFunctions(src: string): Array<{ name: string | null; body: string }> {
  const re = /^(?:export )?(?:async )?function (\w+)\s*\(/gm;
  const matches: Array<{ name: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) matches.push({ name: m[1], index: m.index });
  const chunks: Array<{ name: string | null; body: string }> = [];
  if (matches.length === 0) return [{ name: null, body: src }];
  chunks.push({ name: null, body: src.slice(0, matches[0].index) });
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : src.length;
    chunks.push({ name: matches[i].name, body: src.slice(start, end) });
  }
  return chunks;
}

describe('FREE_TIER_GEMINI_KEY has exactly one injection-path reader (t/4486, t/4486#4)', () => {
  it('no file outside the allowlist reads the raw env var or calls parseFreeTierKeys( (file-level check)', () => {
    const offenders: string[] = [];
    for (const file of collectTsFiles(SERVER_SRC)) {
      const rel = relative(SERVER_SRC, file).replace(/\\/g, '/');
      if (rel === PROXY_TIERS_PATH) continue; // checked at function granularity below
      const src = stripComments(readFileSync(file, 'utf-8'));
      if (PATTERN.test(src) && !FILE_ALLOWLIST.has(rel)) offenders.push(rel);
    }
    expect(offenders, `Unexpected reader(s) of FREE_TIER_GEMINI_KEY / parseFreeTierKeys(:\n${offenders.join('\n')}\n\nFix: inject the free pool only via ai/freePoolKeyAccess.ts's getFreePoolKeys(req, res), or count it via ai/proxyTiers.ts's freeTierKeyCount() — never read the env var or call parseFreeTierKeys( directly outside the allowlist in this test.`).toEqual([]);
  });

  it('ai/proxyTiers.ts: only the allowlisted functions read the pool (function-level check, t/4486#4)', () => {
    const full = join(SERVER_SRC, PROXY_TIERS_PATH);
    const src = stripComments(readFileSync(full, 'utf-8'));
    const chunks = splitTopLevelFunctions(src);
    const offenders: string[] = [];
    for (const { name, body } of chunks) {
      if (!PATTERN.test(body)) continue;
      if (name && PROXY_TIERS_FUNCTION_ALLOWLIST.has(name)) continue;
      offenders.push(name ?? '<module scope, outside any function>');
    }
    expect(offenders, `Unexpected reader(s) of FREE_TIER_GEMINI_KEY / parseFreeTierKeys( inside ${PROXY_TIERS_PATH}:\n${offenders.join('\n')}\n\nThis is exactly how t/4486#4's bypass (byokGeminiFallbackKey) hid behind a file-level allowlist. A function here that needs the pool for INJECTION must not read it directly — have the caller go through ai/freePoolKeyAccess.ts's getFreePoolKeys(req, res) instead; a function that only needs a COUNT should call freeTierKeyCount() rather than re-reading the env var itself.`).toEqual([]);
  });

  it('every allowlisted file/function still exists and still matches the pattern (catches a stale allowlist entry)', () => {
    for (const rel of FILE_ALLOWLIST) {
      const full = join(SERVER_SRC, rel);
      const src = stripComments(readFileSync(full, 'utf-8'));
      expect(PATTERN.test(src), `${rel} is allowlisted but no longer reads FREE_TIER_GEMINI_KEY/parseFreeTierKeys( — remove it from FILE_ALLOWLIST`).toBe(true);
    }
    const proxyTiersSrc = stripComments(readFileSync(join(SERVER_SRC, PROXY_TIERS_PATH), 'utf-8'));
    const chunks = splitTopLevelFunctions(proxyTiersSrc);
    for (const fnName of PROXY_TIERS_FUNCTION_ALLOWLIST) {
      const chunk = chunks.find(c => c.name === fnName);
      expect(chunk, `${fnName} is in PROXY_TIERS_FUNCTION_ALLOWLIST but no top-level function with that name was found in ${PROXY_TIERS_PATH} — remove it or fix the parser`).toBeTruthy();
      expect(PATTERN.test(chunk!.body), `${fnName} is allowlisted but no longer reads FREE_TIER_GEMINI_KEY/parseFreeTierKeys( — remove it from PROXY_TIERS_FUNCTION_ALLOWLIST`).toBe(true);
    }
  });
});
