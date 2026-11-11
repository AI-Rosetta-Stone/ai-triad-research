// @vitest-environment node

/**
 * t/908 — paired flight-recorder dump storage + retention.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  isValidDumpId, selectExpiredDumps, writeDump, dumpsDir, mergeDumps, readMergedDump, type DumpFileInfo,
} from '../flightRecorderDumps.js';
import { setGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import type { FlightRecorder, RecordInput } from '../../../../lib/flight-recorder/flightRecorder.js';
import { writeFramedNdjson, LOG_MAX_LINE_BYTES } from '../logger.js';

describe('isValidDumpId (t/908)', () => {
  it('accepts UUID-safe ids, rejects traversal/empty/oversized', () => {
    expect(isValidDumpId('3f9a-aaaa-bbbb')).toBe(true);
    expect(isValidDumpId('a'.repeat(128))).toBe(true);
    expect(isValidDumpId('../etc/passwd')).toBe(false);
    expect(isValidDumpId('a/b')).toBe(false);
    expect(isValidDumpId('')).toBe(false);
    expect(isValidDumpId('a'.repeat(129))).toBe(false);
    expect(isValidDumpId(42)).toBe(false);
  });
});

function f(dumpId: string, kind: 'client' | 'server', mtime: number, size = 10): DumpFileInfo {
  return { name: `${kind}-${dumpId}.jsonl`, dumpId, mtime, size };
}

describe('selectExpiredDumps (t/908 AC#7)', () => {
  it('keeps everything when under both caps', () => {
    expect(selectExpiredDumps([f('a', 'client', 2), f('a', 'server', 2), f('b', 'client', 1)])).toEqual([]);
  });

  it('drops oldest dumpId pairs beyond the group cap — whole pairs together', () => {
    const files: DumpFileInfo[] = [];
    for (let i = 0; i < 22; i++) { files.push(f(`d${i}`, 'client', i), f(`d${i}`, 'server', i)); }
    const del = selectExpiredDumps(files, 20);
    // The 2 oldest groups (d0, d1) → both halves of each deleted.
    expect(del.sort()).toEqual(['client-d0.jsonl', 'client-d1.jsonl', 'server-d0.jsonl', 'server-d1.jsonl'].sort());
  });

  it('enforces the byte cap by dropping oldest survivors', () => {
    const files = [f('new', 'server', 3, 40), f('mid', 'server', 2, 40), f('old', 'server', 1, 40)];
    const del = selectExpiredDumps(files, 20, 100); // total 120 > 100 → drop oldest (old)
    expect(del).toEqual(['server-old.jsonl']);
  });
});

describe('writeDump (t/908)', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'frdump-')); process.env.AI_TRIAD_STATE_ROOT = root; });
  afterEach(() => { delete process.env.AI_TRIAD_STATE_ROOT; fs.rmSync(root, { recursive: true, force: true }); });

  it('writes a paired client + server dump joinable by dumpId', async () => {
    await writeDump(root, 'client', 'abc', '{"seq":1}\n');
    await writeDump(root, 'server', 'abc', '{"seq":2}\n');
    const dir = dumpsDir(root);
    expect(fs.existsSync(path.join(dir, 'client-abc.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'server-abc.jsonl'))).toBe(true);
  });

  it('records each written dump in the sidecar retention index (t/1350)', async () => {
    await writeDump(root, 'client', 'abc', '{"seq":1}\n');
    await writeDump(root, 'server', 'abc', '{"seq":22}\n');
    const index = JSON.parse(fs.readFileSync(path.join(dumpsDir(root), 'dumps-index.json'), 'utf-8'));
    expect(index.abc).toBeDefined();
    expect(index.abc.client).toBe(Buffer.byteLength('{"seq":1}\n'));
    expect(index.abc.server).toBe(Buffer.byteLength('{"seq":22}\n'));
    expect(typeof index.abc.ts).toBe('number');
  });

  it('emits a debug flight-recorder.dump.written FR event with backend + size (t/1352)', async () => {
    const records: RecordInput[] = [];
    setGlobalRecorder({ record: (e: RecordInput) => records.push(e) } as unknown as FlightRecorder);
    try {
      await writeDump(root, 'client', 'evt-id', '{"seq":1}\n');
    } finally {
      setGlobalRecorder(null as unknown as FlightRecorder);
    }
    const evt = records.find(r => r.type === 'flight-recorder.dump.written');
    expect(evt).toBeDefined();
    expect(evt!.level).toBe('debug');
    const data = evt!.data as Record<string, unknown>;
    expect(data.storageBackend).toBe('local-fs'); // FilesystemBackend in tests
    expect(data.dumpId).toBe('evt-id');
    expect(data.sizeBytes).toBe(Buffer.byteLength('{"seq":1}\n'));
    expect(typeof data.path).toBe('string');
  });
});

// ── Merge logic (t/939) ─────────────────────────────────────────────

function ndjson(...records: Record<string, unknown>[]): string {
  return records.map(r => JSON.stringify(r)).join('\n') + '\n';
}

describe('mergeDumps (t/939)', () => {
  it('interleaves events by _wall timestamp and tags with _source/_merged_seq', () => {
    const client = ndjson(
      { _type: 'header', timestamp: '2026-01-01T00:00:00Z', capacity: 100, retained: 2, lost: 0 },
      { _type: 'event', _wall: '2026-01-01T00:00:01Z', type: 'click' },
      { _type: 'event', _wall: '2026-01-01T00:00:03Z', type: 'nav' },
    );
    const server = ndjson(
      { _type: 'header', timestamp: '2026-01-01T00:00:00Z', capacity: 200, retained: 1, lost: 0 },
      { _type: 'event', _wall: '2026-01-01T00:00:02Z', type: 'api.call' },
    );
    const merged = mergeDumps(client, server);
    const lines = merged.trim().split('\n').map(l => JSON.parse(l));

    const header = lines[0];
    expect(header._type).toBe('header');
    expect(header.merged).toBe(true);
    expect(header.total_events).toBe(3);
    expect(header.sources).toEqual(['client', 'server']);

    const events = lines.filter(l => l._source && l._type !== 'trigger');
    expect(events).toHaveLength(3);
    expect(events[0]._wall).toBe('2026-01-01T00:00:01Z');
    expect(events[0]._source).toBe('client');
    expect(events[0]._merged_seq).toBe(0);
    expect(events[1]._wall).toBe('2026-01-01T00:00:02Z');
    expect(events[1]._source).toBe('server');
    expect(events[1]._merged_seq).toBe(1);
    expect(events[2]._wall).toBe('2026-01-01T00:00:03Z');
    expect(events[2]._source).toBe('client');
    expect(events[2]._merged_seq).toBe(2);
  });

  it('deduplicates dictionary entries by category:value', () => {
    const client = ndjson(
      { _type: 'header' },
      { _type: 'dictionary', handle: 0, category: 'component', value: 'Toolbar' },
      { _type: 'dictionary', handle: 1, category: 'component', value: 'Sidebar' },
    );
    const server = ndjson(
      { _type: 'header' },
      { _type: 'dictionary', handle: 0, category: 'component', value: 'Toolbar' },
      { _type: 'dictionary', handle: 1, category: 'route', value: '/api/health' },
    );
    const merged = mergeDumps(client, server);
    const lines = merged.trim().split('\n').map(l => JSON.parse(l));
    const dicts = lines.filter(l => l._type === 'dictionary');
    expect(dicts).toHaveLength(3);
    expect(dicts.map(d => `${d.category}:${d.value}`)).toEqual([
      'component:Toolbar', 'component:Sidebar', 'route:/api/health',
    ]);
  });

  it('unions context fields and tracks provenance', () => {
    const client = ndjson(
      { _type: 'header' },
      { _type: 'context', userId: 'alice', theme: 'dark' },
    );
    const server = ndjson(
      { _type: 'header' },
      { _type: 'context', nodeVersion: '22', uptime: 3600 },
    );
    const merged = mergeDumps(client, server);
    const lines = merged.trim().split('\n').map(l => JSON.parse(l));
    const ctx = lines.find(l => l._type === 'context');
    expect(ctx.userId).toBe('alice');
    expect(ctx.theme).toBe('dark');
    expect(ctx.nodeVersion).toBe('22');
    expect(ctx._client_fields).toEqual(['userId', 'theme']);
    expect(ctx._server_fields).toEqual(['nodeVersion', 'uptime']);
  });

  it('handles client-only merge (no server dump)', () => {
    const client = ndjson(
      { _type: 'header', timestamp: '2026-01-01T00:00:00Z' },
      { _type: 'event', _wall: '2026-01-01T00:00:01Z', type: 'click' },
    );
    const merged = mergeDumps(client, null);
    const lines = merged.trim().split('\n').map(l => JSON.parse(l));
    const header = lines[0];
    expect(header.merged).toBe(true);
    expect(header.sources).toEqual(['client']);
    expect(header.total_events).toBe(1);
  });

  it('t/3081: client-only merge stamps server_source with omission reason', () => {
    const client = ndjson({ _type: 'header' }, { _type: 'event', _wall: '2026-01-01T00:00:01Z', type: 'click' });
    const merged = mergeDumps(client, null, 'anonymous-session');
    const header = JSON.parse(merged.trim().split('\n')[0]);
    expect(header.server_source).toEqual({ attempted: false, reason: 'anonymous-session' });
  });

  it('t/3081: client+server merge stamps server_source attempted:true', () => {
    const client = ndjson({ _type: 'header' }, { _type: 'event', _wall: '2026-01-01T00:00:01Z', type: 'click' });
    const server = ndjson({ _type: 'header' }, { _type: 'event', _wall: '2026-01-01T00:00:02Z', type: 'api' });
    const merged = mergeDumps(client, server);
    const header = JSON.parse(merged.trim().split('\n')[0]);
    expect(header.server_source).toEqual({ attempted: true, events_contributed: 1 });
  });

  // t/3724: a merge that attempted the server source and got zero events back must not read
  // identically to a genuinely quiet server — both the header and a WARN must say so.
  it('t/3724: events_contributed reflects the actual server event count', () => {
    const client = ndjson({ _type: 'header' }, { _type: 'event', _wall: '2026-01-01T00:00:01Z', type: 'click' });
    const server = ndjson(
      { _type: 'header' },
      { _type: 'event', _wall: '2026-01-01T00:00:02Z', type: 'api' },
      { _type: 'event', _wall: '2026-01-01T00:00:03Z', type: 'api' },
    );
    const merged = mergeDumps(client, server);
    const header = JSON.parse(merged.trim().split('\n')[0]);
    expect(header.server_source).toEqual({ attempted: true, events_contributed: 2 });
  });

  it('t/3724: server attempted with zero events → events_contributed:0 in header, WARN emitted', () => {
    const records: RecordInput[] = [];
    setGlobalRecorder({ record: (e: RecordInput) => records.push(e) } as unknown as FlightRecorder);
    try {
      const client = ndjson({ _type: 'header' }, { _type: 'event', _wall: '2026-01-01T00:00:01Z', type: 'click' });
      const server = ndjson({ _type: 'header' }); // header only — zero events
      const merged = mergeDumps(client, server);
      const header = JSON.parse(merged.trim().split('\n')[0]);
      expect(header.server_source).toEqual({ attempted: true, events_contributed: 0 });

      const warn = records.find(r => r.type === 'system.error' && r.component === 'flight-recorder-dumps'
        && typeof r.message === 'string' && r.message.includes('zero events'));
      expect(warn).toBeDefined();
      expect(warn!.level).toBe('warn');
      expect(warn!.data).toEqual({ serverEventCount: 0, clientEventCount: 1 });
    } finally {
      setGlobalRecorder(null as unknown as FlightRecorder);
    }
  });

  it('t/3724: no WARN when the server dump was never attempted (client-only merge)', () => {
    const records: RecordInput[] = [];
    setGlobalRecorder({ record: (e: RecordInput) => records.push(e) } as unknown as FlightRecorder);
    try {
      const client = ndjson({ _type: 'header' }, { _type: 'event', _wall: '2026-01-01T00:00:01Z', type: 'click' });
      mergeDumps(client, null);
      const warn = records.find(r => typeof r.message === 'string' && r.message.includes('zero events'));
      expect(warn).toBeUndefined();
    } finally {
      setGlobalRecorder(null as unknown as FlightRecorder);
    }
  });

  it('t/3724: no WARN when the server contributed at least one event', () => {
    const records: RecordInput[] = [];
    setGlobalRecorder({ record: (e: RecordInput) => records.push(e) } as unknown as FlightRecorder);
    try {
      const client = ndjson({ _type: 'header' }, { _type: 'event', _wall: '2026-01-01T00:00:01Z', type: 'click' });
      const server = ndjson({ _type: 'header' }, { _type: 'event', _wall: '2026-01-01T00:00:02Z', type: 'api' });
      mergeDumps(client, server);
      const warn = records.find(r => typeof r.message === 'string' && r.message.includes('zero events'));
      expect(warn).toBeUndefined();
    } finally {
      setGlobalRecorder(null as unknown as FlightRecorder);
    }
  });

  it('t/3081: no serverOmissionReason → reason defaults to "unknown"', () => {
    const client = ndjson({ _type: 'header' }, { _type: 'event', _wall: '2026-01-01T00:00:01Z', type: 'click' });
    const merged = mergeDumps(client, null); // no reason provided
    const header = JSON.parse(merged.trim().split('\n')[0]);
    expect(header.server_source).toEqual({ attempted: false, reason: 'unknown' });
  });

  it('tags triggers with _source from each side', () => {
    const client = ndjson(
      { _type: 'header' },
      { _type: 'trigger', action: 'user-clicked-dump' },
    );
    const server = ndjson(
      { _type: 'header' },
      { _type: 'trigger', action: 'admin-requested' },
    );
    const merged = mergeDumps(client, server);
    const lines = merged.trim().split('\n').map(l => JSON.parse(l));
    const triggers = lines.filter(l => l._type === 'trigger');
    expect(triggers).toHaveLength(2);
    expect(triggers[0]._source).toBe('client');
    expect(triggers[1]._source).toBe('server');
  });
});

describe('readMergedDump (t/939)', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'frdump-merge-')); process.env.AI_TRIAD_STATE_ROOT = root; });
  afterEach(() => { delete process.env.AI_TRIAD_STATE_ROOT; fs.rmSync(root, { recursive: true, force: true }); });

  it('merges paired files from disk', async () => {
    const clientNdjson = ndjson(
      { _type: 'header', capacity: 100 },
      { _type: 'event', _wall: '2026-01-01T00:00:01Z', type: 'click' },
    );
    const serverNdjson = ndjson(
      { _type: 'header', capacity: 200 },
      { _type: 'event', _wall: '2026-01-01T00:00:02Z', type: 'api' },
    );
    await writeDump(root, 'client', 'test-id', clientNdjson);
    await writeDump(root, 'server', 'test-id', serverNdjson);

    const merged = await readMergedDump(root, 'test-id');
    expect(merged).not.toBeNull();
    const lines = merged!.trim().split('\n').map(l => JSON.parse(l));
    expect(lines[0].merged).toBe(true);
    expect(lines[0].total_events).toBe(2);
  });

  it('returns null when neither file exists', async () => {
    expect(await readMergedDump(root, 'nonexistent')).toBeNull();
  });

  it('handles single-side (client only) gracefully', async () => {
    await writeDump(root, 'client', 'solo', ndjson(
      { _type: 'header' },
      { _type: 'event', _wall: '2026-01-01T00:00:01Z', type: 'click' },
    ));
    const merged = await readMergedDump(root, 'solo');
    expect(merged).not.toBeNull();
    const lines = merged!.trim().split('\n').map(l => JSON.parse(l));
    expect(lines[0].sources).toEqual(['client']);
  });

  it('excludes the server half when includeServer:false (t/1064 — non-admin merge)', async () => {
    await writeDump(root, 'client', 'gated', ndjson(
      { _type: 'header' },
      { _type: 'event', _wall: '2026-01-01T00:00:01Z', type: 'click' },
    ));
    await writeDump(root, 'server', 'gated', ndjson(
      { _type: 'header' },
      { _type: 'event', _wall: '2026-01-01T00:00:02Z', type: 'api' },
    ));
    const merged = await readMergedDump(root, 'gated', { includeServer: false });
    expect(merged).not.toBeNull();
    const lines = merged!.trim().split('\n').map(l => JSON.parse(l));
    expect(lines[0].sources).toEqual(['client']); // server events withheld from non-admin
    expect(lines[0].total_events).toBe(1);
  });

  it('returns null for a server-only dumpId when includeServer:false', async () => {
    await writeDump(root, 'server', 'srvonly', ndjson(
      { _type: 'header' },
      { _type: 'event', _wall: '2026-01-01T00:00:01Z', type: 'api' },
    ));
    expect(await readMergedDump(root, 'srvonly', { includeServer: false })).toBeNull();
  });

  it('t/3081: includeServer:false + serverOmissionReason → stamped in merged header', async () => {
    await writeDump(root, 'client', 'anon', ndjson(
      { _type: 'header' },
      { _type: 'event', _wall: '2026-01-01T00:00:01Z', type: 'click' },
    ));
    await writeDump(root, 'server', 'anon', ndjson(
      { _type: 'header' },
      { _type: 'event', _wall: '2026-01-01T00:00:02Z', type: 'api' },
    ));
    const merged = await readMergedDump(root, 'anon', {
      includeServer: false,
      serverOmissionReason: 'anonymous-session',
    });
    expect(merged).not.toBeNull();
    const header = JSON.parse(merged!.trim().split('\n')[0]);
    expect(header.sources).toEqual(['client']);
    expect(header.server_source).toEqual({ attempted: false, reason: 'anonymous-session' });
    expect(header.total_events).toBe(1); // server events withheld
  });
});

describe('writeFramedNdjson (t/2865 — SIGUSR2 dump line cap)', () => {
  it('writes each record on its own line, all within LOG_MAX_LINE_BYTES', () => {
    const lines: string[] = [];
    const fakeOut = { write: (s: string) => { lines.push(s); } } as unknown as NodeJS.WritableStream;

    const normal = JSON.stringify({ _type: 'event', msg: 'ok' });
    const oversized = JSON.stringify({ _type: 'event', payload: 'x'.repeat(LOG_MAX_LINE_BYTES + 1000) });
    writeFramedNdjson([normal, oversized, normal].join('\n'), fakeOut);

    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(Buffer.byteLength(line.replace(/\n$/, ''))).toBeLessThanOrEqual(LOG_MAX_LINE_BYTES);
    }
    // oversized record is truncated with a marker, not silently dropped
    expect(lines[1]).toContain('[line truncated');
    // normal records are written verbatim
    expect(lines[0].trim()).toBe(normal);
    expect(lines[2].trim()).toBe(normal);
  });

  it('skips empty lines and does not emit blank writes', () => {
    const lines: string[] = [];
    const fakeOut = { write: (s: string) => { lines.push(s); } } as unknown as NodeJS.WritableStream;
    writeFramedNdjson('\n\n', fakeOut);
    expect(lines).toHaveLength(0);
  });
});
