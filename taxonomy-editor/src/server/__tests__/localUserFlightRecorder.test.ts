// @vitest-environment node

/**
 * t/1111 — regression test: _local (Electron) users can access all flight
 * recorder endpoints. Root cause of t/1064: requireAdmin blocks _local because
 * isAdmin('_local') is always false. Verifies no flight-recorder route is
 * admin-gated and that the local-mode merge path includes server events.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isAdmin } from '../community/community.js';
import { isAnonAllowedRoute } from '../security/accessControl.js';
import { readMergedDump, writeDump } from '../flightRecorderDumps.js';

describe('_local user flight recorder access (t/1111)', () => {
  it('isAdmin returns false for _local — the root cause of t/1064', () => {
    expect(isAdmin('_local')).toBe(false);
  });

  describe('flight recorder routes are reachable without admin', () => {
    it('GET /api/flight-recorder/list is allowed for anonymous (and therefore _local)', () => {
      expect(isAnonAllowedRoute('GET', '/api/flight-recorder/list')).toBe(true);
    });

    it('GET /api/flight-recorder/download-merged/:dumpId is allowed for anonymous', () => {
      expect(isAnonAllowedRoute('GET', '/api/flight-recorder/download-merged/abc-123')).toBe(true);
    });

    it('POST /api/flight-recorder/dump is in the safe POST allowlist', () => {
      expect(isAnonAllowedRoute('POST', '/api/flight-recorder/dump')).toBe(true);
    });

    it('POST /api/flight-recorder/server-dump is in the safe POST allowlist', () => {
      expect(isAnonAllowedRoute('POST', '/api/flight-recorder/server-dump')).toBe(true);
    });

    it('POST /api/admin/flight-recorder/dump is correctly admin-only (not in safe list)', () => {
      expect(isAnonAllowedRoute('POST', '/api/admin/flight-recorder/dump')).toBe(false);
    });
  });

  describe('local-mode merged dump includes server events (t/1064)', () => {
    let root: string;
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-local-')); process.env.AI_TRIAD_STATE_ROOT = root; });
    afterEach(() => { delete process.env.AI_TRIAD_STATE_ROOT; fs.rmSync(root, { recursive: true, force: true }); });

    function ndjson(...records: Record<string, unknown>[]): string {
      return records.map(r => JSON.stringify(r)).join('\n') + '\n';
    }

    it('readMergedDump with includeServer:true returns both client and server events', async () => {
      await writeDump(root, 'client', 'local-test', ndjson(
        { _type: 'header', capacity: 100 },
        { _type: 'event', _wall: '2026-01-01T00:00:01Z', type: 'click' },
      ));
      await writeDump(root, 'server', 'local-test', ndjson(
        { _type: 'header', capacity: 200 },
        { _type: 'event', _wall: '2026-01-01T00:00:02Z', type: 'api.call' },
      ));

      const merged = await readMergedDump(root, 'local-test', { includeServer: true });
      expect(merged).not.toBeNull();
      const lines = merged!.trim().split('\n').map(l => JSON.parse(l));
      expect(lines[0].sources).toEqual(['client', 'server']);
      expect(lines[0].total_events).toBe(2);
    });

    it('readMergedDump with includeServer:false withholds server events (non-admin web path)', async () => {
      await writeDump(root, 'client', 'web-test', ndjson(
        { _type: 'header', capacity: 100 },
        { _type: 'event', _wall: '2026-01-01T00:00:01Z', type: 'click' },
      ));
      await writeDump(root, 'server', 'web-test', ndjson(
        { _type: 'header', capacity: 200 },
        { _type: 'event', _wall: '2026-01-01T00:00:02Z', type: 'api.call' },
      ));

      const merged = await readMergedDump(root, 'web-test', { includeServer: false });
      expect(merged).not.toBeNull();
      const lines = merged!.trim().split('\n').map(l => JSON.parse(l));
      expect(lines[0].sources).toEqual(['client']);
      expect(lines[0].total_events).toBe(1);
    });
  });
});
