// @vitest-environment node
//
// t/4300 (TL, p/522#423) — validateCacheDirDisjoint() existed (storage/dataRootValidator.ts,
// landed with #3436) but was never called anywhere, so its WARN could never fire. This is a
// static source check on server.ts — it cannot import server.ts (which boots an HTTP server
// at import) — mirroring the wiring-test pattern used for t/4296's enforceReadOnlyGuard
// (__tests__/readOnlyGuard.test.ts). It fails if the call is ever removed (Class 8: a check
// that quietly stops running), independent of validateCacheDirDisjoint's own unit tests.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = fs.readFileSync(path.join(here, '..', 'server.ts'), 'utf-8');

describe('t/4300 — server.ts calls validateCacheDirDisjoint() at boot', () => {
  it('imports validateCacheDirDisjoint via the fileIO.ts barrel', () => {
    // fileIO.ts re-exports it from dataRootValidator.ts; server.ts calls it as fileIO.validateCacheDirDisjoint().
    expect(serverSrc).toMatch(/import \* as fileIO from '\.\/storage\/fileIO\.js'/);
  });

  it('calls fileIO.validateCacheDirDisjoint() at boot, after validateDataRoot', () => {
    const validateDataRootIdx = serverSrc.indexOf('await fileIO.validateDataRoot()');
    const disjointIdx = serverSrc.indexOf('fileIO.validateCacheDirDisjoint()');
    expect(validateDataRootIdx).toBeGreaterThan(-1);
    expect(disjointIdx).toBeGreaterThan(validateDataRootIdx);
  });
});
