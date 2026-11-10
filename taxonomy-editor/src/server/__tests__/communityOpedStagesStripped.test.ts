// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/171 (TL p/35#12): an approved op-ed's Community copy carries no `stages`. A stage's prompt holds the
// user's full source material, which is otherwise never public. The strip is op-ed-only: a debate's own
// `stages` key (diagnostics) must survive, which is why it isn't on the SENSITIVE_KEYS denylist.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const files = new Map<string, string>();
const normalize = (p: string) => p.replace(/\\/g, '/');

vi.mock('../storage/fileIO.js', () => ({
  getUserContentBackend: () => ({
    readFile: vi.fn(async (p: string) => files.get(normalize(p)) ?? null),
    writeFile: vi.fn(async (p: string, content: string) => { files.set(normalize(p), content); }),
    listDirectory: vi.fn(async (dir: string) => {
      const prefix = `${normalize(dir)}/`;
      return [...new Set([...files.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length)))];
    }),
  }),
  assertSafeId: (id: string, label: string) => {
    if (!id || id.includes('..') || id.includes('/')) throw new Error(`Unsafe ${label}: ${id}`);
  },
}));
vi.mock('../config.js', () => ({ resolveDataPath: (p: string) => `/data/${p}` }));
vi.mock('../logger.js', () => ({ log: { server: { warn: vi.fn(), info: vi.fn() } } }));

import { approveSubmission } from '../community/community.js';

function seed(id: string, type: string, data: Record<string, unknown>) {
  files.set(normalize(`/data/community/_submissions/sub-${id}.json`), JSON.stringify({ id, type, status: 'pending', submittedBy: 'alice', data }));
}

/** The published Community copy for `communityId` (not the public share, not the submission). */
function published(communityId: string): Record<string, unknown> {
  const key = [...files.keys()].find(k => k.startsWith('/data/community/') && !k.includes('_submissions') && k.endsWith(`${communityId}.json`));
  expect(key, `no community copy written for ${communityId}`).toBeDefined();
  return JSON.parse(files.get(key!)!) as Record<string, unknown>;
}

const stage = { stage: 'generation', attempt: 1, model: 'm', prompt: 'SOURCE MATERIAL: a private document', output: '{}' };

describe('Community publication strips op-ed stages (t/171)', () => {
  beforeEach(() => files.clear());

  it("an approved op-ed's Community copy has no stages, and keeps the rest of the member", async () => {
    seed('o1', 'oped', { topic: 'AI Safety', opeds: [{ pov: 'skeptic', headline: 'h', status: 'complete', body: 'text', stages: [stage] }] });
    const { communityId } = await approveSubmission('o1');
    const copy = published(communityId) as { opeds: Array<Record<string, unknown>> };
    expect(copy.opeds[0]).not.toHaveProperty('stages');
    expect(copy.opeds[0]).toMatchObject({ pov: 'skeptic', headline: 'h', body: 'text' });
    expect(JSON.stringify(copy)).not.toContain('a private document');
  });

  it("a debate's own `stages` key is untouched (the strip is op-ed-only, not a denylist key)", async () => {
    seed('d1', 'debate', { id: 'deb-1', title: 'A debate', stages: [{ name: 'context-rot' }] });
    const { communityId } = await approveSubmission('d1');
    expect(published(communityId).stages).toEqual([{ name: 'context-rot' }]);
  });
});
