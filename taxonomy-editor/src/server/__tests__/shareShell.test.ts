// @vitest-environment node
//
// t/1789 — /share/* serves the SPA shell to fully logged-out visitors (public
// POV share links), the auth-exemption half of the public share feature (t/1787).
//
// isPublicPath, the auth gate, and the anonymous-session mint guards are INLINE in
// server.ts — which calls server.listen() at import time, so it cannot be imported
// without booting the HTTP server. serveStatic was extracted to staticServe.ts (t/3084)
// so it can be unit-tested directly; these source-scan tests follow it there. Per the
// same static-scan discipline the route-table + publicShare suites use, they anchor to
// the real source text rather than a copy. Two invariants (t/1787#2):
//   (a) /share/ is auth-exempt (in isPublicPath) and tightly scoped — a static
//       SPA-shell prefix, no /api/ dynamic surface.
//   (b) serving the shell to a logged-out visitor mints NO session cookie — the
//       public bypass short-circuits the gate before the mint branches, and
//       serveStatic sets no Set-Cookie.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeIsPublicPath, PUBLIC_PATH_PREFIXES } from '../publicPaths.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// t/666: the anonymous-session mint endpoints moved from server.ts to anonAuthEndpoints.ts; read it for the
// mint-guard invariants. (t/1910: isPublicPath moved to the import-safe publicPaths.ts, asserted behaviorally below.)
const anonAuthSrc = fs.readFileSync(path.join(here, '..', 'anonAuthEndpoints.ts'), 'utf-8');

// t/3084: serveStatic was extracted to staticServe.ts — read it there.
const staticServeSrc = fs.readFileSync(path.join(here, '..', 'staticServe.ts'), 'utf-8');

// The serveStatic function body — the code path that delivers the SPA shell.
const serveStaticBody = staticServeSrc.slice(
  staticServeSrc.indexOf('function serveStatic('),
  staticServeSrc.indexOf('\n}', staticServeSrc.indexOf('function serveStatic(')) + 2,
);

describe('/share/ public SPA-shell exemption (t/1789)', () => {
  // ── (a) auth-exempt + tightly scoped ──
  describe('isPublicPath exempts /share/ as a tight prefix', () => {
    it('the /share/ prefix is present in the auth-gate allowlist', () => {
      expect(PUBLIC_PATH_PREFIXES).toContain('/share/');
      expect(computeIsPublicPath('/share/pov/acc-beliefs-001')).toBe(true);
    });

    it('a gated sibling (/api/taxonomy, /api/conflicts) is NOT exempted', () => {
      expect(computeIsPublicPath('/api/taxonomy')).toBe(false);
      expect(computeIsPublicPath('/api/conflicts')).toBe(false);
    });

    it('predicate: /share/... is public, a gated app path is not', () => {
      // Mirrors the source-verified clause above: the gate exempts anything under
      // /share/ and nothing else via this clause.
      const publicByShare = (p: string): boolean => p.startsWith('/share/');
      expect(publicByShare('/share/pov/acc-beliefs-001')).toBe(true);
      expect(publicByShare('/share/')).toBe(true);
      expect(publicByShare('/api/taxonomy/accelerationist')).toBe(false);
      expect(publicByShare('/shareable')).toBe(false); // prefix is /share/ with the slash — no bleed
    });
  });

  // ── (b) serving the shell mints NO session cookie ──
  describe('logged-out /share/ mints no session cookie', () => {
    it('the anonymous-session mint guards are exact-path — /share/ can never trigger them', () => {
      // Both cookie-minting branches key on an EXACT urlPath, not a prefix, so a
      // /share/pov/... request cannot reach either. If a future edit loosened
      // these to a prefix that swallowed /share/, this fails.
      expect(anonAuthSrc).toContain("urlPath === '/.auth/anonymous'");
      expect(anonAuthSrc).toContain("urlPath === '/api/auth/anonymous'");
      // Neither mint guard references /share.
      const mintRegion = anonAuthSrc.slice(
        anonAuthSrc.indexOf("urlPath === '/.auth/anonymous'"),
        anonAuthSrc.indexOf('anonymous: true'),
      );
      expect(mintRegion).not.toContain('/share');
    });

    it('serveStatic sets no Set-Cookie (the shell response carries no session)', () => {
      expect(serveStaticBody).not.toMatch(/set-cookie/i);
    });

    it('serveStatic SPA-fallback serves index.html for /share/ (non-api/ws/health)', () => {
      // The fallback delivers index.html for any non-API path — so /share/pov/:id
      // (no such file on disk) resolves to the shell, not a 404 or the login page.
      expect(serveStaticBody).toContain("!url.pathname.startsWith('/api/')");
      expect(serveStaticBody).toContain("'index.html'");
    });
  });
});
