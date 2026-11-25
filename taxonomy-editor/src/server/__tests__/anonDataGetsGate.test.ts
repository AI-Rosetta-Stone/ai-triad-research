// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/579 (incident, second containment): anonymous callers must not read admin health, site-wide
// analytics or calibration data. On prod these returned recent feedback keyed by an email address,
// a list of 55 user identifiers with activity, and cross-user calibration metrics. server.ts gives
// this gate and the router the same normalised pathname; the router matches segments exactly.

import { describe, it, expect } from 'vitest';
import { isAnonAllowedRoute } from '../security/accessControl.js';

describe('t/579: admin health, analytics and calibration GETs for anonymous callers', () => {
  const refused = [
    '/api/admin/health',
    '/api/admin/health/',
    '/api/analytics/query',
    '/api/analytics/engagement',
    '/api/calibration/log',
    '/api/calibration/history',
    '/API/Analytics/Query',
  ];
  for (const p of refused) {
    it(`refuses anonymous GET ${p}`, () => {
      expect(isAnonAllowedRoute('GET', p)).toBe(false);
    });
  }

  it('still allows the anonymous analytics event POST the SPA sends', () => {
    expect(isAnonAllowedRoute('POST', '/api/analytics/event')).toBe(true);
  });

  it('leaves unrelated anonymous GETs alone', () => {
    expect(isAnonAllowedRoute('GET', '/api/config')).toBe(true);
    expect(isAnonAllowedRoute('GET', '/api/analytics/queryx')).toBe(true);
  });
});
