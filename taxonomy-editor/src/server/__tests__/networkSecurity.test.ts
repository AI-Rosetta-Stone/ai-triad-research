// @vitest-environment node
//
// t/2532 (sec M12) — the dev REST server previously bound 0.0.0.0, answered CORS with
// `*`, and did no Origin check, so a drive-by web page could hit a developer's API.
// These assert the pure helpers server.ts wires in: loopback bind in dev, an explicit
// CORS allowlist (never `*`), and rejection of cross-origin mutating requests — with
// the required same-origin exemption (browser fetch always sends Origin, even
// same-origin, so the server-serves-renderer case must not self-block; TL t/2532#2).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type http from 'http';

const { securityWarn, recordMock } = vi.hoisted(() => ({ securityWarn: vi.fn(), recordMock: vi.fn() }));
vi.mock('../logger.js', () => ({ log: { security: { warn: securityWarn, info: vi.fn(), error: vi.fn() } } }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: recordMock }) }));
beforeEach(() => { securityWarn.mockClear(); recordMock.mockClear(); });

import {
  resolveBindHost, isNonLoopbackDevBind, resolveAllowedOrigins, corsOriginFor,
  isSameOrigin, isDisallowedCrossOriginMutation, isWebSocketOriginAllowed,
  enforceCrossOriginMutationGuard, VITE_DEV_ORIGINS,
} from '../networkSecurity.js';

describe('t/2532 — resolveBindHost (loopback in dev, all-interfaces in prod)', () => {
  it('binds 127.0.0.1 in dev, 0.0.0.0 in production', () => {
    expect(resolveBindHost({})).toBe('127.0.0.1');
    expect(resolveBindHost({ NODE_ENV: 'development' })).toBe('127.0.0.1');
    expect(resolveBindHost({ NODE_ENV: 'production' })).toBe('0.0.0.0');
  });
  it('an explicit HOST overrides in any mode', () => {
    expect(resolveBindHost({ HOST: '0.0.0.0' })).toBe('0.0.0.0');
    expect(resolveBindHost({ NODE_ENV: 'production', HOST: '127.0.0.1' })).toBe('127.0.0.1');
  });
});

describe('t/2532 — isNonLoopbackDevBind (startup-warning trigger)', () => {
  it('true only when a dev run binds a non-loopback HOST', () => {
    expect(isNonLoopbackDevBind({ HOST: '0.0.0.0' })).toBe(true);
    expect(isNonLoopbackDevBind({ HOST: '192.168.1.5' })).toBe(true);
    expect(isNonLoopbackDevBind({ HOST: '127.0.0.1' })).toBe(false);
    expect(isNonLoopbackDevBind({ HOST: 'localhost' })).toBe(false);
    expect(isNonLoopbackDevBind({})).toBe(false);
    expect(isNonLoopbackDevBind({ NODE_ENV: 'production', HOST: '0.0.0.0' })).toBe(false);
  });
});

describe('t/2532 — resolveAllowedOrigins (always an array, never `*`/null)', () => {
  it('dev defaults to the Vite dev origins', () => {
    expect(resolveAllowedOrigins({})).toEqual([...VITE_DEV_ORIGINS]);
  });
  it('production with no ALLOWED_ORIGINS yields [] (cross-origin rejected)', () => {
    expect(resolveAllowedOrigins({ NODE_ENV: 'production' })).toEqual([]);
  });
  it('an explicit ALLOWED_ORIGINS is parsed + trimmed in any mode', () => {
    expect(resolveAllowedOrigins({ ALLOWED_ORIGINS: 'https://a.example, https://b.example' }))
      .toEqual(['https://a.example', 'https://b.example']);
  });
});

describe('t/2532 — corsOriginFor never returns a wildcard', () => {
  it('echoes an allowlisted origin, else falls back to the first — never `*`', () => {
    const allow = ['http://localhost:5173'];
    expect(corsOriginFor('http://localhost:5173', allow)).toBe('http://localhost:5173');
    expect(corsOriginFor('https://evil.example', allow)).toBe('http://localhost:5173');
    expect(corsOriginFor('https://evil.example', [])).toBe('');
    expect(corsOriginFor('http://localhost:5173', allow)).not.toBe('*');
  });
});

describe('t/2532 — isSameOrigin (Origin host:port == Host header)', () => {
  it('matches genuine same-origin, rejects cross-port and malformed', () => {
    expect(isSameOrigin('http://localhost:3000', 'localhost:3000')).toBe(true);
    expect(isSameOrigin('https://app.example', 'app.example')).toBe(true);
    expect(isSameOrigin('http://localhost:5173', 'localhost:7862')).toBe(false);
    expect(isSameOrigin('not-a-url', 'localhost:3000')).toBe(false);
    expect(isSameOrigin('', 'localhost:3000')).toBe(false);
    expect(isSameOrigin('http://localhost:3000', '')).toBe(false);
  });
});

describe('t/2532 — isDisallowedCrossOriginMutation (the drive-by defense)', () => {
  const allow = ['http://localhost:5173'];

  it('BLOCKS a cross-origin, non-allowlisted mutating request', () => {
    expect(isDisallowedCrossOriginMutation('POST', 'https://evil.example', 'localhost:7862', allow)).toBe(true);
    expect(isDisallowedCrossOriginMutation('DELETE', 'https://evil.example', 'localhost:7862', allow)).toBe(true);
  });
  it('ALLOWS a same-origin mutation even when the Origin is not in the allowlist (TL amendment)', () => {
    // server-serves-renderer: Origin host:port == Host → same-origin → not gated
    expect(isDisallowedCrossOriginMutation('POST', 'http://localhost:3000', 'localhost:3000', allow)).toBe(false);
  });
  it('ALLOWS an allowlisted cross-origin mutation (Vite → API)', () => {
    expect(isDisallowedCrossOriginMutation('POST', 'http://localhost:5173', 'localhost:7862', allow)).toBe(false);
  });
  it('ALLOWS a mutation with no Origin (curl / non-browser / same-origin nav)', () => {
    expect(isDisallowedCrossOriginMutation('POST', undefined, 'localhost:7862', allow)).toBe(false);
  });
  it('does NOT gate non-mutating methods (GET/OPTIONS/HEAD)', () => {
    expect(isDisallowedCrossOriginMutation('GET', 'https://evil.example', 'localhost:7862', allow)).toBe(false);
    expect(isDisallowedCrossOriginMutation('OPTIONS', 'https://evil.example', 'localhost:7862', allow)).toBe(false);
  });
});

describe('t/2532 — isWebSocketOriginAllowed (WS bypasses CORS)', () => {
  const allow = ['http://localhost:5173'];
  it('allows same-origin or allowlisted, blocks otherwise', () => {
    expect(isWebSocketOriginAllowed('http://localhost:3000', 'localhost:3000', allow)).toBe(true); // same-origin
    expect(isWebSocketOriginAllowed('http://localhost:5173', 'localhost:7862', allow)).toBe(true); // allowlisted
    expect(isWebSocketOriginAllowed('https://evil.example', 'localhost:7862', allow)).toBe(false);
    expect(isWebSocketOriginAllowed('', 'localhost:7862', allow)).toBe(false); // no origin
  });
});

describe('t/2532 — enforceCrossOriginMutationGuard (pipeline wrapper)', () => {
  const allow = ['http://localhost:5173'];
  function mk(method: string, origin?: string, host = 'localhost:7862') {
    const req = { method, headers: { origin, host } } as unknown as http.IncomingMessage;
    const out = { status: 0, wrote: false };
    const res = {
      writeHead: (s: number) => { out.status = s; out.wrote = true; },
      end: () => { /* body ignored */ },
    } as unknown as http.ServerResponse;
    return { req, res, out };
  }
  it('a cross-origin mutation → 403 and returns true', () => {
    const { req, res, out } = mk('POST', 'https://evil.example');
    expect(enforceCrossOriginMutationGuard(req, res, false, allow)).toBe(true);
    expect(out.status).toBe(403);
  });
  it('a public path is exempt → returns false, writes nothing', () => {
    const { req, res, out } = mk('POST', 'https://evil.example');
    expect(enforceCrossOriginMutationGuard(req, res, true, allow)).toBe(false);
    expect(out.wrote).toBe(false);
  });
  it('a same-origin mutation → returns false, writes nothing', () => {
    const { req, res, out } = mk('POST', 'http://localhost:7862'); // Origin == Host
    expect(enforceCrossOriginMutationGuard(req, res, false, allow)).toBe(false);
    expect(out.wrote).toBe(false);
  });
  // t/4406: the rejection must be greppable in logs, not only visible in the response.
  it('a rejection logs a WARN + FR record naming cross_origin_blocked, origin and host', () => {
    const { req, res } = mk('POST', 'https://evil.example');
    enforceCrossOriginMutationGuard(req, res, false, allow);
    expect(securityWarn).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'https://evil.example', host: 'localhost:7862', method: 'POST' }),
      expect.stringContaining('cross_origin_blocked'),
    );
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', message: 'cross_origin_blocked' }));
  });
  it('a pass (same-origin) logs nothing', () => {
    const { req, res } = mk('POST', 'http://localhost:7862');
    enforceCrossOriginMutationGuard(req, res, false, allow);
    expect(securityWarn).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
  });
});
