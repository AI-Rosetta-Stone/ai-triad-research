// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/725 (TaxonomyServer p/74#49): what an anonymous visitor's save carries. The strip is the renderer half of the
// server's strip: same fields, outgoing copy only, never mutating the in-memory debate.

import { describe, it, expect } from 'vitest';
import type { DebateSession, DebateDelta } from '@lib/debate/types';
import { stripAnonymousFields, stripAnonymousDelta } from './anonUpload';

const BIG = [{ stage: 'draft', prompt: 'p'.repeat(1000), raw_response: 'r' }];

const session = () => ({
  id: 'deb-1',
  title: 'T',
  transcript: [{ id: 'e1' }],
  diagnostics: { enabled: true, entries: { e1: { prompt: 'x' } }, overview: {} },
  dialectical_diagnostics: [{ round: 1, moderator_mode: 'standard' }],
  turn_validations: {
    e1: { final: { process_reward: 0.8 }, attempts: [{ attempt: 1, model: 'm', prompt_delta: '', raw_response: 'r', response_time_ms: 5, validation: { ok: true }, stage_diagnostics: BIG, hint_effectiveness: [] }, { attempt: 2, model: 'm', stage_diagnostics: BIG }] },
    e2: { final: { process_reward: 0.5 }, attempts: [] },
  },
}) as unknown as DebateSession;

describe('stripAnonymousFields', () => {
  it('drops diagnostics, dialectical_diagnostics and every attempt\'s stage_diagnostics, keeps the rest', () => {
    const out = stripAnonymousFields(session()) as unknown as Record<string, unknown> & { turn_validations: Record<string, { final: unknown; attempts: Array<Record<string, unknown>> }> };
    expect('diagnostics' in out).toBe(false);
    expect('dialectical_diagnostics' in out).toBe(false);
    expect(out.id).toBe('deb-1');
    expect(out.transcript).toEqual([{ id: 'e1' }]);
    const attempts = out.turn_validations.e1.attempts;
    expect(attempts).toHaveLength(2);
    for (const a of attempts) expect('stage_diagnostics' in a).toBe(false);
    expect(attempts[0]).toMatchObject({ attempt: 1, model: 'm', validation: { ok: true }, hint_effectiveness: [] });
    expect(out.turn_validations.e1.final).toEqual({ process_reward: 0.8 });
    expect(out.turn_validations.e2).toEqual({ final: { process_reward: 0.5 }, attempts: [] });
  });

  it('is much smaller on the wire', () => {
    const before = JSON.stringify(session()).length;
    const after = JSON.stringify(stripAnonymousFields(session())).length;
    expect(after).toBeLessThan(before / 2);
  });

  it('does not mutate the debate it was given (the tab keeps its diagnostics)', () => {
    const s = session();
    stripAnonymousFields(s);
    expect(s.diagnostics).toBeDefined();
    expect(s.dialectical_diagnostics).toBeDefined();
    expect((s.turn_validations as unknown as Record<string, { attempts: Array<{ stage_diagnostics?: unknown }> }>).e1.attempts[0].stage_diagnostics).toBe(BIG);
  });

  it('returns the same object when there is nothing to strip', () => {
    const lean = { id: 'deb-1', transcript: [], turn_validations: { e1: { final: {}, attempts: [{ attempt: 1 }] } } } as unknown as DebateSession;
    expect(stripAnonymousFields(lean)).toBe(lean);
    const none = { id: 'deb-1', transcript: [] } as unknown as DebateSession;
    expect(stripAnonymousFields(none)).toBe(none);
  });

  it('copes with a malformed trail (no attempts array)', () => {
    const odd = { id: 'x', turn_validations: { e1: { final: {} }, e2: null } } as unknown as DebateSession;
    expect(() => stripAnonymousFields(odd)).not.toThrow();
  });
});

describe('stripAnonymousDelta', () => {
  const delta = (changedFields?: Record<string, unknown>) => ({
    debateId: 'deb-1', baseVersion: 3, newTranscriptEntries: [], changedNodes: [], changedEdges: [], newMutations: [], changedFields,
  }) as unknown as DebateDelta;

  it('strips the same fields from the generic overlay', () => {
    const d = stripAnonymousDelta(delta({ diagnostics: { enabled: true }, position_drift: [1], turn_validations: { e1: { final: {}, attempts: [{ attempt: 1, stage_diagnostics: BIG }] } } }));
    const cf = d.changedFields as unknown as Record<string, unknown>;
    expect('diagnostics' in cf).toBe(false);
    expect(cf.position_drift).toEqual([1]);
    expect(JSON.stringify(cf.turn_validations)).not.toContain('stage_diagnostics');
    expect(d.baseVersion).toBe(3);
  });

  it('returns the same delta when there is no overlay or nothing to strip', () => {
    const none = delta();
    expect(stripAnonymousDelta(none)).toBe(none);
    const lean = delta({ position_drift: [1] });
    expect(stripAnonymousDelta(lean)).toBe(lean);
  });
});
