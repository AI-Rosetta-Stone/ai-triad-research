// @vitest-environment node

/**
 * t/720 — pure access-control decisions extracted from server.ts.
 * L1 (AUTH_DISABLED production block), L3 (clone target containment),
 * L6 (terminal WebSocket admin gate).
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import path from 'path';
import crypto from 'crypto';
import { setAnonSessionSecret, signAnonSessionId, verifyAnonSessionCookie } from '../security/anonSessionSigning.js';
import { isAuthDisabledAllowed, isPathWithinDir, isTerminalAccessAllowed, isAnonAllowedRoute, invalidRouteParam, callerTierIdentity, clientSafeMessage, stripStackFrames, missingApiKeyError, expiredAuthCookies, anonymousSessionCookies, isValidAnonSessionId, resolveAnonSessionId, hasEasyAuthSessionCookie, resolveTestPersonaOverride } from '../security/accessControl.js';
import { deriveStorageUserId } from '../security/userContext.js';
import { resolveTier } from '../ai/proxyTiers.js';

describe('expiredAuthCookies (t/897)', () => {
  it('expires every AppServiceAuthSession cookie present plus the canonical name', () => {
    const out = expiredAuthCookies(['AppServiceAuthSession', 'AppServiceAuthSession1', 'other', 'anon_session_id']);
    expect(out.some(c => c.startsWith('AppServiceAuthSession='))).toBe(true);
    expect(out.some(c => c.startsWith('AppServiceAuthSession1='))).toBe(true);
    expect(out.some(c => c.startsWith('other='))).toBe(false); // non-auth cookies untouched
  });

  it('always expires the canonical cookie even when none are present', () => {
    const out = expiredAuthCookies([]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^AppServiceAuthSession=;/);
  });

  it('each expiry sets Max-Age=0 and Path=/ so the browser deletes it', () => {
    for (const c of expiredAuthCookies(['AppServiceAuthSession'])) {
      expect(c).toContain('Max-Age=0');
      expect(c).toContain('Path=/');
    }
  });
});

describe('isValidAnonSessionId (t/2464)', () => {
  it('accepts a well-formed UUID v4', () => {
    expect(isValidAnonSessionId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isValidAnonSessionId('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe(true);
  });

  it('rejects wrong version bit (not 4)', () => {
    expect(isValidAnonSessionId('550e8400-e29b-31d4-a716-446655440000')).toBe(false); // version 3
    expect(isValidAnonSessionId('550e8400-e29b-51d4-a716-446655440000')).toBe(false); // version 5
  });

  it('rejects wrong variant bits (not [89ab])', () => {
    expect(isValidAnonSessionId('550e8400-e29b-41d4-0716-446655440000')).toBe(false); // variant 0x
    expect(isValidAnonSessionId('550e8400-e29b-41d4-f716-446655440000')).toBe(false); // variant fx
  });

  it('rejects wrong length', () => {
    expect(isValidAnonSessionId('550e8400-e29b-41d4-a716-44665544000')).toBe(false);  // 35 chars
    expect(isValidAnonSessionId('550e8400-e29b-41d4-a716-4466554400000')).toBe(false); // 37 chars
  });

  it('rejects empty string, path traversal, SQL injection', () => {
    expect(isValidAnonSessionId('')).toBe(false);
    expect(isValidAnonSessionId('../etc/passwd')).toBe(false);
    expect(isValidAnonSessionId("'; DROP TABLE sessions; --")).toBe(false);
    expect(isValidAnonSessionId('UPPERCASE-UUID-4XXX-AXXX-XXXXXXXXXXXX')).toBe(false);
  });
});

describe('resolveAnonSessionId (t/2464, t/664 signed)', () => {
  beforeAll(() => setAnonSessionSecret(crypto.randomBytes(32)));
  const isSigned = (v: string) => verifyAnonSessionCookie(v) !== undefined;

  it('reuses a valid existing (signed) cookie value', () => {
    const id = signAnonSessionId('550e8400-e29b-41d4-a716-446655440000');
    expect(resolveAnonSessionId(id)).toBe(id);
  });

  it('replaces a bare uuid (pre-t/664 cookie) with a fresh signed one, silently', () => {
    const bare = '550e8400-e29b-41d4-a716-446655440000';
    const result = resolveAnonSessionId(bare);
    expect(result).not.toBe(bare);
    expect(isSigned(result)).toBe(true);
  });

  it('mints a fresh signed id when existing is undefined', () => {
    expect(isSigned(resolveAnonSessionId(undefined))).toBe(true);
  });

  it('mints a fresh signed id when existing is malformed — never echoes unvalidated input', () => {
    const malformed = '../evil';
    const result = resolveAnonSessionId(malformed);
    expect(result).not.toBe(malformed);
    expect(isSigned(result)).toBe(true);
  });

  it('mints a fresh signed id when existing is an empty string', () => {
    expect(isSigned(resolveAnonSessionId(''))).toBe(true);
  });
});

describe('anonymousSessionCookies (t/1483 + t/2464)', () => {
  const saved = { env: process.env.NODE_ENV, origins: process.env.ALLOWED_ORIGINS };
  afterEach(() => {
    process.env.NODE_ENV = saved.env;
    if (saved.origins === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = saved.origins;
  });

  it('mints exactly the auth_anonymous flag + the provided anon_session_id', () => {
    const out = anonymousSessionCookies('fixed-id-123');
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^auth_anonymous=1;/);
    expect(out[1]).toMatch(/^anon_session_id=fixed-id-123;/);
  });

  it('anon_session_id carries Max-Age=31536000 (1yr persistence); auth_anonymous does not', () => {
    const out = anonymousSessionCookies('x');
    expect(out[0]).not.toContain('Max-Age'); // session-scoped flag cookie
    expect(out[1]).toContain('Max-Age=31536000');
  });

  it('marks both cookies HttpOnly + SameSite=Lax so JS never reads them and CSRF is limited', () => {
    for (const c of anonymousSessionCookies('x')) {
      expect(c).toContain('HttpOnly');
      expect(c).toContain('SameSite=Lax');
      expect(c).toContain('Path=/');
    }
  });

  it('adds Secure in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOWED_ORIGINS;
    for (const c of anonymousSessionCookies('x')) expect(c).toContain('; Secure');
  });

  it('adds Secure when a cross-origin allowlist is configured (HTTPS deploy)', () => {
    process.env.NODE_ENV = 'development';
    process.env.ALLOWED_ORIGINS = 'https://app.example.com';
    for (const c of anonymousSessionCookies('x')) expect(c).toContain('; Secure');
  });

  it('omits Secure in plain local dev so the cookie is still settable over HTTP', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ALLOWED_ORIGINS;
    for (const c of anonymousSessionCookies('x')) expect(c).not.toContain('Secure');
  });
});

describe('hasEasyAuthSessionCookie (t/940)', () => {
  it('detects a present Easy Auth session cookie, including chunked variants', () => {
    expect(hasEasyAuthSessionCookie(['AppServiceAuthSession'])).toBe(true);
    expect(hasEasyAuthSessionCookie(['other', 'AppServiceAuthSession1'])).toBe(true);
    expect(hasEasyAuthSessionCookie(['appserviceauthsession'])).toBe(true); // case-insensitive
  });

  it('is false when no Easy Auth cookie is present (fresh session → no auto-clear)', () => {
    expect(hasEasyAuthSessionCookie([])).toBe(false);
    expect(hasEasyAuthSessionCookie(['anon_session_id', 'auth_anonymous'])).toBe(false);
  });
});

describe('resolveTestPersonaOverride (t/1125)', () => {
  const ADMINS = ['jpsnover', 'jsnover13-at-gmail-com'];
  const SECRET = 's3cr3t-test-persona';
  let saved: { enable?: string; secret?: string };
  beforeEach(() => {
    saved = { enable: process.env.ENABLE_TEST_PERSONA_HEADER, secret: process.env.TEST_PERSONA_SECRET };
  });
  afterEach(() => {
    if (saved.enable === undefined) delete process.env.ENABLE_TEST_PERSONA_HEADER; else process.env.ENABLE_TEST_PERSONA_HEADER = saved.enable;
    if (saved.secret === undefined) delete process.env.TEST_PERSONA_SECRET; else process.env.TEST_PERSONA_SECRET = saved.secret;
  });

  it('is inert when the env flag is unset (production default) — header fully ignored', () => {
    delete process.env.ENABLE_TEST_PERSONA_HEADER;
    process.env.TEST_PERSONA_SECRET = SECRET;
    expect(resolveTestPersonaOverride({ 'x-test-persona': 'admin', 'x-test-persona-secret': SECRET }, ADMINS)).toBeNull();
  });

  it('returns null when enabled but no persona header is present (normal Easy Auth path)', () => {
    process.env.ENABLE_TEST_PERSONA_HEADER = '1';
    process.env.TEST_PERSONA_SECRET = SECRET;
    expect(resolveTestPersonaOverride({}, ADMINS)).toBeNull();
  });

  it('rejects (bad_secret) when the secret is missing or wrong', () => {
    process.env.ENABLE_TEST_PERSONA_HEADER = '1';
    process.env.TEST_PERSONA_SECRET = SECRET;
    expect(resolveTestPersonaOverride({ 'x-test-persona': 'admin' }, ADMINS)).toEqual({ error: 'test_persona_bad_secret' });
    expect(resolveTestPersonaOverride({ 'x-test-persona': 'admin', 'x-test-persona-secret': 'wrong' }, ADMINS)).toEqual({ error: 'test_persona_bad_secret' });
  });

  it('never matches when no server secret is configured (an empty secret cannot be matched)', () => {
    process.env.ENABLE_TEST_PERSONA_HEADER = '1';
    delete process.env.TEST_PERSONA_SECRET;
    expect(resolveTestPersonaOverride({ 'x-test-persona': 'authenticated', 'x-test-persona-secret': '' }, ADMINS)).toEqual({ error: 'test_persona_bad_secret' });
  });

  it('maps personas to identities when env + secret are valid', () => {
    process.env.ENABLE_TEST_PERSONA_HEADER = '1';
    process.env.TEST_PERSONA_SECRET = SECRET;
    const call = (p: string) => resolveTestPersonaOverride({ 'x-test-persona': p, 'x-test-persona-secret': SECRET }, ADMINS);
    expect(call('anonymous')).toEqual({ principalName: '', idp: '', persona: 'anonymous' });
    expect(call('authenticated')).toEqual({ principalName: 'test-persona-user', idp: 'github', persona: 'authenticated' });
    expect(call('admin')).toEqual({ principalName: 'jpsnover', idp: 'github', persona: 'admin' });
  });

  it('admin persona derives into ADMIN_USERS; authenticated does not (AC)', () => {
    process.env.ENABLE_TEST_PERSONA_HEADER = '1';
    process.env.TEST_PERSONA_SECRET = SECRET;
    const admin = resolveTestPersonaOverride({ 'x-test-persona': 'admin', 'x-test-persona-secret': SECRET }, ADMINS) as { principalName: string; idp: string };
    expect(ADMINS).toContain(deriveStorageUserId(admin.principalName, admin.idp));
    const authd = resolveTestPersonaOverride({ 'x-test-persona': 'authenticated', 'x-test-persona-secret': SECRET }, ADMINS) as { principalName: string; idp: string };
    expect(ADMINS).not.toContain(deriveStorageUserId(authd.principalName, authd.idp));
  });

  it('rejects an unknown persona value', () => {
    process.env.ENABLE_TEST_PERSONA_HEADER = '1';
    process.env.TEST_PERSONA_SECRET = SECRET;
    expect(resolveTestPersonaOverride({ 'x-test-persona': 'superuser', 'x-test-persona-secret': SECRET }, ADMINS)).toEqual({ error: 'test_persona_invalid' });
  });
});

describe('missingApiKeyError (t/896)', () => {
  const base = { backend: 'claude', displayName: 'Claude (Anthropic)' };

  it('returns a structured 422 payload when no key is available (AC#1,#2)', () => {
    const out = missingApiKeyError({ ...base, serverProvidedKey: false, haveExplicitKey: false, hasResolvedKey: false });
    expect(out).toEqual({
      error: 'missing_api_key',
      backend: 'claude',
      message: 'No API key configured for Claude (Anthropic). Add one in Settings → API Keys.',
    });
  });

  it('returns null (proceed) when the free tier provides the key (AC#3)', () => {
    expect(missingApiKeyError({ ...base, serverProvidedKey: true, haveExplicitKey: false, hasResolvedKey: false })).toBeNull();
  });

  it('returns null when the caller supplied a key or one resolved from env/store', () => {
    expect(missingApiKeyError({ ...base, serverProvidedKey: false, haveExplicitKey: true, hasResolvedKey: true })).toBeNull();
    expect(missingApiKeyError({ ...base, serverProvidedKey: false, haveExplicitKey: false, hasResolvedKey: true })).toBeNull();
  });
});

describe('clientSafeMessage (t/853)', () => {
  const dump = [
    '', '  Goal:     Load chat session',
    '  Error:    Chat not found', '  Location: server/fileIO.ts → loadChatSession',
    '  Resolve:', '  1. Check the id',
  ].join('\n');

  it('strips ActionableError internals from a cause in production (goal: problem only)', () => {
    const cause = { goal: 'Load chat session', problem: 'Chat not found', location: 'server/fileIO.ts', nextSteps: ['x'] };
    const out = clientSafeMessage('whatever', cause, true);
    expect(out).toBe('Load chat session: Chat not found');
    expect(out).not.toMatch(/Location|Resolve|fileIO/);
  });

  it('strips a serialized ActionableError dump message in production', () => {
    const out = clientSafeMessage(dump, undefined, true);
    expect(out).toBe('Load chat session: Chat not found');
    expect(out).not.toMatch(/Location|Resolve|fileIO/);
  });

  it('passes plain validation messages through unchanged', () => {
    expect(clientSafeMessage('rating must be "up" or "down"', undefined, true)).toBe('rating must be "up" or "down"');
  });

  it('returns the full message in development (unchanged)', () => {
    expect(clientSafeMessage(dump, undefined, false)).toBe(dump);
  });

  // t/3515 (CodeQL js/stack-trace-exposure #5707): the sanitizer barrier — a stack that
  // bled into the error message must never survive into the client-facing string, in EITHER
  // NODE_ENV (dev returns the message verbatim, so it needs the strip too).
  const FRAME_SIG = /\bat\s+\S.*:\d+:\d+/; // an `at <site> …:line:col` V8 frame

  it('t/3515: strips stack frames from a message carrying a stack (production)', () => {
    const withStack = 'Chat not found\n    at loadChatSession (/app/server/fileIO.ts:412:15)\n    at async /app/server/routes/chat.ts:88:5';
    const out = clientSafeMessage(withStack, undefined, true);
    expect(out).toBe('Chat not found');
    expect(out).not.toMatch(FRAME_SIG);
    expect(out).not.toMatch(/fileIO\.ts|chat\.ts/);
  });

  it('t/3515: strips stack frames in development too (dev returns message verbatim)', () => {
    const withStack = 'Boom\n    at doThing (/srv/x.ts:1:2)';
    const out = clientSafeMessage(withStack, undefined, false);
    expect(out).toBe('Boom');
    expect(out).not.toMatch(FRAME_SIG);
  });
});

describe('stripStackFrames (t/3515)', () => {
  it('removes V8 frame lines (with and without parens, Windows and POSIX paths)', () => {
    const s = [
      'Something failed',
      '    at fn (/app/server/foo.ts:10:5)',
      '    at /app/server/bar.ts:20:3',
      '    at Object.<anonymous> (C:\\app\\baz.ts:30:7)',
    ].join('\n');
    expect(stripStackFrames(s)).toBe('Something failed');
  });

  it('preserves prose that merely starts with "at " (no :line:col signature)', () => {
    // The exact TL-cited false-positive class (t/3515#2): must NOT be deleted.
    expect(stripStackFrames('at least 3 nodes required')).toBe('at least 3 nodes required');
    expect(stripStackFrames('Rejected: at least one field must be set')).toBe('Rejected: at least one field must be set');
  });

  it('preserves a multi-line ActionableError (Goal/Error/Location/Resolve — no frame lines)', () => {
    const dump = '  Goal: Load\n  Error: Not found\n  Location: fileIO.ts → load\n  Resolve:\n  1. Check id';
    expect(stripStackFrames(dump)).toBe(dump);
  });

  it('falls back to a generic message when the input is nothing but frames', () => {
    const pureStack = '    at a (/x.ts:1:1)\n    at b (/y.ts:2:2)';
    expect(stripStackFrames(pureStack)).toBe('Request failed');
  });
});

describe('callerTierIdentity (t/848)', () => {
  it('returns the principal/idp for an authenticated context', () => {
    expect(callerTierIdentity({ principalName: 'alice', idp: 'github', isAnonymous: false }))
      .toEqual({ principalName: 'alice', idp: 'github' });
  });

  it('maps anonymous / null context to an empty principal', () => {
    expect(callerTierIdentity({ principalName: '_local', idp: '_local', isAnonymous: true }))
      .toEqual({ principalName: '', idp: '' });
    expect(callerTierIdentity(null)).toEqual({ principalName: '', idp: '' });
  });

  it('an anonymous context never resolves to the platform tier (no header-spoof escalation)', () => {
    // Even if a spoofed x-ms-client-principal-* header existed, the verified
    // context is anonymous → empty principal → resolveTier is not platform.
    const id = callerTierIdentity({ principalName: '_local', idp: '_local', isAnonymous: true });
    expect(resolveTier(id.principalName, id.idp).level).not.toBe('platform');
  });
});

describe('isAuthDisabledAllowed (L1)', () => {
  it('blocks AUTH_DISABLED in production', () => {
    expect(isAuthDisabledAllowed({ AUTH_DISABLED: '1', NODE_ENV: 'production' })).toBe(false);
  });
  it('allows AUTH_DISABLED outside production', () => {
    expect(isAuthDisabledAllowed({ AUTH_DISABLED: '1', NODE_ENV: 'development' })).toBe(true);
    expect(isAuthDisabledAllowed({ AUTH_DISABLED: '1' })).toBe(true);
  });
  it('is false when AUTH_DISABLED is not exactly "1"', () => {
    expect(isAuthDisabledAllowed({ AUTH_DISABLED: '0' })).toBe(false);
    expect(isAuthDisabledAllowed({})).toBe(false);
  });
});

describe('isPathWithinDir (L3)', () => {
  const base = path.resolve('data-root');
  it('accepts the base itself and nested paths', () => {
    expect(isPathWithinDir(base, base)).toBe(true);
    expect(isPathWithinDir(path.join(base, 'sub', 'file.json'), base)).toBe(true);
  });
  it('rejects paths outside the base', () => {
    expect(isPathWithinDir(path.resolve('elsewhere'), base)).toBe(false);
    expect(isPathWithinDir(path.join(base, '..', 'evil'), base)).toBe(false); // traversal
    expect(isPathWithinDir(base + '-evil', base)).toBe(false);                // sibling prefix trick
  });
});

describe('isAnonAllowedRoute — synthetic-embeddings corpus is AUTH-ONLY (t/3259 + t/3260)', () => {
  const SYNTH = '/api/taxonomy/synthetic-embeddings';

  it('BLOCKS anon GET of the ~400MB corpus unconditionally (PM t/3260, TL-confirmed p/522#192)', () => {
    expect(isAnonAllowedRoute('GET', SYNTH)).toBe(false);
  });

  it('is bypass-safe — trailing-slash + query vectors are all blocked', () => {
    // Trailing slash(es): canonicalized here → blocked at the gate (matchRoute would 404 them anyway).
    expect(isAnonAllowedRoute('GET', SYNTH + '/')).toBe(false);
    expect(isAnonAllowedRoute('GET', SYNTH + '///')).toBe(false);
    // Query string: server.ts strips it via normalizedRequestPath (new URL().pathname) BEFORE this fn,
    // for BOTH the gate and the router — prove the composition sees the canonical path → blocked.
    const stripped = new URL('http://x' + SYNTH + '?x=1&y=2').pathname;
    expect(stripped).toBe(SYNTH);
    expect(isAnonAllowedRoute('GET', stripped)).toBe(false);
  });

  it('does NOT over-match — sibling GET routes stay anon-allowed', () => {
    expect(isAnonAllowedRoute('GET', '/api/taxonomy/accelerationist')).toBe(true);
    expect(isAnonAllowedRoute('GET', '/api/taxonomy/synthetic/acc')).toBe(true); // the :pov route, distinct
    expect(isAnonAllowedRoute('GET', '/api/edges')).toBe(true);
  });
});

describe('isAnonAllowedRoute (t/763 anon_route_blocked classification)', () => {
  it('allows read-only GETs', () => {
    expect(isAnonAllowedRoute('GET', '/api/taxonomy/accelerationist')).toBe(true);
    expect(isAnonAllowedRoute('GET', '/api/edges')).toBe(true);
    expect(isAnonAllowedRoute('GET', '/api/community/debates')).toBe(true);
  });
  it('blocks AI/inference routes regardless of method', () => {
    for (const p of ['/api/keys/has', '/api/ai/chat', '/api/embeddings/x', '/api/nli/x',
      '/api/evidence-qbaf', '/api/models/refresh', '/api/harvest/concept']) {
      expect(isAnonAllowedRoute('GET', p)).toBe(false);
    }
    expect(isAnonAllowedRoute('GET', '/api/debates/abc/news-report')).toBe(false);
  });

  it('allows anon POST to /api/ai/temperature despite the /api/ai/ block (t/811)', () => {
    // Local server config — no key, no cost, no abuse vector. Chat + debates set
    // temperature before generation; the carve-out must precede the AI block.
    expect(isAnonAllowedRoute('POST', '/api/ai/temperature')).toBe(true);
    // Still blocks the other AI routes (the carve-out is exact-path only).
    expect(isAnonAllowedRoute('POST', '/api/ai/generate')).toBe(false);
    expect(isAnonAllowedRoute('POST', '/api/ai/temperature/x')).toBe(false);
  });

  it('allows anon POST to /api/admin/errors (t/811)', () => {
    expect(isAnonAllowedRoute('POST', '/api/admin/errors')).toBe(true);
  });
  it('allows anonymous create/save/delete of own ephemeral chats and debates (t/1501)', () => {
    expect(isAnonAllowedRoute('POST', '/api/debates')).toBe(true);
    expect(isAnonAllowedRoute('POST', '/api/chats')).toBe(true);
    expect(isAnonAllowedRoute('PUT', '/api/debates')).toBe(true);
    expect(isAnonAllowedRoute('DELETE', '/api/debates/abc')).toBe(true);
    expect(isAnonAllowedRoute('PUT', '/api/chats')).toBe(true);
    expect(isAnonAllowedRoute('DELETE', '/api/chats/xyz')).toBe(true);
  });
  it('allows anonymous PATCH to own debate (saveDebateDelta, t/2230)', () => {
    expect(isAnonAllowedRoute('PATCH', '/api/debates/abc-123')).toBe(true);
    expect(isAnonAllowedRoute('PATCH', '/api/debates/some-other-id')).toBe(true);
  });
  it('PATCH anon guard is exact-segment: blocks chats and debate sub-paths (t/2230 Q4)', () => {
    // Must not silently inherit anon write access via the broad user-content prefix.
    expect(isAnonAllowedRoute('PATCH', '/api/chats/abc')).toBe(false);
    expect(isAnonAllowedRoute('PATCH', '/api/debates/abc/comments')).toBe(false);
    expect(isAnonAllowedRoute('PATCH', '/api/debates/abc/news-report')).toBe(false);
    expect(isAnonAllowedRoute('PATCH', '/api/debates')).toBe(false);
  });
  it('blocks other writes', () => {
    expect(isAnonAllowedRoute('PUT', '/api/taxonomy/accelerationist')).toBe(false);
    expect(isAnonAllowedRoute('DELETE', '/api/conflicts/c1')).toBe(false);
    expect(isAnonAllowedRoute('POST', '/api/something-random')).toBe(false);
  });
  it('allows allowlisted read-like POSTs', () => {
    expect(isAnonAllowedRoute('POST', '/api/analytics/event')).toBe(true);
    expect(isAnonAllowedRoute('POST', '/api/community/submit')).toBe(true);
    expect(isAnonAllowedRoute('POST', '/api/debates/export')).toBe(true);
  });

  // t/3480: anon-allow the community op-ed public-link mint (regex predicate — parameterized path)
  it('t/3480: allows anon POST to mint a community op-ed public link', () => {
    expect(isAnonAllowedRoute('POST', '/api/community/opeds/abc123/share')).toBe(true);
  });

  it('t/3480: DELETE (revoke) on the same path stays authed-only', () => {
    expect(isAnonAllowedRoute('DELETE', '/api/community/opeds/abc123/share')).toBe(false);
  });

  it('t/3480: exact-match only — sibling subpaths of /api/community/opeds/* stay blocked', () => {
    expect(isAnonAllowedRoute('POST', '/api/community/opeds/abc123/vote')).toBe(false);
    expect(isAnonAllowedRoute('POST', '/api/community/opeds/share')).toBe(false); // no id segment
  });
});

describe('isTerminalAccessAllowed (L6)', () => {
  it('allows when AUTH_DISABLED (single-operator local mode)', () => {
    expect(isTerminalAccessAllowed({ authDisabled: true, principalName: '', isAdmin: false })).toBe(true);
  });
  it('requires an admin principal when auth is enabled', () => {
    expect(isTerminalAccessAllowed({ authDisabled: false, principalName: '', isAdmin: false })).toBe(false);
    expect(isTerminalAccessAllowed({ authDisabled: false, principalName: 'alice', isAdmin: false })).toBe(false);
    expect(isTerminalAccessAllowed({ authDisabled: false, principalName: 'alice', isAdmin: true })).toBe(true);
  });
});

describe('invalidRouteParam (t/810)', () => {
  it('passes well-formed params', () => {
    expect(invalidRouteParam('/api/debates/:id', '/api/debates/abc-123')).toBeNull();
    expect(invalidRouteParam('/api/edges/:index', '/api/edges/42')).toBeNull();
    expect(invalidRouteParam('/api/community/:type/:id', '/api/community/chats/9f8e')).toBeNull();
    expect(invalidRouteParam('/api/taxonomy/:pov', '/api/taxonomy/accelerationist')).toBeNull();
    expect(invalidRouteParam('/api/taxonomy/:pov/node/:nodeId/history', '/api/taxonomy/saf/node/saf-bel-001/history')).toBeNull();
    expect(invalidRouteParam('/health', '/health')).toBeNull(); // no params
  });

  it('rejects path traversal (raw, encoded, null byte) on id params', () => {
    expect(invalidRouteParam('/api/debates/:id', '/api/debates/%2e%2e')).toBe('id');       // encoded ..
    expect(invalidRouteParam('/api/debates/:id', '/api/debates/%2e%2e%2fetc')).toBe('id'); // encoded ../etc
    expect(invalidRouteParam('/api/debates/:id', '/api/debates/foo%00')).toBe('id');       // null byte
    expect(invalidRouteParam('/api/debates/:id', '/api/debates/a.b')).toBe('id');          // dot not allowed for id
  });

  it('rejects malformed percent-encoding', () => {
    expect(invalidRouteParam('/api/debates/:id', '/api/debates/%zz')).toBe('id');
  });

  it('allows dotted filenames but blocks traversal', () => {
    expect(invalidRouteParam('/api/flight-recorder/download/:filename', '/api/flight-recorder/download/dump-2026.json')).toBeNull();
    expect(invalidRouteParam('/api/proposals/:filename', '/api/proposals/%2e%2e')).toBe('filename'); // ".."
    expect(invalidRouteParam('/api/proposals/:filename', '/api/proposals/a%2fb')).toBe('filename');  // a/b
  });

  it('allows colon in review group ids but blocks traversal', () => {
    expect(invalidRouteParam('/api/admin/review/detail/:groupId', '/api/admin/review/detail/calibration%3Ajpsnover')).toBeNull();
    expect(invalidRouteParam('/api/admin/review/detail/:groupId', '/api/admin/review/detail/community%3Aabc-1')).toBeNull();
    expect(invalidRouteParam('/api/admin/review/detail/:groupId', '/api/admin/review/detail/%2e%2e%2fx')).toBe('groupId');
  });

  // t/2930: containerId is "type:id" (node:sit-021, sei:abc); the colon is structural so
  // isSafeId 400'd every one. Both arms — colon passes; traversal still rejected (the proof).
  it('allows colon in container ids but blocks traversal', () => {
    expect(invalidRouteParam('/api/container-mentions/:containerId', '/api/container-mentions/node%3Asit-021')).toBeNull();
    expect(invalidRouteParam('/api/container-mentions/:containerId', '/api/container-mentions/sei%3Aabc')).toBeNull();
    // negative arm (security): encoded/decoded traversal + separators + null byte must still 400
    expect(invalidRouteParam('/api/container-mentions/:containerId', '/api/container-mentions/node%3A%2e%2e%2fsecret')).toBe('containerId'); // node:../secret
    expect(invalidRouteParam('/api/container-mentions/:containerId', '/api/container-mentions/%2e%2e')).toBe('containerId');                 // ..
    expect(invalidRouteParam('/api/container-mentions/:containerId', '/api/container-mentions/node%3A..%2Fx')).toBe('containerId');          // node:../x
    expect(invalidRouteParam('/api/container-mentions/:containerId', '/api/container-mentions/node%3Ax%00')).toBe('containerId');            // null byte
  });

  it('rejects invalid pov names', () => {
    expect(invalidRouteParam('/api/taxonomy/:pov', '/api/taxonomy/%2e%2e')).toBe('pov');
    expect(invalidRouteParam('/api/taxonomy/:pov', '/api/taxonomy/ACC')).toBe('pov'); // uppercase not allowed
  });
});
