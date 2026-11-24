// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * SSRF-guarded URL fetch for prompt grounding (t/2482).
 *
 * Security design — all 5 TL-required changes implemented (t/2482#2):
 *
 * 1. INJECTABLE checkAddress PREDICATE — UrlFetchOptions.checkAddress replaces a
 *    hardcoded isPrivateIp call so tests can pass `() => false` to allow a localhost
 *    server without needing to mock dns.lookup. Default = isPrivateIp.
 *
 * 2. IP-PINNED REQUESTS (closes DNS-rebind TOCTOU) — requests use node:http /
 *    node:https with `host: resolvedIp` (connect to the IP we just validated),
 *    `servername: hostname` (SNI + cert validation against original hostname), and
 *    `Host: hostname` header (correct HTTP/1.1 virtual hosting). This prevents the
 *    window between DNS pre-check and TCP connect where a rebind can swap the IP.
 *
 * 3. MID-STREAM maxBytes ABORT — Content-Length is pre-checked before streaming
 *    begins; the body reader also maintains a running byte counter and calls
 *    res.destroy() + resolves null the moment it crosses maxBytes, so oversized
 *    responses never fully buffer.
 *
 * 4. IPv4-MAPPED IPv6 NORMALIZATION — addresses like `::ffff:127.0.0.1` or
 *    `::ffff:c0a8:0101` are normalized to their IPv4 equivalents before the
 *    private-range checks, preventing a bypass via the dual-stack representation.
 *
 * 5. too-many-redirects IS A DISTINCT REASON — redirect cap exhaustion returns
 *    `{ ok: false, reason: 'too-many-redirects' }` rather than 'network', so
 *    callers can surface a precise message and telemetry can distinguish redirect
 *    loops from hard connectivity failures.
 *
 * Node-only: imports node:dns, node:http, node:https. Never export through a barrel
 * that the renderer can reach — direct import path only.
 */

import { promises as dns } from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
// NOTE: `sanitizeText` is loaded LAZILY (dynamic import) inside the text path below — NOT eagerly here.
// This keeps the module's eager runtime imports to node builtins only, so the standalone binary CLI
// (`fetch-url-cli.mjs`, t/3324) can `import { fetchUrlForPromptBinary }` under plain `node`
// type-stripping without pulling in the sanitizer's `.js`-specifier deps (decode-named-character-
// reference etc.), which plain node cannot resolve. The binary path never sanitizes; the text path's
// bundled/vitest callers resolve the dynamic import normally. Type-only imports below are erased.
import type { UrlFetchOptions, UrlFetchResult, UrlFetchBinaryResult, UrlFetchFailureReason } from './types.js';

const DEFAULT_MAX_BYTES = 1_572_864; // 1.5 MB
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 5;

// ── IP normalization + private-range check ─────────────────────────────────

/**
 * Normalize an IPv4-mapped IPv6 address to its IPv4 form.
 * TL change #4: `::ffff:a.b.c.d` (dotted-decimal) and `::ffff:XXYY:ZZWW`
 * (hex-word) both collapse to `a.b.c.d` before range checks so dual-stack
 * representations cannot bypass the RFC-1918 / loopback blocks.
 */
export function normalizeIp(ip: string): string {
  // Dotted-decimal form: ::ffff:192.168.1.1
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip);
  if (dotted) return dotted[1];
  // Hex-word form: ::ffff:c0a8:0101  (two 16-bit hex groups)
  const hexWord = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hexWord) {
    const hi = parseInt(hexWord[1], 16);
    const lo = parseInt(hexWord[2], 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return ip;
}

/** Returns true when the (already-normalized) IP should be blocked. */
// t/467: IPv4-compatible ::/96 (deprecated): "::a.b.c.d" and "::h:l". Both forms have the first 96 bits zero.
function isIpv4CompatibleV6(lower: string): boolean {
  return /^::\d{1,3}(\.\d{1,3}){3}$/.test(lower) || /^::[0-9a-f]{1,4}(:[0-9a-f]{1,4})?$/.test(lower);
}

export function isPrivateIp(ip: string): boolean {
  const norm = normalizeIp(ip);

  // IPv4 range checks
  const parts = norm.split('.');
  // t/467: only a pure dotted quad is IPv4; "::8.8.8.8" also splits into four parts and must reach the IPv6 checks.
  if (parts.length === 4 && /^\d+(\.\d+){3}$/.test(norm)) {
    const [a, b, c] = parts.map(Number);
    if (a === 127) return true;                            // loopback
    if (a === 10) return true;                             // RFC-1918 10/8
    if (a === 172 && b >= 16 && b <= 31) return true;    // RFC-1918 172.16/12
    if (a === 192 && b === 168) return true;              // RFC-1918 192.168/16
    if (a === 169 && b === 254) return true;              // link-local / metadata
    if (a === 0) return true;                              // unspecified
    if (a === 100 && (b & 0xc0) === 64) return true;     // CGNAT 100.64/10
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a === 192 && b === 0 && c === 2) return true;    // TEST-NET-1
    if (a === 255) return true;                            // broadcast
    if (a >= 224) return true;                             // t/467: multicast 224/4 and reserved 240/4
    return false;
  }

  // IPv6 checks (after normalization, mapped addresses are already IPv4 above)
  const lower = norm.toLowerCase();
  if (isIpv4CompatibleV6(lower)) return true;       // t/467: ::/96 (deprecated)
  if (lower === '::1') return true;                 // loopback
  if (lower === '::') return true;                  // unspecified
  if (lower.startsWith('fe80:')) return true;       // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
  if (lower.startsWith('ff')) return true;          // multicast
  if (lower.startsWith('64:ff9b:')) return true;   // NAT64
  return false;
}

// ── IP-pinned HTTP request (TL change #2) ─────────────────────────────────

function makeRequest(
  resolvedIp: string,
  hostname: string,
  port: number,
  path: string,
  isHttps: boolean,
  timeoutMs: number,
  accept: string,
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    // RFC 9110 §7.2: the Host header carries the port whenever it is not the
    // scheme default, or a virtual host on a non-standard port misroutes.
    const hostHeader = port === (isHttps ? 443 : 80) ? hostname : `${hostname}:${port}`;
    const options: http.RequestOptions & https.RequestOptions = {
      method: 'GET',
      host: resolvedIp,       // connect to the pre-validated IP — closes rebind TOCTOU
      servername: hostname,   // SNI for TLS + certificate CN/SAN validation
      port,
      path,
      headers: {
        'Host': hostHeader,   // correct HTTP/1.1 virtual-host routing
        'User-Agent': 'AI-Triad-Research/1.0 (url-fetch)',
        'Accept': accept,     // text variant: HTML/plain-biased; binary variant: */*
        'Accept-Encoding': 'identity', // avoid gzip complications
      },
    };
    const lib = isHttps ? https : http;
    const req = lib.request(options, resolve);
    req.setTimeout(timeoutMs, () => {
      timedOut = true;
      req.destroy();
    });
    req.on('error', err => {
      if (timedOut) reject(Object.assign(new Error('timeout'), { isTimeout: true }));
      else reject(err);
    });
    req.end();
  });
}

// ── Streaming body reader with mid-stream abort (TL change #3) ────────────

function readBody(res: http.IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise(resolve => {
    let settled = false;
    const done = (val: Buffer | null) => { if (!settled) { settled = true; resolve(val); } };
    const chunks: Buffer[] = [];
    let total = 0;
    res.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        res.destroy(); // abort mid-stream immediately — bounds size DURING accumulation (TL t/3311 cond 2)
        done(null);
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => done(Buffer.concat(chunks)));  // raw bytes; text variant decodes utf-8
    res.on('error', () => done(null));
    // destroy() triggers 'close' but not 'end' — ensure we resolve
    res.on('close', () => done(null));
  });
}

// ── HTML → plain text ──────────────────────────────────────────────────────

// t/390: the URL-mode converter is the linear one from lib/extraction/extractHtml.ts (one implementation, with the
// same tag and entity handling as document extraction). The regex chain it replaces went quadratic on unclosed tags
// (an attacker-controlled page can send them): 40k "<" took about 0.75 s, and the cost quadrupled as the input doubled.

/** HTML to { text, title } for URL mode. Exported for the regression test. */
export async function htmlToText(html: string): Promise<{ text: string; title: string | undefined }> {
  // Lazy import, like the sanitizer: keeps the binary CLI plain-node-importable (see the top-of-file note).
  const { htmlToTextLinear, htmlTitleLinear } = await import('../extraction/extractHtml.js');
  return { text: htmlToTextLinear(html, { blockNewlines: true }), title: htmlTitleLinear(html) };
}

// ── Main entry point ───────────────────────────────────────────────────────

// ── Shared SSRF-guarded transport core (t/3311) ────────────────────────────
//
// The ENTIRE transport loop — URL/protocol parse → DNS + SSRF private-range check (RE-RUN FOR EVERY
// HOP, incl. redirect targets: TL t/3311 cond 1, the classic SSRF-via-redirect bypass) → IP-pinned
// request → redirect cap → HTTP-error → Content-Length precheck → mid-stream maxBytes abort (cond 2).
// Both entry points (fetchUrlForPrompt/text, fetchUrlForPromptBinary/bytes) call this ONE core, so
// the security path is never duplicated (drift-free). `acceptContentType` is a content-SUITABILITY
// filter, NOT a security control; the core returns the raw response bytes + content-type + final URL.
interface RawFetchOk { ok: true; bytes: Buffer; contentType: string; finalUrl: string }
type RawFetchResult = RawFetchOk | { ok: false; reason: UrlFetchFailureReason; status?: number };

async function fetchRawResponse(
  url: string,
  opts: UrlFetchOptions,
  acceptContentType: (contentType: string) => boolean,
  acceptHeader: string,
): Promise<RawFetchResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const checkAddress = opts.checkAddress ?? isPrivateIp; // TL change #1

  let currentUrl = url;
  let redirectCount = 0;

  for (;;) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      return { ok: false, reason: 'network' };
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: 'network' };
    }

    const isHttps = parsed.protocol === 'https:';
    const hostname = parsed.hostname;
    const port = parsed.port ? parseInt(parsed.port, 10) : (isHttps ? 443 : 80);
    const path = (parsed.pathname || '/') + parsed.search;

    // DNS pre-resolution + SSRF check (TL changes #1, #4). This block runs on EVERY loop iteration,
    // so a redirect to a private/metadata IP is re-validated and blocked (TL t/3311 cond 1).
    let resolvedIp: string;
    try {
      const addrs = await dns.lookup(hostname, { all: true });
      if (!addrs.length) return { ok: false, reason: 'network' };
      // Normalize each address (IPv4-mapped IPv6) then apply the check
      const firstAllowed = addrs.find(a => !checkAddress(normalizeIp(a.address)));
      if (!firstAllowed) return { ok: false, reason: 'ssrf-blocked' };
      resolvedIp = firstAllowed.address;
    } catch {
      return { ok: false, reason: 'network' };
    }

    // IP-pinned request (TL change #2)
    let res: http.IncomingMessage;
    try {
      res = await makeRequest(resolvedIp, hostname, port, path, isHttps, timeoutMs, acceptHeader);
    } catch (err) {
      if ((err as { isTimeout?: boolean }).isTimeout) return { ok: false, reason: 'timeout' };
      return { ok: false, reason: 'network' };
    }

    // Redirect handling (TL change #5 — distinct reason). `continue` re-enters the loop, which
    // re-parses + re-validates the new hop through the SSRF check above (cond 1).
    if (res.statusCode !== undefined && res.statusCode >= 300 && res.statusCode < 400) {
      const location = res.headers.location;
      res.destroy();
      if (!location) return { ok: false, reason: 'network' };
      if (redirectCount >= maxRedirects) return { ok: false, reason: 'too-many-redirects' };
      redirectCount++;
      try {
        currentUrl = new URL(location, currentUrl).href;
      } catch {
        return { ok: false, reason: 'network' };
      }
      continue;
    }

    // HTTP errors — carry the status so callers can surface `HTTP <code>`
    if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
      const status = res.statusCode;
      res.destroy();
      return { ok: false, reason: 'http-error', status };
    }

    // Content-Type SUITABILITY filter (caller-supplied; NOT a security control). Text passes
    // html/plain; binary passes accept-all. Reject-before-body-read is preserved for the text path.
    const contentType = res.headers['content-type'] ?? '';
    if (!acceptContentType(contentType)) {
      res.destroy();
      return { ok: false, reason: 'unsupported-content' };
    }

    // Content-Length pre-check (TL change #3 — first half)
    const clHeader = res.headers['content-length'];
    if (clHeader !== undefined && parseInt(clHeader, 10) > maxBytes) {
      res.destroy();
      return { ok: false, reason: 'too-large' };
    }

    // Stream with mid-stream abort (TL change #3 / t/3311 cond 2 — bounds size DURING accumulation)
    const bytes = await readBody(res, maxBytes);
    if (bytes === null) return { ok: false, reason: 'too-large' };

    return { ok: true, bytes, contentType, finalUrl: currentUrl };
  }
}

// ── Text entry point — HTML/plain only, extracted + XSS-sanitized text ──────
export async function fetchUrlForPrompt(
  url: string,
  opts: UrlFetchOptions = {},
): Promise<UrlFetchResult> {
  const raw = await fetchRawResponse(
    url,
    opts,
    contentType => contentType.includes('text/html') || contentType.includes('text/plain'),
    'text/html, text/plain;q=0.9, */*;q=0.1',
  );
  if (!raw.ok) return raw;

  const isHtml = raw.contentType.includes('text/html');
  const body = raw.bytes.toString('utf-8');

  // HTML → text, then XSS safety pass via shared core. rawBody callers run their own converter over
  // the markup, so both steps are skipped for them (the transport-level SSRF guarantees still applied).
  let text: string;
  let title: string | undefined;
  if (opts.rawBody) {
    text = body;
    if (isHtml) {
      const { htmlTitleLinear } = await import('../extraction/extractHtml.js');
      title = htmlTitleLinear(body);
    }
  } else {
    const extracted = isHtml ? await htmlToText(body) : { text: body, title: undefined };
    title = extracted.title;
    // Lazy import (see the top-of-file note): keeps the sanitizer out of the module's eager graph so
    // the binary CLI stays plain-node-importable. Bundled/vitest callers resolve this normally.
    const { sanitizeText } = await import('../sanitize/contentSanitizerCore.js');
    text = sanitizeText(extracted.text);
  }

  // Soft token-budget truncation
  let truncated = false;
  if (opts.tokenBudget !== undefined && text.length > opts.tokenBudget) {
    text = text.slice(0, opts.tokenBudget);
    truncated = true;
  }

  return { ok: true, text, title, finalUrl: raw.finalUrl, truncated };
}

// ── Binary entry point — any content-type → raw bytes (PDF op-ed sources, t/3311) ──
//
// IDENTICAL SSRF core as the text path (every guard + per-hop re-validation + mid-stream maxBytes
// abort reused via fetchRawResponse). The ONLY differences: accept any content-type (skip the
// text-only suitability filter) and return the raw bytes instead of extracted/sanitized text.
// maxBytes still bounds the response, so a large binary cannot OOM the process (TL t/3311 cond 2).
// The bytes are returned untrusted — the caller (PDF parser etc.) owns any content-level safety.
export async function fetchUrlForPromptBinary(
  url: string,
  opts: UrlFetchOptions = {},
): Promise<UrlFetchBinaryResult> {
  const raw = await fetchRawResponse(url, opts, () => true, '*/*');
  if (!raw.ok) return raw;
  return { ok: true, bytes: raw.bytes, contentType: raw.contentType, finalUrl: raw.finalUrl };
}
