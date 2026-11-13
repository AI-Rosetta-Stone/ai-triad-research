// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/185 content tests (TL p/77#68): the stored draft projection carries real content, not empty shells.
// These assert on what is stored, not only on status codes. Gate and drop rules: t/285 (TL p/77#66).

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

/** A degraded run: every calibration trust verdict is censored, which is what isRunDegraded reads. */
function degraded(r: Record<string, unknown>): Record<string, unknown> {
  const cal = (r.calibration as Array<Record<string, unknown>>).map(c => ({
    ...c,
    trust: { ...(c.trust as Record<string, unknown>), verdict: 'censored' },
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
  return JSON.parse(raw!) as { projection: Record<string, any>; note: string };
}

describe('DraftStore content (t/185, TL p/77#68)', () => {
  beforeEach(() => {
    files.clear();
    vi.clearAllMocks();
    (mockBackend.listDirectory as any).mockImplementation(listDirectoryImpl);
  });

  it('stored projection keeps the question text (request.question)', async () => {
    const { projection } = await createAndRead(communityResult(makeValidResult()));
    expect(projection.request?.question).toBe('What counts as an AI harm?');
  });

  it('stored projection keeps calibration as real content, with its values (TL p/77#68)', async () => {
    const { projection } = await createAndRead(communityResult(makeValidResult()));
    expect(Array.isArray(projection.calibration)).toBe(true);
    expect(projection.calibration.length).toBeGreaterThan(0);
    expect(projection.calibration[0]).toHaveProperty('metric');
    expect(projection.calibration[0]).toHaveProperty('value');
  });

  it('stored projection keeps request as content, not an empty shell', async () => {
    const { projection } = await createAndRead(communityResult(makeValidResult()));
    expect(Object.keys(projection.request ?? {}).length).toBeGreaterThan(1);
    expect(projection.request).toHaveProperty('fidelity');
  });

  it('stored record keeps the sanitized note (the wrapper note is not dropped)', async () => {
    const record = await createAndRead(communityResult(makeValidResult()), '  Please review this.  ');
    expect(record.note).toBe('Please review this.');
  });

  it('questionDrift.warning is absent from the stored projection (hasOwnProperty), debatedTopic and driftScore stay', async () => {
    const { projection } = await createAndRead(communityResult(makeDriftedResult()));
    expect(projection.questionDrift).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(projection.questionDrift, 'warning')).toBe(false);
    expect(projection.questionDrift).toHaveProperty('debatedTopic', 'How should AI regulation be designed?');
  });

  it('directAnswer and the per-camp answer fields are kept on a healthy run (t/285 gate)', async () => {
    const { projection } = await createAndRead(communityResult(makeDriftedResult()));
    expect(projection.directAnswer?.text).toBe('No consensus answer: the camps disagree on what counts as harm.');
    const verdict = projection.campVerdicts[0];
    expect(verdict).toHaveProperty('answeredLiteralQuestion', false);
    expect(verdict).toHaveProperty('answerNote', 'Focused on regulatory process instead of harm.');
  });

  it('directAnswer and the per-camp answer fields are removed on a degraded run; the rest of the result stays (t/285 gate)', async () => {
    const { projection } = await createAndRead(communityResult(degraded(makeDriftedResult())));
    expect(projection).not.toHaveProperty('directAnswer');
    const verdict = projection.campVerdicts[0];
    expect(verdict).not.toHaveProperty('answeredLiteralQuestion');
    expect(verdict).not.toHaveProperty('answerNote');
    expect(verdict.verdict).toBe('The debate focused on regulatory process, not on harm.');
    expect(projection.request?.question).toBe('What counts as an AI harm?');
    expect(projection.calibration.length).toBeGreaterThan(0);
  });
});
