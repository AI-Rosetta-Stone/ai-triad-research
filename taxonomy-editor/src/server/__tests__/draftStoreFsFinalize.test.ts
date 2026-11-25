// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/185 (TL t/185#44): atomic finalize on the real filesystem backend. No mocks here: the strict create-only
// write (writeFileIfAbsentStrict) is what refuses a second claim, and the other test files mock it away.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FilesystemBackend } from '../storage/filesystemBackend.js';
import { createDraftStore } from '../community/draftStore.js';
import { runWithUser } from '../security/userContext.js';
const SIGNED_IN = { principalName: 'fs-user', idp: 'test', storageUserId: 'user-fs', isAnonymous: false };
import type { InquiryPayload } from '../../../../lib/inquiry/index.js';
import { makeValidResult } from '../../../../lib/inquiry/__fixtures__/validResult.js';

function communityResult(): Record<string, unknown> {
  const r = makeValidResult() as Record<string, unknown> & { questionDrift?: Record<string, unknown> };
  if (r.questionDrift) delete r.questionDrift.warning;
  return r;
}
const FIXTURE_NODES = new Map<string, { label: string; camp?: 'acc' | 'saf' | 'skp' | 'cc' }>([
  ['skp-beliefs-029', { label: 'Precaution under uncertainty', camp: 'skp' }],
  ['acc-beliefs-004', { label: 'Regulatory process', camp: 'acc' }],
]);

describe('DraftStore finalize on the real filesystem backend (t/185 TL t/185#44)', () => {
  it('two concurrent finalizes of one draft produce exactly one submission', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'draftstore-fs-'));
    try {
      const backend = new FilesystemBackend({ root });
      const store = createDraftStore({ backend, now: () => Date.now() });
      const created = await store.createDraft(
        { result: communityResult(), note: '' } as unknown as InquiryPayload,
        { nodesById: FIXTURE_NODES, clientId: 'fs-client' },
      );
      expect(created.ok).toBe(true);
      const draftId = (created as { draftId: string }).draftId;
      const principal = { storageUserId: 'user-fs', displayName: 'Fs' } as any;

      const results = await Promise.all([
        runWithUser(SIGNED_IN, () => store.finalizeDraft(draftId, principal)),
        runWithUser(SIGNED_IN, () => store.finalizeDraft(draftId, principal)),
      ]);
      const okCount = results.filter(r => r.ok).length;
      expect(okCount).toBe(1);
      expect(results.find(r => !r.ok)).toEqual({ ok: false, reason: 'already_claimed' });

      const subs = fs.readdirSync(path.join(root, 'community', '_submissions'));
      expect(subs.length).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
