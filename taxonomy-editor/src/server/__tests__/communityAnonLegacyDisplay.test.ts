// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/693 (TL p/77#166): an item published before t/693 stores the submitter's storage id (a full email
// address for Google and Entra sign-ins) as its display. Served to an ANONYMOUS caller through the real
// GET /api/community routes, the response carries the pseudonym and the address nowhere. With no key
// loaded it carries the fixed word. Real routes and real community module over an in-memory backend.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const files = new Map<string, string>();
const normalize = (p: string) => p.replace(/\\/g, '/');

vi.mock('../storage/fileIO.js', () => ({
  getUserContentBackend: () => ({
    readFile: vi.fn(async (p: string) => files.get(normalize(p)) ?? null),
    writeFile: vi.fn(async (p: string, content: string) => { files.set(normalize(p), content); }),
    deleteFile: vi.fn(async (p: string) => { files.delete(normalize(p)); }),
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
vi.mock('../security/userContext.js', () => ({
  getStorageUserId: () => 'anon-3f1c2b7e-8a4d-4c1e-9b2a-0d5e6f7a8b9c',
  isAnonymousUser: () => true,
  getStableId: () => undefined,
}));

import { registerCommunityRoutes } from '../routes/community.js';
import type { ServerCtx } from '../routes/context.js';
import { communityPseudonym, PSEUDONYM_FALLBACK } from '../community/submitterPseudonym.js';
import { setAnonSessionSecret, clearAnonSessionSecret } from '../security/anonSessionSigning.js';

/** What deriveStorageUserId makes of a Google or Entra address. */
const EMAIL_ID = 'jane-doe-at-example-com';

type Handler = (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void> | void;
function getHandlers(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const reg = (m: string) => (p: string, h: Handler) => { handlers[`${m} ${p}`] = h; };
  const router = { get: reg('GET'), put: reg('PUT'), post: reg('POST'), patch: reg('PATCH'), del: reg('DELETE') };
  registerCommunityRoutes(router as never, { getGithubBackend: () => null } as unknown as ServerCtx);
  return handlers;
}

/** Calls a GET route as the anonymous caller; returns the status and the response body exactly as sent. */
async function anonGet(route: string, url: string): Promise<{ status: number; raw: string }> {
  const out = { status: 200, raw: '' };
  const res = {
    writableEnded: false, headersSent: false,
    writeHead: (c: number) => { out.status = c; },
    end: (b?: string) => { out.raw = b ?? ''; },
    setHeader: () => undefined,
  } as unknown as ServerResponse;
  const handler = getHandlers()[`GET ${route}`];
  expect(handler, `route GET ${route}`).toBeTypeOf('function');
  await handler({ url, method: 'GET', headers: {} } as unknown as IncomingMessage, res);
  return out;
}

const KINDS = [
  { plural: 'chats', prefix: 'chat-', body: { id: 'old', title: 'Old chat', mode: 'chat' } },
  { plural: 'debates', prefix: 'debate-', body: { id: 'old', title: 'Old debate', phase: 'complete' } },
  { plural: 'opeds', prefix: 'oped-', body: { id: 'old', topic: 'Old', opeds: [{ pov: 'acc', headline: 'h', status: 'complete', body: 'text' }] } },
  { plural: 'inquiries', prefix: 'inquiry-', body: { id: 'old', request: { question: 'Old?' } } },
] as const;

function seedLegacy(kind: typeof KINDS[number]) {
  files.set(`/data/community/${kind.plural}/${kind.prefix}old.json`, JSON.stringify({
    ...kind.body,
    community_metadata: { submitted_by_display: EMAIL_ID, submitted_at: '2026-08-26T00:00:00.000Z', approved_at: '2026-08-26T00:00:00.000Z', original_id: 'private' },
  }));
}

function expectNoAddress(raw: string) {
  expect(raw).not.toContain(EMAIL_ID);
  expect(raw).not.toContain('-at-');
  expect(raw).not.toContain('@');
  expect(raw).not.toContain('owner_storage_id');
}

beforeEach(() => { files.clear(); setAnonSessionSecret(Buffer.alloc(32, 7)); });
afterEach(() => { clearAnonSessionSecret(); });

describe('a pre-t/693 item served to an anonymous caller (t/693)', () => {
  it.each(KINDS)('GET /api/community/$plural and /:id carry the pseudonym and the address nowhere', async (kind) => {
    seedLegacy(kind);
    const pseudonym = communityPseudonym(EMAIL_ID);
    expect(pseudonym).toMatch(/^Contributor-[0-9a-f]{8}$/);

    const list = await anonGet(`/api/community/${kind.plural}`, `/api/community/${kind.plural}`);
    expect(list.status).toBe(200);
    expect(list.raw).toContain('"id":"old"');
    expect(list.raw).toContain(`"submitted_by_display":"${pseudonym}"`);
    expectNoAddress(list.raw);

    const item = await anonGet(`/api/community/${kind.plural}/:id`, `/api/community/${kind.plural}/old`);
    expect(item.status).toBe(200);
    expect(item.raw).toContain(`"submitted_by_display":"${pseudonym}"`);
    expectNoAddress(item.raw);
  });

  it.each(KINDS)('with no key loaded, $plural show the fixed word and the address nowhere', async (kind) => {
    clearAnonSessionSecret();
    seedLegacy(kind);
    for (const [route, url] of [
      [`/api/community/${kind.plural}`, `/api/community/${kind.plural}`],
      [`/api/community/${kind.plural}/:id`, `/api/community/${kind.plural}/old`],
    ]) {
      const r = await anonGet(route, url);
      expect(r.status).toBe(200);
      expect(r.raw).toContain(`"submitted_by_display":"${PSEUDONYM_FALLBACK}"`);
      expectNoAddress(r.raw);
    }
  });
});
