// @vitest-environment node
//
// GitHub identity keys on the stable provider id, not the profile display name / public
// email (p/806#48, #57), including accounts with no public name or email.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage } from 'http';

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
vi.mock('../logger.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../logger.js')>();
  return { ...orig, log: { ...orig.log, security: { ...orig.log.security, warn: warnMock } } };
});

import { normalizePrincipalNameHeader, parseIdentityMap, canProducePrincipal, identityMapSize, _resetPrincipalNameForTest } from '../principalName.js';
import { deriveStorageUserId } from '../security/userContext.js';
import { isAdmin } from '../community/community.js';

const NAME_TYP = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name';
const NAMEID = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier';
const EMAIL = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress';
const TID = 'http://schemas.microsoft.com/identity/claims/tenantid';
const OID = 'http://schemas.microsoft.com/identity/claims/objectidentifier';

function encode(p: unknown): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64');
}

function principal(claims: Array<[string, string]>, authTyp = 'github'): string {
  return encode({ auth_typ: authTyp, name_typ: NAME_TYP, claims: claims.map(([typ, val]) => ({ typ, val })) });
}

function githubReq(opts: { id?: string; headerId?: string; displayName?: string; login?: string; email?: string; nameHeader?: string }): IncomingMessage {
  const claims: Array<[string, string]> = [];
  if (opts.id) claims.push([NAMEID, opts.id]);
  if (opts.login) claims.push(['urn:github:login', opts.login]);
  if (opts.displayName) claims.push([NAME_TYP, opts.displayName]);
  if (opts.email) claims.push([EMAIL, opts.email]);
  const headers: Record<string, string> = {
    'x-ms-client-principal': principal(claims),
    'x-ms-client-principal-idp': 'github',
  };
  if (opts.headerId ?? opts.id) headers['x-ms-client-principal-id'] = (opts.headerId ?? opts.id)!;
  if (opts.nameHeader !== undefined) headers['x-ms-client-principal-name'] = opts.nameHeader;
  return { headers } as unknown as IncomingMessage;
}

function nameOf(r: IncomingMessage): string | undefined {
  return r.headers['x-ms-client-principal-name'] as string | undefined;
}

function aadReq(opts: { tid?: string; oid?: string; name?: string; email?: string; nameHeader?: string }): IncomingMessage {
  const claims: Array<[string, string]> = [];
  if (opts.tid) claims.push([TID, opts.tid]);
  if (opts.oid) claims.push([OID, opts.oid]);
  if (opts.name) claims.push([NAME_TYP, opts.name]);
  if (opts.email) claims.push([EMAIL, opts.email]);
  const headers: Record<string, string> = {
    'x-ms-client-principal': principal(claims, 'aad'),
    'x-ms-client-principal-idp': 'aad',
  };
  if (opts.nameHeader !== undefined) headers['x-ms-client-principal-name'] = opts.nameHeader;
  return { headers } as unknown as IncomingMessage;
}

let prevMap: string | undefined;
let prevAdmins: string | undefined;
let prevContainerAppName: string | undefined;
let prevAiTriadEnv: string | undefined;
let prevGoogleDiagFlag: string | undefined;
beforeEach(() => {
  prevMap = process.env.IDENTITY_MAP;
  prevAdmins = process.env.ADMIN_USERS;
  prevContainerAppName = process.env.CONTAINER_APP_NAME;
  prevAiTriadEnv = process.env.AI_TRIAD_ENV;
  prevGoogleDiagFlag = process.env.GOOGLE_CLAIM_SHAPE_DIAG;
  process.env.ADMIN_USERS = 'jpsnover,jsnover13-at-gmail-com';
  delete process.env.IDENTITY_MAP;
  delete process.env.CONTAINER_APP_NAME;
  delete process.env.AI_TRIAD_ENV;
  delete process.env.GOOGLE_CLAIM_SHAPE_DIAG;
  warnMock.mockClear();
  _resetPrincipalNameForTest();
});
afterEach(() => {
  if (prevMap === undefined) delete process.env.IDENTITY_MAP; else process.env.IDENTITY_MAP = prevMap;
  if (prevAdmins === undefined) delete process.env.ADMIN_USERS; else process.env.ADMIN_USERS = prevAdmins;
  if (prevContainerAppName === undefined) delete process.env.CONTAINER_APP_NAME; else process.env.CONTAINER_APP_NAME = prevContainerAppName;
  if (prevAiTriadEnv === undefined) delete process.env.AI_TRIAD_ENV; else process.env.AI_TRIAD_ENV = prevAiTriadEnv;
  if (prevGoogleDiagFlag === undefined) delete process.env.GOOGLE_CLAIM_SHAPE_DIAG; else process.env.GOOGLE_CLAIM_SHAPE_DIAG = prevGoogleDiagFlag;
});

/** Sets the two env vars that make isStagingIdentity() true, for the diagnostic's gate tests. */
function enableStaging(): void {
  process.env.CONTAINER_APP_NAME = 'taxonomy-editor-staging';
}

describe('GitHub identity keys on the stable provider id', () => {
  it.each([
    ['an admin GitHub id', 'jpsnover'],
    ['an admin Google-derived id', 'jsnover13-at-gmail-com'],
    ['an admin email', 'jsnover13@gmail.com'],
  ])('display name equal to %s does not determine the id', (_label, display) => {
    const r = githubReq({ id: '999001', displayName: display, nameHeader: display });
    normalizePrincipalNameHeader(r, true);
    expect(nameOf(r)).toBe('github-999001');
    const id = deriveStorageUserId(nameOf(r)!, 'github');
    expect(id).toBe('github-999001');
    expect(isAdmin(id)).toBe(false);
  });

  it('public email does not determine the id', () => {
    const r = githubReq({ id: '999002', email: 'jsnover13@gmail.com', nameHeader: 'jsnover13@gmail.com' });
    normalizePrincipalNameHeader(r, true);
    expect(isAdmin(deriveStorageUserId(nameOf(r)!, 'github'))).toBe(false);
  });

  it('renaming the display name does not change the id', () => {
    const a = githubReq({ id: '4242', displayName: 'Before', nameHeader: 'Before' });
    const b = githubReq({ id: '4242', displayName: 'After', nameHeader: 'After' });
    normalizePrincipalNameHeader(a, true);
    normalizePrincipalNameHeader(b, true);
    expect(nameOf(a)).toBe(nameOf(b));
  });

  it('no -name header and no public name/email (p/806#48 regression): signed in as github-<id>', () => {
    const r = githubReq({ id: '777', login: 'ai-triad-smoke' });
    normalizePrincipalNameHeader(r, true);
    expect(nameOf(r)).toBe('github-777');
  });

  it('falls back to x-ms-client-principal-id when the claim is absent', () => {
    const r = githubReq({ headerId: '888' });
    normalizePrincipalNameHeader(r, true);
    expect(nameOf(r)).toBe('github-888');
  });

  it('claim and -id header disagree: uses the claim and WARNs', () => {
    const r = githubReq({ id: '111', headerId: '222' });
    normalizePrincipalNameHeader(r, true);
    expect(nameOf(r)).toBe('github-111');
    expect(warnMock.mock.calls[0][0]).toMatchObject({ reason: 'id_mismatch' });
  });
});

describe('AAD identity keys on tid+oid, not the name/email claim (t/4326 C4)', () => {
  it.each([
    ['an admin AAD-shaped id', 'jsnover15-at-hotmail-com'],
    ['an admin email', 'jsnover15@hotmail.com'],
  ])('name/email equal to %s does not determine the id', (_label, display) => {
    const r = aadReq({ tid: 'tenant-1', oid: 'obj-1', name: display, email: display, nameHeader: display });
    normalizePrincipalNameHeader(r, true);
    expect(nameOf(r)).toBe('aad-tenant-1-obj-1');
    expect(isAdmin(deriveStorageUserId(nameOf(r)!, 'aad'))).toBe(false);
  });

  it('renaming the display name/email does not change the id', () => {
    const a = aadReq({ tid: 't', oid: 'o', name: 'Before', nameHeader: 'Before' });
    const b = aadReq({ tid: 't', oid: 'o', name: 'After', nameHeader: 'After' });
    normalizePrincipalNameHeader(a, true);
    normalizePrincipalNameHeader(b, true);
    expect(nameOf(a)).toBe(nameOf(b));
  });

  it('a mapped tid+oid resolves to the legacy principal name (keeps data, admin, tiers)', () => {
    process.env.IDENTITY_MAP = 'aad:tenant-1-obj-1=jsnover15-at-hotmail-com';
    process.env.ADMIN_USERS = 'jsnover15-at-hotmail-com';
    const r = aadReq({ tid: 'tenant-1', oid: 'obj-1', name: 'Anything', nameHeader: 'Anything' });
    normalizePrincipalNameHeader(r, true);
    expect(nameOf(r)).toBe('jsnover15-at-hotmail-com');
    expect(isAdmin(deriveStorageUserId(nameOf(r)!, 'aad'))).toBe(true);
  });

  it('missing oid → anonymous, WARN with claim types only', () => {
    const r = aadReq({ tid: 'tenant-1', name: 'jpsnover', nameHeader: 'jpsnover' });
    normalizePrincipalNameHeader(r, true);
    expect(nameOf(r)).toBeUndefined();
    const [fields] = warnMock.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toMatchObject({ idp: 'aad', reason: 'no_stable_id' });
  });

  it('missing tid → anonymous', () => {
    const r = aadReq({ oid: 'obj-1', nameHeader: 'x' });
    normalizePrincipalNameHeader(r, true);
    expect(nameOf(r)).toBeUndefined();
  });

  it('tid/oid outside the safe charset → anonymous', () => {
    const r = aadReq({ tid: '../admin', oid: 'obj-1', nameHeader: 'x' });
    normalizePrincipalNameHeader(r, true);
    expect(nameOf(r)).toBeUndefined();
  });

  it('never falls back to the name or email claim — no non-spoofable header exists for AAD', () => {
    // Same tid+oid as a mapped admin, but no map entry configured: must NOT grant via name/email.
    const r = aadReq({ tid: 'unmapped-tenant', oid: 'unmapped-obj', name: 'jpsnover', email: 'jsnover15@hotmail.com', nameHeader: 'jpsnover' });
    normalizePrincipalNameHeader(r, true);
    expect(nameOf(r)).toBe('aad-unmapped-tenant-unmapped-obj');
  });
});

describe('IDENTITY_MAP: explicit legacy mapping', () => {
  it('a mapped stable id resolves to the legacy principal name (keeps data, admin, tiers)', () => {
    process.env.IDENTITY_MAP = 'github:1234=jpsnover, github:5678=ai-triad-smoke';
    const r = githubReq({ id: '1234', displayName: 'Anything', nameHeader: 'Anything' });
    normalizePrincipalNameHeader(r, true);
    expect(nameOf(r)).toBe('jpsnover');
    expect(isAdmin(deriveStorageUserId(nameOf(r)!, 'github'))).toBe(true);
  });

  it('only the mapped id gets the legacy name', () => {
    process.env.IDENTITY_MAP = 'github:1234=jpsnover';
    const r = githubReq({ id: '9999', displayName: 'jpsnover', nameHeader: 'jpsnover' });
    normalizePrincipalNameHeader(r, true);
    expect(nameOf(r)).toBe('github-9999');
  });

  it('malformed entries are skipped with a WARN, valid ones kept', () => {
    const m = parseIdentityMap('github:1=a, nonsense, github:bad id=x, github:2=');
    expect([...m.entries()]).toEqual([['github:1', 'a']]);
    expect(warnMock).toHaveBeenCalledTimes(3);
  });
});

describe('fail closed', () => {
  it('no stable id anywhere → anonymous (name header removed), WARN with claim types only', () => {
    const r = githubReq({ displayName: 'jpsnover', nameHeader: 'jpsnover' });
    normalizePrincipalNameHeader(r, true);
    expect(nameOf(r)).toBeUndefined();
    const [fields, message] = warnMock.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({ reason: 'no_stable_id', claimTypes: [NAME_TYP] });
    expect(JSON.stringify(fields) + message).not.toContain('jpsnover');
  });

  it('a stable id outside the safe charset → anonymous', () => {
    const r = githubReq({ id: '../admin' });
    normalizePrincipalNameHeader(r, true);
    expect(nameOf(r)).toBeUndefined();
  });

  it('undecodable principal and no -id header → anonymous, no throw', () => {
    const r = { headers: { 'x-ms-client-principal': '%%%', 'x-ms-client-principal-idp': 'github', 'x-ms-client-principal-name': 'jpsnover' } } as unknown as IncomingMessage;
    expect(() => normalizePrincipalNameHeader(r, true)).not.toThrow();
    expect(nameOf(r)).toBeUndefined();
  });
});

describe('canProducePrincipal (t/4505): round-trips with what normalizePrincipalNameHeader actually produces', () => {
  it('a self-produced github-<id> name (no map entry) is accepted', () => {
    const r = githubReq({ id: '555' });
    normalizePrincipalNameHeader(r, true);
    expect(canProducePrincipal('github', nameOf(r)!)).toBe(true);
  });

  it('a self-produced aad-<tid>-<oid> name (no map entry) is accepted', () => {
    const r = aadReq({ tid: 't1', oid: 'o1', nameHeader: 'x' });
    normalizePrincipalNameHeader(r, true);
    expect(canProducePrincipal('aad', nameOf(r)!)).toBe(true);
  });

  it('a mapped github name is accepted for github, not for aad', () => {
    process.env.IDENTITY_MAP = 'github:1234=jpsnover';
    const r = githubReq({ id: '1234' });
    normalizePrincipalNameHeader(r, true);
    expect(canProducePrincipal('github', nameOf(r)!)).toBe(true);
    expect(canProducePrincipal('aad', nameOf(r)!)).toBe(false);
  });

  it('a bare legacy name with no map entry is rejected by both idps', () => {
    expect(canProducePrincipal('github', 'jpsnover')).toBe(false);
    expect(canProducePrincipal('aad', 'jpsnover')).toBe(false);
  });

  it('an empty name is never producible', () => {
    expect(canProducePrincipal('github', '')).toBe(false);
  });

  it('identityMapSize reflects the parsed IDENTITY_MAP', () => {
    expect(identityMapSize()).toBe(0);
    process.env.IDENTITY_MAP = 'github:1=a, github:2=b';
    _resetPrincipalNameForTest();
    expect(identityMapSize()).toBe(2);
  });
});

describe('other idps and no-ops', () => {
  it('Google: the provider-verified name is kept unchanged', () => {
    const r = { headers: {
      'x-ms-client-principal-name': 'user@gmail.com', 'x-ms-client-principal-idp': 'google',
      'x-ms-client-principal': principal([[NAMEID, 'g-1']], 'google'),
    } } as unknown as IncomingMessage;
    normalizePrincipalNameHeader(r, true);
    expect(nameOf(r)).toBe('user@gmail.com');
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('Google with the name header missing: filled from the email claim', () => {
    const r = { headers: {
      'x-ms-client-principal-idp': 'google',
      'x-ms-client-principal': principal([[NAMEID, 'g-1'], [EMAIL, 'user@gmail.com']], 'google'),
    } } as unknown as IncomingMessage;
    normalizePrincipalNameHeader(r, true);
    expect(nameOf(r)).toBe('user@gmail.com');
  });

  it('Easy Auth disabled: x-ms-* headers are not touched or trusted', () => {
    const r = githubReq({ id: '1', nameHeader: 'x' });
    normalizePrincipalNameHeader(r, false);
    expect(nameOf(r)).toBe('x');
  });

  it('anonymous request (no principal headers): nothing happens', () => {
    const r = { headers: {} } as unknown as IncomingMessage;
    normalizePrincipalNameHeader(r, true);
    expect(nameOf(r)).toBeUndefined();
    expect(warnMock).not.toHaveBeenCalled();
  });
});

describe('unreviewed idp WARN (t/4326 follow-up, p/822#3)', () => {
  it('an idp other than github/google reaching the trusted-name path WARNs once', () => {
    const r = { headers: {
      'x-ms-client-principal-name': 'someone@example.com', 'x-ms-client-principal-idp': 'facebook',
      'x-ms-client-principal': principal([[EMAIL, 'someone@example.com']], 'facebook'),
    } } as unknown as IncomingMessage;
    normalizePrincipalNameHeader(r, true);
    expect(nameOf(r)).toBe('someone@example.com'); // behavior unchanged — still trusted as-is
    expect(warnMock.mock.calls.some(([fields]) => (fields as Record<string, unknown>).reason === 'unreviewed_idp_trusted_name_fallback' && (fields as Record<string, unknown>).idp === 'facebook')).toBe(true);
  });

  it('google does not WARN (explicitly reviewed)', () => {
    const r = { headers: {
      'x-ms-client-principal-name': 'user@gmail.com', 'x-ms-client-principal-idp': 'google',
      'x-ms-client-principal': principal([[EMAIL, 'user@gmail.com']], 'google'),
    } } as unknown as IncomingMessage;
    normalizePrincipalNameHeader(r, true);
    expect(warnMock.mock.calls.some(([fields]) => (fields as Record<string, unknown>).reason === 'unreviewed_idp_trusted_name_fallback')).toBe(false);
  });

  it('github does not WARN (has its own canonicalization path)', () => {
    const r = githubReq({ id: '1', nameHeader: 'x' });
    normalizePrincipalNameHeader(r, true);
    expect(warnMock.mock.calls.some(([fields]) => (fields as Record<string, unknown>).reason === 'unreviewed_idp_trusted_name_fallback')).toBe(false);
  });

  it('an unreviewed idp with no claims blob at all still WARNs (no encoded principal to decode)', () => {
    const r = { headers: { 'x-ms-client-principal-idp': 'okta', 'x-ms-client-principal-name': 'x' } } as unknown as IncomingMessage;
    normalizePrincipalNameHeader(r, true);
    expect(warnMock.mock.calls.some(([fields]) => (fields as Record<string, unknown>).reason === 'unreviewed_idp_trusted_name_fallback' && (fields as Record<string, unknown>).idp === 'okta')).toBe(true);
  });
});

function googleDiagReq(claims: Array<[string, string]>, name = 'user@gmail.com'): IncomingMessage {
  return { headers: {
    'x-ms-client-principal-name': name, 'x-ms-client-principal-idp': 'google',
    'x-ms-client-principal': principal(claims, 'google'),
  } } as unknown as IncomingMessage;
}

function diagCall(): [Record<string, unknown>, string] | undefined {
  return warnMock.mock.calls.find(([fields]) => 'hasStableIdClaim' in (fields as Record<string, unknown>)) as [Record<string, unknown>, string] | undefined;
}

describe('Google claim-shape diagnostic (TEMPORARY, staging-only, default off — t/4436)', () => {
  it('off by default, even on staging: no diagnostic WARN', () => {
    enableStaging();
    normalizePrincipalNameHeader(googleDiagReq([[NAMEID, 'sub-123'], [EMAIL, 'user@gmail.com']]), true);
    expect(diagCall()).toBeUndefined();
  });

  it('off on prod even with the flag enabled — isStagingIdentity() is the hard gate', () => {
    process.env.GOOGLE_CLAIM_SHAPE_DIAG = '1';
    // deliberately NOT calling enableStaging() — this simulates prod with the flag mistakenly set
    normalizePrincipalNameHeader(googleDiagReq([[NAMEID, 'sub-123'], [EMAIL, 'user@gmail.com']]), true);
    expect(diagCall()).toBeUndefined();
  });

  it('on staging with the flag enabled: captures claim types + hasStableIdClaim, never values', () => {
    enableStaging();
    process.env.GOOGLE_CLAIM_SHAPE_DIAG = '1';
    normalizePrincipalNameHeader(googleDiagReq([[NAMEID, 'sub-123'], [EMAIL, 'user@gmail.com']]), true);
    const call = diagCall();
    expect(call).toBeDefined();
    const [fields, message] = call!;
    expect(fields).toMatchObject({ idp: 'google', claimTypes: [EMAIL, NAMEID].sort(), decodedOk: true, hasStableIdClaim: true });
    // The core requirement (TL p/602#31 condition 2): no claim VALUE ever appears in the log line.
    const serialized = JSON.stringify(fields) + message;
    expect(serialized).not.toContain('sub-123');
    expect(serialized).not.toContain('user@gmail.com');
  });

  it('hasStableIdClaim is false when no nameidentifier-shaped claim is present', () => {
    enableStaging();
    process.env.GOOGLE_CLAIM_SHAPE_DIAG = '1';
    normalizePrincipalNameHeader(googleDiagReq([[EMAIL, 'user@gmail.com']]), true);
    expect(diagCall()?.[0]).toMatchObject({ hasStableIdClaim: false });
  });

  it('fires once per process even across multiple Google requests', () => {
    enableStaging();
    process.env.GOOGLE_CLAIM_SHAPE_DIAG = '1';
    normalizePrincipalNameHeader(googleDiagReq([[EMAIL, 'a@gmail.com']], 'a@gmail.com'), true);
    normalizePrincipalNameHeader(googleDiagReq([[EMAIL, 'b@gmail.com']], 'b@gmail.com'), true);
    expect(warnMock.mock.calls.filter(([fields]) => 'hasStableIdClaim' in (fields as Record<string, unknown>)).length).toBe(1);
  });

  it('never fires for non-google idps', () => {
    enableStaging();
    process.env.GOOGLE_CLAIM_SHAPE_DIAG = '1';
    normalizePrincipalNameHeader(githubReq({ id: '1', nameHeader: 'x' }), true);
    expect(diagCall()).toBeUndefined();
  });
});
