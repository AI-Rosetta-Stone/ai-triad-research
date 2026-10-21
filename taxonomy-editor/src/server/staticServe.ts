// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3084: extracted from server.ts so serveStatic can be unit-tested without
// importing the full server module (which triggers listeners, storage, etc).

import fs from 'fs';
import path from 'path';
import http from 'http';
import { log } from './logger.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  staticDir: string,
): boolean {
  const url = new URL(req.url!, 'http://localhost');

  // t/854: never serve source maps in production — *.js.map lets anyone recover
  // the full client source (API shapes, auth flows, internal logic). 404 them.
  if (process.env.NODE_ENV === 'production' && url.pathname.endsWith('.map')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return true;
  }

  let filePath = path.join(staticDir, url.pathname === '/' ? 'index.html' : url.pathname);

  // Security: prevent directory traversal
  if (!filePath.startsWith(staticDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return true;
  }

  if (!fs.existsSync(filePath)) {
    // SPA fallback: serve index.html for non-API routes.
    // t/3114: /readyz is excluded so an UNREGISTERED /readyz (a routing regression, or an
    // image predating the route) returns a clean 404 instead of a 200 index.html page — the
    // deploy warm-gate treats a non-{status:ready} 200 as not-warm anyway (block), but a real
    // 404 is unambiguous and keeps the gate's health signal honest.
    // t/4406: /.auth/* belongs to the Easy Auth sidecar. One that reaches the app means the
    // sidecar didn't handle it; serving index.html as a 200 hid that (curl /.auth/me looked
    // like a working page). 404 it and WARN. /.auth/anonymous is the app's own route,
    // handled in server.ts before static serving.
    if (url.pathname.startsWith('/.auth/')) {
      log.server.warn({ component: 'static', path: url.pathname }, '/.auth/* path reached the app (not handled by Easy Auth) — 404');
      return false;
    }
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/ws/')
        && !url.pathname.startsWith('/health') && !url.pathname.startsWith('/readyz')) {
      filePath = path.join(staticDir, 'index.html');
    } else {
      return false;
    }
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const content = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': String(content.length) });
  // HEAD: send headers only — no body (RFC 9110 §9.3.2)
  res.end(req.method === 'HEAD' ? undefined : content);
  return true;
}
