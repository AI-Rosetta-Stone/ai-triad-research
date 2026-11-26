// @vitest-environment node

/**
 * t/744 (for t/731): JsonDocStore, the generic ETag compare-and-swap document store.
 *
 * One contract suite runs against both implementations: `BlobJsonDocStore` on its own Azurite (a free port per
 * run, azuriteFreePort.ts) and `InMemoryJsonDocStore`. The forced-412, forced-failure and exhaustion cases use
 * the in-memory store's hooks; the Blob store gets the same cases from a real lost race and a stopped emulator
 * endpoint.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { BlobServiceClient } from '@azure/storage-blob';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { freeAzuritePort } from './azuriteFreePort.js';
import {
  BlobJsonDocStore, InMemoryJsonDocStore, createJsonDocStore, type JsonDocStore,
  JSON_DOC_READ_FAILED, JSON_DOC_WRITE_FAILED, JSON_DOC_CORRUPT, JSON_DOC_CAS_EXHAUSTED, JSON_DOC_NAME_REFUSED,
} from '../storage/jsonDocStore.js';
import { dailyTokenDocName, type TokenDocStore } from '../security/dailyTokenBudget.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const AZURITE_MAIN = path.resolve(here, '../../../node_modules/azurite/dist/src/blob/main.js');
const PORT = await freeAzuritePort();
const KEY = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
const conn = (port: number) =>
  `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${KEY};BlobEndpoint=http://127.0.0.1:${port}/devstoreaccount1;`;
const CONTAINER = 'user-content';
const PREFIX = '_system/daily-tokens';

interface Counter { n: number; by: string[] }
const freshCounter = (): Counter => ({ n: 0, by: [] });
const bump = (who: string) => (doc: Counter) => { doc.n += 1; doc.by.push(who); return { result: doc.n }; };

let proc: ChildProcess;
let service: BlobServiceClient;
let azuriteDir: string;
let seq = 0;
const nextName = () => `${PREFIX}/2026-11-26/doc-${++seq}.json`;

async function waitForAzurite(svc: BlobServiceClient, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try { await svc.getProperties(); return; }
    catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error(`Azurite did not become ready: ${String(lastErr)}`);
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; } catch (err) {
    expect(err).toBeInstanceOf(ActionableError);
    return (err as ActionableError).code;
  }
  throw new Error('expected the call to throw');
}

beforeAll(async () => {
  azuriteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurite-json-doc-store-test-'));
  proc = spawn(
    process.execPath,
    [AZURITE_MAIN, '--silent', '--skipApiVersionCheck', '--location', azuriteDir, '--blobHost', '127.0.0.1', '--blobPort', String(PORT)],
    { stdio: 'ignore', windowsHide: true },
  );
  service = BlobServiceClient.fromConnectionString(conn(PORT));
  await waitForAzurite(service);
  await service.getContainerClient(CONTAINER).createIfNotExists();
}, 30000);

afterAll(async () => {
  if (proc) proc.kill();
  try { fs.rmSync(azuriteDir, { recursive: true, force: true }); } catch { /* the emulator may still hold a handle */ }
});

const implementations: Array<[string, () => JsonDocStore]> = [
  ['BlobJsonDocStore (Azurite)', () => new BlobJsonDocStore({ accountUrl: 'unused', container: CONTAINER, prefix: PREFIX, serviceClient: service, maxCasRetries: 8 })],
  ['InMemoryJsonDocStore', () => new InMemoryJsonDocStore({ prefix: PREFIX, maxCasRetries: 8 })],
];

describe.each(implementations)('JsonDocStore contract: %s', (_label, make) => {
  it('read returns null for a name that was never written', async () => {
    expect(await make().read<Counter>(nextName())).toBeNull();
  });

  it('rmw creates from fresh(), then read returns the document and an ETag that changes on the next write', async () => {
    const store = make();
    const name = nextName();
    expect(await store.rmw(name, freshCounter, bump('a'))).toBe(1);
    const first = await store.read<Counter>(name);
    expect(first?.doc).toEqual({ n: 1, by: ['a'] });
    expect(first?.etag).toBeTruthy();
    expect(await store.rmw(name, freshCounter, bump('b'))).toBe(2);
    const second = await store.read<Counter>(name);
    expect(second?.doc).toEqual({ n: 2, by: ['a', 'b'] });
    expect(second?.etag).not.toBe(first?.etag);
  });

  it('skipWrite returns the result and writes nothing, even though mutate changed its copy', async () => {
    const store = make();
    const name = nextName();
    const result = await store.rmw(name, freshCounter, doc => { doc.n = 99; return { result: 'refused', skipWrite: true }; });
    expect(result).toBe('refused');
    expect(await store.read<Counter>(name)).toBeNull();
  });

  it.each([2, 3])('%i concurrent rmw calls on one existing document lose no update', async (writers) => {
    const store = make();
    const name = nextName();
    await store.rmw(name, freshCounter, bump('seed'));
    const results = await Promise.all(Array.from({ length: writers }, (_, i) => store.rmw(name, freshCounter, bump(`w${i}`))));
    const after = await store.read<Counter>(name);
    expect(after?.doc.n).toBe(writers + 1);
    expect([...(after?.doc.by ?? [])].sort()).toEqual(['seed', ...Array.from({ length: writers }, (_, i) => `w${i}`)].sort());
    expect([...results].sort()).toEqual(Array.from({ length: writers }, (_, i) => i + 2));
  });

  it('first-write race: three writers creating the same new name all land (ifNoneMatch loses, then retries)', async () => {
    const store = make();
    const name = nextName();
    const results = await Promise.all(['a', 'b', 'c'].map(who => store.rmw(name, freshCounter, bump(who))));
    expect([...results].sort()).toEqual([1, 2, 3]);
    const after = await store.read<Counter>(name);
    expect(after?.doc.n).toBe(3);
    expect([...(after?.doc.by ?? [])].sort()).toEqual(['a', 'b', 'c']);
  });

  it('two store instances over the same storage (two replicas) lose no update', async () => {
    // The in-memory store is per instance by design, so this case is Blob's; in memory it checks one instance.
    const a = make();
    const b = a instanceof InMemoryJsonDocStore ? a : make();
    const name = nextName();
    await Promise.all([a.rmw(name, freshCounter, bump('a')), b.rmw(name, freshCounter, bump('b')), a.rmw(name, freshCounter, bump('a2'))]);
    expect((await b.read<Counter>(name))?.doc.n).toBe(3);
  });

  it('refuses a name outside the prefix, with traversal, or that is only the prefix', async () => {
    const store = make();
    for (const bad of ['users/alice/chats/chat-1.json', `${PREFIX}/../users/x.json`, `${PREFIX}/`, PREFIX, `${PREFIX}x/a.json`, `${PREFIX}//a.json`, `${PREFIX}\\a.json`]) {
      expect(await codeOf(store.read(bad))).toBe(JSON_DOC_NAME_REFUSED);
      expect(await codeOf(store.rmw(bad, freshCounter, bump('x')))).toBe(JSON_DOC_NAME_REFUSED);
    }
  });
});

describe('InMemoryJsonDocStore: forced 412 and forced failures', () => {
  const make = (maxCasRetries = 5) => new InMemoryJsonDocStore({ prefix: PREFIX, maxCasRetries });

  it('a forced 412 retries and succeeds, and mutate is re-applied to a freshly downloaded document', async () => {
    const store = make();
    const name = nextName();
    await store.rmw(name, freshCounter, bump('seed'));
    store.forceConflicts(2);
    let runs = 0;
    const result = await store.rmw<Counter, number>(name, freshCounter, doc => { runs++; return bump('w')(doc); });
    expect(runs).toBe(3);
    expect(result).toBe(2);
    expect((await store.read<Counter>(name))?.doc).toEqual({ n: 2, by: ['seed', 'w'] });
  });

  it('retries exhausted throws JSON_DOC_CAS_EXHAUSTED and writes nothing', async () => {
    const store = make(3);
    const name = nextName();
    await store.rmw(name, freshCounter, bump('seed'));
    store.forceConflicts(3);
    let runs = 0;
    expect(await codeOf(store.rmw<Counter, number>(name, freshCounter, doc => { runs++; return bump('w')(doc); }))).toBe(JSON_DOC_CAS_EXHAUSTED);
    expect(runs).toBe(3);
    expect((await store.read<Counter>(name))?.doc).toEqual({ n: 1, by: ['seed'] });
  });

  it('a download failure throws JSON_DOC_READ_FAILED from read; it is not read as "no document"', async () => {
    const store = make();
    const name = nextName();
    await store.rmw(name, freshCounter, bump('seed'));
    store.forceFailures('download', 1);
    expect(await codeOf(store.read(name))).toBe(JSON_DOC_READ_FAILED);
    expect((await store.read<Counter>(name))?.doc.n).toBe(1);
  });

  it('a download failure inside rmw throws without calling fresh() or mutate, and writes nothing', async () => {
    const store = make();
    const name = nextName();
    await store.rmw(name, freshCounter, bump('seed'));
    store.forceFailures('download', 1);
    let freshCalls = 0, mutateCalls = 0;
    const attempt = store.rmw<Counter, number>(name, () => { freshCalls++; return freshCounter(); }, doc => { mutateCalls++; return bump('w')(doc); });
    expect(await codeOf(attempt)).toBe(JSON_DOC_READ_FAILED);
    expect(freshCalls).toBe(0);
    expect(mutateCalls).toBe(0);
    expect((await store.read<Counter>(name))?.doc).toEqual({ n: 1, by: ['seed'] });
  });

  it('an upload failure throws JSON_DOC_WRITE_FAILED, is not retried, and writes nothing', async () => {
    const store = make();
    const name = nextName();
    store.forceFailures('upload', 1);
    let runs = 0;
    expect(await codeOf(store.rmw<Counter, number>(name, freshCounter, doc => { runs++; return bump('w')(doc); }))).toBe(JSON_DOC_WRITE_FAILED);
    expect(runs).toBe(1);
    expect(await store.read(name)).toBeNull();
  });

  it('a stored document that is not JSON throws JSON_DOC_CORRUPT and is not overwritten', async () => {
    const store = make();
    const name = nextName();
    store._setRawForTest(name, '{not json');
    expect(await codeOf(store.read(name))).toBe(JSON_DOC_CORRUPT);
    expect(await codeOf(store.rmw(name, freshCounter, bump('w')))).toBe(JSON_DOC_CORRUPT);
    expect(await codeOf(store.read(name))).toBe(JSON_DOC_CORRUPT);
  });

  it('a caller cannot change the stored document through an object it was handed', async () => {
    const store = make();
    const name = nextName();
    await store.rmw(name, freshCounter, bump('seed'));
    const got = await store.read<Counter>(name);
    got!.doc.n = 500;
    expect((await store.read<Counter>(name))?.doc.n).toBe(1);
  });
});

describe('BlobJsonDocStore: real failures', () => {
  it('an unreachable store throws JSON_DOC_READ_FAILED from both methods; it is not read as "no document"', async () => {
    const deadPort = await freeAzuritePort(); // nothing listens here
    const dead = BlobServiceClient.fromConnectionString(conn(deadPort), { retryOptions: { maxTries: 1, tryTimeoutInMs: 2000 } });
    const store = new BlobJsonDocStore({ accountUrl: 'unused', container: CONTAINER, prefix: PREFIX, serviceClient: dead });
    const name = nextName();
    expect(await codeOf(store.read(name))).toBe(JSON_DOC_READ_FAILED);
    let mutateCalls = 0;
    expect(await codeOf(store.rmw<Counter, number>(name, freshCounter, doc => { mutateCalls++; return bump('w')(doc); }))).toBe(JSON_DOC_READ_FAILED);
    expect(mutateCalls).toBe(0);
  }, 30000);

  it('a missing container is a failure, not "no document"', async () => {
    const store = new BlobJsonDocStore({ accountUrl: 'unused', container: 'no-such-container', prefix: PREFIX, serviceClient: service });
    expect(await codeOf(store.read(nextName()))).toBe(JSON_DOC_READ_FAILED);
  });

  it('a blob that is not JSON throws JSON_DOC_CORRUPT and is left as it is', async () => {
    const name = nextName();
    const blob = service.getContainerClient(CONTAINER).getBlockBlobClient(name);
    await blob.upload('{not json', 9);
    const store = new BlobJsonDocStore({ accountUrl: 'unused', container: CONTAINER, prefix: PREFIX, serviceClient: service });
    expect(await codeOf(store.rmw(name, freshCounter, bump('w')))).toBe(JSON_DOC_CORRUPT);
    expect((await blob.downloadToBuffer()).toString('utf-8')).toBe('{not json');
  });

  it('a real 412 from a competing writer is retried, and exhaustion throws JSON_DOC_CAS_EXHAUSTED with the rival write intact', async () => {
    const name = nextName();
    const container = service.getContainerClient(CONTAINER);
    // A service whose every conditional upload is beaten by a competing unconditional write, so Azurite itself
    // answers 412 (or 409 on a first write). `beatFirst` says how many uploads lose before one is let through.
    let beatFirst = 0;
    let competingWrites = 0;
    const racingService = {
      getContainerClient: () => ({
        getBlockBlobClient: (blobName: string) => {
          const real = container.getBlockBlobClient(blobName);
          return {
            download: () => real.download(),
            upload: async (body: string, length: number, options: Parameters<typeof real.upload>[2]) => {
              if (beatFirst > 0) {
                beatFirst--;
                const rival = JSON.stringify({ n: 100 + ++competingWrites, by: ['rival'] });
                await real.upload(rival, Buffer.byteLength(rival));
              }
              return real.upload(body, length, options);
            },
          };
        },
      }),
    } as unknown as BlobServiceClient;
    const store = new BlobJsonDocStore({ accountUrl: 'unused', container: CONTAINER, prefix: PREFIX, serviceClient: racingService, maxCasRetries: 3 });

    // The first write of a new name loses once (409 BlobAlreadyExists), then lands on top of the rival's document.
    beatFirst = 1;
    expect(await store.rmw(name, freshCounter, bump('w'))).toBe(102);
    expect((await store.read<Counter>(name))?.doc).toEqual({ n: 102, by: ['rival', 'w'] });

    // Every attempt loses (412): it throws, and the last rival write is what is stored.
    beatFirst = 3;
    expect(await codeOf(store.rmw(name, freshCounter, bump('w2')))).toBe(JSON_DOC_CAS_EXHAUSTED);
    expect(competingWrites).toBe(4);
    expect((await store.read<Counter>(name))?.doc).toEqual({ n: 104, by: ['rival'] });
  });
});

describe('fits the caller (t/731)', () => {
  it('both stores satisfy TokenDocStore and accept the names dailyTokenDocName makes', async () => {
    const blob: TokenDocStore = new BlobJsonDocStore({ accountUrl: 'unused', container: CONTAINER, prefix: PREFIX, serviceClient: service });
    const memory: TokenDocStore = new InMemoryJsonDocStore({ prefix: PREFIX });
    const name = dailyTokenDocName(`someone-${Date.now()}@example.test`, '2026-11-26');
    expect(name.startsWith(`${PREFIX}/2026-11-26/`)).toBe(true);
    expect(name).not.toContain('someone');
    for (const store of [blob, memory]) {
      expect(await store.read<Counter>(name)).toBeNull();
      expect(await store.rmw(name, freshCounter, bump('a'))).toBe(1);
      expect((await store.read<Counter>(name))?.doc.n).toBe(1);
    }
  });
});

describe('createJsonDocStore', () => {
  it('builds the in-memory store when AZURE_STORAGE_ACCOUNT_URL is unset, and Blob when it is set', () => {
    expect(createJsonDocStore({ prefix: PREFIX }, {}).kind).toBe('memory');
    expect(createJsonDocStore({ prefix: PREFIX }, {}).store).toBeInstanceOf(InMemoryJsonDocStore);
    const hosted = createJsonDocStore({ prefix: PREFIX }, { AZURE_STORAGE_ACCOUNT_URL: 'https://example.blob.core.windows.net' });
    expect(hosted.kind).toBe('azure-blob');
    expect(hosted.store).toBeInstanceOf(BlobJsonDocStore);
  });

  it('refuses an empty or traversing prefix at construction', () => {
    for (const bad of ['', '/', '../x', '/abs']) {
      expect(() => new InMemoryJsonDocStore({ prefix: bad })).toThrow(ActionableError);
    }
  });
});
