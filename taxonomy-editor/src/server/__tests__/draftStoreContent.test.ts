// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/185 content tests (TL p/77#68, revised by TL p/77#72 after Security t185#21). These assert on what is stored,
// not only on status codes. On the anonymous draft path the body is client-supplied, so calibration (a platform
// trust badge) and the answer substance (directAnswer, per-camp answer fields) are dropped, not kept.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StorageBackend } from '../storage/storageBackend.js';
import { makeValidResult, makeDriftedResult } from '../../../../lib/inquiry/__fixtures__/validResult.js';
import type { InquiryPayload } from '../../../../lib/inquiry/index.js';

const files = new Map<string, string>();
const normalize = (p: string) => p.replace(/\\/g, '/');

const listDirectoryImpl = async (dir: string) => {
  const prefix = `${normalize(dir)}/`;
  return [...new Set([...files.keys()].filter(k => k.startsWith(prefix) && k !== prefix).map(k => k.slice(prefix.length).split('/')[0]))];
};

const mockBackend: StorageBackend = {
  readFile: vi.fn(async (p: string) => files.get(normalize(p)) ?? null),
  writeFile: vi.fn(async (p: string, content: string) => { files.set(normalize(p), content); }),
  deleteFile: vi.fn(async (p: string) => { files.delete(normalize(p)); }),
  listDirectory: vi.fn(listDirectoryImpl),
  exists: vi.fn(async (p: string) => files.has(normalize(p))),
};

vi.mock('../storage/fileIO.js', () => ({
  getUserContentBackend: () => mockBackend,
  writeFileIfAbsentStrict: vi.fn(async (_backend: unknown, path: string, content: string) => {
    const npath = normalize(path);
    if (files.has(npath)) return 'exists';
    files.set(npath, content);
    return 'created';
  }),
}));
vi.mock('../config.js', () => ({ resolveDataPath: (p: string) => `/data/${p}` }));
vi.mock('../logger.js', () => ({ log: { server: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } } }));
vi.mock('../security/contentSanitizer.js', () => ({
  sanitizeUserText: (text: string) => text.trim().slice(0, 2000),
  withSanitizeBudget: (fn: () => any) => fn(),
}));

import { createDraftStore } from '../community/draftStore.js';

const now = () => Date.now();

// Canonical nodes the fixtures reference, so the refs are known (not refused as unknown).
const NODES = new Map<string, { label: string; camp?: 'acc' | 'saf' | 'skp' | 'cc' }>([
  ['skp-beliefs-029', { label: 'Precaution under uncertainty', camp: 'skp' }],
  ['acc-beliefs-004', { label: 'Regulatory process', camp: 'acc' }],
]);

/** Community projection of a fixture: questionDrift.warning removed, as the upload paths do before sending. */
function communityResult(r: Record<string, unknown>): Record<string, unknown> {
  const q = r.questionDrift as Record<string, unknown> | undefined;
  if (q) delete q.warning;
  return r;
}

/** A body that claims a degraded run: every calibration trust verdict is censored. */
function degraded(r: Record<string, unknown>): Record<string, unknown> {
  const cal = (r.calibration as Array<Record<string, unknown>>).map(c => ({
    ...c,
    trust: { ...(c.trust as Record<string, unknown>), verdict: 'censored' },
  }));
  return { ...r, calibration: cal };
}

/** A body that claims a healthy run: every calibration trust verdict is trust. */
function healthyClaim(r: Record<string, unknown>): Record<string, unknown> {
  const cal = (r.calibration as Array<Record<string, unknown>>).map(c => ({
    ...c,
    trust: { ...(c.trust as Record<string, unknown>), verdict: 'trust' },
  }));
  return { ...r, calibration: cal };
}

async function createAndRead(result: Record<string, unknown>, note = '') {
  const store = createDraftStore({ backend: mockBackend, now });
  const created = await store.createDraft({ result, note } as unknown as InquiryPayload, { nodesById: NODES, clientId: 'c' });
  expect(created.ok, `createDraft refused: ${JSON.stringify(created)}`).toBe(true);
  const draftId = (created as { draftId: string }).draftId;
  const key = [...files.keys()].find(k => k.includes(`_drafts/${draftId}`));
  const raw = key ? files.get(key) : undefined;
  expect(raw, 'no draft record written').toBeDefined();
  return { raw: raw!, record: JSON.parse(raw!) as { projection: Record<string, any>; note: string } };
}

describe('DraftStore content (t/185, TL p/77#72)', () => {
  beforeEach(() => {
    files.clear();
    vi.clearAllMocks();
    (mockBackend.listDirectory as any).mockImplementation(listDirectoryImpl);
  });

  it('stored projection keeps the question text (request.question)', async () => {
    const { record } = await createAndRead(communityResult(makeValidResult()));
    expect(record.projection.request?.question).toBe('What counts as an AI harm?');
  });

  it('stored projection keeps request as content, not an empty shell', async () => {
    const { record } = await createAndRead(communityResult(makeValidResult()));
    expect(Object.keys(record.projection.request ?? {}).length).toBeGreaterThan(1);
    expect(record.projection.request).toHaveProperty('fidelity');
  });

  it('stored record keeps the sanitized note (the wrapper note is not dropped)', async () => {
    const { record } = await createAndRead(communityResult(makeValidResult()), '  Please review this.  ');
    expect(record.note).toBe('Please review this.');
  });

  it('calibration is absent from the stored record, by key and by value (platform trust badge, TL p/77#72)', async () => {
    const { record, raw } = await createAndRead(communityResult(makeValidResult()));
    expect(Object.prototype.hasOwnProperty.call(record.projection, 'calibration')).toBe(false);
    expect(raw).not.toContain('"trust":');

    expect((record as { droppedAuthFields: string[] }).droppedAuthFields).toContain('calibration');
  });

  it('calibration is dropped even when the body claims a healthy run (client-supplied, TL p/77#72)', async () => {
    const { record, raw } = await createAndRead(communityResult(healthyClaim(makeValidResult())));
    expect(Object.prototype.hasOwnProperty.call(record.projection, 'calibration')).toBe(false);
    expect(raw).not.toContain('"trust":');
  });

  it('questionDrift.warning is absent from the stored projection (hasOwnProperty); debatedTopic and driftScore stay', async () => {
    const body = communityResult(makeDriftedResult()) as Record<string, any>;
    body.questionDrift.driftScore = 0.4;
    const { record } = await createAndRead(body);
    expect(record.projection.questionDrift).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(record.projection.questionDrift, 'warning')).toBe(false);
    expect(record.projection.questionDrift).toHaveProperty('debatedTopic', 'How should AI regulation be designed?');
    expect(record.projection.questionDrift).toHaveProperty('driftScore', 0.4);
  });

  it('directAnswer is dropped on every anonymous draft, even on a healthy-claimed body (fail closed, TL p/77#72)', async () => {
    const { record, raw } = await createAndRead(communityResult(healthyClaim(makeDriftedResult())));
    expect(Object.prototype.hasOwnProperty.call(record.projection, 'directAnswer')).toBe(false);
    expect(raw).not.toContain('No consensus answer');
  });

  it('directAnswer is dropped on a degraded-claimed body too (the gate no longer decides, TL p/77#72)', async () => {
    const { record, raw } = await createAndRead(communityResult(degraded(makeDriftedResult())));
    expect(Object.prototype.hasOwnProperty.call(record.projection, 'directAnswer')).toBe(false);
    expect(raw).not.toContain('No consensus answer');
  });

  it('per-camp answer fields (answeredLiteralQuestion, answerNote) are dropped on every anonymous draft; the camp verdict stays', async () => {
    const { record, raw } = await createAndRead(communityResult(healthyClaim(makeDriftedResult())));
    const verdict = record.projection.campVerdicts[0];
    expect(verdict).not.toHaveProperty('answeredLiteralQuestion');
    expect(verdict).not.toHaveProperty('answerNote');
    expect(verdict.verdict).toBe('The debate focused on regulatory process, not on harm.');
    expect(raw).not.toContain('Focused on regulatory process instead of harm');
  });

  it('a degraded-claimed body loses the answer fields and the calibration, and keeps the question and request', async () => {
    const { record } = await createAndRead(communityResult(degraded(makeDriftedResult())));
    expect(record.projection.request?.question).toBe('What counts as an AI harm?');
    expect(Object.prototype.hasOwnProperty.call(record.projection, 'calibration')).toBe(false);
    expect(record.projection.campVerdicts[0]).not.toHaveProperty('answerNote');
  });

  it('synthesizedHeadline is dropped on every anonymous draft, even on a healthy-claimed body (fail closed, TL p/77#74)', async () => {
    const body = communityResult(healthyClaim(makeValidResult())) as Record<string, unknown>;
    body.synthesizedHeadline = 'A headline the client wrote about a degraded run';
    const { record, raw } = await createAndRead(body);
    expect(Object.prototype.hasOwnProperty.call(record.projection, 'synthesizedHeadline')).toBe(false);
    expect(raw).not.toContain('A headline the client wrote');
    expect(record.droppedAuthFields).toContain('synthesizedHeadline');
  });

  it('derivation (models, rounds, callBudget, costUsd) is dropped on every anonymous draft (fail closed, TL p/77#74)', async () => {
    const body = communityResult(makeValidResult()) as Record<string, unknown>;
    body.derivation = { fidelity: 'standard', models: { debate: 'client-claimed-model' }, rounds: 99, callBudget: 1, costUsd: 0 };
    const { record, raw } = await createAndRead(body);
    expect(Object.prototype.hasOwnProperty.call(record.projection, 'derivation')).toBe(false);
    expect(raw).not.toContain('client-claimed-model');
    expect(record.droppedAuthFields).toContain('derivation');
    expect(record.projection.request?.question).toBe('What counts as an AI harm?');
  });
});
