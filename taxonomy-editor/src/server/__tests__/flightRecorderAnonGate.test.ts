// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/579 (incident containment): anonymous callers must not list, download or view flight-recorder
// files, nor create a server dump. The server dumps hold every user's server events and the drained
// server log lines, and prod served them to anonymous visitors. server.ts gives this gate and the
// router the same normalised pathname, and the router matches segments exactly and case-sensitively,
// so the literal paths below are the ones that could be served.

import { describe, it, expect } from 'vitest';
import { isAnonAllowedRoute } from '../security/accessControl.js';

describe('t/579: flight-recorder routes for anonymous callers', () => {
  const refusedGets = [
    '/api/flight-recorder/list',
    '/api/flight-recorder/list/',
    '/api/flight-recorder/download/server-flight-recorder-2026-08-28T01-59-20.538Z.jsonl',
    '/api/flight-recorder/download/flight-recorder-2026-11-25T00-00-00.000Z.jsonl',
    '/api/flight-recorder/download/flight-recorder-%2F..%2F..%2Fx.jsonl',
    '/api/flight-recorder/view/server-flight-recorder-2026-08-28T01-59-20.538Z.jsonl',
    '/api/flight-recorder/view/flight-recorder-x.jsonl',
    '/API/Flight-Recorder/LIST',
  ];
  for (const p of refusedGets) {
    it(`refuses anonymous GET ${p}`, () => {
      expect(isAnonAllowedRoute('GET', p)).toBe(false);
    });
  }

  it('refuses anonymous POST /api/flight-recorder/server-dump (it drains the server logs into a file)', () => {
    expect(isAnonAllowedRoute('POST', '/api/flight-recorder/server-dump')).toBe(false);
  });

  it('still allows the anonymous client-dump upload and the merged download (server side omitted for anonymous)', () => {
    expect(isAnonAllowedRoute('POST', '/api/flight-recorder/dump')).toBe(true);
    expect(isAnonAllowedRoute('GET', '/api/flight-recorder/download-merged/0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11')).toBe(true);
  });

  it('leaves unrelated anonymous GETs alone', () => {
    expect(isAnonAllowedRoute('GET', '/api/config')).toBe(true);
  });
});
