// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4161 — the refresh-ai-models IPC payload schema. Pure (no electron import).

import { describe, it, expect } from 'vitest';
import { refreshModelsRequestSchema } from './refreshModelsRequestSchema.js';

const proposal = {
  catalogFingerprint: 'sha256:abc',
  hash: 'sha256:def',
  changes: [{ slot: 'defaults.gemini', from: 'gemini-3.5-flash', to: 'gemini-3.7-flash' }],
};

describe('refreshModelsRequestSchema', () => {
  it('accepts no opts (plain refresh)', () => {
    expect(refreshModelsRequestSchema.parse({})).toEqual({});
  });

  it('accepts a dry run', () => {
    expect(refreshModelsRequestSchema.parse({ dryRun: true })).toEqual({ dryRun: true });
  });

  it('accepts a well-formed accept', () => {
    const input = { accept: { proposal, approvedBy: 'Jane Reviewer', reason: 'vendor rotation' } };
    expect(refreshModelsRequestSchema.parse(input)).toEqual(input);
  });

  it('accepts a change with a null `to` (no same-family successor) and an optional family/reason', () => {
    const p = { ...proposal, changes: [{ slot: 'defaults.claude', from: 'claude-opus-4', to: null, family: null, reason: 'vendor-absent' as const }] };
    expect(() => refreshModelsRequestSchema.parse({ accept: { proposal: p, approvedBy: 'A', reason: 'r' } })).not.toThrow();
  });

  it('rejects an unknown top-level key', () => {
    expect(() => refreshModelsRequestSchema.parse({ dryRun: true, extra: 1 })).toThrow();
  });

  it('rejects an unknown key inside accept', () => {
    expect(() => refreshModelsRequestSchema.parse({ accept: { proposal, approvedBy: 'A', reason: 'r', principal: 'sneaky' } })).toThrow();
  });

  it('rejects an unknown key inside proposal', () => {
    expect(() => refreshModelsRequestSchema.parse({ accept: { proposal: { ...proposal, extra: 1 }, approvedBy: 'A', reason: 'r' } })).toThrow();
  });

  it('rejects an empty reason', () => {
    expect(() => refreshModelsRequestSchema.parse({ accept: { proposal, approvedBy: 'A', reason: '' } })).toThrow();
  });

  it('rejects an oversized reason', () => {
    expect(() => refreshModelsRequestSchema.parse({ accept: { proposal, approvedBy: 'A', reason: 'x'.repeat(2001) } })).toThrow();
  });

  it('rejects an empty approvedBy', () => {
    expect(() => refreshModelsRequestSchema.parse({ accept: { proposal, approvedBy: '', reason: 'r' } })).toThrow();
  });

  it('rejects wrong types (dryRun as a string)', () => {
    expect(() => refreshModelsRequestSchema.parse({ dryRun: 'yes' })).toThrow();
  });

  it('rejects a missing proposal field', () => {
    const { hash: _hash, ...incomplete } = proposal;
    expect(() => refreshModelsRequestSchema.parse({ accept: { proposal: incomplete, approvedBy: 'A', reason: 'r' } })).toThrow();
  });

  it('rejects a non-object payload', () => {
    expect(() => refreshModelsRequestSchema.parse('not an object')).toThrow();
    expect(() => refreshModelsRequestSchema.parse(null)).toThrow();
  });
});
