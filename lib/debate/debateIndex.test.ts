// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { extractSummary, listDebateSessionsIndexed } from './debateIndex.js';

describe('extractSummary', () => {
  it('uses data.title when it is a string', () => {
    const result = extractSummary({
      id: 'd1',
      title: 'My Debate',
      topic: { final: 'AI governance' },
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
      phase: 'completed',
      transcript: [],
    });
    expect(result.title).toBe('My Debate');
  });

  it('extracts title from topic object when data.title is missing', () => {
    const result = extractSummary({
      id: 'd2',
      topic: { final: 'AI safety', original: 'safety' },
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
      phase: 'completed',
      transcript: [],
    });
    expect(result.title).toBe('AI safety');
    expect(result.title).not.toContain('[object Object]');
  });

  it('extracts title from topic.original when topic.final is missing', () => {
    const result = extractSummary({
      id: 'd3',
      topic: { original: 'Original topic' },
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
      phase: 'completed',
      transcript: [],
    });
    expect(result.title).toBe('Original topic');
  });

  it('handles legacy string topic', () => {
    const result = extractSummary({
      id: 'd4',
      topic: 'AI regulation',
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
      phase: 'completed',
      transcript: [],
    });
    expect(result.title).toBe('AI regulation');
  });

  it('falls back to Untitled when no title or topic', () => {
    const result = extractSummary({
      id: 'd5',
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
      phase: 'completed',
      transcript: [],
    });
    expect(result.title).toBe('Untitled');
  });

  it('sets origin_mode and inquiry_id for a legacy inquiry-string origin (t/4679)', () => {
    const result = extractSummary({
      id: 'd6',
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
      phase: 'completed',
      transcript: [],
      origin: 'inquiry',
      inquiryJobId: 'job-123',
    });
    expect(result.origin_mode).toBe('inquiry');
    expect(result.inquiry_id).toBe('job-123');
  });

  it('sets origin_mode without inquiry_id when the legacy inquiry job id is absent', () => {
    const result = extractSummary({
      id: 'd7',
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
      phase: 'completed',
      transcript: [],
      origin: 'inquiry',
    });
    expect(result.origin_mode).toBe('inquiry');
    expect(result.inquiry_id).toBeUndefined();
    expect('inquiry_id' in result).toBe(false);
  });

  it('omits origin_mode/inquiry_id entirely for a cli/gui origin', () => {
    const result = extractSummary({
      id: 'd8',
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
      phase: 'completed',
      transcript: [],
      origin: { mode: 'gui' },
    });
    expect('origin_mode' in result).toBe(false);
    expect('inquiry_id' in result).toBe(false);
  });

  it('omits origin_mode/inquiry_id for a pre-origin debate with no origin field', () => {
    const result = extractSummary({
      id: 'd9',
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
      phase: 'completed',
      transcript: [],
    });
    expect('origin_mode' in result).toBe(false);
    expect('inquiry_id' in result).toBe(false);
  });

  it('does not produce [object Object] when topic is an object and title is missing', () => {
    const result = extractSummary({
      id: 'd6',
      title: '',
      topic: { final: 'Correct title', original: 'backup' },
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
      phase: 'completed',
      transcript: [],
    });
    expect(result.title).not.toContain('[object Object]');
    expect(result.title).toBe('Correct title');
  });

  it('counts turns from transcript', () => {
    const result = extractSummary({
      id: 'd7',
      topic: { final: 'Test' },
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
      phase: 'completed',
      transcript: [
        { type: 'statement' },
        { type: 'opening' },
        { type: 'moderator_intervention' },
      ],
    });
    expect(result.turn_count).toBe(2);
  });

  it('includes app_version when present', () => {
    const result = extractSummary({
      id: 'd8',
      topic: { final: 'Test' },
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
      phase: 'completed',
      transcript: [],
      app_version: 'v0.13.6-71',
    });
    expect(result.app_version).toBe('v0.13.6-71');
  });

  it('computes process_reward_mean from process_rewards', () => {
    const result = extractSummary({
      id: 'd9',
      topic: { final: 'Test' },
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
      phase: 'completed',
      transcript: [],
      process_rewards: [
        { score: 0.6 },
        { score: 0.8 },
        { score: 1.0 },
      ],
    });
    expect(result.process_reward_mean).toBeCloseTo(0.8, 5);
  });

  it('returns null process_reward_mean when no process_rewards', () => {
    const result = extractSummary({
      id: 'd10',
      topic: { final: 'Test' },
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
      phase: 'completed',
      transcript: [],
    });
    expect(result.process_reward_mean).toBeNull();
  });

  it('computes crux_addressed_ratio from neutral evaluations', () => {
    const result = extractSummary({
      id: 'd11',
      topic: { final: 'Test' },
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
      phase: 'completed',
      transcript: [],
      neutral_evaluations: [
        {
          checkpoint: 'final',
          cruxes: [
            { status: 'addressed' },
            { status: 'addressed' },
            { status: 'unaddressed' },
            { status: 'unaddressed' },
          ],
        },
      ],
    });
    expect(result.crux_addressed_ratio).toBeCloseTo(0.5, 5);
  });

  it('computes claims_forgotten_rate from ledger and argument network', () => {
    const result = extractSummary({
      id: 'd12',
      topic: { final: 'Test' },
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
      phase: 'completed',
      transcript: [],
      argument_network: {
        nodes: [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }, { id: 'n4' }],
        edges: [],
      },
      unanswered_claims_ledger: [
        { addressed_round: 2 },
        { addressed_round: undefined },
        { addressed_round: 3 },
      ],
    });
    expect(result.claims_forgotten_rate).toBeCloseTo(0.25, 5);
  });

  it('computes taxonomy_mapped_ratio from AN nodes and transcript refs', () => {
    const result = extractSummary({
      id: 'd13',
      topic: { final: 'Test' },
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
      phase: 'completed',
      transcript: [
        { id: 'e1', type: 'statement', taxonomy_refs: [{ node_id: 'tax-1' }] },
        { id: 'e2', type: 'statement', taxonomy_refs: [] },
      ],
      argument_network: {
        nodes: [
          { id: 'n1', source_entry_id: 'e1' },
          { id: 'n2', source_entry_id: 'e2' },
        ],
        edges: [],
      },
    });
    expect(result.taxonomy_mapped_ratio).toBeCloseTo(0.5, 5);
  });

  it('computes repetition_rate from turn validations', () => {
    const result = extractSummary({
      id: 'd14',
      topic: { final: 'Test' },
      created_at: '2026-01-01',
      updated_at: '2026-01-02',
      phase: 'completed',
      transcript: [
        { type: 'opening' },
        { type: 'statement' },
        { type: 'statement' },
        { type: 'statement' },
      ],
      turn_validations: {
        t1: { final: { issues: ['repetition detected'] } },
        t2: { final: { issues: ['schema error'] } },
        t3: { final: { issues: ['same moves used'] } },
      },
    });
    expect(result.repetition_rate).toBeCloseTo(0.5, 5);
  });
});

describe('listDebateSessionsIndexed', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns string title when cached index entry has object title', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-index-test-'));

    // Write a real debate file so the cache-miss re-read path has valid data
    const debateData = {
      id: 'test-d1',
      title: 'Real Title',
      topic: { final: 'Real Title', original: 'backup' },
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      phase: 'completed',
      transcript: [],
    };
    const debateFile = path.join(tmpDir, 'debate-test-d1.json');
    fs.writeFileSync(debateFile, JSON.stringify(debateData), 'utf-8');
    const mtime = fs.statSync(debateFile).mtimeMs;

    // Write a stale index where title is an object (the bug shape from t/2729)
    const staleIndex = {
      version: 1,
      entries: {
        'test-d1': {
          id: 'test-d1',
          title: { final: 'Real Title', original: 'backup' },
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          phase: 'completed',
          file_mtime: mtime,
        },
      },
    };
    fs.writeFileSync(path.join(tmpDir, 'debates-index.json'), JSON.stringify(staleIndex), 'utf-8');

    const results = listDebateSessionsIndexed(tmpDir);
    expect(results).toHaveLength(1);
    expect(typeof results[0].title).toBe('string');
    expect(results[0].title).toBe('Real Title');
  });
});
