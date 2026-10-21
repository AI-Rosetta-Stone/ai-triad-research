// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3084 — HEAD /assets/* must return 200 + correct headers, no body.
// Root cause: serveStatic was only called for GET; HEAD fell to the catch-all 404.
// Fix: extend call-site condition to GET||HEAD; serveStatic suppresses body for HEAD.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'http';
import path from 'path';

const { mockExistsSync, mockReadFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(() => true),
  mockReadFileSync: vi.fn(() => Buffer.from('.body { color: red; }')),
}));

vi.mock('fs', async (importActual) => {
  const actual = await importActual<typeof import('fs')>();
  return {
    ...actual,
    default: { ...actual, existsSync: mockExistsSync, readFileSync: mockReadFileSync },
  };
});

import { serveStatic } from '../staticServe.js';

function makeReq(method: string, url: string): http.IncomingMessage {
  return { method, url, headers: {} } as unknown as http.IncomingMessage;
}

function makeRes() {
  const headers: Record<string, string> = {};
  let statusCode = 0;
  const chunks: Buffer[] = [];
  return {
    writeHead: vi.fn((code: number, hdrs?: Record<string, string>) => {
      statusCode = code;
      Object.assign(headers, hdrs ?? {});
    }),
    end: vi.fn((body?: unknown) => { if (body instanceof Buffer) chunks.push(body); }),
    get statusCode() { return statusCode; },
    get headers() { return headers; },
    get body() { return Buffer.concat(chunks); },
  };
}

describe('serveStatic HEAD support (t/3084)', () => {
  // path.resolve normalises separators so the traversal check (startsWith) works on Windows
  const staticDir = path.resolve('/fake/static');

  beforeEach(() => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(Buffer.from('.body { color: red; }'));
  });

  it('GET /assets/style.css → 200, Content-Type text/css, body present', () => {
    const req = makeReq('GET', '/assets/style.css');
    const res = makeRes();
    const handled = serveStatic(req, res as unknown as http.ServerResponse, staticDir);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/css');
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('HEAD /assets/style.css → 200, same Content-Type, no body', () => {
    const req = makeReq('HEAD', '/assets/style.css');
    const res = makeRes();
    const handled = serveStatic(req, res as unknown as http.ServerResponse, staticDir);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/css');
    // HEAD must carry Content-Length (clients use it for cache validation)
    expect(res.headers['Content-Length']).toBeDefined();
    // No body bytes for HEAD
    expect(res.body.length).toBe(0);
  });

  it('HEAD and GET produce identical status + Content-Type (t/3084: same headers)', () => {
    mockReadFileSync.mockReturnValue(Buffer.from('console.log("hi")'));
    const get = makeRes();
    const head = makeRes();
    serveStatic(makeReq('GET', '/assets/index.js'), get as unknown as http.ServerResponse, staticDir);
    serveStatic(makeReq('HEAD', '/assets/index.js'), head as unknown as http.ServerResponse, staticDir);
    expect(head.statusCode).toBe(get.statusCode);
    expect(head.headers['Content-Type']).toBe(get.headers['Content-Type']);
    expect(head.headers['Content-Length']).toBe(get.headers['Content-Length']);
  });
});

// t/3114 — /readyz is excluded from the SPA fallback, so an UNREGISTERED /readyz returns a
// clean 404 (serveStatic returns false → caller writes 404) instead of a 200 index.html page.
describe('serveStatic /readyz SPA-fallback exclusion (t/3114)', () => {
  const staticDir = path.resolve('/fake/static');

  it('unregistered /readyz (file absent) → returns false (404 path), NOT index.html', () => {
    mockExistsSync.mockReturnValue(false); // no /readyz file on disk
    const res = makeRes();
    const handled = serveStatic(makeReq('GET', '/readyz'), res as unknown as http.ServerResponse, staticDir);
    expect(handled).toBe(false);          // falls through → server.ts 404s
    expect(res.statusCode).toBe(0);       // serveStatic wrote nothing (no index.html 200)
    expect(res.body.length).toBe(0);
  });

  it('contrast: a normal absent SPA route DOES fall back to index.html (200)', () => {
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue(Buffer.from('<!doctype html>'));
    const res = makeRes();
    const handled = serveStatic(makeReq('GET', '/some/spa/route'), res as unknown as http.ServerResponse, staticDir);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);     // index.html served — proves the exclusion is /readyz-specific
  });
});

// t/4406 — a /.auth/* path reaching the app means Easy Auth didn't handle it. Serving
// index.html as a 200 hid that (`curl /.auth/me` looked like a working page). Now 404 + WARN.
describe('serveStatic /.auth/* SPA-fallback exclusion (t/4406)', () => {
  const staticDir = path.resolve('/fake/static');

  it.each(['/.auth/me', '/.auth/login/github', '/.auth/logout'])('%s → returns false (404 path), NOT index.html', (p) => {
    mockExistsSync.mockReturnValue(false);
    const res = makeRes();
    const handled = serveStatic(makeReq('GET', p), res as unknown as http.ServerResponse, staticDir);
    expect(handled).toBe(false);
    expect(res.statusCode).toBe(0);
  });
});
