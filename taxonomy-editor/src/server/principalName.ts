/**
 * Canonical principal name, set once at request entry so every downstream reader
 * (resolvePrincipalIdentity, routes/session.ts, the WebSocket paths, and through them
 * deriveStorageUserId / isAdmin / allowlist / proxyTiers / READ_ONLY_PRINCIPALS) keys on
 * a value the caller cannot choose.
 *
 * Why: for GitHub, Easy Auth's `x-ms-client-principal-name` is the profile display name
 * or public email, which is neither unique nor stable, so it must not be an identity key.
 *
 * GitHub: the name header is ALWAYS replaced.
 *   - Stable id = the `nameidentifier` claim of the sidecar-set `x-ms-client-principal`
 *     (GitHub's numeric user id), else the sidecar-set `x-ms-client-principal-id`.
 *   - Name = the IDENTITY_MAP entry for `github:<id>` (an explicit, admin-held map onto the
 *     user's legacy principal name, so existing data/admin/tier entries keep working),
 *     else `github-<id>`: a fresh namespaced id no display name or email can produce.
 *   - No usable stable id → the name header is removed (anonymous) — fail closed.
 *   This also fixes the 2026-10-21 regression where the name header is absent for GitHub
 *   accounts with no public name/email (TL p/806#48): those users now get `github-<id>`.
 *
 * Other idps (Google/AAD): the name is the provider-verified email; unchanged. If it is
 * missing, it is filled from the same source the header carries (the name_typ claim), else
 * the email claim.
 *
 * Trust: x-ms-* headers are only consulted when WEBSITE_AUTH_ENABLED is on, where the Easy
 * Auth sidecar strips client-supplied x-ms-* headers and sets its own (S9, t/848).
 */
import type { IncomingMessage } from 'http';
import { log } from './logger.js';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';

const NAME_HEADER = 'x-ms-client-principal-name';
const PRINCIPAL_HEADER = 'x-ms-client-principal';
const ID_HEADER = 'x-ms-client-principal-id';
const IDP_HEADER = 'x-ms-client-principal-idp';

const NAMEIDENTIFIER_CLAIM = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier';
const DEFAULT_NAME_CLAIM = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name';
const EMAIL_CLAIM = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress';

/** A stable id becomes part of a storage directory name: keep it to a safe charset. */
const STABLE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

interface PrincipalClaim { typ?: unknown; val?: unknown }
interface ClientPrincipal { auth_typ?: unknown; name_typ?: unknown; claims?: unknown }

function headerString(req: IncomingMessage, name: string): string {
  const v = req.headers[name];
  return ((Array.isArray(v) ? v[0] : v) ?? '').trim();
}

function claimValue(claims: PrincipalClaim[], typ: string): string {
  for (const c of claims) {
    if (c && c.typ === typ && typeof c.val === 'string' && c.val.trim()) return c.val.trim();
  }
  return '';
}

interface DecodedPrincipal { ok: boolean; claims: PrincipalClaim[]; nameTyp: string; claimTypes: string[] }

function decodePrincipal(encoded: string): DecodedPrincipal {
  if (!encoded) return { ok: false, claims: [], nameTyp: DEFAULT_NAME_CLAIM, claimTypes: [] };
  let principal: ClientPrincipal;
  try {
    principal = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as ClientPrincipal;
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'principal-name', level: 'warn',
      message: 'x-ms-client-principal could not be decoded',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return { ok: false, claims: [], nameTyp: DEFAULT_NAME_CLAIM, claimTypes: [] };
  }
  const claims = Array.isArray(principal?.claims) ? (principal.claims as PrincipalClaim[]) : [];
  const nameTyp = typeof principal?.name_typ === 'string' && principal.name_typ ? principal.name_typ : DEFAULT_NAME_CLAIM;
  // Claim TYPES only (never values) — for logging what the sidecar sends.
  const claimTypes = [...new Set(claims.map(c => (c && typeof c.typ === 'string' ? c.typ : '?')))].sort();
  return { ok: true, claims, nameTyp, claimTypes };
}

/**
 * Parse IDENTITY_MAP: `github:<stableId>=<legacy principal name>,…`. Deploy-time, static,
 * admin-held (like READ_ONLY_PRINCIPALS). Malformed entries are skipped with a WARN.
 */
export function parseIdentityMap(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of (raw ?? '').split(',')) {
    const e = entry.trim();
    if (!e) continue;
    const eq = e.indexOf('=');
    const key = eq > 0 ? e.slice(0, eq).trim().toLowerCase() : '';
    const name = eq > 0 ? e.slice(eq + 1).trim() : '';
    const m = /^([a-z]+):(.+)$/.exec(key);
    if (!m || !STABLE_ID_RE.test(m[2]) || !name) {
      log.security.warn({ component: 'principal-name', reason: 'bad_identity_map_entry' },
        'IDENTITY_MAP entry ignored: expected <idp>:<stableId>=<legacy principal name>');
      continue;
    }
    map.set(key, name);
  }
  return map;
}

let identityMap: Map<string, string> | null = null;
function getIdentityMap(): Map<string, string> {
  if (!identityMap) identityMap = parseIdentityMap(process.env.IDENTITY_MAP);
  return identityMap;
}

const warned = new Set<string>();
function warnOnce(key: string, fields: Record<string, unknown>, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  log.security.warn({ component: 'principal-name', ...fields }, message);
}

/** Test-only: reset the once-per-process WARN dedupe and the cached IDENTITY_MAP. */
export function _resetPrincipalNameForTest(): void { warned.clear(); identityMap = null; }

/** GitHub: replace the (user-editable) name with a stable-id-derived canonical name. */
function canonicalizeGithub(req: IncomingMessage, decoded: DecodedPrincipal): void {
  const claimId = claimValue(decoded.claims, NAMEIDENTIFIER_CLAIM);
  const headerId = headerString(req, ID_HEADER);
  const stableId = claimId || headerId;
  if (claimId && headerId && claimId !== headerId) {
    warnOnce('github|id_mismatch', { idp: 'github', reason: 'id_mismatch' },
      'GitHub nameidentifier claim and x-ms-client-principal-id differ; using the claim');
  }
  if (!stableId || !STABLE_ID_RE.test(stableId)) {
    delete req.headers[NAME_HEADER];
    warnOnce('github|no_stable_id', { idp: 'github', reason: stableId ? 'bad_stable_id' : 'no_stable_id', claimTypes: decoded.claimTypes },
      'GitHub principal has no usable stable id; request treated as anonymous');
    return;
  }
  const mapped = getIdentityMap().get(`github:${stableId.toLowerCase()}`);
  req.headers[NAME_HEADER] = mapped ?? `github-${stableId.toLowerCase()}`;
}

/** Non-GitHub: keep the provider-verified name; fill it from the claims only if missing. */
function fillMissingName(req: IncomingMessage, idp: string, decoded: DecodedPrincipal): void {
  if (headerString(req, NAME_HEADER) || !decoded.ok) return;
  const name = claimValue(decoded.claims, decoded.nameTyp) || claimValue(decoded.claims, EMAIL_CLAIM);
  warnOnce(`${idp || '?'}|fill|${name ? 'ok' : 'none'}`, { idp: idp || null, derived: !!name, claimTypes: decoded.claimTypes },
    name
      ? 'x-ms-client-principal-name missing; filled from x-ms-client-principal claims'
      : 'x-ms-client-principal-name missing and no usable name claim; request stays anonymous');
  if (name) req.headers[NAME_HEADER] = name;
}

// idps whose provider-verified name is deliberately trusted as-is (SO review, t/4326#19).
// Anything else reaching fillMissingName — a typo, a misconfigured sidecar, a future
// provider never reviewed for this trust decision — is a silent fail-open: the request
// takes the trusted-name path nobody decided it should (t/4326, SO follow-up p/822#3).
const TRUSTED_NAME_IDPS = new Set(['google']);

/** WARN once when an idp reaches the trusted-name fallback path without having been
 *  reviewed for it (t/4326 follow-up, T0: observability only, no behavior change). */
function warnOnUnreviewedIdp(idp: string, claimTypes: string[]): void {
  if (!idp || TRUSTED_NAME_IDPS.has(idp)) return;
  warnOnce(`unreviewed-idp|${idp}`, { idp, reason: 'unreviewed_idp_trusted_name_fallback', claimTypes },
    'Unrecognized idp reached the trusted-name fallback path (fail-open) — never reviewed for this trust decision');
}

/**
 * Set the canonical `x-ms-client-principal-name` on the request. Call once per request,
 * at entry, before anything reads principal headers. No-op unless Easy Auth is on.
 */
export function normalizePrincipalNameHeader(req: IncomingMessage, azureAuthEnabled: boolean): void {
  if (!azureAuthEnabled) return;
  const encoded = headerString(req, PRINCIPAL_HEADER);
  const idp = headerString(req, IDP_HEADER).toLowerCase();
  if (idp === 'github') {
    canonicalizeGithub(req, decodePrincipal(encoded));
    return;
  }
  const decoded = decodePrincipal(encoded);
  warnOnUnreviewedIdp(idp, decoded.claimTypes);
  if (!encoded) return;
  fillMissingName(req, idp, decoded);
}
