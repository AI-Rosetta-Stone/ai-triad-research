// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4962 (PI decision p/548#385): a browser-scoped "internal tester" flag so analytics
// can exclude team traffic. The cookie only tags the caller's own browser; the analytics
// event handler reads it and stamps `internal: true` server-side.

import type { IncomingMessage } from 'http';
import { parseCookies } from '../httpCookies.js';

export const INTERNAL_TESTER_COOKIE = 'aitriad_internal';
const ONE_YEAR_SECONDS = 31536000;

// Same convention as anonSessionCreated.ts: Secure wherever the app is served over HTTPS
// (production, or any deployment with ALLOWED_ORIGINS), so local http dev still works.
function secureSuffix(): string {
  return process.env.NODE_ENV === 'production' || process.env.ALLOWED_ORIGINS ? '; Secure' : '';
}

/** Set-Cookie value that turns the flag on (1 year) or clears it. */
export function internalTesterCookie(on: boolean): string {
  const value = on ? '1' : '';
  const maxAge = on ? ONE_YEAR_SECONDS : 0;
  return `${INTERNAL_TESTER_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureSuffix()}`;
}

export function isInternalTester(req: IncomingMessage): boolean {
  return parseCookies(req).get(INTERNAL_TESTER_COOKIE) === '1';
}

/** Minimal static confirmation page; no user input is reflected into it. */
export function internalTesterPage(on: boolean): string {
  const message = on
    ? 'This browser is now marked as an internal tester. Its analytics events will be excluded from analysis.'
    : 'This browser is no longer marked as an internal tester.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Internal tester</title></head><body><p>${message}</p></body></html>`;
}
