// @vitest-environment node
// t/641 (t/629; TL p/50#187, Security p/228#36): PUT /api/proposals/:filename commits to the root of the PUBLIC data repo.
// Through the real route: a signed-in non-admin is refused 403; for the operator, an unknown field is dropped (never
// committed), an email address anywhere is refused, an oversized file is refused, and nothing reaches saveProposal on
// any refusal.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const h = vi.hoisted(() => ({ save: vi.fn(async () => ({ version: 'v2' })), isAdmin: vi.fn(() => false) }));
vi.mock('../storage/fileIO.js', async (importActual) => ({
  ...(await importActual<typeof import('../storage/fileIO.js')>()),
  saveProposal: h.save,
}));
vi.mock('../community/community.js', async (importActual) => ({
  ...(await importActual<typeof import('../community/community.js')>()),
  isAdmin: h.isAdmin,
}));

import type { ServerCtx } from '../routes/context.js';
import { createRouter, type Handler } from '../httpKit.js';
import { registerSourcesRoutes } from '../routes/sources.js';
import { PROPOSAL_MAX_COUNT, validateProposalFile } from '../routes/proposalSchema.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const proposal = (over: Record<string, unknown> = {}) => ({
  action: 'NEW', target_node_id: null, suggested_id: 'acc-beliefs-099', pov: 'accelerationist', category: 'Beliefs',
  label: 'Open weights speed safety research', description: 'A belief node.', rationale: 'Seen across 12 summaries.',
  evidence_doc_ids: ['doc-1', 'doc-2'], evidence_count: 2, status: 'approved', ...over,
});
const file = (over: Record<string, unknown> = {}) => ({
  generated_at: '2026-11-25T00:00:00Z', model: 'gemini-3.5-flash', taxonomy_version: '1.0', summary_count: 12,
  proposals: [proposal()], ...over,
});

async function put(body: unknown): Promise<{ status: number; body: { error?: string } | undefined }> {
  const routes: { method: string; path: string; handler: Handler }[] = [];
  registerSourcesRoutes(createRouter(routes), {} as ServerCtx);
  const route = routes.find(r => r.method === 'PUT' && r.path === '/api/proposals/:filename')!;
  const out: { status: number; body: { error?: string } | undefined } = { status: 200, body: undefined };
  const res = {
    writableEnded: false, headersSent: false, setHeader() {}, getHeader() { return undefined; },
    writeHead(s: number) { out.status = s; this.headersSent = true; return this; },
    end(b?: string) { out.body = b ? JSON.parse(b) : undefined; this.writableEnded = true; },
  } as unknown as ServerResponse;
  await route.handler({ url: '/api/proposals/taxonomy-proposal-1.json', method: 'PUT', headers: { 'if-match': '"base"' }, socket: {} } as unknown as IncomingMessage, res, body);
  return out;
}

let savedAuth: string | undefined;
beforeEach(() => { savedAuth = process.env.AUTH_DISABLED; delete process.env.AUTH_DISABLED; h.save.mockClear(); h.isAdmin.mockReturnValue(false); });
afterEach(() => { if (savedAuth === undefined) delete process.env.AUTH_DISABLED; else process.env.AUTH_DISABLED = savedAuth; });

describe('t/641: PUT /api/proposals/:filename', () => {
  it('a signed-in non-admin is refused 403; nothing is committed', async () => {
    expect((await put(file())).status).toBe(403);
    expect(h.save).not.toHaveBeenCalled();
  });

  describe('as an admin', () => {
    beforeEach(() => { h.isAdmin.mockReturnValue(true); });

    it('a valid file is committed', async () => {
      expect((await put(file())).status).toBe(200);
      expect(h.save).toHaveBeenCalledWith('taxonomy-proposal-1.json', file(), { baseSha: 'base' });
    });

    it('unknown fields, at the top and on a proposal, are dropped and never committed', async () => {
      expect((await put(file({ tracking: 'x', proposals: [proposal({ submitter_email_hash: 'abc', notes: 'free text' })] }))).status).toBe(200);
      const committed = JSON.stringify((h.save.mock.calls[0] as unknown[])[1]);
      expect(committed).not.toContain('tracking');
      expect(committed).not.toContain('submitter_email_hash');
      expect(committed).not.toContain('free text');
    });

    it('an email address in any text field is refused 400', async () => {
      for (const field of ['label', 'description', 'rationale']) {
        const r = await put(file({ proposals: [proposal({ [field]: 'contact jane.doe@example.com for details' })] }));
        expect(`${field} ${r.status}`).toBe(`${field} 400`);
      }
      expect(h.save).not.toHaveBeenCalled();
    });

    it('an oversized file is refused 400 (per-field caps and the count cap)', async () => {
      expect((await put(file({ proposals: [proposal({ rationale: 'x'.repeat(4001) })] }))).status).toBe(400);
      expect((await put(file({ proposals: Array.from({ length: PROPOSAL_MAX_COUNT + 1 }, () => proposal()) }))).status).toBe(400);
      expect(h.save).not.toHaveBeenCalled();
    });

    it('a wrong shape (not a proposal file) is refused 400', async () => {
      for (const body of [{ any: 'thing' }, null, [], 'text', file({ proposals: [proposal({ action: 'DELETE_ALL' })] })]) {
        expect((await put(body)).status).toBe(400);
      }
      expect(h.save).not.toHaveBeenCalled();
    });
  });
});

// Security p/93#98: a review save must keep every field Invoke-ProposalApply needs. Round-trip every real proposal file
// in taxonomy/proposals/ (the generator's own output): it validates, and nothing it carries is dropped or changed.
describe('t/641: real proposal files round-trip unchanged', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'taxonomy', 'proposals');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

  it('there are real files to check', () => { expect(files.length).toBeGreaterThan(0); });

  for (const f of files) {
    it(`${f} validates and round-trips with no field dropped`, () => {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, ''));
      const r = validateProposalFile(data);
      expect(r.ok, r.ok ? '' : r.reason).toBe(true);
      expect(r.ok && r.value).toEqual(data);
    });
  }

  it('a status-only save keeps SPLIT children (with assigned_children), MERGE ids and the REORDER parent', async () => {
    h.isAdmin.mockReturnValue(true);
    const body = file({ proposals: [
      proposal({ action: 'SPLIT', target_node_id: 'saf-beliefs-001', children: [
        { suggested_id: 'saf-beliefs-101', label: 'Child A', description: 'A.', assigned_children: ['saf-beliefs-010'] },
        { suggested_id: 'saf-beliefs-102', label: 'Child B', description: 'B.' },
      ], status: 'approved' }),
      proposal({ action: 'MERGE', merge_node_ids: ['acc-beliefs-001', 'acc-beliefs-002'], surviving_node_id: 'acc-beliefs-001', status: 'rejected' }),
      proposal({ action: 'REORDER', target_node_id: 'skp-beliefs-004', new_parent_id: 'skp-beliefs-001', status: 'pending' }),
    ] });
    expect((await put(body)).status).toBe(200);
    expect((h.save.mock.calls.at(-1) as unknown[])[1]).toEqual(body);
  });
});
