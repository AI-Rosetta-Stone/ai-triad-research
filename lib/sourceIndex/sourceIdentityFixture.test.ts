// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Runs every case in the shared fixture (`docs/specs/source-identity.md`,
 * t/4344) through the TS implementation. The PowerShell side runs the same
 * fixture through `scripts/AITriad/Private/SourceIdentity.ps1`
 * (`tests/SourceIdentity.Tests.ps1`) — both must pass every case.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeSourceContentHash, normalizeUrlForCanonicalId, trustedSourceUrlKeys,
  normalizeTitleForCanonicalId, groupSourceIdentities, type SourceIdentityDoc,
} from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(here, '../../tests/fixtures/source-identity-cases.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
  version: number;
  hash_cases: { name: string; text: string; expected_sha256: string | null }[];
  url_cases: { name: string; input: string | null; expected: string | null }[];
  trust_cases: { name: string; metadata: unknown; expected: string[] }[];
  title_cases: { name: string; input: string | null; expected: string }[];
  grouping_cases: {
    name: string;
    documents: { id: string; metadata: Record<string, unknown>; snapshot_sha256?: string }[];
    expected_canonical: Record<string, string>;
    expected_title_collisions: string[][];
  }[];
};

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

describe(`source-identity fixture v${fixture.version} (t/4344)`, () => {
  describe('hash_cases', () => {
    for (const c of fixture.hash_cases) {
      it(c.name, () => {
        expect(computeSourceContentHash(c.text, sha256Hex)).toBe(c.expected_sha256);
      });
    }
  });

  describe('url_cases', () => {
    for (const c of fixture.url_cases) {
      it(c.name, () => {
        expect(normalizeUrlForCanonicalId(c.input)).toBe(c.expected);
      });
    }
  });

  describe('trust_cases', () => {
    for (const c of fixture.trust_cases) {
      it(c.name, () => {
        expect(trustedSourceUrlKeys(c.metadata as never)).toEqual(c.expected);
      });
    }
  });

  describe('title_cases', () => {
    for (const c of fixture.title_cases) {
      it(c.name, () => {
        expect(normalizeTitleForCanonicalId(c.input)).toBe(c.expected);
      });
    }
  });

  describe('grouping_cases', () => {
    for (const c of fixture.grouping_cases) {
      it(c.name, () => {
        const docs: SourceIdentityDoc[] = c.documents.map(d => ({
          id: d.id,
          metadata: d.metadata as SourceIdentityDoc['metadata'],
          snapshotSha256: d.snapshot_sha256 ?? null,
        }));
        const result = groupSourceIdentities(docs);
        expect(result.canonical).toEqual(c.expected_canonical);
        expect(result.titleCollisions).toEqual(c.expected_title_collisions);
      });
    }
  });
});
