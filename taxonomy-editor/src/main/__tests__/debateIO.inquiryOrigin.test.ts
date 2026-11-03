// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/4682/t/4678/t/4679: debateIO's own local extractSummary carries origin_mode/inquiry_id
 * for Ask a Question debates, through normalizeDebateOrigin — mirrors lib/debate/debateIndex.ts's
 * equivalent test. Drives listDebateSessions() against a real temp-dir debates folder, same
 * pattern as debateIO.extractSummary.test.ts (t/2334).
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const h = vi.hoisted(() => ({ debatesRoot: '' }));

vi.mock('../fileIO.js', () => ({
  resolveDataPath: (sub: string) => {
    if (!h.debatesRoot) {
      h.debatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'debateio-inquiry-origin-'));
    }
    return path.join(h.debatesRoot, sub);
  },
}));

vi.mock('../../../../lib/debate/calibrationLogger.js', () => ({
  extractCalibrationData: () => null,
  appendCalibrationLog: () => undefined,
}));

// Imported AFTER mocks so debateIO binds the mocked deps.
import { listDebateSessions } from '../debateIO.js';

function writeDebate(dir: string, id: string, data: Record<string, unknown>): void {
  const debatesDir = path.join(dir, 'debates');
  fs.mkdirSync(debatesDir, { recursive: true });
  fs.writeFileSync(path.join(debatesDir, `debate-${id}.json`), JSON.stringify(data), 'utf-8');
}

afterAll(() => {
  if (h.debatesRoot) fs.rmSync(h.debatesRoot, { recursive: true, force: true });
});

const BASE = { created_at: '2026-10-30T10:00:00Z', updated_at: '2026-10-30T10:00:00Z', phase: 'closed', topic: { final: 'Topic' }, transcript: [] };

describe('extractSummary origin fields (t/4682)', () => {
  it('carries origin_mode and inquiry_id for a typed inquiry origin', async () => {
    writeDebate(h.debatesRoot, 'b1', { ...BASE, id: 'b1', origin: { mode: 'inquiry', inquiry_id: 'job-1' } });

    const sessions = await listDebateSessions();
    const s = sessions.find(x => x.id === 'b1');
    expect(s).toBeDefined();
    expect(s!.origin_mode).toBe('inquiry');
    expect(s!.inquiry_id).toBe('job-1');
  });

  it('normalises the legacy flat string shape (web-persisted inquiry debates)', async () => {
    writeDebate(h.debatesRoot, 'b2', { ...BASE, id: 'b2', origin: 'inquiry', inquiryJobId: 'legacy-job-2' });

    const sessions = await listDebateSessions();
    const s = sessions.find(x => x.id === 'b2');
    expect(s).toBeDefined();
    expect(s!.origin_mode).toBe('inquiry');
    expect(s!.inquiry_id).toBe('legacy-job-2');
  });

  it('leaves origin_mode/inquiry_id absent for a cli/gui-origin debate', async () => {
    writeDebate(h.debatesRoot, 'b3', { ...BASE, id: 'b3', origin: { mode: 'gui' } });

    const sessions = await listDebateSessions();
    const s = sessions.find(x => x.id === 'b3');
    expect(s).toBeDefined();
    expect(s!.origin_mode).toBeUndefined();
    expect(s!.inquiry_id).toBeUndefined();
  });

  it('leaves origin_mode/inquiry_id absent for a pre-origin debate (no origin field at all)', async () => {
    writeDebate(h.debatesRoot, 'b4', { ...BASE, id: 'b4' });

    const sessions = await listDebateSessions();
    const s = sessions.find(x => x.id === 'b4');
    expect(s).toBeDefined();
    expect(s!.origin_mode).toBeUndefined();
    expect(s!.inquiry_id).toBeUndefined();
  });
});
