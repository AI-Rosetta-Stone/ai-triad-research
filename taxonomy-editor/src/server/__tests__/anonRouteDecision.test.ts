// @vitest-environment node
// t/475 (TL-approved design, t/475#3): the anonymous route decision. It is the one implementation; server.ts calls
// anonRouteDecision and keeps no copy. These tests drive that real decision with the REAL anonymous allowlist
// (isAnonAllowedRoute), not a stub, and pin the behaviour of every other route to what it was before this change.

import { describe, it, expect } from 'vitest';
import { anonRouteDecision, isFreeTierAiPath, FREE_TIER_AI_POST_PATHS } from '../anonAiRoutes.js';
import { isAnonAllowedRoute } from '../security/accessControl.js';

const ON = true;
const OFF = false;
const decide = (method: string, path: string, freeTier: boolean) => anonRouteDecision(method, path, freeTier, isAnonAllowedRoute);

describe('anonymous op-ed creation (t/475, condition 1 & acceptance)', () => {
  it('anonymous POST /api/oped-sets is refused with the free tier on (t/501 incident containment: the op-ed gate is closed)', () => {
    expect(decide('POST', '/api/oped-sets', ON)).toBe(false);
  });

  it('with the free tier OFF the same request is still refused, so params.model can never be honoured on this route', () => {
    expect(decide('POST', '/api/oped-sets', OFF)).toBe(false);
  });

  it('the exemption is exact-match: sub-paths and trailing-slash forms are not exempt', () => {
    expect(decide('POST', '/api/oped-sets/x', ON)).toBe(false);
    expect(decide('POST', '/api/oped-sets/', ON)).toBe(false);
    expect(decide('POST', '/api/oped-sets-evil', ON)).toBe(false);
  });

  it('share stays refused (the handler also refuses anonymous publish)', () => {
    expect(decide('POST', '/api/oped-sets/abc/share', ON)).toBe(false);
    expect(decide('POST', '/api/oped-sets/abc/share', OFF)).toBe(false);
  });

  it('PUT and DELETE on /api/oped-sets/:id stay refused, free tier on or off (condition 4)', () => {
    for (const method of ['PUT', 'DELETE']) {
      expect(decide(method, '/api/oped-sets/abc', ON)).toBe(false);
      expect(decide(method, '/api/oped-sets/abc', OFF)).toBe(false);
    }
  });

  it('GET of an op-ed run and of an op-ed set are reachable by an anonymous caller (the handler scopes them per visitor)', () => {
    expect(decide('GET', '/api/oped-runs/run-1', OFF)).toBe(true);
    expect(decide('GET', '/api/oped-sets/abc', OFF)).toBe(true);
  });

  it('the op-ed path is listed only on the free-tier POST allowlist', () => {
    // t/501 incident containment: the op-ed path is removed from the free-tier list until the fix lands.
    expect(FREE_TIER_AI_POST_PATHS).not.toContain('/api/oped-sets');
    expect(isFreeTierAiPath('GET', '/api/oped-sets')).toBe(false);
    expect(isFreeTierAiPath('POST', '/api/oped-sets')).toBe(false);
  });
});

describe('other routes are unchanged (condition 2: table over the current lists)', () => {
  it('every existing free-tier POST route: exempt with the tier on, and refused with it off unless the anonymous allowlist already allows it', () => {
    for (const path of FREE_TIER_AI_POST_PATHS.filter(p => p !== '/api/oped-sets')) {
      expect(decide('POST', path, ON)).toBe(true);
      expect(decide('POST', path, OFF)).toBe(isAnonAllowedRoute('POST', path));
    }
  });

  it('with the free tier off, every route decides exactly as the anonymous allowlist alone did before this change', () => {
    const routes: Array<[string, string]> = [
      ['POST', '/api/ai/generate'], ['POST', '/api/ai/chat-stream'], ['POST', '/api/embeddings/query'],
      ['POST', '/api/flight-recorder/dump'], ['POST', '/api/analytics/event'], ['POST', '/api/community/submit'],
      ['POST', '/api/debates/export'], ['GET', '/api/debates'], ['GET', '/api/oped-runs/x'],
      ['GET', '/api/ai/temperature'], ['PUT', '/api/chats/x'], ['DELETE', '/api/debates/x'],
      ['PATCH', '/api/debates/x'], ['POST', '/api/keys'], ['GET', '/api/keys'],
    ];
    for (const [m, p] of routes) {
      expect(decide(m, p, OFF)).toBe(isAnonAllowedRoute(m, p));
    }
  });

  it('with the free tier on, no route is newly allowed (op-ed create closed, t/501)', () => {
    const routes: Array<[string, string]> = [
      ['POST', '/api/ai/generate'], ['POST', '/api/ai/chat-stream'], ['POST', '/api/flight-recorder/dump'],
      ['GET', '/api/oped-runs/x'], ['PUT', '/api/oped-sets/x'], ['DELETE', '/api/oped-sets/x'],
      ['POST', '/api/oped-sets/x/share'], ['POST', '/api/oped-sets'],
    ];
    for (const [m, p] of routes) {
      const after = decide(m, p, ON);
      if (p === '/api/oped-sets' && m === 'POST') {
        // t/501 containment: the op-ed create is refused, free tier on or off.
        expect(isAnonAllowedRoute(m, p)).toBe(false);
        expect(after).toBe(false);
      } else {
        const before = (isFreeTierAiPath(m, p) || isAnonAllowedRoute(m, p));
        expect(after).toBe(before);
      }
    }
  });
});
