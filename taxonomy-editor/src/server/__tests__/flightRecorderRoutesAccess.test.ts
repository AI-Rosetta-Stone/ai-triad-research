// @vitest-environment node
// t/579 (incident): the flight-recorder dump routes are admin-only on a hosted server, and their filenames are confined
// to the dump directory. The real routes (registerDiagnosticsRoutes) and the real userContext and admin check run under
// server.ts's request contexts, against a real temporary state root holding a dump directory and a secret .jsonl
// outside it. Before the fix, an anonymous visitor could list, download and view every dump, create a server dump, and
// read any .jsonl through a double-encoded path.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IncomingMessage, ServerResponse } from 'http';

vi.mock('../logger.js', () => {
  const l = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { log: { server: l(), api: l(), fr: l(), ai: l() }, getRequestId: () => 'req-t579' };
});
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }), setGlobalRecorder: vi.fn() }));

import { runWithUser } from '../security/userContext.js';
import { registerDiagnosticsRoutes } from '../routes/diagnostics.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void> | void;

const ANON = { principalName: '_local', idp: '', storageUserId: 'anon-0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11', stableId: undefined, isAnonymous: true, anonymousSessionId: '0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11' };
const MEMBER = { principalName: 'bob', idp: 'github', storageUserId: 'bob', stableId: 'github:2', isAnonymous: false };
const ADMIN = { principalName: 'alice', idp: 'github', storageUserId: 'alice', stableId: 'github:1', isAnonymous: false };

let stateRoot: string;
let dumpDir: string;
const SERVER_DUMP = 'server-flight-recorder-2026-08-28T01-59-20.538Z.jsonl';
const saved = { state: process.env.AI_TRIAD_STATE_ROOT, admins: process.env.ADMIN_USERS, auth: process.env.AUTH_DISABLED };

beforeAll(() => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't579-state-'));
  dumpDir = path.join(stateRoot, 'flight-recorder');
  fs.mkdirSync(dumpDir, { recursive: true });
  fs.writeFileSync(path.join(dumpDir, SERVER_DUMP), '{"server":"event"}\n');
  fs.writeFileSync(path.join(stateRoot, 'flight-recorder-secret.jsonl'), '{"secret":"outside the dump dir"}\n');
});
afterAll(() => { fs.rmSync(stateRoot, { recursive: true, force: true }); });
beforeEach(() => {
  process.env.AI_TRIAD_STATE_ROOT = stateRoot;
  process.env.ADMIN_USERS = 'github:1';
  delete process.env.AUTH_DISABLED;
});
afterEach(() => {
  for (const [k, v] of [['AI_TRIAD_STATE_ROOT', saved.state], ['ADMIN_USERS', saved.admins], ['AUTH_DISABLED', saved.auth]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

function routes(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const reg = (m: string) => (p: string, h: Handler) => { handlers[`${m} ${p}`] = h; };
  const ctx = {
    serverRecorder: { buildDump: () => ({ ndjson: '{"buffer":"server"}\n' }) },
    appendServerLogs: (s: string) => s + '{"log":"line"}\n',
  };
  registerDiagnosticsRoutes({ get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), del: reg('DELETE') } as never, ctx as never);
  return handlers;
}

function fakeRes() {
  const r: { status: number; body: string; headersSent: boolean; writableEnded: boolean } = { status: 200, body: '', headersSent: false, writableEnded: false };
  const res = {
    writeHead(code: number) { r.status = code; r.headersSent = true; return res; },
    setHeader() { return res; },
    end(b?: string) { r.body = b ?? ''; r.writableEnded = true; return res; },
    write() { return true; },
    on() { return res; },
    get headersSent() { return r.headersSent; },
    get writableEnded() { return r.writableEnded; },
  };
  return { res: res as unknown as ServerResponse, r };
}

async function call(user: object, method: string, route: string, url: string) {
  const { res, r } = fakeRes();
  await runWithUser(user as never, () => routes()[`${method} ${route}`]({ url, headers: {} } as IncomingMessage, res, undefined));
  return r;
}

const dumpCount = () => fs.readdirSync(dumpDir).length;

describe('t/579: flight-recorder dump routes refuse anonymous and non-admin callers', () => {
  it.each([[ANON, 'anonymous'], [MEMBER, 'signed-in non-admin']])('%s (%s): list, download, view are 403 and serve nothing', async (user) => {
    const list = await call(user, 'GET', '/api/flight-recorder/list', '/api/flight-recorder/list');
    const dl = await call(user, 'GET', '/api/flight-recorder/download/:filename', `/api/flight-recorder/download/${SERVER_DUMP}`);
    const view = await call(user, 'GET', '/api/flight-recorder/view/:filename', `/api/flight-recorder/view/${SERVER_DUMP}`);
    for (const r of [list, dl, view]) {
      expect(r.status).toBe(403);
      expect(r.body).not.toContain(SERVER_DUMP);
      expect(r.body).not.toContain('server');
    }
  });

  it.each([[ANON], [MEMBER]])('POST server-dump is 403 and writes no file', async (user) => {
    const before = dumpCount();
    const r = await call(user, 'POST', '/api/flight-recorder/server-dump', '/api/flight-recorder/server-dump');
    expect(r.status).toBe(403);
    expect(dumpCount()).toBe(before);
  });

  it('an admin can list and download a server dump', async () => {
    const list = await call(ADMIN, 'GET', '/api/flight-recorder/list', '/api/flight-recorder/list');
    expect(list.status).toBe(200);
    expect(JSON.parse(list.body).files.map((f: { name: string }) => f.name)).toContain(SERVER_DUMP);
    const dl = await call(ADMIN, 'GET', '/api/flight-recorder/download/:filename', `/api/flight-recorder/download/${SERVER_DUMP}`);
    expect(dl.status).toBe(200);
    expect(dl.body).toContain('"server":"event"');
  });

  it('AUTH_DISABLED single-operator mode (outside production) keeps the operator\'s access', async () => {
    process.env.AUTH_DISABLED = '1';
    const list = await call(ANON, 'GET', '/api/flight-recorder/list', '/api/flight-recorder/list');
    expect(list.status).toBe(200);
  });
});

describe('t/579: filenames are confined to the dump directory, even for an admin', () => {
  const traversals = [
    'flight-recorder-%252F..%252Fflight-recorder-secret.jsonl',   // double-encoded: the old route decoded twice
    'flight-recorder-%2F..%2Fflight-recorder-secret.jsonl',
    'flight-recorder-..%2F..%2Fflight-recorder-secret.jsonl',
    'flight-recorder-%5C..%5Cflight-recorder-secret.jsonl',       // backslash
    '..%2Fflight-recorder-secret.jsonl',
    'flight-recorder-x.jsonl%00.txt',
    'notadump.jsonl',
  ];
  it.each(traversals)('download %s is refused with 400 and never returns the secret', async (name) => {
    const r = await call(ADMIN, 'GET', '/api/flight-recorder/download/:filename', `/api/flight-recorder/download/${name}`);
    expect(r.status).toBe(400);
    expect(r.body).not.toContain('outside the dump dir');
  });
  it.each(traversals)('view %s is refused with 400 and never returns the secret', async (name) => {
    const r = await call(ADMIN, 'GET', '/api/flight-recorder/view/:filename', `/api/flight-recorder/view/${name}`);
    expect(r.status).toBe(400);
    expect(r.body).not.toContain('outside the dump dir');
  });
});
