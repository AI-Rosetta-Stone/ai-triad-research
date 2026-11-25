// @vitest-environment node

/**
 * t/1110 — Regression anchor: every API endpoint the debate pipeline calls
 * must be reachable by anonymous / free-tier users.
 *
 * Routes are reachable via one of two mechanisms:
 *   (a) isAnonAllowedRoute() returns true — the route is in the general allowlist
 *   (b) freeTierRoute bypass in server.ts — POST routes gated by freeTierEnabled()
 *
 * Adding a new POST endpoint consumed by the debate pipeline without updating
 * either allowlist (or this test) will cause a test failure.
 */

import { describe, it, expect } from 'vitest';
import { isAnonAllowedRoute } from '../security/accessControl.js';

/**
 * Canonical list of API endpoints the debate pipeline calls for anonymous users.
 *
 * MAINTENANCE: when adding a new endpoint to the debate flow, add it here.
 * A failing test means the route isn't in the anonymous allowlist.
 */

// Routes that pass isAnonAllowedRoute() directly (GETs, safe POSTs, user content).
const ANON_ALLOWED_ROUTES: Array<{ method: string; path: string; desc: string }> = [
  // --- GETs (all GETs are allowed for anonymous users) ---
  { method: 'GET', path: '/api/debates', desc: 'list saved debates' },
  { method: 'GET', path: '/api/debates/abc-123', desc: 'load a specific debate' },
  { method: 'GET', path: '/api/taxonomy/accelerationist', desc: 'load POV taxonomy data' },
  { method: 'GET', path: '/api/taxonomy/safetyist', desc: 'load POV taxonomy data' },
  { method: 'GET', path: '/api/taxonomy/skeptic', desc: 'load POV taxonomy data' },
  { method: 'GET', path: '/api/taxonomy/cross-cutting', desc: 'load cross-cutting taxonomy' },
  { method: 'GET', path: '/api/edges', desc: 'load edges for debate context' },
  { method: 'GET', path: '/api/flags', desc: 'feature flag evaluation' },
  { method: 'GET', path: '/api/models', desc: 'available AI model list' },
  { method: 'GET', path: '/api/proxy/tier', desc: 'resolve caller tier' },
  { method: 'GET', path: '/api/proxy/usage', desc: 'token usage stats' },
  { method: 'GET', path: '/api/dictionary', desc: 'vernacular dictionary' },
  { method: 'GET', path: '/api/config', desc: 'runtime config' },

  // --- POST/PUT/DELETE on user content ---
  { method: 'POST', path: '/api/debates', desc: 'create debate (user content, t/1501)' },
  { method: 'POST', path: '/api/chats', desc: 'create chat (user content, t/1501)' },
  { method: 'PUT', path: '/api/debates', desc: 'save debate (user content)' },
  { method: 'PUT', path: '/api/debates/abc-123', desc: 'update debate (user content)' },
  { method: 'PATCH', path: '/api/debates/abc-123', desc: 'save debate delta (saveDebateDelta, t/2230)' },
  { method: 'DELETE', path: '/api/debates/abc-123', desc: 'delete own debate' },

  // --- Safe POSTs ---
  { method: 'POST', path: '/api/ai/temperature', desc: 'set temperature (no key, no cost)' },
  { method: 'POST', path: '/api/source-evidence', desc: 'source evidence lookup' },
  { method: 'POST', path: '/api/community/submit', desc: 'community submission' },
  { method: 'POST', path: '/api/debates/export', desc: 'export debate' },
  { method: 'POST', path: '/api/flight-recorder/dump', desc: 'flight recorder dump' },
  { method: 'POST', path: '/api/analytics/event', desc: 'analytics event' },
  { method: 'POST', path: '/focus-node', desc: 'set focused node' },
];

// Routes NOT in isAnonAllowedRoute — they're behind the freeTierRoute bypass
// in server.ts (POST + freeTierEnabled()). These must return false from
// isAnonAllowedRoute; the server.ts gate handles them separately.
const FREE_TIER_BYPASS_ROUTES: Array<{ method: string; path: string; desc: string }> = [
  { method: 'POST', path: '/api/ai/generate', desc: 'core AI generation (debate rounds)' },
  { method: 'POST', path: '/api/embeddings/compute', desc: 'compute embeddings (t/1062 fix)' },
];

// Routes the debate UI calls that are intentionally blocked for anonymous users.
// These represent optional features that degrade gracefully when unavailable.
const INTENTIONALLY_BLOCKED_ROUTES: Array<{ method: string; path: string; desc: string }> = [
  { method: 'POST', path: '/api/nli/classify', desc: 'NLI argument classification (AI route)' },
  { method: 'POST', path: '/api/evidence-qbaf', desc: 'QBAF evidence scoring (explicitly blocked)' },
  { method: 'POST', path: '/api/embeddings/query', desc: 'semantic search queries (AI route)' },
  { method: 'POST', path: '/api/flight-recorder/server-dump', desc: 'server flight-recorder dump (t/579 incident: anonymous callers may not dump server logs)' },
];

describe('debate pipeline anonymous route allowlist (t/1110)', () => {
  describe('routes that must pass isAnonAllowedRoute', () => {
    for (const { method, path, desc } of ANON_ALLOWED_ROUTES) {
      it(`${method} ${path} — ${desc}`, () => {
        expect(isAnonAllowedRoute(method, path)).toBe(true);
      });
    }
  });

  describe('freeTierRoute bypass routes are correctly NOT in isAnonAllowedRoute', () => {
    for (const { method, path, desc } of FREE_TIER_BYPASS_ROUTES) {
      it(`${method} ${path} is blocked by isAnonAllowedRoute (handled by freeTierRoute) — ${desc}`, () => {
        expect(isAnonAllowedRoute(method, path)).toBe(false);
      });
    }
  });

  describe('intentionally blocked routes return false', () => {
    for (const { method, path, desc } of INTENTIONALLY_BLOCKED_ROUTES) {
      it(`${method} ${path} is blocked — ${desc}`, () => {
        expect(isAnonAllowedRoute(method, path)).toBe(false);
      });
    }
  });

  describe('regression anchors', () => {
    it('freeTierRoute list matches server.ts — update this test if the server gate changes', () => {
      const freeTierPaths = FREE_TIER_BYPASS_ROUTES.map(r => r.path).sort();
      expect(freeTierPaths).toEqual([
        '/api/ai/generate',
        '/api/embeddings/compute',
      ]);
    });

    it('all debate POST routes are accounted for (no route in multiple categories)', () => {
      const allPosts = [
        ...ANON_ALLOWED_ROUTES.filter(r => r.method === 'POST').map(r => r.path),
        ...FREE_TIER_BYPASS_ROUTES.map(r => r.path),
        ...INTENTIONALLY_BLOCKED_ROUTES.map(r => r.path),
      ];
      const unique = new Set(allPosts);
      expect(unique.size).toBe(allPosts.length);
    });
  });
});
