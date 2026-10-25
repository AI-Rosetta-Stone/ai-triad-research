// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4486 (t/4410 item 2) — geo-restricts the server-provided free Gemini pool out of the EEA,
// Switzerland and the UK (Gemini API terms: "use only Paid Services when making API Clients
// available to users" there). Geolocates the correctly-derived client IP (post-#3679) against an
// offline, bundled country database (DB-IP Lite, CC-BY 4.0) — NO third-party lookup at request
// time (AC2). Fails CLOSED: EEA/CH/UK and any unresolvable IP are refused; everything else,
// including BYOK, is unaffected (BYOK callers never reach this module — see freePoolKeyAccess.ts).
//
// Data: ai/data/geoCountryIpv4.json, built by ai/scripts/build-geo-db.mjs. IPv4 only (v1 scope,
// TL-acknowledged deviation, t/4486#2) — an IPv6 client address can't be resolved against this
// table, so it takes the SAME fail-closed "unknown" path as a resolvable-but-uncategorized IP.
// That over-restricts (an IPv6 EEA... or non-EEA... visitor is refused either way) rather than
// under-restricting, which is the safe direction for a compliance gate.
//
// Lazily loaded (t/4486#2): the ~3.6MB data file is NOT imported at module scope. It loads once,
// on the first real lookup, via a cached dynamic import() — a server that serves zero free-pool
// traffic for its whole process lifetime (e.g. BYOK-only deployments) never pays the cost.

import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { log } from '../logger.js';

/** EEA (27 EU member states + Iceland, Liechtenstein, Norway) + Switzerland + the UK — the
 *  "Paid Services only" region under Gemini's current API terms (t/4410#7, #9). ISO 3166-1
 *  alpha-2. */
const RESTRICTED_COUNTRIES: ReadonlySet<string> = new Set([
  // EU-27
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV',
  'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  // EEA (non-EU)
  'IS', 'LI', 'NO',
  // Switzerland + UK
  'CH', 'GB',
]);

export type GeoRefusalReason = 'restricted_region' | 'no-public-ip' | 'not-in-db';

export interface GeoCheckResult {
  allowed: boolean;
  /** ISO 3166-1 alpha-2, or null when unresolved. Never an IP — this is the only thing logged. */
  country: string | null;
  /** Present only when `allowed === false`. */
  reason?: GeoRefusalReason;
}

interface GeoDbFile {
  sourceDate: string;
  generatedAt: string;
  licence: string;
  attribution: string;
  sha256: string;
  rowCount: number;
  packed: string;
}

interface GeoIndex {
  /** Sorted ascending; binary-search for the greatest start <= target. */
  starts: Uint32Array;
  /** Parallel to `starts`; each entry is a 2-char ISO country code. */
  countries: string[];
  sourceDate: string;
}

let indexPromise: Promise<GeoIndex> | null = null;
const STALENESS_WARN_DAYS = 60;

/** Decode the packed 10-char-record string into typed arrays for binary search.
 *  Exported for the build-staleness/shape tests; not part of the public request-path API. */
export function decodeGeoDb(db: GeoDbFile): GeoIndex {
  const n = db.rowCount;
  const starts = new Uint32Array(n);
  const countries = new Array<string>(n);
  for (let i = 0; i < n; i++) {
    const rec = db.packed.slice(i * 10, i * 10 + 10);
    starts[i] = parseInt(rec.slice(0, 8), 16);
    countries[i] = rec.slice(8, 10).trim();
  }
  return { starts, countries, sourceDate: db.sourceDate };
}

/** Exported for the staleness test (t/4486#2 AC) — not part of the request-path API. */
export function warnIfStale(sourceDate: string): void {
  const ageMs = Date.now() - new Date(`${sourceDate}T00:00:00Z`).getTime();
  const ageDays = Math.floor(ageMs / 86_400_000);
  if (ageDays > STALENESS_WARN_DAYS) {
    log.api.warn(
      { component: 'free-pool-geo', sourceDate, ageDays },
      `Free-pool geo database is ${ageDays} days old (> ${STALENESS_WARN_DAYS}d) — the monthly refresh job may be stuck`,
    );
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'free-pool-geo', level: 'warn',
      message: `Geo database stale: ${ageDays} days old`,
      data: { sourceDate, ageDays },
    });
  } else {
    log.api.info({ component: 'free-pool-geo', sourceDate, ageDays }, 'Free-pool geo database loaded');
  }
}

async function loadIndex(): Promise<GeoIndex> {
  const mod = await import('./data/geoCountryIpv4.json', { with: { type: 'json' } });
  const db = mod.default as GeoDbFile;
  const idx = decodeGeoDb(db);
  warnIfStale(idx.sourceDate);
  return idx;
}

/** Cached: the first caller pays the decode cost, every later call reuses it. */
function getIndex(): Promise<GeoIndex> {
  if (!indexPromise) indexPromise = loadIndex();
  return indexPromise;
}

/** Test seam: force a reload on the next getIndex() call. */
export function _resetGeoIndexForTest(): void { indexPromise = null; }

function binarySearchCountry(idx: GeoIndex, ipUint32: number): string | null {
  let lo = 0;
  let hi = idx.starts.length - 1;
  if (hi < 0 || ipUint32 < idx.starts[0]) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (idx.starts[mid] <= ipUint32) lo = mid; else hi = mid - 1;
  }
  return idx.countries[lo] || null;
}

function ipv4ToUint32(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

/** Normalize a client-IP string (as `getClientIp` returns it) to a bare dotted-quad IPv4
 *  address, or null when it isn't one. Handles (t/4486#2):
 *  - an IPv4-mapped IPv6 address (`::ffff:1.2.3.4`), which Node dual-stack sockets commonly
 *    produce as `req.socket.remoteAddress`;
 *  - a zone id suffix (`fe80::1%eth0`) — stripped before the mapped-v4 check;
 *  - a bracketed host with a port (`[::ffff:1.2.3.4]:443`) — unbracketed before the above.
 *  Any other IPv6 address, or the literal `'unknown'`, returns null (v1 is IPv4-only, see the
 *  module header). */
export function normalizeToIpv4(ip: string): string | null {
  let s = ip.trim();
  const bracketed = s.match(/^\[(.+)\]:\d+$/);
  if (bracketed) s = bracketed[1];
  s = s.split('%')[0]; // strip a zone id, if present
  const mapped = s.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) s = mapped[1];
  return ipv4ToUint32(s) !== null ? s : null;
}

/** The request-path geo check. `ip` is whatever `getClientIp(req)` returned — raw, un-normalized.
 *  Fails closed: an unresolvable IP (including any non-IPv4 address) is refused, same as a
 *  restricted country, with `reason: 'no-public-ip'` when the normalized form itself isn't a
 *  usable address and `'not-in-db'` when it is but the table has no entry for it. Never logs the
 *  IP — callers log only `country` and `reason` (AC3). */
export async function checkFreePoolGeo(ip: string): Promise<GeoCheckResult> {
  const v4 = normalizeToIpv4(ip);
  if (!v4) return { allowed: false, country: null, reason: 'no-public-ip' };
  const idx = await getIndex();
  const asUint32 = ipv4ToUint32(v4);
  const country = asUint32 === null ? null : binarySearchCountry(idx, asUint32);
  if (!country) return { allowed: false, country: null, reason: 'not-in-db' };
  if (RESTRICTED_COUNTRIES.has(country)) return { allowed: false, country, reason: 'restricted_region' };
  return { allowed: true, country };
}
