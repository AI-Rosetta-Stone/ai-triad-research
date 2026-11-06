// @vitest-environment node
//
// t/1788 — GET /api/public/pov/:pov/node/:nodeId: the public, no-login POV-node
// share endpoint. This is a SECURITY-SENSITIVE public surface, so the suite is
// weighted toward the controls the OWASP/info-leak review cares about:
//   (a) whitelist-only projection — a node laden with graph_attributes (aphorism
//       + embeddings + scores), _edit_meta, authorship, timestamps and status
//       must project to EXACTLY the 6 allowlisted fields, nothing more.
//   (b) auth-bypass scope — the /api/public/ clause is present in the server.ts
//       auth gate, a gated sibling is NOT, and the route table exposes exactly
//       one route under /api/public/.
//   (c) no session — a logged-out request gets NO Set-Cookie back.
// Plus rate-limit (429 + Retry-After), 404, and 400 (bad :pov / traversal).
//
// Drives the real handler through a captured Router + a minimal req/res so the
// real httpKit json()/error() path runs. fileIO.readTaxonomyFile is mocked; the
// real isSafePov/isSafeId (used by invalidRouteParam) and the real checkRate are
// exercised — each test uses a distinct client IP so rate windows never bleed.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { IncomingMessage, ServerResponse } from 'http';
import { computeIsPublicPath, PUBLIC_PATH_PREFIXES } from '../publicPaths.js';

const { readTaxonomyFileMock, recordMock } = vi.hoisted(() => ({
  readTaxonomyFileMock: vi.fn(),
  recordMock: vi.fn(),
}));

// Partial mock: override readTaxonomyFile but keep the real isSafePov/isSafeId
// (invalidRouteParam imports them from here — mocking the whole module would
// break the very traversal guard we are testing).
vi.mock('../storage/fileIO.js', async (importActual) => {
  const actual = await importActual<typeof import('../storage/fileIO.js')>();
  return { ...actual, readTaxonomyFile: readTaxonomyFileMock };
});
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: recordMock }) }));

import type { ServerCtx } from '../routes/context.js';
import { createRouter, type Handler } from '../httpKit.js';
import { registerPublicShareRoutes, _resetPublicPovCache, type PublicPovNode } from '../routes/publicShare.js';
import { extractRoutes } from './extractRoutes.js';

const ROUTE = '/api/public/pov/:pov/node/:nodeId';
const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'server.ts');

// ── route harness ──
interface InvokeResult { status: number; body: unknown; headers: Record<string, unknown> }

// `pov`/`nodeId` are inserted verbatim (caller controls encoding) so a test can
// send an encoded-traversal segment. `ip` seeds x-forwarded-for → the rate key.
async function invoke(pov: string, nodeId: string, ip = `1.2.3.${Math.floor(Math.random() * 1e6)}`): Promise<InvokeResult> {
  const routes: { method: string; path: string; handler: Handler }[] = [];
  registerPublicShareRoutes(createRouter(routes), {} as ServerCtx);
  const route = routes.find(r => r.path === ROUTE);
  if (!route) throw new Error('public share route not registered');

  const req = {
    url: `/api/public/pov/${pov}/node/${nodeId}`, method: 'GET',
    headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: ip },
  } as unknown as IncomingMessage;

  const headers: Record<string, unknown> = {};
  const result: InvokeResult = { status: 200, body: undefined, headers };
  const res = {
    writableEnded: false, headersSent: false, req,
    setHeader(name: string, val: unknown) { headers[name.toLowerCase()] = val; },
    getHeader(name: string) { return headers[name.toLowerCase()]; },
    writeHead(s: number, hdrs?: Record<string, unknown>) {
      result.status = s;
      if (hdrs) for (const k of Object.keys(hdrs)) headers[k.toLowerCase()] = hdrs[k];
      this.headersSent = true; return this;
    },
    end(b?: string) { result.body = b ? JSON.parse(b) : undefined; this.writableEnded = true; },
  } as unknown as ServerResponse;

  await route.handler(req, res, undefined);
  return result;
}

describe('GET /api/public/pov/:pov/node/:nodeId (t/1788)', () => {
  beforeEach(() => {
    readTaxonomyFileMock.mockReset();
    recordMock.mockReset();
    // The t/1793 per-POV cache is module-level and persists across invoke()
    // calls (that persistence is the point) — clear it between cases so a
    // cached 'accelerationist' parse from one test can't serve the next.
    _resetPublicPovCache();
  });

  // ── (a) whitelist-only projection — the info-leak guard ──
  describe('projection is a positive 6-field allowlist (info-leak guard)', () => {
    // A node deliberately laden with sensitive/enrichment data that must NEVER
    // leak: full graph_attributes (aphorism + embeddings + scores), _edit_meta,
    // authorship, timestamps, and status.
    const loadedNode = {
      id: 'acc-beliefs-001',
      category: 'beliefs',
      label: 'AI accelerates prosperity',
      description: 'Rapid AI deployment raises living standards.',
      status: 'published',
      created_by: 'jpsnover',
      updated_by: 'reviewer-7',
      created_at: '2026-01-02T00:00:00Z',
      updated_at: '2026-03-04T00:00:00Z',
      _edit_meta: { revision: 42, editor: 'jpsnover', locked: true },
      graph_attributes: {
        aphorism: 'Faster is kinder.',
        embeddings: [0.11, 0.22, 0.33],
        crux_addressed_ratio: 0.87,
        rhetorical_strategy: 'appeal-to-progress',
        assumes: ['abundance'],
      },
    };

    beforeEach(() => { readTaxonomyFileMock.mockResolvedValue({ nodes: [loadedNode] }); });

    it('returns EXACTLY the 6 allowlisted keys and nothing else', async () => {
      const { status, body } = await invoke('accelerationist', 'acc-beliefs-001');
      expect(status).toBe(200);
      expect(Object.keys(body as object).sort()).toEqual(
        ['nodeId', 'pov', 'category', 'label', 'description', 'aphorism'].sort(),
      );
    });

    it('leaks none of _edit_meta / graph_attributes / embeddings / authorship / status / timestamps', async () => {
      const { body } = await invoke('accelerationist', 'acc-beliefs-001');
      for (const forbidden of [
        '_edit_meta', 'graph_attributes', 'embeddings', 'crux_addressed_ratio',
        'created_by', 'updated_by', 'created_at', 'updated_at', 'status', 'id',
      ]) {
        expect(body).not.toHaveProperty(forbidden);
      }
    });

    it('picks ONLY graph_attributes.aphorism (not the rest of graph_attributes)', async () => {
      const { body } = await invoke('accelerationist', 'acc-beliefs-001');
      const rec = body as PublicPovNode;
      expect(rec.aphorism).toBe('Faster is kinder.');
      // The projection carries the aphorism value but never the container.
      expect(JSON.stringify(body)).not.toContain('0.11'); // no embeddings vector
      expect(JSON.stringify(body)).not.toContain('crux_addressed_ratio');
    });

    it('projects the four scalar allowlist fields verbatim', async () => {
      const { body } = await invoke('accelerationist', 'acc-beliefs-001');
      expect(body).toEqual({
        nodeId: 'acc-beliefs-001',
        pov: 'accelerationist',
        category: 'beliefs',
        label: 'AI accelerates prosperity',
        description: 'Rapid AI deployment raises living standards.',
        aphorism: 'Faster is kinder.',
      });
    });

    it('emits aphorism: null when graph_attributes.aphorism is absent', async () => {
      readTaxonomyFileMock.mockResolvedValue({ nodes: [{ id: 'acc-beliefs-002', label: 'x', graph_attributes: { embeddings: [1] } }] });
      const { body } = await invoke('accelerationist', 'acc-beliefs-002');
      expect((body as PublicPovNode).aphorism).toBeNull();
      expect(body).not.toHaveProperty('graph_attributes');
    });
  });

  // ── (b) auth-bypass scope ──
  describe('auth-bypass scope (isPublicPath + route table)', () => {
    // t/1910: isPublicPath moved from server.ts to the import-safe publicPaths.ts, so
    // these assert the real predicate + registered prefix directly (stronger than the
    // former source-text scan). The /api/public/ auth exemption is the t/1788 invariant.
    it('the auth gate exempts the /api/public/ namespace', () => {
      expect(PUBLIC_PATH_PREFIXES).toContain('/api/public/');
      expect(computeIsPublicPath('/api/public/pov/acc-beliefs-001/node/acc-beliefs-001')).toBe(true);
    });

    it('the gated sibling /api/conflicts is NOT in the public exemption list', () => {
      expect(computeIsPublicPath('/api/conflicts')).toBe(false);
      expect(PUBLIC_PATH_PREFIXES).not.toContain('/api/conflicts');
    });

    it('predicate: /api/public/... is exempt, a gated path is not', () => {
      // Mirrors the clause anchored above (source-verified in the prior tests):
      // the auth gate exempts anything under /api/public/ and nothing else here.
      const publicByNamespace = (p: string): boolean => p.startsWith('/api/public/');
      expect(publicByNamespace('/api/public/pov/acc-beliefs-001/node/acc-beliefs-001')).toBe(true);
      expect(publicByNamespace('/api/conflicts')).toBe(false);
    });

    it('the routes under /api/public/ are exactly the POV-node + op-ed share + op-ed index + inquiry share GETs', () => {
      // t/2727 added the op-ed share (2nd tenant); t/3481 added the op-ed index
      // (GET /api/public/opeds, TL-approved public read); t/3626/t/3653 added the inquiry
      // share (anon GET, Server-Auth-reviewed); t/4925 wired the t/4787 chat share (anon GET,
      // SO-reviewed). Keeping this an EXACT list (order-independent)
      // means any future /api/public/ route must be a deliberate, reviewed addition — the
      // allowlist can't grow silently.
      const publicRoutes = extractRoutes(serverEntry)
        .filter(r => r.path.startsWith('/api/public/'))
        .map(r => `${r.method} ${r.path}`)
        .sort();
      expect(publicRoutes).toEqual(
        ['GET /api/public/oped/:shareId', 'GET /api/public/opeds', 'GET /api/public/pov/:pov/node/:nodeId', 'GET /api/public/inquiry/:shareId', 'GET /api/public/chat/:shareId'].sort(),
      );
    });
  });

  // ── (c) no session minted ──
  it('sets NO Set-Cookie header for a logged-out request', async () => {
    readTaxonomyFileMock.mockResolvedValue({ nodes: [{ id: 'acc-beliefs-001', label: 'x' }] });
    const { headers } = await invoke('accelerationist', 'acc-beliefs-001');
    expect(headers['set-cookie']).toBeUndefined();
  });

  // ── rate limit (429 + Retry-After) ──
  it('rate-limits after 30 requests in the window (429 + Retry-After)', async () => {
    readTaxonomyFileMock.mockResolvedValue({ nodes: [{ id: 'acc-beliefs-001', label: 'x' }] });
    const ip = '9.9.9.9';
    for (let i = 0; i < 30; i++) {
      const { status } = await invoke('accelerationist', 'acc-beliefs-001', ip);
      expect(status).toBe(200);
    }
    const blocked = await invoke('accelerationist', 'acc-beliefs-001', ip);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ error: 'rate_limited' });
    expect((blocked.body as { retryAfter: number }).retryAfter).toBeGreaterThan(0);
    expect(blocked.headers['retry-after']).toBe(String((blocked.body as { retryAfter: number }).retryAfter));
  });

  // ── 404 ──
  it('returns 404 for a node id absent from the POV file', async () => {
    readTaxonomyFileMock.mockResolvedValue({ nodes: [{ id: 'acc-beliefs-001', label: 'x' }] });
    const { status, body } = await invoke('accelerationist', 'acc-beliefs-999');
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: 'not_found' });
  });

  // ── 400 (bad :pov / traversal guard) ──
  it('returns 400 for an invalid :pov (uppercase fails isSafePov)', async () => {
    const { status } = await invoke('ACC', 'acc-beliefs-001');
    expect(status).toBe(400);
    expect(readTaxonomyFileMock).not.toHaveBeenCalled(); // rejected before the read
  });

  it('returns 400 for an encoded path-traversal :pov (%2e%2e)', async () => {
    const { status } = await invoke('%2e%2e', 'acc-beliefs-001');
    expect(status).toBe(400);
    expect(readTaxonomyFileMock).not.toHaveBeenCalled();
  });

  // ── (d) short-TTL per-POV cache — the DoS-amplification bound (t/1793) ──
  describe('per-POV TTL cache bounds the unauthenticated parse DoS', () => {
    it('reads+parses the POV file ONCE across a burst of rapid requests for the same pov', async () => {
      readTaxonomyFileMock.mockResolvedValue({ nodes: [{ id: 'acc-beliefs-001', label: 'x' }] });
      // 50 rapid hits, distinct forged IPs (rate limit can't save us — the key
      // is XFF-forgeable), all for the same pov. Cache must collapse them to 1
      // read+parse — this is the amplification bound Server-Auth described.
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) => invoke('accelerationist', 'acc-beliefs-001', `10.0.0.${i}`)),
      );
      for (const { status } of results) expect(status).toBe(200);
      expect(readTaxonomyFileMock).toHaveBeenCalledTimes(1);
    });

    it('a cache hit re-projects from cached data (still returns the node, no re-read)', async () => {
      readTaxonomyFileMock.mockResolvedValue({
        nodes: [
          { id: 'acc-beliefs-001', label: 'first', graph_attributes: { aphorism: 'A.' } },
          { id: 'acc-beliefs-002', label: 'second' },
        ],
      });
      const first = await invoke('accelerationist', 'acc-beliefs-001');
      // Different nodeId, SAME pov → served from the cached parse, and the
      // per-request find still resolves the distinct node.
      const second = await invoke('accelerationist', 'acc-beliefs-002');
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect((second.body as PublicPovNode).label).toBe('second');
      expect(readTaxonomyFileMock).toHaveBeenCalledTimes(1);
    });

    it('distinct POVs are cached independently (one read each — behavior unchanged)', async () => {
      readTaxonomyFileMock.mockImplementation((pov: string) =>
        Promise.resolve({ nodes: [{ id: 'acc-beliefs-001', label: pov }] }));
      await invoke('accelerationist', 'acc-beliefs-001');
      await invoke('safetyist', 'acc-beliefs-001');
      await invoke('accelerationist', 'acc-beliefs-001'); // repeat → hit, no new read
      expect(readTaxonomyFileMock).toHaveBeenCalledTimes(2); // one per distinct pov
    });

    it('does NOT cache a failed read — the next request retries (no poisoned TTL window)', async () => {
      readTaxonomyFileMock.mockRejectedValueOnce(new Error('transient blob error'));
      const failed = await invoke('accelerationist', 'acc-beliefs-001');
      expect(failed.status).toBe(500);
      // Second attempt must re-read (the miss was not cached), then succeed.
      readTaxonomyFileMock.mockResolvedValue({ nodes: [{ id: 'acc-beliefs-001', label: 'x' }] });
      const ok = await invoke('accelerationist', 'acc-beliefs-001');
      expect(ok.status).toBe(200);
      expect(readTaxonomyFileMock).toHaveBeenCalledTimes(2);
    });

    it('stays bounded under many distinct forged-but-valid pov keys (no unbounded growth)', async () => {
      // SAFE_POV_RE (/^[a-z_-]+$/) admits an unbounded key space. Hammer 200
      // distinct valid povs; the cap+purge must keep the map bounded. We assert
      // the observable proxy: re-hitting a pov evicted by the cap re-reads,
      // while the most-recent pov is still a hit — i.e. the map did not retain
      // all 200 entries.
      readTaxonomyFileMock.mockResolvedValue({ nodes: [{ id: 'acc-beliefs-001', label: 'x' }] });
      const key = (i: number) => `pov${String.fromCharCode(97 + (i % 26))}${'a'.repeat(Math.floor(i / 26) + 1)}`;
      for (let i = 0; i < 200; i++) await invoke(key(i), 'acc-beliefs-001', `172.16.0.${i % 256}`);
      const readsAfterFill = readTaxonomyFileMock.mock.calls.length;
      // The earliest key was evicted long ago → re-hitting it re-reads.
      await invoke(key(0), 'acc-beliefs-001');
      expect(readTaxonomyFileMock.mock.calls.length).toBe(readsAfterFill + 1);
      // The most-recent key is still cached → re-hitting it does NOT re-read.
      await invoke(key(199), 'acc-beliefs-001');
      expect(readTaxonomyFileMock.mock.calls.length).toBe(readsAfterFill + 1);
    });
  });

  // ── error path (ADR-003 flight recorder) ──
  it('records to the flight recorder and returns 500 when the read throws', async () => {
    readTaxonomyFileMock.mockRejectedValue(new Error('blob unreachable'));
    const { status } = await invoke('accelerationist', 'acc-beliefs-001');
    expect(status).toBe(500);
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ level: 'error', type: 'system.error' }));
  });
});
